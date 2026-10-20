// Fast LP (FL: Fruity Fast LP). Measured against FL's binary: a one-pole low
// pass with a momentum term (two poles), per sample and channel
//   v = r v + f (x - y); y += v
// f = fastLpF(cutoff) (cutoff at 100 % passes the input unchanged), r =
// fastLpR(resonance); both are per-sample coefficients, independent of the
// sample rate as in FL. Wheel changes: each block moves min(1, n / 128) of the
// way (as Fruity Filter); f ramps across the block, r steps (measured).

import type { EffectInstance, EffectModule } from '../types';
import { fastLpF, fastLpR } from '../../../model/fx/plugins/fastlp';

class FastLP implements EffectInstance {
  latency = 0;
  tail = 0.5;
  private tCut = 1024; private tRes = 0;
  private kCut = 1024; private kRes = 0;
  private f = 1; private r = 0;
  private fresh = true;
  private y = new Float64Array(2);
  private v = new Float64Array(2);

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    this.tCut = Math.min(1024, Math.max(0, num(q.cutoff, 1024)));
    this.tRes = Math.min(1024, Math.max(0, num(q.res, 0)));
    if (this.fresh) {
      this.fresh = false;
      this.kCut = this.tCut; this.kRes = this.tRes;
      this.f = fastLpF(this.kCut); this.r = fastLpR(this.kRes);
    }
    this.updateTail();
  }

  private updateTail(): void {
    // slowest pole: real root of z^2 - (1 + r - f) z + r, or sqrt(r) for complex poles
    const f = fastLpF(this.tCut), r = fastLpR(this.tRes);
    const b = 1 + r - f, disc = b * b - 4 * r;
    const rad = disc >= 0 ? (b + Math.sqrt(disc)) / 2 : Math.sqrt(r);
    this.tail = rad >= 1 || rad <= 0 ? 0 : Math.min(4, Math.log(1e-4) / Math.log(rad) / 44100);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (n <= 0) return;
    const a = Math.min(1, n / 128);
    this.kCut += (this.tCut - this.kCut) * a;
    this.kRes += (this.tRes - this.kRes) * a;
    // the cutoff coefficient ramps across the block, the resonance applies at once (measured)
    const f1 = fastLpF(this.kCut), r1 = fastLpR(this.kRes);
    const f0 = this.f, df = (f1 - f0) / n;
    for (let ch = 0; ch < 2; ch++) {
      const buf = ch === 0 ? L : R;
      let y = this.y[ch], v = this.v[ch], f = f0;
      const r = r1;
      for (let i = 0; i < n; i++) {
        f += df;
        v = r * v + f * (buf[i] - y);
        y += v;
        buf[i] = y;
      }
      if (!(Math.abs(y) < 1e6) || !Number.isFinite(v)) { y = 0; v = 0; }
      if (Math.abs(y) < 1e-20) y = 0;
      if (Math.abs(v) < 1e-20) v = 0;
      this.y[ch] = y; this.v[ch] = v;
    }
    this.f = f1; this.r = r1;
  }

  reset(): void {
    this.y.fill(0); this.v.fill(0);
    this.kCut = this.tCut; this.kRes = this.tRes;
    this.f = fastLpF(this.kCut); this.r = fastLpR(this.kRes);
  }
}

export const effect: EffectModule = {
  id: 'fastlp',
  create: () => new FastLP(),
};
