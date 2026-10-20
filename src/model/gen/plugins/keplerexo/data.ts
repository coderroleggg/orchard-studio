// Kepler Exo parameter model: FL's 155 parameters (names and control ranges in params.ts; FL's parameter index is
// the engine's parameter id), FL's value texts (reproduced from the Pascal wrapper's text function, ../kepler/texts.ts),
// the non-parameter state FL keeps in the engine's state blob and FL's 188 factory presets (presets.ts).
// See docs/research/gen/kepler.md.
//
// State of a Kepler Exo channel (JSON; the parameter keys first, then):
//   modMatrix  { src: number[8], dst: number[8] }  the 8 modulation matrix slots (amounts are the parameters modAmount1..8):
//              src[k] = modulation source index 0..23 (KEPLEREXO_MOD_SOURCES), -1 = none;
//              dst[k] = destination engine parameter id (0..154 = the FL parameter with that index, 256 DCO1 Pitch,
//              257 DCO2 Pitch; keplerExoModDestName), -1 = none. Default: all -1.
//              (FL stores (src, dst) pairs; a source index >= 24 crashes FL's engine, normalize() repairs invalid values.)
//   arpQuantize          boolean  Options > "Arp 1st Step Quantize"   (engine byte this+0x1c998; default false)
//   hq                   boolean  Options > "HQ mode"                 (engine oversampling factor: true = 4, false = 2; default false)
//   enhancedOscillators  boolean  Options > "Enhanced Oscillators"    (engine byte this+0x1ceb0; default false)
//   modPage              0 | 1    the matrix page selector: slots 1-4 (0) or 5-8 (1); view only, not in FL's blob
//   theme                number   Options > Theme; FL keeps it in its registry, not in the state; view only
// FL's preset files (versions 1 and 2) store the parameters and the matrix only: arpQuantize, hq and
// enhancedOscillators keep the instance's values when a preset loads, so they are view state (def.viewState).

import { KEPLEREXO_MAX, KEPLEREXO_MIN, KEPLEREXO_PARAM_KEYS, KEPLEREXO_PARAM_NAMES } from './params';
import { KEPLEREXO_PRESET_DATA, KEPLEREXO_PRESET_NAMES } from './presets';
import {
  ARP_SYNC_TEXT, DELAY_SYNC_TEXT, cutoffHz, ctrlValue, eqGain, eqQ, expInterp, fpcFix, hpHz, lfo1Hz, lfo2Hz, noteIndex, norm,
  pctText, rate10Hz, roundEven, syncRateText, volumeText,
} from '../kepler/texts';

export { KEPLEREXO_MAX, KEPLEREXO_MIN, KEPLEREXO_PARAM_KEYS, KEPLEREXO_PARAM_NAMES, KEPLEREXO_PRESET_DATA, KEPLEREXO_PRESET_NAMES };

export const KEPLEREXO_PARAM_COUNT = 155;
export const KEPLEREXO_MOD_SLOTS = 8;

/** Modulation sources, by the index stored in the matrix (the engine's order; FL's own list shows the first 21 under other names). */
export const KEPLEREXO_MOD_SOURCES: string[] = [
  'LFO1 Bipolar Triangle', 'LFO2 Bipolar', 'Env1', 'Env2', 'Velocity On', 'Velocity Off', 'ModX Bipolar', 'ModY Bipolar',
  'Gate', 'Gate Inverted', 'LFO1 Bipolar Sine', 'LFO1 Unipolar Triangle', 'LFO2 Unipolar', 'Key Follow Bipolar',
  'LFO1 Bipolar Triangle Extra', 'LFO2 Bipolar Extra', 'LFO1 Bipolar Sine Extra', 'LFO1 Unipolar Triangle Extra',
  'LFO2 Unipolar Extra', 'Alternate Bipolar', 'Key Follow Unipolar', 'Random Bipolar', 'ModX Unipolar', 'ModY Unipolar',
];

/** Engine ids beyond the FL parameters that a matrix slot can target. */
export const KEPLEREXO_MOD_EXTRA_DESTS: Record<number, string> = { 256: 'DCO1 Pitch', 257: 'DCO2 Pitch' };

/** Name of a matrix destination (engine parameter id). */
export function keplerExoModDestName(id: number): string {
  if (id >= 0 && id < KEPLEREXO_PARAM_COUNT) return KEPLEREXO_PARAM_NAMES[id];
  return KEPLEREXO_MOD_EXTRA_DESTS[id] ?? '';
}

/** Valid matrix destination ids (-1 = none). */
export function keplerExoModDestValid(id: number): boolean {
  return id === -1 || (id >= 0 && id < KEPLEREXO_PARAM_COUNT) || id in KEPLEREXO_MOD_EXTRA_DESTS;
}

export interface KeplerExoOptions {
  arpQuantize: boolean;
  hq: boolean;
  enhancedOscillators: boolean;
}

export const KEPLEREXO_OPTION_KEYS: (keyof KeplerExoOptions)[] = ['arpQuantize', 'hq', 'enhancedOscillators'];
export const KEPLEREXO_OPTION_DEFAULT: KeplerExoOptions = { arpQuantize: false, hq: false, enhancedOscillators: false };

/** FL's Options menu (the wrapper's button next to the title): captions in FL's order, '-' = separator; "Theme" (a submenu of FL's themes) follows. */
export const KEPLEREXO_OPTIONS_MENU: ({ key: keyof KeplerExoOptions; label: string } | '-')[] = [
  { key: 'arpQuantize', label: 'Arp 1st Step Quantize' },
  '-',
  { key: 'hq', label: 'HQ mode' },
  { key: 'enhancedOscillators', label: 'Enhanced Oscillators' },
  '-',
];

export interface KeplerExoModMatrix { src: number[]; dst: number[] }

export const keplerExoDefaultMatrix = (): KeplerExoModMatrix => ({ src: new Array(8).fill(-1), dst: new Array(8).fill(-1) });

/** Engine floats of the chorus mode positions Off / Chorus 1 / Chorus 2 / Chorus 1+2 (FL sends 0.33 and 0.66, not thirds). */
export const KEPLEREXO_CHORUS_MODE_FLOAT: readonly number[] = [0, Math.fround(0.33), Math.fround(0.66), 1];

/**
 * The engine's float of a control value, as FL's wrapper sends it: (v - Min) * (1 / (Max - Min)) clamped to 0..1 in
 * single precision, except the chorus mode (parameter 69: KEPLEREXO_CHORUS_MODE_FLOAT) and DCO2 semitones
 * (parameter 13: (v + 0.1 sign(v) - Min) / (Max - Min), so that 24 is sent as 24.1 semitones).
 */
export function keplerExoEngineValue(i: number, v: number): number {
  if (i === 69) return KEPLEREXO_CHORUS_MODE_FLOAT[Math.min(3, Math.max(0, Math.round(v)))];
  if (i === 13) return Math.fround(Math.min(1, Math.max(0, (v + 0.1 * Math.sign(v) - KEPLEREXO_MIN[13]) / (KEPLEREXO_MAX[13] - KEPLEREXO_MIN[13]))));
  return Math.fround(norm(v, KEPLEREXO_MIN[i], KEPLEREXO_MAX[i]));
}

const ONOFF = ['Off', 'On'];
const SHAPES = ['Sine', 'Triangle', 'Pulse', 'Saw', 'Noise'];
const PW_SOURCE = ['LFO1', 'Man', 'Env1'];
const ENUMS: Record<number, string[]> = {
  6: PW_SOURCE, 25: PW_SOURCE, 30: [...SHAPES, 'DCO1'], 31: [...SHAPES, 'DCO2'],
  40: ['6 dB/Oct', '12 dB/Oct', '18 dB/Oct', '24 dB/Oct'], 42: [...SHAPES, 'DCO1 out'], 43: ['POS', 'NEG'],
  47: ['Env1', 'Gate', 'Env2'], 51: ['Auto', 'Man'], 57: ['Auto', 'Man'],
  58: ['Triangle', 'Ramp Up', 'Ramp Down', 'Sine', 'Random', 'Random+Glide'],
  69: ['Off', 'Chorus 1', 'Chorus 2', 'Chorus 1+2'], 79: ['Exp', 'Linear'], 83: ['-1', '0', '+1'], 88: ['1', '2', '3'],
  89: ['Up', 'Up/Down', 'Down', 'Random 1', 'Random 2', 'Random 3', 'As played up', 'As played up/down', 'As played down'],
  117: ['LP', 'HP', 'BP', 'Off'], 136: ['Pre', 'Post'], 144: ['4', '8'],
};
for (const i of [1, 3, 8, 9, 12, 15, 16, 21, 23, 27, 49, 52, 55, 59, 71, 75, 76, 77, 78, 81, 82, 85, 87, 100, 110, 111, 121, 134, 137, 151, 152, 154]) ENUMS[i] = ONOFF;

/** FL's control captions / choices of the switch parameters. */
export function keplerExoOptions(i: number): string[] | undefined {
  return ENUMS[i];
}

const MS = new Set([50, 56, 61, 62, 64, 65, 66, 68]);
const BIPOLAR_PCT = new Set([14, 92, 93, 94, 95, 96, 97, 98, 99]);
const sync = (st: Record<string, unknown> | undefined, key: string): boolean => Number(st?.[key] ?? 0) >= 0.5;

/** FL's value text of parameter i at control value v; `st` = the plugin state (tempo sync switches). */
export function keplerExoFormat(i: number, v: number, st?: Record<string, unknown>): string {
  const mn = KEPLEREXO_MIN[i];
  const mx = KEPLEREXO_MAX[i];
  const r = ctrlValue(v, mn, mx);
  const d = norm(r, mn, mx);
  switch (i) {
    case 7: case 26: return pctText(d); // FL prints the two "pulse active" switches as 0.0% / 100.0%
    case 13: return String(r);
    case 36: return `${fpcFix(hpHz(d), 2)} Hz`;
    case 37: return `${fpcFix(cutoffHz(d), 2)} Hz`;
    case 48: return sync(st, 'lfo1Sync') ? syncRateText(d) : `${fpcFix(lfo1Hz(d), 2)} Hz`;
    case 54: return sync(st, 'lfo2Sync') ? syncRateText(d) : `${fpcFix(lfo2Hz(d), 2)} Hz`;
    case 72: return volumeText(d);
    case 86: return sync(st, 'arpSync') ? ARP_SYNC_TEXT[noteIndex(d, 13)] : `${fpcFix(rate10Hz(d), 2)} Hz`;
    case 101: case 102: case 103: return fpcFix(eqQ(d), 2);
    case 104: case 105: case 106: return `${fpcFix(eqGain(d), 2)} dB`;
    case 107: case 108: case 109: return `${fpcFix(expInterp(d, 20, 21000), 0)} Hz`;
    case 113:
      return sync(st, 'delaySync') ? DELAY_SYNC_TEXT[noteIndex(d, 18)] : `${fpcFix((0.01 + 0.49 * d) * 1000, 1)} ms`;
    case 122: return d === 0 ? 'Off' : `${fpcFix(19 + 2981 * d, 1)} Hz`;
    case 123: return d === 0 ? 'Off' : `${fpcFix(500 + 21600 * d, 1)} Hz`;
    case 124: return `${fpcFix(125 * d, 1)} ms`;
    case 145: return `${fpcFix(expInterp(d, 714, 22000), 1)} Hz`;
    case 146: return `${fpcFix(expInterp(d, 12, 1090), 1)} Hz`;
    case 147: {
      const w = roundEven(d * 100);
      return `${100 - w}% Dry / ${w}% Wet`;
    }
    case 153: return fpcFix((d - 0.5) * 24, 2);
    default:
      if (ENUMS[i]) return ENUMS[i][Math.min(Math.max(r - mn, 0), ENUMS[i].length - 1)];
      if (MS.has(i)) return `${fpcFix(1000 * d, 1)} ms`;
      if (BIPOLAR_PCT.has(i)) return `${fpcFix(d * 200 - 100, 1)}%`;
      return pctText(d);
  }
}

/** Typed value (display units) -> control value, for the linear texts. */
export function keplerExoParse(i: number): ((t: number) => number) | undefined {
  const mn = KEPLEREXO_MIN[i];
  const rg = KEPLEREXO_MAX[i] - mn;
  switch (i) {
    case 13: return (t) => t;
    case 72: return (t) => mn + 10 ** (t / 20) * rg;
    case 104: case 105: case 106: return (t) => mn + ((t + 16) / 32) * rg;
    case 113: return undefined;
    case 124: return (t) => mn + (t / 125) * rg;
    case 153: return (t) => mn + (t / 24 + 0.5) * rg;
    default:
      if (ENUMS[i] || [36, 37, 48, 54, 86, 101, 102, 103, 107, 108, 109, 122, 123, 145, 146, 147].includes(i)) return undefined;
      if (MS.has(i)) return (t) => mn + (t / 1000) * rg;
      if (BIPOLAR_PCT.has(i)) return (t) => mn + ((t + 100) / 200) * rg;
      return (t) => mn + (t / 100) * rg;
  }
}

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' && Number.isFinite(v) ? v !== 0 : d);
const rnd = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);

/** A matrix as FL's engine accepts it: 8 sources in -1..23, 8 destinations among the valid ids. */
export function keplerExoNormalizeMatrix(m: unknown): KeplerExoModMatrix {
  const o = (m && typeof m === 'object' ? m : {}) as { src?: unknown; dst?: unknown };
  const src = Array.isArray(o.src) ? o.src : [];
  const dst = Array.isArray(o.dst) ? o.dst : [];
  return {
    src: Array.from({ length: 8 }, (_, k) => { const s = rnd(src[k], -1); return s >= 0 && s < KEPLEREXO_MOD_SOURCES.length ? s : -1; }),
    dst: Array.from({ length: 8 }, (_, k) => { const d = rnd(dst[k], -1); return keplerExoModDestValid(d) ? d : -1; }),
  };
}

/** A preset's whole state: parameter values by key + matrix. */
export function keplerExoPresetState(i: number): Record<string, unknown> {
  const row = KEPLEREXO_PRESET_DATA[i];
  const st: Record<string, unknown> = {};
  for (let k = 0; k < KEPLEREXO_PARAM_COUNT; k++) st[KEPLEREXO_PARAM_KEYS[k]] = row[k];
  st.modMatrix = { src: row.slice(155, 163), dst: row.slice(163, 171) };
  return st;
}

/** Insertion state: FL's plugin database entry = the "Default" preset. */
export const KEPLEREXO_DEFAULT_ROW = KEPLEREXO_PRESET_DATA[0];

/** The Options switches of a (possibly partial) stored state. */
export function keplerExoOptionsOf(p: Record<string, unknown>): KeplerExoOptions {
  const o = { ...KEPLEREXO_OPTION_DEFAULT };
  for (const k of KEPLEREXO_OPTION_KEYS) o[k] = bool(p[k], KEPLEREXO_OPTION_DEFAULT[k]);
  return o;
}

/** The engine's parameter vector (ids 0..154, normalised floats) of a Kepler Exo state: the 155 parameters through FL's conversion. */
export function keplerExoEngineVector(p: Record<string, unknown>): Float32Array {
  const v = new Float32Array(KEPLEREXO_PARAM_COUNT);
  for (let i = 0; i < KEPLEREXO_PARAM_COUNT; i++) {
    const x = Number(p[KEPLEREXO_PARAM_KEYS[i]]);
    v[i] = keplerExoEngineValue(i, Number.isFinite(x) ? x : KEPLEREXO_DEFAULT_ROW[i]);
  }
  return v;
}

/** Repair the non-parameter fields of a stored state. */
export function keplerExoNormalize(p: Record<string, unknown>): Record<string, unknown> {
  const q: Record<string, unknown> = { ...p };
  if (typeof q.__keplerexo === 'number') {
    const st = keplerExoPresetState(q.__keplerexo);
    delete q.__keplerexo;
    Object.assign(q, st);
  }
  for (const k of KEPLEREXO_OPTION_KEYS) q[k] = bool(q[k], KEPLEREXO_OPTION_DEFAULT[k]);
  q.modMatrix = keplerExoNormalizeMatrix(q.modMatrix);
  q.modPage = rnd(q.modPage, 0) === 1 ? 1 : 0;
  q.theme = Math.max(0, rnd(q.theme, 0));
  return q;
}
