// Soundgoodizer: the Maximus core configured with FL's Soundgoodizer preset for
// the selected mode (A..D), the amount knob driving the LMH mix. A mode change
// reconfigures the whole engine (as FL does, which reloads the preset). Its
// built-in Maximus is an older build: the 24 dB split has no low-band allpass
// compensation (with it, modes A and B differ from FL by -22 dB; without, -65 dB).

import type { EffectInstance, EffectModule, FxMonitor } from '../types';
import { sgMaximusState } from '../../../model/fx/plugins/soundgoodizer';
import { MaximusCore } from './maximus/core';
import { mxConfig } from './maximus';

class Soundgoodizer implements EffectInstance {
  private core: MaximusCore;
  private sr: number;
  private mode = -1;
  private amount = -1;

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    this.core = new MaximusCore(sampleRate, blockSize);
    this.apply(0, 600);
    this.core.reset();
  }

  get latency(): number { return this.core.latency; }
  get tail(): number { return this.core.latency / this.sr + 0.05; }

  private apply(mode: number, amount: number): void {
    const changed = mode !== this.mode;
    this.mode = mode;
    this.amount = amount;
    // Soundgoodizer's engine has no low-band allpass compensation (measured on FL)
    this.core.configure({ ...mxConfig(sgMaximusState(mode, amount)), lowComp: false });
    if (changed) this.core.reset();
  }

  setParams(p: unknown): void {
    const q = (p && typeof p === 'object' ? p : {}) as { amount?: number; mode?: number };
    const mode = Math.max(0, Math.min(3, Math.round(typeof q.mode === 'number' ? q.mode : 0)));
    const amount = Math.max(0, Math.min(1000, typeof q.amount === 'number' ? q.amount : 600));
    if (mode !== this.mode || amount !== this.amount) this.apply(mode, amount);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    this.core.process(L, R, n);
  }

  reset(): void { this.core.reset(); }

  monitor(): FxMonitor {
    this.core.takeChunks();
    const g = this.core.gains();
    return { gain: Math.min(...g) };
  }
}

export const effect: EffectModule = {
  id: 'soundgoodizer',
  create: (sr, bs) => new Soundgoodizer(sr, bs),
};
