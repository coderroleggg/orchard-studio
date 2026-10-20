// Free Filter (FL: Fruity Free Filter, legacy): one RBJ biquad (a Parametric
// EQ band) with a type wheel. Form: 419 x 105; Type 100..700 (Tag 0, 7 equal
// zones), Frequency, Q and Gain 0..1024 (Tags 1-3), CENTER switch (editor
// state, Tag -1; on by default). Value texts as FL: "1457 Hz", Q as bars
// (round(Q) "|"), gain magnitude "5.8 dB" (FL shows no sign).
// Measured on FL's binary (docs/research/fx/freefilter.md): coefficients are
// designed for 44.1 kHz whatever the sample rate (at 48 kHz the filter sits
// 8.8 % higher than its text).

import type { FxPluginDef } from '../types';

export const FREE_TYPES = ['Low pass', 'Band pass', 'High pass', 'Notch', 'Low shelf', 'Peaking', 'High shelf'] as const;

/** Type index (0..6) for a type wheel value 100..700. */
export function freeType(v: number): number {
  return Math.min(6, Math.max(0, Math.floor(((Math.min(700, Math.max(100, v)) - 100) * 7) / 600)));
}

/** Frequency (Hz, at 44.1 kHz design rate): 10 + 159.9 (101^t - 1), t = v / 1024. */
export function freeFreqHz(v: number): number {
  return 10 + 159.9 * (Math.pow(101, Math.min(1024, Math.max(0, v)) / 1024) - 1);
}

/** Filter Q (low / band / high pass, notch): 0.1 .. 19, linear. */
export function freeQ(v: number): number {
  return 0.1 + (18.9 * Math.min(1024, Math.max(0, v))) / 1024;
}

/** Peaking Q: 0.1 .. 100, exponential. */
export function freePeakQ(v: number): number {
  return 0.1 * Math.pow(1000, Math.min(1024, Math.max(0, v)) / 1024);
}

/** Shelf slope S: 0.1 .. 2, linear. */
export function freeShelfS(v: number): number {
  return 0.1 + (1.9 * Math.min(1024, Math.max(0, v))) / 1024;
}

/** Gain in dB: -18 .. +18 (512 = 0 dB). */
export function freeGainDb(v: number): number {
  return ((Math.min(1024, Math.max(0, v)) - 512) / 512) * 18;
}

export const def: FxPluginDef = {
  id: 'freefilter',
  name: 'Free Filter',
  category: 'Filter',
  width: 419,
  height: 105,
  hidden: true,
  description: 'Single-band filter / EQ with seven types (legacy)',
  params: [
    { key: 'type', name: 'Type', index: 0, min: 100, max: 700, def: 100, format: (v) => FREE_TYPES[freeType(v)] },
    { key: 'freq', name: 'Frequency', index: 1, min: 0, max: 1024, def: 512, format: (v) => `${Math.round(freeFreqHz(v))} Hz` },
    { key: 'q', name: 'Q', index: 2, min: 0, max: 1024, def: 169, format: (v) => '|'.repeat(Math.round(freeQ(v))) },
    { key: 'gain', name: 'Gain', index: 3, min: 0, max: 1024, def: 676, format: (v) => `${Math.abs(freeGainDb(v)).toFixed(1)} dB` },
    // editor switch, not an FL parameter
    { key: 'center', name: 'Remove DC offset', min: 0, max: 1, def: 1, options: ['Off', 'On'], noAuto: true },
  ],
  // FL's factory presets (values read from the .fst states with the test host)
  presets: [
    { name: 'Default', params: { type: 100, freq: 512, q: 169, gain: 676, center: 1 } },
    { name: 'LowPass 16000', params: { type: 100, freq: 1024, q: 0, gain: 676, center: 1 } },
    { name: 'LowPass ~11025', params: { type: 100, freq: 940, q: 0, gain: 676, center: 1 } },
    { name: 'LowPass ~5512', params: { type: 100, freq: 793, q: 0, gain: 676, center: 1 } },
    { name: 'Noise remover', params: { type: 700, freq: 784, q: 0, gain: 0, center: 1 } },
    { name: 'Sub-Woofer cut', params: { type: 300, freq: 80, q: 0, gain: 676, center: 1 } },
    { name: 'Sub-Woofer pass', params: { type: 100, freq: 176, q: 0, gain: 676, center: 1 } },
    { name: 'Telephone BandPass', params: { type: 250, freq: 876, q: 16, gain: 676, center: 1 } },
    { name: 'Tweak the Freq.!', params: { type: 375, freq: 512, q: 0, gain: 676, center: 1 } },
  ],
};
