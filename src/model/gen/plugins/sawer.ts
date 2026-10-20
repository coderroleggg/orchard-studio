// Sawer (FL: Sawer, Plugin database > Generators > Synth classic): Image-Line's
// analog-modelled synthesizer built around one saw: a sub saw / square at a ratio with
// phase offset, hard sync, noise, unison (up to 8 voices), a 4-pole ladder filter (LP24 /
// LP12 / BP / HP) with its envelope, a global LFO, a six-slot MIDI modulation matrix,
// arpeggiator, chorus, phaser, delay and reverb.
// From FL 2026: the parameter list (73 synth parameters, MIDI CC 0..127 and channel
// aftertouch: 202 parameters, names, value texts checked against test-host sweeps of every
// parameter), the editor form (897 x 622), the engine's hidden settings (arpeggiator speed,
// polyphony, pitch-bend range, modulation matrix) and FL's 421 presets (state blobs decoded).
// FL's plugin database entry: the values of "Ambient/MC Chains" with the MIDI-learn links
// of "Default" (the insertion state).
// State `sample`: the pool sample with FL's data.saw (the oscillator's saw cycle), imported
// from the user's own FL install (plugin menu); without it the engine uses a synthesized
// stand-in. Sawer renders silence in FL's test host (licence check), so its sound could not
// be compared with FL. See docs/research/gen/sawer.md.

import type { FxParamDef } from '../../fx/types';
import type { GenPluginDef } from '../types';
import {
  SW_ENGINE_COUNT, SW_ENUMS, SW_HIDDEN_DEFAULT, SW_PARAM_COUNT, SW_PARAM_KEYS, SW_PARAM_NAMES, SW_PRESET_NAMES, SW_SWITCHES,
  swFormat, swInsertState, swParse, swPresetState,
} from './sawer/data';

const INSERT = swInsertState();

const PARAMS: FxParamDef[] = SW_PARAM_KEYS.map((key, i) => {
  const def = i < SW_PARAM_COUNT ? Number(INSERT[key]) : 0;
  const p: FxParamDef = { key, name: SW_PARAM_NAMES[i], index: i, min: 0, max: 256, def, format: (v) => swFormat(i, v) };
  const parse = swParse(i);
  if (parse) p.parse = parse;
  if (SW_SWITCHES.has(i)) p.options = ['Off', 'On'];
  if (SW_ENUMS[i]) p.step = 1;
  if (i === 1 || i === 6 || i === 7) p.bipolar = true;
  return p;
});

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const NH = SW_ENGINE_COUNT - SW_PARAM_COUNT;

export const def: GenPluginDef = {
  id: 'sawer',
  name: 'Sawer',
  category: 'Synth classic',
  notes: 'events',
  velocity: 'plugin',
  levels: 'plugin',
  defPoly: 0,
  width: 897,
  height: 622,
  description: 'Analog-modelled saw synthesizer with sub oscillator, ladder filter, modulation matrix and effects',
  params: PARAMS,
  viewState: ['sample', 'swKeys', 'swLink'],
  state: () => ({
    hidden: (INSERT.hidden as number[]).slice(),
    ccMap: (INSERT.ccMap as number[]).slice(),
    sample: '',
  }),
  normalize: (p) => {
    const q: Record<string, unknown> = { ...p };
    if (typeof q.__sw === 'number') {
      const st = swPresetState(q.__sw);
      delete q.__sw;
      Object.assign(q, st);
    }
    const h = Array.isArray(q.hidden) ? q.hidden : [];
    q.hidden = Array.from({ length: NH }, (_, i) => num(h[i], SW_HIDDEN_DEFAULT[i]));
    const m = Array.isArray(q.ccMap) ? q.ccMap : [];
    q.ccMap = Array.from({ length: SW_ENGINE_COUNT }, (_, i) => Math.max(-1, Math.min(127, Math.trunc(num(m[i], -1)))));
    q.sample = typeof q.sample === 'string' ? q.sample : '';
    return q;
  },
  presets: SW_PRESET_NAMES.map((name, i) => ({ name, params: { __sw: i } })),
};
