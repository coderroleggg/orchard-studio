// Multiband Compressor widgets drawn after FL's vector skin: tick-ring wheels
// (band and master controls), arc wheels (crossover frequencies), the A / M / B
// band state selector, the meter IN / OUT buttons, the IIR / FIR switch, the
// LIMITER check box, the visual SPEED slider and the peak meters.

import type { CSSProperties, ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

type Box = { x: number; y: number; w: number; h: number };

export const C = {
  panel: '#3f4649',
  bevel: '#555b5e',
  bar: '#5b6164',
  label: '#d9e0e3',
  dim: '#a4aeb1',
  track: '#495155',
  tick: '#a7afb2',
  redTick: '#a88c8c',
  redTrack: '#564b4c',
  arc: '#bcc2c5',
  meterBg: '#2e3639',
  meterEdge: '#232a2d',
  meter: '#c8ff3c',
  peak: '#b89a3e',
  comp: '#c4301d',
  low: '#f07b6e',
  mid: '#e36ae6',
  high: '#6f9cff',
};

export const abs = (b: Box, extra?: CSSProperties): CSSProperties => ({ position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h, boxSizing: 'border-box', ...extra });

/** Caption (FL's QuickLabels: small condensed capitals). */
export function Cap({ x, y, w, h = 9, children, size = 10, color = C.label, align = 'center', style }: Omit<Box, 'h'> & { h?: number; children: ReactNode; size?: number; color?: string; align?: 'left' | 'center' | 'right'; style?: CSSProperties }) {
  return (
    <div style={abs({ x: x - 8, y: y - 3, w: w + 16, h: h + 6 }, { fontSize: size, lineHeight: `${h + 6}px`, color, textAlign: align, whiteSpace: 'nowrap', pointerEvents: 'none', fontStretch: 'condensed', letterSpacing: '0.01em', ...style })}>{children}</div>
  );
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(cx, cy, r, lo), [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let gid = 0;

/** The dark knob body with its white pointer. */
function Body({ c, r, ang, id }: { c: number; r: number; ang: number; id: string }) {
  const [p0x, p0y] = polar(c, c, r * 0.32, ang), [p1x, p1y] = polar(c, c, r * 0.9, ang);
  return (
    <>
      <defs>
        <radialGradient id={id} cx="45%" cy="32%" r="75%">
          <stop offset="0" stopColor="#4b5458" />
          <stop offset="0.55" stopColor="#30373b" />
          <stop offset="1" stopColor="#1f2528" />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c + 1} r={r + 0.8} fill="rgba(0,0,0,0.45)" />
      <circle cx={c} cy={c} r={r} fill={`url(#${id})`} stroke="#1a1f22" strokeWidth={0.8} />
      <path d={arcPath(c, c, r - 0.8, -60, 60)} stroke="rgba(255,255,255,0.12)" strokeWidth={0.9} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#f3f6f7" strokeWidth={Math.max(1.8, r * 0.2)} strokeLinecap="round" />
    </>
  );
}

/** FL's tick-ring wheel (TVectorWheel, band controls): seven ticks over a dark 270 degree track. */
export function TickWheelView({ size, t, red }: { size: number; t: number; red?: boolean }) {
  const S = size, c = S / 2;
  const ang = -135 + 270 * Math.min(1, Math.max(0, t));
  const rTrack = c - 3.2;
  const id = `mbk${(gid = (gid + 1) % 1e6)}`;
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <path d={arcPath(c, c, rTrack, -135, 135)} stroke={red ? C.redTrack : C.track} strokeWidth={4.2} fill="none" />
      {[-135, -90, -45, 0, 45, 90, 135].map((a) => {
        const [x0, y0] = polar(c, c, rTrack - 3.4, a), [x1, y1] = polar(c, c, rTrack + 2.6, a);
        return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke={red ? C.redTick : C.tick} strokeWidth={1.3} />;
      })}
      <Body c={c} r={S * 0.29} ang={ang} id={id} />
    </svg>
  );
}

/** FL's arc wheel (crossover frequencies): a light value arc over the dark track. */
export function ArcWheelView({ size, t }: { size: number; t: number }) {
  const S = size, c = S / 2;
  const ang = -135 + 270 * Math.min(1, Math.max(0, t));
  const r = c - 3.6;
  const id = `mba${(gid = (gid + 1) % 1e6)}`;
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <path d={arcPath(c, c, r, -135, 135)} stroke={C.track} strokeWidth={6.5} fill="none" />
      <path d={arcPath(c, c, r, -135, ang)} stroke={C.arc} strokeWidth={6.5} fill="none" />
      <Body c={c} r={S * 0.3} ang={ang} id={id} />
    </svg>
  );
}

function KnobBox({ x, y, size, control, children, hint }: { x: number; y: number; size: number; control: ControlProps; children: ReactNode; hint?: string }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  return (
    <div {...h} style={abs({ x, y, w: size, h: size }, { cursor: 'default', touchAction: 'none' })}
      onPointerEnter={hint ? () => setHint(hint) : undefined}>
      {children}
    </div>
  );
}

/** A tick-ring wheel bound to parameter `k`. */
export function TickWheel({ k, x, y, size = 40, red }: { k: string; x: number; y: number; size?: number; red?: boolean }) {
  const p = useParam(k);
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return <KnobBox x={x} y={y} size={size} control={p.control}><TickWheelView size={size} t={t} red={red} /></KnobBox>;
}

/**
 * A crossover wheel bound to `k`; it snaps to `partner` (the neighbouring band's
 * cut-off) when the two cross, as FL's ("perfectly crossed" bands).
 */
export function FreqWheel({ k, partner, x, y, size = 36, onTouch }: { k: string; partner: string; x: number; y: number; size?: number; onTouch: () => void }) {
  const p = useParam(k);
  const q = useParam(partner);
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const SNAP = 120;
  const control: ControlProps = {
    ...p.control,
    onBegin: () => { onTouch(); p.control.onBegin?.(); },
    onChange: (v) => { onTouch(); p.set(Math.abs(v - q.value) <= SNAP ? q.value : v); },
  };
  return <KnobBox x={x} y={y} size={size} control={control}><ArcWheelView size={size} t={t} /></KnobBox>;
}

/** The A / M / B band state selector (ON, muted, bypassed). */
export function StateSelector({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const cur = Math.round(p.value);
  const on = ['#ffb032', '#ff4b55', '#e4eef1'];
  return (
    <div style={abs({ x, y, w: 51, h: 13 }, { background: '#898f92', display: 'flex', gap: 1, padding: 1 })}>
      {['A', 'M', 'B'].map((l, i) => (
        <div key={l} style={{ flex: 1, background: cur === i ? on[i] : '#a3aaac', color: cur === i ? 'rgba(60,40,10,0.55)' : '#7f878a', fontSize: 10, lineHeight: '11px', textAlign: 'center', fontWeight: 600, cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); } }}
          onPointerEnter={() => setHint(`${p.def.name}: ${['ON', 'muted', 'bypassed'][i]}`)} onPointerLeave={clearHint}>{l}</div>
      ))}
    </div>
  );
}

/** Meter IN / OUT button. */
export function IoButton({ x, y, out, onToggle }: { x: number; y: number; out: boolean; onToggle: () => void }) {
  return (
    <div style={abs({ x, y, w: 18, h: 12 }, { background: '#3f494b', border: `1px solid ${C.dim}`, color: C.dim, fontSize: 7.5, lineHeight: '10px', textAlign: 'center', cursor: 'default', letterSpacing: '0.02em', fontWeight: 600 })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint('Input / output')} onPointerLeave={clearHint}>{out ? 'OUT' : 'IN'}</div>
  );
}

/** The IIR / FIR toggle (Filter type). */
export function FilterSwitch({ x, y }: { x: number; y: number }) {
  const p = useParam('filterType');
  const fir = p.value >= 0.5;
  const pick = () => { p.control.onBegin?.(); p.set(fir ? 0 : 1); p.control.onEnd?.(); };
  return (
    <div style={abs({ x, y, w: 34, h: 30 }, { cursor: 'default' })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(); } }}
      onPointerEnter={() => setHint(`Filter type: ${fir ? 'LP FIR' : 'BW IIR'}`)} onPointerLeave={clearHint}>
      <div style={abs({ x: 0, y: 1, w: 13, h: 28 }, { background: '#262c2f', borderRadius: 7, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)' })} />
      <div style={abs({ x: 0.5, y: fir ? 16 : 1.5, w: 12, h: 12 }, { borderRadius: '50%', background: 'radial-gradient(circle at 45% 35%, #e6eaec, #b7bdc0 70%, #9aa1a4)', boxShadow: '0 1px 2px rgba(0,0,0,0.5)' })} />
      <div style={abs({ x: 16, y: 0, w: 20, h: 14 }, { color: C.label, fontSize: 10, lineHeight: '14px', pointerEvents: 'none' })}>IIR</div>
      <div style={abs({ x: 16, y: 15, w: 20, h: 14 }, { color: C.label, fontSize: 10, lineHeight: '14px', pointerEvents: 'none' })}>FIR</div>
    </div>
  );
}

/** The LIMITER check box: caption over a round LED. */
export function LimiterCheck({ x, y }: { x: number; y: number }) {
  const p = useParam('limiter');
  const on = p.value >= 0.5;
  return (
    <div style={abs({ x, y, w: 47, h: 34 }, { cursor: 'default' })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`Limiter: ${on ? 'ON' : 'OFF'}`)} onPointerLeave={clearHint}>
      <div style={abs({ x: -4, y: 1, w: 55, h: 12 }, { color: C.label, fontSize: 10.5, lineHeight: '12px', textAlign: 'center', pointerEvents: 'none' })}>LIMITER</div>
      <div style={abs({ x: 16, y: 18, w: 15, h: 15 }, {
        borderRadius: '50%',
        background: on ? 'radial-gradient(circle at 45% 40%, #fff3c0, #ffc24a 55%, #c47a12)' : 'radial-gradient(circle at 45% 38%, #5f686c, #333a3e 70%)',
        boxShadow: on ? '0 0 6px rgba(255,190,70,0.8), inset 0 0 0 1px #6b4a12' : 'inset 0 0 0 1.5px #8d979b, 0 0 0 1px #1f2528',
      })} />
    </div>
  );
}

/** Horizontal visual SPEED slider (-1..100; at the far left the peak display is off). */
export function SpeedSlider({ x, y, w, h, value, onChange }: Box & { value: number; onChange: (v: number) => void }) {
  const thumbW = 13;
  const hnd = useControl({ value, min: -1, max: 100, defaultValue: 50, step: 1, label: 'Visual speed', travel: w - thumbW, format: (v) => (v <= 0 ? 'off' : `${Math.round(v)}%`), onChange }, 'horizontal');
  const t = Math.min(1, Math.max(0, (value + 1) / 101));
  return (
    <div {...hnd} style={abs({ x, y: y - 2, w, h: h + 4 }, { cursor: 'default', touchAction: 'none' })}>
      <div style={abs({ x: 0, y: (h + 4) / 2 - 2, w, h: 4 }, { background: '#2a3134', borderRadius: 2, boxShadow: '0 1px 0 rgba(255,255,255,0.07)' })} />
      <div style={abs({ x: 2, y: (h + 4) / 2 - 0.5, w: w - 4, h: 1 }, { background: '#8d969a' })} />
      <div style={abs({ x: t * (w - thumbW), y: (h + 4) / 2 - 5, w: thumbW, h: 10 }, {
        background: 'linear-gradient(180deg, #e9edef, #c3c9cc 55%, #9ea6aa)', borderRadius: 2, boxShadow: '0 1px 2px rgba(0,0,0,0.55)',
      })}>
        <div style={abs({ x: thumbW / 2 - 0.5, y: 2, w: 1, h: 6 }, { background: '#4a5357' })} />
      </div>
    </div>
  );
}

/** Peak meter level (0..1 of the height) for a linear peak: FL's volumeter scale (-60..+6 dB... linear in dB below 0). */
export function meterPos(v: number): number {
  return Math.min(1, Math.max(0, v / 1.15));
}

/** Draw one vertical bar meter with its peak hold mark. */
export function drawBar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, level: number, hold: number, color: string): void {
  g.fillStyle = C.meterBg;
  g.fillRect(x, y, w, h);
  const f = meterPos(level);
  g.fillStyle = color;
  g.fillRect(x + 1, y + h - 1 - (h - 2) * f, w - 2, (h - 2) * f);
  if (hold > 0.001) {
    const hy = y + h - 1 - (h - 2) * meterPos(hold);
    g.fillStyle = C.peak;
    g.fillRect(x + 1, Math.round(hy) - 1, w - 2, 2);
  }
  g.strokeStyle = C.meterEdge;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}
