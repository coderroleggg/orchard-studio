// Low Lifter widgets: FL's newer vector knob (dark body whose half facing the
// indicator catches the light, bezel with optional band-coloured ring, seven
// scale ticks), the small LED switches, section panels with title bars, the
// thin bracket lines that tie a switch to its knob, and a small FFT for the
// spectrum display. Everything is drawn with SVG / canvas.

import { memo, type ReactNode } from 'react';
import { useControl } from '../../../widgets/control';
import { clearHint, setHint } from '../../../hint';
import { useParam } from '../../kit';

export const FONT = '"Avenir Next Condensed", "Bahnschrift SemiCondensed", "Roboto Condensed", "Arial Narrow", sans-serif';
export const LOW_RED = '#c8383b';
export const HIGH_GREEN = '#9be04c';

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

let kid = 0;

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

/** Static knob drawing; t = normalised position 0..1. */
export function LLKnobView({ size, t, ring, red, topMark }: { size: number; t: number; ring?: string; red?: boolean; topMark?: boolean }) {
  const S = size, c = S / 2;
  const ang = -135 + 270 * Math.min(1, Math.max(0, t));
  const id = `llk${(kid = (kid + 1) % 1e6)}`;
  const rTick0 = c - 0.4, rTick1 = c - S * 0.075;
  const rTrack = c - S * 0.05;
  const rBezel = S * 0.405;
  const rBody = S * 0.335;
  // the facet (half the body on the indicator side) is lit from above
  const lit = Math.pow((1 + Math.cos((ang * Math.PI) / 180)) / 2, 1.6);
  const facet = mix([66, 72, 76], [178, 186, 188], lit);
  const [f0x, f0y] = polar(c, c, rBody, ang - 90);
  const [f1x, f1y] = polar(c, c, rBody, ang + 90);
  const [p0x, p0y] = polar(c, c, S * 0.1, ang);
  const [p1x, p1y] = polar(c, c, rBody - 0.4, ang);
  const tickCol = red ? 'rgba(255,214,214,0.75)' : 'rgba(205,205,205,0.6)';
  const trackCol = red ? 'rgba(70,10,12,0.35)' : 'rgba(255,255,255,0.07)';
  const ptr = ring ?? '#f2f2f2';
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}b`} cx="50%" cy="40%" r="62%">
          <stop offset="0" stopColor="#3d4246" />
          <stop offset="1" stopColor="#272b2e" />
        </radialGradient>
        <linearGradient id={`${id}z`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5b6166" />
          <stop offset="1" stopColor="#1d2023" />
        </linearGradient>
      </defs>
      <circle cx={c} cy={c} r={rTrack} fill="none" stroke={trackCol} strokeWidth={1} />
      {[-135, -90, -45, 0, 45, 90, 135].map((a) => {
        const [x0, y0] = polar(c, c, rTick0, a);
        const [x1, y1] = polar(c, c, rTick1, a);
        return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke={tickCol} strokeWidth={0.9} />;
      })}
      {topMark && <line x1={c} y1={-S * 0.06} x2={c} y2={S * 0.06} stroke="rgba(220,220,220,0.7)" strokeWidth={1} />}
      <circle cx={c} cy={c + S * 0.025} r={rBezel + 0.8} fill="rgba(0,0,0,0.35)" />
      <circle cx={c} cy={c} r={rBezel} fill={`url(#${id}z)`} />
      {ring ? <circle cx={c} cy={c} r={rBezel - S * 0.035} fill="none" stroke={ring} strokeWidth={S * 0.07} />
        : <circle cx={c} cy={c} r={rBezel - S * 0.03} fill="none" stroke="#2a2e31" strokeWidth={S * 0.05} />}
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id}b)`} stroke="#15181a" strokeWidth={0.8} />
      <path d={`M${f0x.toFixed(2)} ${f0y.toFixed(2)} A${rBody} ${rBody} 0 0 1 ${f1x.toFixed(2)} ${f1y.toFixed(2)} Z`} fill={facet} opacity={0.92} />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={ptr} strokeWidth={Math.max(1.6, S * 0.05)} strokeLinecap="round" />
    </svg>
  );
}

/** A knob bound to parameter `k` at FL's form coordinates. */
export const LLKnob = memo(function LLKnob({ k, x, y, size, ring, red, topMark }: { k: string; x: number; y: number; size: number; ring?: string; red?: boolean; topMark?: boolean }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <LLKnobView size={size} t={t} ring={ring} red={red} topMark={topMark} />
    </div>
  );
});

/** FL's small LED check box (light = on) in a 15 x 14 control box. */
export const LLSwitch = memo(function LLSwitch({ k, x, y, dy = 0 }: { k: string; x: number; y: number; dy?: number }) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  const toggle = () => { p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 15, height: 14, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggle(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}>
      <div style={{
        position: 'absolute', left: 2, top: 4.5 + dy, width: 11, height: 5, borderRadius: 1,
        background: on ? 'linear-gradient(#f1f1f1, #cfcfcf)' : 'linear-gradient(#5f6669, #4e5457)',
        boxShadow: on ? '0 0 0 0.6px rgba(0,0,0,0.55)' : '0 0 0 0.6px rgba(0,0,0,0.6), inset 0 0.5px 0 rgba(255,255,255,0.08)',
      }} />
    </div>
  );
});

/** Section panel with its title bar (red for HARMONICS, dark grey otherwise). */
export function Section({ x, w, title, red, children }: { x: number; w: number; title: string; red?: boolean; children?: ReactNode }) {
  const top = 189, h = 88;
  return (
    <>
      <div className="fxk-abs" style={{
        left: x, top, width: w, height: h, borderRadius: '2px 2px 4px 4px',
        background: red
          ? 'linear-gradient(100deg, #7f2a2d 0%, #9a3034 30%, #a53538 100%)'
          : 'repeating-linear-gradient(0deg, rgba(255,255,255,0.018) 0px, rgba(255,255,255,0.018) 1px, rgba(0,0,0,0.018) 2px, rgba(0,0,0,0.018) 3px), linear-gradient(#474747, #3f3f3f)',
        boxShadow: 'inset 0 0 0 0.6px rgba(0,0,0,0.35)',
      }} />
      <div className="fxk-abs" style={{
        left: x, top, width: w, height: 16, lineHeight: '16px', textAlign: 'center',
        background: red ? 'linear-gradient(#8c2a2d, #84272a)' : 'linear-gradient(#3b3b3b, #353535)',
        borderBottom: `1.2px solid ${red ? '#5e1b1d' : '#262626'}`, borderRadius: '2px 2px 0 0',
        color: red ? '#efd4d4' : '#cfcfcf', fontFamily: FONT, fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em', pointerEvents: 'none',
      }}>{title}</div>
      {children}
    </>
  );
}

/** Caption in FL's light condensed capitals, centred on (cx, cy). */
export function Label({ cx, cy, children, red, size = 10.5 }: { cx: number; cy: number; children: ReactNode; red?: boolean; size?: number }) {
  return (
    <div className="fxk-abs" style={{
      left: cx - 50, top: cy - (size + 4) / 2, width: 100, height: size + 4, lineHeight: `${size + 4}px`, textAlign: 'center',
      fontFamily: FONT, fontSize: size, fontWeight: 600, color: red ? '#f0d6d6' : '#d6d6d6', letterSpacing: '0.02em',
      whiteSpace: 'nowrap', pointerEvents: 'none',
    }}>{children}</div>
  );
}

/** Thin L-shaped line from a switch to its knob. */
export function Bracket({ x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number }) {
  const l = Math.min(x0, x1), t = Math.min(y0, y1);
  return (
    <svg className="fxk-abs" style={{ left: l - 1, top: t - 1, width: Math.abs(x1 - x0) + 2, height: Math.abs(y1 - y0) + 2, pointerEvents: 'none', overflow: 'visible' }}>
      <path d={`M${x0 - l + 1} ${y0 - t + 1} V${y1 - t + 1} H${x1 - l + 1}`} stroke="#a3a3a3" strokeWidth={1} fill="none" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// FFT (radix 2, in place) for the spectrum display

export class FFT {
  readonly n: number;
  private cos: Float64Array;
  private sin: Float64Array;
  private rev: Uint32Array;
  readonly win: Float64Array;
  constructor(n: number) {
    this.n = n;
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }
  /** In-place transform of (re, im). */
  run(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}
