// FPC's pad envelopes: FL's TCustomMEnvelope / TMEnvelope player (MEnvelope unit as linked into
// FPC_x64.dylib: update 0x240300, NoteOn 0x244e90 / 0x242700, Tick 0x242b30, Release 0x242930, point
// value 0x241ef0; TFPCVolEnvelope / TFPCPanEnvelope), ticked once per control period with FL's time step
// (envelope units of 0.5 s per period). Reproduced in FL's single / double precision:
//
// - Points hold the segment length before them (dt, float), the level (0..1), the tension and the curve
//   mode; the update step derives per point the curve coefficients (single / double curve:
//   c = sgn(t) (e^(|t| ln 1e6) - 1), B = 1 / |c|, C = ln(|c| + 1)) and the sustain weight (0 .. 1 from the
//   D marker to the loop start / sustain point, 1 .. 0 over the release).
// - A segment's phase runs 0..1 at step inc / (dt x scale), scale = ATT before the D marker, DEC after it
//   (and in a release without S), REL in the release; levels get SUS x weight added (from the D marker on),
//   clamped to 0..1, minus the envelope's offset (pan: 0.5). The sustain point holds until the note off; the
//   loop start (L) sends the envelope back from the sustain / last point; the release continues from the
//   current level (the offset absorbs the difference) through the points after S.
// - Per-point loop counts (FL's point byte 13) are not used by FPC's editor and are not modelled; curve
//   modes other than single curve (0), double curve (1) and hold (2) play as single curves here. A loop of
//   zero-length segments, which hangs FL, holds after a few passes.

import type { FpcEnv } from '../../../../model/gen/plugins/fpc/state';

const f32 = Math.fround;
const EPS = 1.52587890625e-05;
const LN_1E6 = 13.815511557963774;

/** A voice's envelope state (FL's 0x60-byte record). */
export class EnvState {
  stage = 9;
  seg = 0;
  prev = 9;
  phase = 0;
  inc = 0;
  start = 0;
  delta = 0;
  /** Sustain offset applied to the levels (FL's +0x28). */
  ofs = 0;
  /** Output (FL's +0x2c). */
  value = 0;
  sus = 0;
  hold = false;
  /** ATT, DEC, SUS, REL as fractions (knob / 128). */
  readonly adsr = new Float32Array(4);
}

export class EnvShape {
  on = false;
  /** FL's time step per tick (env + 0x10). */
  inc = 1;
  /** Value offset (0.5 for the pan envelope). */
  offset = 0;
  private n = 0;
  private dt = new Float32Array(1);
  private y = new Float32Array(1);
  private mode = new Uint8Array(1);
  private sign = new Int8Array(1);
  private cA = new Float32Array(1);
  private cB = new Float32Array(1);
  private cC = new Float32Array(1);
  private w = new Float32Array(1);
  private d = -1;
  private l = -1;
  private s = -1;
  /** FL's 0x88: the point that ends the sustain / loop section. */
  private stop = -1;
  private readonly knobs = new Float32Array(4);
  private srcPts: number[][] | null = null;

  constructor(pan = false) { this.offset = pan ? 0.5 : 0; }

  /** New state: points, markers, enabled and the ADSR knobs (0..256, sustain -128..128). */
  set(e: FpcEnv, adsr: ArrayLike<number>): void {
    this.on = e.on;
    for (let i = 0; i < 4; i++) this.knobs[i] = f32(adsr[i] * 0.0078125);
    if (e.pts === this.srcPts && this.d === e.d && this.l === e.l && this.s === e.s) return;
    this.srcPts = e.pts;
    const n = Math.max(1, e.pts.length);
    if (this.dt.length < n) {
      this.dt = new Float32Array(n); this.y = new Float32Array(n); this.mode = new Uint8Array(n); this.sign = new Int8Array(n);
      this.cA = new Float32Array(n); this.cB = new Float32Array(n); this.cC = new Float32Array(n); this.w = new Float32Array(n);
    }
    this.n = n;
    for (let i = 0; i < n; i++) {
      const p = e.pts[i] ?? [0, 0, 0, 0];
      let dt = f32(p[0]);
      if (dt < 0) dt = 0;
      this.dt[i] = dt; this.y[i] = f32(p[1]); this.mode[i] = p[3] | 0;
    }
    this.d = e.d; this.l = e.l; this.s = e.s;
    this.update(e.pts);
  }

  /** FL's update (0x240300): sustain section end, per-point curve coefficients and sustain weights. */
  private update(pts: number[][]): void {
    const n = this.n, hi = n - 1;
    this.stop = this.s;
    if (this.stop < 0 && this.l >= 0) this.stop = hi;
    const Dm = this.d >= 0 ? this.d : 0;
    const Sx = this.s >= 0 ? this.s : hi;
    const Lx = this.l >= 0 ? this.l : Sx;
    let att = 0, dec = 0, rel = 0;
    for (let i = 0; i <= hi; i++) {
      const dt = this.dt[i];
      if (Dm >= i) att += dt;
      if (Dm < i && i <= Lx) dec += dt;
      if (i > Sx) rel += dt;
      if (i > 0) {
        const t = f32(pts[i]?.[2] ?? 0);
        this.sign[i] = t === 0 ? 0 : t < 0 || Object.is(t, -0) ? -1 : 1;
        const m = this.mode[i];
        this.cA[i] = 0; this.cB[i] = 0; this.cC[i] = 0;
        if (m <= 1 || m > 2) {
          const e = f32(Math.exp(Math.abs(t) * LN_1E6) - 1);
          const c = f32(this.sign[i] * e);
          this.cA[i] = c;
          if (c !== 0) { const a = Math.abs(c); this.cB[i] = f32(1 / a); this.cC[i] = f32(Math.log(f32(a + 1))); }
        }
      } else this.sign[i] = 0;
    }
    let acc = att;
    for (let i = 0; i <= hi; i++) {
      let w = 0;
      if (i <= Dm) {
        if (i === Dm) acc = 0;
        else { acc -= this.dt[i]; w = f32(acc / (att > EPS ? att : EPS)); }
      } else {
        w = 1;
        if (i > Sx) {
          acc -= this.dt[i];
          w = f32(acc / (rel > EPS ? rel : EPS));
        } else {
          acc += this.dt[i];
          if (i <= Lx) w = f32(acc / (dec > EPS ? dec : EPS));
          if (i === Sx) acc = rel;
        }
      }
      this.w[i] = w;
    }
  }

  /** FL's point value (0x241ef0): level + offset x weight, clamped to 0..1, minus the envelope offset. */
  private point(i: number, ofs: number): number {
    if (i < 0 || i >= this.n) return 0;
    let v = this.y[i];
    if (ofs !== 0) {
      v = v + f32(this.w[i] * ofs);
      if (v < 0) v = 0; else if (v > 1) v = 1;
    }
    return v - this.offset;
  }

  /** FL's NoteOn (TMEnvelope 0x244e90 with the base init 0x242700). */
  noteOn(s: EnvState): void {
    s.seg = 0; s.ofs = 0;
    s.stage = this.d < 0 ? 3 : 1;
    const dt0 = this.dt[0];
    if (dt0 === 0) { s.inc = 1; s.phase = 1; } else { s.inc = this.inc / dt0; s.phase = 0; }
    s.prev = s.stage;
    s.start = f32(this.point(0, s.ofs));
    s.delta = 0;
    s.value = s.start;
    s.hold = false;
    for (let i = 0; i < 4; i++) s.adsr[i] = this.knobs[i];
    s.sus = this.s >= 0 ? s.adsr[2] : 0;
    // FL's +0x38: a loop holds instead of repeating when DEC is 0
    s.hold = !(s.adsr[1] > 0);
    // TMEnvelope: the sustain level applies at once when the envelope starts in its decay stage
    if (s.stage > 1) s.ofs = s.sus;
    s.value = f32(this.point(0, s.ofs));
  }

  /** FL's Release (0x242930). */
  release(s: EnvState): void {
    if (s.stage >= 6) return;
    if (this.s >= 0) {
      s.seg = this.s;
      s.ofs = f32(s.ofs + (s.value - this.pointNoClamp(s.seg, s.ofs)));
      s.phase = 1;
      s.prev = 6;
    }
    s.stage = 6;
    if (s.inc === 0) s.phase = 1;
  }

  /** The point value with FL's clamp switched off (Release computes its offset without it). */
  private pointNoClamp(i: number, ofs: number): number {
    if (i < 0 || i >= this.n) return 0;
    let v = this.y[i];
    if (ofs !== 0) v = v + f32(this.w[i] * ofs);
    return v - this.offset;
  }

  /** FL's Tick (0x242b30): advance by dt ticks. */
  tick(s: EnvState, dt: number): void {
    const hi = this.n - 1;
    if (s.seg < 0 || s.seg > hi) return;
    s.phase = dt * s.inc + s.phase;
    // (FL loops for ever on a loop of zero-length segments: stopped here after a few passes, holding)
    let guard = 4 * this.n + 16;
    while (s.phase >= 1) {
      if (--guard < 0) { s.phase = 0; s.inc = 0; break; }
      if (s.inc === 0) s.phase = dt;
      else s.phase = (s.phase - 1) / s.inc;
      s.start = f32(this.point(s.seg, s.ofs));
      let hold: boolean;
      if (this.stop >= 0 && this.stop <= s.seg && s.stage < 6) {
        if (this.l >= 0) { s.prev = 4; s.seg = this.l + 1; hold = s.hold; } else hold = true;
      } else {
        if (this.d >= 0 && this.d <= s.seg && s.prev < 3) {
          if (s.stage < 3) s.stage = 3;
          s.prev = 3;
          s.ofs = s.sus;
        }
        if (s.seg < hi) { s.seg++; hold = false; } else { s.stage = 9; hold = true; }
      }
      s.delta = f32(this.point(s.seg, s.ofs) - s.start);
      if (hold) { s.phase = 0; s.inc = 0; continue; }
      const k = (s.stage >= 6 && this.s >= 0 ? 2 : 0) + (s.stage >= 3 ? 1 : 0);
      const len = this.dt[s.seg] * s.adsr[k];
      if (len > 0) { s.inc = this.inc / len; s.phase = s.phase * s.inc; } else { s.inc = 1; s.phase = s.phase + 1; }
    }
    if (s.delta === 0) { s.value = s.start; return; }
    const y = this.curve(s.seg, s.phase);
    s.value = f32(f32(y * s.delta) + s.start);
  }

  /** The segment shape (FL's curve modes) at phase t (double) as a float. */
  private curve(i: number, t: number): number {
    if (this.sign[i] === 0 && this.mode[i] <= 1) return f32(t);
    const m = this.mode[i];
    if (m === 2) return 0;
    if (m === 1) {
      if (t < 0.5) return f32(this.single(i, t * 2) * 0.5);
      return f32(1 - this.single(i, (1 - t) * 2) * 0.5);
    }
    return f32(this.single(i, t));
  }

  private single(i: number, t: number): number {
    const A = this.cA[i];
    if (A === 0) return t;
    if (A > 0) return 1 - (Math.exp(this.cC[i] * (1 - t)) - 1) * this.cB[i];
    return (Math.exp(this.cC[i] * t) - 1) * this.cB[i];
  }
}
