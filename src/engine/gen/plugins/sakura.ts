// Sakura (FL: Sakura): Image-Line's string physical-modelling instrument, a port of FL 2026's
// engine by static analysis (see ./sakura/ and docs/research/gen/sakura.md).

import type { GenModule } from '../types';
import { SkPlugin } from './sakura/plugin';

export const gen: GenModule = { id: 'sakura', create: (sr, bs, env) => new SkPlugin(sr, bs, env) };
