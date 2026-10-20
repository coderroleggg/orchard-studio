// Control Surface DSP: the outputs are the surface's control values (0..1 per
// output index, from the slot state); the audio passes through. Nothing runs
// per sample: the engine reads controls() after every block.

import type { EffectInstance, EffectModule } from '../types';

class ControlSurface implements EffectInstance {
  private out = new Float64Array(0);

  setParams(p: unknown): void {
    const v = (p as { values?: unknown }).values;
    const list = Array.isArray(v) ? v : [];
    if (this.out.length !== list.length) this.out = new Float64Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const x = Number(list[i]);
      this.out[i] = Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
    }
  }

  process(): void {}

  controls(): ArrayLike<number> {
    return this.out;
  }

  reset(): void {}
}

export const effect: EffectModule = {
  id: 'controlsurface',
  create: () => new ControlSurface(),
};
