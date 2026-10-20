// Edits of an articulator curve (FL's TMEnvelope / TMLFO / TMMap as Slicex stores them, SxCurve): points
// [dx, level, tension, type, arpeggio, flags, sign], markers m = [flags (bit 0 tempo, bit 1 global, bit 2
// bipolar LFO tension, bit 3 frozen LFO), enabled (-1 / 0), decay, loop start, sustain]. Pure functions
// returning new curves, as FL's envelope editor edits them: the first point stays at time 0, a mapping's
// points stay inside 0..1 with its ends pinned, Slide moves the following points along.

import type { SxCurve } from '../../../../model/gen/plugins/slicex/types';

export const T_ENV = 1, T_LFO = 2, T_MAP = 3;
export const isMap = (c: SxCurve) => c.t === T_MAP;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function cloneCurve(c: SxCurve): SxCurve {
  const o: SxCurve = { t: c.t, p: c.p.map((q) => q.slice()), m: c.m.slice() };
  if (c.a) o.a = c.a.slice();
  if (c.l) o.l = c.l.slice();
  if (c.ph !== undefined) o.ph = c.ph;
  return o;
}

/** Absolute position of every point. */
export function timesOf(c: SxCurve): number[] {
  let t = 0;
  return c.p.map((q, i) => (t += i === 0 ? 0 : Math.max(0, q[0] ?? 0)));
}

/** FL's cached sign byte of a point (+0x13): 2 for a flat curve, 1 positive, 255 (-1) negative tension. */
export function signByte(tension: number, type: number): number {
  const curve = type < 2 || (type >= 7 && type <= 9) || type === 11 || type === 12;
  if (tension === 0) return curve ? 2 : 0;
  return tension > 0 ? 1 : 255;
}

function point(dx: number, level: number, tension: number, type: number): number[] {
  return [Math.fround(Math.max(0, dx)), Math.fround(clamp(level, 0, 1)), Math.fround(clamp(tension, -1, 1)), type, 0, 0, signByte(tension, type)];
}

/** Rebuild dx from absolute positions (keeps p[0][0] = 0). */
function withTimes(c: SxCurve, t: number[]): SxCurve {
  const o = cloneCurve(c);
  o.p.forEach((q, i) => { q[0] = i === 0 ? 0 : Math.fround(Math.max(0, t[i] - t[i - 1])); });
  return o;
}

/**
 * Move point i to position `pos` (time units, or 0..1 on a mapping) and `level`. With `slide`, the
 * following points keep their distance (they move along); otherwise they stay and the point is kept
 * between its neighbours. The first point stays at 0 (and a mapping's last point at 1).
 */
export function movePoint(c: SxCurve, i: number, pos: number, level: number, slide: boolean): SxCurve {
  if (i < 0 || i >= c.p.length) return c;
  const t = timesOf(c);
  const n = t.length;
  const map = isMap(c);
  let np = pos;
  if (i === 0) np = 0;
  else if (map && i === n - 1) np = t[n - 1];
  else {
    const lo = t[i - 1];
    const hi = slide && !map ? Infinity : i + 1 < n ? t[i + 1] : map ? 1 : Infinity;
    np = clamp(np, lo, hi);
  }
  const d = np - t[i];
  const nt = t.map((x, j) => (j === i ? np : slide && !map && j > i ? x + d : x));
  const o = withTimes(c, nt);
  o.p[i][1] = Math.fround(clamp(level, 0, 1));
  o.p[i][6] = signByte(o.p[i][2], o.p[i][3]);
  return o;
}

/** Insert a point at `pos` / `level`; its segment takes the type of the segment it splits. */
export function insertPoint(c: SxCurve, pos: number, level: number): { curve: SxCurve; index: number } {
  const t = timesOf(c);
  const map = isMap(c);
  const p = map ? clamp(pos, 0, 1) : Math.max(0, pos);
  let i = t.findIndex((x) => x > p);
  if (i < 0) i = t.length;
  if (i === 0) i = 1;
  const type = c.p[Math.min(i, c.p.length - 1)]?.[3] ?? 0;
  const o = cloneCurve(c);
  const nt = [...t.slice(0, i), Math.max(t[i - 1] ?? 0, p), ...t.slice(i)];
  o.p.splice(i, 0, point(0, level, 0, type === 2 ? 0 : type));
  const r = withTimes(o, nt);
  for (let k = 2; k <= 4; k++) if (r.m[k] >= i) r.m[k]++;
  return { curve: r, index: i };
}

/** Delete points (never the first one, nor a mapping's last one); markers follow. */
export function deletePoints(c: SxCurve, idx: Iterable<number>): SxCurve {
  const map = isMap(c);
  const del = new Set([...idx].filter((i) => i > 0 && i < c.p.length && !(map && i === c.p.length - 1)));
  if (!del.size) return c;
  const t = timesOf(c);
  const keep = c.p.map((_, i) => i).filter((i) => !del.has(i));
  const o = cloneCurve(c);
  o.p = keep.map((i) => c.p[i].slice());
  const r = withTimes(o, keep.map((i) => t[i]));
  for (let k = 2; k <= 4; k++) {
    const m = c.m[k];
    if (m < 0) continue;
    if (del.has(m)) r.m[k] = -1;
    else r.m[k] = m - [...del].filter((d) => d < m).length;
  }
  return r;
}

export function setTension(c: SxCurve, i: number, tension: number): SxCurve {
  if (i <= 0 || i >= c.p.length) return c;
  const o = cloneCurve(c);
  o.p[i][2] = Math.fround(clamp(tension, -1, 1));
  o.p[i][6] = signByte(o.p[i][2], o.p[i][3]);
  return o;
}

export function setPointField(c: SxCurve, i: number, field: 3 | 4, v: number): SxCurve {
  if (i < 0 || i >= c.p.length) return c;
  const o = cloneCurve(c);
  o.p[i][field] = v & 0xff;
  if (field === 3) o.p[i][6] = signByte(o.p[i][2], v);
  return o;
}

/** Toggle a section marker at point i: 2 decay, 3 loop start, 4 sustain / loop end. */
export function toggleMarker(c: SxCurve, which: 2 | 3 | 4, i: number): SxCurve {
  const o = cloneCurve(c);
  o.m[which] = o.m[which] === i ? -1 : i;
  return o;
}

export function setFlag(c: SxCurve, bit: number, on: boolean): SxCurve {
  const o = cloneCurve(c);
  o.m[0] = on ? (o.m[0] | bit) : (o.m[0] & ~bit);
  return o;
}

export function setEnabled(c: SxCurve, on: boolean): SxCurve {
  const o = cloneCurve(c);
  o.m[1] = on ? -1 : 0;
  return o;
}

export const isEnabled = (c: SxCurve) => c.m[1] !== 0;

export function flipLevels(c: SxCurve, sel?: ReadonlySet<number>): SxCurve {
  const o = cloneCurve(c);
  o.p.forEach((q, i) => { if (!sel || !sel.size || sel.has(i)) { q[1] = Math.fround(1 - q[1]); q[2] = Math.fround(-q[2]); q[6] = signByte(q[2], q[3]); } });
  return o;
}

export function normalizeLevels(c: SxCurve): SxCurve {
  const lo = Math.min(...c.p.map((q) => q[1])), hi = Math.max(...c.p.map((q) => q[1]));
  if (!(hi - lo > 1e-6)) return c;
  const o = cloneCurve(c);
  o.p.forEach((q) => { q[1] = Math.fround((q[1] - lo) / (hi - lo)); });
  return o;
}

/** "Make all loop": the loop from the first point to the last. */
export function makeAllLoop(c: SxCurve): SxCurve {
  const o = cloneCurve(c);
  o.m[3] = 0;
  o.m[4] = o.p.length - 1;
  return o;
}

/** "Turn all points smooth" (type 10). */
export function allSmooth(c: SxCurve): SxCurve {
  const o = cloneCurve(c);
  o.p.forEach((q, i) => { if (i > 0) { q[3] = 10; q[6] = signByte(q[2], 10); } });
  return o;
}

/** "Prepare for smooth editing": every segment a plain single curve without tension. */
export function smoothReset(c: SxCurve): SxCurve {
  const o = cloneCurve(c);
  o.p.forEach((q, i) => { if (i > 0) { q[2] = 0; q[3] = 0; q[6] = 2; } });
  return o;
}

/** Copied points: positions relative to the first copied one. */
export interface CurveClip { pts: number[][]; span: number }

export function copyPoints(c: SxCurve, sel: ReadonlySet<number>): CurveClip | null {
  const idx = [...sel].filter((i) => i >= 0 && i < c.p.length).sort((a, b) => a - b);
  if (!idx.length) return null;
  const t = timesOf(c);
  const t0 = t[idx[0]];
  return { pts: idx.map((i) => [t[i] - t0, ...c.p[i].slice(1)]), span: t[idx[idx.length - 1]] - t0 };
}

/** Insert copied points at `pos` (paste insert: the following points move right by the clip's span; replace: the span's points go). */
export function pastePoints(c: SxCurve, clip: CurveClip, pos: number, replace: boolean): { curve: SxCurve; added: number[] } {
  const t = timesOf(c);
  const at = Math.max(0, pos);
  const gap = clip.span > 0 ? clip.span : 0.05;
  type P = { t: number; q: number[]; old: number };
  let pts: P[] = c.p.map((q, i) => ({ t: t[i], q: q.slice(), old: i }));
  if (replace) pts = pts.filter((x) => x.old === 0 || x.t < at || x.t > at + clip.span);
  else pts = pts.map((x) => (x.t >= at && x.old > 0 ? { ...x, t: x.t + gap } : x));
  const fresh: P[] = clip.pts.map((q) => ({ t: at + q[0], q: [0, ...q.slice(1)], old: -1 }));
  const all = [...pts, ...fresh].sort((a, b) => a.t - b.t || (a.old < 0 ? 1 : -1));
  const o = cloneCurve(c);
  o.p = all.map((x) => x.q);
  const r = withTimes(o, all.map((x) => x.t));
  const map = new Map(all.map((x, i) => [x.old, i] as [number, number]));
  for (let k = 2; k <= 4; k++) r.m[k] = c.m[k] >= 0 ? map.get(c.m[k]) ?? -1 : -1;
  return { curve: r, added: all.map((x, i) => (x.old < 0 ? i : -1)).filter((i) => i >= 0) };
}

/**
 * Step editing: the level `v` for the grid step [a, a + step) — a point at the step start (and one at
 * its end keeping the following level); `hold` (Shift: pulse lines) makes the segment a Hold.
 */
export function drawStep(c: SxCurve, a: number, step: number, v: number, hold: boolean): SxCurve {
  let cur = c;
  const find = (pos: number) => timesOf(cur).findIndex((x) => Math.abs(x - pos) < step * 1e-3);
  let i = find(a);
  if (i < 0) { const r = insertPoint(cur, a, v); cur = r.curve; i = r.index; }
  cur = movePoint(cur, i, a, v, false);
  if (hold && i > 0) cur = setPointField(cur, i, 3, 2);
  return cur;
}
