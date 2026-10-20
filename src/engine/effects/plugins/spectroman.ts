// Spectroman: audio passes through untouched; while the editor is open the
// plugin runs FL's analysis: 2048-point FFT every 1536 samples (optional
// Blackman-Harris window), 128 display columns that take the loudest bin of
// their frequency range, level = 4096 * log11(1 + |X| * 15/1024) (x2 per
// channel in stereo), bars falling 341 units per frame, and 32 band peaks
// per channel held 75 frames then falling 16, 32, 48... per frame.
// The spectrograph merges the channels into one bar set (half decay per
// channel); the sonograph keeps one per channel.

import { getFFT, type FFT } from '../../dsp/fft';
import { SPM_COLS, SPM_FFT, SPM_HOP, spmTable } from '../../../model/fx/plugins/spectroman';
import type { EffectInstance, EffectModule, FxMonitor } from '../types';

const LOG_SCALE = 4096 / Math.log(11);
const BANDS = 32;
/** Frames kept for the editor between polls (the sonograph needs every frame). */
const QUEUE = 16;

/** FL's window: 4-term Blackman-Harris over 2047 intervals. */
function blackmanHarris(n: number): Float32Array {
  const w = new Float32Array(n);
  const a = Math.fround((2 * Math.PI) / (n - 1));
  for (let i = 0; i < n; i++) {
    const x = a * i;
    w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
  }
  return w;
}

export class SpectromanDsp implements EffectInstance {
  private readonly fft: FFT = getFFT(SPM_FFT);
  private readonly win = blackmanHarris(SPM_FFT);
  private readonly bufL = new Float32Array(SPM_FFT);
  private readonly bufR = new Float32Array(SPM_FFT);
  private pos = 0;
  private readonly re = new Float64Array(SPM_FFT);
  private readonly im = new Float64Array(SPM_FFT);
  private readonly mag = [new Float64Array(SPM_FFT / 2 + 1), new Float64Array(SPM_FFT / 2 + 1)];
  private readonly table = new Int32Array(SPM_COLS + 1);
  readonly bars = [new Int32Array(SPM_COLS), new Int32Array(SPM_COLS)];
  readonly peakV = [new Int32Array(BANDS), new Int32Array(BANDS)];
  private readonly peakC = [new Int32Array(BANDS), new Int32Array(BANDS)];
  private readonly queue = new Int32Array(QUEUE * 2 * SPM_COLS);
  private qStart = 0;
  private qN = 0;
  private qCh = 1;
  private mode = 1;
  private scale = -1;
  private stereo = false;
  private windowing = true;
  /** Samples of analysis left before the editor counts as closed (no polls). */
  private watch: number;

  constructor(private readonly sampleRate: number) {
    this.watch = sampleRate;
    this.setParams({});
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as { mode?: number; scale?: number; stereo?: unknown; windowing?: unknown };
    const mode = q.mode === 0 ? 0 : 1;
    const stereo = !!q.stereo;
    if (mode !== this.mode || stereo !== this.stereo) this.clearBars();
    this.mode = mode;
    this.stereo = stereo;
    this.windowing = q.windowing === undefined ? true : !!q.windowing;
    const scale = Math.max(0, Math.min(128, Math.round(typeof q.scale === 'number' ? q.scale : 64)));
    if (scale !== this.scale) { this.scale = scale; spmTable(scale, this.table); }
  }

  private clearBars(): void {
    for (let c = 0; c < 2; c++) { this.bars[c].fill(0); this.peakV[c].fill(0); this.peakC[c].fill(0); }
    this.qN = 0;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.watch <= 0) return;
    this.watch -= n;
    const st = this.stereo;
    let i = 0;
    while (i < n) {
      const m = Math.min(SPM_FFT - this.pos, n - i);
      const bl = this.bufL, br = this.bufR;
      for (let j = 0; j < m; j++) {
        const l = L[i + j], r = R[i + j];
        const a = l === l && l - l === 0 ? l : 0; // non-finite -> 0
        const b = r === r && r - r === 0 ? r : 0;
        if (st) { bl[this.pos + j] = a; br[this.pos + j] = b; } else bl[this.pos + j] = a + b;
      }
      this.pos += m;
      i += m;
      if (this.pos >= SPM_FFT) {
        this.frame();
        const keep = SPM_FFT - SPM_HOP;
        this.bufL.copyWithin(0, SPM_HOP, SPM_FFT);
        this.bufR.copyWithin(0, SPM_HOP, SPM_FFT);
        this.pos = keep;
      }
    }
  }

  /** One analysis frame (FL's Eff_Render block once 2048 samples are collected). */
  private frame(): void {
    const N = SPM_FFT, half = N / 2;
    const st = this.stereo, sono = this.mode === 1;
    const re = this.re, im = this.im, w = this.win;
    if (this.windowing) {
      for (let i = 0; i < N; i++) { re[i] = this.bufL[i] * w[i]; im[i] = st ? this.bufR[i] * w[i] : 0; }
    } else {
      for (let i = 0; i < N; i++) { re[i] = this.bufL[i]; im[i] = st ? this.bufR[i] : 0; }
    }
    this.fft.transform(re, im);
    const mL = this.mag[0], mR = this.mag[1];
    if (st) {
      // two real signals in one complex FFT: L = (X[k] + conj X[N-k]) / 2, R = (X[k] - conj X[N-k]) / 2i
      for (let k = 0; k <= half; k++) {
        const j = (N - k) & (N - 1);
        const ar = re[k] + re[j], ai = im[k] - im[j];
        const br = im[k] + im[j], bi = re[k] - re[j];
        mL[k] = (ar * ar + ai * ai) * 0.25;
        mR[k] = (br * br + bi * bi) * 0.25;
      }
    } else {
      for (let k = 0; k <= half; k++) mL[k] = re[k] * re[k] + im[k] * im[k];
    }
    const s11 = 0.0146484375 * (st ? 2 : 1);
    const nch = st ? 2 : 1;
    const t = this.table;
    for (let ch = 0; ch < nch; ch++) {
      const mag = this.mag[ch];
      const pv = this.peakV[ch], pc = this.peakC[ch];
      for (let b = 0; b < BANDS; b++) {
        if (pv[b] > 0) {
          pc[b]++;
          if (pc[b] > 0) pv[b] = Math.max(0, pv[b] - pc[b] * 16);
        }
      }
      const bars = sono ? this.bars[ch] : this.bars[0];
      const decay = sono || !st ? 341 : 170;
      for (let x = 0; x < SPM_COLS; x++) {
        const b0 = t[x], b1 = t[x + 1];
        let m = mag[b0];
        for (let b = b0 + 1; b <= b1 - 1; b++) if (mag[b] > m) m = mag[b];
        let v = Math.round(Math.log(Math.sqrt(m) * s11 + 1) * LOG_SCALE);
        if (!(v >= 0)) v = 0;
        const d = bars[x] - decay;
        bars[x] = d > v ? d : v;
        const band = x >> 2;
        if (pv[band] <= v) { pv[band] = v; pc[band] = -75; }
      }
    }
    this.push(sono && st ? 2 : 1);
  }

  private push(ch: number): void {
    if (ch !== this.qCh) { this.qCh = ch; this.qN = 0; }
    if (this.qN === QUEUE) { this.qStart = (this.qStart + 1) % QUEUE; this.qN--; }
    const slot = ((this.qStart + this.qN) % QUEUE) * 2 * SPM_COLS;
    this.queue.set(this.bars[0], slot);
    if (ch === 2) this.queue.set(this.bars[1], slot + SPM_COLS);
    this.qN++;
  }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.pos = 0;
    this.clearBars();
  }

  /**
   * New analysis frames since the last poll: `bars` holds `n` frames of `ch`
   * x 128 column levels (4096 = full scale), oldest first; `pk` the latest
   * band peaks (32 for the left / mono channel, then 32 for the right).
   */
  monitor(): FxMonitor | null {
    this.watch = this.sampleRate;
    const n = this.qN;
    if (n === 0) return null;
    const ch = this.qCh;
    const bars = new Float32Array(n * ch * SPM_COLS);
    for (let f = 0; f < n; f++) {
      const slot = ((this.qStart + f) % QUEUE) * 2 * SPM_COLS;
      for (let c = 0; c < ch; c++) bars.set(this.queue.subarray(slot + c * SPM_COLS, slot + (c + 1) * SPM_COLS), (f * ch + c) * SPM_COLS);
    }
    const pk = new Float32Array(2 * BANDS);
    pk.set(this.peakV[0], 0);
    pk.set(this.peakV[1], BANDS);
    this.qStart = (this.qStart + n) % QUEUE;
    this.qN = 0;
    return { mode: this.mode, stereo: this.stereo ? 1 : 0, n, ch, bars, pk };
  }
}

export const effect: EffectModule = {
  id: 'spectroman',
  create: (sr) => new SpectromanDsp(sr),
};
