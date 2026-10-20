// Ogun's envelope editor curves (FL's TMEnvelope / TMLFO / TMMap as saved in OgEnv; the code is Harmor's
// src/ui/plugins/gen/harmor/curve.ts, copied so Ogun does not depend on Harmor's files): absolute point
// positions, segment shapes (FL's 13 point types, src/model/automation.ts curveShape) and the edits of FL's
// envelope editor (move / add / delete points, tension, point type, ADSR markers, flags). OgEnv.p rows are
// [dx, y, tension, type, arp break, b2, kind]: dx is the distance to the previous point (envelopes: 1.0 = 0.5 s or
// a beat when tempo-based; mappings: x positions 0..1 summing to 1). Edits return new curves (states are
// immutable values) and keep the fields they do not touch (the engine recomputes the point kind).


import { CURVE_TAG, curveShape, type CurveMode } from '../../../../model/automation';
import type { OgEnv } from '../../../../model/gen/plugins/ogun/types';

export type CurveKind = 'env' | 'lfo' | 'map';

export const MODE_OF_TAG: CurveMode[] = (() => {
  const out: CurveMode[] = [];
  for (const [m, t] of Object.entries(CURVE_TAG)) out[t] = m as CurveMode;
  return out;
})();

/** Curve kind from FL's saved type (1 envelope, 2 LFO, 3 mapping). */
export function kindOf(e: OgEnv): CurveKind {
  return e.t === 2 ? 'lfo' : e.t === 3 ? 'map' : 'env';
}

/** OgEnv.m indices. */
export const M_FLAGS = 0, M_ENABLED = 1, M_DECAY = 2, M_LOOP = 3, M_SUSTAIN = 4;
/** OgEnv.m[0] flags (FL's ME_TempoBased, ME_Global, ME_UnipolarTension, ME_Frozen). */
export const F_TEMPO = 1, F_GLOBAL = 2, F_UNIPOLAR = 4, F_FROZEN = 8;

export interface Pt {
  x: number;
  y: number;
  /** Tension of the segment ending at this point (-1..1). */
  t: number;
  /** FL point type 0..12 (CURVE_TAG). */
  seg: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Points with absolute x. */
export function points(e: OgEnv): Pt[] {
  let x = 0;
  return e.p.map((q, i) => {
    x += i === 0 ? Math.max(0, q[0] ?? 0) : Math.max(0, q[0] ?? 0);
    return { x, y: q[1] ?? 0, t: q[2] ?? 0, seg: (q[3] ?? 0) | 0 };
  });
}

/** Total length (sum of dx). */
export function length(e: OgEnv): number {
  let s = 0;
  for (const q of e.p) s += Math.max(0, q[0] ?? 0);
  return s;
}

/** Shape of the segment ending at point b for u in 0..1 (FL's point types; Smooth drawn as an isolated smoothstep). */
export function shape(b: Pt, u: number): number {
  const mode = MODE_OF_TAG[b.seg] ?? 'single';
  return curveShape(mode, u, b.t);
}

/** Level of the curve at absolute x (before the first point: its level; after the last: the last level). */
export function valueAt(pts: Pt[], x: number): number {
  if (pts.length === 0) return 0;
  if (x <= pts[0].x) return clamp01(pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (x <= b.x) {
      const span = b.x - a.x;
      const u = span > 0 ? (x - a.x) / span : 1;
      return clamp01(a.y + (b.y - a.y) * shape(b, u));
    }
  }
  return clamp01(pts[pts.length - 1].y);
}

/** Sampled polyline of segment i (from point i-1 to i) for drawing. */
export function segmentSamples(pts: Pt[], i: number, n = 24): [number, number][] {
  const a = pts[i - 1], b = pts[i];
  const out: [number, number][] = [];
  const mode = MODE_OF_TAG[b.seg] ?? 'single';
  const stepped = mode === 'hold' || mode === 'stairs' || mode === 'smoothStairs' || mode === 'pulse' || mode === 'wave';
  const m = stepped ? Math.max(n, 160) : n;
  for (let k = 0; k <= m; k++) {
    const u = k / m;
    out.push([a.x + (b.x - a.x) * u, clamp01(a.y + (b.y - a.y) * shape(b, u))]);
  }
  if (mode === 'hold') out.push([b.x, clamp01(b.y)]);
  return out;
}

// ------------------------------------------------------------------ edits

function row(q: number[] | undefined): number[] {
  const r = (q ?? [0, 0]).slice();
  while (r.length < 2) r.push(0);
  return r;
}

function withP(e: OgEnv, p: number[][]): OgEnv {
  return { ...e, p };
}

function setIdx(r: number[], i: number, v: number): void {
  while (r.length <= i) r.push(0);
  r[i] = v;
}

/** Shift marker indices after inserting (d = +1 at index i) or deleting (d = -1 at index i). */
function shiftMarkers(m: number[], i: number, d: 1 | -1): number[] {
  const out = m.slice();
  for (const k of [M_DECAY, M_LOOP, M_SUSTAIN]) {
    const v = out[k];
    if (v < 0) continue;
    if (d < 0 && v === i) out[k] = -1;
    else if (v >= i) out[k] = v + d;
  }
  return out;
}

export interface MoveOpts {
  /** Mappings: the first and last points keep x = 0 / 1. */
  kind: CurveKind;
  /** Envelopes: following points move along (FL's Slide switch, on by default). */
  slide?: boolean;
  /** Lock axes (FL: Shift locks vertical, Ctrl locks horizontal movement). */
  lockX?: boolean;
  lockY?: boolean;
  /** Snap x to a grid step (envelope units). */
  snap?: number;
}

/** Move point i to absolute (x, y). */
export function movePoint(e: OgEnv, i: number, x: number, y: number, o: MoveOpts): OgEnv {
  const pts = points(e);
  const p = e.p.map(row);
  if (!p[i]) return e;
  if (!o.lockY) setIdx(p[i], 1, clamp01(y));
  if (!o.lockX && i > 0) {
    let nx = Math.max(pts[i - 1].x, x);
    if (o.snap && o.snap > 0) nx = Math.max(pts[i - 1].x, Math.round(nx / o.snap) * o.snap);
    if (o.kind === 'map') {
      if (i === p.length - 1) nx = 1;
      else nx = Math.min(nx, pts[i + 1].x, 1);
    } else if (!o.slide && i + 1 < pts.length) {
      nx = Math.min(nx, pts[i + 1].x);
    }
    const old = pts[i].x;
    setIdx(p[i], 0, nx - pts[i - 1].x);
    if (i + 1 < p.length && (o.kind === 'map' || !o.slide)) setIdx(p[i + 1], 0, Math.max(0, pts[i + 1].x - nx));
    void old;
  }
  return withP(e, p);
}

/** Insert a point at absolute (x, y); returns the curve and the new point's index. */
export function addPoint(e: OgEnv, x: number, y: number, kind: CurveKind): { e: OgEnv; i: number } {
  const pts = points(e);
  const p = e.p.map(row);
  const last = pts[pts.length - 1];
  if (kind === 'map') x = Math.min(1, Math.max(0, x));
  let i = pts.findIndex((q) => q.x > x);
  if (i <= 0) {
    if (i === 0) i = 1; // never before the first point
    else i = pts.length; // after the last point
  }
  if (kind === 'map' && i >= pts.length) i = pts.length - 1;
  const prevX = pts[i - 1]?.x ?? 0;
  const nx = Math.max(prevX, i < pts.length ? Math.min(x, pts[i].x) : x);
  const seg = i < pts.length ? pts[i].seg : (last?.seg ?? 0);
  const r = [nx - prevX, clamp01(y), 0, seg];
  if (i < p.length) setIdx(p[i], 0, Math.max(0, pts[i].x - nx));
  p.splice(i, 0, r);
  return { e: { ...e, p, m: shiftMarkers(e.m, i, 1) }, i };
}

/** Delete point i (the first point stays; mappings keep their two end points). */
export function deletePoint(e: OgEnv, i: number, kind: CurveKind): OgEnv {
  if (i <= 0 || i >= e.p.length) return e;
  if (kind === 'map' && (i === e.p.length - 1 || e.p.length <= 2)) return e;
  const p = e.p.map(row);
  const dx = p[i][0];
  if (i + 1 < p.length) setIdx(p[i + 1], 0, p[i + 1][0] + dx);
  p.splice(i, 1);
  return { ...e, p, m: shiftMarkers(e.m, i, -1) };
}

/** Tension of the segment ending at point i (-1..1). */
export function setTension(e: OgEnv, i: number, t: number): OgEnv {
  if (i <= 0 || i >= e.p.length) return e;
  const p = e.p.map(row);
  setIdx(p[i], 2, Math.max(-1, Math.min(1, t)));
  return withP(e, p);
}

/** Point type of the segment ending at point i. */
export function setSeg(e: OgEnv, i: number, seg: number): OgEnv {
  if (i <= 0 || i >= e.p.length) return e;
  const p = e.p.map(row);
  setIdx(p[i], 2, p[i][2] ?? 0);
  setIdx(p[i], 3, seg);
  return withP(e, p);
}

/** Set (or clear when already set) marker k (M_DECAY / M_LOOP / M_SUSTAIN) on point i. */
export function toggleMarker(e: OgEnv, k: number, i: number): OgEnv {
  const m = e.m.slice();
  m[k] = m[k] === i ? -1 : i;
  return { ...e, m };
}

export function setFlag(e: OgEnv, bit: number, on: boolean): OgEnv {
  const m = e.m.slice();
  m[M_FLAGS] = on ? (m[M_FLAGS] | bit) : (m[M_FLAGS] & ~bit);
  return { ...e, m };
}

export function hasFlag(e: OgEnv, bit: number): boolean {
  return (e.m[M_FLAGS] & bit) !== 0;
}

/** FL stores the envelope / LFO enable switch as a LongBool: -1 on, 0 off. */
export function isEnabled(e: OgEnv): boolean {
  return (e.m[M_ENABLED] | 0) !== 0;
}

export function setEnabled(e: OgEnv, on: boolean): OgEnv {
  const m = e.m.slice();
  m[M_ENABLED] = on ? -1 : 0;
  return { ...e, m };
}

/** Flip levels vertically. */
export function flip(e: OgEnv): OgEnv {
  return withP(e, e.p.map((q) => { const r = row(q); r[1] = 1 - r[1]; return r; }));
}

/** Point index nearest to (x, y) in screen pixels within `radius`, or -1. */
export function hitPoint(pts: Pt[], px: (x: number) => number, py: (y: number) => number, mx: number, my: number, radius = 6): number {
  let best = -1, bd = radius * radius;
  pts.forEach((q, i) => {
    const dx = px(q.x) - mx, dy = py(q.y) - my;
    const d = dx * dx + dy * dy;
    if (d <= bd) { bd = d; best = i; }
  });
  return best;
}

/** Tension handle of segment i (midpoint of the drawn segment). */
export function handlePos(pts: Pt[], i: number): [number, number] {
  const a = pts[i - 1], b = pts[i];
  return [(a.x + b.x) / 2, clamp01(a.y + (b.y - a.y) * shape(b, 0.5))];
}

/** Is the curve a valid OgEnv for the state's normalisation (state.ts envOk)? */
export function validCurve(e: OgEnv): boolean {
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!num(e.t) || !Array.isArray(e.m) || e.m.length !== 5 || !e.m.every(num)) return false;
  if (!Array.isArray(e.p) || e.p.length === 0 || e.p.length > 4096) return false;
  return e.p.every((q) => Array.isArray(q) && q.length >= 2 && q.length <= 7 && q.every(num));
}

// ------------------------------------------------------------------- LFO

/**
 * One LFO cycle shape for drawing (FL's TMLFO oscillator: a triangle with
 * skew, pulse width and tension, src/engine/gen/plugins/sytrus/env.ts
 * LfoShape): value -1..1 at phase 0..1 starting at the rising zero crossing.
 */
export function lfoValue(phase: number, tension: number, skew: number, pw: number): number {
  const s9 = pw / 128, s8 = skew / 256;
  const end = s9 > 0 ? 1 - s9 : 1;
  const s2 = s8 * (1 - Math.abs(s9));
  let peak = (1 - s9) * 0.5 - s2;
  peak = Math.min(end - 1e-6, Math.max(1e-6, peak));
  const flat = s9 >= 0 ? peak : Math.max(1e-6, peak + s9);
  const tt = Math.abs(tension) / 128;
  let v = (Math.exp(tt * 3.044522437723423) - 1) * 0.05;
  v = Math.exp(v * 41.446531658199575) - 1;
  const k = tension === 0 ? 0 : tension < 0 ? -v : v;
  const curve = (x: number) => {
    if (k === 0) return x;
    const a = 1 / Math.abs(k), b = Math.log(Math.abs(k) + 1);
    return k > 0 ? 1 - (Math.exp((1 - x) * b) - 1) * a : (Math.exp(x * b) - 1) * a;
  };
  // start at the rising zero crossing like FL's startPhase
  const start = peak + (end - peak) / 2;
  let ph = (phase + start) % 1;
  if (ph < 0) ph += 1;
  let s: number;
  if (ph > end) return 1;
  if (ph < flat) s = 1 - (ph / flat) * 2;
  else if (ph < peak) return -1;
  else s = ((ph - peak) / (end - peak)) * 2 - 1;
  const y = curve(Math.abs(s));
  return s < 0 ? -y : y;
}
