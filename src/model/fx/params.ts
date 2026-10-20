// Plugin state helpers shared by the effect registry (src/model/fx/registry.ts)
// and the instrument registry (src/model/gen/registry.ts): default states,
// repair of stored states, factory preset loading and controller output names.
// They work on any definition with FL's parameter list (FxParamDef).

import type { FxParamDef, FxParams, FxPluginDef, FxPreset } from './types';

/** The part of a plugin definition the state helpers read (effects and instruments share it). */
export type PluginStateDef = Pick<FxPluginDef, 'params' | 'state' | 'normalize' | 'viewState' | 'outputs'>;

/** A fresh plugin state: every parameter at its default plus the plugin's extra state. */
export function defaultParamsOf(d: PluginStateDef | undefined): FxParams {
  if (!d) return {};
  const p: FxParams = {};
  for (const q of d.params) p[q.key] = q.def;
  return { ...p, ...(d.state?.() ?? {}) };
}

/** Fill fields missing from a stored state (older saves, newly added parameters). */
export function normalizeParamsOf(d: PluginStateDef | undefined, stored: unknown): FxParams {
  const s = (stored && typeof stored === 'object' ? stored : {}) as FxParams;
  if (!d) return s;
  const merged = { ...defaultParamsOf(d), ...s };
  return d.normalize ? d.normalize(merged) : merged;
}

/**
 * The state a factory preset loads: the defaults plus the preset's values,
 * clamped to the controls' ranges (FL's controls cannot hold a value outside
 * them), normalised, with the view settings (def.viewState) of `current` kept.
 */
export function presetStateOf(d: PluginStateDef | undefined, preset: FxPreset, current?: Record<string, unknown>): FxParams {
  const raw: FxParams = { ...defaultParamsOf(d), ...structuredClone(preset.params) };
  for (const q of d?.params ?? []) {
    const v = raw[q.key];
    if (typeof v === 'number' && Number.isFinite(v)) raw[q.key] = Math.min(q.max, Math.max(q.min, v));
  }
  const keep: FxParams = {};
  for (const k of d?.viewState ?? []) if (current && k in current) keep[k] = structuredClone(current[k]);
  return { ...normalizeParamsOf(d, raw), ...keep, __preset: preset.name };
}

/** A plugin's internal controller output names for a state ('' = unused index). */
export function outputsOf(d: PluginStateDef | undefined, params?: FxParams): string[] {
  const o = d?.outputs;
  if (!o) return [];
  return typeof o === 'function' ? o(params ?? defaultParamsOf(d)) : o;
}

/** Clamp and quantise a control value to its parameter's range. */
export function clampParam(q: FxParamDef, v: number): number {
  const step = q.step ?? 1;
  let x = Math.min(q.max, Math.max(q.min, v));
  if (step > 0) x = Math.round((x - q.min) / step) * step + q.min;
  return x;
}

/** FL's value text for a parameter (falls back to the raw control value). */
export function formatParam(q: FxParamDef, v: number, state?: FxParams): string {
  if (q.format) return q.format(v, state);
  if (q.options) return q.options[Math.round(v - q.min)] ?? String(v);
  return String(Math.round(v * 1000) / 1000);
}
