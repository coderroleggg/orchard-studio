// Blood Overdrive knob: a dark glossy knob in a recessed arc track (open at
// the bottom, -155..+155 degrees) that fills with the accent colour, a short
// accent pointer on the black rim, and a darker half-disc that turns with
// the knob (FL's Blood Overdrive skin, drawn as SVG).

import { memo } from 'react';
import { useControl } from '../../../widgets/control';
import { useParam } from '../../kit';
import type { BoTheme } from './themes';

const A0 = -155;
const SWEEP = 310;

function pt(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Annular sector between radii r0 < r1 from angle a to b (degrees, clockwise from 12 o'clock). */
function sector(c: number, r0: number, r1: number, a: number, b: number): string {
  if (b - a < 0.05) return '';
  const large = b - a > 180 ? 1 : 0;
  const [x0, y0] = pt(c, c, r1, a), [x1, y1] = pt(c, c, r1, b);
  const [x2, y2] = pt(c, c, r0, b), [x3, y3] = pt(c, c, r0, a);
  const f = (v: number) => v.toFixed(2);
  return `M${f(x0)} ${f(y0)} A${r1} ${r1} 0 ${large} 1 ${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)} A${r0} ${r0} 0 ${large} 0 ${f(x3)} ${f(y3)} Z`;
}

export interface KnobGeom {
  size: number;
  track: [number, number];
  ring: [number, number];
  body: number;
  pointer: [number, number];
}

export const SMALL: KnobGeom = { size: 58, track: [23.3, 28], ring: [19.4, 22.8], body: 18.7, pointer: [20, 22.6] };
export const BIG: KnobGeom = { size: 120, track: [50.3, 59], ring: [45, 49.7], body: 44.3, pointer: [45.6, 49.6] };

let uid = 0;

export function BoKnobView({ g, t, theme }: { g: KnobGeom; t: number; theme: BoTheme }) {
  const S = g.size, c = S / 2;
  const tc = Math.min(1, Math.max(0, t));
  const ang = A0 + SWEEP * tc;
  const id = `bok${(uid = (uid + 1) % 1e6)}`;
  // darker lower part of the body: its edge tilts with the knob (+26 deg at 0, -26 deg at max) and sits
  // 0.36 body radii below the centre at the ends, 0.32 above at mid travel (FL's rendered knob frames)
  const tilt = (26 * (1 - 2 * tc) * Math.PI) / 180;
  const off = g.body * (0.36 - 0.68 * Math.sin(Math.PI * tc));
  const slope = Math.tan(tilt);
  const L = g.body * 1.2;
  const yl = c + off - slope * L, yr = c + off + slope * L;
  const poly = `${(c - L).toFixed(2)},${yl.toFixed(2)} ${(c + L).toFixed(2)},${yr.toFixed(2)} ${(c + L).toFixed(2)},${(c + L).toFixed(2)} ${(c - L).toFixed(2)},${(c + L).toFixed(2)}`;
  const [q0x, q0y] = pt(c, c, g.pointer[0], ang);
  const [q1x, q1y] = pt(c, c, g.pointer[1], ang);
  const pw = Math.max(1.1, S * 0.022);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={theme.bodyTop} />
          <stop offset="0.45" stopColor={theme.bodyMid} />
          <stop offset="1" stopColor={theme.bodyBot} />
        </linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#aeafaf" />
          <stop offset="0.16" stopColor="#8a8a8a" />
          <stop offset="0.3" stopColor="#1a1a1a" />
          <stop offset="1" stopColor="#0a0a0a" />
        </linearGradient>
        <radialGradient id={`${id}s`} cx="50%" cy="50%" r="50%">
          <stop offset="0.78" stopColor="rgba(8,8,8,0.92)" />
          <stop offset="0.9" stopColor="rgba(12,12,12,0.55)" />
          <stop offset="1" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
        <clipPath id={`${id}c`}><circle cx={c} cy={c} r={g.body} /></clipPath>
      </defs>
      {/* drop shadow under the knob */}
      <ellipse cx={c} cy={c + g.ring[1] * 0.11} rx={g.ring[1] + 1.4} ry={g.ring[1] * 1.08 + 2.4} fill={`url(#${id}s)`} />
      {/* arc track and value */}
      <path d={sector(c, g.track[0], g.track[1], A0, A0 + SWEEP)} fill={theme.track} stroke={theme.trackEdge} strokeWidth={0.7} />
      {tc > 0.001 && <path d={sector(c, g.track[0] + 0.35, g.track[1] - 0.35, A0, ang)} fill={theme.accent} />}
      {/* black rim with top highlight */}
      <circle cx={c} cy={c} r={g.ring[1]} fill={`url(#${id}r)`} />
      <circle cx={c} cy={c} r={g.ring[0] + 0.3} fill="#0d0d0d" />
      <circle cx={c} cy={c} r={g.ring[0]} fill="#3a3a3a" />
      {/* body */}
      <circle cx={c} cy={c} r={g.body} fill={`url(#${id}b)`} />
      <polygon points={poly} fill="rgba(0,0,0,0.26)" clipPath={`url(#${id}c)`} />
      <path d={`M${pt(c, c, g.body - 0.5, -62).map((v) => v.toFixed(2)).join(' ')} A${g.body - 0.5} ${g.body - 0.5} 0 0 1 ${pt(c, c, g.body - 0.5, 62).map((v) => v.toFixed(2)).join(' ')}`}
        stroke="rgba(255,255,255,0.16)" strokeWidth={0.9} fill="none" />
      {/* pointer */}
      <line x1={q0x} y1={q0y} x2={q1x} y2={q1y} stroke={theme.accent} strokeWidth={pw} />
    </svg>
  );
}

/** A Blood Overdrive knob bound to parameter `k`. */
export const BoKnob = memo(function BoKnob({ k, x, y, g, theme }: { k: string; x: number; y: number; g: KnobGeom; theme: BoTheme }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: g.size, height: g.size }} {...h}>
      <BoKnobView g={g} t={t} theme={theme} />
    </div>
  );
});
