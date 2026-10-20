// Harmless (FL: Harmless): FL's additive synthesizer, an 'events' instrument
// like FL's own (TriggerVoice + Gen_Render: the plugin keeps its voices, mono /
// legato / porta, unison and stealing, and mixes them with its global effects).
// The engine core (./harmless/core.ts) is a port of FL 2026's
// Harmless_x64.dylib; this module feeds it notes at their sample, the state
// and the tempo. See docs/research/gen/harmless.md.

import type { GenContext, GenEnv, GenInstance, GenModule, GenNote } from '../types';
import { HL_KEYS } from '../../../model/gen/plugins/harmless/params';
import { HL_EXTRAS, CUSTOM_N } from '../../../model/gen/plugins/harmless/state';
import { HL_BASE_EXTRAS, HL_BASE_PARAMS } from '../../../model/gen/plugins/harmless/presets';
import { HlCore, flVelocity, type HlNoteLevels } from './harmless/core';
import { f32 } from './harmless/fl';
import { HlFx } from './harmless/fx';

const MAX_EVENTS = 256;

interface Held { note: GenNote; lv: HlNoteLevels; released: boolean }

class HarmlessInstance implements GenInstance {
  private readonly core: HlCore;
  private readonly fx: HlFx;
  private readonly env: GenEnv;
  private readonly P = new Int32Array(100);
  private readonly ex = { filterType: 4, resType: 0, phaserType: 0, compType: 0, timbre: 0, threaded: 1, quality: 0 };
  private custom: Float32Array | null = null;
  private customId: string | null = null;
  private velVol = true;
  /** Note events of the next render() call: kind 0 on, 1 off; frame; note. */
  private readonly evKind = new Int8Array(MAX_EVENTS);
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private nEv = 0;
  private readonly held = new Map<number, Held>();
  tail = Infinity;

  constructor(sr: number, blockSize: number, env: GenEnv) {
    this.env = env;
    this.core = new HlCore(sr, Math.max(blockSize, 512), 0x12bd6aa);
    this.fx = new HlFx(sr, Math.max(blockSize, 512));
    this.P.set(HL_BASE_PARAMS);
    this.core.setState(this.P, this.ex, null);
  }

  setParams(p: unknown): void {
    const s = (p ?? {}) as Record<string, unknown>;
    for (let i = 0; i < 100; i++) {
      const v = Number(s[HL_KEYS[i]]);
      this.P[i] = Number.isFinite(v) ? Math.round(v) : HL_BASE_PARAMS[i];
    }
    const e = this.ex as Record<string, number>;
    HL_EXTRAS.forEach((d, i) => {
      const v = Number(s[d.key]);
      e[d.key] = Number.isFinite(v) ? Math.max(0, Math.min(d.max, Math.round(v))) : HL_BASE_EXTRAS[i];
    });
    const id = typeof s.customSample === 'string' ? s.customSample : null;
    if (id !== this.customId) {
      this.customId = id;
      this.custom = null;
      const smp = id ? this.env.sample(id) : undefined;
      const ch = smp?.channels[0];
      if (ch && ch.length >= CUSTOM_N * 2) this.custom = Float32Array.from(ch.subarray(0, CUSTOM_N * 2));
    }
    this.velVol = this.P[37] !== 0;
    this.core.setState(this.P, this.ex, this.custom);
    this.fx.setParams(this.P, this.ex.compType);
    this.tail = Infinity;
  }

  reset(): void {
    this.core.allNotesOff();
    this.held.clear();
    this.nEv = 0;
    this.fx.reset();
  }

  noteOn(note: GenNote, frameOffset: number): void { this.push(0, note, frameOffset); }
  noteOff(note: GenNote, frameOffset: number): void { this.push(1, note, frameOffset); }

  killNote(note: GenNote): void {
    this.core.kill(note.id);
    this.held.delete(note.id);
  }

  /**
   * FL calls Gen_Render every block whether or not a note plays, so Harmless's free-running phases (phaser
   * motion, global LFO, vibrato, tremolo, the phase-randomness counter, the chorus LFOs) keep moving through
   * silences: the instance stays active (tail = Infinity).
   */
  isActive(): boolean {
    return true;
  }

  setMaxPoly(n: number): void {
    this.core.maxPoly = n > 0 ? n : 0;
  }

  allNotesOff(): void {
    this.core.allNotesOff();
    this.held.clear();
    this.nEv = 0;
  }

  private push(kind: number, note: GenNote, frame: number): void {
    if (this.nEv >= MAX_EVENTS) return;
    const n = this.nEv++;
    let at = n;
    while (at > 0 && this.evFrame[at - 1] > frame) at--;
    if (kind === 1) {
      // at the same sample a note off goes before other notes' note ons, as in FL (touching notes do not overlap for
      // legato / porta), whatever order the channel's voice slots send them in; never before its own note on
      let j = at;
      while (j > 0 && this.evFrame[j - 1] === frame && this.evNote[j - 1] !== note) j--;
      while (j < at && this.evKind[j] !== 0) j++;
      at = j;
    }
    for (let i = n; i > at; i--) {
      this.evKind[i] = this.evKind[i - 1]; this.evFrame[i] = this.evFrame[i - 1]; this.evNote[i] = this.evNote[i - 1];
    }
    this.evKind[at] = kind; this.evFrame[at] = frame; this.evNote[at] = note;
  }

  /** FL's FinalLevels of a held note (velocity linked when "Velocity to volume" is on). */
  private levels(h: Held): void {
    const n = h.note, lv = h.lv;
    lv.pan = f32(n.levels.pan);
    lv.vol = this.velVol ? f32(f32(n.init.vol) * f32(n.levels.vol)) : f32(n.levels.vol);
    lv.pitch = f32(n.levels.pitch - 6000);
    lv.fcut = f32(n.levels.fcut);
    lv.fres = f32(n.levels.fres);
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    this.core.setTempo(ctx.tempo);
    this.fx.setTempo(ctx.tempo);
    for (const h of this.held.values()) if (!h.released) this.levels(h);
    let pos = 0, e = 0;
    while (pos < n) {
      while (e < this.nEv && this.evFrame[e] <= pos) this.event(e++);
      let end = n;
      if (e < this.nEv && this.evFrame[e] < end) end = this.evFrame[e];
      if (end > pos) this.block(L, R, pos, end - pos);
      pos = end;
    }
    while (e < this.nEv) this.event(e++);
    for (let i = 0; i < this.nEv; i++) this.evNote[i] = null;
    this.nEv = 0;
  }

  private event(i: number): void {
    const note = this.evNote[i]!;
    if (this.evKind[i] === 0) {
      const h: Held = { note, lv: { pan: 0, vol: 1, pitch: 0, fcut: 0, fres: 0 }, released: false };
      this.levels(h);
      this.held.set(note.id, h);
      // FPV_GetVelocity: FL hands back the velocity through its velocity law (InitLevels.Vol)
      this.core.trigger(note.id, note.color & 15, flVelocity(note.init.vol), h.lv);
    } else {
      const h = this.held.get(note.id);
      if (h) { this.levels(h); h.released = true; this.held.delete(note.id); }
      this.core.release(note.id, f32(note.release / 128));
    }
  }

  private block(L: Float32Array, R: Float32Array, off: number, n: number): void {
    const voices = this.core.voiceCount > 0; // FL tests its voice list before the voices render
    const mix = this.core.render(n);
    this.fx.process(mix, n, voices);
    for (let i = 0; i < n; i++) {
      L[off + i] += mix[2 * i];
      R[off + i] += mix[2 * i + 1];
    }
  }

  monitor() {
    const keys: number[] = [];
    for (const h of this.held.values()) if (!keys.includes(h.note.key)) keys.push(h.note.key);
    return { voices: this.core.voiceCount, keys };
  }
}

export const gen: GenModule = {
  id: 'harmless',
  create: (sr, bs, env) => new HarmlessInstance(sr, bs, env),
};
