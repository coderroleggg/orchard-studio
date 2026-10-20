// Scratcher: a vinyl turntable playing a loaded sample, added to the track's
// audio (FL passes the input through and adds the turntable). The platter
// has a position and a velocity: the motor (Transport forward / reverse,
// Turntable speed, 1x at the default) pulls the velocity toward its speed
// with the Turntable acceleration (platter mass), Turntable hold brakes it,
// and moving the Wave position (the platter, by mouse or automation) grabs
// the record: the position then follows the hand through a damped spring
// shaped by Smooth 1 / 2, Smooth 3 smooths the hand's (stepwise) movement and
// Smooth 4 sets how long a pause in the movement still holds the record; on
// release the platter keeps its momentum. With a time code selected (DVS) the platter follows the
// speed and direction of the time code signal on the input, which is not
// passed on. Without a sample the input passes unchanged.

import type { EffectInstance, EffectModule, FxContext, FxEnv, FxMonitor } from '../types';
import { SC_POS_MAX, SC_SAMPLE_PREFIX, scSpeedFactor, scVolumeGain } from '../../../model/fx/plugins/scratcher';

/** Time code carrier frequencies (Hz), by time code index (0 = off). */
const TC_CARRIER = [0, 1000, 1000, 1000, 2000, 2000, 2500, 2500, 1000];
const SCOPE_N = 96;

function hermite(xm1: number, x0: number, x1: number, x2: number, t: number): number {
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

class Scratcher implements EffectInstance {
  tail = 0;
  private sr: number;
  private env: FxEnv;

  // sample
  private sampleId = '';
  private smpL: Float32Array | null = null;
  private smpR: Float32Array | null = null;
  private len = 0;
  private rate = 1;
  private lookup = 0;

  // parameters
  private posParam = 690;
  private posPrev = NaN;
  private mute = false;
  private speed = 1;
  private acc = 25;
  private pan = 0;
  private vol = 1;
  private hold = false;
  private transport = 0;
  private sm = [0.5, 0.908, 0.999, 0.4];
  private timecode = 0;
  private riaa = false;

  // platter
  private pos = 0;
  private vel = 0;
  private grabbed = 0;
  private target = 0;
  private targetS = 0;
  private kAcc = 0;
  private w0 = 0;
  private zeta = 0.9;
  private kRate = 0;
  private grabHold = 0;
  private gL = 1;
  private gR = 1;
  private gLs = 1;
  private gRs = 1;
  private kGain: number;

  // DVS
  private tcPhase = 0;
  private tcFreq = 0;
  private tcLevel = 0;
  private scope = new Float32Array(SCOPE_N * 2);
  private scopeW = 0;

  constructor(sampleRate: number, env: FxEnv) {
    this.sr = sampleRate;
    this.env = env;
    this.kGain = 1 - Math.exp(-1 / (0.01 * sampleRate));
    this.updateCoefs();
  }

  private updateCoefs(): void {
    const sr = this.sr;
    const tauAcc = 0.02 * Math.pow(100, 1 - Math.min(100, Math.max(0, this.acc)) / 100);
    this.kAcc = 1 - Math.exp(-1 / (tauAcc * sr));
    // hand-following spring: 2..60 Hz (Smooth 1), damping 0.3..1 (Smooth 2)
    this.w0 = (2 * Math.PI * 2 * Math.pow(30, this.sm[0])) / sr;
    this.zeta = 0.3 + 0.7 * this.sm[1];
    // hand-movement smoothing: Smooth 3 is the retention per 1/48000 s
    const keep = Math.pow(Math.min(0.99999, Math.max(0, this.sm[2])), 48000 / sr);
    this.kRate = 1 - keep;
    // a pause in the hand's movement shorter than this still holds the record (20..220 ms)
    this.grabHold = Math.round((0.02 + 0.2 * this.sm[3]) * sr);
  }

  setParams(p: unknown): void {
    const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const sample = q.sample as { id?: unknown } | null | undefined;
    const id = sample && typeof sample.id === 'string' ? sample.id : '';
    if (id !== this.sampleId) {
      this.sampleId = id;
      this.smpL = this.smpR = null;
      this.len = 0;
      this.lookup = 0;
      this.findSample();
    }
    const pos = Math.min(SC_POS_MAX, Math.max(0, num(q.pos, 690)));
    if (pos !== this.posParam || Number.isNaN(this.posPrev)) {
      // the platter moved (mouse or automation): grab the record
      if (!Number.isNaN(this.posPrev)) this.grabbed = this.grabHold;
      this.posParam = pos;
      this.posPrev = pos;
      this.target = (pos / SC_POS_MAX) * this.len;
      if (!this.grabbed) { this.pos = this.target; this.targetS = this.target; }
    }
    this.mute = num(q.mute, 1) < 0.5;
    this.speed = scSpeedFactor(num(q.speed, 50));
    this.acc = num(q.acc, 25);
    this.pan = Math.min(1, Math.max(-1, num(q.pan, 0) / 128));
    this.vol = scVolumeGain(num(q.vol, 199));
    this.hold = num(q.hold, 0) >= 0.5;
    this.transport = Math.round(Math.min(1, Math.max(-1, num(q.transport, 0))));
    this.sm = [num(q.sm1, 500) / 1000, num(q.sm2, 908) / 1000, num(q.sm3, 999) / 1000, num(q.sm4, 400) / 1000].map((v) => Math.min(1, Math.max(0, v)));
    this.timecode = Number.isInteger(q.timecode) ? Math.min(TC_CARRIER.length - 1, Math.max(0, q.timecode as number)) : 0;
    this.riaa = !!q.riaa;
    this.updateCoefs();
    const g = this.mute ? 0 : this.vol;
    this.gL = g * (this.pan > 0 ? 1 - this.pan : 1);
    this.gR = g * (this.pan < 0 ? 1 + this.pan : 1);
  }

  private findSample(): void {
    if (!this.sampleId) return;
    const s = this.env.sample(SC_SAMPLE_PREFIX + this.sampleId);
    if (!s || !s.channels.length || !s.channels[0].length) return;
    this.smpL = s.channels[0];
    this.smpR = s.channels[1] ?? s.channels[0];
    this.len = this.smpL.length;
    this.rate = s.sampleRate / this.sr;
    this.target = (this.posParam / SC_POS_MAX) * this.len;
    this.pos = this.targetS = this.target;
  }

  process(L: Float32Array, R: Float32Array, n: number, _ctx: FxContext): void {
    if (!this.smpL && this.sampleId) {
      // the sample may arrive after the plugin: look again now and then
      if (--this.lookup <= 0) { this.lookup = 64; this.findSample(); }
    }
    const tc = this.timecode;
    const sL = this.smpL, sR = this.smpR, len = this.len;
    if (!sL || !sR || len < 4) {
      if (tc > 0) { L.fill(0, 0, n); R.fill(0, 0, n); }
      return;
    }
    const rate = this.rate;
    const vt = this.hold ? 0 : this.transport * this.speed;
    const kAcc = this.hold ? Math.max(this.kAcc, 1 - Math.exp(-1 / (0.06 * this.sr))) : this.kAcc;
    const w0 = this.w0, zeta = this.zeta, kRate = this.kRate, kG = this.kGain;
    let pos = this.pos, vel = this.vel, grabbed = this.grabbed, targetS = this.targetS;
    const target = this.target;
    let gLs = this.gLs, gRs = this.gRs;
    const gL = this.gL, gR = this.gR;
    // DVS: carrier tracking on the input (L/R in quadrature)
    const f0 = TC_CARRIER[tc] ?? 0;
    let tcPhase = this.tcPhase, tcFreq = this.tcFreq, tcLevel = this.tcLevel;
    const kTc = 1 - Math.exp(-1 / (0.004 * this.sr));
    const kLvl = 1 - Math.exp(-1 / (0.02 * this.sr));
    const thr = this.riaa ? 0.003 : 0.01;
    for (let i = 0; i < n; i++) {
      const inL = L[i], inR = R[i];
      if (f0 > 0) {
        const ph = Math.atan2(inR, inL);
        let d = ph - tcPhase;
        if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
        tcPhase = ph;
        tcFreq += ((d * this.sr) / (2 * Math.PI) - tcFreq) * kTc;
        const a = Math.abs(inL) + Math.abs(inR);
        tcLevel += (a - tcLevel) * kLvl;
        const sp = tcLevel > thr ? tcFreq / f0 : 0;
        vel = Number.isFinite(sp) ? Math.max(-8, Math.min(8, sp)) : 0;
        if ((i & 3) === 0) {
          const k = this.scopeW;
          this.scope[k * 2] = inL;
          this.scope[k * 2 + 1] = inR;
          this.scopeW = (k + 1) % SCOPE_N;
        }
      } else if (grabbed > 0) {
        // the hand holds the record: damped spring toward the (smoothed) hand position
        targetS += (target - targetS) * kRate;
        let e = targetS - pos;
        if (e > len / 2) e -= len; else if (e < -len / 2) e += len;
        const acc = w0 * w0 * e - 2 * zeta * w0 * vel * rate;
        vel += acc / rate;
        grabbed--;
      } else {
        // the motor pulls the platter toward its speed (platter mass = acceleration)
        vel += (vt - vel) * kAcc;
        targetS = pos;
      }
      if (!(vel > -64 && vel < 64)) vel = 0;
      pos += vel * rate;
      if (pos >= len) pos -= len * Math.floor(pos / len);
      else if (pos < 0) pos += len * Math.ceil(-pos / len);
      // read the record (cubic, wrapping)
      const ip = Math.floor(pos);
      const t = pos - ip;
      const i0 = ip % len, im1 = (i0 - 1 + len) % len, i1 = (i0 + 1) % len, i2 = (i0 + 2) % len;
      const yL = hermite(sL[im1], sL[i0], sL[i1], sL[i2], t);
      const yR = hermite(sR[im1], sR[i0], sR[i1], sR[i2], t);
      gLs += (gL - gLs) * kG;
      gRs += (gR - gRs) * kG;
      const base = f0 > 0 ? 0 : 1;
      L[i] = inL * base + yL * gLs;
      R[i] = inR * base + yR * gRs;
    }
    if (!Number.isFinite(pos)) pos = 0;
    if (!Number.isFinite(tcFreq)) tcFreq = 0;
    this.pos = pos; this.vel = vel; this.grabbed = grabbed; this.targetS = targetS;
    this.gLs = gLs; this.gRs = gRs;
    this.tcPhase = tcPhase; this.tcFreq = tcFreq; this.tcLevel = tcLevel;
  }

  reset(): void {
    this.vel = 0;
    this.grabbed = 0;
    this.pos = this.targetS = this.len ? (this.posParam / SC_POS_MAX) * this.len : 0;
    this.gLs = this.gL; this.gRs = this.gR;
    this.tcPhase = this.tcFreq = this.tcLevel = 0;
  }

  monitor(): FxMonitor {
    return {
      loaded: this.len > 0,
      frac: this.len > 0 ? this.pos / this.len : 0,
      sec: this.len > 0 ? (this.pos * this.rate) / this.sr : 0,
      speed: this.vel,
      level: this.tcLevel,
      scope: Array.from(this.scope),
    };
  }
}

export const effect: EffectModule = {
  id: 'scratcher',
  create: (sampleRate, _blockSize, env) => new Scratcher(sampleRate, env),
};
