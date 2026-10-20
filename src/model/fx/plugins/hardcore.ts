// Hardcore (FL: Hardcore Guitar Effects): a pedalboard of 5 stomp-box slots
// (11 pedal types) followed by an 8-band graphic EQ and a cabinet simulation,
// with input and output levels. Editor 767 x 485 (FL's bitmap skin, measured on
// the manual's screenshots, which are at 100%).
//
// Parameters follow FL's own interface for this C++ plugin (flfxhost: names
// from GetName, raw values 0..256 = the plugin's 0..1 floats, text "50 % "):
// 0 Master IN Lvl, 1 Master OUT Lvl, 2 EQ Enable, 3-10 EQ Band 1..8,
// 11 cabinet, 13-37 Box1..5 - Param 1..5, 39-43 Box N Enable, 45-49 box types.
// FL's interface clamps every parameter to 0..256, so the cabinet (0 = off,
// 1..20 = Model A..T) and the pedal types (0 = none, 1..11) cannot be set
// through it; here they are integer, non-automatable parameters, as the
// plugin's own menus set them. Enables and the EQ switch are on above 0, and
// stored floats are truncated (0.5 = no pedal / cabinet off), as in the plugin.
// A slot keeps its knob values when its pedal type changes (as FL does).
// All control laws below were measured on FL's binary (see docs/research/fx/hardcore.md).

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';
import { HC_FACTORY } from './hardcore/presets';

/** Pedal types in FL's menu order (the stored type value is the index). */
export const HC_TYPES = [
  'None', 'Distortion', 'Chorus', 'Flanger', 'Phaser', 'Reverb', 'Delay', 'Noise Gate', 'Equalizer', 'Compressor', 'Modulator', 'Tube Stage',
] as const;

export const enum HcType {
  None = 0, Distortion = 1, Chorus = 2, Flanger = 3, Phaser = 4, Reverb = 5, Delay = 6,
  NoiseGate = 7, Equalizer = 8, Compressor = 9, Modulator = 10, TubeStage = 11,
}

export const HC_SLOTS = 5;
/** Raw parameter range of FL's interface (= the plugin's 0..1). */
export const HC_RAW = 256;

/** Knob captions per pedal type as printed on the pedals (FL spells "TRESHOLD"). */
export const HC_KNOBS: readonly (readonly string[])[] = [
  [],
  ['DIST', 'COMB', 'INFERNO', 'GLASS'],
  ['WIDTH', 'SPEED', 'INTENSITY'],
  ['WIDTH', 'SPEED', 'INTENSITY'],
  ['SPEED', 'TUNE', 'WIDTH', 'INTENSITY'],
  ['DECAY', 'HI-DUMP', 'MIX'],
  ['TIME', 'DECAY', 'MIX'],
  ['ATTACK', 'RELEASE', 'TRESHOLD'],
  ['LOW', 'MIDDLE', 'TREBLE', 'HIGH'],
  ['TRESHOLD', 'RATIO', 'ATTACK', 'RELEASE'],
  ['PITCH', 'AMP', 'PAN', 'RATE'],
  ['LOW', 'HIGH', 'GAIN'],
];

/** Cabinet models: 0 = off; A-E are algorithmic in FL, F-T impulse based. */
export const HC_CABINETS: readonly string[] = ['Off', ...'ABCDEFGHIJKLMNOPQRST'.split('').map((c) => `Model ${c}`)];

export const HC_EQ_BANDS = ['125', '250', '500', '1k', '2k', '4k', '8k', '16k'] as const;
export const HC_EQ_FREQS = [125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

// ---- control laws (v = 0..1, i.e. raw / 256), measured on FL's Hardcore ----

const c01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
const sq = (v: number) => { const s = 2 * c01(v) - 1; return s * Math.abs(s); };
/** Linear interpolation in a table sampled at v = 0, 1/(n-1), ... 1. */
export function hcTable(t: readonly number[], v: number): number {
  const x = c01(v) * (t.length - 1), i = Math.min(t.length - 2, Math.floor(x)), f = x - i;
  return t[i] + (t[i + 1] - t[i]) * f;
}

/** Reverb RT60 (s) for DECAY = 0, 0.05 .. 1 (measured). */
const REVERB_RT = [0.41, 0.409, 0.409, 0.409, 0.418, 0.49, 0.64, 0.916, 1.339, 1.748, 2.32, 3.033, 3.912, 4.947, 6.089, 7.4, 8.991, 10.7, 12.6, 14.33, 17.3];

export const hcMap = {
  /** Input / output level: -24 .. +24 dB, linear in dB. */
  levelDb: (v: number) => 24 * (2 * c01(v) - 1),
  /** Graphic EQ band gain: +-36 dB with a square law around the centre. */
  eqDb: (v: number) => 36 * sq(v),
  distGlassDb: (v: number) => 40 * (c01(v) - 0.5),
  chorusRateHz: (v: number) => 0.1 + 5 * c01(v),
  chorusSpanMs: (v: number) => 4.28 * Math.pow(c01(v), 2.3),
  chorusVoiceGain: (v: number) => -2 * c01(v) * c01(v),
  flangerMaxMs: (v: number) => 0.125 + 4.846 * c01(v) * c01(v),
  flangerRateHz: (v: number) => 0.032 + 9.98 * Math.pow(c01(v), 3),
  flangerWet: (v: number) => -(0.11 + 0.894 * c01(v)),
  phaserRateHz: (v: number) => 21 * c01(v) * c01(v),
  phaserFcHz: (v: number) => Math.max(220, 6550 * c01(v) * c01(v)),
  phaserSweepOct: (v: number) => 1.78 * c01(v) * c01(v),
  reverbRtS: (v: number) => hcTable(REVERB_RT, v),
  /** High-frequency loss per 45 ms of loop (dB) for HI-DUMP. */
  reverbDampDb: (v: number) => 1.75 * c01(v) * c01(v),
  reverbWet: (v: number) => 0.122 + 0.878 * Math.pow(c01(v), 5),
  delayTimeMs: (v: number) => Math.min(985.1, Math.max(99.42, 995 * c01(v))),
  delayWowMs: (v: number) => 3.13 * Math.sin(Math.PI * c01(v)),
  delayFeedback: (v: number) => -0.96 * c01(v) * c01(v),
  delayWet: (v: number) => -(0.1 + 0.9 * c01(v) * c01(v)),
  gateThresholdDb: (v: number) => -64 + 64 * c01(v),
  gateTimeMs: (v: number) => 5.6 + 226 * c01(v) * c01(v),
  eqPedalDb: (v: number) => 20 * sq(v),
  compAttackMs: (v: number) => Math.exp(2.061 + 1.949 * c01(v)),
  compReleaseMs: (v: number) => Math.exp(-0.371 + 2.202 * c01(v)),
  modRateHz: (v: number) => 30 * c01(v) * c01(v),
  modMaxMs: (v: number) => 0.125 + 9.8 * c01(v) * c01(v),
};

// ---- value texts ----

/** FL's value text for every Hardcore parameter: the raw value as a truncated percentage. */
export function hcPct(raw: number): string {
  return `${Math.trunc((Math.min(HC_RAW, Math.max(0, raw)) / HC_RAW) * 100)} % `;
}

const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
const lfoHz = (f: number) => `${f < 1 ? f.toFixed(2) : f.toFixed(1)} Hz`;
const ms = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(2)} s` : t >= 10 ? `${Math.round(t)} ms` : `${t.toFixed(2)} ms`);
const db = (d: number) => `${d > 0.05 ? '+' : ''}${d.toFixed(1)} dB`;

/** The physical value of knob k of a pedal type (shown after FL's percentage in hints). */
export function hcKnobPhys(type: number, k: number, v: number): string {
  const m = hcMap;
  switch (type) {
    case HcType.Distortion: return k === 3 ? `presence ${db(m.distGlassDb(v))}` : '';
    case HcType.Chorus: return ['sweep ' + ms(m.chorusSpanMs(v)), lfoHz(m.chorusRateHz(v)), ''][k] ?? '';
    case HcType.Flanger: return ['max ' + ms(m.flangerMaxMs(v)), lfoHz(m.flangerRateHz(v)), ''][k] ?? '';
    case HcType.Phaser: return [lfoHz(m.phaserRateHz(v)), hz(m.phaserFcHz(v)), `${m.phaserSweepOct(v).toFixed(2)} oct`, ''][k] ?? '';
    case HcType.Reverb: return [`${m.reverbRtS(v).toFixed(2)} s`, '', ''][k] ?? '';
    case HcType.Delay: return [ms(m.delayTimeMs(v)), `feedback ${Math.round(-m.delayFeedback(v) * 100)}%`, ''][k] ?? '';
    case HcType.NoiseGate: return [ms(m.gateTimeMs(v)), ms(m.gateTimeMs(v)), `${m.gateThresholdDb(v).toFixed(1)} dB`][k] ?? '';
    case HcType.Equalizer: return db(m.eqPedalDb(v));
    case HcType.Compressor: return ['', '', ms(m.compAttackMs(v)), ms(m.compReleaseMs(v))][k] ?? '';
    case HcType.Modulator: return k === 3 ? lfoHz(m.modRateHz(v)) : '';
    default: return '';
  }
}

// ---- parameter keys ----

export const hcKnobKey = (slot: number, k: number) => `s${slot + 1}k${k + 1}`;
export const hcOnKey = (slot: number) => `s${slot + 1}on`;
export const hcTypeKey = (slot: number) => `s${slot + 1}type`;
export const hcEqKey = (band: number) => `eq${band + 1}`;

function buildParams(): FxParamDef[] {
  const knob = (key: string, name: string, index: number, def = 128): FxParamDef => ({ key, name, index, min: 0, max: HC_RAW, def, step: 0, format: hcPct });
  const ps: FxParamDef[] = [
    knob('in', 'Master IN Lvl', 0),
    knob('out', 'Master OUT Lvl', 1),
    { key: 'eqOn', name: 'EQ Enable', index: 2, min: 0, max: HC_RAW, def: 0, format: hcPct },
  ];
  for (let b = 0; b < 8; b++) ps.push({ ...knob(hcEqKey(b), `EQ Band ${b + 1}`, 3 + b), bipolar: true });
  ps.push({ key: 'cab', name: 'Cabinet', index: 11, min: 0, max: HC_CABINETS.length - 1, def: 0, options: [...HC_CABINETS], noAuto: true });
  for (let s = 0; s < HC_SLOTS; s++) {
    for (let k = 0; k < 5; k++) ps.push(knob(hcKnobKey(s, k), `Box${s + 1} - Param ${k + 1}`, 13 + 5 * s + k));
  }
  for (let s = 0; s < HC_SLOTS; s++) ps.push({ key: hcOnKey(s), name: `Box ${s + 1} Enable`, index: 39 + s, min: 0, max: HC_RAW, def: HC_RAW, format: hcPct });
  for (let s = 0; s < HC_SLOTS; s++) ps.push({ key: hcTypeKey(s), name: `Box ${s + 1} Type`, index: 45 + s, min: 0, max: HC_TYPES.length - 1, def: 0, options: [...HC_TYPES], noAuto: true });
  return ps;
}

const PARAMS = buildParams();

/** Parameter values from the plugin's 50 stored floats (preset files, states). */
export function hcFromStored(vals: readonly number[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const d of PARAMS) {
    const raw = vals[d.index ?? -1];
    if (raw === undefined || !Number.isFinite(raw)) continue;
    o[d.key] = d.options ? Math.min(d.max, Math.max(0, Math.trunc(raw))) : Math.round(Math.min(1, Math.max(0, raw)) * HC_RAW * 100) / 100;
  }
  return o;
}

const PRESETS: FxPreset[] = HC_FACTORY.map(([name, vals]) => ({ name, params: hcFromStored(vals) }));

/** Parameter patch that swaps two slots (type, knobs and enable): "Move left / right". */
export function hcSwapSlots(p: Record<string, unknown>, a: number, b: number): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const keys = (s: number) => [hcTypeKey(s), hcOnKey(s), ...[0, 1, 2, 3, 4].map((k) => hcKnobKey(s, k))];
  const ka = keys(a), kb = keys(b);
  for (let i = 0; i < ka.length; i++) { o[ka[i]] = p[kb[i]]; o[kb[i]] = p[ka[i]]; }
  return o;
}

export const def: FxPluginDef = {
  id: 'hardcore',
  name: 'Hardcore',
  category: 'Distortion',
  width: 767,
  height: 485,
  description: 'Guitar multi-effect pedalboard with cabinet simulation',
  params: PARAMS,
  presets: PRESETS,
  normalize: (p) => {
    const o = { ...p };
    for (const d of PARAMS) {
      const v = Number(o[d.key]);
      if (!Number.isFinite(v)) { o[d.key] = d.def; continue; }
      o[d.key] = d.options ? Math.min(d.max, Math.max(d.min, Math.trunc(v))) : Math.min(d.max, Math.max(d.min, v));
    }
    return o;
  },
};
