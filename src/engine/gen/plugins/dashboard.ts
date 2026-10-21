// Dashboard (FL: Dashboard): FL 2026's 64-bit dummy, silent (see src/model/gen/plugins/dashboard.ts
// and docs/research/gen/dashboard.md).

import type { GenModule } from '../types';
import { dummy64 } from './dummy64/shell';

export const gen: GenModule = { id: 'dashboard', create: () => dummy64() };
