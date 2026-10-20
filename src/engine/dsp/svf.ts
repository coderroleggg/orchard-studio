// Linear trapezoidal state variable filter (A. Simper / Cytomic formulation).
// Same magnitude response as the bilinear-transformed analog prototype (i.e. the
// RBJ cookbook shapes) but behaves well under fast coefficient modulation.

import { TWO_PI, flush } from './math';

export const enum SvfMode {
  LowPass = 0,
  BandPass = 1, // unity peak gain
  HighPass = 2,
  Notch = 3,
  Peak = 4, // resonant "peak" (LP - HP)
  AllPass = 5,
  Bell = 6,
  LowShelf = 7,
  HighShelf = 8,
}

/** Coefficient set; kept as plain fields so it can be shared by several states. */
export class SvfCoefs {
  a1 = 1; a2 = 0; a3 = 0;
  m0 = 1; m1 = 0; m2 = 0;
  // analog prototype info for response evaluation
  g = 0; k = 1; mode: SvfMode = SvfMode.AllPass; gainDb = 0;

  set(mode: SvfMode, freq: number, q: number, gainDb: number, sampleRate: number): void {
    const nyq = sampleRate * 0.5;
    const f = Math.min(Math.max(freq, 1), nyq * 0.9999);
    let g = Math.tan((Math.PI * f) / sampleRate);
    let k = 1 / Math.max(q, 1e-4);
    const A = Math.pow(10, gainDb / 40);
    let m0 = 0, m1 = 0, m2 = 0;
    switch (mode) {
      case SvfMode.LowPass: m2 = 1; break;
      case SvfMode.BandPass: m1 = k; break;
      case SvfMode.HighPass: m0 = 1; m1 = -k; m2 = -1; break;
      case SvfMode.Notch: m0 = 1; m1 = -k; break;
      case SvfMode.Peak: m0 = 1; m1 = -k; m2 = -2; break;
      case SvfMode.AllPass: m0 = 1; m1 = -2 * k; break;
      case SvfMode.Bell:
        k = 1 / (Math.max(q, 1e-4) * A);
        m0 = 1; m1 = k * (A * A - 1);
        break;
      case SvfMode.LowShelf:
        g /= Math.sqrt(A);
        m0 = 1; m1 = k * (A - 1); m2 = A * A - 1;
        break;
      case SvfMode.HighShelf:
        g *= Math.sqrt(A);
        m0 = A * A; m1 = k * (1 - A) * A; m2 = 1 - A * A;
        break;
    }
    const a1 = 1 / (1 + g * (g + k));
    this.a1 = a1; this.a2 = g * a1; this.a3 = g * g * a1;
    this.m0 = m0; this.m1 = m1; this.m2 = m2;
    this.g = g; this.k = k; this.mode = mode; this.gainDb = gainDb;
  }

  /**
   * Magnitude (linear) of the digital filter at `freq` Hz. Uses the exact
   * bilinear mapping, so it matches what process() does.
   */
  magnitude(freq: number, sampleRate: number): number {
    // s = j*W, W = tan(pi f / fs) / g  (prototype normalised to cutoff 1)
    const w = Math.tan((Math.PI * Math.min(freq, sampleRate * 0.49999)) / sampleRate) / this.g;
    // H(s) = (m0*(s^2 + k s + 1) + m1 * s + m2) / (s^2 + k s + 1)   (v1 = s/D, v2 = 1/D, v0 = 1)
    // with s = jw: s^2 = -w^2
    const k = this.k;
    const dRe = 1 - w * w, dIm = k * w;
    const nRe = this.m0 * (1 - w * w) + this.m2;
    const nIm = this.m0 * k * w + this.m1 * w;
    return Math.sqrt((nRe * nRe + nIm * nIm) / (dRe * dRe + dIm * dIm));
  }
}

/** Filter state (one channel). */
export class SvfState {
  ic1 = 0;
  ic2 = 0;

  reset(): void { this.ic1 = 0; this.ic2 = 0; }

  tick(c: SvfCoefs, v0: number): number {
    const v3 = v0 - this.ic2;
    const v1 = c.a1 * this.ic1 + c.a2 * v3;
    const v2 = this.ic2 + c.a2 * this.ic1 + c.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return c.m0 * v0 + c.m1 * v1 + c.m2 * v2;
  }

  /** In-place block processing. */
  process(c: SvfCoefs, buf: Float32Array, start: number, end: number): void {
    let ic1 = this.ic1, ic2 = this.ic2;
    const a1 = c.a1, a2 = c.a2, a3 = c.a3, m0 = c.m0, m1 = c.m1, m2 = c.m2;
    for (let i = start; i < end; i++) {
      const v0 = buf[i];
      const v3 = v0 - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      buf[i] = m0 * v0 + m1 * v1 + m2 * v2;
    }
    this.ic1 = flush(ic1);
    this.ic2 = flush(ic2);
  }
}

/** First-order (6 dB/oct) TPT filter used for odd filter orders. */
export class OnePole {
  g = 0;
  s = 0;
  highpass = false;
  setFreq(freq: number, sampleRate: number, highpass: boolean): void {
    const f = Math.min(Math.max(freq, 1), sampleRate * 0.49995);
    const wc = Math.tan((Math.PI * f) / sampleRate);
    this.g = wc / (1 + wc);
    this.highpass = highpass;
  }
  reset(): void { this.s = 0; }
  tick(x: number): number {
    const v = (x - this.s) * this.g;
    const lp = v + this.s;
    this.s = lp + v;
    return this.highpass ? x - lp : lp;
  }
}

/** Butterworth section Q values for a cascade of `order` (even) poles. */
export function butterworthQs(order: number): number[] {
  const qs: number[] = [];
  const pairs = Math.floor(order / 2);
  for (let i = 0; i < pairs; i++) {
    const theta = (Math.PI * (2 * i + 1)) / (2 * order);
    qs.push(1 / (2 * Math.sin(theta)));
  }
  return qs.sort((a, b) => a - b);
}

export { TWO_PI };
