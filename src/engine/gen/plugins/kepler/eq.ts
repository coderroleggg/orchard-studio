// Kepler Exo equalizer (engine.dylib: 0x33d80 constructor, 0x33ee0 / 0x33b0c sample rate, 0x33b9c band design,
// 0x33f24 parameters, 0x34418 process, 0x33ca4 one band). Three biquad bands in series: a low shelf, a peak and a
// high shelf; each has a frequency (20 Hz .. 21 kHz, exponential), a Q and a gain (-16 .. +16 dB). Parameters
// arrive as the engine's normalised floats; every change redesigns the band it belongs to (eqdesign.ts, double
// precision) and stores the coefficients as single precision. The bands run as direct-form-I filters with fused
// multiply-adds in FL's order.

import { f32, fma32, fms32 } from './fmath';
import { exp2f, powf } from './applemath';
import { designEqBand, EQ_CODES } from './eqdesign';

class EqBand {
  /** a1, a2, b0, b1, b2 (@0x04 .. 0x14) */
  readonly c = new Float32Array(5);
  type = 0;                    // @0x18
  gain = f32(3);               // @0x1c dB (the constructor starts every band at +3 dB, 1 kHz, Q 0, then the parameters overwrite it)
  freq = f32(1000);            // @0x20 Hz
  q = 0;                       // @0x24
  /** left x1, x2, y1, y2 and right x1, x2, y1, y2 (@0x28 .. 0x44) */
  readonly s = new Float32Array(8);
  sr = 44101;                  // @0x48 (double)
  k = 0;                       // @0x54: 2 / sr, single precision
  private readonly out = new Float64Array(5);

  /** 0x33b0c */
  setSampleRate(sr: number): void {
    if (this.sr === sr) return;
    this.sr = sr;
    this.k = f32(2 / f32(sr));
    this.design(this.type, this.freq, this.q, this.gain);
  }

  /** 0x33b9c */
  design(type: number, freq: number, q: number, gain: number): void {
    this.type = type; this.freq = freq; this.q = q; this.gain = gain;
    if (type > 2) return;
    const w = f32(this.k * freq);
    designEqBand(EQ_CODES[type], w, q, gain, this.out);
    for (let i = 0; i < 5; i++) this.c[i] = f32(this.out[i]);
  }

  /** 0x33ca4: one stereo sample in place. */
  process(io: Float32Array): void {
    const c = this.c, s = this.s;
    const a1 = c[0], a2 = c[1], b0 = c[2], b1 = c[3], b2 = c[4];
    const xl = io[0], xr = io[1];
    let y = fma32(b0, xl, f32(b1 * s[0]));
    y = fma32(b2, s[1], y);
    y = fms32(a1, s[2], y);
    y = fms32(a2, s[3], y);
    s[3] = s[2]; s[2] = y; s[1] = s[0]; s[0] = xl;
    io[0] = y;
    let z = fma32(b0, xr, f32(b1 * s[4]));
    z = fma32(b2, s[5], z);
    z = fms32(a1, s[6], z);
    z = fms32(a2, s[7], z);
    s[7] = s[6]; s[6] = z; s[5] = s[4]; s[4] = xr;
    io[1] = z;
  }

  clear(): void { this.s.fill(0); }
}

export class Eq {
  readonly bands = [new EqBand(), new EqBand(), new EqBand()];
  /** the ten normalised values the parameters last set (@0x108 + 4 idx) */
  readonly p = new Float32Array(10);

  constructor() {
    for (const b of this.bands) b.setSampleRate(44100);
    this.bands[0].design(0, f32(100), 1, 0);
    this.bands[1].design(1, f32(2000), 1, 0);
    this.bands[2].design(2, f32(10000), 1, 0);
    for (let i = 0; i < 10; i++) this.setParam(i, 0.5);
  }

  /** 0x33ee0 */
  setSampleRate(sr: number): void { for (const b of this.bands) b.setSampleRate(sr); }

  /** 0x33f24: idx 1..3 Q of the bands, 4..6 gain, 7..9 frequency. */
  setParam(idx: number, v: number): void {
    this.p[idx] = v;
    if (idx < 1 || idx > 9) return;
    const b = this.bands[(idx - 1) % 3];
    if (idx <= 3) {
      const q = f32(powf(13, powf(v, f32(1.2799999713897705))) * f32(0.2800000011920929));
      b.design(b.type, b.freq, q, b.gain);
    } else if (idx <= 6) {
      b.design(b.type, b.freq, b.q, fma32(v, 32, -16));
    } else {
      const f = f32(exp2f(f32(v * f32(10.036173820495605))) * 20);
      b.design(b.type, f, b.q, b.gain);
    }
  }

  /** 0x34418: the bands in series. */
  process(io: Float32Array): void { for (const b of this.bands) b.process(io); }

  clear(): void { for (const b of this.bands) b.clear(); }
}
