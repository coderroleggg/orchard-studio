// Newtone note edits as pure functions on note lists: pitch (snap to the
// nearest semitone / scale note, set a key, move by an amount), cut / join,
// delete, moving notes and note edges in time (notes adjacent in the source
// stay attached, so their neighbours stretch; gaps can shrink to nothing but
// notes never overlap), and quantising note starts to the time grid.

import { nearestNote, noteCenter, redescribe, sortedNotes, type DecodedAnalysis, type NtNote, type ToneKnobs } from './tonemodel';

/** Shortest note (samples) an edit may leave. */
export const MIN_NOTE = 256;

export function snapToNearest(notes: readonly NtNote[], ids: ReadonlySet<number>, k: ToneKnobs): NtNote[] {
  return notes.map((n) => (ids.has(n.id) ? { ...n, pt: nearestNote(noteCenter(n, k), k.scale) } : n));
}

export function setKey(notes: readonly NtNote[], ids: ReadonlySet<number>, key: number): NtNote[] {
  return notes.map((n) => (ids.has(n.id) ? { ...n, pt: key * 100 } : n));
}

/**
 * Move notes' pitch from their original centres by `cents`; `snap` rounds the
 * result to a semitone (or the scale), Alt-style free movement otherwise.
 */
export function movePitch(orig: readonly NtNote[], ids: ReadonlySet<number>, cents: number, k: ToneKnobs, snap: boolean): NtNote[] {
  return orig.map((n) => {
    if (!ids.has(n.id)) return n;
    const c = noteCenter(n, k) + cents;
    return { ...n, pt: Math.round((snap ? nearestNote(c, k.scale) : c) * 100) / 100 };
  });
}

export function deleteNotes(notes: readonly NtNote[], ids: ReadonlySet<number>): NtNote[] {
  return notes.map((n) => (ids.has(n.id) ? { ...n, del: true } : n));
}

/** Split note `id` at source position `at`. */
export function cutNote(notes: readonly NtNote[], id: number, at: number, d: DecodedAnalysis, nextId: number): { notes: NtNote[]; nextId: number } | null {
  const n = notes.find((q) => q.id === id);
  if (!n || at - n.s < MIN_NOTE || n.e - at < MIN_NOTE) return null;
  const f = (at - n.s) / (n.e - n.s);
  const oc = Math.round(n.os + f * (n.oe - n.os));
  const a = redescribe({ ...n, e: at, oe: oc }, d);
  const b = redescribe({ ...n, id: nextId, s: at, os: oc }, d);
  for (const q of [a, b]) {
    const len = q.e - q.s;
    q.vi = Math.min(n.vi, Math.round(len * 0.4));
    q.vo = Math.min(n.vo, Math.round(len * 0.4));
  }
  const out: NtNote[] = [];
  for (const q of notes) {
    if (q.id === id) out.push(a, b);
    else out.push(q);
  }
  return { notes: out, nextId: nextId + 1 };
}

/** Join two notes adjacent in the source (the first keeps its edits). */
export function joinNotes(notes: readonly NtNote[], idA: number, idB: number, d: DecodedAnalysis): NtNote[] | null {
  let a = notes.find((q) => q.id === idA), b = notes.find((q) => q.id === idB);
  if (!a || !b) return null;
  if (b.s < a.s) [a, b] = [b, a];
  if (Math.abs(a.e - b.s) > 1) return null;
  const c = redescribe({ ...a, e: b.e, oe: b.oe, vo: b.vo }, d);
  return notes.filter((q) => q.id !== b!.id).map((q) => (q.id === a!.id ? c : q));
}

/** The pair of notes meeting at the boundary closest to source position `at` (within `tol`). */
export function boundaryAt(notes: readonly NtNote[], at: number, tol: number): [NtNote, NtNote] | null {
  const ns = sortedNotes(notes).filter((n) => !n.del);
  let best: [NtNote, NtNote] | null = null, bd = tol;
  for (let i = 1; i < ns.length; i++) {
    const a = ns[i - 1], b = ns[i];
    if (Math.abs(a.e - b.s) > 1) continue;
    const dd = Math.abs(b.s - at);
    if (dd <= bd) { bd = dd; best = [a, b]; }
  }
  return best;
}

function validTiming(ns: readonly NtNote[]): boolean {
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    if (n.oe - n.os < MIN_NOTE * 0.5) return false;
    if (n.s === 0 && Math.abs(n.os) > 0.5) return false;
    const a = ns[i - 1];
    if (a) {
      if (Math.abs(a.e - n.s) <= 1) { if (Math.abs(a.oe - n.os) > 0.5) return false; }
      else if (n.os < a.oe + 1) return false;
    } else if (n.s > 0 && n.os < 1) return false;
  }
  return true;
}

function attach(ns: NtNote[], moved: (n: NtNote) => boolean): void {
  for (let i = 1; i < ns.length; i++) {
    const a = ns[i - 1], b = ns[i];
    if (Math.abs(a.e - b.s) > 1) continue;
    const ma = moved(a), mb = moved(b);
    if (mb && !ma) a.oe = b.os;
    else if (ma && !mb) b.os = a.oe;
  }
}

/** Largest valid step toward `full` (binary search on the edit amount). */
function bestValid(make: (f: number) => NtNote[]): NtNote[] {
  const full = make(1);
  if (validTiming(full)) return full;
  let lo = 0, hi = 1;
  let res = make(0);
  for (let it = 0; it < 22; it++) {
    const mid = (lo + hi) / 2;
    const r = make(mid);
    if (validTiming(r)) { lo = mid; res = r; } else hi = mid;
  }
  return res;
}

/** Move notes in time by `delta` output samples (from the drag's original notes). */
export function moveNotesTime(orig: readonly NtNote[], ids: ReadonlySet<number>, delta: number): NtNote[] {
  const base = sortedNotes(orig);
  return bestValid((f) => {
    const dd = Math.round(delta * f);
    const ns = base.map((n) => (ids.has(n.id) ? { ...n, os: n.os + dd, oe: n.oe + dd } : { ...n }));
    attach(ns, (n) => ids.has(n.id));
    return ns;
  });
}

/** Move a note's left or right output edge to `pos` (attached neighbours follow). */
export function moveEdge(orig: readonly NtNote[], id: number, side: 'l' | 'r', pos: number): NtNote[] {
  const base = sortedNotes(orig);
  const n0 = base.find((n) => n.id === id);
  if (!n0) return base;
  const from = side === 'l' ? n0.os : n0.oe;
  return bestValid((f) => {
    const p = Math.round(from + (pos - from) * f);
    const ns = base.map((n) => ({ ...n }));
    const i = ns.findIndex((n) => n.id === id);
    const n = ns[i];
    if (side === 'l') {
      n.os = p;
      const a = ns[i - 1];
      if (a && Math.abs(a.e - n.s) <= 1) a.oe = p;
    } else {
      n.oe = p;
      const b = ns[i + 1];
      if (b && Math.abs(n.e - b.s) <= 1) b.os = p;
    }
    return ns;
  });
}

/** Quantise note starts to a grid (`snap` maps an output position to the grid). */
export function quantizeNotes(notes: readonly NtNote[], ids: ReadonlySet<number> | null, snap: (pos: number) => number): NtNote[] {
  let cur = sortedNotes(notes);
  for (const n of cur.slice()) {
    if (n.del || (ids && !ids.has(n.id))) continue;
    const now = cur.find((q) => q.id === n.id)!;
    const target = snap(now.os);
    if (Math.abs(target - now.os) < 1) continue;
    cur = moveNotesTime(cur, new Set([n.id]), target - now.os);
  }
  return cur;
}

/** Reset the timing of notes (output range back to the source range). */
export function resetTiming(notes: readonly NtNote[]): NtNote[] {
  return notes.map((n) => ({ ...n, os: n.s, oe: n.e }));
}
