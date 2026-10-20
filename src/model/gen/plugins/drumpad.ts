// Drumpad (FL: Drumpad, Plugin database > Generators > Drum; by Maxx
// Claster): a physical-modelling drum synth: mallet, membrane (a bank of
// tuned combs), SOF / LOW / MID / HIGH filters, hold, Lo-Fi and four velocity
// modulations (docs/research/gen/drumpad.md). It uses no samples.
//
// From FL 2026's binaries: the parameter list and value texts (test host
// sweeps: every text matches the formats below for all values), the editor
// (Drumpad's engine dylib: DrumpadEditor 794 x 225) and the engine's mapping
// (FL's wrapper hands it control / 256, the velocity targets 30..33 as they
// are). The 961 factory presets (.fst: the engine's 38 floats) are kept exactly
// as control values x 256 (./drumpad/presets.ts); FL's knobs show them rounded.
// Fresh instance: FL adds the plugin with Plugin database/Generators/Drum/
// Drumpad.fst, the "Default Kick" preset (state() gives it); the parameters'
// defaults are FL's form values (each wheel's Reset value: 128).

import type { GenPluginDef } from '../types';
import { DP_PRESET_NAMES, dpPresetValues } from './drumpad/presets';
import { DP_KEYS } from './drumpad/keys';

export { DP_KEYS };

type P = GenPluginDef['params'][number];

/** FL's velocity modulation targets (value 0 = none; value k targets parameter k + 1). */
export const DP_TARGETS = [' ', 'Mallet Amplitude', 'Mallet Decay', 'Mallet Noise', 'Mallet Noise RP', 'Membrane Decay', 'Membrane Cutoff',
  'Membrane Tension', 'Membrane Phase', 'Membrane Material', 'Membrane Size', 'Membrane Shape', 'LOW Freq', 'LOW Res', 'SOF Freq', 'SOF Decay',
  'SOF Level', 'MID Freq', 'MID Level', 'MID Res', 'MID Freq Mod', 'MID Level Mod', 'MID Attack', 'HIGH Freq', 'HIGH Level', 'HIGH Res', 'Lo-Fi',
  'Hold', 'Pitch'];


const NAMES = ['Mallet retrig', 'Retrig', 'Mallet amplitude', 'Mallet decay', 'Mallet noise', 'Mallet noise RP', 'Membrane decay', 'Membrane cutoff',
  'Membrane tension', 'Membrane phase', 'Membrane material', 'Membrane size', 'Membrane shape', 'LOW frequency', 'LOW reso', 'SOF frequency',
  'SOF decay', 'SOF level', 'MID frequency', 'MID level', 'MID res', 'MID frequency mod', 'MID level mod', 'MID attack', 'HIGH frequency',
  'HIGH level', 'HIGH res', 'Lo-Fi', 'Hold', 'Pitch', 'Velocity mod 1 target', 'Velocity mod 2 target', 'Velocity mod 3 target',
  'Velocity mod 4 target', 'Velocity mod 1 value', 'Velocity mod 2 value', 'Velocity mod 3 value', 'Velocity mod 4 value'];

/** FL's form defaults (the wheels' Reset value 128; check box, selector and combos 0). */
const DEFS = Array.from({ length: 38 }, (_, i) => (i <= 1 || (i >= 30 && i <= 33) ? 0 : 128));

/** The fresh instance: FL's plugin database state, the "Default Kick" preset. */
export const DP_FRESH = 'Default/Default Kick';

const BIPOLAR = new Set([19, 21, 22, 25, 29]);
const RETRIG = ['0', 'I', 'II', 'III'];

/** FL's value text (FL's knobs hold whole numbers: preset values show rounded). */
export function dpText(i: number, x: number): string {
  if (i >= 30 && i <= 33) return DP_TARGETS[Math.round(x)] ?? '';
  const v = Math.round(x);
  if (i === 0) return v ? 'On' : 'Off';
  if (i === 1) return RETRIG[Math.min(3, Math.trunc(Math.fround(Math.fround(v * 0.00390625) * 3)))];
  const t = BIPOLAR.has(i) ? (v / 128 - 1) * 100 : (v / 256) * 100;
  return `${t.toFixed(2)} %`;
}

const param = (i: number): P => {
  const key = DP_KEYS[i];
  if (i >= 30 && i <= 33) return { key, name: NAMES[i], index: i, min: 0, max: 28, def: 0, options: DP_TARGETS, format: (x) => dpText(i, x) };
  return {
    key, name: NAMES[i], index: i, min: 0, max: 256, def: DEFS[i], bipolar: BIPOLAR.has(i), format: (x) => dpText(i, x),
    parse: i <= 1 ? undefined : (t) => (BIPOLAR.has(i) ? (t / 100 + 1) * 128 : (t / 100) * 256),
  };
};

export const def: GenPluginDef = {
  id: 'drumpad',
  name: 'Drumpad',
  category: 'Drum',
  notes: 'events',
  velocity: 'plugin',
  width: 794,
  height: 225,
  description: 'Physical-modelling drum synthesizer',
  params: Array.from({ length: 38 }, (_, i) => param(i)),
  state: () => {
    const v = dpPresetValues(DP_PRESET_NAMES.indexOf(DP_FRESH));
    const q: Record<string, unknown> = {};
    if (v) DP_KEYS.forEach((k, i) => { q[k] = v[i]; });
    return q;
  },
  normalize: (p) => {
    const q: Record<string, unknown> = { ...p };
    if (typeof q.__dp === 'number') {
      const v = dpPresetValues(q.__dp);
      delete q.__dp;
      if (v) DP_KEYS.forEach((k, i) => { q[k] = v[i]; });
    }
    return q;
  },
  presets: DP_PRESET_NAMES.map((name, i) => ({ name, params: { __dp: i } })),
};
