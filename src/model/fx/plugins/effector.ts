// Effector (FL Studio 2026): 12 performance effects used one at a time, an
// X/Y pad mirrored by the X / Y PARAM knobs, a tempo-synced LFO that can move
// X and Y, input / output gain, bypass and dry/wet. Form: 430 x 418.
//
// All 12 parameters are 0..256 wheels/selectors in FL; names, ranges and
// value texts were read from the real plugin (flfxhost info / sweep). FL has
// no Default preset for Effector, so the defaults are its constructor state
// (effect VOX, bypass on).

import type { FxParamDef, FxPluginDef } from '../types';

export const EFFECTS = ['DISTORT', 'LO-FI', 'FLANGER', 'PHASER', 'FILTER', 'DELAY', 'REVERB', 'STEREO', 'TRANS', 'GRAIN', 'VOX', 'RING'];
export const EFFECT_TEXT = ['Distort', 'Lo-fi', 'Flanger', 'Phaser', 'Filter', 'Delay', 'Reverb', 'Stereo', 'Trans', 'Grain', 'Vox', 'Ring'];
export const RATES = ['1/8', '1/4', '3/8', '1/2', '3/4', '1/1', '2/1', '4/1', '8/1'];
/** Beats per LFO cycle for each rate index (1/8 = 8 cycles per beat ... 8/1 = 8 beats per cycle). */
export const RATE_BEATS = [1 / 8, 1 / 4, 3 / 8, 1 / 2, 3 / 4, 1, 2, 4, 8];
export const SHAPES = ['Sine', 'Saw', 'Square'];

/** Effect index (0..11) of the "Effect kind" value: FL rounds v * 11 / 256. */
export const effectIndex = (v: number) => Math.max(0, Math.min(11, Math.round((Math.max(0, Math.min(256, v)) * 11) / 256)));
/** Value FL stores when an effect button is clicked. */
export const effectValue = (k: number) => Math.round((Math.max(0, Math.min(11, k)) * 256) / 11);
/** Mod rate index (0 = 1/8 .. 8 = 8/1): FL's 32-wide steps. */
export const rateIndex = (v: number) => Math.max(0, Math.min(8, Math.floor((Math.max(0, Math.min(256, v)) + 16) / 32)));
export const rateValue = (i: number) => (i <= 0 ? 0 : Math.min(256, i * 32 - 4));
/** Mod shape index (0 Sine, 1 Saw, 2 Square). */
export const shapeIndex = (v: number) => Math.max(0, Math.min(2, Math.floor(Math.max(0, Math.min(256, v)) / 128 + 0.5)));
export const shapeValue = (i: number) => [0, 128, 256][Math.max(0, Math.min(2, i))];

const pct = (v: number) => ((v / 256) * 100).toFixed(2) + '%';
const pctSigned = (v: number) => { const s = (((v - 128) / 128) * 100).toFixed(2); return (s === '-0.00' ? '0.00' : s) + '%'; };
const gainDb = (v: number) => { const s = (((v - 128) / 128) * 24).toFixed(2); return (s === '-0.00' ? '0.00' : s) + ' dB'; };

const P = (key: string, name: string, index: number, def: number, format: (v: number) => string, extra: Partial<FxParamDef> = {}): FxParamDef => ({
  key, name, index, min: 0, max: 256, def, format, ...extra,
});

const params: FxParamDef[] = [
  P('kind', 'Effect kind', 0, 244, (v) => EFFECT_TEXT[effectIndex(v)]),
  P('bypass', 'FX Bypass', 1, 256, (v) => (v > 0 ? 'On' : 'Off')),
  P('mix', 'Wet Mix', 2, 256, pct, { parse: (p) => Math.round((p * 256) / 100) }),
  P('x', 'Param X', 3, 128, pct, { parse: (p) => Math.round((p * 256) / 100) }),
  P('y', 'Param Y', 4, 128, pct, { parse: (p) => Math.round((p * 256) / 100) }),
  P('rate', 'Mod Rate', 5, 28, (v) => RATES[rateIndex(v)]),
  P('tempo', 'Tempo reduce', 6, 0, pct, { parse: (p) => Math.round((p * 256) / 100) }),
  P('modX', 'Mod Amount X', 7, 128, pctSigned, { bipolar: true, parse: (p) => Math.round(128 + (p * 128) / 100) }),
  P('modY', 'Mod Amount Y', 8, 128, pctSigned, { bipolar: true, parse: (p) => Math.round(128 + (p * 128) / 100) }),
  P('shape', 'Mod shape', 9, 0, (v) => SHAPES[shapeIndex(v)]),
  P('input', 'Input Level', 10, 256, pct, { parse: (p) => Math.round((p * 256) / 100) }),
  P('output', 'Output Gain', 11, 128, gainDb, { bipolar: true, parse: (db) => Math.round(128 + (db * 128) / 24) }),
];

export const def: FxPluginDef = {
  id: 'effector',
  name: 'Effector',
  category: 'Misc',
  width: 430,
  height: 418,
  description: '12 performance effects with an X/Y pad and a tempo-synced LFO',
  params,
};
