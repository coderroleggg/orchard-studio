// Kepler / Kepler Exo controls at FL's form coordinates (the kit's controls have a different look, so these draw the Juno style
// ones): TVectorSlider (groove, scale ticks, flat cap), TVectorWheel, TQuickBtn pads (lit pads), TVectorCheckBox LEDs,
// TSwitchSelector levers, TPaintBoxSelector segments, TQuickCombo boxes, section headers and the small waveform / arrow icons.
// Every control binds a plugin parameter through the kit's useParam (FL's value text in the hint, drag / wheel / Alt-reset,
// right-click menu with Create automation clip / Link to controller).

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { Label, useNoScrollWheel, useParam, type BoundParam } from '../../kit';
import { mix, rgba, shade, useSkin } from './skin';
import './kepler.css';

export type Box = { x: number; y: number; w: number; h: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------ parameter helpers
/** The hint FL shows for a control: "<parameter name>: <value text>". */
export function hintOf(p: BoundParam): string {
  return `${p.def.name}: ${p.control.format ? p.control.format(p.value) : String(p.value)}`;
}

/** Flip a 0 / 1 parameter (one undo step). */
export function toggleParam(p: BoundParam): void {
  const on = p.value > p.def.min;
  p.control.onBegin?.();
  p.set(on ? p.def.min : p.def.max);
  p.control.onEnd?.();
}

/** Set a discrete parameter to its i-th position (one undo step). */
export function pickParam(p: BoundParam, i: number): void {
  p.control.onBegin?.();
  p.set(p.def.min + i);
  p.control.onEnd?.();
}

function hoverHint(text: () => string): { onPointerEnter: () => void; onPointerLeave: () => void } {
  return { onPointerEnter: () => setHint(text()), onPointerLeave: clearHint };
}

// ------------------------------------------------------------------ captions
/** Small caption (TQuickLabel): centred on `cx` (or left / right aligned at x), uppercase. */
export function Cap({ cx, x, y, w = 48, h = 9, size = 7.5, children, dim, color, align = 'center', bold = true }: {
  cx?: number; x?: number; y: number; w?: number; h?: number; size?: number; children: ReactNode; dim?: boolean; color?: string;
  align?: 'left' | 'center' | 'right'; bold?: boolean;
}) {
  const skin = useSkin();
  const left = cx !== undefined ? cx - w / 2 : x ?? 0;
  return <Label x={left} y={y} w={w} h={h} size={size} bold={bold} align={align} color={color ?? (dim ? skin.textDim : skin.text)}>{children}</Label>;
}

/** Two-line caption (e.g. DELAY / TIME) whose last line ends at y + 2 * lh. */
export function Cap2({ cx, y, lines, w = 48, lh = 7, size = 7 }: { cx: number; y: number; lines: [string, string]; w?: number; lh?: number; size?: number }) {
  return (
    <>
      <Cap cx={cx} y={y} w={w} h={lh} size={size}>{lines[0]}</Cap>
      <Cap cx={cx} y={y + lh} w={w} h={lh} size={size}>{lines[1]}</Cap>
    </>
  );
}

// ------------------------------------------------------------------ section header
export function Header({ x, y, w, h = 19, title, bg, fg, size = 9, tracking = 1.4, radius = 2, children }: Box & {
  title?: string; bg: string; fg: string; size?: number; tracking?: number; radius?: number; children?: ReactNode;
}) {
  return (
    <div className="kp-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: radius, color: fg, textAlign: 'center', fontSize: size, fontWeight: 700,
      lineHeight: `${h}px`, letterSpacing: tracking, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden',
      background: `linear-gradient(180deg, ${shade(bg, 0.14)} 0%, ${bg} 38%, ${shade(bg, -0.16)} 100%)`,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), 0 1px 0 rgba(0,0,0,0.25)', pointerEvents: children ? undefined : 'none',
    }}>
      {title}
      {children}
    </div>
  );
}

/**
 * The control props of a slider / wheel: FL's wide ranges (0..6000, 0..65536, 0..245760) are not quantised in the control, so the mouse wheel
 * moves a fraction of the range (the parameter itself rounds to FL's integer control positions); narrow ranges (semitones, switches) keep their steps.
 */
function continuous(p: BoundParam): ControlProps {
  return p.def.max - p.def.min > 100 ? { ...p.control, step: 0 } : p.control;
}

/** Double-click puts a control back at its default (FL: the parameter's default value, as Alt-click and the Reset menu item do). */
function resetOnDoubleClick(control: ControlProps): (e: React.MouseEvent) => void {
  return (e) => {
    e.stopPropagation();
    if (control.disabled) return;
    control.onBegin?.();
    control.onChange(control.defaultValue);
    control.onEnd?.();
  };
}

// ------------------------------------------------------------------ slider (TVectorSlider)
export function SliderView({ x, y, w, h, control, cap = 11 }: Box & { control: ControlProps; cap?: number }) {
  const skin = useSkin();
  const hnd = useControl({ travel: h - cap, ...control }, 'vertical');
  const min = control.min ?? 0;
  const max = control.max ?? 1;
  const t = clamp((control.value - min) / (max - min || 1), 0, 1);
  const span = h - cap;
  const top = (1 - t) * span;
  const ref = useNoScrollWheel<HTMLDivElement>();
  const ticks: ReactNode[] = [];
  for (let i = 0; i <= 10; i++) {
    const yy = Math.round(cap / 2 + (span * i) / 10) + 0.5;
    ticks.push(<line key={i} x1={0} x2={w} y1={yy} y2={yy} stroke={i % 5 === 0 ? skin.tickStrong : skin.tick} strokeWidth={1} />);
  }
  return (
    <div ref={ref} className="kp-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }} {...hnd} onDoubleClick={resetOnDoubleClick(control)}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
        {ticks}
        <rect x={w / 2 - 1.5} y={cap / 2} width={3} height={span} rx={1.5} fill="rgba(0,0,0,0.35)" />
        <rect x={w / 2 - 0.75} y={cap / 2} width={1.5} height={span} fill={skin.groove} />
      </svg>
      <div style={{
        position: 'absolute', left: 1, top, width: w - 2, height: cap, borderRadius: 2, boxSizing: 'border-box',
        border: `1px solid ${skin.capEdge}`, background: `linear-gradient(180deg, ${skin.capHi}, ${skin.capLo})`,
        boxShadow: '0 1px 2px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.18)', pointerEvents: 'none',
      }}>
        <div style={{ position: 'absolute', left: 2, right: 2, top: Math.floor(cap / 2) - 1, height: 1, background: skin.capMark }} />
      </div>
    </div>
  );
}

/** A slider bound to parameter `k`; `extraMenu` adds items to its right-click menu (FL's wheel menu "Set"). */
export function KSlider({ k, x, y, w, h, extraMenu, cap }: { k: string; x: number; y: number; w: number; h: number; extraMenu?: MenuItem[]; cap?: number }) {
  const p = useParam(k, extraMenu && extraMenu.length ? { extraMenu } : undefined);
  return <SliderView x={x} y={y} w={w} h={h} control={continuous(p)} cap={cap} />;
}

// ------------------------------------------------------------------ wheel (TVectorWheel)
let knobId = 0;

export function KnobView({ x, y, w, h, control, travel = 200 }: Box & { control: ControlProps; travel?: number }) {
  const skin = useSkin();
  const hnd = useControl({ travel, ...control }, 'vertical');
  const min = control.min ?? 0;
  const max = control.max ?? 1;
  const t = clamp((control.value - min) / (max - min || 1), 0, 1);
  const size = Math.min(w, h);
  const c = size / 2;
  const ang = ((-135 + 270 * t) * Math.PI) / 180;
  const r = c - 1;
  const px = (rr: number) => c + Math.sin(ang) * rr;
  const py = (rr: number) => c - Math.cos(ang) * rr;
  const id = `kpk${(knobId = (knobId + 1) % 1e6)}`;
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="kp-abs" style={{ left: x + (w - size) / 2, top: y + (h - size) / 2, width: size, height: size, touchAction: 'none' }} {...hnd} onDoubleClick={resetOnDoubleClick(control)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible', pointerEvents: 'none' }}>
        <defs>
          <radialGradient id={id} cx="50%" cy="34%" r="75%">
            <stop offset="0" stopColor={skin.knobHi} />
            <stop offset="1" stopColor={skin.knobLo} />
          </radialGradient>
        </defs>
        <circle cx={c} cy={c + 0.8} r={r} fill="rgba(0,0,0,0.35)" />
        <circle cx={c} cy={c} r={r} fill={`url(#${id})`} stroke={skin.knobRim} strokeWidth={1} />
        <line x1={px(r * 0.18)} y1={py(r * 0.18)} x2={px(r * 0.9)} y2={py(r * 0.9)} stroke={skin.knobMark} strokeWidth={Math.max(1.6, size * 0.08)} strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function KKnob({ k, x, y, w, h, travel, extraMenu }: { k: string; x: number; y: number; w: number; h: number; travel?: number; extraMenu?: MenuItem[] }) {
  const p = useParam(k, extraMenu && extraMenu.length ? { extraMenu } : undefined);
  return <KnobView x={x} y={y} w={w} h={h} control={continuous(p)} travel={travel} />;
}

// ------------------------------------------------------------------ pad (TQuickBtn, FS_Pad)
/** The caption / icon colour of a pad in its state. */
export function padFg(color: string, on: boolean, textColor?: string): string {
  return textColor ?? (on ? mix(color, '#000000', 0.7) : rgba('#ffffff', 0.62));
}

export function PadView({ x, y, w, h, color, on, children, hint, handlers, radius = 4, textColor }: Box & {
  color: string; on: boolean; children?: ReactNode; hint?: () => string; handlers?: Record<string, unknown>; radius?: number; textColor?: string;
}) {
  const style: CSSProperties = on
    ? {
      background: `radial-gradient(ellipse at 50% 38%, ${shade(color, 0.7)} 0%, ${shade(color, 0.28)} 52%, ${color} 100%)`,
      boxShadow: `0 0 10px ${rgba(color, 0.55)}, inset 0 0 0 1px ${rgba('#ffffff', 0.28)}`,
    }
    : {
      background: `linear-gradient(180deg, ${mix(color, '#000000', 0.34)} 0%, ${mix(color, '#000000', 0.5)} 100%)`,
      boxShadow: `inset 0 0 0 1px ${rgba('#000000', 0.5)}, inset 0 1px 0 ${rgba('#ffffff', 0.12)}`,
    };
  return (
    <div className="kp-pad" style={{ left: x, top: y, width: w, height: h, borderRadius: radius, color: padFg(color, on, textColor), ...style }}
      {...(hint ? hoverHint(hint) : {})} {...(handlers as object)}>
      {children}
    </div>
  );
}

/**
 * A toggle pad bound to a 0 / 1 parameter; `momentary` pads are on only while the button is held (manual LFO trigger).
 * The content is a caption or an icon that inherits the pad's text colour (currentColor).
 */
export function KPad({ k, x, y, w, h, color, children, momentary, radius, textColor }: {
  k: string; x: number; y: number; w: number; h: number; color: string; children?: ReactNode; momentary?: boolean; radius?: number; textColor?: string;
}) {
  const p = useParam(k);
  const { onContextMenu } = useControl(p.control, 'vertical');
  const held = useRef(false);
  const on = p.value > p.def.min;
  const handlers: Record<string, unknown> = { onContextMenu };
  if (momentary) {
    handlers.onPointerDown = (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer that is not active (synthetic events) */ }
      held.current = true;
      p.control.onBegin?.();
      p.set(p.def.max);
    };
    const release = () => { if (held.current) { held.current = false; p.set(p.def.min); p.control.onEnd?.(); } };
    handlers.onPointerUp = release;
    handlers.onPointerCancel = release;
  } else {
    handlers.onPointerDown = (e: React.PointerEvent) => { if (e.button === 0) { e.stopPropagation(); toggleParam(p); } };
  }
  return <PadView x={x} y={y} w={w} h={h} color={color} on={on} hint={() => hintOf(p)} handlers={handlers} radius={radius} textColor={textColor}>{children}</PadView>;
}

// ------------------------------------------------------------------ LED check box (TVectorCheckBox)
export function LedView({ x, y, w, h, on, caption, captionSide = 'right', ledW = 10, ledH = 6, hint, handlers, size = 7.5 }: Box & {
  on: boolean; caption?: string; captionSide?: 'right' | 'left'; ledW?: number; ledH?: number; hint?: () => string; handlers?: Record<string, unknown>; size?: number;
}) {
  const skin = useSkin();
  const led: CSSProperties = {
    position: 'absolute', width: ledW, height: ledH, borderRadius: 2, boxSizing: 'border-box',
    top: Math.round((h - ledH) / 2), left: caption ? (captionSide === 'right' ? 1 : w - ledW - 1) : Math.round((w - ledW) / 2),
    background: on ? skin.ledOn : skin.ledOff,
    border: `1px solid ${skin.ledRim}`,
    boxShadow: on ? `0 0 6px ${rgba(skin.ledOn, 0.85)}, inset 0 0 2px ${rgba('#ffffff', 0.5)}` : 'inset 0 1px 1px rgba(0,0,0,0.5)',
  };
  return (
    <div className="kp-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default' }} {...(hint ? hoverHint(hint) : {})} {...(handlers as object)}>
      <div style={led} />
      {caption && (
        <div style={{
          position: 'absolute', top: 0, height: h, lineHeight: `${h}px`, fontSize: size, fontWeight: 700, letterSpacing: '0.03em', whiteSpace: 'nowrap',
          textTransform: 'uppercase', color: on ? skin.textHi : skin.text,
          ...(captionSide === 'right' ? { left: ledW + 5 } : { right: ledW + 5 }),
        }}>{caption}</div>
      )}
    </div>
  );
}

export function KLed({ k, x, y, w, h, caption, captionSide, size }: { k: string; x: number; y: number; w: number; h: number; caption?: string; captionSide?: 'right' | 'left'; size?: number }) {
  const p = useParam(k);
  const { onContextMenu } = useControl(p.control, 'vertical');
  const on = p.value > p.def.min;
  return (
    <LedView x={x} y={y} w={w} h={h} on={on} caption={caption} captionSide={captionSide} size={size} hint={() => hintOf(p)}
      handlers={{ onPointerDown: (e: React.PointerEvent) => { if (e.button === 0) { e.stopPropagation(); toggleParam(p); } }, onContextMenu }} />
  );
}

// ------------------------------------------------------------------ lever (TSwitchSelector)
/**
 * A vertical selector: a dark slot with a light handle at the selected position and the captions beside it (position 0 on top).
 * The box is FL's; captions may extend to its right.
 */
export function KLever({ k, x, y, w, h, labels, barW = 12, gap = 4, capSize = 8 }: {
  k: string; x: number; y: number; w: number; h: number; labels: ReactNode[]; barW?: number; gap?: number; capSize?: number;
}) {
  const skin = useSkin();
  const p = useParam(k);
  const { onContextMenu, onWheel } = useControl(p.control, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const n = Math.max(1, Math.round(p.def.max - p.def.min) + 1);
  const idx = clamp(Math.round(p.value - p.def.min), 0, n - 1);
  const cell = h / n;
  return (
    <div ref={ref} className="kp-lever" style={{ left: x, top: y, width: w, height: h }}
      onContextMenu={onContextMenu} onWheel={onWheel} {...hoverHint(() => hintOf(p))}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        pickParam(p, clamp(Math.floor(((e.clientY - r.top) / (r.height || 1)) * n), 0, n - 1));
      }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: barW, height: h, borderRadius: barW / 2, background: skin.bar, border: `1px solid ${skin.barEdge}`, boxSizing: 'border-box', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.6)' }} />
      <div style={{
        position: 'absolute', left: 1, top: idx * cell + 1, width: barW - 2, height: Math.max(6, cell - 2), borderRadius: (barW - 2) / 2 - 0.5,
        background: `linear-gradient(180deg, ${shade(skin.handle, 0.25)}, ${skin.handle} 50%, ${shade(skin.handle, -0.18)})`,
        border: `1px solid ${skin.handleEdge}`, boxSizing: 'border-box', boxShadow: '0 1px 2px rgba(0,0,0,0.5)',
      }} />
      {labels.map((l, i) => (
        <div key={i} className="kp-lever-label" style={{ left: barW + gap, top: i * cell, height: cell, fontSize: capSize, color: i === idx ? skin.textHi : skin.textDim }}>{l}</div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ segmented selector (TPaintBoxSelector)
export function SegView({ x, y, w, h, labels, value, onPick, hint, handlers }: Box & {
  labels: ReactNode[]; value: number; onPick: (i: number) => void; hint?: () => string; handlers?: Record<string, unknown>;
}) {
  const skin = useSkin();
  return (
    <div className="kp-seg" style={{ left: x, top: y, width: w, height: h, background: skin.box, border: `1px solid ${skin.boxEdge}` }}
      {...(hint ? hoverHint(hint) : {})} {...(handlers as object)}>
      {labels.map((l, i) => (
        <div key={i} className="kp-seg-cell" style={{ background: i === value ? skin.boxOn : 'transparent', color: i === value ? skin.boxOnText : skin.boxText }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onPick(i); } }}>{l}</div>
      ))}
    </div>
  );
}

/** A discrete parameter as segments (FL's octave selector). */
export function KSeg({ k, x, y, w, h, labels }: { k: string; x: number; y: number; w: number; h: number; labels: ReactNode[] }) {
  const p = useParam(k);
  const { onContextMenu, onWheel } = useControl(p.control, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} style={{ display: 'contents' }}>
      <SegView x={x} y={y} w={w} h={h} labels={labels} value={clamp(Math.round(p.value - p.def.min), 0, labels.length - 1)} onPick={(i) => pickParam(p, i)}
        hint={() => hintOf(p)} handlers={{ onContextMenu, onWheel }} />
    </div>
  );
}

// ------------------------------------------------------------------ combo (TQuickCombo)
export function ComboView({ x, y, w, h, text, title, onOpen, onStep, hint }: Box & {
  text: string; title?: string; onOpen: (r: DOMRect) => void; onStep?: (dir: number) => void; hint?: string;
}) {
  const skin = useSkin();
  return (
    <div className="kp-combo" title={title ?? text} style={{ left: x, top: y, width: w, height: h, background: skin.box, color: skin.boxText, border: `1px solid ${skin.boxEdge}`, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.35)' }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onOpen(e.currentTarget.getBoundingClientRect()); } }}
      onWheel={(e) => { if (onStep) { e.stopPropagation(); onStep(e.deltaY < 0 ? -1 : 1); } }}>
      <span className="kp-combo-text">{text}</span>
    </div>
  );
}

/** Open a combo's list under its box. */
export function openCombo(r: DOMRect, items: MenuItem[]): void {
  openMenu(r.left, r.bottom, items, { minWidth: r.width });
}

// ------------------------------------------------------------------ small button (the Options button)
export function MenuButton({ x, y, w, h, onOpen, hint = 'Options' }: Box & { onOpen: (r: DOMRect) => void; hint?: string }) {
  const skin = useSkin();
  return (
    <div className="kp-btn" style={{ left: x, top: y, width: w, height: h, borderRadius: 4, background: `linear-gradient(180deg, ${shade(skin.box, 0.12)}, ${skin.box})`, border: `1px solid ${skin.boxEdge}`, boxShadow: '0 1px 2px rgba(0,0,0,0.4)' }}
      {...hoverHint(() => hint)}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onOpen(e.currentTarget.getBoundingClientRect()); } }}>
      <svg width={11} height={9} viewBox="0 0 11 9"><path d="M0.5 1.5 H10.5 M0.5 4.5 H10.5 M0.5 7.5 H10.5" stroke={skin.boxText} strokeWidth={1.4} fill="none" /></svg>
    </div>
  );
}

// ------------------------------------------------------------------ icons
export type WaveKind = 'pulse' | 'saw' | 'sub' | 'sine' | 'tri' | 'noise' | 'ramp' | 'rampDown' | 'random' | 'glide';

const WAVE_PATH: Record<WaveKind, string> = {
  pulse: 'M1 7 H3 V1 H8 V7 H11',
  sub: 'M1 1 H4 V7 H9 V1 H11',
  saw: 'M1 7 L6 1 V7 L11 1 V7',
  ramp: 'M1 7 L8 1 V7 H11',
  rampDown: 'M1 1 L8 7 V1 H11',
  sine: 'M0.5 4 C2 -1 4 -1 6 4 S10 9 11.5 4',
  tri: 'M0.5 4 L3 1 L6 7 L9 1 L11.5 4',
  noise: 'M1 4 L2 2 L3 6 L4 3 L5 7 L6 1 L7 5 L8 2 L9 6 L10 3 L11 5',
  random: 'M1 5 H3 V2 H5 V6 H7 V3 H9 V7 H11',
  glide: 'M1 5 L3 2 L5 6 L7 3 L9 7 L11 4',
};

export function Wave({ kind, color, w = 12, h = 8, stroke = 1.2 }: { kind: WaveKind; color: string; w?: number; h?: number; stroke?: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 12 8" style={{ display: 'block', overflow: 'visible' }}>
      <path d={WAVE_PATH[kind]} fill="none" stroke={color} strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Arrow({ dir, color, size = 7 }: { dir: 'up' | 'down' | 'updown'; color: string; size?: number }) {
  return (
    <svg width={size} height={size + (dir === 'updown' ? 3 : 0)} viewBox="0 0 8 11" style={{ display: 'block', overflow: 'visible' }}>
      {dir !== 'down' && <path d="M4 0.5 L7.5 4.5 H0.5 Z" fill={color} />}
      {dir !== 'up' && <path d={dir === 'down' ? 'M4 7.5 L0.5 3.5 H7.5 Z' : 'M4 10.5 L0.5 6.5 H7.5 Z'} fill={color} />}
    </svg>
  );
}
