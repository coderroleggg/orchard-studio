// Center editor (FL: Fruity Center, 170 x 55) at FL's form coordinates: the
// STATUS bevel and header with the On / Off switch (TSwitchSelector).

import { FxPanel } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { LEGACY, LegacyBevel, LegacyHeader, LegacySwitch } from '../mute2/legacy';

function CenterEditor() {
  return (
    <FxPanel width={170} height={55} style={{ background: LEGACY.panel }}>
      <LegacyBevel x={5} y={5} />
      <LegacyHeader x={59} y={5}>STATUS</LegacyHeader>
      <LegacySwitch k="status" x={11} y={14} w={41} h={28} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'center', Editor: CenterEditor };
