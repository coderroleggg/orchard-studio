// Kepler Exo (FL: Kepler Exo, Plugin database > Generators > Synth classic): the extended Kepler with two
// DCOs, two LFOs and envelopes, a modulation matrix and effects. The DSP is decoded from FL 2026's engine
// library (the same engine as Kepler); see docs/research/gen/kepler.md and the modules in ./kepler/.

import type { GenModule } from '../types';
import { KeplerPlugin } from './kepler/plugin';

export const gen: GenModule = {
  id: 'keplerexo',
  create: (sampleRate, blockSize, env) => new KeplerPlugin(sampleRate, blockSize, true, env),
};
