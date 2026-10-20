// Hosted module editors: each module's own editor (src/ui/plugins/fx) rendered
// with a context that points at the module inside the Patcher state - as a
// live miniature in the module's node (FL's plugin icon) and in a floating
// plugin window inside the Patcher editor (FL opens them detached).

import { Component, memo, useMemo, useRef, type ReactNode } from 'react';
import { defaultFxParams, fxDef, presetState } from '../../../../model/fx/registry';
import type { PatcherModule } from '../../../../model/fx/plugins/patcher';
import { FxEditorContext } from '../../kit';
import { editorFor } from '../../registry';
import { GenericEditor, genericSize } from '../../GenericEditor';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { editGraph, focusModule, hostedCtx } from './sync';

/** A module editor's size at 100% (FL's editor panel; generic editors grow with their parameters). */
export function editorSize(plugin: string, params?: Record<string, unknown>): { w: number; h: number } {
  const d = fxDef(plugin);
  if (!d) return { w: 260, h: 116 };
  const mod = editorFor(plugin);
  if (mod?.size && params) return mod.size(params);
  return mod ? { w: d.width, h: d.height } : genericSize(d.params.length);
}

/** Node icon size (map units): the editor scaled into FL's icon box. */
export function iconSize(plugin: string): { w: number; h: number; s: number } {
  const e = editorSize(plugin);
  const s = Math.min(0.45, 156 / e.w, 76 / e.h);
  return { w: Math.round(e.w * s), h: Math.round(e.h * s), s };
}

class Boundary extends Component<{ children: ReactNode; name: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.warn('[patcher] module editor failed', e); }
  render() {
    if (this.state.failed) return <div className="ptc-failed">{this.props.name}</div>;
    return this.props.children;
  }
}

/** The module's own editor bound to the module's state. */
const ModuleEditor = memo(function ModuleEditor({ slotId, m, trackName, live }: { slotId: string; m: PatcherModule; trackName: string; live: boolean }) {
  const ctx = useMemo(() => hostedCtx(slotId, m, trackName, live), [slotId, m, trackName, live]);
  const mod = editorFor(m.plugin);
  return (
    <FxEditorContext.Provider value={ctx}>
      <Boundary name={m.name}>{mod ? <mod.Editor /> : <GenericEditor />}</Boundary>
    </FxEditorContext.Provider>
  );
});

/** Live miniature of a module's editor (inert). */
export const Thumbnail = memo(function Thumbnail({ slotId, m, trackName }: { slotId: string; m: PatcherModule; trackName: string }) {
  const e = editorSize(m.plugin);
  const ic = iconSize(m.plugin);
  return (
    <div className="ptc-thumb" style={{ width: ic.w, height: ic.h }}>
      <div style={{ width: e.w, height: e.h, transform: `scale(${ic.w / e.w}, ${ic.h / e.h})`, transformOrigin: '0 0' }}>
        <ModuleEditor slotId={slotId} m={m} trackName={trackName} live={false} />
      </div>
    </div>
  );
});

export interface OpenEditor {
  id: string;
  x: number;
  y: number;
}

const TITLE_H = 22;

/**
 * FL's plugin window for a module ("<name> (Patcher)"): title bar with the
 * preset arrows and selector when the plugin has factory presets, close
 * button; the editor below, scaled down when it does not fit the Patcher.
 */
export function HostedWindow({ slotId, m, trackName, win, bounds, onMove, onClose, onFront }: {
  slotId: string;
  m: PatcherModule;
  trackName: string;
  win: OpenEditor;
  bounds: { w: number; h: number };
  onMove: (x: number, y: number) => void;
  onClose: () => void;
  onFront: () => void;
}) {
  const e = editorSize(m.plugin, m.params);
  const s = Math.min(1, (bounds.w - 8) / e.w, (bounds.h - TITLE_H - 8) / e.h);
  const w = Math.round(e.w * s), h = Math.round(e.h * s);
  const x = Math.max(0, Math.min(bounds.w - w, win.x)), y = Math.max(0, Math.min(bounds.h - h - TITLE_H, win.y));
  const def = fxDef(m.plugin);
  const presets = def?.presets ?? [];
  const cur = typeof m.params.__preset === 'string' ? m.params.__preset : '';
  const curIdx = presets.findIndex((p) => p.name === cur);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const loadPreset = (i: number) => {
    const pr = presets[(i + presets.length) % presets.length];
    if (!pr) return;
    const fresh = presetState(m.plugin, pr, m.params);
    editGraph(slotId, `Preset: ${pr.name}`, (g) => { const mm = g.modules[m.id]; if (mm) mm.params = fresh; });
  };
  const presetMenu = (cx: number, cy: number) => {
    openMenu(cx, cy, presets.map((p, i) => ({ label: p.name, checked: i === curIdx, radio: true, onClick: () => loadPreset(i) } as MenuItem)), { minWidth: 160 });
  };
  const winMenu = (cx: number, cy: number) => {
    focusModule(slotId, m.id);
    const items: MenuItem[] = [];
    if (presets.length) items.push({ label: 'Presets', submenu: presets.map((p, i) => ({ label: p.name, checked: i === curIdx, radio: true, onClick: () => loadPreset(i) } as MenuItem)) }, { separator: true });
    // the module editor's own options menu, addressed to the hosted module
    const own = editorFor(m.plugin)?.menu?.(`${slotId}#${m.id}`) ?? [];
    if (own.length) items.push(...own, { separator: true });
    items.push({
      label: 'Reset to default', onClick: () => editGraph(slotId, `Reset ${m.name}`, (g) => { const mm = g.modules[m.id]; if (mm) mm.params = defaultFxParams(m.plugin); }),
    });
    openMenu(cx, cy, items);
  };
  return (
    <div className="ptc-win" style={{ left: x, top: y, width: w }}
      onPointerDownCapture={() => onFront()}>
      <div className="ptc-win-title" style={{ height: TITLE_H }}
        onPointerDown={(ev) => {
          if (ev.button !== 0) return;
          ev.stopPropagation();
          (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
          drag.current = { px: ev.clientX, py: ev.clientY, x, y };
        }}
        onPointerMove={(ev) => {
          const d = drag.current;
          if (!d) return;
          const k = (ev.currentTarget as HTMLElement).getBoundingClientRect().width / Math.max(1, w);
          onMove(d.x + (ev.clientX - d.px) / k, d.y + (ev.clientY - d.py) / k);
        }}
        onPointerUp={() => { drag.current = null; }}
        onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); winMenu(ev.clientX, ev.clientY); }}>
        <span className="ptc-win-menu" onPointerDown={(ev) => { ev.stopPropagation(); if (ev.button === 0) winMenu(ev.clientX, ev.clientY); }}
          onPointerEnter={() => setHint('Plugin options')} onPointerLeave={clearHint}>
          <svg width="8" height="8" viewBox="0 0 8 8"><path d="M0.5 2 L7.5 2 L4 6.5 Z" fill="currentColor" /></svg>
        </span>
        <span className="ptc-win-caption">{m.name} <span className="ptc-win-sub">(Patcher)</span></span>
        {presets.length > 0 && (
          <span className="ptc-win-presets">
            <span className="ptc-win-pname" onPointerDown={(ev) => { ev.stopPropagation(); if (ev.button === 0) presetMenu(ev.clientX, ev.clientY); }}
              onPointerEnter={() => setHint('Select preset')} onPointerLeave={clearHint}>{cur || 'Presets'}</span>
            <span className="ptc-win-btn" onPointerDown={(ev) => { ev.stopPropagation(); if (ev.button === 0) loadPreset(curIdx < 0 ? presets.length - 1 : curIdx - 1); }}
              onPointerEnter={() => setHint('Previous preset')} onPointerLeave={clearHint}>
              <svg width="7" height="9" viewBox="0 0 7 9"><path d="M6 0.5 L1 4.5 L6 8.5 Z" fill="currentColor" /></svg>
            </span>
            <span className="ptc-win-btn" onPointerDown={(ev) => { ev.stopPropagation(); if (ev.button === 0) loadPreset(curIdx + 1); }}
              onPointerEnter={() => setHint('Next preset')} onPointerLeave={clearHint}>
              <svg width="7" height="9" viewBox="0 0 7 9"><path d="M1 0.5 L6 4.5 L1 8.5 Z" fill="currentColor" /></svg>
            </span>
          </span>
        )}
        <span className="ptc-win-btn ptc-win-close" onPointerDown={(ev) => { ev.stopPropagation(); if (ev.button === 0) onClose(); }}
          onPointerEnter={() => setHint('Close')} onPointerLeave={clearHint}>
          <svg width="9" height="9" viewBox="0 0 9 9"><path d="M1 1 L8 8 M8 1 L1 8" stroke="currentColor" strokeWidth="1.6" /></svg>
        </span>
      </div>
      <div className="ptc-win-body" style={{ width: w, height: h }}
        onPointerDownCapture={() => focusModule(slotId, m.id)}
        onWheelCapture={() => focusModule(slotId, m.id)}
        onContextMenuCapture={() => focusModule(slotId, m.id)}
        onKeyDownCapture={() => focusModule(slotId, m.id)}>
        <div style={{ width: e.w, height: e.h, transform: `scale(${s})`, transformOrigin: '0 0' }}>
          <ModuleEditor slotId={slotId} m={m} trackName={trackName} live />
        </div>
      </div>
    </div>
  );
}
