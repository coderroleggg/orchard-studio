// Filter (FL: Fruity Filter): a Chamberlin state variable filter whose low,
// band and high pass outputs are mixed. Form: 500 x 105; every wheel is
// 0..1024 (Tags 0-4), X 2 is a switch (Tag 5). The CENTER switch (remove DC
// offset) is editor state in FL (Tag -1), stored here as a non-automatable
// field. FL's plugin returns no value texts, so FL's hint shows percentages.

import type { FxPluginDef } from '../types';

/** FL's fallback value text for a 0..1024 wheel: "50%". */
export function pct1024(v: number): string {
  return `${Math.round((v / 1024) * 100)}%`;
}

/** SVF frequency coefficient for a cutoff wheel value (measured: (26^t - 1) / 25). */
export function filterF(cut: number): number {
  return (Math.pow(26, Math.min(1024, Math.max(0, cut)) / 1024) - 1) / 25;
}

/** SVF damping for a resonance wheel value (measured: 1 .. 0.2, linear). */
export function filterQ(res: number): number {
  return 1 - (0.8 * Math.min(1024, Math.max(0, res))) / 1024;
}

/** Output mix gain for a LOW / BAND / HIGH PASS wheel value (measured: (11^t - 1) / 10). */
export function filterMix(m: number): number {
  return (Math.pow(11, Math.min(1024, Math.max(0, m)) / 1024) - 1) / 10;
}

/** Approximate centre frequency (Hz) for a cutoff value at a sample rate (Chamberlin tuning f = 2 sin(pi fc / fs)). */
export function filterHz(cut: number, sampleRate: number): number {
  return (Math.asin(Math.min(1, filterF(cut) / 2)) * sampleRate) / Math.PI;
}

export const def: FxPluginDef = {
  id: 'filter',
  name: 'Filter',
  category: 'Filter',
  width: 500,
  height: 105,
  description: 'State variable filter with low, band and high pass mix',
  params: [
    { key: 'cutoff', name: 'Cutoff frequency', index: 0, min: 0, max: 1024, def: 1024, format: pct1024 },
    { key: 'res', name: 'Resonance', index: 1, min: 0, max: 1024, def: 205, format: pct1024 },
    { key: 'lp', name: 'Low pass', index: 2, min: 0, max: 1024, def: 1024, format: pct1024 },
    { key: 'bp', name: 'Band pass', index: 3, min: 0, max: 1024, def: 0, format: pct1024 },
    { key: 'hp', name: 'High pass', index: 4, min: 0, max: 1024, def: 512, format: pct1024 },
    { key: 'x2', name: 'X 2', index: 5, min: 0, max: 1, def: 0, options: ['Off', 'On'] },
    // editor switch, not an FL parameter
    { key: 'center', name: 'Remove DC offset', min: 0, max: 1, def: 1, options: ['Off', 'On'], noAuto: true },
  ],
  // FL's factory presets (values read from the .fst states with the test host;
  // Default equals the plugin's initial state)
  presets: [
    { name: 'Default', params: { cutoff: 1024, res: 205, lp: 1024, bp: 0, hp: 512, x2: 0, center: 1 } },
    { name: 'Party next door', params: { cutoff: 160, res: 1024, lp: 864, bp: 0, hp: 0, x2: 0, center: 1 } },
    { name: 'Retro sound', params: { cutoff: 480, res: 1024, lp: 0, bp: 0, hp: 1024, x2: 1, center: 1 } },
    { name: 'Tiny speakers', params: { cutoff: 544, res: 0, lp: 0, bp: 1024, hp: 464, x2: 1, center: 1 } },
  ],
};
