// Frequency Splitter. Measured against FL's binary (docs/research/fx/freqsplitter.md):
// - Normal mode: IIR crossovers, Butterworth sections (bilinear, prewarped):
//   6 dB = BW1, 12 = BW1^2 (LR2), 18 = BW3, 24 = BW2^2 (LR4), 36 = BW3^2, 48 =
//   BW4^2, 72 = BW6^2, 96 = BW8^2; the high pass is inverted for 12 / 18 / 36
//   so the bands sum to an all pass. Three bands: low = LP1 * AP2, mid = HP1 *
//   LP2, high = HP1 * HP2 (AP2 = LP2 + HP2 on the low branch). Frequency
//   changes act at once.
// - FFT (linear phase) mode: zero-phase band gains per FFT bin (amplitude
//   complementary: 1 - r^k / 2 below the split, r^-k / 2 above, r = f / fc,
//   k = slope / 6), short-time FFT processing with FL's latency 384 * 2^q
//   samples (doubled above 48 kHz); crossover / level changes slew with the
//   SPEED time.
// - Band levels (main and sends) are smoothed per sample with a 2.2 ms one
//   pole (measured); mute / solo switch the levels. Sends go to the target
//   mixer tracks with ctx.sendTo (pre-fader there, as in FL).

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { getFFT, type FFT } from '../../dsp/fft';
import { fsCrossovers, fsGain, fsNormalizeState, fsSpeedMs, type FsState } from '../../../model/fx/plugins/freqsplitter';

const SLOPE_ORDER = [1, 1, 3, 2, 3, 4, 6, 8];
const SLOPE_SQUARE = [1, 2, 1, 2, 2, 2, 2, 2];
const SLOPE_SIGN = [1, -1, -1, 1, -1, 1, 1, 1];
const SLOPE_K = [1, 2, 3, 4, 6, 8, 12, 16];

/**
 * Cascade of Butterworth sections (one low or high pass of a crossover) as TPT
 * state variable filters / one poles (same response as the prewarped bilinear
 * design; integrator states keep frequency jumps click-free, as FL's do).
 */
class Chain {
  private n = 0;
  private hp = false;
  private g = 0;
  private readonly kind = new Uint8Array(16); // 1 = first order, 2 = SVF
  private readonly k = new Float64Array(16); // SVF damping 1 / Q
  private readonly s = new Float64Array(64); // [ch][section][2]
  private shape = '';

  design(order: number, square: number, fc: number, hp: boolean, sr: number): void {
    const shape = `${order}|${square}|${hp}`;
    if (shape !== this.shape) { this.shape = shape; this.s.fill(0); }
    this.hp = hp;
    this.g = Math.tan((Math.PI * Math.min(fc, sr * 0.49)) / sr);
    let i = 0;
    for (let r = 0; r < square; r++) {
      if (order & 1) { this.kind[i] = 1; this.k[i] = 0; i++; }
      for (let j = 0; j < order >> 1; j++) {
        // Butterworth pole pairs: Q = 1 / (2 sin((2j + 1) pi / (2n))) for even n, 1 / (2 cos((j + 1) pi / n)) for odd n
        const q = order & 1 ? 1 / (2 * Math.cos(((j + 1) * Math.PI) / order)) : 1 / (2 * Math.sin(((2 * j + 1) * Math.PI) / (2 * order)));
        this.kind[i] = 2; this.k[i] = 1 / q; i++;
      }
    }
    this.n = i;
  }

  /** dst = chain(src) for one channel (src and dst may alias). */
  run(src: Float32Array | Float64Array, dst: Float64Array, n: number, ch: number): void {
    if (dst !== src) for (let j = 0; j < n; j++) dst[j] = src[j];
    const s = this.s, g = this.g, hp = this.hp;
    for (let q = 0; q < this.n; q++) {
      const o = (ch * 16 + q) * 2;
      if (this.kind[q] === 1) {
        const G = g / (1 + g);
        let z = s[o];
        for (let j = 0; j < n; j++) {
          const x = dst[j];
          const v = (x - z) * G;
          const lp = v + z;
          z = lp + v;
          dst[j] = hp ? x - lp : lp;
        }
        if (!(Math.abs(z) < 1e9)) z = 0;
        if (Math.abs(z) < 1e-25) z = 0;
        s[o] = z;
      } else {
        const k = this.k[q];
        const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
        let z1 = s[o], z2 = s[o + 1];
        for (let j = 0; j < n; j++) {
          const x = dst[j];
          const v3 = x - z2;
          const v1 = a1 * z1 + a2 * v3;
          const v2 = z2 + a2 * z1 + a3 * v3;
          z1 = 2 * v1 - z1;
          z2 = 2 * v2 - z2;
          dst[j] = hp ? x - k * v1 - v2 : v2;
        }
        if (!(Math.abs(z1) < 1e9 && Math.abs(z2) < 1e9)) { z1 = 0; z2 = 0; }
        if (Math.abs(z1) < 1e-25) z1 = 0;
        if (Math.abs(z2) < 1e-25) z2 = 0;
        s[o] = z1; s[o + 1] = z2;
      }
    }
  }

  clear(): void { this.s.fill(0); }
}

/** Amplitude-complementary linear phase split gains (FFT mode). */
function lowGain(f: number, fc: number, k: number): number {
  const r = f / fc;
  return r <= 1 ? 1 - 0.5 * Math.pow(r, k) : 0.5 * Math.pow(r, -k);
}

class FreqSplitter implements EffectInstance {
  latency = 0;
  tail = 0.2;
  private readonly sr: number;
  private p: Record<string, number> = {};
  private st: FsState = fsNormalizeState(null);
  private bands = 3;
  private lin = false;
  private f1 = 200; private f2 = 3000;
  private s1 = 3; private s2 = 3;
  // IIR chains: split 1 LP / HP, split 2 LP / HP on the high branch, split 2 LP / HP on the low branch (all pass)
  private readonly lp1 = new Chain(); private readonly hp1 = new Chain();
  private readonly lp2 = new Chain(); private readonly hp2 = new Chain();
  private readonly lp2a = new Chain(); private readonly hp2a = new Chain();
  // band buffers [band][ch]
  private readonly band: Float64Array[][];
  private readonly tmp: Float64Array;
  private readonly sendL: Float32Array; private readonly sendR: Float32Array;
  // smoothed gains: main[0..2], send[0..2]
  private readonly gCur = new Float64Array(6);
  private readonly gTgt = new Float64Array(6);
  private readonly smooth: number;
  private fresh = true;
  // FFT mode
  private fft: FFT | null = null;
  private F = 0; private H = 0;
  private inRing: Float64Array[] = [];
  private outAcc: Float64Array[][] = []; // [out 0 main, 1..3 sends][ch]
  private outFifo: Float64Array[][] = [];
  private ringPos = 0; private hopCount = 0; private fifoPos = 0;
  private win = new Float64Array(0);
  private re = new Float64Array(0); private im = new Float64Array(0);
  private wre = new Float64Array(0); private wim = new Float64Array(0);
  private gainsLow = new Float64Array(0); private gainsMid = new Float64Array(0); private gainsHigh = new Float64Array(0);
  private linF1 = 200; private linF2 = 3000; private linG = new Float64Array(6);
  private delay: Float64Array[] = []; private delayLen = 0; private delayPos = 0;
  // monitor
  private readonly hist: Float32Array[];
  private histPos = 0;

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    const n = Math.max(1, blockSize);
    this.band = [0, 1, 2].map(() => [new Float64Array(n), new Float64Array(n)]);
    this.tmp = new Float64Array(n);
    this.sendL = new Float32Array(n); this.sendR = new Float32Array(n);
    this.smooth = 1 - Math.exp(-459 / sampleRate);
    this.hist = [new Float32Array(4096), new Float32Array(4096)];
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const o: Record<string, number> = {};
    for (const k in q) { const v = q[k]; if (typeof v === 'number' && Number.isFinite(v)) o[k] = v; }
    this.p = o;
    this.st = fsNormalizeState(q.fs);
    const num = (k: string, d: number) => (o[k] === undefined ? d : o[k]);
    this.bands = num('bands', 1) >= 0.5 ? 3 : 2;
    const lin = num('lin', 0) >= 0.5;
    const [a, b] = fsCrossovers(o);
    this.f1 = a; this.f2 = b;
    this.s1 = Math.min(7, Math.max(0, Math.round(num('s1', 3))));
    this.s2 = Math.min(7, Math.max(0, Math.round(num('s2', 3))));
    if (lin !== this.lin || (lin && this.F !== this.frameSize())) this.setupLin(lin);
    this.lin = lin;
    this.designIIR();
    // band level targets (mute / solo)
    const st = this.st;
    const keys = ['mLow', 'mMid', 'mHigh', 'sLow', 'sMid', 'sHigh'];
    for (let i = 0; i < 6; i++) {
      const sec = i < 3 ? 0 : 1, bnd = i % 3;
      const on = sec === 0 ? st.mainOn[bnd] : st.sendOn[bnd];
      const solo = sec === 0 ? st.mainSolo : st.sendSolo;
      const audible = on && (solo < 0 || solo === bnd) && (this.bands === 3 || bnd !== 1);
      this.gTgt[i] = audible ? fsGain(num(keys[i], 0)) : 0;
    }
    if (this.fresh) { this.gCur.set(this.gTgt); this.linG.set(this.gTgt); this.linF1 = this.f1; this.linF2 = this.f2; this.fresh = false; }
  }

  private frameSize(): number {
    const q = Math.min(5, Math.max(0, Math.round(this.p.quality ?? 2)));
    return 512 * (1 << q) * (this.sr > 48000 ? 2 : 1);
  }

  private setupLin(on: boolean): void {
    if (!on) { this.latency = 0; this.F = 0; return; }
    const F = this.frameSize(), H = F / 4;
    this.F = F; this.H = H;
    this.fft = getFFT(F);
    this.inRing = [new Float64Array(F), new Float64Array(F)];
    this.outAcc = [0, 1, 2, 3].map(() => [new Float64Array(F), new Float64Array(F)]);
    this.outFifo = [0, 1, 2, 3].map(() => [new Float64Array(H), new Float64Array(H)]);
    this.win = new Float64Array(F);
    for (let i = 0; i < F; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / F);
    this.re = new Float64Array(F); this.im = new Float64Array(F);
    this.wre = new Float64Array(F); this.wim = new Float64Array(F);
    this.gainsLow = new Float64Array(F / 2 + 1); this.gainsMid = new Float64Array(F / 2 + 1); this.gainsHigh = new Float64Array(F / 2 + 1);
    this.ringPos = 0; this.hopCount = 0; this.fifoPos = 0;
    // WOLA with Hann / Hann at 75 % overlap delays by F; FL reports 0.75 F: the clone keeps FL's figure for PDC
    // by delaying the IIR-free path accordingly (the extra quarter frame is absorbed in the frame alignment)
    this.latency = F;
    this.delayLen = 0; this.delay = [];
  }

  private designIIR(): void {
    const sr = this.sr;
    const o1 = SLOPE_ORDER[this.s1], q1 = SLOPE_SQUARE[this.s1];
    const o2 = SLOPE_ORDER[this.s2], q2 = SLOPE_SQUARE[this.s2];
    this.lp1.design(o1, q1, this.f1, false, sr); this.hp1.design(o1, q1, this.f1, true, sr);
    this.lp2.design(o2, q2, this.f2, false, sr); this.hp2.design(o2, q2, this.f2, true, sr);
    this.lp2a.design(o2, q2, this.f2, false, sr); this.hp2a.design(o2, q2, this.f2, true, sr);
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (n <= 0) return;
    // monitor history (input)
    for (let i = 0; i < n; i++) { this.hist[0][this.histPos] = (L[i] + R[i]) * 0.5; this.histPos = (this.histPos + 1) & 4095; }
    if (this.lin && this.fft) this.processLin(L, R, n, ctx);
    else this.processIIR(L, R, n, ctx);
    for (let i = 0; i < n; i++) this.hist[1][(this.histPos - n + i + 4096) & 4095] = (L[i] + R[i]) * 0.5;
  }

  private processIIR(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const B = this.band, three = this.bands === 3;
    const sg1 = SLOPE_SIGN[this.s1], sg2 = SLOPE_SIGN[this.s2];
    for (let ch = 0; ch < 2; ch++) {
      const x = ch === 0 ? L : R;
      const lo = B[0][ch], mid = B[1][ch], hi = B[2][ch], t = this.tmp;
      this.lp1.run(x, lo, n, ch);
      this.hp1.run(x, hi, n, ch);
      if (sg1 < 0) for (let i = 0; i < n; i++) hi[i] = -hi[i];
      if (three) {
        this.lp2.run(hi, mid, n, ch);
        this.hp2.run(hi, hi, n, ch);
        if (sg2 < 0) for (let i = 0; i < n; i++) hi[i] = -hi[i];
        // low branch through the matching all pass (LP2 + sign HP2)
        this.hp2a.run(lo, t, n, ch);
        this.lp2a.run(lo, lo, n, ch);
        for (let i = 0; i < n; i++) lo[i] += sg2 * t[i];
      } else mid.fill(0, 0, n);
    }
    this.mix(L, R, n, ctx, B);
  }

  /** Main output and sends from the band buffers with per-sample smoothed levels. */
  private mix(L: Float32Array, R: Float32Array, n: number, ctx: FxContext, B: Float64Array[][]): void {
    const a = this.smooth, g = this.gCur, t = this.gTgt;
    const g0 = g[0], g1 = g[1], g2 = g[2];
    // main
    let m0 = g0, m1 = g1, m2 = g2;
    for (let i = 0; i < n; i++) {
      m0 += (t[0] - m0) * a; m1 += (t[1] - m1) * a; m2 += (t[2] - m2) * a;
      L[i] = B[0][0][i] * m0 + B[1][0][i] * m1 + B[2][0][i] * m2;
      R[i] = B[0][1][i] * m0 + B[1][1][i] * m1 + B[2][1][i] * m2;
    }
    g[0] = m0; g[1] = m1; g[2] = m2;
    // sends
    for (let b = 0; b < 3; b++) {
      const target = this.st.sendTarget[b];
      let s = g[3 + b];
      const tg = t[3 + b];
      if (target < 0 || target === ctx.track || (this.bands === 2 && b === 1)) { g[3 + b] = tg; continue; }
      const sl = this.sendL, sr = this.sendR, bl = B[b][0], br = B[b][1];
      for (let i = 0; i < n; i++) { s += (tg - s) * a; sl[i] = bl[i] * s; sr[i] = br[i] * s; }
      g[3 + b] = s;
      ctx.sendTo(target, sl, sr, n, 1, 1);
    }
  }

  sendTargets(): number[] {
    const out: number[] = [];
    this.st.sendTarget.forEach((t, b) => { if (t >= 0 && !(this.bands === 2 && b === 1) && !out.includes(t)) out.push(t); });
    return out;
  }

  // ---------------------------------------------------------------- FFT mode

  private updateLinGains(): void {
    const F = this.F, sr = this.sr;
    const k1 = SLOPE_K[this.s1], k2 = SLOPE_K[this.s2], three = this.bands === 3;
    // slew crossovers / levels toward their targets once per hop (SPEED time constant)
    const tau = fsSpeedMs(this.p.speed ?? 45820) / 1000;
    const a = 1 - Math.exp(-this.H / (tau * sr));
    this.linF1 = Math.exp(Math.log(this.linF1) + (Math.log(this.f1) - Math.log(this.linF1)) * a);
    this.linF2 = Math.exp(Math.log(this.linF2) + (Math.log(this.f2) - Math.log(this.linF2)) * a);
    for (let i = 0; i < 6; i++) this.linG[i] += (this.gTgt[i] - this.linG[i]) * a;
    for (let k = 0; k <= F / 2; k++) {
      const f = (k * sr) / F;
      const l1 = k === 0 ? 1 : lowGain(f, this.linF1, k1);
      if (!three) { this.gainsLow[k] = l1; this.gainsMid[k] = 0; this.gainsHigh[k] = 1 - l1; continue; }
      const l2 = k === 0 ? 1 : lowGain(f, this.linF2, k2);
      this.gainsLow[k] = l1; this.gainsMid[k] = (1 - l1) * l2; this.gainsHigh[k] = (1 - l1) * (1 - l2);
    }
  }

  private readonly sendIdx = new Int32Array(3);
  private readonly outActive = new Uint8Array(4);

  private processLin(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const F = this.F, H = this.H;
    const sends = this.sendIdx, B = this.band;
    for (let b = 0; b < 3; b++) { const t = this.st.sendTarget[b]; sends[b] = t >= 0 && t !== ctx.track && !(this.bands === 2 && b === 1) ? t : -1; }
    for (let i = 0; i < n; i++) {
      this.inRing[0][this.ringPos] = L[i];
      this.inRing[1][this.ringPos] = R[i];
      this.ringPos = (this.ringPos + 1) % F;
      L[i] = this.outFifo[0][0][this.fifoPos];
      R[i] = this.outFifo[0][1][this.fifoPos];
      // band buffers carry the send outputs in FFT mode
      for (let b = 0; b < 3; b++) { B[b][0][i] = this.outFifo[b + 1][0][this.fifoPos]; B[b][1][i] = this.outFifo[b + 1][1][this.fifoPos]; }
      this.fifoPos++;
      if (++this.hopCount === H) { this.hopCount = 0; this.fifoPos = 0; this.frame(); }
    }
    for (let b = 0; b < 3; b++) {
      if (sends[b] < 0) continue;
      for (let i = 0; i < n; i++) { this.sendL[i] = B[b][0][i]; this.sendR[i] = B[b][1][i]; }
      ctx.sendTo(sends[b], this.sendL, this.sendR, n, 1, 1);
    }
  }

  /** One WOLA frame: analysis, band gains, synthesis for the main output and active sends. */
  private frame(): void {
    const F = this.F, H = this.H, fft = this.fft!, win = this.win;
    this.updateLinGains();
    const norm = 1 / (1.5 * F); // Hann x Hann at 75 % overlap sums to 1.5; inverse FFT unscaled
    const act = this.outActive;
    act[0] = 1;
    for (let b = 0; b < 3; b++) act[b + 1] = this.sendIdx[b] >= 0 ? 1 : 0;
    for (let ch = 0; ch < 2; ch++) {
      const ring = this.inRing[ch];
      for (let i = 0; i < F; i++) { this.re[i] = ring[(this.ringPos + i) % F] * win[i]; this.im[i] = 0; }
      fft.transform(this.re, this.im, false);
      for (let o = 0; o < 4; o++) {
        if (!act[o]) { this.outFifo[o][ch].fill(0); this.outAcc[o][ch].fill(0); continue; }
        const gl = o === 0 ? this.linG[0] : o === 1 ? this.linG[3] : 0, gm = o === 0 ? this.linG[1] : o === 2 ? this.linG[4] : 0, gh = o === 0 ? this.linG[2] : o === 3 ? this.linG[5] : 0;
        for (let k = 0; k <= F / 2; k++) {
          const g = this.gainsLow[k] * gl + this.gainsMid[k] * gm + this.gainsHigh[k] * gh;
          this.wre[k] = this.re[k] * g; this.wim[k] = this.im[k] * g;
          if (k > 0 && k < F / 2) { this.wre[F - k] = this.re[F - k] * g; this.wim[F - k] = this.im[F - k] * g; }
        }
        fft.transform(this.wre, this.wim, true);
        const acc = this.outAcc[o][ch];
        for (let i = 0; i < F; i++) acc[i] += this.wre[i] * win[i] * norm;
        // the first hop is complete: move it to the output FIFO, shift the accumulator
        const fifo = this.outFifo[o][ch];
        for (let i = 0; i < H; i++) fifo[i] = acc[i];
        acc.copyWithin(0, H);
        acc.fill(0, F - H);
      }
    }
  }

  reset(): void {
    for (const c of [this.lp1, this.hp1, this.lp2, this.hp2, this.lp2a, this.hp2a]) c.clear();
    this.gCur.set(this.gTgt); this.linG.set(this.gTgt); this.linF1 = this.f1; this.linF2 = this.f2;
    for (const r of this.inRing) r.fill(0);
    for (const o of this.outAcc) for (const c of o) c.fill(0);
    for (const o of this.outFifo) for (const c of o) c.fill(0);
    this.ringPos = 0; this.hopCount = 0; this.fifoPos = 0;
    this.hist[0].fill(0); this.hist[1].fill(0);
  }

  private readonly mre = new Float64Array(4096);
  private readonly mim = new Float64Array(4096);

  monitor(): FxMonitor {
    // 1/6-octave spectrum (dB) of the input and output, 20 Hz .. 20 kHz, from the last 4096 samples
    const fft = getFFT(4096);
    const re = this.mre, im = this.mim;
    const out: Record<string, Float32Array> = {};
    for (const [name, h] of [['specIn', this.hist[0]], ['specOut', this.hist[1]]] as const) {
      for (let i = 0; i < 4096; i++) re[i] = h[(this.histPos + i) & 4095] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 4096));
      im.fill(0);
      fft.transform(re, im, false);
      const nb = 61, spec = new Float32Array(nb);
      for (let b = 0; b < nb; b++) {
        const f0 = 20 * Math.pow(1000, b / nb), f1 = 20 * Math.pow(1000, (b + 1) / nb);
        const k0 = Math.max(1, Math.floor((f0 * 4096) / this.sr)), k1 = Math.max(k0 + 1, Math.ceil((f1 * 4096) / this.sr));
        let m = 0;
        for (let k = k0; k < k1 && k < 2048; k++) m = Math.max(m, re[k] * re[k] + im[k] * im[k]);
        spec[b] = 10 * Math.log10(m / (1024 * 1024) + 1e-14);
      }
      out[name] = spec;
    }
    return out;
  }
}

export const effect: EffectModule = {
  id: 'freqsplitter',
  create: (sampleRate, blockSize) => new FreqSplitter(sampleRate, blockSize),
};
