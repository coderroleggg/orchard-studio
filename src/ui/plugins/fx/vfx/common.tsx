// Shared look of FL's VFX (voice effect) plugin editors: the dark title band
// with the big italic "VFX" and the plugin name, FL's 16 note colours, the
// combo boxes (TQuickCombo) and the sheet tabs.

import type { CSSProperties, ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { useParam } from '../../kit';
import './vfx.css';

/** Canvas font stack (canvas does not resolve CSS variables). */
export const CANVAS_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';

/** FL's 16 piano-roll note colours, as the VFX editors paint them (sampled from VFX Color Mapper). */
export const NOTE_COLORS = [
  '#aee1b5', '#aedcc0', '#aed7cb', '#aed2d6', '#aecee1', '#bac6db', '#c7bed6', '#d4b6d0',
  '#e1aecb', '#e6b9c0', '#ecc4b6', '#f1cfac', '#f7daa2', '#e4dba6', '#d2ddab', '#c0dfb0',
];

/** Saturated note colours (VFX Keyboard Splitter zone numbers, Envelope colour box). */
export const NOTE_COLORS_VIVID = [
  '#ff8fa3', '#ffe36e', '#7cff7a', '#7af3ff', '#7ab6ff', '#e07aff', '#ff7ac8', '#ffb35e',
  '#d6ff6e', '#6effc4', '#6ee3ff', '#9e8cff', '#ff6ef0', '#ff8f6e', '#fff06e', '#9cff6e',
];

export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

/** The bottom title band: "VFX" in big grey italics and the plugin name. */
export function VfxTitle({ y, w, h, name, nameX, nameSize, children }: { y: number; w: number; h: number; name: string; nameX?: number; nameSize?: number; children?: ReactNode }) {
  return (
    <div className="vfx-title" style={{ left: 0, top: y, width: w, height: h }}>
      <span className="vfx-title-vfx" style={{ fontSize: Math.min(47, h * 0.84) }}>VFX</span>
      <span className="vfx-title-name" style={{ ...(nameX !== undefined ? { left: nameX, bottom: Math.max(3, h * 0.12) } : {}), ...(nameSize ? { fontSize: nameSize } : {}) }}>{name}</span>
      {children}
    </div>
  );
}

export interface ComboLook {
  bg: string;
  fg: string;
  arrow: string;
  radius?: number;
  font?: string;
}

/**
 * Combo box (TQuickCombo) bound to a parameter: click lists the options,
 * the wheel steps through them, right-click is the usual control menu
 * (reset, automation, value).
 */
export function ParamCombo({ k, x, y, w, h, look, text, options, menuTitle, style }: {
  k: string; x: number; y: number; w: number; h: number; look: ComboLook;
  /** Shown text for a value (default: the parameter's value text). */
  text?: (v: number) => string;
  /** List entries (default: the value text of every value). */
  options?: string[];
  menuTitle?: string;
  style?: CSSProperties;
}) {
  const p = useParam(k);
  const hnd = useControl({ ...p.control, travel: 120 }, 'vertical');
  const min = p.def.min, max = p.def.max;
  const label = text ? text(p.value) : p.control.format?.(p.value) ?? String(p.value);
  const opts = options ?? Array.from({ length: max - min + 1 }, (_, i) => (text ? text(min + i) : p.control.format?.(min + i) ?? String(min + i)));
  const pick = (v: number) => { p.control.onBegin?.(); p.set(v); p.control.onEnd?.(); };
  const open = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      ...(menuTitle ? [{ header: true, label: menuTitle } as MenuItem] : []),
      ...opts.map((o, i) => ({ label: o, radio: true, checked: min + i === Math.round(p.value), onClick: () => pick(min + i) } as MenuItem)),
    ];
    openMenu(r.left, r.bottom, items, { minWidth: r.width });
  };
  return (
    <div className="vfx-combo" style={{ left: x, top: y, width: w, height: h, background: look.bg, color: look.fg, borderRadius: look.radius ?? 4, font: look.font, ...style }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); open(e); } }}
      onWheel={hnd.onWheel} onContextMenu={hnd.onContextMenu}
      onPointerEnter={() => setHint(`${p.def.name}: ${label}`)} onPointerLeave={clearHint}>
      <span className="vfx-combo-text">{label}</span>
      <svg className="vfx-combo-arrow" width="7" height="10" viewBox="0 0 7 10"><path d="M0.5 0.5 L6.5 5 L0.5 9.5 Z" fill={look.arrow} /></svg>
    </div>
  );
}

/** FL's sheet tabs with a slanted right edge (TQuickTabSelector look of the VFX plugins). */
export function SheetTabs({ x, y, h, tabs, value, onChange, look }: {
  x: number; y: number; h: number;
  tabs: { label: string; w: number }[];
  value: number;
  onChange: (i: number) => void;
  look: { on: string; off: string; onText: string; offText: string; font: string; slant?: number; line?: string };
}) {
  const slant = look.slant ?? 12;
  let cx = x;
  const pos = tabs.map((t) => { const p = cx; cx += t.w; return p; });
  return (
    <>
      {tabs.map((t, i) => {
        const on = i === value;
        const w = t.w + slant;
        return (
          <div key={t.label} className="vfx-tab" style={{ left: pos[i], top: y, width: w, height: h, zIndex: on ? 3 : 2 - i * 0.01, font: look.font, color: on ? look.onText : look.offText }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(i); } }}>
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', left: 0, top: 0 }}>
              <path d={`M0 ${h} L0 6 Q0 1 6 1 L${t.w - 4} 1 Q${t.w} 1 ${t.w + 2} 5 L${w} ${h} Z`} fill={on ? look.on : look.off} stroke={look.line ?? 'none'} strokeWidth={look.line ? 1 : 0} />
            </svg>
            <span style={{ position: 'relative', paddingRight: slant * 0.6 }}>{t.label}</span>
          </div>
        );
      })}
    </>
  );
}

/** FL 2026's dark combo look (Key Mapper, Level Scaler, Sequencer). */
export const DARK_COMBO: ComboLook = { bg: '#2c3337', fg: '#e3e8ea', arrow: '#8d979c', radius: 2, font: '12px var(--font-ui)' };
export const DARK_COMBO_STYLE: CSSProperties = { boxShadow: 'inset 0 0 0 1px #20262a, 0 1px 0 rgba(255,255,255,0.06)' };

/**
 * FL 2026 horizontal slider (TVectorSlider): a rail with tick marks above it
 * and a black dome knob; `major` ticks only (Pitch slide) or one per step.
 */
export function TickSlider({ k, x, y, w, h, ticks, mark }: { k: string; x: number; y: number; w: number; h: number; ticks: number; mark?: string }) {
  const p = useParam(k);
  return <TickSliderControl x={x} y={y} w={w} h={h} ticks={ticks} mark={mark} control={p.control} id={k} />;
}

/** TickSlider driven by explicit ControlProps (plugin state rather than a parameter). */
export function TickSliderControl({ x, y, w, h, ticks, mark, control, id }: { x: number; y: number; w: number; h: number; ticks: number; mark?: string; control: ControlProps; id: string }) {
  const knob = 16;
  const travel = w - knob;
  const hnd = useControl({ ...control, travel }, 'horizontal');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  const cx = knob / 2 + t * travel;
  const rail = h / 2 + 3;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const tx = knob / 2 + (i / ticks) * travel;
          return <rect key={i} x={tx - 0.5} y={rail - 9} width={1} height={6} fill="#7b858b" />;
        })}
        <rect x={knob / 2 - 2} y={rail - 0.75} width={travel + 4} height={1.5} fill="#7b858b" />
        <ellipse cx={cx + 0.5} cy={rail + 2} rx={knob / 2} ry={knob / 2} fill="rgba(0,0,0,0.35)" />
        <defs>
          <radialGradient id={`tk-${id}`} cx="40%" cy="30%" r="75%">
            <stop offset="0" stopColor="#5d666c" />
            <stop offset="0.45" stopColor="#262b2f" />
            <stop offset="1" stopColor="#0d1012" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={rail} r={knob / 2} fill={`url(#tk-${id})`} stroke="#111416" strokeWidth={0.8} />
        {mark && <rect x={cx - 0.8} y={rail - knob / 2 + 2} width={1.6} height={knob - 4} fill={mark} />}
      </svg>
    </div>
  );
}

/** LED switch with its caption on the left (FL 2026 TVectorCheckBox: "Enable"). */
export function LedSwitch({ k, x, y, w, h, caption, color = '#ff6a3d' }: { k: string; x: number; y: number; w: number; h: number; caption: string; color?: string }) {
  const p = useParam(k);
  const on = p.value > p.def.min;
  return (
    <LedSwitchView x={x} y={y} w={w} h={h} caption={caption} color={color} on={on} hint={`${p.def.name}: ${on ? 'on' : 'off'}`}
      onToggle={() => { p.control.onBegin?.(); p.set(on ? p.def.min : p.def.max); p.control.onEnd?.(); }} />
  );
}

export function LedSwitchView({ x, y, w, h, caption, color = '#ff6a3d', on, onToggle, hint, align = 'right' }: {
  x: number; y: number; w: number; h: number; caption: string; color?: string; on: boolean; onToggle: () => void; hint?: string; align?: 'left' | 'right';
}) {
  const small = h < 16;
  return (
    <div className={'fxk-abs vfx-led-switch' + (small ? ' small' : '')} style={{ left: x, top: y, width: w, height: h, justifyContent: align === 'left' ? 'flex-start' : 'flex-end', flexDirection: align === 'left' ? 'row-reverse' : 'row' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      <span>{caption}</span>
      <span className="vfx-led" style={on ? { background: `radial-gradient(circle at 45% 40%, #ffffff 0, ${color} 45%, ${shade(color, 0.7)} 100%)` } : undefined} />
    </div>
  );
}
