// Filter editor (FL: Fruity Filter, 500 x 105): five wheel sections (wheel,
// rounded caption and a value slider that mirrors the wheel) plus the X 2 and
// CENTER switches, at the coordinates of FL's form.

import { FxPanel } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { FL, FlKnob, QLabel, SwitchSel, VBevel, ValueBar } from './vector';

function Section({ x, y, k, caption }: { x: number; y: number; k: string; caption: string }) {
  return (
    <>
      <VBevel x={x} y={y} w={160} h={45} />
      <FlKnob k={k} x={x + 2} y={y + 3} w={46} h={40} color={FL.green} />
      <QLabel x={x + 54} y={y} w={106} h={16}>{caption}</QLabel>
      <ValueBar k={k} x={x + 51} y={y + 29} w={108} h={14} />
    </>
  );
}

function SwitchSection({ x, y, k, caption }: { x: number; y: number; k: string; caption: string }) {
  return (
    <>
      <VBevel x={x} y={y} w={77} h={45} />
      <QLabel x={x + 17} y={y} w={60} h={16}>{caption}</QLabel>
      <SwitchSel k={k} x={x + 4} y={y + 18} w={41} h={26} pillW={12} />
    </>
  );
}

function FilterEditor() {
  return (
    <FxPanel width={500} height={105} style={{ background: FL.panel }}>
      <Section x={5} y={5} k="cutoff" caption="CUTOFF FREQ" />
      <Section x={170} y={5} k="res" caption="RESONANCE" />
      <Section x={335} y={5} k="lp" caption="LOW PASS" />
      <Section x={5} y={55} k="bp" caption="BAND PASS" />
      <Section x={170} y={55} k="hp" caption="HIGH PASS" />
      <SwitchSection x={335} y={55} k="x2" caption="X 2" />
      <SwitchSection x={417} y={55} k="center" caption="CENTER" />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'filter', Editor: FilterEditor };
