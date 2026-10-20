// MiniSynth (FL: MiniSynth, Plugin database > Generators > Synth classic): the
// FL Studio Mobile synth (one oscillator with 10 kinds and noise, a resonant
// 4-pole ladder filter with its envelope, amp envelope, LFO, POLY / MONO / LEAD
// voices with slide, and distortion, delay, chorus and phaser). A C++ plugin
// (MiniSynth_x64.dylib, FL's C++ plugin wrapper); see
// docs/research/gen/minisynth.md.
//
// Parameters (FL's list, 172 entries; names from the plugin):
// - 0..42: the synth's parameters. FL's integer value is 0..256 and the synth
//   stores value / 256 as a float (presets and the editor set any float), so the
//   controls here are continuous 0..256 (step 0) and presets keep FL's floats
//   exactly (float x 256). Value texts are the synth's own (FL's GetName joins
//   value and unit with a space: "LEAD ", "67.4 ").
// - 43..171: "MIDI CC 0".."MIDI CC 127" and "Chn. Aftertouch", the wrapper's
//   MIDI controller parameters (value x 127 to the synth as a MIDI CC); the
//   synth only reacts to CC 1, the mod wheel (MW Dest / MW Amount).
// - `def` is the synth's default table (getDefault, 0x40e44); a fresh instance
//   gets the state FL loads from the plugin database (MiniSynth.fst, "Default").

import type { GenPluginDef, GenParamDef } from '../types';
import { MS_FRESH, MS_PRESETS } from './minisynth/presets';

const f32 = Math.fround;

/** FL's float of a control value (FL: clamp(int / 256, 0, 1)). */
export function msFloat(v: number): number {
  const f = v / 256;
  return f32(f > 0 ? (f < 1 ? f : 1) : 0);
}

/** C's printf("%.1f") of a float: the exact binary value, ties to even. */
export function cFixed1(x: number): string {
  const t = x * 10;
  if (Number.isFinite(t) && t - Math.floor(t) === 0.5) {
    const n = Math.floor(t);
    const r = n % 2 === 0 ? n : n + 1;
    const s = (Math.abs(r) / 10).toFixed(1);
    return x < 0 ? `-${s}` : s;
  }
  return x.toFixed(1);
}

export const MS_KINDS = ['SAW', 'SAW+SAW', 'PULSE', 'SQR+SAW', 'SQR+SQR', 'SUPERSAW', 'BELL', 'DEAF SAW', 'SAW SPREAD', 'SAW SPREAD 2'];
export const MS_RATES = ['1/4', '3/8', '1/2', '3/4', '1/1', '2/1', '4/1', '8/1', '16/1', '4 Bars', '8 Bars', '16 bars'];
export const MS_VOICE_MODES = ['POLY', 'MONO', 'LEAD'];
export const MS_LFO_SHAPES = ['SINE', 'SAW', 'SQUARE'];
export const MS_LFO_DESTS = ['FLT', 'FRQ', 'OSCMOD'];
export const MS_DELAY_TIMES = ['1/4', '2/4', '3/4', '1/1'];

/** The selector index the synth uses for a control value (trunc(f x n) in float). */
export function msIndex(v: number, n: number): number {
  return Math.trunc(f32(msFloat(v) * n));
}

/** The control value the synth's own editor sets for choice i of n + 1 (i / n; rates: 0.01 + i / 11). */
export function msChoiceValue(i: number, n: number, rate = false): number {
  return (rate ? f32(0.01 + i / 11) : f32(i / n)) * 256;
}

const pct = (v: number) => `${cFixed1(f32(msFloat(v) * 100))} `;
const bip = (v: number) => `${cFixed1(f32(msFloat(v) * 200 + -100))} `;
const pick = (names: string[], n: number) => (v: number) => {
  const i = msIndex(v, n);
  return i >= 0 && i < names.length ? `${names[i]} ` : pct(v);
};
const fromPct = (t: number) => (t / 100) * 256;
const fromBip = (t: number) => ((t + 100) / 200) * 256;

function p(key: string, name: string, index: number, defFloat: number, format: (v: number) => string, extra: Partial<GenParamDef> = {}): GenParamDef {
  return { key, name, index, min: 0, max: 256, def: f32(defFloat) * 256, step: 0, format, ...extra };
}

const SYNTH_PARAMS: GenParamDef[] = [
  p('voicesMode', 'Voices Mode', 0, 0.375, pick(MS_VOICE_MODES, 2)),
  p('transpose', 'Transpose', 1, 0.5, (v) => `${Math.trunc(f32(msFloat(v) * 24 + -12))} `, { parse: (t) => ((t + 12) / 24) * 256, bipolar: true }),
  p('slideTime', 'Slide Time', 2, 0, pct, { parse: fromPct }),
  p('mwDest', 'MW Dest', 3, 0, (v) => (Math.trunc(msFloat(v)) === 1 ? 'LFO ' : 'Filter ')),
  p('mwAmount', 'MW Amount', 4, 0, pct, { parse: fromPct }),
  p('oscKind', 'OSC Kind', 5, 0, pick(MS_KINDS, 9)),
  p('oscMod', 'OSC Mod', 6, 0, pct, { parse: fromPct }),
  p('oscNoise', 'OSC Noise', 7, 0, pct, { parse: fromPct }),
  p('fltFreq', 'FLT Freq', 8, 1, pct, { parse: fromPct }),
  p('fltPeak', 'FLT Peak', 9, 0, pct, { parse: fromPct }),
  p('fltKbd', 'FLT Kbd', 10, 0, pct, { parse: fromPct }),
  p('fltVel', 'FLT Vel', 11, 0, pct, { parse: fromPct }),
  p('egfAtk', 'EGF Atk', 12, 0, pct, { parse: fromPct }),
  p('egfDec', 'EGF Dec', 13, 1, pct, { parse: fromPct }),
  p('egfSus', 'EGF Sus', 14, 1, pct, { parse: fromPct }),
  p('egfRel', 'EGF Rel', 15, 1, pct, { parse: fromPct }),
  p('egfAmnt', 'EGF Amnt', 16, 0.5, bip, { parse: fromBip, bipolar: true }),
  p('lfoShape', 'LFO Shape', 17, 0, pick(MS_LFO_SHAPES, 2)),
  p('lfoDest', 'LFO Dest', 18, 0, pick(MS_LFO_DESTS, 2)),
  p('lfoRate', 'LFO Rate', 19, 0.25, pick(MS_RATES, 11)),
  p('lfoAmnt', 'LFO Amnt', 20, 0.5, bip, { parse: fromBip, bipolar: true }),
  p('ampAtk', 'AMP Atk', 21, 0, pct, { parse: fromPct }),
  p('ampDec', 'AMP Dec', 22, 1, pct, { parse: fromPct }),
  p('ampSus', 'AMP Sus', 23, 1, pct, { parse: fromPct }),
  p('ampRel', 'AMP Rel', 24, 0.07, pct, { parse: fromPct }),
  p('dist', 'DIST', 25, 0, pct),
  p('overdrive', 'Overdrive', 26, 0, pct, { parse: fromPct }),
  p('decimator', 'Decimator', 27, 0, pct, { parse: fromPct }),
  p('delay', 'DELAY', 28, 0, pct),
  p('delayTime', 'DELAY Time', 29, 0.7, pick(MS_DELAY_TIMES, 3)),
  p('delayFdbk', 'DELAY Fdbk', 30, 0.5, pct, { parse: fromPct }),
  p('delayFilter', 'DELAY Filter', 31, 1, pct, { parse: fromPct }),
  p('delayMix', 'DELAY Mix', 32, 0.5, pct, { parse: fromPct }),
  p('chorus', 'CHORUS', 33, 0, pct),
  p('chorusRate', 'CHORUS ModRate', 34, 0.25, pct, { parse: fromPct }),
  p('chorusDepth', 'CHORUS ModDepth', 35, 0.5, pct, { parse: fromPct }),
  p('chorusMix', 'CHORUS Mix', 36, 0.5, pct, { parse: fromPct }),
  p('phaser', 'PHASER', 37, 0, pct),
  p('phaserSpeed', 'PHASER ModSpeed', 38, 0.11222222447395325, pick(MS_RATES, 11)),
  p('phaserWidth', 'PHASER ModWidth', 39, 0.4000000059604645, pct, { parse: fromPct }),
  p('phaserFdbk', 'PHASER Fdbk', 40, 0.10000000149011612, pct, { parse: fromPct }),
  p('phaserMix', 'PHASER Mix', 41, 1, pct, { parse: fromPct }),
  p('phaserFreq', 'PHASER Freq', 42, 0.5, pct, { parse: fromPct }),
];

const ccText = (v: number) => `${Math.trunc(f32(msFloat(v) * 127))}`;
const CC_PARAMS: GenParamDef[] = [
  ...Array.from({ length: 128 }, (_, i) => ({
    key: `cc${i}`, name: `MIDI CC ${i}`, index: 43 + i, min: 0, max: 256, def: 0, step: 0, format: ccText, parse: (t: number) => (t / 127) * 256,
  })),
  { key: 'aftertouch', name: 'Chn. Aftertouch', index: 171, min: 0, max: 256, def: 0, step: 0, format: ccText, parse: (t: number) => (t / 127) * 256 },
];

/** Parameter keys in FL's index order (0..171). */
export const MS_PARAM_KEYS: string[] = [...SYNTH_PARAMS, ...CC_PARAMS].map((q) => q.key);

/** A preset row (parameters 0..42 in index order) as state values. */
function rowParams(row: readonly number[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (let i = 0; i < 43; i++) o[MS_PARAM_KEYS[i]] = row[i];
  return o;
}

export const def: GenPluginDef = {
  id: 'minisynth',
  name: 'MiniSynth',
  category: 'Synth classic',
  notes: 'events',
  velocity: 'plugin',
  defPoly: 8,
  width: 717,
  height: 473,
  description: 'Virtual analog synthesizer (FL Studio Mobile)',
  params: [...SYNTH_PARAMS, ...CC_PARAMS],
  // the editor's page and effects tab
  viewState: ['page', 'fxPage'],
  state: () => ({ ...rowParams(MS_FRESH), page: 0, fxPage: 0 }),
  normalize: (s) => ({
    ...s,
    page: typeof s.page === 'number' && s.page >= 0 && s.page <= 5 ? Math.round(s.page) : 0,
    fxPage: typeof s.fxPage === 'number' && s.fxPage >= 0 && s.fxPage <= 3 ? Math.round(s.fxPage) : 0,
  }),
  presets: MS_PRESETS.map(([name, row]) => ({ name, params: rowParams(row) })),
};
