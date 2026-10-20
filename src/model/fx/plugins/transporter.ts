// Transporter (FL Studio 2026): a real-time relooping effect. The input is
// recorded into a 960000-sample ring; detected transients (or tempo / manual
// triggers) set two mono loops, A and B, to the audio between the last two
// effective triggers, which then repeat until the next one. Form: 740 x 366.
//
// Parameter names, ranges and value texts were read from the real plugin
// (flfxhost info / sweep). FL normalises every control as a float32
// (v - min) / (max - min) before scaling it for display; reproducing that
// gets each text's rounding right. Defaults = FL's Default preset (it equals
// the constructor state).

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';

export function fix(v: number, digits: number): string {
  const s = v.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
}

const n32 = (v: number, min: number, max: number) => Math.fround((v - min) / (max - min));

/** FL's fader law for the levels: (11^x - 1) / 10, x = v / 12800. */
export function levelGain(v: number): number {
  const x = n32(Math.max(0, Math.min(12800, v)), 0, 12800);
  return x <= 0 ? 0 : (Math.pow(11, x) - 1) / 10;
}
export function levelText(v: number): string {
  const g = levelGain(v);
  return g > 0 ? fix(20 * Math.log10(g), 1) + 'dB' : '-InfdB';
}
export function levelFromDb(db: number): number {
  const g = Math.pow(10, db / 20);
  return Math.round((12800 * Math.log(g * 10 + 1)) / Math.log(11));
}
/** Minimum length A in seconds (0.02 .. 2.0). */
export const minLenSec = (v: number) => 0.02 + 1.98 * n32(v, 20, 2000);
/** A/B ratio 1 .. 10 in quarter steps. */
export const abRatio = (v: number) => 1 + Math.round(v) / 4;
/** Spread / bouncing rate -1 .. 1. */
export const bipolar1024 = (v: number) => (n32(v, 0, 1024) - 0.5) * 2;
/** Sensitivity 0 .. 1. */
export const sens1024 = (v: number) => n32(v, 0, 1024);

export const MODES = ['AUTO', 'BOUNCING', 'ADAPTIVE', 'TEMPO'];
export const RATIOS = [
  '1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/1 dotted', '1/2 dotted', '1/4 dotted', '1/8 dotted', '1/16 dotted',
  '1/1 triplet', '1/2 triplet', '1/4 triplet', '1/8 triplet', '1/16 triplet', '1/1 quint.', '1/2 quint.', '1/4 quint.', '1/8 quint.', '1/16 quint.',
];
/** Note value of a tempo ratio item in beats (1/1 = a whole note = 4 beats). */
export function ratioBeats(i: number): number {
  const k = Math.max(0, Math.min(20, Math.round(i)));
  const base = [4, 2, 1, 0.5, 0.25, 0.125];
  if (k <= 5) return base[k];
  if (k <= 10) return base[k - 6] * 1.5; // dotted
  if (k <= 15) return (base[k - 11] * 2) / 3; // triplet
  return (base[k - 16] * 4) / 5; // quintuplet
}

const onOff = (v: number) => (v >= 0.5 ? 'On' : 'Off');
const f2 = (v: number) => fix(n32(v, 0, 10000), 2);

export const KEYS = [
  'dry', 'levelA', 'levelB', 'reverse', 'shift', 'downUp', 'spread', 'minLen', 'ratio', 'sens', 'bounce',
  'ignoreTr', 'flush', 'mode', 'bypass', 'updA', 'updB', 'updAB', 'prob', 'tempoLen', 'tempoTrig', 'ignoreBias',
] as const;

const params: FxParamDef[] = [
  { key: 'dry', name: 'Dry levels', index: 0, min: 0, max: 12800, def: 12800, format: levelText, parse: levelFromDb },
  { key: 'levelA', name: 'Loop level A', index: 1, min: 0, max: 12800, def: 12800, format: levelText, parse: levelFromDb },
  { key: 'levelB', name: 'Loop level B', index: 2, min: 0, max: 12800, def: 12800, format: levelText, parse: levelFromDb },
  { key: 'reverse', name: 'Reverse bias', index: 3, min: 0, max: 10000, def: 0, format: f2 },
  { key: 'shift', name: 'Octave shift bias', index: 4, min: 0, max: 10000, def: 0, format: f2 },
  { key: 'downUp', name: 'Octave down up bias', index: 5, min: 0, max: 10000, def: 0, format: f2 },
  { key: 'spread', name: 'Spread and auto panning', index: 6, min: 0, max: 1024, def: 512, bipolar: true, format: (v) => fix(bipolar1024(v), 2) },
  { key: 'minLen', name: 'Minimum length A', index: 7, min: 20, max: 2000, def: 500, format: (v) => fix(minLenSec(v), 2), parse: (s) => Math.round(s * 1000) },
  { key: 'ratio', name: 'A/B ratio', index: 8, min: 0, max: 36, def: 8, format: (v) => fix(abRatio(v), 2), parse: (r) => Math.round((r - 1) * 4) },
  { key: 'sens', name: 'Transient sensitivity', index: 9, min: 0, max: 1024, def: 512, format: (v) => fix(sens1024(v), 2) },
  { key: 'bounce', name: 'Bouncing rate', index: 10, min: 0, max: 1024, def: 512, bipolar: true, format: (v) => fix(bipolar1024(v), 2) },
  { key: 'ignoreTr', name: 'Ignore transients', index: 11, min: 0, max: 1, def: 0, format: onOff },
  { key: 'flush', name: 'Flush', index: 12, min: 0, max: 1, def: 0, format: onOff },
  { key: 'mode', name: 'Loop mode', index: 13, min: 0, max: 3, def: 0, options: MODES },
  { key: 'bypass', name: 'Bypass', index: 14, min: 0, max: 1, def: 0, format: onOff },
  { key: 'updA', name: 'Update loop A', index: 15, min: 0, max: 1, def: 0, format: onOff },
  { key: 'updB', name: 'Update loop B', index: 16, min: 0, max: 1, def: 0, format: onOff },
  { key: 'updAB', name: 'Update loop A/B', index: 17, min: 0, max: 1, def: 0, format: onOff },
  { key: 'prob', name: 'Probabilities', index: 18, min: 0, max: 1, def: 0, options: ['Probabilistic', 'Deterministic'] },
  { key: 'tempoLen', name: 'Tempo ratio length', index: 19, min: 0, max: 20, def: 0, options: RATIOS },
  { key: 'tempoTrig', name: 'Tempo ratio trigger', index: 20, min: 0, max: 21, def: 21, options: [...RATIOS, 'Off'] },
  { key: 'ignoreBias', name: 'Ignore bias', index: 21, min: 0, max: 10000, def: 0, format: f2 },
];

// FL's factory presets (parameters 0..19; FL's preset files do not store 20 and 21)
const PRESETS: [string, number[]][] = [
  ['Basic reverser', [0, 12800, 0, 10000, 0, 0, 768, 500, 8, 1024, 565, 0, 0, 3, 0, 0, 0, 0, 1, 0]],
  ['Beatdrifter', [12800, 8086, 8086, 5001, 10000, 0, 869, 2000, 2, 510, 512, 0, 0, 2, 0, 0, 0, 0, 1, 5]],
  ['Default', [12800, 12800, 12800, 0, 0, 0, 512, 500, 8, 512, 512, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Flashbacker', [0, 12800, 12800, 4969, 0, 0, 499, 2000, 12, 1024, 512, 0, 0, 1, 0, 0, 0, 0, 0, 1]],
  ['Octavary', [0, 12800, 12800, 0, 2025, 4963, 1024, 1000, 0, 1024, 512, 0, 0, 3, 0, 0, 0, 0, 0, 1]],
  ['Radpad', [12229, 0, 12800, 1019, 2031, 5006, 512, 2000, 8, 824, 512, 0, 0, 2, 0, 0, 0, 0, 0, 1]],
];

export const presets: FxPreset[] = PRESETS.map(([name, v]) => {
  const p: Record<string, unknown> = {};
  v.forEach((x, i) => { p[KEYS[i]] = x; });
  return { name, params: p };
});

/** Options-menu and routing state (not parameters). */
export interface TransporterState {
  /** Sidechain input used as the trigger source (FL's input number, 0 = none). */
  scIn: number;
  /** Exclusive send track (mixer track, -1 = none). */
  out: number;
  /** Options: Flush on pause/stop, Lookahead, Stereo-to-stereo (false = mono-to-stereo), transient source 0 L / 1 R / 2 L+R. */
  flushOnStop: boolean;
  lookahead: boolean;
  stereo: boolean;
  source: number;
  theme: number;
}

const intOr = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d;
};

export const def: FxPluginDef = {
  id: 'transporter',
  name: 'Transporter',
  category: 'Misc',
  width: 740,
  height: 366,
  description: 'Real-time relooping triggered by transients',
  params,
  presets,
  state: (): Record<string, unknown> => ({
    scIn: 0, out: -1, flushOnStop: true, lookahead: true, stereo: true, source: 2, theme: 0,
  } satisfies TransporterState),
  normalize: (p) => ({
    ...p,
    scIn: intOr(p.scIn, 0, 0, 999),
    out: intOr(p.out, -1, -1, 999),
    flushOnStop: p.flushOnStop !== false,
    lookahead: p.lookahead !== false,
    stereo: p.stereo !== false,
    source: intOr(p.source, 2, 0, 2),
    theme: intOr(p.theme, 0, 0, 3),
  }),
};
