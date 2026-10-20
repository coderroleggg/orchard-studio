// Transient and tempo detection for Newtime.
// Onsets: spectral flux of the log-compressed STFT magnitude (1024-point
// frames, ~5.8 ms hop at 44.1 kHz), peaks above an adaptive threshold (local
// mean + 1.5 x local mean absolute deviation + a floor), at least 45 ms
// apart; each onset is then moved to the sample where the 0.5 ms energy
// envelope starts its rise (clicks land on the click).
// Tempo: autocorrelation of the onset strength over 60..200 BPM with a
// log-normal preference around 120 BPM and the period's multiples summed in;
// a loop length that is close to a whole power-of-two number of beats wins.
// Beats: the phase whose comb collects the most onset strength.

import { getFFT } from '../../../dsp/fft';

export interface OnsetEnvelope {
  /** Source samples per envelope frame. */
  hop: number;
  /** Positive spectral flux per frame (frame k is centred on sample k * hop). */
  flux: Float32Array;
}

export function onsetEnvelope(x: Float32Array, sr: number): OnsetEnvelope {
  const N = sr > 64000 ? 2048 : 1024;
  const hop = N / 4;
  const fft = getFFT(N);
  const frames = Math.max(1, Math.ceil(x.length / hop));
  const re = new Float64Array(N), im = new Float64Array(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const half = N / 2;
  const prev = new Float64Array(half + 1);
  const flux = new Float32Array(frames);
  const gamma = 100;
  for (let k = 0; k < frames; k++) {
    const start = k * hop - N / 2;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
    let f = 0;
    for (let b = 1; b <= half; b++) {
      const mag = Math.log1p(gamma * Math.sqrt(re[b] * re[b] + im[b] * im[b]));
      const dlt = mag - prev[b];
      if (dlt > 0 && k > 0) f += dlt;
      prev[b] = mag;
    }
    flux[k] = f;
  }
  return { hop, flux };
}

export interface TransientOptions {
  /** Threshold multiplier (higher = fewer onsets). */
  sensitivity?: number;
  /** Minimum distance between onsets (s). */
  minGap?: number;
}

/** Sample positions of the transients of a mono signal. */
export function detectTransients(x: Float32Array, sr: number, opt: TransientOptions = {}, env?: OnsetEnvelope): number[] {
  const e = env ?? onsetEnvelope(x, sr);
  const { flux, hop } = e;
  const n = flux.length;
  const k1 = opt.sensitivity ?? 1.5;
  const fps = sr / hop;
  const wHalf = Math.max(3, Math.round(0.1 * fps));
  const gap = Math.max(1, Math.round((opt.minGap ?? 0.045) * fps));
  let maxF = 0;
  for (let i = 0; i < n; i++) maxF = Math.max(maxF, flux[i]);
  if (maxF <= 0) return [];
  const floor = maxF * 0.04;
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = flux[i];
    if (v < floor || v < flux[i - 1] || v < flux[i + 1]) continue;
    let m = 0, cnt = 0;
    const a = Math.max(0, i - wHalf), z = Math.min(n, i + wHalf + 1);
    for (let j = a; j < z; j++) { m += flux[j]; cnt++; }
    m /= cnt;
    let dev = 0;
    for (let j = a; j < z; j++) dev += Math.abs(flux[j] - m);
    dev /= cnt;
    if (v < m + k1 * dev + floor * 0.5) continue;
    // local maximum within the gap
    let isMax = true;
    for (let j = Math.max(0, i - gap); j <= Math.min(n - 1, i + gap); j++) if (flux[j] > v || (flux[j] === v && j < i)) { isMax = false; break; }
    if (isMax) peaks.push(i);
  }
  // refine each onset to the start of the energy rise
  const ew = Math.max(4, Math.round(0.0005 * sr));
  const out: number[] = [];
  for (let q = 0; q < peaks.length; q++) {
    const c = peaks[q] * hop;
    // the event lies within the frame that flagged it (+-2 hops), and not past the neighbours
    let a = Math.max(0, c - 2 * hop), z = Math.min(x.length, c + 2 * hop);
    if (q > 0) a = Math.max(a, Math.round((peaks[q - 1] * hop + c) / 2));
    if (q < peaks.length - 1) z = Math.min(z, Math.round((peaks[q + 1] * hop + c) / 2));
    if (z - a < 2 * ew) { out.push(c); continue; }
    // short-time energy
    const en: number[] = [];
    for (let i = a; i + ew <= z; i += 2) {
      let s = 0;
      for (let j = i; j < i + ew; j++) s += x[j] * x[j];
      en.push(s / ew);
    }
    let emax = 0, imax = 0;
    for (let i = 0; i < en.length; i++) if (en[i] > emax) { emax = en[i]; imax = i; }
    let emin = emax, imin = 0;
    for (let i = 0; i <= imax; i++) if (en[i] < emin) { emin = en[i]; imin = i; }
    // a real onset has its energy rise inside the window (an abrupt end of
    // the sample or a timbre change without a level rise is not one)
    if (emax < 1.4 * emin || emax < 1e-10) continue;
    const thr = emin + (emax - emin) * 0.1;
    let on = imax;
    for (let i = imin; i <= imax; i++) if (en[i] >= thr) { on = i; break; }
    out.push(Math.min(z - 1, a + on * 2 + ew - 2));
  }
  // dedupe after refinement
  const res: number[] = [];
  const minS = Math.round((opt.minGap ?? 0.045) * sr * 0.5);
  const tailCut = x.length - Math.round(0.02 * sr);
  for (const p of out.sort((p, q) => p - q)) if ((!res.length || p - res[res.length - 1] >= minS) && p < tailCut) res.push(p);
  return res;
}

/** Tempo (BPM) of an onset envelope; `durSec` lets loop lengths that fit whole beats win. */
export function estimateTempo(env: OnsetEnvelope, sr: number, durSec = 0): number {
  const { flux, hop } = env;
  const n = flux.length;
  const fps = sr / hop;
  if (n < 8) return 120;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= n;
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = Math.max(0, flux[i] - mean);
  const lagMin = Math.max(1, Math.floor((60 / 220) * fps));
  const lagMax = Math.min(n - 1, Math.ceil((60 / 50) * fps));
  const ac = new Float64Array(lagMax + 2);
  for (let L = 1; L <= lagMax + 1 && L < n; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += o[i] * o[i + L];
    ac[L] = s / (n - L);
  }
  let best = -1, bestL = 0;
  for (let L = lagMin; L <= lagMax; L++) {
    const bpm = (60 * fps) / L;
    if (bpm < 60 || bpm > 200) continue;
    let s = ac[L];
    if (2 * L <= lagMax + 1) s += 0.5 * ac[2 * L];
    if (Math.round(L / 2) >= 1) s += 0.25 * ac[Math.round(L / 2)];
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    s *= w;
    if (s > best) { best = s; bestL = L; }
  }
  if (!bestL) return 120;
  // parabolic refinement
  let lag = bestL;
  if (bestL > 1 && bestL < lagMax) {
    const a = ac[bestL - 1], b = ac[bestL], c = ac[bestL + 1];
    const den = a - 2 * b + c;
    if (den < 0) lag = bestL + (0.5 * (a - c)) / den;
  }
  let bpm = (60 * fps) / lag;
  // loops: snap to a whole power-of-two number of beats when close (3 %)
  if (durSec > 0) {
    const beats = (durSec * bpm) / 60;
    for (const b of [2, 4, 8, 16, 32, 64]) {
      if (Math.abs(beats - b) / b < 0.03) { bpm = (b * 60) / durSec; break; }
    }
  }
  return Math.round(bpm * 100) / 100;
}

/** Beat positions (source samples) for a tempo: the phase with the most onset strength. */
export function beatPositions(env: OnsetEnvelope, sr: number, bpm: number, length: number): number[] {
  const { flux, hop } = env;
  const fps = sr / hop;
  const per = (60 / bpm) * fps;
  if (!(per > 1)) return [];
  let bestPh = 0, best = -1;
  const steps = Math.max(1, Math.round(per));
  for (let s = 0; s < steps; s++) {
    const ph = (s / steps) * per;
    let sum = 0;
    for (let t = ph; t < flux.length; t += per) {
      const i = Math.round(t);
      sum += flux[i] ?? 0;
    }
    if (sum > best) { best = sum; bestPh = ph; }
  }
  // the flux of an onset peaks about a quarter window (one hop) before it
  const out: number[] = [];
  const perS = (60 / bpm) * sr;
  let t0 = bestPh * hop + hop;
  while (t0 - perS > -0.1 * perS) t0 -= perS;
  for (let t = Math.max(0, t0); t < length; t += perS) out.push(Math.round(t));
  return out;
}
