// Multiband Compressor (FL: Fruity Multiband Compressor): three band stereo
// compressor with Butterworth IIR or linear phase FIR band splitting and an
// output limiter. Parameters, ranges, defaults and value texts are FL's own
// (read from FL Studio 2026 with flfxhost); the control laws below were
// measured on FL's plugin (docs/research/fx/mbcompressor.md).

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';
import { MB_FREQ_LNF, MB_PRESET_DATA } from './mbcompressor/data';

export const MB_BANDS = ['l', 'm', 'h'] as const;
export type MbBand = (typeof MB_BANDS)[number];
export const MB_BAND_NAMES: Record<MbBand, string> = { l: 'Low', m: 'Mid', h: 'High' };
export const MB_STATES = ['ON', 'muted', 'bypassed'];
export const MB_FILTERS = ['BW IIR', 'LP FIR'];

// ---- control laws (FL control units -> physical units) ----

/** Master volume: gain = 2^(v / 32768) - 1 (0 = silence, 32768 = 0 dB, 65536 = +9.5 dB). */
export const mbMasterGain = (v: number): number => Math.pow(2, v / 32768) - 1;
/** Band output gain: 2^(3 v / 65536) - 1 (21845 = 0 dB, 65536 = +16.9 dB). */
export const mbOutGain = (v: number): number => Math.pow(2, (3 * v) / 65536) - 1;
/** Threshold in dB: -60 .. 0. */
export const mbThresDb = (v: number): number => -60 + (60 * v) / 65536;
/** Ratio amount 0..1 (FL text 1 / (1 - x) : 1). */
export const mbRatioX = (v: number): number => Math.min(1, Math.max(0, v / 65536));
/** Attack (0.1 .. 100 ms) and release (10 .. 1000 ms) in ms. */
export const mbMs = (v: number): number => v / 10;
/**
 * Attack smoothing cut-off (Hz) of the prewarped one-pole: its period runs
 * from 1/17000 s (0.1 ms) to 1/17000 + 0.1 s (100 ms) linearly (measured).
 */
export const mbAttackHz = (v: number): number => 1 / (1 / 17000 + (0.1 * (Math.max(1, v) - 1)) / 999);
/** Release time constant (s) of the peak detector. */
export const mbReleaseSec = (v: number): number => v / 10000;
/**
 * Soft knee: the quadratic knee spans threshold +- W with W = 0.005 + r * t
 * (t = linear threshold): a relative part r = 0.995 (1 - k^2) (0 % = soft,
 * 100 % = hard) plus a fixed 0.005 that widens the knee at low thresholds
 * (measured at thresholds from -54 to -4 dB). Returns r.
 */
export const mbKneeRel = (v: number): number => {
  const k = Math.min(1, Math.max(0, v / 65536));
  return 0.995 * (1 - k * k);
};
/** Absolute knee half width for a knee value and a linear threshold. */
export const mbKneeW = (v: number, t: number): number => 0.005 + mbKneeRel(v) * t;

/** Control value of knot i of MB_FREQ_LNF (every 50 steps from 20; the last knot is 20000). */
const knotV = (i: number): number => (i >= MB_FREQ_LNF.length - 1 ? 20000 : 20 + 50 * i);

/** Frequency control (20..20000) -> Hz. FL's law has no closed form: tabulated (see data.ts). */
export function mbFreqHz(v: number): number {
  const c = Math.min(20000, Math.max(20, v));
  const i = Math.min(MB_FREQ_LNF.length - 2, Math.floor((c - 20) / 50));
  const v0 = knotV(i), f = (c - v0) / (knotV(i + 1) - v0);
  return Math.exp(MB_FREQ_LNF[i] + (MB_FREQ_LNF[i + 1] - MB_FREQ_LNF[i]) * f);
}

/** Inverse of mbFreqHz (control value for a frequency), for typed-in values. */
export function mbFreqValue(hz: number): number {
  const l = Math.log(Math.min(20000, Math.max(20, hz)));
  let lo = 0, hi = MB_FREQ_LNF.length - 1;
  if (l <= MB_FREQ_LNF[0]) return 20;
  if (l >= MB_FREQ_LNF[hi]) return 20000;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (MB_FREQ_LNF[m] <= l) lo = m; else hi = m; }
  const f = (l - MB_FREQ_LNF[lo]) / (MB_FREQ_LNF[hi] - MB_FREQ_LNF[lo]);
  return Math.round(knotV(lo) + (knotV(hi) - knotV(lo)) * f);
}

// ---- value texts (FL's) ----

export function mbDbText(g: number): string {
  if (!(g > 0)) return '-oo';
  let s = (20 * Math.log10(g)).toFixed(1);
  if (s === '-0.0') s = '0.0';
  return s + 'dB';
}
// FL computes the gains of its value texts in single precision (matches all 65537 values)
const f32 = Math.fround;
const masterText = (v: number): string => mbDbText(f32(f32(Math.pow(2, f32(v / 32768))) - 1));
const outText = (v: number): string => mbDbText(f32(f32(Math.pow(2, f32((v * 3) / 65536))) - 1));
const thresText = (v: number): string => {
  if (v === 61440) return '-3.7dB'; // the one tie FL's float maths rounds the other way
  const s = mbThresDb(v).toFixed(1);
  return (s === '-0.0' ? '0.0' : s) + 'dB';
};
const ratioText = (v: number): string => (v >= 65536 ? 'oo:1' : `${(1 / (1 - v / 65536)).toFixed(1)}:1`);
const pctText = (v: number): string => `${Math.floor(v / 655.36 + 0.5)}%`;
const freqText = (v: number): string => `${Math.floor(mbFreqHz(v) + 0.5)}Hz`;
const msText = (v: number): string => `${(v / 10).toFixed(1)}ms`;

// ---- parameters (index = FL parameter index / form Tag) ----

type BandKeys = { state: string; freq: string[]; out: string; thres: string; ratio: string; att: string; rel: string; knee: string };
/** Parameter keys of each band (freq: the cut-offs that bound the band, low to high). */
export const MB_KEYS: Record<MbBand, BandKeys> = {
  h: { state: 'hState', freq: ['hFreq'], out: 'hOut', thres: 'hThres', ratio: 'hRatio', att: 'hAtt', rel: 'hRel', knee: 'hKnee' },
  m: { state: 'mState', freq: ['mFreqL', 'mFreqH'], out: 'mOut', thres: 'mThres', ratio: 'mRatio', att: 'mAtt', rel: 'mRel', knee: 'mKnee' },
  l: { state: 'lState', freq: ['lFreq'], out: 'lOut', thres: 'lThres', ratio: 'lRatio', att: 'lAtt', rel: 'lRel', knee: 'lKnee' },
};

function bandParams(b: MbBand, first: number, freqs: { key: string; name: string; def: number }[], thresDef: number): FxParamDef[] {
  const L = b.toUpperCase();
  const K = MB_KEYS[b];
  const f: FxParamDef[] = freqs.map((q) => ({ key: q.key, name: q.name, min: 20, max: 20000, def: q.def, format: freqText, parse: (hz: number) => mbFreqValue(hz) }));
  const list: FxParamDef[] = [
    { key: K.state, name: `${MB_BAND_NAMES[b]} band state`, min: 0, max: 2, def: 0, options: MB_STATES },
    ...f,
    { key: K.out, name: `${L} Output`, min: 0, max: 65536, def: 21845, format: outText, parse: (db) => Math.round((65536 / 3) * Math.log2(1 + Math.pow(10, db / 20))) },
    { key: K.thres, name: `${L} Threshold`, min: 0, max: 65536, def: thresDef, format: thresText, parse: (db) => Math.round(((db + 60) * 65536) / 60) },
    { key: K.ratio, name: `${L} Ratio`, min: 0, max: 65536, def: 32768, format: ratioText, parse: (r) => Math.round(65536 * (1 - 1 / Math.max(1, r))) },
    { key: K.att, name: `${L} Attack`, min: 1, max: 1000, def: 100, format: msText, parse: (ms) => Math.round(ms * 10) },
    { key: K.rel, name: `${L} Release`, min: 100, max: 10000, def: 1000, format: msText, parse: (ms) => Math.round(ms * 10) },
    // FL names all three "Hard / soft  Knee" (the band letter of the hint is lost); the hint's name is kept
    { key: K.knee, name: `Hard / soft ${L} Knee`, min: 0, max: 65536, def: 52429, format: pctText, parse: (pct) => Math.round(pct * 655.36) },
  ];
  return list.map((p, k) => ({ ...p, index: first + k }));
}

export const MB_PARAMS: FxParamDef[] = [
  { key: 'master', name: 'Master volume', index: 0, min: 0, max: 65536, def: 32768, format: masterText, parse: (db) => Math.round(32768 * Math.log2(1 + Math.pow(10, db / 20))) },
  { key: 'limiter', name: 'Limiter', index: 1, min: 0, max: 1, def: 0, options: ['OFF', 'ON'] },
  { key: 'filterType', name: 'Filter type', index: 2, min: 0, max: 1, def: 0, options: MB_FILTERS },
  ...bandParams('h', 3, [{ key: 'hFreq', name: 'H Freq', def: 17000 }], 45875),
  ...bandParams('m', 11, [{ key: 'mFreqH', name: 'M Freq H', def: 17000 }, { key: 'mFreqL', name: 'M Freq L', def: 6500 }], 48875),
  ...bandParams('l', 20, [{ key: 'lFreq', name: 'L Freq', def: 6500 }], 45875),
];

// ---- non-parameter state ----

/** Meter IN / OUT switches (false = input level, FL's "IN"), visual speed (-1..100, 0 = off). */
export function mbStateDefaults(): Record<string, unknown> {
  return { io: [false, false, false, false], speed: 50 };
}

export function mbNormalize(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  const io = Array.isArray(p.io) ? p.io : [];
  out.io = [0, 1, 2, 3].map((k) => io[k] === true);
  out.speed = typeof p.speed === 'number' && Number.isFinite(p.speed) ? Math.max(-1, Math.min(100, Math.round(p.speed))) : 50;
  return out;
}

export const MB_PRESETS: FxPreset[] = MB_PRESET_DATA.map((pr) => {
  const params: Record<string, unknown> = {};
  MB_PARAMS.forEach((q) => { params[q.key] = pr.values[q.index!]; });
  params.io = pr.io.map((b) => b !== 0);
  params.speed = pr.speed;
  return { name: pr.name, params };
});

export const def: FxPluginDef = {
  id: 'mbcompressor',
  name: 'Multiband Compressor',
  category: 'Dynamics',
  width: 800,
  height: 155,
  description: 'Three band compressor with IIR or linear phase band split and limiter',
  params: MB_PARAMS,
  state: mbStateDefaults,
  normalize: mbNormalize,
  presets: MB_PRESETS,
};
