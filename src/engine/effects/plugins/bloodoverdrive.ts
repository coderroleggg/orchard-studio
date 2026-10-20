// Blood Overdrive (FL: Fruity Blood Overdrive): pre band-pass mix, a 3-band
// sine-shaper overdrive, post gain, final clip and a 2-pole post low-pass.
// The DSP core (shared with Distructor) is FL's code in FL's single
// precision, at the base rate like FL (no oversampling): ./distructor/blood.ts
// and docs/research/fx/bloodoverdrive.md.

import type { EffectInstance, EffectModule } from '../types';
import { BloodCore } from './distructor/blood';

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d;
}

class BloodOverdrive implements EffectInstance {
  private core: BloodCore;

  constructor(sampleRate: number) {
    // FL's SaveRestoreState pre-settles the smoothing with one second of iterations
    this.core = new BloodCore(sampleRate);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    this.core.set({
      preBand: num(q.preBand, 0),
      color: num(q.color, 5000),
      preAmp: num(q.preAmp, 0),
      x100: num(q.x100, 0) >= 0.5 ? 1 : 0,
      postFilter: num(q.postFilter, 0),
      postGain: num(q.postGain, 10000),
    });
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    this.core.process(L, R, n);
  }

  reset(): void {
    this.core.reset();
  }
}

export const effect: EffectModule = {
  id: 'bloodoverdrive',
  create: (sampleRate) => new BloodOverdrive(sampleRate),
};
