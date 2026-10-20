// Pitch Shifter: FL's Voice and Music engines, calibrated against FL's
// binary (docs/research/fx/pitchshifter.md).
//
// Music (granular, latency 0): grains of Duration D (Hann window) start every
// D / Density samples (Jitter lengthens each hop by up to 100%), each reading
// the input at the pitch ratio r from max(0, (r - 1) D) + 4 samples in the
// past (plus Rand x U(0, D / 2)), so a grain never reads ahead of the input.
// The grain clock runs from the plugin's start; grains have gain 1 (no
// overlap normalisation). Reads use Catmull-Rom for r <= 1 and an 8-tap
// windowed sinc with cutoff 1 / r above (FL's impulse responses).
//
// Voice (TD-PSOLA, latency 27.85 / 55.71 ms with the FAST / ACCURATE
// detector): YIN pitch detection on the analysis channel (decimated to about
// 12 kHz and refined at full rate, 53 Hz .. 2.2 kHz), pitch marks one period
// apart aligned by cross-correlation, and grains of two input periods (Hann)
// placed one output period apart, each resampled by the formant factor
// 2^(Formant / 12) x 2^(Pitch (1 - correction) / 12). Unvoiced input passes
// unshifted. The absolute modes place grains at the period of C4 / C5 / C6
// (FL numbering, C5 = middle C) x 2^(Pitch / 12).
//
// Both engines end in tanh (FL's wet-path saturation), followed by the echo
// section (Post: the echo is shifted again in the loop; Pre: shifted, then
// delayed; No shift: a plain echo of the shifted signal) and the linear
// dry / wet mix, the dry path delayed to line up with the Voice engine.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { getFFT } from '../../dsp/fft';
import { PS_ABS_HZ, psDelayBeats, psDelayMs, psLatency } from '../../../model/fx/plugins/pitchshifter';

// ---------------------------------------------------------------- tables

const SINC_RES = 512;
/** sinc(u) for u in [0, 4]. */
const SINC_TAB = new Float32Array(4 * SINC_RES + 2);
/** Blackman window half, x = |d| / 4 in [0, 1]. */
const WIN_TAB = new Float32Array(SINC_RES + 2);
const HANN_RES = 1024;
/** 0.5 + 0.5 cos(pi x) for x in [0, 1]. */
const HANN_TAB = new Float32Array(HANN_RES + 2);
for (let i = 0; i < SINC_TAB.length; i++) {
  const u = i / SINC_RES;
  SINC_TAB[i] = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
}
for (let i = 0; i < WIN_TAB.length; i++) {
  const x = Math.min(1, i / SINC_RES);
  WIN_TAB[i] = Math.max(0, 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x));
}
for (let i = 0; i < HANN_TAB.length; i++) {
  const x = Math.min(1, i / HANN_RES);
  HANN_TAB[i] = 0.5 + 0.5 * Math.cos(Math.PI * x);
}

/** Hann window centred at 0, x in [-1, 1]. */
function hann(x: number): number {
  const a = (x < 0 ? -x : x) * HANN_RES;
  const i = a | 0;
  if (i >= HANN_RES) return 0;
  return HANN_TAB[i] + (HANN_TAB[i + 1] - HANN_TAB[i]) * (a - i);
}

let rdL = 0;
let rdR = 0;

/**
 * Interpolated stereo read at position u of two ring buffers. rate <= 1:
 * Catmull-Rom; above: 8-tap windowed sinc with cutoff 1 / rate (normalised
 * to unity DC gain). Results in rdL / rdR.
 */
function readPair(bL: Float32Array, bR: Float32Array, mask: number, u: number, rate: number): void {
  const i = Math.floor(u);
  const t = u - i;
  if (rate <= 1.0001) {
    const t2 = t * t, t3 = t2 * t;
    const w0 = -0.5 * t3 + t2 - 0.5 * t;
    const w1 = 1.5 * t3 - 2.5 * t2 + 1;
    const w2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
    const w3 = 0.5 * t3 - 0.5 * t2;
    const i0 = (i - 1) & mask, i1 = i & mask, i2 = (i + 1) & mask, i3 = (i + 2) & mask;
    rdL = w0 * bL[i0] + w1 * bL[i1] + w2 * bL[i2] + w3 * bL[i3];
    rdR = w0 * bR[i0] + w1 * bR[i1] + w2 * bR[i2] + w3 * bR[i3];
    return;
  }
  const c = 1 / rate;
  let aL = 0, aR = 0, s = 0;
  for (let k = -3; k <= 4; k++) {
    let d = k - t;
    if (d < 0) d = -d;
    if (d >= 4) continue;
    const su = c * d * SINC_RES;
    const si = su | 0;
    const sv = SINC_TAB[si] + (SINC_TAB[si + 1] - SINC_TAB[si]) * (su - si);
    const wu = d * 0.25 * SINC_RES;
    const wi = wu | 0;
    const h = sv * (WIN_TAB[wi] + (WIN_TAB[wi + 1] - WIN_TAB[wi]) * (wu - wi));
    const j = (i + k) & mask;
    aL += h * bL[j];
    aR += h * bR[j];
    s += h;
  }
  const g = s > 1e-9 ? 1 / s : 0;
  rdL = aL * g;
  rdR = aR * g;
}

/** xorshift32, deterministic from reset. */
class Rng {
  private s = 0x2545f491;
  seed(v: number): void { this.s = v | 0 || 1; }
  next(): number {
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x;
    return (x >>> 0) / 4294967296;
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ---------------------------------------------------------------- Music engine

const MAXG = 24;

class MusicEngine {
  private gStart = new Float64Array(MAXG);
  private gRead = new Float64Array(MAXG);
  private gLen = new Float64Array(MAXG);
  private gRate = new Float64Array(MAXG);
  private gOn = new Uint8Array(MAXG);
  private next = 0;
  private rng = new Rng();
  rate = 1;
  len = 4080;
  dens = 2;
  jit = 0;
  rand = 0;
  outL = 0;
  outR = 0;

  constructor(private bL: Float32Array, private bR: Float32Array, private mask: number) {}

  reset(n: number): void {
    this.gOn.fill(0);
    this.next = n;
    this.rng.seed(0x1234567);
  }

  activeGrains(): number {
    let c = 0;
    for (let g = 0; g < MAXG; g++) c += this.gOn[g];
    return c;
  }

  render(n: number): void {
    if (n >= this.next) this.spawn(n);
    let aL = 0, aR = 0;
    const bL = this.bL, bR = this.bR, mask = this.mask;
    for (let g = 0; g < MAXG; g++) {
      if (this.gOn[g] === 0) continue;
      const k = n - this.gStart[g];
      const len = this.gLen[g];
      if (k >= len) { this.gOn[g] = 0; continue; }
      const w = hann((2 * k) / len - 1);
      if (w <= 0) continue;
      const r = this.gRate[g];
      readPair(bL, bR, mask, this.gRead[g] + r * k, r);
      aL += w * rdL;
      aR += w * rdR;
    }
    this.outL = aL;
    this.outR = aR;
  }

  private spawn(n: number): void {
    const len = this.len, r = this.rate;
    let slot = -1;
    for (let g = 0; g < MAXG; g++) if (this.gOn[g] === 0) { slot = g; break; }
    if (slot >= 0) {
      const back = Math.max(0, (r - 1) * len) + 4 + this.rand * this.rng.next() * len * 0.5;
      this.gStart[slot] = n;
      this.gRead[slot] = n - back;
      this.gLen[slot] = len;
      this.gRate[slot] = r;
      this.gOn[slot] = 1;
    }
    // Jitter only lengthens the hop (FL: gaps, never pile-ups)
    let hop = (len / this.dens) * (1 + this.jit * this.rng.next());
    if (hop < 1) hop = 1;
    this.next += hop;
    if (this.next <= n) this.next = n + hop;
  }
}

// ---------------------------------------------------------------- Voice engine

const MAXV = 48;
const HIST = 64;
const MARKS = 256;
const DSIZE = 4096;
const DET_HOP = 256;

class VoiceEngine {
  // grains: synthesis centre, analysis centre, output half-length, formant factor
  private vS = new Float64Array(MAXV);
  private vA = new Float64Array(MAXV);
  private vH = new Float64Array(MAXV);
  private vF = new Float64Array(MAXV);
  private vOn = new Uint8Array(MAXV);
  // analysis signal (raw and low-passed, full rate) and its decimated copy
  private abuf: Float32Array;
  private lbuf: Float32Array;
  private dbuf = new Float32Array(DSIZE);
  private dHead = 0;
  private dCount = 0;
  private dPhase = 0;
  private readonly M: number;
  private readonly srd: number;
  private readonly tauMin: number;
  private readonly tauMax: number;
  private W = 64;
  private lpc = new Float64Array(10);
  private lps = new Float64Array(4);
  private scratch: Float64Array;
  private dTab: Float64Array;
  private dPrime: Float64Array;
  // detection history (centre time, period, voiced)
  private hC = new Float64Array(HIST);
  private hP = new Float64Array(HIST);
  private hV = new Uint8Array(HIST);
  private hHead = 0;
  private hCount = 0;
  private lastDet = -1e18;
  private voicedState = false;
  private lastPeriod: number;
  // pitch marks
  private mPos = new Float64Array(MARKS);
  private mPer = new Float64Array(MARKS);
  private mHead = 0;
  private mCount = 0;
  private lastMark = -1;
  private scanPos = 0;
  // synthesis plan
  private pS = 0;
  private pA = 0;
  private pH = 1;
  private pF = 1;
  private pStep = 1;
  private pStart = 0;
  private pVoiced = false;
  private planned = false;
  private readonly Tu: number;
  // parameters
  ratio = 1;
  formant = 1;
  pmode = 0;
  chan = 0;
  detector = 1;
  latency = 0;
  Dw = 4;
  outL = 0;
  outR = 0;
  f0 = 0;

  constructor(private sr: number, private bL: Float32Array, private bR: Float32Array, private mask: number) {
    this.abuf = new Float32Array(mask + 1);
    this.lbuf = new Float32Array(mask + 1);
    this.M = Math.max(1, Math.round(sr / 12000));
    this.srd = sr / this.M;
    this.tauMin = Math.max(2, Math.floor(this.srd / 2200));
    this.tauMax = Math.ceil(this.srd / 53);
    this.dTab = new Float64Array(this.tauMax + 2);
    this.dPrime = new Float64Array(this.tauMax + 2);
    this.scratch = new Float64Array(4 * this.tauMax + 16);
    this.Tu = Math.max(16, Math.round(0.005 * sr));
    this.lastPeriod = this.Tu;
    // analysis anti-alias low-pass: 4th-order Butterworth at 0.3 x the decimated rate
    const fc = Math.min(0.45 * sr, 0.3 * this.srd);
    const qs = [0.5411961, 1.306563];
    for (let k = 0; k < 2; k++) {
      const w0 = (2 * Math.PI * fc) / sr, cs = Math.cos(w0), al = Math.sin(w0) / (2 * qs[k]), a0 = 1 + al;
      const o = k * 5;
      this.lpc[o] = (1 - cs) / 2 / a0;
      this.lpc[o + 1] = (1 - cs) / a0;
      this.lpc[o + 2] = (1 - cs) / 2 / a0;
      this.lpc[o + 3] = (-2 * cs) / a0;
      this.lpc[o + 4] = (1 - al) / a0;
    }
    this.setDetector(1);
  }

  setDetector(d: number): void {
    this.detector = d;
    this.latency = psLatency(this.sr, 0, d);
    this.Dw = this.latency + 4;
    const win = Math.round((d === 1 ? 0.0557 : 0.028) * this.srd) - this.tauMax;
    this.W = Math.max(d === 1 ? this.tauMax : 48, Math.min(3 * this.tauMax, win));
  }

  reset(n: number): void {
    this.abuf.fill(0);
    this.lbuf.fill(0);
    this.dbuf.fill(0);
    this.dHead = 0; this.dCount = 0; this.dPhase = 0;
    this.lps.fill(0);
    this.hCount = 0; this.hHead = 0;
    this.lastDet = -1e18;
    this.voicedState = false;
    this.lastPeriod = this.Tu;
    this.f0 = 0;
    this.resetSynthesis(n);
  }

  resetSynthesis(n: number): void {
    this.vOn.fill(0);
    this.mCount = 0; this.mHead = 0;
    this.lastMark = -1;
    this.scanPos = n - this.Dw;
    this.planned = false;
    this.pVoiced = false;
  }

  activeGrains(): number {
    let c = 0;
    for (let g = 0; g < MAXV; g++) c += this.vOn[g];
    return c;
  }

  /** Feed the analysis signal for input sample n (after the input buffers were written). */
  push(n: number, xL: number, xR: number): void {
    const a = this.chan === 0 ? xL : this.chan === 1 ? xR : 0.5 * (xL + xR);
    this.abuf[n & this.mask] = a;
    const c = this.lpc, s = this.lps;
    let x = a;
    for (let k = 0; k < 2; k++) {
      const o = k * 5, z = k * 2;
      const y = c[o] * x + s[z];
      s[z] = c[o + 1] * x - c[o + 3] * y + s[z + 1];
      s[z + 1] = c[o + 2] * x - c[o + 4] * y;
      x = y;
    }
    if (!(x > -1e15 && x < 1e15)) { s.fill(0); x = 0; }
    this.lbuf[n & this.mask] = x;
    if (++this.dPhase >= this.M) {
      this.dPhase = 0;
      this.dbuf[this.dHead] = x;
      this.dHead = (this.dHead + 1) & (DSIZE - 1);
      if (this.dCount < DSIZE) this.dCount++;
    }
  }

  /** Pitch detection (every DET_HOP samples) and pitch-mark placement, up to input sample n. */
  analyze(n: number): void {
    const ls = this.lps;
    for (let k = 0; k < 4; k++) if (ls[k] < 1e-25 && ls[k] > -1e-25) ls[k] = 0;
    if (n - this.lastDet >= DET_HOP && this.dCount >= this.W + this.tauMax) {
      this.lastDet = n;
      this.detect(n);
    }
    if (!this.voicedState && this.lastMark < 0) this.scanPos = Math.max(this.scanPos, n - this.Dw);
    this.placeMarks(n);
  }

  private detect(n: number): void {
    const W = this.W, Tm = this.tauMax, N = W + Tm, x = this.scratch;
    let e = 0;
    for (let j = 0; j < N; j++) {
      const v = this.dbuf[(this.dHead - N + j) & (DSIZE - 1)];
      x[j] = v;
      e += v * v;
    }
    const rms = Math.sqrt(e / N);
    const d = this.dTab, dp = this.dPrime;
    d[0] = 0;
    for (let tau = 1; tau <= Tm; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const v = x[j] - x[j + tau];
        s += v * v;
      }
      d[tau] = s;
    }
    let run = 0;
    dp[0] = 1;
    for (let tau = 1; tau <= Tm; tau++) {
      run += d[tau];
      dp[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }
    let tau = -1;
    for (let t = this.tauMin; t <= Tm; t++) {
      if (dp[t] < 0.15) {
        while (t + 1 <= Tm && dp[t + 1] < dp[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = Infinity;
      for (let t = this.tauMin; t <= Tm; t++) if (dp[t] < best) { best = dp[t]; tau = t; }
    }
    const thr = this.voicedState ? 0.4 : 0.25;
    let voiced = rms > 1e-3 && dp[tau] < thr && tau < Tm - 1;
    let tf = tau;
    if (tau > 1 && tau < Tm) {
      const a = dp[tau - 1], b = dp[tau], c = dp[tau + 1], den = a - 2 * b + c;
      if (den > 1e-12) tf = tau + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
    let T = tf * this.M;
    if (voiced && this.M > 1) {
      // refine at full rate around the decimated estimate
      const ab = this.lbuf, mask = this.mask, Wf = 1024;
      const lo = Math.max(4, Math.floor(T) - this.M), hi = Math.ceil(T) + this.M;
      let bestT = lo, best = Infinity, prev = Infinity, next = Infinity, prevS = Infinity;
      for (let Tc = lo; Tc <= hi; Tc++) {
        let s = 0;
        for (let j = 0; j < Wf; j += 2) {
          const v = ab[(n - j) & mask] - ab[(n - j - Tc) & mask];
          s += v * v;
        }
        if (s < best) { best = s; bestT = Tc; prev = prevS; next = Infinity; } else if (Tc === bestT + 1) next = s;
        prevS = s;
      }
      let Tr = bestT;
      if (prev < Infinity && next < Infinity) {
        const den = prev - 2 * best + next;
        if (den > 1e-15) Tr = bestT + Math.max(-0.5, Math.min(0.5, (0.5 * (prev - next)) / den));
      }
      if (Math.abs(Tr - T) <= this.M + 1) T = Tr;
    }
    if (!(T >= 2)) voiced = false;
    this.voicedState = voiced;
    if (voiced) this.lastPeriod = T;
    const i = this.hHead;
    this.hC[i] = n - (N * this.M) / 2;
    this.hP[i] = voiced ? T : this.lastPeriod;
    this.hV[i] = voiced ? 1 : 0;
    this.hHead = (i + 1) & (HIST - 1);
    if (this.hCount < HIST) this.hCount++;
    this.f0 = voiced ? this.sr / T : 0;
  }

  /** Detection entry nearest to time t (-1 if none). */
  private entryAt(t: number): number {
    let bi = -1, bd = Infinity;
    for (let k = 0; k < this.hCount; k++) {
      const i = (this.hHead - 1 - k) & (HIST - 1);
      const dd = Math.abs(this.hC[i] - t);
      if (dd < bd) { bd = dd; bi = i; } else if (this.hC[i] < t) break;
    }
    return bi;
  }

  private voicedAt(t: number): boolean {
    const i = this.entryAt(t);
    return i >= 0 && this.hV[i] === 1;
  }

  private periodAt(t: number): number {
    const i = this.entryAt(t);
    return i >= 0 ? this.hP[i] : this.lastPeriod;
  }

  /** Centre of the earliest voiced detection at or after t (-1 if none). */
  private voicedAfter(t: number): number {
    let found = -1;
    for (let k = 0; k < this.hCount; k++) {
      const i = (this.hHead - 1 - k) & (HIST - 1);
      if (this.hC[i] < t) break;
      if (this.hV[i] === 1) found = this.hC[i];
    }
    return found;
  }

  private pushMark(pos: number, T: number): void {
    this.mPos[this.mHead] = pos;
    this.mPer[this.mHead] = T;
    this.mHead = (this.mHead + 1) & (MARKS - 1);
    if (this.mCount < MARKS) this.mCount++;
    this.lastMark = pos;
  }

  private placeMarks(n: number): void {
    const ready = n - 4;
    const ab = this.lbuf, mask = this.mask;
    for (let iter = 0; iter < 16; iter++) {
      if (this.lastMark < 0) {
        let s = this.scanPos;
        if (!this.voicedAt(s)) {
          const v = this.voicedAfter(s);
          if (v < 0) return;
          s = v;
          this.scanPos = s;
        }
        const T = this.periodAt(s);
        if (s + 1.5 * T > ready) return;
        let best = Math.floor(s), bv = -1;
        for (let k = Math.floor(s); k < s + T; k++) {
          const v = Math.abs(ab[k & mask]);
          if (v > bv) { bv = v; best = k; }
        }
        this.pushMark(best, T);
        continue;
      }
      const Tl = this.mPer[(this.mHead - 1) & (MARKS - 1)];
      const Tn = this.periodAt(this.lastMark + 0.5 * Tl);
      const pred = this.lastMark + Tn;
      const half = Math.max(2, Math.floor(Tn * 0.5));
      const rad = Math.max(1, Math.floor(Tn * 0.125));
      if (pred + rad + half + 2 > ready) return;
      if (!this.voicedAt(pred)) {
        this.lastMark = -1;
        this.scanPos = pred;
        continue;
      }
      const stride = Math.max(1, Math.floor(Tn / 48));
      const j0 = -Math.floor(half / stride) * stride;
      const p0 = Math.round(pred), lm = Math.round(this.lastMark);
      let er = 0;
      for (let j = j0; j <= half; j += stride) { const v = ab[(lm + j) & mask]; er += v * v; }
      let best = p0, bs = -Infinity;
      for (let c = p0 - rad; c <= p0 + rad; c++) {
        let s = 0, ec = 0;
        for (let j = j0; j <= half; j += stride) {
          const v = ab[(c + j) & mask];
          s += v * ab[(lm + j) & mask];
          ec += v * v;
        }
        const sc = s / Math.sqrt(ec * er + 1e-24);
        if (sc > bs) { bs = sc; best = c; }
      }
      this.pushMark(best, Tn);
    }
  }

  /** Nearest analysis mark to s (extrapolated past the last one); NaN when there are none nearby. */
  private nearest(s: number): { a: number; T: number; spacing: number } | null {
    if (this.mCount === 0) return null;
    const last = (this.mHead - 1) & (MARKS - 1);
    const lp = this.mPos[last], lt = this.mPer[last];
    if (s > lp + 0.5 * lt) {
      if (s - lp > 8 * lt) return null;
      const k = Math.round((s - lp) / lt);
      NEAR.a = lp + k * lt; NEAR.T = lt; NEAR.spacing = lt;
      return NEAR;
    }
    let bi = last, bd = Infinity;
    for (let k = 0; k < this.mCount; k++) {
      const i = (this.mHead - 1 - k) & (MARKS - 1);
      const dd = Math.abs(this.mPos[i] - s);
      if (dd < bd) { bd = dd; bi = i; } else if (this.mPos[i] < s) break;
    }
    if (bd > 2 * this.mPer[bi]) return null;
    NEAR.a = this.mPos[bi];
    NEAR.T = this.mPer[bi];
    const nx = (bi + 1) & (MARKS - 1);
    NEAR.spacing = bi !== last ? this.mPos[nx] - this.mPos[bi] : this.mPer[bi];
    if (!(NEAR.spacing > 0.5 * NEAR.T && NEAR.spacing < 2 * NEAR.T)) NEAR.spacing = NEAR.T;
    return NEAR;
  }

  private plan(s: number, now: number): void {
    let voiced = this.voicedAt(s);
    let a = s, T = this.Tu, f = 1, half = this.Tu, step = this.Tu;
    if (voiced) {
      const m = this.nearest(s);
      if (!m) voiced = false;
      else {
        a = m.a; T = m.T;
        let spacing = m.spacing;
        f = this.formant;
        half = T / f;
        if (!this.pVoiced) {
          // voiced onset: start on the first mark at or after s whose grain still fits
          let x = Math.max(s, now + half);
          for (let k = 0; k < 8 && a < x - 0.5; k++) {
            const mm = this.nearest(a + spacing);
            if (!mm) break;
            a = mm.a; T = mm.T; spacing = mm.spacing;
            half = T / f;
            x = Math.max(s, now + half);
          }
          s = a;
        }
        step = this.pmode > 0 ? this.sr / (PS_ABS_HZ[this.pmode - 1] * this.ratio) : spacing / this.ratio;
      }
    }
    let start = s - half;
    if (start < now) { s += now - start; start = now; }
    this.pS = s; this.pA = a; this.pH = half; this.pF = f;
    this.pStep = Math.max(1, step);
    this.pStart = start;
    this.pVoiced = voiced;
    this.planned = true;
  }

  private spawn(): void {
    for (let g = 0; g < MAXV; g++) {
      if (this.vOn[g] !== 0) continue;
      this.vS[g] = this.pS; this.vA[g] = this.pA; this.vH[g] = this.pH; this.vF[g] = this.pF;
      this.vOn[g] = 1;
      return;
    }
  }

  /** Wet output for input sample n (output time n - Dw). */
  render(n: number): void {
    const t = n - this.Dw;
    if (!this.planned) this.plan(t, t);
    let guard = 0;
    while (t >= this.pStart && guard++ < 64) {
      this.spawn();
      this.plan(this.pS + this.pStep, t);
    }
    let aL = 0, aR = 0;
    const bL = this.bL, bR = this.bR, mask = this.mask;
    for (let g = 0; g < MAXV; g++) {
      if (this.vOn[g] === 0) continue;
      const d = t - this.vS[g];
      const h = this.vH[g];
      if (d >= h) { this.vOn[g] = 0; continue; }
      if (d <= -h) continue;
      const w = hann(d / h);
      const f = this.vF[g];
      readPair(bL, bR, mask, this.vA[g] + d * f, f);
      aL += w * rdL;
      aR += w * rdR;
    }
    this.outL = aL;
    this.outR = aR;
  }
}

const NEAR = { a: 0, T: 1, spacing: 1 };

// ---------------------------------------------------------------- plugin

const SPEC_N = 2048;
const BANDS = 96;
const MAX_ECHO_S = 8;

class PitchShifter implements EffectInstance {
  latency = 0;
  tail = 0.5;
  private sr: number;
  private mask: number;
  private bL: Float32Array;
  private bR: Float32Array;
  private n = 0;
  private music: MusicEngine;
  private voice: VoiceEngine;
  private engine = 1;
  // dry path (lined up with the Voice engine)
  private dryL: Float32Array;
  private dryR: Float32Array;
  private dryMask: number;
  private dryDelay = 0;
  // echo
  private eL: Float32Array;
  private eR: Float32Array;
  private eMask: number;
  private eW = 0;
  private delayT = 1;
  private delayS = 1;
  private kDelay: number;
  private dmode = 0;
  private fbT = 0;
  private fbS = 0;
  private mixT = 1;
  private mixS = 1;
  private kMix: number;
  private tempoSync = false;
  private delayRaw = 768;
  private tempo = 120;
  private ratio = 1;
  private len = 4080;
  // display
  private spec = new Float32Array(SPEC_N);
  private specW = 0;
  private seq = 0;

  constructor(sampleRate: number) {
    const sr = (this.sr = sampleRate);
    const size = nextPow2(Math.ceil(0.62 * sr) + 64);
    this.mask = size - 1;
    this.bL = new Float32Array(size);
    this.bR = new Float32Array(size);
    this.music = new MusicEngine(this.bL, this.bR, this.mask);
    this.voice = new VoiceEngine(sr, this.bL, this.bR, this.mask);
    const dsz = nextPow2(psLatency(sr, 0, 1) + 16);
    this.dryMask = dsz - 1;
    this.dryL = new Float32Array(dsz);
    this.dryR = new Float32Array(dsz);
    const esz = nextPow2(Math.ceil(MAX_ECHO_S * sr) + 16);
    this.eMask = esz - 1;
    this.eL = new Float32Array(esz);
    this.eR = new Float32Array(esz);
    this.kDelay = 1 - Math.exp(-1 / (0.05 * sr));
    this.kMix = 1 - Math.exp(-1 / (0.01 * sr));
    this.reset();
  }

  setParams(p: unknown): void {
    const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    const engine = q.engine === 0 ? 0 : 1;
    const detector = q.detector === 0 ? 0 : 1;
    const pitch = num(q.pitch, 0, -1200, 1200);
    const formant = num(q.formant, 0, -1200, 1200);
    const fcorr = num(q.fcorr, 65536, 0, 65536) / 65536;
    this.ratio = Math.pow(2, pitch / 1200);
    this.len = Math.max(16, (num(q.dur, 8500, 2000, 15000) * this.sr) / 100000);
    const m = this.music;
    m.rate = this.ratio;
    m.len = this.len;
    m.dens = num(q.dens, 200, 100, 500) / 100;
    m.jit = num(q.jit, 0, 0, 100) / 100;
    m.rand = num(q.rand, 0, 0, 100) / 100;
    const v = this.voice;
    v.ratio = this.ratio;
    v.formant = Math.pow(2, formant / 1200) * Math.pow(this.ratio, 1 - fcorr);
    v.pmode = Math.round(num(q.pmode, 0, 0, 3));
    v.chan = Math.round(num(q.chan, 0, 0, 2));
    if (detector !== v.detector) {
      v.setDetector(detector);
      v.resetSynthesis(this.n);
    }
    if (engine !== this.engine) {
      this.engine = engine;
      if (engine === 0) v.reset(this.n); else m.reset(this.n);
    }
    this.latency = engine === 0 ? v.latency : 0;
    this.dryDelay = engine === 0 ? Math.max(0, v.latency - 1) : 0;
    this.dmode = Math.round(num(q.dmode, 0, 0, 3));
    this.fbT = num(q.fb, 0, 0, 100) / 100;
    this.mixT = num(q.mix, 2400, 0, 2400) / 2400;
    this.tempoSync = q.tempo === true;
    this.delayRaw = num(q.delay, 768, 1, 768);
    this.updateDelay();
  }

  private delaySeconds(): number {
    return this.tempoSync ? (psDelayBeats(this.delayRaw) * 60) / Math.max(10, this.tempo) : psDelayMs(this.delayRaw) / 1000;
  }

  private updateDelay(): void {
    const sec = this.delaySeconds();
    this.delayT = Math.min(this.eMask - 8, Math.max(1, sec * this.sr));
    const grain = this.engine === 1 ? ((1 + Math.max(1, this.ratio) + 0.5) * this.len) / this.sr : (this.voice.Dw + 4 * this.sr / 53) / this.sr;
    let echo = 0;
    if (this.dmode !== 0) {
      const d = this.delayT / this.sr;
      const fb = this.fbT;
      echo = fb <= 0.001 ? d : fb >= 0.999 ? 30 : Math.min(30, d * (1 + Math.log(1e-4) / Math.log(fb)));
      if (this.dmode === 2) echo += d;
    }
    this.tail = Math.min(31, grain + echo + 0.05);
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (ctx.tempo > 0 && ctx.tempo !== this.tempo) {
      this.tempo = ctx.tempo;
      if (this.tempoSync) this.updateDelay();
    }
    const voice = this.engine === 0;
    const ve = this.voice, me = this.music;
    const bL = this.bL, bR = this.bR, mask = this.mask;
    const eL = this.eL, eR = this.eR, eMask = this.eMask;
    const dryL = this.dryL, dryR = this.dryR, dryMask = this.dryMask, dryDelay = this.dryDelay;
    const dm = this.dmode;
    const kMix = this.kMix, kDelay = this.kDelay;
    let delayS = this.delayS, fbS = this.fbS, mixS = this.mixS;
    const delayT = this.delayT, fbT = this.fbT, mixT = this.mixT;
    let idx = this.n, ew = this.eW, sw = this.specW;
    let bad = false;
    for (let i = 0; i < n; i++) {
      const xL = L[i], xR = R[i];
      const dwi = idx & dryMask;
      dryL[dwi] = xL;
      dryR[dwi] = xR;
      const dri = (idx - dryDelay) & dryMask;
      const dL = dryL[dri], dR = dryR[dri];
      // echo read
      delayS += (delayT - delayS) * kDelay;
      const pos = ew - delayS;
      const ip = Math.floor(pos), fr = pos - ip;
      const i0 = ip & eMask, i1 = (ip + 1) & eMask;
      const elL = eL[i0] + (eL[i1] - eL[i0]) * fr;
      const elR = eR[i0] + (eR[i1] - eR[i0]) * fr;
      fbS += (fbT - fbS) * kMix;
      let vL = xL, vR = xR;
      if (dm === 1 || dm === 2) { vL += fbS * elL; vR += fbS * elR; }
      const w = idx & mask;
      bL[w] = vL;
      bR[w] = vR;
      let oL: number, oR: number;
      if (voice) {
        ve.push(idx, vL, vR);
        if ((idx & 31) === 0) ve.analyze(idx);
        ve.render(idx);
        oL = ve.outL; oR = ve.outR;
      } else {
        me.render(idx);
        oL = me.outL; oR = me.outR;
      }
      const sL = Math.tanh(oL), sR = Math.tanh(oR);
      let yL = sL, yR = sR, wL = 0, wR = 0;
      if (dm === 1) { wL = sL; wR = sR; }
      else if (dm === 2) { wL = sL; wR = sR; yL = elL; yR = elR; }
      else if (dm === 3) {
        yL = sL + fbS * elL;
        yR = sR + fbS * elR;
        // FL's plain echo can run away at 100%: keep it bounded far above full scale
        if (yL > 4 || yL < -4) yL = 4 * Math.tanh(yL * 0.25);
        if (yR > 4 || yR < -4) yR = 4 * Math.tanh(yR * 0.25);
        wL = yL; wR = yR;
      }
      const ewi = ew & eMask;
      eL[ewi] = wL > 1e-20 || wL < -1e-20 ? wL : 0;
      eR[ewi] = wR > 1e-20 || wR < -1e-20 ? wR : 0;
      ew++;
      mixS += (mixT - mixS) * kMix;
      const outL = dL + (yL - dL) * mixS;
      const outR = dR + (yR - dR) * mixS;
      if (outL === outL && outR === outR && outL < 1e6 && outL > -1e6 && outR < 1e6 && outR > -1e6) {
        L[i] = outL;
        R[i] = outR;
      } else {
        L[i] = 0;
        R[i] = 0;
        bad = true;
      }
      this.spec[sw] = 0.5 * (xL + xR);
      sw = (sw + 1) & (SPEC_N - 1);
      idx++;
    }
    this.n = idx;
    this.eW = ew;
    this.specW = sw;
    this.delayS = delayS;
    this.fbS = fbS;
    this.mixS = mixS;
    if (bad) this.reset();
  }

  reset(): void {
    this.bL.fill(0); this.bR.fill(0);
    this.dryL.fill(0); this.dryR.fill(0);
    this.eL.fill(0); this.eR.fill(0);
    this.spec.fill(0);
    this.n = 0;
    this.eW = 0;
    this.specW = 0;
    this.music.reset(0);
    this.voice.reset(0);
    this.delayS = this.delayT;
    this.fbS = this.fbT;
    this.mixS = this.mixT;
  }

  /** Spectrogram column of the input (96 log bands, 20 Hz .. 20 kHz, dB), detected pitch, engine. */
  monitor(): FxMonitor {
    const fft = getFFT(SPEC_N);
    const re = new Float64Array(SPEC_N), im = new Float64Array(SPEC_N);
    for (let i = 0; i < SPEC_N; i++) {
      const wv = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SPEC_N - 1));
      re[i] = this.spec[(this.specW + i) & (SPEC_N - 1)] * wv;
    }
    fft.transform(re, im);
    const mag = new Float64Array(SPEC_N / 2);
    for (let k = 0; k < SPEC_N / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / (SPEC_N / 4);
    const spec: number[] = [];
    const fmax = Math.min(20000, this.sr / 2);
    for (let b = 0; b < BANDS; b++) {
      const f0 = 20 * Math.pow(fmax / 20, b / BANDS), f1 = 20 * Math.pow(fmax / 20, (b + 1) / BANDS);
      const k0 = (f0 * SPEC_N) / this.sr, k1 = (f1 * SPEC_N) / this.sr;
      let m = 0;
      if (k1 - k0 < 1) {
        const kc = 0.5 * (k0 + k1), ki = Math.floor(kc), kf = kc - ki;
        m = ki + 1 < SPEC_N / 2 ? mag[ki] + (mag[ki + 1] - mag[ki]) * kf : 0;
      } else {
        for (let k = Math.floor(k0); k <= Math.ceil(k1) && k < SPEC_N / 2; k++) m = Math.max(m, mag[k]);
      }
      spec.push(Math.max(-120, 20 * Math.log10(m + 1e-9)));
    }
    return {
      spec,
      seq: ++this.seq,
      f0: this.engine === 0 ? this.voice.f0 : 0,
      engine: this.engine,
      grains: this.engine === 0 ? this.voice.activeGrains() : this.music.activeGrains(),
    };
  }
}

export const effect: EffectModule = {
  id: 'pitchshifter',
  create: (sampleRate) => new PitchShifter(sampleRate),
};
