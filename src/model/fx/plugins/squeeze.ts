// Squeeze (FL: Fruity Squeeze). Form: 279 x 220. Twelve parameters in FL's
// raw units with FL's value texts. FL inserts the plugin with its "Default"
// factory preset, which differs from the constructor state, so those values
// are the defaults here.

import type { FxPluginDef } from '../types';

const pct = (v: number, max: number) => `${Math.round((v / max) * 100)}%`;
const samples = (v: number) => `${Math.round(Math.pow(44101, v / 44100) - 1)} samples`;

export const SQ_FILTER_TYPES = ['low pass', 'high pass', 'band pass', 'notch', 'peak'];
export const SQ_RELATIONS = ['none', 'impact = preserve', 'impact = preserve x 2', 'impact = preserve / 2'];

export const def: FxPluginDef = {
  id: 'squeeze',
  name: 'Squeeze',
  category: 'Distortion',
  width: 279,
  height: 220,
  description: 'Bit reduction (squarize), puncher gating and a resonant filter',
  params: [
    { key: 'gain', name: 'Gain', index: 0, min: 0, max: 160, def: 93, format: (v) => pct(v, 127), parse: (t) => Math.round((t / 100) * 127) },
    {
      key: 'mix', name: 'Mix', index: 1, min: 0, max: 128, def: 108,
      format: (v) => `${(100 - v / 1.28).toFixed(1)}% dry / ${(v / 1.28).toFixed(1)}% wet`, parse: (t) => Math.round(t * 1.28),
    },
    { key: 'steps', name: 'Steps', index: 2, min: 1, max: 32768, def: 28417, format: (v) => `${Math.pow(32768, 1 - v / 32768).toFixed(1)} steps`, parse: (t) => Math.round(32768 * (1 - Math.log(Math.max(1, t)) / Math.log(32768))) },
    { key: 'filter', name: 'Filter', index: 3, min: 0, max: 1, def: 1, options: ['off', 'on'] },
    { key: 'ftype', name: 'Filter type', index: 4, min: 0, max: 4, def: 4, options: SQ_FILTER_TYPES },
    { key: 'res', name: 'Filter Resonance', index: 5, min: 0, max: 65536, def: 46592, format: (v) => pct(v, 65536), parse: (t) => Math.round((t / 100) * 65536) },
    { key: 'cutoff', name: 'Filter Cutoff', index: 6, min: 0, max: 65536, def: 23552, format: (v) => pct(v, 65536), parse: (t) => Math.round((t / 100) * 65536) },
    { key: 'fpos', name: 'Filter Position', index: 7, min: 0, max: 1, def: 1, options: ['pre', 'pos'] },
    { key: 'relation', name: 'Relation', index: 8, min: 0, max: 3, def: 0, options: SQ_RELATIONS },
    { key: 'impact', name: 'Impact', index: 9, min: 0, max: 44100, def: 2892, format: samples, parse: (t) => Math.round((44100 * Math.log(Math.max(0, t) + 1)) / Math.log(44101)) },
    { key: 'preserve', name: 'Preserve', index: 10, min: 0, max: 44100, def: 4684, format: samples, parse: (t) => Math.round((44100 * Math.log(Math.max(0, t) + 1)) / Math.log(44101)) },
    { key: 'amount', name: 'Amount', index: 11, min: 0, max: 65536, def: 0, format: (v) => pct(v, 65536), parse: (t) => Math.round((t / 100) * 65536) },
  ],
  // FL's factory presets (read through FL's plugin with flfxhost info --preset)
  presets: [
    { name: 'Default', params: { gain: 93, mix: 108, steps: 28417, filter: 1, ftype: 4, res: 46592, cutoff: 23552, fpos: 1, relation: 0, impact: 2892, preserve: 4684, amount: 0 } },
    { name: 'Grit', params: { gain: 93, mix: 108, steps: 28417, filter: 0, ftype: 4, res: 46592, cutoff: 23552, fpos: 1, relation: 0, impact: 2892, preserve: 4684, amount: 0 } },
    { name: 'Low Squeek', params: { gain: 127, mix: 64, steps: 28417, filter: 1, ftype: 0, res: 46592, cutoff: 23552, fpos: 0, relation: 1, impact: 15948, preserve: 15948, amount: 0 } },
    { name: 'Off', params: { gain: 127, mix: 64, steps: 1, filter: 0, ftype: 0, res: 32768, cutoff: 32768, fpos: 0, relation: 0, impact: 0, preserve: 7500, amount: 0 } },
    { name: 'Punch', params: { gain: 127, mix: 64, steps: 28417, filter: 0, ftype: 0, res: 32768, cutoff: 32768, fpos: 0, relation: 0, impact: 0, preserve: 7500, amount: 0 } },
    { name: 'Squeek', params: { gain: 127, mix: 64, steps: 28417, filter: 1, ftype: 0, res: 46592, cutoff: 23552, fpos: 0, relation: 0, impact: 5376, preserve: 15948, amount: 0 } },
  ],
};
