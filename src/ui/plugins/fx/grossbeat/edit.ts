// Gross Beat editor: state access and undoable edits of the slot banks.

import type { Draft } from 'immer';
import * as A from '../../../../store/actions';
import {
  GB_BAR, GB_RANGE, GB_SNAP_BEATS, gbEmptySlot, type GbOptions, type GbPoint, type GbSlot,
} from '../../../../model/fx/plugins/grossbeat';

export type Bank = 'tslots' | 'vslots';

export interface GbView {
  tslots: GbSlot[];
  vslots: GbSlot[];
  tslot: number;
  vslot: number;
  map: number;
  snap: number;
  step: boolean;
  slide: boolean;
  freeze: boolean;
  zoom: boolean;
  opt: GbOptions;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d = false) => (typeof v === 'boolean' ? v : d);

export function readView(p: Record<string, unknown>): GbView {
  const bank = (v: unknown): GbSlot[] => (Array.isArray(v) && v.length ? (v as GbSlot[]) : Array.from({ length: 36 }, () => gbEmptySlot()));
  const o = (p.opt && typeof p.opt === 'object' ? p.opt : {}) as Partial<GbOptions>;
  return {
    tslots: bank(p.tslots),
    vslots: bank(p.vslots),
    tslot: Math.min(35, Math.max(0, Math.round(num(p.tslot, 0)))),
    vslot: Math.min(35, Math.max(0, Math.round(num(p.vslot, 0)))),
    map: p.map === 1 ? 1 : 0,
    snap: Math.min(6, Math.max(0, Math.round(num(p.snap, 3)))),
    step: bool(p.step),
    slide: bool(p.slide),
    freeze: bool(p.freeze),
    zoom: bool(p.zoom),
    opt: {
      midi: bool(o.midi, true), declick: o.declick === 0 || o.declick === 2 ? o.declick : 1,
      comp: bool(o.comp), dc: bool(o.dc), hq: bool(o.hq, true), clock: bool(o.clock, true),
    },
  };
}

/** Undoable edit of the slot state; `merge` groups a drag into one undo step. */
export function edit(slotId: string, label: string, recipe: (p: Draft<Record<string, unknown>>) => void, merge?: string): void {
  A.editFx(slotId, label, recipe, merge);
}

/** Edit one slot of a bank (creates the bank from FL's defaults if the state lacks it). */
export function editSlot(slotId: string, bank: Bank, index: number, label: string, recipe: (s: GbSlot) => void, merge?: string): void {
  edit(slotId, label, (p) => {
    let b = p[bank] as unknown as GbSlot[] | undefined;
    if (!Array.isArray(b)) { b = Array.from({ length: 36 }, () => gbEmptySlot()); (p as Record<string, unknown>)[bank] = b; }
    if (!b[index]) b[index] = gbEmptySlot();
    recipe(b[index]);
  }, merge);
}

export function setOpt(slotId: string, label: string, recipe: (o: GbOptions) => void): void {
  edit(slotId, label, (p) => {
    const o = (p.opt && typeof p.opt === 'object' ? p.opt : {}) as GbOptions;
    if (!p.opt || typeof p.opt !== 'object') (p as Record<string, unknown>).opt = o;
    recipe(o);
  });
}

// --------------------------------------------------------------- geometry

/** Snap a beat position to the snap grid (0 = off). */
export function snapBeat(x: number, snap: number): number {
  const q = GB_SNAP_BEATS[snap] ?? 0;
  return q > 0 ? Math.round(x / q) * q : x;
}

/** Snap a value: time envelopes snap the offset to the beat grid, volume envelopes to 1/16 steps. */
export function snapValue(y: number, snap: number, time: boolean): number {
  const q = GB_SNAP_BEATS[snap] ?? 0;
  if (q <= 0) return y;
  if (time) {
    const off = (1 - y) * GB_RANGE;
    return 1 - (Math.round(off / q) * q) / GB_RANGE;
  }
  return Math.round(y * 16) / 16;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function sortPoints(pts: GbPoint[]): void {
  pts.sort((a, b) => a.x - b.x);
  if (pts.length) pts[0].x = 0;
  for (const p of pts) p.x = Math.min(GB_BAR, Math.max(0, p.x));
}

// ---------------------------------------------------------------- tools

/** In-memory clipboard for "Copy state" / "Paste state" (one slot's envelope and settings). */
let clip: GbSlot | null = null;

export function copySlot(s: GbSlot): void {
  clip = structuredClone(s);
}

export function hasClip(): boolean {
  return clip !== null;
}

export function pasteInto(s: GbSlot): void {
  if (!clip) return;
  const c = structuredClone(clip);
  s.pts = c.pts;
  s.trig = c.trig; s.pos = c.pos; s.hold = c.hold; s.link = c.link; s.key = c.key; s.one = c.one;
}

export function flipVertical(s: GbSlot): void {
  for (const p of s.pts) { p.y = 1 - p.y; p.t = -p.t; }
}

export function normalizeLevels(s: GbSlot): void {
  let lo = 1, hi = 0;
  for (const p of s.pts) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
  if (hi - lo < 1e-6) { for (const p of s.pts) p.y = 1; return; }
  for (const p of s.pts) p.y = (p.y - lo) / (hi - lo);
}

/** Decimate points: keep every other inner point. */
export function decimate(s: GbSlot): void {
  if (s.pts.length <= 3) return;
  const last = s.pts[s.pts.length - 1];
  s.pts = s.pts.filter((_, i) => i === 0 || i % 2 === 0).concat(s.pts.length % 2 === 0 ? [last] : []);
}

/** Smooth up abrupt changes: hold steps become straight single curves. */
export function smoothAbrupt(s: GbSlot): void {
  for (let i = 1; i < s.pts.length; i++) if (s.pts[i].m === 2 || s.pts[i].m === 5 || s.pts[i].m === 3) { s.pts[i].m = 0; s.pts[i].t = 0; }
}

/** Turn all points smooth: every segment a double curve (S shape). */
export function allSmooth(s: GbSlot): void {
  for (let i = 1; i < s.pts.length; i++) { s.pts[i].m = 1; s.pts[i].t = -0.3; }
}

export function resetSlot(s: GbSlot): void {
  const e = gbEmptySlot(s.name);
  s.pts = e.pts;
}

/**
 * "1 semitone up / down" on the segment ending at point i: its playback speed
 * (1 - d(offset)/dx) is multiplied by 2^(+-1/12) by moving the point vertically.
 */
export function pitchSegment(s: GbSlot, i: number, semis: number): void {
  if (i < 1 || i >= s.pts.length) return;
  const a = s.pts[i - 1], b = s.pts[i];
  const dx = b.x - a.x;
  if (dx <= 1e-9) return;
  const dOff = (a.y - b.y) * GB_RANGE;
  const speed = 1 - dOff / dx;
  const next = speed * Math.pow(2, semis / 12);
  const off = (1 - next) * dx;
  b.y = clamp01(a.y - off / GB_RANGE);
}
