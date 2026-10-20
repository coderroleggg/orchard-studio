// Parametric EQ 2 processor, measured against FL Studio's own plugin
// (docs/research/fx/peq2.md; band designs in src/model/peq2design.ts).
//
// - Bands run in series as cascaded biquads in direct form I (double precision).
//   Peaking / shelf bands at 0 dB pass the signal unchanged but keep their
//   history, so moving away from 0 dB is seamless; a type or order change
//   clears the band's state.
// - Parameter changes apply at once (FL's default "Minimum phase mod speed:
//   Off"). Medium / Smooth glide level (dB), frequency and bandwidth (knob
//   units) per sample with k = 44100 / (192 sr) (Smooth) or 1 - (1 - k)^2.
// - HQ modes: off = RBJ at the host rate, HQ+ = decramped designs, Legacy =
//   HIIR polyphase half-bands (6 coefficients, transition 0.1) around RBJ at
//   2x, Enhanced = zero-stuffing, RBJ at 2x, then a 176-tap sine-windowed sinc
//   and every other sample kept (latency 44 samples at any rate).
// - A band left at 0 dB keeps its history for 0.2 s, then FL drops it (zeros).
// - LIN: one FFT convolution with a K-tap kernel (K = 256 << precision, latency
//   1.5 K): the minimum-phase design's magnitude as 2^(dB/6), sampled on 2K
//   bins, zero-phase impulse response cut to K taps under a sine window. Kernel changes crossfade over 0.1 / 0.25 / 0.01 / 0.02 s
//   (stored LIN mod speed 0..3).
// - Main level is applied to the input, ramped per block by at most 44.1 / s in
//   linear gain (22.05 / s with Legacy / Enhanced HQ selected, also in LIN).
// - After 0.2 s of digital silence at the input (whole blocks) processing stops
//   with the states frozen (not in LIN mode).

import {
  activeBands, bandIsFlat, designModeOf, designRate, designSection, normalizePEQ2,
  type DesignMode, type PEQ2Band, type PEQ2Params, type PEQ2Type,
} from '../../model/peq2';
import { bandSpecs, biquadResponse, LIN_EXPONENT } from '../../model/peq2design';
import type { BiquadCoefs } from '../dsp/biquad';
import { getFFT } from '../dsp/fft';
import type { EffectInstance } from './index';

const MAX_SECTIONS = 4;

// ------------------------------------------------------------------ bands
class Band {
  type: PEQ2Type = 'off';
  order = 0;
  on = false;
  /** current (smoothed) and target knob values */
  fx = 0; bx = 0; lv = 0;
  tfx = 0; tbx = 0; tlv = 0;
  n = 0; // sections
  readonly c = new Float64Array(MAX_SECTIONS * 5);
  /** DF1 history per channel and section: x1 x2 y1 y2 */
  readonly st = new Float64Array(2 * MAX_SECTIONS * 4);
  moving = false;
  /** samples spent flat (0 dB); FL drops a flat band's history after 0.2 s */
  flatFor = 0;

  reset(): void { this.st.fill(0); this.flatFor = 0; }
  get flat(): boolean { return (this.type === 'peaking' || this.type === 'lowshelf' || this.type === 'highshelf') && this.lv === 0; }

  design(fs: number, mode: DesignMode): void {
    if (!this.on) { this.n = 0; return; }
    const specs = bandSpecs(this.type as Exclude<PEQ2Type, 'off'>, this.fx, this.bx, this.lv, this.order);
    this.n = Math.min(MAX_SECTIONS, specs.length);
    for (let k = 0; k < this.n; k++) {
      const q = designSection(specs[k], fs, mode);
      const o = k * 5;
      this.c[o] = q.b0; this.c[o + 1] = q.b1; this.c[o + 2] = q.b2; this.c[o + 3] = q.a1; this.c[o + 4] = q.a2;
    }
  }

  /** Runs the sections over buf[start..end) of channel ch; `idle` = flat for 0.2 s (history dropped). */
  run(buf: Float32Array | Float64Array, ch: number, start: number, end: number, idle = false): void {
    const st = this.st, c = this.c;
    if (this.flat) {
      // identity sections: keep the history equal to the input (cleared once idle)
      if (end <= start) return;
      if (idle) { st.fill(0, ch * MAX_SECTIONS * 4, (ch + 1) * MAX_SECTIONS * 4); return; }
      const x1 = buf[end - 1], x2 = end - 2 >= start ? buf[end - 2] : st[ch * MAX_SECTIONS * 4];
      for (let k = 0; k < this.n; k++) {
        const o = (ch * MAX_SECTIONS + k) * 4;
        st[o] = x1; st[o + 1] = x2; st[o + 2] = x1; st[o + 3] = x2;
      }
      return;
    }
    for (let k = 0; k < this.n; k++) {
      const o = (ch * MAX_SECTIONS + k) * 4, q = k * 5;
      const b0 = c[q], b1 = c[q + 1], b2 = c[q + 2], a1 = c[q + 3], a2 = c[q + 4];
      let x1 = st[o], x2 = st[o + 1], y1 = st[o + 2], y2 = st[o + 3];
      for (let i = start; i < end; i++) {
        const x = buf[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        buf[i] = y;
      }
      st[o] = x1; st[o + 1] = x2;
      st[o + 2] = Math.abs(y1) < 1e-30 ? 0 : y1;
      st[o + 3] = Math.abs(y2) < 1e-30 ? 0 : y2;
    }
  }
}

// ------------------------------------------------------------------ Legacy HQ: HIIR half-bands
const HB0 = [0.039151597734460045, 0.3026468483284934, 0.6746159185469639];
const HB1 = [0.1473771136010466, 0.48246854276970014, 0.8830050257693731];

class AllpassChain {
  private x = new Float64Array(3);
  private y = new Float64Array(3);
  private readonly a: number[];
  constructor(a: number[]) { this.a = a; }
  tick(v: number): number {
    const a = this.a, x = this.x, y = this.y;
    for (let k = 0; k < 3; k++) {
      const out = a[k] * (v - y[k]) + x[k];
      x[k] = v; y[k] = out; v = out;
    }
    return v;
  }
  reset(): void { this.x.fill(0); this.y.fill(0); }
}

class Hiir2x {
  private u0 = new AllpassChain(HB0);
  private u1 = new AllpassChain(HB1);
  private d0 = new AllpassChain(HB0);
  private d1 = new AllpassChain(HB1);
  up(src: Float32Array, n: number, dst: Float64Array): void {
    for (let i = 0; i < n; i++) { const x = src[i]; dst[2 * i] = this.u0.tick(x); dst[2 * i + 1] = this.u1.tick(x); }
  }
  down(src: Float64Array, n: number, dst: Float32Array): void {
    for (let i = 0; i < n; i++) dst[i] = 0.5 * (this.d0.tick(src[2 * i + 1]) + this.d1.tick(src[2 * i]));
  }
  reset(): void { this.u0.reset(); this.u1.reset(); this.d0.reset(); this.d1.reset(); }
}

// ------------------------------------------------------------------ Enhanced HQ: FIR interpolator
/** h[i] = sinc((i - 88) / 2) sin(pi (i + 1) / 176), i = 0..175 (FL's window is one tap off-centre). */
const FIR_H = (() => {
  const h = new Float64Array(176);
  for (let i = 0; i < 176; i++) {
    const x = i - 88;
    const s = x === 0 ? 1 : Math.sin((Math.PI * x) / 2) / ((Math.PI * x) / 2);
    h[i] = s * Math.sin((Math.PI * (i + 1)) / 176);
  }
  return h;
})();
const FIR_ODD = Float64Array.from({ length: 88 }, (_, i) => FIR_H[2 * i + 1]);
const FIR_CENTER = FIR_H[88];
const FIR_LATENCY = 44;
const FIR_HIST = 128; // base samples of history (>= 88), power of two

/** Decimator: y[i] = sum_j h[j] w[2i - j] over the 2x band output (even taps are zero except the centre). */
class FirDown2x {
  private hist = new Float64Array(FIR_HIST * 2);
  private pos = 0;
  down(src: Float64Array, n: number, dst: Float32Array): void {
    const h = this.hist, m = FIR_HIST * 2 - 1;
    let p = this.pos;
    for (let i = 0; i < n; i++) {
      p = (p + 1) & m; h[p] = src[2 * i];
      p = (p + 1) & m; h[p] = src[2 * i + 1];
      // p holds w[2i + 1]; w[2i - j] = h[p - 1 - j]
      let acc = FIR_CENTER * h[(p - 1 - 2 * FIR_LATENCY) & m];
      for (let k = 0; k < 88; k++) acc += FIR_ODD[k] * h[(p - 2 - 2 * k) & m];
      dst[i] = acc;
    }
    this.pos = p;
  }
  reset(): void { this.hist.fill(0); this.pos = 0; }
}

// ------------------------------------------------------------------ LIN: FFT convolution with crossfades
const LIN_FADE = [0.1, 0.25, 0.01, 0.02];

class LinearPhase {
  readonly K: number;
  private N: number;
  private kRe: Float64Array; private kIm: Float64Array; // current kernel spectrum
  private nRe: Float64Array; private nIm: Float64Array; // fade target
  private xRe: Float64Array; private xIm: Float64Array; // spectrum of the current frame
  private inBuf: [Float64Array, Float64Array];
  private xSpec: [Float64Array, Float64Array, Float64Array, Float64Array]; // re/im per channel
  private outA: [Float64Array, Float64Array];
  private outB: [Float64Array, Float64Array];
  private re: Float64Array; private im: Float64Array;
  private fill = 0;
  fading = false;
  private alpha = 0;
  private rate = 0;
  readonly latency: number;
  constructor(K: number) {
    this.K = K;
    this.N = 2 * K;
    const N = this.N;
    this.kRe = new Float64Array(N); this.kIm = new Float64Array(N);
    this.nRe = new Float64Array(N); this.nIm = new Float64Array(N);
    this.xRe = new Float64Array(N); this.xIm = new Float64Array(N);
    this.inBuf = [new Float64Array(N), new Float64Array(N)];
    this.xSpec = [new Float64Array(N), new Float64Array(N), new Float64Array(N), new Float64Array(N)];
    this.outA = [new Float64Array(K), new Float64Array(K)];
    this.outB = [new Float64Array(K), new Float64Array(K)];
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.latency = K + K / 2;
  }
  /** Kernel spectrum (2K-point) from a magnitude sampled on 2K bins (mag[k] at k fs / 2K, k = 0..K). */
  private kernelSpectrum(mag: Float64Array, re: Float64Array, im: Float64Array): void {
    const K = this.K, N = this.N, fft = getFFT(N);
    re.fill(0); im.fill(0);
    for (let k = 0; k <= K; k++) { re[k] = mag[k]; if (k > 0 && k < K) re[N - k] = mag[k]; }
    fft.transform(re, im, true); // zero-phase impulse response, times N
    const h = this.re;
    for (let j = 0; j < K; j++) h[j] = (re[(j - K / 2 + N) % N] / N) * Math.sin((Math.PI * j) / (K - 1));
    re.fill(0); im.fill(0);
    for (let j = 0; j < K; j++) re[j] = h[j];
    fft.transform(re, im);
  }
  /** New kernel: immediate, or crossfaded from the current one over `fade` samples. */
  setKernel(mag: Float64Array, fadeSamples: number, first: boolean): void {
    if (first || fadeSamples <= 0) {
      this.kernelSpectrum(mag, this.kRe, this.kIm);
      this.fading = false;
      this.recompute(this.outA, this.kRe, this.kIm);
      return;
    }
    if (this.fading) {
      // continue from the current mixture: old := (1 - a) old + a target (linear in the kernel)
      const a = this.alpha;
      for (let k = 0; k < this.N; k++) { this.kRe[k] += a * (this.nRe[k] - this.kRe[k]); this.kIm[k] += a * (this.nIm[k] - this.kIm[k]); }
      for (let c = 0; c < 2; c++) for (let i = 0; i < this.K; i++) this.outA[c][i] += a * (this.outB[c][i] - this.outA[c][i]);
    }
    this.kernelSpectrum(mag, this.nRe, this.nIm);
    this.recompute(this.outB, this.nRe, this.nIm);
    this.fading = true;
    this.alpha = 0;
    this.rate = 1 / fadeSamples;
  }
  /** Output block of the current frame for a kernel. */
  private recompute(out: [Float64Array, Float64Array], kRe: Float64Array, kIm: Float64Array): void {
    const N = this.N, K = this.K, fft = getFFT(N);
    for (let c = 0; c < 2; c++) {
      const xr = this.xSpec[2 * c], xi = this.xSpec[2 * c + 1];
      for (let k = 0; k < N; k++) {
        const a = xr[k], b = xi[k], cr = kRe[k], ci = kIm[k];
        this.re[k] = a * cr - b * ci;
        this.im[k] = a * ci + b * cr;
      }
      fft.transform(this.re, this.im, true);
      const o = out[c];
      for (let i = 0; i < K; i++) o[i] = this.re[K + i] / N;
    }
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const K = this.K;
    for (let i = 0; i < n; i++) {
      const j = this.fill;
      this.inBuf[0][K + j] = L[i];
      this.inBuf[1][K + j] = R[i];
      if (this.fading) {
        const a = this.alpha;
        L[i] = this.outA[0][j] + a * (this.outB[0][j] - this.outA[0][j]);
        R[i] = this.outA[1][j] + a * (this.outB[1][j] - this.outA[1][j]);
        this.alpha = a + this.rate;
        if (this.alpha >= 1) {
          this.fading = false;
          this.kRe.set(this.nRe); this.kIm.set(this.nIm);
          this.outA[0].set(this.outB[0]); this.outA[1].set(this.outB[1]);
        }
      } else {
        L[i] = this.outA[0][j];
        R[i] = this.outA[1][j];
      }
      if (++this.fill === K) {
        this.fill = 0;
        this.frame();
      }
    }
  }
  private frame(): void {
    const N = this.N, K = this.K, fft = getFFT(N);
    for (let c = 0; c < 2; c++) {
      const xr = this.xSpec[2 * c], xi = this.xSpec[2 * c + 1];
      xr.set(this.inBuf[c]); xi.fill(0);
      fft.transform(xr, xi);
      this.inBuf[c].copyWithin(0, K);
    }
    this.recompute(this.outA, this.kRe, this.kIm);
    if (this.fading) this.recompute(this.outB, this.nRe, this.nIm);
  }
  reset(): void {
    for (const b of this.inBuf) b.fill(0);
    for (const b of this.xSpec) b.fill(0);
    for (const b of this.outA) b.fill(0);
    for (const b of this.outB) b.fill(0);
    this.fill = 0;
    if (this.fading) { this.kRe.set(this.nRe); this.kIm.set(this.nIm); this.fading = false; }
  }
}

// ------------------------------------------------------------------ the EQ
export class ParametricEQ2 implements EffectInstance {
  private sr: number;
  private p: PEQ2Params;
  private bands: Band[] = [];
  private mode: DesignMode = 'plus';
  private enhanced = false;
  private lin = false;
  private gain = 1;
  private gainTarget = 1;
  private smooth = 0; // per-sample glide coefficient at the design rate (0 = instant)
  private quiet = 0;
  private started = false;
  private hiirL = new Hiir2x(); private hiirR = new Hiir2x();
  private firL = new FirDown2x(); private firR = new FirDown2x();
  private osL: Float64Array; private osR: Float64Array;
  private linEq: LinearPhase | null = null;
  private linKey = '';
  private linPending = false;
  private linMag: Float64Array | null = null;
  latency = 0;
  analyser = { buffer: new Float32Array(8192), write: 0, watched: false };

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    this.p = normalizePEQ2(undefined);
    this.osL = new Float64Array(Math.max(1, blockSize) * 2);
    this.osR = new Float64Array(Math.max(1, blockSize) * 2);
    for (let i = 0; i < 7; i++) this.bands.push(new Band());
    this.setParams(this.p);
  }

  setParams(raw: unknown): void {
    const p = normalizePEQ2(raw as Partial<PEQ2Params>);
    this.p = p;
    this.gainTarget = Math.pow(10, p.mainLevel / 20);
    if (!this.started) this.gain = this.gainTarget; // a loaded state applies at once
    const mode = designModeOf(p);
    const enhanced = mode === 'os2' && p.hqMode === 'enhanced';
    const modeChanged = mode !== this.mode || enhanced !== this.enhanced || p.lin !== this.lin;
    this.mode = mode;
    this.enhanced = enhanced;
    this.lin = p.lin;
    const fsd = designRate(this.sr, mode);
    const sp = p.opts.minPhaseModSpeed;
    const k = 44100 / (192 * fsd);
    this.smooth = p.lin ? 0 : sp === 2 ? k : sp === 1 ? 1 - (1 - k) * (1 - k) : 0;
    if (modeChanged) {
      this.hiirL.reset(); this.hiirR.reset(); this.firL.reset(); this.firR.reset();
      for (const b of this.bands) b.reset();
    }
    const active = new Set<PEQ2Band>(activeBands(p));
    p.bands.forEach((b, i) => {
      const rt = this.bands[i];
      const on = active.has(b);
      if (on !== rt.on || b.type !== rt.type || Math.round(b.order) !== rt.order) {
        // topology change: clear the state, jump to the new values
        rt.on = on; rt.type = b.type; rt.order = Math.round(b.order);
        rt.reset();
        rt.fx = rt.tfx = b.freq; rt.bx = rt.tbx = b.bw; rt.lv = rt.tlv = b.level;
        rt.moving = false;
        rt.design(fsd, mode);
        return;
      }
      rt.tfx = b.freq; rt.tbx = b.bw; rt.tlv = b.level;
      if (this.smooth === 0 || modeChanged || !this.started) {
        rt.fx = b.freq; rt.bx = b.bw; rt.lv = b.level;
        rt.moving = false;
        rt.design(fsd, mode);
      } else {
        rt.moving = rt.fx !== rt.tfx || rt.bx !== rt.tbx || rt.lv !== rt.tlv;
      }
    });
    if (p.lin) {
      const K = 256 << Math.max(0, Math.min(5, Math.round(p.linPrecision)));
      const first = !this.linEq || this.linEq.K !== K;
      if (first) { this.linEq = new LinearPhase(K); this.linMag = new Float64Array(K + 1); this.linKey = ''; }
      const key = this.responseKey(p);
      if (key !== this.linKey) {
        this.linKey = key;
        if (first || !this.linEq!.fading) this.applyKernel(first || modeChanged);
        else this.linPending = true;
      }
      this.latency = this.linEq!.latency;
    } else {
      this.linEq = null;
      this.latency = enhanced ? FIR_LATENCY : 0;
    }
  }

  private responseKey(p: PEQ2Params): string {
    let s = `${this.mode}`;
    for (const b of activeBands(p)) if (!bandIsFlat(b)) s += `|${b.type}${b.order}:${b.freq}:${b.bw}:${b.level}`;
    return s;
  }

  /** LIN kernel from the bands' minimum-phase magnitude. */
  private applyKernel(immediate: boolean): void {
    const eq = this.linEq!, mag = this.linMag!, K = eq.K, sr = this.sr;
    const dfs = designRate(sr, this.mode);
    const coefs: BiquadCoefs[] = [];
    for (const b of activeBands(this.p)) {
      if (bandIsFlat(b)) continue;
      for (const s of bandSpecs(b.type as Exclude<PEQ2Type, 'off'>, b.freq, b.bw, b.level, b.order)) coefs.push(designSection(s, dfs, this.mode));
    }
    for (let k = 0; k <= K; k++) {
      const f = (k * sr) / (2 * K);
      let m = 1;
      for (const c of coefs) m *= biquadResponse(c, f, dfs)[0];
      mag[k] = Math.pow(m, LIN_EXPONENT);
    }
    eq.setKernel(mag, immediate ? 0 : LIN_FADE[this.p.opts.linModSpeed] * sr, immediate);
    this.linPending = false;
  }

  reset(): void {
    for (const b of this.bands) b.reset();
    this.hiirL.reset(); this.hiirR.reset(); this.firL.reset(); this.firR.reset();
    this.linEq?.reset();
    this.quiet = 0;
  }

  private tap(L: Float32Array, R: Float32Array, n: number): void {
    const a = this.analyser;
    const N = a.buffer.length;
    let w = a.write;
    for (let i = 0; i < n; i++) { a.buffer[w] = L[i]; a.buffer[w + 1] = R[i]; w = (w + 2) % N; }
    a.write = w;
  }

  /** Runs every band over the buffers (at the design rate), gliding moving bands per sample. */
  private runBands(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number, fsd: number): void {
    const k = this.smooth;
    const hold = 0.2 * fsd;
    for (const b of this.bands) {
      if (!b.on || b.n === 0) continue;
      if (!b.moving) {
        if (b.flat) {
          b.flatFor += n;
          const idle = b.flatFor >= hold;
          b.run(L, 0, 0, n, idle); b.run(R, 1, 0, n, idle);
        } else { b.flatFor = 0; b.run(L, 0, 0, n); b.run(R, 1, 0, n); }
        continue;
      }
      b.flatFor = 0;
      for (let i = 0; i < n; i++) {
        b.fx += (b.tfx - b.fx) * k; b.bx += (b.tbx - b.bx) * k; b.lv += (b.tlv - b.lv) * k;
        const done = Math.abs(b.tfx - b.fx) < 1e-9 && Math.abs(b.tbx - b.bx) < 1e-9 && Math.abs(b.tlv - b.lv) < 1e-7;
        if (done) { b.fx = b.tfx; b.bx = b.tbx; b.lv = b.tlv; }
        b.design(fsd, this.mode); // FL recomputes the coefficients every sample while gliding
        b.run(L, 0, i, i + 1); b.run(R, 1, i, i + 1);
        if (done) {
          b.moving = false;
          b.run(L, 0, i + 1, n); b.run(R, 1, i + 1, n);
          break;
        }
      }
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (n <= 0) return;
    this.started = true;
    if (n > this.osL.length / 2) {
      const m = this.osL.length / 2;
      for (let o = 0; o < n; o += m) { const c = Math.min(m, n - o); this.process(L.subarray(o, o + c), R.subarray(o, o + c), c); }
      return;
    }
    if (this.analyser.watched && this.p.monitor === 'input') this.tap(L, R, n);
    if (!this.lin) {
      // FL stops after 0.2 s of digital silence at the input (whole blocks), states frozen
      let silent = true;
      for (let i = 0; i < n; i++) if (L[i] !== 0 || R[i] !== 0) { silent = false; break; }
      if (silent) {
        if (this.quiet >= 0.2 * this.sr) return;
        this.quiet += n;
      } else {
        if (this.quiet >= 0.2 * this.sr) for (const b of this.bands) b.flatFor = 0; // resumed
        this.quiet = 0;
      }
    }
    // main level (applied to the input, as FL): linear ramp across the block, at most 44.1 / s in linear gain
    const g0 = this.gain, max = (44.1 * n) / designRate(this.sr, this.mode); // half as fast with Legacy / Enhanced HQ
    const g1 = g0 + Math.max(-max, Math.min(max, this.gainTarget - g0));
    if (g0 !== 1 || g1 !== 1) {
      const d = (g1 - g0) / n;
      for (let i = 0; i < n; i++) { const g = g0 + d * i; L[i] *= g; R[i] *= g; }
    }
    this.gain = g1;
    if (this.lin && this.linEq) {
      if (this.linPending && !this.linEq.fading) this.applyKernel(false);
      this.linEq.process(L, R, n);
    } else if (this.mode === 'os2') {
      const fsd = this.sr * 2;
      if (this.enhanced) {
        for (let i = 0; i < n; i++) { this.osL[2 * i] = L[i]; this.osL[2 * i + 1] = 0; this.osR[2 * i] = R[i]; this.osR[2 * i + 1] = 0; }
      } else { this.hiirL.up(L, n, this.osL); this.hiirR.up(R, n, this.osR); }
      this.runBands(this.osL, this.osR, 2 * n, fsd);
      if (this.enhanced) { this.firL.down(this.osL, n, L); this.firR.down(this.osR, n, R); }
      else { this.hiirL.down(this.osL, n, L); this.hiirR.down(this.osR, n, R); }
    } else {
      this.runBands(L, R, n, this.sr);
    }
    if (this.analyser.watched && this.p.monitor !== 'input') this.tap(L, R, n);
  }
}
