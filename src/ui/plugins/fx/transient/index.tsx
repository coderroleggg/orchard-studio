// Transient Processor editor (FL: Transient Processor, 547 x 318): in/out
// volumeters at the sides, FL's vector wheels at form coordinates, the shape
// spinners, the Drive LED (lit while the saturator works), ON/OFF switch, help
// and block-diagram buttons, and the scrolling meter graph (input peaks,
// output peaks, transient process) whose controls appear on mouse-over.

import { useEffect, useRef, useState } from 'react';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState } from '../../kit';
import { clearHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';
import type { FxEditorModule } from '../../registry';
import {
  MeterGraph, OnOffSwitch, ShapeSpin, SpeedSlider, TpKnob, TpLabel, Volumeter, type GraphView,
} from './widgets';

const W = 547, H = 318;

/** Editors listening for the "Show block diagram" menu command, by slot. */
const diagramListeners = new Map<string, () => void>();

function DriveLed() {
  const { slotId } = useFxEditor();
  const st = useRef({ v: 0 });
  useFxMonitor(slotId, (d) => { st.current.v = Math.max(st.current.v, Number(d.sat) || 0); });
  return (
    <AnimatedDisplay x={268} y={93} w={15} h={7} frame={(g, w, h) => {
      const s = st.current;
      // lit when the soft clipper bends the signal (|k x| beyond ~0.5 = more than 1% compression)
      const on = Math.min(1, Math.max(0, (s.v - 0.45) / 0.6));
      s.v *= 0.82;
      g.fillStyle = '#3a2422';
      g.fillRect(0, 0, w, h);
      const r = Math.round(103 + on * (255 - 103)), gg = Math.round(69 + on * (78 - 69)), b = Math.round(67 + on * (48 - 67));
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(1, 1, w - 2, h - 2);
      if (on > 0.05) { g.fillStyle = `rgba(255,200,170,${0.35 * on})`; g.fillRect(2, 1.5, w - 4, 1.5); }
    }} />
  );
}

function IconBtn({ x, y, w, h, hint, onClick, children }: { x: number; y: number; w: number; h: number; hint: string; onClick: () => void; children: React.ReactNode }) {
  const [hov, setHov] = useState(false);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', color: hov ? '#2b343a' : '#4c565c' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => { setHov(true); setHint(hint); }} onPointerLeave={() => { setHov(false); clearHint(); }}>
      {children}
    </div>
  );
}

/** The signal flowchart (FL shows it from the block-diagram button). */
function Flowchart({ onClose }: { onClose: () => void }) {
  const box = (x: number, y: number, w: number, label: string) => (
    <g key={label + x}>
      <rect x={x} y={y} width={w} height={22} fill="#9fa4a7" stroke="#e1e5e7" strokeWidth={1} />
      <text x={x + w / 2} y={y + 15} textAnchor="middle" fontSize={10} fontWeight={700} fill="#f4f6f7">{label}</text>
    </g>
  );
  const arrowUp = (x: number, y0: number, y1: number, label: string) => (
    <g key={label + x}>
      <line x1={x} y1={y0} x2={x} y2={y1 + 4} stroke="#e1e5e7" />
      <path d={`M${x - 4} ${y1 + 6} L${x} ${y1} L${x + 4} ${y1 + 6} Z`} fill="#e1e5e7" />
      <text x={x} y={y0 + 12} textAnchor="middle" fontSize={9.5} fill="#e1e5e7">{label}</text>
    </g>
  );
  return (
    <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: H, background: '#2c3a42', zIndex: 5 }}
      onPointerDown={(e) => { e.stopPropagation(); onClose(); }}>
      <svg width={W} height={H}>
        <text x={W / 2} y={34} textAnchor="middle" fontSize={22} fill="#c9d4d9" fontWeight={300}>Transient Processor</text>
        <text x={W / 2} y={54} textAnchor="middle" fontSize={14} fill="#c9d4d9" fontWeight={300}>signal flowchart</text>
        <g stroke="#e1e5e7" fill="none">
          <path d="M44 150 H58 M58 150 V112 H72 M58 150 V178 H72" />
          <path d="M152 112 H420 L446 142" />
          <path d="M152 178 H170 M320 178 H336 M422 178 L446 158" />
          <path d="M468 150 H482 M504 150 H512" />
          <path d="M112 166 V128" />
        </g>
        <path d="M108 132 L112 124 L116 132 Z" fill="#e1e5e7" />
        {box(12, 139, 32, 'IN')}
        {box(72, 101, 80, 'LOWPASS')}
        {box(72, 167, 80, 'HIGHPASS')}
        {box(170, 167, 150, 'TRANSIENT PROCESSING')}
        {box(336, 167, 86, 'SATURATION')}
        {box(512, 139, 30, 'OUT')}
        <circle cx={457} cy={150} r={11} fill="#9fa4a7" stroke="#e1e5e7" strokeWidth={1.5} />
        <circle cx={493} cy={150} r={11} fill="#9fa4a7" stroke="#e1e5e7" strokeWidth={1.5} />
        {arrowUp(112, 230, 189, 'Split Frequency')}
        {arrowUp(185, 250, 189, 'Attack')}
        {arrowUp(225, 230, 189, 'Shape')}
        {arrowUp(265, 250, 189, 'Release')}
        {arrowUp(305, 230, 189, 'Shape')}
        {arrowUp(379, 230, 189, 'Drive')}
        {arrowUp(457, 250, 161, 'Split Balance')}
        {arrowUp(493, 230, 161, 'Gain')}
      </svg>
    </div>
  );
}

function TransientEditor() {
  const { slotId } = useFxEditor();
  const visI = useFxState<boolean>('visI', true);
  const visO = useFxState<boolean>('visO', true);
  const visS = useFxState<boolean>('visS', true);
  const speed = useFxState<number>('speed', 50);
  const view: GraphView = { visI, visO, visS, speed };
  const setView = (label: string, key: string, v: unknown) => A.setFxStateNoHistory(slotId, label, (p) => { p[key] = v; });
  const [hover, setHover] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [diagram, setDiagram] = useState(false);
  useEffect(() => {
    diagramListeners.set(slotId, () => setDiagram((d) => !d));
    return () => { diagramListeners.delete(slotId); };
  }, [slotId]);

  const visBtn = (key: 'visI' | 'visO' | 'visS', on: boolean, top: number, hint: string, glyph: React.ReactNode) => (
    <div className="fxk-abs" style={{ left: 1, top, width: 18, height: 13, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', color: on ? '#e9eef0' : '#6d7a80', fontSize: 9, fontWeight: 700 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setView(hint, key, !on); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{glyph}</div>
  );

  return (
    <FxPanel width={W} height={H} style={{ background: '#2d383b' }}>
      {/* main surface between the meters */}
      <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: 178, background: 'radial-gradient(78% 150% at 50% -10%, #95a6b0 0%, #7d8c95 36%, #66737a 68%, #565f64 100%)' }} />
      <div className="fxk-abs" style={{ left: 122, top: 27, width: 111, height: 148, borderRadius: 4, background: 'rgba(255,255,255,0.055)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)' }} />
      <div className="fxk-abs" style={{ left: 318, top: 27, width: 110, height: 148, borderRadius: 4, background: 'rgba(255,255,255,0.055)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)' }} />
      <div className="fxk-abs" style={{ left: 0, top: 176, width: W, height: 2, background: '#3b4448' }} />

      <div className="fxk-abs" style={{ left: 120, top: -1, width: 310, height: 28, textAlign: 'center', fontSize: 23, lineHeight: '28px', fontWeight: 200, color: '#d3e3ea', fontVariant: 'small-caps', letterSpacing: '0.05em', pointerEvents: 'none', textShadow: '0 1px 1px rgba(40,55,62,0.35)' }}>
        Transient Processor
      </div>

      <Volumeter x={0} y={0} w={32} h={178} which="in" />
      <Volumeter x={515} y={0} w={32} h={178} which="out" />

      <TpKnob k="splitFreq" x={54} y={27} size={54} />
      <TpLabel x={36} y={78} w={90}>SPLIT FREQ.</TpLabel>
      <TpKnob k="attack" x={132} y={34} size={90} />
      <TpLabel x={132} y={122} w={90}>ATTACK</TpLabel>
      <ShapeSpin k="attackShape" x={154} y={140} w={46} h={24} />
      <TpKnob k="drive" x={248} y={27} size={54} />
      <TpLabel x={230} y={78} w={90}>DRIVE</TpLabel>
      <DriveLed />
      <TpKnob k="splitBal" x={248} y={111} size={54} />
      <TpLabel x={230} y={162} w={90}>SPLIT BALANCE</TpLabel>
      <TpKnob k="release" x={327} y={34} size={90} />
      <TpLabel x={327} y={122} w={90}>RELEASE</TpLabel>
      <ShapeSpin k="releaseShape" x={349} y={142} w={46} h={24} />
      <TpKnob k="gain" x={440} y={27} size={54} />
      <TpLabel x={422} y={78} w={90}>GAIN</TpLabel>

      <OnOffSwitch k="effect" x={39} y={149} />

      <IconBtn x={469} y={154} w={22} h={22} hint="Show On-Line Help" onClick={() => setHint('Transient Processor: see the FL Studio manual')}>
        <div style={{ width: 22, height: 22, textAlign: 'center', lineHeight: '22px', fontSize: 16, fontWeight: 700 }}>?</div>
      </IconBtn>
      <IconBtn x={487} y={154} w={22} h={22} hint="Show block diagram" onClick={() => setDiagram(true)}>
        <svg width={22} height={22} viewBox="0 0 22 22">
          <g fill="none" stroke="currentColor" strokeWidth={1.3}>
            <path d="M7 5 H9 V17 H7 M9 11 H14" />
            <rect x={4} y={3.5} width={3} height={3} />
            <rect x={4} y={15.5} width={3} height={3} />
            <rect x={14} y={9.5} width={3} height={3} />
          </g>
        </svg>
      </IconBtn>

      <div className="fxk-abs" style={{ left: 0, top: 178, width: W, height: 140 }}
        onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        <MeterGraph x={4} y={2} w={W - 4} h={138} view={view} frozen={frozen} onClick={() => setFrozen((f) => !f)} />
        {frozen && <div className="fxk-abs" style={{ right: 10, top: 8, color: '#8c979c', fontSize: 9, fontWeight: 700, pointerEvents: 'none' }}>FROZEN</div>}
        {hover && (
          <div className="fxk-abs" style={{ left: 6, top: 8, width: 21, height: 98 }}>
            <div className="fxk-abs" style={{ left: 0, top: -1, width: 21, height: 83, background: '#404b50', border: '1px solid #262e32', borderRadius: 2 }} />
            {visBtn('visI', visI, 3, 'Show input peaks', <span style={{ color: visI ? '#9dd63b' : undefined }}>I</span>)}
            {visBtn('visO', visO, 16, 'Show output peaks', <span style={{ color: visO ? '#b495e6' : undefined }}>O</span>)}
            {visBtn('visS', visS, 30, 'Transient process', <span style={{ color: visS ? '#ff6a3d' : undefined }}>S</span>)}
            <SpeedSlider x={0} y={46} w={21} h={46} value={speed} onChange={(v) => setView('Scrolling speed', 'speed', v)} />
          </div>
        )}
      </div>

      {diagram && <Flowchart onClose={() => setDiagram(false)} />}
      <div className="fxk-abs" style={{ left: 268, top: 93, width: 15, height: 7, pointerEvents: 'none', boxShadow: 'inset 0 0 0 1px #2b1d1c' }} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'transient',
  Editor: TransientEditor,
  menu: (slotId) => [
    { label: 'Show block diagram', onClick: () => diagramListeners.get(slotId)?.() },
  ],
};
