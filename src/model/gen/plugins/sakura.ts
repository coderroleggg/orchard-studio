// Sakura (FL: Sakura, Plugin database > Generators > Synth special): Image-Line's string
// modelling synthesizer: two damped strings with an exciter (noise burst), a comb filter, lo-cut and
// hi-cut filters with their envelope, a global EG and LFO, eight resonators, an eight-slot
// modulation matrix, delay, chorus and reverb.
// From FL 2026: the parameter list (78 synth parameters, MIDI CC 0..127 and channel aftertouch:
// 207 parameters, names and value texts checked against test-host sweeps of every parameter at
// every raw value), the editor form (855 x 532), the engine's hidden settings (modulation matrix,
// string 2 frequency ratio, delay time sync, transpose) and FL's 501 presets (state chunks decoded).
// FL's plugin database entry holds the values of the factory preset "Default/Bowed 6" (the
// insertion state). Sakura renders silence in FL's test host (licence check), so its sound could not
// be compared with FL. See docs/research/gen/sakura.md.

import type { FxParamDef } from '../../fx/types';
import type { GenPluginDef } from '../types';
import {
  SK_INVERTS, SK_PARAM_COUNT, SK_PARAM_KEYS, SK_PARAM_NAMES, SK_PRESET_NAMES, SK_SWITCHES,
  skFormat, skInsertState, skNormHidden, skParse, skPresetState,
} from './sakura/data';

const INSERT = skInsertState();

const PARAMS: FxParamDef[] = SK_PARAM_KEYS.map((key, i) => {
  const def = i < SK_PARAM_COUNT ? Number(INSERT[key]) : 0;
  const p: FxParamDef = { key, name: SK_PARAM_NAMES[i], index: i, min: 0, max: 256, def, format: (v) => skFormat(i, v) };
  const parse = skParse(i);
  if (parse) p.parse = parse;
  if (SK_SWITCHES.has(i)) p.options = ['Off', 'On'];
  else if (SK_INVERTS.has(i)) p.options = ['+', '-'];
  if (i === 1) p.bipolar = true; // Tune: -99..99 cents around the middle
  return p;
});

export const def: GenPluginDef = {
  id: 'sakura',
  name: 'Sakura',
  category: 'Synth special',
  notes: 'events',
  velocity: 'plugin',
  levels: 'plugin',
  defPoly: 0,
  width: 855,
  height: 532,
  description: 'String modelling synthesizer with two strings, comb and cut filters, resonators, modulation matrix and effects',
  params: PARAMS,
  viewState: [],
  state: () => ({ hidden: (INSERT.hidden as number[]).slice() }),
  normalize: (p) => {
    const q: Record<string, unknown> = { ...p };
    const k = q.__sk;
    delete q.__sk;
    if (typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < SK_PRESET_NAMES.length) Object.assign(q, skPresetState(k));
    for (const d of PARAMS) {
      const x = q[d.key];
      q[d.key] = typeof x === 'number' && Number.isFinite(x) ? Math.min(d.max, Math.max(d.min, x)) + 0 : d.def;
    }
    q.hidden = skNormHidden(q.hidden);
    return q;
  },
  presets: SK_PRESET_NAMES.map((name, i) => ({ name, params: { __sk: i } })),
};
