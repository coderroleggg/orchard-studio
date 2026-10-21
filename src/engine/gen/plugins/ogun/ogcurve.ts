// Ogun's curve library: the envelope / LFO / mapping classes (TCustomMEnvelope, TMEnvelope, TMLFO, TMMap) as compiled into
// Ogun_x64.dylib (FL 2026, arm64 slice; VMTs 0x3588c0 / 0x358a10 / 0x358b60 / 0x358cb0). The same Delphi source as Harmor's
// (src/engine/gen/plugins/harmor/env.ts, whose compile step and LFO oscillator are reused), in an older build: a point keeps
// its time distance as a double and the playback state (0x70 bytes + LFO half) holds start / delta / output as doubles.
//
//   state record (voice+0xe8+0x108*i, envelope at +0, LFO at +0x80): +0x00 stage (1 attack, 3 decay, 4 loop, 6 release, 9 done),
//   +0x04 point, +0x08 mode, +0x10 pos, +0x18 inc, +0x20 start, +0x28 delta, +0x30 offset, +0x38 output, +0x40 LFO output,
//   +0x48 sustain offset, +0x50 hold, +0x68 LFO phase (uint32), +0x6c..+0x78 attack / decay / sustain offset / release scales.
//
// Arithmetic follows the binary: double where FL keeps double, float32 where it keeps float.

import { LfoShape, lfoIncrement, rne, TYPE_ENV, TYPE_LFO, TYPE_MAP } from '../harmor/env';
import type { OgEnv } from '../../../../model/gen/plugins/ogun/types';
import { exp as lexp, log as llog, sin as lsin, cos as lcos } from '../harmor/fx-libm';

export { TYPE_ENV, TYPE_LFO, TYPE_MAP };

const f32 = Math.fround;
const NO_LEN = 2147483647.0;
const EPS16 = 1.52587890625e-5; // 2^-16
const TINY = 5.960464477539063e-8; // 2^-24
const LN1E6 = 13.815511557963774;
const TWO_PI_F = 6.2831854820251465;
const HALF_PI_F = 1.5707963705062866;
const INV128 = 0.0078125;
const INV256 = 0.00390625;

const scratchD = new Float64Array(1);
const scratchU = new Uint32Array(scratchD.buffer);
const scratchF = new Float32Array(1);
const scratchFU = new Uint32Array(scratchF.buffer);
/** High 32 bits of a double (FL compares them unsigned: `pos >= 1` is hi32 >= 0x3ff00000). */
export function hi32(x: number): number { scratchD[0] = x; return scratchU[1]; }
export function fbits(x: number): number { scratchF[0] = x; return scratchFU[0]; }
function toI32(x: number): number {
  if (x !== x) return 0;
  if (x >= 9223372036854775807) return -1;
  if (x <= -9223372036854775808) return 0;
  return Math.trunc(x) | 0;
}
function toU32(x: number): number { return toI32(x) >>> 0; }
const isPosZero = (v: number): boolean => v === 0 && 1 / v > 0;
const signBit = (v: number): boolean => v < 0 || (v === 0 && 1 / v < 0);

/** A curve playback state (the 0x70-byte record of Ogun's envelope / LFO classes, doubles). */
export class OgState {
  stage = 0;
  cur = 0;
  mode = 0;
  pos = 0;
  inc = 0;
  start = 0;
  delta = 0;
  ofs = 0;
  /** +0x38 output (envelope / map), +0x40 LFO output. */
  out = 0;
  lfoOut = 0;
  /** +0x48 sustain offset, +0x50 hold, +0x51 arpeggio hold. */
  susOfs = 0;
  hold = 0;
  arpHold = 0;
  arpIdx = -1;
  arp40 = -1;
  arpCount = -1;
  arpLevel = 0;
  /** +0x68 LFO phase (uint32). */
  phase = 0;
  /** +0x6c attack, +0x70 decay, +0x74 sustain offset, +0x78 release scale (float32). */
  readonly scale = new Float32Array([1, 1, 0, 1]);

  kill(): void {
    this.stage = 9;
    this.mode = 9;
    this.start = 0;
    this.delta = 0;
    this.out = 0;
  }
}


/** Two-point linear map (0x266da0). */
function isLinear2(c: OgCurve): boolean {
  if (c.n !== 2) return false;
  const s = c.seg[1];
  if (!(s < 2 || (s >= 7 && s <= 9) || s === 11 || s === 12)) return false;
  return fbits(c.t[1]) === 0;
}

/** Flat curve test (0x266cf0): the common level (raw y, before the offset) or null. */
function mapConstant(c: OgCurve): number | null {
  if (c.n <= 0) return null;
  const v = fbits(c.y[0]);
  for (let i = 1; i <= c.high; i++) if (fbits(c.y[i]) !== v) return null;
  return c.y[0];
}

/** Largest relative difference between a curve's length and the sum of its distances that counts as rounding noise (fixLength). */
const FIX_TOLERANCE = 1e-9;

export class OgCurve {
  type = TYPE_ENV;
  /** Point count and record fields (+0x0 x, +0x4 y, +0x8 tension, +0xc seg, +0xd arp, +0xe b2, +0xf kind, +0x10.. c0..c2, +0x1c offset weight). */
  n = 0;
  x = new Float64Array(0);
  y = new Float32Array(0);
  t = new Float32Array(0);
  seg = new Uint8Array(0);
  arp = new Uint8Array(0);
  b2 = new Uint8Array(0);
  kind = new Int8Array(0);
  c0 = new Float32Array(0);
  c1 = new Float32Array(0);
  c2 = new Float32Array(0);
  w = new Float32Array(0);
  /** +0x08: speed ratio of the last setSpeed (new / old). */
  ratio = 0;
  /** +0x10: curve time per tick. */
  speed = 1.0;
  /** +0x18: value offset subtracted from every level (0.5 for bipolar curves and LFOs). */
  offset = 0;
  /** +0x20: class flags (0x3f; LFO clears bit 3; maps 0x20 (+0x40 in articulators); bit 7 = flat release weights). */
  flags = 0x3f;
  /** +0x21: clamp levels with an offset to [lo, hi]. */
  clamp = 1;
  /** Markers (+0x44 flags byte, +0x48 enabled, +0x4c decay, +0x50 loop start, +0x54 sustain). */
  m0 = 0;
  enabled = -1;
  decay = -1;
  loop = -1;
  sus = -1;
  /** +0x68: fixed length (maps 1.0), +0x70 / +0x78 clamp range. */
  len = NO_LEN;
  lo = 0;
  hi = 1;
  /** +0x88 sustain index, +0x8c loop and sustain at the same time, +0x8d has arpeggio break points. */
  susIdx = -1;
  loopSusSame = 0;
  hasArp = 0;
  // TMEnvelope
  /** +0x98 ADSR ints (128 = 1.0; sustain -128..128) and +0xa8 their float scales, +0xb8 sustain offset. */
  adsrI = new Int32Array([128, 128, 0, 128]);
  adsr = new Float32Array([1, 1, 0, 1]);
  susDef = 0;
  /** +0xc0: shared state of a "global" envelope (another voice's state; set by the voice trigger). */
  shared: OgState | null = null;
  // TMLFO
  /** +0xd0 speed, tension, skew, pulse width (ints), +0xe0 start phase (uint32). */
  lfoI = new Int32Array([40898, 0, 0, 0]);
  ph = 0;
  lfo = new LfoShape();
  /** +0x98 / +0xa0 phase increment per tick (double; +0xa0 is 0 when m[0] bit 3 is set), +0xa8 global phase. */
  incU = 0;
  incV = 0;
  gphase = 0;
  // TMMap
  /** +0x98 table, +0xa0 leading entries dropped, +0xa4 last index, +0xa8 x scale, +0xac default value, +0xb8 table resolution. */
  table: Float32Array | null = null;
  tabOfs = 0;
  tabLast = 0;
  tabScale = 0;
  def = 1;
  res = 0;

  constructor(type: number = TYPE_ENV) {
    this.init(type);
  }

  /** FL's constructors (0x444120 + 0x450150 / 0x450660 / 0x4511c0). */
  init(type: number): void {
    this.type = type;
    this.speed = 1.0;
    this.len = NO_LEN;
    this.lo = 0;
    this.hi = 1;
    this.clamp = 1;
    this.flags = 0x3f;
    this.offset = 0;
    this.ratio = 0;
    this.shared = null;
    this.table = null;
    if (type === TYPE_LFO) {
      this.offset = 0.5;
      this.flags &= ~8;
      this.gphase = 0xc0000000; // FL after construction: the default oscillator's start phase (dumps: every LFO, enabled or not)
    } else if (type === TYPE_MAP) {
      this.flags = 0x20;
      this.len = 1.0;
      this.def = f32(1 - this.offset);
    }
  }

  get high(): number {
    return this.n - 1;
  }

  private alloc(n: number): void {
    if (this.x.length >= n) return;
    const c = Math.max(n, 4);
    const fa = () => new Float32Array(c);
    const cp = <T extends Float32Array | Float64Array | Uint8Array | Int8Array>(src: T, dst: T): T => { dst.set(src.subarray(0, this.n)); return dst; };
    this.x = cp(this.x, new Float64Array(c)); this.y = cp(this.y, fa()); this.t = cp(this.t, fa());
    this.seg = cp(this.seg, new Uint8Array(c)); this.arp = cp(this.arp, new Uint8Array(c)); this.b2 = cp(this.b2, new Uint8Array(c));
    this.kind = cp(this.kind, new Int8Array(c));
    this.c0 = cp(this.c0, fa()); this.c1 = cp(this.c1, fa()); this.c2 = cp(this.c2, fa()); this.w = cp(this.w, fa());
  }

  /** Load a stored curve (FL's Load 0x4443c0 for version 3 and the class fix-ups), then compile it. */
  load(e: OgEnv): void {
    const pts = e.p;
    const n = Math.max(pts.length, 0);
    this.alloc(Math.max(n, 1));
    let lastY = 0;
    for (let i = 0; i < n; i++) {
      const q = pts[i];
      this.x[i] = q[0] ?? 0;
      let y = f32(q[1] ?? 0);
      if (y !== y) y = lastY; // NaN level: FL keeps the previous point's level
      this.y[i] = y;
      lastY = y;
      this.t[i] = f32(q[2] ?? 0);
      this.seg[i] = (q[3] ?? 0) & 0xff;
      this.arp[i] = (q[4] ?? 0) & 0xff;
      this.b2[i] = (q[5] ?? 0) & 0xff;
      this.kind[i] = ((q[6] ?? 0) << 24) >> 24;
      this.c0[i] = 0; this.c1[i] = 0; this.c2[i] = 0; this.w[i] = 0;
    }
    this.n = n;
    const m = e.m;
    this.m0 = (m[0] ?? 0) & 0xff;
    this.enabled = m[1] ?? -1;
    this.decay = m[2] ?? -1;
    this.loop = m[3] ?? -1;
    this.sus = m[4] ?? -1;
    if (!(this.flags & 0x10)) for (let i = 0; i < n; i++) this.b2[i] = 0;
    if (!(this.flags & 4)) { this.decay = -1; this.loop = -1; this.sus = -1; }
    if (!(this.flags & 8)) this.decay = -1;
    if (this.type === TYPE_ENV && e.a && e.a.length === 4) for (let i = 0; i < 4; i++) this.adsrI[i] = e.a[i] | 0;
    if (this.type === TYPE_LFO) {
      if (e.l && e.l.length === 4) for (let i = 0; i < 4; i++) this.lfoI[i] = e.l[i] | 0;
      this.ph = (e.ph ?? 0) >>> 0;
    }
    this.fixLength();
    if (this.n === 0) {
      // FL: SetLength(points, 1) (a zero point)
      this.n = 1;
      this.x[0] = 0; this.y[0] = 0; this.t[0] = 0; this.seg[0] = 0; this.arp[0] = 0; this.b2[0] = 0; this.kind[0] = 0;
    }
    this.changed();
  }

  /** Fixed-length normalisation (0x447d00; maps: length 1.0). */
  private fixLength(): void {
    if (this.len === NO_LEN) return;
    if (this.n === 0) {
      this.insert(0, this.def, 0); // FL: point at 0 with the default value
    } else if (this.x[0] > 0) {
      this.insert(0, this.y[0], 0);
    }
    const total = this.timeTo(this.high);
    if (!(total > 0)) {
      this.insert(this.len, this.y[this.high], 0);
    } else {
      const r = this.len / total;
      // FL scales a stored curve once, when it reads it (the state reader, flstate.ts fixLength: the model keeps every curve in that form),
      // so the distances here already sum to the length up to the rounding of their sum (a relative 2e-14 for a 27 000 point map).
      // Scaling by that residual a second time would only move every distance by it, and that shifts the impulse EQ table of a large
      // pad map by an ulp where a harmonic sits on a knot (about 8 % of Autogun's presets). A curve that is really off scale is
      // still normalised.
      if (Math.abs(r - 1) > FIX_TOLERANCE) for (let i = 0; i < this.n; i++) this.x[i] = this.x[i] * r;
    }
  }

  /** Insert a point at absolute time `tm` (0x448140 with select-clear, unquantised; no Changed). */
  private insert(tm: number, yv: number, tens: number): void {
    for (let i = 0; i < this.n; i++) this.b2[i] &= 0xfe;
    let tt = tm;
    if (!(tt >= 0)) tt = 0;
    else if (tt > this.len) tt = this.len;
    let idx = this.n, d12 = 0;
    if (this.n > 0) {
      let d13 = this.x[0];
      d12 = d13;
      for (let i = 1; i <= this.high; i++) {
        d13 += this.x[i];
        if (d13 > tt) { idx = i; break; }
        d12 = d13;
      }
    }
    this.alloc(this.n + 1);
    for (let i = this.n; i > idx; i--) {
      this.x[i] = this.x[i - 1]; this.y[i] = this.y[i - 1]; this.t[i] = this.t[i - 1];
      this.seg[i] = this.seg[i - 1]; this.arp[i] = this.arp[i - 1]; this.b2[i] = this.b2[i - 1]; this.kind[i] = this.kind[i - 1];
      this.c0[i] = this.c0[i - 1]; this.c1[i] = this.c1[i - 1]; this.c2[i] = this.c2[i - 1]; this.w[i] = this.w[i - 1];
    }
    this.n++;
    const dx = tt - d12;
    this.x[idx] = dx > 0 ? dx : 0;
    this.y[idx] = yv; this.t[idx] = tens; this.seg[idx] = 0; this.arp[idx] = 0; this.b2[idx] = 0;
    if (idx < this.high) this.x[idx + 1] = this.x[idx + 1] - this.x[idx];
    // markers >= idx would shift (0x447530); maps have none at this point
    if (this.decay >= idx) this.decay++;
    if (this.loop >= idx) this.loop++;
    if (this.sus >= idx) this.sus++;
  }

  /** Time (sum of dx) up to and including point i (0x44a9b0). */
  timeTo(i: number): number {
    let d = 0;
    if (i >= 0 && i <= this.high) for (let k = 0; k <= i; k++) d += this.x[k];
    return d;
  }

  /** Level of point i with a level offset (0x44a8b0), minus the curve offset (double). */
  pointValue(i: number, ofs: number): number {
    if (!(i >= 0 && i <= this.high)) return 0;
    let v = this.y[i];
    if (ofs !== 0 || 1 / ofs < 0) {
      v = v + f32(this.w[i] * ofs);
      if (this.clamp) {
        if (v < this.lo) v = this.lo;
        else if (v > this.hi) v = this.hi;
      }
    }
    return v - this.offset;
  }

  /** Steps of stairs / pulse / wave points (0x44b5f0). */
  private steps(i: number): number {
    const s = this.seg[i];
    if (s < 3 || s > 6) return -1;
    const at = f32(Math.abs(this.t[i]));
    const xx = f32(1 - at * 0.6);
    const e = f32(lexp(xx * LN1E6) - 1);
    let r = toI32(rne(e * 0.001));
    if (s === 3 && this.t[i] >= 0) r++;
    return r;
  }

  /** Neighbouring point for smooth points (nested 0x449860): wraps inside the loop. */
  private nb(i: number, dir: number, susEnd: number, loopEnd: number): number {
    let j = i + dir;
    if (this.loop >= 0 && this.loop + 1 < this.susIdx && loopEnd < i && susEnd >= i) {
      while (loopEnd >= j) j += susEnd - loopEnd;
      while (susEnd < j) j -= susEnd - loopEnd;
    }
    if (j < 0 || j > this.high) j = -1;
    return j;
  }

  /** FL's Changed (0x448ad0) plus the class extension (TMEnvelope 0x4503e0, TMLFO 0x450a00, TMMap 0x451a80). */
  changed(): void {
    this.coefficients();
    if (this.type === TYPE_ENV) this.envScales();
    else if (this.type === TYPE_LFO) this.lfoChanged();
    else if (this.type === TYPE_MAP) this.buildTable();
  }

  private coefficients(): void {
    const n = this.high;
    this.hasArp = 0;
    this.susIdx = this.sus;
    if (this.susIdx < 0 && this.loop >= 0) this.susIdx = n;
    const dec = this.decay >= 0 ? this.decay : 0;
    const susEnd = this.sus >= 0 ? this.sus : n;
    const loopEnd = this.loop >= 0 ? this.loop : susEnd;
    let attackSum = 0, decaySum = 0, relSum = 0;
    for (let i = 0; i <= n; i++) {
      if (this.x[i] < 0) this.x[i] = 0;
      const xi = this.x[i];
      if (i <= dec) attackSum += xi;
      if (i > dec && i <= loopEnd) decaySum += xi;
      if (i > susEnd) relSum += xi;
      if (i <= 0) continue;
      const tn = this.t[i];
      const tb = fbits(tn);
      this.kind[i] = (tb << 1) === 0 ? 0 : (tb >>> 31 ? -1 : 1);
      const st = this.steps(i);
      const sg = this.seg[i];
      if (sg <= 1) {
        const e = f32(lexp(f32(Math.abs(tn)) * LN1E6) - 1);
        const sgn = (tb << 1) === 0 ? 0 : (tb >>> 31 ? -1 : 1);
        const v = f32(e * sgn);
        this.c0[i] = v;
        if (v !== 0) {
          const av = f32(Math.abs(v));
          this.c1[i] = f32(1 / av);
          this.c2[i] = f32(llog(f32(av + 1)));
        }
      } else if (sg === 3) {
        const sign = tn >= 0 ? 1 : -1;
        this.c2[i] = f32(sign * 0.5);
        this.c0[i] = f32(st + 1);
        this.c1[i] = f32(1 / f32(this.c0[i] - sign));
      } else if (sg === 4) {
        this.c0[i] = f32(st + 1);
        this.c1[i] = f32(1 / this.c0[i]);
      } else if (sg === 5) {
        const sign = tn >= 0 ? 1 : -1;
        this.c2[i] = f32(sign * 0.5);
        this.c0[i] = f32((st + 1) * 2);
        this.c1[i] = TWO_PI_F;
      } else if (sg === 6) {
        this.c0[i] = f32(f32(st) + 0.5);
        this.c1[i] = TWO_PI_F;
        if (st === 0 && this.kind[i] > 0) this.kind[i] = 2;
      } else if (sg === 7 || sg === 8) {
        this.c0[i] = tn;
      } else if (sg === 9) {
        this.c0[i] = f32(Math.abs(tn));
      } else if (sg === 10) {
        this.smoothCoef(i, susEnd, loopEnd);
      } else if (sg === 11 || sg === 12) {
        let d0 = f32(Math.abs(tn)) * 0.9;
        if (!(d0 > EPS16)) d0 = EPS16;
        const d9 = 1 - d0;
        const c0 = f32(1 - d9 * d9 * d9);
        this.c0[i] = c0;
        let c1 = f32(f32(1 - c0) / c0);
        let c2 = c1;
        if (this.kind[i] > 0) { c1 = -c1; c2 = f32(c1 - 1); }
        if (sg === 12) { c1 = f32(c1 * 0.5); c2 = f32(c2 * 0.5); }
        this.c1[i] = c1;
        this.c2[i] = c2;
      }
      if ((sg < 2 || (sg >= 7 && sg <= 9) || sg === 11 || sg === 12) && tn === 0) this.kind[i] = 2;
      if (this.arp[i] !== 0 && this.sus >= i) this.hasArp = 1;
    }
    // level offset weights
    let d8 = attackSum;
    for (let i = 0; i <= n; i++) {
      this.w[i] = 0;
      if (i > dec) {
        this.w[i] = 1;
        if (i > susEnd) {
          d8 = d8 - this.x[i];
          if (this.flags & 0x80) this.w[i] = 1;
          else this.w[i] = f32(d8 / (relSum > EPS16 ? relSum : EPS16));
        } else {
          d8 = d8 + this.x[i];
          if (i <= loopEnd) this.w[i] = f32(d8 / (decaySum > EPS16 ? decaySum : EPS16));
          if (i === susEnd) d8 = relSum;
        }
      } else if (i === dec) {
        d8 = 0;
      } else {
        d8 = d8 - this.x[i];
        this.w[i] = f32(d8 / (attackSum > EPS16 ? attackSum : EPS16));
      }
    }
    if (this.susIdx >= 0 && this.loop >= 0) {
      const d = this.timeTo(this.susIdx) - this.timeTo(this.loop);
      this.loopSusSame = d > 0 ? 0 : 1;
    } else this.loopSusSame = 0;
    this.hasArp = this.hasArp && !this.loopSusSame ? 1 : 0;
  }

  /** Smooth point coefficients (seg 10, 0x449030). */
  private smoothCoef(i: number, susEnd: number, loopEnd: number): void {
    const d9 = this.x[i] > TINY ? this.x[i] : TINY;
    let d8: number = this.y[i];
    let j = this.nb(i, -1, susEnd, loopEnd);
    const d10 = j < 0 ? d8 : this.y[j];
    let d58: number, d13: number;
    if (j >= 0 && this.seg[j] === 10) {
      d58 = this.x[j] / d9;
      const j2 = this.nb(i, -2, susEnd, loopEnd);
      d13 = j2 < 0 ? d10 : this.y[j2];
    } else {
      d58 = 1;
      d13 = d10;
    }
    j = this.nb(i, 1, susEnd, loopEnd);
    let d15: number, d11: number;
    if (j >= 0 && this.seg[j] === 10) {
      d15 = this.x[j] / d9;
      d11 = this.y[j];
    } else {
      d15 = 1;
      d11 = d8;
    }
    d8 = d8 - d10;
    if (!(Math.abs(d8) >= TINY)) {
      this.kind[i] = 2;
      return;
    }
    d13 = (d13 - d10) / d8;
    d11 = (d11 - d10) / d8;
    const sp40 = d58 > TINY ? d58 : TINY;
    const d14 = 1;
    const sp50 = d15 > TINY ? d15 : TINY;
    const sp38 = (d11 - 1) / sp50;
    const sp48 = 1 / d14;
    const sp30 = -d13 / sp40;
    const tan = (s2: number, s3: number, s5: number, s6: number): number => {
      let s1 = f32(s5 * s6);
      if (!(s1 > 0)) return 0;
      const s4 = f32(f32(2 * s3) + s2);
      const s2b = f32(s3 + f32(2 * s2));
      s1 = f32(s5 * s6);
      const s3b = f32(s1 * f32(s4 + s2b));
      return f32(s3b / f32(f32(s4 * s5) + f32(s2b * s6)));
    };
    this.c0[i] = tan(f32(d14), f32(sp50), f32(sp38), f32(sp48));
    this.c1[i] = tan(f32(sp40), f32(d14), f32(sp48), f32(sp30));
    this.c2[i] = f32(1 - f32(Math.abs(this.t[i])));
  }

  /** TMEnvelope: ADSR float scales from the ints (0x4503e0). */
  envScales(): void {
    for (let i = 0; i < 4; i++) this.adsr[i] = f32(f32(this.adsrI[i]) * INV128);
    this.susDef = this.sus >= 0 ? this.adsr[2] : 0;
  }

  /** TMLFO: oscillator shape and phase increments (0x450a00 after the base Changed). */
  private lfoChanged(): void {
    const tension = this.lfoI[1];
    let v = f32(lexp(f32(f32(Math.abs(tension)) * INV128) * 3.044522437723423) - 1);
    v = f32(v * 0.05);
    const bip = (this.m0 >> 2) & 1;
    const sgn = tension === 0 ? 0 : tension < 0 ? -1 : 1;
    const v2 = f32(lexp(v * 41.446531658199575) - 1);
    const tc = f32(sgn * v2);
    const pw = f32(f32(this.lfoI[3]) * INV128);
    const skew = f32(f32(this.lfoI[2]) * INV256);
    this.lfo.setup(bip, tc, skew, pw);
    this.incU = lfoIncrement(this.lfoI[0], this.speed);
    this.incV = this.m0 & 8 ? 0 : this.incU;
  }

  /** TMMap lookup table (0x451a80). */
  private buildTable(): void {
    this.table = null;
    if (this.res < 0) return;
    const c = mapConstant(this);
    if (c !== null) {
      this.tabOfs = 0;
      this.tabLast = 0;
      this.table = new Float32Array(1);
      this.table[0] = f32(c - this.offset);
      return;
    }
    if (isLinear2(this)) {
      this.tabOfs = 0;
      this.tabLast = 1;
      this.table = new Float32Array(2);
      this.table[0] = f32(this.y[0] - this.offset);
      this.table[1] = f32(this.y[1] - this.offset);
      this.tabScale = f32(1 / this.len);
      return;
    }
    if (this.res <= 0) return;
    const res = this.res;
    const tab = new Float32Array(res);
    this.tabOfs = 0;
    this.tabLast = 0;
    const step = this.len / (res - 1);
    const st = new OgState();
    ogReaderInit(this, st);
    let last = 0;
    for (let i = 0; i < res; i++) {
      tab[this.tabLast] = st.out;
      if (i === 0) last = tab[this.tabLast];
      else if (fbits(tab[this.tabLast]) === fbits(last)) { this.tabLast--; this.tabOfs++; }
      else last = 2147483648;
      this.tabLast++;
      ogReaderAdvance(this, st, step);
    }
    this.tabLast--;
    last = tab[this.tabLast];
    while (this.tabLast > 0 && fbits(tab[this.tabLast - 1]) === fbits(last)) this.tabLast--;
    this.table = tab.slice(0, this.tabLast + 1);
    this.tabScale = f32((res - 1) / this.len);
  }

  /** SetOffset (0x444390, TMMap 0x451610: also the default value). Recompiles. */
  setOffset(v: number): void {
    this.offset = v;
    this.changed();
    if (this.type === TYPE_MAP) this.def = f32(1 - this.offset);
  }
}


// ------------------------------------------------------------------ shapes

/** FL's tension curve on u with coefficients (k, a, b) (double). */
function tcurve(k: number, a: number, b: number, u: number): number {
  if (isPosZero(k)) return u;
  if (!signBit(k)) return 1 - (lexp((1 - u) * b) - 1) * a;
  return (lexp(u * b) - 1) * a;
}

/** Segment shape of point i at position t (the 13-way switch of 0x262fc0 / 0x263ec0; double result). */
export function shapeD(c: OgCurve, i: number, t: number): number {
  if (c.kind[i] === 2) return t;
  const kd = c.kind[i];
  const c0 = c.c0[i], c1 = c.c1[i], c2 = c.c2[i];
  switch (c.seg[i]) {
    case 0:
      return tcurve(c0, c1, c2, t);
    case 1:
      if (hi32(t) < 0x3fe00000) return tcurve(c0, c1, c2, t * 2) * 0.5;
      return 1 - tcurve(c0, c1, c2, (1 - t) * 2) * 0.5;
    case 2:
      return 0;
    case 3:
      return f32(toI32(rne(t * c0 - c2))) * c1;
    case 4: {
      const d8a = t * c0 - 0.5;
      const d10 = toI32(rne(d8a - 0.5));
      const d8 = (d8a - d10) * 2 - 1;
      let d11: number;
      if (kd < 0) {
        const q = 1 - Math.abs(d8);
        const sg = signBit(d8) ? -1 : 1;
        d11 = (1 - q * q * q) * sg;
      } else d11 = d8 * d8 * d8;
      return (d10 + d11 * 0.5 + 1) * c1;
    }
    case 5:
      return f32(toI32(rne(t * c0 - c2)) & 1);
    case 6: {
      if (kd < 0) return (lsin((t * c0 + 0.75) * c1) + 1) * 0.5;
      const d8 = t * c0 - 0.5;
      const d10 = toI32(rne(d8 - 0.5));
      return Math.abs((d8 - d10) * 2 - 1);
    }
    case 7: {
      const d10 = kd > 0 ? 1 - t : t;
      const d11 = d10 * d10 * d10;
      return t - (d11 * d11 - d10) * c0;
    }
    case 8: {
      if (hi32(t) < 0x3fe00000) {
        const u = t * 2;
        const d10 = kd > 0 ? 1 - u : u;
        const d11 = d10 * d10 * d10;
        return (u - (d11 * d11 - d10) * c0) * 0.5;
      }
      const u = (1 - t) * 2;
      const d10 = kd > 0 ? 1 - u : u;
      const d11 = d10 * d10 * d10;
      return 1 - (u - (d11 * d11 - d10) * c0) * 0.5;
    }
    case 9: {
      const d11 = kd > 0 ? lsin(t * HALF_PI_F) : 1 - lcos(t * HALF_PI_F);
      return t - (t - d11) * c0;
    }
    case 10: {
      const d10 = t * t;
      const d8 = t - 1;
      let d2 = 3 * d10 - 2 * d10 * t;
      d2 = d2 + d10 * d8 * c0;
      const d1 = d2 + t * d8 * d8 * c1;
      return t + (d1 - t) * c2;
    }
    case 11: {
      if (kd > 0) return c1 / (1 - c0 * (1 - t)) - c2;
      return c1 / (1 - c0 * t) - c2;
    }
    case 12: {
      if (hi32(t) < 0x3fe00000) {
        const u = t * 2;
        if (kd > 0) return c1 / (1 - c0 * (1 - u)) - c2;
        return c1 / (1 - c0 * u) - c2;
      }
      const u = (1 - t) * 2;
      if (kd > 0) return 1 - c1 / (1 - c0 * (1 - u)) + c2;
      return 1 - c1 / (1 - c0 * u) + c2;
    }
    default:
      return 0;
  }
}

// ----------------------------------------------------------- map readers

/** Reader start (vmt+0x118, 0x262cf0). */
export function ogReaderInit(c: OgCurve, s: OgState): void {
  s.cur = 0;
  s.ofs = 0;
  s.stage = 1;
  if (c.x[0] === 0) { s.inc = 1; s.pos = 1; } else { s.inc = c.speed / c.x[0]; s.pos = 0; }
  s.start = c.pointValue(0, 0);
  s.delta = 0;
  s.out = s.start;
  s.lfoOut = 0;
}

/** Advance a sequential read by `step` (0x263ec0): the value is in s.out. */
export function ogReaderAdvance(c: OgCurve, s: OgState, step: number): void {
  const n = c.high;
  if (s.cur >= 0 && s.cur <= n) s.pos = s.pos + step * s.inc;
  while (hi32(s.pos) >= 0x3ff00000) {
    const old = s.cur;
    if (s.inc === 0) s.pos = step;
    else s.pos = (s.pos - 1) / s.inc;
    s.start = c.pointValue(s.cur, 0);
    if (s.cur < n) s.cur++;
    else s.stage = 9;
    s.delta = c.pointValue(s.cur, 0) - s.start;
    if (s.cur === old) {
      s.pos = 0;
      s.inc = 0;
      continue;
    }
    const dt = c.x[s.cur];
    if (dt > 0) {
      s.inc = 1 / dt;
      s.pos = s.pos * s.inc;
    } else {
      s.inc = 1;
      s.pos = s.pos + 1;
    }
  }
  const v = s.cur >= 0 && s.cur <= n ? shapeD(c, s.cur, s.pos) : 0;
  s.out = s.start + v * s.delta;
}

const mapState = new OgState();

/** Value at x by a fresh read (0x266b60 without a table). */
export function ogMapAt(c: OgCurve, x: number): number {
  ogReaderInit(c, mapState);
  ogReaderAdvance(c, mapState, x);
  return mapState.out;
}

/** TMMap lookup (0x266b60): table interpolation when a table was built, else an exact read (double). */
export function ogMapValue(c: OgCurve, x: number): number {
  const tab = c.table;
  if (tab) {
    if (c.tabLast === 0) return tab[0];
    const xs = x * c.tabScale;
    const i = toI32(rne(xs - 0.5));
    if (c.tabOfs > i) return tab[0];
    if (i - c.tabOfs >= c.tabLast) return tab[c.tabLast];
    const f = xs - i;
    const j = i - c.tabOfs;
    return tab[j] * (1 - f) + tab[j + 1] * f;
  }
  return ogMapAt(c, x);
}

/** Fill n float32 samples at steps of `step` through a sequential read (the X / Y tables 0x70be0). */
export function ogMapFill32(c: OgCurve, dst: Float32Array, n: number, step: number): void {
  const st = new OgState();
  ogReaderInit(c, st);
  for (let i = 0; i < n; i++) {
    dst[i] = st.out;
    ogReaderAdvance(c, st, step);
  }
}

/** Flat curve test (0x266cf0 + 0x266da0): the common raw level, or null. */
export function ogMapConstant(c: OgCurve): number | null {
  return mapConstant(c);
}

// ------------------------------------------------------- envelope playback

/** Note-on state reset (0x262b60). */
export function ogStateInit(c: OgCurve, s: OgState): void {
  if (c.enabled !== 0) {
    s.cur = 0;
    s.ofs = 0;
    s.stage = c.decay < 0 ? 3 : 1;
    if (c.x[0] === 0) { s.inc = 1; s.pos = 1; } else { s.inc = c.speed / c.x[0]; s.pos = 0; }
    s.mode = s.stage;
    s.start = c.pointValue(0, f32(s.ofs));
    s.delta = 0;
    s.out = s.start;
    s.lfoOut = 0;
    s.arpIdx = -1; s.arp40 = -1; s.arpCount = -1;
    s.arpLevel = 0;
    s.arpHold = 0;
    s.hold = c.loopSusSame;
  } else {
    s.stage = 9; s.mode = 9; s.start = 0; s.delta = 0; s.out = 0;
  }
}

/** Sustain offset / hold setup (0x2654d0). */
export function ogSusSetup(c: OgCurve, s: OgState): void {
  s.susOfs = c.sus >= 0 ? s.scale[2] : 0;
  s.hold = s.hold !== 0 || !(s.scale[1] > 0) ? 1 : 0;
}

/** Start level with a level offset (0x265620). */
export function ogSetStartOfs(c: OgCurve, s: OgState, ofs: number): void {
  if (s.stage <= 1) s.ofs = ofs;
  else s.ofs = s.susOfs;
  s.out = c.pointValue(0, f32(s.ofs));
}

/** TMEnvelope note on (0x265550, vmt+0x110). */
export function ogEnvNoteOn(c: OgCurve, s: OgState): void {
  ogStateInit(c, s);
  s.scale.set(c.adsr);
  ogSusSetup(c, s);
  ogSetStartOfs(c, s, s.ofs);
}

/** TMLFO note on (0x265e70): neutral scales, reset, start phase. */
export function ogLfoNoteOn(c: OgCurve, s: OgState): void {
  s.scale[0] = 1; s.scale[1] = 1; s.scale[2] = 0; s.scale[3] = 1;
  s.lfoOut = 0;
  ogStateInit(c, s);
  if (c.m0 & 2) s.phase = c.gphase >>> 0;
  else s.phase = (c.lfo.startPhase() + c.ph) >>> 0;
}

/** Envelope eval (0x262fc0, vmt+0x120): advance by `step` ticks; the output is s.out. */
export function ogEnvEval(c: OgCurve, s: OgState, step: number): void {
  const n = c.high;
  if (s.cur >= 0 && s.cur <= n) s.pos = s.pos + step * s.inc;
  while (hi32(s.pos) >= 0x3ff00000) {
    if (s.inc === 0) s.pos = step;
    else s.pos = (s.pos - 1) / s.inc;
    s.start = c.pointValue(s.cur, f32(s.ofs));
    let hold: boolean;
    if (s.cur >= c.susIdx && c.susIdx >= 0 && s.stage < 6) {
      if (c.loop >= 0) {
        s.mode = 4;
        s.cur = c.loop + 1;
        hold = s.hold !== 0;
      } else hold = true;
    } else {
      if (s.cur >= c.decay && c.decay >= 0 && s.mode < 3) {
        if (s.stage < 3) s.stage = 3;
        s.mode = 3;
        s.ofs = s.susOfs;
      }
      if (s.cur < n) {
        s.cur++;
        hold = false;
      } else {
        s.stage = 9;
        hold = true;
      }
    }
    s.delta = c.pointValue(s.cur, f32(s.ofs)) - s.start;
    if (hold) {
      s.pos = 0;
      s.inc = 0;
      continue;
    }
    let dt: number = c.x[s.cur];
    const idx = (s.stage >= 6 && c.sus >= 0 ? 2 : 0) + (s.stage >= 3 ? 1 : 0);
    dt = dt * s.scale[idx];
    if (dt > 0) {
      s.inc = c.speed / dt;
      s.pos = s.pos * s.inc;
    } else {
      s.inc = 1;
      s.pos = s.pos + 1;
    }
  }
  if (s.delta === 0) {
    s.out = s.start;
    return;
  }
  const v = s.cur >= 0 && s.cur <= n ? shapeD(c, s.cur, s.pos) : 0;
  s.out = s.start + v * s.delta;
}

/** Note off (0x262dd0): to the release stage. */
export function ogEnvRelease(c: OgCurve, s: OgState): void {
  if (s.stage >= 6) return;
  if (c.sus >= 0) {
    s.cur = c.sus;
    const save = c.clamp;
    c.clamp = 0;
    const d9 = s.ofs, d8 = s.out;
    const v = c.pointValue(s.cur, f32(s.ofs));
    s.ofs = d9 + (d8 - v);
    c.clamp = save;
    s.pos = 1;
    s.mode = 6;
  }
  s.stage = 6;
  if (s.inc === 0) s.pos = 1;
}

/** Skip the attack to a fraction `t` of the time to the decay point (0x264c70, "link velocity to attack length"). */
export function ogEnvSkipAttack(c: OgCurve, s: OgState, t: number): void {
  if (c.decay >= 0) ogEnvEval(c, s, (c.timeTo(c.decay) * s.scale[0] * t) / c.speed);
}

/** Time base change (0x267720 -> vmt+0x140): `time` per tick, or `tempo` per tick with the tempo marker (m[0] bit 0). */
export function ogSetSpeed(c: OgCurve, time: number, tempo: number): void {
  c.ratio = c.speed;
  c.speed = c.m0 & 1 ? tempo : time;
  c.ratio = c.speed / c.ratio;
  if (c.type === TYPE_LFO) c.changed();
}

/** TMLFO eval (0x265f20): the amount curve and the oscillator; the output is s.lfoOut. */
export function ogLfoEval(c: OgCurve, s: OgState, step: number): void {
  const atStart = (): boolean => s.cur === 0 && s.stage < 9 && hi32(s.pos) < 0x3ff00000;
  let d8: number;
  if (atStart()) {
    let d1 = step + (s.pos - 1) / s.inc;
    if (!(d1 > 0)) d1 = 0;
    d8 = d1;
  } else d8 = step;
  ogEnvEval(c, s, step);
  if (!atStart()) {
    s.phase = (s.phase + toU32(rne(d8 * c.incV))) >>> 0;
    s.lfoOut = s.out * c.lfo.value(s.phase);
  }
}

/** Compile a stored curve as an envelope, LFO or mapping (flags / table resolution as the owner sets them). */
export function ogCompile(e: OgEnv, kind: 'env' | 'lfo' | 'map', opts?: { offset?: number; res?: number; flags?: number }): OgCurve {
  const c = new OgCurve(kind === 'env' ? TYPE_ENV : kind === 'lfo' ? TYPE_LFO : TYPE_MAP);
  if (opts?.flags !== undefined) c.flags = opts.flags;
  if (opts?.res !== undefined) c.res = opts.res;
  if (opts?.offset !== undefined) {
    c.offset = opts.offset;
    if (c.type === TYPE_MAP) c.def = f32(1 - c.offset);
  }
  c.load(e);
  return c;
}
