// Harmor's vector controls (original drawings after FL 2026's TVectorWheel,
// TVectorSlider, TVectorCheckBox, TQuickCombo, TSwitchSelector,
// TVectorDigiWheel, TVectorMultiDigiWheel and the editor's double switches),
// driven by FL's form properties (FORM: position, colours, angles, pointer
// and cap styles) and bound through ControlProps (useParam or a setting).

import { memo, useId, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useNoScrollWheel } from '../../kit';
import type { FCtl } from './form';
import { isSeparator, selectable } from './bind';

const abs = (c: { x: number; y: number; w: number; h: number }, extra?: CSSProperties): CSSProperties =>
  ({ position: 'absolute', left: c.x, top: c.y, width: c.w, height: c.h, ...extra });

/** Value position 0..1 of a control. */
export function frac(cp: ControlProps): number {
  const lo = cp.min ?? 0, hi = cp.max ?? 1;
  return Math.min(1, Math.max(0, (cp.value - lo) / (hi - lo || 1)));
}

/** Hint text of a control (FL's hint bar: "<name>: <value>"). */
function hintOf(cp: ControlProps): string {
  return `${cp.label}: ${cp.format ? cp.format(cp.value) : Math.round(cp.value)}`;
}

/** Discrete one-shot change through the control's gesture callbacks. */
export function commit(cp: ControlProps, v: number): void {
  cp.onBegin?.();
  cp.onChange(Math.min(cp.max ?? v, Math.max(cp.min ?? v, v)));
  cp.onEnd?.();
}

// ------------------------------------------------------------------ wheel

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.2) return '';
  if (Math.abs(a1 - a0) >= 359.9) {
    const [x0, y0] = polar(cx, cy, r, a0);
    const [x1, y1] = polar(cx, cy, r, a0 + 180);
    return `M${x0} ${y0} A${r} ${r} 0 1 1 ${x1} ${y1} A${r} ${r} 0 1 1 ${x0} ${y0}`;
  }
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(cx, cy, r, lo);
  const [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Sweep of an FL vector wheel from its StartAngle / EndAngle (radians, maths
 * convention: 3pi/2 = bottom; the wheel turns clockwise on screen from the
 * start to the end, equal angles = a full turn from the bottom): [start, end]
 * in degrees clockwise from the top.
 */
export function wheelSweep(a0 = 4.7124, a1 = 4.7124): [number, number] {
  let gap = a1 - a0;
  if (gap < 0) gap += 2 * Math.PI;
  const sweep = 360 - (gap * 180) / Math.PI;
  const start = 90 - (a0 * 180) / Math.PI; // screen angle of a0, clockwise from the top
  const s = ((start % 360) + 360) % 360;
  const st = s > 180 ? s - 360 : s;
  return [st, st + sweep];
}

export interface WheelLook {
  fill?: string;
  rail?: string;
  cap?: string;
  chrome?: boolean;
  ptr?: 's' | 'l' | 'n' | 'L';
  a0?: number;
  a1?: number;
  centered?: boolean;
}

/** The wheel drawing (size S): rail ring, value arc, shadowed body (dark cap or chrome), pointer. */
export const WheelView = memo(function WheelView({ S, t, look, dim }: { S: number; t: number; look: WheelLook; dim?: boolean }) {
  const id = 'hw' + useId().replace(/:/g, '');
  const c = S / 2;
  const ring = Math.max(2, Math.round(S * (S >= 40 ? 0.085 : 0.11)));
  const rr = c - ring / 2 - 0.5;
  const [s0, s1] = wheelSweep(look.a0, look.a1);
  const full = s1 - s0 >= 359.9;
  const ang = s0 + (s1 - s0) * Math.min(1, Math.max(0, t));
  const from = look.centered ? s0 + (s1 - s0) / 2 : s0;
  const rb = rr - ring / 2 - Math.max(1, S * 0.04);
  const fill = look.fill ?? '#33c1e1';
  const rail = look.rail ?? '#2e2329';
  const cap = look.cap ?? '#353e42';
  const chrome = !!look.chrome;
  const ptr = look.ptr ?? 's';
  const pc = chrome ? '#2b2d30' : '#e9e9e9';
  let p0 = 0.5, p1 = 0.92;
  if (ptr === 'l') { p0 = chrome ? 0.12 : 0.18; p1 = 0.9; }
  if (ptr === 'L') { p0 = 0; p1 = 1.05; }
  const [x0, y0] = polar(c, c, rb * p0, ang);
  const [x1, y1] = polar(c, c, rb * p1, ang);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible', opacity: dim ? 0.55 : 1 }}>
      <defs>
        <radialGradient id={`${id}c`} cx="42%" cy="34%" r="72%">
          {chrome ? (
            <>
              <stop offset="0" stopColor="#f4f6f7" />
              <stop offset="0.55" stopColor="#c3c9cd" />
              <stop offset="1" stopColor="#8a9297" />
            </>
          ) : (
            <>
              <stop offset="0" stopColor={cap} stopOpacity="1" />
              <stop offset="1" stopColor="#000" stopOpacity="0.55" />
            </>
          )}
        </radialGradient>
      </defs>
      {/* rail ring and value arc */}
      <path d={arcPath(c, c, rr, s0, full ? s0 + 360 : s1)} stroke="rgba(0,0,0,0.45)" strokeWidth={ring + 1.4} fill="none" />
      <path d={arcPath(c, c, rr, s0, full ? s0 + 360 : s1)} stroke={rail} strokeWidth={ring} fill="none" />
      <path d={arcPath(c, c, rr, from, ang)} stroke={fill} strokeWidth={ring} fill="none" />
      {/* body */}
      <circle cx={c} cy={c + Math.max(1, S * 0.05)} r={rb + 0.6} fill="rgba(0,0,0,0.45)" />
      <circle cx={c} cy={c} r={rb} fill={chrome ? `url(#${id}c)` : cap} />
      {!chrome && <circle cx={c} cy={c} r={rb} fill={`url(#${id}c)`} opacity={0.6} />}
      <circle cx={c} cy={c} r={rb - 0.5} fill="none" stroke={chrome ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.10)'} strokeWidth={0.8} />
      {ptr !== 'n' && (
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={pc} strokeWidth={Math.max(1.4, S * (chrome ? 0.055 : 0.07))} strokeLinecap="round" />
      )}
    </svg>
  );
});

/** A wheel at FL's form position. */
export function HWheel({ ctl, cp, dim, look }: { ctl: FCtl; cp: ControlProps; dim?: boolean; look?: Partial<WheelLook> }) {
  const S = Math.min(ctl.w, ctl.h);
  const hnd = useControl({ travel: S >= 40 ? 220 : 180, ...cp }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  // a stable look object lets the memoised drawing skip unchanged wheels
  const lk = useMemo<WheelLook>(() => ({
    fill: ctl.fill, rail: ctl.rail, cap: ctl.cap, chrome: ctl.chrome, ptr: ctl.ptr, a0: ctl.a0, a1: ctl.a1, centered: ctl.centered, ...look,
  }), [ctl, look]);
  return (
    <div ref={ref} className="hm-ctl" style={abs({ x: ctl.x + (ctl.w - S) / 2, y: ctl.y + (ctl.h - S) / 2, w: S, h: S })} {...hnd}>
      <WheelView S={S} t={frac(cp)} dim={dim || cp.disabled} look={lk} />
    </div>
  );
}

// ----------------------------------------------------------------- slider

/** A TVectorSlider: rail with optional fill and inner ruler, rectangular handle (vertical) or pointer handle (horizontal). */
export function HSlider({ ctl, cp }: { ctl: FCtl; cp: ControlProps }) {
  const horiz = !!ctl.horiz;
  const len = horiz ? ctl.w : ctl.h;
  const hs = Math.min(len / 3, ctl.hs ?? 11);
  const hnd = useControl({ travel: Math.max(40, len - hs), ...cp }, horiz ? 'horizontal' : 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="hm-ctl" style={abs(ctl)} {...hnd}>
      <SliderView ctl={ctl} t={frac(cp)} disabled={!!cp.disabled} />
    </div>
  );
}

const SliderView = memo(function SliderView({ ctl, t, disabled }: { ctl: FCtl; t: number; disabled: boolean }) {
  const horiz = !!ctl.horiz;
  const len = horiz ? ctl.w : ctl.h;
  const hs = Math.min(len / 3, ctl.hs ?? 11);
  const W = ctl.w, H = ctl.h;
  const fill = ctl.fill ?? '#33c2e1';
  const rail = ctl.rail ?? '#575e6a';
  const handle = ctl.handle ?? '#5b5f66';
  const rs = Math.max(1, ctl.rs ?? 2);
  const els: ReactNode[] = [];
  if (!horiz) {
    const cx = Math.round(W / 2) - 0.5;
    const y0 = hs / 2, y1 = H - hs / 2;
    const yv = y1 - (y1 - y0) * t;
    const yc = ctl.centered ? (y0 + y1) / 2 : y1;
    if (ctl.ruler) {
      for (let i = 0; i <= 20; i++) {
        const y = y0 + ((y1 - y0) * i) / 20;
        const big = i % 10 === 0;
        els.push(<line key={`r${i}`} x1={cx - (big ? 5 : 3.5)} y1={y} x2={cx - rs / 2 - 1.2} y2={y} stroke="rgba(0,0,0,0.38)" strokeWidth={1} />);
      }
    }
    els.push(<rect key="rail0" x={cx - rs / 2 - 1} y={y0 - 1} width={rs + 2} height={y1 - y0 + 2} rx={1} fill="rgba(0,0,0,0.55)" />);
    els.push(<rect key="rail" x={cx - rs / 2} y={y0} width={rs} height={y1 - y0} fill={rail} />);
    if (ctl.fillRail) els.push(<rect key="fill" x={cx - rs / 2} y={Math.min(yv, yc)} width={rs} height={Math.abs(yc - yv)} fill={fill} />);
    const hw = W - 2;
    els.push(
      <g key="h" transform={`translate(1 ${yv - hs / 2})`}>
        <rect x={0} y={1} width={hw} height={hs} rx={2} fill="rgba(0,0,0,0.45)" />
        <rect x={0} y={0} width={hw} height={hs} rx={2} fill={handle} />
        <rect x={0.5} y={0.5} width={hw - 1} height={hs / 2} rx={1.5} fill="rgba(255,255,255,0.12)" />
        <rect x={2} y={hs / 2 - 0.75} width={hw - 4} height={1.5} fill={ctl.fillRail ? fill : '#d8dde0'} />
      </g>,
    );
  } else {
    const cy = Math.round(H / 2) - 2.5;
    const x0 = hs / 2, x1 = W - hs / 2;
    const xv = x0 + (x1 - x0) * t;
    els.push(<rect key="rail0" x={x0 - 1} y={cy - rs / 2 - 1} width={x1 - x0 + 2} height={rs + 2} rx={1} fill="rgba(0,0,0,0.55)" />);
    els.push(<rect key="rail" x={x0} y={cy - rs / 2} width={x1 - x0} height={rs} fill={rail} />);
    for (let i = 0; i <= 20; i++) {
      const x = x0 + ((x1 - x0) * i) / 20;
      const big = i % 10 === 0;
      els.push(<line key={`r${i}`} x1={x} y1={cy + rs / 2 + 2} x2={x} y2={cy + rs / 2 + (big ? 5 : 3.5)} stroke="rgba(255,255,255,0.18)" strokeWidth={1} />);
    }
    const hw = Math.min(hs, 12), hh = H - 4;
    els.push(
      <g key="h" transform={`translate(${xv} 1)`}>
        <path d={`M${-hw / 2} ${hh} L${-hw / 2} ${hh * 0.42} L0 0 L${hw / 2} ${hh * 0.42} L${hw / 2} ${hh} Z`} fill="rgba(0,0,0,0.5)" transform="translate(0 1)" />
        <path d={`M${-hw / 2} ${hh} L${-hw / 2} ${hh * 0.42} L0 0 L${hw / 2} ${hh * 0.42} L${hw / 2} ${hh} Z`} fill={handle} stroke="rgba(0,0,0,0.6)" strokeWidth={0.8} />
        <line x1={0} y1={hh * 0.3} x2={0} y2={hh - 2} stroke={fill} strokeWidth={1.4} />
      </g>,
    );
  }
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible', opacity: disabled ? 0.5 : 1 }}>{els}</svg>;
});

// ------------------------------------------------------------------ check

/** Where FL draws a check box's LED: left of the caption (default), right (caption painted on its left), centred. */
export type LedPos = 'left' | 'right' | 'center' | 'bottom';

/** FL check boxes whose painted caption sits left of the LED (labels mode 3 inside the box). */
const LED_RIGHT = new Set(['LegatoBox', 'PortaBox', 'InvArpBox', 'ModSmoothBox']);

export function ledPosOf(ctl: { n?: string; w: number; h: number }): LedPos {
  if (ctl.n && LED_RIGHT.has(ctl.n)) return 'right';
  if (ctl.n === 'VelToVolBox') return 'bottom';
  return ctl.w <= ctl.h + 8 ? 'center' : 'left';
}

/** A TVectorCheckBox: LED dot, optional caption. */
export function HCheckView({ ctl, on, onToggle, hint, caption, color = '#ff9b3d', led }: {
  ctl: { n?: string; x: number; y: number; w: number; h: number }; on: boolean; onToggle: () => void; hint: string; caption?: string; color?: string; led?: LedPos;
}) {
  const pos = led ?? ledPosOf(ctl);
  const r = Math.max(3, Math.min(4.5, Math.min(ctl.w, ctl.h) / 3.6));
  const cx = pos === 'center' || pos === 'bottom' ? ctl.w / 2 : pos === 'right' ? ctl.w - r - 4 : r + 3;
  const cy = pos === 'bottom' ? ctl.h - r - 3 : ctl.h / 2;
  return (
    <div className="hm-ctl" style={abs(ctl)}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width={ctl.w} height={ctl.h} style={{ display: 'block', overflow: 'visible' }}>
        <circle cx={cx} cy={cy + 0.6} r={r + 1.2} fill="rgba(0,0,0,0.45)" />
        <circle cx={cx} cy={cy} r={r} fill={on ? color : '#3a2f33'} stroke="rgba(0,0,0,0.6)" strokeWidth={0.8} />
        {on && <circle cx={cx} cy={cy} r={r + 3} fill={color} opacity={0.18} />}
        <circle cx={cx - r * 0.3} cy={cy - r * 0.35} r={r * 0.35} fill="#fff" opacity={on ? 0.55 : 0.12} />
        {caption && <text x={cx + r + 4} y={cy + 3.5} className="hm-cap">{caption}</text>}
      </svg>
    </div>
  );
}

export function HCheck({ ctl, cp, caption, color }: { ctl: FCtl; cp: ControlProps; caption?: string; color?: string }) {
  const lo = cp.min ?? 0, hi = cp.max ?? 1;
  const on = cp.value > lo;
  return (
    <HCheckView ctl={ctl} on={on} caption={caption} color={color} hint={`${cp.label}: ${on ? 'on' : 'off'}`}
      onToggle={() => commit(cp, on ? lo : hi)} />
  );
}

// ------------------------------------------------------------------ combo

/**
 * Menu items of an FL item list ('-' separators, '-Text' headers), Value =
 * selectable index; `marks` (selectable indices) get FL's "in use" dot.
 */
export function comboMenu(items: readonly string[], value: number, pick: (v: number) => void, hints?: readonly string[], marks?: ReadonlySet<number>): MenuItem[] {
  const out: MenuItem[] = [];
  let k = 0;
  items.forEach((s, i) => {
    if (s === '-') { out.push({ separator: true }); return; }
    if (isSeparator(s)) { out.push({ header: true, label: s.slice(1) }); return; }
    const v = k++;
    out.push({ label: marks?.has(v) ? `${s}  \u2022` : s, radio: true, checked: v === Math.round(value), onClick: () => pick(v), hint: hints?.[i] || undefined });
  });
  return out;
}

/** A TQuickCombo: box with the current item and FL's arrow; click opens the item menu, the wheel steps. */
export function HCombo({ ctl, cp, items, glyph, extra, marks }: {
  ctl: FCtl; cp: ControlProps; items?: readonly string[]; glyph?: ReactNode; extra?: MenuItem[];
  /** Selectable items marked "in use" in the menu (computed when the menu opens). */
  marks?: () => ReadonlySet<number>;
}) {
  const list = items ?? ctl.items ?? [];
  const sel = selectable(list);
  const v = Math.round(cp.value);
  const text = sel[v] ?? '';
  const ref = useNoScrollWheel<HTMLDivElement>();
  const pick = (i: number) => commit(cp, i);
  const sober = !!ctl.sober;
  const bg = ctl.color ?? '#303336';
  return (
    <div ref={ref} className={'hm-ctl hm-combo' + (sober ? ' sober' : '')} style={abs(ctl, { background: bg, color: ctl.font ?? '#b3b6bf' })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, [...comboMenu(list, v, pick, ctl.hints, marks?.()), ...(extra ?? [])], { minWidth: Math.max(80, r.width) });
      }}
      onWheel={(e) => { e.stopPropagation(); const n = Math.min(sel.length - 1, Math.max(0, v + (e.deltaY > 0 ? 1 : -1))); if (n !== v) pick(n); }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, comboMenu(list, v, pick, ctl.hints));
      }}
      onPointerEnter={() => setHint(`${cp.label}: ${text}`)} onPointerLeave={clearHint}>
      {glyph ?? <span className="hm-combo-text">{text}</span>}
      {!ctl.noText && <span className="hm-combo-arrow" />}
    </div>
  );
}

// ----------------------------------------------------------------- switch

/** A TSwitchSelector: slide switch with one position per caption (oct / Hz ...). */
export function HSwitch({ ctl, cp, caps }: { ctl: FCtl; cp: ControlProps; caps?: string[] }) {
  const labels = caps ?? ctl.caps ?? [];
  const n = Math.max(1, labels.length);
  const v = Math.round(cp.value - (cp.min ?? 0));
  const rowH = ctl.h / n;
  const leftCaps = !!ctl.capLeft;
  const slotW = 9;
  const slotX = leftCaps ? ctl.w - slotW - 1 : 1;
  const ref = useNoScrollWheel<HTMLDivElement>();
  const pick = (i: number) => commit(cp, (cp.min ?? 0) + i);
  return (
    <div ref={ref} className="hm-ctl" style={abs(ctl)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * n)));
        pick(i === v && n === 2 ? 1 - v : i);
      }}
      onWheel={(e) => { e.stopPropagation(); const i = Math.min(n - 1, Math.max(0, v + (e.deltaY > 0 ? 1 : -1))); if (i !== v) pick(i); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, labels.map((s, i) => ({ label: ctl.hints?.[i] || s, radio: true, checked: i === v, onClick: () => pick(i) }))); }}
      onPointerEnter={() => setHint(`${cp.label}: ${ctl.hints?.[v] || labels[v] || ''}`)} onPointerLeave={clearHint}>
      <svg width={ctl.w} height={ctl.h} style={{ display: 'block' }}>
        <rect x={slotX} y={2} width={slotW} height={ctl.h - 4} rx={4.5} fill="rgba(0,0,0,0.5)" stroke={ctl.border ?? '#313437'} strokeWidth={1} />
        <circle cx={slotX + slotW / 2} cy={rowH * v + rowH / 2} r={3.4} fill="#d9dde0" stroke="rgba(0,0,0,0.6)" strokeWidth={0.7} />
        {labels.map((s, i) => (
          <text key={i} x={leftCaps ? slotX - 3 : slotX + slotW + 3} y={rowH * i + rowH / 2 + 3.3} textAnchor={leftCaps ? 'end' : 'start'}
            className={'hm-switch-cap' + (i === v ? ' on' : '')}>{s}</text>
        ))}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------- digits

/** A TVectorDigiWheel: coloured digit box, vertical drag / wheel / click arrows-free stepping. */
export function HDigi({ ctl, cp, text }: { ctl: FCtl; cp: ControlProps; text?: string }) {
  const range = (cp.max ?? 1) - (cp.min ?? 0);
  const hnd = useControl({ travel: Math.max(60, range * 8), step: 1, ...cp }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const label = text ?? (cp.format ? cp.format(cp.value) : String(Math.round(cp.value)));
  return (
    <div ref={ref} className="hm-ctl hm-digi" style={abs(ctl, { background: ctl.color ?? '#525862', color: ctl.font ?? '#d7d7d7', fontSize: Math.min(15, ctl.h - 5) })} {...hnd}>
      {label}
    </div>
  );
}

/** Width of a digit of the multi-digit wheel (CSS .hm-mdigi span). */
export const DIGIT_W = 7;

/**
 * A TVectorMultiDigiWheel (frequency / detuning multiplicator): the value as
 * "m.dddd"; dragging over a digit changes it by that digit's place value.
 */
export function HMultiDigi({ ctl, cp, decimals = 4 }: { ctl: FCtl; cp: ControlProps; decimals?: number }) {
  const unit = Math.pow(10, decimals);
  const text = (cp.value / unit).toFixed(decimals);
  const ref = useNoScrollWheel<HTMLDivElement>();
  const drag = useRef<{ y: number; v0: number; inc: number } | null>(null);
  /** Place value of the digit under x (digits are drawn centred, DIGIT_W apart). */
  const incAt = (px: number, w: number): number => {
    const tw = text.length * DIGIT_W;
    const dot = text.indexOf('.');
    let i = Math.floor((px - (w - tw) / 2) / DIGIT_W);
    i = Math.max(0, Math.min(text.length - 1, i));
    if (i === dot) i = dot + 1;
    const pos = i < dot ? dot - 1 - i : -(i - dot);
    return Math.max(1, Math.round(Math.pow(10, pos) * unit));
  };
  return (
    <div ref={ref} className="hm-ctl hm-mdigi" style={abs(ctl, { background: ctl.color ?? '#dadada' })}
      onPointerDown={(e) => {
        if (e.button === 1 || (e.button === 0 && e.altKey)) { commit(cp, cp.defaultValue); return; }
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        drag.current = { y: e.clientY, v0: cp.value, inc: incAt(((e.clientX - r.left) * ctl.w) / r.width, ctl.w) };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        cp.onBegin?.();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) { setHint(hintOf(cp)); return; }
        const steps = Math.round((d.y - e.clientY) / 6);
        const v = Math.min(cp.max ?? 1e9, Math.max(cp.min ?? -1e9, d.v0 + steps * d.inc));
        if (v !== cp.value) cp.onChange(v);
        setHint(hintOf({ ...cp, value: v }));
      }}
      onPointerUp={() => { if (drag.current) { drag.current = null; cp.onEnd?.(); } }}
      onPointerCancel={() => { if (drag.current) { drag.current = null; cp.onEnd?.(); } }}
      onWheel={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const inc = incAt(((e.clientX - r.left) * ctl.w) / r.width, ctl.w);
        commit(cp, cp.value + (e.deltaY < 0 ? inc : -inc));
      }}
      onPointerLeave={clearHint}
      onContextMenu={(e) => { e.preventDefault(); }}>
      {text.split('').map((ch, i) => <span key={i} className={ch === '.' ? 'dot' : ''}>{ch}</span>)}
    </div>
  );
}

// --------------------------------------------------------- double switch

/** FL's double switch (DblSwitchPaint): two options side by side, the active one lit. */
export function HDblSwitch({ ctl, cp, opts }: { ctl: FCtl; cp: ControlProps; opts: [string, string] }) {
  const v = cp.value > (cp.min ?? 0) ? 1 : 0;
  const half = ctl.w / 2;
  return (
    <div className="hm-ctl" style={abs(ctl)}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); commit(cp, v ? (cp.min ?? 0) : (cp.max ?? 1)); } }}
      onPointerEnter={() => setHint(`${cp.label}: ${opts[v]}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, opts.map((o, i) => ({ label: o, radio: true, checked: i === v, onClick: () => commit(cp, i ? (cp.max ?? 1) : (cp.min ?? 0)) }))); }}>
      <svg width={ctl.w} height={ctl.h} style={{ display: 'block' }}>
        <rect x={0.5} y={0.5} width={ctl.w - 1} height={ctl.h - 1} rx={4} fill="rgba(0,0,0,0.32)" stroke="rgba(0,0,0,0.5)" />
        <rect x={v * half + 1.5} y={1.5} width={half - 3} height={ctl.h - 3} rx={3} fill="#f2f2f2" />
        {opts.map((o, i) => (
          <text key={i} x={i * half + half / 2} y={ctl.h / 2 + 3.4} textAnchor="middle" className="hm-dbl" fill={i === v ? '#202020' : 'rgba(255,255,255,0.72)'}>{o}</text>
        ))}
      </svg>
    </div>
  );
}

// ----------------------------------------------------------------- buttons

export type GlyphName = 'menu' | 'about' | 'browse' | 'kb' | 'vis' | 'link' | 'copy' | 'paste';

function glyphPath(g: GlyphName, s: number): ReactNode {
  const k = s / 16;
  const tr = `scale(${k})`;
  switch (g) {
    case 'menu': return <path transform={tr} d="M4 6 L12 6 L8 11 Z" fill="currentColor" />;
    case 'about': return <g transform={tr}><circle cx={8} cy={8} r={6} fill="none" stroke="currentColor" strokeWidth={1.5} /><rect x={7.2} y={7} width={1.6} height={5} fill="currentColor" /><rect x={7.2} y={4.2} width={1.6} height={1.6} fill="currentColor" /></g>;
    case 'browse': return <path transform={tr} d="M2 4 H6.5 L8 5.5 H14 V12.5 H2 Z" fill="none" stroke="currentColor" strokeWidth={1.4} />;
    case 'kb': return <g transform={tr} fill="currentColor"><rect x={2} y={4} width={12} height={8} rx={1} fill="none" stroke="currentColor" strokeWidth={1.3} /><rect x={4.6} y={4} width={1.4} height={4.5} /><rect x={7.3} y={4} width={1.4} height={4.5} /><rect x={10} y={4} width={1.4} height={4.5} /></g>;
    case 'vis': return <g transform={tr} fill="currentColor"><rect x={2.5} y={9} width={2} height={4} /><rect x={5.5} y={6} width={2} height={7} /><rect x={8.5} y={3.5} width={2} height={9.5} /><rect x={11.5} y={7} width={2} height={6} /></g>;
    case 'link': return <path transform={tr} d="M6.5 9.5 L9.5 6.5 M5 8 L3.5 9.5 A2 2 0 0 0 6.5 12.5 L8 11 M8 5 L9.5 3.5 A2 2 0 0 1 12.5 6.5 L11 8" stroke="currentColor" strokeWidth={1.5} fill="none" />;
    default: return null;
  }
}

/** A TQuickBtn with an icon (FS_SoberDarkBottom: dark rounded button). */
export function HButton({ ctl, glyph, hint, onClick, active, children, style }: {
  ctl: { x: number; y: number; w: number; h: number }; glyph?: GlyphName; hint: string; onClick: (e: React.PointerEvent) => void; active?: boolean; children?: ReactNode; style?: CSSProperties;
}) {
  const s = Math.min(ctl.w, ctl.h) - 8;
  return (
    <div className={'hm-ctl hm-btn' + (active ? ' on' : '')} style={abs(ctl, style)}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {glyph && <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`}>{glyphPath(glyph, s)}</svg>}
      {children}
    </div>
  );
}
