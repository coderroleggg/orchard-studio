// Soft Clipper (FL: Fruity Soft Clipper): per-channel memoryless curve, then
// post gain. Measured on FL's binary (max error 5e-7 on noise and ramps):
//   t = thres/128;  |x| <= t: y = x;  else y = sign(x)·(t + (1 - t)(1 - e^(-(|x| - t)/(1 - t))))
//   out = y · (11^(post/128) - 1)/10.
// No latency, no tail. Threshold and post gain changes apply at the next
// block, without smoothing (as in FL).

import type { EffectInstance, EffectModule, FxMonitor } from '../types';
import { scPostGain, scThreshold } from '../../../model/fx/plugins/softclipper';

class SoftClipper implements EffectInstance {
  private t = scThreshold(100);
  private g = scPostGain(128);
  private peakL = 0;
  private peakR = 0;

  setParams(raw: unknown): void {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const tv = typeof p.thres === 'number' && Number.isFinite(p.thres) ? Math.min(127, Math.max(1, p.thres)) : 100;
    const pv = typeof p.post === 'number' && Number.isFinite(p.post) ? Math.min(160, Math.max(0, p.post)) : 128;
    this.t = scThreshold(tv);
    this.g = scPostGain(pv);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const t = this.t, g = this.g, d = 1 - t, inv = d > 0 ? 1 / d : 0;
    let pl = this.peakL, pr = this.peakR;
    for (let i = 0; i < n; i++) {
      let x = L[i];
      if (!(x === x)) x = 0;
      let a = x < 0 ? -x : x;
      if (a > t) { const y = inv > 0 ? t + d * (1 - Math.exp(-(a - t) * inv)) : t; x = x < 0 ? -y : y; a = y; }
      x *= g;
      L[i] = x;
      a *= g;
      if (a > pl) pl = a;
      x = R[i];
      if (!(x === x)) x = 0;
      a = x < 0 ? -x : x;
      if (a > t) { const y = inv > 0 ? t + d * (1 - Math.exp(-(a - t) * inv)) : t; x = x < 0 ? -y : y; a = y; }
      x *= g;
      R[i] = x;
      a *= g;
      if (a > pr) pr = a;
    }
    this.peakL = pl; this.peakR = pr;
  }

  reset(): void {
    this.peakL = this.peakR = 0;
  }

  monitor(): FxMonitor {
    const m = { peakL: this.peakL, peakR: this.peakR };
    this.peakL = this.peakR = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'softclipper',
  create: () => new SoftClipper(),
};
