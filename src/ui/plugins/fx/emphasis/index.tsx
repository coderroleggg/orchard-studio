// Emphasis editor (FL: Emphasis, 740 x 366): rolling display with the control
// sections (Input gain, Enhancement, Routing, Output) over its lower part, the
// GR / output peak / LUFS meters at the right and FL's bottom bar (DC block,
// instant recovery, true peak, oversampling, bypass, delta, level matching,
// visuals toggle and the options menu: LUFS display, display range, low latency).

import type { ReactNode } from 'react';
import { FxPanel, useFxEditor, useFxState, useParam } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { emCeilingGain, emInputGainDb } from '../../../../model/fx/plugins/emphasis';
import type { FxEditorModule } from '../../registry';
import { ActionText, EmKnob, FONT, Meters, ORANGE, ParamCombo, ParamToggle, RANGES, RollingDisplay, SegSwitch } from './widgets';

const W = 740, H = 366;

function Section({ x, w, title, titleW, children }: { x: number; w: number; title: string; titleW: number; children?: ReactNode }) {
  return (
    <>
      <div className="fxk-abs" style={{ left: x, top: 247, width: w, height: 90, background: '#292929', borderRadius: 3 }} />
      <div className="fxk-abs" style={{ left: x, top: 247, width: titleW, height: 16, background: '#1a1a1a', borderRadius: '3px 0 4px 0', color: '#c9c9c9', fontFamily: FONT, fontSize: 13, fontWeight: 500, letterSpacing: '0.09em', lineHeight: '16px', paddingLeft: 4, boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden' }}>{title}</div>
      {children}
    </>
  );
}

function Caption({ cx, children }: { cx: number; children: ReactNode }) {
  return (
    <div className="fxk-abs" style={{ left: cx - 50, top: 318, width: 100, height: 12, textAlign: 'center', color: '#a2a2a2', fontFamily: FONT, fontSize: 11.5, fontWeight: 600, letterSpacing: '0.06em', lineHeight: '12px', pointerEvents: 'none' }}>{children}</div>
  );
}

function optionsItems(slotId: string, lufsMode: number, displayRange: number, lowLatency: boolean): MenuItem[] {
  const set = (label: string, key: string, v: unknown) => A.editFx(slotId, label, (p) => { p[key] = v; });
  return [
    { label: 'Theme', disabled: true },
    { separator: true },
    { label: 'LUFS display', submenu: ['Integrated', 'Short term', 'Momentary'].map((l, i) => ({ label: l, radio: true, checked: lufsMode === i, onClick: () => set('LUFS display', 'lufsMode', i) })) },
    { separator: true },
    { label: 'Display range', submenu: RANGES.map((r, i) => ({ label: ` -${r}dB`, radio: true, checked: displayRange === i, onClick: () => set('Display range', 'displayRange', i) })) },
    { separator: true },
    { label: 'Low latency', checked: lowLatency, onClick: () => set('Low latency', 'lowLatency', !lowLatency) },
  ];
}

function EmphasisEditor() {
  const { slotId } = useFxEditor();
  const lufsMode = useFxState<number>('lufsMode', 1);
  const displayRange = useFxState<number>('displayRange', 1);
  const lowLatency = useFxState<boolean>('lowLatency', false);
  const visuals = useFxState<boolean>('visuals', true);
  const mode = useParam('mode').value;
  const deltaOn = useParam('delta').value >= 0.5;
  const adaptive = mode < 2;
  const range = RANGES[displayRange] ?? 18;
  const gearMenu = (e: React.PointerEvent | React.MouseEvent) => openMenu(e.clientX, e.clientY, optionsItems(slotId, lufsMode, displayRange, lowLatency));

  return (
    <FxPanel width={W} height={H} style={{ background: '#0b0c0b' }}>
      <RollingDisplay x={4} y={4} w={629} h={246} range={range} visible={visuals} />
      <div className="fxk-abs" style={{ left: 4, top: 4, width: 629, height: 246, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6)', pointerEvents: 'none' }} />

      <Section x={3} w={87} title="INPUT GAIN" titleW={68}>
        <EmKnob k="inputGain" x={20} y={279} size={54} text={(v) => emInputGainDb(v).toFixed(1)} />
      </Section>
      <Section x={94} w={282} title="ENHANCEMENT" titleW={92}>
        <ParamCombo k="mode" x={110} y={288} w={75} h={20} style={{ background: '#0e0e0e', borderRadius: 3, color: '#f1f1f1', fontSize: 13, fontWeight: 600 }} />
        <Caption cx={147}>MODE</Caption>
        <EmKnob k="emphasis" x={199} y={275} size={44} auto={adaptive} text={(v) => String(Math.round(v / 100))} />
        <Caption cx={221}>EMPHASIS</Caption>
        <EmKnob k="envOrder" x={257} y={275} size={44} text={(v) => String(Math.round(v))} ringT={(v) => v / 4} />
        <Caption cx={279}>ENVELOPE</Caption>
        <EmKnob k="hardness" x={316} y={275} size={44} steps={10} text={(v) => String(Math.round(v))} />
        <Caption cx={338}>HARDNESS</Caption>
      </Section>
      <Section x={380} w={163} title="ROUTING" titleW={60}>
        <SegSwitch k="channelMode" x={397} y={287} w={70} h={20} />
        <Caption cx={432}>CHANNEL MODE</Caption>
        <EmKnob k="linking" x={485} y={275} size={44} text={(v) => String(Math.round(v / 100))} />
        <Caption cx={507}>LINKING</Caption>
      </Section>
      <Section x={547} w={84} title="OUTPUT" titleW={56}>
        <div style={{ opacity: deltaOn ? 0.45 : 1 }}>
          <EmKnob k="ceiling" x={564} y={279} size={54} text={(v) => { const g = emCeilingGain(v); return g > 0 ? (20 * Math.log10(g)).toFixed(1) : '-inf'; }} />
        </div>
      </Section>

      <Meters range={range} lufsMode={lufsMode} />
      {/* LUFS type button (S >) */}
      <div className="fxk-abs" style={{ left: 711, top: 322, width: 22, height: 11, cursor: 'default' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); openMenu(e.clientX, e.clientY, ['Integrated', 'Short term', 'Momentary'].map((l, i) => ({ label: l, radio: true, checked: lufsMode === i, onClick: () => A.editFx(slotId, 'LUFS display', (p) => { p.lufsMode = i; }) }))); } }}
        onPointerEnter={() => setHint('LUFS display')} onPointerLeave={clearHint} />

      {/* bottom bar */}
      <div className="fxk-abs" style={{ left: 8, top: 344, width: 100, height: 20, lineHeight: '20px', color: ORANGE, fontFamily: FONT, fontSize: 14, fontWeight: 600, letterSpacing: '0.42em', pointerEvents: 'none' }}>EMPHASIS</div>
      {[201, 459, 632].map((x) => <div key={x} className="fxk-abs" style={{ left: x, top: 349, width: 1, height: 12, background: '#4a4a4a' }} />)}
      <ParamToggle k="dcBlock" x={204} y={346} w={53} h={18} label="DC BLOCK" />
      <ParamToggle k="instantRecovery" x={257} y={346} w={98} h={18} label="INSTANT RECOVERY" />
      <ParamToggle k="truePeak" x={358} y={346} w={60} h={18} label="TRUE PEAK" />
      <ParamCombo k="oversampling" x={420} y={346} w={36} h={18} labels={['OFF', '2X', '4X', '8X', '16X']} style={{ color: ORANGE, fontSize: 12, fontWeight: 500 }} arrowColor={ORANGE} />
      <ParamToggle k="bypass" x={466} y={346} w={45} h={18} label="BYPASS" />
      <ParamToggle k="delta" x={509} y={346} w={38} h={18} label="DELTA" />
      <ParamToggle k="levelMatch" x={546} y={346} w={84} h={18} label="LEVEL MATCHING" />
      <ActionText x={702} y={345} w={18} h={18} active={!visuals} hint="Toggle visuals visibility"
        onClick={() => A.editFx(slotId, 'Visuals', (p) => { p.visuals = !visuals; })}
        label={<svg width={14} height={10} viewBox="0 0 14 10" style={{ marginTop: 4 }}><path d="M1 5 Q7 -1 13 5 Q7 11 1 5 Z" fill="none" stroke="currentColor" strokeWidth={1.3} /><circle cx={7} cy={5} r={2} fill="currentColor" /></svg>} />
      <ActionText x={719} y={345} w={18} h={18} hint="Options" onClick={(e) => gearMenu(e)}
        label={<svg width={14} height={14} viewBox="0 0 16 16" style={{ marginTop: 2 }}><path d="M8 5.2 A2.8 2.8 0 1 0 8 10.8 A2.8 2.8 0 1 0 8 5.2 Z M6.9 1 H9.1 L9.5 3 L11 3.7 L12.8 2.6 L14.4 4.2 L13.3 6 L14 7.5 L16 7.9 V10.1 L14 10.5 L13.3 12 L14.4 13.8 L12.8 15.4 L11 14.3 L9.5 15 L9.1 17 H6.9" fill="none" stroke="currentColor" strokeWidth={1.2} transform="translate(0 -0.5) scale(0.94)" /></svg>} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'emphasis',
  Editor: EmphasisEditor,
  menu: (slotId) => {
    const p = A.findFx(store.project, slotId)?.fx.params ?? {};
    const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
    return optionsItems(slotId, num('lufsMode', 1), num('displayRange', 1), p.lowLatency === true);
  },
};
