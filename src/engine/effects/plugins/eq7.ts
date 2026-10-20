// 7 Band EQ (FL: Fruity 7 Band EQ). Measured against FL's binary (noise
// input / output fits, residual 5e-8):
// - band 1: first order low shelf, midpoint 63 Hz; band 7: first order high
//   shelf, midpoint 8000 Hz (bilinear, prewarped, boost and cut mirror
//   images); bands 2-6: RBJ peaking with 2 octaves (250, 500, 1500 Hz) and
//   1 octave (3000, 5000 Hz) bandwidth;
// - all designed for 44.1 kHz whatever the sample rate (as FL);
// - levels act immediately; bands in series, direct form I.

import type { EffectInstance, EffectModule } from '../types';
import { EQ7_BW, EQ7_FREQS } from '../../../model/fx/plugins/eq7';

/** Coefficients [b0, b1, b2, a1, a2] of band i at gain dB (44.1 kHz design). */
export function eq7Design(out: Float64Array, i: number, db: number): void {
  const w0 = (2 * Math.PI * EQ7_FREQS[i]) / 44100;
  if (i === 0 || i === 6) {
    const K = Math.tan(w0 / 2), sv = Math.pow(10, db / 40);
    // HS: pole (1 - K sqrt V) / (1 + K sqrt V), zero (1 - K / sqrt V) / (1 + K / sqrt V), DC gain 1; LS mirrored
    const kp = i === 6 ? K * sv : K / sv, kz = i === 6 ? K / sv : K * sv;
    const p = (1 - kp) / (1 + kp), z = (1 - kz) / (1 + kz);
    const dcScale = i === 6 ? (1 - p) / (1 - z) : ((1 - p) / (1 - z)) * sv * sv; // LS: DC gain V
    out[0] = dcScale; out[1] = -dcScale * z; out[2] = 0; out[3] = -p; out[4] = 0;
    return;
  }
  const A = Math.pow(10, db / 40), cw = Math.cos(w0), sw = Math.sin(w0);
  const al = sw * Math.sinh(((Math.LN2 / 2) * EQ7_BW[i] * w0) / sw);
  const ia = 1 / (1 + al / A);
  out[0] = (1 + al * A) * ia; out[1] = -2 * cw * ia; out[2] = (1 - al * A) * ia; out[3] = -2 * cw * ia; out[4] = (1 - al / A) * ia;
}

class SevenBandEQ implements EffectInstance {
  latency = 0;
  tail = 0.3;
  private levels = new Float64Array(7);
  private c: Float64Array[] = Array.from({ length: 7 }, () => new Float64Array(5));
  // direct form I memory [band][ch]: x1, x2, y1, y2
  private m: Float64Array[] = Array.from({ length: 7 }, () => new Float64Array(8));

  constructor() {
    for (let i = 0; i < 7; i++) eq7Design(this.c[i], i, 0);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    for (let i = 0; i < 7; i++) {
      const v = q[`band${i + 1}`];
      const lv = typeof v === 'number' && Number.isFinite(v) ? Math.min(1800, Math.max(-1800, v)) : 0;
      if (lv !== this.levels[i]) { this.levels[i] = lv; eq7Design(this.c[i], i, lv / 100); }
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i = 0; i < 7; i++) {
      // every band runs, flat ones too (their memory stays current, as in FL's direct form I)
      const c = this.c[i], m = this.m[i];
      const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? L : R, o = ch * 4;
        let x1 = m[o], x2 = m[o + 1], y1 = m[o + 2], y2 = m[o + 3];
        for (let k = 0; k < n; k++) {
          const x = buf[k];
          const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = x; y2 = y1; y1 = y;
          buf[k] = y;
        }
        if (!(Math.abs(y1) < 1e6 && Math.abs(y2) < 1e6)) { x1 = x2 = y1 = y2 = 0; }
        if (Math.abs(y1) < 1e-20) y1 = 0;
        if (Math.abs(y2) < 1e-20) y2 = 0;
        m[o] = x1; m[o + 1] = x2; m[o + 2] = y1; m[o + 3] = y2;
      }
    }
  }

  reset(): void {
    for (const m of this.m) m.fill(0);
  }
}

export const effect: EffectModule = {
  id: 'eq7',
  create: () => new SevenBandEQ(),
};
