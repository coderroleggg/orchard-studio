// Phaser (FL: Fruity Phaser, Bram's SupaPhaser), measured against FL's binary:
//   u   = x sqrt(1 - fb^2) + 0.99 fb y[-1]          (fb = Feedback, 0..1)
//   y   = k first-order allpasses (-a + z^-1) / (1 - a z^-1),  k = max(3, Stages + 1)
//   a   = min + (max - min) (1 + sin 2 pi phase) / 2   (Minimum / Maximum depth)
//   out = gain (d x sqrt(1 - fb^2) + (1 - d) y)       (d = Dry - Wet / 1024, gain = v / 2500)
// The LFO starts at phase 0, runs freely at R (e^(4 s) - 1) / (e^4 - 1) Hz
// (s = Sweep / 5000; R = 2 Hz "small", 10 Hz "large") and the right channel
// leads by Stereo / 1024 x half a cycle. As in FL, every parameter change
// applies at once (no glides or crossfades).

import type { EffectInstance, EffectModule } from '../types';
import { phaserDryShare, phaserGain, phaserLargeRange, phaserSections } from '../../../model/fx/plugins/phaser';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const MAXK = 23;
const TWO_PI = 2 * Math.PI;
const E4 = Math.exp(4) - 1;
const F = Math.fround;

/** LFO rate in Hz for a Sweep value and range (measured law). */
export function phaserRate(sweep: number, large: boolean): number {
  const x = Math.max(0, Math.min(1, sweep / 5000));
  return ((large ? 10 : 2) * (Math.exp(4 * x) - 1)) / E4;
}

class Phaser implements EffectInstance {
  private readonly sr: number;
  // allpass states [channel][section] (transposed direct form II)
  private readonly u1 = [new Float64Array(MAXK), new Float64Array(MAXK)];
  private readonly fbY = new Float64Array(2);
  private phase = 0;
  private inc = 0;
  // settings: FL applies every change at once
  private lo = 0;
  private hi = 0.9;
  private st = 0.25;
  private fb = 0.693;
  private d = 0;
  private g = 1;
  private k = 12;
  private tailSec = 1;

  constructor(sr: number) {
    this.sr = sr;
    this.setParams({});
  }

  get tail(): number {
    return this.tailSec;
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    // FL accumulates the LFO phase in single precision (rates drift by up to ~0.2 %)
    this.inc = F(phaserRate(num(q.sweep, 1500), phaserLargeRange(num(q.range, 0))) / this.sr);
    this.lo = Math.max(0, Math.min(1, num(q.minDepth, 0) / 1000));
    this.hi = Math.max(0, Math.min(1, num(q.maxDepth, 900) / 1000));
    this.st = (Math.max(0, Math.min(1024, num(q.stereo, 512))) / 1024) * 0.5;
    this.fb = Math.max(0, Math.min(1, num(q.feedback, 693) / 1000));
    this.d = phaserDryShare(num(q.dryWet, 0));
    this.g = phaserGain(num(q.gain, 2500));
    this.k = phaserSections(Math.max(0, Math.min(22, num(q.stages, 11))));
    // ring time: the loop decays by 0.99 fb per pass; one pass lasts about the chain's group delay
    const amax = Math.min(0.995, Math.max(this.lo, this.hi));
    const loop = 1 + this.k * ((1 + amax) / (1 - amax));
    const g = 0.99 * this.fb;
    this.tailSec = Math.min(10, (loop * (g > 1e-3 ? Math.log(1e-4) / Math.log(g) : 1) + 2 * loop) / this.sr + 0.02);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const k = this.k;
    const u1L = this.u1[0], u1R = this.u1[1];
    const lo = this.lo, hi = this.hi, st = this.st, fb = this.fb, d = this.d, g = this.g;
    let phase = this.phase, fbL = this.fbY[0], fbR = this.fbY[1];
    const inc = this.inc;
    const gin = Math.sqrt(Math.max(0, 1 - fb * fb)), gfb = 0.99 * fb;
    const span = hi - lo;
    for (let i = 0; i < n; i++) {
      let pr = phase + st;
      if (pr >= 1) pr -= 1;
      const aL = lo + span * 0.5 * (1 + Math.sin(TWO_PI * phase));
      const aR = lo + span * 0.5 * (1 + Math.sin(TWO_PI * pr));
      phase = F(phase + inc);
      if (phase >= 1) phase = F(phase - 1);
      const il = L[i], ir = R[i];
      const xl = il - il === 0 ? il : 0, xr = ir - ir === 0 ? ir : 0;   // NaN / Inf -> 0
      let vl = xl * gin + gfb * fbL, vr = xr * gin + gfb * fbR;
      let outL = 0, outR = 0;
      for (let s = 0; s < k; s++) {
        // transposed direct form II (closest to FL under modulation); only the sections
        // in use run (FL), the others keep their state
        const yl = -aL * vl + u1L[s];
        u1L[s] = vl + aL * yl; vl = yl;
        const yr = -aR * vr + u1R[s];
        u1R[s] = vr + aR * yr; vr = yr;
      }
      outL = vl; outR = vr;
      fbL = outL; fbR = outR;
      // FL scales the input by sqrt(1 - fb^2) before the split, so the dry share too
      L[i] = g * (d * gin * xl + (1 - d) * outL);
      R[i] = g * (d * gin * xr + (1 - d) * outR);
    }
    // denormal flush / recovery
    for (let s = 0; s < MAXK; s++) {
      if (!(Math.abs(u1L[s]) > 1e-30)) u1L[s] = 0;
      if (!(Math.abs(u1R[s]) > 1e-30)) u1R[s] = 0;
    }
    if (!(Math.abs(fbL) > 1e-30)) fbL = 0;
    if (!(Math.abs(fbR) > 1e-30)) fbR = 0;
    if (!Number.isFinite(fbL + fbR)) this.clear();
    else { this.fbY[0] = fbL; this.fbY[1] = fbR; }
    this.phase = phase;
  }

  private clear(): void {
    for (let c = 0; c < 2; c++) this.u1[c].fill(0);
    this.fbY.fill(0);
  }

  reset(): void {
    this.clear();
  }
}

export const effect: EffectModule = {
  id: 'phaser',
  create: (sr) => new Phaser(sr),
};
