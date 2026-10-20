// Kepler (FL: Kepler, Plugin database > Generators > Synth classic): FL's Juno-6 emulation. The DSP (the
// 8-voice DCO / ladder filter engine shared with Kepler Exo, chorus, arpeggiator) is decoded from FL 2026's
// engine library; see docs/research/gen/kepler.md and the modules in ./kepler/.

import type { GenModule } from '../types';
import { KeplerPlugin } from './kepler/plugin';

export const gen: GenModule = {
  id: 'kepler',
  create: (sampleRate, blockSize, env) => new KeplerPlugin(sampleRate, blockSize, false, env),
};
