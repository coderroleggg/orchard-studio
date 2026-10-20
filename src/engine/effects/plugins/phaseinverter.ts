// Phase Inverter (FL: Fruity Phase Inverter), from FL's binary: the state
// (Off / Left / Right, see phaseInverterState) flips the sign bit of every
// sample of the chosen channel. State changes apply at once, as in FL.

import type { EffectInstance, EffectModule } from '../types';
import { phaseInverterState } from '../../../model/fx/plugins/phaseinverter';

class PhaseInverter implements EffectInstance {
  private state = 2;

  setParams(p: unknown): void {
    this.state = phaseInverterState(Number((p as Record<string, unknown> | null)?.state ?? 1024));
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.state === 0) return;
    const b = this.state === 1 ? L : R;
    for (let i = 0; i < n; i++) b[i] = -b[i];
  }

  reset(): void {}
}

export const effect: EffectModule = {
  id: 'phaseinverter',
  create: () => new PhaseInverter(),
};
