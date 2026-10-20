// Filter (FL: Fruity Filter). Measured against FL's plugin binary:
// - Chamberlin state variable filter, per sample:
//     low += f*band; high = in - low - q*band; band += f*high
//   out = gl*low + gb*band + gh*high
//   f = (26^(cutoff/1024) - 1) / 25 (0..1, independent of the sample rate, as in FL),
//   q = 1 - 0.8*res/1024 (Q 1..5), mix gains (11^(m/1024) - 1) / 10.
// - X 2: the mixed output runs through a second SVF with the same f and no
//   resonance (q = 1) and is mixed again (24 dB/oct slopes).
// - CENTER: DC removal, out -= lp2(out) with two one-pole smoothers
//   (0.0395 per sample, then a ~4 Hz pole).
// - Smoothing: per block the wheels move min(1, n/128) of the way to their
//   targets; f, q and the gains ramp linearly across the block.

import type { EffectInstance, EffectModule } from '../types';
import { filterF, filterMix, filterQ } from '../../../model/fx/plugins/filter';

const DC_FAST = 0.03948526;

interface Targets { cutoff: number; res: number; lp: number; bp: number; hp: number }

class FruityFilter implements EffectInstance {
  latency = 0;
  tail = 0.5;
  private readonly sr: number;
  private readonly dcSlow: number;
  // wheel targets and smoothed wheel values (control units)
  private t: Targets = { cutoff: 1024, res: 205, lp: 1024, bp: 0, hp: 512 };
  private k: Targets = { cutoff: 1024, res: 205, lp: 1024, bp: 0, hp: 512 };
  // coefficients reached at the end of the previous block
  private f = 1;
  private q = filterQ(205);
  private gl = 1;
  private gb = 0;
  private gh = filterMix(512);
  private x2 = false;
  private center = true;
  private fresh = true;
  // state: [L, R] stage 1, stage 2, DC smoothers
  private low = new Float64Array(2);
  private band = new Float64Array(2);
  private low2 = new Float64Array(2);
  private band2 = new Float64Array(2);
  private dc1 = new Float64Array(2);
  private dc2 = new Float64Array(2);

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.dcSlow = 1 - Math.exp(-25.51 / sampleRate);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);
    const t = this.t;
    t.cutoff = Math.min(1024, Math.max(0, num(q.cutoff, 1024)));
    t.res = Math.min(1024, Math.max(0, num(q.res, 205)));
    t.lp = Math.min(1024, Math.max(0, num(q.lp, 1024)));
    t.bp = Math.min(1024, Math.max(0, num(q.bp, 0)));
    t.hp = Math.min(1024, Math.max(0, num(q.hp, 512)));
    const x2 = num(q.x2, 0) >= 0.5;
    if (x2 && !this.x2) { this.low2.fill(0); this.band2.fill(0); }
    this.x2 = x2;
    const center = num(q.center, 1) >= 0.5;
    if (center && !this.center) { this.dc1.fill(0); this.dc2.fill(0); }
    this.center = center;
    if (this.fresh) this.snap();
    this.tail = this.ringTime();
  }

  /** Jump to the targets (new instance, reset). */
  private snap(): void {
    const t = this.t, k = this.k;
    k.cutoff = t.cutoff; k.res = t.res; k.lp = t.lp; k.bp = t.bp; k.hp = t.hp;
    this.f = filterF(k.cutoff); this.q = filterQ(k.res);
    this.gl = filterMix(k.lp); this.gb = filterMix(k.bp); this.gh = filterMix(k.hp);
    this.fresh = false;
  }

  /** Seconds for the resonance to decay by ~80 dB (idle cut-off of the mixer track). */
  private ringTime(): number {
    const f = Math.max(1e-6, filterF(this.t.cutoff)), q = filterQ(this.t.res);
    // pole radius^2 of the Chamberlin SVF is 1 - f q
    const r2 = Math.max(0, 1 - f * q);
    const perSample = r2 > 0 ? -0.5 * Math.log(r2) : 10;
    const s = 9.2 / Math.max(1e-9, perSample) / this.sr;
    return Math.min(4, Math.max(0.1, s + (this.center ? 0.2 : 0)));
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (n <= 0) return;
    const t = this.t, k = this.k;
    const a = n >= 128 ? 1 : n / 128;
    k.cutoff += (t.cutoff - k.cutoff) * a;
    k.res += (t.res - k.res) * a;
    k.lp += (t.lp - k.lp) * a;
    k.bp += (t.bp - k.bp) * a;
    k.hp += (t.hp - k.hp) * a;
    const f1 = filterF(k.cutoff), q1 = filterQ(k.res);
    const gl1 = filterMix(k.lp), gb1 = filterMix(k.bp), gh1 = filterMix(k.hp);
    const inv = 1 / n;
    const df = (f1 - this.f) * inv, dq = (q1 - this.q) * inv;
    const dgl = (gl1 - this.gl) * inv, dgb = (gb1 - this.gb) * inv, dgh = (gh1 - this.gh) * inv;
    const x2 = this.x2, center = this.center, A = DC_FAST, B = this.dcSlow;
    for (let c = 0; c < 2; c++) {
      const buf = c === 0 ? L : R;
      let low = this.low[c], band = this.band[c], low2 = this.low2[c], band2 = this.band2[c];
      let d1 = this.dc1[c], d2 = this.dc2[c];
      let f = this.f, q = this.q, gl = this.gl, gb = this.gb, gh = this.gh;
      for (let i = 0; i < n; i++) {
        f += df; q += dq; gl += dgl; gb += dgb; gh += dgh;
        low += f * band;
        const high = buf[i] - low - q * band;
        band += f * high;
        let o = gl * low + gb * band + gh * high;
        if (x2) {
          low2 += f * band2;
          const high2 = o - low2 - band2;
          band2 += f * high2;
          o = gl * low2 + gb * band2 + gh * high2;
        }
        if (center) {
          d1 += (o - d1) * A;
          d2 += (d1 - d2) * B;
          o -= d2;
        }
        buf[i] = o;
      }
      // denormal / runaway guards
      this.low[c] = guard(low); this.band[c] = guard(band);
      this.low2[c] = guard(low2); this.band2[c] = guard(band2);
      this.dc1[c] = guard(d1); this.dc2[c] = guard(d2);
    }
    this.f = f1; this.q = q1; this.gl = gl1; this.gb = gb1; this.gh = gh1;
  }

  reset(): void {
    this.low.fill(0); this.band.fill(0); this.low2.fill(0); this.band2.fill(0);
    this.dc1.fill(0); this.dc2.fill(0);
    this.snap();
  }
}

function guard(x: number): number {
  if (!(x > -1e6 && x < 1e6)) return 0; // NaN or runaway
  return x > 1e-20 || x < -1e-20 ? x : 0;
}

export const effect: EffectModule = {
  id: 'filter',
  create: (sampleRate) => new FruityFilter(sampleRate),
};
