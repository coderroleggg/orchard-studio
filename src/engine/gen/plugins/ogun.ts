// Ogun (FL: Ogun): Didier Dambrin's additive "pad harmonics" synthesizer, a port of Ogun_x64.dylib (FL 2026, arm64) by
// static analysis and test-host measurements (./ogun/, docs/research/gen/ogun.md). Voices render the timbre (FftOsc), the
// filter and the articulators into the plugin's mix; render() runs the summed voices through the plugin's effects (3-band EQ,
// chorus, delay, reverb, halfband downsampler: ./ogun/fx.ts) and adds the result to the channel's buffers.

import type { GenContext, GenEnv, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import type { FxParams } from '../../../model/fx/types';
import { OgunPlug } from './ogun/plug';
import { OgunVoice } from './ogun/voice';

export class OgunInstance implements GenInstance {
  readonly plug = new OgunPlug();
  private voices: OgunVoice[] = [];
  private maxPoly = 0;
  /**
   * Autogun: its Soundgoodizer runs on every chunk of the effects' output (interleaved L / R, `frames` frames) in place, after the
   * halfband and before the sum is added to the channel (the end of FL's Gen_Render, Autogun_x64 0x6d9a0).
   */
  postFx: ((buf: Float32Array, frames: number) => void) | null = null;

  constructor(sampleRate: number, blockSize: number, _env?: GenEnv) {
    this.plug.setSampleRate(sampleRate);
    this.plug.setBlockSize(blockSize);
  }

  /** Seconds the effects keep sounding after the last voice (Infinity while the delay or the reverb run). */
  get tail(): number {
    return this.plug.fx.tailSeconds();
  }

  /**
   * The counter FL's Ogun hashes into a random timbre seed (timbre seed 2 = 0): FPC's RandSeed at load, the clock in seconds, then one
   * more per note. Tests set it to reproduce a host render made with a fixed clock.
   */
  setRandomCounter(n: number): void {
    this.plug.counter = n | 0;
  }

  setParams(p: unknown): void {
    this.plug.apply(p as FxParams);
  }

  /** FPE_MaxPoly (plug+0xe4): at the limit, a new note ends the newest sounding voice (0x6e02c). */
  setMaxPoly(n: number): void {
    this.maxPoly = n > 0 ? n | 0 : 0;
  }

  reset(): void {
    this.plug.lastPitch = null;
    this.voices.length = 0;
    this.plug.fx.reset();
    this.plug.mix.fill(0);
  }

  triggerVoice(params: GenVoiceParams, ctx?: GenContext): GenVoice | null {
    const pl = this.plug;
    if (ctx) { pl.setRendering(!!ctx.rendering); pl.setTempo(ctx.tempo); }
    // FL's voice list holds the voices not yet removed (state < 10); finished ones are only dropped after the block's mix
    if (this.maxPoly > 0) {
      let listed = 0, alive = 0, last: OgunVoice | null = null;
      for (const o of this.voices) {
        if (o.state < 10) listed++;
        if (o.state < 9) { alive++; last = o; }
      }
      if (listed >= this.maxPoly && !(this.maxPoly > alive) && last) last.force();
    }
    const v = new OgunVoice(pl, params);
    if (pl.oneVoicePerKey) {
      for (const o of this.voices) if (o.key === v.key && o.state < 9) o.force();
    }
    this.voices.push(v);
    return v;
  }

  /** Gen_Render's second half: the voices' mix through the effects, added to the channel's L / R. */
  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    const pl = this.plug;
    if (ctx) { pl.setRendering(!!ctx.rendering); pl.setTempo(ctx.tempo); }
    const os = pl.os;
    const fx = pl.fx;
    pl.ensureMix(n * os);
    // the voices' mix, newest voice first (the order of FL's voice loop, which matters for float addition)
    const mix = pl.mix, total = 2 * n * os;
    for (let k = this.voices.length - 1; k >= 0; k--) {
      const o = this.voices[k].out;
      const m = o.length < total ? o.length : total;
      for (let j = 0; j < m; j++) mix[j] = mix[j] + o[j];
      o.fill(0, 0, m);
    }
    // the voice list at the start of FL's Gen_Render decides whether the effects' input tail is reloaded
    const active = this.voices.length > 0;
    const mode = pl.pi[30];
    let done = 0;
    while (done < n) {
      const m = Math.min(n - done, pl.block);
      const got = fx.process(pl.mix, 2 * done * os, m * os, active, mode);
      const o = fx.out();
      if (this.postFx) this.postFx(o, got);
      for (let i = 0; i < got; i++) {
        L[done + i] += o[2 * i];
        R[done + i] += o[2 * i + 1];
      }
      done += m;
    }
    if (this.voices.length) this.voices = this.voices.filter((o) => o.state < 10);
  }
}

export const gen: GenModule = { id: 'ogun', create: (sr, bs, env) => new OgunInstance(sr, bs, env) };
