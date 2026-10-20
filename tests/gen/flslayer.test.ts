// FL Slayer (FL: FL Slayer): FL 2026 ships a 64-bit dummy that renders silence (docs/research/gen/flslayer.md).
import { dummy64Suite, stubWindow } from './dummy64';

stubWindow();
const { editor } = await import('../../src/ui/plugins/gen/flslayer');
dummy64Suite({ id: 'flslayer', params: 29, defPoly: 0, editor });
