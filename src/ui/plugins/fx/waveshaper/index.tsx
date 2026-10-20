// WaveShaper editor (FL: Fruity WaveShaper, 270 x 353): the curve editor on
// top, the gear (settings) button, and FL's settings panel: name badge,
// unipolar / bipolar switch, PRE / MIX / POST wheels, options menu, freeze /
// step / snap editing switches, smoothing, HQ, CENTER and the oversampling
// selector, at FL's form coordinates.

import { memo, type ReactNode } from 'react';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { WS_IDENTITY, WS_OVERSAMPLE, wsCurve, type WsPoint } from '../../../../model/fx/plugins/waveshaper';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { useControl } from '../../../widgets/control';
import { FxPanel, useFxEditor, useFxState, useParam } from '../../kit';
import { clearHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { CurveEditor } from './CurveEditor';

const PANEL_Y = 256;
const A0 = -154;
const SWEEP = 308;

function pt(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/** FL's small vector wheel with a tick scale (40 px). */
function WsKnobView({ t }: { t: number }) {
  const S = 40, c = 20;
  const ang = A0 + SWEEP * Math.min(1, Math.max(0, t));
  const ticks = [];
  for (let i = 0; i < 33; i++) {
    const a = A0 + (SWEEP * i) / 32;
    const long = i % 4 === 0;
    const [x0, y0] = pt(c, 16.6, a);
    const [x1, y1] = pt(c, long ? 19.6 : 18.6, a);
    ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#3a4246" strokeWidth={0.75} />);
  }
  const [p0x, p0y] = pt(c, 4.5, ang);
  const [p1x, p1y] = pt(c, 13.3, ang);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id="wsk-body" cx="50%" cy="30%" r="75%">
          <stop offset="0" stopColor="#626b70" />
          <stop offset="0.55" stopColor="#4a5357" />
          <stop offset="1" stopColor="#363d41" />
        </radialGradient>
      </defs>
      {ticks}
      <circle cx={c} cy={c + 0.8} r={15.8} fill="rgba(0,0,0,0.35)" />
      <circle cx={c} cy={c} r={15.4} fill="#23292e" />
      <circle cx={c} cy={c} r={14.4} fill="url(#wsk-body)" />
      <path d={`M${pt(c, 13.4, -58).join(' ')} A13.4 13.4 0 0 1 ${pt(c, 13.4, 58).join(' ')}`} stroke="rgba(255,255,255,0.12)" strokeWidth={0.9} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#e4e9eb" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  );
}

const WsKnob = memo(function WsKnob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 40, height: 40 }} {...h}>
      <WsKnobView t={t} />
    </div>
  );
});

function Led({ on }: { on: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 11, height: 11, borderRadius: '50%', boxSizing: 'border-box', flex: 'none',
      border: '1px solid #23292e',
      background: on ? 'radial-gradient(circle at 48% 45%, #fff0e0 0%, #ffba93 30%, #ff7a3c 70%, #c4421a 100%)' : 'radial-gradient(circle at 48% 45%, #6e777d 0%, #4f585d 55%, #3b4144 100%)',
      boxShadow: on ? '0 0 4px rgba(255,140,80,0.8)' : 'inset 0 1px 1px rgba(0,0,0,0.3)',
    }} />
  );
}

/** A state switch: LED plus a caption or glyph (FL's TVectorCheckBox). */
function StateCheck({ k, x, y, w, hint, children, fallback = 0 }: { k: string; x: number; y: number; w: number; hint: string; children: ReactNode; fallback?: number }) {
  const { slotId } = useFxEditor();
  const on = Number(useFxState<number>(k, fallback)) >= 0.5;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 14, display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        A.editFx(slotId, hint, (p) => { p[k] = on ? 0 : 1; });
        setHint(`${hint}: ${on ? 'off' : 'on'}`);
      }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <Led on={on} />
      {children}
    </div>
  );
}

const capStyle = { font: '9.5px "Open Sans Condensed", "Arial Narrow", Arial, sans-serif', color: '#a5b4b7', letterSpacing: 0.2, whiteSpace: 'nowrap' as const };

function Glyph({ d, w = 13, fill = false }: { d: string; w?: number; fill?: boolean }) {
  return (
    <svg width={w} height={13} viewBox="0 0 12 12" style={{ display: 'block' }}>
      <path d={d} fill={fill ? '#a9bcc4' : 'none'} stroke={fill ? 'none' : '#b9cad1'} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SNOW = 'M6 1 V11 M1.7 3.5 L10.3 8.5 M1.7 8.5 L10.3 3.5 M4.6 1.6 L6 3 L7.4 1.6 M4.6 10.4 L6 9 L7.4 10.4';
const PENCIL = 'M2 10 L2.6 7.6 L8.6 1.6 L10.4 3.4 L4.4 9.4 Z M7.6 2.6 L9.4 4.4';
const MAGNET = 'M2.4 3 V6.6 A3.6 3.6 0 0 0 9.6 6.6 V3 H7.4 V6.6 A1.4 1.4 0 0 1 4.6 6.6 V3 Z';
const SMOOTH = 'M2.5 10.5 C5.5 10.5 5 1.5 9.5 1.5';

/** Unipolar / bipolar switch (FL's PolarBtn): pill with the thumb on the selected mode's icon. */
function PolarSwitch() {
  const { slotId } = useFxEditor();
  const bip = Number(useFxState<number>('bipolar', 0)) >= 0.5;
  return (
    <div className="fxk-abs" style={{ left: 67, top: PANEL_Y + 7, width: 41, height: 32, cursor: 'default' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        A.editFx(slotId, bip ? 'Unipolar' : 'Bipolar', (p) => { p.bipolar = bip ? 0 : 1; });
        setHint(`Mode: ${bip ? 'unipolar' : 'bipolar'}`);
      }}
      onPointerEnter={() => setHint(`Unipolar / bipolar mode: ${bip ? 'bipolar' : 'unipolar'}`)} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 1, top: 2, width: 15, height: 28, borderRadius: 7.5, background: '#2c3337', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.5)' }}>
        <div style={{ position: 'absolute', left: 1.5, top: bip ? 14.5 : 1.5, width: 12, height: 12, borderRadius: '50%', background: 'radial-gradient(circle at 45% 40%, #e4e8ea, #b2bbbf 70%, #8f999e)', boxShadow: '0 1px 2px rgba(0,0,0,0.6)' }} />
      </div>
      <svg style={{ position: 'absolute', left: 18, top: 2 }} width={23} height={28} viewBox="0 0 23 28">
        <path d="M1 12.5 H4.5 V3.5 H8.6 V12.5 H22" fill="none" stroke={bip ? '#6f7b80' : '#a9b6bb'} strokeWidth={1.3} />
        <path d="M1 18.5 H4.5 V15 H8.6 V27 H12.4 V18.5 H22" fill="none" stroke={bip ? '#a9b6bb' : '#6f7b80'} strokeWidth={1.3} />
      </svg>
    </div>
  );
}

/** Oversampling selector (FL's TVectorDigiWheel 0..4: 1x .. 16x). */
function OverSelect() {
  const { slotId } = useFxEditor();
  const v = Math.max(0, Math.min(4, Math.round(Number(useFxState<number>('oversample', 0)))));
  const set = (n: number) => {
    const c = Math.max(0, Math.min(4, n));
    if (c !== v) A.editFx(slotId, 'Oversampling', (p) => { p.oversample = c; });
    setHint(`Oversampling factor: ${WS_OVERSAMPLE[c]}`);
  };
  const h = useControl({
    value: v, min: 0, max: 4, step: 1, defaultValue: 0, label: 'Oversampling factor', format: (n) => WS_OVERSAMPLE[Math.round(n)] ?? '',
    onChange: (n) => set(Math.round(n)), travel: 40,
  }, 'vertical');
  return (
    <div className="fxk-abs" style={{ left: 236, top: PANEL_Y + 73, width: 30, height: 20, boxSizing: 'border-box', background: '#535c61', border: '1px solid #3a4246', borderRadius: 2 }}>
      <div {...h} style={{ position: 'absolute', left: 0, top: 0, width: 21, height: 18, font: '11px Arial, Helvetica, sans-serif', lineHeight: '18px', color: '#ffffff', textAlign: 'right', cursor: 'ns-resize' }}>{WS_OVERSAMPLE[v]}</div>
      <div style={{ position: 'absolute', left: 22, top: 2, width: 7, height: 7 }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); set(v + 1); } }}>
        <svg width={7} height={7}><path d="M3.5 1.5 L6 5 L1 5 Z" fill="#a9b4b8" /></svg>
      </div>
      <div style={{ position: 'absolute', left: 22, top: 9, width: 7, height: 7 }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); set(v - 1); } }}>
        <svg width={7} height={7}><path d="M3.5 5.5 L6 2 L1 2 Z" fill="#a9b4b8" /></svg>
      </div>
    </div>
  );
}

function curveOf(slotId: string): WsPoint[] {
  return wsCurve(A.findFx(store.project, slotId)?.fx.params.curve);
}

/** FL's curve options (MenuBtn and the plugin menu). */
function optionItems(slotId: string): MenuItem[] {
  const p = A.findFx(store.project, slotId)?.fx.params ?? {};
  const flag = (k: string, d = 0) => Number(p[k] ?? d) >= 0.5;
  const setCurve = (label: string, f: (c: WsPoint[]) => WsPoint[]) => A.editFx(slotId, label, (q) => { q.curve = f(curveOf(slotId)).map((x) => [...x]); });
  return [
    { label: 'Reset curve', onClick: () => setCurve('Reset curve', () => WS_IDENTITY.map((x) => [...x] as WsPoint)) },
    { label: 'Flip vertically', onClick: () => setCurve('Flip vertically', (c) => c.map(([x, y, t, m]) => [x, 1 - y, t, m] as WsPoint)) },
    {
      label: 'Flip horizontally', onClick: () => setCurve('Flip horizontally', (c) => {
        const r = [...c].reverse();
        // segment shapes travel with their segments: point i takes the mode / tension of old point i+1, tension mirrored
        return r.map(([x, y], i) => [1 - x, y, i === 0 ? 0 : -r[i - 1][2], i === 0 ? 0 : r[i - 1][3]] as WsPoint);
      }),
    },
    { separator: true },
    { label: 'Bipolar', checked: flag('bipolar'), onClick: () => A.editFx(slotId, 'Bipolar', (q) => { q.bipolar = flag('bipolar') ? 0 : 1; }) },
    { label: 'Snap to grid', checked: flag('snap', 1), onClick: () => A.editFx(slotId, 'Snap', (q) => { q.snap = flag('snap', 1) ? 0 : 1; }) },
    { label: 'Step editing', checked: flag('step'), onClick: () => A.editFx(slotId, 'Step editing', (q) => { q.step = flag('step') ? 0 : 1; }) },
    { label: 'Freeze editing', checked: flag('freeze'), onClick: () => A.editFx(slotId, 'Freeze', (q) => { q.freeze = flag('freeze') ? 0 : 1; }) },
  ];
}

function WaveShaperEditor() {
  const { slotId } = useFxEditor();
  const menuAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, optionItems(slotId));
  };
  return (
    <FxPanel width={270} height={353} style={{ background: '#41687e' }}>
      <div className="fxk-abs" style={{ left: 8, top: 8, width: 254, height: 225 }} onPointerLeave={clearHint}>
        <CurveEditor x={0} y={0} w={254} h={225} />
      </div>
      {/* settings (gear) button */}
      <div className="fxk-abs" style={{ left: 243, top: 232, width: 24, height: 19, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); menuAt(e); } }}
        onPointerEnter={() => setHint('Settings')} onPointerLeave={clearHint}>
        <svg width={15} height={15} viewBox="0 0 16 16">
          <path d="M8 1.2 L9.3 1.4 L9.7 3.2 L11 3.8 L12.6 2.8 L13.6 3.8 L12.6 5.4 L13.2 6.7 L15 7.1 L15 8.9 L13.2 9.3 L12.6 10.6 L13.6 12.2 L12.6 13.2 L11 12.2 L9.7 12.8 L9.3 14.6 L6.7 14.6 L6.3 12.8 L5 12.2 L3.4 13.2 L2.4 12.2 L3.4 10.6 L2.8 9.3 L1 8.9 L1 7.1 L2.8 6.7 L3.4 5.4 L2.4 3.8 L3.4 2.8 L5 3.8 L6.3 3.2 L6.7 1.4 Z" fill="none" stroke="#61deff" strokeWidth={1.7} strokeLinejoin="round" />
          <circle cx={8} cy={8} r={2.2} fill="none" stroke="#61deff" strokeWidth={1.6} />
        </svg>
      </div>
      {/* settings panel */}
      <div className="fxk-abs" style={{ left: 0, top: PANEL_Y, width: 270, height: 97, background: '#4a5356', borderTop: '1px solid #3a4447' }} />
      <svg className="fxk-abs" width={66} height={36} style={{ left: 0, top: PANEL_Y, pointerEvents: 'none' }}>
        <path d="M8 2.5 H62 L55 18.5 H1 Z" fill="#757e83" />
        <text x={31} y={16.2} textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontWeight={700} fontStyle="italic" fontSize={14.5} fill="#4a5356" letterSpacing={0.3}>WAVE</text>
        <text x={1} y={32.5} fontFamily="Arial, Helvetica, sans-serif" fontSize={14.6} fill="#b1bdc4">SHAPER</text>
      </svg>
      <PolarSwitch />
      <WsKnob k="pre" x={142} y={PANEL_Y + 1} />
      <WsKnob k="mix" x={184} y={PANEL_Y + 1} />
      <WsKnob k="post" x={227} y={PANEL_Y + 1} />
      {[['PRE', 162], ['MIX', 204], ['POST', 247]].map(([t, cx]) => (
        <div key={t} className="fxk-abs" style={{ left: (cx as number) - 20, top: PANEL_Y + 43, width: 40, height: 12, textAlign: 'center', ...capStyle, lineHeight: '12px', color: '#98aeac', pointerEvents: 'none' }}>{t}</div>
      ))}
      {/* options menu button */}
      <div className="fxk-abs" style={{ left: 3, top: PANEL_Y + 53, width: 20, height: 20, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); menuAt(e); } }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
        <svg width={9} height={6}><path d="M0.5 0.5 H8.5 L4.5 5.5 Z" fill="#e4e9eb" /></svg>
      </div>
      <StateCheck k="freeze" x={4} y={PANEL_Y + 77} w={35} hint="Freeze editing"><Glyph d={SNOW} /></StateCheck>
      <StateCheck k="step" x={38} y={PANEL_Y + 77} w={35} hint="Step editing (hold shift for pulse mode)"><Glyph d={PENCIL} /></StateCheck>
      <StateCheck k="snap" x={74} y={PANEL_Y + 77} w={35} hint="Snap to grid" fallback={1}><Glyph d={MAGNET} /></StateCheck>
      <StateCheck k="smooth" x={142} y={PANEL_Y + 58} w={32} hint="Smooth up modulation"><Glyph d={SMOOTH} /></StateCheck>
      <div className="fxk-abs" style={{ left: 175, top: PANEL_Y + 57, height: 14, ...capStyle, lineHeight: '14px', pointerEvents: 'none' }}>OVERSAMPLE</div>
      <svg className="fxk-abs" width={30} height={12} style={{ left: 233, top: PANEL_Y + 61, pointerEvents: 'none' }}>
        <path d="M0.5 0.5 H23.5 V8" fill="none" stroke="#a5b4b7" strokeWidth={1} />
      </svg>
      <StateCheck k="hq" x={142} y={PANEL_Y + 77} w={35} hint="Don't truncate below -85dB"><span style={capStyle}>HQ</span></StateCheck>
      <StateCheck k="center" x={179} y={PANEL_Y + 77} w={54} hint="Remove DC offset"><span style={capStyle}>CENTER</span></StateCheck>
      <OverSelect />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'waveshaper',
  Editor: WaveShaperEditor,
  menu: (slotId) => [{ label: 'Curve', submenu: optionItems(slotId) }],
};
