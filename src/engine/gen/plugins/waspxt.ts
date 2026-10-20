// Wasp XT (FL: Wasp XT): FL 2026's 64-bit dummy, silent (see src/model/gen/plugins/waspxt.ts
// and docs/research/gen/waspxt.md).

import type { GenModule } from '../types';
import { dummy64 } from './dummy64/shell';

export const gen: GenModule = { id: 'waspxt', create: () => dummy64() };
