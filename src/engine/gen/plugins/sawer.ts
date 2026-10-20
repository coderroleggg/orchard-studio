// Sawer (FL: Sawer): Image-Line's analog-modelled saw synthesizer, a port of FL 2026's
// engine by static analysis (see ./sawer/ and docs/research/gen/sawer.md).

import type { GenModule } from '../types';
import { SwPlugin } from './sawer/plugin';

export const gen: GenModule = { id: 'sawer', create: (sr, bs, env) => new SwPlugin(sr, bs, env) };
