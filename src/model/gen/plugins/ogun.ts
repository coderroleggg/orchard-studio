// Ogun (FL: Ogun, Plugin database > Generators > Synth special and Drum): Didier Dambrin's additive synthesizer for
// "exceptionally rich metallic and shimmering timbres": up to 32 767 harmonics per voice, weighted by two seeded random
// spectra (timbre seeds 1 and 2) and shaped by harmonic mapping curves (forced harmonics, impulse, decay and release
// EQ), synthesised by inverse FFTs and morphed over time, then unison, a filter, articulators for pitch / volume /
// filter / timbre, and an effects chain (3-band EQ, chorus, delay, reverb). A port of FL's plugin
// (docs/research/gen/ogun.md).
//
// From FL 2026's Ogun_x64.dylib (arm64 slice): the 89 automatable parameters (params.ts: names and ranges from the test
// host, reset values from the editor form, value texts of the plugin's GetName port in texts.ts), the state format
// (SaveRestoreState 0x68750, types.ts), the 229 factory presets (loaded and re-saved by FL itself, presets.ts, parameter
// level data: the analysed spectra of resynthesis presets are FL content, left out) and the plugin database entry a new
// instance has (base.ts).

import type { GenPluginDef } from '../types';
import { OGUN_PARAMS } from './ogun/params';
import { OG_PRESET_NAMES, defaultView, freshState, normalizeOgun } from './ogun/state';

export const def: GenPluginDef = {
  id: 'ogun',
  name: 'Ogun',
  category: 'Synth special',
  alsoIn: ['Drum'],
  notes: 'voices',
  // the plugin applies the voice's volume (with its own handling of the note velocity) and panning itself
  levels: 'plugin',
  width: 560,
  height: 640,
  description: 'A metallic timbre generator (additive synthesizer)',
  params: OGUN_PARAMS,
  viewState: ['view'],
  state: () => ({ ...freshState(), view: defaultView() }),
  normalize: (p) => normalizeOgun(p),
  presets: OG_PRESET_NAMES.map((name, i) => ({ name, params: { __og: i } })),
};
