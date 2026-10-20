// ZGameEditor Visualizer: audio passes through untouched. While the editor
// is open, the plugin feeds its visual layers: 64 log-spaced band levels
// (30 Hz..16 kHz, 0..1 over a 66 dB range) from a 2048-point Hann FFT every
// 1024 samples, the latest 512-sample stereo waveform, and peak / RMS levels.

import { getFFT } from '../../dsp/fft';
import type { EffectInstance, EffectModule, FxMonitor } from '../types';

const N = 2048;
const HOP = 1024;
const BANDS = 64;
const WAVE = 512;
const RING = 4096;

export class ZgeVizDsp implements EffectInstance {
  private readonly ringL = new Float32Array(RING);
  private readonly ringR = new Float32Array(RING);
  private pos = 0;
  private since = 0;
  private readonly win = new Float64Array(N);
  private readonly re = new Float64Array(N);
  private readonly im = new Float64Array(N);
  private readonly edges = new Int32Array(BANDS + 1);
  private readonly bands = new Float32Array(BANDS);
  private peak = 0;
  private sum2 = 0;
  private count = 0;
  private fresh = false;
  private watch: number;

  constructor(private readonly sampleRate: number) {
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    for (let b = 0; b <= BANDS; b++) {
      const f = 30 * Math.pow(16000 / 30, b / BANDS);
      this.edges[b] = Math.max(1, Math.min(N / 2 - 1, Math.round((f * N) / sampleRate)));
    }
    this.watch = sampleRate;
  }

  setParams(): void {}

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.watch <= 0) return;
    this.watch -= n;
    let p = this.pos, pk = this.peak, s2 = this.sum2;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (!(l === l && l - l === 0)) l = 0;
      if (!(r === r && r - r === 0)) r = 0;
      this.ringL[p] = l; this.ringR[p] = r;
      p = (p + 1) & (RING - 1);
      const m = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (m > pk) pk = m;
      s2 += (l * l + r * r) * 0.5;
    }
    this.pos = p; this.peak = pk; this.sum2 = s2; this.count += n;
    this.since += n;
    if (this.since >= HOP) { this.since = 0; this.analyse(); }
    this.fresh = true;
  }

  private analyse(): void {
    const re = this.re, im = this.im;
    const start = (this.pos - N) & (RING - 1);
    for (let i = 0; i < N; i++) {
      const j = (start + i) & (RING - 1);
      re[i] = (this.ringL[j] + this.ringR[j]) * 0.5 * this.win[i];
      im[i] = 0;
    }
    getFFT(N).transform(re, im);
    const norm = 4 / N;
    for (let b = 0; b < BANDS; b++) {
      let m = 0;
      for (let k = this.edges[b]; k <= Math.max(this.edges[b], this.edges[b + 1] - 1); k++) {
        const v = re[k] * re[k] + im[k] * im[k];
        if (v > m) m = v;
      }
      const db = m > 1e-14 ? 10 * Math.log10(m * norm * norm) : -140;
      const v = Math.max(0, Math.min(1, (db + 66) / 66));
      if (v > this.bands[b]) this.bands[b] = v;
    }
  }

  reset(): void {
    this.ringL.fill(0); this.ringR.fill(0); this.bands.fill(0);
    this.peak = this.sum2 = 0; this.count = 0;
  }

  /** {bands (64, max since the last poll), wave (512 L then 512 R), peak, rms}. */
  monitor(): FxMonitor | null {
    this.watch = this.sampleRate;
    if (!this.fresh) return null;
    this.fresh = false;
    const wave = new Float32Array(2 * WAVE);
    const start = (this.pos - WAVE) & (RING - 1);
    for (let i = 0; i < WAVE; i++) {
      const j = (start + i) & (RING - 1);
      wave[i] = this.ringL[j];
      wave[WAVE + i] = this.ringR[j];
    }
    const out = { bands: Float32Array.from(this.bands), wave, peak: this.peak, rms: Math.sqrt(this.sum2 / Math.max(1, this.count)) };
    this.bands.fill(0);
    this.peak = this.sum2 = 0;
    this.count = 0;
    return out;
  }
}

export const effect: EffectModule = {
  id: 'zgameviz',
  create: (sr) => new ZgeVizDsp(sr),
};
