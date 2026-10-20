// FL vector controls used by effect editors, positioned in editor pixels
// (the coordinates of FL's editor forms): panel, bevels, labels, numeric
// spinners (TVectorDigiWheel), sliders, tab selectors, pill switches, LED
// check boxes, icon buttons and canvas displays.

import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../widgets/control';
import { openMenu, type MenuItem } from '../../widgets/ContextMenu';
import { setHint, clearHint } from '../../hint';
import { useParam } from './context';
import './kit.css';

type Box = { x: number; y: number; w: number; h: number };

/**
 * React's wheel listeners are passive, so a wheel turn over a control inside
 * a scrolling editor would also scroll it: block the default natively.
 */
export function useNoScrollWheel<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const block = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', block, { passive: false });
    return () => el.removeEventListener('wheel', block);
  }, []);
  return ref;
}

const abs = (b: Box, extra?: CSSProperties): CSSProperties => ({ left: b.x, top: b.y, width: b.w, height: b.h, ...extra });

/** The editor surface (FL's SynthPanel): fixed size, FL's grey-blue plugin background. */
export function FxPanel({ width, height, children, className, style }: { width: number; height: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={'fxk-panel' + (className ? ' ' + className : '')} style={{ width, height, ...style }}>
      {children}
    </div>
  );
}

/** Inset panel (TVectorBevel); with `title` it gets FL's section title bar. */
export function Bevel({ x, y, w, h, title, titleH = 18, tone = 'dark', children, style }: Box & { title?: string; titleH?: number; tone?: 'dark' | 'darker' | 'light'; children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className={`fxk-abs fxk-bevel ${tone}`} style={abs({ x, y, w, h }, style)}>
      {title !== undefined && <div className="fxk-bevel-title" style={{ height: titleH, lineHeight: `${titleH}px` }}>{title}</div>}
      {children}
    </div>
  );
}

/** Caption text (TQuickLabel): uppercase, centred in its box by default. */
export function Label({ x, y, w, h = 15, children, align = 'center', size = 11, color, bold, style }: Omit<Box, 'h'> & { h?: number; children: ReactNode; align?: 'left' | 'center' | 'right'; size?: number; color?: string; bold?: boolean; style?: CSSProperties }) {
  return (
    <div className="fxk-abs fxk-label" style={abs({ x, y, w, h }, { textAlign: align, fontSize: size, lineHeight: `${h}px`, color, fontWeight: bold ? 600 : undefined, ...style })}>
      {children}
    </div>
  );
}

/** Numeric spinner (TVectorDigiWheel): drag vertically, wheel, or click the arrows. */
export const DigiWheel = memo(function DigiWheel({ k, x, y, w, h, text, control: over }: Box & { k: string; text?: (v: number) => string; control?: Partial<ControlProps> }) {
  const p = useParam(k, over);
  return <DigiWheelControl x={x} y={y} w={w} h={h} control={p.control} text={text} />;
});

export function DigiWheelControl({ x, y, w, h, control, text }: Box & { control: ControlProps; text?: (v: number) => string }) {
  const hnd = useControl({ travel: Math.max(60, ((control.max ?? 1) - (control.min ?? 0)) * 6), ...control }, 'vertical');
  const step = control.step && control.step > 0 ? control.step : 1;
  const bump = (d: number) => {
    const v = Math.min(control.max ?? 1, Math.max(control.min ?? 0, control.value + d * step));
    control.onBegin?.();
    control.onChange(v);
    control.onEnd?.();
  };
  const label = text ? text(control.value) : control.format ? control.format(control.value) : String(control.value);
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={wheelRef} className="fxk-abs fxk-digi" style={abs({ x, y, w, h })}>
      <div className="fxk-digi-val" {...hnd}>{label}</div>
      <div className="fxk-digi-arrows">
        <div onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) bump(1); }} />
        <div onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) bump(-1); }} />
      </div>
    </div>
  );
}

/** Slider (TVectorSlider) with FL's rectangular cap; vertical when taller than wide. */
export const Slider = memo(function Slider({ k, x, y, w, h, capColor, control: over }: Box & { k: string; capColor?: string; control?: Partial<ControlProps> }) {
  const p = useParam(k, over);
  return <SliderControl x={x} y={y} w={w} h={h} control={p.control} capColor={capColor} />;
});

export function SliderControl({ x, y, w, h, control, capColor }: Box & { control: ControlProps; capColor?: string }) {
  const vertical = h >= w;
  const len = vertical ? h : w;
  const cap = vertical ? Math.max(10, Math.round(w * 0.55)) : Math.max(8, Math.round(h * 0.6));
  const hnd = useControl({ travel: len - cap, ...control }, vertical ? 'vertical' : 'horizontal');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const pos = vertical ? (1 - t) * (len - cap) : t * (len - cap);
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={wheelRef} className={'fxk-abs fxk-slider ' + (vertical ? 'v' : 'h')} style={abs({ x, y, w, h })} {...hnd}>
      <div className="fxk-slider-groove" />
      <div className="fxk-slider-cap" style={vertical ? { top: pos, height: cap, background: capColor } : { left: pos, width: cap, background: capColor }} />
    </div>
  );
}

/** Tab selector (TQuickTabSelector): one segment per option. */
export function TabSelector({ x, y, w, h, options, value, onChange, hint, vertical }: Box & { options: string[]; value: number; onChange: (i: number) => void; hint?: string; vertical?: boolean }) {
  return (
    <div className={'fxk-abs fxk-tabs' + (vertical ? ' vertical' : '')} style={abs({ x, y, w, h })}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {options.map((o, i) => (
        <div key={i} className={'fxk-tab' + (i === value ? ' on' : '')}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(i); } }}>{o}</div>
      ))}
    </div>
  );
}

/** Tab selector bound to an option parameter. */
export function ParamTabs({ k, x, y, w, h, options, vertical }: Box & { k: string; options?: string[]; vertical?: boolean }) {
  const p = useParam(k);
  const opts = options ?? p.def.options ?? [];
  return (
    <TabSelector x={x} y={y} w={w} h={h} options={opts} vertical={vertical} value={Math.round(p.value - p.def.min)} hint={p.def.name}
      onChange={(i) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); }} />
  );
}

/**
 * FL's pill switch: a rounded track with a light thumb at the selected
 * option and the option captions beside it (Delay 3's delay model, filter type).
 */
export function PillSwitch({ k, x, y, w, h, options, labelW = 70, horizontal }: Box & { k: string; options?: string[]; labelW?: number; horizontal?: boolean }) {
  const p = useParam(k);
  const opts = options ?? p.def.options ?? [];
  const n = Math.max(1, opts.length);
  const idx = Math.round(p.value - p.def.min);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  const trackW = horizontal ? w : Math.min(w, 16);
  const cell = horizontal ? w / n : h / n;
  return (
    <div className="fxk-abs" style={abs({ x, y, w: horizontal ? w : w + labelW, h: horizontal ? h + 16 : h })}
      onPointerEnter={() => setHint(`${p.def.name}: ${opts[idx] ?? ''}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, opts.map((o, i) => ({ label: o, checked: i === idx, radio: true, onClick: () => pick(i) } as MenuItem))); }}>
      <div className={'fxk-pill' + (horizontal ? ' h' : '')} style={horizontal ? { left: 0, top: 0, width: w, height: h } : { left: 0, top: 0, width: trackW, height: h }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const f = horizontal ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
          pick(Math.min(n - 1, Math.max(0, Math.floor(f * n))));
        }}>
        <div className="fxk-pill-thumb" style={horizontal
          ? { left: idx * cell + (cell - (h - 4)) / 2, top: 2, width: h - 4, height: h - 4 }
          : { top: idx * cell + (cell - (trackW - 4)) / 2, left: 2, width: trackW - 4, height: trackW - 4 }} />
      </div>
      {opts.map((o, i) => (
        <div key={i} className={'fxk-pill-label' + (i === idx ? ' on' : '')}
          style={horizontal
            ? { left: i * cell, top: h + 1, width: cell, textAlign: 'center' }
            : { left: trackW + 6, top: i * cell, height: cell, lineHeight: `${cell}px`, width: labelW }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}>{o}</div>
      ))}
    </div>
  );
}

/** LED check box with caption (FL's TVectorCheckBox), bound to a 0/1 parameter. */
export function Check({ k, x, y, w = 90, h = 16, caption, color = '#b9f35a' }: Omit<Box, 'w' | 'h'> & { k: string; w?: number; h?: number; caption?: string; color?: string }) {
  const p = useParam(k);
  const on = p.value > p.def.min;
  return (
    <CheckView x={x} y={y} w={w} h={h} caption={caption ?? p.def.name.toUpperCase()} on={on} color={color} hint={`${p.def.name}: ${on ? 'on' : 'off'}`}
      onToggle={() => { p.control.onBegin?.(); p.set(on ? p.def.min : p.def.max); p.control.onEnd?.(); }} />
  );
}

export function CheckView({ x, y, w, h, caption, on, onToggle, color = '#b9f35a', hint }: Box & { caption?: string; on: boolean; onToggle: () => void; color?: string; hint?: string }) {
  return (
    <div className="fxk-abs fxk-check" style={abs({ x, y, w, h })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      <span className={'fxk-led' + (on ? ' on' : '')} style={on ? { background: color, boxShadow: `0 0 4px ${color}` } : undefined} />
      {caption && <span className="fxk-check-cap">{caption}</span>}
    </div>
  );
}

export type IconName = 'menu' | 'store' | 'flip' | 'reset' | 'prev' | 'next' | 'plus' | 'minus' | 'random' | 'link' | 'up' | 'down' | 'play' | 'stop' | 'folder' | 'save' | 'undo' | 'redo';

function iconPath(name: IconName): ReactNode {
  switch (name) {
    case 'menu': return <path d="M3 5 L13 5 L8 11 Z" fill="currentColor" />;
    case 'store': return <path d="M4 6 L12 6 L8 11 Z M3 3 L13 3 L13 4.4 L3 4.4 Z" fill="currentColor" />;
    case 'flip': return <path d="M8 2 L12 6 L4 6 Z M8 14 L4 10 L12 10 Z" fill="currentColor" />;
    case 'reset': return <path d="M8 3 A5 5 0 1 1 3.4 6 L5 6.6 A3.4 3.4 0 1 0 8 4.6 L8 6.4 L4.6 4 L8 1.6 Z" fill="currentColor" />;
    case 'prev': return <path d="M10.5 3 L5 8 L10.5 13 Z" fill="currentColor" />;
    case 'next': return <path d="M5.5 3 L11 8 L5.5 13 Z" fill="currentColor" />;
    case 'plus': return <path d="M7 3 H9 V7 H13 V9 H9 V13 H7 V9 H3 V7 H7 Z" fill="currentColor" />;
    case 'minus': return <path d="M3 7 H13 V9 H3 Z" fill="currentColor" />;
    case 'random': return <path d="M3 4 H6 L10 12 H13 M3 12 H6 L7.4 9.2 M10 4 H13 M8.6 6.8 L10 4" stroke="currentColor" strokeWidth="1.4" fill="none" />;
    case 'link': return <path d="M6.5 9.5 L9.5 6.5 M5 8 L3.5 9.5 A2 2 0 0 0 6.5 12.5 L8 11 M8 5 L9.5 3.5 A2 2 0 0 1 12.5 6.5 L11 8" stroke="currentColor" strokeWidth="1.4" fill="none" />;
    case 'up': return <path d="M8 4 L13 11 L3 11 Z" fill="currentColor" />;
    case 'down': return <path d="M8 12 L3 5 L13 5 Z" fill="currentColor" />;
    case 'play': return <path d="M5 3 L13 8 L5 13 Z" fill="currentColor" />;
    case 'stop': return <path d="M4 4 H12 V12 H4 Z" fill="currentColor" />;
    case 'folder': return <path d="M2 4 H6.5 L8 5.5 H14 V13 H2 Z" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'save': return <path d="M3 3 H11 L13 5 V13 H3 Z M5 3 V6 H10 V3 M5 13 V9 H11 V13" fill="none" stroke="currentColor" strokeWidth="1.2" />;
    case 'undo': return <path d="M6 4 L2.5 7 L6 10 M3 7 H10 A3.5 3.5 0 0 1 10 14 H7" fill="none" stroke="currentColor" strokeWidth="1.4" />;
    case 'redo': return <path d="M10 4 L13.5 7 L10 10 M13 7 H6 A3.5 3.5 0 0 0 6 14 H9" fill="none" stroke="currentColor" strokeWidth="1.4" />;
  }
}

/** Small icon button (TQuickBtn). `round` gives FL's circular A/B compare buttons. */
export function IconButton({ x, y, w, h, icon, hint, onClick, active, round, children }: Box & { icon?: IconName; hint?: string; onClick: (e: React.PointerEvent) => void; active?: boolean; round?: boolean; children?: ReactNode }) {
  return (
    <div className={'fxk-abs fxk-btn' + (active ? ' on' : '') + (round ? ' round' : '')} style={abs({ x, y, w, h })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {icon && <svg width={Math.min(w, h) - 4} height={Math.min(w, h) - 4} viewBox="0 0 16 16">{iconPath(icon)}</svg>}
      {children}
    </div>
  );
}

/** Text button (FL's flat outlined buttons, e.g. Delay 3's CUTOFF switch). */
export function TextButton({ x, y, w, h, children, active, onClick, hint }: Box & { children: ReactNode; active?: boolean; onClick: () => void; hint?: string }) {
  return (
    <div className={'fxk-abs fxk-tbtn' + (active ? ' on' : '')} style={abs({ x, y, w, h })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}

/**
 * Canvas display (TQuickPaintBox). `draw` runs on mount, whenever `deps`
 * change and when `redraw()` from the returned ref is called (animations).
 */
export function Display({ x, y, w, h, draw, deps = [], className, onPointerDown, onPointerMove, onPointerUp, onWheel, onContextMenu, style, children }: Box & {
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void;
  deps?: unknown[];
  className?: string;
  onPointerDown?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onWheel?: (e: React.WheelEvent<HTMLCanvasElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRef.current(g, w, h);
  }, [w, h, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={'fxk-abs fxk-display' + (className ? ' ' + className : '')} style={abs({ x, y, w, h }, style)}>
      <canvas ref={ref} style={{ width: w, height: h, display: 'block' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onWheel={onWheel} onContextMenu={onContextMenu ?? ((e) => e.preventDefault())} />
      {children}
    </div>
  );
}

/** Imperative animated canvas: `frame` is called for every animation frame while mounted. */
export function AnimatedDisplay({ x, y, w, h, frame, className, style, onPointerDown, onPointerMove, onPointerUp, onContextMenu }: Box & {
  frame: (g: CanvasRenderingContext2D, w: number, h: number, t: number) => void;
  className?: string;
  style?: CSSProperties;
  onPointerDown?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const c = ref.current;
      if (!c) return;
      const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      frameRef.current(g, w, h, t);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [w, h]);
  return (
    <div className={'fxk-abs fxk-display' + (className ? ' ' + className : '')} style={abs({ x, y, w, h }, style)}>
      <canvas ref={ref} style={{ width: w, height: h, display: 'block' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu ?? ((e) => e.preventDefault())} />
    </div>
  );
}

/** Horizontal level meter (FL green-yellow-red), value 0..1 linear amplitude. */
export function drawMeter(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, level: number, vertical = true): void {
  const db = level > 1e-6 ? 20 * Math.log10(level) : -120;
  const f = Math.min(1, Math.max(0, (db + 60) / 66)); // -60 .. +6 dB
  g.fillStyle = '#1d2326';
  g.fillRect(x, y, w, h);
  const grad = vertical ? g.createLinearGradient(0, y + h, 0, y) : g.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, '#3fb34f');
  grad.addColorStop(0.82, '#d5d84a');
  grad.addColorStop(0.91, '#e0a23f');
  grad.addColorStop(1, '#e8483c');
  g.fillStyle = grad;
  if (vertical) g.fillRect(x, y + h * (1 - f), w, h * f);
  else g.fillRect(x, y, w * f, h);
}
