// Mobile Rack time-based modules: Tape Delay, Trance Delay, Reverb 2 and Tape
// Stop. Measured on FL's binary with flfxhost:
//  - Tape Delay: time 1000 v^2 ms (+3 samples), linear interpolation, no
//    tone filter or saturation; the line is fed x + fb x tap and the output is
//    x + mix x fb x tap (no echo at all with Fdbk at 0); Async shortens one
//    channel's time by up to half. Time changes glide (tape pitch bend).
//  - Trance Delay: tempo-synced 1/4, 3/8, 1/2, 3/4, 1/1 beat (whole samples,
//    no interpolation); the same feedback structure (feedback x 0.99) with a
//    filter in the loop (below 0.5 a one-pole low pass with pole 1 - 2v,
//    above it x - lowpass with coefficient (2v - 1)^4); modes Normal,
//    Ping-Pong (crossed lines) and Offset (a two-division echo with the whole
//    left output delayed by one division); Pan balances the inputs.
//  - Reverb 2: FL's module has Fruity Reeverb 2's controls; this is a compact
//    rendition (early reflections, eight-line FDN with a bass multiplier around
//    the crossover, damping, modulation), calibrated to FL's decay times,
//    early / late timing and levels.
//  - Tape Stop: variable-speed playback that spins down / up over the stop and
//    start times when Play toggles (or when the transport stops, with Sync).

import {
  MR_TRANCE_BEATS, mrMap,
} from '../../../../model/fx/plugins/mobilerack/modules';
import { DelayLine, OnePole1 } from '../hardcore/dsp';
import { Sm, beatsToSec, clamp, dbToLin, fl, smoothK, type MrCtx, type MrModule } from './common';

const r48 = (sr: number) => sr / 48000;

export class TapeDelay implements MrModule {
  private readonly sr: number;
  private readonly dl: DelayLine;
  private readonly dr: DelayLine;
  private readonly tL: Sm;
  private readonly tR: Sm;
  private fb = 0.6;
  private readonly mix: Sm;
  private timeS = 0.36;

  constructor(sr: number) {
    this.sr = sr;
    this.dl = new DelayLine(1.02 * sr + 16); this.dr = new DelayLine(1.02 * sr + 16);
    this.tL = new Sm(0, smoothK(120, sr)); this.tR = new Sm(0, smoothK(120, sr));
    this.mix = new Sm(0.4, smoothK(10, sr));
  }

  set(p: Float64Array): void {
    const t = (mrMap.tapeDelayMs(p[1]) / 1000) * this.sr * 0.99996, extra = 2.97 * r48(this.sr);
    this.timeS = mrMap.tapeDelayMs(p[1]) / 1000;
    this.fb = Math.min(1, p[2]);
    const a = 2 * p[3] - 1;
    this.tL.set(Math.max(1, (a < 0 ? t * (1 + a / 2) : t) + extra));
    this.tR.set(Math.max(1, (a > 0 ? t * (1 - a / 2) : t) + extra));
    this.mix.set(p[4]);
  }

  snap(): void { this.tL.snap(); this.tR.snap(); this.mix.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const fb = this.fb, maxD = this.dl.size - 2;
    for (let i = 0; i < n; i++) {
      const tl = this.dl.read(clamp(this.tL.next(), 1, maxD)), tr = this.dr.read(clamp(this.tR.next(), 1, maxD));
      this.dl.write(fl(L[i] + fb * tl));
      this.dr.write(fl(R[i] + fb * tr));
      const m = this.mix.next() * fb;
      L[i] += m * tl; R[i] += m * tr;
    }
  }

  reset(): void { this.dl.clear(); this.dr.clear(); }
  tail(): number { return this.fb >= 0.999 ? 30 : Math.min(30, this.timeS * Math.max(1, Math.log(1e-4) / Math.log(Math.max(1e-3, this.fb))) + 0.1); }
}

// ---------------------------------------------------------------------------

/** One-pole filter in the trance delay's loop (v < 0.5 low pass, v > 0.5 x - low pass). */
class LoopFilter {
  private s = 0;
  hp = false;
  k = 1; // one-pole coefficient (1 - pole)
  set(v: number): void {
    if (v <= 0.5) { this.hp = false; this.k = clamp(2 * v, 0, 1); }
    else { this.hp = true; const x = 2 * v - 1; this.k = clamp(x * x * x * x, 0, 1); }
  }
  tick(x: number): number {
    this.s += (x - this.s) * this.k;
    this.s = fl(this.s);
    return this.hp ? x - this.s : this.s;
  }
  reset(): void { this.s = 0; }
}

export class TranceDelay implements MrModule {
  private readonly sr: number;
  private readonly dl: DelayLine;
  private readonly dr: DelayLine;
  private readonly offL: DelayLine;
  private readonly fL = new LoopFilter();
  private readonly fR = new LoopFilter();
  private beats = 0.75;
  private fb = 0.4;
  private readonly mix: Sm;
  private mode = 1;
  private gl = 1; private gr = 1;

  constructor(sr: number) {
    this.sr = sr;
    // up to 2 beats (offset mode) of the longest division at 30 BPM
    this.dl = new DelayLine(4.1 * sr + 16); this.dr = new DelayLine(4.1 * sr + 16);
    this.offL = new DelayLine(2.05 * sr + 16);
    this.mix = new Sm(1, smoothK(10, sr));
  }

  set(p: Float64Array): void {
    this.beats = MR_TRANCE_BEATS[Math.min(4, Math.trunc(p[1] * 4 + 1e-7))];
    // FL scales the feedback by 0.99 (echo n has gain mix (0.99 fb)^n)
    this.fb = 0.99 * Math.min(1, p[2]);
    this.mix.set(p[3]);
    this.fL.set(p[4]); this.fR.set(p[4]);
    const mode = Math.min(2, Math.max(0, Math.round(p[5] * 2)));
    if (mode !== this.mode) { this.mode = mode; this.dl.clear(); this.dr.clear(); this.offL.clear(); }
    const w = p[6];
    this.gl = Math.min(1, 2 * (1 - w)); this.gr = Math.min(1, 2 * w);
  }

  snap(): void { this.mix.snap(); }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    // whole-sample delay (FL does not interpolate this one)
    const D = Math.max(2, Math.min(Math.round(beatsToSec(this.beats, ctx.tempo) * this.sr), Math.floor((this.dl.size - 4) / 2)));
    const fb = this.fb;
    if (this.mode === 2) {
      // offset: a 2-division echo on both channels, the left output delayed by one division
      const D2 = 2 * D, off = D - 1;
      for (let i = 0; i < n; i++) {
        const m = this.mix.next();
        const yl = this.fL.tick(this.dl.tap(D2)), yr = this.fR.tick(this.dr.tap(D2));
        const inL = L[i] * this.gl, inR = R[i] * this.gr;
        this.dl.write(fl(inL + fb * yl)); this.dr.write(fl(inR + fb * yr));
        const outL = L[i] + m * fb * yl;
        this.offL.write(outL);
        L[i] = this.offL.tap(off + 1);
        R[i] += m * fb * yr;
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const m = this.mix.next();
      const yl = this.fL.tick(this.dl.tap(D)), yr = this.fR.tick(this.dr.tap(D));
      const inL = L[i] * this.gl, inR = R[i] * this.gr;
      if (this.mode === 0) { this.dl.write(fl(inL + fb * yl)); this.dr.write(fl(inR + fb * yr)); }
      else { this.dl.write(fl(inR + fb * yr)); this.dr.write(fl(inL + fb * yl)); } // ping-pong: crossed lines
      L[i] += m * fb * yl; R[i] += m * fb * yr;
    }
  }

  reset(): void { this.dl.clear(); this.dr.clear(); this.offL.clear(); this.fL.reset(); this.fR.reset(); }
  tail(): number { return this.fb >= 0.98 ? 30 : 8; }
}

// ---------------------------------------------------------------------------

/** Late-tank line lengths (ms at SIZE 100 %). */
const FDN_MS = [50.3, 56.9, 61.7, 67.9, 72.1, 77.3, 83.9, 89.1];
/** Input diffusers of the late reverb (ms), summing to ~30 ms (FL: first late arrival 49.9 ms without diffusion). */
const DIFF_MS = [11.9, 8.3, 6.1, 3.7];

/** Schroeder all-pass on a delay line. */
class Allpass {
  readonly line: DelayLine;
  len = 1;
  g = 0.6;
  constructor(maxSamples: number) { this.line = new DelayLine(maxSamples + 4); }
  tick(x: number): number {
    const d = this.line.tap(this.len);
    const w = x + this.g * d;
    this.line.write(fl(w));
    return d - this.g * w;
  }
  clear(): void { this.line.clear(); }
}

/**
 * Reverb 2. Structure and calibration from FL's binary: HIGH / LOW CUT are
 * one-pole filters on the input; early reflections start at 37.5 ms (left) /
 * 28.5 ms (right) x size through three all-passes (5.3, 1.75, 5.3 ms, gain from
 * DIFFUSION); the late part starts at 19.9 ms x size (pre-delay
 * adds to it only), runs through four diffusers (DIFFUSION) into an 8-line
 * FDN whose decay is about 1.3 x DECAY with a bass multiplier below CROSS;
 * DAMPING blends a one-pole low pass 50 / 50 into the late output; the late
 * output also carries the early reflections (0.71 x the ER output), so the two
 * add coherently; the diffuse energy grows as RT^0.7 (as measured).
 */
export class Reverb2 implements MrModule {
  private readonly sr: number;
  private readonly pre: DelayLine;
  private readonly erL: DelayLine;
  private readonly erR: DelayLine;
  private readonly erApL: Allpass[];
  private readonly erApR: Allpass[];
  private readonly diff: Allpass[];
  private readonly lines: DelayLine[];
  private readonly len: Float64Array;
  private readonly gHi = new Float64Array(8);
  private readonly gLo = new Float64Array(8);
  private readonly xS = new Float64Array(8);
  private readonly v = new Float64Array(8);
  private readonly hiCut = [new OnePole1(), new OnePole1()];
  private readonly loCut = [new OnePole1(), new OnePole1()];
  private readonly damp = [new OnePole1(), new OnePole1()];
  private hiOn = true; private loOn = true; private dampOn = true;
  private xK = 0.02;
  private size = 1;
  private lateN = 955; private preN = 0;
  private erLN = 1799; private erRN = 1366;
  private readonly dry: Sm; private readonly erG: Sm; private readonly wetG: Sm;
  private sep = 0; private pan = 0.5;
  private modDepth = 0; private modInc = 0; private modPh = 0;
  private decay = 1; private rt = 1.35; private tempoSync = false; private delayV = 0;

  constructor(sr: number) {
    this.sr = sr;
    const ms = (m: number) => (m * sr) / 1000;
    this.pre = new DelayLine(ms(1000 + 21) + 8);
    this.erL = new DelayLine(ms(38) + 8); this.erR = new DelayLine(ms(29) + 8);
    this.erApL = [new Allpass(ms(5.4)), new Allpass(ms(1.8)), new Allpass(ms(5.4))];
    this.erApR = [new Allpass(ms(5.4)), new Allpass(ms(1.8)), new Allpass(ms(5.4))];
    this.diff = DIFF_MS.map((m) => new Allpass(ms(m)));
    this.len = Float64Array.from(FDN_MS, (m) => ms(m));
    this.lines = FDN_MS.map((m) => new DelayLine(ms(m) + ms(4) + 16));
    const k = smoothK(15, sr);
    this.dry = new Sm(1, k); this.erG = new Sm(1, k); this.wetG = new Sm(0.7, k);
  }

  set(p: Float64Array): void {
    const sr = this.sr;
    this.hiOn = p[1] < 0.999;
    for (const f of this.hiCut) f.setHz(Math.min(sr * 0.45, mrMap.revCutHz(p[1])), sr);
    this.loOn = p[2] > 0.001;
    for (const f of this.loCut) f.setHz(mrMap.revLowCutHz(p[2]), sr);
    this.size = Math.max(0.07, p[3]);
    const sz = this.size, ms = (m: number) => Math.max(1, Math.round((m * sz * sr) / 1000));
    this.lateN = ms(19.9);
    this.erLN = ms(37.5); this.erRN = ms(28.5);
    this.erApL[0].len = this.erApR[0].len = ms(5.33);
    this.erApL[1].len = this.erApR[1].len = ms(1.75);
    this.erApL[2].len = this.erApR[2].len = ms(5.33);
    for (const a of [...this.erApL, ...this.erApR]) a.g = 0.5 * p[5];
    DIFF_MS.forEach((m, i) => { this.diff[i].len = ms(m); this.diff[i].g = 0.72 * p[5]; });
    this.decay = mrMap.revDecayS(p[4]);
    this.rt = 1.3 * this.decay + 0.05;
    this.dampOn = p[6] < 0.999;
    for (const f of this.damp) f.setHz(Math.min(sr * 0.45, mrMap.revCutHz(p[6])), sr);
    this.dry.set(1.25 * p[7]);
    this.erG.set(1.25 * p[8]);
    this.tempoSync = p[12] >= 0.5;
    this.delayV = p[11];
    this.modDepth = 0.002 * sr * p[13];
    const bass = 0.2 + 2.8 * p[14];
    this.sep = 2 * p[15] - 1;
    this.modInc = (0.05 + 2 * p[16]) / sr;
    this.xK = 1 - Math.exp((-2 * Math.PI * (25 + 1975 * p[17])) / sr);
    this.pan = p[18];
    for (let i = 0; i < 8; i++) {
      const L = this.len[i] * sz;
      this.gHi[i] = Math.pow(10, (-3 * L) / (sr * this.rt));
      this.gLo[i] = Math.pow(10, (-3 * L) / (sr * this.rt * (1 + 0.5 * (bass - 1))));
    }
    this.wetG.set(1.25 * p[9] * 0.55);
  }

  snap(): void { this.dry.snap(); this.erG.snap(); this.wetG.snap(); }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    const sr = this.sr;
    const preS = this.tempoSync ? beatsToSec(Math.round(this.delayV * 16) / 4, ctx.tempo) : this.delayV;
    this.preN = clamp(Math.round(preS * sr), 0, this.pre.size - this.lateN - 4);
    const lateD = this.preN + this.lateN;
    const lines = this.lines, v = this.v, sz = this.size, lens = this.len;
    for (let i = 0; i < n; i++) {
      let xl = L[i], xr = R[i];
      if (this.loOn) { xl = this.loCut[0].hp(xl); xr = this.loCut[1].hp(xr); }
      if (this.hiOn) { xl = this.hiCut[0].lp(xl); xr = this.hiCut[1].lp(xr); }
      const x = 0.5 * (xl + xr);
      // early reflections: pre-delayed taps through two all-passes per side
      this.erL.write(x); this.erR.write(x);
      let el = this.erL.tap(this.erLN + 1), er = this.erR.tap(this.erRN + 1);
      el = this.erApL[2].tick(this.erApL[1].tick(this.erApL[0].tick(el)));
      er = this.erApR[2].tick(this.erApR[1].tick(this.erApR[0].tick(er)));
      // late: 19.9 ms x size (+ pre-delay), diffusion, FDN
      this.pre.write(x);
      let u = this.pre.tap(lateD + 1);
      for (let k = 0; k < 4; k++) u = this.diff[k].tick(u);
      this.modPh += this.modInc; if (this.modPh >= 1) this.modPh -= 1;
      const m = Math.sin(6.283185307179586 * this.modPh) * this.modDepth;
      for (let k = 0; k < 8; k++) {
        const d = lens[k] * sz + (k === 1 ? m : k === 4 ? -m : k === 6 ? 0.6 * m : 0);
        v[k] = lines[k].read(Math.max(2, d));
      }
      // the late output carries the early reflections too (FL: ER and late are correlated)
      let oL = 0.74 * (v[0] - v[2] + v[4] - v[6] + 0.7 * (v[1] - v[7]) + 0.8 * u) + 1.03 * el;
      let oR = 0.74 * (v[1] - v[3] + v[5] - v[7] + 0.7 * (v[2] - v[6]) - 0.8 * u) + 1.03 * er;
      for (let h = 1; h < 8; h <<= 1) {
        for (let a = 0; a < 8; a += h << 1) {
          for (let b = a; b < a + h; b++) { const pp = v[b], qq = v[b + h]; v[b] = pp + qq; v[b + h] = pp - qq; }
        }
      }
      for (let k = 0; k < 8; k++) {
        const s = v[k] * 0.35355339059327373;
        this.xS[k] += (s - this.xS[k]) * this.xK;
        const lo = this.xS[k], hi = s - lo;
        lines[k].write(fl(lo * this.gLo[k] + hi * this.gHi[k] + ((k & 1) ? -u : u) * 0.5));
      }
      if (this.dampOn) { oL = 0.5 * (oL + this.damp[0].lp(oL)); oR = 0.5 * (oR + this.damp[1].lp(oR)); }
      const wg = this.wetG.next(), eg = this.erG.next() * 0.43, dg = this.dry.next();
      const mid = 0.5 * (oL + oR), side = 0.5 * (oL - oR) * (1 + this.sep);
      let wl = (mid + side) * wg, wr = (mid - side) * wg;
      wl *= Math.min(1, 2 * (1 - this.pan)); wr *= Math.min(1, 2 * this.pan);
      L[i] = L[i] * dg + wl + el * eg;
      R[i] = R[i] * dg + wr + er * eg;
    }
    for (let k = 0; k < 8; k++) this.xS[k] = fl(this.xS[k]);
  }

  reset(): void {
    this.pre.clear(); this.erL.clear(); this.erR.clear();
    for (const a of [...this.erApL, ...this.erApR, ...this.diff]) a.clear();
    for (const l of this.lines) l.clear();
    this.xS.fill(0);
    for (const f of [...this.hiCut, ...this.loCut, ...this.damp]) f.reset();
  }
  tail(): number { return Math.min(40, this.rt * 1.5 + 1.2); }
}

// ---------------------------------------------------------------------------

/** Tape Stop: variable-speed playback of a 12 s buffer. */
export class TapeStop implements MrModule {
  private readonly sr: number;
  private readonly bl: Float32Array;
  private readonly br: Float32Array;
  private readonly N: number;
  private w = 0;
  private r = 0; // read position (fractional samples)
  private speed = 1;
  private play = true;
  private stopS = 1; private startS = 1;
  private warp = true;
  private sync = false;
  private state: 'live' | 'stopping' | 'stopped' | 'starting' | 'catch' = 'live';
  private fade = 1;

  constructor(sr: number) {
    this.sr = sr;
    this.N = Math.ceil(12 * sr);
    this.bl = new Float32Array(this.N); this.br = new Float32Array(this.N);
  }

  set(p: Float64Array): void {
    this.sync = p[7] >= 0.5;
    this.stopS = mrMap.tapeStopS(this.sync ? p[3] : p[1]);
    this.startS = mrMap.tapeStopS(this.sync ? p[4] : p[2]);
    this.warp = p[6] >= 0.5;
    this.play = p[5] >= 0.5;
  }

  private read(buf: Float32Array, pos: number): number {
    const N = this.N;
    let i = Math.floor(pos); const f = pos - i;
    i = ((i % N) + N) % N;
    const a = buf[i], b = buf[(i + 1) % N];
    return a + (b - a) * f;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    const want = this.sync ? ctx.playing && this.play : this.play;
    const sr = this.sr;
    if (!want && (this.state === 'live' || this.state === 'starting' || this.state === 'catch')) {
      if (this.state === 'live' || this.state === 'catch') this.r = this.w;
      this.state = this.stopS > 0 ? 'stopping' : 'stopped';
      if (this.state === 'stopped') this.speed = 0;
    } else if (want && (this.state === 'stopped' || this.state === 'stopping')) {
      this.state = this.startS > 0 ? 'starting' : 'live';
      if (this.state === 'starting') this.r = this.w; // spin up from the current position
      else this.speed = 1;
    }
    const dStop = this.stopS > 0 ? 1 / (this.stopS * sr) : 1;
    const dStart = this.startS > 0 ? 1 / (this.startS * sr) : 1;
    for (let i = 0; i < n; i++) {
      this.bl[this.w] = L[i]; this.br[this.w] = R[i];
      this.w = this.w + 1 >= this.N ? 0 : this.w + 1;
      if (this.state === 'live') continue;
      if (this.state === 'stopping') { this.speed = Math.max(0, this.speed - dStop); if (this.speed <= 0) this.state = 'stopped'; }
      else if (this.state === 'starting') { this.speed = Math.min(1, this.speed + dStart); if (this.speed >= 1) { this.state = 'catch'; this.fade = 0; } }
      const s = this.warp ? this.speed * this.speed * (3 - 2 * this.speed) : this.speed;
      this.r += s;
      const tl = this.read(this.bl, this.r - 1), tr = this.read(this.br, this.r - 1);
      if (this.state === 'catch') {
        // crossfade back to the live input
        this.fade = Math.min(1, this.fade + 1 / (0.05 * sr));
        L[i] = tl + (L[i] - tl) * this.fade; R[i] = tr + (R[i] - tr) * this.fade;
        if (this.fade >= 1) this.state = 'live';
      } else if (this.state === 'stopped') { L[i] = 0; R[i] = 0; }
      else { L[i] = tl; R[i] = tr; }
    }
    if (this.state === 'live') this.speed = 1;
  }

  reset(): void { this.bl.fill(0); this.br.fill(0); this.w = 0; this.r = 0; this.state = this.play ? 'live' : 'stopped'; this.speed = this.play ? 1 : 0; }
  tail(): number { return this.state === 'live' ? 0 : Math.max(this.stopS, this.startS) + 0.1; }
  monitor() { return { speed: this.state === 'live' ? 1 : this.speed }; }
}

void dbToLin;
