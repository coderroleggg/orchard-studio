// Pure edit operations of the Envelope Controller's envelope editor (points, section
// markers, selections, clipboard, step drawing) on `EcShape`s, and the editor's
// grid / view geometry. No React here so the rules are testable.

import { evalEnvelope, type AutoPoint, type CurveMode } from '../../../../model/automation';
import { EC_MAX_POINTS, type EcShape } from '../../../../model/gen/plugins/envctrl';

export type MarkerKey = 'd' | 'l' | 's';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const cloneShape = (sh: EcShape): EcShape => ({ ...sh, pts: sh.pts.map((p) => ({ ...p })) });

/** Index at which a point at `pos` is inserted (after points at the same position). */
export function insertIndexFor(pts: AutoPoint[], pos: number): number {
  for (let k = 0; k < pts.length; k++) if (pts[k].pos > pos) return k;
  return pts.length;
}

/** Insert a point at index `i`: the markers at or after it move one point up. */
export function insertPoint(sh: EcShape, i: number, p: AutoPoint): EcShape {
  const at = Math.max(0, Math.min(sh.pts.length, i));
  const pts = [...sh.pts.slice(0, at).map((q) => ({ ...q })), { ...p }, ...sh.pts.slice(at).map((q) => ({ ...q }))];
  const up = (m: number) => (m >= at ? m + 1 : m);
  return { ...sh, pts, d: up(sh.d), l: up(sh.l), s: up(sh.s) };
}

/** Delete the points `idx` (a shape keeps at least its first and one more point; the first point stays). */
export function removePoints(sh: EcShape, idx: Iterable<number>): EcShape {
  const kill = new Set<number>();
  for (const i of idx) if (i > 0 && i < sh.pts.length) kill.add(i);
  if (sh.pts.length - kill.size < 2) {
    // keep the last point
    kill.delete(sh.pts.length - 1);
    if (sh.pts.length - kill.size < 2) return sh;
  }
  if (!kill.size) return sh;
  const map = (m: number) => {
    if (m < 0 || kill.has(m)) return -1;
    let c = 0;
    for (const k of kill) if (k < m) c++;
    return m - c;
  };
  return { ...sh, pts: sh.pts.filter((_, i) => !kill.has(i)).map((q) => ({ ...q })), d: map(sh.d), l: map(sh.l), s: map(sh.s) };
}

/** Which section markers a point may take (D before the sustain, L before the section end, S after D and L). */
export function markerAllowed(sh: EcShape, key: MarkerKey | 'dl', i: number): boolean {
  const n = sh.pts.length;
  if (i < 0 || i >= n) return false;
  const okD = sh.s < 0 || i <= sh.s;
  const okL = i < (sh.s >= 0 ? sh.s : n - 1);
  const okS = (sh.d < 0 || i >= sh.d) && (sh.l < 0 || i > sh.l);
  return key === 'd' ? okD : key === 'l' ? okL : key === 's' ? okS : okD && okL;
}

/** Whether the point carries the marker. */
export function hasMarker(sh: EcShape, key: MarkerKey | 'dl', i: number): boolean {
  return key === 'dl' ? sh.d === i && sh.l === i : sh[key] === i;
}

/** Set a marker on a point, or clear it when the point already has it. */
export function toggleMarker(sh: EcShape, key: MarkerKey | 'dl', i: number): EcShape {
  if (!markerAllowed(sh, key, i)) return sh;
  const on = hasMarker(sh, key, i);
  const out = { ...sh, pts: sh.pts.map((p) => ({ ...p })) };
  if (key === 'dl') {
    if (on) { out.d = -1; out.l = -1; } else { out.d = i; out.l = i; }
  } else out[key] = on ? -1 : i;
  return out;
}

/** The letters of the markers on a point, in D L S order ("" for none). */
export function markerLetters(sh: EcShape, i: number): string {
  return (sh.d === i ? 'D' : '') + (sh.l === i ? 'L' : '') + (sh.s === i ? 'S' : '');
}

/** Mirror the values of the points `idx` (all by default): 1 - value (a curve keeps its tension: it is the same progress). */
export function flipValues(sh: EcShape, idx?: ReadonlySet<number>): EcShape {
  return { ...sh, pts: sh.pts.map((p, i) => (!idx || idx.size === 0 || idx.has(i) ? { ...p, value: clamp01(1 - p.value) } : { ...p })) };
}

/** Scale the values so the lowest becomes 0 and the highest 1 (a flat envelope is left alone). */
export function normalizeValues(sh: EcShape): EcShape {
  let lo = Infinity, hi = -Infinity;
  for (const p of sh.pts) { lo = Math.min(lo, p.value); hi = Math.max(hi, p.value); }
  if (!(hi > lo)) return sh;
  return { ...sh, pts: sh.pts.map((p) => ({ ...p, value: clamp01((p.value - lo) / (hi - lo)) })) };
}

/** A copy of the selected points (for the clipboard): positions relative to the first selected point. */
export interface ClipPoints {
  pts: Array<{ dx: number; value: number; tension: number; mode: CurveMode }>;
}

export function copyPoints(sh: EcShape, idx: ReadonlySet<number>): ClipPoints | null {
  const sel = [...idx].filter((i) => i >= 0 && i < sh.pts.length).sort((a, b) => a - b);
  if (!sel.length) return null;
  const x0 = sh.pts[sel[0]].pos;
  return { pts: sel.map((i) => ({ dx: sh.pts[i].pos - x0, value: sh.pts[i].value, tension: sh.pts[i].tension, mode: sh.pts[i].mode })) };
}

/**
 * Paste points at `pos`: with `replace` the points in the pasted range are removed first, else the
 * points after it move later by the pasted length (insert). Returns the new shape and the indexes of the pasted points.
 */
export function pastePoints(sh: EcShape, clip: ClipPoints, pos: number, replace: boolean): { shape: EcShape; added: number[] } {
  const span = clip.pts[clip.pts.length - 1].dx;
  let pts = sh.pts.map((p) => ({ ...p }));
  let d = sh.d, l = sh.l, s = sh.s;
  const first = pts.findIndex((p, i) => i > 0 && p.pos >= pos);
  if (replace) {
    const keep: boolean[] = pts.map((p, i) => i === 0 || p.pos < pos || p.pos > pos + span);
    const idxMap: number[] = [];
    let c = 0;
    keep.forEach((k, i) => { idxMap[i] = k ? c++ : -1; });
    const re = (m: number) => (m >= 0 ? idxMap[m] : -1);
    d = re(d); l = re(l); s = re(s);
    pts = pts.filter((_, i) => keep[i]);
  } else if (first >= 0) {
    for (let i = first; i < pts.length; i++) pts[i].pos += span;
  }
  if (pts.length + clip.pts.length > EC_MAX_POINTS) return { shape: sh, added: [] };
  const at = insertIndexFor(pts, pos + 1e-9);
  const ins = clip.pts.map((q) => ({ pos: pos + q.dx, value: q.value, tension: q.tension, mode: q.mode }));
  pts.splice(at, 0, ...ins);
  const up = (m: number) => (m >= at ? m + ins.length : m);
  return { shape: { ...sh, pts, d: up(d), l: up(l), s: up(s) }, added: ins.map((_, k) => at + k) };
}

/** Duplicate the selected points right after the selection (the points behind it move later). */
export function duplicatePoints(sh: EcShape, idx: ReadonlySet<number>): { shape: EcShape; added: number[] } {
  const clip = copyPoints(sh, idx);
  if (!clip) return { shape: sh, added: [] };
  const sel = [...idx].sort((a, b) => a - b);
  const end = sh.pts[sel[sel.length - 1]].pos;
  const span = clip.pts[clip.pts.length - 1].dx;
  const gap = span > 0 ? 0 : 0.05;
  return pastePoints(sh, clip, end + gap + (span > 0 ? 1e-6 : 0), false);
}

/**
 * Step drawing (the editor's Step switch): one control point at every `step` between the two positions
 * with the pointer's value; the points in the stroked range are replaced. `hold` draws pulse lines
 * (horizontal / vertical only: every point holds the previous value until its position).
 */
export function drawSteps(sh: EcShape, from: number, to: number, value: number, step: number, hold: boolean, lo = 0, hi = Infinity): EcShape {
  if (!(step > 0)) return sh;
  const a = Math.max(lo, Math.min(from, to)), b = Math.min(hi, Math.max(from, to));
  const k0 = Math.ceil(a / step - 1e-9), k1 = Math.floor(b / step + 1e-9);
  if (k1 < k0) return sh;
  const v = clamp01(value);
  let pts = sh.pts.map((p) => ({ ...p }));
  let d = sh.d, l = sh.l, s = sh.s;
  // remove the points strictly inside the stroked range (never the first point)
  const x0 = k0 * step - 1e-9, x1 = k1 * step + 1e-9;
  const keep = pts.map((p, i) => i === 0 || p.pos < x0 || p.pos > x1);
  const idxMap: number[] = [];
  let c = 0;
  keep.forEach((k, i) => { idxMap[i] = k ? c++ : -1; });
  const re = (m: number) => (m >= 0 ? idxMap[m] : -1);
  d = re(d); l = re(l); s = re(s);
  pts = pts.filter((_, i) => keep[i]);
  const ins: AutoPoint[] = [];
  for (let k = k0; k <= k1; k++) {
    const pos = k * step;
    if (pos <= 0 && pts.length) { pts[0].value = v; continue; }
    ins.push({ pos, value: v, tension: 0, mode: hold ? 'hold' : 'single' });
  }
  if (pts.length + ins.length > EC_MAX_POINTS) return sh;
  const at = ins.length ? insertIndexFor(pts, ins[0].pos - 1e-9) : pts.length;
  pts.splice(at, 0, ...ins);
  const up = (m: number) => (m >= at ? m + ins.length : m);
  return { ...sh, pts, d: up(d), l: up(l), s: up(s) };
}

// ------------------------------------------------------------------- geometry

/** The grid lines of the time axis: positions of the minor lines and how many minors make a major one. */
export interface TimeGrid {
  step: number;
  every: number;
}

/**
 * FL's grid of an envelope's time axis: major lines every 2 units (1 s) with 10 minor lines (0.1 s) when
 * absolute, every beat with 4 minor lines when tempo based; zooming halves / doubles the spacing.
 */
export function timeGrid(tempo: boolean, pxPerUnit: number): TimeGrid {
  const per = tempo ? 4 : 10;
  let major = tempo ? 1 : 2;
  while (major * pxPerUnit < 40) major *= 2;
  while (major * pxPerUnit > 450 && major > per / 96) major /= 2;
  return { step: major / per, every: per };
}

/** The envelope's content width for the time scroller (a little room behind its last point). */
export function contentSpan(sh: EcShape, spanMin = 3.5): number {
  const last = sh.pts.length ? sh.pts[sh.pts.length - 1].pos : 0;
  return Math.max(spanMin, last * 1.1 + 0.5);
}

/** The curve's value at `pos` for drawing (a note's envelope is flat behind its last point). */
export const valueAt = (sh: EcShape, pos: number) => evalEnvelope(sh.pts, pos);

/** Whether all points have the same value (FL marks a source "in use" with an arrow when its envelope is not flat). */
export const isFlat = (sh: EcShape) => sh.pts.every((p) => p.value === sh.pts[0].value);

/** Replace / clamp a dragged point's position between its neighbours. */
export function clampPos(pts: ReadonlyArray<AutoPoint>, i: number, pos: number, fixedEnd: boolean): number {
  if (i === 0) return 0;
  const lo = pts[i - 1].pos;
  const hi = i === pts.length - 1 ? (fixedEnd ? pts[i].pos : Infinity) : pts[i + 1].pos;
  return Math.max(lo, Math.min(hi, pos));
}
