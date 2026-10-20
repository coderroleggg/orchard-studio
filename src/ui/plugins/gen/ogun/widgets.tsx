// Ogun's vector controls (original drawings after FL 2026's TVectorWheel, TVectorSlider, TVectorCheckBox, TQuickCombo,
// TVectorDigiWheel, TPaintBoxSelector and TQuickXYZ), driven by FL's form properties (form.ts: position, colours, angles,
// pointer and cap styles) and bound through ControlProps (a parameter via useParam, or a setting). The wheel / slider
// drawings follow Harmor's (src/ui/plugins/gen/harmor/widgets.tsx, copied so the editors stay independent).

import { memo, useId, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useNoScrollWheel } from '../../kit';
import type { FCtl } from './form';

const abs = (c: { x: number; y: number; w: number; h: number }, extra?: CSSProperties): CSSProperties =>
  ({ position: 'absolute', left: c.x, top: c.y, width: c.w, height: c.h, ...extra });

/** Value position 0..1 of a control. */
export function frac(cp: ControlProps): number {
  const lo = cp.min ?? 0, hi = cp.max ?? 1;
  return Math.min(1, Math.max(0, (cp.value - lo) / (hi - lo || 1)));
}

/** Discrete one-shot change through the control's gesture callbacks. */
export function commit(cp: ControlProps, v: number): void {
  cp.onBegin?.();
  cp.onChange(Math.min(cp.max ?? v, Math.max(cp.min ?? v, v)));
  cp.onEnd?.();
}

/** Hint text of a control (FL's hint bar: "<name>: <value>"). */
function hintOf(cp: ControlProps): string {
  return `${cp.label}: ${cp.format ? cp.format(cp.value) : Math.round(cp.value)}`;
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
 * Sweep of an FL vector wheel from its StartAngle / EndAngle (radians, maths convention: 3pi/2 = bottom; the wheel turns
 * clockwise on screen from the start to the end, equal angles = a full turn): [start, end] in degrees clockwise from the top.
 */
export function wheelSweep(a0 = 4.7124, a1 = 4.7124): [number, number] {
  let gap = a1 - a0;
  if (gap < 0) gap += 2 * Math.PI;
  const sweep = 360 - (gap * 180) / Math.PI;
  const start = 90 - (a0 * 180) / Math.PI;
  const s = ((start % 360) + 360) % 360;
  const st = s > 180 ? s - 360 : s;
  return [st, st + sweep];
}

export interface WheelLook {
  fill?: string;
  rail?: string;
  cap?: string;
  ptr?: 's' | 'l' | 'n' | 'L';
  a0?: number;
  a1?: number;
  centered?: boolean;
}

/** The wheel drawing (size S): rail ring, value arc, shadowed body, pointer. */
export const WheelView = memo(function WheelView({ S, t, look, dim }: { S: number; t: number; look: WheelLook; dim?: boolean }) {
  const id = 'ow' + useId().replace(/:/g, '');
  const c = S / 2;
  const ring = Math.max(2, Math.round(S * (S >= 40 ? 0.085 : 0.11)));
  const rr = c - ring / 2 - 0.5;
  const [s0, s1] = wheelSweep(look.a0, look.a1);
  const ang = s0 + (s1 - s0) * Math.min(1, Math.max(0, t));
  const from = look.centered ? s0 + (s1 - s0) / 2 : s0;
  const rb = rr - ring / 2 - Math.max(1, S * 0.04);
  const fill = look.fill ?? '#33c1e1';
  const rail = look.rail ?? '#2e2329';
  const cap = look.cap ?? '#353e42';
  const ptr = look.ptr ?? 's';
  let p0 = 0.5, p1 = 0.92;
  if (ptr === 'l') { p0 = 0.18; p1 = 0.9; }
  if (ptr === 'L') { p0 = 0; p1 = 1.05; }
  const [x0, y0] = polar(c, c, rb * p0, ang);
  const [x1, y1] = polar(c, c, rb * p1, ang);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible', opacity: dim ? 0.55 : 1 }}>
      <defs>
        <radialGradient id={`${id}c`} cx="42%" cy="34%" r="72%">
          <stop offset="0" stopColor={cap} stopOpacity="1" />
          <stop offset="1" stopColor="#000" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      <path d={arcPath(c, c, rr, s0, s1)} stroke="rgba(0,0,0,0.45)" strokeWidth={ring + 1.4} fill="none" />
      <path d={arcPath(c, c, rr, s0, s1)} stroke={rail} strokeWidth={ring} fill="none" />
      <path d={arcPath(c, c, rr, from, ang)} stroke={fill} strokeWidth={ring} fill="none" />
      <circle cx={c} cy={c + Math.max(1, S * 0.05)} r={rb + 0.6} fill="rgba(0,0,0,0.45)" />
      <circle cx={c} cy={c} r={rb} fill={cap} />
      <circle cx={c} cy={c} r={rb} fill={`url(#${id}c)`} opacity={0.6} />
      <circle cx={c} cy={c} r={rb - 0.5} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={0.8} />
      {ptr !== 'n' && <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#e9e9e9" strokeWidth={Math.max(1.4, S * 0.07)} strokeLinecap="round" />}
    </svg>
  );
});

/** A wheel at FL's form position. */
export function OWheel({ ctl, cp, dim, look }: { ctl: FCtl; cp: ControlProps; dim?: boolean; look?: Partial<WheelLook> }) {
  const S = Math.min(ctl.w, ctl.h);
  const hnd = useControl({ travel: S >= 40 ? 220 : 180, ...cp }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const lk = useMemo<WheelLook>(() => ({ fill: ctl.fill, rail: ctl.rail, cap: ctl.cap, ptr: ctl.ptr, a0: ctl.a0, a1: ctl.a1, centered: ctl.centered, ...look }), [ctl, look]);
  return (
    <div ref={ref} className="og-ctl" style={abs({ x: ctl.x + (ctl.w - S) / 2, y: ctl.y + (ctl.h - S) / 2, w: S, h: S })} {...hnd}>
      <WheelView S={S} t={frac(cp)} dim={dim || cp.disabled} look={lk} />
    </div>
  );
}

// ----------------------------------------------------------------- slider

/** A TVectorSlider: rail with optional fill and inner ruler, rectangular handle (vertical). */
export function OSlider({ ctl, cp }: { ctl: FCtl; cp: ControlProps }) {
  const len = ctl.h;
  const hs = Math.min(len / 3, ctl.hs ?? 11);
  const hnd = useControl({ travel: Math.max(40, len - hs), ...cp }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="og-ctl" style={abs(ctl)} {...hnd}>
      <SliderView ctl={ctl} t={frac(cp)} disabled={!!cp.disabled} />
    </div>
  );
}

const SliderView = memo(function SliderView({ ctl, t, disabled }: { ctl: FCtl; t: number; disabled: boolean }) {
  const len = ctl.h;
  const hs = Math.min(len / 3, ctl.hs ?? 11);
  const W = ctl.w, H = ctl.h;
  const fill = ctl.fill ?? '#33c2e1';
  const rail = ctl.rail ?? '#575e6a';
  const handle = ctl.handle ?? '#5b5f66';
  const rs = Math.max(1, ctl.rs ?? 2);
  const els: ReactNode[] = [];
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
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible', opacity: disabled ? 0.5 : 1 }}>{els}</svg>;
});

// ------------------------------------------------------------------ check

/** A TVectorCheckBox: LED and FL's caption; `led` = where the lamp sits. */
export function OCheck({ ctl, on, onToggle, hint, caption, led = 'left' }: {
  ctl: FCtl; on: boolean; onToggle: () => void; hint: string; caption?: string; led?: 'left' | 'right' | 'center' | 'bottom';
}) {
  const cls = led === 'right' ? ' right' : led === 'bottom' ? ' bottom' : led === 'center' ? ' center' : '';
  const txt = caption ?? ctl.caption;
  return (
    <div className={'og-ctl og-check' + cls} style={abs(ctl)}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span className={'og-led' + (on ? ' on' : '')} />
      {txt ? <span>{txt}</span> : null}
    </div>
  );
}

export function OCheckCp({ ctl, cp, led }: { ctl: FCtl; cp: ControlProps; led?: 'left' | 'right' | 'center' | 'bottom' }) {
  const lo = cp.min ?? 0, hi = cp.max ?? 1;
  const on = cp.value > lo;
  return <OCheck ctl={ctl} on={on} hint={cp.label} led={led} onToggle={() => commit(cp, on ? lo : hi)} />;
}

// ------------------------------------------------------------------ combo

/** Menu items of an FL item list ('-Text' = a group caption, not selectable); Value indexes the selectable items. */
export function comboMenu(items: readonly string[], value: number, pick: (v: number) => void, marks?: ReadonlySet<number>): MenuItem[] {
  const out: MenuItem[] = [];
  let k = 0;
  for (const s of items) {
    if (s.startsWith('-')) { out.push({ header: true, label: s.slice(1) }); continue; }
    const v = k++;
    out.push({ label: marks?.has(v) ? `${s}  •` : s, radio: true, checked: v === Math.round(value), onClick: () => pick(v) });
  }
  return out;
}

/** A TQuickCombo: box with the current item and an arrow; a click opens the item menu, the wheel steps. */
export function OCombo({ ctl, cp, items, marks, disabled }: {
  ctl: FCtl; cp: ControlProps; items: readonly string[]; marks?: () => ReadonlySet<number>; disabled?: boolean;
}) {
  const sel = items.filter((s) => !s.startsWith('-'));
  const v = Math.round(cp.value);
  const text = sel[v] ?? '';
  const ref = useNoScrollWheel<HTMLDivElement>();
  const pick = (i: number) => commit(cp, i);
  return (
    <div ref={ref} className="og-ctl og-combo" style={abs(ctl, { background: ctl.color ?? '#6e7186', color: ctl.font ?? '#eaf0ff', opacity: disabled ? 0.55 : 1 })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        if (disabled) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, comboMenu(items, v, pick, marks?.()), { minWidth: Math.max(80, r.width) });
      }}
      onWheel={(e) => { e.stopPropagation(); if (disabled) return; const n = Math.min(sel.length - 1, Math.max(0, v + (e.deltaY > 0 ? 1 : -1))); if (n !== v) pick(n); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onPointerEnter={() => setHint(`${cp.label}: ${text}`)} onPointerLeave={clearHint}>
      <span className="og-combo-text">{text}</span>
      <span className="og-combo-arrow" />
    </div>
  );
}

// ------------------------------------------------------------------ digits

/** A TVectorDigiWheel: coloured digit box, vertical drag / wheel stepping. */
export function ODigi({ ctl, cp, text, flat, size }: { ctl: FCtl; cp: ControlProps; text?: string; flat?: boolean; size?: number }) {
  const range = (cp.max ?? 1) - (cp.min ?? 0);
  const hnd = useControl({ travel: Math.max(60, range * 8), step: 1, ...cp }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const label = text ?? (cp.format ? cp.format(cp.value) : String(Math.round(cp.value)));
  return (
    <div ref={ref} className={'og-ctl og-digi' + (flat ? ' flat' : '')}
      style={abs(ctl, { background: flat ? 'transparent' : ctl.color ?? '#525862', color: ctl.font ?? '#d7d7d7', fontSize: size ?? Math.min(15, ctl.h - 5) })} {...hnd}>
      {label}
    </div>
  );
}

// ---------------------------------------------------------------- selector

/** A TPaintBoxSelector: cells with captions in a row (or a column); a click or a drag across the cells selects. */
export function OCells({ ctl, cp, labels, hints }: { ctl: FCtl; cp: ControlProps; labels: readonly string[]; hints?: readonly string[] }) {
  const col = (ctl.rows ?? 1) > 1;
  const v = Math.round(cp.value - (cp.min ?? 0));
  const n = labels.length;
  const ref = useNoScrollWheel<HTMLDivElement>();
  const drag = useRef(false);
  const cellAt = (e: React.PointerEvent): number => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = col ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    return Math.min(n - 1, Math.max(0, Math.floor(f * n)));
  };
  const set = (i: number) => { if (i !== v) cp.onChange((cp.min ?? 0) + i); };
  return (
    <div ref={ref} className={'og-ctl og-cells' + (col ? ' col' : '')} style={abs(ctl)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = true;
        cp.onBegin?.();
        set(cellAt(e));
      }}
      onPointerMove={(e) => {
        if (drag.current) { set(cellAt(e)); return; }
        const i = cellAt(e);
        setHint(`${cp.label}: ${hints?.[i] ?? labels[i] ?? ''}`);
      }}
      onPointerUp={() => { if (drag.current) { drag.current = false; cp.onEnd?.(); } }}
      onPointerCancel={() => { if (drag.current) { drag.current = false; cp.onEnd?.(); } }}
      onWheel={(e) => { e.stopPropagation(); const i = Math.min(n - 1, Math.max(0, v + (e.deltaY > 0 ? 1 : -1))); if (i !== v) commit(cp, (cp.min ?? 0) + i); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onPointerLeave={clearHint}>
      {labels.map((s, i) => <div key={i} className={'og-cell' + (i === v ? ' on' : '')}>{s}</div>)}
    </div>
  );
}

// -------------------------------------------------------------------- xy pad

/** FL's X / Y modulation pad (TQuickXYZ, Ogun's cursor): drag sets both values, a right click jumps to the point. */
export function XYPad({ ctl, xp, yp }: { ctl: FCtl; xp: ControlProps; yp: ControlProps }) {
  const ref = useRef<HTMLDivElement>(null);
  const tx = frac(xp), ty = frac(yp);
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), fy = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    return [(xp.min ?? 0) + fx * ((xp.max ?? 1) - (xp.min ?? 0)), (yp.min ?? 0) + fy * ((yp.max ?? 1) - (yp.min ?? 0))] as const;
  };
  const put = (e: React.PointerEvent | React.MouseEvent) => {
    const [vx, vy] = at(e);
    xp.onChange(Math.round(vx));
    yp.onChange(Math.round(vy));
    setHint(`X: ${xp.format?.(Math.round(vx)) ?? Math.round(vx)}, Y: ${yp.format?.(Math.round(vy)) ?? Math.round(vy)}`);
  };
  const drag = useRef(false);
  const end = () => { if (drag.current) { drag.current = false; xp.onEnd?.(); yp.onEnd?.(); } };
  return (
    <div ref={ref} className="og-ctl og-xy" style={abs(ctl, { background: ctl.color ?? '#33393e' })}
      onPointerDown={(e) => {
        if (e.button === 2) { e.stopPropagation(); xp.onBegin?.(); yp.onBegin?.(); put(e); xp.onEnd?.(); yp.onEnd?.(); return; }
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = true;
        xp.onBegin?.(); yp.onBegin?.();
        put(e);
      }}
      onPointerMove={(e) => { if (drag.current) put(e); else setHint(`X / Y modulation: ${xp.format?.(xp.value) ?? xp.value}, ${yp.format?.(yp.value) ?? yp.value}`); }}
      onPointerUp={end} onPointerCancel={end}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onPointerLeave={() => { if (!drag.current) clearHint(); }}>
      <svg width={ctl.w} height={ctl.h} style={{ display: 'block' }}>
        <line x1={0} y1={ctl.h / 2} x2={ctl.w} y2={ctl.h / 2} stroke="rgba(255,255,255,0.06)" />
        <line x1={ctl.w / 2} y1={0} x2={ctl.w / 2} y2={ctl.h} stroke="rgba(255,255,255,0.06)" />
        <line x1={tx * ctl.w} y1={0} x2={tx * ctl.w} y2={ctl.h} stroke="rgba(185,184,195,0.45)" />
        <line x1={0} y1={(1 - ty) * ctl.h} x2={ctl.w} y2={(1 - ty) * ctl.h} stroke="rgba(185,184,195,0.45)" />
        <circle cx={tx * ctl.w} cy={(1 - ty) * ctl.h} r={4.2} fill="#33393e" stroke="#c3bab9" strokeWidth={1.6} />
      </svg>
    </div>
  );
}

// ----------------------------------------------------------------- buttons

export type GlyphName = 'menu' | 'kb' | 'random' | 'undo' | 'arrow' | 'freeze' | 'step' | 'snap' | 'slide' | 'points' | 'cf';

function glyph(g: GlyphName, s: number): ReactNode {
  const k = s / 16;
  const tr = `scale(${k})`;
  switch (g) {
    case 'menu': return <g transform={tr}><rect x={1.5} y={1.5} width={13} height={13} rx={3} fill="none" stroke="currentColor" strokeWidth={1.4} /><path d="M4.5 6.2 L8 10.2 L11.5 6.2" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></g>;
    case 'kb': return <g transform={tr} fill="currentColor"><rect x={1.5} y={3.5} width={13} height={9} rx={1.2} fill="none" stroke="currentColor" strokeWidth={1.3} /><rect x={4.4} y={3.5} width={1.5} height={5} /><rect x={7.3} y={3.5} width={1.5} height={5} /><rect x={10.2} y={3.5} width={1.5} height={5} /></g>;
    case 'random': return <g transform={tr}><rect x={2} y={2} width={12} height={12} rx={2.6} fill="none" stroke="currentColor" strokeWidth={1.4} /><circle cx={5.4} cy={5.4} r={1.1} fill="currentColor" /><circle cx={10.6} cy={5.4} r={1.1} fill="currentColor" /><circle cx={8} cy={8} r={1.1} fill="currentColor" /><circle cx={5.4} cy={10.6} r={1.1} fill="currentColor" /><circle cx={10.6} cy={10.6} r={1.1} fill="currentColor" /></g>;
    case 'undo': return <path transform={tr} d="M6 4 L2.5 7 L6 10 M3 7 H10 A3.5 3.5 0 0 1 10 14 H7" fill="none" stroke="currentColor" strokeWidth={1.4} />;
    case 'arrow': return <path transform={tr} d="M4 5 L12 5 L8 11 Z" fill="currentColor" />;
    case 'freeze': return <path transform={tr} d="M8 1.5 V14.5 M2.5 4.5 L13.5 11.5 M13.5 4.5 L2.5 11.5" stroke="currentColor" strokeWidth={1.5} fill="none" />;
    case 'step': return <path transform={tr} d="M1.5 12 H5 V8 H8.5 V4 H12 V1.5 M12 4 H14.5" stroke="currentColor" strokeWidth={1.5} fill="none" />;
    case 'snap': return <path transform={tr} d="M2 2.5 H14 M2 8 H14 M2 13.5 H14 M4.5 1 V15 M11.5 1 V15" stroke="currentColor" strokeWidth={1.1} fill="none" opacity={0.95} />;
    case 'slide': return <path transform={tr} d="M1 8 H15 M11 4 L15 8 L11 12 M4.5 4.5 V11.5" stroke="currentColor" strokeWidth={1.5} fill="none" />;
    case 'points': return <path transform={tr} d="M2.5 2 V14 M8 2 V14 M13.5 2 V14" stroke="currentColor" strokeWidth={1.3} strokeDasharray="2.4 1.8" fill="none" />;
    case 'cf': return <path transform={tr} d="M1.5 11.5 C4 3, 7 14, 9.5 7.5 S13 3, 14.5 5" stroke="currentColor" strokeWidth={1.5} fill="none" />;
  }
}

/** A TQuickBtn with an original glyph. */
export function OButton({ ctl, g, hint, onClick, on, style, className }: {
  ctl: { x: number; y: number; w: number; h: number }; g: GlyphName; hint: string; onClick: (e: React.PointerEvent) => void; on?: boolean; style?: CSSProperties; className?: string;
}) {
  const s = Math.min(ctl.w, ctl.h) - 3;
  return (
    <div className={'og-ctl og-btn' + (on ? ' on' : '') + (className ? ' ' + className : '')} style={abs(ctl, style)}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`}>{glyph(g, s)}</svg>
    </div>
  );
}
