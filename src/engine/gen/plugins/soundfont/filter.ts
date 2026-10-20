// FL's SoundFont Player voice filter (Sobanth, coefficients 0x1de670, processing 0x1ff8e4): an RBJ low-pass biquad
// with the SF2 resonance convention. Per control block the cutoff (cents -> Hz = 440 2^((c - 6900)/1200), clamped to
// 0.45 sr, at least 5 Hz) and Q (centibels, 0..960) give
//   Q' = 10^((Q_dB - 3.01) / 20)  (Q_dB = clamp(Q_cB / 10, 0, 96)),  alpha = sin(w) / (2 Q'),
//   b0 = b2 = (1 - cos w) / 2, b1 = 1 - cos w, a0 = 1 + alpha, a1 = -2 cos w, a2 = 1 - alpha, gain 1 / sqrt(Q')
// (so the pass band is +1.505 dB at Q 0 and falls by Q/2 dB), stored as a1n = -a1/a0, a2n = -a2/a0, b * gain / a0.
// The filter is bypassed while the cutoff is above 0.45 sr and Q is 0 (default 13500 cents). New coefficients are
// reached by a linear ramp of 1/32 of the difference per sample over the control block (the first set is applied at
// once). Direct form 1: y = b0 x + b1 x1 + b2 x2 + a1n y1 + a2n y2 (float32 in FL).

import { clampF } from './num';

export class SfFilter {
  /** 1 = low pass (the only type SF2 uses). */
  type = 1;
  /** Gain parameter (+0x18), 1 for SF2. */
  gain = 1;
  /** Coefficients now: a1n, a2n, b0, b1, b2, and their per-sample increments. */
  c0 = 0; c1 = 0; c2 = 0; c3 = 0; c4 = 0;
  d0 = 0; d1 = 0; d2 = 0; d3 = 0; d4 = 0;
  /** Samples left of the coefficient ramp. */
  ramp = 0;
  /** The filter processes (FL +0x70), the wish of the last update (+0x74). */
  on = false;
  wish = false;
  /** First coefficient set pending (+0x30), last frequency / Q (+0x20 / +0x28). */
  first = true;
  lastF = -1;
  lastQ = -1;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;

  reset(): void {
    this.type = 1; this.gain = 1;
    this.c0 = this.c1 = this.c2 = this.c3 = this.c4 = 0;
    this.d0 = this.d1 = this.d2 = this.d3 = this.d4 = 0;
    this.ramp = 0; this.on = false; this.wish = false; this.first = true; this.lastF = -1; this.lastQ = -1;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  /**
   * Control-block update (0x1de670). `cents` is the modulated cutoff (clamped here to 1500..13500), `qcb` the modulated
   * Q in centibels (clamped to 0..960).
   */
  update(cents: number, qcb: number, sr: number, blockInv: number, blockLen: number): void {
    if (this.type === 0) { this.on = false; return; }
    if (this.ramp === 0) this.on = this.wish;
    const c = cents < 1500 ? 1500 : cents > 13500 ? 13500 : cents;
    let f = 440 * Math.exp(((c - 6900) * 0.0008333333535119891) * 0.6931471805599453);
    const q = clampF(qcb, 0, 960);
    if (f > 0.45 * sr) {
      f = 0.45 * sr;
      this.wish = Math.abs(q) > 1e-10 || (this.type - 1) >>> 0 >= 2;
    } else {
      if (f < 5) f = 5;
      this.wish = true;
    }
    if (this.wish || this.first) this.on = this.wish;
    if (Math.abs(f - this.lastF) > 0.01 || Math.abs(q - this.lastQ) > 0.01) {
      const qc = clampF(Math.fround(q * 0.1), 0, 96);
      const qp = Math.exp((qc - 3.01) * 0.05000000074505806 * 2.302585092994046);
      const w = 6.283185307179586 * (f / sr);
      const sw = Math.sin(w), cw = Math.cos(w);
      const alpha = sw / (2 * qp);
      const g = this.gain / Math.sqrt(qp);
      const a0 = 1 + alpha;
      const inv = Math.abs(a0) < 1e-14 ? 0 : 1 / a0;
      const n1 = (2 * cw) * inv; // -a1 / a0
      const n2 = -(1 - alpha) * inv; // -a2 / a0
      const b0 = ((1 - cw) * 0.5) * inv * g, b1 = (1 - cw) * inv * g;
      if (this.first) {
        this.c0 = Math.fround(n1); this.c1 = Math.fround(n2); this.c2 = Math.fround(b0); this.c3 = Math.fround(b1); this.c4 = Math.fround(b0);
        this.d0 = this.d1 = this.d2 = this.d3 = this.d4 = 0;
        this.ramp = 0;
        this.first = false;
      } else {
        this.d0 = Math.fround((n1 - this.c0) * blockInv);
        this.d1 = Math.fround((n2 - this.c1) * blockInv);
        this.d2 = Math.fround((b0 - this.c2) * blockInv);
        this.d3 = Math.fround((b1 - this.c3) * blockInv);
        this.d4 = Math.fround((b0 - this.c4) * blockInv);
        this.ramp = blockLen;
      }
      this.lastF = f;
      this.lastQ = q;
    }
  }

  /** Filter `n` samples of buf in place (0x1ff8e4). */
  process(buf: Float32Array, n: number): void {
    if (!this.on) {
      // coefficients still ramp (the processing routine's bypass branch)
      if (this.ramp > 0) {
        const m = Math.min(this.ramp, n);
        this.ramp -= m;
        this.c0 += m * this.d0; this.c1 += m * this.d1; this.c2 += m * this.d2; this.c3 += m * this.d3; this.c4 += m * this.d4;
      }
      return;
    }
    let c0 = this.c0, c1 = this.c1, c2 = this.c2, c3 = this.c3, c4 = this.c4;
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
    const d0 = this.d0, d1 = this.d1, d2 = this.d2, d3 = this.d3, d4 = this.d4;
    let ramping = Math.min(this.ramp, n);
    this.ramp -= ramping;
    const f = Math.fround;
    for (let i = 0; i < n; i++) {
      const x0 = buf[i];
      // FL: fmul, then four fused multiply-adds (the float32 products are exact in double)
      let y = f(x1 * c3);
      y = f(x0 * c2 + y);
      y = f(x2 * c4 + y);
      y = f(y1 * c0 + y);
      y = f(y2 * c1 + y);
      buf[i] = y;
      x2 = x1; x1 = x0; y2 = y1; y1 = y;
      if (ramping > 0) {
        c0 = f(c0 + d0); c1 = f(c1 + d1); c2 = f(c2 + d2); c3 = f(c3 + d3); c4 = f(c4 + d4);
        ramping--;
      }
    }
    this.c0 = c0; this.c1 = c1; this.c2 = c2; this.c3 = c3; this.c4 = c4;
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
  }
}
