// Shared building blocks of Harmor's global FX (FL Studio 2026 Harmor_x64.dylib,
// arm64 slice; addresses below are that binary's). Each piece reproduces FL's
// code operation by operation: float32 where FL computes in float32
// (Math.fround after every operation), double where FL uses double, FL's
// operation order and no fused multiply-adds (FL's FX code uses separate
// fmul / fadd everywhere checked).
//
// FL keeps its audio interleaved (L, R, L, R ...); every buffer here is an
// interleaved stereo Float32Array with frame i at [2i, 2i + 1].
//
// See fx.ts for the unit chain and docs of each effect.

import { exp } from './fx-libm';
import { sin as libmSin } from './fx-libm';

export const f32 = Math.fround;

export const LN2 = 0.6931471805599453;
/** FL's runtime constant a2d264: float32 ln 3 (0x3f8c9f54). */
export const LN3F = f32(1.0986123085021973);
/** ln(0.01) (FL a35580, double): the -40 dB target of FL's one-pole time constants. */
export const LN001 = -4.605170185988091;
/** FL a2d248: ln 2 / 12 (double 0x3fad9303fea2f7e9). */
const LN2_12 = 0.057762265046662105;
/** FL a97148: float32 440 exp((0 - 57) ln2 / 12) (0xfcac0), the frequency of FL key 0 (16.35 Hz). */
export const NOTE0_HZ = f32(440 * exp((0 - 57) * LN2_12));
/** FL a2d21c: float32 1 / sin(pi/4) (pan law gain). */
export const SQRT2F = f32(1 / libmSin(0.7853981633974483));
/** FL's silence / denormal threshold 8ec63c: 2^-24 as float32. */
export const EPS24 = 5.960464477539063e-8;
/** float32 constants used by FL (read from the binary's __DATA). */
export const F001 = f32(0.001);
export const F01 = f32(0.01);

// Bit views for float32 bit tests.
const cvt = new ArrayBuffer(8);
const cvtF = new Float32Array(cvt);
const cvtU = new Uint32Array(cvt);
const cvtI = new Int32Array(cvt);

/** Bit pattern (uint32) of a float32 value. */
export function bitsOf(x: number): number {
  cvtF[0] = x;
  return cvtU[0];
}
/** Bit pattern as int32 (FL compares float bits as signed integers in places). */
export function ibitsOf(x: number): number {
  cvtF[0] = x;
  return cvtI[0];
}
/** FL's `x == 1.0` test on float32 bits (0x3f800000). */
export function isOneF(x: number): boolean {
  return bitsOf(x) === 0x3f800000;
}

/**
 * FL's volume law (ProcessParam 0xd2718 post volume, 0xcac00 part / pre volume,
 * 0xd314c distortion wet): x = f32(v * 0.001f); x == 1 ? 1 : f32((exp(f32(x ln3)) - 1) * 0.5).
 */
export function volLaw(v: number): number {
  const x = f32(f32(v) * F001);
  if (isOneF(x)) return x;
  return f32((exp(f32(x * LN3F)) - 1) * 0.5);
}

/** FPC's Math.tanh (0x167c20): +-1 beyond +-5678.22, else (1 - e^-2x) / (1 + e^-2x) in double. */
export function tanhFpc(x: number): number {
  if (x > 5678.2224944132204) return 1;
  if (x < -5678.2224944132204) return -1;
  const e = exp(-2 * x);
  return (1 - e) / (1 + e);
}

/** frintx (round to nearest, ties to even: FL's default FPCR) of a double. */
export function rint(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** frinta (round half away from zero) on a float32 value: FL's ippsRound_32f. */
export function frinta(x: number): number {
  if (x !== x) return x;
  const a = Math.abs(x);
  if (a >= 8388608) return x;
  const r = Math.floor(a + 0.5);
  return x < 0 || (x === 0 && 1 / x < 0) ? -r : r;
}

// ---------------------------------------------------------------- element-wise IPP ops
// FL's dsp_ippv2 forwards these to vDSP (vadd, vmul, vsadd, vsmul, vsq, vabs) or
// does them in NEON: one IEEE float32 operation per element, exact.

export function addI(src: Float32Array, so: number, dst: Float32Array, dof: number, n: number): void {
  for (let i = 0; i < n; i++) dst[dof + i] = dst[dof + i] + src[so + i];
}
export function add3(a: Float32Array, ao: number, b: Float32Array, bo: number, dst: Float32Array, dof: number, n: number): void {
  for (let i = 0; i < n; i++) dst[dof + i] = a[ao + i] + b[bo + i];
}
export function mulI(src: Float32Array, so: number, dst: Float32Array, dof: number, n: number): void {
  for (let i = 0; i < n; i++) dst[dof + i] = dst[dof + i] * src[so + i];
}
export function mulCI(c: number, dst: Float32Array, dof: number, n: number): void {
  for (let i = 0; i < n; i++) dst[dof + i] = dst[dof + i] * c;
}
export function mulC(src: Float32Array, so: number, c: number, dst: Float32Array, dof: number, n: number): void {
  for (let i = 0; i < n; i++) dst[dof + i] = src[so + i] * c;
}
export function addCI(c: number, dst: Float32Array, dof: number, n: number): void {
  for (let i = 0; i < n; i++) dst[dof + i] = dst[dof + i] + c;
}
export function abs(src: Float32Array, so: number, dst: Float32Array, dof: number, n: number): void {
  for (let i = 0; i < n; i++) dst[dof + i] = Math.abs(src[so + i]);
}
export function sqr(src: Float32Array, so: number, dst: Float32Array, dof: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const x = src[so + i];
    dst[dof + i] = x * x;
  }
}
export function round(src: Float32Array, so: number, dst: Float32Array, dof: number, n: number): void {
  for (let i = 0; i < n; i++) dst[dof + i] = frinta(src[so + i]);
}
/** ippsAndC_32u_I(0x80000000) then ippsOrC_32u_I(0x3f800000): x -> +-1 by its sign bit. */
export function signOne(buf: Float32Array, off: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const x = buf[off + i];
    buf[off + i] = x < 0 || (x === 0 && 1 / x < 0) || (x !== x && bitsOf(x) >= 0x80000000) ? -1 : 1;
  }
}

// ---------------------------------------------------------------- FL's gain "ramp" record

/**
 * FL's 4-channel float ramp record (tgt[4] at +0x4, cur[4] at +0x14, coefficient k at
 * +0x24) with its helpers. FL's sync (0x460af0) snaps cur to tgt whenever they differ,
 * so a gain change applies at the next call (no ramp); fill() keeps FL's one-block
 * kick (its exponential step is applied once and never decayed).
 */
export class FlRamp {
  private readonly buf = new ArrayBuffer(32);
  readonly tgt = new Float32Array(this.buf, 0, 4);
  readonly cur = new Float32Array(this.buf, 16, 4);
  private readonly tgtU = new Uint32Array(this.buf, 0, 4);
  private readonly curU = new Uint32Array(this.buf, 16, 4);
  /** +0x24 (float32). */
  k = 0;

  /** Set both used channel targets. */
  set(l: number, r: number): void {
    this.tgt[0] = l;
    this.tgt[1] = r;
  }

  /** cur := tgt (all four channels). */
  snap(): void {
    for (let i = 0; i < 4; i++) this.cur[i] = this.tgt[i];
  }

  /** 0x460af0: if any |cur - tgt| > 2^-24, cur := tgt and return true. */
  sync(): boolean {
    let ch = false;
    for (let i = 0; i < 4; i++) if (Math.abs(f32(this.cur[i] - this.tgt[i])) > EPS24) ch = true;
    if (ch) this.snap();
    return ch;
  }

  /** 0x460c90: bits of tgt0, tgt1, cur0, cur1 all zero. */
  isZero(): boolean {
    return (this.tgtU[0] | this.tgtU[1] | this.curU[0] | this.curU[1]) === 0;
  }

  /** 0x4604a0: dst = src * gain (interleaved stereo, n frames). */
  gain(src: Float32Array, so: number, dst: Float32Array, dof: number, n: number): void {
    if (this.sync()) {
      // 0x4607f0 (cur == tgt after the sync: d = 0)
      let dl = f32(this.cur[0] - this.tgt[0]);
      let dr = f32(this.cur[1] - this.tgt[1]);
      const k = this.k, tl = this.tgt[0], tr = this.tgt[1];
      for (let i = 0; i < n; i++) {
        dl = f32(dl * k);
        dr = f32(dr * k);
        dst[dof + 2 * i] = src[so + 2 * i] * f32(dl + tl);
        dst[dof + 2 * i + 1] = src[so + 2 * i + 1] * f32(dr + tr);
      }
      this.cur[0] = f32(dl + tl);
      this.cur[1] = f32(dr + tr);
      return;
    }
    if ((this.tgtU[0] | this.tgtU[1]) === 0) {
      dst.fill(0, dof, dof + 2 * n);
      return;
    }
    const gl = this.tgt[0], gr = this.tgt[1];
    for (let i = 0; i < n; i++) {
      dst[dof + 2 * i] = src[so + 2 * i] * gl;
      dst[dof + 2 * i + 1] = src[so + 2 * i + 1] * gr;
    }
  }

  /** 0x460370: dst += src * gain (separate fmul and fadd). */
  addGain(src: Float32Array, so: number, dst: Float32Array, dof: number, n: number): void {
    if (this.sync()) {
      // 0x460600
      let dl = f32(this.cur[0] - this.tgt[0]);
      let dr = f32(this.cur[1] - this.tgt[1]);
      const k = this.k, tl = this.tgt[0], tr = this.tgt[1];
      for (let i = 0; i < n; i++) {
        dl = f32(dl * k);
        dr = f32(dr * k);
        const j = dof + 2 * i;
        dst[j] = dst[j] + f32(src[so + 2 * i] * f32(dl + tl));
        dst[j + 1] = dst[j + 1] + f32(src[so + 2 * i + 1] * f32(dr + tr));
      }
      this.cur[0] = f32(dl + tl);
      this.cur[1] = f32(dr + tr);
      return;
    }
    if ((this.tgtU[0] | this.tgtU[1]) === 0) return;
    const gl = this.tgt[0], gr = this.tgt[1];
    for (let i = 0; i < n; i++) {
      const j = dof + 2 * i;
      dst[j] = dst[j] + f32(src[so + 2 * i] * gl);
      dst[j + 1] = dst[j + 1] + f32(src[so + 2 * i + 1] * gr);
    }
  }

  /** 0x4609c0: dst = per channel f32(f32(k * f32(cur - tgt)) + cur) for all n frames, then cur := tgt. */
  fill(dst: Float32Array, dof: number, n: number): void {
    const vl = f32(f32(this.k * f32(this.cur[0] - this.tgt[0])) + this.cur[0]);
    const vr = f32(f32(this.k * f32(this.cur[1] - this.tgt[1])) + this.cur[1]);
    for (let i = 0; i < n; i++) {
      dst[dof + 2 * i] = vl;
      dst[dof + 2 * i + 1] = vr;
    }
    this.snap();
  }

  reset(): void {
    this.tgt.fill(0);
    this.cur.fill(0);
  }
}

// ---------------------------------------------------------------- Harmor's biquad record

/**
 * Harmor's 0x78-byte biquad record: type at +0x0, frequency (float32) at +0x8,
 * state (x1, x2, y1, y2 for L and R, doubles) at +0x10, coefficients b0 b1 b2 a1 a2
 * (doubles) at +0x50. Design 0x395950 (RBJ cookbook), processing kernel 0x23a0
 * (G[a35610]): stereo Direct Form I in double, float32 in / out, both channels per call.
 */
export class FlBiquad {
  type = 0;
  freq = 0;
  /** [x1L, x1R, x2L, x2R, y1L, y1R, y2L, y2R] */
  readonly st = new Float64Array(8);
  b0 = 0;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;

  resetState(): void {
    this.st.fill(0);
  }

  /** 0x395950(rec, gain, alpha, sin w, cos w) for the types Harmor's FX use (1 low pass, 4 high pass). */
  design(_gain: number, alpha: number, _s: number, c: number): void {
    const t = this.type;
    if (t < 1) return;
    if (t === 1) {
      const a0 = 1 / (1 + alpha);
      this.a1 = a0 * (-2 * c);
      this.a2 = a0 * (1 - alpha);
      this.b1 = a0 * (1 - c);
      this.b0 = this.b1 * 0.5;
      this.b2 = this.b0;
    } else if (t === 4) {
      const a0 = 1 / (1 + alpha);
      this.a1 = a0 * (-2 * c);
      this.a2 = a0 * (1 - alpha);
      this.b1 = a0 * -(1 + c);
      this.b0 = -this.b1 * 0.5;
      this.b2 = this.b0;
    } else {
      throw new Error('FlBiquad: type ' + t + ' not ported');
    }
  }

  /** Kernel 0x23a0: in place on interleaved stereo frames buf[off .. off + 2n). */
  process(buf: Float32Array, off: number, n: number): void {
    const s = this.st;
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let x1l = s[0], x1r = s[1], x2l = s[2], x2r = s[3];
    let y1l = s[4], y1r = s[5], y2l = s[6], y2r = s[7];
    for (let i = 0; i < n; i++) {
      const j = off + 2 * i;
      const xl = buf[j], xr = buf[j + 1];
      const yl = (b2 * x2l + b1 * x1l - a1 * y1l - a2 * y2l) + b0 * xl;
      const yr = (b2 * x2r + b1 * x1r - a1 * y1r - a2 * y2r) + b0 * xr;
      buf[j] = yl;
      buf[j + 1] = yr;
      x2l = x1l; x1l = xl; y2l = y1l; y1l = yl;
      x2r = x1r; x1r = xr; y2r = y1r; y1r = yr;
    }
    s[0] = x1l; s[1] = x1r; s[2] = x2l; s[3] = x2r;
    s[4] = y1l; s[5] = y1r; s[6] = y2l; s[7] = y2r;
  }
}

/**
 * FL's sample-rate record (0x1034c0, x[plug+0xd0]): the values the FX read from it.
 */
export class FlRate {
  readonly sr: number;
  /** +0x20 1/sr (double) */
  readonly inv: number;
  /** +0x28 44100/sr (double) */
  readonly r441: number;
  /** +0x30 2 pi / sr (double) */
  readonly w: number;
  /** +0x38 f32(0.4999 sr) */
  readonly nyq: number;
  /** +0x3c f32(0.001 * 44100 / sr) */
  readonly step: number;
  /** +0x48 f32(exp(ln 0.01 / (15 ms in samples))) */
  readonly k15: number;

  constructor(sampleRate: number) {
    const sr = Math.round(sampleRate) | 0;
    this.sr = sr;
    this.inv = 1 / sr;
    this.r441 = 44100 / sr;
    this.w = 6.283185307179586 * this.inv;
    this.nyq = f32(sr * 0.4999);
    this.step = f32(0.001 * this.r441);
    this.k15 = f32(exp(LN001 / (15 * 0.001 * sr)));
  }
}
