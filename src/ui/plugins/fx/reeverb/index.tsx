// Reeverb editor (FL: Fruity Reeverb, legacy; form 335 x 255): ten bevels in
// two columns, each with a wheel (46 x 40 at bevel + 2, 3), the caption bar
// (106 x 16 at bevel + 54, 0) and the value text (bevel + 55, 26). Colours and
// text metrics sampled from FL's manual screenshot (FL 2026 skin).

import { memo } from 'react';
import { useControl } from '../../../widgets/control';
import { FxPanel, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import './reeverb.css';

// FL's legacy wheel sweeps 300 degrees (measured on the manual screenshot)
const START = -150;
const SWEEP = 300;

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

const ARC = '#d4ffff';

/** FL's wheel (46 x 40): dark track ring with the cyan value arc, two-tone body, cyan pointer. */
function WheelView({ t }: { t: number }) {
  const cx = 23, cy = 20;
  const ringW = 3.8, rRing = 17.1, rBody = 13.9;
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const [p0x, p0y] = polar(cx, cy, rBody * 0.38, ang);
  const [p1x, p1y] = polar(cx, cy, rBody * 0.95, ang);
  // the darker half of the body turns slowly with the knob
  const shade = 180 - ang / 3;
  const [s0x, s0y] = polar(cx, cy, rBody, shade - 90);
  const [s1x, s1y] = polar(cx, cy, rBody, shade + 90);
  return (
    <svg width={46} height={40} viewBox="0 0 46 40" style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="rvlBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#56616a" />
          <stop offset="1" stopColor="#47515a" />
        </linearGradient>
      </defs>
      <circle cx={cx} cy={cy} r={rRing} fill="none" stroke="#3e464b" strokeWidth={ringW + 1.4} />
      <circle cx={cx} cy={cy} r={rRing} fill="none" stroke="#485157" strokeWidth={ringW} />
      {ang - START > 0.5 && <path d={arc(cx, cy, rRing, START, ang)} stroke={ARC} strokeWidth={ringW} fill="none" />}
      <circle cx={cx} cy={cy + 0.9} r={rBody + 0.7} fill="rgba(0,0,0,0.3)" />
      <circle cx={cx} cy={cy} r={rBody} fill="url(#rvlBody)" />
      <path d={`M${s0x} ${s0y} A${rBody} ${rBody} 0 0 1 ${s1x} ${s1y} Z`} fill="rgba(0,0,0,0.17)" />
      <path d={arc(cx, cy, rBody - 0.6, -70, 70)} stroke="rgba(255,255,255,0.09)" strokeWidth={1} fill="none" />
      <path d={arc(cx, cy, rBody - 0.6, 110, 250)} stroke="rgba(0,0,0,0.3)" strokeWidth={1.2} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={ARC} strokeWidth={2} />
    </svg>
  );
}

/** One bevel: wheel, caption bar and value text for parameter `k`. */
const Cell = memo(function Cell({ k, title, x, y }: { k: string; title: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const text = p.control.format ? p.control.format(p.value) : String(p.value);
  return (
    <div className="rvl-bevel" style={{ left: x, top: y }}>
      <div className="fxk-abs fxk-wheel" style={{ left: 2, top: 3, width: 46, height: 40 }} {...h}>
        <WheelView t={t} />
      </div>
      <div className="rvl-title">{title}</div>
      <div className="rvl-value">{text}</div>
    </div>
  );
});

const CELLS: [string, string, number, number][] = [
  ['lowCut', 'LOWCUT', 5, 5],
  ['highCut', 'HIGHCUT', 170, 5],
  ['predelay', 'PREDELAY', 5, 55],
  ['room', 'ROOM SIZE', 170, 55],
  ['diffusion', 'DIFFUSION', 5, 105],
  ['color', 'COLOR', 170, 105],
  ['decay', 'DECAY', 5, 155],
  ['damping', 'HIGH DAMPING', 170, 155],
  ['dry', 'DRY', 5, 205],
  ['reverb', 'REVERB', 170, 205],
];

function ReeverbEditor() {
  return (
    <FxPanel width={335} height={255} className="rvl-panel">
      {CELLS.map(([k, title, x, y]) => <Cell key={k} k={k} title={title} x={x} y={y} />)}
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'reeverb', Editor: ReeverbEditor };
