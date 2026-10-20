// Mobile Rack drive modules: Distortion and Waveshaper.
//
// Distortion (measured on FL's binary, static curves from slow sines):
//   Hard: (1 + g) x / (1 + g |x|), g = 10^(5 d) - 1 (small-signal gain 100 d dB)
//   Tube: tanh(g x) / tanh(g), g = 10^(4 d) - 1
//   Soft: sign(x) (1 - e^(-g|x|)) / (1 - e^-g) with a small-signal gain of 1 + 46 d^2
//   Clip: clip(10^(3 d^2) x) to +-1 (60 d^2 dB)
// Bias adds (2v - 1)^5 before the curve and switches on a 35 Hz DC blocker;
// BitCrush holds samples for 1 + 256 v^4 samples (at 48 kHz); Stereo scales
// the drive per channel (left d (1 + s), right d (1 - s), s = 2v - 1, capped
// at d); Gain is the output level (-24..0 dB).
//
// Waveshaper: FL's six curves are only approximated (character, gain staging
// and X/Y behaviour from describing-function measurements): input gain from
// Y, X and Drive into the curve, auto-gain, post gain, mix, then the EQ
// (low cut, bass shelf, mid bell, treble shelf, high cut) and an LFO on X / Y.

import { Biquad2, rbj } from '../hardcore/dsp';
import {
  MR_SYNC_WOW_BEATS, mrMap,
} from '../../../../model/fx/plugins/mobilerack/modules';
import { Phasor, Sm, beatsToSec, clamp, dbToLin, fl, lfoShape, smoothK, type MrCtx, type MrModule } from './common';

const trunc = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.trunc(v * (n - 1) + 1e-7)));

/** Soft curve gain g with a small-signal slope of `slope` (g / (1 - e^-g) = slope). */
function softG(slope: number): number {
  if (slope <= 1.0001) return 0;
  let g = 2 * (slope - 1);
  for (let i = 0; i < 30; i++) {
    const e = Math.exp(-g), f = g / (1 - e) - slope;
    const df = (1 - e - g * e) / ((1 - e) * (1 - e));
    const ng = g - f / df;
    if (!Number.isFinite(ng) || ng <= 0) break;
    if (Math.abs(ng - g) < 1e-9) { g = ng; break; }
    g = ng;
  }
  return g;
}

/** One channel's distortion curve. */
class Curve {
  kind = 0;
  g = 0;
  k = 1; // Soft normalisation 1 / (1 - e^-g), Tube 1 / tanh(g), Clip gain
  set(kind: number, d: number): void {
    this.kind = kind;
    switch (kind) {
      case 0: this.g = Math.pow(10, 5 * d) - 1; break;
      case 1: this.g = Math.pow(10, 4 * d) - 1; this.k = this.g > 1e-6 ? 1 / Math.tanh(this.g) : 1; break;
      case 2: this.g = softG(1 + 46 * d * d); this.k = this.g > 1e-6 ? 1 / (1 - Math.exp(-this.g)) : 1; break;
      default: this.g = Math.pow(10, 3 * d * d); break;
    }
  }
  tick(x: number): number {
    switch (this.kind) {
      case 0: return ((1 + this.g) * x) / (1 + this.g * Math.abs(x));
      case 1: return this.g > 1e-6 ? Math.tanh(this.g * x) * this.k : x;
      case 2: {
        if (this.g <= 1e-6) return x;
        const a = (1 - Math.exp(-this.g * Math.abs(x))) * this.k;
        return x < 0 ? -a : a;
      }
      default: { const y = x * this.g; return y > 1 ? 1 : y < -1 ? -1 : y; }
    }
  }
}

export class Distortion implements MrModule {
  private readonly sr: number;
  private readonly cL = new Curve();
  private readonly cR = new Curve();
  private bias = 0;
  private hold = 1;
  private holdPh = 0;
  private hL = 0; private hR = 0;
  private readonly out: Sm;
  private readonly dcMix: Sm;
  private readonly dcR: number;
  private dxL = 0; private dyL = 0; private dxR = 0; private dyR = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.out = new Sm(1, smoothK(10, sr));
    this.dcMix = new Sm(0, smoothK(10, sr));
    this.dcR = Math.exp((-2 * Math.PI * 35) / sr);
  }

  set(p: Float64Array): void {
    const d = p[1];
    const s = 2 * p[4] - 1;
    const kind = trunc(p[5], 4);
    this.cL.set(kind, d * Math.min(1, 1 + s));
    this.cR.set(kind, d * Math.min(1, 1 - s));
    const v = p[2];
    this.hold = Math.max(1, (1 + 256 * v * v * v * v) * (this.sr / 48000));
    this.out.set(dbToLin(-24 * (1 - p[3])));
    const b = 2 * p[6] - 1;
    this.bias = b * b * b * b * b;
    this.dcMix.set(Math.abs(this.bias) > 1e-9 ? 1 : 0);
  }

  snap(): void { this.out.snap(); this.dcMix.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const b = this.bias, r = this.dcR;
    for (let i = 0; i < n; i++) {
      // sample-rate reduction
      this.holdPh += 1;
      if (this.holdPh >= this.hold || this.hold <= 1) { this.holdPh -= this.hold; if (this.holdPh < 0) this.holdPh = 0; this.hL = L[i]; this.hR = R[i]; }
      const yl = this.cL.tick(this.hL + b), yr = this.cR.tick(this.hR + b);
      // DC blocker (only with bias)
      const zl = yl - this.dxL + r * this.dyL; this.dxL = yl; this.dyL = fl(zl);
      const zr = yr - this.dxR + r * this.dyR; this.dxR = yr; this.dyR = fl(zr);
      const m = this.dcMix.next(), g = this.out.next();
      L[i] = (yl + (zl - yl) * m) * g;
      R[i] = (yr + (zr - yr) * m) * g;
    }
  }

  reset(): void { this.dxL = this.dyL = this.dxR = this.dyR = 0; this.hL = this.hR = 0; this.holdPh = 0; }
  tail(): number { return 0.05; }
}

// ---------------------------------------------------------------------------

/** Waveshaper curves (approximations of FL Studio Mobile's six shapes). */
function wsCurve(shape: number, x: number, xs: number, y: number): number {
  switch (shape) {
    case 0: // Analog: smooth tanh with an asymmetric bias from X
      return Math.tanh(x + 0.3 * xs) - Math.tanh(0.3 * xs);
    case 1: { // Moshpit: hard knee
      const a = Math.abs(x);
      return x / Math.pow(1 + a * a * a * a, 0.25);
    }
    case 2: { // Foldback: sine folder, Y sets the folds
      return Math.sin(x * (0.5 + 1.5 * y) * (1 + Math.abs(xs)));
    }
    case 3: { // Chainsaw: asymmetric clip with a gated, buzzy edge
      const c = clamp(x + 0.2 * xs, -1, 1);
      const q = Math.round(c * (6 + 26 * (1 - y))) / (6 + 26 * (1 - y));
      return q;
    }
    case 4: { // Rectifuzz: X morphs clean -> full-wave -> fuzzed rectifier
      const t = Math.tanh(x);
      const m = 1 - Math.abs(2 * ((xs + 1) / 2) - 1); // 0 at X = 0 / 1, 1 at X = 0.5
      const rect = Math.abs(t) * 2 - 1;
      return xs > 0 ? t * (1 - m) + rect * m * 0.5 + Math.tanh(3 * x) * (1 - m) * 0.25 : t * (1 - m) + rect * m * 0.5;
    }
    default: { // Cyclone: sinusoidal phase shaping, nearly clean at low drive
      return Math.sin(1.2 * Math.tanh(x) + 0.4 * xs * Math.sin(2 * x)) / Math.sin(1.2);
    }
  }
}

export class Waveshaper implements MrModule {
  private readonly sr: number;
  private shape = 0;
  private autoGain = false;
  private xv = 0.5; private yv = 0.5; private drive = 0;
  private readonly post: Sm;
  private spread = 0;
  private readonly mix: Sm;
  private readonly hpFix: Biquad2;
  private readonly lc = new Biquad2();
  private readonly hc = new Biquad2();
  private readonly bass = new Biquad2();
  private readonly mid = new Biquad2();
  private readonly treble = new Biquad2();
  private readonly lfo = new Phasor();
  private lfoShapeI = 0;
  private lfoSync = false;
  private lfoBeats = 1;
  private lfoHz = 0.1;
  private toX = 0; private toY = 0;
  private eqOn = { bass: false, mid: false, treble: false, lc: false };

  constructor(sr: number) {
    this.sr = sr;
    this.post = new Sm(1, smoothK(10, sr));
    this.mix = new Sm(1, smoothK(10, sr));
    this.hpFix = new Biquad2();
    // FL's fixed low-frequency roll-off (about 60 Hz, first order)
    const w = Math.exp((-2 * Math.PI * 60) / sr);
    this.hpFix.set({ b0: (1 + w) / 2, b1: -(1 + w) / 2, b2: 0, a1: -w, a2: 0 });
  }

  set(p: Float64Array): void {
    this.shape = trunc(p[1], 6);
    this.autoGain = p[2] >= 0.5;
    this.xv = p[3]; this.yv = p[4]; this.drive = p[5];
    this.post.set(dbToLin(36 * (p[6] - 0.5)));
    this.spread = p[7];
    this.mix.set(p[8]);
    const sr = this.sr;
    this.hc.set(rbj('lp', Math.min(sr * 0.45, 0.75 * mrMap.wsCutHz(p[9])), sr, 0, Math.SQRT1_2));
    const lcHz = mrMap.wsCutHz(p[10]);
    this.eqOn.lc = lcHz > 20.5;
    this.lc.set(rbj('hp', lcHz, sr, 0, Math.SQRT1_2));
    const bassDb = 36 * (p[11] - 0.5), midDb = 36 * (p[13] - 0.5), trebDb = 36 * (p[14] - 0.5);
    this.eqOn.bass = Math.abs(bassDb) > 0.01; this.eqOn.mid = Math.abs(midDb) > 0.01; this.eqOn.treble = Math.abs(trebDb) > 0.01;
    this.bass.set(rbj('lowshelf', 120, sr, bassDb, 0.7));
    this.mid.set(rbj('peak', mrMap.wsMidHz(p[12]), sr, midDb, 0.9));
    this.treble.set(rbj('highshelf', 5000, sr, trebDb, 0.7));
    this.lfoShapeI = Math.min(2, Math.max(0, Math.round(p[15] * 2)));
    this.lfoSync = p[16] >= 0.5;
    this.lfoBeats = MR_SYNC_WOW_BEATS[trunc(p[17], MR_SYNC_WOW_BEATS.length)];
    this.lfoHz = mrMap.randomHz(p[18]);
    this.toX = p[19]; this.toY = p[20];
  }

  snap(): void { this.post.snap(); this.mix.snap(); }

  /** Small-signal gain (linear) into the curve for X, Y and Drive (FL: +2..+22 dB from Y, -6 dB at X extremes, up to +42 dB with Drive). */
  private inGain(x: number, y: number): number {
    const base = 2 + 20 * Math.sqrt(clamp(y, 0, 1)) - 6 * Math.abs(2 * x - 1);
    const db = base + (42 - base) * this.drive;
    return dbToLin(db);
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    // LFO (block rate)
    let hz = this.lfoHz;
    if (this.lfoSync) { hz = 1 / beatsToSec(this.lfoBeats, ctx.tempo); this.lfo.sync(ctx, this.lfoBeats); }
    const ph = this.lfo.advance(hz, n, this.sr);
    const lv = lfoShape(this.lfoShapeI, ph);
    const x = clamp(this.xv + 0.5 * this.toX * lv, 0, 1);
    const y = clamp(this.yv + 0.5 * this.toY * lv, 0, 1);
    const g = this.inGain(x, y);
    const comp = this.autoGain ? 1 / Math.max(1, Math.sqrt(g)) : 1;
    const xsL = 2 * x - 1, xsR = clamp(2 * x - 1 + this.spread * 0.6, -1, 1);
    for (let i = 0; i < n; i++) {
      const dl = L[i], dr = R[i];
      const m = this.mix.next(), pg = this.post.next() * comp;
      const wl = wsCurve(this.shape, dl * g, xsL, y) * pg;
      const wr = wsCurve(this.shape, dr * g, xsR, y) * pg;
      L[i] = dl + (wl - dl) * m;
      R[i] = dr + (wr - dr) * m;
    }
    this.hpFix.process(L, R, n);
    if (this.eqOn.lc) this.lc.process(L, R, n);
    if (this.eqOn.bass) this.bass.process(L, R, n);
    if (this.eqOn.mid) this.mid.process(L, R, n);
    if (this.eqOn.treble) this.treble.process(L, R, n);
    this.hc.process(L, R, n);
    for (let i = 0; i < n; i++) {
      // keep the output bounded (the curves are, the EQ boost is not)
      const l = L[i], r = R[i];
      if (l > 8 || l < -8 || !Number.isFinite(l)) L[i] = Number.isFinite(l) ? Math.sign(l) * 8 : 0;
      if (r > 8 || r < -8 || !Number.isFinite(r)) R[i] = Number.isFinite(r) ? Math.sign(r) * 8 : 0;
    }
  }

  reset(): void { this.hpFix.reset(); this.lc.reset(); this.hc.reset(); this.bass.reset(); this.mid.reset(); this.treble.reset(); }
  tail(): number { return 0.1; }
  monitor() { return { x: this.xv, y: this.yv }; }
}
