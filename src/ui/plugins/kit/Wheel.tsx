// FL vector knob (TVectorWheel). Two looks seen in FL's effects:
// - 'flat': dark two-tone body, coloured value arc on a dark track ring and a
//   coloured pointer (Fruity Limiter, Delay 3's big knobs, Compressor);
// - 'metal': brushed-metal conic body with the same ring (Delay 3's small knobs).
// Geometry follows FL's 46 px wheel: 1 px outline, ~4.5 px ring, ~36 px body.

import { memo } from 'react';
import { useControl, type ControlProps } from '../../widgets/control';
import { useParam } from './context';
import { useNoScrollWheel } from './controls';

const START = -135;
const SWEEP = 270; // FL's vector wheels; legacy plugins use 300 (pass `sweep`)

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(cx, cy, r, lo);
  const [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export interface WheelViewProps {
  size: number;
  /** Normalised position 0..1. */
  t: number;
  color?: string;
  bipolar?: boolean;
  look?: 'flat' | 'metal' | 'classic';
  /** Track ring colour behind the arc. */
  track?: string;
  disabled?: boolean;
  /** Rotation range in degrees (default 270; FL's legacy knobs turn 300). */
  sweep?: number;
}

let gid = 0;

/** Static knob drawing (also used by editors that render knobs without a bound parameter). */
export function WheelView({ size, t, color = '#8fd14f', bipolar = false, look = 'flat', track = '#3d464b', disabled, sweep = SWEEP }: WheelViewProps) {
  const START = -sweep / 2, SWEEP_ = sweep;
  const S = size;
  const c = S / 2;
  const ringW = Math.max(2.4, S * 0.095);
  const rRing = c - 1 - ringW / 2;
  const rBody = rRing - ringW / 2 - Math.max(1, S * 0.03);
  const tc = Math.min(1, Math.max(0, t));
  const ang = START + SWEEP_ * tc;
  const from = bipolar ? 0 : START;
  const [p0x, p0y] = polar(c, c, rBody * (look === 'metal' ? 0.55 : 0.42), ang);
  const [p1x, p1y] = polar(c, c, rBody * 0.93, ang);
  // two-tone body: the darker half turns slowly with the knob
  const shade = 180 - ang / 3;
  const [s0x, s0y] = polar(c, c, rBody, shade - 90);
  const [s1x, s1y] = polar(c, c, rBody, shade + 90);
  const id = `kw${(gid = (gid + 1) % 1e6)}`;
  if (look === 'classic') {
    // older vector style (Balance, Stereo Enhancer...): dark sphere, thin arc, dot at the arc end
    const rS = S * 0.36, rA = S * 0.445, aw = Math.max(1.6, S * 0.05);
    const [dx, dy] = polar(c, c, S * 0.49, ang);
    const [q0x, q0y] = polar(c, c, rS * 0.25, ang);
    const [q1x, q1y] = polar(c, c, rS * 0.98, ang);
    return (
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible', opacity: disabled ? 0.45 : 1 }}>
        <defs>
          <radialGradient id={`${id}s`} cx="50%" cy="30%" r="75%">
            <stop offset="0" stopColor="#4c555b" />
            <stop offset="0.55" stopColor="#2c3236" />
            <stop offset="1" stopColor="#15191b" />
          </radialGradient>
        </defs>
        <circle cx={c} cy={c + S * 0.03} r={rS + 1.5} fill="rgba(0,0,0,0.45)" />
        <circle cx={c} cy={c} r={rS} fill={`url(#${id}s)`} stroke="#121517" strokeWidth={1} />
        <path d={arc(c, c, rS - 1, -60, 60)} stroke="rgba(255,255,255,0.18)" strokeWidth={1} fill="none" />
        {Math.abs(ang - from) > 0.5 && <path d={arc(c, c, rA, from, ang)} stroke={color} strokeWidth={aw} fill="none" strokeLinecap="round" />}
        <circle cx={dx} cy={dy} r={Math.max(1.6, S * 0.04)} fill={color} />
        <line x1={q0x} y1={q0y} x2={q1x} y2={q1y} stroke="#0e1112" strokeWidth={Math.max(1.5, S * 0.045)} />
      </svg>
    );
  }
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible', opacity: disabled ? 0.45 : 1 }}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3d454a" />
          <stop offset="1" stopColor="#2e363b" />
        </linearGradient>
        {look === 'metal' && (
          <radialGradient id={`${id}m`} cx="50%" cy="38%" r="70%">
            <stop offset="0" stopColor="#5a646a" />
            <stop offset="0.6" stopColor="#3a4247" />
            <stop offset="1" stopColor="#262d31" />
          </radialGradient>
        )}
      </defs>
      {/* ring: outline, track, value arc */}
      <path d={arc(c, c, rRing, START, START + SWEEP_)} stroke="#242b2f" strokeWidth={ringW + 1.6} fill="none" />
      <path d={arc(c, c, rRing, START, START + SWEEP_)} stroke={track} strokeWidth={ringW} fill="none" />
      <path d={arc(c, c, rRing, from, ang)} stroke={color} strokeWidth={ringW} fill="none" />
      {/* body */}
      <circle cx={c} cy={c + S * 0.025} r={rBody + 0.8} fill="rgba(0,0,0,0.35)" />
      <circle cx={c} cy={c} r={rBody} fill={look === 'metal' ? `url(#${id}m)` : `url(#${id}b)`} />
      {look === 'metal' ? (
        <>
          {[0, 60, 120, 180, 240, 300].map((a) => {
            const [x0, y0] = polar(c, c, rBody * 0.15, a);
            const [x1, y1] = polar(c, c, rBody * 0.98, a + 180);
            return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke="rgba(255,255,255,0.035)" strokeWidth={rBody * 0.5} />;
          })}
          <circle cx={c} cy={c} r={rBody - 0.5} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
        </>
      ) : (
        <>
          <path d={`M${s0x} ${s0y} A${rBody} ${rBody} 0 0 1 ${s1x} ${s1y} Z`} fill="rgba(0,0,0,0.16)" />
          <path d={arc(c, c, rBody - 0.6, -70, 70)} stroke="rgba(255,255,255,0.10)" strokeWidth={1} fill="none" />
          <path d={arc(c, c, rBody - 0.6, 110, 250)} stroke="rgba(0,0,0,0.35)" strokeWidth={1.2} fill="none" />
        </>
      )}
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={color} strokeWidth={Math.max(1.6, S * 0.05)} strokeLinecap="butt" />
    </svg>
  );
}

export interface WheelProps {
  /** Position and size in editor pixels (FL form Left / Top / Width). */
  x: number;
  y: number;
  size: number;
  color?: string;
  look?: 'flat' | 'metal' | 'classic';
  track?: string;
  disabled?: boolean;
  bipolar?: boolean;
  /** Rotation range in degrees (default 270). */
  sweep?: number;
}

/** A knob bound to plugin parameter `k`. */
export const Wheel = memo(function Wheel({ k, control: over, ...rest }: WheelProps & { k: string; control?: Partial<ControlProps> }) {
  const p = useParam(k, { ...(rest.disabled ? { disabled: true } : {}), ...(over ?? {}) });
  return <WheelControl {...rest} control={p.control} bipolar={rest.bipolar ?? p.def.bipolar} />;
});

/** A knob driven by explicit ControlProps (custom bindings). */
export function WheelControl({ x, y, size, color, look, track, disabled, bipolar, sweep, control }: WheelProps & { control: ControlProps }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={wheelRef} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <WheelView size={size} t={t} color={color} bipolar={bipolar} look={look} track={track} sweep={sweep} disabled={disabled || control.disabled} />
    </div>
  );
}
