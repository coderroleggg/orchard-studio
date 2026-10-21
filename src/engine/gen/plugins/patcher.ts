// Patcher as an instrument (engine). The effect's Patcher engine
// (src/engine/effects/plugins/patcher.ts) runs the patch; this wrapper gives it
// the instrument interface of an 'events' plugin:
// - the channel's notes (already through the channel's note handling: key range,
//   arpeggiator, echo, polyphony, glides...) arrive as noteOn / noteOff / killNote
//   with their live levels and become From FL Studio's "Notes" events, sample
//   accurately; the MIDI Out ports the patch activated ("Port p") deliver raw notes;
// - render() runs the graph for the block and adds To FL Studio's audio (an
//   instrument has no audio input: From FL Studio's audio is silence);
// - the channel keeps rendering while hosted voices sound, VFX modules still owe
//   notes, or effects after the generators ring (the longest path's tail).
// Generators inside the patch are HostedGen (src/engine/gen/hosted.ts).
// See docs/research/gen/patcher.md.

import { Patcher } from '../../effects/plugins/patcher';
import type { FxContext, FxMonitor } from '../../effects/types';
import type { InterpMode } from '../../../model/sampler';
import { genDef } from '../../../model/gen/registry';
import { setHostedGenHooks } from '../hosted';
import { createGen } from '../index';
import type { GenContext, GenEnv, GenInstance, GenModule, GenNote } from '../types';

// the instruments the patch hosts come from the registries this module is part of (called when a module is created)
setHostedGenHooks({ create: (plugin, sr, bs, env) => createGen(plugin, sr, bs, env), def: (plugin) => genDef(plugin) });

class GenPatcher implements GenInstance {
  private readonly core: Patcher;
  private readonly fctx: FxContext;
  private readonly sr: number;
  private readonly sendL: Float32Array;
  private readonly sendR: Float32Array;
  /** Frames the patch keeps ringing after its last note (effect tails behind the generators). */
  private ring = 0;
  /** This block's GenContext.out (routing modules' sends reach other mixer tracks through it). */
  private out: GenContext['out'];

  constructor(sampleRate: number, blockSize: number, env: GenEnv) {
    this.sr = sampleRate;
    this.core = new Patcher(sampleRate, blockSize, env);
    this.sendL = new Float32Array(blockSize);
    this.sendR = new Float32Array(blockSize);
    this.fctx = {
      sampleRate, blockSize, tempo: 120, ppq: 96, playing: false, pos: 0, songMode: false, track: 0, sidechain: [],
      sendTo: (track, L, R, n, gl, gr) => {
        const out = this.out;
        if (!out) return;
        const bl = this.sendL, br = this.sendR;
        for (let i = 0; i < n; i++) { bl[i] = L[i] * gl; br[i] = R[i] * gr; }
        out(track, bl, br, n);
      },
    };
  }

  setParams(p: unknown): void { this.core.setParams(p); }

  reset(): void {
    this.core.reset();
    this.ring = 0;
  }

  noteOn(note: GenNote, frameOffset: number): void { this.core.channelNoteOn(note, frameOffset); }

  noteOff(note: GenNote, frameOffset: number): void { this.core.channelNoteOff(note, frameOffset); }

  killNote(note: GenNote): void { this.core.channelNoteKill(note); }

  allNotesOff(): void { this.core.allNotesOff(); }

  setMaxPoly(n: number): void { this.core.setMaxPoly(n); }

  setInterpolation(mode: InterpMode): void { this.core.setInterpolation(mode); }

  isActive(): boolean { return this.core.busy() || this.ring > 0; }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    const f = this.fctx;
    f.tempo = ctx.tempo; f.ppq = ctx.ppq; f.playing = ctx.playing; f.pos = ctx.pos; f.songMode = ctx.songMode; f.track = ctx.track;
    f.rendering = ctx.rendering;
    this.out = ctx.out;
    this.core.process(L, R, n, f);
    if (this.core.busy()) {
      const t = this.core.tail;
      this.ring = t === Infinity ? Infinity : Math.ceil(t * this.sr);
    } else if (this.ring > 0 && this.ring !== Infinity) this.ring = Math.max(0, this.ring - n);
  }

  monitor(): FxMonitor | null { return this.core.monitor(); }

  monitorHosted(moduleId: string): FxMonitor | null { return this.core.monitorHosted(moduleId); }

  takeStateChanges(): [string, unknown][] | null { return this.core.takeStateChanges(); }

  midiPorts(): readonly number[] { return this.core.midiPorts(); }

  portNote(on: boolean, key: number, velocity: number, frame: number, port: number, channel: number): void {
    if (on) this.core.noteOn(key, velocity, frame, port, channel);
    else this.core.noteOff(key, frame, port, channel);
  }
}

export const gen: GenModule = {
  id: 'patcher',
  create: (sr, bs, env) => new GenPatcher(sr, bs, env),
};
