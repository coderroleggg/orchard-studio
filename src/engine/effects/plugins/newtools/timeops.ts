// Newtime marker edits as pure functions: add a warp marker where the
// output is clicked (its source position read through the current warp),
// remove, move (clamped between the neighbours so the warp stays
// monotonic), move a region (the markers on both sides), change the type
// (downbeat is unique), snap the downbeat to a bar, and copy the marker
// pattern of one bar to all bars.

import { TimeMap } from './psola';
import { MK_DOWNBEAT, MK_GROOVE, MK_WARP, beatLen, gridOrigin, markerPos, timeAnchors, type NtmMarker, type TimeKnobs } from './timemodel';

export const MIN_GAP_SEC = 0.004;

/** The current warp as a map (output position <-> source position). */
export function warpMap(markers: readonly NtmMarker[], k: TimeKnobs, srcLen: number, bpm: number, sr: number): TimeMap {
  const a = timeAnchors(markers, k, srcLen, bpm, sr);
  return new TimeMap(a.map((p) => [p.dst, p.src] as [number, number]));
}

export function sortMarkers(markers: readonly NtmMarker[]): NtmMarker[] {
  return markers.slice().sort((a, b) => a.src - b.src);
}

/** Add a warp marker at output position `at`. */
export function addMarker(markers: readonly NtmMarker[], at: number, k: TimeKnobs, srcLen: number, bpm: number, sr: number, id: number): NtmMarker[] | null {
  const map = warpMap(markers, k, srcLen, bpm, sr);
  const src = Math.round(map.srcAt(at));
  const gap = MIN_GAP_SEC * sr;
  if (src < gap || src > srcLen - gap) return null;
  if (markers.some((m) => Math.abs(m.src - src) < gap)) return null;
  return sortMarkers([...markers, { id, src, dst: Math.round(at), type: MK_WARP }]);
}

export function removeMarkers(markers: readonly NtmMarker[], ids: ReadonlySet<number>): NtmMarker[] {
  return markers.filter((m) => !ids.has(m.id));
}

/** Room for a marker's effective position: between its neighbours (and the sample ends). */
function bounds(ms: readonly NtmMarker[], i: number, k: TimeKnobs, srcLen: number, bpm: number, sr: number, skip?: ReadonlySet<number>): [number, number] {
  const gap = MIN_GAP_SEC * sr;
  let lo = gap, hi = srcLen - gap;
  for (let j = i - 1; j >= 0; j--) { if (skip?.has(ms[j].id)) continue; lo = markerPos(ms[j], k, bpm, sr) + gap; break; }
  for (let j = i + 1; j < ms.length; j++) { if (skip?.has(ms[j].id)) continue; hi = markerPos(ms[j], k, bpm, sr) - gap; break; }
  return [lo, hi];
}

/** Move marker `id` so its effective output position becomes `pos` (clamped). */
export function moveMarker(orig: readonly NtmMarker[], id: number, pos: number, k: TimeKnobs, srcLen: number, bpm: number, sr: number): NtmMarker[] {
  const ms = sortMarkers(orig);
  const i = ms.findIndex((m) => m.id === id);
  if (i < 0) return ms;
  const m = ms[i];
  const [lo, hi] = bounds(ms, i, k, srcLen, bpm, sr);
  const eff = Math.max(lo, Math.min(hi, pos));
  // the stored position (and a groove marker's template position) move by
  // the same amount, so the effective position lands exactly on `eff`
  const delta = eff - markerPos(m, k, bpm, sr);
  const moved = { ...m, dst: Math.round(m.dst + delta), g: m.g !== undefined ? Math.round(m.g + delta) : undefined };
  return ms.map((q, j) => (j === i ? moved : q));
}

/** Move several markers together by `delta` (a region between markers). */
export function moveMarkers(orig: readonly NtmMarker[], ids: ReadonlySet<number>, delta: number, k: TimeKnobs, srcLen: number, bpm: number, sr: number): NtmMarker[] {
  const ms = sortMarkers(orig);
  let d = delta;
  // the group may not cross the markers around it
  for (let i = 0; i < ms.length; i++) {
    if (!ids.has(ms[i].id)) continue;
    const [lo, hi] = bounds(ms, i, k, srcLen, bpm, sr, ids);
    const p = markerPos(ms[i], k, bpm, sr);
    d = Math.max(lo - p, Math.min(hi - p, d));
  }
  return ms.map((m) => (ids.has(m.id) ? { ...m, dst: Math.round(m.dst + d), g: m.g !== undefined ? Math.round(m.g + d) : undefined } : m));
}

/** Set a marker's type; a second downbeat turns the old one into a warp marker. Same type again = warp. */
export function setMarkerType(markers: readonly NtmMarker[], id: number, type: number): NtmMarker[] {
  return markers.map((m) => {
    if (m.id === id) {
      const t = m.type === type ? MK_WARP : type;
      return { ...m, type: t, g: t === MK_GROOVE ? m.g ?? m.dst : undefined };
    }
    if (type === MK_DOWNBEAT && m.type === MK_DOWNBEAT) return { ...m, type: MK_WARP };
    return m;
  });
}

/** Move the downbeat marker onto the nearest bar line. */
export function snapDownbeat(markers: readonly NtmMarker[], k: TimeKnobs, srcLen: number, bpm: number, sr: number): NtmMarker[] {
  const d = markers.find((m) => m.type === MK_DOWNBEAT);
  if (!d) return markers.slice();
  const bar = 4 * beatLen(bpm, sr);
  return moveMarker(markers, d.id, Math.round(d.dst / bar) * bar, k, srcLen, bpm, sr);
}

/**
 * Copy the marker pattern of the bar containing output range [a, b) to every
 * bar: markers elsewhere within 1/4 beat of a pattern position move onto it.
 */
export function applyPatternToAll(markers: readonly NtmMarker[], a: number, b: number, k: TimeKnobs, srcLen: number, bpm: number, sr: number): NtmMarker[] {
  const bl = beatLen(bpm, sr), bar = 4 * bl;
  const o = gridOrigin(markers, bpm, sr);
  const inSel = markers.filter((m) => m.dst >= a && m.dst < b);
  if (!inSel.length) return markers.slice();
  const offs = inSel.map((m) => ((((m.dst - o) % bar) + bar) % bar));
  let ms = sortMarkers(markers);
  for (const m of ms.slice()) {
    if (m.dst >= a && m.dst < b) continue;
    if (m.type === MK_DOWNBEAT) continue;
    const barStart = o + Math.floor((m.dst - o) / bar) * bar;
    let best = NaN, bd = bl / 4;
    for (const off of offs) {
      for (const t of [barStart + off - bar, barStart + off, barStart + off + bar]) {
        const dd = Math.abs(t - m.dst);
        if (dd < bd) { bd = dd; best = t; }
      }
    }
    if (Number.isFinite(best)) ms = moveMarker(ms, m.id, best, k, srcLen, bpm, sr);
  }
  return ms;
}

/** Marker colours (FL's screenshot): warp, downbeat, groove, shift. */
export const MARKER_COLORS = ['#fcd484', '#d9fc84', '#fcfc0c', '#0cd4fc'];
export const MARKER_NAMES = ['Warp marker', 'Downbeat marker', 'Groove marker', 'Shift marker'];
