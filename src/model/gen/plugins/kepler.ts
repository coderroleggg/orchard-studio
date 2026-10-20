// Kepler (FL: Kepler, Plugin database > Generators > Synth classic): Image-Line's emulation of a Juno-6 style
// synthesizer (one DCO with pulse / saw / sub / noise, HPF, 24 dB VCF, one LFO, envelope, arpeggiator, chorus).
// From FL 2026: the 36 FL parameters (names, ranges, engine ids, value texts reproduced from the Pascal wrapper's
// text function and verified with full test-host sweeps), the form (1080 x 217), the engine's state blob (the
// Options menu switches that are not parameters) and FL's 277 presets (state blobs decoded with FL's own loader).
// The plugin database entry equals the "Default" preset: the insertion state. See docs/research/gen/kepler.md.

import type { FxParamDef } from '../../fx/types';
import type { GenPluginDef } from '../types';
import {
  KEPLER_DEFAULT_ROW, KEPLER_MAX, KEPLER_MIN, KEPLER_OPTION_DEFAULT, KEPLER_PARAM_KEYS, KEPLER_PARAM_NAMES,
  KEPLER_PRESET_NAMES, keplerFormat, keplerNormalize, keplerOptions, keplerParse,
} from './kepler/data';

const PARAMS: FxParamDef[] = KEPLER_PARAM_KEYS.map((key, i) => {
  const p: FxParamDef = {
    key, name: KEPLER_PARAM_NAMES[i], index: i, min: KEPLER_MIN[i], max: KEPLER_MAX[i], def: KEPLER_DEFAULT_ROW[i],
    format: (v, st) => keplerFormat(i, v, st),
  };
  const parse = keplerParse(i);
  if (parse) p.parse = parse;
  const options = keplerOptions(i);
  if (options) p.options = options;
  return p;
});

export const def: GenPluginDef = {
  id: 'kepler',
  name: 'Kepler',
  category: 'Synth classic',
  notes: 'events',
  velocity: 'plugin',
  levels: 'plugin',
  defPoly: 0,
  width: 1080,
  height: 217,
  description: 'Juno-6 style analog synthesizer with arpeggiator and chorus',
  params: PARAMS,
  // Options FL's preset files do not store (the instance keeps them when a preset loads)
  viewState: ['chorusNoiseGate', 'chorusNoise', 'hq', 'flTablesSample'],
  // flTablesSample: pool sample holding FL's LFO sine and noise tables when the user imported them ("Import FL content...")
  state: () => ({ ...KEPLER_OPTION_DEFAULT, flTablesSample: '' }),
  normalize: keplerNormalize,
  presets: KEPLER_PRESET_NAMES.map((name, i) => ({ name, params: { __kepler: i } })),
};
