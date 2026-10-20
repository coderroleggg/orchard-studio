// Kepler parameter model: FL's 36 parameters (names, control ranges and the engine ids they drive, in params.ts),
// FL's value texts (reproduced from the wrapper's text function, texts.ts), the non-parameter state FL keeps in the
// engine's state blob (the Options menu) and FL's 277 factory presets (presets.ts). See docs/research/gen/kepler.md.
//
// State of a Kepler channel (everything JSON; keys of `def.params` first, then these):
//   arpQuantize      boolean  Options > "Quantize first arpeggiator step"   (engine byte this+0x1c998; default false)
//   velocityToVolume boolean  Options > "Velocity to volume"                (engine parameter 73: true = 1.0, false = 0.0; default true)
//   alignSubPhase    boolean  Options > "Align sub oscillator phase"        (engine parameter 11: true = 0.0, false = 0.5; default false)
//   chorusNoiseGate  boolean  Options > "Chorus noise gate"                 (engine noise-gate flag = Kepler Exo parameter 71; default false)
//   chorusNoise      boolean  Options > "Chorus noise"                      (engine parameter 70: true = 0.09, false = 0.0; default false)
//   hq               boolean  Options > "HQ mode"                           (engine oversampling factor: true = 4, false = 2; default false)
// Presets set the first three; noise gate, chorus noise and HQ are not in FL's preset files (FL's loader keeps the
// instance's current values), so they are view state here (def.viewState): a preset load keeps them.

import { KEPLER_ENGINE_DEFAULTS, KEPLER_ENGINE_ID, KEPLER_MAX, KEPLER_MIN, KEPLER_PARAM_KEYS, KEPLER_PARAM_NAMES } from './params';
import { KEPLER_PRESET_DATA, KEPLER_PRESET_NAMES } from './presets';
import {
  ARP_SYNC_TEXT, cutoffHz, ctrlValue, fpcFix, hpHz, noteIndex, norm, pctText, rate10Hz, syncRateText, volumeText,
} from './texts';

export {
  KEPLER_ENGINE_DEFAULTS, KEPLER_ENGINE_ID, KEPLER_MAX, KEPLER_MIN, KEPLER_PARAM_KEYS, KEPLER_PARAM_NAMES, KEPLER_PRESET_DATA,
  KEPLER_PRESET_NAMES,
};

export const KEPLER_PARAM_COUNT = 36;

/** The six Options-menu switches (see the header). */
export interface KeplerOptions {
  arpQuantize: boolean;
  velocityToVolume: boolean;
  alignSubPhase: boolean;
  chorusNoiseGate: boolean;
  chorusNoise: boolean;
  hq: boolean;
}

export const KEPLER_OPTION_KEYS: (keyof KeplerOptions)[] = [
  'arpQuantize', 'velocityToVolume', 'alignSubPhase', 'chorusNoiseGate', 'chorusNoise', 'hq',
];

/** FL's Options menu (the wrapper's button next to the title): captions in FL's order, '-' = separator. */
export const KEPLER_OPTIONS_MENU: ({ key: keyof KeplerOptions; label: string } | '-')[] = [
  { key: 'arpQuantize', label: 'Quantize first arpeggiator step' },
  { key: 'velocityToVolume', label: 'Velocity to volume' },
  { key: 'alignSubPhase', label: 'Align sub oscillator phase' },
  '-',
  { key: 'chorusNoise', label: 'Chorus noise' },
  { key: 'chorusNoiseGate', label: 'Chorus noise gate' },
  '-',
  { key: 'hq', label: 'HQ mode' },
];

/** Options a preset file stores (the others stay as they are when a preset loads). */
export const KEPLER_PRESET_OPTION_KEYS: (keyof KeplerOptions)[] = ['arpQuantize', 'velocityToVolume', 'alignSubPhase'];

/** Option defaults = FL's insertion state. */
export const KEPLER_OPTION_DEFAULT: KeplerOptions = {
  arpQuantize: false, velocityToVolume: true, alignSubPhase: false, chorusNoiseGate: false, chorusNoise: false, hq: false,
};

/** Engine floats of the chorus mode positions Off / Chorus 1 / Chorus 2 / Chorus 1 + 2 (FL sends 0.33 and 0.66, not thirds). */
export const KEPLER_CHORUS_MODE_FLOAT: readonly number[] = [0, Math.fround(0.33), Math.fround(0.66), 1];

/**
 * The engine's float of a control value, as FL's wrapper sends it: (v - Min) * (1 / (Max - Min)) clamped to 0..1 in
 * single precision, except the chorus mode (parameter 30: KEPLER_CHORUS_MODE_FLOAT).
 */
export function keplerEngineValue(i: number, v: number): number {
  if (i === 30) return KEPLER_CHORUS_MODE_FLOAT[Math.min(3, Math.max(0, Math.round(v)))];
  return Math.fround(norm(v, KEPLER_MIN[i], KEPLER_MAX[i]));
}

/** Engine parameter values (by engine id) the Options switches stand for. */
export function keplerOptionEngineValues(o: KeplerOptions): { velocityToVolume: number; subOscPhase: number; chorusNoise: number; chorusNoiseGate: number; oversampling: number } {
  return {
    velocityToVolume: o.velocityToVolume ? 1 : 0,
    subOscPhase: o.alignSubPhase ? 0 : 0.5,
    chorusNoise: o.chorusNoise ? 0.09 : 0,
    chorusNoiseGate: o.chorusNoiseGate ? 1 : 0,
    oversampling: o.hq ? 4 : 2,
  };
}

const ONOFF = ['Off', 'On'];
const ENUMS: Record<number, string[]> = {
  0: ONOFF, 1: ['UP', 'UP/DOWN', 'DOWN'], 2: ['1', '2', '3'], 4: ONOFF, 6: ONOFF, 8: ['AUTO', 'MAN'], 9: ONOFF,
  12: ['LFO', 'MAN', 'ENV'], 13: ONOFF, 14: ONOFF, 15: ONOFF, 21: ['POS', 'NEG'], 25: ['ENV', 'GATE'],
  30: ['Off', 'Chorus 1', 'Chorus 2', 'Chorus 1 + 2'], 31: ONOFF, 32: ['-1', '0', '+1'], 34: ONOFF,
};
/** FL's control captions / choices of the switch parameters. */
export function keplerOptions(i: number): string[] | undefined {
  return ENUMS[i];
}

const MS = new Set([7, 26, 27, 29]);
const sync = (st: Record<string, unknown> | undefined, key: string): boolean => Number(st?.[key] ?? 0) >= 0.5;

/** FL's value text of parameter i at control value v; `st` = the plugin state (tempo sync switches). */
export function keplerFormat(i: number, v: number, st?: Record<string, unknown>): string {
  const mn = KEPLER_MIN[i];
  const mx = KEPLER_MAX[i];
  const r = ctrlValue(v, mn, mx);
  const d = norm(r, mn, mx);
  switch (i) {
    case 1: return r === 1 ? 'UP/DOWN' : 'UP'; // FL prints "UP" for the third position too
    case 2: return String(r + 1);
    case 3:
      return sync(st, 'arpSync') ? ARP_SYNC_TEXT[noteIndex(d, 13)] : `${fpcFix(rate10Hz(d), 2)} Hz`;
    case 5:
      return sync(st, 'lfoSync') ? syncRateText(d) : `${fpcFix(rate10Hz(d), 2)} Hz`;
    case 18: return `${fpcFix(hpHz(d), 2)} Hz`;
    case 19: return `${fpcFix(cutoffHz(d), 2)} Hz`;
    case 33: return volumeText(d);
    default:
      if (ENUMS[i]) return ENUMS[i][Math.min(Math.max(r - mn, 0), ENUMS[i].length - 1)];
      if (MS.has(i)) return `${fpcFix(1000 * d, 1)} ms`;
      return pctText(d);
  }
}

/** Typed value (display units) -> control value, for the linear texts. */
export function keplerParse(i: number): ((t: number) => number) | undefined {
  const mn = KEPLER_MIN[i];
  const rg = KEPLER_MAX[i] - mn;
  if (MS.has(i)) return (t) => mn + (t / 1000) * rg;
  if (i === 33) return (t) => mn + 10 ** (t / 20) * rg;
  if (ENUMS[i] || i === 3 || i === 5 || i === 18 || i === 19) return undefined;
  return (t) => mn + (t / 100) * rg;
}

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' && Number.isFinite(v) ? v !== 0 : d);

/** A preset's whole state: parameter values by key + options. */
export function keplerPresetState(i: number): Record<string, unknown> {
  const row = KEPLER_PRESET_DATA[i];
  const st: Record<string, unknown> = {};
  for (let k = 0; k < KEPLER_PARAM_COUNT; k++) st[KEPLER_PARAM_KEYS[k]] = row[k];
  KEPLER_PRESET_OPTION_KEYS.forEach((key, k) => { st[key] = row[KEPLER_PARAM_COUNT + k] !== 0; });
  return st;
}

/** Insertion state: FL's plugin database entry = the "Default" preset. */
export const KEPLER_DEFAULT_ROW = KEPLER_PRESET_DATA[0];

/** The Options switches of a (possibly partial) stored state. */
export function keplerOptionsOf(p: Record<string, unknown>): KeplerOptions {
  const o = { ...KEPLER_OPTION_DEFAULT };
  for (const k of KEPLER_OPTION_KEYS) {
    const v = p[k];
    o[k] = typeof v === 'boolean' ? v : typeof v === 'number' && Number.isFinite(v) ? v !== 0 : KEPLER_OPTION_DEFAULT[k];
  }
  return o;
}

/**
 * The engine's parameter vector (ids 0..154, normalised floats) a Kepler state stands for: the engine parameters Kepler does
 * not expose at their insertion values (KEPLER_ENGINE_DEFAULTS), the 36 parameters through FL's conversion at their engine ids,
 * and the Options switches as FL's menu applies them (velocity to volume = id 73, sub oscillator phase = id 11, chorus noise =
 * id 70, chorus noise gate = id 71).
 */
export function keplerEngineVector(p: Record<string, unknown>): Float32Array {
  const v = new Float32Array(155);
  v.set(KEPLER_ENGINE_DEFAULTS);
  for (let i = 0; i < KEPLER_PARAM_COUNT; i++) {
    const x = Number(p[KEPLER_PARAM_KEYS[i]]);
    v[KEPLER_ENGINE_ID[i]] = keplerEngineValue(i, Number.isFinite(x) ? x : KEPLER_DEFAULT_ROW[i]);
  }
  const o = keplerOptionEngineValues(keplerOptionsOf(p));
  v[73] = o.velocityToVolume;
  v[11] = o.subOscPhase;
  v[70] = o.chorusNoise;
  v[71] = o.chorusNoiseGate;
  return v;
}

/** Repair the option fields of a stored state. */
export function keplerNormalize(p: Record<string, unknown>): Record<string, unknown> {
  const q: Record<string, unknown> = { ...p };
  if (typeof q.__kepler === 'number') {
    const st = keplerPresetState(q.__kepler);
    delete q.__kepler;
    Object.assign(q, st);
  }
  for (const k of KEPLER_OPTION_KEYS) q[k] = bool(q[k], KEPLER_OPTION_DEFAULT[k]);
  return q;
}
