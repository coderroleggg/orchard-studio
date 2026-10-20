// Slicex editor widgets, drawn after FL 2026's Slicex (form styles and colours from the editor form,
// shapes from FL's editor thumbnail; original drawing): bevelled knobs with a long pointer (TVectorWheel
// VWC_Bevelled / VWP_LongLine), gear-outline knobs (Mod X / Y), master sliders with an orange filled
// gauge rail (TVectorSlider VSR_GaugeDarkCenter), cell selectors (TPaintBoxSelector), flat combos
// (TQuickCombo FS_SoberFlat), LED switches (TVectorCheckBox), the deck toolbar's buttons (TQuickBtn
// FS_ChannelPulse / FS_Sober) and numeric boxes (TVectorDigiWheel without arrows).

import type { CSSProperties, ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useNoScrollWheel } from '../../kit';
import { store } from '../../../../store';

export const ORANGE = '#ffa830';
export const TXT = '#e9edfa';
export const DIM = '#959ea6';

/** Delphi TColor (0x00BBGGRR) -> CSS. */
export const tcolor = (c: number): string => `rgb(${c & 0xff},${(c >> 8) & 0xff},${(c >> 16) & 0xff})`;

export const hintProps = (s: string | (() => string)) => ({
  onPointerEnter: () => setHint(typeof s === 'string' ? s : s()),
  onPointerLeave: clearHint,
});

const box = (x: number, y: number, w: number, h: number, extra?: CSSProperties): CSSProperties => ({ left: x, top: y, width: w, height: h, ...extra });

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** A control bound to plugin state (not an FL parameter): one undo step per gesture. */
export function stateControl(label: string, value: number, min: number, max: number, def: number, set: (v: number) => void, format?: (v: number) => string): ControlProps {
  return {
    value, min, max, defaultValue: def, label, step: 1, format: format ?? ((v) => String(Math.round(v))),
    onChange: (v) => set(Math.round(Math.max(min, Math.min(max, v)))),
    onBegin: () => store.beginGesture(label),
    onEnd: () => store.endGesture(),
  };
}

// ------------------------------------------------------------------ knobs

export interface KnobLook {
  /** Pointer colour (FL FillColor). */
  color?: string;
  /** Cap colour (FL CapColor). */
  cap?: string;
  /** Rotation range in degrees (FL Start / EndAngle). */
  sweep?: number;
  /** 'line': VWP_LongLine on a bevelled cap; 'gear': VWC_GearOutline with dents (Mod X / Y). */
  style?: 'line' | 'gear';
  bipolar?: boolean;
}

export function KnobView({ size, t, color = ORANGE, cap = '#515b62', sweep = 308.6, style = 'line', disabled }: KnobLook & { size: number; t: number; disabled?: boolean }) {
  const c = size / 2;
  const r = c - 0.75;
  const ang = -sweep / 2 + sweep * Math.min(1, Math.max(0, t));
  const id = `sxk${Math.round(size * 10)}`;
  if (style === 'gear') {
    const [x0, y0] = polar(c, c, 0, ang), [x1, y1] = polar(c, c, r * 0.86, ang);
    const dents = Array.from({ length: 5 }, (_, i) => {
      const a = -sweep / 2 + (sweep * i) / 4;
      const [ax, ay] = polar(c, c, r - 1.2, a), [bx, by] = polar(c, c, r + 0.4, a);
      return <path key={i} d={`M${ax} ${ay} L${bx} ${by}`} stroke="#2a3034" strokeWidth={1.3} />;
    });
    return (
      <svg width={size} height={size} style={{ display: 'block', opacity: disabled ? 0.45 : 1 }}>
        <circle cx={c} cy={c} r={r - 0.6} fill="none" stroke={color} strokeWidth={1.4} />
        {dents}
        <path d={`M${x0} ${y0} L${x1} ${y1}`} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      </svg>
    );
  }
  const [x0, y0] = polar(c, c, r * 0.3, ang), [x1, y1] = polar(c, c, r * 0.86, ang);
  return (
    <svg width={size} height={size} style={{ display: 'block', opacity: disabled ? 0.45 : 1 }}>
      <defs>
        <radialGradient id={id} cx="38%" cy="30%" r="80%">
          <stop offset="0" stopColor="#7d878e" />
          <stop offset="0.55" stopColor={cap} />
          <stop offset="1" stopColor="#30373b" />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c + 0.6} r={r} fill="rgba(0,0,0,0.35)" />
      <circle cx={c} cy={c} r={r - 0.4} fill={`url(#${id})`} stroke="#2b3134" strokeWidth={0.8} />
      <circle cx={c} cy={c} r={r * 0.7} fill={cap} opacity={0.55} />
      <path d={`M${x0} ${y0} L${x1} ${y1}`} stroke={color} strokeWidth={Math.max(1.6, size * 0.085)} strokeLinecap="round" />
    </svg>
  );
}

export function Knob({ x, y, size, control, hint, ...look }: KnobLook & { x: number; y: number; size: number; control: ControlProps; hint?: string }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="fxk-abs sx-knob" style={box(x, y, size, size)} {...h} {...(hint ? hintProps(hint) : {})}>
      <KnobView size={size} t={(control.value - min) / (max - min || 1)} {...look} disabled={control.disabled} />
    </div>
  );
}

// ------------------------------------------------------------------ master sliders

/** FL's master slider: ruler ticks, a 2 px rail filled orange from the bottom (or the centre) to the handle. */
export function MasterSlider({ x, y, w, h, control, centered }: { x: number; y: number; w: number; h: number; control: ControlProps; centered?: boolean }) {
  const HH = 11;
  const hnd = useControl({ travel: h - HH, ...control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const top = 3, bot = h - 3;
  const yv = bot - t * (bot - top);
  const y0 = centered ? (top + bot) / 2 : bot;
  const cx = w / 2;
  const ticks: ReactNode[] = [];
  for (let i = 0; i <= 10; i++) {
    const ty = Math.round(top + ((bot - top) * i) / 10) + 0.5;
    const big = i % 5 === 0;
    ticks.push(<path key={i} d={`M${cx - (big ? 8 : 6)} ${ty} H${cx - 3} M${cx + 3} ${ty} H${cx + (big ? 8 : 6)}`} stroke={big ? '#4b5257' : '#3a4044'} strokeWidth={1} />);
  }
  return (
    <div ref={ref} className="fxk-abs sx-slider" style={box(x, y, w, h)} {...hnd}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {ticks}
        <rect x={cx - 2.5} y={top - 1} width={5} height={bot - top + 2} rx={1} fill="#070909" />
        <rect x={cx - 2} y={top} width={4} height={bot - top} fill="#2f3133" />
        <rect x={cx - 0.5} y={top} width={1} height={bot - top} fill="#535353" />
        {Math.abs(yv - y0) > 0.5 && <rect x={cx - 2} y={Math.min(yv, y0)} width={4} height={Math.abs(yv - y0)} fill={ORANGE} />}
        {Math.abs(yv - y0) > 0.5 && <rect x={cx - 0.5} y={Math.min(yv, y0)} width={1} height={Math.abs(yv - y0)} fill="#b8701c" />}
        <g transform={`translate(${cx - 7.5} ${Math.round(yv - HH / 2)})`}>
          <rect x={0} y={0} width={15} height={HH} rx={1.5} fill="#494e52" stroke="#1d2124" strokeWidth={0.8} />
          <rect x={1} y={1} width={13} height={4} rx={1} fill="#5c6267" />
          <rect x={2} y={HH / 2 - 0.5} width={11} height={1} fill="#9aa1a6" />
        </g>
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ selectors

/**
 * FL's TPaintBoxSelector: one cell per option (`cols` x `rows`), the selected one lit; dragging across
 * the cells selects (seCanSlide). `cell` renders a cell's content.
 */
export function Selector({ x, y, w, h, n, cols, value, onChange, cell, hints, className, style, cellStyle }: {
  x: number; y: number; w: number; h: number; n: number; cols?: number; value: number; onChange: (i: number) => void;
  cell: (i: number, on: boolean) => ReactNode; hints?: (i: number) => string; className?: string; style?: CSSProperties;
  cellStyle?: (i: number, on: boolean) => CSSProperties;
}) {
  const nc = cols ?? n;
  const nr = Math.ceil(n / nc);
  const cw = w / nc, ch = h / nr;
  const pick = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cx = Math.floor(((e.clientX - r.left) / r.width) * nc), cy = Math.floor(((e.clientY - r.top) / r.height) * nr);
    const i = Math.max(0, Math.min(n - 1, cy * nc + Math.max(0, Math.min(nc - 1, cx))));
    if (i !== value) onChange(i);
    if (hints) setHint(hints(i));
  };
  return (
    <div className={'fxk-abs sx-sel' + (className ? ' ' + className : '')} style={box(x, y, w, h, style)}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); pick(e); }}
      onPointerMove={(e) => {
        if ((e.buttons & 1) && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) pick(e);
        else if (hints) {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const i = Math.floor(((e.clientY - r.top) / r.height) * nr) * nc + Math.floor(((e.clientX - r.left) / r.width) * nc);
          if (i >= 0 && i < n) setHint(hints(i));
        }
      }}
      onPointerLeave={clearHint}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={'sx-sel-cell' + (i === value ? ' on' : '')}
          style={{ left: (i % nc) * cw, top: Math.floor(i / nc) * ch, width: cw, height: ch, ...(cellStyle ? cellStyle(i, i === value) : {}) }}>
          {cell(i, i === value)}
        </div>
      ))}
    </div>
  );
}

/** FL's flat combo (TQuickCombo FS_SoberFlat): the text and a down arrow; `onOpen` shows the list. */
export function Combo({ x, y, w, h, text, color, onOpen, hint, onContextMenu }: {
  x: number; y: number; w: number; h: number; text: string; color: string; onOpen: (e: React.PointerEvent) => void; hint?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="fxk-abs sx-combo" style={box(x, y, w, h, { background: color })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onOpen(e); } }}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu?.(e); }}
      {...(hint ? hintProps(hint) : {})}>
      <span className="sx-combo-text">{text}</span>
      <svg className="sx-combo-arrow" width={8} height={5} viewBox="0 0 8 5"><path d="M0 0 H8 L4 5 Z" fill="currentColor" /></svg>
    </div>
  );
}

/** LED switch (TVectorCheckBox FS_Transparent, P_SmallBold caption). */
export function Led({ x, y, w, h, caption, on, onToggle, hint, ledRight }: {
  x: number; y: number; w: number; h: number; caption: string; on: boolean; onToggle: () => void; hint?: string; ledRight?: boolean;
}) {
  const led = <span className={'sx-led' + (on ? ' on' : '')} />;
  return (
    <div className="fxk-abs sx-check" style={box(x, y, w, h)}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      {...hintProps(() => `${hint ?? caption}: ${on ? 'on' : 'off'}`)}>
      {!ledRight && led}
      <span className="sx-check-cap">{caption}</span>
      {ledRight && led}
    </div>
  );
}

/** Numeric box (TVectorDigiWheel, VDWA_None): drag vertically / wheel; `nul` is shown for the null value. */
export function Digi({ x, y, w, h, control, nul, onContextMenu }: { x: number; y: number; w: number; h: number; control: ControlProps; nul?: number; onContextMenu?: (e: React.MouseEvent) => void }) {
  const hnd = useControl({ travel: Math.max(60, ((control.max ?? 1) - (control.min ?? 0)) * 4), ...control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const text = nul !== undefined && control.value === nul ? '⋯' : control.format ? control.format(control.value) : String(control.value);
  return (
    <div ref={ref} className="fxk-abs sx-digi" style={box(x, y, w, h)} {...hnd}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e); } : hnd.onContextMenu}>
      {text}
    </div>
  );
}

/** Caption text (FL paints the section captions in code: "REGION SETTINGS", "ARTICULATOR"...). */
export function Cap({ x, y, w, h = 11, children, align = 'left', color, size = 8.5, style }: {
  x: number; y: number; w: number; h?: number; children: ReactNode; align?: 'left' | 'center' | 'right'; color?: string; size?: number; style?: CSSProperties;
}) {
  return <div className="fxk-abs sx-cap" style={box(x, y, w, h, { textAlign: align, color, fontSize: size, lineHeight: `${h}px`, ...style })}>{children}</div>;
}

/** Deck toolbar button (TQuickBtn FS_ChannelPulse 24 x 34: glyph on top, a down arrow for menus). */
export function ToolBtn({ x, y, w = 24, h = 34, children, hint, onClick, onMenu, arrow, active }: {
  x: number; y: number; w?: number; h?: number; children: ReactNode; hint: string; onClick?: (e: React.PointerEvent) => void;
  onMenu?: (e: React.MouseEvent) => void; arrow?: boolean; active?: boolean;
}) {
  return (
    <div className={'fxk-abs sx-tool' + (active ? ' on' : '')} style={box(x, y, w, h)}
      onPointerDown={(e) => { if (e.button === 0 && onClick) { e.stopPropagation(); onClick(e); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu?.(e); }}
      {...hintProps(hint)}>
      <div className="sx-tool-glyph">{children}</div>
      {arrow && <svg className="sx-tool-arrow" width={7} height={4} viewBox="0 0 7 4"><path d="M0 0 H7 L3.5 4 Z" fill="currentColor" /></svg>}
    </div>
  );
}

/** Small transparent glyph button (TQuickBtn FS_VectorTransparent). */
export function GlyphBtn({ x, y, w, h, children, hint, onClick, onMenu, on, color }: {
  x: number; y: number; w: number; h: number; children: ReactNode; hint: string; onClick?: (e: React.PointerEvent) => void;
  onMenu?: (e: React.MouseEvent) => void; on?: boolean; color?: string;
}) {
  return (
    <div className={'fxk-abs sx-glyph' + (on ? ' on' : '')} style={box(x, y, w, h, on && color ? { color } : undefined)}
      onPointerDown={(e) => { if (e.button === 0 && onClick) { e.stopPropagation(); onClick(e); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu?.(e); }}
      {...hintProps(hint)}>
      {children}
    </div>
  );
}

/** Opens a menu under an element (FL's Popup_Bottom). */
export function below(e: React.PointerEvent | React.MouseEvent): [number, number] {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return [r.left, r.bottom];
}
