// Delay 3 editor widgets, drawn after FL 2026's vector skin (geometry and
// colours sampled from FL's manual screenshot at 1.5x): flat and brushed-metal
// knobs with a 270-degree value ring, LED switches, the pill selectors, the
// input fader, the smoothing slider, boxed captions and the distortion curve.

import type { ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

export const LIME = '#cdff6a';
const TRACK = '#646f75';
const SOCKET = '#4c565c';
const OUTLINE = '#4c575e';

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

/** FL's warning ring: lime up to `from`, then through orange (about 72 % of the way) to red. */
export function warnColor(t: number, from: number): string {
  if (t <= from) return LIME;
  const u = Math.min(1, (t - from) / (1 - from));
  const hue = 80 - 75 * u, light = 71 - 11 * u;
  return `hsl(${hue.toFixed(1)}, 100%, ${light.toFixed(1)}%)`;
}

let gid = 0;

export interface KnobViewProps {
  size: number;
  /** Normalised position 0..1. */
  t: number;
  look: 'flat' | 'metal';
  color?: string;
  bipolar?: boolean;
  /** Tempo-sync step dots around the ring (FL's TIME wheel). */
  dots?: number[];
}

/** Static knob drawing: socket + track + value ring, dark or brushed-metal body, pointer. */
export function KnobView({ size: S, t, look, color = LIME, bipolar, dots }: KnobViewProps) {
  const c = S / 2;
  const ringR = S * 0.466, ringW = Math.max(2.2, S * 0.062);
  const bodyR = S * 0.418;
  const tc = Math.min(1, Math.max(0, t));
  const ang = START + SWEEP * tc;
  const from = bipolar ? 0 : START;
  const id = `d3k${(gid = (gid + 1) % 1e6)}`;
  const flat = look === 'flat';
  const [p0x, p0y] = polar(c, c, bodyR * (flat ? 0.36 : 0.3), ang);
  const [p1x, p1y] = polar(c, c, bodyR * (flat ? 0.95 : 0.92), ang);
  // flat bodies: the lighter half turns with the knob (FL's two-tone dome)
  const shade = 180 - ang / 3;
  const [s0x, s0y] = polar(c, c, bodyR, shade - 90);
  const [s1x, s1y] = polar(c, c, bodyR, shade + 90);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}f`} cx="50%" cy="30%" r="70%">
          <stop offset="0" stopColor="#4a545a" />
          <stop offset="1" stopColor="#3e474c" />
        </radialGradient>
        <radialGradient id={`${id}m`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#475257" stopOpacity="1" />
          <stop offset="0.35" stopColor="#475257" stopOpacity="0.55" />
          <stop offset="1" stopColor="#475257" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}c`}><circle cx={c} cy={c} r={bodyR} /></clipPath>
      </defs>
      {/* socket ring (full circle), track and value arc */}
      <circle cx={c} cy={c} r={ringR} fill="none" stroke={OUTLINE} strokeWidth={ringW + 1.4} />
      <circle cx={c} cy={c} r={ringR} fill="none" stroke={SOCKET} strokeWidth={ringW} />
      <path d={arcPath(c, c, ringR, START, START + SWEEP)} stroke={TRACK} strokeWidth={ringW} fill="none" />
      {Math.abs(ang - from) > 0.3 && <path d={arcPath(c, c, ringR, from, ang)} stroke={color} strokeWidth={ringW} fill="none" />}
      {dots?.map((d, i) => {
        const [dx, dy] = polar(c, c, S * 0.535, START + SWEEP * d);
        return <circle key={i} cx={dx} cy={dy} r={Math.max(0.7, S * 0.013)} fill="#8a979e" />;
      })}
      {bipolar && (() => { const [dx, dy] = polar(c, c, S * 0.565, 0); return <circle cx={dx} cy={dy} r={Math.max(0.8, S * 0.02)} fill="#808e95" />; })()}
      {/* body */}
      <circle cx={c} cy={c + S * 0.012} r={bodyR + 0.7} fill="#2e363a" opacity={0.75} />
      {flat ? (
        <g>
          <circle cx={c} cy={c} r={bodyR} fill={`url(#${id}f)`} />
          <path d={`M${s0x} ${s0y} A${bodyR} ${bodyR} 0 0 1 ${s1x} ${s1y} Z`} fill="rgba(0,0,0,0.13)" />
          <path d={arcPath(c, c, bodyR - 0.5, -60, 60)} stroke="rgba(255,255,255,0.07)" strokeWidth={0.8} fill="none" />
        </g>
      ) : (
        <g clipPath={`url(#${id}c)`}>
          <foreignObject x={c - bodyR} y={c - bodyR} width={bodyR * 2} height={bodyR * 2}>
            <div style={{
              width: '100%', height: '100%', borderRadius: '50%',
              background: 'conic-gradient(from 0deg, #bac2c6 0deg, #6a757a 28deg, #4c575d 58deg, #40494e 90deg, #3a4348 125deg, #424b51 155deg, #737c81 180deg, #444d53 205deg, #393f45 240deg, #40494e 270deg, #4b5459 300deg, #6d787d 322deg, #8a9398 338deg, #bac2c6 360deg)',
            }} />
          </foreignObject>
          <circle cx={c} cy={c} r={bodyR} fill={`url(#${id}m)`} />
        </g>
      )}
      <circle cx={c} cy={c} r={bodyR} fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth={0.7} />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={color} strokeWidth={Math.max(1.1, S * 0.03)} strokeLinecap="butt" />
    </svg>
  );
}

interface Pos { x: number; y: number; size: number }

/** Knob control (drag / wheel / menus come from the shared control hook). */
export function KnobControl({ x, y, size, look, colorOf, dots, bipolar, control }: Pos & {
  look: 'flat' | 'metal'; colorOf?: (t: number) => string; dots?: number[]; bipolar?: boolean; control: ControlProps;
}) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <KnobView size={size} t={t} look={look} color={colorOf ? colorOf(t) : LIME} bipolar={bipolar} dots={dots} />
    </div>
  );
}

/** Knob bound to a parameter. */
export function Knob({ k, x, y, size, look, colorOf, dots, control }: Pos & {
  k: string; look: 'flat' | 'metal'; colorOf?: (t: number) => string; dots?: number[]; control?: Partial<ControlProps>;
}) {
  const p = useParam(k, control);
  return <KnobControl x={x} y={y} size={size} look={look} colorOf={colorOf} dots={dots} bipolar={p.def.bipolar} control={p.control} />;
}

/** FL's round LED switch with caption (TEMPO SYNC, KEEP PITCH). */
export function Led({ k, x, y, w, h, caption }: { k: string; x: number; y: number; w: number; h: number; caption: string }) {
  const p = useParam(k);
  const on = p.value > p.def.min;
  const toggle = () => { p.control.onBegin?.(); p.set(on ? p.def.min : p.def.max); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs d3-led" style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggle(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: 'Off', radio: true, checked: !on, onClick: () => on && toggle() },
          { label: 'On', radio: true, checked: on, onClick: () => !on && toggle() },
        ]);
      }}>
      <span className={'d3-led-dot' + (on ? ' on' : '')} />
      <span className="d3-led-cap">{caption}</span>
    </div>
  );
}

/**
 * FL's pill selector (TSwitchSelector): a rounded slot with a light ball at
 * the selected position and the option names beside it (click either).
 */
export function Pill({ k, x, y, trackW, h, labels, labelW, cellH }: {
  k: string; x: number; y: number; trackW: number; h: number; labels: string[]; labelW: number; cellH?: number;
}) {
  const p = useParam(k);
  const n = labels.length;
  const idx = Math.round(p.value - p.def.min);
  const cell = cellH ?? h / n;
  const pick = (i: number) => { if (i === idx) return; p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  const ball = trackW - 3;
  const pad = (h - cell * n) / 2;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: trackW + labelW, height: h }}
      onPointerEnter={() => setHint(`${p.def.name}: ${p.def.options?.[idx] ?? labels[idx] ?? ''}`)} onPointerLeave={clearHint}
      onWheel={(e) => { e.stopPropagation(); pick(Math.min(n - 1, Math.max(0, idx + (e.deltaY > 0 ? 1 : -1)))); }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, labels.map((o, i) => ({ label: o, checked: i === idx, radio: true, onClick: () => pick(i) } as MenuItem)));
      }}>
      <div className="d3-pill" style={{ left: 0, top: 0, width: trackW, height: h, borderRadius: trackW / 2 }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const f = (e.clientY - r.top) / r.height;
          pick(Math.min(n - 1, Math.max(0, Math.floor(((f * h - pad) / (cell * n)) * n))));
        }}>
        <div className="d3-pill-ball" style={{ left: 1.5, top: pad + idx * cell + (cell - ball) / 2, width: ball, height: ball }} />
      </div>
      {labels.map((o, i) => (
        <div key={i} className="d3-pill-label" style={{ left: trackW + 8.5, top: pad + i * cell + 1.2, height: cell, lineHeight: `${cell}px`, width: labelW - 8 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}>{o}</div>
      ))}
    </div>
  );
}

/** The INPUT wet fader (vertical, FL's cap with a lime line, ticks on both sides). */
export function InputFader({ k, x, y, w, h }: { k: string; x: number; y: number; w: number; h: number }) {
  const p = useParam(k);
  const capH = 23, capW = 18;
  const top = 5, bot = h - 13;
  const travel = bot - top - capH;
  const hnd = useControl({ travel, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min);
  const capY = top + (1 - t) * travel;
  const cx = w / 2;
  const ticks: ReactNode[] = [];
  const n = 21;
  for (let i = 0; i < n; i++) {
    const yy = top + capH / 2 + (i * travel) / (n - 1);
    const long = i % 5 === 0;
    ticks.push(<line key={`a${i}`} x1={long ? 3 : 7} x2={cx - 4} y1={yy} y2={yy} stroke="#3f484e" strokeWidth={0.7} />);
    ticks.push(<line key={`b${i}`} x1={cx + 4} x2={long ? w - 3 : w - 7} y1={yy} y2={yy} stroke="#3f484e" strokeWidth={0.7} />);
  }
  return (
    <div className="fxk-abs fxk-slider" style={{ left: x, top: y, width: w, height: h }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        {ticks}
        <line x1={cx} x2={cx} y1={capY + capH / 2} y2={bot} stroke={LIME} strokeWidth={1.4} />
        <g transform={`translate(${cx - capW / 2} ${capY})`}>
          <path d={`M2 0 H${capW - 2} L${capW} 3 V${capH - 4} L${capW - 4} ${capH} H4 L0 ${capH - 4} V3 Z`} fill="#2f373b" />
          <path d={`M2 1 H${capW - 2} L${capW - 1} 3.5 V${capH * 0.42} H1 V3.5 Z`} fill="#3d464b" />
          <path d={`M1 ${capH * 0.42} H${capW - 1} V${capH - 4.5} L${capW - 4.5} ${capH - 1} H4.5 L1 ${capH - 4.5} Z`} fill="#454e53" />
          <line x1={3} x2={capW - 3} y1={capH * 0.32} y2={capH * 0.32} stroke={LIME} strokeWidth={1} />
        </g>
      </svg>
    </div>
  );
}

/** The SMOOTHING slider: thin track with ticks, lime fill and a small round thumb. */
export function SmoothSlider({ k, x, y, w, h }: { k: string; x: number; y: number; w: number; h: number }) {
  const p = useParam(k);
  const thumb = 13;
  const travel = w - thumb;
  const hnd = useControl({ travel, ...p.control }, 'horizontal');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min);
  const tx = thumb / 2 + t * travel;
  const cy = h / 2;
  const ticks: ReactNode[] = [];
  for (let i = 0; i <= 10; i++) {
    const xx = thumb / 2 + (i * travel) / 10;
    ticks.push(<line key={i} x1={xx} x2={xx} y1={cy - 2.4} y2={cy + 2.4} stroke="#3f484e" strokeWidth={0.7} />);
  }
  return (
    <div className="fxk-abs fxk-slider" style={{ left: x, top: y, width: w, height: h }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        {ticks}
        <line x1={thumb / 2} x2={w - thumb / 2} y1={cy} y2={cy} stroke="#3f484e" strokeWidth={1} />
        <line x1={thumb / 2} x2={tx} y1={cy} y2={cy} stroke={LIME} strokeWidth={1.1} />
        <circle cx={tx} cy={cy + 0.4} r={thumb / 2} fill="#2b3236" />
        <circle cx={tx} cy={cy} r={thumb / 2 - 0.6} fill="url(#d3sl)" />
        <defs>
          <radialGradient id="d3sl" cx="50%" cy="30%" r="70%">
            <stop offset="0" stopColor="#5a646a" />
            <stop offset="1" stopColor="#2f373b" />
          </radialGradient>
        </defs>
        <line x1={tx} x2={tx} y1={cy - thumb / 2 + 1.5} y2={cy + thumb / 2 - 1.5} stroke={LIME} strokeWidth={0.9} />
      </svg>
    </div>
  );
}

/** Caption; `boxed` draws FL's outlined bevel (shown on modulated targets). */
export function Cap({ x, y, w, h = 15, children, boxed, size = 9.5 }: { x: number; y: number; w: number; h?: number; children: ReactNode; boxed?: boolean; size?: number }) {
  return (
    <div className={'fxk-abs d3-cap' + (boxed ? ' boxed' : '')} style={{ left: x, top: y, width: w, height: h, lineHeight: `${h - (boxed ? 2 : 0)}px`, fontSize: size }}>
      {children}
    </div>
  );
}
