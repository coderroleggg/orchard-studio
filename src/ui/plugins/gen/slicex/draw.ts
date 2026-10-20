// Slicex editor drawing (canvas, no DOM): the deck's sample window (FL's Edison sample editor shared by
// Slicex: blue-grey gradient, tempo or time grid, red selection, white waveform, orange region markers
// with their name tabs, spectrum view) and the articulator's envelope display (FL's TMEnvEditor: grid,
// red curve, orange points, tension circles, D / L / S marker lines, LFO preview, velocity line).
// Colours as in Orchard's Edison editor and Envelope Controller (sampled from FL); original drawing.

import { evalEnvelope, type AutoPoint, type CurveMode } from '../../../../model/automation';

// ------------------------------------------------------------------ peaks

export const PEAK_BLOCK = 256;

export interface Peaks {
  /** Per channel: interleaved [min, max] per PEAK_BLOCK frames. */
  mm: Float32Array[];
  blocks: number;
}

const peakCache = new WeakMap<Float32Array, Peaks>();

export function computePeaks(ch: Float32Array[]): Peaks {
  const len = ch[0]?.length ?? 0;
  const blocks = Math.ceil(len / PEAK_BLOCK);
  const mm = ch.map((c) => {
    const o = new Float32Array(blocks * 2);
    for (let b = 0; b < blocks; b++) {
      let lo = Infinity, hi = -Infinity;
      const e = Math.min(len, (b + 1) * PEAK_BLOCK);
      for (let i = b * PEAK_BLOCK; i < e; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      o[b * 2] = lo === Infinity ? 0 : lo;
      o[b * 2 + 1] = hi === -Infinity ? 0 : hi;
    }
    return o;
  });
  return { mm, blocks };
}

/** Block peaks of a sample's channels (cached; pool audio never changes). */
export function peaksOf(ch: Float32Array[]): Peaks {
  const k = ch[0];
  if (!k) return { mm: [], blocks: 0 };
  let p = peakCache.get(k);
  if (!p) { p = computePeaks(ch); peakCache.set(k, p); }
  return p;
}

function minMax(ch: Float32Array[], pk: Peaks | null, ci: number, f0: number, f1: number): [number, number] {
  const c = ch[Math.min(ci, ch.length - 1)];
  const n = c.length;
  let a = Math.max(0, Math.floor(f0)), b = Math.min(n, Math.ceil(f1));
  if (b <= a) { if (a >= n || b < 0) return [1, -1]; b = a + 1; }
  let lo = Infinity, hi = -Infinity;
  if (pk && b - a > PEAK_BLOCK * 3) {
    const mm = pk.mm[Math.min(ci, pk.mm.length - 1)];
    const b0 = Math.ceil(a / PEAK_BLOCK), b1 = Math.floor(b / PEAK_BLOCK);
    for (let i = a; i < b0 * PEAK_BLOCK; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let k = b0; k < b1; k++) { const l = mm[k * 2], h = mm[k * 2 + 1]; if (l < lo) lo = l; if (h > hi) hi = h; }
    for (let i = b1 * PEAK_BLOCK; i < b; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  } else {
    for (let i = a; i < b; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  return [lo, hi];
}

// ------------------------------------------------------------------ sample window

export const WCOL = {
  bgTop: '#3b4252', bgMid: '#2c3344', bgBot: '#3c4353', wave: '#d2d9e9', waveR: '#bfc8de', waveSel: '#ffdeef',
  sel: 'rgba(150, 38, 78, 0.55)', marker: '#ffb871', markerText: '#f5a462', head: '#eef4ff', play: 'rgba(255, 196, 120, 0.22)',
  cur: 'rgba(255, 184, 113, 0.12)', band: 'rgba(255, 184, 113, 0.05)', text: 'rgba(160, 172, 196, 0.55)',
};

export interface WaveRegion {
  s: number;
  /** Resolved last frame. */
  end: number;
  /** A region (stored end) rather than a marker. */
  region: boolean;
  name: string;
}

export interface WaveOpts {
  ch: Float32Array[] | null;
  sr: number;
  view: [number, number];
  sel: [number, number] | null;
  regions: WaveRegion[];
  /** The current region (highlighted), -1 = none. */
  cur: number;
  showRegions: boolean;
  /** Tempo of the grid (BPM), 0 = time grid. */
  tempo: number;
  spectrum: boolean;
  /** Text of an empty deck. */
  empty: string;
  /** The small second-deck display of the dual view. */
  compact?: boolean;
}

function niceSeconds(spp: number): number {
  for (const s of [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s / spp >= 60) return s;
  return 600;
}

const finite = (x: number, d = 0) => (Number.isFinite(x) ? x : d);

export function drawWave(g: CanvasRenderingContext2D, W: number, H: number, o: WaveOpts): void {
  const bg = g.createLinearGradient ? g.createLinearGradient(0, 0, 0, H) : null;
  if (bg) { bg.addColorStop(0, WCOL.bgTop); bg.addColorStop(0.5, WCOL.bgMid); bg.addColorStop(1, WCOL.bgBot); g.fillStyle = bg; } else g.fillStyle = WCOL.bgMid;
  g.fillRect(0, 0, W, H);
  const n = o.ch?.[0]?.length ?? 0;
  if (!o.ch || n === 0) {
    g.fillStyle = WCOL.text;
    g.font = `${o.compact ? 10 : 12}px var(--font-ui), sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(o.empty, W / 2, H / 2);
    g.textAlign = 'left';
    return;
  }
  const v0 = finite(o.view[0]), v1 = Math.max(v0 + 1, finite(o.view[1], n));
  const span = v1 - v0;
  const fx = (f: number) => ((f - v0) / span) * W;
  const sr = o.sr > 0 ? o.sr : 44100;

  // grid: beats of the deck's tempo, else seconds
  g.font = '9px var(--font-ui), sans-serif';
  g.textBaseline = 'alphabetic';
  if (o.tempo > 0) {
    const fpb = (sr * 60) / o.tempo;
    const pxb = (fpb / span) * W;
    const sub = pxb / 4 >= 7 ? 4 : pxb / 2 >= 7 ? 2 : 1;
    const step = fpb / sub;
    const k0 = Math.max(0, Math.floor(v0 / step)), k1 = Math.ceil(v1 / step);
    const bar = sub * 4;
    const labelEvery = Math.max(1, Math.ceil(36 / (pxb * 4)));
    if (k1 - k0 < 4000 && pxb >= 3) {
      for (let k = k0; k <= k1; k++) {
        const x = Math.round(fx(k * step)) + 0.5;
        const isBar = k % bar === 0, isBeat = k % sub === 0;
        g.fillStyle = isBar ? 'rgba(10, 14, 24, 0.55)' : isBeat ? 'rgba(10, 14, 24, 0.3)' : 'rgba(10, 14, 24, 0.14)';
        g.fillRect(x - 0.5, 0, 1, H);
        if (isBar && !o.compact && (k / bar) % labelEvery === 0) { g.fillStyle = WCOL.text; g.fillText(String(k / bar + 1), x + 3, H - 3); }
      }
    }
  } else {
    const sp = niceSeconds(span / sr / W);
    const step = sp * sr;
    for (let k = Math.max(0, Math.floor(v0 / step)); k * step <= v1 && k < 100000; k++) {
      const x = Math.round(fx(k * step)) + 0.5;
      g.fillStyle = 'rgba(10, 14, 24, 0.35)';
      g.fillRect(x - 0.5, 0, 1, H);
      if (!o.compact) {
        const t = k * sp;
        g.fillStyle = WCOL.text;
        g.fillText(sp >= 1 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${t.toFixed(sp >= 0.1 ? 1 : 3)}s`, x + 3, H - 3);
      }
    }
  }
  g.fillStyle = 'rgba(10, 14, 24, 0.35)';
  g.fillRect(0, Math.floor(H / 2), W, 1);

  // region bands (current region lighter)
  if (o.showRegions) {
    o.regions.forEach((r, i) => {
      const x0 = Math.max(0, fx(r.s)), x1 = Math.min(W, fx(r.end + 1));
      if (x1 <= x0) return;
      if (i !== o.cur && !r.region) return;
      g.fillStyle = i === o.cur ? WCOL.cur : WCOL.band;
      g.fillRect(x0, 0, x1 - x0, H);
    });
  }

  // selection
  const sel = o.sel ? [Math.min(o.sel[0], o.sel[1]), Math.max(o.sel[0], o.sel[1]) + 1] : null;
  if (sel) {
    const x0 = fx(sel[0]), x1 = fx(sel[1]);
    if (x1 > 0 && x0 < W) { g.fillStyle = WCOL.sel; g.fillRect(Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), H); }
  }

  if (o.spectrum) drawSpectrum(g, W, H, o.ch, sr, v0, v1);

  // waveform: min / max outline per pixel column, the selected part in pink
  const amp = H / 2 - 2, cy = H / 2;
  const chans = Math.min(2, o.ch.length);
  const fpp = span / W;
  const pk = peaksOf(o.ch);
  if (o.spectrum) g.globalAlpha = 0.55;
  for (let ci = chans - 1; ci >= 0; ci--) {
    g.fillStyle = ci === 1 ? WCOL.waveR : WCOL.wave;
    if (fpp < 1.5) {
      g.strokeStyle = g.fillStyle;
      g.lineWidth = 1.2;
      g.beginPath();
      let started = false;
      for (let f = Math.max(0, Math.floor(v0) - 1); f <= Math.min(n - 1, Math.ceil(v1) + 1); f++) {
        const x = fx(f), y = cy - o.ch[ci][f] * amp;
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
      continue;
    }
    for (let x = 0; x < W; x++) {
      const f0 = v0 + x * fpp, f1 = f0 + fpp;
      if (f1 <= 0 || f0 >= n) continue;
      const [lo, hi] = minMax(o.ch, pk, ci, f0, f1);
      if (lo > hi) continue;
      let yt = cy - hi * amp, yb = cy - lo * amp;
      if (yb - yt < 1) { const m = (yt + yb) / 2; yt = m - 0.5; yb = m + 0.5; }
      const inSel = sel && f1 > sel[0] && f0 < sel[1];
      if (inSel) g.fillStyle = WCOL.waveSel;
      g.fillRect(x, yt, 1, yb - yt);
      if (inSel) g.fillStyle = ci === 1 ? WCOL.waveR : WCOL.wave;
    }
  }
  g.globalAlpha = 1;

  // region markers: orange line, tab and name; regions also mark their end
  if (o.showRegions) {
    g.font = "600 10.5px 'Avenir Next Condensed', 'Arial Narrow', 'Roboto Condensed', sans-serif";
    g.textBaseline = 'top';
    o.regions.forEach((r, i) => {
      const x = Math.round(fx(r.s)) + 0.5;
      const cur = i === o.cur;
      if (r.region) {
        const xe = Math.round(fx(r.end + 1)) + 0.5;
        if (xe >= -2 && xe <= W + 2) { g.fillStyle = 'rgba(255, 184, 113, 0.55)'; g.fillRect(xe - 0.5, 0, 1, H); g.fillRect(xe - 4, 0, 3.5, 9); }
      }
      if (x < -200 || x > W + 2) return;
      g.fillStyle = WCOL.marker;
      g.fillRect(x - 0.5, 0, cur ? 2 : 1, H);
      g.fillRect(x, 0, cur ? 6 : 4, o.compact ? 7 : 11);
      if (r.name && !o.compact) { g.fillStyle = cur ? '#ffe2c2' : WCOL.markerText; g.fillText(r.name, x + 7, 2); }
    });
  }
}

/** Playing regions (bands) and their play heads (monitor data), on the overlay canvas. */
export function drawHeads(g: CanvasRenderingContext2D, W: number, H: number, view: [number, number], bands: [number, number][], heads: number[]): void {
  g.clearRect(0, 0, W, H);
  const span = Math.max(1, view[1] - view[0]);
  const fx = (f: number) => ((f - view[0]) / span) * W;
  g.fillStyle = WCOL.play;
  for (const [s, e] of bands) {
    const x0 = Math.max(0, fx(s)), x1 = Math.min(W, fx(e + 1));
    if (x1 > x0) g.fillRect(x0, 0, x1 - x0, H);
  }
  g.fillStyle = WCOL.head;
  for (const f of heads) {
    const x = Math.round(fx(f)) + 0.5;
    if (x < -1 || x > W + 1) continue;
    g.fillRect(x - 0.5, 0, 1, H);
    g.beginPath(); g.moveTo(x - 4, 0); g.lineTo(x + 4, 0); g.lineTo(x, 5); g.fill();
  }
}

// ------------------------------------------------------------------ spectrum

function fftMag(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** Spectrum view (FL's "12 dB steps"-like gradient, natural frequency scale): one FFT per column, cached per view. */
let specCache: { ch: Float32Array; key: string; img: CanvasImageSource } | null = null;

function drawSpectrum(g: CanvasRenderingContext2D, W: number, H: number, ch: Float32Array[], sr: number, v0: number, v1: number): void {
  const key = `${ch.length}|${v0}|${v1}|${W}|${H}|${sr}`;
  if (specCache && specCache.ch === ch[0] && specCache.key === key) { g.drawImage(specCache.img, 0, 0, W, H); return; }
  const doc = (globalThis as { document?: { createElement?: (t: string) => HTMLCanvasElement } }).document;
  const off = doc?.createElement ? doc.createElement('canvas') : null;
  const og = off ? (off.width = Math.round(W), off.height = Math.round(H), off.getContext('2d')) : null;
  paintSpectrum(og ?? g, W, H, ch, sr, v0, v1);
  if (off && og) { specCache = { ch: ch[0], key, img: off }; g.drawImage(off, 0, 0, W, H); }
}

function paintSpectrum(g: CanvasRenderingContext2D, W: number, H: number, ch: Float32Array[], sr: number, v0: number, v1: number): void {
  const N = 1024;
  const cols = Math.min(Math.round(W), 900);
  const n = ch[0].length;
  const re = new Float64Array(N), im = new Float64Array(N);
  const rows = Math.max(8, Math.round(H / 2));
  const fmin = 30, fmax = Math.min(20000, sr / 2);
  const binOf = (r: number) => Math.min(N / 2 - 1, Math.max(1, Math.round(((fmin * Math.pow(fmax / fmin, r / (rows - 1))) / sr) * N)));
  const bins = Array.from({ length: rows }, (_, r) => binOf(r));
  const cw = W / cols, rh = H / rows;
  for (let c = 0; c < cols; c++) {
    const mid = Math.round(v0 + ((c + 0.5) / cols) * (v1 - v0));
    if (mid < 0 || mid >= n) continue;
    for (let i = 0; i < N; i++) {
      const f = mid - N / 2 + i;
      const v = f >= 0 && f < n ? (ch.length > 1 ? (ch[0][f] + ch[1][f]) * 0.5 : ch[0][f]) : 0;
      re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fftMag(re, im);
    for (let r = 0; r < rows; r++) {
      const b = bins[r];
      const m = Math.hypot(re[b], im[b]) / (N / 4);
      const db = 20 * Math.log10(m + 1e-9);
      const t = Math.max(0, Math.min(1, (db + 90) / 90));
      if (t <= 0.02) continue;
      const q = Math.round(t * 7.5) / 7.5; // 12 dB steps
      g.fillStyle = `rgba(${Math.round(255 * Math.min(1, q * 1.6))},${Math.round(255 * Math.max(0, q * 1.4 - 0.4))},${Math.round(255 * Math.max(0, q * 2 - 1.2))},${(0.25 + 0.75 * q).toFixed(3)})`;
      g.fillRect(c * cw, H - (r + 1) * rh, cw + 0.5, rh + 0.5);
    }
  }
}

// ------------------------------------------------------------------ envelope display

export const ECOL = {
  bg: '#333a4a', gridMinor: '#2d3443', gridMajor: '#262c3a', curve: '#ff3e35', curveOff: '#c0453f', point: '#ffc33e',
  pointCenter: '#3c2b12', text: '#8e97aa', flag: '#2a2d44', fill: 'rgba(255, 62, 53, 0.07)',
};

/** FL's point type tags (the menu's Tag values) as curve modes. */
export const TAG_MODE: CurveMode[] = ['single', 'double', 'hold', 'stairs', 'smoothStairs', 'pulse', 'wave', 'single2', 'double2', 'halfSine', 'smooth', 'single3', 'double3'];

export interface EnvPt { pos: number; value: number; tension: number; mode: CurveMode }

/** Curve points with absolute positions: p = [dx, level, tension, type, ...]. */
export function envPoints(p: number[][]): EnvPt[] {
  let t = 0;
  return p.map((q, i) => {
    t += i === 0 ? 0 : Math.max(0, q[0] ?? 0);
    return { pos: t, value: Math.max(0, Math.min(1, q[1] ?? 0)), tension: Math.max(-1, Math.min(1, q[2] ?? 0)), mode: TAG_MODE[(q[3] ?? 0) & 0xff] ?? 'single' };
  });
}

export interface EnvOpts {
  pts: EnvPt[];
  /** Visible x range: time units (0.5 s or beats) or 0..1 for the mappings. */
  v0: number;
  v1: number;
  map: boolean;
  enabled: boolean;
  tempo: boolean;
  /** Decay, loop start and sustain points (-1 = none). */
  decay: number;
  loop: number;
  sus: number;
  selected: ReadonlySet<number>;
  handles: boolean;
  /** LFO waveform preview: value (-1..1) at time t, or null. */
  lfo: ((t: number) => number) | null;
  /** The last note's velocity / modulation on a mapping's x axis (0..1). */
  line: number | null;
  /** Marquee selection rectangle (display pixels). */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
}

export const envX = (o: Pick<EnvOpts, 'v0' | 'v1'>, w: number, pos: number) => ((pos - o.v0) / (o.v1 - o.v0 || 1)) * w;
export const envY = (h: number, v: number) => 4 + (1 - v) * (h - 8);
export const envPos = (o: Pick<EnvOpts, 'v0' | 'v1'>, w: number, x: number) => o.v0 + (x / w) * (o.v1 - o.v0);
export const envVal = (h: number, y: number) => Math.max(0, Math.min(1, 1 - (y - 4) / (h - 8)));

export function envValueAt(pts: EnvPt[], pos: number): number {
  return evalEnvelope(pts as AutoPoint[], pos);
}

export function drawEnv(g: CanvasRenderingContext2D, W: number, H: number, o: EnvOpts): void {
  g.fillStyle = ECOL.bg;
  g.fillRect(0, 0, W, H);
  // grid: 1/4 units (time) or 1/8 (mappings), a darker line every 4
  const step = o.map ? 0.125 : 0.25;
  const span = o.v1 - o.v0;
  let st = step;
  while ((st / span) * W < 6 && st < 1e6) st *= 2;
  for (let k = Math.max(0, Math.floor(o.v0 / st)); k * st <= o.v1 && k < 5000; k++) {
    const x = Math.round(envX(o, W, k * st)) + 0.5;
    const major = Math.round(k * st / step) % 4 === 0;
    g.fillStyle = major ? ECOL.gridMajor : ECOL.gridMinor;
    g.fillRect(x - 0.5, 0, major ? 2 : 1, H);
  }
  for (let v = 1; v < 4; v++) { g.fillStyle = v === 2 ? ECOL.gridMajor : ECOL.gridMinor; g.fillRect(0, Math.round(envY(H, v / 4)), W, 1); }
  if (!o.pts.length) return;
  // the curve, sampled per pixel (FL's segment shapes)
  const ys: number[] = [];
  for (let x = 0; x <= W; x++) ys.push(envY(H, envValueAt(o.pts, envPos(o, W, x))));
  const last = o.pts[o.pts.length - 1];
  const xEnd = Math.min(W, envX(o, W, last.pos));
  g.fillStyle = ECOL.fill;
  g.beginPath(); g.moveTo(Math.max(0, envX(o, W, 0)), H);
  for (let x = Math.max(0, Math.floor(envX(o, W, 0))); x <= xEnd; x++) g.lineTo(x, ys[x]);
  g.lineTo(xEnd, H); g.closePath(); g.fill();
  // LFO preview under the curve
  if (o.lfo) {
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= W; x++) {
      const t = envPos(o, W, x);
      const amt = envValueAt(o.pts, t);
      const y = envY(H, 0.5 + 0.5 * amt * o.lfo(t));
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.strokeStyle = o.enabled || o.map ? ECOL.curve : ECOL.curveOff;
  g.globalAlpha = o.enabled || o.map ? 1 : 0.8;
  g.lineWidth = 1.4;
  g.beginPath();
  for (let x = 0; x <= W; x++) { if (x === 0) g.moveTo(x, ys[x]); else g.lineTo(x, ys[x]); }
  g.stroke();
  g.globalAlpha = 1;
  // marker lines with their flags
  g.font = 'bold 9px var(--font-ui), sans-serif';
  g.textBaseline = 'top';
  const flags: [number, string][] = [];
  if (!o.map) {
    if (o.decay >= 0) flags.push([o.decay, 'D']);
    if (o.loop >= 0) flags.push([o.loop, 'L']);
    if (o.sus >= 0) flags.push([o.sus, o.loop >= 0 ? 'E' : 'S']);
  }
  for (const [i, t] of flags) {
    const p = o.pts[i];
    if (!p) continue;
    const x = Math.round(envX(o, W, p.pos)) + 0.5;
    g.fillStyle = 'rgba(200, 210, 230, 0.45)';
    g.fillRect(x - 0.5, 0, 1, H);
    g.fillStyle = '#c8d2e6';
    g.fillRect(x, 0, 9, 10);
    g.fillStyle = ECOL.flag;
    g.fillText(t, x + 2, 1);
  }
  if (o.line !== null) {
    const x = Math.round(envX(o, W, o.line)) + 0.5;
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillRect(x - 0.5, 0, 1, H);
  }
  // handles
  if (o.handles) {
    for (let i = 1; i < o.pts.length; i++) {
      const a = o.pts[i - 1], b = o.pts[i];
      if (Math.abs(b.value - a.value) < 1e-6 && b.mode !== 'stairs' && b.mode !== 'smoothStairs' && b.mode !== 'pulse' && b.mode !== 'wave') continue;
      const xm = envX(o, W, (a.pos + b.pos) / 2);
      const ym = envY(H, envValueAt(o.pts, (a.pos + b.pos) / 2));
      g.strokeStyle = ECOL.curve; g.lineWidth = 1.2;
      g.beginPath(); g.arc(xm, ym, 3, 0, Math.PI * 2); g.stroke();
    }
    o.pts.forEach((p, i) => {
      const x = envX(o, W, p.pos), y = envY(H, p.value);
      g.fillStyle = o.selected.has(i) ? ECOL.point : ECOL.pointCenter;
      g.beginPath(); g.arc(x, y, 3.3, 0, Math.PI * 2); g.fill();
      g.strokeStyle = ECOL.point; g.lineWidth = 1.5; g.stroke();
    });
  }
  if (o.marquee) {
    const { x0, y0, x1, y1 } = o.marquee;
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
}
