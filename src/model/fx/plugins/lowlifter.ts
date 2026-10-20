// Low Lifter (FL: Low Lifter, Image-Line / Dario Sanfilippo). Bass enhancer:
// an LR4 crossover isolates the low band, which is boosted (with a 0 dBFS
// limiter), shaped by a Chebyshev series that adds 2nd and 3rd harmonics with
// a decay slope, diffused by an allpass network and mixed back with the high
// band before a final low cut. Form 680 x 280; parameters in FL's order.
// The value laws below reproduce all of FL's value texts exactly.

import type { FxPluginDef } from '../types';

const f32 = Math.fround;

/** Normalised control value as FL stores it (float32). */
function nx(v: number): number {
  return f32(v / 10000);
}
/** Low band gain (dB): -inf, 0 dB at 50 %, +12 dB (law -120 + 132 x^(1/7.275)). */
export function llLowGainDb(v: number): number {
  return v <= 0 ? -Infinity : 132 * Math.pow(nx(v), 1 / 7.275) - 120;
}
/** Harmonics decay slope (dB): -60 .. 0 dB (law 60 (x^(1/3.105) - 1)). */
export function llSlopeDb(v: number): number {
  return 60 * (Math.pow(nx(v), 1 / 3.105) - 1);
}
/** High band gain (dB): -inf .. 0 dB (law 120 (x^0.2 - 1)). */
export function llHighGainDb(v: number): number {
  return v <= 0 ? -Infinity : 120 * (Math.pow(nx(v), 0.2) - 1);
}
/** Pre-shaping boost (dB): 0 .. 18 dB. */
export function llPreGainDb(v: number): number {
  return nx(v) * 18;
}
/** Crossover cutoff and low cut (Hz): 20 .. 120 Hz (law 20 + 100 x^2.0043374). */
export function llFreqHz(v: number): number {
  return 20 + 100 * Math.pow(nx(v), 2.0043374);
}
/** Diffuser coefficient (allpass gain), -0.99 .. 0.99. */
export function llDiffCoef(v: number): number {
  return f32(f32(0.99) * f32(2 * nx(v) - 1));
}
/** Diffuser mix 0..1. */
export function llDiffMix(v: number): number {
  return nx(v);
}

// FL prints the exact binary value rounded half away from zero (= JS toFixed)
function fix2(x: number): string {
  const s = x.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}
const dbText = (f: (v: number) => number) => (v: number) => { const d = f(v); return Number.isFinite(d) ? `${fix2(d)} dB` : '-inf'; };
const onOff = ['Off', 'On'];

export const def: FxPluginDef = {
  id: 'lowlifter',
  name: 'Low Lifter',
  category: 'Misc',
  width: 680,
  height: 280,
  description: 'Bass enhancer: harmonics, diffusion and crossover',
  // analyzer options (Options menu): histogram, range, pivot slope, frequency precision, time smoothing, average
  state: () => ({ histogram: true, range: 2, pivot: 0, precision: 2, smoothing: 2, average: false }),
  params: [
    { key: 'enabled', name: 'Enabled', index: 0, min: 0, max: 1, def: 1, options: onOff },
    // FL's Default preset: Dry/Wet 100 %, slope -6.53 dB, pre-shaping boost 9 dB, crossover 99.53 Hz
    { key: 'dryWet', name: 'Dry/Wet', index: 1, min: 0, max: 10000, def: 10000, format: (v) => `${Math.round(f32(nx(v) * 100))}%` },
    { key: 'lowGain', name: 'Low band gain', index: 2, min: 0, max: 10000, def: 4999, format: dbText(llLowGainDb) },
    { key: 'slope', name: 'Harmonics decay slope', index: 3, min: 0, max: 10000, def: 6993, format: dbText(llSlopeDb) },
    { key: 'lookahead', name: 'Lookahead', index: 4, min: 0, max: 1, def: 1, options: onOff },
    { key: 'invert', name: 'Invert harmonics polarity', index: 5, min: 0, max: 1, def: 0, options: onOff },
    { key: 'preGain', name: 'Pre-shaping boost', index: 6, min: 0, max: 10000, def: 4998, format: dbText(llPreGainDb) },
    { key: 'diffMix', name: 'Diffuser mix', index: 7, min: 0, max: 10000, def: 0, format: (v) => fix2(llDiffMix(v)) },
    { key: 'diffDepth', name: 'Diffuser coefficient', index: 8, min: 0, max: 10000, def: 5000, format: (v) => fix2(llDiffCoef(v)) },
    { key: 'highGain', name: 'High band gain', index: 9, min: 0, max: 10000, def: 10000, format: dbText(llHighGainDb) },
    { key: 'crossover', name: 'Crossover cutoff', index: 10, min: 0, max: 10000, def: 8920, format: (v) => `${fix2(llFreqHz(v))} Hz` },
    { key: 'lowCut', name: 'Low cut', index: 11, min: 0, max: 10000, def: 0, format: (v) => `${fix2(llFreqHz(v))} Hz` },
    { key: 'multiband', name: 'Multiband processsing', index: 12, min: 0, max: 1, def: 0, options: onOff },
    { key: 'highBand', name: 'High band', index: 13, min: 0, max: 1, def: 1, options: onOff },
    { key: 'lowBand', name: 'Low band', index: 14, min: 0, max: 1, def: 1, options: onOff },
  ],
  // FL's factory presets (Plugin presets/Effects/Low Lifter), values read with the FL host;
  // parameters not listed keep the Default preset's values
  presets: [
    { name: 'Bass isolator', params: { slope: 7210, preGain: 0, crossover: 10000, lowBand: 0 } },
    { name: 'Bottom end', params: { dryWet: 3071, lowGain: 5000, slope: 2787, invert: 1, preGain: 10000, diffMix: 5302, diffDepth: 2873, highGain: 0, crossover: 6643, multiband: 1 } },
    { name: 'Default', params: {} },
    { name: 'Density', params: { lowGain: 4641, slope: 3277, preGain: 6757, diffMix: 5053, diffDepth: 8990, crossover: 7712, lowCut: 4240, multiband: 1 } },
    { name: 'Mastering bass boost', params: { lowGain: 5000, slope: 3837, preGain: 3773, diffMix: 2147, diffDepth: 4935, crossover: 6210, lowCut: 4045, multiband: 1, highBand: 0 } },
    { name: 'Nightclub next door', params: { lowGain: 5000, slope: 2104, invert: 1, preGain: 9002, diffMix: 4413, diffDepth: 7395, highGain: 0, crossover: 9582, lowCut: 4424, multiband: 1 } },
    { name: 'Sub presence', params: { lowGain: 5000, slope: 6593, preGain: 10000, diffMix: 6810, diffDepth: 6322, crossover: 4810, lowCut: 2930 } },
  ],
};
