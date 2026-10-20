// Sakura's controls: FL's TVectorWheel / TVectorSlider / TVectorCheckBox / TSwitchSelector /
// TVectorDigiWheel / TQuickCombo in the plugin's crimson and silver skin. Mouse behaviour is the
// kit's (widgets/control useControl: drag, Ctrl = fine, Alt or middle click = reset, wheel, right
// click menu with the automation items); only the drawing is Sakura's own (original art, drawn by
// code). Gradients are defined once in the backdrop's <defs> (art.tsx) and referenced here by id.

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { autoTargetOf, automationMenuItems, useControl, type ControlProps } from '../../../widgets/control';
import { openMenu } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { useNoScrollWheel, useParam } from '../../kit';
import type { KnobSkin, SliderKind } from './layout';
import { dropHint, showHint } from './hint';

// ------------------------------------------------------------------ hints (the editor's HintLabel and the hint bar)
let nextOwner = 1;

/**
 * Hover / drag hint of a control: the HintLabel shows `name` and `text` while the mouse is over the control or
 * drags it, and follows the value. `bar` also drives the app's hint bar (controls that do not use useControl,
 * which sets the bar itself).
 */
export function useHintFx(name: string, text: string, bar = false) {
  const st = useRef({ id: 0, over: false, drag: false, name, text, bar });
  const s = st.current;
  if (!s.id) s.id = nextOwner++;
  s.name = name;
  s.text = text;
  s.bar = bar;
  const api = useMemo(() => {
    const show = (): void => { showHint(s.id, s.name, s.text); if (s.bar) setHint(s.text ? `${s.name}: ${s.text}` : s.name); };
    const hide = (): void => { dropHint(s.id); if (s.bar) clearHint(); };
    return {
      show,
      enter: () => { s.over = true; show(); },
      leave: () => { s.over = false; if (!s.drag) hide(); },
      down: () => { s.drag = true; show(); },
      up: () => { s.drag = false; if (!s.over) hide(); },
    };
  }, [s]);
  useEffect(() => { if (s.over || s.drag) api.show(); }, [name, text, api, s]);
  useEffect(() => () => dropHint(s.id), [s]);
  return api;
}

/** useControl's handlers plus the HintLabel hooks, for a vertical or horizontal drag control. */
function useCtl(control: ControlProps, orientation: 'vertical' | 'horizontal', travel: number) {
  const base = useControl({ travel, ...control }, orientation);
  const text = control.format ? control.format(control.value) : String(Math.round(control.value));
  const hint = useHintFx(control.label, text);
  const ref = useNoScrollWheel<HTMLDivElement>();
  const props = {
    onPointerDown: (e: React.PointerEvent) => { hint.down(); base.onPointerDown(e); },
    onPointerMove: base.onPointerMove,
    onPointerUp: () => { base.onPointerUp(); hint.up(); },
    onPointerCancel: () => { base.onPointerCancel(); hint.up(); },
    onLostPointerCapture: () => { base.onLostPointerCapture(); hint.up(); },
    onWheel: base.onWheel,
    onContextMenu: base.onContextMenu,
    onPointerEnter: hint.enter,
    onPointerLeave: () => { base.onPointerLeave(); hint.leave(); },
    onDoubleClick: base.onDoubleClick,
  };
  return { ref, props, hint };
}

const norm = (c: ControlProps): number => {
  const min = c.min ?? 0, max = c.max ?? 1;
  const t = (c.value - min) / (max - min || 1);
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
};

// ------------------------------------------------------------------ knobs
const START = -135;
const SWEEP = 270;

/** Point at angle `deg` (0 = up, clockwise) and radius `r` around (c, c). */
export function pol(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

export function arc(c: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const [x0, y0] = pol(c, r, a0);
  const [x1, y1] = pol(c, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r.toFixed(2)} ${r.toFixed(2)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** A knob's drawing at normalised position `t` (0..1) in a square of `size` px. */
export function KnobFace({ size: S, t, skin, ticks }: { size: number; t: number; skin: KnobSkin; ticks?: number }) {
  const c = S / 2;
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const svg = (children: ReactNode) => (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>{children}</svg>
  );
  if (skin === 'chrome') {
    const r = S * 0.46;
    const [x0, y0] = pol(c, S * 0.05, ang);
    const [x1, y1] = pol(c, S * 0.38, ang);
    return svg(
      <>
        {ticks ? Array.from({ length: ticks }, (_, k) => {
          const a = START + (SWEEP * k) / (ticks - 1);
          const [ax, ay] = pol(c, S * 0.6, a);
          const [bx, by] = pol(c, S * 0.72, a);
          return <line key={k} x1={ax} y1={ay} x2={bx} y2={by} stroke="rgba(255,232,240,0.85)" strokeWidth={0.9} />;
        }) : null}
        <circle cx={c} cy={c + S * 0.035} r={r + S * 0.012} fill="rgba(0,0,0,0.30)" />
        <circle cx={c} cy={c} r={r} fill="url(#skChrome)" stroke="#1b1c21" strokeWidth={Math.max(0.9, S * 0.04)} />
        <circle cx={c} cy={c} r={r * 0.78} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={0.6} />
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#26272d" strokeWidth={Math.max(1.5, S * 0.075)} strokeLinecap="round" />
      </>,
    );
  }
  if (skin === 'dark' || skin === 'darkPink') {
    const pink = skin === 'darkPink';
    const rb = S >= 40 ? 0.33 : 0.4;
    const [lx, ly] = pol(c, S * rb * 0.5, ang);
    const [dx, dy] = pol(c, S * rb * 0.84, ang);
    return svg(
      <>
        <circle cx={c} cy={c} r={S / 2 - 0.6} fill="none" stroke={pink ? 'rgba(255,214,226,0.42)' : 'rgba(25,25,34,0.38)'} strokeWidth={0.9} />
        <circle cx={c} cy={c + S * 0.025} r={S * rb + 1} fill="rgba(0,0,0,0.28)" />
        <circle cx={c} cy={c} r={S * rb} fill="url(#skDark)" stroke="#07070a" strokeWidth={1} />
        <circle cx={c} cy={c} r={S * rb * 0.44} fill="url(#skTan)" stroke="rgba(0,0,0,0.55)" strokeWidth={0.7} />
        <line x1={lx} y1={ly} x2={dx} y2={dy} stroke="#d8c58d" strokeWidth={Math.max(1.2, S * 0.04)} strokeLinecap="round" />
        <circle cx={dx} cy={dy} r={Math.max(1.3, S * 0.035)} fill="#f4e8c5" />
      </>,
    );
  }
  // 'strip': modulation strip knob with a rose value arc
  const rT = S * 0.45;
  const tw = Math.max(1.6, S * 0.085);
  const [q0x, q0y] = pol(c, S * 0.2, ang);
  const [q1x, q1y] = pol(c, S * 0.31, ang);
  return svg(
    <>
      <path d={arc(c, rT, START, START + SWEEP)} stroke="#34363f" strokeWidth={tw} fill="none" strokeLinecap="round" />
      {ang - START > 1 && <path d={arc(c, rT, START, ang)} stroke="#d98d9c" strokeWidth={tw} fill="none" strokeLinecap="round" />}
      <circle cx={c} cy={c} r={S * 0.33} fill="url(#skStripBody)" stroke="#0a0a0d" strokeWidth={1} />
      <circle cx={c} cy={c} r={S * 0.19} fill="url(#skCapSilver)" stroke="rgba(0,0,0,0.6)" strokeWidth={0.7} />
      <line x1={q0x} y1={q0y} x2={q1x} y2={q1y} stroke="#eeeef4" strokeWidth={Math.max(1.3, S * 0.055)} strokeLinecap="round" />
    </>,
  );
}

export interface KnobProps { x: number; y: number; w: number; h?: number; skin: KnobSkin; ticks?: number }

/** A knob driven by explicit ControlProps (the kit's WheelControl in Sakura's skin). */
export function KnobControl({ x, y, w, h = w, skin, ticks, control }: KnobProps & { control: ControlProps }) {
  const { ref, props } = useCtl(control, 'vertical', 200);
  const s = Math.min(w, h);
  return (
    <div ref={ref} className="sk-ctl" style={{ left: x, top: y, width: w, height: h }} {...props}>
      <div style={{ position: 'absolute', left: (w - s) / 2, top: (h - s) / 2 }}>
        <KnobFace size={s} t={norm(control)} skin={skin} ticks={ticks} />
      </div>
    </div>
  );
}

/** A knob bound to FL parameter `k`. */
export function PKnob({ k, ...rest }: KnobProps & { k: string }) {
  const p = useParam(k);
  return <KnobControl {...rest} control={p.control} />;
}

// ------------------------------------------------------------------ sliders
/** A slider's drawing at normalised position `t` (0..1). */
export function SliderFace({ kind, w, h, t }: { kind: SliderKind; w: number; h: number; t: number }) {
  if (kind === 'slot') {
    // vertical slot: silver frame, dark ribbed slot, a black bar cap with a light lip
    const capH = 10, ix = 3, iy = 3, iw = w - 6, ih = h - 6;
    const pos = iy + (1 - t) * (ih - capH);
    const ribs: ReactNode[] = [];
    for (let x = ix + 2; x < ix + iw - 1; x += 3) ribs.push(<line key={x} x1={x} y1={iy} x2={x} y2={iy + ih} stroke="rgba(0,0,0,0.5)" strokeWidth={1} />);
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={4} fill="url(#skFrame)" stroke="#2a2b30" />
        <rect x={ix} y={iy} width={iw} height={ih} rx={2} fill="url(#skSlot)" />
        {ribs}
        <rect x={ix} y={pos} width={iw} height={capH} rx={1.5} fill="#0e0f13" stroke="#000" strokeWidth={0.8} />
        <rect x={ix + 0.5} y={pos + 0.5} width={iw - 1} height={3.4} rx={1.2} fill="url(#skHandle)" />
      </svg>
    );
  }
  if (kind === 'res') {
    // resonator frequency: a silver bar (bright up to the cap, dim beyond it) with a tall dark cap
    const capW = 11, bh = 12, by = (h - bh) / 2;
    const pos = t * (w - capW);
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
        <rect x={0.5} y={by + 0.5} width={w - 1} height={bh - 1} rx={3} fill="url(#skBarDim)" stroke="#3b3c42" />
        <rect x={1} y={by + 1} width={Math.max(0, pos + capW / 2 - 1)} height={bh - 2} rx={2.5} fill="url(#skBar)" />
        <rect x={pos} y={0} width={capW} height={h} rx={2} fill="#1b1c26" stroke="#07070b" strokeWidth={0.8} />
        <rect x={pos + 2.5} y={2.5} width={1.6} height={h - 5} rx={0.7} fill="#6a6b79" />
        <rect x={pos + capW - 4.1} y={2.5} width={1.6} height={h - 5} rx={0.7} fill="#6a6b79" />
        <rect x={pos + 1} y={0.8} width={capW - 2} height={1} fill="rgba(255,255,255,0.2)" />
      </svg>
    );
  }
  // comb ratio: a black comb in a silver frame with a light handle
  const hw = 18;
  const pos = t * (w - hw - 3);
  const teeth: ReactNode[] = [];
  const n = 24;
  for (let k = 0; k < n; k++) {
    const x = 5 + (k * (w - 10)) / (n - 1);
    teeth.push(<line key={k} x1={x} y1={5} x2={x} y2={h - 5} stroke="#c3c4cf" strokeWidth={1} opacity={x < pos ? 0.3 : 0.9} />);
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3} fill="url(#skFrame)" stroke="#2b2c31" />
      <rect x={2} y={2} width={w - 4} height={h - 4} rx={1.5} fill="#07070a" />
      {teeth}
      <rect x={pos + 2} y={2} width={hw} height={h - 4} rx={1.5} fill="url(#skHandle)" stroke="#17181d" strokeWidth={0.8} />
      <path d={`M${pos + 2 + 4} ${h / 2}L${pos + 2 + 8} ${h / 2 - 3}L${pos + 2 + 8} ${h / 2 + 3}Z`} fill="#3d3e46" />
      <path d={`M${pos + 2 + hw - 4} ${h / 2}L${pos + 2 + hw - 8} ${h / 2 - 3}L${pos + 2 + hw - 8} ${h / 2 + 3}Z`} fill="#3d3e46" />
    </svg>
  );
}

export interface SliderProps { x: number; y: number; w: number; h: number; kind: SliderKind }

/** A slider driven by explicit ControlProps (the kit's SliderControl in Sakura's skin). */
export function SliderControl({ x, y, w, h, kind, control }: SliderProps & { control: ControlProps }) {
  const vertical = kind === 'slot';
  const travel = kind === 'slot' ? h - 6 - 10 : kind === 'res' ? w - 11 : w - 21;
  const { ref, props } = useCtl(control, vertical ? 'vertical' : 'horizontal', travel);
  return (
    <div ref={ref} className="sk-ctl" style={{ left: x, top: y, width: w, height: h }} {...props}>
      <SliderFace kind={kind} w={w} h={h} t={norm(control)} />
    </div>
  );
}

export function PSlider({ k, ...rest }: SliderProps & { k: string }) {
  const p = useParam(k);
  return <SliderControl {...rest} control={p.control} />;
}

// ------------------------------------------------------------------ switches, LEDs and power buttons
/** Right click on a two-state control: its automation menu (the kit's check boxes have none). */
function toggleMenu(control: ControlProps | undefined) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (control?.auto) openMenu(e.clientX, e.clientY, automationMenuItems(autoTargetOf(control), e.clientX, e.clientY));
  };
}

/** TVectorCheckBox in Sakura's skin: a round red lamp (resonator on) or a cream power dot (effect on). */
export function LedFace({ s, on, kind }: { s: number; on: boolean; kind: 'led' | 'power' }) {
  const c = s / 2;
  if (kind === 'led') {
    return (
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ display: 'block', overflow: 'visible' }}>
        {on && <circle cx={c} cy={c} r={c + 1.5} fill="rgba(235,70,105,0.28)" />}
        <circle cx={c} cy={c} r={c - 0.5} fill="#15161a" stroke="#050507" />
        <circle cx={c} cy={c} r={c - 3} fill={on ? 'url(#skLedOn)' : 'url(#skLedOff)'} stroke="rgba(0,0,0,0.55)" strokeWidth={0.8} />
        {on && <path d={`M${c - 1.6} ${c - 2.6}L${c + 2.8} ${c}L${c - 1.6} ${c + 2.6}Z`} fill="#ffe4ea" />}
      </svg>
    );
  }
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ display: 'block', overflow: 'visible' }}>
      {on && <circle cx={c} cy={c} r={c} fill="rgba(255,236,226,0.28)" />}
      <circle cx={c} cy={c} r={c - 4.2} fill="#0c0c0f" stroke={on ? 'rgba(255,240,232,0.55)' : 'rgba(255,208,222,0.35)'} strokeWidth={0.9} />
      <circle cx={c} cy={c} r={c - 6.4} fill={on ? '#fbf0e6' : '#2a2a30'} />
    </svg>
  );
}

export function LedControl({ x, y, s = 18, kind, on, name, text, onToggle, control }: {
  x: number; y: number; s?: number; kind: 'led' | 'power'; on: boolean; name: string; text: string; onToggle: () => void; control?: ControlProps;
}) {
  const hint = useHintFx(name, text, true);
  return (
    <div className="sk-ctl" style={{ left: x, top: y, width: s, height: s }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={hint.enter} onPointerLeave={hint.leave} onContextMenu={toggleMenu(control)}>
      <LedFace s={s} on={on} kind={kind} />
    </div>
  );
}

/** TSwitchSelector: a dark pill with a light thumb at the "+" (left) or "-" (right) end. */
export function LeverFace({ w, h, on }: { w: number; h: number; on: boolean }) {
  const r = (h - 2) / 2;
  return (
    <svg width={w} height={h + 9} viewBox={`0 0 ${w} ${h + 9}`} style={{ display: 'block', overflow: 'visible' }}>
      <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={h / 2} fill="#101116" stroke="#3b3c45" />
      <circle cx={on ? w - h / 2 : h / 2} cy={h / 2} r={r - 1} fill="url(#skCapSilver)" stroke="#000" strokeWidth={0.6} />
      <text x={h / 2} y={h + 7.5} textAnchor="middle" className="sk-lv" fill={on ? '#62646f' : '#c9cad4'}>+</text>
      <text x={w - h / 2} y={h + 7.5} textAnchor="middle" className="sk-lv" fill={on ? '#c9cad4' : '#62646f'}>&#8722;</text>
    </svg>
  );
}

export function LeverControl({ x, y, w, h, on, name, text, onToggle, control }: {
  x: number; y: number; w: number; h: number; on: boolean; name: string; text: string; onToggle: () => void; control?: ControlProps;
}) {
  const hint = useHintFx(name, text, true);
  return (
    <div className="sk-ctl" style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={hint.enter} onPointerLeave={hint.leave} onContextMenu={toggleMenu(control)}>
      <LeverFace w={w} h={h} on={on} />
    </div>
  );
}

/** A two-state FL parameter (0 = off, 256 = on) as a LED, power dot or +/- lever. */
export function PToggle({ k, x, y, w, h, kind }: { k: string; x: number; y: number; w: number; h: number; kind: 'led' | 'power' | 'lever' }) {
  const p = useParam(k);
  const on = p.value !== 0;
  const text = p.control.format?.(p.value) ?? (on ? 'On' : 'Off');
  const toggle = () => { p.control.onBegin?.(); p.set(on ? 0 : p.def.max); p.control.onEnd?.(); };
  if (kind === 'lever') return <LeverControl x={x} y={y} w={w} h={h} on={on} name={p.def.name} text={text} onToggle={toggle} control={p.control} />;
  return <LedControl x={x} y={y} s={w} kind={kind} on={on} name={p.def.name} text={text} onToggle={toggle} control={p.control} />;
}

// ------------------------------------------------------------------ digi wheels and combos
/** Where a list menu of a control opens: under the control. */
function openList(el: HTMLElement, items: string[], index: number, pick: (i: number) => void): void {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom, items.map((t, i) => ({ label: t.trim() || '---', radio: true, checked: i === index, onClick: () => pick(i) })), { minWidth: r.width });
}

/**
 * TVectorDigiWheel: a small dark window with the item text. Drag vertically or turn the mouse wheel to step
 * through the items; a click (no drag) shows the list (the manual: "Click on the window to show options").
 */
export function DigiControl({ x, y, w, h, control, items }: { x: number; y: number; w: number; h: number; control: ControlProps; items: string[] }) {
  const { ref, props } = useCtl({ ...control, format: (v) => items[Math.round(v)] ?? '' }, 'vertical', 60);
  const down = useRef<[number, number, boolean] | null>(null);
  const moved = useRef(false);
  const idx = Math.round(control.value);
  const pick = (i: number) => { control.onBegin?.(); control.onChange(i); control.onEnd?.(); };
  return (
    <div ref={ref} className="sk-ctl sk-digi" style={{ left: x, top: y, width: w, height: h }} {...props}
      onPointerDown={(e) => { down.current = [e.clientX, e.clientY, e.button === 0 && !e.altKey]; moved.current = false; props.onPointerDown(e); }}
      onPointerMove={(e) => {
        const d = down.current;
        if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 3) moved.current = true;
        props.onPointerMove(e);
      }}
      onPointerUp={(e) => {
        const click = down.current !== null && down.current[2] && !moved.current && e.button === 0;
        down.current = null;
        props.onPointerUp();
        if (click) openList(e.currentTarget as HTMLElement, items, idx, pick);
      }}>
      {items[idx] ?? ''}
    </div>
  );
}

/** TQuickCombo (FS_SoberPlain): a dark list box; click for the list, wheel to step. */
export function ComboControl({ x, y, w, h, items, index, name, onPick }: {
  x: number; y: number; w: number; h: number; items: string[]; index: number; name: string; onPick: (i: number) => void;
}) {
  const text = items[index] ?? '';
  const hint = useHintFx(name, text, true);
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="sk-ctl sk-combo" style={{ left: x, top: y, width: w, height: h, lineHeight: `${h}px` }}
      onPointerEnter={hint.enter} onPointerLeave={hint.leave}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); e.preventDefault(); openList(e.currentTarget as HTMLElement, items, index, onPick); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onWheel={(e) => { e.stopPropagation(); const n = Math.max(0, Math.min(items.length - 1, index + (e.deltaY < 0 ? 1 : -1))); if (n !== index) onPick(n); }}>
      <span className="sk-combo-t">{text}</span>
      <svg className="sk-combo-a" width={7} height={5} viewBox="0 0 7 5"><path d="M0.5 0.5 L3.5 4.2 L6.5 0.5 Z" fill="#a4a6b3" /></svg>
    </div>
  );
}
