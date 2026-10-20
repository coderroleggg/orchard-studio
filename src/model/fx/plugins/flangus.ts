// Flangus (FL: Fruity Flangus, by Didier Dambrin): up to 9 stacked flangers per
// channel. Form: 361 x 177 (seven sliders and the "ORD" wheel). Parameters,
// ranges and texts from FL's binary (flfxhost info/sweep); the DSP mappings
// were measured from FL's own renders, see docs/research/fx/flangus.md.

import type { FxPluginDef } from '../types';

/** FL's exponential knob law (11^x - 1) / 10: 0 -> 0, 1 -> 1. */
export function flangusExp(x: number): number {
  return (Math.pow(11, x) - 1) / 10;
}

/** Signed level for Dry / Wet (-128..128): sign(v) * exp law. */
export function flangusLevel(v: number): number {
  return Math.sign(v) * flangusExp(Math.min(1, Math.abs(v) / 128));
}

/** "50%": halves round away from zero ("-88%" at -112/128). */
const pct = (v: number, max: number) => {
  const x = (v / max) * 100;
  return `${Math.sign(x) * Math.round(Math.abs(x))}%`;
};

export const def: FxPluginDef = {
  id: 'flangus',
  name: 'Flangus',
  category: 'Flanger',
  width: 361,
  height: 177,
  description: 'Stacked flangers with spread, stereo cross and unison-like detune',
  params: [
    { key: 'order', name: 'Order', index: 0, min: 1, max: 9, def: 4, format: (v) => String(Math.round(v)), parse: (n) => n },
    { key: 'depth', name: 'Depth', index: 1, min: 0, max: 1024, def: 512, format: (v) => pct(v, 1024), parse: (p) => (p / 100) * 1024 },
    { key: 'speed', name: 'Speed', index: 2, min: 0, max: 1024, def: 768, format: (v) => pct(v, 1024), parse: (p) => (p / 100) * 1024 },
    { key: 'delay', name: 'Delay', index: 3, min: 0, max: 128, def: 8, format: (v) => pct(v, 128), parse: (p) => (p / 100) * 128 },
    { key: 'spread', name: 'Spread', index: 4, min: 0, max: 128, def: 128, format: (v) => pct(v, 128), parse: (p) => (p / 100) * 128 },
    { key: 'cross', name: 'Cross', index: 5, min: -128, max: 128, def: -32, bipolar: true, format: (v) => pct(v, 128), parse: (p) => (p / 100) * 128 },
    { key: 'dry', name: 'Dry level', index: 6, min: -128, max: 128, def: 96, bipolar: true, format: (v) => pct(v, 128), parse: (p) => (p / 100) * 128 },
    { key: 'wet', name: 'Wet level', index: 7, min: -128, max: 128, def: 96, bipolar: true, format: (v) => pct(v, 128), parse: (p) => (p / 100) * 128 },
  ],
  // FL's factory presets (read from the .fst files through flfxhost; values that
  // differ from the defaults)
  presets: [
    { name: 'Classic', params: { speed: 892, dry: 88, wet: 128 } },
    { name: 'Deep chorus', params: { order: 7, speed: 512, delay: 128, cross: 54, dry: 122, wet: 90 } },
    { name: 'Default', params: {} },
    { name: 'Fast flanger', params: { order: 6, depth: 231, speed: 848, delay: 0, spread: 0, cross: -66, dry: 0, wet: 112 } },
    { name: 'Flanger', params: { order: 6, depth: 561, speed: 854, delay: 0, spread: 0, cross: 38, dry: 0, wet: 114 } },
    { name: 'Flanger 2', params: { order: 1, depth: 136, speed: 312, delay: 0, spread: 0, cross: 128, dry: 128, wet: -128 } },
    { name: 'For drums', params: { speed: 512, delay: 30, cross: -56, dry: -128, wet: 128 } },
    { name: 'Modulation', params: { order: 1, depth: 42, speed: 944, delay: 0, spread: 0, cross: -22, dry: 0, wet: 128 } },
    { name: 'Stereoized', params: { order: 2, depth: 86, speed: 632, delay: 0, spread: 0, cross: 0, dry: 0, wet: 120 } },
    { name: 'Surround flanger', params: { order: 9, depth: 81, speed: 170, delay: 0, spread: 0, cross: -66, dry: 0, wet: 104 } },
    { name: 'Thick', params: { order: 5, depth: 1024, speed: 856, delay: 0, cross: 68, dry: 42, wet: 128 } },
    { name: 'Vibrate', params: { order: 7, depth: 19, speed: 985, delay: 0, spread: 0, cross: 0, dry: 128, wet: 82 } },
  ],
};
