// Autogun (FL: Autogun, Plugin database > Generators > Synth special): "a universe of sounds waiting to be discovered": Ogun's
// engine playing one of 4 294 967 296 patches, each generated from its preset number (the plugin's random preset generator is
// Ogun's, so a number can be shared between the two), through a Soundgoodizer ("magic dust"). A port of FL's plugin
// (docs/research/gen/autogun.md); the engine is Ogun's (src/engine/gen/plugins/autogun.ts imports it).
//
// From FL 2026's Autogun_x64.dylib (arm64 slice): the parameter list (one: the master level, shown 0 - 200 %), the state
// (SaveRestoreState 0x65800: Ogun's with the preset counter) and what a new instance has (the constructor 0x677a0: a random
// preset, master level 256, magic dust 430), here as the small state of state.ts.

import type { GenPluginDef } from '../types';
import { AUTOGUN_PARAMS, freshState, normalizeAutogun } from './autogun/state';

export const def: GenPluginDef = {
  id: 'autogun',
  name: 'Autogun',
  category: 'Synth special',
  notes: 'voices',
  // the plugin applies the voice's volume (with its own handling of the note velocity) and panning itself, as Ogun does
  levels: 'plugin',
  width: 282,
  height: 379,
  description: 'A metallic timbre generator',
  params: AUTOGUN_PARAMS,
  state: () => freshState(),
  normalize: (p) => normalizeAutogun(p),
};
