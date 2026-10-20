// FL's generic editor for its Smart Electronix ports (class TTestPlug: Fruity
// Chorus, Flanger, Phaser): a grid of 160 x 45 bevels, each holding a 46 x 40
// vector knob, a caption tab and the parameter's value text. Shared by the
// chorus, flanger and phaser editors. Colours sampled from FL's screenshots.

import { memo, useId } from 'react';
import { useControl } from '../../../widgets/control';
import { FxPanel, useParam } from '../../kit';
import { setHint, clearHint } from '../../../hint';

const START = -135;
const SWEEP = 270;
const PANEL = '#444a4f';
const BEVEL = '#50585b';
const TAB = '#5a636a';
const CAPTION = '#c3d2d9';

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

// Facet shade of the clockwise half of the pointer-side facet, measured from FL's
// screenshots at these pointer angles (the counter-clockwise half mirrors it).
const FACET: [number, number, number, number][] = [
  [-135, 0x44, 0x4d, 0x53], [-108, 0x4d, 0x56, 0x5b], [-73, 0x3b, 0x45, 0x4a], [-54, 0x42, 0x4c, 0x51],
  [-46, 0x4a, 0x55, 0x5b], [-27, 0x64, 0x6e, 0x74], [-13.5, 0x6e, 0x78, 0x7e], [0, 0x6d, 0x77, 0x7d],
  [27, 0x47, 0x50, 0x56], [54, 0x3a, 0x44, 0x4a], [81, 0x4e, 0x57, 0x5c], [135, 0x34, 0x3a, 0x3e],
];

function facetRgb(a: number, gain: number): string {
  const x = Math.max(-135, Math.min(135, a));
  let i = 0;
  while (i < FACET.length - 2 && FACET[i + 1][0] < x) i++;
  const [a0, r0, g0, b0] = FACET[i], [a1, r1, g1, b1] = FACET[i + 1];
  const t = (x - a0) / (a1 - a0 || 1);
  const c = (u: number, v: number) => Math.max(0, Math.min(255, Math.round((u + (v - u) * t) * gain)));
  return `rgb(${c(r0, r1)},${c(g0, g1)},${c(b0, b1)})`;
}

/**
 * The TTestPlug knob (40 px high in a 46 px wide box): a 270-degree ring with
 * the value arc in the plugin's accent colour, and a top-lit body with a facet
 * on the pointer side (cut by a chord 0.32 R off centre, split by the pointer
 * into two halves shaded by their orientation) and a short pointer line.
 */
export function TestPlugKnobView({ t, color }: { t: number; color: string }) {
  const id = useId().replace(/:/g, '');
  const cx = 23, cy = 20;
  const rArc = 17.3, wArc = 4, R = 14.7;
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  // facet: chord perpendicular to the pointer at 0.32 R, split by the pointer line
  const d = 0.32 * R, half = (Math.acos(0.32) * 180) / Math.PI;
  const [mx, my] = polar(cx, cy, d, ang);
  const [ex, ey] = polar(cx, cy, R, ang);
  const [l0x, l0y] = polar(cx, cy, R, ang - half);
  const [l1x, l1y] = polar(cx, cy, R, ang + half);
  const ccw = `M${mx} ${my} L${l0x} ${l0y} A${R} ${R} 0 0 1 ${ex} ${ey} Z`;
  const cw = `M${mx} ${my} L${ex} ${ey} A${R} ${R} 0 0 1 ${l1x} ${l1y} Z`;
  // gradient along the pointer: rim slightly lighter than the chord
  const [gx0, gy0] = polar(0.5, 0.5, 0.5, ang);
  const [gx1, gy1] = polar(0.5, 0.5, 0.16, ang);
  const [p0x, p0y] = polar(cx, cy, R * 0.34, ang);
  const [p1x, p1y] = polar(cx, cy, R * 0.93, ang);
  return (
    <svg width={46} height={40} viewBox="0 0 46 40" style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#545e63" />
          <stop offset="1" stopColor="#414b51" />
        </linearGradient>
        {[['l', -ang], ['r', ang]].map(([k, a]) => (
          <linearGradient key={k as string} id={`${id}${k}`} x1={gx0} y1={gy0} x2={gx1} y2={gy1}>
            <stop offset="0" stopColor={facetRgb(a as number, 1.1)} />
            <stop offset="1" stopColor={facetRgb(a as number, 0.95)} />
          </linearGradient>
        ))}
      </defs>
      {/* ring track: dark outline with a faintly lighter groove */}
      <path d={arcPath(cx, cy, rArc, START, START + SWEEP)} stroke="#454d51" strokeWidth={wArc + 1.2} fill="none" />
      <path d={arcPath(cx, cy, rArc, START, START + SWEEP)} stroke="#525b5e" strokeWidth={wArc - 0.8} fill="none" />
      {/* value arc */}
      <path d={arcPath(cx, cy, rArc, START, ang)} stroke={color} strokeWidth={wArc} fill="none" />
      {/* body with its soft shadow, facet halves and rim light */}
      <circle cx={cx} cy={cy + 1.6} r={R + 0.6} fill="#353b3e" opacity={0.85} />
      <circle cx={cx} cy={cy} r={R} fill={`url(#${id}b)`} />
      <path d={ccw} fill={`url(#${id}l)`} />
      <path d={cw} fill={`url(#${id}r)`} />
      <path d={arcPath(cx, cy, R - 0.5, -55, 55)} stroke="rgba(255,255,255,0.16)" strokeWidth={0.8} fill="none" />
      <path d={arcPath(cx, cy, R - 0.4, 125, 235)} stroke="rgba(0,0,0,0.28)" strokeWidth={0.9} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={color} strokeWidth={1.6} strokeLinecap="butt" />
    </svg>
  );
}

/** A knob bound to parameter `k` at form position (x, y) (FL's TVectorWheel 46 x 40). */
export const TestPlugKnob = memo(function TestPlugKnob({ k, x, y, color }: { k: string; x: number; y: number; color: string }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 46, height: 40 }} {...h}>
      <TestPlugKnobView t={t} color={color} />
    </div>
  );
});

export interface TestPlugCell {
  /** Parameter key. */
  k: string;
  /** Caption shown in the tab (FL's label caption). */
  caption: string;
  /** Bevel position (form Left/Top); the bevel is 160 x 45. */
  bx: number;
  by: number;
  /** Knob position (form Left/Top of the wheel). */
  kx: number;
  ky: number;
  /** Value label position (form Left/Top, 102 x 14). */
  vx: number;
  vy: number;
  /** Override for the value text (FL's label text when it differs from the hint). */
  text?: (v: number) => string;
}

function Cell({ cell, color, textColor }: { cell: TestPlugCell; color: string; textColor: string }) {
  const p = useParam(cell.k);
  const txt = cell.text ? cell.text(p.value) : p.control.format?.(p.value) ?? String(p.value);
  return (
    <>
      <div className="fxk-abs" style={{ left: cell.bx, top: cell.by, width: 160, height: 45, background: BEVEL, borderRadius: 3 }} />
      <div className="fxk-abs" style={{
        left: cell.bx + 54, top: cell.by, width: 106, height: 16, background: TAB, borderRadius: 2,
        color: CAPTION, font: '600 8.9px/16px var(--font-ui)', letterSpacing: '0.045em', textAlign: 'center', whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}>{cell.caption}</div>
      <div className="fxk-abs" style={{
        left: cell.vx, top: cell.vy + 0.5, width: 102, height: 14, color: textColor,
        font: '400 10.3px/14px var(--font-ui)', letterSpacing: '-0.01em', whiteSpace: 'pre', overflow: 'hidden', cursor: 'default',
      }}
        onPointerEnter={() => setHint(`${p.def.name}: ${p.control.format?.(p.value) ?? p.value}`)} onPointerLeave={clearHint}>{txt}</div>
      <TestPlugKnob k={cell.k} x={cell.kx} y={cell.ky} color={color} />
    </>
  );
}

/** The whole TTestPlug editor: panel plus one bevel cell per parameter. */
export function TestPlugEditor({ width, height, cells, color, textColor }: {
  width: number; height: number; cells: TestPlugCell[]; color: string; textColor: string;
}) {
  return (
    <FxPanel width={width} height={height} style={{ background: PANEL }}>
      {cells.map((c) => <Cell key={c.k} cell={c} color={color} textColor={textColor} />)}
    </FxPanel>
  );
}

/** A cell from FL's form coordinates: bevel, wheel and value label (Left/Top). */
export function cell(k: string, caption: string, bx: number, by: number, kx: number, ky: number, vx: number, vy: number, text?: (v: number) => string): TestPlugCell {
  return { k, caption, bx, by, kx, ky, vx, vy, text };
}
