// FL Slayer (FL: FL Slayer): FL 2026's 64-bit dummy, silent (see src/model/gen/plugins/flslayer.ts
// and docs/research/gen/flslayer.md).

import type { GenModule } from '../types';
import { dummy64 } from './dummy64/shell';

export const gen: GenModule = { id: 'flslayer', create: () => dummy64() };
