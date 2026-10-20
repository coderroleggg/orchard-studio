// Edison's sample edit window and zoom / scroll bar: waveform (or spectrum)
// on FL's blue-grey gradient with a tempo grid, the selection (red), regions
// and markers (orange tags), loop points (red), the noise threshold band
// (green), envelopes, and the play / record heads on an animated overlay.

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { getFFT } from '../../../../engine/dsp/fft';
import type { EdEnvPoint, EdMarker, EdState } from '../../../../model/fx/plugins/edison';
import { PEAK_BLOCK, type BlockPeaks } from './audio';
import type { Chans } from './ops';

export interface WaveSource {
  ch: Chans;
  len: number;
  offset: number;
  peaks?: BlockPeaks;
  key: string;
}

export interface GridInfo { tempo: number; bpb: number }

export const COL = {
  bgTop: '#3b4252',
  bgMid: '#2c3344',
  bgBot: '#3c4353',
  flat: '#343b4b',
  wave: '#d2d9e9',
  waveR: '#bfc8de',
  waveSel: '#ffdeef',
  sel: 'rgba(150, 38, 78, 0.55)',
  band: 'rgba(52, 150, 112, 0.28)',
  bandWave: '#ceede5',
  marker: '#ffb871',
  markerText: '#f5a462',
  loop: '#f0515c',
  head: '#eef4ff',
  rec: '#ff4a4a',
};

export const ENV_COLORS = ['#d2d9e9', '#ec5fd0', '#f4a23c', '#8bdc4e', '#5aa8f2'];
export const ENV_KEYS = ['', 'pan', 'vol', 'sep', 'ap'] as const;

const dprOf = () => Math.min(3, (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1) * 1.5);

function fitCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = dprOf();
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

/** Min / max of channel `ci` over [f0, f1) frames of a source (block peaks when coarse). */
function minMax(s: WaveSource, ci: number, f0: number, f1: number): [number, number] {
  const c = s.ch[Math.min(ci, s.ch.length - 1)];
  let a = Math.max(0, Math.floor(f0 - s.offset)), b = Math.min(s.len, Math.ceil(f1 - s.offset));
  if (b <= a) {
    if (a >= s.len || b < 0) return [1, -1];
    b = a + 1;
  }
  let lo = Infinity, hi = -Infinity;
  if (s.peaks && b - a > PEAK_BLOCK * 3) {
    const mm = s.peaks.mm[Math.min(ci, s.peaks.mm.length - 1)];
    const b0 = Math.ceil(a / PEAK_BLOCK), b1 = Math.floor(b / PEAK_BLOCK);
    for (let i = a; i < b0 * PEAK_BLOCK; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let k = b0; k < b1; k++) { const l = mm[k * 2], h = mm[k * 2 + 1]; if (l < lo) lo = l; if (h > hi) hi = h; }
    for (let i = b1 * PEAK_BLOCK; i < b; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  } else {
    for (let i = a; i < b; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  return lo === Infinity ? [1, -1] : [lo, hi];
}

function sampleAt(sources: WaveSource[], ci: number, f: number): number | null {
  for (const s of sources) {
    const i = f - s.offset;
    if (i >= 0 && i < s.len) return s.ch[Math.min(ci, s.ch.length - 1)][i];
  }
  return null;
}

// --------------------------------------------------------------- spectrum
const GRADIENTS: [number, string][][] = [
  // 12 dB steps, Charcoal, Furnace, Deeper furnace, Glacier, Temperature, The Matrix
  [[0, '#000000'], [0.33, '#404040'], [0.34, '#606060'], [0.66, '#a0a0a0'], [0.67, '#c8c8c8'], [1, '#ffffff']],
  [[0, '#0b0b0e'], [0.5, '#5c5c66'], [1, '#f2f2f6']],
  [[0, '#05020a'], [0.25, '#3a0d3a'], [0.5, '#b1232d'], [0.72, '#ef8a2a'], [0.88, '#ffd977'], [1, '#ffffff']],
  [[0, '#000000'], [0.35, '#2a0610'], [0.6, '#9a1b1b'], [0.8, '#f07a1a'], [1, '#fff0b0']],
  [[0, '#02060c'], [0.35, '#0e3156'], [0.65, '#3d8fc4'], [0.85, '#a6dcf4'], [1, '#ffffff']],
  [[0, '#000040'], [0.25, '#0040ff'], [0.5, '#00ff80'], [0.75, '#ffe000'], [1, '#ff2000']],
  [[0, '#000000'], [0.4, '#003a10'], [0.75, '#20c040'], [1, '#c8ffc8']],
];

function lut(idx: number): Uint8ClampedArray {
  const stops = GRADIENTS[Math.min(GRADIENTS.length - 1, Math.max(0, idx))];
  const o = new Uint8ClampedArray(256 * 3);
  const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / Math.max(1e-6, t1 - t0)));
    const a = hex(c0), b = hex(c1);
    for (let j = 0; j < 3; j++) o[i * 3 + j] = a[j] + (b[j] - a[j]) * u;
  }
  return o;
}

let specCache: { key: string; canvas: HTMLCanvasElement } | null = null;

function spectrumImage(sources: WaveSource[], sr: number, start: number, end: number, W: number, H: number, natural: boolean, gradient: number): HTMLCanvasElement | null {
  const key = `${sources.map((s) => s.key + ':' + s.len).join(',')}|${start}|${end}|${W}|${H}|${natural}|${gradient}`;
  if (specCache?.key === key) return specCache.canvas;
  const cw = Math.max(1, Math.round(W)), chh = Math.max(1, Math.round(H));
  const N = 1024;
  const fft = getFFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const colors = lut(gradient);
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = chh;
  const g = cv.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(cw, chh);
  const fpp = (end - start) / cw;
  const rowBin = new Float64Array(chh);
  for (let y = 0; y < chh; y++) {
    const t = 1 - (y + 0.5) / chh;
    const f = natural ? 20 * Math.pow(sr / 2 / 20, t) : t * sr / 2;
    rowBin[y] = Math.min(N / 2 - 1, (f / sr) * N);
  }
  const mag = new Float64Array(N / 2);
  for (let x = 0; x < cw; x++) {
    const c = start + (x + 0.5) * fpp;
    let any = false;
    for (let i = 0; i < N; i++) {
      const f = Math.round(c - N / 2 + i);
      let v = 0;
      for (const s of sources) {
        const k = f - s.offset;
        if (k >= 0 && k < s.len) { for (const ch of s.ch) v += ch[k]; v /= s.ch.length; any = true; break; }
      }
      re[i] = v * win[i];
      im[i] = 0;
    }
    if (any) {
      fft.transform(re, im);
      for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / (N / 4);
    } else mag.fill(0);
    for (let y = 0; y < chh; y++) {
      const b = rowBin[y], k0 = Math.floor(b), t = b - k0;
      const m = mag[k0] * (1 - t) + mag[Math.min(N / 2 - 1, k0 + 1)] * t;
      const db = m > 1e-9 ? 20 * Math.log10(m) : -120;
      const lv = Math.min(255, Math.max(0, Math.round(((db + 96) / 96) * 255)));
      const o = (y * cw + x) * 4;
      img.data[o] = colors[lv * 3];
      img.data[o + 1] = colors[lv * 3 + 1];
      img.data[o + 2] = colors[lv * 3 + 2];
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  specCache = { key, canvas: cv };
  return cv;
}

// ------------------------------------------------------------------- drawing
export interface DrawOpts {
  sources: WaveSource[];
  sr: number;
  view: [number, number];
  sel: [number, number] | null;
  markers: EdMarker[];
  loopPts: [number, number] | null;
  st: EdState;
  grid: GridInfo | null;
  nch: number;
}

function niceSeconds(spp: number): number {
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const s of steps) if (s / spp >= 60) return s;
  return 600;
}

export function drawWave(g: CanvasRenderingContext2D, W: number, H: number, o: DrawOpts): void {
  const { st, sr } = o;
  const [v0, v1] = o.view;
  const span = Math.max(1e-9, v1 - v0);
  const fx = (f: number) => ((f - v0) / span) * W;
  // background
  if (st.gradient) {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, COL.bgTop);
    bg.addColorStop(0.5, COL.bgMid);
    bg.addColorStop(1, COL.bgBot);
    g.fillStyle = bg;
  } else g.fillStyle = COL.flat;
  g.fillRect(0, 0, W, H);

  // grid (tempo) and ruler labels
  g.font = '9px var(--font-ui)';
  g.textBaseline = 'alphabetic';
  if (o.grid && o.grid.tempo > 0) {
    const fpb = (sr * 60) / o.grid.tempo;
    const pxb = fpb / span * W;
    const bpb = Math.max(1, o.grid.bpb);
    const sub = pxb / 4 >= 7 ? 4 : pxb / 2 >= 7 ? 2 : 1;
    const step = fpb / sub;
    const k0 = Math.floor(v0 / step), k1 = Math.ceil(v1 / step);
    const barEvery = sub * bpb;
    const showBeats = pxb >= 5;
    const labelEvery = Math.max(1, Math.ceil(36 / (pxb * bpb)));
    if (k1 - k0 < 4000) {
      for (let k = Math.max(0, k0); k <= k1; k++) {
        const x = Math.round(fx(k * step)) + 0.5;
        const isBar = k % barEvery === 0, isBeat = k % sub === 0;
        if (!isBar && !showBeats) continue;
        g.fillStyle = isBar ? 'rgba(10, 14, 24, 0.55)' : isBeat ? 'rgba(10, 14, 24, 0.3)' : 'rgba(10, 14, 24, 0.14)';
        g.fillRect(x - 0.5, 0, 1, H);
        const bar = k / barEvery;
        if (isBar && bar % labelEvery === 0) {
          g.fillStyle = 'rgba(160, 172, 196, 0.45)';
          g.fillText(String(bar + 1), x + 3, H - 3);
        }
      }
    }
  } else {
    const sp = niceSeconds(span / sr / W);
    const step = sp * sr;
    for (let k = Math.max(0, Math.floor(v0 / step)); k * step <= v1; k++) {
      const x = Math.round(fx(k * step)) + 0.5;
      g.fillStyle = 'rgba(10, 14, 24, 0.35)';
      g.fillRect(x - 0.5, 0, 1, H);
      g.fillStyle = 'rgba(160, 172, 196, 0.45)';
      const t = k * sp;
      g.fillText(sp >= 1 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${t.toFixed(sp >= 0.1 ? 1 : 3)}s`, x + 3, H - 3);
    }
  }
  // centre line
  g.fillStyle = 'rgba(10, 14, 24, 0.35)';
  g.fillRect(0, Math.floor(H / 2), W, 1);

  // selection
  if (o.sel) {
    const x0 = fx(o.sel[0]), x1 = fx(o.sel[1]);
    if (x1 > 0 && x0 < W) {
      g.fillStyle = COL.sel;
      g.fillRect(Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), H);
    }
  }

  const amp = H / 2 - 2;
  const cy = H / 2;
  const thr = st.threshold;
  const bandY0 = cy - thr * amp, bandY1 = cy + thr * amp;
  if (st.noiseView) {
    g.fillStyle = COL.band;
    g.fillRect(0, bandY0, W, Math.max(1, bandY1 - bandY0));
  }

  // spectrum
  const total = o.sources.reduce((m, s) => Math.max(m, s.offset + s.len), 0);
  if (st.spec && total > 0) {
    const img = spectrumImage(o.sources, sr, v0, v1, Math.min(W, 1400), H, st.natural, st.specGrad);
    if (img) {
      g.save();
      g.globalAlpha = 1;
      g.imageSmoothingEnabled = true;
      g.drawImage(img, 0, 0, W, H);
      g.restore();
      if (o.sel) {
        const x0 = fx(o.sel[0]), x1 = fx(o.sel[1]);
        g.fillStyle = 'rgba(150, 38, 78, 0.35)';
        g.fillRect(Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), H);
      }
    }
  }

  // waveform
  if (total > 0 && (!st.spec || st.dual)) {
    const chans: number[] = st.chanView === 2 ? [0] : st.chanView === 3 ? [Math.min(1, o.nch - 1)] : st.chanView === 0 ? [-1] : Array.from({ length: Math.min(2, o.nch) }, (_, i) => i);
    const fpp = span / W;
    const selA = o.sel ? fx(o.sel[0]) : Infinity, selB = o.sel ? fx(o.sel[1]) : -Infinity;
    if (st.spec && st.dual) g.globalAlpha = 0.55;
    if (fpp < 1.5) {
      // zoomed in: sample curve
      for (let n = chans.length - 1; n >= 0; n--) {
        const ci = chans[n];
        g.strokeStyle = n === 1 ? COL.waveR : COL.wave;
        g.lineWidth = 1.2;
        g.beginPath();
        let started = false;
        for (let f = Math.max(0, Math.floor(v0) - 1); f <= Math.ceil(v1) + 1; f++) {
          let v: number | null;
          if (ci < 0) { const a = sampleAt(o.sources, 0, f), b = sampleAt(o.sources, 1, f); v = a === null ? null : b === null ? a : (a + b) / 2; }
          else v = sampleAt(o.sources, ci, f);
          if (v === null) { started = false; continue; }
          const x = fx(f), y = cy - v * amp;
          if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
        }
        g.stroke();
        if (fpp < 0.12) {
          g.fillStyle = n === 1 ? COL.waveR : COL.wave;
          for (let f = Math.max(0, Math.floor(v0)); f <= Math.ceil(v1); f++) {
            const v = ci < 0 ? sampleAt(o.sources, 0, f) : sampleAt(o.sources, ci, f);
            if (v === null) continue;
            g.fillRect(fx(f) - 1.5, cy - v * amp - 1.5, 3, 3);
          }
        }
      }
    } else {
      // one filled outline per channel (min / max per pixel column), then the
      // selected part and the threshold band repainted in their colours
      for (let n = chans.length - 1; n >= 0; n--) {
        const ci = chans[n];
        const path = new Path2D();
        let open = -1;
        const tops: number[] = [], bots: number[] = [];
        const close = () => {
          const n2 = tops.length;
          path.moveTo(open, tops[0]);
          for (let k = 0; k < n2; k++) path.lineTo(open + k + 0.5, tops[k]);
          path.lineTo(open + n2, tops[n2 - 1]);
          path.lineTo(open + n2, bots[n2 - 1]);
          for (let k = n2 - 1; k >= 0; k--) path.lineTo(open + k + 0.5, bots[k]);
          path.lineTo(open, bots[0]);
          path.closePath();
          open = -1;
          tops.length = 0;
          bots.length = 0;
        };
        for (let x = 0; x < W; x++) {
          const f0 = v0 + x * fpp, f1 = f0 + fpp;
          let lo = Infinity, hi = -Infinity;
          for (const s of o.sources) {
            if (f1 <= s.offset || f0 >= s.offset + s.len) continue;
            if (ci < 0) {
              const [l0, h0] = minMax(s, 0, f0, f1), [l1, h1] = minMax(s, Math.min(1, s.ch.length - 1), f0, f1);
              lo = Math.min(lo, (l0 + l1) / 2); hi = Math.max(hi, (h0 + h1) / 2);
            } else {
              const [l, h] = minMax(s, ci, f0, f1);
              if (l <= h) { lo = Math.min(lo, l); hi = Math.max(hi, h); }
            }
          }
          if (lo > hi) { if (open >= 0) close(); continue; }
          let yTop = cy - hi * amp, yBot = cy - lo * amp;
          if (yBot - yTop < 1) { const m = (yTop + yBot) / 2; yTop = m - 0.5; yBot = m + 0.5; }
          if (open < 0) open = x;
          tops.push(yTop);
          bots.push(yBot);
        }
        if (open >= 0) close();
        g.fillStyle = n === 1 ? COL.waveR : COL.wave;
        g.fill(path);
        if (o.sel && selB > 0 && selA < W) {
          g.save();
          g.beginPath();
          g.rect(Math.max(0, selA), 0, Math.min(W, selB) - Math.max(0, selA), H);
          g.clip();
          g.fillStyle = COL.waveSel;
          g.fill(path);
          g.restore();
        }
        if (st.noiseView) {
          g.save();
          g.beginPath();
          g.rect(0, bandY0, W, Math.max(1, bandY1 - bandY0));
          g.clip();
          g.fillStyle = COL.bandWave;
          g.fill(path);
          g.restore();
        }
      }
    }
    g.globalAlpha = 1;
  }

  // loop points
  if (o.loopPts && st.loopView) {
    for (const [i, f] of o.loopPts.entries()) {
      const x = Math.round(fx(f)) + 0.5;
      if (x < -20 || x > W + 20) continue;
      g.fillStyle = COL.loop;
      g.fillRect(x - 0.5, 0, 1, H);
      g.beginPath();
      if (i === 0) { g.moveTo(x, 0); g.lineTo(x + 7, 0); g.lineTo(x, 7); }
      else { g.moveTo(x, 0); g.lineTo(x - 7, 0); g.lineTo(x, 7); }
      g.fill();
    }
  }

  // regions / markers
  if (st.regionsView) {
    g.font = "600 10.5px 'Avenir Next Condensed', 'Arial Narrow', 'Roboto Condensed', sans-serif";
    g.textBaseline = 'top';
    for (const m of o.markers) {
      const x = Math.round(fx(m.pos)) + 0.5;
      if (m.end !== undefined) {
        const xe = Math.round(fx(m.end)) + 0.5;
        if (xe >= 0 && x <= W) {
          g.fillStyle = 'rgba(255, 184, 113, 0.07)';
          g.fillRect(Math.max(0, x), 0, Math.min(W, xe) - Math.max(0, x), H);
        }
        if (xe >= -2 && xe <= W + 2) {
          g.fillStyle = 'rgba(255, 184, 113, 0.55)';
          g.fillRect(xe - 0.5, 0, 1, H);
          g.fillRect(xe - 4, 0, 3.5, 9);
        }
      }
      if (x < -200 || x > W + 2) continue;
      g.fillStyle = COL.marker;
      g.fillRect(x - 0.5, 0, 1, H);
      g.fillRect(x, 0, 4, 11);
      if (m.name) {
        g.fillStyle = COL.markerText;
        g.fillText(m.name, x + 7, 2);
      }
    }
  }

  // envelope
  if (st.envSel > 0) {
    const key = ENV_KEYS[st.envSel] as 'pan' | 'vol' | 'sep' | 'ap';
    const pts = st.envs[key];
    const color = ENV_COLORS[st.envSel];
    const yOf = (v: number) => 4 + (1 - v) * (H - 8);
    g.strokeStyle = color;
    g.lineWidth = 1.4;
    g.beginPath();
    const def = 0.5;
    if (!pts.length) { g.moveTo(0, yOf(key === 'ap' ? 1 : def)); g.lineTo(W, yOf(key === 'ap' ? 1 : def)); }
    else {
      g.moveTo(0, yOf(pts[0][1]));
      for (const p of pts) g.lineTo(fx(p[0]), yOf(p[1]));
      g.lineTo(W, yOf(pts[pts.length - 1][1]));
    }
    g.stroke();
    g.fillStyle = color;
    for (const p of pts) { const x = fx(p[0]); if (x >= -4 && x <= W + 4) { g.beginPath(); g.arc(x, yOf(p[1]), 3.2, 0, Math.PI * 2); g.fill(); } }
  }
}

// -------------------------------------------------------------- component
export interface WaveViewProps {
  x: number;
  y: number;
  w: number;
  h: number;
  draw: DrawOpts;
  /** Live heads: returns [playhead frame | null, playing, recording cursor frame | null]. */
  heads: () => [number | null, boolean, number | null];
  frozen: boolean;
  onDown: (e: React.PointerEvent<HTMLCanvasElement>, frame: number, px: number, py: number) => void;
  onMove: (e: React.PointerEvent<HTMLCanvasElement>, frame: number, px: number, py: number) => void;
  onUp: (e: React.PointerEvent<HTMLCanvasElement>, frame: number, px: number, py: number) => void;
  onWheel: (e: React.WheelEvent<HTMLCanvasElement>, frame: number) => void;
  onDouble: (e: React.MouseEvent<HTMLCanvasElement>, frame: number, px: number, py: number) => void;
  onHover?: (frame: number, py: number) => void;
  cursor?: string;
}

export function WaveView(p: WaveViewProps) {
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(p.draw);
  drawRef.current = p.draw;
  const headsRef = useRef(p.heads);
  headsRef.current = p.heads;

  useLayoutEffect(() => {
    const c = base.current;
    if (!c) return;
    const g = fitCanvas(c, p.w, p.h);
    if (g) drawWave(g, p.w, p.h, p.draw);
  });

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const c = over.current;
      if (!c) return;
      const g = fitCanvas(c, p.w, p.h);
      if (!g) return;
      g.clearRect(0, 0, p.w, p.h);
      const [v0, v1] = drawRef.current.view;
      const span = Math.max(1e-9, v1 - v0);
      const [ph, playing, rc] = headsRef.current();
      if (ph !== null) {
        const x = Math.round(((ph - v0) / span) * p.w) + 0.5;
        if (x >= -1 && x <= p.w + 1) {
          g.fillStyle = playing ? COL.head : 'rgba(238, 244, 255, 0.45)';
          g.fillRect(x - 0.5, 0, 1, p.h);
          g.beginPath();
          g.moveTo(x - 4, 0); g.lineTo(x + 4, 0); g.lineTo(x, 5);
          g.fill();
        }
      }
      if (rc !== null) {
        const x = Math.round(((rc - v0) / span) * p.w) + 0.5;
        if (x >= -1 && x <= p.w + 1) {
          g.fillStyle = COL.rec;
          g.fillRect(x - 1, 0, 2, p.h);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [p.w, p.h]);

  const frameAt = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = r.width / p.w, sy = r.height / p.h;
    const px = (e.clientX - r.left) / sx, py = (e.clientY - r.top) / sy;
    const [v0, v1] = drawRef.current.view;
    return { f: v0 + (px / p.w) * (v1 - v0), px, py };
  };

  const style: CSSProperties = { position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h };
  return (
    <div style={style} className="ed-wave">
      <canvas ref={base} style={{ position: 'absolute', inset: 0, width: p.w, height: p.h }} />
      <canvas
        ref={over}
        style={{ position: 'absolute', inset: 0, width: p.w, height: p.h, cursor: p.frozen ? 'crosshair' : (p.cursor ?? 'default'), touchAction: 'none' }}
        onPointerDown={(e) => { const a = frameAt(e); p.onDown(e, a.f, a.px, a.py); }}
        onPointerMove={(e) => { const a = frameAt(e); p.onMove(e, a.f, a.px, a.py); p.onHover?.(a.f, a.py); }}
        onPointerUp={(e) => { const a = frameAt(e); p.onUp(e, a.f, a.px, a.py); }}
        onPointerCancel={(e) => { const a = frameAt(e); p.onUp(e, a.f, a.px, a.py); }}
        onWheel={(e) => { const a = frameAt(e); p.onWheel(e, a.f); }}
        onDoubleClick={(e) => { const a = frameAt(e); p.onDouble(e, a.f, a.px, a.py); }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}

// ------------------------------------------------------------ zoom / scroll bar
export interface OverviewProps {
  x: number;
  y: number;
  w: number;
  h: number;
  sources: WaveSource[];
  total: number;
  view: [number, number];
  sel: [number, number] | null;
  onView: (start: number, end: number) => void;
  onStep: (dir: -1 | 1) => void;
}

export function Overview(p: OverviewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: 'move' | 'l' | 'r' | 'jump'; f0: number; v: [number, number] } | null>(null);
  const AR = 14; // left arrow button
  const tw = p.w - AR;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = fitCanvas(c, tw, p.h);
    if (!g) return;
    g.fillStyle = '#232a39';
    g.fillRect(0, 0, tw, p.h);
    const total = Math.max(1, p.total);
    const fx = (f: number) => (f / total) * tw;
    // visible window
    const x0 = fx(p.view[0]), x1 = fx(p.view[1]);
    g.fillStyle = '#3a4152';
    g.fillRect(x0, 1, Math.max(3, x1 - x0), p.h - 2);
    if (p.sel) {
      g.fillStyle = 'rgba(150, 38, 78, 0.6)';
      g.fillRect(fx(p.sel[0]), 1, Math.max(1, fx(p.sel[1]) - fx(p.sel[0])), p.h - 2);
    }
    // waveform overview
    const cy = p.h / 2, amp = p.h / 2 - 3;
    const fpp = total / tw;
    g.fillStyle = '#aeb6c8';
    if (p.total > 0) {
      for (let x = 0; x < tw; x++) {
        const f0 = x * fpp, f1 = f0 + fpp;
        let hi = 0;
        for (const s of p.sources) {
          if (f1 <= s.offset || f0 >= s.offset + s.len) continue;
          for (let ci = 0; ci < Math.min(2, s.ch.length); ci++) {
            const [l, h] = minMax(s, ci, f0, f1);
            if (l <= h) hi = Math.max(hi, Math.abs(l), Math.abs(h));
          }
        }
        if (hi > 0) g.fillRect(x, cy - hi * amp, 1, Math.max(1, hi * 2 * amp));
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.1)';
    g.fillRect(x0, 1, 1, p.h - 2);
    g.fillRect(Math.max(x0, x1 - 1), 1, 1, p.h - 2);
  });

  const fAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * tw;
    return { f: (px / tw) * Math.max(1, p.total), px };
  };
  return (
    <div className="ed-overview" style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h }}>
      <div className="ed-ov-arrow" style={{ width: AR, height: p.h }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.onStep(-1); } }}>
        <svg width="10" height="10" viewBox="0 0 16 16"><path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
      </div>
      <canvas ref={ref} style={{ position: 'absolute', left: AR, top: 0, width: tw, height: p.h, touchAction: 'none' }}
        onPointerDown={(e) => {
          if (e.button !== 0 || p.total <= 0) return;
          e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const { f, px } = fAt(e);
          const total = Math.max(1, p.total);
          const x0 = (p.view[0] / total) * tw, x1 = (p.view[1] / total) * tw;
          let mode: 'move' | 'l' | 'r' | 'jump' = 'jump';
          if (Math.abs(px - x0) <= 4) mode = 'l';
          else if (Math.abs(px - x1) <= 4) mode = 'r';
          else if (px > x0 && px < x1) mode = 'move';
          if (mode === 'jump') {
            const half = (p.view[1] - p.view[0]) / 2;
            const s = Math.min(Math.max(0, f - half), total - 2 * half);
            p.onView(s, s + 2 * half);
            drag.current = { mode: 'move', f0: f, v: [s, s + 2 * half] };
          } else drag.current = { mode, f0: f, v: [...p.view] as [number, number] };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const { f } = fAt(e);
          const total = Math.max(1, p.total);
          const df = f - d.f0;
          const minSpan = 16;
          if (d.mode === 'move') {
            const span = d.v[1] - d.v[0];
            const s = Math.min(Math.max(0, d.v[0] + df), total - span);
            p.onView(s, s + span);
          } else if (d.mode === 'l') p.onView(Math.min(Math.max(0, d.v[0] + df), d.v[1] - minSpan), d.v[1]);
          else if (d.mode === 'r') p.onView(d.v[0], Math.max(Math.min(total, d.v[1] + df), d.v[0] + minSpan));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}

export function envAt(pts: EdEnvPoint[], f: number, def: number): number {
  if (!pts.length) return def;
  if (f <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (f <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return x1 > x0 ? y0 + ((f - x0) / (x1 - x0)) * (y1 - y0) : y1;
    }
  }
  return pts[pts.length - 1][1];
}
