// SimSynth (FL: SimSynth Live, Plugin database > Generators > Synth classic):
// FL's three-oscillator subtractive synth (originally David Billen's SimSynth).
// From FL 2026's binaries (docs/research/gen/simsynth.md): the FPC wrapper
// SimSynth_x64.dylib (TTestPlug: 26 automatable parameters, the editor form of
// 562 x 376 with 58 controls, Tag = the engine's parameter index) and the C++
// engine SimSynth_eng_x64.dylib (SSPlug::ProcessParam's table at 0xb52c: every
// control is a patch double value / 65535 (coarse: knob x 420 / 20160), a switch
// or a shape). Parameters 0..25 are FL's automatable ones (names, value texts as
// `flfxhost sweep`); controls 26..57 (pulse width, coarse, fine, keyboard
// tracking, switches, shapes) are not automatable in FL and live in the state
// under the keys of TAGS. A fresh instance plays FL's Default patch (the plugin
// database state SimSynth.fst equals Plugin presets/SimSynth/Default.fst); each
// parameter's `def` is the form's DefaultValue (FL's reset value).

import type { GenParamDef, GenPluginDef, GenPreset } from '../types';
import { PRESET_ROWS } from './simsynth/presets';

/** The engine's control index (Tag 0..57) -> state key. */
export const TAGS = [
  'o1Level', 'o1Lfo', 'o1Env', 'o2Level', 'o2Lfo', 'o2Env', 'o3Level', 'o3Lfo', 'o3Env',
  'lfoDelay', 'lfoRate', 'svfCut', 'svfEmph', 'svfEnv', 'svfLfo', 'svfHigh', 'svfBand',
  'envA', 'envD', 'envS', 'envR', 'vcaVelo', 'fenvA', 'fenvD', 'fenvS', 'fenvR',
  'o1Pw', 'o1Coarse', 'o1Fine', 'o2Pw', 'o2Coarse', 'o2Fine', 'o3Pw', 'o3Coarse', 'o3Fine', 'svfKb',
  'chorus', 'retrigger', 'trackAmp', 'lfoOn', 'svfOn', 'o1On', 'o2On', 'o3On', 'ring',
  'o1Oct1', 'o1Oct2', 'o1Warm', 'o2Oct1', 'o2Oct2', 'o2Warm', 'o3Oct1', 'o3Oct2', 'o3Warm',
  'o1Shape', 'o2Shape', 'o3Shape', 'lfoShape',
] as const;

export type SimSynthKey = (typeof TAGS)[number];

/** Control ranges by tag (0..65535 knobs, 0..48 coarse, 0/1 switches, shapes). */
export function tagMax(tag: number): number {
  if (tag === 27 || tag === 30 || tag === 33) return 48;
  if (tag >= 36 && tag <= 53) return 1;
  if (tag >= 54 && tag <= 56) return 4;
  if (tag === 57) return 3;
  return 65535;
}

/** FL's percent text (wrapper 0x5f5c0): round(v / 65535 x 100) %. */
const pct = (v: number) => `${Math.round((v / 65535) * 100)}%`;
/** Centre-zero percent (0x5f2a8): round(v / 65535 x 200 - 100) %. */
const bip = (v: number) => `${Math.round((v / 65535) * 200 - 100)}%`;
/** LFO rate (0x5f2f8): round(v / 65535 x 999 + 1). */
const rate = (v: number) => `${Math.round((v / 65535) * 999 + 1)}`;
/** Emphasis (0x5f380): round(v / 65535 x 94) %. */
const emph = (v: number) => `${Math.round((v / 65535) * 94)}%`;
const fromPct = (p: number) => Math.round((p / 100) * 65535);
const fromBip = (p: number) => Math.round(((p + 100) / 200) * 65535);

function knob(index: number, key: SimSynthKey, name: string, def: number, kind: 'pct' | 'bip' | 'rate' | 'emph' = 'pct'): GenParamDef {
  const format = kind === 'bip' ? bip : kind === 'rate' ? rate : kind === 'emph' ? emph : pct;
  const parse = kind === 'bip' ? fromBip : kind === 'rate' ? (x: number) => Math.round(((x - 1) / 999) * 65535)
    : kind === 'emph' ? (x: number) => Math.round((x / 94) * 65535) : fromPct;
  return { key, name, index, min: 0, max: 65535, def, format, parse, ...(kind === 'bip' ? { bipolar: true } : {}) };
}

const PARAMS: GenParamDef[] = [
  knob(0, 'o1Level', 'Osc1 Level', 32767),
  knob(1, 'o1Lfo', 'Osc1 LFO', 32767, 'bip'),
  knob(2, 'o1Env', 'Osc1 Env', 32767, 'bip'),
  knob(3, 'o2Level', 'Osc2 Level', 32767),
  knob(4, 'o2Lfo', 'Osc2 LFO', 32767, 'bip'),
  knob(5, 'o2Env', 'Osc2 Env', 32767, 'bip'),
  knob(6, 'o3Level', 'Osc3 Level', 32767),
  knob(7, 'o3Lfo', 'Osc3 LFO', 32767, 'bip'),
  knob(8, 'o3Env', 'Osc3 Env', 32767, 'bip'),
  knob(9, 'lfoDelay', 'LFO Delay', 0),
  knob(10, 'lfoRate', 'LFO Rate', 32767, 'rate'),
  knob(11, 'svfCut', 'SVF Cut', 32768),
  knob(12, 'svfEmph', 'SVF Emphasis', 0, 'emph'),
  knob(13, 'svfEnv', 'SVF Env', 32767, 'bip'),
  knob(14, 'svfLfo', 'SVF LFO', 32767, 'bip'),
  knob(15, 'svfHigh', 'SVF High', 0),
  knob(16, 'svfBand', 'SVF Band', 0),
  knob(17, 'envA', 'Env Attack', 0),
  knob(18, 'envD', 'Env Decay', 32768),
  knob(19, 'envS', 'Env Sustain', 32768),
  knob(20, 'envR', 'Env Release', 10000),
  knob(21, 'vcaVelo', 'VCA Velo', 65535),
  knob(22, 'fenvA', 'SVF Env Attack', 0),
  knob(23, 'fenvD', 'SVF Env Decay', 32768),
  knob(24, 'fenvS', 'SVF Env Sustain', 32768),
  knob(25, 'fenvR', 'SVF Env Release', 10000),
];

/** The form's reset values (DefaultValue) of controls 26..57. */
export const EXTRA_DEFAULTS: Record<string, number> = {
  o1Pw: 32767, o1Coarse: 24, o1Fine: 32767, o2Pw: 32767, o2Coarse: 24, o2Fine: 32767,
  o3Pw: 32767, o3Coarse: 24, o3Fine: 32767, svfKb: 0,
  chorus: 0, retrigger: 0, trackAmp: 0, lfoOn: 0, svfOn: 0, o1On: 0, o2On: 0, o3On: 0, ring: 0,
  o1Oct1: 0, o1Oct2: 0, o1Warm: 0, o2Oct1: 0, o2Oct2: 0, o2Warm: 0, o3Oct1: 0, o3Oct2: 0, o3Warm: 0,
  o1Shape: 1, o2Shape: 1, o3Shape: 1, lfoShape: 2,
};

/** Shape names (wrapper texts: Square, Saw, Triangle, Noise, Sine; the LFO has the first four). */
export const SHAPES = ['Square', 'Saw', 'Triangle', 'Noise', 'Sine'];

/** A preset row (58 control values in tag order) as a state. */
export function rowState(row: ArrayLike<number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (let t = 0; t < TAGS.length; t++) o[TAGS[t]] = row[t];
  return o;
}

const PRESETS: GenPreset[] = PRESET_ROWS.map(([name, row]) => ({ name, params: rowState(row) }));
const DEFAULT_ROW = PRESET_ROWS.find(([n]) => n === 'Default')![1];

export const def: GenPluginDef = {
  id: 'simsynth',
  name: 'SimSynth',
  category: 'Synth classic',
  notes: 'voices',
  levels: 'plugin',
  defPoly: 16,
  width: 562,
  height: 376,
  description: 'Three oscillator subtractive synthesizer',
  params: PARAMS,
  // FL loads Default.fst (= the plugin database state) into a new instance
  state: () => rowState(DEFAULT_ROW),
  normalize: (p) => {
    const o = { ...p };
    for (let t = 26; t < TAGS.length; t++) {
      const k = TAGS[t];
      const v = Number(o[k]);
      o[k] = Number.isFinite(v) ? Math.min(tagMax(t), Math.max(0, Math.round(v))) : EXTRA_DEFAULTS[k];
    }
    return o;
  },
  presets: PRESETS,
};
