// Wasp (FL: Wasp): FL 2026 ships a 64-bit dummy that renders silence (docs/research/gen/wasp.md).
import { dummy64Suite, stubWindow } from './dummy64';

stubWindow();
const { editor } = await import('../../src/ui/plugins/gen/wasp');
dummy64Suite({ id: 'wasp', params: 41, defPoly: 4, editor });
