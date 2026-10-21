// Instruments hosted inside Patcher (modules with a 'g' id, docs/research/gen/patcher.md).
//
// A hosted instrument plays the notes that reach its "Notes" input as voices of
// its own, the way a channel of its own would (src/engine/GenChannel.ts), minus
// what the channel owns: the MISC / INS tabs, which stay with the Patcher
// channel (INS envelopes, LFOs and filter of legacy generators such as 3x Osc are
// not applied inside Patcher). The voice levels come from the note:
// - a note of the Patcher channel (From FL Studio's "Notes") carries the channel's
//   live levels (NoteSrcPool: volume, panning, pitch, Mod X / Y of the channel
//   note, updated every block while it is held), so channel volume / pan / pitch
//   knobs, bends and slides reach the hosted voices; a VFX module in between may
//   change the key (the pitch follows) and the velocity (the volume follows);
// - a note without a source (a MIDI Out port's, or any note inside an effect
//   slot's Patcher) plays at unity channel volume, centred, with the root key at C5.
// Voices of 'voices' instruments are rendered exactly like the channel does it:
// control steps of 16 samples from the voice's first sample, volume and FL's
// circular pan law ramped per step unless the plugin applies its levels itself,
// the 10 ms declick of forced stops; 'events' instruments get note on / off /
// kill events with their levels (once per block) and render all voices in render().
//
// HostedGen is an EffectInstance so the Patcher engine (effects/plugins/patcher.ts)
// runs it like any module: its input is silence, its output the voices' sum.
// The instrument registries reach it through setHostedGenHooks (called by the
// instrument version of Patcher, src/engine/gen/plugins/patcher.ts), so the
// effect engine does not load every instrument with it.

import type { GenPluginDef } from '../../model/gen/types';
import { velocityGain, type InterpMode } from '../../model/sampler';
import type { EffectInstance, FxContext, FxMonitor } from '../effects/types';
import { PITCH_C5, newLevels, type GenLevels } from './levels';
import type { GenContext, GenEnv, GenInstance, GenNote, GenVoice } from './types';

/** The instrument registries (engine and definitions) a hosted instrument is made from. */
export interface HostedGenHooks {
  create(plugin: string, sampleRate: number, blockSize: number, env: GenEnv): GenInstance | null;
  def(plugin: string): GenPluginDef | undefined;
}

let hooks: HostedGenHooks | null = null;

/** Hand over the instrument registries (once, when the instrument modules load); without them hosted instruments are silent. */
export function setHostedGenHooks(h: HostedGenHooks): void {
  hooks = h;
}

/** The channel's control rate (InstrumentChannel CTRL): voices render in steps of this many samples. */
const CTRL = 16;
/** Voices per hosted instrument (the channel holds 128). */
const MAX_VOICES = 128;
/** The channel's declick of forced stops (GenChannel STOP_FADE_MS), ms. */
const STOP_FADE_MS = 10;
/** Channel notes tracked at once (held ones are never recycled). */
const SRC_MAX = 512;

function copyLevels(to: GenLevels, from: GenLevels): void {
  to.pan = from.pan; to.vol = from.vol; to.pitch = from.pitch; to.fcut = from.fcut; to.fres = from.fres;
}

// ------------------------------------------------------------- channel notes

/** A note of the Patcher channel whose live levels hosted voices follow while it is held. */
export class NoteSrc {
  /** The channel note's id (0 = free). */
  id = 0;
  held = false;
  /** The channel's note object while held (its `levels` are updated by the channel every block). */
  ref: GenNote | null = null;
  key = 60;
  velocity = 100;
  release = 64;
  color = 0;
  length = Infinity;
  readonly init = newLevels();
  readonly levels = newLevels();

  /** Take over the channel note's current levels. */
  copy(): void {
    const r = this.ref;
    if (r) copyLevels(this.levels, r.levels);
  }
}

/**
 * The channel notes in flight: a ring that skips held entries, so a held note
 * keeps its entry however many notes follow. Event lists carry an entry's index.
 */
export class NoteSrcPool {
  readonly srcs: NoteSrc[] = [];
  private next = 0;
  private held = 0;

  constructor() {
    for (let i = 0; i < SRC_MAX; i++) this.srcs.push(new NoteSrc());
  }

  /** A channel note starts: its entry's index (-1 when every entry is held: the note plays without source levels). */
  start(note: GenNote): number {
    const n = this.srcs.length;
    for (let k = 0; k < n; k++) {
      const i = (this.next + k) % n;
      const s = this.srcs[i];
      if (s.held) continue;
      this.next = (i + 1) % n;
      s.id = note.id;
      s.held = true;
      s.ref = note;
      s.key = note.key; s.velocity = note.velocity; s.release = note.release; s.color = note.color; s.length = note.length;
      copyLevels(s.init, note.init);
      copyLevels(s.levels, note.levels);
      this.held++;
      return i;
    }
    return -1;
  }

  /** The entry of a held channel note, by the note's id (-1: none). */
  find(id: number): number {
    if (this.held === 0) return -1;
    for (let i = 0; i < this.srcs.length; i++) if (this.srcs[i].held && this.srcs[i].id === id) return i;
    return -1;
  }

  /** The note ends (or is killed): its levels freeze at their last values. */
  release(i: number): void {
    const s = i >= 0 ? this.srcs[i] : undefined;
    if (!s || !s.held) return;
    s.copy();
    s.held = false;
    s.ref = null;
    this.held--;
  }

  releaseAll(): void {
    for (let i = 0; i < this.srcs.length; i++) this.release(i);
  }

  /** Once per block, after the channel updated its notes' levels. */
  refresh(): void {
    if (this.held === 0) return;
    for (const s of this.srcs) if (s.held) s.copy();
  }
}

// ----------------------------------------------------------------- the host

/** A hosted voice: the channel-voice state of GenChannel plus the GenNote the plugin sees. */
class HVoice implements GenNote {
  // GenNote / GenVoiceParams
  id = 0;
  key = 60;
  velocity = 100;
  release = 64;
  color = 0;
  length = Infinity;
  frame = 0;
  readonly init: GenLevels = newLevels();
  readonly levels: GenLevels = newLevels();
  // voice state
  active = false;
  started = false;
  /** 'events' instruments: note on sent / note off or kill sent. */
  on = false;
  off = false;
  delay = 0;
  untilRelease = Infinity;
  released = false;
  stopping = false;
  stopAt = 0;
  stopGain = 1;
  stopStep = 0;
  age = 0;
  gv: GenVoice | null = null;
  /** Event key / MIDI channel / source (NoteSrcPool index and the id it had). */
  evKey = 60;
  chan = 1;
  src = -1;
  srcId = 0;
  /** Event velocity (FL 0..128) and its law. */
  vel = 100;
  velGain = 1;
  /** The current block's gain (velocity x channel part) and pan gains, ramped per control step. */
  amp = 1;
  panLg = Math.SQRT1_2;
  panRg = Math.SQRT1_2;
  gain = NaN;
  panL = NaN;
  panR = NaN;
}

/** The note events of one block, as the Patcher engine keeps them (EvList). */
export interface HostedEvents {
  n: number;
  f: Int32Array;
  k: Int16Array;
  v: Float32Array;
  o: Uint8Array;
  c: Uint8Array;
  s: Int32Array;
}

export class HostedGen implements EffectInstance {
  private readonly inst: GenInstance | null;
  private readonly def: GenPluginDef | undefined;
  private readonly events: boolean;
  private readonly channelLevels: boolean;
  private readonly velocityPlugin: boolean;
  private readonly sr: number;
  private readonly voices: HVoice[] = [];
  private readonly vL: Float32Array;
  private readonly vR: Float32Array;
  private readonly gctx: GenContext;
  private ageCounter = 0;
  private noteIds = 0;

  constructor(plugin: string, sampleRate: number, blockSize: number, env: GenEnv, private readonly pool: NoteSrcPool) {
    this.sr = sampleRate;
    this.def = hooks?.def(plugin);
    this.inst = hooks?.create(plugin, sampleRate, blockSize, env) ?? null;
    this.events = this.def?.notes === 'events';
    this.channelLevels = this.def?.levels !== 'plugin';
    this.velocityPlugin = this.def?.velocity === 'plugin';
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new HVoice());
    this.vL = new Float32Array(CTRL);
    this.vR = new Float32Array(CTRL);
    this.gctx = { sampleRate, blockSize, tempo: 120, ppq: 96, playing: false, pos: 0, songMode: false, track: 0 };
  }

  get tail(): number { return this.inst?.tail ?? 0; }
  get latency(): number { return this.inst?.latency ?? 0; }

  setParams(p: unknown): void {
    this.inst?.setParams(p);
  }

  setMaxPoly(n: number): void {
    this.inst?.setMaxPoly?.(n);
  }

  setInterpolation(mode: InterpMode): void {
    this.inst?.setInterpolation?.(mode);
  }

  reset(): void {
    for (const v of this.voices) if (v.active) this.endVoice(v);
    this.inst?.reset();
  }

  /** Panic / a changed patch: the voices stop with the declick fade and the plugin forgets its notes. */
  allNotesOff(): void {
    for (const v of this.voices) if (v.active) this.forceStop(v, 0, true);
    this.inst?.allNotesOff?.();
  }

  /** Voices sound (or an 'events' instrument still plays its own). */
  busy(): boolean {
    for (const v of this.voices) if (v.active) return true;
    return this.events && !!this.inst?.isActive?.();
  }

  monitor(): FxMonitor | null {
    const d = this.inst?.monitor?.() ?? null;
    if (d) d.__active = this.busy();
    return d;
  }

  takeStateChanges(): [string, unknown][] | null {
    return this.inst?.takeStateChanges?.() ?? null;
  }

  // ------------------------------------------------------------------ notes
  /** This block's note events (time order, note offs first at a frame). */
  hostEvents(ev: HostedEvents): void {
    if (!this.inst) return;
    for (let i = 0; i < ev.n; i++) {
      if (ev.o[i]) this.start(ev.k[i], ev.v[i], ev.c[i], ev.s[i], ev.f[i]);
      else this.release(ev.k[i], ev.c[i], ev.s[i], ev.f[i]);
    }
  }

  /** The channel note `src` is stopped at once (polyphony limit, panic). */
  killSrc(src: number): void {
    for (const v of this.voices) if (v.active && v.src === src) this.forceStop(v, 0, false);
  }

  private alloc(): HVoice {
    for (const v of this.voices) if (!v.active) return v;
    let oldest = this.voices[0];
    for (const v of this.voices) if (v.age < oldest.age) oldest = v;
    this.endVoice(oldest);
    return oldest;
  }

  private start(key: number, vel: number, chan: number, src: number, frame: number): void {
    const v = this.alloc();
    const s = src >= 0 ? this.pool.srcs[src] : undefined;
    v.active = true;
    v.started = false;
    v.on = false;
    v.off = false;
    v.delay = Math.max(0, frame);
    v.untilRelease = Infinity;
    v.released = false;
    v.stopping = false;
    v.stopGain = 1;
    v.age = ++this.ageCounter;
    v.gv = null;
    v.gain = NaN; v.panL = NaN; v.panR = NaN;
    v.id = ++this.noteIds;
    v.evKey = key;
    v.key = key;
    v.chan = chan;
    v.color = Math.max(0, Math.min(15, chan - 1));
    v.src = s ? src : -1;
    v.srcId = s ? s.id : 0;
    v.vel = vel;
    v.velocity = vel;
    v.velGain = velocityGain(vel);
    v.release = s ? s.release : 64;
    v.length = s ? s.length : Infinity;
    this.follow(v);
  }

  private release(key: number, chan: number, src: number, frame: number): void {
    for (const v of this.voices) {
      // like the channel's noteOffAt: every sounding voice of the key (and source) is released
      if (v.active && !v.released && !v.stopping && v.evKey === key && v.chan === chan && v.src === src) v.untilRelease = Math.min(v.untilRelease, frame);
    }
  }

  /**
   * The voice's levels for this block from its note's source (live while the
   * channel note is held, frozen after) or the neutral defaults.
   */
  private follow(v: HVoice): void {
    const lv = v.levels, ini = v.init;
    const s = v.src >= 0 ? this.pool.srcs[v.src] : undefined;
    // a source entry recycled for a later note (a release tail outliving 500 notes): the levels stay as they were
    if (v.src >= 0 && (!s || s.id !== v.srcId)) return;
    let amp: number;
    let pan: number;
    if (s) {
      const dk = (v.evKey - s.key) * 100;
      // final volume = velocity law x the channel's part; an unchanged velocity keeps the channel's value as is
      amp = v.vel === s.velocity ? s.levels.vol : s.init.vol > 1e-9 ? (s.levels.vol / s.init.vol) * v.velGain : 0;
      pan = s.levels.pan;
      lv.pitch = s.levels.pitch + dk;
      lv.fcut = s.levels.fcut; lv.fres = s.levels.fres;
      ini.pitch = s.init.pitch + dk;
      ini.pan = s.init.pan; ini.fcut = s.init.fcut; ini.fres = s.init.fres;
    } else {
      amp = v.velGain;
      pan = 0;
      lv.pitch = PITCH_C5 + (v.evKey - 60) * 100;
      lv.fcut = 0; lv.fres = 0;
      ini.pitch = lv.pitch;
      ini.pan = 0; ini.fcut = 0; ini.fres = 0;
    }
    ini.vol = v.velGain;
    // a plugin that handles velocity itself gets only the channel's part of the volume (GenChannel.updateLevels)
    lv.vol = this.velocityPlugin ? (v.velGain > 1e-9 ? amp / v.velGain : 0) : amp;
    pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    lv.pan = pan;
    v.amp = amp;
    const th = (pan + 1) * Math.PI / 4;
    v.panLg = Math.cos(th);
    v.panRg = Math.sin(th);
  }

  // ----------------------------------------------------------------- render
  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const inst = this.inst;
    if (!inst) return;
    const g = this.gctx;
    g.tempo = ctx.tempo; g.ppq = ctx.ppq; g.playing = ctx.playing; g.pos = ctx.pos; g.songMode = ctx.songMode; g.track = ctx.track;
    g.rendering = ctx.rendering;
    for (const v of this.voices) {
      if (!v.active) continue;
      if (v.src >= 0) this.follow(v); // a note with a source follows its live levels; others keep the levels they started with
      if (this.events) this.runNote(v, n);
      else this.renderVoice(v, L, R, n);
    }
    inst.render?.(L, R, n, g);
  }

  private endVoice(v: HVoice): void {
    if (v.gv) { v.gv.kill(); v.gv = null; }
    if (this.events && v.on && !v.off) {
      v.off = true;
      if (this.inst?.killNote) this.inst.killNote(v); else this.inst?.noteOff?.(v, 0);
    }
    v.active = false;
  }

  /** Stop a voice with the declick fade, `atFrame` frames from now (GenChannel / InstrumentChannel.forceStop). */
  private forceStop(v: HVoice, atFrame: number, fast: boolean): void {
    if (!v.active || v.stopping) return;
    if (v.delay > atFrame) { this.endVoice(v); return; } // never started
    const ms = fast ? 4 : STOP_FADE_MS;
    v.stopping = true;
    v.stopAt = Math.max(0, atFrame - v.delay);
    v.stopGain = 1;
    v.stopStep = 1 / Math.max(1, (ms / 1000) * this.sr);
  }

  /** GenChannel.renderVoice without the INS tab: the plugin voice in control steps, then volume and pan. */
  private renderVoice(v: HVoice, outL: Float32Array, outR: Float32Array, n: number): void {
    const inst = this.inst!;
    let i = 0;
    if (v.delay > 0) {
      const d = Math.min(v.delay, n);
      v.delay -= d;
      i = d;
      if (v.untilRelease !== Infinity) v.untilRelease -= d;
      if (i >= n) return;
    }
    const vl = this.vL, vr = this.vR;
    const lv = this.channelLevels;
    while (i < n) {
      let chunk = Math.min(CTRL, n - i);
      v.frame = i;
      // note off: the plugin voice's release (FL's Voice_Release)
      if (!v.released && v.untilRelease !== Infinity) {
        if (v.untilRelease <= 0) {
          v.released = true;
          v.gv?.release();
        } else if (v.untilRelease < chunk) chunk = Math.max(1, Math.floor(v.untilRelease));
      }
      let stopping = false;
      if (v.stopping) {
        if (v.stopAt > 0) { if (v.stopAt < chunk) chunk = v.stopAt; }
        else stopping = true;
      }
      if (!v.started) {
        v.started = true;
        v.gv = inst.triggerVoice?.(v, this.gctx) ?? null;
        if (v.gv && v.released) v.gv.release();
      }
      const gv = v.gv;
      if (!gv) { this.endVoice(v); return; }
      vl.fill(0, 0, chunk);
      vr.fill(0, 0, chunk);
      const alive = gv.render(vl, vr, chunk);
      const pL = lv ? v.panLg : 1, pR = lv ? v.panRg : 1;
      const a1 = lv ? v.amp : 1;
      const a0 = Number.isNaN(v.gain) ? a1 : v.gain;
      const da = (a1 - a0) / chunk;
      const pl0 = Number.isNaN(v.panL) ? pL : v.panL, pr0 = Number.isNaN(v.panR) ? pR : v.panR;
      const dpl = (pL - pl0) / chunk, dpr = (pR - pr0) / chunk;
      let ended = false;
      for (let k = 0; k < chunk; k++) {
        let gain = a0 + da * k;
        if (stopping) {
          gain *= 0.5 + 0.5 * Math.cos(Math.PI * (1 - v.stopGain));
          v.stopGain -= v.stopStep;
          if (v.stopGain <= 0) ended = true;
        }
        const j = i + k;
        outL[j] += vl[k] * gain * (pl0 + dpl * k);
        outR[j] += vr[k] * gain * (pr0 + dpr * k);
        if (ended) break;
      }
      v.gain = a1;
      v.panL = pL; v.panR = pR;
      if (v.untilRelease !== Infinity) v.untilRelease -= chunk;
      if (v.stopping && v.stopAt > 0) v.stopAt -= chunk;
      i += chunk;
      if (ended || !alive) { this.endVoice(v); return; }
    }
  }

  /** GenChannel.runNote: an 'events' instrument gets the voice's note on, off and kill at their samples. */
  private runNote(v: HVoice, n: number): void {
    const inst = this.inst!;
    let i = 0;
    if (v.delay > 0) {
      const d = Math.min(v.delay, n);
      v.delay -= d;
      i = d;
      if (v.untilRelease !== Infinity) v.untilRelease -= d;
      if (i >= n) return;
    }
    const left = n - i;
    v.frame = i;
    if (!v.started) {
      v.started = true;
      v.on = true;
      inst.noteOn?.(v, i);
    }
    // forced stop: the note is killed at its sample
    if (v.stopping) {
      if (v.stopAt < left) {
        v.off = true;
        if (inst.killNote) inst.killNote(v); else inst.noteOff?.(v, i + Math.max(0, v.stopAt));
        v.active = false;
        return;
      }
      v.stopAt -= left;
    }
    if (!v.released && v.untilRelease !== Infinity) {
      if (v.untilRelease < left) {
        v.released = true;
        v.off = true;
        inst.noteOff?.(v, i + Math.max(0, Math.floor(v.untilRelease)));
        // the plugin plays the release; the voice slot is free
        v.active = false;
        return;
      }
      v.untilRelease -= left;
    }
  }
}
