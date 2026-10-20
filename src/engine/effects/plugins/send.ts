// Send (FL: Fruity Send), modelled on FL's binary:
// - the send signal is the plugin's input through PanOMatic's merge-pan
//   matrix (send pan p, send gain v = (11^(vol/256) - 1) / 10):
//     p >= 0: L' = (1-p)v·L,  R' = v(1-p/2)·R + (pv/2)·L
//     p <  0: R' = (1+p)v·R,  L' = v(1+p/2)·L - (pv/2)·R
//   mixed into the target track's input (FL: the plugin's output buffer
//   that the host routes to that track). The matrix ramps once per block
//   at most 44.1/sr per sample and starts from zero when the plugin is
//   created; it only runs while a target is selected;
// - the dry output is the input times g = (11^(dry/256) - 1) / 10 (the wheel
//   reads 0..100% but follows the volume law). FL applies the dry gain
//   without smoothing: a change takes effect at the next block (so does ours).

import type { EffectInstance, EffectModule, FxContext } from '../types';

function gain(v: number): number {
  const s = v / 256;
  if (s === 1) return 1;
  return Math.max(0, (Math.pow(11, s) - 1) * 0.1);
}

class Send implements EffectInstance {
  private readonly maxRate: number;
  private pan = 0;
  private vol = 1;
  private dry = 1;
  private target = -1;
  private dirty = true;
  // send matrix LL, RR, RL (R into L), LR (L into R): current / target
  private readonly cur = new Float64Array(4);
  private readonly tgt = new Float64Array(4);
  private readonly start = new Float64Array(4);
  private readonly step = new Float64Array(4);
  private readonly sL: Float32Array;
  private readonly sR: Float32Array;

  constructor(sampleRate: number, blockSize: number) {
    this.maxRate = Math.fround(44.1 / sampleRate); // FL: the host's float32 smoothing rate
    const n = Math.max(1, blockSize | 0);
    this.sL = new Float32Array(n);
    this.sR = new Float32Array(n);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
    };
    this.pan = num('pan', 0, -128, 128) / 128;
    this.vol = gain(num('vol', 256, 0, 320));
    this.dry = gain(num('dry', 256, 0, 256));
    const t = Number(q.target ?? -1);
    this.target = Number.isInteger(t) && t >= 0 ? t : -1;
    this.dirty = true;
  }

  sendTargets(): number[] {
    return this.target >= 0 ? [this.target] : [];
  }

  private matrix(): void {
    const t = this.tgt, pan = this.pan, vol = this.vol;
    if (pan >= 0) {
      const lr = pan * 0.5 * vol;
      t[0] = (1 - pan) * vol; t[1] = vol - lr; t[2] = 0; t[3] = lr;
    } else {
      const rl = -pan * 0.5 * vol;
      t[1] = (1 + pan) * vol; t[0] = vol - rl; t[2] = rl; t[3] = 0;
    }
    this.dirty = false;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (n <= 0) return;
    if (this.target >= 0 && this.target !== ctx.track) {
      if (this.dirty) this.matrix();
      for (let o = 0; o < n; o += this.sL.length) this.send(L, R, o, Math.min(this.sL.length, n - o), ctx);
    }
    // dry: FL steps the gain per block (a plain copy at 100 %)
    const g = this.dry;
    if (g === 1) return;
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  }

  private send(L: Float32Array, R: Float32Array, o: number, n: number, ctx: FxContext): void {
    const cur = this.cur, tgt = this.tgt, rate = this.maxRate, s = this.start, dd = this.step;
    for (let k = 0; k < 4; k++) {
      const start = cur[k];
      let d = (tgt[k] - start) / n;
      if (d > rate || d < -rate) {
        d = d > 0 ? rate : -rate;
        let c = start + d * n;
        if (Math.abs(c) < 5.960464477539063e-8) { c = 0; d = -start / n; } // FL: |c| < 2^-24 snaps to 0
        cur[k] = c;
      } else cur[k] = tgt[k];
      s[k] = start;
      dd[k] = d;
    }
    const sL = this.sL, sR = this.sR;
    const s0 = s[0], s1 = s[1], s2 = s[2], s3 = s[3], d0 = dd[0], d1 = dd[1], d2 = dd[2], d3 = dd[3];
    for (let i = 0; i < n; i++) {
      const l = L[o + i], r = R[o + i];
      sL[i] = (s0 + d0 * i) * l + (s2 + d2 * i) * r;
      sR[i] = (s1 + d1 * i) * r + (s3 + d3 * i) * l;
    }
    ctx.sendTo(this.target, sL, sR, n, 1, 1);
  }

  reset(): void {
    if (this.dirty) this.matrix();
    this.cur.set(this.tgt);
  }
}

export const effect: EffectModule = {
  id: 'send',
  create: (sampleRate, blockSize) => new Send(sampleRate, blockSize),
};
