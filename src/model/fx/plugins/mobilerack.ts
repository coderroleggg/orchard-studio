// FL Studio Mobile Rack FX: a modular rack hosting FL Studio Mobile's effect
// modules in series (FL: "FL Studio Mobile Rack FX", Effects > Misc).
//
// FL exposes no parameters until a module control is "activated", so the
// plugin declares none statically; the rack lives in the slot state:
//   mods:  modules by id ({ type, p: normalised parameter values 0..1
//          (p[0] = module Enable), mx: module mixer [level, mix, pan] })
//   order: module ids from top to bottom (processing order)
//   next:  next free module id
// Every module parameter is automatable through the path
// "params.mods.<id>.p.<index>" (range 0..1), which survives reordering.
// Module definitions (FL's names, defaults and value texts) are in
// ./mobilerack/modules; the factory presets are FL's: Default (one Reverb 2),
// Empty, and one preset per module.

import type { FxPluginDef, FxPreset } from '../types';
import { MR_MODULES, mrDefaults, mrModuleDef } from './mobilerack/modules';

export { MR_MODULES, mrModuleDef, mrDefaults } from './mobilerack/modules';

export interface MrMod {
  id: number;
  type: number;
  /** Normalised parameter values (p[0] = Enable). */
  p: number[];
  /** Module mixer: [level, mix, pan] (FL's SMPR chunk). */
  mx: number[];
  /** Panel minimised in the editor. */
  min?: boolean;
}

export interface MrState {
  mods: Record<string, MrMod>;
  order: number[];
  next: number;
}

/** Module mixer defaults: level 0 dB, mix 100 %, pan centre. */
export const MR_MIX_DEFAULT = [0.5, 1, 0.5];

/** Module mixer laws (measured): level dB = 40 (v - 0.5) on the wet path; wet mix linear; pan = wet balance. */
export const mrMixMap = {
  levelDb: (v: number) => 40 * (v - 0.5),
  mixL: (mix: number, pan: number) => mix * Math.min(1, 2 * (1 - pan)),
  mixR: (mix: number, pan: number) => mix * Math.min(1, 2 * pan),
};

export function mrNewModule(type: number, id: number): MrMod {
  return { id, type, p: mrDefaults(type), mx: [...MR_MIX_DEFAULT] };
}

/** A rack holding the given module types (ids 1, 2, ...). */
export function mrRack(types: number[]): MrState {
  const mods: Record<string, MrMod> = {};
  const order: number[] = [];
  types.forEach((t, i) => { mods[String(i + 1)] = mrNewModule(t, i + 1); order.push(i + 1); });
  return { mods, order, next: types.length + 1 };
}

/** The rack's modules in processing order. */
export function mrModules(p: Record<string, unknown>): MrMod[] {
  const mods = (p.mods ?? {}) as Record<string, MrMod>;
  const order = Array.isArray(p.order) ? (p.order as number[]) : [];
  const out: MrMod[] = [];
  for (const id of order) { const m = mods[String(id)]; if (m) out.push(m); }
  return out;
}

/** Automation path of module parameter k (relative to the slot state). */
export function mrParamPath(id: number, k: number): string {
  return `mods.${id}.p.${k}`;
}

/** Automation path of module mixer control k (0 level, 1 mix, 2 pan). */
export function mrMixPath(id: number, k: number): string {
  return `mods.${id}.mx.${k}`;
}

/** Header name of a module in the rack ("FX Chorus"). */
export function mrHeaderName(type: number): string {
  return `FX ${mrModuleDef(type)?.name ?? 'Module'}`;
}

const REVERB2 = 35;

/** FL's factory presets: Default, Empty, then one per module (FL's folders Echo, Filter, Level, Misc). */
const PRESET_ORDER: string[] = [
  'Reeverb 2', 'Tape Delay', 'Trance Delay',
  'Comb Filter', 'Filter', 'Graphic EQ', 'Param EQ', 'Spacer', 'Spreader', 'Stereoizer', 'Tuned EQ',
  'Autoduck', 'Compressor', 'Distortion', 'Gate', 'Leveler', 'Limiter', 'Multiband Compressor', 'Waveshaper',
  'Analyser', 'Chorus', 'Flanger', 'Multi FX', 'Phaser', 'Pitcher 2', 'Tape Stop', 'Tremolo', 'Tuner', 'Wow & Flutter',
];

const PRESETS: FxPreset[] = [
  { name: 'Default', params: { ...mrRack([REVERB2]) } },
  { name: 'Empty', params: { ...mrRack([]) } },
  ...PRESET_ORDER.map((name) => {
    const m = MR_MODULES.find((d) => (d.preset ?? d.name) === name);
    return { name, params: { ...mrRack(m ? [m.type] : []) } };
  }),
];

const clamp01 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

/** Repair a stored rack: drop unknown modules, fill missing values, keep order and ids consistent. */
export function mrNormalize(p: Record<string, unknown>): Record<string, unknown> {
  const src = (p.mods && typeof p.mods === 'object' ? p.mods : {}) as Record<string, Partial<MrMod>>;
  const mods: Record<string, MrMod> = {};
  let maxId = 0;
  for (const [key, m] of Object.entries(src)) {
    if (!m || typeof m !== 'object') continue;
    const def = mrModuleDef(Number(m.type));
    const id = Number(key);
    if (!def || !Number.isInteger(id) || id <= 0) continue;
    const d = mrDefaults(def.type);
    const pv = Array.isArray(m.p) ? m.p : [];
    const mx = Array.isArray(m.mx) ? m.mx : [];
    mods[key] = {
      id, type: def.type,
      p: d.map((dv, i) => clamp01(pv[i], dv)),
      mx: MR_MIX_DEFAULT.map((dv, i) => clamp01(mx[i], dv)),
      ...(m.min ? { min: true } : {}),
    };
    maxId = Math.max(maxId, id);
  }
  const seen = new Set<number>();
  const order: number[] = [];
  for (const id of Array.isArray(p.order) ? (p.order as unknown[]) : []) {
    const n = Number(id);
    if (mods[String(n)] && !seen.has(n)) { seen.add(n); order.push(n); }
  }
  for (const key of Object.keys(mods)) { const n = Number(key); if (!seen.has(n)) { seen.add(n); order.push(n); } }
  const next = Math.max(maxId + 1, typeof p.next === 'number' && Number.isFinite(p.next) ? Math.floor(p.next) : 1);
  return { ...p, mods, order, next };
}

export const def: FxPluginDef = {
  id: 'mobilerack',
  name: 'FL Studio Mobile Rack FX',
  category: 'Misc',
  width: 575,
  height: 605,
  description: 'Rack of FL Studio Mobile effect modules in series',
  params: [],
  state: () => ({ ...mrRack([REVERB2]) }),
  normalize: mrNormalize,
  presets: PRESETS,
};
