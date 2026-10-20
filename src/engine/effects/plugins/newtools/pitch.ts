// Pitch tracking for Newtone: YIN (de Cheveigne & Kawahara 2002) on an
// anti-alias decimated copy (~11 kHz) for speed, with the period refined on
// the full-rate signal by parabolic interpolation of the raw difference
// function (sub-cent accuracy on steady tones). Post-processing: voicing
// from periodicity and a level gate, octave-jump repair against the
// neighbourhood median, a 3-frame median and removal of voiced blips.

import { decimate, median } from './util';

export interface PitchOptions {
  /** Frame hop in seconds (default 5 ms). */
  hopSec?: number;
  /** Lowest / highest detectable fundamental (Hz). */
  fmin?: number;
  fmax?: number;
  /** YIN absolute threshold on the cumulative-mean-normalised difference. */
  threshold?: number;
}

export interface PitchTrack {
  sr: number;
  /** Source samples per frame; frame k is centred on sample k * hop. */
  hop: number;
  /** Fundamental (Hz) per frame, 0 = unvoiced. */
  f0: Float32Array;
  /** Periodicity 0..1 (1 - normalised difference at the chosen lag). */
  conf: Float32Array;
  /** Frame RMS (linear). */
  rms: Float32Array;
}

interface FrameEstimate { period: number; conf: number }

/**
 * Period (in samples of `x`) of the frame starting at `start`, or 0. YIN on
 * `x` with window `w` over lags tauMin..tauMax.
 */
function yinFrame(x: Float32Array, start: number, w: number, tauMin: number, tauMax: number, thr: number, d: Float64Array, cm: Float64Array): FrameEstimate {
  const n = x.length;
  let run = 0;
  cm[0] = 1;
  let best = -1;
  let gmin = Infinity, gtau = -1;
  const inb = start >= 0 && start + w + tauMax + 1 < n;
  const diff = (tau: number): number => {
    let s = 0;
    if (inb) {
      for (let j = 0; j < w; j++) {
        const a = x[start + j] - x[start + j + tau];
        s += a * a;
      }
    } else {
      for (let j = 0; j < w; j++) {
        const i0 = start + j, i1 = i0 + tau;
        const a = (i0 >= 0 && i0 < n ? x[i0] : 0) - (i1 >= 0 && i1 < n ? x[i1] : 0);
        s += a * a;
      }
    }
    return s;
  };
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    d[tau] = diff(tau);
    run += d[tau];
    cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    if (tau < tauMin || tau > tauMax) continue;
    if (best < 0 && cm[tau] < thr) best = tau;
    if (best >= 0 && tau > best) {
      if (cm[tau] < cm[best]) best = tau;
      else break; // passed the dip's minimum
    }
    if (cm[tau] < gmin) { gmin = cm[tau]; gtau = tau; }
  }
  const tau = best >= 0 ? best : gtau;
  if (tau < 2) return { period: 0, conf: 0 };
  // a global minimum at the edge of the lag range is no period
  if (best < 0 && tau >= tauMax) return { period: 0, conf: 0 };
  // parabolic interpolation on the normalised difference (tau - 1 .. tau + 1 were computed)
  const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
  const den = a - 2 * b + c;
  let off = den > 1e-12 ? (0.5 * (a - c)) / den : 0;
  if (off > 0.5) off = 0.5; else if (off < -0.5) off = -0.5;
  return { period: tau + off, conf: Math.max(0, Math.min(1, 1 - b)) };
}

/** Refine a period estimate on the full-rate signal around `tc` (+-r samples). */
function refinePeriod(x: Float32Array, center: number, tc: number, r: number): number {
  const n = x.length;
  const lo = Math.max(2, Math.floor(tc) - r), hi = Math.ceil(tc) + r;
  const w = Math.max(Math.round(2 * tc), 256);
  const start = Math.round(center - (w + hi) / 2);
  const vals: number[] = [];
  for (let t = lo - 1; t <= hi + 1; t++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const i0 = start + j, i1 = i0 + t;
      const a = (i0 >= 0 && i0 < n ? x[i0] : 0) - (i1 >= 0 && i1 < n ? x[i1] : 0);
      s += a * a;
    }
    vals.push(s);
  }
  let bi = 1;
  for (let i = 1; i < vals.length - 1; i++) if (vals[i] < vals[bi]) bi = i;
  const a = vals[bi - 1], b = vals[bi], c = vals[bi + 1];
  const den = a - 2 * b + c;
  let off = den > 0 ? (0.5 * (a - c)) / den : 0;
  if (off > 0.5) off = 0.5; else if (off < -0.5) off = -0.5;
  return lo - 1 + bi + off;
}

/** Pitch track of a mono signal; yields progress 0..1 now and then. */
export function* pitchTrackGen(x: Float32Array, sr: number, opt: PitchOptions = {}): Generator<number, PitchTrack, void> {
  const hopSec = opt.hopSec ?? 0.005;
  const fmin = opt.fmin ?? 55, fmax = opt.fmax ?? 1500;
  const thr = opt.threshold ?? 0.15;
  const D = Math.max(1, Math.round(sr / 11025));
  const xd = decimate(x, D);
  const srd = sr / D;
  const tauMax = Math.ceil(srd / fmin) + 1;
  const tauMin = Math.max(2, Math.floor(srd / fmax));
  const W = Math.max(Math.round(0.03 * srd), 2 * tauMin + 8);
  const hop = Math.max(1, Math.round(sr * hopSec));
  const frames = Math.max(1, Math.floor(x.length / hop) + 1);
  const f0 = new Float32Array(frames), conf = new Float32Array(frames), rms = new Float32Array(frames);
  const d = new Float64Array(tauMax + 3), cm = new Float64Array(tauMax + 3);
  const rw = Math.max(hop, Math.round(0.015 * sr));
  // frame RMS first (for the gate and to skip silent frames)
  let maxRms = 0;
  for (let k = 0; k < frames; k++) {
    const c = k * hop;
    const a = Math.max(0, c - rw), z = Math.min(x.length, c + rw);
    let s = 0;
    for (let i = a; i < z; i++) s += x[i] * x[i];
    rms[k] = z > a ? Math.sqrt(s / (z - a)) : 0;
    if (rms[k] > maxRms) maxRms = rms[k];
  }
  const gate = Math.max(maxRms * Math.pow(10, -45 / 20), 3e-4);
  for (let k = 0; k < frames; k++) {
    if ((k & 255) === 255) yield k / frames;
    if (rms[k] < gate * 0.5) continue;
    const cd = (k * hop) / D;
    // centre the compared span (window + a typical lag) on the frame
    const start = Math.round(cd - (W + 0.25 * tauMax) / 2);
    const est = yinFrame(xd, start, W, tauMin, tauMax, thr, d, cm);
    if (est.period <= 0) continue;
    let per = est.period * D;
    if (D > 1) per = refinePeriod(x, k * hop, per, D + 1);
    const hz = sr / per;
    if (hz < fmin * 0.95 || hz > fmax * 1.05 || !Number.isFinite(hz)) continue;
    f0[k] = hz;
    conf[k] = est.conf;
  }
  // voicing
  for (let k = 0; k < frames; k++) if (f0[k] > 0 && (conf[k] < 0.72 || rms[k] < gate)) f0[k] = 0;
  repairOctaves(f0);
  medianSmooth(f0);
  dropBlips(f0, 4);
  return { sr, hop, f0, conf, rms };
}

/** Fold isolated octave jumps toward the median of the voiced neighbourhood. */
function repairOctaves(f0: Float32Array): void {
  const n = f0.length;
  const lg = new Float32Array(n);
  for (let i = 0; i < n; i++) lg[i] = f0[i] > 0 ? Math.log2(f0[i]) : NaN;
  const out = Float32Array.from(f0);
  for (let i = 0; i < n; i++) {
    if (!(f0[i] > 0)) continue;
    const nb: number[] = [];
    for (let j = Math.max(0, i - 12); j <= Math.min(n - 1, i + 12); j++) if (j !== i && f0[j] > 0) nb.push(lg[j]);
    if (nb.length < 6) continue;
    const m = median(nb);
    const dlt = lg[i] - m;
    if (dlt > 0.8 && dlt < 1.2) out[i] = f0[i] / 2;
    else if (dlt < -0.8 && dlt > -1.2) out[i] = f0[i] * 2;
  }
  f0.set(out);
}

function medianSmooth(f0: Float32Array): void {
  const n = f0.length;
  const out = Float32Array.from(f0);
  for (let i = 1; i < n - 1; i++) {
    const a = f0[i - 1], b = f0[i], c = f0[i + 1];
    if (a > 0 && b > 0 && c > 0) out[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  f0.set(out);
}

function dropBlips(f0: Float32Array, minLen: number): void {
  const n = f0.length;
  let i = 0;
  while (i < n) {
    if (!(f0[i] > 0)) { i++; continue; }
    let j = i;
    while (j < n && f0[j] > 0) j++;
    if (j - i < minLen) f0.fill(0, i, j);
    i = j;
  }
}

/** Synchronous pitch track (tests, worker). */
export function pitchTrack(x: Float32Array, sr: number, opt: PitchOptions = {}): PitchTrack {
  const g = pitchTrackGen(x, sr, opt);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** Median voiced pitch (Hz) of a signal: a one-shot estimate for tests and tuning displays. */
export function estimatePitch(x: Float32Array, sr: number): number {
  const t = pitchTrack(x, sr);
  const v: number[] = [];
  for (const f of t.f0) if (f > 0) v.push(f);
  return v.length ? median(v) : 0;
}
