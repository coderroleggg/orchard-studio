// Rotary knob. 270 degree sweep, optional bipolar arc (drawn from the centre).

import { memo } from 'react';
import { useControl, type ControlProps } from './control';

export interface KnobProps extends ControlProps {
  size?: number;
  bipolar?: boolean;
  arcColor?: string;
  className?: string;
  style?: React.CSSProperties;
}

const START = -135;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.01) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(cx, cy, r, lo);
  const [x1, y1] = polar(cx, cy, r, hi);
  const large = hi - lo > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export const Knob = memo(function Knob(props: KnobProps) {
  const { size = 24, bipolar = false, arcColor, className, style } = props;
  const min = props.min ?? 0, max = props.max ?? 1;
  const handlers = useControl(props, 'vertical');
  const t = (props.value - min) / (max - min);
  const angle = START + SWEEP * Math.min(1, Math.max(0, t));
  const c = size / 2;
  const rArc = c - 1.5;
  const rBody = c - 4;
  const zero = bipolar ? 0 : START;
  const [px, py] = polar(c, c, rBody - 1, angle);
  const [qx, qy] = polar(c, c, rBody * 0.35, angle);
  const gid = `kg${size}`;
  return (
    <svg
      className={'knob' + (className ? ' ' + className : '') + (props.disabled ? ' disabled' : '')}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: 'block', flex: 'none', touchAction: 'none', ...style }}
      {...handlers}
    >
      <defs>
        <radialGradient id={gid} cx="40%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#6d777f" />
          <stop offset="60%" stopColor="#4a535a" />
          <stop offset="100%" stopColor="#3a4248" />
        </radialGradient>
      </defs>
      <path d={arcPath(c, c, rArc, START, START + SWEEP)} stroke="var(--knob-ring)" strokeWidth={2.4} fill="none" strokeLinecap="round" />
      <path d={arcPath(c, c, rArc, zero, angle)} stroke={arcColor ?? 'var(--knob-arc)'} strokeWidth={2.4} fill="none" strokeLinecap="round" />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${gid})`} stroke="#22272b" strokeWidth={1} />
      <circle cx={c} cy={c} r={rBody - 1.2} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
      <line x1={qx} y1={qy} x2={px} y2={py} stroke="var(--knob-pointer)" strokeWidth={Math.max(1.4, size / 14)} strokeLinecap="round" />
    </svg>
  );
});
