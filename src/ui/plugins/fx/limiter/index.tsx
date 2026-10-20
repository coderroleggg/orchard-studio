// Limiter editor (FL: Fruity Limiter, 626 x 300), at FL's form coordinates:
// scrolling analysis display with its display buttons and speed slider, the
// LOUDNESS / ENVELOPE / NOISE GATE sections, the LIMIT / COMP target selector
// (CEIL, ATT, REL, SUSTAIN and two CURVE spinners for the limiter; THRES, KNEE,
// RATIO, ATT, REL, SUSTAIN, CURVE and SIDECHAIN for the compressor), the A/B
// spare-state buttons and the Options menu (0.2 dB limiter safety).

import { useRef } from 'react';
import { FxPanel, useFxEditor, useFxState, useSidechainInput } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useControl, type ControlProps } from '../../../widgets/control';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { LIMITER_PARAMS, NOISE_THRES_RESET } from '../../../../model/fx/plugins/limiter';
import { Knob, RoundButton, Spinner, SpinnerControl, TabSel, Txt } from './widgets';
import { LimiterDisplay } from './display';

const C_GAIN = '#6543aa';
const C_SAT = '#5e4849';
const C_CEIL = '#52952e';
const C_COMP = '#38a9bf';
const C_ENV = '#7d908c';
const C_GATE = '#53503f';
const LABEL = '#c2d0d2';
const LINE = '#a3b2b8';

/** Parameter keys stored in the A/B spare state. */
const KEYS = LIMITER_PARAMS.map((p) => p.key);

function pickParams(p: Record<string, unknown>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const q of LIMITER_PARAMS) o[q.key] = typeof p[q.key] === 'number' ? (p[q.key] as number) : q.def;
  return o;
}

function setUi(slotId: string, label: string, recipe: (p: Record<string, unknown>) => void): void {
  A.setFxStateNoHistory(slotId, label, recipe as never);
}

/** Options menu items (the editor's menu button and the plugin window menu). */
function optionItems(slotId: string): MenuItem[] {
  const loc = A.findFx(store.project, slotId);
  const safety = loc ? (loc.fx.params as Record<string, unknown>).safety !== false : true;
  return [
    {
      label: '0.2 dB limiter safety', checked: safety,
      onClick: () => A.editFx(slotId, '0.2 dB limiter safety', (p) => { p.safety = !safety; }),
    },
    { separator: true },
    { label: 'About', disabled: true, hint: 'Limiter: compressor, limiter, noise gate and saturation' },
  ];
}


function SidechainSelect({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const sc = useSidechainInput();
  return <SpinnerControl x={x} y={y} w={w} h={h} control={sc.control} text={sc.text} onContextMenu={sc.onContextMenu} hint="Sidechain input number" />;
}

/** One of the display buttons (TQuickBtn with a coloured glyph); dimmed when off. */
function VisButton({ x, y, w, h, on, hint, onClick, children }: { x: number; y: number; w: number; h: number; on: boolean; hint: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', opacity: on ? 1 : 0.28 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>{children}</svg>
    </div>
  );
}

/** Scrolling speed slider (TVectorSlider, 0..100, up = faster). */
function SpeedSlider({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const speed = Number(useFxState<number>('speed', 50));
  const control: ControlProps = {
    value: speed, min: 0, max: 100, defaultValue: 50, step: 1, label: 'Scrolling speed',
    format: (v) => `${Math.round(v)}%`,
    onChange: (v) => setUi(slotId, 'Scrolling speed', (p) => { p.speed = v; }),
  };
  const hnd = useControl({ travel: 52, ...control }, 'vertical');
  // FL draws the cap 20 px below the panel top at 50 (measured); 34 px of travel
  const capY = 3 + (1 - speed / 100) * 34;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, borderRadius: 4, background: '#383838', touchAction: 'none' }} {...hnd}>
      <div style={{ position: 'absolute', left: w / 2, top: 7, width: 2, height: h - 14, background: '#454545', borderRadius: 1 }} />
      <div style={{ position: 'absolute', left: 3.8, top: capY + 2.5, width: 15.5, height: 9, background: 'rgba(0,0,0,0.35)', borderRadius: 1 }} />
      <div style={{
        position: 'absolute', left: 3.8, top: capY, width: 15.5, height: 9, borderRadius: 1,
        background: 'linear-gradient(180deg, #c3d0d3 0%, #9aa9ad 38%, #8a989c 45%, #3a474d 52%, #4b5a60 80%, #5e6d72 100%)',
      }} />
    </div>
  );
}

function LimiterEditor() {
  const { slotId } = useFxEditor();
  const tab = useFxState<number>('tab', 0) === 1 ? 1 : 0;
  const showIn = useFxState<boolean>('showIn', true) !== false;
  const showOut = useFxState<boolean>('showOut', true) !== false;
  const showEnv = useFxState<boolean>('showEnv', true) !== false;
  const showLv = useFxState<boolean>('showLevels', true) !== false;
  const curveRef = useRef(false);
  const onCompDrag = (a: boolean) => { curveRef.current = a; };
  const toggle = (key: string, label: string, cur: boolean) => setUi(slotId, label, (p) => { p[key] = !cur; });

  const store_ = () => A.editFx(slotId, 'Store in spare state', (p) => { p.spare = pickParams(p as Record<string, unknown>); });
  const flip = () => A.editFx(slotId, 'Flip with spare state', (p) => {
    const cur = pickParams(p as Record<string, unknown>);
    const sp = (p.spare && typeof p.spare === 'object' ? p.spare : {}) as Record<string, number>;
    for (const k of KEYS) if (typeof sp[k] === 'number') p[k] = sp[k];
    p.spare = cur;
  });

  const knobLabel = (cx: number, text: string) => <Txt x={cx - 30} y={233} w={60} h={15} color={LABEL}>{text}</Txt>;

  return (
    <FxPanel width={626} height={300} style={{ background: '#3c444a' }}>
      {/* ---------- display area ---------- */}
      <div className="fxk-abs" style={{ left: 4, top: 3, width: 21, height: 83, background: '#383838', borderRadius: 4 }} />
      <div className="fxk-abs" style={{ left: 5, top: 5, width: 18, height: 18, cursor: 'default' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); openMenu(e.clientX, e.clientY, optionItems(slotId)); } }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
        <svg width={18} height={18} viewBox="0 0 18 18" style={{ display: 'block' }}><path d="M4.9 8.6 L13.1 8.6 L9 12.9 Z" fill="#edfbff" /></svg>
      </div>
      <VisButton x={5} y={28} w={18} h={13} on={showIn} hint="Show input peaks" onClick={() => toggle('showIn', 'Show input peaks', showIn)}>
        <rect x={8.4} y={1.9} width={1.6} height={9.6} fill="#da92ff" />
      </VisButton>
      <VisButton x={5} y={41} w={18} h={13} on={showOut} hint="Show output peaks" onClick={() => toggle('showOut', 'Show output peaks', showOut)}>
        <circle cx={9.2} cy={6.5} r={3.3} fill="none" stroke="#c3ff77" strokeWidth={2.1} />
      </VisButton>
      <VisButton x={5} y={54} w={18} h={13} on={showEnv} hint="Show analysis & gain envelopes" onClick={() => toggle('showEnv', 'Show analysis & gain envelopes', showEnv)}>
        <path d="M5.4 10.4 C7.6 10.6 8.6 9.6 9.6 7.6 C10.6 5.6 11.4 4.2 13 3.8" fill="none" stroke="#ffffff" strokeWidth={2} strokeLinecap="round" />
      </VisButton>
      <VisButton x={5} y={69} w={18} h={13} on={showLv} hint="Show level markers" onClick={() => toggle('showLevels', 'Show level markers', showLv)}>
        <rect x={5.6} y={3} width={7.4} height={1.5} fill="#da92ff" />
        <rect x={5.6} y={6.8} width={7.4} height={1.5} fill="#da92ff" />
      </VisButton>
      <SpeedSlider x={4} y={88} w={21} h={65} />
      <LimiterDisplay x={29} y={0} w={597} h={160} curveRef={curveRef} />

      {/* ---------- section headers ---------- */}
      <div className="fxk-abs" style={{ left: 284, top: 161, width: 1, height: 15, background: '#778186' }} />
      <div className="fxk-abs" style={{ left: 462, top: 161, width: 1, height: 15, background: '#778186' }} />
      <Txt x={-24} y={160} w={307} h={18} size={12.5} color="#9eafb6" style={{ fontFamily: 'var(--font-ui)', fontWeight: 600, letterSpacing: '0.01em' }}>LOUDNESS</Txt>
      <Txt x={284} y={160} w={177} h={18} size={12.5} color="#9eafb6" style={{ fontFamily: 'var(--font-ui)', fontWeight: 600, letterSpacing: '0.01em' }}>ENVELOPE</Txt>
      <Txt x={462} y={160} w={164} h={18} size={12.5} color="#9eafb6" style={{ fontFamily: 'var(--font-ui)', fontWeight: 600, letterSpacing: '0.01em' }}>NOISE GATE</Txt>

      {/* ---------- settings ---------- */}
      <div className="fxk-abs" style={{
        left: 0, top: 176, width: 626, height: 124,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0) 62%, rgba(0,0,0,0.09) 100%), linear-gradient(90deg, #4e575b 0px, #5e686d 114px, #6d797f 461px, #565f64 626px)',
      }} />
      <div className="fxk-abs" style={{
        left: 114, top: 179, width: 347, height: 117, borderRadius: 5, overflow: 'hidden',
        background: 'linear-gradient(90deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.02) 100%), linear-gradient(180deg, #4a555c 0%, #546068 60%, #4e5960 100%)',
      }} />

      {/* LOUDNESS */}
      <Knob k="gain" x={8} y={184} color={C_GAIN} />
      {knobLabel(31, 'GAIN')}
      <Knob k="sat" x={62} y={184} color={C_SAT} />
      {knobLabel(85, 'SAT')}
      {tab === 0 ? (
        <>
          <Knob k="ceil" x={122} y={184} color={C_CEIL} />
          {knobLabel(145, 'CEIL')}
        </>
      ) : (
        <>
          <Knob k="cThres" x={122} y={184} color={C_COMP} onDrag={onCompDrag} />
          {knobLabel(145, 'THRES')}
          <Knob k="cKnee" x={176} y={184} color={C_COMP} onDrag={onCompDrag} />
          {knobLabel(199, 'KNEE')}
          <Knob k="cRatio" x={230} y={184} color={C_COMP} onDrag={onCompDrag} />
          {knobLabel(253, 'RATIO')}
        </>
      )}

      {/* ENVELOPE */}
      <Knob k={tab === 0 ? 'att' : 'cAtt'} x={290} y={184} color={C_ENV} />
      {knobLabel(313, 'ATT')}
      <Knob k={tab === 0 ? 'rel' : 'cRel'} x={346} y={184} color={C_ENV} />
      {knobLabel(369, 'REL')}
      <Knob k={tab === 0 ? 'sustain' : 'cSustain'} x={406} y={184} color={C_ENV} />
      {knobLabel(429, 'SUSTAIN')}
      <Txt x={283} y={259} w={60} h={15} color={LABEL}>CURVE</Txt>
      {tab === 0 ? (
        <>
          <div className="fxk-abs" style={{ left: 312.5, top: 247, width: 1, height: 10, background: LINE }} />
          <div className="fxk-abs" style={{ left: 368.5, top: 247, width: 1, height: 10, background: LINE }} />
          <Txt x={339} y={259} w={60} h={15} color={LABEL}>CURVE</Txt>
          <Spinner k="attCurve" x={300} y={272} />
          <Spinner k="relCurve" x={356} y={272} />
        </>
      ) : (
        <>
          <div className="fxk-abs" style={{ left: 312.5, top: 247, width: 1, height: 10, background: LINE }} />
          <div className="fxk-abs" style={{ left: 312.5, top: 251, width: 57, height: 1, background: LINE }} />
          <div className="fxk-abs" style={{ left: 368.5, top: 247, width: 1, height: 5, background: LINE }} />
          <Txt x={339} y={259} w={60} h={15} color={LABEL}>SIDECHAIN</Txt>
          <Spinner k="cCurve" x={300} y={272} />
          <SidechainSelect x={351} y={272} w={37} h={21} />
        </>
      )}
      <TabSel x={114} y={276} w={83} h={20} options={['LIMIT', 'COMP']} split={[40, 43]} value={tab} hint="Target"
        onChange={(i) => setUi(slotId, 'Target', (p) => { p.tab = i; })} />

      {/* NOISE GATE */}
      <Knob k="nRel" x={466} y={184} color={C_GATE} />
      {knobLabel(489, 'REL')}
      <Knob k="nGain" x={520} y={184} color={C_GATE} />
      {knobLabel(543, 'GAIN')}
      <Knob k="nThres" x={574} y={184} color={C_GATE} resetTo={NOISE_THRES_RESET} />
      {knobLabel(597, 'THRES')}

      {/* A/B spare state */}
      <RoundButton x={572} y={271} glyph="store" hint="Store in spare state" onClick={store_} />
      <RoundButton x={598} y={271} glyph="flip" hint="Flip with spare state (A/B compare)" onClick={flip} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'limiter',
  Editor: LimiterEditor,
  menu: (slotId) => [{ label: 'Options', submenu: optionItems(slotId) }],
};
