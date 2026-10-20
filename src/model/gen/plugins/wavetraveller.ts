// Wave Traveller (FL: Wave Traveller, Plugin database > Generators > Sampler): spline-controlled scratching.
// A note plays the patch of its key: a WAVE spline moves the play position over the loaded sample (a record
// under the hand), a VOL spline and the mutes shape the volume. See docs/research/gen/wavetraveller.md.
//
// From FL 2026's binary (Wave Traveller_x64.dylib, arm64 slice, class TTestPlug / CWWarper, no symbols):
// - 0 parameters (FL's NumParams is 0): everything is the plugin's saved state (SaveRestoreState 0x645f0,
//   version 1000005), as JSON here (./wavetraveller/state.ts);
// - editor form: SynthPanel 715 x 224;
// - flags Generator | GetNoteInput | NewVoiceParams, DefPoly 0; the plugin applies the voice's pan and volume
//   itself (ComputeLRVol per sample on FinalLevels) and plays Gen_Render from its own voice list;
// - a new instance gets the plugin database state (Wave Traveller.fst): 120 default patches, key 60, no sample.

import type { GenPluginDef } from './../types';
import { defaultWtState, normalizeWtState, patchFromSeed, wtState } from './wavetraveller/state';
import { WT_FACTORY } from './wavetraveller/presets';

export const def: GenPluginDef = {
  id: 'wavetraveller',
  name: 'Wave Traveller',
  category: 'Sampler',
  notes: 'voices',
  // the plugin pans and scales its voices itself (FinalLevels.Pan / Vol, velocity included)
  levels: 'plugin',
  defPoly: 0,
  width: 715,
  height: 224,
  description: 'Spline-controlled scratching',
  params: [],
  state: () => ({ ...defaultWtState() }),
  normalize: (p) => normalizeWtState(p),
  // editor view (not saved by FL): WAVE / VOL page, patch selector octave, snap
  viewState: ['part', 'octave', 'snap'],
  // FL's GetName(FPN_Semitone): the patch name on its key
  keyNames: (params) => {
    const s = wtState(params);
    const out: Record<number, string> = {};
    for (const k of Object.keys(s.patches)) if (s.patches[k].name) out[Number(k)] = s.patches[k].name;
    return out;
  },
  // FL's Presets folder (Default.fst is the database state, no sample)
  presets: [
    ...WT_FACTORY.map((f) => ({
      name: f.name,
      params: {
        sample: '',
        file: f.file,
        key: f.key,
        patches: Object.fromEntries(Object.entries(f.patches).map(([k, v]) => [k, patchFromSeed(v)])),
      },
    })),
  ],
};
