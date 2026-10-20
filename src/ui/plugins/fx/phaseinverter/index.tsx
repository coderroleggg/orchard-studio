// Phase Inverter editor (FL: Fruity Phase Inverter, 170 x 55) at FL's form
// coordinates: one STATE bevel with the wheel (lime colour scheme) and the
// state name ("Off", "Left", "Right"; FL 2026 shows the plain name, the
// "State: " prefix of older versions only appears in the hint bar).

import { FxPanel } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { LEGACY, LegacySection } from '../mute2/legacy';

function PhaseInverterEditor() {
  return (
    <FxPanel width={170} height={55} style={{ background: LEGACY.panel }}>
      <LegacySection k="state" x={5} title="STATE" color={LEGACY.lime} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'phaseinverter', Editor: PhaseInverterEditor };
