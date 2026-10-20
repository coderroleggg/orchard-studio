// Helpers for instrument (generator) tests: an engine with mixer tracks, test
// instruments that record what the channel asks of them, and render helpers.
import { Engine } from '../../src/engine/Engine';
import { registerGen } from '../../src/engine/gen';
import type { GenContext, GenInstance, GenNote, GenVoice, GenVoiceParams } from '../../src/engine/gen/types';
import { registerGenDef } from '../../src/model/gen/registry';
import type { GenPluginDef } from '../../src/model/gen/types';
import { createGenChannel, createMixerTrack, createNote, createPattern } from '../../src/model/defaults';
import type { Channel, Note, Pattern } from '../../src/model/types';
import type { FromEngine } from '../../src/engine/protocol';

export const SR = 48000;
// 120 BPM, PPQ 96: 250 samples per tick, a step (24 ticks) = 6000 samples, a beat = 24000

export function makeEngine(opts: { rendering?: boolean; post?: (m: FromEngine) => void } = {}): Engine {
  const e = new Engine({ sampleRate: SR, blockSize: 128, rendering: opts.rendering, post: opts.post });
  e.handle({ t: 'globals', g: { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: createMixerTrack(i) });
  return e;
}

/** Play a pattern with notes on the given channels (pattern mode) and render `frames`. */
export function play(e: Engine, chans: Channel[], notes: Record<string, Partial<Note>[]>, frames: number): [Float32Array, Float32Array] {
  for (const c of chans) e.handle({ t: 'channel', c });
  const pat: Pattern = createPattern(1);
  for (const [id, list] of Object.entries(notes)) pat.notes[id] = list.map((n) => createNote({ pos: 0, len: 24, ...n }));
  e.handle({ t: 'pattern', p: pat });
  e.handle({ t: 'mode', song: false, patternId: pat.id });
  e.handle({ t: 'play' });
  return e.renderOffline(frames);
}

export function rms(b: Float32Array, a = 0, z = b.length): number {
  let s = 0;
  for (let i = a; i < z; i++) s += b[i] * b[i];
  return Math.sqrt(s / Math.max(1, z - a));
}

export function peak(b: Float32Array, a = 0, z = b.length): number {
  let m = 0;
  for (let i = a; i < z; i++) m = Math.max(m, Math.abs(b[i]));
  return m;
}

export function firstNonZero(b: Float32Array, from = 0): number {
  for (let i = from; i < b.length; i++) if (Math.abs(b[i]) > 1e-9) return i;
  return -1;
}

// ------------------------------------------------------------ test 'voices' instrument
/** What a test voice saw (sample positions are counted from the voice's first sample). */
export interface VoiceLog {
  key: number;
  velocity: number;
  color: number;
  length: number;
  initPitch: number;
  initVol: number;
  initPan: number;
  /** Voice sample position of the release (-1 = none) and of the kill. */
  releasedAt: number;
  killedAt: number;
  /** Samples rendered so far. */
  pos: number;
  /** [voice position, pitch, vol, pan, fcut, fres] per render call. */
  levels: [number, number, number, number, number, number][];
}

/**
 * A DC instrument: each voice outputs a constant `level` (0.5) on both sides
 * (unity, centred: the channel applies volume and pan), records its calls,
 * and ends `releaseFrames` samples after its release.
 */
export class DcGen implements GenInstance {
  static all: DcGen[] = [];
  voices: VoiceLog[] = [];
  params: Record<string, unknown> = {};
  setCount = 0;
  constructor() { DcGen.all.push(this); }
  setParams(p: unknown): void { this.params = { ...(p as Record<string, unknown>) }; this.setCount++; }
  reset(): void {}
  triggerVoice(p: GenVoiceParams): GenVoice {
    const log: VoiceLog = {
      key: p.key, velocity: p.velocity, color: p.color, length: p.length, initPitch: p.init.pitch, initVol: p.init.vol, initPan: p.init.pan,
      releasedAt: -1, killedAt: -1, pos: 0, levels: [],
    };
    this.voices.push(log);
    const gen = this;
    let relLeft = Infinity;
    return {
      render(L, R, n) {
        log.levels.push([log.pos, p.levels.pitch, p.levels.vol, p.levels.pan, p.levels.fcut, p.levels.fres]);
        const level = Number(gen.params.level ?? 0.5);
        for (let i = 0; i < n; i++) {
          if (relLeft <= 0) return false;
          L[i] += level; R[i] += level;
          relLeft--;
          log.pos++;
        }
        return relLeft > 0;
      },
      release() { if (log.releasedAt < 0) log.releasedAt = log.pos; relLeft = Number(gen.params.releaseFrames ?? 0); },
      kill() { log.killedAt = log.pos; },
    };
  }
}

export const DC_DEF: GenPluginDef = {
  id: 'test-dc', name: 'Test DC', category: 'Synth classic', notes: 'voices', width: 200, height: 60,
  params: [
    { key: 'level', name: 'Level', index: 0, min: 0, max: 1, def: 0.5, step: 0 },
    { key: 'releaseFrames', name: 'Release', index: 1, min: 0, max: 48000, def: 0 },
  ],
  presets: [{ name: 'Loud', params: { level: 1 } }],
};

export const DC_INS_DEF: GenPluginDef = { ...DC_DEF, id: 'test-dc-ins', name: 'Test DC INS', ins: true };
export const DC_PLUGIN_LEVELS_DEF: GenPluginDef = { ...DC_DEF, id: 'test-dc-own', name: 'Test DC own levels', levels: 'plugin' };

registerGenDef(DC_DEF);
registerGenDef(DC_INS_DEF);
registerGenDef(DC_PLUGIN_LEVELS_DEF);
registerGen({ id: 'test-dc', create: () => new DcGen() });
registerGen({ id: 'test-dc-ins', create: () => new DcGen() });
registerGen({ id: 'test-dc-own', create: () => new DcGen() });

// ------------------------------------------------------------ test 'events' instrument
export type NoteEv = [string, number, number, number]; // kind, key, absolute frame, velocity

/** An 'events' instrument: logs note events at their absolute frames, sounds 0.25 per held note. */
export class EventGen implements GenInstance {
  static all: EventGen[] = [];
  events: NoteEv[] = [];
  held = new Map<number, GenNote>();
  t = 0;
  ctxs: GenContext[] = [];
  /** Always rendered, so `t` follows the engine's frames. */
  tail = Infinity;
  private pendingOn: [GenNote, number][] = [];
  private pendingOff: [GenNote, number][] = [];
  constructor() { EventGen.all.push(this); }
  setParams(): void {}
  reset(): void {}
  noteOn(note: GenNote, off: number): void { this.events.push(['on', note.key, this.t + off, note.velocity]); this.pendingOn.push([note, off]); }
  noteOff(note: GenNote, off: number): void { this.events.push(['off', note.key, this.t + off, 0]); this.pendingOff.push([note, off]); }
  killNote(note: GenNote): void { this.events.push(['kill', note.key, this.t, 0]); this.held.delete(note.id); }
  isActive(): boolean { return this.held.size > 0 || this.pendingOn.length > 0; }
  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    this.ctxs.push({ ...ctx });
    for (let i = 0; i < n; i++) {
      for (const [note, off] of this.pendingOn) if (off === i) this.held.set(note.id, note);
      for (const [note, off] of this.pendingOff) if (off === i) this.held.delete(note.id);
      const v = 0.25 * this.held.size;
      L[i] += v; R[i] += v;
    }
    this.pendingOn = []; this.pendingOff = [];
    this.t += n;
  }
}

export const EV_DEF: GenPluginDef = {
  id: 'test-ev', name: 'Test Events', category: 'Drum', notes: 'events', width: 200, height: 60, params: [],
};
registerGenDef(EV_DEF);
registerGen({ id: 'test-ev', create: () => new EventGen() });

// ------------------------------------------------------------ test controller instrument
export const CTRL_DEF: GenPluginDef = {
  id: 'test-genctl', name: 'Test Gen Controller', category: 'Controller', notes: 'voices', noAudio: true, width: 100, height: 40,
  params: [{ key: 'v', name: 'Value', index: 0, min: 0, max: 1, def: 0, step: 0 }],
  outputs: ['Out'],
};
registerGenDef(CTRL_DEF);
registerGen({
  id: 'test-genctl',
  create: () => {
    const out = new Float64Array(1);
    return { tail: Infinity, setParams(p: unknown) { out[0] = Number((p as { v?: number }).v ?? 0); }, reset() {}, controls: () => out };
  },
});

export function genChannel(plugin: string, mixerTrack = 0): Channel {
  const c = createGenChannel(plugin, undefined, mixerTrack);
  c.volume = 1;
  return c;
}
