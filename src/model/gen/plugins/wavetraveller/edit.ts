// Wave Traveller's spline editing (FL's TCSplnCtrl, CWWarper editor handlers) as pure functions on the model: hit
// testing and dragging of points / Bezier handles / the Tension handle, inserting and deleting points, the snap
// grid, Normalize 100 / 50 %, the mutes strip. See docs/research/gen/wavetraveller.md.

import {
  WT_BEZIER, WT_TENSION, buildTable, newPoint, type WtMute, type WtPatch, type WtPoint,
} from './state';

const f32 = Math.fround;

/** FL's spline editor area (SplineEditorPaintBox) and mutes strip (MutePaintBox). */
export const SPLINE_W = 400;
export const SPLINE_H = 210;
/** The editor's coordinate steps: pixel columns / rows minus one. */
const PX_X = SPLINE_W - 1;
const PX_Y = SPLINE_H - 1;
/** One pixel in time (FL keeps points 1 pixel apart). */
export const PIXEL = 1 / PX_X;

/** Hit radius in pixels. */
export const HIT = 4;

/** Snap grid divisions per beat for the snap menu entries Off, 1/16, 1/12, 1/8, 1/6, 1/4, 1/3 (Off = the Alt-held grid). */
export const SNAP_DIV = [4, 16, 12, 8, 6, 4, 3] as const;
export const SNAP_NAMES = ['Off', '1/16', '1/12', '1/8', '1/6', '1/4', '1/3'] as const;

/** What a drag moves: the point, its incoming (left) / outgoing (right) Bezier handle, or the Tension handle. */
export type DragMode = 0 | 1 | 2 | 3;
export interface Hit { index: number; mode: DragMode }

/** Normalised (time, value) -> editor pixel (value 1 at the top). */
export const toPx = (x: number, y: number): [number, number] => [Math.round(x * PX_X), Math.round((1 - y) * PX_Y)];

/** Editor pixel -> normalised (time, value). */
export const fromPx = (px: number, py: number): [number, number] => [px / PX_X, 1 - py / PX_Y];

/** Screen position of a point's incoming handle (FL draws the handle at point + h; the curve's control point is point + 3 h). */
export function handlePos(p: WtPoint, which: 1 | 2): [number, number] {
  return toPx(p.x + (which === 1 ? p.h1x : p.h2x), p.y + (which === 1 ? p.h1y : p.h2y));
}

/** Screen position of segment i's Tension handle (the segment's middle, y0 + T dy). */
export function tensionPos(pts: readonly WtPoint[], i: number): [number, number] {
  const a = pts[i];
  const b = pts[i + 1];
  return toPx((a.x + b.x) * 0.5, a.y + a.tension * (b.y - a.y));
}

/** The point / handle under the mouse (pixels), FL's order: per point its body, Tension handle, incoming and outgoing Bezier handles. */
export function hitTest(pts: readonly WtPoint[], mx: number, my: number): Hit | null {
  const near = (p: [number, number]) => Math.abs(mx - p[0]) <= HIT && Math.abs(my - p[1]) <= HIT;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (near(toPx(p.x, p.y))) return { index: i, mode: 0 };
    if (p.type === WT_TENSION && i + 1 < pts.length && near(tensionPos(pts, i))) return { index: i, mode: 3 };
    if (i > 0 && pts[i - 1].type === WT_BEZIER && near(handlePos(p, 1))) return { index: i, mode: 1 };
    if (p.type === WT_BEZIER && i + 1 < pts.length && near(handlePos(p, 2))) return { index: i, mode: 2 };
  }
  return null;
}

export interface DragOptions {
  /** Shift: keep the value (move in time only); Ctrl: keep the time (move in value only). Both: ignored. */
  shift: boolean;
  ctrl: boolean;
  /** Alt inverts the snap setting. */
  alt: boolean;
  /** Snap menu entry 0..6. */
  snap: number;
  /** The phrase length in beats (tempo mode) or 1 (absolute mode): the snap grid has beats x div cells. */
  beats: number;
}

const clampPx = (v: number, hi: number): number => Math.min(hi, Math.max(0, v));

/** Mouse pixel -> pixel snapped to the grid (when snapping): FL's cells (W-1) / (div x beats) wide, (H-1) / (4 div) high. */
function snapPx(mx: number, my: number, o: DragOptions): [number, number] {
  const on = (o.snap > 0) !== o.alt;
  if (!on) return [mx, my];
  const div = SNAP_DIV[Math.min(6, Math.max(0, o.snap))];
  const sx = PX_X / (div * Math.max(1e-6, o.beats));
  const sy = PX_Y / (div * 4);
  return [Math.round(Math.round(mx / sx) * sx), Math.round(Math.round(my / sy) * sy)];
}

/**
 * Move what a drag grabbed to the mouse (pixels): the point (end points only in value, others keep 1 pixel from
 * their neighbours), a handle (kept on its side of the point; a locked point mirrors the other handle) or the
 * Tension handle (T = (y - y0) / dy within 0.001..0.999). `start` is the point's value at the start of the drag
 * (for the Shift / Ctrl locks).
 */
export function applyDrag(pts: WtPoint[], hit: Hit, mx: number, my: number, o: DragOptions, start?: { x: number; y: number }): void {
  const i = hit.index;
  const p = pts[i];
  if (!p) return;
  let [px, py] = [clampPx(mx, PX_X), clampPx(my, PX_Y)];
  const lock = o.shift !== o.ctrl;
  if (hit.mode === 0) {
    [px, py] = snapPx(px, py, o);
    let [x, y] = fromPx(px, py);
    if (lock) {
      const s = start ?? { x: p.x, y: p.y };
      if (o.shift) y = s.y; else x = s.x;
    }
    y = f32(Math.min(1, Math.max(0, y)));
    if (i === 0 || i === pts.length - 1) { p.y = y; return; }
    const prev = pts[i - 1];
    const next = pts[i + 1];
    if (x > prev.x && x < next.x) { p.x = f32(x); p.y = y; return; }
    p.y = y;
    p.x = f32(x <= prev.x ? prev.x + PIXEL : next.x - PIXEL);
    return;
  }
  const [x, y] = fromPx(px, py);
  if (hit.mode === 1) {
    p.h1x = f32(x - p.x); p.h1y = f32(y - p.y);
    if (!(p.h1x < 0)) p.h1x = f32(-PIXEL);
    if (p.locked) { p.h2x = f32(-p.h1x); p.h2y = f32(-p.h1y); }
  } else if (hit.mode === 2) {
    p.h2x = f32(x - p.x); p.h2y = f32(y - p.y);
    if (!(p.h2x > 0)) p.h2x = f32(PIXEL);
    if (p.locked) { p.h1x = f32(-p.h2x); p.h1y = f32(-p.h2y); }
  } else {
    const q = pts[i + 1];
    if (!q) return;
    let t = f32((y - p.y) / (q.y - p.y));
    if (!(t >= 0.001)) t = f32(0.001);
    else if (t > 0.999) t = f32(0.999);
    p.tension = t;
  }
}

/**
 * Insert a point at the mouse (pixels) unless it is on the border (FL: strictly inside the area): the point
 * takes the page's last chosen type, is locked and has FL's default handles. Returns its index or -1.
 */
export function addPointAt(pts: WtPoint[], mx: number, my: number, type: number, o: DragOptions): number {
  if (!(mx > 0 && mx < PX_X && my > 0 && my < PX_Y)) return -1;
  const [sx, sy] = snapPx(mx, my, o);
  const [x, y] = fromPx(sx, sy);
  let at = 0;
  for (let i = 0; i < pts.length; i++) if (pts[i].x > x) { at = i; break; }
  pts.splice(at, 0, newPoint(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), type, true));
  return at;
}

/** Delete a point (never the first or the last). */
export function deletePoint(pts: WtPoint[], i: number): boolean {
  if (i <= 0 || i >= pts.length - 1) return false;
  pts.splice(i, 1);
  return true;
}

/**
 * Normalize 100 % (NoteSelectorNormalize100MenuItemClick 0x5fa40) of the WAVE spline: the curve's value range is
 * stretched to 0..1 and START / END move to the part of the sample the curve really covers, so the sound stays.
 * Returns false when the curve is flat.
 */
export function normalize100(p: WtPatch): boolean {
  const { min, max } = buildTable(p.wave, new Float32Array(1024));
  if (max - min === 0) return false;
  const span = f32(p.end - p.start);
  const k = f32(1 / f32(max - min));
  for (const q of p.wave) {
    q.y = f32(f32(q.y - min) * k);
    q.h1y = f32(q.h1y * k);
    q.h2y = f32(q.h2y * k);
  }
  let s = f32(p.start + f32(span * min));
  if (!(s >= 0)) s = 0;
  let e = f32(p.start + f32(span * max));
  if (e > 1) e = 1;
  p.start = s;
  p.end = e;
  return true;
}

/** Normalize 50 % (0x627f0): the curve's value range is scaled to 0.25..0.75 (START / END unchanged). */
export function normalize50(p: WtPatch): boolean {
  const { min, max } = buildTable(p.wave, new Float32Array(1024));
  if (max - min === 0) return false;
  const k = f32(0.5 / f32(max - min));
  for (const q of p.wave) {
    q.y = f32(f32(f32(q.y - min) * k) + 0.25);
    q.h1y = f32(q.h1y * k);
    q.h2y = f32(q.h2y * k);
  }
  return true;
}

/** The mutes as spans [from, to, on] covering 0..1 (the state before the first entry is on). */
function muteSpans(m: readonly WtMute[]): [number, number, number][] {
  const sorted = [...m].sort((a, b) => a[1] - b[1]);
  const spans: [number, number, number][] = [];
  let t = 0;
  let on = 1;
  for (const [o, at] of sorted) {
    if (at > t) { spans.push([t, at, on]); t = at; }
    on = o ? 1 : 0;
  }
  spans.push([t, Math.max(t, 1), on]);
  return spans;
}

/** Paint the mutes strip: the phrase from t0 to t1 becomes muted (on = 0) or active (on = 1). */
export function paintMutes(m: readonly WtMute[], t0: number, t1: number, on: number): WtMute[] {
  const a = Math.max(0, Math.min(t0, t1));
  const b = Math.min(1, Math.max(t0, t1));
  const out: [number, number, number][] = [];
  for (const [f, t, s] of muteSpans(m)) {
    if (t <= a || f >= b) { out.push([f, t, s]); continue; }
    if (f < a) out.push([f, a, s]);
    if (t > b) out.push([b, t, s]);
  }
  out.push([a, b, on ? 1 : 0]);
  out.sort((x, y) => x[0] - y[0]);
  const res: WtMute[] = [];
  let prev = -1;
  for (const [f, , s] of out) {
    if (s === prev) continue;
    res.push([s, f32(res.length ? f : 0)]);
    prev = s;
  }
  return res.length ? res : [[1, 0]];
}

/** Whether the phrase is active (not muted) at t. */
export function mutedAt(m: readonly WtMute[], t: number): boolean {
  let on = 1;
  for (const [o, at] of [...m].sort((x, y) => x[1] - y[1])) { if (at > t) break; on = o ? 1 : 0; }
  return on === 0;
}
