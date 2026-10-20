// Pure edit operations on Sytrus curves (SyEnv: points [dt, y, tension, seg?,
// arp?, flag?], markers m = [flags, enabled, decay, loop, sustain]) used by the
// articulator editor. dt is the time since the previous point (1.0 = 0.5 s).

import type { SyEnv } from '../../../../model/gen/plugins/sytrus/types';

export type CurveKind = 'env' | 'lfo' | 'map';

/** Marker slots in SyEnv.m. */
export const M_DECAY = 2, M_LOOP = 3, M_SUS = 4;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function cloneEnv(e: SyEnv): SyEnv {
  const out: SyEnv = { p: e.p.map((q) => q.slice()), m: e.m.slice() };
  if (e.ph !== undefined) out.ph = e.ph;
  return out;
}

/** Absolute time of every point. */
export function timesOf(e: SyEnv): number[] {
  const t: number[] = [];
  let s = 0;
  e.p.forEach((q, i) => { s += i === 0 ? 0 : Math.max(0, q[0] ?? 0); t.push(s); });
  return t;
}

export function totalOf(e: SyEnv): number {
  const t = timesOf(e);
  return t[t.length - 1] ?? 0;
}

/**
 * Move point i to absolute time `t` and level `y`. Point 0 stays at time 0.
 * `slide`: the following points move along; otherwise they keep their times
 * (the point stays between its neighbours). Maps keep their first and last
 * points at x = 0 and the map's end.
 */
export function movePoint(e: SyEnv, i: number, t: number, y: number, slide: boolean, kind: CurveKind): SyEnv {
  const out = cloneEnv(e);
  const P = out.p, n = P.length;
  if (i < 0 || i >= n) return e;
  P[i][1] = clamp(y, 0, 1);
  if (i === 0 || (kind === 'map' && i === n - 1)) return out;
  const T = timesOf(e);
  const prev = T[i - 1];
  const noSlide = !slide || kind === 'map';
  const hi = noSlide && i + 1 < n ? T[i + 1] : Infinity;
  const nt = clamp(t, prev, hi);
  P[i][0] = nt - prev;
  if (noSlide && i + 1 < n) P[i + 1][0] = T[i + 1] - nt;
  return out;
}

/** Insert a point at absolute time t (after the points at or before t); returns its index. */
export function insertPoint(e: SyEnv, t: number, y: number): { env: SyEnv; index: number } {
  const out = cloneEnv(e);
  const T = timesOf(e);
  let k = T.length;
  for (let i = 1; i < T.length; i++) if (T[i] > t) { k = i; break; }
  if (k === 0) k = 1;
  const prev = T[k - 1];
  const nt = Math.max(prev, t);
  const pt = [nt - prev, clamp(y, 0, 1), 0];
  if (k < out.p.length) out.p[k][0] = Math.max(0, T[k] - nt);
  out.p.splice(k, 0, pt);
  for (const s of [M_DECAY, M_LOOP, M_SUS]) if (out.m[s] >= k) out.m[s] += 1;
  return { env: out, index: k };
}

/** Delete point i (not the first; a curve keeps at least 2 points); the following points keep their times. */
export function deletePoint(e: SyEnv, i: number): SyEnv {
  if (i <= 0 || i >= e.p.length || e.p.length <= 2) return e;
  const out = cloneEnv(e);
  const dt = out.p[i][0];
  if (i + 1 < out.p.length) out.p[i + 1][0] += dt;
  out.p.splice(i, 1);
  for (const s of [M_DECAY, M_LOOP, M_SUS]) {
    if (out.m[s] === i) out.m[s] = -1;
    else if (out.m[s] > i) out.m[s] -= 1;
  }
  return out;
}

/** Set field f of point i (2 tension, 3 segment type), keeping the optional trailing fields. */
export function setPointField(e: SyEnv, i: number, f: 2 | 3, v: number): SyEnv {
  const out = cloneEnv(e);
  const q = out.p[i];
  if (!q) return e;
  while (q.length <= f) q.push(0);
  q[f] = v;
  if (q.length > 3 && !q[3] && !q[4] && !q[5]) q.length = 3;
  return out;
}

/** Toggle a section marker (decay / loop start / sustain) on point i. */
export function toggleMarker(e: SyEnv, slot: number, i: number): SyEnv {
  const out = cloneEnv(e);
  out.m[slot] = out.m[slot] === i ? -1 : i;
  return out;
}

export function setFlag(e: SyEnv, bit: number, on: boolean): SyEnv {
  const out = cloneEnv(e);
  out.m[0] = on ? (out.m[0] | bit) : (out.m[0] & ~bit);
  return out;
}

/** ENV / LFO enabled flag (FL's LongBool: -1 = on). */
export const isEnabled = (e: SyEnv) => (e.m[1] | 0) !== 0;

export function setEnabled(e: SyEnv, on: boolean): SyEnv {
  const out = cloneEnv(e);
  out.m[1] = on ? -1 : 0;
  return out;
}

export function flipEnv(e: SyEnv): SyEnv {
  const out = cloneEnv(e);
  for (const q of out.p) q[1] = clamp(1 - q[1], 0, 1);
  return out;
}

export function sameEnv(a: SyEnv, b: SyEnv): boolean {
  return JSON.stringify(a.p) === JSON.stringify(b.p) && a.m.join() === b.m.join() && (a.ph ?? 0) === (b.ph ?? 0);
}
