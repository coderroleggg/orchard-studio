// Parameter edits for the Parametric EQ 2 editor. Every edit resolves the
// slot afresh (it can move between mixer slots while the window is open) and
// goes through setPeq2 so it lands in the undo history.

import type { Draft } from 'immer';
import { store } from '../../store';
import { editFx, findFx, setFxStateNoHistory } from '../../store/actions';
import {
  defaultBand, defaultPEQ2, normalizePEQ2, PEQ2_TYPES,
  type PEQ2Band, type PEQ2Bank, type PEQ2Params, type PEQ2Type,
} from '../../model/peq2';
import { flashHint } from '../hint';

type Recipe = (p: Draft<PEQ2Params>) => void;

const OPT_KEYS = Object.keys(defaultPEQ2().opts);

function bandOk(v: unknown): boolean {
  const b = v as Partial<PEQ2Band> | null;
  return !!b && PEQ2_TYPES.includes(b.type as PEQ2Type) && typeof b.level === 'number' && typeof b.freq === 'number'
    && typeof b.bw === 'number' && typeof b.order === 'number' && typeof b.enabled === 'boolean' && typeof b.solo === 'boolean';
}

/** True when the stored params have every field the editor reads. */
export function isComplete(v: unknown): v is PEQ2Params {
  const p = v as Partial<PEQ2Params> | null;
  if (!p || !Array.isArray(p.bands) || p.bands.length !== 7 || !p.bands.every(bandOk)) return false;
  if (typeof p.mainLevel !== 'number' || !p.opts || !p.spare || !Array.isArray(p.spare.bands)) return false;
  for (const k of OPT_KEYS) if (!(k in p.opts)) return false;
  return typeof p.lin === 'boolean' && typeof p.hq === 'boolean' && typeof p.showTokens === 'boolean'
    && typeof p.onSpare === 'boolean' && typeof p.linPrecision === 'number'
    && typeof p.hqMode === 'string' && typeof p.monitor === 'string';
}

function fixBank(b: Partial<PEQ2Bank> | undefined): PEQ2Bank {
  const bands = Array.from({ length: 7 }, (_, i) => ({ ...defaultBand(i), ...(b?.bands?.[i] ?? {}) }));
  return { bands, mainLevel: typeof b?.mainLevel === 'number' ? b.mainLevel : 0 };
}

/** Complete params (fills fields missing from older saves). */
export function fixParams(v: unknown): PEQ2Params {
  const n = normalizePEQ2(v as Partial<PEQ2Params> | undefined);
  return { ...n, ...fixBank(n), spare: fixBank(n.spare) };
}

/** The params as displayed: the stored object itself when complete (keeps identities stable). */
export function viewParams(v: unknown): PEQ2Params {
  return isComplete(v) ? v : fixParams(v);
}

export function currentParams(slotId: string): PEQ2Params | null {
  const loc = findFx(store.project, slotId);
  return loc ? viewParams(loc.fx.params) : null;
}

/** Apply an edit. `mergeKey` defaults to one key per label (consecutive edits merge). */
export function edit(slotId: string, label: string, recipe: Recipe, mergeKey?: string): void {
  const loc = findFx(store.project, slotId);
  if (!loc) return;
  if (!isComplete(loc.fx.params)) {
    const fixed = fixParams(loc.fx.params) as unknown as Record<string, unknown>;
    setFxStateNoHistory(slotId, 'Parametric EQ 2', (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fixed); });
  }
  // editing any parameter while the spare bank is shown makes it the main bank
  const compare = label.startsWith('Compare');
  // through editFx so the editor also works hosted in Patcher ("<slot>#<module>" ids)
  editFx(slotId, label, (d) => {
    const p = d as unknown as Draft<PEQ2Params>;
    recipe(p);
    if (!compare && p.onSpare) p.onSpare = false;
  }, mergeKey ?? `peq2:${slotId}:${label}`);
}

let seq = 0;

/** A discrete edit (click, menu): always its own undo step. */
export function editOnce(slotId: string, label: string, recipe: Recipe): void {
  edit(slotId, label, recipe, `peq2:${label}:${++seq}`);
}

/** Replace the params without an undo entry (band solo audition and its restore). */
export function setParamsNoHistory(slotId: string, params: PEQ2Params): void {
  setFxStateNoHistory(slotId, 'Band solo', (p) => {
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, params as unknown as Record<string, unknown>);
  });
}

// ------------------------------------------------------------------ actions
/** Alt+click on a token: level, frequency and BW back to the band's defaults (type and order kept). */
export function resetBand(slotId: string, k: number): void {
  const def = defaultBand(k);
  editOnce(slotId, 'Reset band', (p) => {
    const b = p.bands[k];
    b.level = def.level;
    b.freq = def.freq;
    b.bw = def.bw;
  });
}

export function resetAll(slotId: string): void {
  editOnce(slotId, 'Reset Parametric EQ 2', (p) => { Object.assign(p, defaultPEQ2()); });
}

/** Compare, first button: copy the current settings to the spare state. */
export function compareStore(slotId: string): void {
  const p = currentParams(slotId);
  if (!p) return;
  if (p.opts.lockSpare) {
    flashHint('Spare state is locked (Options > Lock spare state)');
    return;
  }
  editOnce(slotId, 'Compare: store', (d) => {
    d.spare = { bands: d.bands.map((b) => ({ ...b })), mainLevel: d.mainLevel };
  });
  flashHint('Current settings stored in the spare state');
}

/** Compare, second button: swap the current settings and the spare state. */
export function compareSwap(slotId: string): void {
  editOnce(slotId, 'Compare: swap', (d) => {
    const main: PEQ2Bank = { bands: d.bands.map((b) => ({ ...b })), mainLevel: d.mainLevel };
    const spare = fixBank({ bands: (d.spare?.bands ?? []).map((b) => ({ ...b })), mainLevel: d.spare?.mainLevel });
    d.bands = spare.bands;
    d.mainLevel = spare.mainLevel;
    d.spare = main;
    d.onSpare = !d.onSpare;
  });
}

// ------------------------------------------------------- band solo on Shift
/** The audition filter for a band (docs/research/peq2.md 6.6). */
export function auditionBand(b: PEQ2Band, mode: 'bandpass' | 'adaptive', bw: number): PEQ2Band {
  let type: PEQ2Type = 'bandpass';
  let order = -3; // Bandpass mode: a Steep 8 band pass around the token
  if (mode === 'adaptive') {
    order = b.order;
    if (b.type === 'lowpass' || b.type === 'highshelf') type = 'highpass';
    else if (b.type === 'highpass' || b.type === 'lowshelf') type = 'lowpass';
  }
  return { ...b, type, order, bw, level: 0, enabled: true, solo: true };
}

/** Params with band k soloed as its audition filter. */
export function auditionParams(p: PEQ2Params, k: number, bw: number): PEQ2Params {
  const aud = auditionBand(p.bands[k], p.opts.soloMode, bw);
  return { ...p, bands: p.bands.map((b, i) => (i === k ? aud : { ...b, solo: false })) };
}
