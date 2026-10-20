// Slicex editor: readers of the plugin state, and the model operations the editor calls (FL's loading,
// slicing, region edits, macros and score dump from src/model/gen/plugins/slicex/ops.ts and dump.ts, the
// model port of FL's code).

import type { FxParams } from '../../../../model/fx/types';
import { emptyDeck } from '../../../../model/gen/plugins/slicex/defaults';
import { normSettings, sxRegionEnd } from '../../../../model/gen/plugins/slicex/state';
import type { SxArt, SxDeck, SxSettings } from '../../../../model/gen/plugins/slicex/types';
import { sxSetOption as setOption, type SxAudio } from '../../../../model/gen/plugins/slicex/ops';

export {
  sxLoadDeck, sxAutoSlice, sxGridSlice, sxZeroCrossAll, sxAssignAll, sxSetAllCutGroups, sxAddMarker, sxAddRegion, sxDeleteRegion,
  sxClearRegions, sxMoveStart, sxMoveEnd, sxToRegion, sxToMarker, sxCloneRegion, sxSetRegion, sxGuessTempo, sxMacro, sxAssignToKey, sxRegionOnKey,
  type SxAudio, type SxEditResult, type SxMacro,
} from '../../../../model/gen/plugins/slicex/ops';
export { sxDumpScore, SX_DUMP_MODES, type SxDumpNote } from '../../../../model/gen/plugins/slicex/dump';

export type Range = [number, number];

// ------------------------------------------------------------------ state readers

export const deckKey = (d: number): 'deckA' | 'deckB' => (d ? 'deckB' : 'deckA');
export const sampleKey = (d: number): 'sampleA' | 'sampleB' => (d ? 'sampleB' : 'sampleA');

export function deckOf(p: FxParams, d: number): SxDeck {
  const x = p[deckKey(d)] as SxDeck | undefined;
  return x && Array.isArray(x.regions) ? x : emptyDeck();
}

export function sampleOf(p: FxParams, d: number): string | null {
  const s = p[sampleKey(d)];
  return typeof s === 'string' && s ? s : null;
}

export function artsOf(p: FxParams): SxArt[] {
  return Array.isArray(p.arts) ? (p.arts as SxArt[]) : [];
}

export function optOf(p: FxParams): SxSettings {
  const o = p.opt as SxSettings | undefined;
  return o && Array.isArray(o.raw) ? o : normSettings(o);
}

const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
const range = (v: unknown): Range | null => (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0] as number, v[1] as number] : null);

/** The editor's view state (SX_VIEW_KEYS). */
export interface SxView {
  art: number; target: number; part: number; deck: number; region: number;
  /** FL's display mode (option block +0x1314): 0 full, 1 no audio editor, 2 no region settings, 3 compact. */
  disp: number;
  /** The keyboard is shown (FL's option byte +0x1330, KbBtn). */
  kb: boolean;
  kbBase: number;
  /** Dual deck display (option byte +0x132b, DualDeckBtn). */
  dual: boolean;
  sel: Range | null; zoom: Range | null; snap: number; spec: boolean;
}

export function viewOf(p: FxParams): SxView {
  return {
    art: int(p.vArt, 0, 0, 7), target: int(p.vTarget, 0, 0, 5), part: int(p.vPart, 1, 0, 5), deck: int(p.vDeck, 0, 0, 1),
    region: int(p.vRegion, 0, 0, 65535), disp: int(optOf(p).dispMode, 0, 0, 3), kb: optOf(p).kbShown !== false, kbBase: int(p.vKbBase, 3, 0, 4),
    dual: optOf(p).dual !== false, sel: range(p.vSel), zoom: range(p.vZoom), snap: int(p.vSnap, 4, 0, 5), spec: int(p.vSpec, 0, 0, 1) === 1,
  };
}

/** Frame range of region r: [start, last frame] (markers run to the next region / the end). */
export function regionSpan(deck: SxDeck, r: number, frames: number): Range {
  const rg = deck.regions[r];
  if (!rg) return [0, Math.max(0, frames - 1)];
  return [rg.s, Math.max(rg.s, sxRegionEnd(deck, r, frames))];
}

/** Index of the region whose span contains frame f (the last one starting at or before it), -1 if none. */
export function regionAt(deck: SxDeck, f: number, frames: number): number {
  let best = -1;
  deck.regions.forEach((rg, i) => {
    const [s, e] = regionSpan(deck, i, frames);
    if (f >= s && f <= e && (best < 0 || rg.s >= deck.regions[best].s)) best = i;
  });
  return best;
}

// ------------------------------------------------------------------ helpers

function mono(a: SxAudio): Float32Array {
  const ch = a.channels;
  const n = ch[0]?.length ?? 0;
  if (ch.length < 2) return ch[0] ?? new Float32Array(0);
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = (ch[0][i] + ch[1][i]) * 0.5;
  return m;
}

/** Nearest rising zero crossing of the mono mix within `span` frames of f (f itself when none): the editor's snap. */
export function zeroCross(a: SxAudio, f: number, span = 512): number {
  const m = mono(a);
  const n = m.length;
  for (let d = 0; d <= span; d++) {
    for (const q of [f - d, f + d]) {
      if (q <= 0 || q >= n) continue;
      if (m[q - 1] <= 0 && m[q] > 0) return q;
    }
  }
  return f;
}

/** Set one option (ops.ts sxSetOption, keeping FL's raw block in step). */
export function sxSetOption(opt: SxSettings, key: keyof SxSettings, value: number | boolean): SxSettings {
  const v = typeof opt[key] === 'number' ? Math.round(Number(value)) : !!value;
  return setOption(opt, key, v as SxSettings[typeof key]);
}
