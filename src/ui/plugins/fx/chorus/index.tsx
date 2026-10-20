// Chorus editor (FL: Fruity Chorus, 500 x 205): FL's TTestPlug grid of twelve
// knob bevels with value texts, in the plugin's light cyan accent.

import type { FxEditorModule } from '../../registry';
import { TestPlugEditor, cell } from './TestPlugEditor';

const CELLS = [
  cell('delay', 'DELAY', 5, 5, 7, 10, 60, 31),
  cell('depth', 'DEPTH', 170, 5, 172, 10, 225, 31),
  cell('stereo', 'STEREO', 335, 5, 337, 10, 390, 31),
  cell('lfo1Freq', 'LFO 1 FREQ', 5, 55, 7, 58, 60, 81),
  cell('lfo2Freq', 'LFO 2 FREQ', 170, 55, 172, 58, 225, 81),
  cell('lfo3Freq', 'LFO 3 FREQ', 335, 55, 337, 58, 390, 81),
  cell('lfo1Wave', 'LFO 1 WAVE', 5, 105, 7, 108, 60, 131),
  cell('lfo2Wave', 'LFO 2 WAVE', 170, 105, 172, 108, 225, 131),
  cell('lfo3Wave', 'LFO 3 WAVE', 335, 105, 337, 108, 390, 131),
  cell('crossType', 'CROSS TYPE', 5, 155, 7, 158, 60, 181),
  cell('crossCutoff', 'CROSS CUTOFF', 170, 155, 172, 158, 225, 181),
  cell('wetOnly', 'WET ONLY', 335, 155, 337, 158, 390, 181),
];

function ChorusEditor() {
  return <TestPlugEditor width={500} height={205} cells={CELLS} color="#d4ffff" textColor="#dcffff" />;
}

export const editor: FxEditorModule = { id: 'chorus', Editor: ChorusEditor };
