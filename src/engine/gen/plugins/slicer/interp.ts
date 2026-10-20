// FL's TResampler interpolation kernels as Fruity Slicer's voices use them (FL 2026, Fruity
// Slicer_x64.dylib, arm64): kernel 1 (linear, 0x1a5070) and kernel 3 (windowed sinc,
// 0x1a6d40 -> 0x1a7130 / ippsSin_64f / NEON routine 0x44a4), with FL's tap gathering at the
// slice edges (0x1a8a40: taps outside the slice repeat its first / last frame). The sinc
// kernel is a lane-by-lane transcription of FL's NEON code in float32, including the ARM
// reciprocal estimate (FRECPE) and the fused reciprocal step (FRECPS). See
// docs/research/gen/slicer.md.

const f32 = Math.fround;

/** FPD_ProcessMode interpolation points -> FL's kernel (0x6cf60): 1 linear, 2 three-point, 3 sinc. */
export function kernelOf(points: number): { kind: 1 | 2 | 3; taps: number } {
  if (points <= 2) return { kind: 1, taps: 1 };
  if (points === 3) return { kind: 2, taps: 3 };
  return { kind: 3, taps: Math.min(512, points) };
}

// ------------------------------------------------------------------ ARM reciprocal estimate
const cvF = new Float32Array(1);
const cvI = new Uint32Array(cvF.buffer);

/** ARM FRECPE (FPRecipEstimate, single precision, round to nearest, no flush to zero). */
export function frecpe(x: number): number {
  cvF[0] = x;
  const bits = cvI[0];
  const sign = bits & 0x80000000;
  let exp = (bits >>> 23) & 0xff;
  let frac = bits & 0x7fffff;
  if (exp === 0xff) {
    if (frac !== 0) return NaN;
    cvI[0] = sign; return cvF[0]; // 1 / inf = 0
  }
  if (exp === 0 && frac === 0) { cvI[0] = sign | 0x7f800000; return cvF[0]; }
  if (exp === 0) {
    // denormal input
    if ((frac & 0x400000) === 0) { exp = -1; frac = (frac << 2) & 0x7fffff; } else frac = (frac << 1) & 0x7fffff;
    // inputs this small overflow the estimate
    if (exp === -1 || (frac >>> 15) < 0) { /* falls through to the general formula */ }
  }
  const scaled = 0x100 | (frac >>> 15); // '1' : fraction<22:15>
  let resExp = 253 - exp;
  const a = scaled * 2 + 1;
  const b = Math.floor((1 << 19) / a);
  const est = (b + 1) >> 1; // 256..511
  let rfrac = (est & 0xff) << 15;
  if (resExp >= 255) { cvI[0] = sign | 0x7f800000; return cvF[0]; }
  if (resExp === 0) rfrac = 0x400000 | (rfrac >>> 1);
  else if (resExp === -1) { rfrac = 0x200000 | (rfrac >>> 2); resExp = 0; }
  else if (resExp < -1) { cvI[0] = sign; return cvF[0]; }
  cvI[0] = sign | (resExp << 23) | rfrac;
  return cvF[0];
}

/** ARM FRECPS: 2 - a b with one rounding (fused). */
function frecps(a: number, b: number): number {
  if ((a === 0 && !Number.isFinite(b)) || (b === 0 && !Number.isFinite(a))) return 2;
  return f32(2 - a * b);
}

// ------------------------------------------------------------------ kernels
const F_PI = 3.141592653589793;
const TWO_PI_F = f32(6.2831854820251465);
const W0 = f32(0.36), W1 = f32(0.64);

/** Sinc kernel state of a resampler (FL's +0xec taps, +0x128..+0x140). */
export class SincKernel {
  /** Kernel size (points per side). */
  taps = 24;
  /** pi / taps and 2 cos(pi / taps) (window recurrence), FL +0x128 / +0x140. */
  private A = F_PI / 24;
  private cA2 = 2 * Math.cos(F_PI / 24);
  /** Sinc phase step (pi, or pi / speed when speeding up: anti-aliasing) and 2 cos of it. */
  private B = F_PI;
  private cB2 = -2;
  private base = 24;
  private speed = 1;

  /** FL's SetQuality: the kernel size for `points`. */
  setPoints(points: number): void {
    this.base = Math.max(4, Math.min(512, points));
    this.setSize(this.base);
    this.setSpeed(this.speed, true);
  }

  /** FL 0x1a7590. */
  private setSize(t: number): void {
    this.taps = t;
    if (t >= 7) {
      this.A = F_PI / t;
      this.cA2 = 2 * Math.cos(this.A);
    }
  }

  /** FL's SetSpeed (0x1a80f0) part for the sinc kernel: anti-alias cutoff and kernel widening. */
  setSpeed(speed: number, force = false): void {
    const s = Math.abs(speed);
    if (!force && s === this.speed) return;
    this.speed = s;
    if (s > 1) { this.B = F_PI / s; this.cB2 = 2 * Math.cos(this.B); } else { this.B = F_PI; this.cB2 = -2; }
    let t = Math.trunc(Math.round(s) + 3) & ~3;
    t = Math.max(this.base, t);
    if (t > 512) t = 512;
    if (t !== this.taps) this.setSize(t);
  }

  /**
   * One output frame at position k + f (k = frame, 0 <= f < 1) of the slice frames
   * [st, st + len) of L / R (taps outside repeat the first / last frame), into out[0..1].
   */
  run(L: Float32Array, R: Float32Array, st: number, len: number, k: number, f: number, out: Float32Array): void {
    if (f < 1e-25) f = 1e-25; // ippsThreshold_LT_64f_I
    const A = this.A, B = this.B;
    const s0 = Math.sin(1.5707963267948966 - f * A), s1 = Math.sin(1.5707963267948966 - f * A - A);
    const s2 = Math.sin(f * B), s3 = Math.sin(f * B + B);
    const ra1 = this.cA2 * s0 - s1, ra2 = this.cA2 * ra1 - s0;
    const rb1 = this.cB2 * s2 - s3, rb2 = this.cB2 * rb1 - s2;
    // v16 = {sin((f-1)B), sin(fB), cos((f-1)A), cos(fA)}, v7 = {sin((f-2)B), sin((f+1)B), cos((f-2)A), cos((f+1)A)}
    let a0 = f32(rb1), a1 = f32(s2), a2 = f32(ra1), a3 = f32(s0);
    let b0 = f32(rb2), b1 = f32(s3), b2 = f32(ra2), b3 = f32(s1);
    const x = f * F_PI;
    let x0 = f32(x - F_PI), x1 = f32(x), x2 = f32(x - F_PI - F_PI), x3 = f32(x + F_PI);
    const c0 = f32(this.cB2), c2 = f32(this.cA2);
    let accL0 = 0, accR0 = 0, accL1 = 0, accR1 = 0;
    const last = len - 1;
    const half = this.taps >> 1;
    for (let it = 0; it < half; it++) {
      // 1 / x: FRECPE, a fused step, an unfused step
      let r0 = frecpe(x0), r1 = frecpe(x1), r2 = frecpe(x2), r3 = frecpe(x3);
      r0 = f32(r0 * frecps(r0, x0)); r1 = f32(r1 * frecps(r1, x1)); r2 = f32(r2 * frecps(r2, x2)); r3 = f32(r3 * frecps(r3, x3));
      r0 = f32(f32(r0 + r0) - f32(r0 * f32(x0 * r0)));
      r1 = f32(f32(r1 + r1) - f32(r1 * f32(x1 * r1)));
      r2 = f32(f32(r2 + r2) - f32(r2 * f32(x2 * r2)));
      r3 = f32(f32(r3 + r3) - f32(r3 * f32(x3 * r3)));
      // weights of frames +1+2it (lane 0) and -2it (lane 1): window(a2 / a3) sin(a0 / a1) / x
      const u0 = f32(a0 * r0), u1 = f32(a1 * r1);
      const wa = f32(W0 + f32(a2 + f32(a2 * f32(W1 * a2))));
      const wb = f32(W0 + f32(a3 + f32(a3 * f32(W1 * a3))));
      const k0 = f32(wa * u0), k1 = f32(wb * u1);
      const na0 = f32(f32(c0 * b0) - a0), na1 = f32(f32(c0 * b1) - a1), na2 = f32(f32(c2 * b2) - a2), na3 = f32(f32(c2 * b3) - a3);
      a0 = na0; a1 = na1; a2 = na2; a3 = na3;
      x0 = f32(x0 - TWO_PI_F); x1 = f32(x1 + TWO_PI_F); x2 = f32(x2 - TWO_PI_F); x3 = f32(x3 + TWO_PI_F);
      // taps outside the slice repeat its first / last frame (FL 0x1a8a40)
      let j = k + 1 + 2 * it;
      let ix = st + (j < 0 ? 0 : j > last ? last : j);
      accL0 = f32(accL0 + f32(L[ix] * k0)); accR0 = f32(accR0 + f32(R[ix] * k0));
      j = k - 2 * it;
      ix = st + (j < 0 ? 0 : j > last ? last : j);
      accL1 = f32(accL1 + f32(L[ix] * k1)); accR1 = f32(accR1 + f32(R[ix] * k1));
      // frames +2+2it (lane 2's x) and -1-2it (lane 3's x): window(b2 / b3) sin(b0 / b1) / x
      const wc = f32(W0 + f32(b2 + f32(b2 * f32(W1 * b2))));
      const wd = f32(W0 + f32(b3 + f32(b3 * f32(W1 * b3))));
      const k2 = f32(wc * f32(b0 * r2)), k3 = f32(wd * f32(b1 * r3));
      const nb0 = f32(f32(c0 * a0) - b0), nb1 = f32(f32(c0 * a1) - b1), nb2 = f32(f32(c2 * a2) - b2), nb3 = f32(f32(c2 * a3) - b3);
      b0 = nb0; b1 = nb1; b2 = nb2; b3 = nb3;
      j = k + 2 + 2 * it;
      ix = st + (j < 0 ? 0 : j > last ? last : j);
      accL0 = f32(accL0 + f32(L[ix] * k2)); accR0 = f32(accR0 + f32(R[ix] * k2));
      j = k - 1 - 2 * it;
      ix = st + (j < 0 ? 0 : j > last ? last : j);
      accL1 = f32(accL1 + f32(L[ix] * k3)); accR1 = f32(accR1 + f32(R[ix] * k3));
    }
    out[0] = f32(f32(accL0 + accL1) * 0.5);
    out[1] = f32(f32(accR0 + accR1) * 0.5);
  }
}

/** FL's linear kernel (0x1a5070) at k + f with FL's edge taps. */
export function linearAt(L: Float32Array, R: Float32Array, st: number, len: number, k: number, f: number, out: Float32Array): void {
  const last = len - 1;
  const i0 = st + (k < 0 ? 0 : k > last ? last : k);
  const k1 = k + 1;
  const i1 = st + (k1 < 0 ? 0 : k1 > last ? last : k1);
  const g = 1 - f;
  out[0] = f32(L[i0] * g + L[i1] * f);
  out[1] = f32(R[i0] * g + R[i1] * f);
}
