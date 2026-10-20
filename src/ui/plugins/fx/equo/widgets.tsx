// EQUO's vector controls: the dark knob with a metal cap and an orange dot,
// round check boxes, flat blue buttons and section headers (drawn, not
// copied artwork).

import { memo, useId, type ReactNode } from 'react';
import { useParam } from '../../kit';
import { useControl, type ControlProps } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';

export const font = 'Arial, Helvetica, sans-serif';
export const narrow = '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';

export const EQ = {
  bg: '#3e464c',
  frame: '#4d555a',
  frameHi: '#5a646b',
  panelA: '#1b4775',
  panelB: '#142f4a',
  title: '#0c2745',
  gap: '#0c0c0c',
  column: '#113a63',
  modeOn: '#3d668f',
  modeOff: '#14365a',
  locked: '#d8261b',
  marker: '#9cc5ee',
  edit: '#ffb36b',
  btn: '#113a63',
  btnBorder: '#2b5886',
  btnText: '#9cc5ee',
  btnOn: '#85beed',
  btnOnText: '#ffffff',
  bank: '#0e1722',
  analyse: '#2e8068',
  analyseOn: '#43b08e',
  analyseText: '#bff2df',
  gear: '#59c9ff',
  header: '#586067',
  headerText: '#2f3840',
  caption: '#c3d3dd',
  dot: '#fbb03e',
} as const;

interface Box { x: number; y: number; w: number; h: number }

/** FL's EQUO knob: thin 300 degree track, dark bezel, brushed metal cap, orange position dot. */
export function EqKnobView({ size, t }: { size: number; t: number }) {
  const id = useId().replace(/:/g, '');
  const c = size / 2;
  const ang = ((-150 + 300 * Math.min(1, Math.max(0, t)) - 90) * Math.PI) / 180;
  const rT = size * 0.49, rB = size * 0.43, rC = size * 0.29, rD = size * 0.365;
  const a0 = ((-150 - 90) * Math.PI) / 180, a1 = ((150 - 90) * Math.PI) / 180;
  const arc = `M ${c + rT * Math.cos(a0)} ${c + rT * Math.sin(a0)} A ${rT} ${rT} 0 1 1 ${c + rT * Math.cos(a1)} ${c + rT * Math.sin(a1)}`;
  const disc = (r: number, style: React.CSSProperties) => (
    <div style={{ position: 'absolute', left: c - r, top: c - r, width: 2 * r, height: 2 * r, borderRadius: '50%', boxSizing: 'border-box', ...style }} />
  );
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>
          <linearGradient id={`t${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#24292d" />
            <stop offset="1" stopColor="#30373b" />
          </linearGradient>
        </defs>
        <path d={arc} fill="none" stroke={`url(#t${id})`} strokeWidth={Math.max(1, size * 0.032)} />
      </svg>
      {disc(rB + 0.6, { top: c - rB + 1.2, background: 'rgba(8,10,12,0.45)', filter: 'blur(0.9px)' })}
      {disc(rB, { background: 'radial-gradient(circle at 50% 18%, #565e63 0%, #30373b 40%, #1a1e21 75%, #111416 100%)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 1px rgba(0,0,0,0.4)' })}
      {disc(rC + 1.2, { background: '#0f1214' })}
      {disc(rC, { background: 'conic-gradient(from 20deg, #4a5054, #a3aaae 35deg, #5c6367 85deg, #3c4245 140deg, #6f777b 200deg, #a0a7ab 235deg, #555b5f 290deg, #4a5054 360deg)' })}
      {disc(rC, { background: 'radial-gradient(circle at 50% 40%, rgba(255,255,255,0.10), rgba(0,0,0,0.25) 100%)' })}
      {disc(size * 0.04, { left: c + rD * Math.cos(ang) - size * 0.04, top: c + rD * Math.sin(ang) - size * 0.04, background: EQ.dot, boxShadow: '0 0 2px rgba(251,176,62,0.6)' })}
    </div>
  );
}

export function EqKnobControl({ x, y, size, control }: { x: number; y: number; size: number; control: ControlProps }) {
  const hnd = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...hnd}>
      <EqKnobView size={size} t={(control.value - min) / (max - min || 1)} />
    </div>
  );
}

export const EqKnob = memo(function EqKnob({ k, x, y, size = 40 }: { k: string; x: number; y: number; size?: number }) {
  const p = useParam(k);
  return <EqKnobControl x={x} y={y} size={size} control={p.control} />;
});

export function Caption({ x, y, w, children, size = 8.6, color = EQ.caption, align = 'center' }: { x: number; y: number; w: number; children: ReactNode; size?: number; color?: string; align?: 'left' | 'center' | 'right' }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 11, lineHeight: '11px', textAlign: align, color, fontFamily: font, fontSize: size, fontWeight: 700, whiteSpace: 'nowrap', pointerEvents: 'none', letterSpacing: '0.02em' }}>
      {children}
    </div>
  );
}

/** Section header bar (MORPH / SETUP). */
export function Header({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 13, background: EQ.header, borderRadius: 1, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: 3, top: 0, lineHeight: '13px', fontFamily: narrow, fontWeight: 700, fontSize: 14.5, color: EQ.headerText, letterSpacing: '0.05em', textShadow: '0 1px 0 rgba(255,255,255,0.12)' }}>{children}</div>
    </div>
  );
}

/** Round check box with caption (TVectorCheckBox). */
export function EqCheck({ x, y, on, caption, hint, onToggle }: { x: number; y: number; on: boolean; caption: string; hint: string; onToggle: () => void }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 80, height: 11, cursor: 'default' }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}>
      <div style={{
        position: 'absolute', left: 0, top: 0.5, width: 10, height: 10, borderRadius: '50%', boxSizing: 'border-box', border: '1.4px solid #1d2225',
        background: on ? 'radial-gradient(circle at 45% 38%, #ffe0a3, #f6a12e 65%, #c47414)' : 'radial-gradient(circle at 45% 38%, #7d8387, #4a5054 70%, #3a4044)',
        boxShadow: on ? '0 0 4px rgba(251,176,62,0.55)' : '0 0.5px 0 rgba(255,255,255,0.08)',
      }} />
      <div style={{ position: 'absolute', left: 14, top: 0, lineHeight: '11px', fontFamily: font, fontWeight: 700, fontSize: 8.6, color: EQ.caption, whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>{caption}</div>
    </div>
  );
}

/** Flat blue button of the display panel (bank / curve / draw mode selectors). */
export function EqBtn({ x, y, w, h, on, children, hint, size = 11, onClick, dark, style }: Box & {
  on?: boolean; children: ReactNode; hint?: string; size?: number; onClick?: (e: React.PointerEvent) => void; dark?: boolean; style?: React.CSSProperties;
}) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 2, boxSizing: 'border-box',
      background: on ? EQ.btnOn : dark ? EQ.bank : EQ.btn, border: `1px solid ${on ? '#a9d4f5' : dark ? '#24323f' : EQ.btnBorder}`,
      color: on ? EQ.btnOnText : EQ.btnText, fontFamily: font, fontSize: size, lineHeight: `${h - 2}px`, textAlign: 'center', cursor: 'default', overflow: 'hidden', ...style,
    }}
      onPointerEnter={hint ? () => setHint(hint) : undefined} onPointerLeave={hint ? clearHint : undefined}
      onPointerDown={(e) => { if (e.button === 0 && onClick) { e.stopPropagation(); onClick(e); } }}
      onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  );
}

/** Settings gear icon. */
export function Gear({ size, color }: { size: number; color: string }) {
  const c = size / 2, ro = size * 0.47, ri = size * 0.34, teeth = 8;
  let d = '';
  for (let i = 0; i < teeth * 2; i++) {
    const a0 = (i / (teeth * 2)) * Math.PI * 2, a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? ro : ri;
    d += `${i === 0 ? 'M' : 'L'} ${c + r * Math.cos(a0)} ${c + r * Math.sin(a0)} L ${c + r * Math.cos(a1)} ${c + r * Math.sin(a1)} `;
  }
  return (
    <svg width={size} height={size}>
      <path d={d + 'Z'} fill={color} />
      <circle cx={c} cy={c} r={size * 0.16} fill="#16406a" />
    </svg>
  );
}
