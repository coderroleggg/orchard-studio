// Balance (FL: Fruity Balance), calibrated against FL's binary (flfxhost
// renders are bit-exact with this model at static settings):
// - x = float32((pan + 128) / 256), p = float32(pan / 128), θ = (1 + p)·π/4,
//   k = (1 - sin(π·|x - 0.5|) / 2) / (10·cos(π/4)),
//   g = float32(11^float32(1.25·vol/320) - 1) · k   (= √2·(11^(vol/256)-1)/10 at centre),
//   LL = g·cos θ, RR = g·sin θ, and the channel being balanced away pours into
//   the other: pan left RL = LL - RR, pan right LR = RR - LL. Hard left gives
//   L' = (L + R)/√2, R' = 0; the centre is the identity.
// - the four float32 coefficients ramp once per block toward their targets
//   with FL's shared smoother (at most 10·float32(44.1/sr) per sample, |c| < 2^-24 snaps
//   to 0), starting from zero when the plugin is created (a short fade-in);
//   per sample, in float32: L' = c0·L + c2·R, R' = c1·R + c3·L, c += step.
// - the editor's peak meter reads the output peaks.

import type { EffectInstance, EffectModule, FxMonitor } from '../types';

const f32 = Math.fround;
const NORM = 1 / (Math.cos(Math.PI / 4) * 10);
const SNAP = 5.960464477539063e-8; // FL's runtime threshold, 2^-24

class Balance implements EffectInstance {
  private readonly rate: number;
  // coefficients LL, RR, RL (R into L), LR (L into R): current and target (float32 values)
  private readonly cur = new Float64Array(4);
  private readonly tgt = new Float64Array(4);
  private readonly st = new Float64Array(4);
  private readonly sp = new Float64Array(4);
  private peakL = 0;
  private peakR = 0;

  constructor(sampleRate: number) {
    // FL: ten times the host's float32(44.1 / sr) smoothing rate (0.01 per sample at 44.1 kHz)
    this.rate = f32(f32(44.1 / sampleRate) * 10);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
    };
    const pan = num('pan', 0, -128, 128), vol = num('vol', 256, 0, 320);
    const x = f32(f32(pan + 128) * 0.00390625);
    const pn = f32(f32(pan) * 0.0078125);
    const k = (1 - Math.sin(Math.abs(x - 0.5) * Math.PI) * 0.5) * NORM;
    const g = f32(Math.exp(f32((vol / 320) * 1.25) * 2.3978952727983707) - 1) * k;
    const th = (1 + pn) * 0.7853981633974483;
    const LL = g * Math.cos(th), RR = g * Math.sin(th);
    const t = this.tgt;
    t[0] = f32(LL);
    t[1] = f32(RR);
    t[2] = x < 0.5 ? f32(LL - RR) : 0;
    t[3] = x < 0.5 ? 0 : f32(RR - LL);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (n <= 0) return;
    // FL's smoother, once per block (float32)
    const cur = this.cur, tgt = this.tgt, st = this.st, sp = this.sp, rate = this.rate;
    let moving = false;
    for (let k = 0; k < 4; k++) {
      const start = cur[k];
      let d = f32(tgt[k] - start);
      if (d !== 0) {
        cur[k] = tgt[k];
        d = f32(d / n);
        if (Math.abs(d) > rate) {
          d = d > 0 ? rate : -rate;
          let c = f32(start + f32(d * n));
          if (Math.abs(c) < SNAP) { c = 0; d = f32(-start / n); }
          cur[k] = c;
        }
        moving = true;
      }
      st[k] = start;
      sp[k] = d;
    }
    let c0 = st[0], c1 = st[1], c2 = st[2], c3 = st[3];
    let pl = this.peakL, pr = this.peakR;
    if (!moving) {
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        const ol = f32(f32(c0 * l) + f32(c2 * r)), or = f32(f32(c1 * r) + f32(c3 * l));
        L[i] = ol; R[i] = or;
        const al = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or;
        if (al > pl) pl = al;
        if (ar > pr) pr = ar;
      }
    } else {
      const d0 = sp[0], d1 = sp[1], d2 = sp[2], d3 = sp[3];
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        const ol = f32(f32(c0 * l) + f32(c2 * r)), or = f32(f32(c1 * r) + f32(c3 * l));
        c0 = f32(c0 + d0); c1 = f32(c1 + d1); c2 = f32(c2 + d2); c3 = f32(c3 + d3);
        L[i] = ol; R[i] = or;
        const al = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or;
        if (al > pl) pl = al;
        if (ar > pr) pr = ar;
      }
    }
    this.peakL = pl; this.peakR = pr;
  }

  reset(): void {
    this.cur.set(this.tgt);
    this.peakL = this.peakR = 0;
  }

  monitor(): FxMonitor {
    const m = { peakL: this.peakL, peakR: this.peakR };
    this.peakL = this.peakR = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'balance',
  create: (sampleRate) => new Balance(sampleRate),
};
