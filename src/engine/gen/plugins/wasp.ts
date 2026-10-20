// Wasp (FL: Wasp): FL 2026's 64-bit dummy, silent (see src/model/gen/plugins/wasp.ts and
// docs/research/gen/wasp.md).

import type { GenModule } from '../types';
import { dummy64 } from './dummy64/shell';

export const gen: GenModule = { id: 'wasp', create: () => dummy64() };
