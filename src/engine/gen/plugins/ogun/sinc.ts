// Ogun's highest resampler quality (processing quality "Huge": resampler byte 6, also forced while the project is rendered):
// FL's TResampler windowed-sinc kernel (kernel 3, 32 points per side) as Ogun_x64.dylib runs it on the oscillator's interleaved
// (re, im) frames: per output frame four sines (ippsSin_64f) start two recurrences in doubles, float32 vector lanes (the NEON routine
// at 0x383c: reciprocals by FRECPE and two Newton steps, a Hamming-like window, 16 iterations of four taps) accumulate, and the
// two halves are averaged. The kernel is the one Fruity Slicer's voices use (../slicer/interp.ts, a lane-by-lane transcription of the
// same NEON code); what differs here is the setup: no widening of the kernel for fast playback and the cutoff B = (1 / speed) pi.
//
// FL addresses: set speed 0x26bac0, per-frame setup 0x1ff820 (the sine arguments 0x1ff9e0), NEON routine 0x383c.

import { frecpe } from '../slicer/interp';
import { cos as libmCos } from '../harmor/fx-libm';

const f32 = Math.fround;
const PI = 3.141592653589793;
const TWO_PI_F = f32(6.2831854820251465);
const W0 = f32(0.36), W1 = f32(0.64);
/** Points per side of the resampler byte 6 (the table at 0x371188). */
const TAPS = 32;

/** ARM FRECPS: 2 - a b with one rounding (fused). */
function frecps(a: number, b: number): number {
  if ((a === 0 && !Number.isFinite(b)) || (b === 0 && !Number.isFinite(a))) return 2;
  return f32(2 - a * b);
}

export class OgunSinc {
  /** FL +0x128 / +0x140: pi / taps and 2 cos(pi / taps); +0x130 / +0x138: the cutoff phase step and 2 cos of it. */
  private readonly A = PI / TAPS;
  private readonly cA2 = 2 * libmCos(PI / TAPS);
  private B = PI;
  private cB2 = -2;

  /** 0x26bac0: the playback speed sets the anti-aliasing cutoff (the kernel stays 32 points wide). */
  setSpeed(speed: number): void {
    const s = Math.abs(speed);
    this.B = (s > 1 ? 1 / s : 1) * PI;
    this.cB2 = 2 * libmCos(this.B);
  }

  /**
   * One output frame at position (c + f) of the interleaved (re, im) frames in `ext` (frame c holds the position's integer part,
   * 0 <= f < 1; 32 frames of padding on both sides), into out[oi], out[oi + 1].
   */
  run(ext: Float32Array, c: number, f: number, out: Float32Array, oi: number): void {
    if (f < 1e-25) f = 1e-25; // ippsThreshold_LT_64f_I
    const A = this.A, B = this.B;
    const s0 = Math.sin(1.5707963267948966 - f * A), s1 = Math.sin(1.5707963267948966 - f * A - A);
    const s2 = Math.sin(f * B), s3 = Math.sin(f * B + B);
    const ra1 = this.cA2 * s0 - s1, ra2 = this.cA2 * ra1 - s0;
    const rb1 = this.cB2 * s2 - s3, rb2 = this.cB2 * rb1 - s2;
    // a = {sin((f-1)B), sin(fB), cos((f-1)A), cos(fA)}, b = {sin((f-2)B), sin((f+1)B), cos((f-2)A), cos((f+1)A)}
    let a0 = f32(rb1), a1 = f32(s2), a2 = f32(ra1), a3 = f32(s0);
    let b0 = f32(rb2), b1 = f32(s3), b2 = f32(ra2), b3 = f32(s1);
    const x = f * PI;
    let x0 = f32(x - PI), x1 = f32(x), x2 = f32(x - PI - PI), x3 = f32(x + PI);
    const c0 = f32(this.cB2), c2 = f32(this.cA2);
    let accL0 = 0, accR0 = 0, accL1 = 0, accR1 = 0;
    const last = (ext.length >> 1) - 1;
    const half = TAPS >> 1;
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
      let j = c + 1 + 2 * it;
      let o = 2 * (j < 0 ? 0 : j > last ? last : j);
      accL0 = f32(accL0 + f32(ext[o] * k0)); accR0 = f32(accR0 + f32(ext[o + 1] * k0));
      j = c - 2 * it;
      o = 2 * (j < 0 ? 0 : j > last ? last : j);
      accL1 = f32(accL1 + f32(ext[o] * k1)); accR1 = f32(accR1 + f32(ext[o + 1] * k1));
      // frames +2+2it (lane 2's x) and -1-2it (lane 3's x): window(b2 / b3) sin(b0 / b1) / x
      const wc = f32(W0 + f32(b2 + f32(b2 * f32(W1 * b2))));
      const wd = f32(W0 + f32(b3 + f32(b3 * f32(W1 * b3))));
      const k2 = f32(wc * f32(b0 * r2)), k3 = f32(wd * f32(b1 * r3));
      const nb0 = f32(f32(c0 * a0) - b0), nb1 = f32(f32(c0 * a1) - b1), nb2 = f32(f32(c2 * a2) - b2), nb3 = f32(f32(c2 * a3) - b3);
      b0 = nb0; b1 = nb1; b2 = nb2; b3 = nb3;
      j = c + 2 + 2 * it;
      o = 2 * (j < 0 ? 0 : j > last ? last : j);
      accL0 = f32(accL0 + f32(ext[o] * k2)); accR0 = f32(accR0 + f32(ext[o + 1] * k2));
      j = c - 1 - 2 * it;
      o = 2 * (j < 0 ? 0 : j > last ? last : j);
      accL1 = f32(accL1 + f32(ext[o] * k3)); accR1 = f32(accR1 + f32(ext[o + 1] * k3));
    }
    out[oi] = f32(f32(accL0 + accL1) * 0.5);
    out[oi + 1] = f32(f32(accR0 + accR1) * 0.5);
  }
}
