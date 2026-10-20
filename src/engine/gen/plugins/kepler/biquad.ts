// Kepler / Kepler Exo biquad filters (engine.dylib 0xf7ac design, 0xf684 / 0xf6fc stereo process, object of 0x4c
// bytes: sample rate @0, five coefficients @4..0x14, a second set @0x18..0x28, states @0x2c..0x48). The designer
// is the RBJ cookbook in single precision; the coefficients are stored normalised with the feedback sign flipped
// (y = c0 x + c1 x1 + c2 x2 + c3 y1 + c4 y2).

import { f32, fma32 } from './fmath';
import { sincosf, tanf } from './applemath';

const TWO_PI = f32(6.2831854820251465);
const PI_F = f32(3.1415927410125732);
const LN2_HALF = f32(0.3465735912322998);

export const BQ = { LOW_PASS: 0, HIGH_PASS: 1, PEAK: 2, LOW_SHELF: 3, HIGH_SHELF: 4, BAND_SKIRT: 5, BAND_PEAK: 6, NOTCH: 7, ALL_PASS: 8, ONE_POLE_LP: 9, ONE_POLE_HP: 10 } as const;

/** sinh as single precision (the engine calls the system sinhf; only the bandwidth mode needs it). */
function sinhf(x: number): number { return f32(Math.sinh(x)); }

const sc: number[] = [0, 0];

/**
 * 0xf7ac: coefficients (b0, b1, b2, -a1, -a2, all divided by a0) of a filter of `type` at `fc` Hz;
 * `q`: Q (or bandwidth in octaves when `bw`), `gain`: linear amplitude of the peak / shelf types.
 */
export function designBiquad(type: number, bw: boolean, fc: number, sr: number, q: number, gain: number, out: Float32Array | number[], o = 0): void {
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === BQ.ONE_POLE_LP || type === BQ.ONE_POLE_HP) {
    const t = tanf(f32(f32(fc * PI_F) / sr));
    a0 = f32(t + 1); a1 = f32(t + -1); a2 = 0;
    if (type === BQ.ONE_POLE_LP) { b0 = t; b1 = t; b2 = 0; } else { b0 = 1; b1 = -1; b2 = 0; }
    // the one-pole high-pass keeps its input terms (1, -1) unscaled by t (0xf828)
  } else {
    const w = f32(f32(fc * TWO_PI) / sr);
    sincosf(w, sc);
    const sin = sc[0], cos = sc[1];
    let alpha: number;
    if (bw) {
      const s0 = f32(f32(q * LN2_HALF) * w);
      alpha = f32(sin * sinhf(f32(s0 / sin)));
    } else {
      alpha = f32(sin / f32(q + q));
    }
    const A = gain;
    switch (type) {
      case BQ.LOW_PASS: {
        const m = f32(1 - cos);
        b1 = m; b0 = f32(m * 0.5); b2 = b0;
        a0 = f32(alpha + 1); a1 = f32(cos * -2); a2 = f32(1 - alpha);
        break;
      }
      case BQ.HIGH_PASS: {
        const p = f32(cos + 1);
        b0 = f32(p * 0.5); b2 = b0; b1 = -p;
        a0 = f32(alpha + 1); a1 = f32(cos * -2); a2 = f32(1 - alpha);
        break;
      }
      case BQ.PEAK: {
        b0 = fma32(alpha, A, 1);
        b1 = f32(cos * -2);
        b2 = fma32(-alpha, A, 1);
        const r = f32(alpha / A);
        a0 = f32(r + 1); a1 = b1; a2 = f32(1 - r);
        break;
      }
      case BQ.LOW_SHELF: {
        const sa = f32(Math.sqrt(A));
        const s4 = f32(sa / q);
        const s5 = f32(A + 1), s6 = f32(A + -1);
        const s1 = fma32(-s6, cos, s5);
        b0 = f32(fma32(s4, sin, s1) * A);
        b1 = f32(f32(A + A) * fma32(-s5, cos, s6));
        b2 = f32(fma32(-s4, sin, s1) * A);
        const s7 = fma32(s6, cos, s5);
        a0 = fma32(s4, sin, s7);
        a1 = f32(fma32(s5, cos, s6) * -2);
        a2 = fma32(-s4, sin, s7);
        break;
      }
      case BQ.HIGH_SHELF: {
        const sa = f32(Math.sqrt(A));
        const s4 = f32(sa / q);
        const s5 = f32(A + 1), s6 = f32(A + -1);
        const s1 = fma32(s6, cos, s5);
        b0 = f32(fma32(s4, sin, s1) * A);
        b1 = f32(f32(A * -2) * fma32(s5, cos, s6));
        b2 = f32(fma32(-s4, sin, s1) * A);
        const s7 = fma32(-s6, cos, s5);
        a0 = fma32(s4, sin, s7);
        const t = fma32(-s5, cos, s6);
        a1 = f32(t + t);
        a2 = fma32(-s4, sin, s7);
        break;
      }
      case BQ.BAND_SKIRT:
        b0 = f32(sin * 0.5); b1 = 0; b2 = f32(sin * -0.5);
        a0 = f32(alpha + 1); a1 = f32(cos * -2); a2 = f32(1 - alpha);
        break;
      case BQ.BAND_PEAK:
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = f32(alpha + 1); a1 = f32(cos * -2); a2 = f32(1 - alpha);
        break;
      case BQ.NOTCH:
        b0 = 1; b1 = f32(cos * -2); b2 = 1;
        a0 = f32(alpha + 1); a1 = b1; a2 = f32(1 - alpha);
        break;
      case BQ.ALL_PASS:
        b0 = f32(1 - alpha); b1 = f32(cos * -2); b2 = f32(alpha + 1);
        a0 = b2; a1 = b1; a2 = b0;
        break;
      default:
        b0 = 0; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
  }
  const inv = f32(1 / a0);
  out[o] = f32(b0 * inv);
  out[o + 1] = f32(b1 * inv);
  out[o + 2] = f32(b2 * inv);
  out[o + 3] = f32(f32(-a1) * inv);
  out[o + 4] = f32(f32(-a2) * inv);
}

/** A stereo biquad: the same coefficients for both channels (0xf684) or one set each (0xf6fc). */
export class Biquad {
  sr = 44100;
  /** coefficient sets: [0..4] left (and right when shared), [5..9] right */
  readonly c = new Float32Array(10);
  /** left y1, y2, x1, x2 and right y1, y2, x1, x2 (@0x2c .. 0x48) */
  readonly s = new Float32Array(8);

  setSampleRate(sr: number): void { this.sr = f32(sr); }

  /** 0xf77c: design the left (or the shared) set. */
  designLeft(type: number, fc: number, q: number, gain: number, bw: boolean): void {
    designBiquad(type, bw, fc, this.sr, q, gain, this.c, 0);
  }

  /** 0xfb38: design the right set. */
  designRight(type: number, fc: number, q: number, gain: number, bw: boolean): void {
    designBiquad(type, bw, fc, this.sr, q, gain, this.c, 5);
  }

  /** 0xf638: take the coefficients of another filter. */
  copyFrom(o: Biquad): void { for (let i = 0; i < 5; i++) this.c[i] = o.c[i]; }

  clear(): void { this.s.fill(0); }

  /** 0xf684: shared coefficients; io[0] = L, io[1] = R, in place. */
  process(io: Float32Array): void {
    const c = this.c, s = this.s;
    const xl = io[0], xr = io[1];
    let y = fma32(c[0], xl, f32(c[1] * s[2]));
    y = fma32(c[2], s[3], y);
    y = fma32(c[3], s[0], y);
    y = fma32(c[4], s[1], y);
    s[3] = s[2]; s[1] = s[0]; s[2] = xl; s[0] = y;
    let z = fma32(c[0], xr, f32(c[1] * s[6]));
    z = fma32(c[2], s[7], z);
    z = fma32(c[3], s[4], z);
    z = fma32(c[4], s[5], z);
    s[7] = s[6]; s[5] = s[4]; s[6] = xr; s[4] = z;
    io[0] = y; io[1] = z;
  }

  /** 0xf6fc: separate coefficients per channel. */
  processDual(io: Float32Array): void {
    const c = this.c, s = this.s;
    const xl = io[0], xr = io[1];
    let y = fma32(c[0], xl, f32(c[1] * s[2]));
    y = fma32(c[2], s[3], y);
    y = fma32(c[3], s[0], y);
    y = fma32(c[4], s[1], y);
    s[3] = s[2]; s[1] = s[0]; s[2] = xl; s[0] = y;
    let z = fma32(c[5], xr, f32(c[6] * s[6]));
    z = fma32(c[7], s[7], z);
    z = fma32(c[8], s[4], z);
    z = fma32(c[9], s[5], z);
    s[7] = s[6]; s[5] = s[4]; s[6] = xr; s[4] = z;
    io[0] = y; io[1] = z;
  }
}
