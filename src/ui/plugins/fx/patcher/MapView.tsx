// Patcher "Map" tab: the module graph. Nodes show live miniatures of their
// editors; cables are FL's curves with an arrow in the middle (drag the arrow
// vertically for the link level, right-click an audio link to mute it).
// Mouse (FL's Patcher manual): drag a node to move it (Ctrl/Shift-click adds
// to the selection, drag on empty space selects with a rubber band), drag
// from an output to an input to link (compatible ports light up; drop on a
// node for a list of its inputs), pick up a link by its input end to move or
// remove it, double-click a module to open its editor (Alt+click keeps the
// others open), right-click for the module / map menus, middle-drag pans,
// wheel scrolls, Ctrl / Alt / Shift + wheel zoom vertically / horizontally /
// both, Ctrl + right-drag zooms into a region, double-click on empty space
// toggles the zoomed-out view. Keys: Del deletes the selection, M toggles the
// minimap, Shift+M cycles its size, 1-4 move it to a corner, F8 adds a plugin.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fxDef } from '../../../../model/fx/registry';
import { genDef } from '../../../../model/gen/registry';
import { channelOfSlot } from '../../../../model/gen/ids';
import {
  IN, IN_NAME, LINK_MAX, OUT, OUT_NAME, addModule, autoArrange, connect, connectError, disconnect, disconnectNode,
  inPortOut, inPorts, isGenModule, levelText, nodePorts, portName, removeModules, shownOuts, uniqueName,
  type LinkKind, type PatcherGraph, type PatcherLink, type PatcherModule,
} from '../../../../model/fx/plugins/patcher';
import { store } from '../../../../store';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, flashHint, setHint } from '../../../hint';
import { fxPickerItems, genPickerItems } from '../../pluginMenu';
import { Thumbnail, iconSize, moduleDefaults } from './Hosted';
import { FromIcon, ToIcon } from './icons';
import { editGraph, viewGraph } from './sync';
import {
  PORT_R, allPorts, cable, findPort, nodeBox, nodeCentre, nodeScale, toMap, toScreen, workspace,
  type PortPos, type PortRef, type Xf,
} from './geometry';

export const SB = 12; // scrollbar thickness

const COLORS: Record<LinkKind, { on: string; off: string; cable: string }> = {
  audio: { on: '#ffdf20', off: '#b66700', cable: '#ffdc1f' },
  events: { on: '#2cffdb', off: '#009259', cable: '#2cf5d4' },
};

const MINIMAP_SIZES = [{ w: 110, h: 74 }, { w: 160, h: 106 }, { w: 230, h: 152 }];

/** View transforms per Patcher slot (kept while the editor is closed). */
const views = new Map<string, { xf: Xf; prev: Xf | null }>();

type Drag =
  | { kind: 'move'; ids: string[]; x0: number; y0: number; dx: number; dy: number; moved: boolean }
  | { kind: 'cable'; from: PortRef; x: number; y: number; pick?: PatcherLink; reverse: boolean }
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: 'pan'; x0: number; y0: number; ox: number; oy: number }
  | { kind: 'level'; link: string; y0: number; level0: number; level: number }
  | { kind: 'zoomrect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'minimap'; x0: number; y0: number; ox: number; oy: number; k: number }
  | { kind: 'scroll'; axis: 'x' | 'y'; p0: number; o0: number; k: number };

export interface Activity {
  /** Output peak per node id ('in' = From FL Studio). */
  peaks: Map<string, number>;
  /** Latency per module (samples) and the sample rate. */
  lat: Map<string, number>;
  sr: number;
  total: number;
}

export interface MapViewProps {
  slotId: string;
  graph: PatcherGraph;
  trackName: string;
  width: number;
  height: number;
  activity: Activity | null;
  openEditor: (id: string, keepOthers: boolean) => void;
  hideEditors: () => void;
  closeEditor: (id: string) => void;
  /** Receives the root menu opener (the top bar's options button). */
  menuRef?: React.MutableRefObject<((x: number, y: number) => void) | null>;
}

export function MapView({ slotId, graph: g, trackName, width, height, activity, openEditor, hideEditors, closeEditor, menuRef }: MapViewProps) {
  const view = g.view;
  const vw = width - SB, vh = height - SB;
  const ws = useMemo(() => workspace(g, vw, vh), [g, vw, vh]);
  const stored = views.get(slotId);
  const [xf, setXfState] = useState<Xf>(() => stored?.xf ?? { zx: 1, zy: 1, ox: 0, oy: 0 });
  const prevXf = useRef<Xf | null>(stored?.prev ?? null);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d); };
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const mouse = useRef({ x: vw / 2, y: vh / 2 });

  // keep the view inside the workspace
  const clampXf = useCallback((t: Xf): Xf => {
    const fx = Math.min(vw / ws.w, vh / ws.h);
    const zx = Math.min(6, Math.max(Math.min(1, fx), t.zx)), zy = Math.min(6, Math.max(Math.min(1, fx), t.zy));
    const spanX = vw / zx, spanY = vh / zy;
    const ox = spanX >= ws.w ? (ws.w - spanX) / 2 : Math.min(ws.w - spanX, Math.max(0, t.ox));
    const oy = spanY >= ws.h ? (ws.h - spanY) / 2 : Math.min(ws.h - spanY, Math.max(0, t.oy));
    return { zx, zy, ox, oy };
  }, [vw, vh, ws.w, ws.h]);
  const cxf = useMemo(() => clampXf(xf), [xf, clampXf]);
  const setXf = useCallback((t: Xf) => {
    const c = clampXf(t);
    setXfState(c);
    views.set(slotId, { xf: c, prev: prevXf.current });
  }, [clampXf, slotId]);

  const zn = nodeScale(cxf);
  const moved = useMemo(() => {
    const m = new Map<string, { dx: number; dy: number }>();
    if (drag?.kind === 'move') for (const id of drag.ids) m.set(id, { dx: drag.dx, dy: drag.dy });
    return m;
  }, [drag]);
  const ports = useMemo(() => allPorts(g, cxf, view, moved), [g, cxf, view, moved]);
  const connected = useMemo(() => {
    const s = new Set<string>();
    for (const l of g.links) { s.add(`${l.from}|${l.kind}|out|${l.fromPort}`); s.add(`${l.to}|${l.kind}|in|${l.toPort}`); }
    return s;
  }, [g.links]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const k = r.width / width || 1;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k, k };
  };

  const centreOf = (id: string) => {
    const c = nodeCentre(g, id);
    if (!c) return null;
    const off = moved.get(id);
    return toScreen(cxf, c.x + (off?.dx ?? 0), c.y + (off?.dy ?? 0));
  };

  /** Node under a screen point (icon box), topmost first. */
  const nodeAt = (x: number, y: number): string | null => {
    const ids = [...g.order.filter((id) => g.modules[id])].reverse();
    ids.push(IN, OUT);
    for (const id of ids) {
      const c = centreOf(id);
      if (!c) continue;
      const b = nodeBox(g, id);
      if (Math.abs(x - c.x) <= (b.w / 2) * zn + 2 && Math.abs(y - c.y) <= (b.h / 2) * zn + 2) return id;
    }
    return null;
  };

  const portAt = (x: number, y: number): PortPos | null => {
    let best: PortPos | null = null, bd = (PORT_R + 4) * Math.max(1, zn);
    for (const p of ports) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bd) { bd = d; best = p; }
    }
    return best;
  };

  const compatible = (from: PortRef, to: PortRef): boolean => {
    if (from.kind !== to.kind || from.dir === to.dir) return false;
    const o = from.dir === 'out' ? from : to, i = from.dir === 'out' ? to : from;
    // a picked-up link may land where it came from
    return connectError(g, o.kind, o.node, o.port, i.node, i.port) === null;
  };

  // ---------------------------------------------------------------- edits
  const addAt = (plugin: string, mx: number, my: number, gen = false) => {
    const d = gen ? genDef(plugin) : fxDef(plugin);
    if (!d) return;
    editGraph(slotId, `Add ${d.name}`, (dg) => {
      const m = addModule(dg, plugin, moduleDefaults(plugin, gen), Math.max(70, mx), Math.max(60, my), uniqueName(dg, d.name), gen);
      setSel(new Set([m.id]));
    });
  };

  /**
   * The plugin picker: effects by category, then (first, in a channel's Patcher)
   * a Generators folder with the instruments by category. Patcher itself is not
   * offered inside Patcher (a nested one would edit the outer graph).
   */
  const pickerItems = (pos: { x: number; y: number }): MenuItem[] => {
    const fxItems = fxPickerItems((plugin) => addAt(plugin, pos.x, pos.y)).map((c) => ({
      ...c, submenu: (c.submenu ?? []).filter((it) => it.label !== 'Patcher'),
    })).filter((c) => (c.submenu ?? []).length > 0);
    const genItems: MenuItem = { label: 'Generators', submenu: genPickerItems((plugin) => addAt(plugin, pos.x, pos.y, true)) };
    return channelOfSlot(slotId) !== null ? [genItems, ...fxItems] : [...fxItems, genItems];
  };

  const deleteNodes = (ids: string[]) => {
    const mods = ids.filter((id) => g.modules[id]);
    if (!mods.length) return;
    for (const id of mods) closeEditor(id);
    editGraph(slotId, mods.length > 1 ? 'Delete modules' : `Delete ${g.modules[mods[0]].name}`, (dg) => removeModules(dg, mods));
    setSel(new Set());
  };

  const link = (a: PortRef, b: PortRef, pick?: PatcherLink) => {
    const o = a.dir === 'out' ? a : b, i = a.dir === 'out' ? b : a;
    const err = connectError(g, o.kind, o.node, o.port, i.node, i.port);
    if (err && !(pick && pick.from === o.node && pick.fromPort === o.port && pick.to === i.node && pick.toPort === i.port)) {
      flashHint(err);
      return;
    }
    if (pick && pick.from === o.node && pick.fromPort === o.port && pick.to === i.node && pick.toPort === i.port) return;
    editGraph(slotId, pick ? 'Move link' : 'Link', (dg) => {
      if (pick) disconnect(dg, pick.id);
      const l = connect(dg, o.kind, o.node, o.port, i.node, i.port);
      if (l && pick) { l.level = pick.level; l.mute = pick.mute; }
    });
  };

  /** Dropping a cable on a node: link to its only compatible port, or list them (FL's popup). */
  const dropOnNode = (id: string, from: PortRef, pick: PatcherLink | undefined, cx: number, cy: number) => {
    const p = nodePorts(g, id);
    if (!p) return;
    const want: 'in' | 'out' = from.dir === 'out' ? 'in' : 'out';
    const n = want === 'in' ? (from.kind === 'audio' ? p.audioIn : p.eventsIn) : (from.kind === 'audio' ? p.audioOut : p.eventsOut);
    const opts: PortRef[] = [];
    // outputs: the ones the node shows (From FL Studio's MIDI ports only when activated)
    const ks = want === 'out' ? shownOuts(g, id, from.kind) : Array.from({ length: n }, (_, k) => k);
    for (const k of ks) {
      const r: PortRef = { node: id, kind: from.kind, dir: want, port: k };
      if (compatible(from, r)) opts.push(r);
    }
    if (!opts.length) { flashHint(want === 'in' ? 'No compatible input' : 'No compatible output'); if (pick) editGraph(slotId, 'Unlink', (dg) => disconnect(dg, pick.id)); return; }
    if (opts.length === 1) { link(from, opts[0], pick); return; }
    openMenu(cx, cy, [
      { header: true, label: g.modules[id]?.name ?? (id === IN ? IN_NAME : OUT_NAME) },
      ...opts.map((r) => ({ label: portName(g, id, r.kind, r.dir, r.port), onClick: () => link(from, r, pick) } as MenuItem)),
    ]);
  };

  // ---------------------------------------------------------------- menus
  const setView = (patch: Partial<PatcherGraph['view']>) => viewGraph(slotId, (dg) => { Object.assign(dg.view, patch); });

  const fit = () => {
    const f = Math.min(vw / ws.w, vh / ws.h, 1);
    return { zx: f, zy: f, ox: 0, oy: 0 };
  };
  const zoomOut = () => { prevXf.current = cxf; setXf(fit()); };
  const nextZoom = () => { const p = prevXf.current; prevXf.current = cxf; if (p) setXf(p); };

  const rootMenu = (cx: number, cy: number, at?: { x: number; y: number }) => {
    const pos = at ?? toMap(cxf, vw / 2, vh / 2);
    const add = pickerItems(pos);
    const chk = (label: string, key: keyof PatcherGraph['view'], shortcut?: string): MenuItem => ({
      label, shortcut, checked: !!view[key], onClick: () => setView({ [key]: !view[key] } as Partial<PatcherGraph['view']>),
    });
    openMenu(cx, cy, [
      { label: 'Show plugin picker', shortcut: 'F8', onClick: () => openMenu(cx, cy, add, { minWidth: 150 }) },
      { label: 'Add plugin', submenu: add },
      { separator: true },
      {
        label: 'View', submenu: [
          chk('Audio', 'audio'), chk('Events', 'events'), chk('Parameters', 'params'),
          { separator: true },
          chk('Activity', 'activity'), chk('Labels', 'labels'), chk('Latency', 'latency'), chk('Performance', 'performance'),
          { separator: true },
          chk('Minimap', 'minimap', 'M'),
        ],
      },
      {
        label: 'Zoom', submenu: [
          { label: 'Zoom out', onClick: zoomOut },
          { label: 'Next zoom area', disabled: !prevXf.current, onClick: nextZoom },
        ],
      },
      { label: 'Auto-arrange modules', onClick: () => editGraph(slotId, 'Auto-arrange modules', (dg) => autoArrange(dg, Math.max(vw, ws.w), Math.max(vh, ws.h))) },
      { label: 'Hide all plugin windows', onClick: hideEditors },
      { header: true, label: 'Visual' },
      chk('Remember tab sizes', 'rememberTabs'),
      chk('Hide all plugin windows on close', 'hideOnClose'),
      chk('Show info inside modules', 'infoInside'),
      { header: true, label: 'Processing' },
      chk('Link velocity', 'linkVelocity'),
      chk('Multithread plugins on this map', 'multithread'),
      { separator: true },
      { label: 'About', submenu: [{ label: 'Patcher v0', disabled: true }] },
    ], { minWidth: 210 });
  };

  if (menuRef) menuRef.current = (cx, cy) => rootMenu(cx, cy);

  /**
   * From FL Studio > Outputs > Events: "Notes" (the slot's MIDI input port) and
   * the "Port p" outputs to activate (FL: notes of a MIDI Out channel on port p).
   */
  const inEventsMenu = (): MenuItem[] => {
    const on = inPorts(g);
    const used = new Set(g.links.filter((l) => l.from === IN && l.kind === 'events' && l.fromPort > 0).map((l) => l.fromPort - 1));
    const setPorts = (ports: number[]) => editGraph(slotId, 'From FL Studio outputs', (dg) => {
      const keep = [...new Set([...ports, ...used])].filter((q) => q >= 0 && q <= 255).sort((a, b) => a - b);
      if (keep.length) dg.io.in.ports = keep; else delete dg.io.in.ports;
    });
    const byPort = new Map<number, string[]>();
    for (const c of store.project.channels) {
      if (c.kind !== 'midiout' || !c.midiOut) continue;
      byPort.set(c.midiOut.port, [...(byPort.get(c.midiOut.port) ?? []), c.name]);
    }
    const list = [...new Set([...byPort.keys(), ...on])].sort((a, b) => a - b);
    return [
      { label: portName(g, IN, 'events', 'out', 0), checked: true, disabled: true, hint: 'Notes on the slot\'s MIDI input port' },
      { separator: true },
      ...list.map((q): MenuItem => ({
        label: `${portName(g, IN, 'events', 'out', inPortOut(q))}${byPort.has(q) ? ` (${byPort.get(q)!.join(', ')})` : ''}`,
        checked: on.includes(q), disabled: used.has(q),
        onClick: () => setPorts(on.includes(q) ? on.filter((x) => x !== q) : [...on, q]),
      })),
      ...(list.length ? [{ separator: true } as MenuItem] : []),
      {
        label: 'Other port...', onClick: () => {
          const t = prompt('MIDI port (0..255)', '');
          const k = t === null ? NaN : parseInt(t, 10);
          if (Number.isFinite(k) && k >= 0 && k <= 255) setPorts([...on, k]);
        },
      },
    ];
  };

  const outputsMenu = (id: string): MenuItem[] => {
    const p = nodePorts(g, id);
    const m = g.modules[id];
    if (!p) return [];
    const items: MenuItem[] = [];
    if (p.audioOut) items.push({ label: 'Audio', submenu: [{ label: portName(g, id, 'audio', 'out', 0), checked: true, disabled: true }] });
    if (id === IN) {
      items.push({ label: 'Events', submenu: inEventsMenu() });
      return items;
    }
    if (p.eventsOut) {
      const on = new Set(shownOuts(g, id, 'events'));
      const setOuts = (outs: number[]) => editGraph(slotId, 'Module outputs', (dg) => {
        const mm = dg.modules[id];
        if (!mm) return;
        const used = new Set(dg.links.filter((l) => l.from === id && l.kind === 'events').map((l) => l.fromPort));
        mm.outs = [...new Set([...outs, ...used])].sort((a, b) => a - b);
      });
      items.push({
        label: 'Events', submenu: [
          ...(p.eventsOut > 1 ? [
            { label: 'Activate all', onClick: () => setOuts(Array.from({ length: p.eventsOut }, (_, k) => k)) },
            { label: 'Deactivate all', onClick: () => setOuts([]) },
            { separator: true } as MenuItem,
          ] : []),
          ...Array.from({ length: p.eventsOut }, (_, k) => ({
            label: portName(g, id, 'events', 'out', k), checked: on.has(k), disabled: !m,
            onClick: () => setOuts(on.has(k) ? [...on].filter((q) => q !== k) : [...on, k]),
          } as MenuItem)),
        ],
      });
    }
    return items;
  };

  const inputsMenu = (id: string): MenuItem[] => {
    const p = nodePorts(g, id);
    if (!p) return [];
    const items: MenuItem[] = [];
    if (p.audioIn) items.push({ label: 'Audio', submenu: [{ label: portName(g, id, 'audio', 'in', 0), checked: true, disabled: true }] });
    if (p.eventsIn) items.push({ label: 'Events', submenu: [{ label: portName(g, id, 'events', 'in', 0), checked: true, disabled: true }] });
    items.push({ label: 'Parameters', disabled: true });
    return items;
  };

  const nodeMenu = (id: string, cx: number, cy: number) => {
    const m = g.modules[id];
    if (!m) {
      openMenu(cx, cy, [
        { header: true, label: id === IN ? IN_NAME : OUT_NAME },
        { label: 'Disconnect', onClick: () => editGraph(slotId, 'Disconnect', (dg) => disconnectNode(dg, id)) },
        ...(id === IN ? [{ label: 'Outputs', submenu: outputsMenu(id) }] : [{ label: 'Inputs', submenu: inputsMenu(id) }]),
      ]);
      return;
    }
    openMenu(cx, cy, [
      { label: 'Rename...', shortcut: m.name, onClick: () => { const n = prompt('Module name', m.name); if (n) editGraph(slotId, 'Rename module', (dg) => { const mm = dg.modules[id]; if (mm) mm.name = n; }); } },
      { label: 'Save preset as...', disabled: true },
      { separator: true },
      { label: 'Disconnect', onClick: () => editGraph(slotId, 'Disconnect', (dg) => disconnectNode(dg, id)) },
      { label: 'Delete', shortcut: 'Del', onClick: () => deleteNodes(sel.has(id) ? [...sel] : [id]) },
      { separator: true },
      { label: 'Inputs', submenu: inputsMenu(id) },
      { label: 'Outputs', submenu: outputsMenu(id) },
      { separator: true },
      { label: 'Allow threaded processing', checked: m.threaded !== false, onClick: () => editGraph(slotId, 'Threaded processing', (dg) => { const mm = dg.modules[id]; if (mm) mm.threaded = mm.threaded === false; }) },
    ]);
  };

  // ----------------------------------------------------------- interaction
  const onPointerDown = (e: React.PointerEvent) => {
    ref.current?.focus({ preventScroll: true });
    const p = local(e);
    mouse.current = p;
    if (p.x > vw || p.y > vh) return; // scrollbars handle themselves
    const el = e.currentTarget as HTMLElement;
    if (e.button === 1) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      setDrag({ kind: 'pan', x0: p.x, y0: p.y, ox: cxf.ox, oy: cxf.oy });
      return;
    }
    if (e.button === 2) {
      if (e.ctrlKey) { el.setPointerCapture(e.pointerId); setDrag({ kind: 'zoomrect', x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }
      return;
    }
    if (e.button !== 0) return;
    // level handle of the link under the pointer
    const under = portAt(p.x, p.y) ? null : linkAt(p.x, p.y);
    if (under) {
      const l = g.links.find((q) => q.id === under);
      const c = l ? linkCurve(l) : null;
      if (l && c && l.kind === 'audio' && Math.hypot(p.x - c.mx, p.y - c.my) <= 13 * Math.max(1, zn)) {
        el.setPointerCapture(e.pointerId);
        setDrag({ kind: 'level', link: l.id, y0: p.y, level0: l.level, level: l.level });
        setHint(`Level: ${levelText(l.level)}`);
        return;
      }
    }
    const port = portAt(p.x, p.y);
    if (port) {
      el.setPointerCapture(e.pointerId);
      if (port.dir === 'out') { setDrag({ kind: 'cable', from: port, x: p.x, y: p.y, reverse: false }); return; }
      const into = g.links.filter((l) => l.to === port.node && l.toPort === port.port && l.kind === port.kind);
      const pick = into[into.length - 1];
      if (pick) {
        setDrag({ kind: 'cable', from: { node: pick.from, kind: pick.kind, dir: 'out', port: pick.fromPort }, x: p.x, y: p.y, pick, reverse: false });
      } else {
        setDrag({ kind: 'cable', from: port, x: p.x, y: p.y, reverse: true });
      }
      return;
    }
    const id = nodeAt(p.x, p.y);
    if (id) {
      if (e.altKey && g.modules[id]) { openEditor(id, true); return; }
      const additive = e.ctrlKey || e.shiftKey || e.metaKey;
      let next = sel;
      if (additive) { next = new Set(sel); if (next.has(id)) next.delete(id); else next.add(id); }
      else if (!sel.has(id)) next = new Set([id]);
      setSel(next);
      el.setPointerCapture(e.pointerId);
      const ids = [...next].filter((q) => q === id || next.has(q));
      setDrag({ kind: 'move', ids: ids.length ? ids : [id], x0: p.x, y0: p.y, dx: 0, dy: 0, moved: false });
      return;
    }
    el.setPointerCapture(e.pointerId);
    setDrag({ kind: 'band', x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.ctrlKey || e.shiftKey || e.metaKey });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    mouse.current = p;
    const d = dragRef.current;
    if (!d) {
      hover(p.x, p.y);
      return;
    }
    switch (d.kind) {
      case 'pan':
        setXf({ ...cxf, ox: d.ox - (p.x - d.x0) / cxf.zx, oy: d.oy - (p.y - d.y0) / cxf.zy });
        break;
      case 'move': {
        const dx = (p.x - d.x0) / cxf.zx, dy = (p.y - d.y0) / cxf.zy;
        setDrag({ ...d, dx, dy, moved: d.moved || Math.hypot(p.x - d.x0, p.y - d.y0) > 2 });
        break;
      }
      case 'cable': {
        setDrag({ ...d, x: p.x, y: p.y });
        const t = portAt(p.x, p.y);
        if (t && compatible(d.reverse ? t : d.from, d.reverse ? d.from : t)) setHint(`Link to ${portName(g, t.node, t.kind, t.dir, t.port)} (${t.node === IN ? IN_NAME : t.node === OUT ? OUT_NAME : g.modules[t.node]?.name ?? ''})`);
        else clearHint();
        break;
      }
      case 'band': case 'zoomrect':
        setDrag({ ...d, x1: p.x, y1: p.y });
        break;
      case 'level': {
        const k = e.shiftKey || e.ctrlKey ? 0.1 : 1;
        const level = Math.min(LINK_MAX, Math.max(0, d.level0 + ((d.y0 - p.y) / 120) * k));
        setDrag({ ...d, level });
        setHint(`Level: ${levelText(level)}`);
        break;
      }
      case 'minimap':
        setXf({ ...cxf, ox: d.ox + (p.x - d.x0) / d.k, oy: d.oy + (p.y - d.y0) / d.k });
        break;
      case 'scroll':
        if (d.axis === 'x') setXf({ ...cxf, ox: d.o0 + (p.x - d.p0) * d.k });
        else setXf({ ...cxf, oy: d.o0 + (p.y - d.p0) * d.k });
        break;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    const p = local(e);
    if (d.kind !== 'cable') setHoverLink(linkAt(p.x, p.y));
    switch (d.kind) {
      case 'move': {
        const fdx = (p.x - d.x0) / cxf.zx, fdy = (p.y - d.y0) / cxf.zy;
        if (d.moved || Math.hypot(p.x - d.x0, p.y - d.y0) > 2) {
          const w = workspace(g, vw, vh);
          editGraph(slotId, d.ids.length > 1 ? 'Move modules' : 'Move module', (dg) => {
            for (const id of d.ids) {
              const c = id === IN ? dg.io.in : id === OUT ? dg.io.out : dg.modules[id];
              if (!c) continue;
              const b = nodeBox(g, id);
              c.x = Math.max(b.w / 2 + 14, Math.min(w.w + 400, c.x + fdx));
              c.y = Math.max(b.h / 2 + 10, Math.min(w.h + 300, c.y + fdy));
            }
          });
        }
        break;
      }
      case 'cable': {
        const t = portAt(p.x, p.y);
        if (t) {
          if (compatible(d.reverse ? t : d.from, d.reverse ? d.from : t) || (d.pick && t.node === d.pick.to && t.port === d.pick.toPort && t.kind === d.pick.kind)) {
            link(d.from, t, d.pick);
          } else if (d.pick) {
            editGraph(slotId, 'Unlink', (dg) => disconnect(dg, d.pick!.id));
          } else {
            const o = d.reverse ? t : d.from, i = d.reverse ? d.from : t;
            const err = o.kind !== i.kind ? 'Audio and event ports cannot be linked' : o.dir === i.dir ? 'Link an output to an input'
              : connectError(g, o.kind, o.node, o.port, i.node, i.port);
            flashHint(err ?? 'These ports cannot be linked');
          }
          break;
        }
        const n = nodeAt(p.x, p.y);
        if (n && n !== d.from.node) { dropOnNode(n, d.from, d.pick, e.clientX, e.clientY); break; }
        if (d.pick && n !== d.from.node) editGraph(slotId, 'Unlink', (dg) => disconnect(dg, d.pick!.id));
        break;
      }
      case 'band': {
        const x0 = Math.min(d.x0, p.x), x1 = Math.max(d.x0, p.x), y0 = Math.min(d.y0, p.y), y1 = Math.max(d.y0, p.y);
        const next = d.add ? new Set(sel) : new Set<string>();
        if (x1 - x0 < 3 && y1 - y0 < 3) { if (!d.add) setSel(next); break; }
        for (const id of [IN, OUT, ...g.order]) {
          const c = centreOf(id);
          if (!c) continue;
          const b = nodeBox(g, id);
          if (c.x + (b.w / 2) * zn >= x0 && c.x - (b.w / 2) * zn <= x1 && c.y + (b.h / 2) * zn >= y0 && c.y - (b.h / 2) * zn <= y1) next.add(id);
        }
        setSel(next);
        break;
      }
      case 'level': {
        const k = e.shiftKey || e.ctrlKey ? 0.1 : 1;
        const level = Math.min(LINK_MAX, Math.max(0, d.level0 + ((d.y0 - p.y) / 120) * k));
        if (level !== d.level0) editGraph(slotId, 'Link level', (dg) => { const l = dg.links.find((q) => q.id === d.link); if (l) l.level = level; }, `ptc-level:${slotId}:${d.link}`);
        break;
      }
      case 'zoomrect': {
        const x0 = Math.min(d.x0, p.x), x1 = Math.max(d.x0, p.x), y0 = Math.min(d.y0, p.y), y1 = Math.max(d.y0, p.y);
        if (x1 - x0 > 8 && y1 - y0 > 8) {
          prevXf.current = cxf;
          const a = toMap(cxf, x0, y0), b = toMap(cxf, x1, y1);
          const z = Math.min(vw / (b.x - a.x), vh / (b.y - a.y));
          setXf({ zx: z, zy: z, ox: a.x, oy: a.y });
        } else if (prevXf.current) nextZoom();
        break;
      }
      default:
        break;
    }
  };

  const linkCurve = (l: PatcherLink) => {
    const a = findPort(ports, { node: l.from, kind: l.kind, dir: 'out', port: l.fromPort });
    const b = findPort(ports, { node: l.to, kind: l.kind, dir: 'in', port: l.toPort });
    if (!a || !b) return null;
    return cable(a.x, a.y, b.x, b.y, zn);
  };

  /** The link whose middle arrow is under a point. */
  const linkAt = (x: number, y: number): string | null => {
    let best: string | null = null, bd = 16 * Math.max(1, zn);
    for (const l of g.links) {
      if ((l.kind === 'audio' && !view.audio) || (l.kind === 'events' && !view.events)) continue;
      const c = linkCurve(l);
      if (!c) continue;
      const dd = Math.hypot(c.mx - x, c.my - y);
      if (dd < bd) { bd = dd; best = l.id; }
    }
    return best;
  };

  const hover = (x: number, y: number) => {
    const port = portAt(x, y);
    if (port) {
      const nm = port.node === IN ? IN_NAME : port.node === OUT ? OUT_NAME : g.modules[port.node]?.name ?? '';
      setHint(`${nm} - ${portName(g, port.node, port.kind, port.dir, port.port)}`);
      if (hoverLink) setHoverLink(null);
      return;
    }
    const best = linkAt(x, y);
    if (best !== hoverLink) setHoverLink(best);
    if (best) {
      const l = g.links.find((q) => q.id === best)!;
      setHint(l.kind === 'audio' ? `Audio link - level ${levelText(l.level)}${l.mute ? ' (muted)' : ''} - drag the arrow to change, right-click to ${l.mute ? 'unmute' : 'mute'}` : 'Event link');
      return;
    }
    const id = nodeAt(x, y);
    if (id) setHint(g.modules[id] ? `${g.modules[id].name} - double-click to open, right-click for options` : id === IN ? IN_NAME : OUT_NAME);
    else clearHint();
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (e.ctrlKey) return; // zoom region gesture
    const p = local(e);
    if (p.x > vw || p.y > vh) return;
    const under = portAt(p.x, p.y) ? null : linkAt(p.x, p.y);
    if (under) {
      const l = g.links.find((q) => q.id === under);
      if (l && l.kind === 'audio') {
        editGraph(slotId, l.mute ? 'Unmute link' : 'Mute link', (dg) => { const q = dg.links.find((k) => k.id === l.id); if (q) q.mute = !q.mute; });
        return;
      }
    }
    const port = portAt(p.x, p.y);
    const id = port?.node ?? nodeAt(p.x, p.y);
    if (id) { nodeMenu(id, e.clientX, e.clientY); return; }
    rootMenu(e.clientX, e.clientY, toMap(cxf, p.x, p.y));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = local(e);
    const id = nodeAt(p.x, p.y);
    if (id && g.modules[id]) { openEditor(id, false); return; }
    if (id === IN || id === OUT) {
      const n = prompt('Name', id === IN ? IN_NAME : OUT_NAME);
      void n; // FL's I/O nodes keep their names
      return;
    }
    if (!id && !portAt(p.x, p.y)) {
      // zoom out temporarily / return
      const f = fit();
      if (Math.abs(cxf.zx - f.zx) < 1e-3 && Math.abs(cxf.zy - f.zy) < 1e-3) { if (prevXf.current) nextZoom(); }
      else zoomOut();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = local(e);
    const dir = e.deltaY > 0 ? 1 : -1;
    const k = Math.pow(1.15, -dir);
    const at = toMap(cxf, p.x, p.y);
    if (e.ctrlKey || e.altKey || e.shiftKey) {
      const zx = e.ctrlKey && !e.shiftKey ? cxf.zx : cxf.zx * k;
      const zy = e.altKey && !e.shiftKey ? cxf.zy : cxf.zy * k;
      const t = clampXf({ zx, zy, ox: 0, oy: 0 });
      setXf({ zx: t.zx, zy: t.zy, ox: at.x - p.x / t.zx, oy: at.y - p.y / t.zy });
      return;
    }
    const spanY = vh / cxf.zy;
    if (spanY < ws.h) setXf({ ...cxf, oy: cxf.oy + (e.deltaY / cxf.zy) * 0.6 });
    else if (vw / cxf.zx < ws.w) setXf({ ...cxf, ox: cxf.ox + (e.deltaY / cxf.zx) * 0.6 });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); e.stopPropagation(); deleteNodes([...sel]); return; }
    if (e.ctrlKey || e.metaKey) return;
    if (k === 'm' || k === 'M') {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) setView({ minimap: true, minimapSize: (view.minimapSize + 1) % 3 });
      else setView({ minimap: !view.minimap });
      return;
    }
    if (view.minimap && /^[1-4]$/.test(k)) { e.preventDefault(); e.stopPropagation(); setView({ minimapPos: [0, 1, 2, 3][Number(k) - 1] }); return; }
    if (k === 'F8') {
      e.preventDefault(); e.stopPropagation();
      const r = ref.current!.getBoundingClientRect();
      const s = r.width / width;
      rootMenuAddOnly(r.left + mouse.current.x * s, r.top + mouse.current.y * s);
      return;
    }
    if (k === 'Escape') setSel(new Set());
  };

  const rootMenuAddOnly = (cx: number, cy: number) => {
    const pos = toMap(cxf, mouse.current.x, mouse.current.y);
    openMenu(cx, cy, pickerItems(pos), { minWidth: 150 });
  };

  // a link deleted / a module removed: drop stale selection
  useEffect(() => {
    setSel((s) => {
      let changed = false;
      const n = new Set<string>();
      for (const id of s) if (id === IN || id === OUT || g.modules[id]) n.add(id); else changed = true;
      return changed ? n : s;
    });
  }, [g.modules]);

  // ---------------------------------------------------------------- render
  const active = (id: string) => (activity?.peaks.get(id) ?? 0) > 1e-4;
  const cables: React.ReactNode[] = [];
  for (const l of g.links) {
    if ((l.kind === 'audio' && !view.audio) || (l.kind === 'events' && !view.events)) continue;
    if (drag?.kind === 'cable' && drag.pick?.id === l.id) continue;
    const c = linkCurve(l);
    if (!c) continue;
    const col = COLORS[l.kind].cable;
    const level = drag?.kind === 'level' && drag.link === l.id ? drag.level : l.level;
    const hot = hoverLink === l.id || (drag?.kind === 'level' && drag.link === l.id);
    const a = 9 * Math.max(0.6, zn), b = 4.5 * Math.max(0.6, zn);
    const tip = { x: c.mx + c.tx * a * 0.55, y: c.my + c.ty * a * 0.55 };
    const back = { x: c.mx - c.tx * a * 0.45, y: c.my - c.ty * a * 0.45 };
    const arrow = `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)} L${(back.x - c.ty * b).toFixed(1)} ${(back.y + c.tx * b).toFixed(1)} L${(back.x + c.ty * b).toFixed(1)} ${(back.y - c.tx * b).toFixed(1)} Z`;
    const flowing = view.activity && !l.mute && active(l.from);
    cables.push(
      <g key={l.id} opacity={l.mute ? 0.35 : 1}>
        <path d={c.d} stroke="rgba(0,0,0,0.22)" strokeWidth={Math.max(2, 3.4 * zn)} fill="none" transform="translate(0.6 1)" />
        <path d={c.d} stroke={col} strokeWidth={Math.max(1.2, (hot ? 2.6 : 2) * zn)} fill="none" strokeDasharray={l.mute ? `${5 * zn} ${4 * zn}` : undefined} />
        {flowing && <path className="ptc-flow" d={c.d} stroke="#fff" strokeOpacity={0.55} strokeWidth={Math.max(1, 1.4 * zn)} fill="none" strokeDasharray={`${2 * zn} ${14 * zn}`} />}
        <path d={arrow} fill={col} />
        {hot && l.kind === 'audio' && (
          <g>
            <circle cx={c.mx} cy={c.my} r={11 * Math.max(0.8, zn)} fill="none" stroke={col} strokeOpacity={0.45} strokeWidth={1.2} />
            <path d={ringArc(c.mx, c.my, 11 * Math.max(0.8, zn), level / LINK_MAX)} fill="none" stroke={col} strokeWidth={4 * Math.max(0.8, zn)} strokeLinecap="round" />
          </g>
        )}
      </g>,
    );
  }
  let dragCable: React.ReactNode = null;
  if (drag?.kind === 'cable') {
    const a = findPort(ports, drag.from);
    if (a) {
      const c = drag.reverse ? cable(drag.x, drag.y, a.x, a.y, zn) : cable(a.x, a.y, drag.x, drag.y, zn);
      dragCable = <path d={c.d} stroke={COLORS[drag.from.kind].cable} strokeWidth={Math.max(1.2, 2 * zn)} fill="none" opacity={0.9} />;
    }
  }
  const lit = (p: PortPos): boolean => {
    if (drag?.kind !== 'cable') return false;
    if (drag.pick && p.node === drag.pick.to && p.port === drag.pick.toPort && p.kind === drag.pick.kind && p.dir === 'in') return true;
    return compatible(drag.reverse ? p : drag.from, drag.reverse ? drag.from : p);
  };

  const sb = scrollbars(cxf, vw, vh, ws);
  const mini = view.minimap ? minimapGeom(view.minimapSize, view.minimapPos, vw, vh, ws) : null;

  return (
    <div ref={ref} className="ptc-map" tabIndex={0} style={{ width, height }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => { if (!drag) { clearHint(); if (hoverLink) setHoverLink(null); } }}
      onContextMenu={onContextMenu} onDoubleClick={onDoubleClick} onWheel={onWheel} onKeyDown={onKeyDown}>
      <div className="ptc-view" style={{ width: vw, height: vh }}>
        <svg className="ptc-layer" width={vw} height={vh}>{cables}</svg>
        {g.order.map((id) => {
          const m = g.modules[id];
          if (!m) return null;
          const c = centreOf(id)!;
          return <ModuleNode key={id} slotId={slotId} m={m} trackName={trackName} x={c.x} y={c.y} zn={zn}
            selected={sel.has(id)} labels={view.labels} latency={view.latency || view.performance ? activity : null} showLat={view.latency} showPerf={view.performance} inside={view.infoInside} />;
        })}
        {[IN, OUT].map((id) => {
          const c = centreOf(id)!;
          return (
            <div key={id} className={'ptc-io' + (sel.has(id) ? ' sel' : '')} style={{ left: c.x - 23 * zn, top: c.y - 20 * zn, width: 46 * zn, height: 40 * zn }}>
              {id === IN ? <FromIcon size={zn} /> : <ToIcon size={zn} />}
              {view.labels && <div className="ptc-label" style={{ top: 40 * zn + 3 * zn, fontSize: 13 * zn }}>{id === IN ? IN_NAME : OUT_NAME}</div>}
            </div>
          );
        })}
        <svg className="ptc-layer ptc-top" width={vw} height={vh}>
          {ports.map((p) => {
            const on = connected.has(`${p.node}|${p.kind}|${p.dir}|${p.port}`);
            const col = COLORS[p.kind];
            const r = PORT_R * Math.max(0.7, Math.min(1.4, zn));
            return (
              <g key={`${p.node}|${p.kind}|${p.dir}|${p.port}`}>
                {lit(p) && <circle cx={p.x} cy={p.y} r={r + 3.5} fill="none" stroke="#5dff6a" strokeWidth={2.2} />}
                <circle cx={p.x} cy={p.y} r={r} fill={on ? col.on : col.off} stroke="#000" strokeWidth={1.1} />
              </g>
            );
          })}
          {dragCable}
          {drag?.kind === 'band' && (
            <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)}
              fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.55)" strokeDasharray="3 3" />
          )}
          {drag?.kind === 'zoomrect' && (
            <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)}
              fill="rgba(255,181,71,0.18)" stroke="#ffb547" />
          )}
        </svg>
        {view.performance && <PerfPanel g={g} />}
        {mini && (
          <Minimap g={g} geom={mini} xf={cxf} vw={vw} vh={vh} ws={ws}
            onDown={(e, inView) => {
              e.stopPropagation();
              const p = local(e);
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const k = mini.s;
              if (inView) { ref.current?.setPointerCapture(e.pointerId); setDrag({ kind: 'minimap', x0: p.x, y0: p.y, ox: cxf.ox, oy: cxf.oy, k }); }
              else {
                const mx = (p.x - mini.x - mini.ix) / k, my = (p.y - mini.y - mini.iy) / k;
                setXf({ ...cxf, ox: mx - vw / cxf.zx / 2, oy: my - vh / cxf.zy / 2 });
              }
            }}
            onMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, minimapItems(view, setView)); }} />
        )}
      </div>
      {/* scrollbars */}
      <div className="ptc-sb v" style={{ left: vw, top: 0, width: SB, height: vh }}>
        <div className="ptc-sb-arrow up" onPointerDown={(e) => { e.stopPropagation(); setXf({ ...cxf, oy: cxf.oy - 40 / cxf.zy }); }} />
        <div className="ptc-sb-thumb" style={{ top: sb.vy, height: sb.vh }}
          onPointerDown={(e) => { e.stopPropagation(); ref.current?.setPointerCapture(e.pointerId); setDrag({ kind: 'scroll', axis: 'y', p0: local(e).y, o0: cxf.oy, k: ws.h / sb.track }); }} />
        <div className="ptc-sb-arrow down" onPointerDown={(e) => { e.stopPropagation(); setXf({ ...cxf, oy: cxf.oy + 40 / cxf.zy }); }} />
      </div>
      <div className="ptc-sb h" style={{ left: 0, top: vh, width: vw, height: SB }}>
        <div className="ptc-sb-arrow left" onPointerDown={(e) => { e.stopPropagation(); setXf({ ...cxf, ox: cxf.ox - 40 / cxf.zx }); }} />
        <div className="ptc-sb-thumb" style={{ left: sb.hx, width: sb.hw }}
          onPointerDown={(e) => { e.stopPropagation(); ref.current?.setPointerCapture(e.pointerId); setDrag({ kind: 'scroll', axis: 'x', p0: local(e).x, o0: cxf.ox, k: ws.w / sb.trackX }); }} />
        <div className="ptc-sb-arrow right" onPointerDown={(e) => { e.stopPropagation(); setXf({ ...cxf, ox: cxf.ox + 40 / cxf.zx }); }} />
      </div>
      <div className="ptc-sb-corner" style={{ left: vw, top: vh, width: SB, height: SB }} />
    </div>
  );
}

function ringArc(cx: number, cy: number, r: number, f: number): string {
  const t = Math.min(1, Math.max(0, f));
  if (t < 0.005) return '';
  const a0 = (135 * Math.PI) / 180, a1 = a0 + t * 1.5 * Math.PI;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${t * 270 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function minimapItems(view: PatcherGraph['view'], setView: (p: Partial<PatcherGraph['view']>) => void): MenuItem[] {
  return [
    { label: 'Minimap', shortcut: 'M', checked: view.minimap, onClick: () => setView({ minimap: !view.minimap }) },
    { header: true, label: 'Size' },
    ...['Tiny', 'Medium', 'Large'].map((s, i) => ({ label: s, radio: true, checked: view.minimapSize === i, onClick: () => setView({ minimap: true, minimapSize: i }) } as MenuItem)),
    { header: true, label: 'Position' },
    ...[['Top Left', 0, '1'], ['Top Right', 1, '2'], ['Bottom Right', 2, '3'], ['Bottom Left', 3, '4']].map(([s, i, k]) => ({
      label: s as string, shortcut: k as string, radio: true, checked: view.minimapPos === i, onClick: () => setView({ minimap: true, minimapPos: i as number }),
    } as MenuItem)),
  ];
}

function scrollbars(xf: Xf, vw: number, vh: number, ws: { w: number; h: number }) {
  const track = vh - 2 * SB, trackX = vw - 2 * SB;
  const fy = Math.min(1, vh / xf.zy / ws.h), fx = Math.min(1, vw / xf.zx / ws.w);
  const vhh = Math.max(16, track * fy), hw = Math.max(16, trackX * fx);
  const vy = SB + (fy >= 1 ? 0 : (Math.max(0, xf.oy) / (ws.h - vh / xf.zy)) * (track - vhh));
  const hx = SB + (fx >= 1 ? 0 : (Math.max(0, xf.ox) / (ws.w - vw / xf.zx)) * (trackX - hw));
  return { vy, vh: vhh, hx, hw, track, trackX };
}

interface MiniGeom { x: number; y: number; w: number; h: number; s: number; ix: number; iy: number }

function minimapGeom(size: number, pos: number, vw: number, vh: number, ws: { w: number; h: number }): MiniGeom {
  const box = MINIMAP_SIZES[Math.min(2, Math.max(0, size))];
  const m = 10;
  const x = pos === 0 || pos === 3 ? m : vw - box.w - m;
  const y = pos === 0 || pos === 1 ? m : vh - box.h - m;
  const s = Math.min((box.w - 8) / ws.w, (box.h - 8) / ws.h);
  return { x, y, w: box.w, h: box.h, s, ix: (box.w - ws.w * s) / 2, iy: (box.h - ws.h * s) / 2 };
}

function Minimap({ g, geom, xf, vw, vh, ws, onDown, onMenu }: {
  g: PatcherGraph; geom: MiniGeom; xf: Xf; vw: number; vh: number; ws: { w: number; h: number };
  onDown: (e: React.PointerEvent, inView: boolean) => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const s = geom.s;
  const rect = (x: number, y: number, w: number, h: number, cls: string, key: string) => (
    <div key={key} className={cls} style={{ left: geom.ix + (x - w / 2) * s, top: geom.iy + (y - h / 2) * s, width: Math.max(3, w * s), height: Math.max(2, h * s) }} />
  );
  const vx = geom.ix + Math.max(0, xf.ox) * s, vy = geom.iy + Math.max(0, xf.oy) * s;
  const vwm = Math.min(ws.w, vw / xf.zx) * s, vhm = Math.min(ws.h, vh / xf.zy) * s;
  return (
    <div className="ptc-mini" style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h }}
      onPointerDown={(e) => { if (e.button === 0) onDown(e, false); else e.stopPropagation(); }}
      onContextMenu={onMenu} onPointerEnter={() => setHint('Minimap - drag the view area, right-click for options')} onPointerLeave={clearHint}>
      {rect(g.io.in.x, g.io.in.y, 46, 22, 'ptc-mini-io', 'in')}
      {rect(g.io.out.x, g.io.out.y, 46, 22, 'ptc-mini-io', 'out')}
      {g.order.map((id) => {
        const m = g.modules[id];
        if (!m) return null;
        const b = nodeBox(g, id);
        return rect(m.x, m.y, b.w, b.h, 'ptc-mini-node', id);
      })}
      <div className="ptc-mini-view" style={{ left: vx, top: vy, width: vwm, height: vhm }}
        onPointerDown={(e) => { if (e.button === 0) onDown(e, true); }} />
    </div>
  );
}

function PerfPanel({ g }: { g: PatcherGraph }) {
  return (
    <div className="ptc-perf">
      <div><b>Total</b><span>-</span></div>
      <div>Patcher<span>-</span></div>
      <div>Modules ({Object.keys(g.modules).length})<span>-</span></div>
      <div>Other<span>-</span></div>
    </div>
  );
}

const ModuleNode = memo(function ModuleNode({ slotId, m, trackName, x, y, zn, selected, labels, latency, showLat, showPerf, inside }: {
  slotId: string; m: PatcherModule; trackName: string; x: number; y: number; zn: number; selected: boolean; labels: boolean;
  latency: Activity | null; showLat: boolean; showPerf: boolean; inside: boolean;
}) {
  const ic = iconSize(m.plugin, isGenModule(m.id));
  const w = ic.w * zn, h = ic.h * zn;
  const lat = latency?.lat.get(m.id) ?? 0;
  const info: string[] = [];
  if (showLat) info.push(`${((lat / (latency?.sr || 48000)) * 1000).toFixed(1)} ms`);
  if (showPerf) info.push('CPU -');
  return (
    <div className="ptc-node-wrap" style={{ left: x - w / 2, top: y - h / 2, width: w, height: h }}>
      <div className={'ptc-node' + (selected ? ' sel' : '')} style={{ width: ic.w, height: ic.h, transform: `scale(${zn})` }}>
        <Thumbnail slotId={slotId} m={m} trackName={trackName} />
        {info.length > 0 && inside && <div className="ptc-info inside">{info.join('  ')}</div>}
      </div>
      {info.length > 0 && !inside && <div className="ptc-info" style={{ bottom: h + 3 * zn, fontSize: 10.5 * Math.max(0.8, zn) }}>{info.join('  ')}</div>}
      {labels && <div className="ptc-label" style={{ top: h + 4 * zn, fontSize: 13 * zn }}>{m.name}</div>}
    </div>
  );
});
