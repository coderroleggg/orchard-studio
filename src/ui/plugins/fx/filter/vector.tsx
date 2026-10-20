// FL vector widgets used by the Filter-family editors (Filter, Parametric EQ,
// Love Philter, EQUO, Frequency Splitter, 7 Band EQ, Free Filter, Fast LP),
// drawn after FL 2026's screenshots:
// - FlKnob: TVectorWheel as in Fruity Filter (300 degree sweep, 4 px value
//   ring, two-tone body, pointer from a third of the radius to the rim);
// - ValueBar: the thin horizontal TVectorSlider that mirrors a wheel;
// - SwitchSel: TSwitchSelector (vertical pill with the option captions);
// - QLabel / VBevel: TQuickLabel (QL_RoundedSubtle) and TVectorBevel (VB_PlainRounded).
// These are candidates for the shared kit (see the batch report).

import { memo, type CSSProperties, type ReactNode } from 'react';
import { useControl, automationMenuItems, autoTargetOf, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

type Box = { x: number; y: number; w: number; h: number };

/** FL 2026 default plugin colours (sampled from the Fruity Filter screenshot). */
export const FL = {
  panel: '#444a4f',
  bevel: '#50585b',
  label: '#5a636a',
  text: '#c9d8e0',
  green: '#d8ffd4',
  track: '#41484c',
  trackEdge: '#353b40',
};

export const SWEEP_START = -150;
export const SWEEP = 300;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(cx, cy, r, lo);
  const [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let uid = 0;

export interface FlKnobViewProps {
  /** Box size (FL draws the wheel with the smaller side as diameter, centred). */
  w: number;
  h: number;
  /** Normalised position 0..1. */
  t: number;
  color?: string;
  bipolar?: boolean;
  disabled?: boolean;
  /** Ring track colour. */
  track?: string;
}

/** FL's vector wheel drawing (no interaction). */
export function FlKnobView({ w, h, t, color = FL.green, bipolar, disabled, track = '#4f585b' }: FlKnobViewProps) {
  const D = Math.min(w, h);
  const s = D / 40;
  const cx = w / 2, cy = h / 2;
  const tc = Math.min(1, Math.max(0, t));
  const ang = SWEEP_START + SWEEP * tc;
  const from = bipolar ? 0 : SWEEP_START;
  const rr = 17.5 * s, rw = 4 * s, rb = 14.5 * s;
  const id = `flk${(uid = (uid + 1) % 1e9)}`;
  // two-tone body: a bevelled cap on the pointer side (beyond a chord at 0.36 R),
  // split by the pointer ridge; each half is lit by its facing (light from above)
  const ux = Math.sin((ang * Math.PI) / 180), uy = -Math.cos((ang * Math.PI) / 180); // toward the pointer
  const vx = -uy, vy = ux; // clockwise side
  const d = 0.36 * rb, E = rb + 2;
  const pt = (a: number, b: number) => `${(cx + ux * a + vx * b).toFixed(2)} ${(cy + uy * a + vy * b).toFixed(2)}`;
  const halfCw = `M${pt(d, 0)}L${pt(E, 0)}L${pt(E, E)}L${pt(d, E)}Z`;
  const halfCcw = `M${pt(d, 0)}L${pt(E, 0)}L${pt(E, -E)}L${pt(d, -E)}Z`;
  const ca = Math.cos((ang * Math.PI) / 180), sa = Math.sin((ang * Math.PI) / 180);
  const shade = (b: number) => (b >= 0 ? `rgba(255,255,255,${(0.2 * b).toFixed(3)})` : `rgba(14,18,21,${(0.36 * -b).toFixed(3)})`);
  const bCw = 0.55 * ca - 0.45 * sa, bCcw = 0.55 * ca + 0.45 * sa;
  const [q0x, q0y] = polar(cx, cy, 4.7 * s, ang);
  const [q1x, q1y] = polar(cx, cy, 14.1 * s, ang);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible', opacity: disabled ? 0.5 : 1 }}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1={cy - rb} x2="0" y2={cy + rb} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6a7278" />
          <stop offset="0.04" stopColor="#5a636a" />
          <stop offset="0.16" stopColor="#555d63" />
          <stop offset="0.25" stopColor="#505b60" />
          <stop offset="0.4" stopColor="#4e575b" />
          <stop offset="0.5" stopColor="#4a545a" />
          <stop offset="0.68" stopColor="#475056" />
          <stop offset="0.8" stopColor="#444e54" />
          <stop offset="0.93" stopColor="#434c52" />
          <stop offset="1" stopColor="#353b40" />
        </linearGradient>
        <linearGradient id={`${id}o`} x1="0" y1={cy - rr} x2="0" y2={cy + rr} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3c4448" />
          <stop offset="0.55" stopColor="#465055" />
          <stop offset="1" stopColor="#4c5559" />
        </linearGradient>
        <clipPath id={`${id}c`}><circle cx={cx} cy={cy} r={rb} /></clipPath>
      </defs>
      {/* ring track with its outline, then the value arc */}
      <path d={arcPath(cx, cy, rr, SWEEP_START, SWEEP_START + SWEEP)} stroke={`url(#${id}o)`} strokeWidth={rw + 1.3 * s} fill="none" />
      <path d={arcPath(cx, cy, rr, SWEEP_START, SWEEP_START + SWEEP)} stroke={track} strokeWidth={rw - 0.7 * s} fill="none" />
      <path d={arcPath(cx, cy, rr, from, ang)} stroke={color} strokeWidth={rw} fill="none" />
      {/* drop shadow, body, two-tone facet, rim */}
      <circle cx={cx} cy={cy + 1.6 * s} r={rb + 1.2 * s} fill="rgba(20,24,27,0.32)" />
      <circle cx={cx} cy={cy} r={rb + 0.7 * s} fill="#3a4246" />
      <circle cx={cx} cy={cy} r={rb} fill={`url(#${id}b)`} />
      <g clipPath={`url(#${id}c)`}>
        <path d={halfCw} fill={shade(bCw)} />
        <path d={halfCcw} fill={shade(bCcw)} />
      </g>
      <line x1={q0x} y1={q0y} x2={q1x} y2={q1y} stroke={color} strokeWidth={1.75 * s} strokeLinecap="butt" />
    </svg>
  );
}

export interface FlKnobProps extends Box {
  color?: string;
  bipolar?: boolean;
  disabled?: boolean;
  track?: string;
  /** Mouse travel (px) for the full range. */
  travel?: number;
}

/** Wheel bound to plugin parameter `k`. */
export const FlKnob = memo(function FlKnob({ k, control: over, ...rest }: FlKnobProps & { k: string; control?: Partial<ControlProps> }) {
  const p = useParam(k, over);
  return <FlKnobControl {...rest} control={p.control} bipolar={rest.bipolar ?? p.def.bipolar} />;
});

/** Wheel driven by explicit ControlProps. */
export function FlKnobControl({ x, y, w, h, color, bipolar, disabled, track, travel = 200, control }: FlKnobProps & { control: ControlProps }) {
  const hnd = useControl({ travel, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: w, height: h }} {...hnd}>
      <FlKnobView w={w} h={h} t={t} color={color} bipolar={bipolar} disabled={disabled || control.disabled} track={track} />
    </div>
  );
}

/**
 * Thin horizontal value slider (TVectorSlider): a rounded track inset by half
 * the control height with a fill from the left; drag to change the value.
 */
export const ValueBar = memo(function ValueBar({ k, x, y, w, h, color, control: over }: Box & { k: string; color?: string; control?: Partial<ControlProps> }) {
  const p = useParam(k, over);
  return <ValueBarControl x={x} y={y} w={w} h={h} color={color} control={p.control} />;
});

export function ValueBarControl({ x, y, w, h, color = FL.green, control, bipolar }: Box & { color?: string; control: ControlProps; bipolar?: boolean }) {
  const inset = Math.round(h * 0.42);
  const hnd = useControl({ travel: Math.max(40, w - 2 * inset), ...control }, 'horizontal');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const tw = w - 2 * inset;
  const th = Math.max(4, Math.round(h * 0.38));
  const top = Math.round((h - th) / 2);
  const fillW = Math.max(1.4, t * (tw - 2));
  const z = bipolar ? (tw - 2) / 2 : 0;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', touchAction: 'none' }} {...hnd}>
      <div style={{ position: 'absolute', left: inset, top, width: tw, height: th, boxSizing: 'border-box', background: FL.track, border: `1px solid ${FL.trackEdge}`, borderRadius: th / 2 }}>
        <div style={{
          position: 'absolute', top: 0, bottom: 0, borderRadius: 1, background: color,
          left: bipolar ? Math.min(z, t * (tw - 2)) : 0,
          width: bipolar ? Math.max(1.4, Math.abs(t * (tw - 2) - z)) : fillW,
        }} />
      </div>
    </div>
  );
}

/**
 * FL's switch selector (TSwitchSelector): a vertical pill with a round thumb
 * at the selected option and the option captions to its right.
 */
export function SwitchSelView({ x, y, w, h, options, value, onPick, hint, menu, pillW }: Box & {
  options: string[]; value: number; onPick: (i: number) => void; hint?: string; menu?: MenuItem[]; pillW?: number;
}) {
  const n = Math.max(1, options.length);
  const pw = pillW ?? Math.round(Math.min(w * 0.4, h / n + 3));
  const ph = h - 3;
  const cell = h / n;
  const thumb = pw - 3;
  const tTop = Math.min(ph - 1 - thumb, Math.max(-0.5, (value + 0.5) * cell - thumb / 2 - 1.5 - 1));
  const style: CSSProperties = { left: x, top: y, width: w, height: h, cursor: 'default' };
  return (
    <div className="fxk-abs" style={style}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const f = (e.clientY - r.top) / r.height;
        if (n === 2 && (e.clientX - r.left) / r.width < (pw + 2) / w) onPick(value === 0 ? 1 : 0);
        else onPick(Math.min(n - 1, Math.max(0, Math.floor(f * n))));
      }}
      onContextMenu={(e) => {
        e.preventDefault(); e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          ...options.map((o, i) => ({ label: o, checked: i === value, radio: true, onClick: () => onPick(i) } as MenuItem)),
          ...(menu ?? []),
        ]);
      }}>
      <div style={{
        position: 'absolute', left: 1, top: 1.5, width: pw, height: ph, boxSizing: 'border-box',
        borderRadius: pw / 2, border: '1px solid #26292b', background: '#41484c',
      }}>
        <div style={{
          position: 'absolute', left: (pw - 2 - thumb) / 2, top: tTop, width: thumb, height: thumb, borderRadius: '50%',
          background: 'radial-gradient(circle at 45% 40%, #d8dfe2, #bfc6c9 60%, #aab1b4)',
        }} />
      </div>
      {options.map((o, i) => (
        <div key={i} style={{
          position: 'absolute', left: pw + 4.4, top: i * cell, height: cell, lineHeight: `${cell}px`,
          color: '#d4dde2', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: Math.min(9.4, cell * 0.8), letterSpacing: '0.03em',
          whiteSpace: 'nowrap', WebkitTextStroke: '0.2px #d4dde2',
        }}>{o}</div>
      ))}
    </div>
  );
}

/** Switch selector bound to an option parameter. */
export function SwitchSel({ k, x, y, w, h, options, pillW }: Box & { k: string; options?: string[]; pillW?: number }) {
  const p = useParam(k);
  const opts = options ?? p.def.options ?? ['Off', 'On'];
  const idx = Math.round(p.value - p.def.min);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  const target = autoTargetOf(p.control);
  return (
    <SwitchSelView x={x} y={y} w={w} h={h} options={opts} value={idx} onPick={pick} pillW={pillW}
      hint={`${p.def.name}: ${opts[idx] ?? ''}`}
      menu={target ? automationMenuItems(target, 0, 0) : undefined} />
  );
}

/** TQuickLabel with FL's rounded subtle box (QL_RoundedSubtle). */
export function QLabel({ x, y, w, h, children, size = 8.4, color = FL.text, bg = FL.label, bold = false, align = 'center', style }: Box & {
  children: ReactNode; size?: number; color?: string; bg?: string | null; bold?: boolean; align?: 'left' | 'center' | 'right'; style?: CSSProperties;
}) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, lineHeight: `${h}px`, textAlign: align, background: bg ?? undefined,
      borderRadius: bg ? 3 : 0, color, fontFamily: 'Arial, Helvetica, sans-serif', fontSize: size,
      fontWeight: bold ? 700 : 400, whiteSpace: 'nowrap', overflow: 'hidden', pointerEvents: 'none', letterSpacing: '0.09em',
      WebkitTextStroke: bold ? undefined : `0.25px ${color}`, ...style,
    }}>{children}</div>
  );
}

/** TVectorBevel, VB_PlainRounded style. */
export function VBevel({ x, y, w, h, color = FL.bevel, radius = 3.5, children, style }: Box & { color?: string; radius?: number; children?: ReactNode; style?: CSSProperties }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: color, borderRadius: radius, ...style }}>{children}</div>;
}

/**
 * Wheel section of the Fruity Filter family (Filter, Fast LP, Free Filter):
 * rounded bevel (160 x 45), wheel, rounded caption and the value slider that
 * mirrors the wheel.
 */
export function WheelSection({ x, y, k, caption, color = FL.green, bevel, label }: { x: number; y: number; k: string; caption: string; color?: string; bevel?: string; label?: string }) {
  return (
    <>
      <VBevel x={x} y={y} w={160} h={45} color={bevel} />
      <FlKnob k={k} x={x + 2} y={y + 3} w={46} h={40} color={color} />
      <QLabel x={x + 54} y={y} w={106} h={16} bg={label}>{caption}</QLabel>
      <ValueBar k={k} x={x + 51} y={y + 29} w={108} h={14} color={color} />
    </>
  );
}
