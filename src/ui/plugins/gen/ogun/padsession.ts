// The state side of Ogun's pad harmonics tool (the dialog is padharm.tsx): what the tool remembers between uses and one use of the
// tool on a shaping map. While the tool is open its map is shown in the edited target at once (no undo entry); "Accept" makes the
// change one undo step, closing the tool any other way gives the map back.

import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import {
  PAD_BINS, PAD_WIDTH_DEFAULT, PAD_WIDTH_MAX, buildPadCurve, copyBins, defaultWindow, newBins, type PadBins, type PadSettings,
} from '../../../../model/gen/plugins/ogun/padharm';
import type { OgEnv } from '../../../../model/gen/plugins/ogun/types';
import { byteOf, xiOf, type Params } from './settings';

// ------------------------------------------------------------------------------------------------------- remembered state

/** The part of the tool's state that belongs to a target (FL keeps it per editor target). */
export interface PadPerTarget {
  width: number;
  normalize: boolean;
  window: OgEnv;
}

/** What the tool remembers: the bins (shared by every target), the tab and the per-target settings. */
export interface PadSaved {
  bins: PadBins;
  tab: 0 | 1;
  per: Record<number, PadPerTarget>;
}

const STORE_KEY = 'orchard.ogun.padharm';
let saved: PadSaved | null = null;

const isNums = (a: unknown, n: number): a is number[] => Array.isArray(a) && a.length === n && a.every((v) => typeof v === 'number' && Number.isFinite(v));
const clampBin = (v: number): number => Math.max(0, Math.min(65536, Math.round(v)));

/** Parse remembered state from text (defensive: it comes from the browser's storage); anything unusable falls back to the defaults. */
export function parseSaved(text: string | null): PadSaved {
  const out: PadSaved = { bins: newBins(), tab: 0, per: {} };
  let j: Partial<PadSaved> | null = null;
  try { j = JSON.parse(text ?? 'null') as Partial<PadSaved> | null; } catch { return out; }
  if (!j || typeof j !== 'object') return out;
  if (j.bins && isNums(j.bins.level, PAD_BINS) && isNums(j.bins.width, PAD_BINS)) out.bins = { level: j.bins.level.map(clampBin), width: j.bins.width.map(clampBin) };
  if (j.tab === 1) out.tab = 1;
  const per = j.per && typeof j.per === 'object' ? j.per : {};
  for (const [k, v] of Object.entries(per)) {
    const t = +k;
    if (!(t >= 13 && t <= 16) || !v || typeof v.width !== 'number' || !Number.isFinite(v.width)) continue;
    const w = v.window;
    if (!w || !Array.isArray(w.p) || w.p.length < 2 || w.p.length > 64 || !w.p.every((q) => isNums(q, 7)) || !isNums(w.m, 5)) continue;
    if (w.p[0][0] !== 0) continue;
    out.per[t] = { width: Math.max(0, Math.min(PAD_WIDTH_MAX, Math.round(v.width))), normalize: v.normalize !== false, window: { t: 3, m: w.m.slice(), p: w.p.map((q) => q.slice()) } };
  }
  return out;
}

/** The remembered state (read from the browser's storage on first use). */
export function loadSaved(): PadSaved {
  if (saved) return saved;
  let text: string | null = null;
  try { if (typeof document !== 'undefined') text = localStorage.getItem(STORE_KEY); } catch { /* no storage */ }
  saved = parseSaved(text);
  return saved;
}

export function persistSaved(): void {
  if (!saved) return;
  try { if (typeof document !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
}

/** Forget what was remembered (tests). */
export function resetSaved(): void {
  saved = null;
}

// -------------------------------------------------------------------------------------------------------------------- session

const paramsOf = (slotId: string): Params => (A.findFx(store.project, slotId)?.fx.params ?? {}) as Params;

/** The tool's settings of one use. */
export interface PadState extends PadSettings {
  tab: 0 | 1;
}

/** The delay after the last change before the map follows (FL: the tool's 200 ms timer). */
export const PAD_PREVIEW_MS = 200;

/** One use of the tool on a shaping map (target 13..16 of the editor: forced harmonics, impulse EQ, decay EQ, release EQ). */
export class PadSession {
  readonly j: number;
  readonly state: PadState;
  /** The map as it was when the tool opened (null when the instrument has no such map). */
  readonly orig: OgEnv | null;
  /** Richness order (state xi[3]) and the natural EQ mapping scale at the time the tool opened. */
  readonly order: number;
  readonly natural: boolean;
  private accepted = false;
  private done = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly slotId: string, readonly target: number) {
    this.j = target - 13;
    const p = paramsOf(slotId);
    const maps = p.maps as OgEnv[] | undefined;
    this.orig = maps?.[this.j] ? structuredClone(maps[this.j]) : null;
    this.order = xiOf(p)[3] ?? 14;
    this.natural = byteOf(xiOf(p)[8], 3) !== 0;
    const sv = loadSaved();
    const per = sv.per[target];
    this.state = {
      bins: copyBins(sv.bins), tab: sv.tab, width: per?.width ?? PAD_WIDTH_DEFAULT, normalize: per?.normalize ?? true,
      window: per ? structuredClone(per.window) : defaultWindow(),
    };
  }

  /** The tool's map for the current settings. */
  build(): OgEnv | null {
    if (!this.orig) return null;
    const s = this.state;
    return buildPadCurve(this.orig, { bins: s.bins, width: s.width, normalize: s.normalize, window: s.window }, this.order, this.natural);
  }

  private put(curve: OgEnv, history: string | null, dropMissing: boolean): void {
    const recipe = (d: Record<string, unknown>) => {
      const maps = d.maps as OgEnv[] | undefined;
      if (maps) maps[this.j] = curve;
      const miss = d.missing as string[] | undefined;
      if (dropMissing && Array.isArray(miss)) {
        const i = miss.indexOf(`m${this.j}`);
        if (i >= 0) miss.splice(i, 1);
      }
    };
    if (history) A.editFx(this.slotId, history, recipe);
    else A.setFxStateNoHistory(this.slotId, 'Create pad harmonics', recipe);
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Start (or, after close(), restart) the use: the tool's map is shown in the edited target at once. */
  open(): void {
    this.done = false;
    this.accepted = false;
    this.preview();
  }

  /** Show the tool's map in the edited target now (no undo entry). */
  preview(): void {
    this.clearTimer();
    if (this.done) return;
    const c = this.build();
    if (c) this.put(c, null, false);
  }

  /** Show it when the user pauses (every change restarts the timer). */
  schedule(): void {
    this.clearTimer();
    if (this.done) return;
    this.timer = setTimeout(() => this.preview(), PAD_PREVIEW_MS);
  }

  /** What the tool remembers for next time. */
  remember(): void {
    const sv = loadSaved();
    const s = this.state;
    sv.bins = copyBins(s.bins);
    sv.tab = s.tab;
    sv.per[this.target] = { width: s.width, normalize: s.normalize, window: structuredClone(s.window) };
    persistSaved();
  }

  /** Accept: the tool's map replaces the original in one undo step (the map is the user's now: no longer missing FL content). */
  accept(): void {
    if (this.done) return;
    this.clearTimer();
    const c = this.build();
    if (!c || !this.orig) { this.close(); return; }
    this.accepted = true;
    const o = this.orig;
    A.setFxStateNoHistory(this.slotId, 'Create pad harmonics', (d) => { const m = d.maps as OgEnv[] | undefined; if (m) m[this.j] = o; });
    this.put(c, 'Create pad harmonics', true);
    this.close();
  }

  /** Close the tool: what it shows is given back unless it was accepted; the settings are remembered either way. */
  close(): void {
    if (this.done) return;
    this.done = true;
    this.clearTimer();
    this.remember();
    if (!this.accepted && this.orig) {
      const o = this.orig;
      A.setFxStateNoHistory(this.slotId, 'Create pad harmonics', (d) => { const m = d.maps as OgEnv[] | undefined; if (m) m[this.j] = o; });
    }
  }
}
