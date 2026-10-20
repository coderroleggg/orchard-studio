// Effect editor windows: one floating window per open 'fx:<slotId>' entry
// whose mixer slot still exists. Parametric EQ 2 has its own sizing; every
// other plugin renders its editor (src/ui/plugins/fx) at FL's editor size,
// scaled to the window. The scaled panel, the preset bar and the MIDI input
// port box are shared with instrument channels (Channel settings' PLUGIN tab).

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { store, useProject, useUi } from '../../store';
import * as A from '../../store/actions';
import { findFx, updateWindow } from '../../store/actions';
import { Window } from '../windows/Window';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import './pluginWindows.css';
import { ParametricEQ2 } from './ParametricEQ2';
import { currentParams, resetAll } from './peq2Edit';
import { optionsMenu } from './peq2Menus';
import { BASE_H, BASE_W } from './peq2Layout';
import { defaultFxParams, fxDef, presetState } from '../../model/fx/registry';
import { mixerTrackName } from '../../model/defaults';
import { FxEditorContext, type FxEditorCtx } from './kit';
import { editorFor, persistentPlugins } from './registry';
import { genEditorFor, persistentGenPlugins } from './genRegistry';
import { genDef } from '../../model/gen/registry';
import { GenericEditor, genericSize } from './GenericEditor';
import { EditorBoundary } from './EditorBoundary';
import { flashHint, setHint, clearHint } from '../hint';
import { NOTE_INPUT_FX, portText } from '../../model/midiout';
import { useControl } from '../widgets/control';

// window chrome around the editor: 1 px border each side, 24 px title bar
const CHROME_W = 2;
const CHROME_H = 26;
// size A.openFxWindow gives a new PEQ2 window; replaced once by the editor's own 700 x 350
const OPEN_W = 700;
const OPEN_H = 460;
const fitted = new Set<string>();

export function PluginWindows() {
  const windows = useUi((u) => u.windows);
  const ids = Object.keys(windows).filter((id) => id.startsWith('fx:') && windows[id].open);
  return (
    <>
      {ids.map((id) => <FxWindow key={id} id={id} slotId={id.slice(3)} />)}
      <PersistentFx />
      <PersistentGen />
    </>
  );
}

const PERSISTENT = persistentPlugins();
const PERSISTENT_GEN = persistentGenPlugins();

/** Detached displays of instrument plugins (FxEditorModule.Persistent), for every channel holding them. */
function PersistentGen() {
  const key = useProject((p) => {
    if (PERSISTENT_GEN.size === 0) return '';
    const out: string[] = [];
    for (const g of A.allGens(p)) if (PERSISTENT_GEN.has(g.plugin)) out.push(g.id);
    return out.join(',');
  });
  if (!key) return null;
  return <>{key.split(',').map((slotId) => <PersistentGenSlot key={slotId} slotId={slotId} />)}</>;
}

const PersistentGenSlot = memo(function PersistentGenSlot({ slotId }: { slotId: string }) {
  const plugin = useProject((p) => findFx(p, slotId)?.fx.plugin ?? null);
  const params = useProject((p) => findFx(p, slotId)?.fx.params ?? null);
  const name = useProject((p) => p.channels.find((c) => c.id === A.channelOfSlot(slotId))?.name ?? '');
  const mod = plugin ? genEditorFor(plugin) : undefined;
  if (!plugin || !params || !mod?.Persistent) return null;
  const ctx: FxEditorCtx = { slotId, plugin, params: params as Record<string, unknown>, trackName: name, pluginName: genDef(plugin)?.name ?? plugin };
  const P = mod.Persistent;
  return <FxEditorContext.Provider value={ctx}><EditorBoundary name={`${ctx.pluginName} display`} width={240} height={60}><P /></EditorBoundary></FxEditorContext.Provider>;
});

/** Detached plugin displays that live as long as their slot (see FxEditorModule.Persistent). */
function PersistentFx() {
  const key = useProject((p) => {
    if (PERSISTENT.size === 0) return '';
    const out: string[] = [];
    for (const s of A.allFx(p)) if (PERSISTENT.has(s.plugin)) out.push(s.id);
    return out.join(',');
  });
  if (!key) return null;
  return <>{key.split(',').map((slotId) => <PersistentSlot key={slotId} slotId={slotId} />)}</>;
}

const PersistentSlot = memo(function PersistentSlot({ slotId }: { slotId: string }) {
  const plugin = useProject((p) => findFx(p, slotId)?.fx.plugin ?? null);
  const params = useProject((p) => findFx(p, slotId)?.fx.params ?? null);
  const trackName = useProject((p) => {
    const loc = findFx(p, slotId);
    return loc ? mixerTrackName(p.mixer.tracks[loc.track]) : '';
  });
  const mod = plugin ? editorFor(plugin) : undefined;
  if (!plugin || !params || !mod?.Persistent) return null;
  const ctx: FxEditorCtx = { slotId, plugin, params: params as Record<string, unknown>, trackName, pluginName: fxDef(plugin)?.name ?? plugin };
  const P = mod.Persistent;
  return <FxEditorContext.Provider value={ctx}><EditorBoundary name={`${ctx.pluginName} display`} width={240} height={60}><P /></EditorBoundary></FxEditorContext.Provider>;
});

const FxWindow = memo(function FxWindow({ id, slotId }: { id: string; slotId: string }) {
  const plugin = useProject((p) => findFx(p, slotId)?.fx.plugin ?? null);
  const title = useUi((u) => u.windows[id]?.title ?? 'Effect');

  useEffect(() => {
    if (plugin !== 'peq2' || fitted.has(id)) return;
    fitted.add(id);
    const w = store.ui.windows[id];
    if (w && w.w === OPEN_W && w.h === OPEN_H) updateWindow(id, { w: BASE_W + CHROME_W, h: BASE_H + CHROME_H });
  }, [id, plugin]);

  if (!plugin) return null;
  if (plugin === 'peq2') {
    const menu = (): MenuItem[] => {
      const p = currentParams(slotId);
      return [
        ...(p ? [{ label: 'Options', submenu: optionsMenu(slotId, p) }] : []),
        { label: 'Reset to default', onClick: () => resetAll(slotId) },
      ];
    };
    return (
      <Window id={id} title={title} minW={380} minH={230} menu={menu}>
        <ParametricEQ2 slotId={slotId} />
      </Window>
    );
  }
  return <GenericFxWindow id={id} slotId={slotId} plugin={plugin} title={title} />;
});

/**
 * The plugin wrapper's MIDI input port ("Input port"): notes from MIDI Out
 * channels on this port reach the effect. FL's port selector shows "⋯" when no
 * port is set; clicking it then assigns one ("No input port set (click to auto
 * assign)").
 */
function midiPortMenu(slotId: string, port: number): MenuItem[] {
  return portMenu(port, (p) => A.setFxMidiPort(slotId, p));
}

/** The MIDI input port menu (None, Auto assign, the MIDI Out channels' ports, Type in port...). */
export function portMenu(port: number, set: (port: number) => void): MenuItem[] {
  const byPort = new Map<number, string[]>();
  for (const c of store.project.channels) {
    if (c.kind !== 'midiout' || !c.midiOut) continue;
    const list = byPort.get(c.midiOut.port) ?? [];
    list.push(c.name);
    byPort.set(c.midiOut.port, list);
  }
  const auto = A.autoMidiPort();
  const ports = [...byPort.keys()].sort((a, b) => a - b);
  return [
    { label: 'None', radio: true, checked: port < 0, onClick: () => set(-1) },
    { label: `Auto assign (port ${auto})`, onClick: () => set(auto) },
    ...(ports.length ? [{ header: true, label: 'MIDI Out channels' } as MenuItem] : []),
    ...ports.map((p): MenuItem => ({ label: `Port ${p} - ${byPort.get(p)!.join(', ')}`, radio: true, checked: port === p, onClick: () => set(p) })),
    ...(port >= 0 && !byPort.has(port) ? [{ label: `Port ${port}`, radio: true, checked: true } as MenuItem] : []),
    { separator: true },
    {
      label: 'Type in port...', onClick: () => {
        const t = prompt('MIDI input port (0..255, empty = none)', port >= 0 ? String(port) : '');
        if (t === null) return;
        const n = parseInt(t, 10);
        set(t.trim() === '' || !Number.isFinite(n) ? -1 : Math.max(0, Math.min(255, n)));
      },
    },
  ];
}

/** Port selector in the plugin window's title bar (drag / wheel; click "⋯" to auto assign; right-click for the menu). */
function MidiPortBox({ slotId, port }: { slotId: string; port: number }) {
  return <PortBox port={port} set={(p) => A.setFxMidiPort(slotId, p)} />;
}

/** A MIDI input port box (effect slots and instrument channels). */
export function PortBox({ port, set }: { port: number; set: (port: number) => void }) {
  const hnd = useControl({
    value: port, min: -1, max: 255, defaultValue: -1, step: 1, label: 'MIDI input port', travel: 300, format: portText, parse: (v) => v,
    onChange: (v) => set(Math.round(v)), onBegin: () => store.beginGesture('MIDI input port'), onEnd: () => store.endGesture(),
  }, 'vertical');
  return (
    <div className="fxw-port" {...hnd}
      style={{ display: 'flex', alignItems: 'center', gap: 4, height: 17, padding: '0 5px', marginRight: 6, borderRadius: 3, background: 'rgba(0, 0, 0, 0.25)', cursor: 'ns-resize', touchAction: 'none', fontSize: 10 }}
      onPointerDown={(e) => {
        if (e.button === 0 && port < 0 && !e.altKey) { e.stopPropagation(); set(A.autoMidiPort()); return; }
        e.stopPropagation();
        hnd.onPointerDown(e);
      }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, [{ header: true, label: 'MIDI input port' }, ...portMenu(port, set)]); }}
      onPointerMove={(e) => { hnd.onPointerMove(e); if (e.buttons === 0) setHint(port < 0 ? 'No input port set (click to auto assign)' : `MIDI input port: ${port} - drag to change, right-click for options`); }}
      onPointerLeave={() => { hnd.onPointerLeave(); clearHint(); }}>
      <span style={{ color: '#9aa6ad', letterSpacing: '0.04em' }}>PORT</span>
      <span style={{ minWidth: 16, textAlign: 'center', color: port >= 0 ? '#ffcf70' : '#c9d2d7', fontSize: 11 }}>{portText(port)}</span>
    </div>
  );
}

function GenericFxWindow({ id, slotId, plugin, title }: { id: string; slotId: string; plugin: string; title: string }) {
  const params = useProject((p) => findFx(p, slotId)?.fx.params ?? null);
  const midiPort = useProject((p) => findFx(p, slotId)?.fx.midiPort ?? -1);
  const takesNotes = NOTE_INPUT_FX.has(plugin) || midiPort >= 0;
  const trackName = useProject((p) => {
    const loc = findFx(p, slotId);
    return loc ? mixerTrackName(p.mixer.tracks[loc.track]) : '';
  });
  const def = fxDef(plugin);
  const mod = editorFor(plugin);
  const size = mod?.size && params ? mod.size(params as Record<string, unknown>)
    : mod || !def ? { w: def?.width ?? 400, h: def?.height ?? 200 } : genericSize(def.params.length);

  // fit the window to the editor on first open, and whenever the editor changes size
  const lastSize = useRef(`${size.w}x${size.h}`);
  useEffect(() => {
    const key = `${size.w}x${size.h}`;
    if (fitted.has(id) && lastSize.current === key) return;
    fitted.add(id);
    lastSize.current = key;
    updateWindow(id, { w: size.w + CHROME_W, h: size.h + CHROME_H });
  }, [id, size.w, size.h]);

  if (!params) return null;
  const ctx: FxEditorCtx = { slotId, plugin, params: params as Record<string, unknown>, trackName, pluginName: def?.name ?? plugin };
  const presets = def?.presets ?? [];
  const current = typeof (params as Record<string, unknown>).__preset === 'string' ? (params as Record<string, unknown>).__preset as string : '';
  const loadPreset = (i: number) => {
    const pr = presets[(i + presets.length) % presets.length];
    if (!pr) return;
    const fresh = presetState(plugin, pr, params as Record<string, unknown>);
    A.editFx(slotId, `Preset: ${pr.name}`, (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
  };
  const curIdx = presets.findIndex((p) => p.name === current);
  const portBox = takesNotes ? <MidiPortBox slotId={slotId} port={midiPort} /> : null;
  const toolbar = presets.length ? <PresetBar names={presets.map((p) => p.name)} current={current} load={loadPreset} before={portBox} />
    : portBox ? <div className="fxw-presets">{portBox}</div> : undefined;
  const menu = (): MenuItem[] => [
    ...(presets.length ? [{ label: 'Presets', submenu: presetMenu(presets.map((p) => p.name), curIdx, loadPreset) }, { separator: true } as MenuItem] : []),
    ...(takesNotes ? [{ label: 'MIDI input port', submenu: midiPortMenu(slotId, midiPort) }, { separator: true } as MenuItem] : []),
    ...(mod?.menu ? [...mod.menu(slotId), { separator: true } as MenuItem] : []),
    {
      label: 'Reset to default', onClick: () => {
        const fresh = defaultFxParams(plugin);
        A.editFx(slotId, 'Reset plugin', (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
        flashHint(`${def?.name ?? plugin} reset`);
      },
    },
  ];
  return (
    <Window id={id} title={title} toolbar={toolbar} minW={Math.min(260, size.w)} minH={Math.min(140, size.h)} menu={menu}>
      <FxEditorContext.Provider value={ctx}>
        <Scaled w={size.w} h={size.h}>
          <EditorBoundary name={def?.name ?? plugin} width={size.w} height={size.h}>
            {mod ? <mod.Editor /> : <GenericEditor />}
          </EditorBoundary>
        </Scaled>
      </FxEditorContext.Provider>
    </Window>
  );
}

/**
 * The plugin wrapper's preset browser in a window's title bar: previous / next
 * arrows and the current preset's name (click: the preset menu). `load` gets
 * the preset index (wrapping around).
 */
export function PresetBar({ names, current, load, before }: { names: string[]; current: string; load: (i: number) => void; before?: React.ReactNode }) {
  const curIdx = names.indexOf(current);
  return (
    <div className="fxw-presets">
      {before}
      <button className="fxw-pbtn" title="Previous preset" onPointerDown={(e) => { e.stopPropagation(); load(curIdx < 0 ? names.length - 1 : curIdx - 1); }}>
        <svg width="8" height="8" viewBox="0 0 8 8"><path d="M6 1 L2 4 L6 7 Z" fill="currentColor" /></svg>
      </button>
      <button className="fxw-pbtn" title="Next preset" onPointerDown={(e) => { e.stopPropagation(); load(curIdx + 1); }}>
        <svg width="8" height="8" viewBox="0 0 8 8"><path d="M2 1 L6 4 L2 7 Z" fill="currentColor" /></svg>
      </button>
      <span className="fxw-pname" onPointerDown={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, presetMenu(names, curIdx, load), { minWidth: 160 });
      }}>{current || 'Presets'}</span>
    </div>
  );
}

/** Preset menu items; names written "Folder/Name" go into submenus (FL's preset folders). */
export function presetMenu(names: string[], current: number, load: (i: number) => void): MenuItem[] {
  const root: MenuItem[] = [];
  const folders = new Map<string, MenuItem[]>();
  names.forEach((full, i) => {
    const cut = full.lastIndexOf('/');
    const item: MenuItem = { label: cut >= 0 ? full.slice(cut + 1) : full, checked: i === current, radio: true, onClick: () => load(i) };
    if (cut < 0) { root.push(item); return; }
    const folder = full.slice(0, cut);
    let sub = folders.get(folder);
    if (!sub) { sub = []; folders.set(folder, sub); root.push({ label: folder, submenu: sub }); }
    sub.push(item);
  });
  return root;
}

/** Scales a fixed-size editor uniformly to fit the window body (effect windows, the instrument PLUGIN tab). */
export function Scaled({ w, h, children }: { w: number; h: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [s, setS] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const k = Math.min(el.clientWidth / w, el.clientHeight / h);
      setS(Number.isFinite(k) && k > 0 ? k : 1);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [w, h]);
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#4d575e' }}>
      <div style={{ width: w, height: h, transform: `scale(${s})`, transformOrigin: '0 0' }}>{children}</div>
    </div>
  );
}
