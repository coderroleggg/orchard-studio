// Mute 2 (FL: Fruity Mute 2), from FL's binary: when muted (Mute below
// 512) the chosen channel(s) are replaced by silence: L, both (L + R) or R;
// otherwise the input passes untouched. Changes apply at once (no ramp), as
// in FL.

import type { EffectInstance, EffectModule } from '../types';
import { mute2Channel, mute2Muted } from '../../../model/fx/plugins/mute2';

class Mute2 implements EffectInstance {
  private muted = false;
  private channel = 1;

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    this.muted = mute2Muted(Number(q.mute ?? 512));
    this.channel = mute2Channel(Number(q.channel ?? 512));
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (!this.muted || n <= 0) return;
    if (this.channel !== 2) L.fill(0, 0, n);
    if (this.channel !== 0) R.fill(0, 0, n);
  }

  reset(): void {}
}

export const effect: EffectModule = {
  id: 'mute2',
  create: () => new Mute2(),
};
