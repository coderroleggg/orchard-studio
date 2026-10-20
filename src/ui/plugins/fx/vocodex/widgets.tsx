// Vocodex widgets, drawn after FL 2026's screenshots (1.5x): dark knobs with a
// coloured value arc, the big metal WET wheel with its LED ring, thin mixer
// sliders with metal caps and tick rows, LED switches, numeric boxes, the
// ORDER segment bar, the PEAK / RMS pill and small icon buttons.

import { memo, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

export const VX = {
  bg: '#1b252a',
  text: '#c9d6db',
  textDim: '#8fa0a6',
  darkText: '#3b4447',
  magenta: '#d0386a',
  green: '#40bf91',
  blue: '#2fa0d4',
  orange: '#f2a12e',
  pink: '#c879e0',
  led: '#ff8a4a',
};

type Box = { x: number; y: number; w: number; h: number };

const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(cx, cy, r, lo), [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** FL 2026 dark knob: body, dark track ring with a coloured value arc and a light pointer. */
export function VxKnobView({ size, t, color, bipolar }: { size: number; t: number; color: string; bipolar?: boolean }) {
  const S = size, c = S / 2;
  const rr = S * 0.45, rw = Math.max(2, S * 0.1), rb = S * 0.36;
  const tc = Math.min(1, Math.max(0, t));
  const ang = -140 + 280 * tc;
  const from = bipolar ? 0 : -140;
  const [p0x, p0y] = polar(c, c, rb * 0.25, ang), [p1x, p1y] = polar(c, c, rb * 0.95, ang);
  return (
    <svg width={S} height={S} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`vk${S}`} cx="45%" cy="35%" r="70%">
          <stop offset="0" stopColor="#5c6266" />
          <stop offset="0.7" stopColor="#3b4043" />
          <stop offset="1" stopColor="#2b2f31" />
        </radialGradient>
      </defs>
      <path d={arc(c, c, rr, -140, 140)} stroke="#2a3134" strokeWidth={rw} fill="none" />
      <path d={arc(c, c, rr, from, ang)} stroke={color} strokeWidth={rw} fill="none" />
      <circle cx={c} cy={c + S * 0.03} r={rb + 1} fill="rgba(0,0,0,0.45)" />
      <circle cx={c} cy={c} r={rb} fill={`url(#vk${S})`} stroke="#1b1f21" strokeWidth={0.8} />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={color} strokeWidth={Math.max(1.2, S * 0.05)} strokeLinecap="round" />
    </svg>
  );
}

export const VxKnob = memo(function VxKnob({ k, x, y, size, color, control }: { k: string; x: number; y: number; size: number; color: string; control?: Partial<ControlProps> }) {
  const p = useParam(k, control);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: size, height: size, touchAction: 'none' }} {...h}>
      <VxKnobView size={size} t={t} color={color} bipolar={p.def.bipolar} />
    </div>
  );
});

/** The big metal WET wheel with a ring of blue LED segments. */
export const WetKnob = memo(function WetKnob({ x, y, size }: { x: number; y: number; size: number }) {
  const p = useParam('wet');
  const h = useControl({ travel: 260, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const S = size, c = S / 2;
  const segs: ReactNode[] = [];
  const N = 30;
  for (let i = 0; i < N; i++) {
    const a = -140 + (280 * (i + 0.5)) / N;
    const on = (i + 0.5) / N <= t + 1e-9;
    const [x0, y0] = polar(c, c, S * 0.43, a), [x1, y1] = polar(c, c, S * 0.49, a);
    segs.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={on ? '#3fb4e8' : '#3a4448'} strokeWidth={S * 0.055} />);
  }
  const ang = -140 + 280 * Math.min(1, Math.max(0, t));
  const [dx, dy] = polar(c, c, S * 0.31, ang);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: S, height: S, touchAction: 'none' }} {...h}>
      <svg width={S} height={S} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id="vxwet" cx="40%" cy="35%" r="75%">
            <stop offset="0" stopColor="#c9cfd2" />
            <stop offset="0.55" stopColor="#8d9599" />
            <stop offset="1" stopColor="#5c6468" />
          </radialGradient>
        </defs>
        {segs}
        <circle cx={c} cy={c} r={S * 0.4} fill="#1c2226" />
        <circle cx={c} cy={c} r={S * 0.36} fill="url(#vxwet)" stroke="#2c3337" strokeWidth={1} />
        {[0, 45, 90, 135].map((a) => {
          const [x0, y0] = polar(c, c, S * 0.36, a), [x1, y1] = polar(c, c, S * 0.36, a + 180);
          return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke="rgba(255,255,255,0.05)" strokeWidth={S * 0.12} />;
        })}
        <circle cx={dx} cy={dy} r={S * 0.035} fill="#3fc6ff" />
      </svg>
    </div>
  );
});

/** Thin mixer slider (TVectorSlider in the metal panel) with tick rows and a metal cap. */
export const VxSlider = memo(function VxSlider({ k, x, y, w, h, fill, ticks = 9 }: Box & { k: string; fill?: string; ticks?: number }) {
  const p = useParam(k);
  const capH = 9, top = 4, bot = h - 4;
  const span = bot - top - capH;
  const hnd = useControl({ travel: span, ...p.control }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const capY = top + (1 - t) * span;
  const cx = w / 2;
  const marks: ReactNode[] = [];
  for (let i = 0; i < ticks; i++) {
    const ty = Math.round(top + capH / 2 + (span * i) / (ticks - 1)) + 0.5;
    marks.push(<line key={'a' + i} x1={0} y1={ty} x2={cx - 3} y2={ty} stroke="rgba(40,48,50,0.55)" strokeWidth={0.7} />);
    marks.push(<line key={'b' + i} x1={cx + 3} y1={ty} x2={w} y2={ty} stroke="rgba(40,48,50,0.55)" strokeWidth={0.7} />);
  }
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', overflow: 'visible' }}>
        {marks}
        <rect x={cx - 1.5} y={top} width={3} height={bot - top} rx={1.5} fill="#2b3134" />
        {fill && t > 0 && <rect x={cx - 0.75} y={capY + capH / 2} width={1.5} height={bot - (capY + capH / 2)} fill={fill} />}
      </svg>
      <div style={{
        position: 'absolute', left: cx - 5.5, top: capY, width: 11, height: capH, borderRadius: 1.5,
        background: 'repeating-linear-gradient(180deg, #5b6265 0px, #5b6265 1px, #3c4245 1px, #3c4245 2px)',
        boxShadow: '0 0 0 0.5px #1d2224, 0 1px 2px rgba(0,0,0,0.5)',
      }} />
    </div>
  );
});

/** Round LED switch with a caption (TVectorCheckBox), bound to a boolean state field or a callback. */
export function VxLed({ x, y, w, h, caption, on, onToggle, hint, dark, size = 10 }: Box & { caption?: string; on: boolean; onToggle: () => void; hint?: string; dark?: boolean; size?: number }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => hint && setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span style={{
        width: size, height: size, borderRadius: '50%', flex: 'none', boxSizing: 'border-box', border: '1px solid #20282b',
        background: on ? 'radial-gradient(circle at 45% 40%, #ffd2b0 0%, #ff8a4a 50%, #c25220 100%)' : 'radial-gradient(circle at 45% 40%, #5e676b, #353c3f)',
        boxShadow: on ? '0 0 4px rgba(255,138,74,0.8)' : 'inset 0 1px 1px rgba(0,0,0,0.4)',
      }} />
      {caption && <span style={{ fontSize: 9.5, fontWeight: 600, color: dark ? VX.darkText : VX.text, whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>{caption}</span>}
    </div>
  );
}

/** Numeric box (TVectorDigiWheel): drag vertically or use the wheel; right-click for a menu. */
export function VxDigi({ x, y, w, h, value, min, max, text, onChange, hint, light, onMenu }: Box & {
  value: number; min: number; max: number; text?: string; onChange: (v: number) => void; hint: string; light?: boolean;
  onMenu?: (e: React.MouseEvent) => void;
}) {
  const ctl: ControlProps = {
    value, min, max, defaultValue: value, step: 1, label: hint, format: () => text ?? String(value),
    onChange: (v) => onChange(Math.round(v)),
  };
  const hnd = useControl({ travel: Math.max(60, (max - min) * 4), ...ctl }, 'vertical');
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, boxSizing: 'border-box',
      background: light ? 'linear-gradient(180deg, #e9eff0, #c8d0d2)' : 'linear-gradient(180deg, #3a4e5a, #2c3c46)',
      border: `1px solid ${light ? '#8a9497' : '#1a2328'}`, borderRadius: 1,
      color: light ? '#20272a' : '#e6eef2', fontSize: Math.round(h * 0.62), lineHeight: `${h - 2}px`, textAlign: 'right',
      paddingRight: 4, touchAction: 'none', cursor: 'ns-resize', fontVariantNumeric: 'tabular-nums',
    }} {...hnd} onContextMenu={(e) => { e.preventDefault(); onMenu?.(e); }}>
      {text ?? value}
    </div>
  );
}

/** Small square icon button (FL's TQuickBtn in the dark area). */
export function VxIconBtn({ x, y, w, h, children, active, onClick, hint }: Box & { children: ReactNode; active?: boolean; onClick: (e: React.PointerEvent) => void; hint?: string }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, boxSizing: 'border-box', borderRadius: 2,
      background: active ? 'linear-gradient(180deg, #6b7e86, #4f5f66)' : 'linear-gradient(180deg, #3d4a50, #2c373c)',
      border: '1px solid #151c1f', display: 'flex', alignItems: 'center', justifyContent: 'center', color: active ? '#ffffff' : '#d5e0e4', cursor: 'default',
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>{children}</div>
  );
}

export function Snowflake({ size = 14, color = '#e8f2f6' }: { size?: number; color?: string }) {
  const arms = [0, 60, 120];
  return (
    <svg width={size} height={size} viewBox="-8 -8 16 16">
      {arms.map((a) => (
        <g key={a} transform={`rotate(${a})`} stroke={color} strokeWidth={1.2} strokeLinecap="round">
          <line x1={0} y1={-7} x2={0} y2={7} />
          <line x1={0} y1={-4.5} x2={-2} y2={-6.5} /><line x1={0} y1={-4.5} x2={2} y2={-6.5} />
          <line x1={0} y1={4.5} x2={-2} y2={6.5} /><line x1={0} y1={4.5} x2={2} y2={6.5} />
        </g>
      ))}
    </svg>
  );
}

export function Caption({ x, y, w, h = 11, children, color = VX.text, size = 9.5, align = 'center', italic, weight = 600 }: Omit<Box, 'h'> & {
  h?: number; children: ReactNode; color?: string; size?: number; align?: 'left' | 'center' | 'right'; italic?: boolean; weight?: number;
}) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, lineHeight: `${h}px`, fontSize: size, color, textAlign: align, fontWeight: weight,
      fontStyle: italic ? 'italic' : undefined, whiteSpace: 'nowrap', pointerEvents: 'none', letterSpacing: '0.02em',
    }}>{children}</div>
  );
}
