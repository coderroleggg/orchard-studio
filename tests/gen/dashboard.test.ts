// Dashboard (FL: Dashboard): FL 2026's 64-bit dummy, silent (see src/model/gen/plugins/dashboard.ts
// and docs/research/gen/dashboard.md).
import { dummy64Suite, stubWindow } from './dummy64';

stubWindow();
const { editor } = await import('../../src/ui/plugins/gen/dashboard');
dummy64Suite({ id: 'dashboard', params: 257, defPoly: 0, editor });
