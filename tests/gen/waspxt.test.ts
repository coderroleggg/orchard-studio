// Wasp XT (FL: Wasp XT): FL 2026 ships a 64-bit dummy that renders silence (docs/research/gen/waspxt.md).
import { dummy64Suite, stubWindow } from './dummy64';

stubWindow();
const { editor } = await import('../../src/ui/plugins/gen/waspxt');
dummy64Suite({ id: 'waspxt', params: 56, defPoly: 4, editor });
