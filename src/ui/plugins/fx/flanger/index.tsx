// Flanger editor (FL: Fruity Flanger, 500 x 205): FL's TTestPlug grid of
// twelve knob bevels with value texts, in the plugin's cream accent.

import type { FxEditorModule } from '../../registry';
import { TestPlugEditor, cell } from '../chorus/TestPlugEditor';

const CELLS = [
  cell('delay', 'DELAY', 5, 5, 7, 8, 60, 31),
  cell('depth', 'DEPTH', 170, 5, 172, 8, 225, 31),
  cell('rate', 'RATE', 335, 5, 337, 8, 390, 31),
  cell('phase', 'PHASE', 5, 55, 7, 58, 60, 81),
  cell('damp', 'DAMP', 170, 55, 172, 58, 225, 81),
  cell('shape', 'SHAPE', 335, 55, 337, 58, 390, 81),
  cell('feed', 'FEED', 5, 105, 7, 108, 60, 131),
  cell('invFeedback', 'INV FEEDBACK', 170, 105, 172, 108, 225, 131),
  cell('invWet', 'INV WET', 335, 105, 337, 108, 390, 131),
  cell('dry', 'DRY', 5, 155, 7, 158, 60, 181),
  cell('wet', 'WET', 170, 155, 172, 158, 225, 181),
  cell('cross', 'CROSS', 335, 155, 337, 158, 390, 181),
];

function FlangerEditor() {
  return <TestPlugEditor width={500} height={205} cells={CELLS} color="#fff8d4" textColor="#ffffdc" />;
}

export const editor: FxEditorModule = { id: 'flanger', Editor: FlangerEditor };
