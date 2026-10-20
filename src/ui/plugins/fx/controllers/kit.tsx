// Shared widgets of the controller plugin editors (Peak, Formula, X-Y, X-Y-Z
// Controller, Control Surface), drawn after FL 2026's vector skin: the
// ring knob (dark body with a vertical gradient, track ring, value arc and
// dot pointer), the ticked "phase" knob, sober panels with a title tab, and
// LED switches. Geometry and colours are sampled from FL's screenshots.

import { memo, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

// FL 2026 wheels turn over 300 degrees (7 o'clock to 5 o'clock)
const START = -150;
const SWEEP = 300;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(cx, cy, r, lo);
  const [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let uid = 0;

export interface FlKnobViewProps {
  size: number;
  /** Position 0..1. */
  t: number;
  color: string;
  bipolar?: boolean;
  /** Extra drawing inside the body (centre at size/2), e.g. a tension curve. */
  inner?: (c: number, r: number) => ReactNode;
  /** No dot pointer (the inner drawing shows the value). */
  noDot?: boolean;
  disabled?: boolean;
}

/** FL 2026 ring knob. */
export function FlKnobView({ size: S, t, color, bipolar, inner, noDot, disabled }: FlKnobViewProps) {
  const c = S / 2;
  const k = S / 38; // FL's 38 px knob as the unit
  const rOut = c - 0.7 * k;
  const ringW = 2.1 * k;
  const rRing = rOut - 0.8 * k - ringW / 2;
  const rBody = rRing - ringW / 2 - 0.4 * k;
  const tc = Math.min(1, Math.max(0, t));
  const ang = START + SWEEP * tc;
  const from = bipolar ? 0 : START;
  const centred = bipolar && Math.abs(tc - 0.5) < 1e-6;
  const [dx, dy] = polar(c, c, rBody * 0.8, ang);
  const id = `flk${(uid = (uid + 1) % 1e6)}`;
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible', opacity: disabled ? 0.45 : 1 }}>
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#434a4e" />
          <stop offset="1" stopColor="#30353a" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7a828a" />
          <stop offset="0.5" stopColor="#535b61" />
          <stop offset="1" stopColor="#353c43" />
        </linearGradient>
      </defs>
      {bipolar && <line x1={c} y1={-2.2 * k} x2={c} y2={0.2 * k} stroke={centred ? color : '#2c3236'} strokeWidth={Math.max(1, 0.9 * k)} />}
      {/* track ring with its outlines */}
      <circle cx={c} cy={c} r={rOut - 0.4 * k} fill="none" stroke="#2c3236" strokeWidth={Math.max(0.8, 0.8 * k)} />
      <circle cx={c} cy={c} r={rRing} fill="none" stroke={`url(#${id}t)`} strokeWidth={ringW} />
      {Math.abs(ang - from) > 0.5 && <path d={arcPath(c, c, rRing, from, ang)} stroke={color} strokeWidth={ringW} fill="none" />}
      {/* body */}
      <circle cx={c} cy={c} r={rBody + 0.7 * k} fill="#262c30" />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id}b)`} />
      <path d={arcPath(c, c, rBody - 0.5 * k, -55, 55)} stroke="rgba(255,255,255,0.22)" strokeWidth={Math.max(0.8, 0.8 * k)} fill="none" />
      <path d={arcPath(c, c, rBody - 0.5 * k, 140, 220)} stroke="rgba(255,255,255,0.08)" strokeWidth={Math.max(0.8, 0.8 * k)} fill="none" />
      {inner?.(c, rBody)}
      {!noDot && <circle cx={dx} cy={dy} r={Math.max(1, 1.05 * k)} fill={color} />}
    </svg>
  );
}

/** FL's ticked knob without a ring (Peak Controller's LFO phase): line pointer, 16 tick marks. */
export function FlTickKnobView({ size: S, t, color }: { size: number; t: number; color: string }) {
  const c = S / 2;
  const k = S / 40;
  const rBody = 12.2 * k;
  const ang = 180 + 360 * Math.min(1, Math.max(0, t));
  const [p0x, p0y] = polar(c, c, rBody * 0.42, ang);
  const [p1x, p1y] = polar(c, c, rBody * 1.38, ang);
  const id = `flt${(uid = (uid + 1) % 1e6)}`;
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5c646b" />
          <stop offset="1" stopColor="#363d43" />
        </linearGradient>
      </defs>
      {Array.from({ length: 16 }, (_, i) => {
        const a = i * 22.5;
        const long = i % 4 === 0;
        const [x0, y0] = polar(c, c, rBody + (long ? 1.6 : 2.2) * k, a);
        const [x1, y1] = polar(c, c, rBody + (long ? 6.4 : 5.4) * k, a);
        return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#2f353a" strokeWidth={Math.max(1, (long ? 1.2 : 0.9) * k)} />;
      })}
      <ellipse cx={c} cy={c + 2.4 * k} rx={rBody + 0.4 * k} ry={rBody} fill="rgba(0,0,0,0.28)" />
      <circle cx={c} cy={c} r={rBody + 0.6 * k} fill="#262c30" />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id}b)`} />
      <path d={arcPath(c, c, rBody - 0.5 * k, -50, 50)} stroke="rgba(255,255,255,0.16)" strokeWidth={Math.max(0.8, 0.8 * k)} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={color} strokeWidth={Math.max(1.2, 1.4 * k)} />
    </svg>
  );
}

/** A tension curve inside a knob body (FL's PeakLogVis / LFOLogVis): Tension(x, k) from bottom left to top right. */
export function tensionInner(tension: number, color = '#dfe5e8') {
  return (c: number, r: number) => {
    const s = Math.sign(tension);
    const kk = (Math.pow(1001, Math.abs(tension) / 128) - 1) * 0.1;
    const f = (x: number) => (s === 0 || kk <= 0 ? x : s > 0 ? (kk + 1 - Math.pow(kk + 1, 1 - x)) / kk : (Math.pow(kk + 1, x) - 1) / kk);
    const w = r * 1.12, x0 = c - w / 2, y0 = c + w / 2;
    let d = '';
    for (let i = 0; i <= 24; i++) {
      const x = i / 24;
      d += `${i ? 'L' : 'M'}${(x0 + x * w).toFixed(2)} ${(y0 - f(x) * w).toFixed(2)}`;
    }
    return <path d={d} stroke={color} strokeWidth={Math.max(1, r * 0.09)} fill="none" strokeLinecap="round" />;
  };
}

type Box = { x: number; y: number };

/** A knob bound to plugin parameter `k`. */
export const FlKnob = memo(function FlKnob({ k, x, y, size = 38, color, tension, tick, control: over }: Box & {
  k: string; size?: number; color: string; tension?: boolean; tick?: boolean; control?: Partial<ControlProps>;
}) {
  const p = useParam(k, over);
  return <FlKnobControl x={x} y={y} size={size} color={color} tension={tension} tick={tick} control={p.control} bipolar={p.def.bipolar} />;
});

export function FlKnobControl({ x, y, size = 38, color, tension, tick, bipolar, control }: Box & {
  size?: number; color: string; tension?: boolean; tick?: boolean; bipolar?: boolean; control: ControlProps;
}) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      {tick ? <FlTickKnobView size={size} t={t} color={color} />
        : <FlKnobView size={size} t={t} color={color} bipolar={bipolar} noDot={tension}
          inner={tension ? tensionInner(control.value) : undefined} disabled={control.disabled} />}
    </div>
  );
}

/**
 * FL 2026 sober panel (TVectorPanel psSober): a slightly lighter box with a
 * 1 px dark outline and the caption in a tab cut into its top-left corner.
 */
export function SoberPanel({ x, y, w, h, title, tabW, children, style, colors }: Box & {
  w: number; h: number; title?: string; tabW?: number; children?: ReactNode; style?: CSSProperties;
  /** Panel, tab and outline colours (default: the Peak Controller's). */
  colors?: { bg: string; tab: string; line: string };
}) {
  const tw = tabW ?? (title ? Math.max(30, title.length * 7 + 16) : 0);
  const th = 19;
  const col = colors ?? { bg: '#444b4f', tab: '#3f454a', line: '#363c41' };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, ...style }}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill={col.bg} stroke={col.line} />
        {title && (
          <path d={`M0.5 0.5 H${tw + 0.5} L${tw - 9.5} ${th - 1} Q${tw - 10.5} ${th + 0.5} ${tw - 12.5} ${th + 0.5} H0.5 Z`} fill={col.tab} stroke={col.line} />
        )}
      </svg>
      {title && <div style={{ position: 'absolute', left: 6, top: 0, height: th, lineHeight: `${th}px`, fontSize: 11.5, color: '#dfe5e8', whiteSpace: 'nowrap' }}>{title}</div>}
      {children}
    </div>
  );
}

/** A small caption under a knob (TQuickLabel P_SmallBold). */
export function KnobLabel({ x, y, w, h = 11, children }: Box & { w: number; h?: number; children: ReactNode }) {
  return (
    <div className="fxk-abs" style={{ left: x - 4, top: y, width: w + 8, height: h, lineHeight: `${h}px`, textAlign: 'center', fontSize: 9.5, fontWeight: 500, letterSpacing: '-0.01em', color: '#d5dde2', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
      {children}
    </div>
  );
}

/** FL's check box with the LED after the caption (TVectorCheckBox, Ramp / Mute). */
export function LedSwitch({ x, y, w, h, caption, on, onToggle, color = '#ff6a3d', hint }: Box & {
  w: number; h: number; caption: string; on: boolean; onToggle: () => void; color?: string; hint?: string;
}) {
  const d = Math.round(h * 0.62);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(hint ?? `${caption}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span style={{ fontSize: 11.5, color: '#d5dde2' }}>{caption}</span>
      <span style={{
        width: d, height: d, borderRadius: '50%', flex: 'none', boxSizing: 'border-box',
        border: '1.5px solid #82888a',
        background: on ? `radial-gradient(circle at 45% 40%, #ffd0b8 0%, ${color} 55%, #a43720 100%)` : 'radial-gradient(circle at 45% 40%, #4b5055 0%, #2d3234 70%, #121515 100%)',
        boxShadow: on ? `0 0 4px ${color}` : 'inset 0 0 0 1px #121515',
      }} />
    </div>
  );
}
