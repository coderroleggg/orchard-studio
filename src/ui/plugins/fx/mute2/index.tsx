// Mute 2 editor (FL: Fruity Mute 2, 335 x 55) at FL's form coordinates:
// MUTE and CHANNEL bevels, each with its wheel, header and value caption
// ("On" / "Off", "L" / "L + R" / "R").

import { FxPanel } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { LEGACY, LegacySection } from './legacy';

function Mute2Editor() {
  return (
    <FxPanel width={335} height={55} style={{ background: LEGACY.panel }}>
      <LegacySection k="mute" x={5} title="MUTE" color={LEGACY.pink} />
      <LegacySection k="channel" x={170} title="CHANNEL" color={LEGACY.pink} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'mute2', Editor: Mute2Editor };
