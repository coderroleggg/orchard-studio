// Maximus (FL: Maximus): 3-band (LOW / MID / HIGH) plus MASTER maximizer,
// compressor, limiter, gate and expander. Form: 626 x 385. The 59 parameters,
// names, ranges and value texts were read from FL's own plugin (flfxhost
// info / sweep); FL applies its "Default" preset on insert (24 dB slopes), so
// those values are the defaults here. Each band's compression curve, the
// option switches, the selected band and the A/B spare state are plugin state.
// DSP facts are in docs/research/fx/maximus.md.

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';
import { LIMIT_CURVE, normalizeCurve, type CurvePoint } from './maximus/curve';
import { MAXIMUS_DEFAULTS, MAXIMUS_PRESET_DATA } from './maximus/presets';

export const MX_BANDS = ['low', 'mid', 'high', 'master'] as const;
export type MxBand = (typeof MX_BANDS)[number];
export const MX_BAND_LABELS = ['LOW', 'MID', 'HIGH', 'MASTER'];
export const MX_BAND_NAMES = ['Low band', 'Mid band', 'High band', 'Master'];
export const MX_MODES = ['on', 'compression off', 'muted', 'off'];

/** Per-band parameter fields, in FL's parameter order. */
export const MX_FIELDS = ['Mode', 'Pre', 'Post', 'Stereo', 'SatThres', 'SatCeil', 'Att', 'Rel2', 'AttCurve', 'Rel', 'RelCurve', 'Sustain', 'SusMode'] as const;
export type MxField = (typeof MX_FIELDS)[number];
export const mxKey = (band: number, field: MxField): string => MX_BANDS[band] + field;

// ------------------------------------------------------------------ knob laws (FL's)

/** Crossover frequency: 30 Hz .. 16 kHz, exponential (19800 = 200 Hz, 48065 = 3 kHz). */
export const mxFreqHz = (v: number): number => 30 * Math.pow(1600 / 3, v / 65536);
/** Low cut: 5 .. 80 Hz, -1 = off. */
export const mxLowCutHz = (v: number): number => (v < 0 ? 0 : 5 * Math.pow(16, v / 65536));
/** Pre / post gain and saturation ceiling: (7^(v/1000) - 1) / 6, 1000 = 0 dB, 2000 = +18.06 dB. */
export const mxGain = (v: number): number => (Math.pow(7, v / 1000) - 1) / 6;
/** Attack, sustain window and LMH delay: 0 .. 1000 ms. */
export const mxShortMs = (v: number): number => 2 * (Math.pow(501, v / 10000) - 1);
/** Release and release 2: 0 .. 2000 ms. */
export const mxLongMs = (v: number): number => 4 * (Math.pow(501, v / 10000) - 1);
/** Stereo separation as the side-signal gain: separated 1..2, merged 1..0 ((1 - 0.2^(1-a)) / 0.8). */
export function mxSideGain(v: number): number {
  const a = Math.max(-1, Math.min(1, v / 1000));
  if (a <= 0) return 1 - a;
  return (1 - Math.pow(0.2, 1 - a)) / 0.8;
}

// ------------------------------------------------------------------ value texts (FL's)

function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** FL's dB text: "0.0dB", "-11.2dB", "18.1dB", "-InfdB". */
export function mxDbText(g: number): string {
  if (!(g > 0)) return '-InfdB';
  let s = (20 * Math.log10(g)).toFixed(1);
  if (s === '-0.0') s = '0.0';
  return s + 'dB';
}
export const mxHzText = (hz: number): string => `${roundHalfUp(hz)}Hz`;
export const mxMsText = (ms: number): string => `${ms.toFixed(2)}ms`;

// FL's percentage texts round half up, except a few halves that its float maths
// rounds down (read from FL with a full sweep).
const STEREO_DOWN = new Set([125, 505, 565, 625]);
const SAT_DOWN = new Set([505, 565]);

export function mxStereoText(v: number): string {
  const a = Math.abs(Math.round(v));
  let p = roundHalfUp(a / 10);
  if (STEREO_DOWN.has(a)) p -= 1;
  if (p === 0) return 'Original';
  return `${p}% ${v < 0 ? 'separated' : 'merged'}`;
}

export function mxSatText(v: number): string {
  if (v === 0) return 'No saturation';
  const a = Math.abs(Math.round(v));
  let p = roundHalfUp(a / 10);
  if (SAT_DOWN.has(a)) p -= 1;
  return `${p}% mode ${v < 0 ? 'A' : 'B'}`;
}

const msParse = (scale: number) => (ms: number): number =>
  Math.round(Math.min(10000, Math.max(0, (10000 * Math.log(Math.max(0, ms) / scale + 1)) / Math.log(501))));
const dbParse = (db: number): number => Math.round(Math.min(2000, Math.max(0, (1000 * Math.log(6 * Math.pow(10, db / 20) + 1)) / Math.log(7))));
const hzParse = (hz: number): number => Math.round(Math.min(65536, Math.max(0, (65536 * Math.log(Math.max(30, hz) / 30)) / Math.log(1600 / 3))));

// ------------------------------------------------------------------ parameters

const D = MAXIMUS_DEFAULTS;

function bandParams(b: number): FxParamDef[] {
  const n = MX_BAND_NAMES[b];
  const i0 = 7 + b * 13;
  const k = (f: MxField) => mxKey(b, f);
  return [
    { key: k('Mode'), name: `${n} mode`, index: i0, min: 0, max: 3, def: D[i0], options: MX_MODES },
    { key: k('Pre'), name: `${n} pre gain`, index: i0 + 1, min: 0, max: 2000, def: D[i0 + 1], format: (v) => mxDbText(mxGain(v)), parse: dbParse },
    { key: k('Post'), name: `${n} post gain`, index: i0 + 2, min: 0, max: 2000, def: D[i0 + 2], format: (v) => mxDbText(mxGain(v)), parse: dbParse },
    { key: k('Stereo'), name: `${n} stereo separation`, index: i0 + 3, min: -1000, max: 1000, def: D[i0 + 3], bipolar: true, format: mxStereoText, parse: (pct) => Math.round(pct * 10) },
    { key: k('SatThres'), name: `${n} soft saturation threshold`, index: i0 + 4, min: -1000, max: 1000, def: D[i0 + 4], bipolar: true, format: mxSatText, parse: (pct) => Math.round(pct * 10) },
    { key: k('SatCeil'), name: `${n} soft saturation ceiling`, index: i0 + 5, min: 0, max: 2000, def: D[i0 + 5], format: (v) => mxDbText(mxGain(v)), parse: dbParse },
    { key: k('Att'), name: `${n} attack time`, index: i0 + 6, min: 0, max: 10000, def: D[i0 + 6], format: (v) => (v === 0 ? 'Default' : mxMsText(mxShortMs(v))), parse: msParse(2) },
    { key: k('Rel2'), name: `${n} release 2 time`, index: i0 + 7, min: 0, max: 10000, def: D[i0 + 7], format: (v) => (v === 0 ? 'Default' : mxMsText(mxLongMs(v))), parse: msParse(4) },
    { key: k('AttCurve'), name: `${n} attack / release 2 curve`, index: i0 + 8, min: 1, max: 8, def: D[i0 + 8], format: (v) => String(Math.round(v)), parse: (n2) => Math.round(n2) },
    { key: k('Rel'), name: `${n} release time`, index: i0 + 9, min: 0, max: 10000, def: D[i0 + 9], format: (v) => mxMsText(mxLongMs(v)), parse: msParse(4) },
    { key: k('RelCurve'), name: `${n} release curve`, index: i0 + 10, min: 1, max: 8, def: D[i0 + 10], format: (v) => String(Math.round(v)), parse: (n2) => Math.round(n2) },
    { key: k('Sustain'), name: `${n} sustain window`, index: i0 + 11, min: 0, max: 10000, def: D[i0 + 11], format: (v) => mxMsText(mxShortMs(v)), parse: msParse(2) },
    { key: k('SusMode'), name: `${n} sustain mode`, index: i0 + 12, min: 0, max: 1, def: D[i0 + 12], options: ['PEAK', 'RMS'] },
  ];
}

export const MX_PARAMS: FxParamDef[] = [
  { key: 'lowFreq', name: 'Low band frequency', index: 0, min: 0, max: 65536, def: D[0], format: (v) => mxHzText(mxFreqHz(v)), parse: hzParse },
  { key: 'lowSlope', name: 'Low band slope', index: 1, min: 0, max: 1, def: D[1], options: ['12dB', '24dB'] },
  { key: 'highFreq', name: 'High band frequency', index: 2, min: 0, max: 65536, def: D[2], format: (v) => mxHzText(mxFreqHz(v)), parse: hzParse },
  { key: 'highSlope', name: 'High band slope', index: 3, min: 0, max: 1, def: D[3], options: ['12dB', '24dB'] },
  { key: 'lmhDelay', name: 'LMH lookahead delay', index: 4, min: 0, max: 10000, def: D[4], format: (v) => mxMsText(mxShortMs(v)), parse: msParse(2) },
  { key: 'lmhMix', name: 'LMH mix', index: 5, min: 0, max: 1000, def: D[5], format: (v) => `${roundHalfUp(v / 10)}%`, parse: (pct) => Math.round(pct * 10) },
  {
    key: 'lowCut', name: 'Low cut', index: 6, min: -1, max: 65536, def: D[6],
    format: (v) => (v < 0 ? 'Off' : mxHzText(mxLowCutHz(v))),
    parse: (hz) => (hz < 5 ? -1 : Math.round(Math.min(65536, (65536 * Math.log(hz / 5)) / Math.log(16)))),
  },
  ...bandParams(0), ...bandParams(1), ...bandParams(2), ...bandParams(3),
];

// ------------------------------------------------------------------ state

/** Monitor display toggles (FL's buttons, in order). */
export const MX_VIS = ['main input peaks', 'band input peaks', 'band output peaks', 'band analysis envelope', 'band gain envelope', 'all gain envelopes', 'band level markers', 'output spectrogram'];

export interface MxSpare { p: number[]; curves: CurvePoint[][] }

const limitCurves = (): CurvePoint[][] => [0, 1, 2, 3].map(() => LIMIT_CURVE.map((q) => [...q] as CurvePoint));

/** Non-parameter state defaults. */
export function mxStateDefaults(): Record<string, unknown> {
  return {
    curves: limitCurves(),
    solo: false,
    // options menu
    oversample: 0, masterMid: false, linPhase: false, safety: true, lockSpare: false,
    // view
    band: 3, display: 0, vis: [false, true, true, false, true, false, true, false], peaks: true, speed: 50,
    freeze: false, snap: true,
    an: { input: 0, hist: true, range: 2, pivot: 2, precision: 1, smoothing: 2, average: false, heat: false, enhanced: true, hq: true, heatPos: 0 },
    spare: { p: [...MAXIMUS_DEFAULTS], curves: limitCurves() } as MxSpare,
  };
}

/** The params of the state as FL's 59-value list (index order). */
export function mxParamList(p: Record<string, unknown>): number[] {
  return MX_PARAMS.map((q) => (typeof p[q.key] === 'number' ? (p[q.key] as number) : q.def));
}

export function mxNormalize(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  const cs = Array.isArray(p.curves) ? p.curves : [];
  out.curves = [0, 1, 2, 3].map((k) => normalizeCurve(cs[k]));
  const vis = Array.isArray(p.vis) ? p.vis : [];
  const dv = mxStateDefaults().vis as boolean[];
  out.vis = dv.map((d, k) => (typeof vis[k] === 'boolean' ? vis[k] : d));
  const sp = p.spare as Partial<MxSpare> | undefined;
  const spc = Array.isArray(sp?.curves) ? sp!.curves : [];
  out.spare = {
    p: MX_PARAMS.map((q, k) => (Array.isArray(sp?.p) && typeof sp!.p[k] === 'number' ? sp!.p[k] : MAXIMUS_DEFAULTS[k])),
    curves: [0, 1, 2, 3].map((k) => normalizeCurve(spc[k])),
  };
  const band = Number(p.band);
  out.band = Number.isFinite(band) ? Math.max(0, Math.min(3, Math.round(band))) : 3;
  return out;
}

// ------------------------------------------------------------------ presets

export const MX_PRESETS: FxPreset[] = MAXIMUS_PRESET_DATA.map((pr) => ({
  name: pr.name,
  params: {
    ...pr.params,
    curves: [0, 1, 2, 3].map((k) => (pr.curves?.[k] ?? LIMIT_CURVE).map((q) => [...q])),
    oversample: pr.oversample ?? 0,
    masterMid: pr.midMode ?? false,
    band: pr.band,
    display: pr.display,
  },
}));

export const def: FxPluginDef = {
  id: 'maximus',
  name: 'Maximus',
  category: 'Dynamics',
  width: 626,
  height: 385,
  description: 'Multiband maximizer, compressor and limiter',
  params: MX_PARAMS,
  state: mxStateDefaults,
  normalize: mxNormalize,
  presets: MX_PRESETS,
};
