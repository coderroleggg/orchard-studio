// Flanger (FL: Fruity Flanger, a Smart Electronix port), measured against FL's
// binary. Per channel: the input plus feedback is written into a delay line,
// read back with linear interpolation at
//   Delay + Depth/2 + floor(Depth/2 in samples) * lfo
// (FL keeps the sweep half-width a whole number of samples), damped by a
// one-pole low-pass (coefficient Damp, inside the feedback loop) and fed back
// with 0.98 * Feed (sign flipped by Invert feedback). The LFO morphs from sine
// (Shape 0) to triangle (Shape 1) and the right channel leads by Phase.
// Output = Dry * in + Wet * wet + Cross * (other channel's wet); Invert wet
// flips the wet (and cross) output only. As in FL, every parameter change
// applies at once (no glides; Delay and Depth jumps click).

import type { EffectInstance, EffectModule } from '../types';
import { flangerDelayMs, flangerDepthMs, flangerFeedback, flangerOn, flangerRateHz } from '../../../model/fx/plugins/flanger';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const TWO_PI = 2 * Math.PI;
const F = Math.fround;

/** Triangle with sine phase: 0 at x = 0 rising to 1 at x = 1/4 (x in cycles). */
function tri(x: number): number {
  return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
}

class Flanger implements EffectInstance {
  private readonly sr: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private readonly mask: number;
  private w = 0;
  // settings (samples, gains)
  private cen = 0;    // sweep centre: Delay + Depth/2
  private amp = 0;    // sweep half-width: floor(Depth/2)
  private ph = 0;     // right-channel phase lead (cycles)
  private sh = 0;     // sine -> triangle mix
  private fb = 0;
  private damp = 0;
  private dry = 0;
  private wet = 0;
  private crs = 0;
  private inc = 0;
  private phase = 0;
  private yL = 0; private yR = 0;      // damped delay outputs (feedback source)
  private tailSec = 0.05;

  constructor(sr: number) {
    this.sr = sr;
    let len = 1;
    while (len < Math.ceil(0.0405 * sr) + 8) len <<= 1;
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
    this.mask = len - 1;
    this.setParams({});
  }

  get tail(): number {
    return this.tailSec;
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const ms = this.sr / 1000;
    const dly = flangerDelayMs(num(q.delay, 0)) * ms;
    const dep = flangerDepthMs(num(q.depth, 2000)) * ms;
    this.cen = dly + dep / 2;
    this.amp = Math.floor(dep / 2);
    // FL accumulates the LFO phase in single precision (rate drift of up to ~0.1 %)
    this.inc = F(flangerRateHz(num(q.rate, 2000)) / this.sr);
    this.ph = num(q.phase, 118) / 360;
    this.sh = Math.max(0, Math.min(1, num(q.shape, 0) / 1024));
    this.damp = Math.max(0, Math.min(1, num(q.damp, 0) / 5000));
    this.fb = flangerFeedback(Math.max(0, Math.min(100, num(q.feed, 23))), num(q.invFeedback, 1024));
    const sign = flangerOn(num(q.invWet, 1024)) ? -1 : 1;
    this.dry = Math.max(0, num(q.dry, 3500) / 5000);
    this.wet = (sign * Math.max(0, num(q.wet, 3000))) / 5000;
    this.crs = (sign * Math.max(0, num(q.cross, 2500))) / 5000;
    // ring time: echoes every (Delay + Depth) until -80 dB (damping only shortens it)
    const loop = (dly + dep) / this.sr;
    const g = Math.abs(this.fb);
    this.tailSec = Math.min(30, loop * (g > 1e-4 ? Math.log(1e-4) / Math.log(g) + 1 : 1) + 0.02);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const bufL = this.bufL, bufR = this.bufR, mask = this.mask, inc = this.inc;
    const maxD = mask - 2;
    let w = this.w, phase = this.phase, yL = this.yL, yR = this.yR;
    const cen = this.cen, amp = this.amp, ph = this.ph, sh = this.sh, fb = this.fb, damp = this.damp;
    const dry = this.dry, wet = this.wet, crs = this.crs;

    for (let i = 0; i < n; i++) {
      phase = F(phase + inc);
      if (phase >= 1) phase = F(phase - 1);
      let pr = phase + ph;
      if (pr >= 1) pr -= 1;
      const uL = Math.sin(TWO_PI * phase) * (1 - sh) + tri(phase) * sh;
      const uR = Math.sin(TWO_PI * pr) * (1 - sh) + tri(pr) * sh;

      const il = L[i], ir = R[i];
      const xl = il - il === 0 ? il : 0, xr = ir - ir === 0 ? ir : 0;   // NaN / Inf -> 0
      bufL[w] = xl + fb * yL;
      bufR[w] = xr + fb * yR;

      let d = cen + amp * uL;
      if (d > maxD) d = maxD; else if (d < 0) d = 0;
      let pos = w - d + mask + 1;
      let ip = pos | 0;
      let fr = pos - ip;
      let s0 = bufL[ip & mask];
      const rl = s0 + (bufL[(ip + 1) & mask] - s0) * fr;

      d = cen + amp * uR;
      if (d > maxD) d = maxD; else if (d < 0) d = 0;
      pos = w - d + mask + 1;
      ip = pos | 0;
      fr = pos - ip;
      s0 = bufR[ip & mask];
      const rr = s0 + (bufR[(ip + 1) & mask] - s0) * fr;

      yL = rl + (yL - rl) * damp;
      yR = rr + (yR - rr) * damp;
      L[i] = dry * xl + wet * yL + crs * yR;
      R[i] = dry * xr + wet * yR + crs * yL;
      w = (w + 1) & mask;
    }
    if (!(Math.abs(yL) > 1e-30)) yL = 0;
    if (!(Math.abs(yR) > 1e-30)) yR = 0;
    if (!Number.isFinite(yL + yR)) { yL = yR = 0; this.bufL.fill(0); this.bufR.fill(0); }
    this.w = w; this.phase = phase; this.yL = yL; this.yR = yR;
  }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.yL = this.yR = 0;
  }
}

export const effect: EffectModule = {
  id: 'flanger',
  create: (sr) => new Flanger(sr),
};
