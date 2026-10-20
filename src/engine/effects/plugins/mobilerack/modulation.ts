// Mobile Rack modulation modules: Chorus, Flanger, Phaser, Tremolo, Wow &
// Flutter and Comb Filter. Structures measured on FL's binary (impulse trains
// through flfxhost):
//  - Chorus: one voice per channel in a 10 ms buffer, voice gain 2 mix^2 over
//    the untouched dry signal. The left voice sweeps 475 - 74 d^1.47 +- (0.8 +
//    76 d^1.76) samples (at 48 kHz); FL's right voice sits at the end of the
//    buffer (479.5 samples, wrapping onto the newest sample). Stereo blends
//    each voice into the other channel.
//  - Flanger: delay = 3 samples + 2.5 v^2 ms x 119/120 x (1 + 0.49 amount LFO);
//    LFO sine / saw / square, free (0.1 + 9.9 v^3 Hz) or synced; Stereo offsets
//    the right LFO by up to 180 degrees; wet = +-mix^2, feedback +-v.
//  - Phaser: six first-order all-passes whose coefficient uses f / sr in place
//    of tan(pi f / sr) (FL's notches sit near f / pi), feedback v, wet mix^2;
//    the LFO moves the Frequency knob.
//  - Tremolo: raised-cosine / triangle LFO with shape, skew and width controls.
//  - Wow & Flutter: a fully wet modulated 10 ms delay (wow 10 ms and flutter
//    3 ms peak-to-peak at full amount); Random jitters both rates.
//  - Comb Filter: delay sr / f (+ 3 samples), feedback v, wet = mix x tap.

import {
  MR_NOTES, MR_SYNC_PHASER_BEATS, MR_SYNC_TREMOLO_BEATS, MR_SYNC_WOW_BEATS, mrMap,
} from '../../../../model/fx/plugins/mobilerack/modules';
import { DelayLine } from '../hardcore/dsp';
import { Phasor, Sm, TAU, beatsToSec, clamp, fl, lfoShape, smoothK, type MrCtx, type MrModule } from './common';
import { PitchTracker } from './pitch';

void MR_NOTES;
const trunc = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.trunc(v * (n - 1) + 1e-7)));
const r48 = (sr: number) => sr / 48000;

/** Ring buffer that is written before it is read (FL's wrap-around reads). */
class Ring {
  readonly buf: Float32Array;
  readonly n: number;
  w = 0;
  constructor(n: number) { this.n = Math.max(4, n | 0); this.buf = new Float32Array(this.n); }
  write(x: number): void { this.buf[this.w] = x; this.w = this.w + 1 >= this.n ? 0 : this.w + 1; }
  /** Read d samples behind the newest sample (d = 0 is the newest), linear interpolation, wrapping. */
  read(d: number): number {
    const n = this.n;
    let pos = this.w - 1 - d;
    pos = ((pos % n) + n) % n;
    const i = Math.floor(pos), f = pos - i;
    const a = this.buf[i], b = this.buf[(i + 1) % n];
    return a + (b - a) * f;
  }
  clear(): void { this.buf.fill(0); this.w = 0; }
}

// ---------------------------------------------------------------------------

export class Chorus implements MrModule {
  private readonly sr: number;
  private readonly rl: Ring;
  private readonly rr: Ring;
  private readonly lfo = new Phasor();
  private rate = 1;
  private center = 475; private half = 1; private rHalf = 0.1;
  private stereo = 1;
  private readonly gain: Sm;

  constructor(sr: number) {
    this.sr = sr;
    const n = Math.round(0.01 * sr);
    this.rl = new Ring(n); this.rr = new Ring(n);
    this.gain = new Sm(0, smoothK(10, sr));
  }

  set(p: Float64Array): void {
    this.rate = mrMap.chorusRateHz(p[1]);
    const d = clamp(p[2], 0, 1);
    this.center = 475.2 - 73.9 * Math.pow(d, 1.47);
    this.half = 0.77 + 76 * Math.pow(d, 1.76);
    this.rHalf = 0.04 + 0.36 * Math.pow(d, 1.76);
    this.stereo = p[3];
    this.gain.set(2 * p[4] * p[4]);
  }

  snap(): void { this.gain.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const k = r48(this.sr), inc = this.rate / this.sr, cross = 1 - this.stereo;
    const maxD = this.rl.n - 1;
    let ph = this.lfo.ph;
    for (let i = 0; i < n; i++) {
      const s = Math.sin(TAU * ph);
      ph += inc; if (ph >= 1) ph -= 1;
      this.rl.write(L[i]); this.rr.write(R[i]);
      const vl = this.rl.read(clamp((this.center - this.half * s) * k, 0, maxD));
      const vr = this.rr.read(clamp((479.5 + this.rHalf * s) * k, 0, maxD + 0.999));
      const g = this.gain.next();
      L[i] += g * (vl + cross * vr);
      R[i] += g * (vr + cross * vl);
    }
    this.lfo.ph = ph;
  }

  reset(): void { this.rl.clear(); this.rr.clear(); }
  tail(): number { return 0.02; }
}

// ---------------------------------------------------------------------------

export class Flanger implements MrModule {
  private readonly sr: number;
  private readonly dl: DelayLine;
  private readonly dr: DelayLine;
  private readonly lfo = new Phasor();
  private sync = false; private beats = 1; private hz = 1;
  private shape = 0; private amount = 1;
  private readonly base: Sm;
  private fb = 0; private stereo = 0;
  private readonly wet: Sm;
  private yl = 0; private yr = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.dl = new DelayLine(0.006 * sr + 16); this.dr = new DelayLine(0.006 * sr + 16);
    this.base = new Sm(0, smoothK(30, sr));
    this.wet = new Sm(0, smoothK(10, sr));
  }

  set(p: Float64Array): void {
    this.beats = MR_SYNC_PHASER_BEATS[trunc(p[1], MR_SYNC_PHASER_BEATS.length)];
    this.sync = p[2] >= 0.5;
    this.hz = mrMap.lfoHz(p[3]);
    this.shape = Math.min(2, Math.max(0, Math.round(p[4] * 2)));
    this.amount = p[5];
    this.base.set((mrMap.flangerDelayMs(p[6]) * this.sr) / 1000);
    this.fb = Math.min(0.98, p[7]) * (p[8] >= 0.5 ? -1 : 1);
    this.stereo = p[9];
    this.wet.set(p[10] * p[10] * (p[11] >= 0.5 ? -1 : 1));
  }

  snap(): void { this.base.snap(); this.wet.snap(); }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    let hz = this.hz;
    if (this.sync) { hz = 1 / beatsToSec(this.beats, ctx.tempo); this.lfo.sync(ctx, this.beats); }
    const ph0 = this.lfo.advance(hz, n, this.sr);
    const inc = hz / this.sr, off = 0.5 * this.stereo, a = 0.49 * this.amount;
    // FL: delay = 3 samples + 119/120 of the nominal time
    const extra = 3 * r48(this.sr);
    for (let i = 0; i < n; i++) {
      const ph = ph0 + inc * i;
      const b = this.base.next() * (119 / 120);
      const dL = Math.max(1, extra + b * (1 + a * lfoShape(this.shape, ph)));
      const dR = Math.max(1, extra + b * (1 + a * lfoShape(this.shape, ph + off)));
      const tl = this.dl.read(dL), tr = this.dr.read(dR);
      this.dl.write(fl(L[i] + this.fb * tl));
      this.dr.write(fl(R[i] + this.fb * tr));
      const w = this.wet.next();
      L[i] += w * tl; R[i] += w * tr;
    }
    void this.yl; void this.yr;
  }

  reset(): void { this.dl.clear(); this.dr.clear(); }
  tail(): number { return 0.3; }
}

// ---------------------------------------------------------------------------

export class Phaser implements MrModule {
  private readonly sr: number;
  private readonly lfo = new Phasor();
  private sync = true; private beats = 0.375; private hz = 0.1;
  private amount = 0.25; private fb = 0.1; private freqV = 0.25;
  private shape = 0; private stereo = 1;
  private readonly wet: Sm;
  private readonly sL = new Float64Array(12);
  private readonly sR = new Float64Array(12);
  private yL = 0; private yR = 0;

  constructor(sr: number) { this.sr = sr; this.wet = new Sm(1, smoothK(10, sr)); }

  set(p: Float64Array): void {
    this.beats = MR_SYNC_PHASER_BEATS[trunc(p[1], MR_SYNC_PHASER_BEATS.length)];
    this.amount = p[2];
    this.fb = Math.min(0.95, p[3]);
    this.freqV = p[4];
    this.wet.set(p[5] * p[5]);
    this.sync = p[6] >= 0.5;
    this.hz = mrMap.lfoHz(p[7]);
    this.shape = Math.min(2, Math.max(0, Math.round(p[8] * 2)));
    this.stereo = p[9];
  }

  snap(): void { this.wet.snap(); }

  /** All-pass coefficient for LFO value lv. */
  private coef(lv: number): number {
    const v = clamp(this.freqV + 0.75 * this.amount * lv, 0, 1);
    const t = mrMap.phaserHz(v) / this.sr;
    return (t - 1) / (t + 1);
  }

  private static chain(x: number, a: number, s: Float64Array): number {
    // six first-order all-passes (a + z^-1) / (1 + a z^-1); s holds x1, y1 pairs
    for (let k = 0; k < 6; k++) {
      const x1 = s[2 * k], y1 = s[2 * k + 1];
      const y = a * x + x1 - a * y1;
      s[2 * k] = x; s[2 * k + 1] = y;
      x = y;
    }
    return x;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    let hz = this.hz;
    if (this.sync) { hz = 1 / beatsToSec(this.beats, ctx.tempo); this.lfo.sync(ctx, this.beats); }
    const ph0 = this.lfo.advance(hz, n, this.sr), inc = hz / this.sr, off = 0.5 * this.stereo;
    // coefficients at 16-sample steps
    let aL = this.coef(lfoShape(this.shape, ph0)), aR = this.coef(lfoShape(this.shape, ph0 + off));
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0 && i > 0) { const ph = ph0 + inc * i; aL = this.coef(lfoShape(this.shape, ph)); aR = this.coef(lfoShape(this.shape, ph + off)); }
      const yl = Phaser.chain(L[i] + this.fb * this.yL, aL, this.sL);
      const yr = Phaser.chain(R[i] + this.fb * this.yR, aR, this.sR);
      this.yL = fl(yl); this.yR = fl(yr);
      const w = this.wet.next();
      L[i] += w * yl; R[i] += w * yr;
    }
    for (let k = 0; k < 12; k++) { this.sL[k] = fl(this.sL[k]); this.sR[k] = fl(this.sR[k]); }
  }

  reset(): void { this.sL.fill(0); this.sR.fill(0); this.yL = this.yR = 0; }
  tail(): number { return 0.3; }
}

// ---------------------------------------------------------------------------

export class Tremolo implements MrModule {
  private readonly sr: number;
  private readonly lfo = new Phasor();
  private sync = false; private beats = 0.25; private hz = 1;
  private max = 1; private min = 0; private phase = 0; private stereo = 0;
  private shape = 0.5; private smooth = 1; private skew = 0; private width = 0.5;
  private gl = 1; private gr = 1;

  constructor(sr: number) { this.sr = sr; }

  set(p: Float64Array): void {
    this.hz = mrMap.tremoloHz(p[1]);
    const edges = [0.1083, 0.225, 0.3417, 0.4417, 0.5583, 0.6583];
    let i = 0; while (i < edges.length && p[2] >= edges[i]) i++;
    this.beats = MR_SYNC_TREMOLO_BEATS[i];
    this.max = p[3]; this.min = p[4];
    this.phase = p[5]; this.stereo = p[6];
    this.sync = p[7] >= 0.5;
    this.shape = p[8]; this.smooth = p[9]; this.skew = 2 * p[10] - 1; this.width = p[11];
  }

  /** Waveform 0..1 at phase x. */
  wave(x: number): number {
    x -= Math.floor(x);
    const pk = clamp(0.5 + 0.5 * this.skew, 0.001, 0.999);
    const tri = x < pk ? x / pk : (1 - x) / (1 - pk);
    let u = tri + (0.5 - 0.5 * Math.cos(Math.PI * tri) - tri) * this.smooth;
    // shape: 0 -> square, 0.5 -> as is, 1 -> narrow peaks
    if (this.shape < 0.5) {
      const k = 1 + 40 * Math.pow((0.5 - this.shape) * 2, 2);
      u = 0.5 + 0.5 * Math.tanh(k * (u - 0.5)) / Math.tanh(k * 0.5);
    } else if (this.shape > 0.5) {
      u = Math.pow(u, 1 + 6 * (this.shape - 0.5) * 2);
    }
    return clamp(u + 2 * (this.width - 0.5), 0, 1);
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    let hz = this.hz;
    if (this.sync) { hz = 1 / beatsToSec(this.beats, ctx.tempo); this.lfo.sync(ctx, this.beats); }
    const ph0 = this.lfo.advance(hz, n, this.sr), inc = hz / this.sr;
    const span = this.max - this.min;
    for (let i = 0; i < n; i++) {
      const ph = ph0 + inc * i + this.phase;
      const tl = this.min + span * this.wave(ph), tr = this.min + span * this.wave(ph + this.stereo);
      this.gl += (tl - this.gl) * 0.15; this.gr += (tr - this.gr) * 0.15;
      L[i] *= this.gl; R[i] *= this.gr;
    }
  }

  reset(): void { this.gl = this.gr = 1; }
  tail(): number { return 0; }
}

// ---------------------------------------------------------------------------

export class WowFlutter implements MrModule {
  private readonly sr: number;
  private readonly rl: Ring;
  private readonly rr: Ring;
  private wowHz = 1; private flHz = 6; private rndHz = 1;
  private wowBeats = 0.25; private flBeats = 0.125; private rndBeats = 4;
  private wowA = 0; private flA = 0; private rndA = 0;
  private sync = false;
  private pw = 0; private pf = 0;
  private rnd = 0; private rndT = 0; private rndPh = 0; private seed = 12345;

  constructor(sr: number) {
    this.sr = sr;
    const n = Math.round(0.01 * sr) + 2;
    this.rl = new Ring(n); this.rr = new Ring(n);
  }

  set(p: Float64Array): void {
    this.wowHz = mrMap.wowHz(p[1]);
    this.wowBeats = MR_SYNC_WOW_BEATS[trunc(p[2], 10)];
    this.wowA = p[3];
    this.flHz = mrMap.flutterHz(p[4]);
    this.flBeats = MR_SYNC_WOW_BEATS[trunc(p[5], 10)];
    this.flA = p[6];
    this.sync = p[7] >= 0.5;
    this.rndHz = mrMap.randomHz(p[8]);
    this.rndBeats = MR_SYNC_WOW_BEATS[trunc(p[9], 10)];
    this.rndA = p[10];
  }

  private rand(): number { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296 * 2 - 1; }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    const sr = this.sr;
    let wh = this.wowHz, fh = this.flHz, rh = this.rndHz;
    if (this.sync) { wh = 1 / beatsToSec(this.wowBeats, ctx.tempo); fh = 1 / beatsToSec(this.flBeats, ctx.tempo); rh = 1 / beatsToSec(this.rndBeats, ctx.tempo); }
    const wAmp = 0.01 * sr * this.wowA, fAmp = 0.003 * sr * this.flA;
    const maxD = this.rl.n - 2;
    for (let i = 0; i < n; i++) {
      // random walk target, changed at the random rate, smoothed
      this.rndPh += rh / sr;
      if (this.rndPh >= 1) { this.rndPh -= 1; this.rndT = this.rand(); }
      this.rnd += (this.rndT - this.rnd) * (rh * 6 / sr);
      const j = 1 + 0.5 * this.rndA * this.rnd;
      this.pw += (wh * j) / sr; if (this.pw >= 1) this.pw -= 1;
      this.pf += (fh * j) / sr; if (this.pf >= 1) this.pf -= 1;
      const d = clamp(0.5 * wAmp * (1 - Math.cos(TAU * this.pw)) + 0.5 * fAmp * (1 - Math.cos(TAU * this.pf)), 0, maxD);
      this.rl.write(L[i]); this.rr.write(R[i]);
      L[i] = this.rl.read(d); R[i] = this.rr.read(d);
    }
  }

  reset(): void { this.rl.clear(); this.rr.clear(); }
  tail(): number { return 0.02; }
}

// ---------------------------------------------------------------------------

export class CombFilter implements MrModule {
  private readonly sr: number;
  private readonly dl: DelayLine;
  private readonly dr: DelayLine;
  private readonly tracker: PitchTracker;
  private mode = 0;
  private pitchHz = 30.6;
  private noteHz = 164.8;
  private snapOn = true;
  private octK = 1;
  private fb = 0.8;
  private readonly wet: Sm;
  private smooth = 0.25;
  private polL = 1; private polR = 1;
  private asym = 0;
  private dCur = 0;
  private first = true;

  constructor(sr: number) {
    this.sr = sr;
    this.dl = new DelayLine(sr * 1.05 + 16); this.dr = new DelayLine(sr * 1.05 + 16);
    this.tracker = new PitchTracker(sr);
    this.wet = new Sm(0.75, smoothK(10, sr));
  }

  set(p: Float64Array): void {
    this.mode = trunc(p[1], 3);
    this.pitchHz = mrMap.combPitchHz(p[2]);
    this.fb = Math.min(0.995, p[3]);
    this.wet.set(p[4]);
    this.octK = Math.pow(2, Math.round((p[5] - 0.5) * 4));
    this.smooth = p[6];
    this.snapOn = p[7] >= 0.5;
    const pol = trunc(p[8], 4);
    this.polL = pol === 1 || pol === 3 ? -1 : 1;
    this.polR = pol === 2 || pol === 3 ? -1 : 1;
    this.asym = (p[9] - 0.5) * 0.1;
    const oct = Math.round(p[10] * 7) - 1, note = Math.round(p[11] * 11);
    this.noteHz = 440 * Math.pow(2, (12 * (oct + 1) + note - 69) / 12);
  }

  snap(): void { this.wet.snap(); this.first = true; }

  process(L: Float32Array, R: Float32Array, n: number): void {
    let hz = this.snapOn ? this.noteHz : this.pitchHz;
    if (this.mode === 2) {
      this.tracker.push(L, R, n);
      if (this.tracker.hz > 0) hz = this.tracker.hz;
    }
    hz = clamp(hz * this.octK, 1, this.sr / 8);
    const target = this.sr / hz + 2.97 * r48(this.sr);
    if (this.first) { this.dCur = target; this.first = false; }
    const k = smoothK(5 + 400 * this.smooth * this.smooth, this.sr);
    const maxD = this.dl.size - 4;
    for (let i = 0; i < n; i++) {
      this.dCur += (target - this.dCur) * k;
      const dL = clamp(this.dCur * (1 + this.asym), 1, maxD), dR = clamp(this.dCur * (1 - this.asym), 1, maxD);
      const tl = this.dl.read(dL), tr = this.dr.read(dR);
      this.dl.write(fl(L[i] + this.fb * tl));
      this.dr.write(fl(R[i] + this.fb * tr));
      const w = this.wet.next();
      L[i] += w * this.polL * tl; R[i] += w * this.polR * tr;
    }
  }

  reset(): void { this.dl.clear(); this.dr.clear(); this.tracker.reset(); }
  tail(): number { return 2; }
  monitor() { return { hz: this.mode === 2 ? this.tracker.hz : this.snapOn ? this.noteHz : this.pitchHz }; }
}
