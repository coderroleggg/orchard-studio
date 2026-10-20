// Instrument (generator) plugin registry: every module in ./plugins exports
// `def: GenPluginDef`. The state helpers are shared with the effect registry
// (src/model/fx/params.ts).

import type { FxParamDef, FxParams, FxPreset } from '../fx/types';
import { defaultParamsOf, normalizeParamsOf, outputsOf, presetStateOf } from '../fx/params';
import { GEN_CATEGORIES, type GenCategory, type GenPluginDef } from './types';

export { clampParam, formatParam } from '../fx/params';

const mods = import.meta.glob<{ def?: GenPluginDef }>('./plugins/*.ts', { eager: true });

export const GEN_DEFS: GenPluginDef[] = Object.values(mods)
  .map((m) => m.def)
  .filter((d): d is GenPluginDef => !!d)
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

const byId = new Map(GEN_DEFS.map((d) => [d.id, d]));

/** Register a definition at runtime (tests). */
export function registerGenDef(d: GenPluginDef): void {
  const i = GEN_DEFS.findIndex((x) => x.id === d.id);
  if (i >= 0) GEN_DEFS[i] = d; else GEN_DEFS.push(d);
  byId.set(d.id, d);
}

export function genDef(id: string): GenPluginDef | undefined {
  return byId.get(id);
}

export function genParamDef(id: string, key: string): FxParamDef | undefined {
  return byId.get(id)?.params.find((p) => p.key === key);
}

/** Instruments listed in a plugin database folder (menus, Browser), sorted by name. */
export function genInCategory(cat: GenCategory): GenPluginDef[] {
  return GEN_DEFS.filter((d) => !d.hidden && (d.category === cat || d.alsoIn?.includes(cat)));
}

/** Folders that list at least one instrument plugin. */
export function genCategories(): GenCategory[] {
  return GEN_CATEGORIES.filter((c) => genInCategory(c).length > 0);
}

/** A fresh instrument state: every parameter at its default plus the plugin's extra state. */
export function defaultGenParams(id: string): FxParams {
  return defaultParamsOf(byId.get(id));
}

/** Fill fields missing from a stored state (older saves, newly added parameters). */
export function normalizeGenParams(id: string, stored: unknown): FxParams {
  return normalizeParamsOf(byId.get(id), stored);
}

/** The state a factory preset loads (see presetStateOf: defaults + preset, clamped, view state kept). */
export function genPresetState(id: string, preset: FxPreset, current?: Record<string, unknown>): FxParams {
  return presetStateOf(byId.get(id), preset, current);
}

/** An instrument's internal controller output names for a state ('' = unused index). */
export function genOutputs(id: string, params?: FxParams): string[] {
  return outputsOf(byId.get(id), params);
}
