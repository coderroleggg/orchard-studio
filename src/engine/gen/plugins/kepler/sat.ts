// Kepler Exo saturation effect (engine.dylib 0x30c1c process, 0x30dac amount, 0x30bd4 sample rate, 0x30c14 HQ,
// 0x30d08 anti-aliased tanh): a drive (tan of the cube root of the amount) follows a 50 ms smoother, the stereo
// signal goes through the rational tanh of the filter code, normalised by the tanh of the drive; the HQ mode uses the
// first-order anti-derivative anti-aliased tanh (log cosh) instead.

import { f32, fma32 } from './fmath';
import { powf, tanf, logf, tanhf, coshf } from './applemath';
import { tanhApprox } from './filter';
import { coefTime } from './voice';

/** The drive (gain before the shaper) for an amount 0..1: tan(cbrt(amount) * 1.55). */
export function satDrive(amount: number): number {
  return tanf(f32(powf(f32(amount), f32(0.3333333432674408)) * f32(1.5499999523162842)));
}

/** The static transfer curve: tanh approximation of 3 x drive, normalised by 3 tanh(drive) (what the processor does per sample before the ADAA variant). */
export function satShape(x: number, drive: number): number {
  return f32(tanhApprox(f32(f32(x * 3) * drive)) / f32(tanhApprox(drive) * 3));
}

export class Saturation {
  target = 0;               // @0x00 drive
  cur = 1;                  // @0x10 smoothed drive (the constructor starts at 1)
  coef = 0;                 // @0x20
  hq = false;               // @0x30
  private readonly prev = new Float32Array(2); // @0x38 state of the anti-aliased tanh

  /** 0x30bd4 */
  setSampleRate(sr: number): void { this.coef = coefTime(0.05, 0.9, sr); }

  /** 0x30dac: amount 0..1 */
  setAmount(v: number): void {
    this.target = satDrive(v);
  }

  /** 0x30d08 */
  private adaa(x: number, ch: number): number {
    const p = this.prev[ch];
    let r: number;
    if (Math.abs(f32(x - p)) < f32(0.0010000000474974513)) {
      r = tanhf(f32(f32(p + x) * 0.5));
    } else {
      const d = f32(x - p);
      const fx = logf(Math.min(coshf(x), 3.4028234663852886e38));
      const fp = logf(Math.min(coshf(p), 3.4028234663852886e38));
      r = f32(f32(fx - fp) / d);
    }
    this.prev[ch] = x;
    return r;
  }

  /** 0x30c1c: one stereo sample in place. */
  process(io: Float32Array): void {
    this.cur = fma32(this.coef, f32(this.target - this.cur), this.cur);
    const g = this.cur;
    const xl = f32(io[0] * 3), xr = f32(io[1] * 3);
    const norm = f32(tanhApprox(g) * 3);
    const yl = f32(xl * g), yr = f32(xr * g);
    if (this.hq) {
      const inv = f32(1 / norm);
      io[0] = f32(inv * this.adaa(yl, 0));
      io[1] = f32(inv * this.adaa(yr, 1));
    } else {
      io[0] = f32(tanhApprox(yl) / norm);
      io[1] = f32(tanhApprox(yr) / norm);
    }
  }
}
