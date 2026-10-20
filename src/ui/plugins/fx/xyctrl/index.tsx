// X-Y Controller editor (FL: Fruity X-Y Controller, 239 x 352): the pad (drag
// to move the goal; the target follows), the X/Y switch with Level / Min / Max
// / Tension for the selected axis, Speed and Acceleration, and the joystick
// section (enable, axis menus, speed). Skins: right-click the pad. The
// joystick is read with the Gamepad API (see ./joystick.ts).

import { useRef } from 'react';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../../kit';
import { editFx, setFxParam } from '../../../../store/actions';
import { store } from '../../../../store';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { defaultJoystick, type XYJoystick } from '../../../../model/fx/plugins/xyctrl';
import { tensionInner } from '../controllers/kit';
import { gamepadNames } from './joystick';
import type { FxEditorModule } from '../../registry';

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** FL's white knob of the older skins: white metal body, red pointer, ticks around. */
function WhiteKnobView({ size: S, t }: { size: number; t: number }) {
  const c = S / 2, k = S / 36;
  const ang = -150 + 300 * Math.min(1, Math.max(0, t));
  const [p0x, p0y] = polar(c, c, 1.5 * k, ang);
  const [p1x, p1y] = polar(c, c, 11.2 * k, ang);
  return (
    <svg width={S} height={S} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id="wk-body" cx="42%" cy="35%" r="70%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.55" stopColor="#e6e9ea" />
          <stop offset="1" stopColor="#a9b0b3" />
        </radialGradient>
      </defs>
      {Array.from({ length: 7 }, (_, i) => {
        const a = -150 + i * 50;
        const [x0, y0] = polar(c, c, 15.2 * k, a);
        const [x1, y1] = polar(c, c, 18 * k, a);
        return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#d5dadb" strokeWidth={Math.max(0.8, 0.9 * k)} opacity={0.75} />;
      })}
      <circle cx={c} cy={c + 1 * k} r={13.2 * k} fill="rgba(0,0,0,0.35)" />
      <circle cx={c} cy={c} r={12.6 * k} fill="url(#wk-body)" stroke="#3a4040" strokeWidth={Math.max(0.8, 0.9 * k)} />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#b8202a" strokeWidth={Math.max(1.4, 1.9 * k)} strokeLinecap="round" />
    </svg>
  );
}

function WhiteKnob({ x, y, control }: { x: number; y: number; control: ControlProps }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 36, height: 36 }} {...h}>
      <WhiteKnobView size={36} t={(control.value - min) / (max - min || 1)} />
    </div>
  );
}

function Lbl({ x, y, w, children }: { x: number; y: number; w: number; children: React.ReactNode }) {
  return <div className="fxk-abs" style={{ left: x - 6, top: y, width: w + 12, height: 15, lineHeight: '15px', textAlign: 'center', fontSize: 10, color: '#eef2f3', fontFamily: '"Arial Narrow", "Helvetica Neue", Arial, sans-serif', fontStretch: 'condensed', pointerEvents: 'none' }}>{children}</div>;
}

/** The axis-bound knobs: the X/Y switch decides whether they edit X or Y. */
function AxisKnob({ x, y, which }: { x: number; y: number; which: 'Level' | 'Min' | 'Max' }) {
  const axis = useFxState<number>('axis', 0);
  const p = useParam((axis ? 'y' : 'x') + which);
  return <WhiteKnob x={x} y={y} control={p.control} />;
}

function TensionBox({ x, y }: { x: number; y: number }) {
  const axis = useFxState<number>('axis', 0);
  const p = useParam(axis ? 'yTension' : 'xTension');
  const h = useControl({ travel: 160, ...p.control }, 'vertical');
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 29, height: 31, background: '#3d4443', borderRadius: 3, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.45)' }} {...h}>
      <svg width={29} height={31} style={{ display: 'block' }}>
        <g transform="translate(14.5 16) scale(1.15 0.9) translate(-14.5 -15.5)">{tensionInner(p.value, '#a9e8a6')(14.5, 10)}</g>
      </svg>
    </div>
  );
}

function Pad({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const skin = useFxState<string>('skin', 'Default');
  const lx = useParam('xLevel'), ly = useParam('yLevel');
  const st = useRef({ x: NaN, y: NaN, gx: 0.5, gy: 0.5, drag: false });
  st.current.gx = lx.value / 65536;
  st.current.gy = ly.value / 65536;
  useFxMonitor(slotId, (d) => { st.current.x = Number(d.x); st.current.y = Number(d.y); });
  const setGoal = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    lx.set(Math.round(fx * 65536));
    ly.set(Math.round(fy * 65536));
    setHint(`X: ${Math.round(fx * 100)}%  Y: ${Math.round(fy * 100)}%`);
  };
  const sampler = skin === 'Sampler grid';
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        st.current.drag = true;
        store.nextGestureIsKnob = true; // pad moves are knob tweaks (undo follows "Undo knob tweaks")
        lx.control.onBegin?.();
        setGoal(e);
      }}
      onPointerMove={(e) => { if (st.current.drag) setGoal(e); }}
      onPointerUp={() => { if (st.current.drag) { st.current.drag = false; lx.control.onEnd?.(); clearHint(); } }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, ['Default', 'Sampler grid'].map((s) => ({
          label: s, radio: true, checked: skin === s, onClick: () => editFx(slotId, 'Skin', (p) => { p.skin = s; }),
        } as MenuItem)));
      }}
      frame={(g, W, H) => {
        const s = st.current;
        // a target never seen by the engine (gallery, stopped audio) sits on its goal
        const tx = Number.isFinite(s.x) ? s.x : s.gx, ty = Number.isFinite(s.y) ? s.y : s.gy;
        g.fillStyle = sampler ? '#3e4a52' : '#50566b';
        g.fillRect(0, 0, W, H);
        const cells = sampler ? 16 : 12;
        g.fillStyle = sampler ? '#4a5961' : '#5c6277';
        for (let i = 1; i < cells; i++) {
          g.fillRect(Math.round((i * W) / cells), 0, 1, H);
          g.fillRect(0, Math.round((i * H) / cells), W, 1);
        }
        g.strokeStyle = sampler ? '#5d6d76' : '#6e7589';
        g.lineWidth = 1;
        g.strokeRect(0.5, 0.5, W - 1, H - 1);
        const px = tx * W, py = (1 - ty) * H;
        g.fillStyle = 'rgba(226, 230, 238, 0.62)';
        g.fillRect(0, Math.round(py), W, 1);
        g.fillRect(Math.round(px), 0, 1, H);
        g.strokeStyle = 'rgba(205, 210, 222, 0.75)';
        g.lineWidth = 2;
        g.beginPath(); g.arc(px + 0.5, py + 0.5, 11.2, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#f2f4f8';
        g.beginPath(); g.arc(px + 0.5, py + 0.5, 3.6, 0, Math.PI * 2); g.fill();
        if (Math.abs(s.gx - tx) + Math.abs(s.gy - ty) > 0.004) {
          const gx = s.gx * W, gy = (1 - s.gy) * H;
          g.strokeStyle = 'rgba(242, 244, 248, 0.7)';
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(gx - 3, gy); g.lineTo(gx + 3, gy); g.moveTo(gx, gy - 3); g.lineTo(gx, gy + 3); g.stroke();
        }
      }} />
  );
}

function XYSwitch({ x, y }: { x: number; y: number }) {
  const { slotId } = useFxEditor();
  const axis = useFxState<number>('axis', 0);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 34, height: 30, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); editFx(slotId, 'Select X-Y', (p) => { p.axis = axis ? 0 : 1; }); } }}
      onPointerEnter={() => setHint('Select X-Y')} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 0, top: 1, width: 14, height: 28, borderRadius: 7, background: '#2d3333', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)' }}>
        <div style={{ position: 'absolute', left: 1.5, top: axis ? 15.5 : 1.5, width: 11, height: 11, borderRadius: '50%', background: 'radial-gradient(circle at 40% 35%, #ffffff, #d6dadb 70%, #9aa1a3)' }} />
      </div>
      <div style={{ position: 'absolute', left: 18, top: 0, fontSize: 11, lineHeight: '14px', color: axis ? '#c4cbcc' : '#ffffff' }}>X</div>
      <div style={{ position: 'absolute', left: 18, top: 14, fontSize: 11, lineHeight: '14px', color: axis ? '#ffffff' : '#c4cbcc' }}>Y</div>
    </div>
  );
}

function JoySection() {
  const { slotId } = useFxEditor();
  const joy = { ...defaultJoystick(), ...useFxState<Partial<XYJoystick>>('joy', {}) };
  const setJoy = (label: string, patch: Partial<XYJoystick>, mergeKey?: string) => editFx(slotId, label, (p) => { p.joy = { ...joy, ...patch }; }, mergeKey);
  const axisMenu = (e: React.PointerEvent, which: 'x' | 'y') => {
    const cur = which === 'x' ? joy.xAxis : joy.yAxis;
    const abs = which === 'x' ? joy.xAbs : joy.yAbs;
    const names = gamepadNames();
    const items: MenuItem[] = [
      ...(names.length ? names.map((n) => ({ label: n, disabled: true } as MenuItem)) : [{ label: '(no joystick found)', disabled: true }]),
      { separator: true },
      ...Array.from({ length: 8 }, (_, i) => ({
        label: String(i + 1), radio: true, checked: cur === i,
        onClick: () => setJoy('Joystick axis', which === 'x' ? { xAxis: i } : { yAxis: i }),
      } as MenuItem)),
      { separator: true },
      { label: 'Absolute', checked: abs, hint: 'Absolute / relative mode', onClick: () => setJoy('Joystick mode', which === 'x' ? { xAbs: !abs } : { yAbs: !abs }) },
    ];
    openMenu(e.clientX, e.clientY, items);
  };
  const speed: ControlProps = {
    value: joy.speed, min: 0, max: 100, defaultValue: 70, step: 1, label: 'Joystick speed',
    format: (v) => `${Math.round(v)}%`, onChange: (v) => setJoy('Joystick speed', { speed: v }, `xyjoy:${slotId}`),
  };
  const btn = (x: number, which: 'x' | 'y', tag: string) => (
    <div className="fxk-abs" style={{ left: x, top: 92, width: 16, height: 16, background: '#6c7473', border: '1px solid #8b9392', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#454c4b', cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); axisMenu(e, which); } }}
      onPointerEnter={() => setHint(`Choose what controls the ${tag} axis`)} onPointerLeave={clearHint}>{tag}</div>
  );
  return (
    <>
      <div className="fxk-abs" style={{ left: 152, top: 74, width: 14, height: 14, borderRadius: '50%', boxSizing: 'border-box', border: '1.5px solid #7f8587', background: joy.enabled ? 'radial-gradient(circle at 45% 40%, #ffd0b8 0%, #ff6a3d 55%, #a43720 100%)' : 'radial-gradient(circle at 45% 40%, #4b5055 0%, #2d3234 70%, #121515 100%)', cursor: 'default' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setJoy('Enable joystick', { enabled: !joy.enabled }); } }}
        onPointerEnter={() => setHint('Enable joystick controller')} onPointerLeave={clearHint} />
      <svg className="fxk-abs" style={{ left: 172, top: 70, pointerEvents: 'none' }} width={14} height={18} viewBox="0 0 14 18">
        <circle cx="7" cy="4" r="3" fill="#e9eeee" /><rect x="6" y="6" width="2" height="7" fill="#e9eeee" /><rect x="2" y="12" width="10" height="4" rx="1" fill="#e9eeee" />
      </svg>
      {btn(151, 'x', 'X')}
      {btn(169, 'y', 'Y')}
      <WhiteKnob x={192} y={59} control={speed} />
    </>
  );
}

function XYCtrlEditor() {
  const speed = useParam('speed'), accel = useParam('accel');
  return (
    <FxPanel width={239} height={352} style={{ background: '#50566b' }}>
      <Pad x={5} y={5} w={229} h={229} />
      <div className="fxk-abs" style={{ left: 0, top: 240, width: 239, height: 112, background: 'linear-gradient(180deg, #4d5554, #414847)' }}>
        <div className="fxk-abs" style={{ left: 0, top: 0, width: 239, height: 55, background: 'linear-gradient(180deg, #74807f, #5b6463)', borderRadius: '0 0 4px 4px' }} />
        <XYSwitch x={16} y={12} />
        <AxisKnob x={61} y={3} which="Level" />
        <AxisKnob x={106} y={3} which="Min" />
        <AxisKnob x={148} y={3} which="Max" />
        <TensionBox x={196} y={6} />
        <Lbl x={63} y={39} w={32}>LEVEL</Lbl>
        <Lbl x={110} y={39} w={26}>MIN</Lbl>
        <Lbl x={153} y={39} w={26}>MAX</Lbl>
        <Lbl x={192} y={39} w={36}>TENSION</Lbl>
        <WhiteKnob x={18} y={59} control={speed.control} />
        <WhiteKnob x={61} y={59} control={accel.control} />
        <Lbl x={18} y={95} w={32}>SPEED</Lbl>
        <Lbl x={66} y={95} w={26}>ACC</Lbl>
        <JoySection />
        <Lbl x={197} y={95} w={26}>SPEED</Lbl>
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'xyctrl',
  Editor: XYCtrlEditor,
  menu: (slotId) => [
    { label: 'Center target', onClick: () => { setFxParam(slotId, 'xLevel', 32768); setFxParam(slotId, 'yLevel', 32768); } },
  ],
};
