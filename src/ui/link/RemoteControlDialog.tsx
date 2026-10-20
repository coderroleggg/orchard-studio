// Remote control settings dialog ("Link to controller..." in a control's
// menu), after FL's TMIDIInputForm: the parameter, the link entry (Link 1..N /
// New link), the MIDI controller (port, channel, controller, auto detect,
// omni, note mode), the internal controller (outputs of the project's
// controller plugins; the section is hidden when there are none), the mapping
// formula with FL's presets and a graph, smoothing, Remove conflicts, and
// Reset / Remove / Accept. The dialog mounts its own React root, so opening it
// needs no host component.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { store, useProject } from '../../store';
import { automationName, controllerSources, linksOf, removeLink, saveLink } from '../../store/actions';
import { uid } from '../../model/defaults';
import type { AutomationTarget } from '../../model/automation';
import {
  DEFAULT_FORMULA, MAPPING_PRESETS, SMOOTH_TIME_DEFAULT, USER_FORMULAS, mapLinkValue, smoothTimeMs, type ControllerLink,
} from '../../model/links';
import { compileFormula } from '../../model/formula';
import { openMenu, isMenuOpen, type MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint } from '../hint';
import { midiLinkSupport, watchMidiLearn } from '../../audio/midiLinks';
import './remote.css';

// ------------------------------------------------------------ open / close
let current: { target: AutomationTarget; key: number } | null = null;
let nextKey = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let root: Root | null = null;

/** Open the Remote control settings dialog for a parameter. */
export function openLinkDialog(target: AutomationTarget): void {
  if (typeof document === 'undefined') return;
  if (!root) {
    const el = document.createElement('div');
    el.id = 'remote-control-dialog';
    document.body.appendChild(el);
    root = createRoot(el);
    root.render(<DialogHost />);
  }
  current = { target: { ...target }, key: nextKey++ };
  emit();
}

export function closeLinkDialog(): void {
  current = null;
  emit();
}

function DialogHost() {
  const cur = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => current);
  if (!cur) return null;
  return <RemoteControlDialog key={cur.key} target={cur.target} />;
}

// ------------------------------------------------------------ the dialog
interface Settings {
  linkId: string | null; // null: new link
  slotId: string | null;
  output: number;
  port: number;
  chan: number;
  ctrl: number;
  omni: boolean;
  mode: number;
  record: boolean;
  formula: string;
  relative: boolean;
  smooth: boolean;
  smoothTime: number;
}

const NOTE_MODES = ['Default', 'Hold', 'Latch', 'Inc', 'Stay'];

function fromLink(l: ControllerLink | null): Settings {
  return {
    linkId: l?.id ?? null,
    slotId: l?.source?.slotId ?? null,
    output: l?.source?.output ?? 0,
    port: l?.midi?.port ?? -1,
    chan: l?.midi?.chan ?? 1,
    ctrl: l?.midi?.ctrl ?? -1,
    omni: !!l?.midi?.omni,
    mode: l?.midi?.mode ?? 0,
    record: !!l?.record,
    formula: l?.formula ?? DEFAULT_FORMULA,
    relative: !!l?.relative,
    smooth: !!l?.smooth,
    smoothTime: l?.smoothTime ?? SMOOTH_TIME_DEFAULT,
  };
}

function RemoteControlDialog({ target }: { target: AutomationTarget }) {
  // selectors must return stable values: derive the lists from the project in render
  const project = useProject((p) => p);
  const links = useMemo(() => linksOf(target, project), [project.links]); // eslint-disable-line react-hooks/exhaustive-deps
  const sources = controllerSources(project);
  const name = automationName(project, target);
  const [s, setS] = useState<Settings>(() => fromLink(links[0] ?? null));
  const [conflicts, setConflicts] = useState(false);
  const [learn, setLearn] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Settings>) => setS((o) => ({ ...o, ...patch }));

  const compiled = compileFormula(s.formula);
  const hasInternal = sources.length > 0;
  const shift = hasInternal ? 0 : 83; // the hidden Internal controller section (75 + 8 px)
  const H = 490 - shift;

  // centre on screen (poScreenCenter)
  useLayoutEffect(() => {
    if (pos) return;
    setPos({ x: Math.round((window.innerWidth - 258) / 2), y: Math.max(8, Math.round((window.innerHeight - H - 2) / 2)) });
  }, [pos, H]);

  // MIDI learn ("Auto detect"): the next controller moved fills port / channel / controller
  useEffect(() => {
    if (!learn) return;
    return watchMidiLearn((m) => { set({ port: m.port, chan: m.chan, ctrl: m.ctrl }); setLearn(false); });
  }, [learn]);

  const accept = () => {
    const src = hasInternal && s.slotId && sources.some((x) => x.slotId === s.slotId && x.output === s.output)
      ? { slotId: s.slotId, output: s.output } : undefined;
    const midi = s.ctrl >= 0 ? { port: s.port, chan: s.chan, ctrl: s.ctrl, omni: s.omni, mode: s.mode } : undefined;
    if (!src && !midi) {
      if (s.linkId) removeLink(s.linkId);
    } else {
      saveLink({
        id: s.linkId ?? uid('l'),
        target: { ...target },
        ...(src ? { source: src } : {}),
        ...(midi ? { midi } : {}),
        formula: compiled.ok ? s.formula.trim() : DEFAULT_FORMULA,
        ...(s.relative ? { relative: true } : {}),
        ...(s.smooth ? { smooth: true } : {}),
        smoothTime: s.smoothTime,
        ...(s.record ? { record: true } : {}),
      }, conflicts);
    }
    closeLinkDialog();
  };

  const remove = () => {
    if (s.linkId) removeLink(s.linkId);
    closeLinkDialog();
  };

  const reset = () => setS((o) => ({ ...fromLink(null), linkId: o.linkId }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMenuOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLinkDialog(); }
      else if (e.key === 'Enter' && !(e.target as HTMLElement).closest('input')) { e.preventDefault(); e.stopPropagation(); accept(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0 || !pos) return;
    if ((e.target as HTMLElement).closest('.rc-caption-close')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setPos({ x: ox + ev.clientX - sx, y: Math.max(0, oy + ev.clientY - sy) });
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  // ---------------------------------------------------------- menus
  const entryMenu = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = links.map((l, i) => ({
      label: `Link ${i + 1}`, radio: true, checked: s.linkId === l.id, onClick: () => setS(fromLink(l)),
    }));
    items.push({ label: 'New link', radio: true, checked: s.linkId === null, onClick: () => setS(fromLink(null)) });
    openMenu(r.left, r.bottom, items, { minWidth: r.width });
  };

  const sourceMenu = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      { label: '(none)', radio: true, checked: !s.slotId, onClick: () => set({ slotId: null, output: 0 }) },
      { header: true, label: 'Controller plugins' },
      ...sources.map((x) => ({
        label: x.label, radio: true, checked: s.slotId === x.slotId && s.output === x.output,
        onClick: () => set({ slotId: x.slotId, output: x.output }),
      } as MenuItem)),
    ];
    openMenu(r.left, r.bottom, items, { minWidth: r.width });
  };

  const presetMenu = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [];
    const add = (list: typeof MAPPING_PRESETS) => {
      for (const p of list) {
        if (p.section) items.push({ header: true, label: p.section });
        else if (p.separatorBefore) items.push({ separator: true });
        items.push({
          label: p.label, hint: p.formula, checked: s.formula.trim().toLowerCase() === p.formula.toLowerCase() && !!p.relative === s.relative,
          onClick: () => set({ formula: p.formula, relative: !!p.relative }),
        });
      }
    };
    add(MAPPING_PRESETS);
    items.push({ header: true, label: 'User defined' });
    add(USER_FORMULAS);
    openMenu(r.right, r.top, items);
  };

  const modeMenu = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, NOTE_MODES.map((m, i) => ({ label: m, radio: true, checked: s.mode === i, onClick: () => set({ mode: i }) } as MenuItem)), { minWidth: r.width });
  };

  const entryText = s.linkId ? `Link ${Math.max(1, links.findIndex((l) => l.id === s.linkId) + 1)}` : 'New link';
  const srcText = s.slotId ? sources.find((x) => x.slotId === s.slotId && x.output === s.output)?.label ?? '(none)' : '(none)';
  const statusText = !compiled.ok ? `Error compiling expression\n${compiled.error}`
    : s.formula.trim().toLowerCase() === 'input' ? '(default 1:1 mapping)' : 'Compiled ok.';
  const midiOk = midiLinkSupport();

  if (!pos) return null;
  return (
    <div className="rc-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}
      onContextMenu={(e) => e.preventDefault()}>
      <div ref={ref} className="rc-dialog" style={{ left: pos.x, top: pos.y, height: H + 2 }}>
        <div className="rc-caption" onPointerDown={startMove}>
          <span className="rc-caption-icon">
            <svg width="13" height="13" viewBox="0 0 16 16"><path fill="currentColor" d="M6.8 1h2.4l.4 2a5 5 0 0 1 1.4.8l1.9-.7 1.2 2.1-1.5 1.3a5 5 0 0 1 0 1.6l1.5 1.3-1.2 2.1-1.9-.7a5 5 0 0 1-1.4.8l-.4 2H6.8l-.4-2A5 5 0 0 1 5 12.8l-1.9.7-1.2-2.1L3.4 10a5 5 0 0 1 0-1.6L1.9 7.1l1.2-2.1 1.9.7A5 5 0 0 1 6.4 4.9zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" /></svg>
          </span>
          <span className="rc-caption-text">Remote control settings</span>
          <span className="rc-caption-close" onPointerDown={(e) => { e.stopPropagation(); closeLinkDialog(); }}>
            <svg width="9" height="9" viewBox="0 0 9 9"><path d="M1.5 1.5 L7.5 7.5 M7.5 1.5 L1.5 7.5" stroke="currentColor" strokeWidth="1.6" /></svg>
          </span>
        </div>
        <div className="rc-body" style={{ height: H - 26 }}>
          <Combo x={0} y={0} w={256} h={26} large text={name} hint="Current parameter"
            onOpen={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.left, r.bottom, [{ label: name, checked: true, radio: true }], { minWidth: r.width }); }} />
          <Combo x={0} y={37} w={256} h={23} text={entryText} hint="Current assignment" onOpen={entryMenu} />

          <Panel x={1} y={67} w={254} h={96} title="MIDI controller">
            <Lbl x={7} y={33}>Port</Lbl>
            <NumField x={34} y={28} w={40} h={25} value={s.port} min={-1} max={255} hint="MIDI input port number" text={(v) => (v < 0 ? '-' : String(v))} onChange={(v) => set({ port: v })} />
            <Lbl x={90} y={33}>Channel</Lbl>
            <NumField x={137} y={28} w={32} h={25} value={s.chan} min={1} max={16} hint="MIDI channel number" onChange={(v) => set({ chan: v })} />
            <Lbl x={184} y={33}>Ctrl</Lbl>
            <NumField x={208} y={28} w={40} h={25} value={s.ctrl} min={-1} max={127} hint="Continuous Controller number" text={(v) => (v < 0 ? '-' : String(v))} onChange={(v) => set({ ctrl: v })} />
            <Check x={3} y={66} w={88} h={21} on={learn} caption="Auto detect" disabled={!midiOk}
              hint={midiOk ? 'Just move your MIDI controller' : 'Web MIDI is not available in this browser'} onToggle={() => setLearn(!learn)} />
            <Check x={91} y={66} w={60} h={21} on={s.omni} caption="Omni" hint="Input goes to the selected channel / track" onToggle={() => set({ omni: !s.omni })} />
            <Lbl x={151} y={69}>Mode</Lbl>
            <Combo x={188} y={65} w={60} h={23} text={NOTE_MODES[s.mode] ?? 'Default'} hint="How to treat a note or button link" onOpen={modeMenu} />
          </Panel>

          {hasInternal && (
            <Panel x={1} y={171} w={254} h={75} title="Internal controller">
              <Combo x={6} y={26} w={242} h={23} text={srcText} hint="Internal controller" onOpen={sourceMenu} />
              <Check x={139} y={54} w={110} h={18} small on={s.record} caption="Record automation" hint="Allow recording of automation" onToggle={() => set({ record: !s.record })} />
            </Panel>
          )}

          <MapGraph x={3} y={254 - shift} w={76} h={75} formula={compiled.ok ? s.formula : DEFAULT_FORMULA} />
          <Panel x={79} y={254 - shift} w={176} h={77} title="Mapping formula">
            <input className="rc-edit" style={{ left: 6, top: 26, width: 149, height: 20 }} value={s.formula} spellCheck={false}
              onChange={(e) => set({ formula: e.target.value, relative: false })}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') closeLinkDialog(); }}
              onPointerEnter={() => setHint('Input to output mapping formula')} onPointerLeave={clearHint} />
            <div className="rc-presets" style={{ left: 157, top: 24, width: 15, height: 24 }}
              onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); presetMenu(e); } }}
              onPointerEnter={() => setHint('Presets')} onPointerLeave={clearHint}>
              <svg width="7" height="5" viewBox="0 0 7 5"><path d="M0 0 H7 L3.5 5 Z" fill="currentColor" /></svg>
            </div>
            <div className={'rc-status ' + (compiled.ok ? 'ok' : 'err')} style={{ left: 6, top: 50, width: 164, height: 25 }}>{statusText}</div>
          </Panel>

          <Panel x={1} y={339 - shift} w={254} h={42}>
            <Check x={2} y={1} w={95} h={17} on={s.smooth} caption="Smoothing" title hint="Enable automation smoothing" onToggle={() => set({ smooth: !s.smooth })} />
            <Lbl x={104} y={15}>Time</Lbl>
            <HSlider x={130} y={8} w={97} h={26} value={s.smoothTime} min={-1024} max={1024} def={SMOOTH_TIME_DEFAULT} disabled={!s.smooth}
              hint={(v) => (s.smooth ? `Smoothing envelope time: ${Math.round(smoothTimeMs(v))}ms` : 'Disabled')} onChange={(v) => set({ smoothTime: v })} />
          </Panel>

          <Check x={0} y={389 - shift} w={116} h={21} on={conflicts} caption="Remove conflicts" hint="Auto-remove other conflicting assignments" onToggle={() => setConflicts(!conflicts)} />

          <Btn x={1} y={431 - shift} w={68} h={33} hint="Reset all settings" onClick={reset}>Reset</Btn>
          <Btn x={81} y={431 - shift} w={68} h={33} hint="Remove this link" disabled={!s.linkId} onClick={remove}>Remove</Btn>
          <Btn x={170} y={431 - shift} w={68} h={33} hint="Accept" isDefault onClick={accept}>Accept</Btn>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ widgets
type Box = { x: number; y: number; w: number; h: number };

function Combo({ x, y, w, h, text, hint, large, onOpen, disabled }: Box & { text: string; hint?: string; large?: boolean; disabled?: boolean; onOpen: (e: React.PointerEvent) => void }) {
  return (
    <div className={'rc-combo' + (large ? ' large' : '') + (disabled ? ' disabled' : '') + (w < 80 ? ' small' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0 && !disabled) { e.stopPropagation(); onOpen(e); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      <span className="rc-combo-text">{text}</span>
    </div>
  );
}

function Panel({ x, y, w, h, title, children }: Box & { title?: string; children?: React.ReactNode }) {
  return (
    <div className="rc-panel" style={{ left: x, top: y, width: w, height: h }}>
      {title && <div className="rc-panel-tab">{title}</div>}
      {children}
    </div>
  );
}

function Lbl({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return <div className="rc-label" style={{ left: x, top: y }}>{children}</div>;
}

function Check({ x, y, w, h, on, caption, hint, onToggle, small, title, disabled }: Box & {
  on: boolean; caption: string; hint?: string; onToggle: () => void; small?: boolean; title?: boolean; disabled?: boolean;
}) {
  return (
    <div className={'rc-check' + (small ? ' small' : '')} style={{ left: x, top: y, width: w, height: h, opacity: disabled ? 0.5 : 1, fontSize: title ? 12 : undefined, color: title ? '#b9bfc3' : undefined }}
      onPointerDown={(e) => { if (e.button === 0 && !disabled) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      <span className={'rc-led' + (on ? ' on' : '')} />
      <span>{caption}</span>
    </div>
  );
}

function NumField({ x, y, w, h, value, min, max, onChange, text, hint, disabled }: Box & {
  value: number; min: number; max: number; onChange: (v: number) => void; text?: (v: number) => string; hint?: string; disabled?: boolean;
}) {
  const clampV = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  const drag = useRef<{ y: number; v: number } | null>(null);
  return (
    <div className={'rc-num' + (disabled ? ' disabled' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      <div className="rc-num-val"
        onPointerDown={(e) => {
          if (e.button !== 0 || disabled) return;
          e.stopPropagation();
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, v: value };
        }}
        onPointerMove={(e) => { const d = drag.current; if (d) onChange(clampV(d.v + (d.y - e.clientY) / 4)); }}
        onPointerUp={() => { drag.current = null; }}
        onWheel={(e) => { if (!disabled) { e.stopPropagation(); onChange(clampV(value + (e.deltaY < 0 ? 1 : -1))); } }}
        onDoubleClick={() => {
          if (disabled) return;
          const t = prompt(hint ?? 'Value', String(value));
          if (t !== null && Number.isFinite(Number(t))) onChange(clampV(Number(t)));
        }}>
        {text ? text(value) : String(value)}
      </div>
      <div className="rc-num-arrows">
        <div onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0 && !disabled) onChange(clampV(value + 1)); }} />
        <div onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0 && !disabled) onChange(clampV(value - 1)); }} />
      </div>
    </div>
  );
}

function HSlider({ x, y, w, h, value, min, max, def, onChange, hint, disabled }: Box & {
  value: number; min: number; max: number; def: number; onChange: (v: number) => void; hint: (v: number) => string; disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const t = (value - min) / (max - min);
  const setFrom = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left - 9) / (r.width - 18)));
    const v = Math.round(min + f * (max - min));
    onChange(v);
    setHint(hint(v));
  };
  return (
    <div ref={ref} className={'rc-slider' + (disabled ? ' disabled' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => {
        if (e.button === 1 || (e.button === 0 && e.altKey)) { onChange(def); return; }
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        setFrom(e.clientX);
      }}
      onPointerMove={(e) => { if (e.buttons & 1) setFrom(e.clientX); else setHint(hint(value)); }}
      onPointerLeave={clearHint}
      onWheel={(e) => { e.stopPropagation(); const v = Math.min(max, Math.max(min, value + (e.deltaY < 0 ? 16 : -16))); onChange(v); setHint(hint(v)); }}>
      <div className="rc-slider-groove" />
      <div className="rc-slider-fill" style={{ width: `calc(${t * 100}% - ${t * 8}px)` }} />
      <div className="rc-slider-cap" style={{ left: `calc(${t * 100}% - ${t * 10}px)` }} />
    </div>
  );
}

function Btn({ x, y, w, h, children, onClick, hint, disabled, isDefault }: Box & { children: React.ReactNode; onClick: () => void; hint?: string; disabled?: boolean; isDefault?: boolean }) {
  return (
    <div className={'rc-btn' + (disabled ? ' disabled' : '') + (isDefault ? ' default' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}

/** The mapping graph (FL's FGraph): input left to right, output bottom to top. */
function MapGraph({ x, y, w, h, formula }: Box & { formula: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#2a3236';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#3a4448';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = Math.round((w * i) / 4) + 0.5, gy = Math.round((h * i) / 4) + 0.5;
      g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, h); g.stroke();
      g.beginPath(); g.moveTo(0, gy); g.lineTo(w, gy); g.stroke();
    }
    g.strokeStyle = '#d7e4e8';
    g.lineWidth = 1.3;
    g.beginPath();
    for (let i = 0; i <= w; i++) {
      const v = mapLinkValue(formula, i / w);
      const yy = 2 + (1 - v) * (h - 4);
      if (i) g.lineTo(i, yy); else g.moveTo(i, yy);
    }
    g.stroke();
    g.strokeStyle = '#1d2326';
    g.strokeRect(0.5, 0.5, w - 1, h - 1);
  }, [formula, w, h]);
  return (
    <canvas ref={ref} className="rc-graph" style={{ left: x, top: y, width: w, height: h }}
      onPointerMove={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const i = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        setHint(`In: ${Math.round(i * 100)}% out: ${Math.round(mapLinkValue(formula, i) * 100)}%`);
      }}
      onPointerLeave={clearHint} />
  );
}

/** The project's links of a parameter (for the control menu's state). */
export function linkCount(target: AutomationTarget): number {
  return linksOf(target, store.project).length;
}
