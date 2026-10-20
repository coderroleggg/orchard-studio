// Reeverb 2's vector controls (FL 2026 skin): grey dome knobs in a dark ring
// with a muted pink value arc and pointer dot, slim faders with a pink fill
// below a glossy black cap, the MID / SIDE pill switch and the round TEMPO LED.

import { memo, useState, type CSSProperties } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

const START = -135;
const SWEEP = 270;

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

export interface RvKnobLook {
  arc?: string;
  ring?: string;
  dot?: string;
}

/** Static drawing of the knob for a normalised position t (0..1). */
export function RvKnobView({ size, t, bipolar, look, hot }: { size: number; t: number; bipolar?: boolean; look?: RvKnobLook; hot?: boolean }) {
  const S = size, c = S / 2;
  const arc = hot ? '#bc6d74' : look?.arc ?? '#9c8889';
  const ring = look?.ring ?? '#465157';
  const dot = hot ? '#cf737b' : look?.dot ?? '#a08b8e';
  const sw = S * 0.088;
  const rr = c - sw / 2 - 0.4;
  const rb = S * 0.385;
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const from = bipolar ? 0 : START;
  const [px, py] = polar(c, c, S * 0.3, ang);
  const id = `rvk${(uid = (uid + 1) % 1e6)}`;
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}b`} cx="50%" cy="22%" r="85%">
          <stop offset="0" stopColor="#66707a" />
          <stop offset="0.45" stopColor="#525c62" />
          <stop offset="1" stopColor="#363e43" />
        </radialGradient>
        <linearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#99a2a8" stopOpacity="0.95" />
          <stop offset="0.45" stopColor="#99a2a8" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* ring: dark outline, track, then the value arc */}
      <circle cx={c} cy={c} r={rr} fill="none" stroke="#353e43" strokeWidth={sw + 1.2} />
      <circle cx={c} cy={c} r={rr} fill="none" stroke={ring} strokeWidth={sw} />
      {Math.abs(ang - from) > 0.5 && <path d={arcPath(c, c, rr, from, ang)} stroke={arc} strokeWidth={sw} fill="none" />}
      {/* cradle shadow under the dome */}
      <ellipse cx={c} cy={c + S * 0.06} rx={rb + 0.6} ry={rb + 0.4} fill="#2b3236" />
      <circle cx={c} cy={c} r={rb} fill={`url(#${id}b)`} />
      <circle cx={c} cy={c} r={rb - 0.5} fill="none" stroke={`url(#${id}h)`} strokeWidth={1} />
      <circle cx={px} cy={py} r={Math.max(1, S * 0.036)} fill={dot} />
    </svg>
  );
}

export interface RvKnobProps {
  k: string;
  x: number;
  y: number;
  size?: number;
  look?: RvKnobLook;
  bipolar?: boolean;
  control?: Partial<ControlProps>;
}

/** A knob bound to plugin parameter `k`. */
export const RvKnob = memo(function RvKnob({ k, x, y, size = 36, look, bipolar, control }: RvKnobProps) {
  const p = useParam(k, control);
  return <RvKnobControl x={x} y={y} size={size} look={look} bipolar={bipolar ?? p.def.bipolar} control={p.control} />;
});

export function RvKnobControl({ x, y, size = 36, look, bipolar, control }: { x: number; y: number; size?: number; look?: RvKnobLook; bipolar?: boolean; control: ControlProps }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const [hot, setHot] = useState(false);
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}
      onPointerEnter={() => setHot(true)} onPointerLeave={() => { setHot(false); h.onPointerLeave?.(); }}>
      <RvKnobView size={size} t={t} bipolar={bipolar} look={look} hot={hot} />
    </div>
  );
}

/** Vertical fader (TVectorSlider) in Reeverb 2's style: ticks, slim groove, pink fill, glossy cap. */
export const RvFader = memo(function RvFader({ k, x, y, w, h, fill = '#9c8889' }: { k: string; x: number; y: number; w: number; h: number; fill?: string }) {
  const p = useParam(k);
  const capH = 24;
  const capW = 13;
  const travel = h - capH;
  const hnd = useControl({ travel, ...p.control }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const capTop = (1 - t) * travel;
  const cx = w / 2;
  const ticks: number[] = [];
  for (let i = 0; i <= 10; i++) ticks.push(Math.round(capH / 2 + (travel * i) / 10) + 0.5);
  const grooveTop = 9, grooveBot = h - 7;
  const capMid = capTop + capH / 2;
  return (
    <div className="fxk-abs fxk-slider" style={{ left: x, top: y, width: w, height: h }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>
          <linearGradient id={`rvf${k}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4c5458" />
            <stop offset="0.3" stopColor="#5f686b" />
            <stop offset="0.58" stopColor="#4c5458" />
            <stop offset="0.6" stopColor="#1f2324" />
            <stop offset="0.64" stopColor="#40484b" />
            <stop offset="0.8" stopColor="#252d30" />
            <stop offset="0.93" stopColor="#3b4347" />
            <stop offset="1" stopColor="#4f575a" />
          </linearGradient>
        </defs>
        {ticks.map((ty) => (
          <g key={ty} stroke="#5b6467" strokeWidth={1}>
            <line x1={0} y1={ty} x2={cx - 2.5} y2={ty} />
            <line x1={cx + 2.5} y1={ty} x2={w} y2={ty} />
          </g>
        ))}
        <rect x={cx - 1.5} y={grooveTop} width={3} height={grooveBot - grooveTop} rx={1.5} fill="#3c474c" />
        {capMid < grooveBot && <rect x={cx - 0.75} y={capMid} width={1.5} height={Math.max(0, grooveBot - 1 - capMid)} fill={fill} />}
        <rect x={cx - capW / 2} y={capTop + 0.5} width={capW} height={capH - 1} rx={2.5} fill={`url(#rvf${k})`} stroke="#30373b" strokeWidth={1} />
      </svg>
    </div>
  );
});

/** MID / SIDE pill switch (TSwitchSelector): thumb up = MID. */
export function MidSideSwitch({ x, y, side, onChange }: { x: number; y: number; side: boolean; onChange: (side: boolean) => void }) {
  const lab: CSSProperties = { position: 'absolute', left: 20, fontStyle: 'italic', fontSize: 11.5, fontWeight: 500, letterSpacing: '0.06em', cursor: 'default', pointerEvents: 'auto', textAlign: 'left' };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 45, height: 30 }}
      onPointerEnter={() => setHint(`Mid / side input: ${side ? 'Side' : 'Mid'}`)} onPointerLeave={clearHint}>
      <div className="rv2-pill" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(!side); } }}>
        <div className="rv2-pill-thumb" style={{ top: side ? 15 : 2 }} />
      </div>
      <div className="rv2-cap" style={{ ...lab, top: 0, color: '#b9c4ca' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(false); } }}>MID</div>
      <div className="rv2-cap" style={{ ...lab, top: 15, color: '#b9c4ca' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(true); } }}>SIDE</div>
    </div>
  );
}

/** Round LED push button (TEMPO). */
export function RoundLed({ x, y, on, hint, onToggle }: { x: number; y: number; on: boolean; hint: string; onToggle: () => void }) {
  return (
    <div className={'fxk-abs rv2-led' + (on ? ' on' : '')} style={{ left: x, top: y, width: 14, height: 14 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint} />
  );
}
