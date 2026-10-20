// Fruity Vocoder's vector widgets, drawn after FL 2026's screenshot (2x):
// - MetalKnob: tick ring, dark outer ring lit from above, brushed-metal cap and
//   an orange position dot (TVectorWheel in the vocoder's skin);
// - TickSlider: TVectorSlider with tick marks on both sides, a dark cap with a
//   centre line across the slider and a hollow groove between zero and the value;
// - LedButton: round LED with a caption below (TVectorCheckBox);
// - Section: the lighter rounded section panels, sharing the editor's radial
//   lighting (the panel gradients are fitted to the screenshot).

import { memo, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

export const EDITOR_W = 406;
export const EDITOR_H = 300;

/** Editor background and section panels: linear in the distance from the top centre (ellipse 250 x 400). */
const LIGHT = 'ellipse 250px 400px at 203px 0px';
export const BG = `radial-gradient(${LIGHT}, rgb(97,108,126) 0%, rgb(54,61,71) 100%, rgb(50,56,65) 110%)`;
const SECTION_BG = `radial-gradient(${LIGHT}, rgb(119,129,144) 0%, rgb(67,74,83) 100%, rgb(62,68,77) 110%)`;

export const C = {
  caption: '#d0d8dc',
  captionDim: '#a5acb0',
  dot: '#ffae34',
  tick: '#363e46',
  groove: '#2a3238',
};

type Box = { x: number; y: number; w: number; h: number };

/** Lighter rounded section panel; its gradient is aligned with the editor's. */
export function Section({ x, y, w, h, children, style }: Box & { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 4,
      background: SECTION_BG, backgroundSize: `${EDITOR_W}px ${EDITOR_H}px`, backgroundPosition: `${-x}px ${-y}px`,
      ...style,
    }}>{children}</div>
  );
}

/** Caption text in the vocoder's style (centred in its box unless aligned). */
export function Caption({ x, y, w, h = 10, size = 9.5, color = C.caption, align = 'center', bold = true, weight, children, style }: Omit<Box, 'h'> & {
  h?: number; size?: number; color?: string; align?: 'left' | 'center' | 'right'; bold?: boolean; weight?: number; children: ReactNode; style?: CSSProperties;
}) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, lineHeight: `${h}px`, fontSize: size, color, textAlign: align,
      fontWeight: weight ?? (bold ? 500 : 400), letterSpacing: '0.04em', whiteSpace: 'nowrap', pointerEvents: 'none', ...style,
    }}>{children}</div>
  );
}

/** FL's vocoder knobs sweep 310 degrees (dot at -155 .. +155). */
const START = -155;
const SWEEP = 310;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Knob drawing (40 px box in FL's form); `t` is the normalised position. */
export function MetalKnobView({ size, t }: { size: number; t: number }) {
  const s = size / 40;
  const c = size / 2;
  const ticks: ReactNode[] = [];
  const N = 33;
  for (let i = 0; i < N; i++) {
    const a = START + (SWEEP * i) / (N - 1);
    const major = i === 0 || i === N - 1 || i === (N - 1) / 2 || i === 2 || i === N - 3;
    const [x0, y0] = polar(c, c, (major ? 16.9 : 17.4) * s, a);
    const [x1, y1] = polar(c, c, 20 * s, a);
    ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={major ? '#353c44' : C.tick} strokeWidth={0.62 * s} />);
  }
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const [dx, dy] = polar(c, c, 12 * s, ang);
  const ring = 14.3 * s, line = 10.45 * s, cap = 9.85 * s;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>{ticks}</svg>
      {/* outer ring: dark, lit from above */}
      <div style={{
        position: 'absolute', left: c - ring, top: c - ring, width: 2 * ring, height: 2 * ring, borderRadius: '50%',
        background: 'linear-gradient(180deg, #9ca4a9 0%, #8a9297 7%, #6b7176 14%, #262d31 28%, #12181b 46%, #141b1f 62%, #232c32 80%, #2f3940 92%, #222b30 100%)',
        boxShadow: `0 0 0 ${0.5 * s}px #28323a, 0 ${0.8 * s}px ${1.4 * s}px rgba(0,0,0,0.3)`,
      }} />
      {/* black line around the cap */}
      <div style={{ position: 'absolute', left: c - line, top: c - line, width: 2 * line, height: 2 * line, borderRadius: '50%', background: '#0a0e11' }} />
      {/* brushed-metal cap */}
      <div style={{
        position: 'absolute', left: c - cap, top: c - cap, width: 2 * cap, height: 2 * cap, borderRadius: '50%',
        background: [
          'linear-gradient(180deg, rgba(150,158,164,0.85) 0%, rgba(120,127,132,0.55) 18%, rgba(96,101,105,0.3) 36%, rgba(0,0,0,0) 52%, rgba(255,255,255,0.03) 70%, rgba(150,155,160,0.3) 100%)',
          'conic-gradient(from 0deg, #3a4145 0deg, #4b5257 18deg, #6f767b 36deg, #4c5358 58deg, #343a3e 95deg, #2f3539 140deg, #3a4044 185deg, #4f565b 205deg, #666d72 220deg, #474e53 240deg, #33393d 280deg, #30363a 320deg, #3a4145 360deg)',
        ].join(','),
        boxShadow: `inset 0 0 0 ${0.45 * s}px rgba(95,101,106,0.55)`,
      }} />
      <div style={{
        position: 'absolute', left: dx - 0.95 * s, top: dy - 0.95 * s, width: 1.9 * s, height: 1.9 * s, borderRadius: '50%',
        background: C.dot, boxShadow: `0 0 ${1.2 * s}px rgba(255,174,52,0.75)`,
      }} />
    </div>
  );
}

/** A metal knob bound to parameter `k` at FL's form position. */
export const MetalKnob = memo(function MetalKnob({ k, x, y, size = 40 }: { k: string; x: number; y: number; size?: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: size, height: size, touchAction: 'none' }} {...h}>
      <MetalKnobView size={size} t={t} />
    </div>
  );
});

export interface TickSliderProps extends Box {
  k: string;
  /** Number of tick positions (both sides). */
  ticks: number;
  /** Tick span: first and last tick y relative to the box top (cap travel). */
  tickTop: number;
  tickBottom: number;
  /** Only the end and centre ticks are long. */
  shortTicks?: boolean;
  /** Tick lengths left / right of the groove (px) and gap to the groove. */
  tickLen?: number;
  control?: Partial<ControlProps>;
}

/** Vertical slider with tick marks; the cap travels between the first and last tick. */
export const TickSlider = memo(function TickSlider({ k, x, y, w, h, ticks, tickTop, tickBottom, shortTicks, tickLen = 8, control }: TickSliderProps) {
  const p = useParam(k, control);
  const span = tickBottom - tickTop;
  const hnd = useControl({ travel: span, ...p.control }, 'vertical');
  const min = p.def.min, max = p.def.max;
  const t = Math.min(1, Math.max(0, (p.value - min) / (max - min || 1)));
  const zero = p.def.bipolar ? (0 - min) / (max - min) : 0;
  const cx = w / 2;
  const capY = tickBottom - t * span;
  const zeroY = tickBottom - zero * span;
  const capW = 11, capH = 22;
  const gTop = tickTop - 5, gBot = tickBottom + 5;
  const marks: ReactNode[] = [];
  for (let i = 0; i < ticks; i++) {
    const ty = Math.round(tickTop + (span * i) / (ticks - 1)) + 0.5;
    const end = i === 0 || i === ticks - 1;
    const long = !shortTicks || end || (ticks % 2 === 1 && i === (ticks - 1) / 2);
    const len = long ? tickLen : tickLen * 0.5;
    const col = end ? '#2b3239' : C.tick;
    const gap = 3.5;
    marks.push(<line key={'l' + i} x1={cx - gap - tickLen} y1={ty} x2={cx - gap - tickLen + len} y2={ty} stroke={col} strokeWidth={0.8} />);
    marks.push(<line key={'r' + i} x1={cx + gap + tickLen - len} y1={ty} x2={cx + gap + tickLen} y2={ty} stroke={col} strokeWidth={0.8} />);
  }
  const hollowA = Math.min(capY, zeroY), hollowB = Math.max(capY, zeroY);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        {marks}
        {/* groove: solid, hollow between zero and the value */}
        <rect x={cx - 2.25} y={gTop} width={4.5} height={gBot - gTop} rx={2.25} fill="#3a4148" />
        <rect x={cx - 1.75} y={gTop + 0.5} width={3.5} height={gBot - gTop - 1} rx={1.75} fill={C.groove} />
        {hollowB - hollowA > 1 && <rect x={cx - 1} y={hollowA} width={2} height={hollowB - hollowA} fill="rgba(98,108,120,0.95)" />}
      </svg>
      {/* centre line across the slider at the cap */}
      <div style={{ position: 'absolute', left: cx - 3.5 - tickLen, width: 2 * (3.5 + tickLen), top: capY - 0.5, height: 1, background: 'rgba(16,20,23,0.85)', zIndex: 2 }} />
      <div style={{
        position: 'absolute', left: cx - capW / 2, top: capY - capH / 2, width: capW, height: capH, borderRadius: 2.5,
        background: 'linear-gradient(180deg, #50585c 0%, #474e52 14%, #3c4246 32%, #2b3135 40%, #262b2f 49%, #1b1f22 51%, #343a3e 56%, #2a2f33 66%, #1e2326 82%, #15191c 100%)',
        boxShadow: '0 0 0 0.5px rgba(10,13,15,0.85), 0 0 2.5px 1px rgba(20,24,28,0.45)', zIndex: 1,
      }} />
    </div>
  );
});

/** Round LED switch with its caption below, bound to a 0/1 parameter. */
export function LedButton({ k, x, y, w, h, caption }: Box & { k: string; caption: string }) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  const toggle = () => { p.control.onBegin?.(); p.set(on ? p.def.min : p.def.max); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggle(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'ON' : 'OFF'}`)} onPointerLeave={clearHint}>
      <div style={{
        position: 'absolute', left: w / 2 - 5.5, top: 3, width: 11, height: 11, borderRadius: '50%', boxSizing: 'border-box',
        border: '1px solid #20262b',
        background: on
          ? 'radial-gradient(circle at 45% 40%, #ffe3a8 0%, #ffae34 45%, #c9761c 100%)'
          : 'radial-gradient(circle at 45% 38%, #a3abb0 0%, #737b80 45%, #4a5156 100%)',
        boxShadow: on ? '0 0 5px rgba(255,174,52,0.85)' : '0 1px 1px rgba(0,0,0,0.3)',
      }} />
      <div style={{ position: 'absolute', left: 0, top: 21, width: w, textAlign: 'center', fontSize: 9.5, fontWeight: 500, color: C.caption, letterSpacing: '0.04em' }}>{caption}</div>
    </div>
  );
}
