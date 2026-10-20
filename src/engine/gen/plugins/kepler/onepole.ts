// Kepler / Kepler Exo stereo one-pole filter (engine.dylib 0x3a44 process, 0x385c sample rate, 0x3928 low-pass,
// 0x397c high-pass; object of 0x38 bytes): bilinear one-pole, y = b0 x + b1 x1 + a1 y1 in single precision with the
// engine's fused multiply-adds. The engine uses it for the output high-pass, the chorus input / output filters
// and (low-pass) in the delay and reverb.

import { f32, fma32 } from './fmath';
import { tanf } from './applemath';

const PI_F = f32(3.1415927410125732);

export class OnePole {
  /** y L, x L, y R, x R (@0x00 .. 0x0c) */
  readonly s = new Float32Array(4);
  b0 = 0; b1 = 0; a1 = 0;     // @0x10 / 0x14 / 0x18
  hp = false;                 // @0x2c
  fc = 100;                   // @0x30
  k = 0;                      // @0x34 (pi / sr)

  /** 0x38e8: a new filter is a 100 Hz low-pass at 44.1 kHz. */
  constructor() { this.setSampleRate(44100); }

  /** 0x385c: new sample rate; the coefficients are redone for the current cutoff and type. */
  setSampleRate(sr: number): void {
    this.k = f32(f32(1 / sr) * PI_F);
    this.recompute();
  }

  /** 0x3928: low-pass at fc Hz. */
  setLowpass(fc: number): void { this.fc = fc; this.hp = false; this.recompute(); }

  /** 0x397c: high-pass at fc Hz. */
  setHighpass(fc: number): void { this.fc = fc; this.hp = true; this.recompute(); }

  private recompute(): void {
    const t = tanf(f32(this.k * this.fc));
    const s1 = f32(t + 1);
    if (this.hp) {
      const b = f32(1 / s1);
      this.b0 = b; this.b1 = -b;
    } else {
      const b = f32(t / s1);
      this.b0 = b; this.b1 = b;
    }
    this.a1 = f32(f32(-f32(t + -1)) / s1);
  }

  clear(): void { this.s.fill(0); }

  /** 0x3a44: one stereo sample in place (io[0] = L, io[1] = R). */
  process(io: Float32Array): void {
    const s = this.s;
    const xl = io[0], xr = io[1];
    const yl = fma32(s[0], this.a1, fma32(xl, this.b0, f32(s[1] * this.b1)));
    const yr = fma32(s[2], this.a1, fma32(xr, this.b0, f32(s[3] * this.b1)));
    s[0] = yl; s[2] = yr;
    s[1] = xl; s[3] = xr;
    io[0] = yl; io[1] = yr;
  }
}
