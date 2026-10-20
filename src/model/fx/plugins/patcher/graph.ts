// Patcher's graph (FL: Patcher, "Map" tab): hosted modules (effect plugins
// with their own state), FL's "From FL Studio" / "To FL Studio" nodes and the
// links between them. Pure functions shared by the engine (processing order,
// latency compensation) and the editor (editing operations, cycle checks).
//
// Node ids: 'in' (From FL Studio), 'out' (To FL Studio) and module ids
// ('m1', 'm2', ...). Links are 'audio' (stereo, yellow) or 'events' (notes,
// green). An input port sums every link into it and an output port fans out.
// From FL Studio's event outputs: 0 = "Notes" (the slot's MIDI input port)
// and 1 + p = "Port p" (MIDI port p, activated from the node's Outputs menu,
// as in FL: "Outputs > Events > Port 5"). Effects that take notes (Pitcher,
// Vocodex, Gross Beat) have a "Notes" event input.

export const GRAPH_KEY = '$graph';
export const IN = 'in';
export const OUT = 'out';

/** FL's I/O node captions. */
export const IN_NAME = 'From FL Studio';
export const OUT_NAME = 'To FL Studio';

/** Link level range (linear gain; 1 = unity). */
export const LINK_MAX = 1.25;

export type LinkKind = 'audio' | 'events';

export interface PatcherModule {
  id: string;
  /** Effect plugin id (FX registry). */
  plugin: string;
  /** Label shown under the node (module menu > Rename). */
  name: string;
  /** Centre of the node icon in map units. */
  x: number;
  y: number;
  /** The module's own plugin state (what a mixer slot would hold in FxSlot.params). */
  params: Record<string, unknown>;
  /** Activated event output ports (VFX voice outputs), 0-based. */
  outs?: number[];
  /** Module menu switches (no audible effect in this clone). */
  threaded?: boolean;
  compatLevels?: boolean;
}

export interface PatcherLink {
  id: string;
  kind: LinkKind;
  from: string;
  fromPort: number;
  to: string;
  toPort: number;
  /** Audio level, linear gain 0..LINK_MAX (dragging the cable's centre arrow). */
  level: number;
  /** Right-click on an audio link mutes it. */
  mute: boolean;
}

export interface PatcherView {
  /** Data link filters (the Audio / Parameters / Events check boxes). */
  audio: boolean;
  params: boolean;
  events: boolean;
  /** View menu. */
  activity: boolean;
  labels: boolean;
  latency: boolean;
  performance: boolean;
  /** Minimap: shown, size (0 tiny, 1 medium, 2 large), corner (0 TL, 1 TR, 2 BR, 3 BL). */
  minimap: boolean;
  minimapSize: number;
  minimapPos: number;
  /** Options. */
  infoInside: boolean;
  rememberTabs: boolean;
  hideOnClose: boolean;
  linkVelocity: boolean;
  multithread: boolean;
  /** Visible tab: 0 Map, 1 Surface. */
  tab: number;
}

export interface PatcherGraph {
  version: 1;
  modules: Record<string, PatcherModule>;
  /** Module ids in creation / z order (processing tie-break). */
  order: string[];
  links: PatcherLink[];
  /** I/O node positions; `in.ports` = MIDI ports activated as From FL Studio event outputs ("Port p"). */
  io: { in: { x: number; y: number; ports?: number[] }; out: { x: number; y: number } };
  /**
   * The module whose editor window was used last: Patcher's monitor() returns
   * its display data (meters). Editing itself does not depend on it.
   */
  focus: string | null;
  /** Id counter for modules and links. */
  next: number;
  view: PatcherView;
}

export function defaultView(): PatcherView {
  return {
    audio: true, params: true, events: true,
    activity: true, labels: true, latency: false, performance: false,
    minimap: false, minimapSize: 1, minimapPos: 2,
    infoInside: false, rememberTabs: false, hideOnClose: false, linkVelocity: true, multithread: true,
    tab: 0,
  };
}

/** A new Patcher: From FL Studio linked straight to To FL Studio (FL's Default preset). */
export function defaultGraph(): PatcherGraph {
  return {
    version: 1,
    modules: {},
    order: [],
    links: [{ id: 'l1', kind: 'audio', from: IN, fromPort: 0, to: OUT, toPort: 0, level: 1, mute: false }],
    io: { in: { x: 64, y: 240 }, out: { x: 920, y: 240 } },
    focus: null,
    next: 2,
    view: defaultView(),
  };
}

// ------------------------------------------------------------------ ports

/** VFX (voice effect) plugins: note processors with event ports and no audio ports. */
const EVENT_OUTS: Record<string, number> = {
  vfxcolormapper: 16, vfxenvelope: 1, vfxkeymapper: 1, vfxkeysplitter: 16,
  vfxlevelscaler: 1, vfxscript: 1, vfxsequencer: 1,
};

/** Event outputs a new module of this plugin shows (FL activates voice ports 1-4 on Color Mapper). */
const EVENT_OUTS_ACTIVE: Record<string, number> = { vfxcolormapper: 4, vfxkeysplitter: 4 };

/** Effects with a notes input (they take MIDI notes). */
const NOTE_INPUT = new Set(['pitcher', 'vocodex', 'grossbeat', 'patcher']);

/** From FL Studio's event outputs: "Notes" + one per MIDI port. */
export const IN_EVENT_OUTS = 1 + 256;

export function isEventModule(plugin: string): boolean {
  return plugin in EVENT_OUTS;
}

/** The effect takes notes on an event input. */
export function takesNotes(plugin: string): boolean {
  return NOTE_INPUT.has(plugin);
}

/** From FL Studio's event output for MIDI port p. */
export const inPortOut = (p: number): number => 1 + p;

/** The MIDI ports activated as From FL Studio event outputs. */
export function inPorts(g: PatcherGraph): number[] {
  return Array.isArray(g.io.in.ports) ? g.io.in.ports : [];
}

export interface NodePorts {
  audioIn: number;
  audioOut: number;
  eventsIn: number;
  eventsOut: number;
}

export function pluginPorts(plugin: string): NodePorts {
  if (isEventModule(plugin)) return { audioIn: 0, audioOut: 0, eventsIn: 1, eventsOut: EVENT_OUTS[plugin] };
  return { audioIn: 1, audioOut: 1, eventsIn: takesNotes(plugin) ? 1 : 0, eventsOut: 0 };
}

export function nodePorts(g: PatcherGraph, id: string): NodePorts | null {
  if (id === IN) return { audioIn: 0, audioOut: 1, eventsIn: 0, eventsOut: IN_EVENT_OUTS };
  if (id === OUT) return { audioIn: 1, audioOut: 0, eventsIn: 0, eventsOut: 0 };
  const m = g.modules[id];
  return m ? pluginPorts(m.plugin) : null;
}

export function defaultOuts(plugin: string): number[] | undefined {
  if (!isEventModule(plugin)) return undefined;
  const n = Math.min(EVENT_OUTS[plugin], EVENT_OUTS_ACTIVE[plugin] ?? 1);
  return Array.from({ length: n }, (_, i) => i);
}

/** Output ports shown on a node: connected ports are always shown. */
export function shownOuts(g: PatcherGraph, id: string, kind: LinkKind): number[] {
  const p = nodePorts(g, id);
  if (!p) return [];
  const n = kind === 'audio' ? p.audioOut : p.eventsOut;
  if (n === 0) return [];
  const m = g.modules[id];
  const set = new Set<number>(
    kind === 'events' && id === IN ? [0, ...inPorts(g).map(inPortOut)]
      : kind === 'events' && m ? m.outs ?? defaultOuts(m.plugin) ?? [0] : Array.from({ length: n }, (_, i) => i));
  for (const l of g.links) if (l.from === id && l.kind === kind) set.add(l.fromPort);
  return [...set].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
}

export function portName(g: PatcherGraph, id: string, kind: LinkKind, dir: 'in' | 'out', port: number): string {
  if (id === IN) return kind === 'audio' ? 'Audio input' : port === 0 ? 'Notes' : `Port ${port - 1}`;
  if (id === OUT) return 'Audio output';
  const m = g.modules[id];
  if (m && kind === 'events') {
    if (dir === 'in') return 'Notes';
    return EVENT_OUTS[m.plugin] > 1 ? `Voice output ${port + 1}` : 'Notes';
  }
  return dir === 'in' ? 'Audio input' : 'Audio output';
}

// ------------------------------------------------------------- structure

export function hasNode(g: PatcherGraph, id: string): boolean {
  return id === IN || id === OUT || !!g.modules[id];
}

/** True when `to` can already reach `from`, so a link from -> to would close a loop. */
export function wouldCycle(g: PatcherGraph, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([to]);
  const stack = [to];
  while (stack.length) {
    const n = stack.pop()!;
    for (const l of g.links) {
      if (l.from !== n) continue;
      if (l.to === from) return true;
      if (!seen.has(l.to)) { seen.add(l.to); stack.push(l.to); }
    }
  }
  return false;
}

/** Why a link cannot be made (null = it can). */
export function connectError(g: PatcherGraph, kind: LinkKind, from: string, fromPort: number, to: string, toPort: number): string | null {
  const a = nodePorts(g, from), b = nodePorts(g, to);
  if (!a || !b) return 'Unknown node';
  const outs = kind === 'audio' ? a.audioOut : a.eventsOut;
  const ins = kind === 'audio' ? b.audioIn : b.eventsIn;
  if (fromPort < 0 || fromPort >= outs) return 'No such output';
  if (toPort < 0 || toPort >= ins) return 'No such input';
  if (g.links.some((l) => l.kind === kind && l.from === from && l.fromPort === fromPort && l.to === to && l.toPort === toPort)) return 'Already linked';
  if (wouldCycle(g, from, to)) return 'Feedback loops are not allowed';
  return null;
}

/** Add a link (mutates `g`; works on immer drafts). Returns the link, or null when refused. */
export function connect(g: PatcherGraph, kind: LinkKind, from: string, fromPort: number, to: string, toPort: number): PatcherLink | null {
  if (connectError(g, kind, from, fromPort, to, toPort)) return null;
  const l: PatcherLink = { id: `l${g.next++}`, kind, from, fromPort, to, toPort, level: 1, mute: false };
  g.links.push(l);
  if (kind === 'events') {
    const m = g.modules[from];
    if (m && m.outs && !m.outs.includes(fromPort)) m.outs = [...m.outs, fromPort].sort((x, y) => x - y);
  }
  return l;
}

export function disconnect(g: PatcherGraph, linkId: string): void {
  const i = g.links.findIndex((l) => l.id === linkId);
  if (i >= 0) g.links.splice(i, 1);
}

/** Module menu > Disconnect: drop every link to and from a node. */
export function disconnectNode(g: PatcherGraph, id: string): void {
  for (let i = g.links.length - 1; i >= 0; i--) if (g.links[i].from === id || g.links[i].to === id) g.links.splice(i, 1);
}

export function addModule(g: PatcherGraph, plugin: string, params: Record<string, unknown>, x: number, y: number, name: string): PatcherModule {
  const id = `m${g.next++}`;
  const m: PatcherModule = { id, plugin, name, x, y, params };
  const outs = defaultOuts(plugin);
  if (outs) m.outs = outs;
  g.modules[id] = m;
  g.order.push(id);
  return m;
}

export function removeModules(g: PatcherGraph, ids: string[]): void {
  const drop = new Set(ids);
  for (const id of ids) delete g.modules[id];
  g.order = g.order.filter((id) => !drop.has(id));
  g.links = g.links.filter((l) => !drop.has(l.from) && !drop.has(l.to));
  if (g.focus && drop.has(g.focus)) g.focus = null;
}

/** A unique label for a new module ("Delay 3", "Delay 3 #2", ...). */
export function uniqueName(g: PatcherGraph, base: string): string {
  const names = new Set(Object.values(g.modules).map((m) => m.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} #${i}`)) return `${base} #${i}`;
}

// ------------------------------------------------------------ processing

export interface ProcessPlan {
  /** Modules in processing order (sources first). */
  order: string[];
  /** Audio links used for processing (no feedback edges), grouped by target node. */
  inputs: Map<string, PatcherLink[]>;
  /** Processing depth of each module (FL's multithreaded columns: same depth = same column). */
  depth: Map<string, number>;
}

/**
 * Topological processing order over every link (audio and events). Links are
 * refused when they would close a loop, so a stored graph is acyclic; a
 * corrupted graph still processes: a link from a module that comes later in
 * the order is ignored.
 */
export function processPlan(g: PatcherGraph): ProcessPlan {
  const ids = g.order.filter((id) => g.modules[id]);
  for (const id of Object.keys(g.modules)) if (!ids.includes(id)) ids.push(id);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const l of g.links) if (indeg.has(l.to) && indeg.has(l.from)) indeg.set(l.to, indeg.get(l.to)! + 1);
  const order: string[] = [];
  const done = new Set<string>();
  const depth = new Map<string, number>();
  const ready = ids.filter((id) => indeg.get(id) === 0);
  while (order.length < ids.length) {
    if (!ready.length) {
      // a loop: release the earliest unprocessed module
      const n = ids.find((id) => !done.has(id))!;
      ready.push(n);
      indeg.set(n, 0);
    }
    const n = ready.shift()!;
    if (done.has(n)) continue;
    done.add(n);
    order.push(n);
    let d = 0;
    for (const l of g.links) if (l.to === n && (l.from === IN || done.has(l.from)) && l.from !== n) d = Math.max(d, (depth.get(l.from) ?? 0) + 1);
    depth.set(n, Math.max(1, d));
    for (const l of g.links) {
      if (l.from !== n || !indeg.has(l.to) || done.has(l.to)) continue;
      const k = indeg.get(l.to)! - 1;
      indeg.set(l.to, k);
      if (k === 0) ready.push(l.to);
    }
  }
  const pos = new Map(order.map((id, i) => [id, i]));
  const inputs = new Map<string, PatcherLink[]>();
  for (const l of g.links) {
    if (l.kind !== 'audio') continue;
    if (l.to !== OUT && !pos.has(l.to)) continue;
    if (l.from !== IN && !pos.has(l.from)) continue;
    if (l.from !== IN && l.to !== OUT && pos.get(l.from)! >= pos.get(l.to)!) continue; // feedback edge
    let arr = inputs.get(l.to);
    if (!arr) inputs.set(l.to, (arr = []));
    arr.push(l);
  }
  return { order, inputs, depth };
}

export interface Compensation {
  /** Latency at "To FL Studio" (samples): the longest path. */
  total: number;
  /** Delay inserted on each audio link so parallel paths line up (samples). */
  delays: Map<string, number>;
  /** Latency at each module's output (samples). */
  arrival: Map<string, number>;
}

/** Automatic delay compensation inside Patcher: every input port lines its links up with its latest one. */
export function compensate(plan: ProcessPlan, latencyOf: (id: string) => number): Compensation {
  const out = new Map<string, number>([[IN, 0]]);
  const delays = new Map<string, number>();
  const line = (id: string): number => {
    const links = plan.inputs.get(id) ?? [];
    let a = 0;
    for (const l of links) a = Math.max(a, out.get(l.from) ?? 0);
    for (const l of links) delays.set(l.id, a - (out.get(l.from) ?? 0));
    return a;
  };
  for (const id of plan.order) out.set(id, line(id) + Math.max(0, Math.round(latencyOf(id))));
  const total = line(OUT);
  out.delete(IN);
  return { total, delays, arrival: out };
}

/** Ring time at "To FL Studio" (seconds): the longest sum of module tails along a path. */
export function pathTail(plan: ProcessPlan, tailOf: (id: string) => number): number {
  const t = new Map<string, number>([[IN, 0]]);
  const inTail = (id: string): number => {
    let a = 0;
    for (const l of plan.inputs.get(id) ?? []) a = Math.max(a, t.get(l.from) ?? 0);
    return a;
  };
  for (const id of plan.order) t.set(id, inTail(id) + Math.max(0, tailOf(id)));
  return inTail(OUT);
}

// ---------------------------------------------------------------- layout

/**
 * Map menu > Auto-arrange modules: one column per processing depth (FL's
 * multithreaded columns), From FL Studio on the left, To FL Studio on the right.
 */
export function autoArrange(g: PatcherGraph, width: number, height: number): void {
  const plan = processPlan(g);
  const cols = new Map<number, string[]>();
  let maxD = 0;
  for (const id of plan.order) {
    const d = plan.depth.get(id) ?? 1;
    maxD = Math.max(maxD, d);
    let c = cols.get(d);
    if (!c) cols.set(d, (c = []));
    c.push(id);
  }
  const ncol = maxD + 2;
  const dx = Math.max(150, (width - 120) / Math.max(1, ncol - 1));
  const x0 = 64;
  g.io.in = { ...g.io.in, x: x0, y: height / 2 };
  g.io.out = { x: x0 + dx * (ncol - 1), y: height / 2 };
  for (const [d, ids] of cols) {
    // keep the current vertical order inside a column
    ids.sort((a, b) => g.modules[a].y - g.modules[b].y);
    const dy = Math.max(110, Math.min(150, (height - 60) / Math.max(1, ids.length)));
    const y0 = height / 2 - (dy * (ids.length - 1)) / 2;
    ids.forEach((id, i) => { g.modules[id].x = x0 + dx * d; g.modules[id].y = y0 + dy * i; });
  }
}

// ------------------------------------------------------------- normalize

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** Repair a stored graph (missing fields, dangling links, duplicate ids). */
export function normalizeGraph(raw: unknown): PatcherGraph {
  const d = defaultGraph();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<PatcherGraph>;
  const modules: Record<string, PatcherModule> = {};
  let next = Math.max(2, num(r.next, 2));
  const bump = (id: string) => { const k = Number(id.slice(1)); if (Number.isFinite(k)) next = Math.max(next, k + 1); };
  for (const [id, m] of Object.entries(r.modules && typeof r.modules === 'object' ? r.modules : {})) {
    if (!m || typeof m !== 'object' || typeof m.plugin !== 'string' || id === IN || id === OUT) continue;
    modules[id] = {
      id, plugin: m.plugin, name: typeof m.name === 'string' ? m.name : m.plugin,
      x: num(m.x, 300), y: num(m.y, 240),
      params: m.params && typeof m.params === 'object' ? m.params : {},
      ...(Array.isArray(m.outs) ? { outs: m.outs.filter((k) => typeof k === 'number') } : isEventModule(m.plugin) ? { outs: defaultOuts(m.plugin) } : {}),
      ...(m.threaded !== undefined ? { threaded: !!m.threaded } : {}),
      ...(m.compatLevels !== undefined ? { compatLevels: !!m.compatLevels } : {}),
    };
    bump(id);
  }
  const order = (Array.isArray(r.order) ? r.order : []).filter((id): id is string => typeof id === 'string' && !!modules[id]);
  for (const id of Object.keys(modules)) if (!order.includes(id)) order.push(id);
  const g: PatcherGraph = {
    version: 1, modules, order, links: [],
    io: {
      in: {
        x: num(r.io?.in?.x, d.io.in.x), y: num(r.io?.in?.y, d.io.in.y),
        ...(Array.isArray(r.io?.in?.ports) && r.io!.in.ports.length
          ? { ports: [...new Set(r.io!.in.ports.filter((p): p is number => Number.isInteger(p) && p >= 0 && p <= 255))].sort((a, b) => a - b) }
          : {}),
      },
      out: { x: num(r.io?.out?.x, d.io.out.x), y: num(r.io?.out?.y, d.io.out.y) },
    },
    focus: typeof r.focus === 'string' && modules[r.focus] ? r.focus : null,
    next,
    view: { ...d.view, ...(r.view && typeof r.view === 'object' ? r.view : {}) },
  };
  const ids = new Set<string>();
  for (const l of Array.isArray(r.links) ? r.links : []) {
    if (!l || typeof l !== 'object') continue;
    const kind: LinkKind = l.kind === 'events' ? 'events' : 'audio';
    let id = typeof l.id === 'string' && !ids.has(l.id) ? l.id : `l${g.next++}`;
    if (ids.has(id)) id = `l${g.next++}`;
    if (connectError(g, kind, String(l.from), num(l.fromPort, 0), String(l.to), num(l.toPort, 0))) continue;
    ids.add(id);
    bump(id);
    g.links.push({
      id, kind, from: String(l.from), fromPort: num(l.fromPort, 0), to: String(l.to), toPort: num(l.toPort, 0),
      level: Math.min(LINK_MAX, Math.max(0, num(l.level, 1))), mute: !!l.mute,
    });
  }
  g.next = Math.max(g.next, next);
  return g;
}

/** The link level as FL's hint shows it ("Level: 100% (0.0 dB)"). */
export function levelText(level: number): string {
  const db = level > 0 ? 20 * Math.log10(level) : -Infinity;
  return `${Math.round(level * 100)}% (${Number.isFinite(db) ? `${db > 0.05 ? '+' : ''}${db.toFixed(1)} dB` : '-inf dB'})`;
}
