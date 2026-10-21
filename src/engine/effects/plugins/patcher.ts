// Patcher: runs its hosted modules (any registered effect, created with
// createEffect) as a graph between "From FL Studio" and "To FL Studio".
// - Audio links are stereo; an input sums its links, an output fans out.
// - Modules run in topological order (feedback links are refused by the
//   editor and ignored here).
// - Latency compensation is automatic, as in FL: every input lines its links
//   up with the latest one (a delay per link), so parallel paths stay in phase.
//   Patcher reports the longest path's latency to the mixer's PDC and the
//   longest chain of module tails as its tail.
// - Link levels and mutes ramp over a block (no zipper noise).
// - Hosted modules' parameters are automated at their own paths
//   (params.$graph.modules.<id>.params.<key>); the engine's setPath writes
//   them into this state before setParams.
// - Notes (MIDI input): From FL Studio's "Notes" output carries the notes of
//   the slot's MIDI input port, its "Port p" outputs those of MIDI port p
//   (FL: From FL Studio > Outputs > Events > Port p; Patcher listens on the
//   activated ports). Event links carry them, at their sample, to the
//   modules: effects that take notes get noteOn / noteOff, VFX modules play
//   them live through their note processing (processNotes) and send the
//   resulting notes on along their voice outputs (LiveVfx below).
// - Generators: modules with a 'g' id (isGenModule) are instrument plugins,
//   hosted by HostedGen (src/engine/gen/hosted.ts): they take the notes of their
//   event links as voices and render into the module's audio output. The
//   instrument version of Patcher (src/engine/gen/plugins/patcher.ts) wraps
//   this same class: the channel's notes enter as From FL Studio's "Notes"
//   output (with the channel note's live levels, see NoteSrcPool), and the
//   graph's audio output is the instrument's output.

import { createEffect } from '../index';
import type { EffectInstance, EffectModule, FxContext, FxEnv, FxMonitor } from '../types';
import {
  GRAPH_KEY, IN, LINK_MAX, OUT, compensate, inPortOut, inPorts, isEventModule, isGenModule, pathTail, processPlan,
  type PatcherGraph, type PatcherLink, type ProcessPlan,
} from '../../../model/fx/plugins/patcher';
import { clampKey, seeded, type VfxContext, type VfxNote } from '../../../model/fx/plugins/vfx/notes';
import { HostedGen, NoteSrcPool } from '../../gen/hosted';
import type { GenNote } from '../../gen/types';
import type { InterpMode } from '../../../model/sampler';

/** Notes the instrument version feeds in (the channel's), as opposed to MIDI Out ports (>= 0). */
const CHANNEL_PORT = -2;

// ------------------------------------------------------------------ notes

/**
 * Note events of one block on one port (sample offsets, time order). Grows,
 * never shrinks. `s` is the note's source (NoteSrcPool index of the channel note
 * the event comes from, -1 for MIDI port notes): hosted generators follow its
 * live levels.
 */
export class EvList {
  f = new Int32Array(32);
  k = new Int16Array(32);
  v = new Float32Array(32);
  o = new Uint8Array(32);
  c = new Uint8Array(32);
  s = new Int32Array(32);
  n = 0;
  clear(): void { this.n = 0; }
  push(frame: number, key: number, vel: number, on: boolean, chan: number, src = -1): void {
    if (this.n === this.f.length) {
      const cap = this.f.length * 2;
      const grow = <T extends Int32Array | Int16Array | Float32Array | Uint8Array>(a: T, b: T) => { b.set(a); return b; };
      this.f = grow(this.f, new Int32Array(cap)); this.k = grow(this.k, new Int16Array(cap));
      this.v = grow(this.v, new Float32Array(cap)); this.o = grow(this.o, new Uint8Array(cap)); this.c = grow(this.c, new Uint8Array(cap));
      this.s = grow(this.s, new Int32Array(cap));
    }
    const i = this.n++;
    this.f[i] = frame; this.k[i] = key; this.v[i] = vel; this.o[i] = on ? 1 : 0; this.c[i] = chan; this.s[i] = src;
  }
  append(src: EvList): void { for (let i = 0; i < src.n; i++) this.push(src.f[i], src.k[i], src.v[i], src.o[i] === 1, src.c[i], src.s[i]); }
  /** Stable sort by frame, note offs first at a frame (merged inputs). */
  sort(): void {
    for (let i = 1; i < this.n; i++) {
      const f = this.f[i], k = this.k[i], v = this.v[i], o = this.o[i], c = this.c[i], s = this.s[i];
      let j = i - 1;
      while (j >= 0 && (this.f[j] > f || (this.f[j] === f && this.o[j] > o))) {
        this.f[j + 1] = this.f[j]; this.k[j + 1] = this.k[j]; this.v[j + 1] = this.v[j]; this.o[j + 1] = this.o[j]; this.c[j + 1] = this.c[j]; this.s[j + 1] = this.s[j];
        j--;
      }
      this.f[j + 1] = f; this.k[j + 1] = k; this.v[j + 1] = v; this.o[j + 1] = o; this.c[j + 1] = c; this.s[j + 1] = s;
    }
  }
}

/** A VFX module's note processing (every VFX engine instance has it). */
type VfxFx = EffectInstance & { notes?(n: VfxNote[], ctx?: VfxContext): VfxNote[] };

interface LiveIn { id: number; key: number; vel: number; chan: number; src: number; start: number; startTick: number; end: number; endTick: number }
interface LiveOut { inId: number; port: number; key: number; vel: number; chan: number; src: number; start: number; end: number; started: boolean }

/** Ticks a live note is given before its release is known (per-note VFX); outputs reaching it last until the release. */
const LIVE_BARS = 4;
/** Batch VFX (Sequencer): look-ahead and how long released notes stay in the batch. */
const BATCH_BARS = 1;
const KEEP_BARS = 8;

/**
 * A hosted VFX module played live. Per-note mode (mappers, envelope, script):
 * each note is processed on its own when it starts (relative times, a seeded
 * random source per note, LIVE_BARS long); its output notes are scheduled from
 * the note start, and the release ends those still sounding (outputs that
 * would run to the provisional end last until the release). Batch mode
 * (Sequencer: an arpeggiator needs the whole chord): the held notes (and the
 * recently released ones, with their real lengths) are processed together at
 * song ticks whenever they change and every half look-ahead; future outputs
 * are replaced, sounding ones that the new result no longer has are released.
 */
class LiveVfx {
  private ins: LiveIn[] = [];
  private outs: LiveOut[] = [];
  private nid = 0;
  private rerunAt = Infinity;
  /** The module's counters from note to note (VfxContext.state: Key Mapper's cycle positions). */
  private state: Record<string, unknown> = {};
  /**
   * @param batch the held notes are processed together (Sequencer)
   * @param bars how long a note is processed before its release is known (scripts: shorter, they run tick by tick)
   */
  constructor(private readonly batch: boolean, private readonly bars = LIVE_BARS) {}

  reset(): void { this.ins.length = 0; this.outs.length = 0; this.rerunAt = Infinity; this.state = {}; }

  /** Notes are held or output notes are still due (the patch must keep running); released notes kept for the next batch do not count. */
  busy(): boolean {
    if (this.outs.length > 0) return true;
    for (const x of this.ins) if (x.end === Infinity) return true;
    return false;
  }

  run(fx: VfxFx, ev: EvList, clock: number, n: number, baseTick: number, spt: number, ppq: number, tempo: number, out: EvList[]): void {
    for (const o of out) o.clear();
    if (!fx.notes) return;
    for (let i = 0; i < ev.n; i++) {
      const f = ev.f[i], T = clock + f, tick = baseTick + f / spt;
      if (ev.o[i]) this.noteOn(fx, ev.k[i], ev.v[i], ev.c[i], ev.s[i], T, tick, spt, ppq, tempo);
      else this.noteOff(fx, ev.k[i], T, tick, spt, ppq, tempo);
    }
    if (this.batch && this.rerunAt < clock + n) {
      const T = Math.max(clock, this.rerunAt);
      this.rerun(fx, T, baseTick + (T - clock) / spt, spt, ppq, tempo);
    }
    this.emit(clock, n, out);
  }

  private noteOn(fx: VfxFx, key: number, vel: number, chan: number, src: number, T: number, tick: number, spt: number, ppq: number, tempo: number): void {
    // a key pressed again ends its previous note first
    if (this.ins.some((x) => x.key === key && x.end === Infinity)) this.noteOff(fx, key, T, tick, spt, ppq, tempo);
    const id = ++this.nid;
    const color = Math.max(0, Math.min(15, chan - 1));
    this.ins.push({ id, key, vel, chan, src, start: T, startTick: tick, end: Infinity, endTick: Infinity });
    if (this.batch) { this.rerun(fx, T, tick, spt, ppq, tempo); return; }
    const len = this.bars * 4 * ppq;
    const note: VfxNote = { key, pos: 0, len, vel, rel: 64, pan: 64, fine: 120, modX: 128, modY: 128, color };
    let res: VfxNote[] = [];
    const ctx = { ppq, tempo, random: seeded((id * 2654435761) >>> 0), state: this.state, horizon: len };
    try { res = fx.notes!([note], ctx); } catch { res = []; }
    for (const o of res) {
      if (!(o.vel > 0) || !Number.isFinite(o.pos) || !Number.isFinite(o.len)) continue;
      const start = T + Math.max(0, o.pos) * spt;
      const open = o.pos + o.len >= len - 1;
      this.outs.push({
        inId: id, port: Math.max(0, Math.min(15, Math.round(o.port ?? 0))), key: clampKey(o.key), vel: Math.min(128, o.vel), chan, src,
        start: Math.round(start), end: open ? Infinity : Math.round(start + Math.max(1, o.len) * spt), started: false,
      });
    }
  }

  private noteOff(fx: VfxFx, key: number, T: number, tick: number, spt: number, ppq: number, tempo: number): void {
    const inp = this.ins.find((x) => x.key === key && x.end === Infinity);
    if (!inp) return;
    inp.end = T;
    inp.endTick = tick;
    if (this.batch) { this.rerun(fx, T, tick, spt, ppq, tempo); return; }
    this.ins.splice(this.ins.indexOf(inp), 1);
    for (let i = this.outs.length - 1; i >= 0; i--) {
      const o = this.outs[i];
      if (o.inId !== inp.id) continue;
      if (!o.started) this.outs.splice(i, 1);
      else if (o.end > T) o.end = T;
    }
  }

  private rerun(fx: VfxFx, T: number, tick: number, spt: number, ppq: number, tempo: number): void {
    const bar = 4 * ppq;
    this.ins = this.ins.filter((x) => x.end === Infinity || x.endTick > tick - KEEP_BARS * bar);
    const held = this.ins.some((x) => x.end === Infinity);
    const notes: VfxNote[] = this.ins.map((x) => ({
      key: x.key, pos: x.startTick, len: Math.max(1, (x.end === Infinity ? tick + BATCH_BARS * bar : x.endTick) - x.startTick),
      vel: x.vel, rel: 64, pan: 64, fine: 120, modX: 128, modY: 128, color: Math.max(0, Math.min(15, x.chan - 1)),
    }));
    let res: VfxNote[] = [];
    if (notes.length) { try { res = fx.notes!(notes, { ppq, tempo, random: seeded(12345) }); } catch { res = []; } }
    // the outputs of a chord follow the levels of its latest held note
    let src = -1;
    for (const x of this.ins) if (x.end === Infinity) src = x.src;
    const fresh = res.filter((o) => o.vel > 0 && Number.isFinite(o.pos) && Number.isFinite(o.len)).map((o) => {
      const start = Math.round(T + (o.pos - tick) * spt);
      return { port: Math.max(0, Math.min(15, Math.round(o.port ?? 0))), key: clampKey(o.key), vel: Math.min(128, o.vel), start, end: Math.round(start + Math.max(1, o.len) * spt), used: false };
    });
    const tol = Math.max(1, spt);
    const keep: LiveOut[] = [];
    for (const o of this.outs) {
      if (!o.started) continue; // future notes are replaced by the new result
      const m = fresh.find((q) => !q.used && q.port === o.port && q.key === o.key && Math.abs(q.start - o.start) <= tol);
      if (m) { m.used = true; o.end = Math.max(T, m.end); } else if (o.end > T) o.end = T;
      keep.push(o);
    }
    for (const q of fresh) if (!q.used && q.start >= T) keep.push({ inId: 0, port: q.port, key: q.key, vel: q.vel, chan: 1, src, start: q.start, end: q.end, started: false });
    this.outs = keep;
    this.rerunAt = held ? T + (BATCH_BARS * bar * spt) / 2 : Infinity;
  }

  /** Output events of the block [clock, clock + n), per voice port. */
  private emit(clock: number, n: number, out: EvList[]): void {
    const end = clock + n;
    let w = 0;
    for (let i = 0; i < this.outs.length; i++) {
      const o = this.outs[i];
      const list = out[o.port];
      if (!o.started && o.start < end) {
        if (o.end <= clock) continue; // missed entirely
        o.started = true;
        list?.push(Math.max(0, o.start - clock), o.key, o.vel, true, o.chan, o.src);
      }
      if (o.started && o.end < end) {
        list?.push(Math.max(0, Math.min(n - 1, o.end - clock)), o.key, 0, false, o.chan, o.src);
        continue;
      }
      this.outs[w++] = o;
    }
    this.outs.length = w;
    for (const l of out) if (l.n > 1) l.sort();
  }
}

interface ModNode {
  id: string;
  plugin: string;
  fx: EffectInstance;
  /** Working buffer: the summed input, processed in place into the module's output. */
  L: Float32Array;
  R: Float32Array;
  inputs: Edge[];
  lat: number;
  peak: number;
  /** Event links into the module (source null: From FL Studio) and this block's merged input. */
  evLinks: { src: ModNode | null; fromPort: number }[];
  evIn: EvList;
  /** VFX modules: live note processing and this block's output events per voice port. */
  vfx: LiveVfx | null;
  evOut: EvList[] | null;
  /** Generator modules: the hosted instrument (the same object as `fx`). */
  gen: HostedGen | null;
}

interface Edge {
  id: string;
  src: ModNode | null; // null: From FL Studio
  gain: number;
  g0: number;
  delay: number;
  dl: Float32Array | null;
  dr: Float32Array | null;
  pos: number;
}

interface LinkSig { id: string; kind: string; from: string; fromPort: number; to: string; toPort: number }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

export class Patcher implements EffectInstance {
  private readonly sr: number;
  private readonly bs: number;
  private readonly env: FxEnv;
  private nodes = new Map<string, ModNode>();
  private order: ModNode[] = [];
  private outEdges: Edge[] = [];
  private edges = new Map<string, Edge>();
  private inL: Float32Array;
  private inR: Float32Array;
  private pass = true;
  private sig: LinkSig[] = [];
  private ids: string[] = [];
  private focus: string | null = null;
  private plan: ProcessPlan | null = null;
  private lat = 0;
  private tailSec = 0;
  private peakIn = 0;
  private peakOut = 0;
  // ---- notes ----
  /** The slot's MIDI input port (From FL Studio's "Notes" output). */
  private wrapperPort = -1;
  /** MIDI ports activated as From FL Studio event outputs. */
  private ports: number[] = [];
  /** Note events received for the next block: [frame, key, vel, on, channel, port]. */
  private inF: number[] = [];
  private inK: number[] = [];
  private inV: number[] = [];
  private inO: boolean[] = [];
  private inC: number[] = [];
  private inP: number[] = [];
  private inS: number[] = [];
  /** From FL Studio's event outputs (0 = Notes, 1 + p = Port p) for this block. */
  private inOut = new Map<number, EvList>();
  private clock = 0;
  private freeTick = 0;
  private anyNotes = false;
  /** Channel notes' live levels for the generators (the instrument version). */
  readonly srcs = new NoteSrcPool();
  /** The channel's max polyphony and the project's resampling quality, forwarded to hosted generators. */
  private maxPoly = 0;
  private interp: InterpMode | null = null;

  constructor(sampleRate: number, blockSize: number, env: FxEnv) {
    this.sr = sampleRate;
    this.bs = blockSize;
    this.env = env;
    this.inL = new Float32Array(blockSize);
    this.inR = new Float32Array(blockSize);
  }

  get latency(): number { return this.lat; }
  get tail(): number { return this.tailSec; }

  setParams(p: unknown): void {
    const s = isObj(p) ? p : {};
    const g = s[GRAPH_KEY] as PatcherGraph | undefined;
    if (!isObj(g) || !isObj(g.modules) || !Array.isArray(g.links)) {
      // no graph: behave like FL's default patch (input straight to output)
      this.pass = true;
      this.lat = 0;
      this.tailSec = 0;
      return;
    }
    this.pass = false;
    this.focus = typeof g.focus === 'string' ? g.focus : null;
    let structural = false;

    // module instances (kept while the id and plugin stay the same)
    let count = 0;
    for (const id in g.modules) {
      count++;
      const m = g.modules[id];
      let node = this.nodes.get(id);
      if (!node || node.plugin !== m.plugin) {
        const isGen = isGenModule(id);
        const vfx = !isGen && isEventModule(m.plugin);
        const gen = isGen ? new HostedGen(m.plugin, this.sr, this.bs, this.env, this.srcs) : null;
        if (gen) {
          if (this.maxPoly) gen.setMaxPoly(this.maxPoly);
          if (this.interp) gen.setInterpolation(this.interp);
        }
        node = {
          id, plugin: m.plugin, fx: gen ?? createEffect(m.plugin, this.sr, this.bs, this.env),
          L: new Float32Array(this.bs), R: new Float32Array(this.bs), inputs: [], lat: 0, peak: 0,
          evLinks: [], evIn: new EvList(), vfx: vfx ? new LiveVfx(m.plugin === 'vfxsequencer', m.plugin === 'vfxscript' ? 2 : LIVE_BARS) : null,
          evOut: vfx ? Array.from({ length: 16 }, () => new EvList()) : null,
          gen,
        };
        this.nodes.set(id, node);
        structural = true;
      }
      node.fx.setParams(isObj(m.params) ? m.params : {});
      const lat = Math.max(0, Math.round(node.fx.latency ?? 0));
      if (lat !== node.lat) { node.lat = lat; structural = true; }
    }
    if (count !== this.nodes.size) {
      for (const id of [...this.nodes.keys()]) if (!g.modules[id]) this.nodes.delete(id);
      structural = true;
    }
    if (!structural) structural = !this.sameLinks(g.links) || !this.sameOrder(g.order);
    if (structural) this.rebuild(g);
    // From FL Studio's MIDI port outputs (the ports Patcher listens on): the activated ones and any linked one
    const linked = g.links.filter((l) => l.kind === 'events' && l.from === IN && l.fromPort > 0).map((l) => l.fromPort - 1);
    const ports = [...new Set([...inPorts(g), ...linked])].filter((q) => q >= 0 && q <= 255).sort((a, b) => a - b);
    if (ports.length !== this.ports.length || ports.some((p, k) => p !== this.ports[k])) this.ports = ports.slice();
    for (const k of [...this.inOut.keys()]) if (k !== 0 && !this.ports.includes(k - 1)) this.inOut.delete(k);
    if (!this.inOut.has(0)) this.inOut.set(0, new EvList());
    for (const p of this.ports) if (!this.inOut.has(inPortOut(p))) this.inOut.set(inPortOut(p), new EvList());
    // levels and mutes change without a rebuild
    for (const l of g.links) {
      const e = this.edges.get(l.id);
      if (e) e.gain = l.mute ? 0 : Math.min(LINK_MAX, Math.max(0, Number.isFinite(l.level) ? l.level : 1));
    }
    this.tailSec = this.computeTail();
  }

  private sameLinks(links: PatcherLink[]): boolean {
    if (links.length !== this.sig.length) return false;
    for (let i = 0; i < links.length; i++) {
      const a = links[i], b = this.sig[i];
      if (a.id !== b.id || a.kind !== b.kind || a.from !== b.from || a.to !== b.to || a.fromPort !== b.fromPort || a.toPort !== b.toPort) return false;
    }
    return true;
  }

  private sameOrder(order: string[]): boolean {
    if (!Array.isArray(order) || order.length !== this.ids.length) return false;
    for (let i = 0; i < order.length; i++) if (order[i] !== this.ids[i]) return false;
    return true;
  }

  private rebuild(g: PatcherGraph): void {
    this.sig = g.links.map((l) => ({ id: l.id, kind: l.kind, from: l.from, fromPort: l.fromPort, to: l.to, toPort: l.toPort }));
    this.ids = Array.isArray(g.order) ? [...g.order] : [];
    const plan = processPlan(g);
    this.plan = plan;
    const comp = compensate(plan, (id) => this.nodes.get(id)?.lat ?? 0);
    this.lat = comp.total;
    const keep = new Map<string, Edge>();
    const edgeFor = (l: PatcherLink): Edge => {
      const old = this.edges.get(l.id);
      const src = l.from === IN ? null : this.nodes.get(l.from) ?? null;
      const delay = comp.delays.get(l.id) ?? 0;
      const gain = l.mute ? 0 : Math.min(LINK_MAX, Math.max(0, l.level));
      const e: Edge = old && old.src === src ? old : { id: l.id, src, gain, g0: gain, delay: 0, dl: null, dr: null, pos: 0 };
      if (e.delay !== delay) {
        e.delay = delay;
        const size = delay + this.bs;
        if (delay > 0 && (!e.dl || e.dl.length < size)) { e.dl = new Float32Array(size); e.dr = new Float32Array(size); e.pos = 0; }
        else if (e.dl) { e.dl.fill(0); e.dr!.fill(0); e.pos = 0; }
      }
      keep.set(l.id, e);
      return e;
    };
    this.order = [];
    for (const id of plan.order) {
      const node = this.nodes.get(id);
      if (!node) continue;
      node.inputs = (plan.inputs.get(id) ?? []).map(edgeFor);
      this.order.push(node);
    }
    this.outEdges = (plan.inputs.get(OUT) ?? []).map(edgeFor);
    this.edges = keep;
    // event links (no feedback: the source runs earlier); a changed patch lets go of every note
    const pos = new Map(this.order.map((m, i) => [m.id, i]));
    let anyNotes = false;
    for (const m of this.order) {
      m.evLinks = [];
      for (const l of g.links) {
        if (l.kind !== 'events' || l.to !== m.id) continue;
        if (l.from === IN) m.evLinks.push({ src: null, fromPort: l.fromPort });
        else {
          const src = this.nodes.get(l.from);
          if (src && (pos.get(src.id) ?? 1e9) < (pos.get(m.id) ?? -1)) m.evLinks.push({ src, fromPort: l.fromPort });
        }
      }
      if (m.evLinks.length || m.vfx) anyNotes = true;
      m.fx.allNotesOff?.();
      m.vfx?.reset();
    }
    this.anyNotes = anyNotes;
  }

  private computeTail(): number {
    const plan = this.plan;
    if (!plan) return 0;
    let inf = false;
    const t = pathTail(plan, (id) => {
      const v = this.nodes.get(id)?.fx.tail ?? 0;
      if (!Number.isFinite(v)) inf = true;
      return Number.isFinite(v) ? v : 0;
    });
    return inf ? Infinity : t + this.lat / this.sr;
  }

  private mix(e: Edge, dstL: Float32Array, dstR: Float32Array, n: number): void {
    const sl = e.src ? e.src.L : this.inL, sr = e.src ? e.src.R : this.inR;
    const g0 = e.g0, g1 = e.gain, dg = (g1 - g0) / n;
    e.g0 = g1;
    if (g0 === 0 && g1 === 0 && e.delay === 0) return;
    if (e.delay === 0 || !e.dl || !e.dr) {
      if (dg === 0) {
        if (g1 === 1) for (let i = 0; i < n; i++) { dstL[i] += sl[i]; dstR[i] += sr[i]; }
        else for (let i = 0; i < n; i++) { dstL[i] += sl[i] * g1; dstR[i] += sr[i] * g1; }
      } else {
        for (let i = 0; i < n; i++) { const g = g0 + dg * i; dstL[i] += sl[i] * g; dstR[i] += sr[i] * g; }
      }
      return;
    }
    const bl = e.dl, br = e.dr, size = bl.length, d = e.delay;
    let w = e.pos;
    for (let i = 0; i < n; i++) {
      bl[w] = sl[i];
      br[w] = sr[i];
      let r = w - d;
      if (r < 0) r += size;
      const g = g0 + dg * i;
      dstL[i] += bl[r] * g;
      dstR[i] += br[r] * g;
      if (++w >= size) w = 0;
    }
    e.pos = w;
  }

  // ------------------------------------------------------------- MIDI input
  setMidiPort(port: number): void { this.wrapperPort = port; }

  midiPorts(): readonly number[] { return this.ports; }

  noteOn(key: number, velocity: number, frameOffset: number, port: number, channel: number): void {
    this.queueNote(key, velocity, frameOffset, true, channel, port, -1);
  }

  noteOff(key: number, frameOffset: number, port: number, channel: number): void {
    this.queueNote(key, 0, frameOffset, false, channel, port, -1);
  }

  allNotesOff(): void {
    this.inF.length = this.inK.length = this.inV.length = this.inO.length = this.inC.length = this.inP.length = this.inS.length = 0;
    for (const m of this.nodes.values()) { m.fx.allNotesOff?.(); m.vfx?.reset(); }
    this.srcs.releaseAll();
  }

  // ------------------------------------------- the instrument version: channel notes
  /** A channel note starts (From FL Studio's "Notes"), `frame` samples into the next process() call. */
  channelNoteOn(note: GenNote, frame: number): void {
    this.queueNote(note.key, note.velocity, frame, true, note.color + 1, CHANNEL_PORT, this.srcs.start(note));
  }

  /** The channel note's release; its levels freeze at their last values. (A note this patch no longer tracks, e.g. after a panic, is ignored.) */
  channelNoteOff(note: GenNote, frame: number): void {
    const src = this.srcs.find(note.id);
    if (src < 0) return;
    this.queueNote(note.key, 0, frame, false, note.color + 1, CHANNEL_PORT, src);
    this.srcs.release(src);
  }

  /** The channel stops a note at once (polyphony limit, panic): hosted voices fade out and end. */
  channelNoteKill(note: GenNote): void {
    const src = this.srcs.find(note.id);
    if (src < 0) return;
    for (const m of this.nodes.values()) m.gen?.killSrc(src);
    // a note-on queued for this block ends with the block; downstream VFX modules get the note off
    this.queueNote(note.key, 0, 0x7fffffff, false, note.color + 1, CHANNEL_PORT, src);
    this.srcs.release(src);
  }

  /** Anything is still sounding or due: hosted voices, VFX output notes, queued notes. */
  busy(): boolean {
    if (this.inF.length) return true;
    for (const m of this.nodes.values()) if (m.gen?.busy() || m.vfx?.busy()) return true;
    return false;
  }

  /** The channel's max polyphony (FL's FPE_MaxPoly), for the hosted generators that limit their own voices. */
  setMaxPoly(n: number): void {
    this.maxPoly = n;
    for (const m of this.nodes.values()) m.gen?.setMaxPoly(n);
  }

  /** The project's resampling quality, for hosted generators that resample by themselves. */
  setInterpolation(mode: InterpMode): void {
    this.interp = mode;
    for (const m of this.nodes.values()) m.gen?.setInterpolation(mode);
  }

  /** State the hosted modules changed by themselves, at their paths inside the graph. */
  takeStateChanges(): [string, unknown][] | null {
    let out: [string, unknown][] | null = null;
    for (const m of this.nodes.values()) {
      const c = m.fx.takeStateChanges?.();
      if (!c) continue;
      out ??= [];
      for (const [path, v] of c) out.push([`${GRAPH_KEY}.modules.${m.id}.params.${path}`, v]);
    }
    return out;
  }

  private queueNote(key: number, vel: number, frame: number, on: boolean, chan: number, port: number, src: number): void {
    // MIDI notes are 0..127; the channel's notes reach FL's top keys (131)
    if (key < 0 || key > (port === CHANNEL_PORT ? 131 : 127) || this.inF.length >= 1024) return;
    this.inF.push(Math.max(0, frame | 0)); this.inK.push(key); this.inV.push(vel); this.inO.push(on); this.inC.push(chan || 1); this.inP.push(port); this.inS.push(src);
  }

  /** This block's note events: From FL Studio's outputs, then module by module along the event links. */
  private routeNotes(m: ModNode, n: number, baseTick: number, spt: number, ppq: number, tempo: number): void {
    const ev = m.evIn;
    ev.clear();
    for (const l of m.evLinks) {
      const src = l.src ? l.src.evOut?.[l.fromPort] : this.inOut.get(l.fromPort);
      if (src && src.n) ev.append(src);
    }
    if (m.evLinks.length > 1 && ev.n > 1) ev.sort();
    if (m.vfx && m.evOut) { m.vfx.run(m.fx as VfxFx, ev, this.clock, n, baseTick, spt, ppq, tempo, m.evOut); return; }
    if (m.gen) { m.gen.hostEvents(ev); return; }
    const fx = m.fx;
    for (let i = 0; i < ev.n; i++) {
      // port -1: the module's own notes input (a nested Patcher's "Notes")
      if (ev.o[i]) fx.noteOn?.(ev.k[i], ev.v[i], ev.f[i], -1, ev.c[i]);
      else fx.noteOff?.(ev.k[i], ev.f[i], -1, ev.c[i]);
    }
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (this.pass) { this.inF.length = this.inK.length = this.inV.length = this.inO.length = this.inC.length = this.inP.length = this.inS.length = 0; return; }
    // notes: From FL Studio's "Notes" (the slot's port) and "Port p" outputs
    const tempo = ctx.tempo > 1 ? ctx.tempo : 120, ppq = ctx.ppq > 0 ? ctx.ppq : 96;
    const spt = (this.sr * 60) / (tempo * ppq);
    const baseTick = ctx.playing ? ctx.pos : this.freeTick;
    for (const l of this.inOut.values()) l.clear();
    for (let i = 0; i < this.inF.length; i++) {
      const p = this.inP[i];
      const f = Math.min(n - 1, this.inF[i]);
      if (p === this.wrapperPort || p === CHANNEL_PORT) this.inOut.get(0)?.push(f, this.inK[i], this.inV[i], this.inO[i], this.inC[i], this.inS[i]);
      if (p >= 0) this.inOut.get(inPortOut(p))?.push(f, this.inK[i], this.inV[i], this.inO[i], this.inC[i], this.inS[i]);
    }
    this.inF.length = this.inK.length = this.inV.length = this.inO.length = this.inC.length = this.inP.length = this.inS.length = 0;
    // the channel's voices queue their events voice by voice: put them in time order (note offs first)
    for (const l of this.inOut.values()) if (l.n > 1) l.sort();
    this.srcs.refresh();
    const inL = this.inL, inR = this.inR;
    let pk = this.peakIn;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      inL[i] = l; inR[i] = r;
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (a > pk) pk = a;
    }
    this.peakIn = pk;
    for (const m of this.order) {
      if (this.anyNotes && (m.evLinks.length || m.vfx)) this.routeNotes(m, n, baseTick, spt, ppq, tempo);
      const bl = m.L, br = m.R;
      bl.fill(0, 0, n);
      br.fill(0, 0, n);
      for (const e of m.inputs) this.mix(e, bl, br, n);
      m.fx.process(bl, br, n, ctx);
      let p = m.peak;
      for (let i = 0; i < n; i++) {
        const l = bl[i], r = br[i];
        // keep the graph finite whatever a module does
        if (!(l > -1e9 && l < 1e9)) bl[i] = 0;
        if (!(r > -1e9 && r < 1e9)) br[i] = 0;
        const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
        if (a > p && a < 1e9) p = a;
      }
      m.peak = p;
    }
    L.fill(0, 0, n);
    R.fill(0, 0, n);
    for (const e of this.outEdges) this.mix(e, L, R, n);
    pk = this.peakOut;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > pk) pk = a;
    }
    this.peakOut = pk;
    this.clock += n;
    if (!ctx.playing) this.freeTick += n / spt;
  }

  reset(): void {
    this.inF.length = this.inK.length = this.inV.length = this.inO.length = this.inC.length = this.inP.length = this.inS.length = 0;
    this.srcs.releaseAll();
    for (const m of this.nodes.values()) { m.fx.reset(); m.L.fill(0); m.R.fill(0); m.peak = 0; m.vfx?.reset(); }
    for (const e of this.edges.values()) { e.g0 = e.gain; if (e.dl) { e.dl.fill(0); e.dr!.fill(0); e.pos = 0; } }
    this.peakIn = this.peakOut = 0;
  }

  sendTargets(): number[] {
    const out: number[] = [];
    for (const m of this.nodes.values()) for (const k of m.fx.sendTargets?.() ?? []) if (!out.includes(k)) out.push(k);
    return out;
  }

  /**
   * The focused module's own display data (its open editor reads it through
   * the Patcher slot), plus Patcher's activity data: per-module output peaks and
   * latencies (`__pIds` order), input / output peaks and the total latency.
   */
  /** A hosted module's own display data (its editor watches "<slot>#<module>"). */
  monitorHosted(moduleId: string): FxMonitor | null {
    const n = this.nodes.get(moduleId);
    return n?.fx.monitor?.() ?? null;
  }

  monitor(): FxMonitor {
    const out: FxMonitor = {};
    const ids: string[] = [], peaks: number[] = [], lats: number[] = [];
    for (const m of this.nodes.values()) { ids.push(m.id); peaks.push(m.peak); lats.push(m.lat); m.peak = 0; }
    out.__pIds = ids.join(',');
    out.__pPeak = peaks;
    out.__pLat = lats;
    out.__pIn = this.peakIn;
    out.__pOut = this.peakOut;
    out.__pTotal = this.lat;
    out.__pSr = this.sr;
    this.peakIn = this.peakOut = 0;
    return out;
  }
}

export const effect: EffectModule = {
  id: 'patcher',
  create: (sr, bs, env) => new Patcher(sr, bs, env),
};
