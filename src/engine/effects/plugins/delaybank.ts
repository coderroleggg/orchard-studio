// Delay Bank (FL: Fruity Delay Bank), measured from FL's own plugin with
// flfxhost (docs/research/fx/delaybank.md). Per unit (1..8, in order):
//
//   x * In -> input pan / volume (+ the previous unit's "to next")
//     -> input filter (pre) -> stereo offset pre-delay (one side)
//     -> delay lines (per input side, D samples) with the feedback section:
//          line out -> feedback filter -> separation + feedback pan -> x fb vol x FB
//          (ping-pong swaps sides) -> back into the lines
//     -> unit output = processed echo (or the raw line output with "leave first echo";
//        inverted swaps the output sides) x grain envelope
//     -> input filter (post) -> "to next" (next unit's input) and output pan / volume
//   out = dry x x + wet x sum(unit outputs)
//
// Feedback mode "off" bypasses the delay (the unit passes its input). Filters
// are RBJ biquads; dual / triple slopes cascade 2 / 3 identical stages with
// FL's per-stage parameters. Volumes and pans ramp per processing block (at
// most 0.001 per sample); the dry level switches at once. Any change of a
// delay length or offset re-creates the lines (the next echoes start from
// silence). OVERSAMPLE runs the whole plugin at 2x through FL's polyphase IIR
// half-band up / down samplers.

import type { EffectInstance, EffectModule, FxContext } from '../types';
import {
  DB_UNITS, dbKey, dbUnits, dbVol, dbPanGains, dbSep, dbCutoffHz, dbFilterQ, dbFilterBW, dbPeakQ, dbShelfS,
  dbFilterAmp, dbOffsetMs, dbTimeBeats, type DbUnit,
} from '../../../model/fx/plugins/delaybank';

/** Lines are sized for tempos down to this (or the song's tempo when slower). */
const SIZE_TEMPO = 30;
const LN10000 = Math.log(10000);
/** Line write limit (keeps runaway feedback finite). */
const LIMIT = 8;
/** FL's 2x half-band: 6 allpass coefficients (HIIR design, transition 0.1). */
const HB = [0.039151597734460045, 0.1473771136010466, 0.3026468483284934, 0.48246854276970014, 0.6746159185469639, 0.8830050257693731];

/** Round half to even (Delphi's Round). */
function roundEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** A delay line; content written before the last clear() reads as silence (FL re-creates its buffers). */
class Line {
  buf = new Float32Array(4);
  w = 0;
  age = 0;
  size(): number { return this.buf.length; }
  read(d: number): number {
    if (d > this.age) return 0;
    let k = this.w - d;
    if (k < 0) k += this.buf.length;
    return this.buf[k];
  }
  write(v: number): void {
    this.buf[this.w] = v;
    if (++this.w >= this.buf.length) this.w = 0;
    if (this.age < 0x3fffffff) this.age++;
  }
  clear(): void { this.age = 0; }
  /** Grow to at least n samples (outside process()). */
  ensure(n: number): void {
    if (n <= this.buf.length) return;
    this.buf = new Float32Array(n);
    this.w = 0;
    this.age = 0;
  }
  release(): void { this.buf = new Float32Array(4); this.w = 0; this.age = 0; }
}

/** RBJ biquad, 1..3 identical stages, stereo, direct form I like FL (coefficient changes switch at once). */
class StereoFilter {
  on = false;
  stages = 1;
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  /** Per stage and channel: x1, x2, y1, y2. */
  private readonly z = new Float64Array(24);
  l = 0; r = 0;
  private key = '';

  /** FL's mapping: type 0..7, slope 0..2, wheel values, at processing rate `rate`. */
  set(type: number, slope: number, cut: number, res: number, gain: number, rate: number): void {
    const key = `${type}|${slope}|${cut}|${res}|${gain}|${rate}`;
    if (key === this.key) return;
    const was = this.on;
    this.key = key;
    this.on = type > 0;
    if (!this.on) return;
    if (!was) this.z.fill(0);
    const n = slope + 1;
    this.stages = n;
    const f = Math.min(dbCutoffHz(type, cut), rate * 0.49);
    const w0 = (2 * Math.PI * f) / rate, c = Math.cos(w0), s = Math.sin(w0);
    let al: number, A = 1;
    if (type === 2 || type === 3) {
      // band pass: n stages of n x the bandwidth; notch: bandwidth / n
      const bw = type === 2 ? dbFilterBW(res) * n : dbFilterBW(res) / n;
      al = s * Math.sinh(((Math.LN2 / 2) * bw * w0) / s);
    } else if (type === 1 || type === 4) {
      al = s / (2 * Math.pow(dbFilterQ(res), 1 / n));
    } else {
      A = Math.pow(dbFilterAmp(gain), 1 / n);
      if (type === 6) al = s / (2 * dbPeakQ(res));
      else al = (s / 2) * Math.sqrt(Math.max(0, (A + 1 / A) * (1 / dbShelfS(res) - 1) + 2));
    }
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case 1: b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 4: b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 2: b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 3: b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 6: b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; break;
      case 5: {
        const q = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) - (A - 1) * c + q); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - q);
        a0 = (A + 1) + (A - 1) * c + q; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - q;
        break;
      }
      default: {
        const q = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) + (A - 1) * c + q); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - q);
        a0 = (A + 1) - (A - 1) * c + q; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - q;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  /** Filter one stereo sample into this.l / this.r. */
  run(l: number, r: number): void {
    const z = this.z, b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    for (let s = 0, k = 0; s < this.stages; s++, k += 8) {
      const yl = b0 * l + b1 * z[k] + b2 * z[k + 1] - a1 * z[k + 2] - a2 * z[k + 3];
      z[k + 1] = z[k]; z[k] = l; z[k + 3] = z[k + 2]; z[k + 2] = yl;
      const yr = b0 * r + b1 * z[k + 4] + b2 * z[k + 5] - a1 * z[k + 6] - a2 * z[k + 7];
      z[k + 5] = z[k + 4]; z[k + 4] = r; z[k + 7] = z[k + 6]; z[k + 6] = yr;
      l = yl; r = yr;
    }
    this.l = l; this.r = r;
  }

  flush(): void {
    const z = this.z;
    for (let i = 0; i < 24; i++) {
      const v = z[i];
      if (!(Math.abs(v) < 1e10)) { z.fill(0); return; }
      if (Math.abs(v) < 1e-25) z[i] = 0;
    }
  }

  reset(): void { this.z.fill(0); }
}

/** FL's 2x polyphase IIR half-band upsampler (one per channel). */
class Up2 {
  private readonly x = new Float64Array(6);
  private readonly y = new Float64Array(6);
  a = 0; b = 0;
  run(v: number): void {
    const x = this.x, y = this.y;
    let s0 = v, s1 = v;
    for (let i = 0; i < 6; i += 2) {
      let t = (s0 - y[i]) * HB[i] + x[i]; x[i] = s0; y[i] = t; s0 = t;
      t = (s1 - y[i + 1]) * HB[i + 1] + x[i + 1]; x[i + 1] = s1; y[i + 1] = t; s1 = t;
    }
    this.a = s0; this.b = s1;
  }
  reset(): void { this.x.fill(0); this.y.fill(0); }
}

/** FL's 2x polyphase IIR half-band downsampler. */
class Down2 {
  private readonly x = new Float64Array(6);
  private readonly y = new Float64Array(6);
  run(first: number, second: number): number {
    const x = this.x, y = this.y;
    let s0 = second, s1 = first;
    for (let i = 0; i < 6; i += 2) {
      let t = (s0 - y[i]) * HB[i] + x[i]; x[i] = s0; y[i] = t; s0 = t;
      t = (s1 - y[i + 1]) * HB[i + 1] + x[i + 1]; x[i + 1] = s1; y[i + 1] = t; s1 = t;
    }
    return 0.5 * (s0 + s1);
  }
  reset(): void { this.x.fill(0); this.y.fill(0); }
}

// ramped coefficients of a unit
const I00 = 0, I01 = 1, I10 = 2, I11 = 3; // input pan x volume
const F00 = 4, F01 = 5, F10 = 6, F11 = 7; // feedback separation + pan x volume (ping-pong swapped)
const O00 = 8, O01 = 9, O10 = 10, O11 = 11; // output pan x volume
const NX = 12; // to next
const NR = 13;

/** FL's pan law as a matrix [ll, lr, rl, rr] scaled by g. */
function panMatrix(p: number, g: number, out: Float64Array, at: number): void {
  const [k0, k1, K] = dbPanGains(p);
  if (p >= 0) { out[at] = k0 * g; out[at + 1] = 0; out[at + 2] = k1 * g; out[at + 3] = (K - k1) * g; }
  else { out[at] = (K - k1) * g; out[at + 1] = k1 * g; out[at + 2] = 0; out[at + 3] = k0 * g; }
}

class Unit {
  readonly A = new Line();
  readonly B = new Line();
  readonly O = new Line();
  readonly inF = new StereoFilter();
  readonly fbF = new StereoFilter();
  s: DbUnit;
  time = 1440;
  ofs = 0;
  D = 0;
  P = 0;
  side = 0;

  /** Largest gain of the feedback filter (for the tail estimate). */
  fbBoost = 1;
  readonly cur = new Float64Array(NR);
  readonly tgt = new Float64Array(NR);
  readonly inc = new Float64Array(NR);
  fresh = true;

  constructor(s: DbUnit) { this.s = s; }

  clear(): void {
    this.A.clear(); this.B.clear(); this.O.clear();
  }
}

interface Globals { dry: number; wet: number; input: number; feedback: number }

class DelayBank implements EffectInstance {
  private readonly sr: number;
  private readonly cap: number;
  private os = false;
  private rate: number;
  private solo = -1;
  private g: Globals = { dry: 128, wet: 128, input: 128, feedback: 128 };
  private readonly units: Unit[] = [];
  private lastTempo = 120;
  /** Samples processed (processing rate): the grain envelopes run from it, like FL's. */
  private pos = 0;
  // global ramps: input, wet (dry switches at once, like FL)
  private gIn = 1; private gInT = 1; private gInI = 0;
  private gWet = 1; private gWetT = 1; private gWetI = 0;
  private gDry = 1;
  private fresh = true;
  // scratch (processing rate)
  private readonly xL: Float32Array; private readonly xR: Float32Array; // input
  private readonly iL: Float32Array; private readonly iR: Float32Array; // input x In
  private readonly wL: Float32Array; private readonly wR: Float32Array; // wet sum
  private readonly nL: Float32Array[]; private readonly nR: Float32Array[]; // to-next ping-pong
  private readonly upL = new Up2(); private readonly upR = new Up2();
  private readonly dnL = new Down2(); private readonly dnR = new Down2();

  constructor(sr: number, block: number) {
    this.sr = sr;
    this.rate = sr;
    this.cap = Math.max(128, block | 0);
    const n = this.cap * 2;
    this.xL = new Float32Array(n); this.xR = new Float32Array(n);
    this.iL = new Float32Array(n); this.iR = new Float32Array(n);
    this.wL = new Float32Array(n); this.wR = new Float32Array(n);
    this.nL = [new Float32Array(n), new Float32Array(n)];
    this.nR = [new Float32Array(n), new Float32Array(n)];
    const st = dbUnits(undefined);
    for (let u = 0; u < DB_UNITS; u++) this.units.push(new Unit(st[u]));
    this.setParams({});
    // the first real state applies at once (FL loads its state without ramps)
    this.fresh = true;
  }

  /** Delay length in samples at the processing rate. */
  private delayLen(u: Unit, tempo: number): number {
    const bpm = u.s.tempo ? tempo : 120;
    return Math.max(1, roundEven(dbTimeBeats(u.time) * (60 / bpm) * this.rate));
  }

  /** Exact (unrounded) echo time in samples at the processing rate. */
  private exactLen(u: Unit, tempo: number): number {
    const bpm = u.s.tempo ? tempo : 120;
    return dbTimeBeats(u.time) * (60 / bpm) * this.rate;
  }

  private offsetLen(u: Unit): number {
    return roundEven((dbOffsetMs(u.ofs) * this.rate) / 1000);
  }

  setParams(raw: unknown): void {
    const p = (raw ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number): number => {
      const v = p[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d;
    };
    this.g = { dry: num('dry', 128), wet: num('wet', 128), input: num('input', 128), feedback: num('feedback', 128) };
    const os = num('oversample', 0) >= 0.5;
    const solo = Math.round(num('solo', -1));
    this.solo = solo >= 0 && solo < DB_UNITS ? solo : -1;
    if (os !== this.os) {
      // new processing rate: re-create the lines and filters, like FL
      this.os = os;
      this.rate = os ? this.sr * 2 : this.sr;
      this.upL.reset(); this.upR.reset(); this.dnL.reset(); this.dnR.reset();
      for (const u of this.units) { u.clear(); u.inF.reset(); u.fbF.reset(); u.D = 0; }
      this.pos = os ? this.pos * 2 : Math.floor(this.pos / 2);
    }
    const st = dbUnits(p.units);
    const snap = this.fresh;
    this.fresh = false;
    const fbAll = Math.min(128, Math.max(0, this.g.feedback)) / 128;
    for (let i = 0; i < DB_UNITS; i++) {
      const u = this.units[i];
      const s = st[i];
      u.s = s;
      u.time = Math.min(7680, Math.max(0, num(dbKey(i, 'Time'), 1440)));
      u.ofs = Math.min(512, Math.max(-512, num(dbKey(i, 'Ofs'), 0)));
      const rate = this.rate;
      u.inF.set(s.inType, s.inMode, num(dbKey(i, 'InCut'), 33145), num(dbKey(i, 'InRes'), 17500), num(dbKey(i, 'InGain'), 0), rate);
      u.fbF.set(s.fbType, s.fbMode, num(dbKey(i, 'FbCut'), 33145), num(dbKey(i, 'FbRes'), 17500), num(dbKey(i, 'FbGain'), 0), rate);
      u.fbBoost = s.fbType === 1 || s.fbType === 4 ? Math.max(1, dbFilterQ(num(dbKey(i, 'FbRes'), 17500)))
        : s.fbType >= 5 ? Math.max(1, dbFilterAmp(num(dbKey(i, 'FbGain'), 0)) ** 2) : 1;
      const t = u.tgt;
      panMatrix(num(dbKey(i, 'InPan'), 0), dbVol(num(dbKey(i, 'InVol'), 128)), t, I00);
      panMatrix(num(dbKey(i, 'OutPan'), 0), dbVol(num(dbKey(i, 'OutVol'), 128)), t, O00);
      // FL switches "to next" at once
      t[NX] = i < DB_UNITS - 1 ? dbVol(num(dbKey(i, 'Next'), 0)) : 0;
      u.cur[NX] = t[NX];
      // feedback: separation, then FL's pan; its pour into the near side is taken from the
      // unseparated difference, limited to what keeps the near side at the separated mid
      const fp = num(dbKey(i, 'FbPan'), 0);
      const [a, b] = dbSep(num(dbKey(i, 'Sep'), 0));
      const [k0, k1, K] = dbPanGains(fp);
      const g = (Math.min(128, Math.max(-128, num(dbKey(i, 'FbVol'), 64))) / 128) * fbAll;
      const pour = Math.min(k1 * (a + b), (K * (a - b)) / 2);
      let m00: number, m01: number, m10: number, m11: number;
      if (fp >= 0) { m00 = k0 * a; m01 = k0 * b; m10 = K * b + pour; m11 = K * a - pour; }
      else { m10 = k0 * b; m11 = k0 * a; m00 = K * a - pour; m01 = K * b + pour; }
      if (s.mode === 3) { t[F00] = m10 * g; t[F01] = m11 * g; t[F10] = m00 * g; t[F11] = m01 * g; }
      else { t[F00] = m00 * g; t[F01] = m01 * g; t[F10] = m10 * g; t[F11] = m11 * g; }
      if (snap || u.fresh) { u.cur.set(t); u.fresh = false; }
      // line memory (enabled units only; FL's maximum is 4 beats)
      if (s.enable) {
        const minTempo = Math.max(10, Math.min(SIZE_TEMPO, this.lastTempo));
        const need = Math.ceil(dbTimeBeats(u.time) * (60 / (s.tempo ? minTempo : 120)) * this.rate) + 4;
        if (need > u.A.size()) { u.A.ensure(need); u.B.ensure(need); u.D = 0; }
        const pNeed = Math.ceil(0.5 * this.rate) + 4;
        if (pNeed > u.O.size()) { u.O.ensure(pNeed); u.D = 0; }
      }
    }
    const gin = dbVol(this.g.input), gwet = dbVol(this.g.wet);
    this.gInT = gin; this.gWetT = gwet;
    this.gDry = dbVol(this.g.dry);
    if (snap) { this.gIn = gin; this.gWet = gwet; }
  }

  /** FL ramps volumes and pans by at most 0.001 per sample at 44.1 kHz. */
  private rampLimit(): number {
    return 0.001 * (44100 / this.rate);
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (ctx.tempo > 0 && Number.isFinite(ctx.tempo)) this.lastTempo = ctx.tempo;
    for (let off = 0; off < n; off += this.cap) this.chunk(L, R, off, Math.min(this.cap, n - off));
  }

  private chunk(L: Float32Array, R: Float32Array, off: number, m: number): void {
    const os = this.os, N = os ? m * 2 : m;
    const xL = this.xL, xR = this.xR, iL = this.iL, iR = this.iR, wL = this.wL, wR = this.wR;
    if (os) {
      for (let i = 0, j = 0; i < m; i++, j += 2) {
        this.upL.run(L[off + i]); xL[j] = this.upL.a; xL[j + 1] = this.upL.b;
        this.upR.run(R[off + i]); xR[j] = this.upR.a; xR[j + 1] = this.upR.b;
      }
    } else {
      for (let i = 0; i < m; i++) { xL[i] = L[off + i]; xR[i] = R[off + i]; }
    }
    const lim = this.rampLimit();
    // global input level (ramped)
    this.gInI = rampInc(this.gIn, this.gInT, N, lim);
    let g = this.gIn;
    for (let i = 0; i < N; i++) { iL[i] = xL[i] * g; iR[i] = xR[i] * g; g += this.gInI; }
    this.gIn = endRamp(this.gIn, this.gInT, this.gInI, N, lim);
    wL.fill(0, 0, N); wR.fill(0, 0, N);
    // units in order; each may feed the next one
    let prev = -1;
    for (let k = 0; k < DB_UNITS; k++) {
      const u = this.units[k];
      if (!u.s.enable) { prev = -1; continue; }
      const out = k & 1;
      const feeds = k < DB_UNITS - 1 && this.units[k + 1].s.enable && u.tgt[NX] !== 0;
      this.runUnit(u, N, lim, prev >= 0 ? this.nL[prev] : null, prev >= 0 ? this.nR[prev] : null,
        feeds ? this.nL[out] : null, feeds ? this.nR[out] : null, this.solo < 0 || this.solo === k);
      prev = feeds ? out : -1;
    }
    // dry (at once) + wet (ramped)
    this.gWetI = rampInc(this.gWet, this.gWetT, N, lim);
    let gw = this.gWet;
    const dry = this.gDry;
    for (let i = 0; i < N; i++) {
      wL[i] = xL[i] * dry + wL[i] * gw;
      wR[i] = xR[i] * dry + wR[i] * gw;
      gw += this.gWetI;
    }
    this.gWet = endRamp(this.gWet, this.gWetT, this.gWetI, N, lim);
    this.pos += N;
    if (os) {
      for (let i = 0, j = 0; i < m; i++, j += 2) {
        L[off + i] = this.dnL.run(wL[j], wL[j + 1]);
        R[off + i] = this.dnR.run(wR[j], wR[j + 1]);
      }
    } else {
      for (let i = 0; i < m; i++) { L[off + i] = wL[i]; R[off + i] = wR[i]; }
    }
  }

  private runUnit(u: Unit, N: number, lim: number,
    pL: Float32Array | null, pR: Float32Array | null, nL: Float32Array | null, nR: Float32Array | null, audible: boolean): void {
    const s = u.s;
    // delay length / offset: a change re-creates the lines (FL)
    const D = Math.min(u.A.size(), this.delayLen(u, this.lastTempo));
    const P = Math.min(u.O.size() - 1, this.offsetLen(u));
    const side = u.ofs < 0 ? -1 : u.ofs > 0 ? 1 : 0;
    if (D !== u.D || P !== u.P || side !== u.side) {
      u.clear();
      u.D = D; u.P = P; u.side = side;
    }
    const cur = u.cur, tgt = u.tgt, inc = u.inc;
    for (let c = 0; c < NR; c++) inc[c] = rampInc(cur[c], tgt[c], N, lim);
    let i00 = cur[I00], i01 = cur[I01], i10 = cur[I10], i11 = cur[I11];
    let f00 = cur[F00], f01 = cur[F01], f10 = cur[F10], f11 = cur[F11];
    let o00 = cur[O00], o01 = cur[O01], o10 = cur[O10], o11 = cur[O11];
    let nx = cur[NX];
    const di00 = inc[I00], di01 = inc[I01], di10 = inc[I10], di11 = inc[I11];
    const df00 = inc[F00], df01 = inc[F01], df10 = inc[F10], df11 = inc[F11];
    const do00 = inc[O00], do01 = inc[O01], do10 = inc[O10], do11 = inc[O11];
    const dnx = inc[NX];
    const iL = this.iL, iR = this.iR, wL = this.wL, wR = this.wR;
    const A = u.A, B = u.B, O = u.O, inF = u.inF, fbF = u.fbF;
    const pre = inF.on && !s.post, post = inF.on && !!s.post, fbOn = fbF.on;
    const mode = s.mode, leave = !!s.leave, div = s.div, shape = s.shape;
    const kShape = shape !== 0 ? -(shape / 128) * LN10000 : 0;
    const kNorm = shape !== 0 ? 1 / Math.expm1(kShape) : 1;
    // grains: one grain = the exact (unrounded) echo time / division; grain k starts at sample
    // round(k G) counted from the plugin start (FL), the window spans G - 1.5 samples
    const G = div > 0 ? Math.max(2, this.exactLen(u, this.lastTempo) / div) : 2;
    const den = G - 1.5;
    const n0 = this.pos;
    let gk = Math.floor((n0 + 0.5) / G);
    if (Math.floor(gk * G + 0.5) > n0) gk--;
    if (Math.floor((gk + 1) * G + 0.5) <= n0) gk++;
    let gs = Math.floor(gk * G + 0.5), gn = Math.floor((gk + 1) * G + 0.5);
    for (let i = 0; i < N; i++) {
      const xl = iL[i], xr = iR[i];
      let il = i00 * xl + i01 * xr, ir = i10 * xl + i11 * xr;
      if (pL) { il += pL[i]; ir += pR![i]; }
      if (pre) { inF.run(il, ir); il = inF.l; ir = inF.r; }
      let yl: number, yr: number;
      if (mode === 0) {
        yl = il; yr = ir;
      } else {
        if (side < 0 && P > 0) { const d = O.read(P); O.write(il); il = d; }
        else if (side > 0 && P > 0) { const d = O.read(P); O.write(ir); ir = d; }
        const a = A.read(D), b = B.read(D);
        let fa = a, fb = b;
        if (fbOn) { fbF.run(a, b); fa = fbF.l; fb = fbF.r; }
        const pl = f00 * fa + f01 * fb, pr = f10 * fa + f11 * fb;
        let wa = il + pl, wb = ir + pr;
        if (wa > LIMIT) wa = LIMIT; else if (wa < -LIMIT) wa = -LIMIT;
        if (wb > LIMIT) wb = LIMIT; else if (wb < -LIMIT) wb = -LIMIT;
        A.write(wa); B.write(wb);
        if (leave) { yl = a; yr = b; } else { yl = pl; yr = pr; }
        if (mode === 2) { const t = yl; yl = yr; yr = t; }
      }
      if (div > 0) {
        const n = n0 + i;
        if (n >= gn) { gk++; gs = gn; gn = Math.floor((gk + 1) * G + 0.5); }
        const j = n - gs;
        const sn = j < den ? Math.sin((Math.PI * j) / den) : 0;
        let e = sn * sn;
        if (kShape !== 0) e = Math.expm1(kShape * e) * kNorm;
        yl *= e; yr *= e;
      }
      if (post) { inF.run(yl, yr); yl = inF.l; yr = inF.r; }
      if (nL) { nL[i] = nx * yl; nR![i] = nx * yr; }
      if (audible) { wL[i] += o00 * yl + o01 * yr; wR[i] += o10 * yl + o11 * yr; }
      i00 += di00; i01 += di01; i10 += di10; i11 += di11;
      f00 += df00; f01 += df01; f10 += df10; f11 += df11;
      o00 += do00; o01 += do01; o10 += do10; o11 += do11;
      nx += dnx;
    }
    for (let c = 0; c < NR; c++) cur[c] = endRamp(cur[c], tgt[c], inc[c], N, lim);
    inF.flush(); fbF.flush();
  }

  reset(): void {
    for (const u of this.units) { u.clear(); u.inF.reset(); u.fbF.reset(); }
    this.pos = 0;
    this.upL.reset(); this.upR.reset(); this.dnL.reset(); this.dnR.reset();
  }

  /** Echo tails of the enabled units (to -90 dB, capped at 60 s), chained units add up. */
  get tail(): number {
    let total = 0;
    for (const u of this.units) {
      if (!u.s.enable || u.s.mode === 0) continue;
      const bpm = u.s.tempo ? Math.max(10, this.lastTempo) : 120;
      const T = Math.max(1 / this.rate, dbTimeBeats(u.time) * (60 / bpm));
      let gl = Math.abs(u.tgt[F00]) + Math.abs(u.tgt[F01]);
      gl = Math.max(gl, Math.abs(u.tgt[F10]) + Math.abs(u.tgt[F11]));
      gl *= u.fbBoost;
      const extra = dbOffsetMs(u.ofs) / 1000 + 0.05;
      if (gl >= 0.999) return 60;
      const reps = gl <= 1e-4 ? 1 : Math.ceil(Math.log(10 ** (-90 / 20)) / Math.log(gl)) + 1;
      total += reps * T + extra;
      if (total >= 60) return 60;
    }
    return Math.min(60, total);
  }
}

/** Per-block ramp step toward a target (FL: linear across the block, capped). */
function rampInc(v: number, t: number, n: number, lim: number): number {
  const d = t - v;
  if (d === 0) return 0;
  return Math.max(-lim, Math.min(lim, d / n));
}

/** Value after n ramp steps (lands on the target when the step was not capped). */
function endRamp(v: number, t: number, inc: number, n: number, lim: number): number {
  if (inc === 0) return v;
  if (Math.abs(inc) < lim || Math.abs(t - v) <= Math.abs(inc) * n + 1e-12) return t;
  return v + inc * n;
}

export const effect: EffectModule = {
  id: 'delaybank',
  create: (sampleRate, blockSize) => new DelayBank(sampleRate, blockSize),
};
