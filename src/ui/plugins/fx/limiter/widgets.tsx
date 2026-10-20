// FL vector widgets for the dynamics editors (Limiter, Compressor, Soft
// Clipper), drawn at FL's form coordinates with SVG/CSS. Geometry and colours
// were measured from FL 2026's manual screenshots (1.5x): the 46 px wheel has
// a 3.3 px value ring (r 18.7..22) open at the bottom, a 17.5 px two-tone face
// with a drop shadow, and a coloured pointer.

import { memo, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

/** Condensed caption face (FL's vector UI uses a condensed sans; no FL font is bundled). */
export const COND = '"Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

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

/** Wheel geometry (at `nominal` px) and face colours. */
export interface KnobStyle {
  nominal: number;
  rRing: number;
  ringW: number;
  rBody: number;
  outline: string;
  track: string;
  faceTop: string;
  faceBot: string;
  rim: string;
  /** Pointer extent as fractions of the face radius. */
  pIn: number;
  pOut: number;
}

/** Fruity Limiter's 46 px wheel. */
export const LIMITER_KNOB: KnobStyle = {
  nominal: 46, rRing: 20.35, ringW: 3.3, rBody: 17.5, outline: '#2a3338', track: '#3f484d', faceTop: '#3b444a', faceBot: '#30393e', rim: 'rgba(255,255,255,0.13)', pIn: 0.33, pOut: 0.97,
};

/** Fruity Compressor's 40 px wheel: thicker light track, lighter face. */
export const COMPRESSOR_KNOB: KnobStyle = {
  nominal: 40, rRing: 17.35, ringW: 4, rBody: 14.4, outline: '#3c4549', track: '#4c5558', faceTop: '#666f75', faceBot: '#3f494e', rim: 'rgba(255,255,255,0.2)', pIn: 0.44, pOut: 1.2,
};

/** Static drawing of FL's vector wheel (scaled from the style's nominal size). */
export function KnobView({ size = 46, t, color, bipolar, disabled, look = LIMITER_KNOB }: { size?: number; t: number; color: string; bipolar?: boolean; disabled?: boolean; look?: KnobStyle }) {
  const k = size / look.nominal;
  const c = size / 2;
  const rRing = look.rRing * k, ringW = look.ringW * k, rBody = look.rBody * k;
  const tc = Math.min(1, Math.max(0, t));
  const ang = START + SWEEP * tc;
  const from = bipolar ? 0 : START;
  // flat facet on the pointer side: the segment beyond a chord perpendicular to the
  // pointer at 0.32 r, lit by a light from above (bright near 12 o'clock, shaded elsewhere)
  const half = 71.34; // acos(0.32)
  const [s0x, s0y] = polar(c, c, rBody, ang - half);
  const [s1x, s1y] = polar(c, c, rBody, ang + half);
  const lit = Math.pow(Math.max(0, Math.cos((ang * Math.PI) / 180)), 5);
  const [p0x, p0y] = polar(c, c, rBody * look.pIn, ang);
  const [p1x, p1y] = polar(c, c, rBody * look.pOut, ang);
  const id = `lk${(uid = (uid + 1) % 1e6)}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible', opacity: disabled ? 0.45 : 1 }}>
      <defs>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={look.faceTop} />
          <stop offset="1" stopColor={look.faceBot} />
        </linearGradient>
        <radialGradient id={`${id}s`} cx="50%" cy="50%" r="50%">
          <stop offset="0.75" stopColor="rgba(10,14,16,0.55)" />
          <stop offset="1" stopColor="rgba(10,14,16,0)" />
        </radialGradient>
      </defs>
      {/* value ring: outline, track, arc */}
      <path d={arcPath(c, c, rRing, START, START + SWEEP)} stroke={look.outline} strokeWidth={ringW + 1.3 * k} fill="none" />
      <path d={arcPath(c, c, rRing, START, START + SWEEP)} stroke={look.track} strokeWidth={ringW} fill="none" />
      {Math.abs(ang - from) > 0.3 && <path d={arcPath(c, c, rRing, from, ang)} stroke={color} strokeWidth={ringW} fill="none" />}
      {/* face with drop shadow */}
      <circle cx={c} cy={c + 2.4 * k} r={rBody + 2.2 * k} fill={`url(#${id}s)`} />
      <circle cx={c} cy={c} r={rBody + 0.6 * k} fill="#283035" />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id}f)`} />
      <path d={`M${s0x} ${s0y} A${rBody} ${rBody} 0 0 1 ${s1x} ${s1y} Z`} fill={`rgba(0,0,0,${(0.18 * (1 - lit)).toFixed(3)})`} />
      {lit > 0.01 && <path d={`M${s0x} ${s0y} A${rBody} ${rBody} 0 0 1 ${s1x} ${s1y} Z`} fill={`rgba(255,255,255,${(0.19 * lit).toFixed(3)})`} />}
      <path d={arcPath(c, c, rBody - 0.5 * k, -62, 62)} stroke={look.rim} strokeWidth={0.9 * k} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={color} strokeWidth={1.9 * k} strokeLinecap="butt" />
    </svg>
  );
}

/** A knob bound to parameter `k` at FL's form position. */
export const Knob = memo(function Knob({ k, x, y, size = 46, color, resetTo, onDrag, hint, look }: {
  k: string; x: number; y: number; size?: number; color: string; resetTo?: number; onDrag?: (active: boolean) => void; hint?: string; look?: KnobStyle;
}) {
  const p = useParam(k);
  const control: ControlProps = {
    ...p.control,
    defaultValue: resetTo ?? p.control.defaultValue,
    label: hint ?? p.control.label,
    onBegin: () => { p.control.onBegin?.(); onDrag?.(true); },
    onEnd: () => { p.control.onEnd?.(); onDrag?.(false); },
  };
  return <KnobControl x={x} y={y} size={size} color={color} bipolar={p.def.bipolar} control={control} look={look} />;
});

export function KnobControl({ x, y, size = 46, color, bipolar, control, look }: { x: number; y: number; size?: number; color: string; bipolar?: boolean; control: ControlProps; look?: KnobStyle }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <KnobView size={size} t={t} color={color} bipolar={bipolar} disabled={control.disabled} look={look} />
    </div>
  );
}

/** Caption (TQuickLabel) in the condensed face, centred in its box. */
export function Txt({ x, y, w, h = 15, size = 10.5, color = '#bfd0d0', bold, align = 'center', children, style }: {
  x: number; y: number; w: number; h?: number; size?: number; color?: string; bold?: boolean; align?: 'left' | 'center' | 'right'; children: ReactNode; style?: CSSProperties;
}) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, lineHeight: `${h}px`, textAlign: align, font: `${bold ? 700 : 400} ${size}px ${COND}`,
      color, whiteSpace: 'nowrap', pointerEvents: 'none', ...style,
    }}>{children}</div>
  );
}

/**
 * FL's light numeric spinner (TVectorDigiWheel in the dynamics plugins): grey-blue
 * box, white value right-aligned before two small arrows. Drag, wheel or click the arrows.
 */
export function SpinnerControl({ x, y, w, h, control, text, onContextMenu, hint, tone = 'light' }: {
  x: number; y: number; w: number; h: number; control: ControlProps; text: string;
  onContextMenu?: (e: React.MouseEvent) => void; hint?: string; tone?: 'light' | 'dark';
}) {
  const hnd = useControl({ travel: Math.max(60, ((control.max ?? 1) - (control.min ?? 0)) * 14), ...control }, 'vertical');
  const step = control.step && control.step > 0 ? control.step : 1;
  const bump = (d: number) => {
    const v = Math.min(control.max ?? 1, Math.max(control.min ?? 0, control.value + d * step));
    if (v === control.value) return;
    control.onBegin?.();
    control.onChange(v);
    control.onEnd?.();
    setHint(`${control.label}: ${control.format ? control.format(v) : v}`);
  };
  return (
    <div className="fxk-abs" {...hnd}
      onContextMenu={onContextMenu ?? hnd.onContextMenu}
      onPointerEnter={() => hint && setHint(hint)}
      style={{
        left: x, top: y, width: w, height: h, boxSizing: 'border-box', border: `1px solid ${tone === 'dark' ? '#454e53' : '#475558'}`, borderRadius: 1,
        background: tone === 'dark' ? 'linear-gradient(135deg, #626c72 0%, #5e686e 60%, #5b656b 100%)' : 'linear-gradient(135deg, #7e8c8f 0%, #747f83 55%, #6f7c7f 100%)',
        cursor: 'ns-resize', touchAction: 'none',
      }}>
      <div style={{ position: 'absolute', left: 0, right: 9.5, top: 0, bottom: 0, textAlign: 'right', font: `400 14px/${h - 2}px var(--font-ui)`, color: '#fff', pointerEvents: 'none', whiteSpace: 'nowrap' }}>{text}</div>
      <svg width={7} height={h - 2} style={{ position: 'absolute', right: 1, top: 0 }} viewBox={`0 0 7 ${h - 2}`}>
        <path d={`M1 ${(h - 2) / 2 - 1.2} L3.5 ${(h - 2) / 2 - 4.4} L6 ${(h - 2) / 2 - 1.2} Z`} fill="#4c5a60" />
        <path d={`M1 ${(h - 2) / 2 + 1.2} L3.5 ${(h - 2) / 2 + 4.4} L6 ${(h - 2) / 2 + 1.2} Z`} fill="#4c5a60" />
        <rect x={0} y={0} width={7} height={(h - 2) / 2} fill="transparent" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); bump(1); } }} />
        <rect x={0} y={(h - 2) / 2} width={7} height={(h - 2) / 2} fill="transparent" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); bump(-1); } }} />
      </svg>
    </div>
  );
}

/** Spinner bound to an integer parameter. */
export function Spinner({ k, x, y, w = 26, h = 21 }: { k: string; x: number; y: number; w?: number; h?: number }) {
  const p = useParam(k);
  return <SpinnerControl x={x} y={y} w={w} h={h} control={p.control} text={String(Math.round(p.value))} />;
}

/** FL's round "spare state" buttons (store / flip): translucent light disc with an engraved glyph. */
export function RoundButton({ x, y, size = 24, glyph, hint, onClick }: { x: number; y: number; size?: number; glyph: 'store' | 'flip'; hint: string; onClick: () => void }) {
  const c = size / 2;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: size, height: size, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
        <circle cx={c} cy={c} r={c - 0.5} fill="rgba(170,182,186,0.55)" />
        {glyph === 'store'
          ? <path d={`M${c - 4.3} ${c - 2} L${c + 4.3} ${c - 2} L${c} ${c + 3} Z`} fill="#a5b0b2" />
          : <path d={`M${c - 4} ${c - 1.2} L${c} ${c - 5.4} L${c + 4} ${c - 1.2} Z M${c - 4} ${c + 1.2} L${c} ${c + 5.4} L${c + 4} ${c + 1.2} Z`} fill="#a5b0b2" />}
      </svg>
    </div>
  );
}

/** Two-segment target selector (TQuickTabSelector: LIMIT / COMP). */
export function TabSel({ x, y, w, h, options, value, onChange, hint, split }: {
  x: number; y: number; w: number; h: number; options: string[]; value: number; onChange: (i: number) => void; hint?: string; split?: number[];
}) {
  const widths = split ?? options.map(() => w / options.length);
  let acc = 0;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h }} onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {options.map((o, i) => {
        const left = acc;
        acc += widths[i];
        const on = i === value;
        return (
          <div key={o} style={{
            position: 'absolute', left, top: 0, width: widths[i], height: h, lineHeight: `${h}px`, textAlign: 'center',
            background: on ? '#2f383d' : '#3e474d', color: on ? '#ffffff' : '#a5aeb3', font: `400 15px ${COND}`, cursor: 'default',
            borderBottomLeftRadius: i === 0 ? 4 : 0,
          }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(i); } }}>{o}</div>
        );
      })}
    </div>
  );
}
