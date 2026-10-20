// dB Meter: passes audio through untouched and measures the per-channel
// sample peak (max |x|) between editor polls, like FL's plugin which keeps the
// block peaks for its meter timer and resets them once read.

import type { EffectInstance, EffectModule, FxMonitor } from '../types';

class DbMeter implements EffectInstance {
  private peakL = 0;
  private peakR = 0;
  private fresh = false;
  private silentSent = false;

  setParams(): void {}

  process(L: Float32Array, R: Float32Array, n: number): void {
    let pl = this.peakL, pr = this.peakR;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
    }
    // NaN never compares greater, so peaks stay finite
    this.peakL = pl; this.peakR = pr;
    this.fresh = true;
  }

  reset(): void {
    this.peakL = this.peakR = 0;
  }

  /** {l, r}: linear sample peaks since the last poll; null while nothing new (silence already sent). */
  monitor(): FxMonitor | null {
    if (!this.fresh) return null;
    const l = this.peakL, r = this.peakR;
    this.peakL = this.peakR = 0;
    this.fresh = false;
    if (l === 0 && r === 0) {
      if (this.silentSent) return null;
      this.silentSent = true;
    } else this.silentSent = false;
    return { l, r };
  }
}

export const effect: EffectModule = {
  id: 'dbmeter',
  create: () => new DbMeter(),
};
