// Transistor Bass (FL: Transistor Bass, Plugin database > Generators > Synth
// classic): FL's TB-303 emulation with distortion, delay, reverb and a step
// sequencer. The DSP (both engines, oversampling, filters, envelopes,
// accent / slide circuits, distortion, parameter smoother, delay, sequencer)
// is decoded from FL 2026's engine library; see docs/research/gen/transistorbass.md
// and the modules in ./transistorbass/.

import type { GenModule } from '../types';
import { TbPlugin } from './transistorbass/plugin';

export const gen: GenModule = {
  id: 'transistorbass',
  create: (sampleRate, blockSize) => new TbPlugin(sampleRate, blockSize),
};
