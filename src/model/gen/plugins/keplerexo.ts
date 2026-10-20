// Kepler Exo (FL: Kepler Exo, Plugin database > Generators > Synth classic): the extended Kepler: two DCOs with
// cross modulation and hard sync, two LFOs and two envelopes, a 24 dB multi-slope filter with FM, an 8 slot
// modulation matrix, arpeggiator, chorus, EQ, delay, reverb, saturation and hyper chorus.
// From FL 2026: the 155 FL parameters (names, ranges, value texts reproduced from the Pascal wrapper's text function
// and verified with full test-host sweeps), the form (1080 x 574), the engine's state blob (modulation matrix and
// Options menu switches) and FL's 188 presets (state blobs decoded with FL's own loader).
// The plugin database entry equals the "Default" preset: the insertion state. See docs/research/gen/keplerexo.md (and kepler.md for the shared engine).

import type { FxParamDef } from '../../fx/types';
import type { GenPluginDef } from '../types';
import {
  KEPLEREXO_DEFAULT_ROW, KEPLEREXO_MAX, KEPLEREXO_MIN, KEPLEREXO_OPTION_DEFAULT, KEPLEREXO_PARAM_KEYS, KEPLEREXO_PARAM_NAMES,
  KEPLEREXO_PRESET_NAMES, keplerExoDefaultMatrix, keplerExoFormat, keplerExoNormalize, keplerExoOptions, keplerExoParse,
} from './keplerexo/data';

/** Centre-zero controls (semitones, detune, pan, matrix amounts, EQ gains, master tune). */
const BIPOLAR = new Set([13, 14, 74, 92, 93, 94, 95, 96, 97, 98, 99, 104, 105, 106, 153]);

const PARAMS: FxParamDef[] = KEPLEREXO_PARAM_KEYS.map((key, i) => {
  const p: FxParamDef = {
    key, name: KEPLEREXO_PARAM_NAMES[i], index: i, min: KEPLEREXO_MIN[i], max: KEPLEREXO_MAX[i], def: KEPLEREXO_DEFAULT_ROW[i],
    format: (v, st) => keplerExoFormat(i, v, st),
  };
  const parse = keplerExoParse(i);
  if (parse) p.parse = parse;
  const options = keplerExoOptions(i);
  if (options) p.options = options;
  if (BIPOLAR.has(i)) p.bipolar = true;
  return p;
});

export const def: GenPluginDef = {
  id: 'keplerexo',
  name: 'Kepler Exo',
  category: 'Synth classic',
  notes: 'events',
  velocity: 'plugin',
  levels: 'plugin',
  defPoly: 0,
  width: 1080,
  height: 574,
  description: 'Extended Juno-style synthesizer with two DCOs, modulation matrix and effects',
  params: PARAMS,
  // Options FL's preset files do not store (the instance keeps them when a preset loads) and view settings
  viewState: ['arpQuantize', 'hq', 'enhancedOscillators', 'modPage', 'theme', 'flTablesSample'],
  // flTablesSample: pool sample holding FL's LFO sine and noise tables when the user imported them ("Import FL content...")
  state: () => ({ ...KEPLEREXO_OPTION_DEFAULT, modMatrix: keplerExoDefaultMatrix(), modPage: 0, theme: 0, flTablesSample: '' }),
  normalize: keplerExoNormalize,
  presets: KEPLEREXO_PRESET_NAMES.map((name, i) => ({ name, params: { __keplerexo: i } })),
};
