// Free Filter (FL: Fruity Free Filter). Measured against FL's binary:
// - one RBJ cookbook biquad per channel (types LP, BP (0 dB peak), HP, notch,
//   low shelf, peaking, high shelf) designed with w0 = 2 pi f / 44100 at any
//   sample rate (FL's fixed design rate); Q / peak Q / shelf slope / gain
//   mappings as Fruity Parametric EQ's bands;
// - direct form I; parameter changes take effect at once (no glide), a type
//   change clears the filter memory (both sample-exact against FL);
// - CENTER (default on): Fruity Filter's DC remover after the filter.

import type { EffectInstance, EffectModule } from '../types';
import { freeFreqHz, freeGainDb, freePeakQ, freeQ, freeShelfS, freeType } from '../../../model/fx/plugins/freefilter';

const DC_FAST = 0.03948526;

/** RBJ coefficients for the Free Filter at its 44.1 kHz design rate (writes [b0, b1, b2, a1, a2]). */
export function freeDesign(out: Float64Array, type: number, freq: number, q: number, gain: number): void {
  const w0 = (2 * Math.PI * freeFreqHz(freq)) / 44100;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const A = Math.pow(10, freeGainDb(gain) / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type <= 3) {
    const al = sw / (2 * freeQ(q));
    a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
    if (type === 0) { b1 = 1 - cw; b0 = b1 / 2; b2 = b0; }
    else if (type === 1) { b0 = al; b1 = 0; b2 = -al; }
    else if (type === 2) { b1 = -(1 + cw); b0 = -b1 / 2; b2 = b0; }
    else { b0 = 1; b1 = -2 * cw; b2 = 1; }
  } else if (type === 5) {
    const al = sw / (2 * freePeakQ(q));
    b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A;
    a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
  } else {
    const S = freeShelfS(q);
    const al = (sw / 2) * Math.sqrt(Math.max(0, (A + 1 / A) * (1 / S - 1) + 2));
    const k = 2 * Math.sqrt(A) * al;
    if (type === 4) {
      b0 = A * ((A + 1) - (A - 1) * cw + k); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - k);
      a0 = (A + 1) + (A - 1) * cw + k; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - k;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cw + k); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - k);
      a0 = (A + 1) - (A - 1) * cw + k; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - k;
    }
  }
  const ia = 1 / a0;
  out[0] = b0 * ia; out[1] = b1 * ia; out[2] = b2 * ia; out[3] = a1 * ia; out[4] = a2 * ia;
}

class FreeFilter implements EffectInstance {
  latency = 0;
  tail = 0.5;
  private readonly dcSlow: number;
  private type = -1;
  private freq = 512; private q = 169; private gain = 676;
  private center = true;
  private c = new Float64Array(5);
  // direct form I memory per channel: x[n-1], x[n-2], y[n-1], y[n-2]
  private x1 = new Float64Array(2); private x2 = new Float64Array(2);
  private y1 = new Float64Array(2); private y2 = new Float64Array(2);
  private dc1 = new Float64Array(2);
  private dc2 = new Float64Array(2);

  constructor(sampleRate: number) {
    this.dcSlow = 1 - Math.exp(-25.51 / sampleRate);
    freeDesign(this.c, 0, 512, 169, 676);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);
    const ty = freeType(num(q.type, 100));
    this.freq = Math.min(1024, Math.max(0, num(q.freq, 512)));
    this.q = Math.min(1024, Math.max(0, num(q.q, 169)));
    this.gain = Math.min(1024, Math.max(0, num(q.gain, 676)));
    this.center = num(q.center, 1) >= 0.5;
    if (ty !== this.type) { this.type = ty; this.clearFilter(); }
    freeDesign(this.c, this.type, this.freq, this.q, this.gain);
    const Q = this.type === 5 ? freePeakQ(this.q) : this.type >= 4 ? 1 : freeQ(this.q);
    this.tail = Math.min(4, (6.9 * 2 * Math.max(0.5, Q)) / (2 * Math.PI * freeFreqHz(this.freq)) + (this.center ? 0.2 : 0));
  }

  private clearFilter(): void {
    this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (n <= 0) return;
    const c = this.c, b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
    const B = this.dcSlow;
    for (let ch = 0; ch < 2; ch++) {
      const buf = ch === 0 ? L : R;
      let x1 = this.x1[ch], x2 = this.x2[ch], y1 = this.y1[ch], y2 = this.y2[ch];
      for (let i = 0; i < n; i++) {
        const x = buf[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        buf[i] = y;
      }
      if (!(Math.abs(y1) < 1e6 && Math.abs(y2) < 1e6)) { x1 = x2 = y1 = y2 = 0; }
      if (Math.abs(y1) < 1e-20) y1 = 0;
      if (Math.abs(y2) < 1e-20) y2 = 0;
      this.x1[ch] = x1; this.x2[ch] = x2; this.y1[ch] = y1; this.y2[ch] = y2;
      if (this.center) {
        let d1 = this.dc1[ch], d2 = this.dc2[ch];
        for (let i = 0; i < n; i++) {
          d1 += (buf[i] - d1) * DC_FAST; d2 += (d1 - d2) * B;
          buf[i] -= d2;
        }
        this.dc1[ch] = Math.abs(d1) < 1e-20 ? 0 : d1; this.dc2[ch] = Math.abs(d2) < 1e-20 ? 0 : d2;
      }
    }
  }

  reset(): void {
    this.clearFilter();
    this.dc1.fill(0); this.dc2.fill(0);
  }
}

export const effect: EffectModule = {
  id: 'freefilter',
  create: (sampleRate) => new FreeFilter(sampleRate),
};
