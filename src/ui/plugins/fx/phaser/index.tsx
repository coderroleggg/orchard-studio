// Phaser editor (FL: Fruity Phaser, 500 x 155): FL's TTestPlug grid of nine
// knob bevels with value texts, in the plugin's light green accent.

import type { FxEditorModule } from '../../registry';
import { TestPlugEditor, cell } from '../chorus/TestPlugEditor';

const CELLS = [
  cell('sweep', 'SWEEP FREQ.', 5, 5, 7, 8, 60, 31),
  cell('minDepth', 'MIN DEPTH', 170, 5, 172, 8, 225, 31),
  cell('maxDepth', 'MAX DEPTH', 335, 5, 338, 8, 395, 31),
  cell('range', 'FREQ. RANGE', 5, 55, 7, 58, 60, 81),
  cell('stereo', 'STEREO', 170, 55, 172, 58, 225, 81),
  // FL's label reads "Nr. stages: 8" (the parameter text alone is "8")
  cell('stages', 'NR. STAGES', 335, 55, 338, 58, 395, 81, (v) => `Nr. stages: ${Math.round(v) + 1}`),
  cell('feedback', 'FEEDBACK', 5, 105, 7, 108, 60, 131),
  cell('dryWet', 'DRY-WET', 170, 105, 172, 108, 225, 131),
  cell('gain', 'OUT GAIN', 335, 105, 338, 108, 395, 131),
];

function PhaserEditor() {
  return <TestPlugEditor width={500} height={155} cells={CELLS} color="#e6ffd4" textColor="#f0ffdc" />;
}

export const editor: FxEditorModule = { id: 'phaser', Editor: PhaserEditor };
