// Wave Candy: audio passes through untouched. While the editor (and so the
// display) is open, the plugin analyses what the current display mode needs:
// - Oscilloscope: the latest window (10..100 ms) starting on a rising zero
//   crossing found within the sync period set by "Update";
// - Spectrum: sonogram columns every "Update" (5..100 ms), Hann-windowed FFT
//   of 2 x the band count, optional frequency reassignment ("Enhanced
//   frequency"), mapped to log-spaced rows (20 Hz..20 kHz) in dBFS;
// - Meter: Peak, PPM (5 ms attack), RMS (300 ms), VU, Leq(A) (A-weighted RMS)
//   or ITU-R BS.1770 momentary loudness (K-weighted, 400 ms) per channel;
// - Vectorscope: the latest block of (L, R) pairs.
// Visual gain, natural weighting, scaling and ballistics are applied by the editor.

import { bilinear, prototype, type BiquadCoefs } from '../../dsp/biquad';
import { getFFT } from '../../dsp/fft';
import { WC_SPEC_ROWS, wcEffectiveMode, wcRowFreq, wcState } from '../../../model/fx/plugins/wavecandy';
import type { EffectInstance, EffectModule, FxMonitor } from '../types';

const RING = 1 << 15; // 0.68 s at 48 kHz (enough for 100 ms windows and 16384-point FFTs)
const MAX_FFT = 16384;
const SPEC_QUEUE = 24;
const MAX_POINTS = 1600;
const BUTTERFLY_BUDGET = 3e6; // FFT work per second before the column rate is reduced

class Biquad {
  z1 = 0;
  z2 = 0;
  constructor(public c: BiquadCoefs) {}
  run(x: number): number {
    const c = this.c;
    const y = c.b0 * x + this.z1;
    this.z1 = c.b1 * x - c.a1 * y + this.z2;
    this.z2 = c.b2 * x - c.a2 * y;
    return y;
  }
}

/** First-order section (bilinear) as a biquad. */
function firstOrder(kind: 'lp' | 'hp', fc: number, sr: number): BiquadCoefs {
  const K = Math.tan((Math.PI * Math.min(fc, sr * 0.49)) / sr);
  const n = 1 / (1 + K);
  return kind === 'lp'
    ? { b0: K * n, b1: K * n, b2: 0, a1: (K - 1) * n, a2: 0 }
    : { b0: n, b1: -n, b2: 0, a1: (K - 1) * n, a2: 0 };
}

/** Moving mean of squares over a fixed window, in blocks of 64 samples. */
class MovingMs {
  private readonly sums: Float64Array;
  private at = 0;
  private acc = 0;
  private cnt = 0;
  private total = 0;
  constructor(private readonly blocks: number) { this.sums = new Float64Array(Math.max(1, blocks)); }
  push(x2: number): void {
    this.acc += x2;
    if (++this.cnt === 64) {
      this.total += this.acc - this.sums[this.at];
      this.sums[this.at] = this.acc;
      this.at = (this.at + 1) % this.sums.length;
      this.acc = 0;
      this.cnt = 0;
    }
  }
  value(): number { return Math.max(0, this.total) / (this.sums.length * 64); }
  reset(): void { this.sums.fill(0); this.total = this.acc = 0; this.cnt = 0; }
}

export class WaveCandyDsp implements EffectInstance {
  private readonly ringL = new Float32Array(RING);
  private readonly ringR = new Float32Array(RING);
  private pos = 0;
  private mode = 0;
  private hold = false;
  // oscilloscope / vectorscope
  private oscWindow = 960;
  private oscSync = 480;
  private vecBlock = 480;
  // spectrum
  private fftN = 0;
  private hop = 720;
  private sinceCol = 0;
  private enhanced = true;
  private readonly win = new Float64Array(MAX_FFT);
  private readonly dwin = new Float64Array(MAX_FFT);
  private readonly re = new Float64Array(MAX_FFT);
  private readonly im = new Float64Array(MAX_FFT);
  private readonly rowPow = new Float64Array(WC_SPEC_ROWS);
  private readonly rowBin = new Float32Array(WC_SPEC_ROWS);
  private readonly queue = new Float32Array(SPEC_QUEUE * WC_SPEC_ROWS);
  private qn = 0;
  private colDt = 0.015;
  // meters
  private meterMode = 0;
  private readonly peak = new Float64Array(2);
  private readonly env = new Float64Array(2);
  private readonly vu1 = new Float64Array(2);
  private readonly vu2 = new Float64Array(2);
  private readonly rms: MovingMs[];
  private readonly loud: MovingMs[];
  private readonly aw: Biquad[][];
  private readonly kw: Biquad[][];
  private readonly ppmAtt: number;
  private readonly ppmRel: number;
  private readonly vuA: number;
  private quietSamples = 0;
  private fresh = false;
  private watch: number;

  constructor(private readonly sampleRate: number) {
    const sr = sampleRate;
    const blocks = (sec: number) => Math.max(1, Math.round((sec * sr) / 64));
    this.rms = [new MovingMs(blocks(0.3)), new MovingMs(blocks(0.3))];
    this.loud = [new MovingMs(blocks(0.4)), new MovingMs(blocks(0.4))];
    const aCoefs = (): Biquad[] => [
      new Biquad(firstOrder('hp', 20.6, sr)), new Biquad(firstOrder('hp', 20.6, sr)),
      new Biquad(firstOrder('hp', 107.7, sr)), new Biquad(firstOrder('hp', 737.9, sr)),
      new Biquad(firstOrder('lp', 12194, sr)), new Biquad(firstOrder('lp', 12194, sr)),
    ];
    this.aw = [aCoefs(), aCoefs()];
    // BS.1770 K-weighting: high shelf (+4 dB, 1682 Hz) and RLB high-pass (38 Hz)
    const kCoefs = (): Biquad[] => [
      new Biquad(bilinear(prototype('highshelf', 0.7072, 3.9998), 1681.97, sr)),
      new Biquad(bilinear(prototype('highpass', 0.5003), 38.135, sr)),
    ];
    this.kw = [kCoefs(), kCoefs()];
    this.aGain = 1 / this.magAt(this.aw[0], 1000);
    this.ppmAtt = 1 - Math.exp(-1 / (0.005 * sr));
    this.ppmRel = Math.exp(-1 / (0.65 * sr));
    this.vuA = 1 - Math.exp(-1 / (0.045 * sr));
    this.watch = sr;
    this.setParams({});
  }

  private aGain = 1;

  /** |H| of a cascade at frequency f (for normalising the A-weighting at 1 kHz). */
  private magAt(chain: Biquad[], f: number): number {
    const w = (2 * Math.PI * f) / this.sampleRate;
    let mag = 1;
    for (const { c } of chain) {
      const cr = Math.cos(w), ci = -Math.sin(w), c2r = Math.cos(2 * w), c2i = -Math.sin(2 * w);
      const nr = c.b0 + c.b1 * cr + c.b2 * c2r, ni = c.b1 * ci + c.b2 * c2i;
      const dr = 1 + c.a1 * cr + c.a2 * c2r, di = c.a1 * ci + c.a2 * c2i;
      mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
    }
    return mag;
  }

  setParams(p: unknown): void {
    const raw = (p ?? {}) as Record<string, unknown>;
    const s = wcState(raw);
    const sr = this.sampleRate;
    const mode = wcEffectiveMode(s);
    if (mode !== this.mode) this.qn = 0;
    this.mode = mode;
    this.hold = Number(raw.hold) > 0;
    this.oscWindow = Math.min(RING / 2, Math.round((sr * s.oscWindow) / 100000));
    this.oscSync = Math.max(16, Math.round((sr * 10) / s.oscUpdate));
    this.vecBlock = Math.min(RING / 4, Math.round((sr * s.vecUpdate) / 100000));
    this.meterMode = s.meterMode;
    this.enhanced = s.specEnhanced;
    const n = Math.min(MAX_FFT, 64 << s.specRes);
    if (n !== this.fftN) this.prepareWindow(n);
    // column period from "Update", lengthened when the FFT work would exceed the budget
    const perCol = (n / 2) * Math.log2(n) * (this.enhanced ? 1 : 0.6);
    const minDt = perCol / BUTTERFLY_BUDGET;
    this.colDt = Math.max(s.specUpdate / 100000, minDt);
    this.hop = Math.max(32, Math.round(sr * this.colDt));
  }

  private prepareWindow(n: number): void {
    this.fftN = n;
    for (let i = 0; i < n; i++) {
      const ph = (2 * Math.PI * i) / n;
      this.win[i] = 0.5 - 0.5 * Math.cos(ph);
      this.dwin[i] = (Math.PI / n) * Math.sin(ph); // derivative of the Hann window per sample
    }
    // bin of each display row (for the plain, non-reassigned mapping)
    for (let r = 0; r < WC_SPEC_ROWS; r++) this.rowBin[r] = (wcRowFreq(r) * n) / this.sampleRate;
    this.qn = 0;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.watch <= 0) return;
    this.watch -= n;
    if (this.hold) return;
    const rl = this.ringL, rr = this.ringR;
    let p = this.pos;
    let quiet = true;
    const mm = this.meterMode;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (!(l === l && l - l === 0)) l = 0;
      if (!(r === r && r - r === 0)) r = 0;
      rl[p] = l; rr[p] = r;
      p = (p + 1) & (RING - 1);
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > 3e-5 || ar > 3e-5) quiet = false;
      if (this.mode !== 2) continue;
      if (al > this.peak[0]) this.peak[0] = al;
      if (ar > this.peak[1]) this.peak[1] = ar;
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? l : r, ax = c === 0 ? al : ar;
        switch (mm) {
          case 1: { // PPM: 5 ms attack, slow release
            const e = this.env[c];
            this.env[c] = ax > e ? e + (ax - e) * this.ppmAtt : e * this.ppmRel;
            break;
          }
          case 2: this.rms[c].push(x * x); break;
          case 3: { // VU: second-order smoothing of the rectified signal
            this.vu1[c] += (ax - this.vu1[c]) * this.vuA;
            this.vu2[c] += (this.vu1[c] - this.vu2[c]) * this.vuA;
            break;
          }
          case 4: {
            let y = x;
            const ch = this.aw[c];
            for (let k = 0; k < ch.length; k++) y = ch[k].run(y);
            y *= this.aGain;
            this.rms[c].push(y * y);
            break;
          }
          case 5: {
            const k = this.kw[c];
            const y = k[1].run(k[0].run(x));
            this.loud[c].push(y * y);
            break;
          }
        }
      }
    }
    this.pos = p;
    this.quietSamples = quiet ? this.quietSamples + n : 0;
    this.fresh = true;
    if (this.mode === 1) {
      this.sinceCol += n;
      while (this.sinceCol >= this.hop) {
        this.sinceCol -= this.hop;
        this.column();
      }
    }
  }

  /** One sonogram column from the latest FFT-size samples (mono). */
  private column(): void {
    const N = this.fftN, re = this.re, im = this.im, w = this.win, dw = this.dwin;
    const rl = this.ringL, rr = this.ringR;
    const start = (this.pos - N) & (RING - 1);
    for (let i = 0; i < N; i++) {
      const j = (start + i) & (RING - 1);
      const x = (rl[j] + rr[j]) * 0.5;
      re[i] = x * w[i];
      im[i] = this.enhanced ? x * dw[i] : 0;
    }
    getFFT(N).transform(re, im);
    const half = N / 2;
    const norm = 4 / N; // full-scale sine (Hann gain 0.5) reads 0 dBFS
    const rp = this.rowPow;
    rp.fill(0);
    const sr = this.sampleRate;
    const rows = WC_SPEC_ROWS;
    const logSpan = Math.log(1000);
    if (this.enhanced) {
      // two real transforms in one: H = FFT(x*w), D = FFT(x*w'); reassigned bin = k - N/(2 pi) * Im(D conj H) / |H|^2
      for (let k = 1; k < half; k++) {
        const j = N - k;
        const hr = (re[k] + re[j]) * 0.5, hi = (im[k] - im[j]) * 0.5;
        const dr = (im[k] + im[j]) * 0.5, di = -(re[k] - re[j]) * 0.5;
        const p2 = hr * hr + hi * hi;
        if (p2 < 1e-20) continue;
        const kk = k - (N / (2 * Math.PI)) * ((di * hr - dr * hi) / p2);
        const f = (kk * sr) / N;
        if (f < 19 || f > 21000) continue;
        const row = Math.round((Math.log(Math.max(20, f) / 20) / logSpan) * (rows - 1));
        if (row >= 0 && row < rows) rp[row] += p2;
      }
      // a sine's whole main lobe lands in one row: divide by the Hann energy factor (1.5) to keep 0 dBFS
      for (let r = 0; r < rows; r++) rp[r] = (rp[r] * norm * norm) / 1.5;
    } else {
      for (let r = 0; r < rows; r++) {
        const b = this.rowBin[r];
        const lo = Math.max(1, Math.floor(this.rowBinEdge(r, -0.5))), hi = Math.min(half - 1, Math.floor(this.rowBinEdge(r, 0.5)));
        let m = 0;
        if (hi >= lo) {
          for (let k = lo; k <= hi; k++) { const v = re[k] * re[k] + im[k] * im[k]; if (v > m) m = v; }
        } else {
          const k0 = Math.min(half - 2, Math.max(1, Math.floor(b))), t = b - k0;
          const v0 = re[k0] * re[k0] + im[k0] * im[k0], v1 = re[k0 + 1] * re[k0 + 1] + im[k0 + 1] * im[k0 + 1];
          m = v0 + (v1 - v0) * Math.max(0, Math.min(1, t));
        }
        rp[r] = m * norm * norm;
      }
    }
    if (this.qn === SPEC_QUEUE) { this.queue.copyWithin(0, rows, SPEC_QUEUE * rows); this.qn--; }
    const o = this.qn * rows;
    for (let r = 0; r < rows; r++) this.queue[o + r] = rp[r] > 1e-14 ? 10 * Math.log10(rp[r]) : -140;
    this.qn++;
  }

  private rowBinEdge(r: number, d: number): number {
    return (20 * Math.pow(1000, (r + d) / (WC_SPEC_ROWS - 1)) * this.fftN) / this.sampleRate;
  }

  reset(): void {
    this.ringL.fill(0);
    this.ringR.fill(0);
    this.peak.fill(0); this.env.fill(0); this.vu1.fill(0); this.vu2.fill(0);
    this.rms.forEach((m) => m.reset());
    this.loud.forEach((m) => m.reset());
    for (const ch of [...this.aw, ...this.kw]) for (const b of ch) b.z1 = b.z2 = 0;
    this.qn = 0;
  }

  /** Copy the latest `len` samples, starting `back` samples before the write position, decimated to <= MAX_POINTS. */
  private grab(len: number, back: number): Float32Array {
    const step = Math.max(1, Math.ceil(len / MAX_POINTS));
    const n = Math.floor(len / step);
    const out = new Float32Array(2 * n);
    const start = (this.pos - back) & (RING - 1);
    for (let i = 0; i < n; i++) {
      const j = (start + i * step) & (RING - 1);
      out[i] = this.ringL[j];
      out[n + i] = this.ringR[j];
    }
    return out;
  }

  monitor(): FxMonitor | null {
    this.watch = this.sampleRate;
    if (this.hold || !this.fresh) return null;
    this.fresh = false;
    const quiet = this.quietSamples / this.sampleRate;
    switch (this.mode) {
      case 0: {
        // start on a rising zero crossing within the sync period before the window
        const W = this.oscWindow;
        let back = W;
        const rl = this.ringL, rr = this.ringR;
        for (let k = 0; k < this.oscSync; k++) {
          const j = (this.pos - W - k) & (RING - 1), jp = (j - 1) & (RING - 1);
          const a = rl[jp] + rr[jp], b = rl[j] + rr[j];
          if (a < 0 && b >= 0) { back = W + k; break; }
        }
        return { mode: 0, quiet, osc: this.grab(W, back), stride: Math.max(1, Math.ceil(W / MAX_POINTS)), sr: this.sampleRate };
      }
      case 1: {
        const n = this.qn;
        this.qn = 0;
        if (!n) return { mode: 1, quiet, cols: 0 };
        return { mode: 1, quiet, cols: n, dt: this.colDt, spec: this.queue.slice(0, n * WC_SPEC_ROWS) };
      }
      case 2: {
        const lv = [0, 0];
        for (let c = 0; c < 2; c++) {
          switch (this.meterMode) {
            case 0: lv[c] = this.peak[c]; break;
            case 1: lv[c] = this.env[c]; break;
            case 2: case 4: lv[c] = Math.sqrt(this.rms[c].value()); break;
            case 3: lv[c] = this.vu2[c] * (Math.PI / (2 * Math.SQRT2)); break;
            case 5: { const ms = this.loud[c].value(); lv[c] = ms > 1e-12 ? Math.pow(10, (-0.691 + 10 * Math.log10(ms)) / 20) : 0; break; }
          }
        }
        const out = { mode: 2, quiet, l: lv[0], r: lv[1], pl: this.peak[0], pr: this.peak[1] };
        this.peak.fill(0);
        return out;
      }
      default:
        return { mode: 3, quiet, vec: this.grab(this.vecBlock, this.vecBlock) };
    }
  }
}

export const effect: EffectModule = {
  id: 'wavecandy',
  create: (sr) => new WaveCandyDsp(sr),
};
