// Delay editor (FL: Fruity Delay, legacy, 500 x 105): six panels (INPUT,
// FEEDBACK, CUTOFF with level bars; TEMPO, STEPS, MODE with their value
// labels), each with FL's dark knob and pink value arc, at the coordinates of
// FL's editor form.

import type { ReactNode } from 'react';
import { delayModeText, delayStepsText, delayTempoText } from '../../../../model/fx/plugins/delay';
import { useControl, type ControlProps } from '../../../widgets/control';
import { FxPanel, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import './delay.css';

const START = -135;
const SWEEP = 270;
const PINK = '#ffd8d4';
let gid = 0;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** FL's dark knob (TVectorWheel, 46 x 40 box): two-tone body, track ring with the pink value arc. */
function Knob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const W = 46, H = 40, cx = W / 2 - 1, cy = H / 2;
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const R = 18.4, body = 14, id = `dlk${(gid = (gid + 1) % 1e6)}`;
  const [p0x, p0y] = polar(cx, cy, body * 0.5, ang);
  const [p1x, p1y] = polar(cx, cy, body * 0.9, ang);
  const [s0x, s0y] = polar(cx, cy, body, 225);
  const [s1x, s1y] = polar(cx, cy, body, 45);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: W, height: H }} {...h}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={`${id}b`} gradientUnits="userSpaceOnUse" x1={s0x} y1={s0y} x2={s1x} y2={s1y}>
            <stop offset="0" stopColor="#4b565c" />
            <stop offset="0.5" stopColor="#465156" />
            <stop offset="0.5" stopColor="#3a4348" />
            <stop offset="1" stopColor="#353d42" />
          </linearGradient>
        </defs>
        <path d={arc(cx, cy, R, START, START + SWEEP)} stroke="#3a4145" strokeWidth={2.9} fill="none" />
        {t > 0.002 && <path d={arc(cx, cy, R, START, ang)} stroke={PINK} strokeWidth={2.9} fill="none" />}
        <circle cx={cx} cy={cy} r={body + 1.1} fill="#2b3236" />
        <circle cx={cx} cy={cy} r={body} fill={`url(#${id}b)`} />
        <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={PINK} strokeWidth={1.9} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** The level bar beside a knob (FL's horizontal TVectorSlider), drags the same parameter. */
function Bar({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const control: ControlProps = { ...p.control, travel: 108 };
  const h = useControl(control, 'horizontal');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  return (
    <div className="dl-bar" style={{ left: x, top: y, width: 108 }} {...h}>
      <div className="dl-bar-track" />
      <div className="dl-bar-fill" style={{ width: Math.max(0, 106 * t) }} />
    </div>
  );
}

function Label({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return <div className="dl-label" style={{ left: x, top: y }}>{children}</div>;
}

function Value({ k, x, y, text }: { k: string; x: number; y: number; text: (v: number) => string }) {
  const p = useParam(k);
  return <div className="dl-value" style={{ left: x, top: y }}>{text(p.value)}</div>;
}

function DelayEditor() {
  return (
    <FxPanel width={500} height={105} className="dl-panel">
      {[[5, 5], [170, 5], [335, 5], [5, 55], [170, 55], [335, 55]].map(([x, y]) => <div key={`${x}-${y}`} className="dl-bevel" style={{ left: x, top: y }} />)}
      <Knob k="input" x={7} y={8} />
      <Label x={59} y={5}>INPUT</Label>
      <Bar k="input" x={56} y={34} />
      <Knob k="feedback" x={172} y={8} />
      <Label x={224} y={5}>FEEDBACK</Label>
      <Bar k="feedback" x={221} y={34} />
      <Knob k="cutoff" x={337} y={8} />
      <Label x={389} y={8}>CUTOFF</Label>
      <Bar k="cutoff" x={386} y={37} />
      <Knob k="tempo" x={7} y={58} />
      <Label x={59} y={56}>TEMPO</Label>
      <Value k="tempo" x={60} y={81} text={delayTempoText} />
      <Knob k="steps" x={172} y={58} />
      <Label x={224} y={55}>STEPS</Label>
      <Value k="steps" x={225} y={81} text={delayStepsText} />
      <Knob k="mode" x={337} y={58} />
      <Label x={389} y={55}>MODE</Label>
      <Value k="mode" x={390} y={81} text={delayModeText} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'delay', Editor: DelayEditor };
