// Canvas drawing of the Envelope Controller's envelope display (FL's TMEnvEditor): the blue-grey grid, the
// translucent fill under the curve, the red curve with its orange control points and red tension circles,
// the section marker lines with their flags, the LFO waveform preview and the selection rectangle.
// Colours were sampled from FL's manual screenshots (original drawing, no FL assets): FL lays the fill and the
// marker lines over the grid additively (+19, +3, +2 and +94 per channel), which is reproduced here.

import { evalEnvelope } from '../../../../model/automation';
import { ecLfoWave, type EcShape } from '../../../../model/gen/plugins/envctrl';
import { markerLetters, timeGrid } from './shapeOps';

export const COL = {
  bg: '#434b5d', gridMinor: '#3a4254', gridMajor: '#2f3749', gridMajorEdge: '#3c4456', keyStripe: '#3f4658',
  curve: '#ff3e35', point: '#ffc33e', pointCenter: '#3c2b12', tail: '#979fb1',
  flagText: '#2a2d44', frame: '#21293a',
} as const;

export type AxisKind = 'time' | 'key' | 'map';

export interface LfoPreview {
  /** Cycles per second (ecLfoHz). */
  hz: number;
  tns: number;
  sk: number;
  pw: number;
  /** The LFO level knob (-1..1). */
  level: number;
}

export interface DrawArgs {
  w: number;
  h: number;
  shape: EcShape;
  kind: AxisKind;
  tempo: boolean;
  /** Visible time / x range and value range. */
  v0: number;
  v1: number;
  y0: number;
  y1: number;
  /** Draw the control points and tension circles (off while frozen). */
  handles: boolean;
  selected: ReadonlySet<number>;
  /** Markers (D / L / S flags) apply to the envelope and the LFO only. */
  markers: boolean;
  lfo: LfoPreview | null;
  /** The last note's position on a mapping axis (0..1): a vertical line. */
  noteLine: number | null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
}

const PT_R = 3.3;

export const xOf = (a: Pick<DrawArgs, 'w' | 'v0' | 'v1'>, pos: number) => ((pos - a.v0) / (a.v1 - a.v0)) * a.w;
export const yOf = (a: Pick<DrawArgs, 'h' | 'y0' | 'y1'>, v: number) => 0.5 + (1 - (v - a.y0) / (a.y1 - a.y0)) * (a.h - 1);
export const posAt = (a: Pick<DrawArgs, 'w' | 'v0' | 'v1'>, x: number) => a.v0 + (x / a.w) * (a.v1 - a.v0);
export const valueOf = (a: Pick<DrawArgs, 'h' | 'y0' | 'y1'>, y: number) => a.y0 + (1 - (y - 0.5) / (a.h - 1)) * (a.y1 - a.y0);

/** Mid-time handle of the segment ending at point i: its position and value. */
export function tensionHandle(a: DrawArgs, i: number): { x: number; y: number } {
  const p = a.shape.pts, pm = (p[i - 1].pos + p[i].pos) / 2;
  return { x: xOf(a, pm), y: yOf(a, evalEnvelope(p, pm)) };
}

/** Whether the segment ending at point i has a tension handle (its end values differ). */
export const hasTension = (sh: EcShape, i: number) => i > 0 && Math.abs(sh.pts[i].value - sh.pts[i - 1].value) > 1e-6;

export function drawEnvDisplay(g: CanvasRenderingContext2D, a: DrawArgs): void {
  const { w, h, shape, kind } = a;
  const pts = shape.pts;
  g.save();
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();
  g.fillStyle = COL.bg;
  g.fillRect(0, 0, w, h);

  // ---- grid: 16 value rows (a major line every 4), time columns
  const dy = (a.y1 - a.y0) || 1;
  const rowStep = 1 / 16;
  for (let k = Math.ceil(a.y0 / rowStep - 1e-9); k * rowStep <= a.y1 + 1e-9; k++) {
    const y = Math.round(yOf(a, k * rowStep) - 0.5);
    if ((h - 1) * rowStep / dy < 5) break;
    g.fillStyle = k % 4 === 0 ? COL.gridMajor : COL.gridMinor;
    g.fillRect(0, y, w, 1);
  }
  const span = a.v1 - a.v0;
  if (kind === 'time') {
    const gr = timeGrid(a.tempo, w / span);
    const k0 = Math.ceil(a.v0 / gr.step - 1e-9);
    for (let k = k0; k * gr.step <= a.v1 + 1e-9; k++) {
      const x = Math.round(xOf(a, k * gr.step));
      if (k % gr.every === 0) {
        g.fillStyle = COL.gridMajorEdge; g.fillRect(x - 1, 0, 3, h);
        g.fillStyle = COL.gridMajor; g.fillRect(x, 0, 1, h);
      } else if ((gr.step * w) / span >= 4) {
        g.fillStyle = COL.gridMinor; g.fillRect(x, 0, 1, h);
      }
    }
  } else if (kind === 'key') {
    // piano roll like columns: the black keys' columns are a shade darker, an octave line every 12 keys
    const keyW = w / (span * 120);
    for (let k = Math.max(0, Math.floor(a.v0 * 120)); k <= Math.min(119, Math.ceil(a.v1 * 120)); k++) {
      const s = k % 12;
      if (s === 1 || s === 3 || s === 6 || s === 8 || s === 10) {
        g.fillStyle = COL.keyStripe;
        g.fillRect(Math.round(xOf(a, k / 120)), 0, Math.max(1, Math.round(keyW)), h);
      }
    }
    for (let o = 1; o < 10; o++) {
      const x = Math.round(xOf(a, (o * 12) / 120));
      g.fillStyle = COL.gridMajorEdge; g.fillRect(x - 1, 0, 3, h);
      g.fillStyle = COL.gridMajor; g.fillRect(x, 0, 1, h);
    }
  } else {
    for (let k = 1; k < 16; k++) {
      const x = Math.round(xOf(a, k / 16));
      if (k % 4 === 0) { g.fillStyle = COL.gridMajorEdge; g.fillRect(x - 1, 0, 3, h); g.fillStyle = COL.gridMajor; g.fillRect(x, 0, 1, h); }
      else { g.fillStyle = COL.gridMinor; g.fillRect(x, 0, 1, h); }
    }
  }

  // ---- fill under the curve (additive), curve
  const lastX = xOf(a, pts[pts.length - 1].pos);
  const firstX = xOf(a, pts[0].pos);
  const n = Math.max(2, Math.ceil(w * 1.5));
  const curveY = (x: number) => yOf(a, evalEnvelope(pts, posAt(a, x)));
  const startX = Math.max(0, firstX), endX = Math.min(w, lastX);
  const curveXs: number[] = [];
  if (endX > startX) {
    for (let i = 0; i < n; i++) {
      const x = startX + ((endX - startX) * i) / n;
      curveXs.push(x);
    }
    curveXs.push(endX);
  }
  if (curveXs.length) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgb(19,3,2)';
    g.beginPath();
    g.moveTo(startX, h);
    for (const x of curveXs) g.lineTo(x, curveY(x));
    g.lineTo(endX, h);
    g.closePath();
    g.fill();
    g.restore();
  }

  // behind the last point the envelope stays on its value: a plain grey line
  if (lastX < w) {
    g.strokeStyle = COL.tail;
    g.lineWidth = 1;
    const y = Math.round(yOf(a, pts[pts.length - 1].value) - 0.5) + 0.5;
    g.beginPath(); g.moveTo(Math.max(0, lastX), y); g.lineTo(w, y); g.stroke();
  }

  // ---- LFO waveform (the LFO's output over the modifier envelope)
  if (a.lfo) {
    const L = a.lfo;
    g.strokeStyle = 'rgba(255,255,255,0.45)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= w; x += 0.5) {
      const pos = posAt(a, x);
      if (pos < 0) continue;
      const wv = ecLfoWave((pos * L.hz) / 2, L.tns, L.sk, L.pw);
      const y = evalEnvelope(pts, pos);
      const v = 0.5 + (L.level * wv * (2 * y - 1)) / 2;
      const py = yOf(a, Math.max(-0.5, Math.min(1.5, v)));
      if (x === 0 || pos <= a.v0 + 1e-9) g.moveTo(x, py); else g.lineTo(x, py);
    }
    g.stroke();
  }

  if (curveXs.length) {
    g.strokeStyle = COL.curve;
    g.lineWidth = 1.4;
    g.lineJoin = 'round';
    g.beginPath();
    curveXs.forEach((x, i) => { if (i === 0) g.moveTo(x, curveY(x)); else g.lineTo(x, curveY(x)); });
    g.stroke();
  }

  // ---- marker lines (additive) and the last note's line
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgb(94,94,94)';
  if (a.markers) {
    for (let i = 0; i < pts.length; i++) {
      if (!markerLetters(shape, i)) continue;
      const x = Math.round(xOf(a, pts[i].pos));
      if (x >= -1 && x <= w) g.fillRect(x, 0, 1, h);
    }
  }
  if (a.noteLine !== null && Number.isFinite(a.noteLine)) {
    const x = Math.round(xOf(a, a.noteLine));
    if (x >= 0 && x <= w) g.fillRect(x, 0, 1, h);
  }
  g.restore();

  // ---- handles
  if (a.handles) {
    g.lineWidth = 1.3;
    g.strokeStyle = COL.curve;
    for (let i = 1; i < pts.length; i++) {
      if (!hasTension(shape, i)) continue;
      const hd = tensionHandle(a, i);
      if (hd.x < -4 || hd.x > w + 4) continue;
      g.beginPath(); g.arc(hd.x, hd.y, 3, 0, Math.PI * 2); g.stroke();
    }
    for (let i = 0; i < pts.length; i++) {
      const x = xOf(a, pts[i].pos), y = yOf(a, pts[i].value);
      if (x < -5 || x > w + 5) continue;
      g.beginPath();
      g.arc(x, y, PT_R, 0, Math.PI * 2);
      g.fillStyle = a.selected.has(i) ? COL.point : COL.pointCenter;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = COL.point;
      g.stroke();
    }
  }

  // ---- marker flags at the bottom
  if (a.markers) {
    for (let i = 0; i < pts.length; i++) {
      const t = markerLetters(shape, i);
      if (!t) continue;
      const x = Math.round(xOf(a, pts[i].pos));
      if (x < -30 || x > w) continue;
      drawFlag(g, x, h, t);
    }
  }

  if (a.marquee) {
    const m = a.marquee;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1), rw = Math.abs(m.x1 - m.x0), rh = Math.abs(m.y1 - m.y0);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(x, y, rw, rh);
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, rw, rh);
  }
  g.restore();
}

/** A section marker's flag: a light tab hanging on the marker line at the bottom with the marker's letters. */
export function drawFlag(g: CanvasRenderingContext2D, x: number, h: number, text: string): void {
  const fw = 8 + 6.5 * text.length, fh = 16, r = 7;
  const top = h - fh - 1;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgb(94,94,94)';
  g.beginPath();
  g.moveTo(x, top);
  g.lineTo(x + fw - r - 2, top);
  g.quadraticCurveTo(x + fw, top + 2, x + fw, top + fh / 2);
  g.quadraticCurveTo(x + fw, top + fh - 2, x + fw - r - 2, top + fh);
  g.lineTo(x, top + fh);
  g.closePath();
  g.fill();
  g.restore();
  g.fillStyle = COL.flagText;
  g.font = '700 10px ' + (typeof document !== 'undefined' ? getComputedStyle(document.body).fontFamily || 'sans-serif' : 'sans-serif');
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(text, x + 4, top + fh / 2 + 0.5);
}
