// GMS (FL: GMS, Groove Machine Synth): Image-Line's three-oscillator wavetable synthesizer
// with unison, ladder filter, envelopes, LFOs and ten performance effects, a port of FL
// 2026's plugin by static analysis (see ./gms/ and docs/research/gen/gms.md).

import type { GenModule } from '../types';
import { GmsPlugin } from './gms/plugin';

export const gen: GenModule = { id: 'gms', create: (sr, bs, env) => new GmsPlugin(sr, bs, env) };
