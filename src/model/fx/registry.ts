// Effect plugin registry: every module in ./plugins exports `def`.

import type { FxCategory, FxParamDef, FxParams, FxPluginDef, FxPreset } from './types';
import { FX_CATEGORIES } from './types';
import { defaultParamsOf, normalizeParamsOf, outputsOf, presetStateOf } from './params';

export { clampParam, formatParam } from './params';

const mods = import.meta.glob<{ def?: FxPluginDef }>('./plugins/*.ts', { eager: true });

export const FX_DEFS: FxPluginDef[] = Object.values(mods)
  .map((m) => m.def)
  .filter((d): d is FxPluginDef => !!d)
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

const byId = new Map(FX_DEFS.map((d) => [d.id, d]));

export function fxDef(id: string): FxPluginDef | undefined {
  return byId.get(id);
}

export function fxParamDef(id: string, key: string): FxParamDef | undefined {
  return byId.get(id)?.params.find((p) => p.key === key);
}

/** Plugins listed in a category (menus, Browser), sorted by name. */
export function fxInCategory(cat: FxCategory): FxPluginDef[] {
  return FX_DEFS.filter((d) => !d.hidden && (d.category === cat || d.alsoIn?.includes(cat)));
}

export function fxCategories(): FxCategory[] {
  return FX_CATEGORIES.filter((c) => fxInCategory(c).length > 0);
}

/** A fresh plugin state: every parameter at its default plus the plugin's extra state. */
export function defaultFxParams(id: string): FxParams {
  return defaultParamsOf(byId.get(id));
}

/** Fill fields missing from a stored state (older saves, newly added parameters). */
export function normalizeFxParams(id: string, stored: unknown): FxParams {
  return normalizeParamsOf(byId.get(id), stored);
}

/**
 * The state a factory preset loads: the defaults plus the preset's values,
 * clamped to the controls' ranges (FL's controls cannot hold a value outside
 * them), normalised, with the view settings (def.viewState) of `current` kept.
 */
export function presetState(id: string, preset: FxPreset, current?: Record<string, unknown>): FxParams {
  return presetStateOf(byId.get(id), preset, current);
}

/** A plugin's internal controller output names for a slot state ('' = unused index). */
export function fxOutputs(id: string, params?: FxParams): string[] {
  return outputsOf(byId.get(id), params);
}
