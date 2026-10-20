// Blood Overdrive (FL: Fruity Blood Overdrive). Form: 420 x 180. Six
// parameters, each 0..10000 except x100 (0/1). FL's value texts are the raw
// fractions ("0.5000"); Post gain reads -1.0000 .. 0.0000.
// Non-parameter state: the editor theme (FL's right-click Theme menu).

import type { FxPluginDef } from '../types';

/** FL's value text for the 0..10000 knobs: the fraction with four decimals. */
export function fracText(v: number): string {
  return (v / 10000).toFixed(4);
}

/** Post gain text: fraction - 1 ("-0.3000", "0.0000" at maximum). */
export function postGainText(v: number): string {
  const s = (v / 10000 - 1).toFixed(4);
  return s === '-0.0000' ? '0.0000' : s;
}

/** Editor themes (FL's right-click menu on the editor background). */
export const BO_THEMES = ['Dark Brown', 'Brown Metalic', 'Brown Metalic Panels', 'Blood Red'];

const frac = { min: 0, max: 10000, format: fracText, parse: (t: number) => Math.round(t * 10000) };

export const def: FxPluginDef = {
  id: 'bloodoverdrive',
  name: 'Blood Overdrive',
  category: 'Distortion',
  width: 420,
  height: 180,
  description: 'Overdrive distortion with pre band-pass and post low-pass filtering',
  params: [
    { key: 'preBand', name: 'Pre band', index: 0, def: 0, ...frac },
    { key: 'color', name: 'Color', index: 1, def: 5000, ...frac },
    { key: 'preAmp', name: 'Pre amp', index: 2, def: 0, ...frac },
    { key: 'x100', name: 'x100', index: 3, min: 0, max: 1, def: 0, options: ['Off', 'On'] },
    { key: 'postFilter', name: 'Post filter', index: 4, def: 0, ...frac },
    { key: 'postGain', name: 'Post gain', index: 5, min: 0, max: 10000, def: 10000, format: postGainText, parse: (t: number) => Math.round((t + 1) * 10000) },
  ],
  state: () => ({ theme: 0 }),
  // FL's factory presets (values read through FL's plugin with flfxhost --preset)
  presets: [
    { name: 'Boost', params: { preBand: 4000, color: 5000, preAmp: 2000, x100: 0, postFilter: 2500, postGain: 10000 } },
    { name: 'Drive', params: { preBand: 8500, color: 5000, preAmp: 10000, x100: 0, postFilter: 5000, postGain: 5000 } },
    { name: 'Reset', params: { preBand: 0, color: 5000, preAmp: 0, x100: 0, postFilter: 0, postGain: 10000 } },
  ],
};
