// Parametric EQ 2 spectrum analyzer (display only).
//
// The engine sends the last 4096 stereo frames of the monitored signal about
// 30 times a second. Successive blocks overlap, so only the new frames are
// appended to a longer history; that allows FFT sizes above 4096 for the
// higher "Frequency precision" settings. Each block is downmixed (Mid / Side /
// L / R), windowed and transformed; bins are mapped to pixel columns (peak per
// column, interpolated where columns are narrower than a bin), tilted by the
// pivot slope around 1 kHz and smoothed by the peak-fall or RMS ballistics.

import { getFFT } from '../../engine/dsp/fft';
import { freqHz, type PEQ2Options, type PEQ2Params } from '../../model/peq2';
import { host } from '../../store';
import type { Geom } from './peq2Draw';

const HIST = 16384; // frames of history (power of two, >= the largest FFT)
const FFT_SIZES = [2048, 4096, 8192, 16384]; // Frequency precision Low .. Highest
const FALL = [96, 48, 24, 12, 6]; // peak fall in dB/s per Time smoothing step (Fastest .. Slowest)
const TAU = [0.06, 0.15, 0.35, 0.8, 1.6]; // RMS averaging time constant (s) per step
const SILENT = -200;

export function analyzerVisible(p: PEQ2Params): boolean {
  return p.monitor !== 'off' && (p.opts.histogram || p.opts.heatmap);
}

function step(v: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.round(v) || 0));
}

/**
 * Number of new frames in `cur` relative to `prev` (both hold the latest
 * frames, oldest first): the shift s for which cur[i] == prev[i + s].
 */
function findShift(prev: Float32Array, cur: Float32Array, frames: number, hint: number): number {
  const test = (s: number): boolean => {
    const m = frames - s;
    if (m <= 0) return false;
    const probes = [0, 1, m >> 2, m >> 1, (3 * m) >> 2, m - 2, m - 1];
    for (const p of probes) {
      const i = p < 0 ? 0 : p >= m ? m - 1 : p;
      const a = 2 * i, b = 2 * (i + s);
      if (cur[a] !== prev[b] || cur[a + 1] !== prev[b + 1]) return false;
    }
    return true;
  };
  if (hint > 0 && hint < frames && test(hint)) return hint;
  for (let s = 1; s < frames; s++) if (test(s)) return s;
  return frames;
}

export class Analyzer {
  private hl = new Float32Array(HIST);
  private hr = new Float32Array(HIST);
  private wpos = 0;
  private filled = 0;
  private prev: Float32Array | null = null;
  private lastShift = 0;
  private n = 0;
  private re = new Float64Array(0);
  private im = new Float64Array(0);
  private win = new Float64Array(0);
  private spec = new Float32Array(0);
  private mapKey = '';
  private k0 = new Int32Array(0);
  private k1 = new Int32Array(0);
  private kf = new Float32Array(0);
  private oct = new Float32Array(0); // log2(column centre / 1 kHz)
  private inst = new Float32Array(0);
  private tmp = new Float32Array(0);
  private avg = new Float32Array(0);
  private heat = new Float32Array(0);
  private wasAverage = false;
  cols = 0;
  /** Displayed level per column (dB, pivot tilt included). */
  held = new Float32Array(0);
  lastTime = 0;
  hasData = false;

  reset(): void {
    this.filled = 0;
    this.prev = null;
    this.lastShift = 0;
    this.hasData = false;
    this.held.fill(SILENT);
    this.avg.fill(0);
  }

  /** New block from the engine: interleaved [L0, R0, L1, R1, ...]. */
  push(data: Float32Array, sr: number, o: PEQ2Options, cols: number, now: number): void {
    if (data.length < 4 || cols < 1) return;
    this.append(data);
    this.resize(cols);
    this.analyze(sr, o, now);
  }

  private resize(cols: number): void {
    if (cols === this.cols) return;
    this.cols = cols;
    this.held = new Float32Array(cols).fill(SILENT);
    this.avg = new Float32Array(cols);
    this.inst = new Float32Array(cols);
    this.tmp = new Float32Array(cols);
    this.heat = new Float32Array(cols);
    this.mapKey = '';
  }

  private append(data: Float32Array): void {
    const frames = data.length >> 1;
    const shift = this.prev && this.prev.length === data.length ? findShift(this.prev, data, frames, this.lastShift) : frames;
    for (let i = frames - shift; i < frames; i++) {
      this.hl[this.wpos] = data[2 * i];
      this.hr[this.wpos] = data[2 * i + 1];
      this.wpos = (this.wpos + 1) & (HIST - 1);
    }
    this.filled = Math.min(HIST, this.filled + shift);
    this.prev = data;
    this.lastShift = shift;
  }

  private buildMap(sr: number): void {
    const C = this.cols, N = this.n, half = N >> 1, nyq = sr / 2;
    this.k0 = new Int32Array(C);
    this.k1 = new Int32Array(C);
    this.kf = new Float32Array(C);
    this.oct = new Float32Array(C);
    for (let c = 0; c < C; c++) {
      const lo = freqHz(c / C), hi = freqHz((c + 1) / C), fc = freqHz((c + 0.5) / C);
      this.oct[c] = Math.log2(fc / 1000);
      if (lo >= nyq) {
        this.k0[c] = -1;
        this.k1[c] = -2;
        continue;
      }
      this.k0[c] = Math.max(1, Math.ceil((lo * N) / sr));
      this.k1[c] = Math.min(half, Math.floor((hi * N) / sr));
      this.kf[c] = Math.min(half - 1, (fc * N) / sr);
    }
  }

  private analyze(sr: number, o: PEQ2Options, now: number): void {
    const N = FFT_SIZES[step(o.freqPrecision, FFT_SIZES.length)];
    if (N !== this.n) {
      this.n = N;
      this.re = new Float64Array(N);
      this.im = new Float64Array(N);
      this.spec = new Float32Array((N >> 1) + 1);
      this.win = new Float64Array(N);
      for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // Hann
      this.mapKey = '';
    }
    const key = `${this.cols}:${N}:${sr}`;
    if (key !== this.mapKey) {
      this.buildMap(sr);
      this.mapKey = key;
    }

    // windowed downmix of the latest N frames
    const { re, im, win, hl, hr } = this;
    const avail = Math.min(this.filled, N);
    const start = (this.wpos - N + HIST) & (HIST - 1);
    const src = o.monitorInput;
    for (let i = 0; i < N; i++) {
      im[i] = 0;
      if (i < N - avail) {
        re[i] = 0;
        continue;
      }
      const j = (start + i) & (HIST - 1);
      const l = hl[j], r = hr[j];
      const v = src === 'side' ? l - r : src === 'left' ? l : src === 'right' ? r : (l + r) * 0.5;
      re[i] = v * win[i];
    }
    getFFT(N).transform(re, im);

    // amplitude spectrum in dBFS (a full-scale sine reads 0 dB: Hann sum = N / 2)
    const spec = this.spec, half = N >> 1, scale = 4 / N;
    for (let k = 0; k <= half; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
      spec[k] = m > 1e-10 ? 20 * Math.log10(m) : SILENT;
    }

    // bins -> columns
    const C = this.cols, inst = this.inst, pivot = o.pivot || 0;
    for (let c = 0; c < C; c++) {
      const a = this.k0[c], b = this.k1[c];
      if (a < 0) {
        inst[c] = SILENT;
        continue;
      }
      let v: number;
      if (b >= a) {
        v = spec[a];
        for (let k = a + 1; k <= b; k++) if (spec[k] > v) v = spec[k];
      } else {
        const kf = this.kf[c], k = Math.floor(kf), t = kf - k;
        v = spec[k] + (spec[k + 1] - spec[k]) * t;
      }
      inst[c] = v + pivot * this.oct[c];
    }
    if (!o.enhancedFreq) {
      // standard frequency lines are a little wider than the enhanced ones
      const t = this.tmp;
      t.set(inst);
      for (let c = 0; c < C; c++) {
        let v = t[c];
        if (c > 0 && t[c - 1] > v) v = t[c - 1];
        if (c < C - 1 && t[c + 1] > v) v = t[c + 1];
        inst[c] = v;
      }
    }

    // ballistics
    const dt = this.hasData ? Math.min(0.25, Math.max(0.005, (now - this.lastTime) / 1000)) : 1 / 30;
    const ts = step(o.timeSmoothing, FALL.length);
    const held = this.held;
    if (o.average) {
      const avg = this.avg;
      if (!this.wasAverage) for (let c = 0; c < C; c++) avg[c] = held[c] > SILENT + 1 ? Math.pow(10, held[c] / 10) : 0;
      const a = 1 - Math.exp(-dt / TAU[ts]);
      for (let c = 0; c < C; c++) {
        avg[c] += a * (Math.pow(10, inst[c] / 10) - avg[c]);
        held[c] = avg[c] > 1e-20 ? 10 * Math.log10(avg[c]) : SILENT;
      }
    } else {
      const fall = FALL[ts] * dt;
      for (let c = 0; c < C; c++) held[c] = Math.max(inst[c], held[c] - fall);
    }
    this.wasAverage = o.average;
    this.lastTime = now;
    this.hasData = true;
  }

  /** No new data (audio stopped): let the display fall. Returns true while anything is visible. */
  decay(dt: number, o: PEQ2Options): boolean {
    const fall = FALL[step(o.timeSmoothing, FALL.length)] * dt;
    const floor = (o.range || -120) - 6;
    let any = false;
    for (let c = 0; c < this.cols; c++) {
      if (this.held[c] <= floor) continue;
      this.held[c] -= fall;
      if (o.average) this.avg[c] = Math.pow(10, this.held[c] / 10);
      any = true;
    }
    return any;
  }

  /** Heatmap brightness 0..1 per column. */
  heatValues(o: PEQ2Options): Float32Array {
    const C = this.cols, out = this.heat, floor = o.range || -120;
    for (let c = 0; c < C; c++) out[c] = Math.min(1, Math.max(0, (this.held[c] - floor) / -floor));
    if (!o.heatmapHighPrecision) {
      // alternative algorithm: blur the lowest bands so their centres are easier to spot
      const t = this.tmp;
      t.set(out);
      const lim = C * 0.45;
      for (let c = 0; c < lim; c++) {
        const r = Math.round(3 * (1 - c / lim));
        if (r <= 0) continue;
        let sum = 0, wsum = 0;
        for (let j = -r; j <= r; j++) {
          const cc = c + j;
          if (cc < 0 || cc >= C) continue;
          const w = r + 1 - Math.abs(j);
          sum += t[cc] * w;
          wsum += w;
        }
        out[c] = sum / wsum;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- drawing
const HEAT_STEPS = 64;

function heatLut(alpha: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < HEAT_STEPS; i++) {
    const t = i / (HEAT_STEPS - 1);
    const r = Math.round(28 + 205 * t * t);
    const g = Math.round(70 + 172 * t);
    const b = Math.round(96 + 156 * Math.sqrt(t));
    out.push(`rgba(${r}, ${g}, ${b}, ${Math.min(1, (0.1 + 0.85 * t) * alpha).toFixed(3)})`);
  }
  return out;
}

const HEAT_STRONG = heatLut(1);
const HEAT_FAINT = heatLut(0.45);

export function drawAnalyzer(ctx: CanvasRenderingContext2D, g: Geom, an: Analyzer, o: PEQ2Options, show: boolean): void {
  ctx.clearRect(0, 0, g.w, g.h);
  if (!show || !an.hasData || an.cols === 0) return;
  const C = an.cols, cw = g.pw / C;
  const floor = o.range || -120;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.px, g.py, g.pw, g.ph);
  ctx.clip();

  if (o.heatmap) {
    // with the histogram on, the heatmap goes to the chosen position; alone it fills the graph
    const strip = o.histogram && o.heatmapPosition !== 'full';
    const hh = strip ? Math.max(6, Math.round(g.ph * 0.15)) : g.ph;
    const y0 = strip && o.heatmapPosition === 'bottom' ? g.py + g.ph - hh : g.py;
    const lut = o.histogram && !strip ? HEAT_FAINT : HEAT_STRONG;
    const v = an.heatValues(o);
    for (let c = 0; c < C; c++) {
      const t = v[c];
      if (t <= 0.02) continue;
      ctx.fillStyle = lut[Math.min(HEAT_STEPS - 1, Math.round(t * t * (HEAT_STEPS - 1)))];
      ctx.fillRect(g.px + c * cw, y0, cw + 0.5, hh);
    }
  }

  if (o.histogram) {
    const held = an.held;
    const top = g.py - 1, bottom = g.py + g.ph + 1;
    const yOf = (db: number) => Math.max(top, Math.min(bottom, g.py + g.ph - ((db - floor) / -floor) * g.ph));
    ctx.beginPath();
    ctx.moveTo(g.px, bottom);
    for (let c = 0; c < C; c++) ctx.lineTo(g.px + (c + 0.5) * cw, yOf(held[c]));
    ctx.lineTo(g.px + g.pw, bottom);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, g.py, 0, g.py + g.ph);
    grad.addColorStop(0, 'rgba(118, 172, 204, 0.42)');
    grad.addColorStop(1, 'rgba(118, 172, 204, 0.05)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    for (let c = 0; c < C; c++) {
      const x = g.px + (c + 0.5) * cw, y = yOf(held[c]);
      if (c === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(158, 206, 230, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

// ------------------------------------------------------------ watching
// The engine analyses one slot at a time. Open editors stack up; the most
// recently opened or focused one is watched.
const watchStack: string[] = [];

function applyWatch(): void {
  host.watchSpectrum(watchStack.length ? watchStack[watchStack.length - 1] : null);
}

export function watchAcquire(slotId: string): void {
  const i = watchStack.indexOf(slotId);
  if (i >= 0) watchStack.splice(i, 1);
  watchStack.push(slotId);
  applyWatch();
}

export function watchRelease(slotId: string): void {
  const i = watchStack.indexOf(slotId);
  if (i < 0) return;
  watchStack.splice(i, 1);
  applyWatch();
}

export function watchPrefer(slotId: string): void {
  const i = watchStack.indexOf(slotId);
  if (i < 0 || i === watchStack.length - 1) return;
  watchStack.splice(i, 1);
  watchStack.push(slotId);
  applyWatch();
}
