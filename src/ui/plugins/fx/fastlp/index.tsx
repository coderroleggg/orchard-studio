// Fast LP editor (FL: Fruity Fast LP, 335 x 55): two Fruity Filter style wheel
// sections (CUTOFF, RESONANCE) at the coordinates of FL's form, with Fast LP's
// pink accent (FL 2026 thumbnail).

import { FxPanel } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { FL, WheelSection } from '../filter/vector';

const PINK = '#f4c6f0';

function FastLPEditor() {
  return (
    <FxPanel width={335} height={55} style={{ background: FL.panel }}>
      <WheelSection x={5} y={5} k="cutoff" caption="CUTOFF" color={PINK} />
      <WheelSection x={170} y={5} k="res" caption="RESONANCE" color={PINK} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'fastlp', Editor: FastLPEditor };
