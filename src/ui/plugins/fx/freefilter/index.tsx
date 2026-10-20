// Free Filter editor (FL: Fruity Free Filter, 419 x 105) at the coordinates of
// FL's form: TYPE / FREQ / GAIN sections show their value text under the
// caption, Q has a value bar, plus the CENTER switch; pink accent (FL 2026
// thumbnail). FL's logo glyph is replaced by a generic filter-curve mark.

import { FxPanel, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { FL, FlKnob, QLabel, SwitchSel, VBevel, ValueBar } from '../filter/vector';

const PINK = '#f4c6f0';

function ValueText({ x, y, k }: { x: number; y: number; k: string }) {
  const p = useParam(k);
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: 102, height: 14, lineHeight: '14px', color: PINK, fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', pointerEvents: 'none', paddingLeft: 2,
    }}>{p.control.format ? p.control.format(p.value) : String(p.value)}</div>
  );
}

function TextSection({ x, y, k, caption, bipolar }: { x: number; y: number; k: string; caption: string; bipolar?: boolean }) {
  return (
    <>
      <VBevel x={x} y={y} w={160} h={45} />
      <FlKnob k={k} x={x + 2} y={y + 3} w={46} h={40} color={PINK} bipolar={bipolar} />
      <QLabel x={x + 54} y={y} w={106} h={16}>{caption}</QLabel>
      <ValueText x={x + 55} y={y + 26} k={k} />
    </>
  );
}

function FreeFilterEditor() {
  return (
    <FxPanel width={419} height={105} style={{ background: FL.panel }}>
      <TextSection x={5} y={5} k="type" caption="TYPE" />
      <TextSection x={170} y={5} k="freq" caption="FREQ" />
      <VBevel x={5} y={55} w={160} h={45} />
      <FlKnob k="q" x={7} y={58} w={46} h={40} color={PINK} />
      <QLabel x={59} y={55} w={106} h={16}>Q</QLabel>
      <ValueBar k="q" x={56} y={84} w={108} h={14} color={PINK} />
      <TextSection x={170} y={55} k="gain" caption="GAIN" bipolar />
      <VBevel x={336} y={5} w={77} h={45} />
      <QLabel x={353} y={5} w={60} h={16}>CENTER</QLabel>
      <SwitchSel k="center" x={340} y={23} w={41} h={26} pillW={12} />
      <svg className="fxk-abs" style={{ left: 350, top: 58, pointerEvents: 'none' }} width={52} height={38} viewBox="0 0 52 38">
        <path d="M3 30 L16 30 C24 30 26 8 33 8 C38 8 40 30 49 30" fill="none" stroke="#5f686e" strokeWidth={3} strokeLinecap="round" />
      </svg>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'freefilter', Editor: FreeFilterEditor };
