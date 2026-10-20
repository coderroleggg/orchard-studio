// Bass Boost editor (FL: Fruity Bass Boost, 335 x 55) at FL's form
// coordinates: FREQ bevel (wheel and "60 Hz" caption) and AMOUNT bevel
// (wheel and the AmountSlider, a read-only bar mirroring the amount: in
// FL it has no parameter and no change handler).

import { FxPanel, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { LEGACY, LegacySection } from '../mute2/legacy';

/**
 * TVectorSlider (horizontal, 221,34 108 x 14) drawn as FL's thin bar: a 1 px
 * (at 1.5x) dark frame around a 4 px track, filled from the left.
 */
function AmountBar() {
  const p = useParam('amount');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min)));
  const f = 2 / 3; // frame: one device pixel at FL's 1.5x
  const w = 97.3, h = 5.33;
  return (
    <div className="fxk-abs" style={{ left: 226.7, top: 38, width: w, height: h, background: '#353b40', pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: f, top: f, width: w - 2 * f, height: h - 2 * f, background: '#41484c' }} />
      <div style={{ position: 'absolute', left: f, top: f, width: (w - 2 * f) * t, height: h - 2 * f, background: '#ffd4d8' }} />
    </div>
  );
}

function BassBoostEditor() {
  return (
    <FxPanel width={335} height={55} style={{ background: LEGACY.panel }}>
      <LegacySection k="freq" x={5} title="FREQ" color={LEGACY.pink} />
      <LegacySection k="amount" x={170} title="AMOUNT" color={LEGACY.pink} value={<AmountBar />} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'bassboost', Editor: BassBoostEditor };
