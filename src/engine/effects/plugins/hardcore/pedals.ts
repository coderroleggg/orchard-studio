// The eleven Hardcore stomp-boxes, calibrated against FL's binary (flfxhost
// measurements, docs/research/fx/hardcore.md). Each pedal takes its knob
// values (0..1 = raw / 256) and processes a stereo block in place. FL passes
// the dry signal at unity through most pedals and adds the effect on top, with
// the measured polarities and gain laws. Drives run 4x oversampled; parameters
// glide (per sample for gains and LFO depths, per block for filters).

import { HcType, hcMap } from '../../../../model/fx/plugins/hardcore';
import { FdnReverb } from './reverb';
import { Biquad2, DelayLine, Glide, Lfo, Oversampler4, Smooth, clamp, dbToLin, design, fl, glideK, lerpTable, onePoleK, rbj } from './dsp';
import { analogMag2, prototype } from '../../../dsp/biquad';

export interface Pedal {
  /** Knob values 0..1 (five; unused ones ignored). */
  set(k: ArrayLike<number>): void;
  process(L: Float32Array, R: Float32Array, n: number): void;
  reset(): void;
  /** Seconds the pedal rings after silence (reverb, delay feedback). */
  tail(): number;
  /** Bring smoothed values to their targets (after a reset). */
  snap(): void;
}

const log2 = Math.log2;
const SMOOTH_MS = 20;
/** |H(800 Hz)| of an analog prototype section (gain staging was measured at 800 Hz). */
const at800 = (kind: 'highpass' | 'lowpass' | 'peaking', f0: number, q: number, g = 0) => Math.sqrt(analogMag2(prototype(kind, q, g), 800 / f0));
/** The saturator both drives use (fits FL's harmonics and compression best). */
const sat = (x: number) => x / (1 + (x < 0 ? -x : x));

// ---------------------------------------------------------------- Distortion
// High pass (589 Hz) and the INFERNO bass resonance (86 Hz) feed the DIST drive
// into a x/(1+|x|) saturator (4x); the output passes a broad 1.7 kHz dip, the
// GLASS presence bell (2.43 kHz, +-20 dB), two low passes and the COMB. Drive
// and output gains per DIST were fitted to FL's output power and harmonics on
// 400 / 800 Hz sines (FL's high-drive harmonic structure is only approximated).

const DIST_PRE = [26.4, 40.6, 50.3, 57.5, 63.1];
const DIST_POST = [0.9, -7.9, -10.7, -13.0, -14.8];

class Distortion implements Pedal {
  private readonly sr: number;
  private readonly os = [new Oversampler4(), new Oversampler4()];
  private readonly ovs = new Float64Array(4);
  private readonly hp = new Biquad2();
  private readonly inferno = new Biquad2();
  private readonly dip = new Biquad2();
  private readonly glass = new Biquad2();
  private readonly lp1 = new Biquad2();
  private readonly lp2 = new Biquad2();
  private readonly comb = [new DelayLine(64), new DelayLine(64)];
  private readonly combD: number;
  private readonly pre: Smooth;
  private readonly post: Smooth;
  private readonly combAmt: Smooth;
  private readonly infG = new Glide(24.3);
  private readonly infQ = new Glide(1.68);
  private readonly glassDb = new Glide(0);
  private readonly norm: number;

  constructor(sr: number) {
    this.sr = sr;
    const k = onePoleK(SMOOTH_MS, sr);
    this.pre = new Smooth(1, k);
    this.post = new Smooth(1, k);
    this.combAmt = new Smooth(0.25, k);
    this.combD = 0.00022 * sr;
    this.hp.set(design('highpass', 589, 0.76, 0, sr));
    this.dip.set(design('peaking', 1704, 0.12, -4.4, sr));
    this.lp1.set(design('lowpass', 4316, 2.19, 0, sr));
    this.lp2.set(design('lowpass', 2737, 0.62, 0, sr));
    // the staging tables include the filters' gains at 800 Hz (INFERNO / GLASS at 12 o'clock)
    const preAt = at800('highpass', 589, 0.76) * at800('peaking', 86, 1.68, 24.3);
    const postAt = at800('peaking', 1704, 0.12, -4.4) * at800('lowpass', 4316, 2.19) * at800('lowpass', 2737, 0.62);
    this.norm = 1 / (preAt * postAt);
    this.coefs();
  }

  private coefs(): void {
    this.inferno.set(design('peaking', 86, this.infQ.cur, this.infG.cur, this.sr));
    this.glass.set(design('peaking', 2430, 0.42, this.glassDb.cur, this.sr));
  }

  set(k: ArrayLike<number>): void {
    const d = clamp(k[0], 0, 1), c = clamp(k[1], 0, 1), inf = clamp(k[2], 0, 1);
    this.pre.set(dbToLin(lerpTable(DIST_PRE, d)));
    this.post.set(dbToLin(lerpTable(DIST_POST, d)) * this.norm);
    this.combAmt.set(0.5 * c);
    this.infG.set(inf <= 0.5 ? 1.8 + 45 * inf : 24.3 + 32.2 * (inf - 0.5));
    this.infQ.set(1.68 + 6.6 * Math.max(0, inf - 0.5) ** 2);
    this.glassDb.set(hcMap.distGlassDb(k[3]));
  }

  snap(): void { this.pre.snap(); this.post.snap(); this.combAmt.snap(); this.infG.snap(); this.infQ.snap(); this.glassDb.snap(); this.coefs(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const kb = glideK(n, SMOOTH_MS, this.sr);
    const a = this.infG.step(kb), b = this.infQ.step(kb), c = this.glassDb.step(kb);
    if (a || b || c) this.coefs();
    this.hp.process(L, R, n);
    this.inferno.process(L, R, n);
    const ovs = this.ovs;
    for (let i = 0; i < n; i++) {
      const g = this.pre.next(), pg = this.post.next();
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? L : R;
        const os = this.os[ch];
        os.up(buf[i] * g, ovs);
        ovs[0] = sat(ovs[0]); ovs[1] = sat(ovs[1]); ovs[2] = sat(ovs[2]); ovs[3] = sat(ovs[3]);
        buf[i] = os.down(ovs) * pg;
      }
    }
    this.dip.process(L, R, n);
    this.glass.process(L, R, n);
    this.lp1.process(L, R, n);
    this.lp2.process(L, R, n);
    const D = this.combD;
    for (let i = 0; i < n; i++) {
      const cc = this.combAmt.next();
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? L : R, cb = this.comb[ch];
        const y = buf[i];
        cb.write(y);
        buf[i] = (y + cc * cb.read(D)) / (1 + cc);
      }
    }
    this.os[0].flush(); this.os[1].flush();
  }

  reset(): void {
    for (const o of this.os) o.reset();
    for (const c of this.comb) c.clear();
    for (const f of [this.hp, this.inferno, this.dip, this.glass, this.lp1, this.lp2]) f.reset();
  }

  tail(): number { return 0; }
}

// ---------------------------------------------------------------- Tube Stage
// LOW high pass and a fixed 2.1 kHz low pass -> GAIN drive -> x/(1+|x|) (4x)
// -> HIGH low pass -> fixed 12.4 kHz low pass. Filter tables and gain staging
// fitted to FL's responses; the 2.1 kHz pole sits before the saturator because
// FL's saturated output keeps square-wave harmonics (3rd at -9.5 dB).

const TUBE_LOW_F = [982, 760, 548.3, 383.6, 222, 61.7, 25.7, 15.2, 9.5].map(Math.log);
const TUBE_LOW_Q = [0.47, 0.44, 0.37, 0.31, 0.22, 0.09, 0.07, 0.09, 0.17];
const TUBE_HIGH_F = [1655, 2106, 2727, 3662, 5470, 9935, 11190, 12600, 14186].map(Math.log);
const TUBE_HIGH_Q = [0.53, 0.5, 0.48, 0.45, 0.39, 0.32, 0.93, 1.54, 2.15];
const TUBE_PRE = [-15.2, -5.5, 11.5, 22.8, 29.8, 37.0, 42.2, 46.5, 50.0];
const TUBE_POST = [20.2, 11.2, -1.0, -3.9, -3.5, -4.8, -5.1, -5.1, -5.0];

class TubeStage implements Pedal {
  private readonly sr: number;
  private readonly os = [new Oversampler4(), new Oversampler4()];
  private readonly ovs = new Float64Array(4);
  private readonly hp = new Biquad2();
  private readonly lp = new Biquad2();
  private readonly fix1 = new Biquad2();
  private readonly fix2 = new Biquad2();
  private readonly pre: Smooth;
  private readonly post: Smooth;
  private readonly low = new Glide(0.5);
  private readonly high = new Glide(0.5);
  private readonly preNorm: number;
  private readonly postNorm: number;

  constructor(sr: number) {
    this.sr = sr;
    const k = onePoleK(SMOOTH_MS, sr);
    this.pre = new Smooth(1, k);
    this.post = new Smooth(1, k);
    this.fix1.set(design('lowpass', 2086, 0.53, 0, sr));
    this.fix2.set(design('lowpass', 12394, 0.94, 0, sr));
    // staging was fitted at 800 Hz with LOW at 12 o'clock and HIGH fully up
    this.preNorm = 1 / (at800('highpass', 222, 0.22) * at800('lowpass', 2086, 0.53));
    this.postNorm = 1 / (at800('lowpass', 14186, 2.15) * at800('lowpass', 12394, 0.94));
    this.coefs();
  }

  private coefs(): void {
    this.hp.set(design('highpass', Math.exp(lerpTable(TUBE_LOW_F, this.low.cur)), lerpTable(TUBE_LOW_Q, this.low.cur), 0, this.sr));
    this.lp.set(design('lowpass', Math.exp(lerpTable(TUBE_HIGH_F, this.high.cur)), lerpTable(TUBE_HIGH_Q, this.high.cur), 0, this.sr));
  }

  set(k: ArrayLike<number>): void {
    this.low.set(clamp(k[0], 0, 1));
    this.high.set(clamp(k[1], 0, 1));
    const g = clamp(k[2], 0, 1);
    this.pre.set(dbToLin(lerpTable(TUBE_PRE, g)) * this.preNorm);
    this.post.set(dbToLin(lerpTable(TUBE_POST, g)) * this.postNorm);
  }

  snap(): void { this.pre.snap(); this.post.snap(); this.low.snap(); this.high.snap(); this.coefs(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const kb = glideK(n, SMOOTH_MS, this.sr);
    const a = this.low.step(kb), b = this.high.step(kb);
    if (a || b) this.coefs();
    this.hp.process(L, R, n);
    this.fix1.process(L, R, n);
    const ovs = this.ovs;
    for (let i = 0; i < n; i++) {
      const g = this.pre.next(), pg = this.post.next();
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? L : R;
        const os = this.os[ch];
        os.up(buf[i] * g, ovs);
        ovs[0] = sat(ovs[0]); ovs[1] = sat(ovs[1]); ovs[2] = sat(ovs[2]); ovs[3] = sat(ovs[3]);
        buf[i] = os.down(ovs) * pg;
      }
    }
    this.lp.process(L, R, n);
    this.fix2.process(L, R, n);
    this.os[0].flush(); this.os[1].flush();
  }

  reset(): void {
    for (const o of this.os) o.reset();
    for (const f of [this.hp, this.lp, this.fix1, this.fix2]) f.reset();
  }

  tail(): number { return 0; }
}

// -------------------------------------------------------------------- Chorus
// Dry at unity plus two swept voices per channel at -2 x INTENSITY^2 each:
// voice A (8.57 ms, same on both sides) and voice B (11.04 ms left, 10.04 ms
// right), each sweeping down by WIDTH's span; LFO 0.1 + 5 x SPEED Hz.

const CH_BASE = [8.573, 11.042, 10.042];
const CH_PHASE = [0, 1 / 3, 2 / 3];

class Chorus implements Pedal {
  private readonly sr: number;
  private readonly dl: DelayLine[];
  private readonly lfo = new Lfo();
  private readonly span: Smooth;
  private readonly gain: Smooth;

  constructor(sr: number) {
    this.sr = sr;
    const max = Math.ceil(0.014 * sr) + 8;
    this.dl = [new DelayLine(max), new DelayLine(max)];
    this.span = new Smooth(0, onePoleK(SMOOTH_MS * 2, sr));
    this.gain = new Smooth(-0.5, onePoleK(SMOOTH_MS, sr));
  }

  set(k: ArrayLike<number>): void {
    this.span.set(hcMap.chorusSpanMs(k[0]) * 0.001 * this.sr);
    this.lfo.setRate(hcMap.chorusRateHz(k[1]), this.sr);
    this.gain.set(hcMap.chorusVoiceGain(k[2]));
  }

  snap(): void { this.span.snap(); this.gain.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const s = 0.001 * this.sr;
    const a0 = CH_BASE[0] * s, b0L = CH_BASE[1] * s, b0R = CH_BASE[2] * s;
    const dlL = this.dl[0], dlR = this.dl[1];
    for (let i = 0; i < n; i++) {
      const sp = this.span.next(), g = this.gain.next();
      const dA = a0 - sp * (0.5 - 0.5 * this.lfo.at(CH_PHASE[0] + 0.25));
      const dBL = b0L - sp * (0.5 - 0.5 * this.lfo.at(CH_PHASE[1] + 0.25));
      const dBR = b0R - sp * (0.5 - 0.5 * this.lfo.at(CH_PHASE[2] + 0.25));
      this.lfo.step();
      const l = L[i], r = R[i];
      const wl = dlL.read(dA) + dlL.read(dBL), wr = dlR.read(dA) + dlR.read(dBR);
      dlL.write(l); dlR.write(r);
      L[i] = l + g * wl;
      R[i] = r + g * wr;
    }
  }

  reset(): void { for (const d of this.dl) d.clear(); }
  tail(): number { return 0.02; }
}

// ------------------------------------------------------------------- Flanger
// Dry plus one voice at -(0.11 + 0.894 x INTENSITY), the delay sweeping
// between half and all of 0.125 + 4.85 x WIDTH^2 ms at 0.032 + 9.98 x SPEED^3 Hz,
// with a small negative feedback (-0.088). Mono (same on both sides).

class Flanger implements Pedal {
  private readonly sr: number;
  private readonly dl: DelayLine[];
  private readonly lfo = new Lfo();
  private readonly dmax: Smooth;
  private readonly wet: Smooth;

  constructor(sr: number) {
    this.sr = sr;
    const max = Math.ceil(0.006 * sr) + 8;
    this.dl = [new DelayLine(max), new DelayLine(max)];
    this.dmax = new Smooth(0.0013 * sr, onePoleK(SMOOTH_MS * 2, sr));
    this.wet = new Smooth(-0.55, onePoleK(SMOOTH_MS, sr));
  }

  set(k: ArrayLike<number>): void {
    this.dmax.set(hcMap.flangerMaxMs(k[0]) * 0.001 * this.sr);
    this.lfo.setRate(hcMap.flangerRateHz(k[1]), this.sr);
    this.wet.set(hcMap.flangerWet(k[2]));
  }

  snap(): void { this.dmax.snap(); this.wet.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const dm = this.dmax.next(), w = this.wet.next();
      const d = Math.max(1, dm * (0.75 + 0.25 * this.lfo.next()));
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? L : R, dl = this.dl[ch];
        const x = buf[i];
        const v = dl.read(d);
        dl.write(x - 0.088 * v);
        buf[i] = x + w * v;
      }
    }
  }

  reset(): void { for (const d of this.dl) d.clear(); }
  tail(): number { return 0.03; }
}

// -------------------------------------------------------------------- Phaser
// Six first-order all-passes at fc (TUNE: max(220, 6550 TUNE^2) Hz) swept up by
// 1.78 x WIDTH^2 octaves at 21 x SPEED^2 Hz, 0.4 feedback; out = dry + INTENSITY x chain.

class Phaser implements Pedal {
  private readonly sr: number;
  private readonly lfo = new Lfo();
  private readonly st = [new Float64Array(12), new Float64Array(12)];
  private readonly fbv = new Float64Array(2);
  private readonly fcLog: Smooth;
  private readonly sweep: Smooth;
  private readonly mix: Smooth;

  constructor(sr: number) {
    this.sr = sr;
    const k = onePoleK(SMOOTH_MS * 2, sr);
    this.fcLog = new Smooth(log2(1637), k);
    this.sweep = new Smooth(0.45, k);
    this.mix = new Smooth(0.5, onePoleK(SMOOTH_MS, sr));
  }

  set(k: ArrayLike<number>): void {
    this.lfo.setRate(hcMap.phaserRateHz(k[0]), this.sr);
    this.fcLog.set(log2(hcMap.phaserFcHz(k[1])));
    this.sweep.set(hcMap.phaserSweepOct(k[2]));
    this.mix.set(clamp(k[3], 0, 1));
  }

  snap(): void { this.fcLog.snap(); this.sweep.snap(); this.mix.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const piOverSr = Math.PI / this.sr, fmax = this.sr * 0.45;
    for (let i = 0; i < n; i++) {
      const fcl = this.fcLog.next(), sw = this.sweep.next(), mix = this.mix.next();
      const s = this.lfo.next();
      const f = Math.min(fmax, Math.pow(2, fcl + sw * (0.5 + 0.5 * s)));
      const t = Math.tan(f * piOverSr);
      const a = (t - 1) / (t + 1);
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? L : R;
        const x = buf[i];
        const z = this.st[ch];
        let v = x + 0.4 * this.fbv[ch];
        for (let j = 0; j < 6; j++) {
          const y = a * v + z[2 * j] - a * z[2 * j + 1];
          z[2 * j] = v; z[2 * j + 1] = y;
          v = y;
        }
        this.fbv[ch] = fl(v);
        buf[i] = x + mix * v;
      }
    }
    for (const z of this.st) for (let j = 0; j < 12; j++) z[j] = fl(z[j]);
  }

  reset(): void { for (const z of this.st) z.fill(0); this.fbv.fill(0); }
  tail(): number { return 0.05; }
}

// -------------------------------------------------------------------- Reverb
// Dry at unity plus the FDN reverb: RT60 from DECAY (measured table), HI-DUMP
// as a high-shelf loss in the loop, wet level 0.122 + 0.878 MIX^5 (of full).

/** Output scale of the FDN so the wet level matches FL's at MIX 100%. */
export const HC_REVERB_LEVEL = 3.08;

class Reverb implements Pedal {
  private readonly fdn: FdnReverb;
  private readonly wL: Float32Array;
  private readonly wR: Float32Array;
  private readonly wet: Smooth;
  private decay = 2.3;

  constructor(sr: number, maxBlock: number) {
    this.fdn = new FdnReverb(sr);
    this.wL = new Float32Array(maxBlock);
    this.wR = new Float32Array(maxBlock);
    this.wet = new Smooth(0.15, onePoleK(SMOOTH_MS, sr));
  }

  set(k: ArrayLike<number>): void {
    this.decay = hcMap.reverbRtS(k[0]);
    this.fdn.set(this.decay, 1500, 0, 1, hcMap.reverbDampDb(k[1]));
    this.wet.set(HC_REVERB_LEVEL * hcMap.reverbWet(k[2]));
  }

  snap(): void { this.wet.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const wL = this.wL, wR = this.wR;
    this.fdn.process(L, R, wL, wR, n);
    for (let i = 0; i < n; i++) {
      const w = this.wet.next();
      L[i] += wL[i] * w;
      R[i] += wR[i] * w;
    }
  }

  reset(): void { this.fdn.reset(); }
  tail(): number { return this.decay * 1.1 + 0.05; }
}

// --------------------------------------------------------------------- Delay
// Dry at unity plus -(0.1 + 0.9 MIX^2) of the echo; time 995 x TIME ms (99.4 ..
// 985 ms), feedback -0.96 DECAY^2, a 1 Hz wow of 3.13 sin(pi TIME) ms peak to
// peak, linear interpolation (its high-frequency loss shapes the repeats).

class Delay implements Pedal {
  private readonly sr: number;
  private readonly dl: DelayLine[];
  private readonly wow = new Lfo();
  private readonly time: Smooth;
  private readonly wowAmp: Smooth;
  private readonly fb: Smooth;
  private readonly wet: Smooth;
  private fbT = 0.24;
  private timeS = 0.5;

  constructor(sr: number) {
    this.sr = sr;
    const max = Math.ceil(1.0 * sr) + 64;
    this.dl = [new DelayLine(max), new DelayLine(max)];
    this.wow.setRate(1, sr);
    this.time = new Smooth(0.5 * sr, onePoleK(60, sr));
    const k = onePoleK(SMOOTH_MS, sr);
    this.wowAmp = new Smooth(0, k);
    this.fb = new Smooth(-0.24, k);
    this.wet = new Smooth(-0.325, k);
  }

  set(k: ArrayLike<number>): void {
    this.timeS = hcMap.delayTimeMs(k[0]) / 1000;
    this.time.set(this.timeS * this.sr);
    this.wowAmp.set(0.5 * hcMap.delayWowMs(k[0]) * 0.001 * this.sr);
    this.fbT = hcMap.delayFeedback(k[1]);
    this.fb.set(this.fbT);
    this.wet.set(hcMap.delayWet(k[2]));
  }

  snap(): void { this.time.snap(); this.wowAmp.snap(); this.fb.snap(); this.wet.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const dlL = this.dl[0], dlR = this.dl[1];
    for (let i = 0; i < n; i++) {
      const t = Math.max(2, this.time.next() + this.wowAmp.next() * this.wow.next());
      const fb = this.fb.next(), w = this.wet.next();
      const l = L[i], r = R[i];
      const yl = dlL.read(t), yr = dlR.read(t);
      dlL.write(clamp(l + fb * yl, -8, 8));
      dlR.write(clamp(r + fb * yr, -8, 8));
      L[i] = l + w * yl;
      R[i] = r + w * yr;
    }
  }

  reset(): void { for (const d of this.dl) d.clear(); }

  tail(): number {
    const fb = Math.abs(this.fbT);
    const repeats = fb > 0.001 ? Math.log(1e-3) / Math.log(fb) : 1;
    return Math.min(60, this.timeS * (repeats + 1) + 0.05);
  }
}

// ---------------------------------------------------------------- Noise Gate
// Hard gate on the peak level: opens above -64 + 64 x TRESHOLD dB, holds 100 ms
// after the level falls below, then closes; ATTACK / RELEASE time constants
// 5.6 + 226 x knob^2 ms. Closed = silence.

class NoiseGate implements Pedal {
  private readonly sr: number;
  private env = 0;
  private readonly envK: number;
  private thr = 0.01;
  private ka = 0.1;
  private kr = 0.001;
  private g = 0;
  private open = false;
  private hold = 0;
  private readonly holdN: number;

  constructor(sr: number) {
    this.sr = sr;
    this.envK = Math.exp(-1 / (0.004 * sr));
    this.holdN = Math.round(0.1 * sr);
  }

  set(k: ArrayLike<number>): void {
    this.ka = onePoleK(hcMap.gateTimeMs(k[0]), this.sr);
    this.kr = onePoleK(hcMap.gateTimeMs(k[1]), this.sr);
    this.thr = dbToLin(hcMap.gateThresholdDb(k[2]));
  }

  snap(): void {}

  process(L: Float32Array, R: Float32Array, n: number): void {
    let g = this.g, open = this.open, hold = this.hold, env = this.env;
    const thr = this.thr, thrLo = thr * 0.944, ek = this.envK;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      env = a > env ? a : env * ek;
      if (env > thr) { open = true; hold = this.holdN; }
      else if (open && env < thrLo) { if (hold > 0) hold--; else open = false; }
      g += ((open ? 1 : 0) - g) * (open ? this.ka : this.kr);
      L[i] = l * g; R[i] = r * g;
    }
    this.g = fl(g); this.open = open; this.hold = hold; this.env = fl(env);
  }

  reset(): void { this.env = 0; this.g = 0; this.open = false; this.hold = 0; }
  tail(): number { return 0; }
}

// ----------------------------------------------------------------- Equalizer
// RBJ low shelf 300 Hz, bells 700 Hz and 1.8 kHz, high shelf 7 kHz, all with a
// 0.98-octave bandwidth, +-20 dB with a square law around 12 o'clock.

const EQ4: [('lowshelf' | 'peak' | 'highshelf'), number][] = [['lowshelf', 300], ['peak', 700], ['peak', 1800], ['highshelf', 7000]];

class Equalizer implements Pedal {
  private readonly sr: number;
  private readonly f = EQ4.map(() => new Biquad2());
  private readonly g = EQ4.map(() => new Glide(0));

  constructor(sr: number) { this.sr = sr; this.coefs(true); }

  private coefs(all: boolean, kb = 1): void {
    for (let b = 0; b < 4; b++) {
      if (this.g[b].step(kb) || all) this.f[b].set(rbj(EQ4[b][0], EQ4[b][1], this.sr, this.g[b].cur, 0, 0.98));
    }
  }

  set(k: ArrayLike<number>): void { for (let b = 0; b < 4; b++) this.g[b].set(hcMap.eqPedalDb(k[b])); }
  snap(): void { for (const g of this.g) g.snap(); this.coefs(true); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    this.coefs(false, glideK(n, SMOOTH_MS, this.sr));
    for (const f of this.f) f.process(L, R, n);
  }

  reset(): void { for (const f of this.f) f.reset(); }
  tail(): number { return 0; }
}

// ---------------------------------------------------------------- Compressor
// Peak follower on the louder channel (attack e^(2.061 + 1.949 ATTACK) ms,
// release e^(-0.371 + 2.202 RELEASE) ms) into a soft-knee curve whose ratio,
// knee and threshold follow RATIO (fitted to FL's static curves and its
// attack / release behaviour, 1.4 dB rms); TRESHOLD moves it by 64 dB. No make-up.

/** Per RATIO 0, .25, .5, .75, .9, 1: slope 1 - 1/ratio, knee width (dB), threshold at TRESHOLD 0 (dB). */
const COMP_R = [0, 0.25, 0.5, 0.75, 0.9, 1];
const COMP_SLOPE = [1 - 1 / 7.88, 1 - 1 / 8.27, 1 - 1 / 9.24, 1 - 1 / 11.42, 1 - 1 / 15.32, 1 - 1 / 43.88];
const COMP_KNEE = [52.4, 52.3, 52.3, 51.9, 49.8, 40.5];
const COMP_THR = [-38.65, -40.87, -43.82, -48.64, -54.41, -64.6];

function compInterp(t: number[], r: number): number {
  let i = 0;
  while (i < COMP_R.length - 2 && r > COMP_R[i + 1]) i++;
  const f = (r - COMP_R[i]) / (COMP_R[i + 1] - COMP_R[i]);
  return t[i] + (t[i + 1] - t[i]) * f;
}

class Compressor implements Pedal {
  private readonly sr: number;
  private thr = -40;
  private slope = 0.9;
  private knee = 52;
  private ka = 0.1;
  private kr = 0.01;
  private env = 0;

  constructor(sr: number) { this.sr = sr; }

  set(k: ArrayLike<number>): void {
    const r = clamp(k[1], 0, 1);
    this.slope = compInterp(COMP_SLOPE, r);
    this.knee = compInterp(COMP_KNEE, r);
    this.thr = compInterp(COMP_THR, r) + 64 * clamp(k[0], 0, 1);
    this.ka = onePoleK(hcMap.compAttackMs(k[2]), this.sr);
    this.kr = onePoleK(hcMap.compReleaseMs(k[3]), this.sr);
  }

  snap(): void {}

  process(L: Float32Array, R: Float32Array, n: number): void {
    let env = this.env;
    const ka = this.ka, kr = this.kr, thr = this.thr, s = this.slope, W = this.knee, hw = W / 2;
    const lo = Math.pow(10, (thr - hw) / 20);
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      env += (a - env) * (a > env ? ka : kr);
      if (env > lo) {
        const o = 20 * Math.log10(env) - thr;
        const gr = o >= hw ? -s * o : (-s * (o + hw) * (o + hw)) / (2 * W);
        const g = Math.pow(10, gr / 20);
        L[i] = l * g; R[i] = r * g;
      }
    }
    this.env = fl(env);
  }

  reset(): void { this.env = 0; }
  tail(): number { return 0; }
}

// ----------------------------------------------------------------- Modulator
// The signal runs through a short vibrato delay (sweeping between half and all
// of 0.125 + 9.8 PITCH^2 ms) at twice its level; one LFO (30 x RATE^2 Hz)
// modulates the gain by 1 + AMP x lfo and pans by +-PAN x lfo (linear).

class Modulator implements Pedal {
  private readonly sr: number;
  private readonly lfo = new Lfo();
  private readonly dl: DelayLine[];
  private readonly dmax: Smooth;
  private readonly amp: Smooth;
  private readonly pan: Smooth;

  constructor(sr: number) {
    this.sr = sr;
    const max = Math.ceil(0.011 * sr) + 8;
    this.dl = [new DelayLine(max), new DelayLine(max)];
    const k = onePoleK(SMOOTH_MS * 2, sr);
    this.dmax = new Smooth(0.000125 * sr, k);
    this.amp = new Smooth(0, k);
    this.pan = new Smooth(0, k);
  }

  set(k: ArrayLike<number>): void {
    this.dmax.set(hcMap.modMaxMs(k[0]) * 0.001 * this.sr);
    this.amp.set(clamp(k[1], 0, 1));
    this.pan.set(clamp(k[2], 0, 1));
    this.lfo.setRate(hcMap.modRateHz(k[3]), this.sr);
  }

  snap(): void { this.dmax.snap(); this.amp.snap(); this.pan.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const dlL = this.dl[0], dlR = this.dl[1];
    for (let i = 0; i < n; i++) {
      const dm = this.dmax.next(), amp = this.amp.next(), pan = this.pan.next();
      const s = this.lfo.next();
      const d = Math.max(1, dm * (0.75 + 0.25 * s));
      const vl = dlL.read(d), vr = dlR.read(d);
      dlL.write(L[i]); dlR.write(R[i]);
      const g = 2 * (1 + amp * s);
      L[i] = vl * g * (1 + pan * s);
      R[i] = vr * g * (1 - pan * s);
    }
  }

  reset(): void { for (const d of this.dl) d.clear(); }
  tail(): number { return 0.02; }
}

/** A new pedal of `type` (null for None). */
export function createPedal(type: number, sr: number, maxBlock: number): Pedal | null {
  switch (type) {
    case HcType.Distortion: return new Distortion(sr);
    case HcType.Chorus: return new Chorus(sr);
    case HcType.Flanger: return new Flanger(sr);
    case HcType.Phaser: return new Phaser(sr);
    case HcType.Reverb: return new Reverb(sr, maxBlock);
    case HcType.Delay: return new Delay(sr);
    case HcType.NoiseGate: return new NoiseGate(sr);
    case HcType.Equalizer: return new Equalizer(sr);
    case HcType.Compressor: return new Compressor(sr);
    case HcType.Modulator: return new Modulator(sr);
    case HcType.TubeStage: return new TubeStage(sr);
    default: return null;
  }
}
