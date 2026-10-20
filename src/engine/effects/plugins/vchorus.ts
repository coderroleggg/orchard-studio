// Vintage Chorus (FL: Vintage Chorus), a Juno-6 style BBD chorus. Calibrated
// against FL's binary (flfxhost); see docs/research/fx/vchorus.md:
// - per channel a modulated delay ("BBD") whose output passes a 5th-order
//   low-pass (-3 dB at 5 kHz, fitted to FL's response within 0.05 dB) and a
//   first-order high-pass at High pass (10..170 Hz; 0.5 Hz in the Juno modes);
// - Chorus I: triangle 0.4 Hz, Chorus II: triangle 0.6 Hz, both sweeping
//   1.114..5.190 ms; I+II (Link): sine 8 Hz, 3.104 +- 0.255 ms with the right
//   channel 10.3 degrees on (else half a cycle); the delay trajectory is
//   smoothed by a 21.7 ms one-pole; these modes ignore Mix (fixed 50 %),
//   Feedback, High pass, Invert and Mono;
// - Custom: delay sweeps between Time 1 and Time 2 (0.244 ms + 0.0098 x the
//   shown "ms"), triangle or sine LFO at 10 x^2 Hz (or tempo synced, period
//   129^(1-x) - 1 steps, restarting at Start phase), LR Phase between channels;
// - equal-power Mix (sqrt), Invert wet, Feedback from the filtered wet
//   back into the delay, Gain 0..12 dB after the mix, Mono input = (L + R) / 2;
// - hiss in the wet path growing with the delay (BBD clock), gated by the
//   input when Noise gate is on;
// - changes as in FL: Mix, Gain and Noise glide (21.7 ms one-pole), the rest
//   applies at once (the delay glides through its smoothing); a new instance
//   fades in from 0 with the delay coming down from 10 ms.

import type { EffectInstance, EffectModule, FxContext } from '../types';
import { vchorusDelayMs, vchorusHighPassHz, vchorusNoise, vchorusSpeedHz, vchorusSyncSteps } from '../../../model/fx/plugins/vchorus';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const F = Math.fround;
const TWO_PI = 2 * Math.PI;
/** FL smooths the delay trajectory (and its gains) with a one-pole of 21.7 ms: it
 *  rounds the triangle's corners and slows fast LFOs (-3.3 dB, 47 degrees at 8 Hz). */
const DELAY_TAU = 0.02169;
/** Feedback gain at 100 % (FL: 0.3142 at 50 %, linear). */
const FB_MAX = 0.6284;
/** Hiss scale per unit level, applied as HISS (0.68 + p)^2 with p the (smoothed) LFO
 *  position 0..1: FL's hiss is about 15 dB louder at the long end of the sweep. */
const HISS = 0.7466;
const HISS_FLOOR = 0.1946;

/** Biquad (transposed DF II) coefficients. */
interface BQ { b0: number; b1: number; b2: number; a1: number; a2: number }

function lowpass2(fc: number, q: number, sr: number): BQ {
  const k = Math.tan((Math.PI * Math.min(fc, sr * 0.49)) / sr);
  const n = 1 / (1 + k / q + k * k);
  return { b0: k * k * n, b1: 2 * k * k * n, b2: k * k * n, a1: 2 * (k * k - 1) * n, a2: (1 - k / q + k * k) * n };
}

function lowpass1(fc: number, sr: number): BQ {
  const k = Math.tan((Math.PI * Math.min(fc, sr * 0.49)) / sr);
  const n = 1 / (1 + k);
  return { b0: k * n, b1: k * n, b2: 0, a1: (k - 1) * n, a2: 0 };
}

function highpass1(fc: number, sr: number): BQ {
  const k = Math.tan((Math.PI * Math.min(fc, sr * 0.49)) / sr);
  const n = 1 / (1 + k);
  return { b0: n, b1: -n, b2: 0, a1: (k - 1) * n, a2: 0 };
}

/** Triangle with sine phase (0 at x = 0, rising), x in cycles. */
function tri(x: number): number {
  return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
}

class Chain {
  // filter states: two biquads, the high-pass, the final one-pole
  readonly s = new Float64Array(8);
  // hiss shaping states: high-pass, two biquads
  readonly ns = new Float64Array(5);
  /** BBD output filters up to the feedback take-off (2 biquads + high-pass). */
  run(x: number, f: BQ[]): number {
    const s = this.s;
    let y = f[0].b0 * x + s[0]; s[0] = f[0].b1 * x - f[0].a1 * y + s[1]; s[1] = f[0].b2 * x - f[0].a2 * y; x = y;
    y = f[1].b0 * x + s[2]; s[2] = f[1].b1 * x - f[1].a1 * y + s[3]; s[3] = f[1].b2 * x - f[1].a2 * y; x = y;
    return y;
  }
  /** The high pass, ahead of the BBD (test). */
  hp(x: number, f: BQ): number {
    const s = this.s;
    const y = f.b0 * x + s[4]; s[4] = f.b1 * x - f.a1 * y;
    return y;
  }
  /** The last one-pole (7 kHz), outside the feedback loop. */
  out(x: number, f: BQ): number {
    const y = f.b0 * x + this.s[5];
    this.s[5] = f.b1 * x - f.a1 * y;
    return y;
  }
  /** Hiss spectrum (fitted to FL within 1 dB): a flat floor plus a first-order
   *  high-pass at 4.8 kHz, then two low-pass biquads (8.7 kHz and 20.4 kHz). */
  hiss(n: number, h: BQ[]): number {
    const s = this.ns;
    let y = h[0].b0 * n + s[0]; s[0] = h[0].b1 * n - h[0].a1 * y;
    let x = HISS_FLOOR * n + y;
    y = h[1].b0 * x + s[1]; s[1] = h[1].b1 * x - h[1].a1 * y + s[2]; s[2] = h[1].b2 * x - h[1].a2 * y; x = y;
    y = h[2].b0 * x + s[3]; s[3] = h[2].b1 * x - h[2].a1 * y + s[4]; s[4] = h[2].b2 * x - h[2].a2 * y;
    return y;
  }
  clear(): void { this.s.fill(0); this.ns.fill(0); }
}

class VintageChorus implements EffectInstance {
  /** Feedback ring and the 0.5 Hz DC blocker settle within 0.5 s; ungated hiss never stops. */
  get tail(): number { return this.noiseT > 0 && !this.gate ? Infinity : 0.5; }
  private readonly sr: number;
  private readonly buf = [new Float32Array(1), new Float32Array(1)];
  private readonly mask: number;
  private w = 0;
  private readonly chains = [new Chain(), new Chain()];
  private readonly filt: BQ[];
  private readonly fbY = new Float64Array(2);
  // LFO phase, accumulated in single precision from 0 like FL (its rates drift by
  // the same -0.07 % at 0.4 Hz, -0.01 % at 8 Hz)
  private phase = 0;
  private readonly dS = new Float64Array(4);   // smoothed delays (ms) and LFO positions
  // settings
  private mode = 0;
  private sine = false;
  private rate = 0.4;
  private syncSteps = 4;
  private sync = false;
  private startPh = 0;
  // glided values
  private lo = 1.0799;     // ms (before the delay smoothing)
  private hi = 5.2301;
  private lr = 0.5;
  private mT = 0.5; private mC = 0.5;          // Mix (FL smooths the control, then the gains follow)
  private fb = 0;                                // Feedback and High pass switch at once (FL)
  private gainT = 1; private gain = 1;
  private noiseT = 0; private noise = 0;
  private hp = 50;
  private invert = false;
  private mono = false;
  private gate = false;
  private gateEnv = 0;
  private gateGain = 0;
  private seed = 0x13579bdf;
  private readonly kTau: number;
  private readonly hissF: BQ[];
  private wasPlaying = false;

  constructor(sr: number) {
    this.sr = sr;
    let len = 1;
    while (len < Math.ceil(0.012 * sr) + 8) len <<= 1;
    this.buf = [new Float32Array(len), new Float32Array(len)];
    this.mask = len - 1;
    // fitted to FL's wet response (within 0.05 dB / 0.3 degrees to 14 kHz); the
    // feedback is taken before the last one-pole, one sample later (exact fit)
    this.filt = [lowpass2(7291.9, 0.6726, sr), lowpass2(6722.6, 0.7442, sr), highpass1(50, sr), lowpass1(7000, sr)];
    this.kTau = 1 - Math.exp(-1 / (DELAY_TAU * sr));
    this.hissF = [highpass1(4841.5, sr), lowpass2(20389.8, 1.3, sr), lowpass2(8717.3, 0.403, sr)];
    // FL starts from its constructor state (Chorus I, Mix 50 %, -65 dB hiss) and glides
    // from there to the first settings (the Default preset on insertion)
    this.setParams({ mode: 0, link: 0, speed: 49152, lfoType: 0, lrPhase: 3000, time1: 60, time2: 3000, mix: 3000, feedback: 0, highPass: 3000, gain: 0, noise: 3000 });
    // FL's output gain glides up from 0 (a 21.7 ms fade-in after creation)
    this.mC = 0; this.gain = 0; this.noise = 0;
    // FL's smoothed delay starts at 10 ms (measured: it glides down from there)
    this.dS[0] = 10; this.dS[1] = 10; this.dS[2] = 0.5; this.dS[3] = 0.5;
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const mode = Math.max(0, Math.min(2, Math.round(num(q.mode, 0))));
    const link = num(q.link, 0) >= 0.5;
    // 0: Chorus I, 1: Chorus II, 2: I+II, 3: Custom
    this.mode = mode === 2 ? 3 : link ? 2 : mode;
    if (this.mode === 0 || this.mode === 1) {
      this.lo = 1.0799; this.hi = 5.2301; this.sine = false; this.rate = this.mode === 0 ? 0.4 : 0.6; this.lr = 0.5; this.sync = false;
    } else if (this.mode === 2) {
      // the right channel runs only 10.3 degrees ahead in I+II (measured; FL's "Juno 6 Mode I + II" preset uses LR Phase 171)
      this.lo = 3.11 - 0.2599; this.hi = 3.11 + 0.2599; this.sine = true; this.rate = 8; this.lr = 171 / 6000; this.sync = false;
    } else {
      // FL's bulk delay is 1.95 samples (at 44.1 kHz) shorter than the shown time
      this.lo = Math.max(0.05, vchorusDelayMs(num(q.time1, 60)) - 0.0442);
      this.hi = Math.max(0.05, vchorusDelayMs(num(q.time2, 3000)) - 0.0442);
      this.sine = num(q.lfoType, 0) >= 0.5;
      this.rate = vchorusSpeedHz(num(q.speed, 80));
      this.syncSteps = vchorusSyncSteps(num(q.speed, 80));
      this.sync = num(q.sync, 0) >= 0.5;
      this.lr = Math.max(0, Math.min(6000, num(q.lrPhase, 3000))) / 6000;
      this.startPh = Math.max(0, Math.min(6000, num(q.startPhase, 0))) / 6000;
    }
    // FL: the Juno modes ignore Mix (fixed 50 %), Feedback, High pass, Invert and Mono;
    // Gain, Noise and Noise gate apply in every mode
    const custom = this.mode === 3;
    // equal power: wet = sqrt(m), dry = sqrt(1 - m) with FL's -45 dB dry floor at 100 % wet
    const m = custom ? Math.max(0, Math.min(1, num(q.mix, 3000) / 6000)) : 0.5;
    this.mT = m;
    this.fb = custom ? (Math.max(0, Math.min(6000, num(q.feedback, 0))) / 6000) * FB_MAX : 0;
    this.gainT = Math.pow(10, ((Math.max(0, Math.min(6000, num(q.gain, 0))) / 6000) * 12) / 20);
    this.noiseT = vchorusNoise(num(q.noise, 3000));
    // the Juno modes block only DC (first order at 0.5 Hz, measured); FL's high pass sits
    // ahead of the BBD (inside the feedback loop), so a change reaches the output late
    const hp = custom ? vchorusHighPassHz(num(q.highPass, 3000)) : 0.5;
    if (hp !== this.hp) { this.hp = hp; const h = highpass1(hp, this.sr); this.filt[2].b0 = h.b0; this.filt[2].b1 = h.b1; this.filt[2].a1 = h.a1; }
    this.invert = custom && num(q.invert, 0) >= 0.5;
    this.mono = custom && num(q.mono, 0) >= 0.5;
    this.gate = num(q.gate, 0) >= 0.5;
  }

  /** Uniform white noise in -1..1 (xorshift, allocation free). */
  private rnd(): number {
    let s = this.seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 2147483648 - 1;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const sr = this.sr, mask = this.mask, kT = this.kTau;
    // per block: the LFO increment (tempo sync restarts at Start phase)
    let inc: number;
    if (this.mode === 3 && this.sync) {
      const stepSec = 60 / Math.max(1, ctx.tempo) / 4;
      const period = this.syncSteps * stepSec;
      inc = 1 / (period * sr);
      if (ctx.playing) {
        const steps = (ctx.pos / Math.max(1, ctx.ppq)) * 4;
        const target = (((steps / this.syncSteps + this.startPh) % 1) + 1) % 1;
        if (!this.wasPlaying) this.phase = F(target);
      }
    } else inc = this.rate / sr;
    this.wasPlaying = ctx.playing;
    const incF = F(inc);
    const bufL = this.buf[0], bufR = this.buf[1];
    const chL = this.chains[0], chR = this.chains[1], f = this.filt;
    let w = this.w, phase = this.phase, fbL = this.fbY[0], fbR = this.fbY[1];
    let gain = this.gain, noise = this.noise, mC = this.mC;
    const fb = this.fb, mT = this.mT, gainT = this.gainT, noiseT = this.noiseT;
    const lo = this.lo, hi = this.hi, lr = this.lr;
    let dSL = this.dS[0], dSR = this.dS[1], pSL = this.dS[2], pSR = this.dS[3];
    const sine = this.sine, mono = this.mono, inv = this.invert ? -1 : 1, gateOn = this.gate;
    const msToS = sr / 1000;
    const gateRel = Math.exp(-1 / (0.15 * sr)), gateAtt = Math.exp(-1 / (0.005 * sr));
    let gateEnv = this.gateEnv, gateGain = this.gateGain;
    for (let i = 0; i < n; i++) {
      // FL's 21.7 ms one-pole on Mix (equal power: wet sqrt(m), dry sqrt(1 - m) with a
      // -45 dB dry floor at 100 % wet), Gain and Noise
      mC += (mT - mC) * kT; gain += (gainT - gain) * kT; noise += (noiseT - noise) * kT;
      const dry = Math.sqrt(0.999942 * (1 - mC) + 0.0000285 * mC), wet = Math.sqrt(mC);
      let xl = L[i], xr = R[i];
      if (mono) { const m = 0.5 * (xl + xr); xl = m; xr = m; }
      // LFO: 0..1 position between the two delay times
      phase = F(phase + incF);
      if (phase >= 1) phase = F(phase - 1);
      let pr = phase + lr;
      if (pr >= 1) pr -= 1;
      const uL = sine ? Math.sin(TWO_PI * phase) : tri(phase);
      const uR = sine ? Math.sin(TWO_PI * pr) : tri(pr);
      const tL = lo + (hi - lo) * 0.5 * (1 + uL), tR = lo + (hi - lo) * 0.5 * (1 + uR);
      dSL += (tL - dSL) * kT; dSR += (tR - dSR) * kT;
      pSL += (0.5 * (1 + uL) - pSL) * kT; pSR += (0.5 * (1 + uR) - pSR) * kT;
      const dL = dSL * msToS, dR = dSR * msToS;
      bufL[w] = chL.hp(xl + fb * fbL, f[2]);
      bufR[w] = chR.hp(xr + fb * fbR, f[2]);
      const tl = chL.run(this.read(bufL, w, dL), f), tr = chR.run(this.read(bufR, w, dR), f);
      fbL = tl; fbR = tr;
      let yl = chL.out(tl, f[3]), yr = chR.out(tr, f[3]);
      // hiss, gated by the input when asked
      if (noise > 0) {
        let g = 1;
        if (gateOn) {
          const lev = Math.max(Math.abs(xl), Math.abs(xr));
          gateEnv = lev > gateEnv ? lev + (gateEnv - lev) * gateAtt : lev + (gateEnv - lev) * gateRel;
          const target = gateEnv > 1e-4 ? 1 : 0;
          gateGain += (target - gateGain) * 0.002;
          g = gateGain;
        }
        // FL's hiss follows the LFO position (0 at the shorter time, 1 at the longer)
        const eL = 0.68 + pSL, eR = 0.68 + pSR;
        const aL = noise * HISS * eL * eL * g, aR = noise * HISS * eR * eR * g;
        yl += aL * chL.hiss(this.rnd(), this.hissF);
        yr += aR * chR.hiss(this.rnd(), this.hissF);
      }
      L[i] = gain * (dry * xl + inv * wet * yl);
      R[i] = gain * (dry * xr + inv * wet * yr);
      w = (w + 1) & mask;
    }
    if (!Number.isFinite(fbL + fbR)) this.clear();
    else { this.fbY[0] = Math.abs(fbL) > 1e-30 ? fbL : 0; this.fbY[1] = Math.abs(fbR) > 1e-30 ? fbR : 0; }
    for (const ch of this.chains) for (let k = 0; k < ch.s.length; k++) if (!(Math.abs(ch.s[k]) > 1e-30)) ch.s[k] = 0;
    this.w = w; this.phase = phase;
    this.dS[0] = dSL; this.dS[1] = dSR; this.dS[2] = pSL; this.dS[3] = pSR;
    this.mC = mC; this.gain = gain; this.noise = noise;
    this.gateEnv = gateEnv; this.gateGain = gateGain;
  }

  /** Cubic (Hermite) read at a fractional delay. */
  private read(buf: Float32Array, w: number, d: number): number {
    const mask = this.mask;
    if (d < 2) d = 2;
    const pos = w - d + mask + 1;
    const ip = pos | 0;
    const t = pos - ip;
    const xm1 = buf[(ip - 1) & mask], x0 = buf[ip & mask], x1 = buf[(ip + 1) & mask], x2 = buf[(ip + 2) & mask];
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * t + c2) * t + c1) * t + x0;
  }

  private clear(): void {
    this.buf[0].fill(0); this.buf[1].fill(0);
    this.chains[0].clear(); this.chains[1].clear();
    this.fbY.fill(0);
  }

  reset(): void {
    this.clear();
  }
}

export const effect: EffectModule = {
  id: 'vchorus',
  create: (sr) => new VintageChorus(sr),
};
