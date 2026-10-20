// Mobile Rack dynamics modules: Compressor, Limiter, Gate, Leveller, Autoduck
// and Multiband Compressor. Laws measured on FL's binary with flfxhost:
//  - Compressor: feed-forward, threshold -40..0 dB, ratio 1 + 19.2 v^2 (inf at
//    the top), attack 50 v^2 ms, release 10 + 490 v^2 ms, hold 50 v^2 ms. The
//    Level knob is a gain of 40 v dB (its text reads 20 dB lower); Auto gain
//    adds -20 dB - thresh (1 - 1/ratio), so 0 dBFS maps to 0 dBFS. Input gain
//    drives the detector only (the signal path is compensated).
//  - Limiter: 2 ms look-ahead brick wall (the delay is not compensated, as in FL),
//    in / out gain +-24 dB, threshold -24..0 dB, release 0.1 + 1.9 v^4 s.
//  - Gate: 5.3 ms look-ahead; threshold -60..0 dB, hysteresis 66 v^2 dB;
//    attack / release / hold 0..1000 ms; curves blend linear and dB-linear ramps;
//    mix -100..100 % (negative mixes the inverted gate: ducking).
//  - Leveller: gain -60 + 72 v^0.6 dB, linear balance.
//  - Autoduck: a per-beat gain envelope (attack ramp, hold, curved recovery).

import { Biquad2, rbj } from '../hardcore/dsp';
import { Sm, beatsToSec, clamp, dbToLin, fl, linToDb, smoothK, type MrCtx, type MrModule } from './common';
import { mrMap } from '../../../../model/fx/plugins/mobilerack/modules';

const trunc = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.trunc(v * (n - 1) + 1e-7)));

/** Peak / RMS level detector with attack, release and hold (works in linear amplitude). */
class Detector {
  env = 0;
  ka = 1; kr = 0.001;
  holdN = 0; holdC = 0;
  rms = false;
  set(attackMs: number, releaseMs: number, holdMs: number, rms: boolean, sr: number): void {
    this.ka = smoothK(Math.max(0.01, attackMs), sr);
    this.kr = smoothK(Math.max(1, releaseMs), sr);
    this.holdN = Math.round((holdMs * sr) / 1000);
    this.rms = rms;
  }
  tick(x: number): number {
    const v = this.rms ? x * x : x;
    if (v > this.env) { this.env += (v - this.env) * this.ka; this.holdC = this.holdN; }
    else if (this.holdC > 0) this.holdC--;
    else this.env += (v - this.env) * this.kr;
    this.env = fl(this.env);
    return this.rms ? Math.sqrt(this.env) : this.env;
  }
  reset(): void { this.env = 0; this.holdC = 0; }
}

export class Compressor implements MrModule {
  private readonly sr: number;
  private readonly det = new Detector();
  private thr = -20;
  private slope = 0; // 1 - 1/ratio
  private inDb = 0;
  private readonly makeup: Sm;
  private gr = 0;
  private grShown = 0;

  constructor(sr: number) { this.sr = sr; this.makeup = new Sm(1, smoothK(20, sr)); }

  set(p: Float64Array): void {
    this.thr = mrMap.compThreshDb(p[1]);
    const ratio = mrMap.compRatio(p[2]);
    this.slope = Number.isFinite(ratio) ? 1 - 1 / ratio : 1;
    this.det.set(mrMap.compAttackMs(p[3]), mrMap.compReleaseMs(p[4]), 50 * p[6] * p[6], p[9] >= 0.5, this.sr);
    this.inDb = 40 * p[8] - 20;
    const auto = p[7] >= 0.5 ? -20 - this.thr * this.slope : 0;
    this.makeup.set(dbToLin(40 * p[5] + auto));
  }

  snap(): void { this.makeup.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const gi = dbToLin(this.inDb), thr = this.thr, slope = this.slope;
    let grMax = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i])) * gi;
      const lev = linToDb(this.det.tick(a));
      const over = lev - thr;
      const gr = over > 0 ? over * slope : 0;
      if (gr > grMax) grMax = gr;
      const g = dbToLin(-gr) * this.makeup.next();
      L[i] *= g; R[i] *= g;
    }
    this.gr = grMax;
    this.grShown = Math.max(grMax, this.grShown * 0.9);
  }

  reset(): void { this.det.reset(); this.gr = 0; }
  tail(): number { return 0.6; }
  monitor() { return { gr: this.grShown }; }
}

// ---------------------------------------------------------------------------

/** Look-ahead brick-wall limiter (min filter + moving average over the look-ahead). */
export class Limiter implements MrModule {
  private readonly sr: number;
  private readonly D: number;
  private readonly dL: Float32Array;
  private readonly dR: Float32Array;
  private dw = 0;
  // sliding minimum (monotonic deque in a ring)
  private readonly qv: Float64Array;
  private readonly qt: Int32Array;
  private qh = 0; private qn = 0;
  private t = 0;
  // moving average of the windowed minimum
  private readonly avg: Float64Array;
  private aw = 0;
  private asum = 0;
  private g = 1;
  private kr = 0.001;
  private inG = 1; private outG = 1; private thr = 1;
  private grShown = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.D = Math.max(1, Math.round(0.002 * sr));
    this.dL = new Float32Array(this.D);
    this.dR = new Float32Array(this.D);
    this.qv = new Float64Array(this.D + 2);
    this.qt = new Int32Array(this.D + 2);
    this.avg = new Float64Array(this.D).fill(1);
    this.asum = this.D;
  }

  set(p: Float64Array): void {
    this.inG = dbToLin(48 * (p[1] - 0.5));
    this.outG = dbToLin(48 * (p[2] - 0.5));
    this.kr = smoothK(mrMap.limiterReleaseS(p[3]) * 1000 / 4, this.sr);
    this.thr = dbToLin(-24 * (1 - p[4]));
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const D = this.D, cap = this.qv.length;
    let minG = 1;
    for (let i = 0; i < n; i++) {
      const l = L[i] * this.inG, r = R[i] * this.inG;
      const a = Math.max(Math.abs(l), Math.abs(r));
      const req = a > this.thr ? this.thr / a : 1;
      // push into the sliding-minimum deque (window D + 1 samples)
      while (this.qn > 0) {
        const last = (this.qh + this.qn - 1) % cap;
        if (this.qv[last] >= req) this.qn--; else break;
      }
      const slot = (this.qh + this.qn) % cap;
      this.qv[slot] = req; this.qt[slot] = this.t; this.qn++;
      while (this.qt[this.qh] <= this.t - D - 1) { this.qh = (this.qh + 1) % cap; this.qn--; }
      const wmin = this.qv[this.qh];
      this.t++;
      // moving average over D samples
      this.asum += wmin - this.avg[this.aw];
      this.avg[this.aw] = wmin;
      if (++this.aw >= D) this.aw = 0;
      const target = Math.min(wmin, this.asum / D);
      this.g = target < this.g ? target : this.g + (target - this.g) * this.kr;
      if (this.g < minG) minG = this.g;
      // delay line
      const ol = this.dL[this.dw], or = this.dR[this.dw];
      this.dL[this.dw] = l; this.dR[this.dw] = r;
      if (++this.dw >= D) this.dw = 0;
      const gg = Math.min(this.g, 1) * this.outG;
      L[i] = ol * gg; R[i] = or * gg;
    }
    if (this.t > 1 << 30) { for (let k = 0; k < this.qn; k++) this.qt[(this.qh + k) % cap] -= 1 << 29; this.t -= 1 << 29; }
    this.grShown = Math.max(-linToDb(minG), this.grShown * 0.9);
  }

  reset(): void {
    this.dL.fill(0); this.dR.fill(0); this.dw = 0;
    this.qn = 0; this.qh = 0; this.t = 0;
    this.avg.fill(1); this.asum = this.D; this.aw = 0; this.g = 1;
  }
  tail(): number { return 2.2; }
  monitor() { return { gr: this.grShown }; }
}

// ---------------------------------------------------------------------------

export class Gate implements MrModule {
  private readonly sr: number;
  private readonly D: number;
  private readonly dL: Float32Array;
  private readonly dR: Float32Array;
  private dw = 0;
  private open = false;
  private env = 0;
  private kEnv: number;
  private u = 0; // ramp position 0 (closed) .. 1 (open)
  private openThr = 0.001; private closeThr = 0.001;
  private attN = 1; private relN = 1; private holdN = 0;
  private aCurve = 0; private rCurve = 1;
  private mix = 1;
  private openFor = 0;
  private g = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.D = Math.max(1, Math.round(0.0053 * sr));
    this.dL = new Float32Array(this.D);
    this.dR = new Float32Array(this.D);
    this.kEnv = smoothK(4, sr);
  }

  set(p: Float64Array): void {
    const thr = mrMap.gateThreshDb(p[1]);
    this.openThr = dbToLin(thr);
    this.closeThr = dbToLin(thr - 66 * p[2] * p[2]);
    this.attN = Math.max(1, (1000 * p[3] * this.sr) / 1000);
    this.aCurve = p[4];
    this.relN = Math.max(1, (1000 * p[5] * this.sr) / 1000);
    this.rCurve = p[6];
    this.mix = 2 * p[7] - 1;
    this.holdN = Math.round((1000 * p[8] * this.sr) / 1000);
  }

  /** Gain for ramp position u (0 closed .. 1 open) with curve c (0 linear .. 1 dB-linear over 60 dB). */
  private static shape(u: number, c: number): number {
    const dbl = u <= 0 ? 0 : Math.pow(10, (-60 * (1 - u)) / 20);
    return u * (1 - c) + dbl * c;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const D = this.D;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      // peak envelope (instant attack, 4 ms decay)
      this.env = a > this.env ? a : this.env + (a - this.env) * this.kEnv;
      if (!this.open) {
        if (this.env >= this.openThr) { this.open = true; this.openFor = 0; }
      } else {
        this.openFor++;
        if (this.env < this.closeThr && this.openFor >= this.holdN) this.open = false;
      }
      if (this.open) { this.u = Math.min(1, this.u + 1 / this.attN); this.g = Gate.shape(this.u, this.aCurve); }
      else { this.u = Math.max(0, this.u - 1 / this.relN); this.g = Gate.shape(this.u, this.rCurve); }
      const m = this.mix;
      // negative mix blends in the inverted gate (passes what the gate removes)
      const gain = m >= 0 ? 1 - m + m * this.g : 1 + m - m * (1 - this.g);
      const ol = this.dL[this.dw], or = this.dR[this.dw];
      this.dL[this.dw] = L[i]; this.dR[this.dw] = R[i];
      if (++this.dw >= D) this.dw = 0;
      L[i] = ol * gain; R[i] = or * gain;
    }
    this.env = fl(this.env);
  }

  reset(): void { this.dL.fill(0); this.dR.fill(0); this.dw = 0; this.open = false; this.env = 0; this.u = 0; this.g = 0; }
  tail(): number { return 1.1; }
  monitor() { return { open: this.open, g: this.g }; }
}

// ---------------------------------------------------------------------------

export class Leveller implements MrModule {
  private readonly gL: Sm;
  private readonly gR: Sm;
  private pkL = 0; private pkR = 0;

  constructor(sr: number) { const k = smoothK(10, sr); this.gL = new Sm(1, k); this.gR = new Sm(1, k); }

  set(p: Float64Array): void {
    const g = dbToLin(mrMap.levellerDb(p[1]));
    const pan = p[2];
    this.gL.set(g * Math.min(1, 2 * (1 - pan)));
    this.gR.set(g * Math.min(1, 2 * pan));
  }

  snap(): void { this.gL.snap(); this.gR.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    let pl = 0, pr = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i] * this.gL.next(), r = R[i] * this.gR.next();
      L[i] = l; R[i] = r;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
    }
    this.pkL = Math.max(pl, this.pkL * 0.92);
    this.pkR = Math.max(pr, this.pkR * 0.92);
  }

  reset(): void { this.pkL = this.pkR = 0; }
  tail(): number { return 0; }
  monitor() { return { l: this.pkL, r: this.pkR }; }
}

// ---------------------------------------------------------------------------

/** Autoduck recovery curves measured on FL (Curve 100 %, recovery fraction 0, 0.05 .. 1) for Shape 0, 0.25, 0.5, 0.8, 1. */
const DUCK_SHAPES = [0, 0.25, 0.5, 0.8, 1];
const DUCK_CURVES = [
  [0, 0.02, 0.05, 0.07, 0.1, 0.13, 0.16, 0.19, 0.23, 0.26, 0.3, 0.33, 0.37, 0.42, 0.47, 0.52, 0.57, 0.64, 0.72, 0.83, 1],
  [0, 0, 0.01, 0.02, 0.02, 0.03, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.12, 0.14, 0.16, 0.18, 0.22, 0.3, 1],
  [0, 0.12, 0.25, 0.37, 0.48, 0.57, 0.66, 0.73, 0.79, 0.84, 0.88, 0.91, 0.94, 0.96, 0.98, 0.99, 0.99, 1, 1, 1, 1],
  [0, 0, 0, 0.02, 0.04, 0.07, 0.12, 0.19, 0.28, 0.4, 0.54, 0.67, 0.77, 0.85, 0.91, 0.95, 0.98, 0.99, 1, 1, 1],
  [0, 0, 0, 0, 0, 0.01, 0.03, 0.07, 0.16, 0.31, 0.58, 0.78, 0.9, 0.96, 0.98, 1, 1, 1, 1, 1, 1],
];

function duckCurve(shape: number, u: number): number {
  let j = 0;
  while (j < DUCK_SHAPES.length - 2 && shape > DUCK_SHAPES[j + 1]) j++;
  const t = clamp((shape - DUCK_SHAPES[j]) / (DUCK_SHAPES[j + 1] - DUCK_SHAPES[j]), 0, 1);
  const x = clamp(u, 0, 1) * 20, i = Math.min(19, Math.floor(x)), f = x - i;
  const a = DUCK_CURVES[j], b = DUCK_CURVES[j + 1];
  const va = a[i] + (a[i + 1] - a[i]) * f, vb = b[i] + (b[i + 1] - b[i]) * f;
  return va + (vb - va) * t;
}

/**
 * Autoduck: a gain envelope repeating every beat (locked to the song
 * position while playing): ramp down to the floor over Attack, Hold, then a
 * recovery over Time of the rest of the beat along FL's measured curves
 * (Shape), blended toward a straight line by Curve; Shift moves the phase.
 */
export class Autoduck implements MrModule {
  private readonly sr: number;
  private floor = 0.235;
  private attackS = 0.004;
  private curve = 1; // 1 = fully curved, 0 = linear
  private time = 1;
  private shift = 0;
  private hold = 0;
  private shape = 0.8;
  private ph = 0;
  private g = 1;

  constructor(sr: number) { this.sr = sr; }

  set(p: Float64Array): void {
    this.floor = Math.pow(1 - clamp(p[1], 0, 1), 1.645);
    this.attackS = (215 * p[2]) / 1000;
    this.curve = 1 - p[3];
    this.time = Math.max(0.01, p[4]);
    this.shift = p[5] - 0.5;
    this.hold = 0.99 * p[6];
    this.shape = p[7];
  }

  /** Gain at beat phase x (0..1) for a beat of `beatS` seconds. */
  gainAt(x: number, beatS: number): number {
    const att = Math.min(0.5, this.attackS / beatS);
    if (x < att) return 1 + (this.floor - 1) * (x / Math.max(1e-6, att));
    const h0 = att + this.hold * (1 - att);
    if (x < h0) return this.floor;
    const span = Math.max(1e-6, this.time * (1 - h0));
    const u = Math.min(1, (x - h0) / span);
    const f = (1 - this.curve) * u + this.curve * duckCurve(this.shape, u);
    return this.floor + (1 - this.floor) * f;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    const beatS = beatsToSec(1, ctx.tempo);
    const inc = 1 / (beatS * this.sr);
    if (ctx.playing) this.ph = ctx.beat - Math.floor(ctx.beat);
    for (let i = 0; i < n; i++) {
      let x = this.ph - this.shift;
      x -= Math.floor(x);
      const t = this.gainAt(x, beatS);
      this.g += (t - this.g) * 0.2;
      L[i] *= this.g; R[i] *= this.g;
      this.ph += inc;
      if (this.ph >= 1) this.ph -= 1;
    }
  }

  reset(): void { this.g = 1; }
  tail(): number { return 0; }
  monitor() { return { g: this.g, ph: this.ph }; }
}

// ---------------------------------------------------------------------------

/** Linkwitz-Riley 4th-order split (two cascaded Butterworth biquads per path). */
class Lr4 {
  readonly lp1 = new Biquad2(); readonly lp2 = new Biquad2();
  readonly hp1 = new Biquad2(); readonly hp2 = new Biquad2();
  set(f: number, sr: number): void {
    const l = rbj('lp', f, sr, 0, Math.SQRT1_2), h = rbj('hp', f, sr, 0, Math.SQRT1_2);
    this.lp1.set(l); this.lp2.set(l); this.hp1.set(h); this.hp2.set(h);
  }
  reset(): void { this.lp1.reset(); this.lp2.reset(); this.hp1.reset(); this.hp2.reset(); }
}

/** Multiband Compressor: three bands (LR4 crossovers), per-band compression, gain, width and bypass. */
export class MultibandComp implements MrModule {
  private readonly sr: number;
  private readonly bs: number;
  private readonly x1 = new Lr4();
  private readonly x2 = new Lr4();
  private readonly ap = new Lr4(); // all-pass compensation of the low band at f2
  private readonly bufs: Float32Array[];
  private readonly det = [new Detector(), new Detector(), new Detector()];
  private readonly inG = new Float64Array(3);
  private readonly thr = new Float64Array(3);
  private readonly slope = new Float64Array(3);
  private readonly outG = new Float64Array(3);
  private readonly width = new Float64Array(3);
  private readonly state = new Int32Array(3);
  private readonly gr = new Float64Array(3);
  private masterIn = 1;
  private dry = 0;
  private safe = false;
  private f1 = 0; private f2 = 0;

  constructor(sr: number, bs: number) {
    this.sr = sr; this.bs = bs;
    this.bufs = Array.from({ length: 8 }, () => new Float32Array(bs));
  }

  set(p: Float64Array): void {
    this.masterIn = dbToLin(48 * (p[1] - 0.5));
    let f1 = mrMap.mbFreqHz(p[2]), f2 = mrMap.mbFreqHz(p[3]);
    if (f2 < f1 * 1.05) f2 = f1 * 1.05;
    f1 = Math.min(f1, this.sr * 0.45); f2 = Math.min(f2, this.sr * 0.47);
    if (f1 !== this.f1 || f2 !== this.f2) { this.f1 = f1; this.f2 = f2; this.x1.set(f1, this.sr); this.x2.set(f2, this.sr); this.ap.set(f2, this.sr); }
    this.safe = trunc(p[4], 2) === 1;
    this.dry = p[5] * p[5];
    for (let b = 0; b < 3; b++) {
      const o = 6 + b * 7;
      this.inG[b] = dbToLin(48 * (p[o] - 0.5));
      this.thr[b] = -48 * (1 - p[o + 1]);
      this.slope[b] = 1 - 1 / (1 + 30 * p[o + 2]);
      this.det[b].set(50 * p[o + 3] * p[o + 3], 10 + 990 * p[o + 4], 0, false, this.sr);
      this.outG[b] = dbToLin(48 * (p[o + 5] - 0.5));
      this.state[b] = trunc(p[o + 6], 3);
      this.width[b] = 2 * p[27 + b];
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let o = 0; o < n; o += this.bs) {
      const m = Math.min(this.bs, n - o);
      this.block(L.subarray(o, o + m), R.subarray(o, o + m), m);
    }
  }

  private block(L: Float32Array, R: Float32Array, n: number): void {
    const [lowL, lowR, midL, midR, hiL, hiR, dryL, dryR] = this.bufs;
    const mi = this.masterIn;
    for (let i = 0; i < n; i++) {
      dryL[i] = L[i]; dryR[i] = R[i];
      const l = L[i] * mi, r = R[i] * mi;
      lowL[i] = l; lowR[i] = r; hiL[i] = l; hiR[i] = r;
    }
    // split 1
    this.x1.lp1.process(lowL, lowR, n); this.x1.lp2.process(lowL, lowR, n);
    this.x1.hp1.process(hiL, hiR, n); this.x1.hp2.process(hiL, hiR, n);
    for (let i = 0; i < n; i++) { midL[i] = hiL[i]; midR[i] = hiR[i]; }
    // split 2 on the upper band
    this.x2.lp1.process(midL, midR, n); this.x2.lp2.process(midL, midR, n);
    this.x2.hp1.process(hiL, hiR, n); this.x2.hp2.process(hiL, hiR, n);
    // all-pass the low band at f2 (LP + HP of the second crossover) to keep the sum flat
    const apL = dryL, apR = dryR; // reuse after copying dry into L/R below
    for (let i = 0; i < n; i++) { L[i] = dryL[i]; R[i] = dryR[i]; }
    for (let i = 0; i < n; i++) { apL[i] = lowL[i]; apR[i] = lowR[i]; }
    this.ap.lp1.process(lowL, lowR, n); this.ap.lp2.process(lowL, lowR, n);
    this.ap.hp1.process(apL, apR, n); this.ap.hp2.process(apL, apR, n);
    for (let i = 0; i < n; i++) { lowL[i] += apL[i]; lowR[i] += apR[i]; }
    const bands: [Float32Array, Float32Array][] = [[lowL, lowR], [midL, midR], [hiL, hiR]];
    const dry = this.dry, wet = 1 - dry;
    for (let i = 0; i < n; i++) { const l = L[i], r = R[i]; L[i] = l * dry; R[i] = r * dry; }
    for (let b = 0; b < 3; b++) {
      const st = this.state[b];
      if (st === 2) { this.gr[b] *= 0.9; continue; }
      const [bl, br] = bands[b];
      const gi = this.inG[b], thr = this.thr[b], sl = this.slope[b], go = this.outG[b], w = this.width[b];
      let grMax = 0;
      for (let i = 0; i < n; i++) {
        let l = bl[i], r = br[i];
        if (st === 0) {
          l *= gi; r *= gi;
          const lev = linToDb(this.det[b].tick(Math.max(Math.abs(l), Math.abs(r))));
          const over = lev - thr;
          const grDb = over > 0 ? over * sl : 0;
          if (grDb > grMax) grMax = grDb;
          const g = dbToLin(-grDb) * go;
          l *= g; r *= g;
          const mm = 0.5 * (l + r), ss = 0.5 * (l - r) * w;
          l = mm + ss; r = mm - ss;
        }
        L[i] += l * wet; R[i] += r * wet;
      }
      this.gr[b] = Math.max(grMax, this.gr[b] * 0.9);
    }
    if (this.safe) {
      for (let i = 0; i < n; i++) { L[i] = Math.tanh(L[i]); R[i] = Math.tanh(R[i]); }
    }
  }

  reset(): void { this.x1.reset(); this.x2.reset(); this.ap.reset(); for (const d of this.det) d.reset(); this.gr.fill(0); }
  tail(): number { return 1.1; }
  monitor() { return { gr: Array.from(this.gr) }; }
}
