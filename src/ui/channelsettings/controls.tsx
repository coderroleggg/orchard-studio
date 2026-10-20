import type { AutoSpec } from '../widgets/control';
// Building blocks shared by the SMP / INS / MISC tabs: labelled sections, knob
// cells, toggles, switches, drop-down selectors, LCD number boxes, per-window
// view state and devicePixelRatio-aware canvases.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Draft } from 'immer';
import { store, useProject } from '../../store';
import * as A from '../../store/actions';
import type { SamplerSettings } from '../../model/sampler';
import type { TimeBase } from '../../model/timing';
import { Knob } from '../widgets/Knob';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint } from '../hint';

export type SamplerRecipe = (s: Draft<SamplerSettings>) => void;

/** Edit a channel's sampler settings; `label` names the undo step. */
export function editSampler(channelId: string, label: string, recipe: SamplerRecipe): void {
  A.setSampler(channelId, label, recipe);
}

// ------------------------------------------------------------- view state
// Which tab / target / tracker a window shows. This is not project data, so it
// lives outside the store, but it survives closing and reopening the window.
const viewState = new Map<string, unknown>();

export function useViewState<T>(scope: string, key: string, initial: T): [T, (v: T) => void] {
  const k = scope + '|' + key;
  const [v, setV] = useState<T>(() => (viewState.has(k) ? (viewState.get(k) as T) : initial));
  const set = useCallback((nv: T) => {
    viewState.set(k, nv);
    setV(nv);
  }, [k]);
  return [v, set];
}

export function useTimeBase(): TimeBase {
  const ppq = useProject((p) => p.ppq);
  const beatsPerBar = useProject((p) => p.beatsPerBar);
  const stepsPerBeat = useProject((p) => p.stepsPerBeat);
  return useMemo(() => ({ ppq, beatsPerBar, stepsPerBeat }), [ppq, beatsPerBar, stepsPerBeat]);
}

let fontCache = '';
export function uiFont(): string {
  if (!fontCache) fontCache = getComputedStyle(document.body).fontFamily || 'sans-serif';
  return fontCache;
}

// ----------------------------------------------------------------- layout
export function Section({ title, tools, className, style, children }: {
  title: ReactNode;
  tools?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={'cs-sec' + (className ? ' ' + className : '')} style={style}>
      <div className="cs-sec-head">
        <div className="cs-cap">{title}</div>
        {tools && <div className="cs-sec-tools">{tools}</div>}
      </div>
      <div className="cs-sec-body">{children}</div>
    </div>
  );
}

/** A control with a small caption underneath (FL's knob labels). */
export function Cell({ cap, className, capClass, onCapDown, capHint, children }: {
  cap: string;
  className?: string;
  capClass?: string;
  onCapDown?: (e: React.PointerEvent) => void;
  capHint?: string;
  children: ReactNode;
}) {
  return (
    <div className={'cs-k' + (className ? ' ' + className : '')}>
      <div className="cs-k-ctl">{children}</div>
      <span className={'cs-k-cap' + (capClass ? ' ' + capClass : '')}
        onPointerDown={onCapDown}
        onPointerEnter={capHint ? () => setHint(capHint) : undefined}
        onPointerLeave={capHint ? clearHint : undefined}>
        {cap}
      </span>
    </div>
  );
}

export interface KnobCellProps {
  cap: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  def: number;
  format: (v: number) => string;
  set: (v: number) => void;
  /** Undo label (defaults to the hint label). */
  undo?: string;
  bipolar?: boolean;
  size?: number;
  step?: number;
  disabled?: boolean;
  arc?: string;
  menu?: MenuItem[];
  className?: string;
  /** Automation target (makes "Create automation clip" available). */
  auto?: AutoSpec;
}

/** Automation target for a channel / sampler parameter path. */
export function chAuto(id: string, path: string): AutoSpec {
  return { scope: 'channel', id, path };
}

export function KnobCell(p: KnobCellProps) {
  const undo = p.undo ?? p.label;
  return (
    <Cell cap={p.cap} className={(p.disabled ? 'dim' : '') + (p.className ? ' ' + p.className : '')}>
      <Knob size={p.size ?? 24} value={p.value} min={p.min} max={p.max} defaultValue={p.def} label={p.label}
        format={p.format} bipolar={p.bipolar} step={p.step} disabled={p.disabled} arcColor={p.arc} extraMenu={p.menu} auto={p.auto}
        onBegin={() => store.beginGesture(undo)} onEnd={() => store.endGesture()} onChange={p.set} />
    </Cell>
  );
}

/** Small knob without caption (tension knobs). */
export function MiniKnob(p: Omit<KnobCellProps, 'cap'>) {
  const undo = p.undo ?? p.label;
  return (
    <div className="cs-mini">
      <Knob size={p.size ?? 16} value={p.value} min={p.min} max={p.max} defaultValue={p.def} label={p.label}
        format={p.format} bipolar={p.bipolar} step={p.step} disabled={p.disabled} arcColor={p.arc} extraMenu={p.menu} auto={p.auto}
        onBegin={() => store.beginGesture(undo)} onEnd={() => store.endGesture()} onChange={p.set} />
    </div>
  );
}

// ---------------------------------------------------------------- switches
const onOff = (v: boolean) => (v ? 'on' : 'off');

/** Checkbox-style switch with a label (SMP content flags, Mono, Porta...). */
export function Toggle({ on, label, name, set, disabled, className }: {
  on: boolean;
  label: ReactNode;
  name: string;
  set: (on: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={'cs-tog' + (on ? ' on' : '') + (disabled ? ' disabled' : '') + (className ? ' ' + className : '')}
      onPointerDown={(e) => {
        if (e.button !== 0 || disabled) return;
        e.preventDefault();
        e.stopPropagation();
        set(!on);
        setHint(`${name}: ${onOff(!on)}`);
      }}
      onPointerEnter={() => setHint(`${name}: ${onOff(on)}`)}
      onPointerLeave={clearHint}>
      <span className="cs-tog-box" />
      <span className="cs-tog-label">{label}</span>
    </div>
  );
}

/** Small lit push button (TEMPO, GLOBAL...). */
export function Pill({ on, label, name, set }: { on: boolean; label: string; name: string; set: (on: boolean) => void }) {
  return (
    <button className={'cs-pill' + (on ? ' on' : '')}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        set(!on);
        setHint(`${name}: ${onOff(!on)}`);
      }}
      onPointerEnter={() => setHint(`${name}: ${onOff(on)}`)}
      onPointerLeave={clearHint}>
      {label}
    </button>
  );
}

export interface SegOption<T> {
  v: T;
  label: ReactNode;
  hint: string;
}

/** One-of-N button group (LFO shape, arp direction, Vel / Key, reverb A / B). */
export function Segmented<T extends string>({ value, options, name, set, vertical, className }: {
  value: T;
  options: readonly SegOption<T>[];
  name: string;
  set: (v: T) => void;
  vertical?: boolean;
  className?: string;
}) {
  return (
    <div className={'cs-seg' + (vertical ? ' vertical' : '') + (className ? ' ' + className : '')}>
      {options.map((o) => (
        <button key={o.v} className={'cs-seg-btn' + (o.v === value ? ' on' : '')}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            if (o.v !== value) set(o.v);
            setHint(`${name}: ${o.hint}`);
          }}
          onPointerEnter={() => setHint(`${name}: ${o.hint}${o.v === value ? '' : ' (click to select)'}`)}
          onPointerLeave={clearHint}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------- selectors
export interface ChoiceOption<T> {
  v: T;
  label: string;
}

/** Drop-down selector: click opens the list, the wheel steps through it. */
export function Choice<T extends string | number>({ value, options, name, onSelect, width, text, menuItems, className }: {
  value: T;
  options: readonly ChoiceOption<T>[];
  name: string;
  onSelect: (v: T) => void;
  width?: number;
  /** Text to show when the value is not one of the options. */
  text?: string;
  /** Custom menu (grouped lists, extra commands); defaults to the options. */
  menuItems?: () => MenuItem[];
  className?: string;
}) {
  const label = options.find((o) => o.v === value)?.label ?? text ?? String(value);
  const items = (): MenuItem[] =>
    menuItems ? menuItems() : options.map((o) => ({ label: o.label, checked: o.v === value, radio: true, onClick: () => onSelect(o.v) }));
  return (
    <div className={'combo cs-sel' + (className ? ' ' + className : '')} style={width ? { width } : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom + 1, items(), { minWidth: r.width });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, items());
      }}
      onWheel={(e) => {
        e.stopPropagation();
        const i = options.findIndex((o) => o.v === value);
        const j = Math.max(0, Math.min(options.length - 1, (i < 0 ? 0 : i) + (e.deltaY > 0 ? 1 : -1)));
        if (j !== i) {
          onSelect(options[j].v);
          setHint(`${name}: ${options[j].label}`);
        }
      }}
      onPointerEnter={() => setHint(`${name}: ${label}`)}
      onPointerLeave={clearHint}>
      <span className="cs-sel-text">{label}</span>
      <svg className="cs-sel-arrow" width="7" height="7" viewBox="0 0 7 7"><path d="M0.5 2 L3.5 5.2 L6.5 2 Z" fill="currentColor" /></svg>
    </div>
  );
}

/** Small arrow button that opens a menu (presets, options). */
export function MenuArrow({ items, hint }: { items: () => MenuItem[]; hint: string }) {
  return (
    <button className="cs-arrow-btn"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom + 1, items(), { minWidth: 150 });
      }}
      onPointerEnter={() => setHint(hint)}
      onPointerLeave={clearHint}>
      <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 2.5 L4 6 L7 2.5 Z" fill="currentColor" /></svg>
    </button>
  );
}

// ------------------------------------------------------------- LCD number
export interface NumBoxProps {
  value: number;
  min: number;
  max: number;
  def: number;
  name: string;
  undo: string;
  /** Text shown in the box. */
  display: (v: number) => string;
  /** Value text for the hint bar (defaults to `display`). */
  hintValue?: (v: number) => string;
  set: (v: number) => void;
  parse?: (s: string) => number | null;
  /** Pixels of vertical drag per unit. */
  px?: number;
  width?: number;
  menu?: () => MenuItem[];
  onDoubleClick?: () => void;
  className?: string;
}

/** Integer value in an LCD box: drag vertically or use the wheel; double-click to type. */
export function NumBox(p: NumBoxProps) {
  const pr = useRef(p);
  pr.current = p;
  const drag = useRef<{ y: number; v: number } | null>(null);
  const hintOf = (v: number) => `${pr.current.name}: ${(pr.current.hintValue ?? pr.current.display)(v)}`;
  const clampV = (v: number) => Math.max(pr.current.min, Math.min(pr.current.max, Math.round(v)));
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('dragging-control');
    store.endGesture();
  };
  const typeIn = () => {
    const c = pr.current;
    const s = prompt(c.name, c.display(c.value));
    if (s === null) return;
    const n = c.parse ? c.parse(s) : parseFloat(s);
    if (n === null || !isFinite(n)) return;
    c.set(clampV(n));
  };
  return (
    <div className={'cs-num' + (p.className ? ' ' + p.className : '')} style={p.width ? { width: p.width } : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: pr.current.value };
        store.beginGesture(pr.current.undo);
        document.body.classList.add('dragging-control');
        setHint(hintOf(pr.current.value));
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) {
          setHint(hintOf(pr.current.value));
          return;
        }
        const v = clampV(d.v + (d.y - e.clientY) / (pr.current.px ?? 6));
        if (v !== pr.current.value) pr.current.set(v);
        setHint(hintOf(v));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onWheel={(e) => {
        e.stopPropagation();
        const c = pr.current;
        const v = clampV(c.value + (e.deltaY < 0 ? 1 : -1));
        if (v !== c.value) c.set(v);
        setHint(hintOf(v));
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (pr.current.onDoubleClick) pr.current.onDoubleClick();
        else typeIn();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const c = pr.current;
        const extra = c.menu ? c.menu() : [];
        openMenu(e.clientX, e.clientY, [
          { header: true, label: c.name },
          { label: 'Reset', onClick: () => c.set(c.def) },
          { label: 'Type in value...', onClick: typeIn },
          ...(extra.length ? [{ separator: true } as MenuItem, ...extra] : []),
        ]);
      }}
      onPointerLeave={() => { if (!drag.current) clearHint(); }}>
      {p.display(p.value)}
    </div>
  );
}

// ------------------------------------------------------------------ canvas
/**
 * Keeps a canvas' bitmap at its CSS size x devicePixelRatio and redraws it on
 * resize or when `deps` change. `draw` receives CSS-pixel coordinates.
 */
export function useCanvas(
  draw: (g: CanvasRenderingContext2D, w: number, h: number, dpr: number) => void,
  deps: readonly unknown[],
) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const measure = () => {
      const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
      setSize((s) => (s.w === w && s.h === h && s.dpr === dpr ? s : { w, h, dpr }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c || size.w <= 0 || size.h <= 0) return;
    const bw = Math.round(size.w * size.dpr), bh = Math.round(size.h * size.dpr);
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    drawRef.current(g, size.w, size.h, size.dpr);
  }, [size, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return ref;
}
