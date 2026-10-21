// Autogun (FL: Autogun): Ogun's engine (ogun.ts: voices, effects) playing the patch generated from the state's preset counter, its
// output run through the Soundgoodizer FL hosts in the plugin ("magic dust"). FL's Gen_Render (Autogun_x64 0x6d9a0) is Ogun's with
// one addition at its end: while the magic dust (plug+0x238) is above 0, the hosted SGv2 (Shared/SGv2_x64.dylib, the Maximus
// engine, loaded with Data/SG.dat) processes each chunk of the plugin's output in place, after the effects and before the sum is
// added to the channel. The dust is forwarded to SGv2 parameter 5, the mix of the three bands (SGSliderChange, ProcessParam(5, dust)).
// The SGv2 engine is Harmor's port (harmor/fx-comp-sg.ts); its state is autogun/sgdata.ts.

import type { GenContext, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import type { FxParams } from '../../../model/fx/types';
import { autogunPatch, normalizeAutogun, ogunStateOf } from '../../../model/gen/plugins/autogun/state';
import { OgunInstance } from './ogun';
import { SgEngine } from './harmor/fx-comp-sg';
import { AUTOGUN_SG } from './autogun/sgdata';

/** Seconds the Soundgoodizer keeps sounding after its input fell silent: its silence gate (1.5 s plus its latency) then resets it. */
const SG_TAIL = 1.6;

export class AutogunInstance implements GenInstance {
  /** Ogun's engine (the voices, the effects). */
  readonly og: OgunInstance;
  private readonly sg: SgEngine;
  private readonly maxBlock: number;
  private dust = 0;
  private lastDust = -1;
  private n = -1;
  private base: FxParams | null = null;

  constructor(sampleRate: number, blockSize: number, env?: import('../types').GenEnv) {
    this.og = new OgunInstance(sampleRate, blockSize, env);
    this.og.plug.masterScale = 0.25;
    this.maxBlock = Math.max(1, blockSize | 0);
    this.sg = new SgEngine(sampleRate, this.maxBlock);
    this.sg.load(AUTOGUN_SG);
    this.og.postFx = (buf, frames) => this.soundgoodize(buf, frames);
  }

  /** Seconds the plugin keeps sounding after its last voice (Infinity while Ogun's delay or reverb run). */
  get tail(): number {
    const t = this.og.tail;
    return this.dust > 0 && t < SG_TAIL ? SG_TAIL : t;
  }

  /** The counter Ogun hashes into a random timbre seed (see OgunInstance.setRandomCounter). */
  setRandomCounter(n: number): void {
    this.og.setRandomCounter(n);
  }

  setParams(p: unknown): void {
    const raw = normalizeAutogun((p ?? {}) as FxParams);
    // the generated patch is kept while the preset counter stays (a generation takes tens of milliseconds)
    if (!this.base || raw.n !== this.n) {
      this.base = autogunPatch(raw.n as number);
      this.n = raw.n as number;
    }
    const st = ogunStateOf(raw, this.base);
    this.dust = st.xi ? (st.xi as number[])[14] : 0;
    if (this.dust !== this.lastDust) {
      this.lastDust = this.dust;
      this.sg.setMix(this.dust);
    }
    this.og.setParams(st);
  }

  setMaxPoly(n: number): void {
    this.og.setMaxPoly(n);
  }

  reset(): void {
    this.og.reset();
    this.sg.clear();
  }

  triggerVoice(params: GenVoiceParams, ctx?: GenContext): GenVoice | null {
    return this.og.triggerVoice(params, ctx);
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    this.og.render(L, R, n, ctx);
  }

  /** The end of Gen_Render: SGv2's Eff_Render over the chunk (interleaved stereo, in place) while the dust is above 0. */
  private soundgoodize(buf: Float32Array, frames: number): void {
    if (this.dust <= 0 || frames <= 0) return;
    if (frames <= this.maxBlock) {
      this.sg.process(buf, frames);
      return;
    }
    for (let o = 0; o < frames; o += this.maxBlock) {
      const m = Math.min(this.maxBlock, frames - o);
      this.sg.process(buf.subarray(2 * o, 2 * (o + m)), m);
    }
  }
}

export const gen: GenModule = { id: 'autogun', create: (sr, bs, env) => new AutogunInstance(sr, bs, env) };
