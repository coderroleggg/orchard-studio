// Fast Dist (FL: Fruity Fast Dist): FL's host table distortion ("TS404"
// DistWave_32FM) with the plugin's pre amp / mix / post gain staging, in FL's
// single precision. Like FL, the table lookup truncates during playback and
// interpolates when the project is exported (FxContext.rendering = FL's
// "HQ for all plugins"). No smoothing, no oversampling. The DSP core is shared
// with Distructor: ./distructor/fastdist.ts, and docs/research/fx/fastdist.md.

import type { EffectInstance, EffectModule, FxContext } from '../types';
import { FastDistCore } from './distructor/fastdist';

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d;
}

class FastDist implements EffectInstance {
  private core = new FastDistCore();

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    this.core.set({
      preAmp: num(q.preAmp, 128),
      thres: num(q.thres, 10),
      type: num(q.type, 0),
      mix: num(q.mix, 128),
      post: num(q.post, 128),
    });
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    this.core.process(L, R, n, !!ctx?.rendering);
  }

  reset(): void {}
}

export const effect: EffectModule = {
  id: 'fastdist',
  create: () => new FastDist(),
};
