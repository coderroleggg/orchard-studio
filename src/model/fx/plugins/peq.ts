// Parametric EQ (FL: Fruity Parametric EQ, legacy 7-band EQ). Form: 240 x 350.
// FL's parameter order: levels 1-7 (Tags 0-6, -1800..1800 = -18..+18 dB),
// frequencies 1-7 (7-13, 0..65536), widths 1-7 (14-20, 0..65536),
// types 1-7 (21-27, 0..7) and main level (28, 0..256, 128 = unity).
// Value texts and mappings were read from FL's plugin (flfxhost info/sweep).

import type { FxParamDef, FxPluginDef } from '../types';

export const PEQ_BANDS = 7;

export const PEQ_TYPES = ['Disabled', 'Low pass', 'Band pass', 'High pass', 'Notch', 'Low shelf', 'Peaking', 'High shelf'] as const;

/** Band type values. */
export const PEQ_OFF = 0, PEQ_LP = 1, PEQ_BP = 2, PEQ_HP = 3, PEQ_NOTCH = 4, PEQ_LSHELF = 5, PEQ_PEAK = 6, PEQ_HSHELF = 7;

/** Frequency (Hz) for a frequency wheel value: 10 Hz .. 16 kHz (measured). */
export function peqFreqHz(v: number): number {
  const t = Math.min(1, Math.max(0, v / 65536));
  return 10 + 159.9 * (Math.pow(101, t) - 1);
}

/** Inverse of peqFreqHz. */
export function peqFreqValue(hz: number): number {
  const t = Math.log(1 + (Math.max(10, hz) - 10) / 159.9) / Math.log(101);
  return Math.min(65536, Math.max(0, Math.round(t * 65536)));
}

/** Width wheel -> Q for low/band/high pass and notch: 0.1 .. 19, linear. */
export function peqFilterQ(width: number): number {
  return 0.1 + 18.9 * Math.min(1, Math.max(0, width / 65536));
}

/** Width wheel -> Q for peaking bands: 0.1 .. 100, exponential (FL: 0.1 + 0.0999 (1001^t - 1)). */
export function peqPeakQ(width: number): number {
  return 0.1 + 0.0999 * (Math.pow(1001, Math.min(1, Math.max(0, width / 65536))) - 1);
}

/** Width wheel -> shelf slope S (RBJ cookbook): 0.1 .. 2, linear. */
export function peqShelfSlope(width: number): number {
  return 0.1 + 1.9 * Math.min(1, Math.max(0, width / 65536));
}

/** Main level gain: (11^(v/128) - 1) / 10 (128 = unity, 256 = x12). */
export function peqMainGain(v: number): number {
  return (Math.pow(11, Math.min(256, Math.max(0, v)) / 128) - 1) / 10;
}

export const PEQ_DEF_FREQ = [5777, 13024, 19904, 33145, 42327, 49307, 55825];
// FL's initial widths (the form's DefaultValue is 17500 for every band; the
// plugin starts bands 5 and 6 at 24000)
export const PEQ_DEF_WIDTH = [17500, 17500, 17500, 17500, 24000, 24000, 17500];
export const PEQ_DEF_TYPE = [5, 6, 6, 6, 6, 6, 7];

export const levelText = (v: number) => `${(v / 100).toFixed(1)}dB`;
export const freqText = (v: number) => `${Math.round(peqFreqHz(v))}Hz`;
export const widthText = (v: number) => `${Math.round((v / 65536) * 100)}%`;
export const mainText = (v: number) => `${Math.round((v / 256) * 100)}%`;

function params(): FxParamDef[] {
  const out: FxParamDef[] = [];
  for (let b = 0; b < PEQ_BANDS; b++) out.push({ key: `level${b + 1}`, name: `Band ${b + 1} level`, index: b, min: -1800, max: 1800, def: 0, bipolar: true, format: levelText, parse: (db) => Math.round(db * 100) });
  for (let b = 0; b < PEQ_BANDS; b++) out.push({ key: `freq${b + 1}`, name: `Band ${b + 1} freq`, index: 7 + b, min: 0, max: 65536, def: PEQ_DEF_FREQ[b], format: freqText, parse: (hz) => peqFreqValue(hz) });
  for (let b = 0; b < PEQ_BANDS; b++) out.push({ key: `width${b + 1}`, name: `Band ${b + 1} width`, index: 14 + b, min: 0, max: 65536, def: PEQ_DEF_WIDTH[b], format: widthText, parse: (pc) => Math.round((pc / 100) * 65536) });
  for (let b = 0; b < PEQ_BANDS; b++) out.push({ key: `type${b + 1}`, name: `Band ${b + 1} type`, index: 21 + b, min: 0, max: 7, def: PEQ_DEF_TYPE[b], options: [...PEQ_TYPES] });
  out.push({ key: 'main', name: 'Main level', index: 28, min: 0, max: 256, def: 128, format: mainText, parse: (pc) => Math.round((pc / 100) * 256) });
  return out;
}

// FL's factory presets: raw values in FL's parameter order (levels, freqs,
// widths, types, main), read from the .fst states with the test host.
const FACTORY: [string, number[]][] = [
  ['AH', [0, 0, 1720, 880, 980, 0, 0, 5777, 13024, 24565, 30073, 39904, 49307, 55825, 17500, 17500, 36188, 34908, 39360, 24000, 17500, 0, 0, 6, 6, 6, 0, 0, 128]],
  ['AH 2', [0, 0, 1720, 880, 980, 0, 0, 5777, 26592, 27893, 34681, 41696, 32667, 55825, 17500, 44380, 604, 4700, 4032, 35008, 17500, 0, 3, 4, 4, 0, 1, 0, 206]],
  ['All off', [0, 0, 0, 0, 0, 0, 0, 5777, 13024, 19904, 33145, 42327, 49307, 55825, 17500, 17500, 17500, 17500, 24000, 24000, 17500, 0, 0, 0, 0, 0, 0, 0, 128]],
  ['BassDrum Punch', [600, 450, 500, 350, 0, 0, 0, 4518, 9414, 28013, 33145, 42327, 49307, 55825, 20828, 35420, 17500, 17500, 24000, 24000, 17500, 6, 6, 6, 6, 0, 0, 0, 114]],
  ['Default', [0, 0, 0, 0, 0, 0, 0, 5777, 13024, 19904, 33145, 42327, 49307, 55825, 17500, 17500, 17500, 17500, 24000, 24000, 17500, 5, 6, 6, 6, 6, 6, 7, 128]],
  ['EE', [0, 0, 1800, 460, 540, 0, 0, 5777, 13024, 8181, 36729, 42720, 49307, 55825, 17500, 17500, 36700, 34908, 33728, 24000, 17500, 0, 0, 6, 6, 6, 0, 0, 128]],
  ['High End Boost', [550, 450, -150, 200, 150, 0, 0, 60276, 0, 0, 0, 0, 0, 0, 20828, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 128]],
  ['HighHat Sizzle', [150, 450, 250, 375, 150, 0, 0, 13004, 28012, 42327, 61495, 0, 0, 0, 20828, 23296, 29184, 26624, 0, 0, 0, 6, 6, 6, 6, 0, 0, 0, 128]],
  ['Loudness', [553, 550, -150, 200, 150, 0, 0, 17920, 49305, 0, 0, 0, 0, 0, 33024, 32000, 0, 0, 0, 0, 0, 5, 7, 0, 0, 0, 0, 0, 128]],
  ['Middle', [0, 0, 0, 0, 0, 0, 0, 5777, 13024, 19904, 33145, 42327, 49307, 55825, 17500, 17500, 17500, 15452, 24000, 24000, 17500, 5, 0, 0, 6, 0, 0, 7, 128]],
  ['MultiMedia Brickwall - 11khz limit', [-1800, -1800, 150, 200, 150, 0, 0, 3328, 61495, 60275, 0, 0, 0, 0, 33024, 32000, 16384, 0, 0, 0, 0, 5, 7, 6, 0, 0, 0, 0, 128]],
  ['MultiMedia Enhance', [-1800, 100, 150, 200, 150, 0, 0, 2429, 61495, 0, 0, 0, 0, 0, 24320, 32000, 0, 0, 0, 0, 0, 5, 7, 0, 0, 0, 0, 0, 128]],
  ['Notch Filter', [550, 450, -150, 200, 150, 0, 0, 19918, 0, 0, 0, 0, 0, 0, 6236, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 128]],
  ['OO', [0, 0, 1720, 880, 0, 0, 0, 5777, 13024, 20981, 26489, 39904, 49307, 55825, 17500, 17500, 36188, 34908, 39360, 24000, 17500, 0, 0, 6, 6, 6, 0, 0, 128]],
  ['Phone', [-1800, -1800, 0, 0, 0, 0, 0, 15243, 55824, 19904, 33145, 42327, 49307, 55825, 46940, 44636, 17500, 17500, 24000, 24000, 17500, 5, 7, 0, 0, 0, 0, 0, 128]],
  ['Remove 20hz + 16khz +', [-1800, -1800, 600, 200, 150, 0, 0, 893, 65536, 65536, 0, 0, 0, 0, 33024, 55808, 16384, 0, 0, 0, 0, 5, 7, 0, 0, 0, 0, 0, 128]],
  ['Remove Super High Freq', [550, 450, -150, 200, 150, 0, 0, 65536, 0, 0, 0, 0, 0, 0, 3072, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 128]],
  ['Simple low + high', [0, 0, 0, 0, 0, 0, 0, 5777, 55607, 19904, 33145, 42327, 49307, 55825, 4956, 9472, 17500, 17500, 24000, 24000, 17500, 5, 7, 0, 0, 0, 0, 0, 128]],
  ['SnareDrum Enhance', [200, 450, 400, 550, 150, 0, 0, 17268, 34048, 60276, 65536, 0, 0, 0, 20828, 23296, 0, 19200, 0, 0, 0, 6, 6, 6, 6, 0, 0, 0, 128]],
  ['Sub Boost', [750, 0, 0, 0, 0, 0, 0, 3537, 886, 19904, 33145, 42327, 49307, 55825, 13916, 3420, 17500, 17500, 24000, 24000, 17500, 5, 3, 0, 0, 0, 0, 0, 116]],
  ['Super Low Roll-Off', [-825, 0, 0, 0, 0, 0, 0, 840, 13024, 19904, 33145, 42327, 49307, 55825, 13916, 17500, 17500, 17500, 24000, 24000, 17500, 5, 0, 0, 0, 0, 0, 0, 128]],
];

const KEYS = [
  ...Array.from({ length: PEQ_BANDS }, (_, b) => `level${b + 1}`),
  ...Array.from({ length: PEQ_BANDS }, (_, b) => `freq${b + 1}`),
  ...Array.from({ length: PEQ_BANDS }, (_, b) => `width${b + 1}`),
  ...Array.from({ length: PEQ_BANDS }, (_, b) => `type${b + 1}`),
  'main',
];

export const def: FxPluginDef = {
  id: 'peq',
  name: 'Parametric EQ',
  category: 'Filter',
  width: 240,
  height: 350,
  description: '7-band parametric equalizer (legacy)',
  params: params(),
  presets: FACTORY.map(([name, v]) => ({ name, params: Object.fromEntries(KEYS.map((k, i) => [k, v[i]])) })),
};
