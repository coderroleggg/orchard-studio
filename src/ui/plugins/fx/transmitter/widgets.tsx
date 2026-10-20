// Transmitter's vector widgets (FL 2026 "Transmitter" look): ring knobs with
// the value inside, the level fader with tick marks, dark value / combo boxes,
// vertical section tabs with the on/off LED and the light routing selectors.

import { memo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { useParam } from '../../kit';
import type { TxTheme } from './theme';

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

/** Inner value text: FL's value text without its unit. */
export function innerText(s: string): string {
  return s.replace(/ (ms|s)$/, '');
}

export interface KnobProps {
  k: string;
  x: number;
  y: number;
  /** Knob diameter (the form wheel's width). */
  size: number;
  theme: TxTheme;
  disabled?: boolean;
  /** Caption below the knob, centred at captionY (form px). */
  caption?: string;
  captionY?: number;
  /** Override of the inner text. */
  text?: (v: number) => string;
  fontSize?: number;
}

/** Ring knob: dark face with the value inside, thin outer track and value arc. */
export const TxKnob = memo(function TxKnob({ k, x, y, size, theme, disabled, caption, captionY, text, fontSize }: KnobProps) {
  const p = useParam(k, disabled ? { disabled: true } : undefined);
  const cp: ControlProps = { ...p.control, travel: 200 };
  const h = useControl(cp, 'vertical');
  const S = size, c = S / 2;
  const ringW = S >= 70 ? 2.6 : 2;
  const rRing = c - ringW / 2 - 0.5;
  const rFace = S * (S >= 70 ? 0.35 : 0.315);
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const ang = START + SWEEP * t;
  const from = p.def.bipolar ? 0 : START;
  const label = text ? text(p.value) : innerText(p.control.format ? p.control.format(p.value) : String(p.value));
  const fs = fontSize ?? (S >= 70 ? 11 : 9);
  return (
    <>
      <div className="fxk-abs" style={{ left: x, top: y, width: S, height: S, touchAction: 'none', cursor: 'default', opacity: disabled ? 0.45 : 1 }} {...h}>
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
          <path d={arcPath(c, c, rRing, START, START + SWEEP)} stroke={theme.knobTrack} strokeWidth={ringW} fill="none" />
          {Math.abs(ang - from) > 0.3 && <path d={arcPath(c, c, rRing, from, ang)} stroke={theme.accent} strokeWidth={ringW} fill="none" />}
          <circle cx={c} cy={c} r={rFace} fill={theme.knobFace} />
          <circle cx={c} cy={c} r={rFace - 0.5} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
        </svg>
        <div style={{
          position: 'absolute', left: 0, top: 0, width: S, height: S, textAlign: 'center',
          color: theme.knobText, font: `600 ${fs}px ${theme.font}`, lineHeight: `${S}px`, letterSpacing: '0.02em', pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>{label}</div>
      </div>
      {caption && captionY !== undefined && <Caption x={x + S / 2} y={captionY} theme={theme} dim={disabled}>{caption}</Caption>}
    </>
  );
});

export function Caption({ x, y, children, theme, w = 90, dim, align = 'center', style }: { x: number; y: number; children: ReactNode; theme: TxTheme; w?: number; dim?: boolean; align?: 'center' | 'left'; style?: CSSProperties }) {
  return (
    <div className="fxk-abs" style={{
      left: align === 'center' ? x - w / 2 : x, top: y - 6, width: w, height: 12, textAlign: align,
      color: theme.caption, font: `500 9.5px ${theme.font}`, lineHeight: '12px', letterSpacing: '0.07em', pointerEvents: 'none', whiteSpace: 'nowrap',
      opacity: dim ? 0.5 : 1, ...style,
    }}>{children}</div>
  );
}

/** Dark rounded box with centred text (value display, combo face). */
export function DarkBox({ x, y, w, h, children, theme, arrow, onPointerDown, onContextMenu, hint, style }: {
  x: number; y: number; w: number; h: number; children: ReactNode; theme: TxTheme; arrow?: boolean;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void; onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  hint?: string; style?: CSSProperties;
}) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 3, background: theme.box, boxShadow: `inset 0 0 0 1px ${theme.boxEdge}`,
      color: theme.boxText, font: `600 9px ${theme.font}`, letterSpacing: '0.04em', textAlign: 'center',
      whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'default', ...style, lineHeight: `${h}px`,
    }}
      onPointerDown={onPointerDown} onContextMenu={onContextMenu ?? ((e) => e.preventDefault())}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {children}
      {arrow && <svg width={4} height={6} style={{ position: 'absolute', right: 5, top: (h - 6) / 2 }}><path d="M0 0 L4 3 L0 6 Z" fill={theme.boxArrow} /></svg>}
    </div>
  );
}

/** Option combo (TQuickCombo): face shows the selected item; click / right-click opens the list. */
export function TxCombo({ k, x, y, w, h, items, theme, header }: { k: string; x: number; y: number; w: number; h: number; items: string[]; theme: TxTheme; header?: string }) {
  const p = useParam(k);
  const idx = Math.round(p.value - p.def.min);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  const open = (cx: number, cy: number) => {
    const list: MenuItem[] = [];
    if (header) list.push({ header: true, label: header });
    items.forEach((it, i) => list.push({ label: it.charAt(0) + it.slice(1).toLowerCase(), checked: i === idx, radio: true, onClick: () => pick(i) }));
    openMenu(cx, cy, list);
  };
  return (
    <DarkBox x={x} y={y} w={w} h={h} theme={theme} arrow hint={`${p.def.name}: ${p.def.options?.[idx] ?? items[idx] ?? ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        open(r.left, r.bottom);
      }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); open(e.clientX, e.clientY); }}>
      <span style={{ paddingRight: 6 }}>{items[idx] ?? ''}</span>
    </DarkBox>
  );
}

/** Level fader (TVectorSlider, vertical) with FL's tick marks and blue fill under the cap. */
export function TxFader({ x, y, w, h, control, theme }: { x: number; y: number; w: number; h: number; control: ControlProps; theme: TxTheme }) {
  const capH = 11, capW = 20;
  const top = 5, bot = h - 5; // travel of the cap centre
  const hnd = useControl({ ...control, travel: bot - top }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const cy = bot - t * (bot - top);
  const cx = w / 2;
  const ticks: number[] = [];
  for (let i = 0; i <= 16; i++) ticks.push(top + ((bot - top) * i) / 16);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none', cursor: 'default' }} {...hnd}>
      <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
        {ticks.map((ty, i) => (
          <g key={i}>
            <line x1={cx - 7} x2={cx - 4} y1={ty} y2={ty} stroke={theme.tick} strokeWidth={1} />
            <line x1={cx + 4} x2={cx + 7} y1={ty} y2={ty} stroke={theme.tick} strokeWidth={1} />
          </g>
        ))}
        <line x1={cx} x2={cx} y1={top} y2={bot} stroke={theme.faderTrack} strokeWidth={2} />
        <line x1={cx} x2={cx} y1={cy} y2={bot} stroke={theme.accent} strokeWidth={1.6} />
        <defs>
          <linearGradient id="txcap" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={theme.capTop} />
            <stop offset="0.5" stopColor={theme.capMid} />
            <stop offset="1" stopColor={theme.capBot} />
          </linearGradient>
        </defs>
        <rect x={cx - capW / 2} y={cy - capH / 2} width={capW} height={capH} rx={3} fill="url(#txcap)" stroke="#121619" strokeWidth={0.8} />
        <line x1={cx - capW / 2 + 2} x2={cx + capW / 2 - 2} y1={cy} y2={cy} stroke={theme.capLine} strokeWidth={1} />
      </svg>
    </div>
  );
}

/** Vertical section tab ("DETECTION", "TRANSIENT", "SUSTAIN") with an optional LED at the top. */
export function SectionTab({ x, y, w, h, label, theme, led, ledOn, onLed, onLedMenu, ledHint, textTop }: {
  x: number; y: number; w: number; h: number; label: string; theme: TxTheme;
  led?: boolean; ledOn?: boolean; onLed?: () => void; onLedMenu?: (e: React.MouseEvent) => void; ledHint?: string; textTop?: number;
}) {
  const tt = textTop ?? (led ? 16 : 3);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, borderRadius: 3, background: theme.tab }}>
      <div style={{
        position: 'absolute', left: w / 2, top: tt + (h - tt) / 2, transform: 'translate(-50%, -50%) rotate(-90deg)',
        color: theme.tabText, font: `600 10px ${theme.font}`, lineHeight: '12px', letterSpacing: '0.12em', whiteSpace: 'nowrap', pointerEvents: 'none',
      }}>{label}</div>
      {led && (
        <div style={{ position: 'absolute', left: (w - 9) / 2, top: 3, width: 9, height: 9, cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onLed?.(); } }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onLedMenu?.(e); }}
          onPointerEnter={() => ledHint && setHint(ledHint)} onPointerLeave={clearHint}>
          <div style={{
            width: 9, height: 9, borderRadius: '50%', boxSizing: 'border-box',
            background: ledOn ? theme.accent : theme.ledOff, border: `1px solid ${ledOn ? theme.ledRim : '#11161a'}`,
            boxShadow: ledOn ? `0 0 3px ${theme.accent}` : 'none',
          }} />
        </div>
      )}
    </div>
  );
}

/**
 * Routing selector (TVectorDigiWheel with Caption '⋯'): shows the selected
 * number or "⋯" for none; drag or wheel to step, right-click for the list.
 */
export function RouteBox({ x, y, w, h, value, count, onSet, menu, hint, theme }: {
  x: number; y: number; w: number; h: number; value: number; count: number; onSet: (v: number) => void;
  menu: (cx: number, cy: number) => void; hint: () => string; theme: TxTheme;
}) {
  const drag = useRef<{ y: number; start: number } | null>(null);
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 2, background: theme.route, boxShadow: `inset 0 0 0 1px ${theme.routeEdge}`,
      cursor: 'ns-resize', touchAction: 'none',
    }}
      onPointerEnter={() => setHint(hint())} onPointerLeave={() => { if (!drag.current) clearHint(); }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, start: value };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const v = Math.max(0, Math.min(count, d.start + Math.round((d.y - e.clientY) / 8)));
        if (v !== value) onSet(v);
        setHint(hint());
      }}
      onPointerUp={() => { drag.current = null; }}
      onWheel={(e) => { e.stopPropagation(); onSet(Math.max(0, Math.min(count, value + (e.deltaY < 0 ? 1 : -1)))); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); menu(e.clientX, e.clientY); }}>
      <div style={{
        position: 'absolute', right: 8, top: 0, height: h, color: theme.routeText,
        font: value > 0 ? `500 10px ${theme.font}` : `700 9px ${theme.font}`, lineHeight: `${h}px`, pointerEvents: 'none',
      }}>{value > 0 ? String(value) : '⋯'}</div>
      <svg width={5} height={9} style={{ position: 'absolute', right: 2, top: (h - 9) / 2, pointerEvents: 'none' }}>
        <path d="M1 1.5 Q4 3 2.5 4.5 Q1 6 4 7.5" fill="none" stroke={theme.routeText} strokeWidth={0.9} opacity={0.7} />
      </svg>
    </div>
  );
}

/** Flat text switch of the bottom bar (STEREO LINK, LOOKAHEAD): blue text when on. */
export function TextSwitch({ x, y, w, h, label, on, onClick, hint, theme }: { x: number; y: number; w: number; h: number; label: string; on: boolean; onClick: () => void; hint: string; theme: TxTheme }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, textAlign: 'center', cursor: 'default',
      color: on ? theme.switchOn : theme.switchOff, font: `500 9.5px ${theme.font}`, lineHeight: `${h}px`, letterSpacing: '0.01em', whiteSpace: 'nowrap',
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{label}</div>
  );
}
