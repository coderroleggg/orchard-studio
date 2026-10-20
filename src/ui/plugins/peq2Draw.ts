// Parametric EQ 2 graph drawing: geometry, the static layer (gradient, log
// grid, rulers, dB labels), response curves, band tokens and the value bubble.
// Curves come only from the model's bankResponse / bandResponse so the
// display matches what the audio engine does.

import {
  activeBands, bandResponse, bankResponse, freqHz, typeHasLevel, PEQ2_BAND_COLORS,
  type DesignMode, type PEQ2Band, type PEQ2Bank,
} from '../../model/peq2';
import type { BiquadCoefs } from '../../engine/dsp/biquad';
import { keyToHz } from '../../engine/dsp/math';
import { keyName } from '../../model/notes';
import { MINUS } from './peq2Format';

export const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** The EQ scale is +/-18 dB. */
export const DB_RANGE = 18;

const COL = {
  bgTop: '#142028',
  bgBottom: '#1b2b35',
  grid: '#263640',
  gridMajor: '#304552',
  zero: '#3f5866',
  rulerBg: '#0f171c',
  cell: '#2f3f4a',
  cellText: '#a5b6c0',
  dbText: '#738a98',
  curve: '#ebf3f7',
  curveFill: 'rgba(214, 236, 248, 0.075)',
  phase: 'rgba(255, 178, 96, 0.85)',
  tokenFill: '#0d1519',
  tokenFillHot: '#1b2830',
  bubbleBg: 'rgba(8, 13, 17, 0.9)',
  bubbleBorder: 'rgba(255, 255, 255, 0.16)',
  bubbleText: '#e8f0f4',
};

// ------------------------------------------------------------------ geometry
export interface Geom {
  w: number;
  h: number;
  s: number;
  rowH: number; // one top-ruler row
  rulerTop: number; // both top rows
  rulerBottom: number;
  // plot rectangle
  px: number;
  py: number;
  pw: number;
  ph: number;
  /** Inset of the +/-18 dB lines from the plot edges. */
  pad: number;
  tokenR: number;
  font: number;
}

export function makeGeom(w: number, h: number, s: number): Geom {
  const rowH = Math.max(9, Math.round(11 * s));
  const rulerBottom = Math.max(10, Math.round(12 * s));
  const rulerTop = rowH * 2;
  return {
    w, h, s, rowH, rulerTop, rulerBottom,
    px: 0,
    py: rulerTop,
    pw: Math.max(10, w),
    ph: Math.max(20, h - rulerTop - rulerBottom),
    pad: Math.max(4, Math.round(6 * s)),
    tokenR: Math.max(5.5, 7.5 * s),
    font: Math.max(7, Math.round(8.5 * s)),
  };
}

/** x of a normalised frequency (same mapping as the FREQ knob). */
export const xOfNorm = (g: Geom, n: number) => g.px + n * g.pw;
export const normOfX = (g: Geom, x: number) => (x - g.px) / g.pw;
export const xOfHz = (g: Geom, f: number) => g.px + (Math.log10(f / 20) / 3) * g.pw;
export const yOfDb = (g: Geom, db: number) => g.py + g.pad + ((DB_RANGE - db) / (2 * DB_RANGE)) * (g.ph - 2 * g.pad);
export const dbOfY = (g: Geom, y: number) => DB_RANGE - ((y - g.py - g.pad) / (g.ph - 2 * g.pad)) * 2 * DB_RANGE;
export const pxPerDb = (g: Geom) => (g.ph - 2 * g.pad) / (2 * DB_RANGE);

/** Size a canvas for devicePixelRatio and return a context drawing in CSS px. */
export function setupCanvas(c: HTMLCanvasElement, w: number, h: number, dpr: number): CanvasRenderingContext2D | null {
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function mixHex(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round(((x >> sh) & 255) * (1 - t) + ((y >> sh) & 255) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function clipPlot(ctx: CanvasRenderingContext2D, g: Geom): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.px, g.py, g.pw, g.ph);
  ctx.clip();
}

// ---------------------------------------------------------------- background
/** Named ranges of the second top-ruler row: [from Hz, to Hz, labels (longest first)]. */
const RANGES: [number, number, string[]][] = [
  [20, 60, ['sub']],
  [60, 250, ['bass']],
  [250, 500, ['low mids', 'lo mids', 'lo']],
  [500, 2000, ['mids']],
  [2000, 4000, ['high mids', 'hi mids', 'hi']],
  [4000, 6000, ['presence', 'pres.']],
  [6000, 20000, ['brilliance', 'brill.']],
];

/** Named range at a frequency (second top-ruler row): "mids: 500 Hz - 2 kHz". */
export function rangeAt(f: number): string | null {
  const r = RANGES.find(([f0, f1]) => f >= f0 && f < f1) ?? (f >= 20000 ? RANGES[RANGES.length - 1] : null);
  const hz = (v: number) => (v >= 1000 ? `${v / 1000} kHz` : `${v} Hz`);
  return r ? `${r[2][0]}: ${hz(r[0])} - ${hz(r[1])}` : null;
}

/** Bottom ruler: cell borders (1-2-5 pattern). */
const MARKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const markLabel = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));

function cell(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, h: number): boolean {
  const a = Math.round(x0) + 1, b = Math.round(x1);
  if (b - a < 1) return false;
  ctx.fillStyle = COL.cell;
  ctx.fillRect(a, y + 1, b - a, h - 1);
  return true;
}

function fit(ctx: CanvasRenderingContext2D, labels: string[], maxW: number): string | null {
  for (const l of labels) if (ctx.measureText(l).width <= maxW) return l;
  return null;
}

export function drawBackground(ctx: CanvasRenderingContext2D, g: Geom): void {
  ctx.clearRect(0, 0, g.w, g.h);
  ctx.fillStyle = COL.rulerBg;
  ctx.fillRect(0, 0, g.w, g.h);
  const grad = ctx.createLinearGradient(0, g.py, 0, g.py + g.ph);
  grad.addColorStop(0, COL.bgTop);
  grad.addColorStop(1, COL.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(g.px, g.py, g.pw, g.ph);

  // vertical log grid: 1..9 x each decade
  ctx.lineWidth = 1;
  for (let dec = 10; dec <= 10000; dec *= 10) {
    for (let m = 1; m <= 9; m++) {
      const f = dec * m;
      if (f <= 20 || f >= 20000) continue;
      const x = Math.round(xOfHz(g, f)) + 0.5;
      ctx.strokeStyle = m === 1 ? COL.gridMajor : COL.grid;
      ctx.beginPath();
      ctx.moveTo(x, g.py);
      ctx.lineTo(x, g.py + g.ph);
      ctx.stroke();
    }
  }
  // horizontal grid: major every 6 dB, faint minor lines at 3 dB
  for (let db = -DB_RANGE; db <= DB_RANGE; db += 3) {
    const y = Math.round(yOfDb(g, db)) + 0.5;
    const major = db % 6 === 0;
    ctx.globalAlpha = major ? 1 : 0.45;
    ctx.strokeStyle = db === 0 ? COL.zero : major ? COL.gridMajor : COL.grid;
    ctx.beginPath();
    ctx.moveTo(g.px, y);
    ctx.lineTo(g.px + g.pw, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.font = `${g.font}px ${FONT}`;
  ctx.textBaseline = 'middle';
  const pad = Math.max(2, Math.round(3 * g.s));

  // dB labels on the right edge, every 6 dB
  ctx.textAlign = 'right';
  const lw = ctx.measureText('+18').width + 2 * pad;
  for (let db = -DB_RANGE; db <= DB_RANGE; db += 6) {
    const y = Math.round(yOfDb(g, db)) + 0.5;
    const text = db === 0 ? '0' : `${db > 0 ? '+' : MINUS}${Math.abs(db)}`;
    ctx.fillStyle = mixHex(COL.bgTop, COL.bgBottom, (y - g.py) / g.ph);
    ctx.fillRect(g.px + g.pw - lw - pad, y - g.font * 0.55, lw, g.font * 1.1);
    ctx.fillStyle = COL.dbText;
    ctx.fillText(text, g.px + g.pw - 2 * pad, y);
  }

  // top ruler, row 1: octave cells starting at each C (FL naming, C5 = 261.6 Hz)
  ctx.textAlign = 'left';
  const ty1 = Math.round(g.rowH / 2) + 0.5;
  for (let oct = 0; oct <= 11; oct++) {
    const f0 = keyToHz(12 * oct), f1 = keyToHz(12 * (oct + 1));
    if (f1 <= 20 || f0 >= 20000) continue;
    const x0 = Math.max(0, xOfHz(g, f0)), x1 = Math.min(g.w, xOfHz(g, f1));
    if (!cell(ctx, x0, x1, 0, g.rowH)) continue;
    const label = keyName(12 * oct);
    if (ctx.measureText(label).width + 2 * pad <= x1 - x0) {
      ctx.fillStyle = COL.cellText;
      ctx.fillText(label, Math.round(x0) + 1 + pad, ty1);
    }
  }
  // top ruler, row 2: named frequency ranges
  ctx.textAlign = 'center';
  const ty2 = g.rowH + Math.round(g.rowH / 2) + 0.5;
  for (const [f0, f1, labels] of RANGES) {
    const x0 = xOfHz(g, f0), x1 = xOfHz(g, f1);
    if (!cell(ctx, x0, x1, g.rowH, g.rowH)) continue;
    const label = fit(ctx, labels, x1 - x0 - 2 * pad);
    if (label) {
      ctx.fillStyle = COL.cellText;
      ctx.fillText(label, Math.round((x0 + x1) / 2) + 0.5, ty2);
    }
  }
  // bottom ruler: cells between 20, 50, 100 ... 20k, labelled at their borders
  const yb = g.h - g.rulerBottom;
  const tyb = yb + Math.round(g.rulerBottom / 2) + 0.5;
  ctx.textAlign = 'left';
  for (let i = 0; i < MARKS.length - 1; i++) {
    const x0 = xOfHz(g, MARKS[i]), x1 = xOfHz(g, MARKS[i + 1]);
    if (!cell(ctx, x0, x1, yb, g.rulerBottom)) continue;
    ctx.fillStyle = COL.cellText;
    ctx.fillText(markLabel(MARKS[i]), Math.round(x0) + 1 + pad, tyb);
  }
  ctx.textAlign = 'right';
  ctx.fillText(markLabel(MARKS[MARKS.length - 1]), g.w - pad, tyb);
}

// -------------------------------------------------------------------- curves
export interface Curve {
  /** y (CSS px) per point; point i sits at x = px + i / (n - 1) * pw. */
  ys: Float32Array;
  /** Wrapped phase in radians per point (Phase rotation on). */
  phase: Float32Array | null;
}

function points(g: Geom): number {
  return Math.max(2, Math.ceil(g.pw)) + 1;
}

const toDb = (m: number) => 20 * Math.log10(Math.max(m, 1e-9));
const wrapPi = (p: number) => p - 2 * Math.PI * Math.round(p / (2 * Math.PI));
/** Frequency of curve point i; held at Nyquist when the sample rate is below 40 kHz. */
const pointHz = (i: number, n: number, fs: number) => Math.min(freqHz(i / (n - 1)), fs * 0.4999);

/** Total response of the bank (including main level) across the graph width. */
export function computeCurve(bank: PEQ2Bank, fs: number, mode: DesignMode, lin: boolean, g: Geom, withPhase: boolean): Curve {
  const n = points(g);
  const ys = new Float32Array(n);
  const phase = withPhase ? new Float32Array(n) : null;
  const cache = new Map<PEQ2Band, BiquadCoefs[]>();
  for (let i = 0; i < n; i++) {
    const [m, p] = bankResponse(bank, pointHz(i, n, fs), fs, mode, lin, cache);
    ys[i] = yOfDb(g, toDb(m));
    if (phase) phase[i] = wrapPi(p);
  }
  return { ys, phase };
}

/** One band's own response (drawn for the hovered / dragged band). */
export function computeBandCurve(b: PEQ2Band, fs: number, mode: DesignMode, lin: boolean, g: Geom): Float32Array {
  const n = points(g);
  const ys = new Float32Array(n);
  const band: PEQ2Band = { ...b, enabled: true, solo: false };
  // same design as the audio (LIN: the minimum-phase magnitude as 2^(dB/6))
  for (let i = 0; i < n; i++) {
    const f = pointHz(i, n, fs);
    ys[i] = yOfDb(g, toDb(bandResponse(band, f, fs, mode, lin)));
  }
  return ys;
}

const clampY = (g: Geom, y: number) => Math.max(g.py - 40, Math.min(g.py + g.ph + 40, y));

function tracePath(ctx: CanvasRenderingContext2D, g: Geom, ys: Float32Array, cont: boolean): void {
  const n = ys.length, step = g.pw / (n - 1);
  for (let i = 0; i < n; i++) {
    const x = g.px + i * step, y = clampY(g, ys[i]);
    if (i === 0 && !cont) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

/** Light fill under the composite curve, down to the bottom of the graph. */
export function drawCurveFill(ctx: CanvasRenderingContext2D, g: Geom, ys: Float32Array): void {
  clipPlot(ctx, g);
  ctx.beginPath();
  ctx.moveTo(g.px, g.py + g.ph + 2);
  tracePath(ctx, g, ys, true);
  ctx.lineTo(g.px + g.pw, g.py + g.ph + 2);
  ctx.closePath();
  ctx.fillStyle = COL.curveFill;
  ctx.fill();
  ctx.restore();
}

export function drawCurveLine(ctx: CanvasRenderingContext2D, g: Geom, ys: Float32Array): void {
  clipPlot(ctx, g);
  ctx.beginPath();
  tracePath(ctx, g, ys, false);
  ctx.strokeStyle = COL.curve;
  ctx.lineWidth = Math.max(1.4, 1.8 * g.s);
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

/** Band-coloured tint between a band's curve and the 0 dB line. */
export function drawBandFill(ctx: CanvasRenderingContext2D, g: Geom, ys: Float32Array, color: string): void {
  const y0 = yOfDb(g, 0);
  clipPlot(ctx, g);
  ctx.beginPath();
  ctx.moveTo(g.px, y0);
  tracePath(ctx, g, ys, true);
  ctx.lineTo(g.px + g.pw, y0);
  ctx.closePath();
  ctx.fillStyle = rgba(color, 0.16);
  ctx.fill();
  ctx.restore();
}

export function drawBandLine(ctx: CanvasRenderingContext2D, g: Geom, ys: Float32Array, color: string, dashed: boolean): void {
  clipPlot(ctx, g);
  ctx.beginPath();
  tracePath(ctx, g, ys, false);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, 1.5 * g.s);
  ctx.lineJoin = 'round';
  if (dashed) ctx.setLineDash([4 * g.s, 3 * g.s]);
  ctx.stroke();
  ctx.restore();
}

/** Phase line: +/-180 degrees on the +/-18 dB scale, wrapping edge to edge. */
export function drawPhase(ctx: CanvasRenderingContext2D, g: Geom, ph: Float32Array): void {
  const n = ph.length, step = g.pw / (n - 1);
  clipPlot(ctx, g);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = g.px + i * step, y = yOfDb(g, (ph[i] / Math.PI) * DB_RANGE);
    if (i === 0 || Math.abs(ph[i] - ph[i - 1]) > Math.PI) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = COL.phase;
  ctx.lineWidth = Math.max(1, 1.2 * g.s);
  ctx.stroke();
  ctx.restore();
}

// -------------------------------------------------------------------- tokens
export interface Token {
  k: number;
  x: number;
  y: number;
}

/** Token positions in band order: (freq, level) for level types, the 0 dB line otherwise. */
export function tokenLayout(bands: PEQ2Band[], show: boolean, g: Geom): Token[] {
  const out: Token[] = [];
  if (!show) return out;
  bands.forEach((b, k) => {
    if (b.type === 'off') return;
    out.push({ k, x: xOfNorm(g, b.freq), y: yOfDb(g, typeHasLevel(b.type) ? b.level : 0) });
  });
  return out;
}

/** Topmost token under (x, y), or -1 (higher band numbers are drawn on top). */
export function hitTest(toks: Token[], g: Geom, x: number, y: number): number {
  const r = g.tokenR + 3;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if ((t.x - x) ** 2 + (t.y - y) ** 2 <= r * r) return t.k;
  }
  return -1;
}

export function drawTokens(ctx: CanvasRenderingContext2D, g: Geom, bank: PEQ2Bank, toks: Token[], hover: number, top: number): void {
  const active = new Set(activeBands(bank));
  const order = top >= 0 ? [...toks.filter((t) => t.k !== top), ...toks.filter((t) => t.k === top)] : toks;
  for (const t of order) {
    const b = bank.bands[t.k];
    const hot = t.k === hover || t.k === top;
    const col = PEQ2_BAND_COLORS[t.k];
    const r = g.tokenR * (hot ? 1.12 : 1);
    ctx.save();
    ctx.globalAlpha = active.has(b) ? 1 : 0.45;
    if (hot) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, r + 4 * g.s, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, 0.22);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.fillStyle = hot ? COL.tokenFillHot : COL.tokenFill;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, (hot ? 2.4 : 1.9) * g.s);
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.fillStyle = hot ? '#ffffff' : col;
    ctx.font = `bold ${Math.max(7, Math.round(9.5 * g.s * (hot ? 1.08 : 1)))}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(t.k + 1), t.x, t.y + 0.5 * g.s);
    ctx.restore();
  }
}

/** Floating value readout next to the dragged token (or the cursor). */
export function drawBubble(ctx: CanvasRenderingContext2D, g: Geom, x: number, y: number, text: string): void {
  ctx.font = `${g.font}px ${FONT}`;
  const padX = 5 * g.s;
  const w = ctx.measureText(text).width + 2 * padX;
  const h = g.font + 6 * g.s;
  const off = g.tokenR + 6 * g.s;
  let bx = x + off, by = y - off - h;
  if (bx + w > g.px + g.pw - 2) bx = x - off - w;
  if (bx < g.px + 2) bx = g.px + 2;
  if (by < g.py + 2) by = y + off;
  if (by + h > g.py + g.ph - 2) by = g.py + g.ph - h - 2;
  roundRect(ctx, bx, by, w, h, 3 * g.s);
  ctx.fillStyle = COL.bubbleBg;
  ctx.fill();
  ctx.strokeStyle = COL.bubbleBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = COL.bubbleText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + padX, by + h / 2 + 0.5);
}
