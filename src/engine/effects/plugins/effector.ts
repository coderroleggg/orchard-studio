// Effector (FL Studio 2026). Measured on FL's plugin with flfxhost (see
// docs/research/fx/effector.md). Signal flow: input gain (v/256)^2 -> effect
// (X / Y = PARAM knobs moved by the LFO: X + modX/2 * lfo) -> linear dry/wet
// -> output gain (+-24 dB, linear in dB). Bypass passes the input untouched.
// The LFO runs at the Mod Rate (beats per cycle, song-position aligned while
// playing) times 2^(3.33 * Tempo reduce); Trans and Grain use its period
// directly; Delay uses the rate as its time (halved until <= 1 s).
//
// Effects (X, Y in 0..1):
//  DISTORT  low band (one-pole, cutoff from Y) through a rational soft clipper
//           normalised to 0.5 at 0.5 (drive from X), high band clean.
//  LO-FI    sample hold of 1 + 127 X^3 samples, quantiser step Y^2 / 32 (truncating).
//  FLANGER  y = x - s[n - D], s = x - 0.96 Y s[n - D], D = 3 + 218 X^2 samples @ 44.1 kHz.
//  PHASER   x + six first-order allpasses (coefficient from X), feedback from Y.
//  FILTER   X < 0.5 low-pass, > 0.5 high-pass (8-pole), Y resonance.
//  DELAY    x + echoes, gain X^2 per repeat, echo filter: low-pass below Y = 0.5, high-pass above.
//  REVERB   x + a stereo comb / allpass reverb, RT60 0.52 s * e^(3.32 X), wet from Y.
//  STEREO   Haas panning: the far channel is delayed by up to 86 samples @ 44.1 kHz
//           (3 samples base delay on both); Y > 0.5 lowers the far channel.
//  TRANS    gate dropping to Y^2 at every LFO period, recovering over 30 + 95 X^2 ms.
//  GRAIN    one-period grains repeated from the previous period (X / Y unused).
//  VOX      three resonant formant band-passes (vowel from X, throat scale from Y).
//  RING     x * sin(2 pi f t), f = 32 Hz * 415.6^X.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

const TWO_PI = Math.PI * 2;
const TINY = 1e-25;
const RATE_BEATS = [1 / 8, 1 / 4, 3 / 8, 1 / 2, 3 / 4, 1, 2, 4, 8];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (q: Record<string, unknown>, k: string, d: number) => {
  const v = Number(q[k] ?? d);
  return Number.isFinite(v) ? Math.min(256, Math.max(0, v)) : d;
};

function lerpTab(xs: number[], ys: number[], x: number, logY = false): number {
  if (x <= xs[0]) return ys[0];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x <= xs[i + 1]) {
      const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
      if (logY && ys[i] > 0 && ys[i + 1] > 0) return Math.exp(Math.log(ys[i]) + (Math.log(ys[i + 1]) - Math.log(ys[i])) * t);
      return ys[i] + (ys[i + 1] - ys[i]) * t;
    }
  }
  return ys[ys.length - 1];
}

/** Biquad state + coefficients (transposed direct form II), per channel. */
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  z1 = new Float64Array(2); z2 = new Float64Array(2);
  set(type: 'lp' | 'hp' | 'bp', fc: number, q: number, sr: number, gain = 1): void {
    const f = Math.min(Math.max(fc, 5), sr * 0.49);
    const w0 = (TWO_PI * f) / sr, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Math.max(0.05, q));
    const a0 = 1 + al;
    if (type === 'lp') { this.b0 = ((1 - cs) / 2) / a0; this.b1 = (1 - cs) / a0; this.b2 = this.b0; }
    else if (type === 'hp') { this.b0 = ((1 + cs) / 2) / a0; this.b1 = -(1 + cs) / a0; this.b2 = this.b0; }
    else { this.b0 = (al * q) / a0; this.b1 = 0; this.b2 = -(al * q) / a0; } // band-pass, peak gain q
    this.b0 *= gain; this.b1 *= gain; this.b2 *= gain;
    this.a1 = (-2 * cs) / a0; this.a2 = (1 - al) / a0;
  }
  tick(c: number, x: number): number {
    const y = this.b0 * x + this.z1[c];
    this.z1[c] = this.b1 * x - this.a1 * y + this.z2[c];
    this.z2[c] = this.b2 * x - this.a2 * y;
    return y;
  }
  flush(): void {
    for (let c = 0; c < 2; c++) {
      if (Math.abs(this.z1[c]) < TINY) this.z1[c] = 0;
      if (Math.abs(this.z2[c]) < TINY) this.z2[c] = 0;
    }
  }
  reset(): void { this.z1.fill(0); this.z2.fill(0); }
}

/** Ring buffer delay line (per channel). */
class Line {
  readonly buf: Float32Array;
  readonly n: number;
  w = 0;
  constructor(n: number) { this.n = n; this.buf = new Float32Array(n); }
  push(x: number): void { this.buf[this.w] = x; this.w = this.w + 1 >= this.n ? 0 : this.w + 1; }
  /** Sample written d samples ago (d >= 1, fractional: linear interpolation). */
  read(d: number): number {
    const di = Math.floor(d), fr = d - di;
    let i0 = this.w - di; if (i0 < 0) i0 += this.n;
    let i1 = i0 - 1; if (i1 < 0) i1 += this.n;
    return this.buf[i0] + (this.buf[i1] - this.buf[i0]) * fr;
  }
  reset(): void { this.buf.fill(0); this.w = 0; }
}

// Freeverb-style tunings (samples at 44.1 kHz)
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const APS = [556, 441, 341, 225];
const SPREAD = 23;
/** Q of the first three sections of the 8-pole Butterworth filter (the fourth carries the resonance). */
const BW_Q = [0.5098, 0.6013, 0.9000];

// Vox: formant table (Hz) across X (cyclic: X = 1 equals X = 0)
const VOX_X = [0, 0.25, 0.5, 0.75, 1];
const VOX_F = [[670, 1090, 2362], [559, 1061, 2375], [451, 1766, 2429], [260, 1934, 2470], [670, 1090, 2362]];
function voxFormant(k: number, x: number): number {
  const v = Math.min(1, Math.max(0, x));
  for (let i = 0; i < VOX_X.length - 1; i++) {
    if (v <= VOX_X[i + 1]) {
      const t = (v - VOX_X[i]) / (VOX_X[i + 1] - VOX_X[i]);
      return Math.exp(Math.log(VOX_F[i][k]) + (Math.log(VOX_F[i + 1][k]) - Math.log(VOX_F[i][k])) * t);
    }
  }
  return VOX_F[VOX_F.length - 1][k];
}

class Effector implements EffectInstance {
  private readonly sr: number;
  private readonly k44: number;
  // parameters (normalised)
  private kind = 10; private bypass = true; private mix = 1; private x = 0.5; private y = 0.5;
  private rate = 1; private tempoMul = 1; private modX = 0; private modY = 0; private shape = 0;
  private inGain = 1; private outGain = 1;
  // smoothed
  private xs = 0.5; private ys = 0.5; private mixS = 1; private inS = 1; private outS = 1;
  private first = true;
  // LFO
  private phase = 0;
  private lfo = 0;
  // effect states
  private readonly dist = new Float64Array(2);
  private holdPh = 0; private readonly held = new Float64Array(2);
  private readonly fl: Line[];
  private readonly apState = new Float64Array(12);
  private readonly phFb = new Float64Array(2);
  private readonly filt: Biquad[] = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
  private readonly dl: Line[];
  private readonly dlLp = new Float64Array(2); private readonly dlHp = new Float64Array(2); private readonly dlHpX = new Float64Array(2);
  private readonly combs: Line[][];
  private readonly combLp: Float64Array;
  private readonly aps: Line[][];
  private readonly st: Line[];
  private transT = 1e9; private transPrev = -1;
  private readonly gr: Line[];
  private grPh = 0; private grPrev = -1;
  private readonly vox: Biquad[] = [new Biquad(), new Biquad(), new Biquad()];
  private ringPh = 0;
  // display
  private peakIn = 0; private peakOut = 0;
  private lastX = 0.5; private lastY = 0.5;
  tail = 0.5;

  constructor(sr: number) {
    this.sr = sr;
    this.k44 = sr / 44100;
    this.fl = [new Line(Math.ceil(260 * this.k44) + 4), new Line(Math.ceil(260 * this.k44) + 4)];
    this.dl = [new Line(Math.ceil(1.05 * sr) + 4), new Line(Math.ceil(1.05 * sr) + 4)];
    this.combs = [0, 1].map((c) => COMBS.map((n) => new Line(Math.ceil((n + c * SPREAD) * this.k44) + 2)));
    this.combLp = new Float64Array(16);
    this.aps = [0, 1].map((c) => APS.map((n) => new Line(Math.ceil((n + c * SPREAD) * this.k44) + 2)));
    this.st = [new Line(Math.ceil(100 * this.k44) + 4), new Line(Math.ceil(100 * this.k44) + 4)];
    this.gr = [new Line(Math.ceil(9 * sr) + 4), new Line(Math.ceil(9 * sr) + 4)];
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    this.kind = Math.max(0, Math.min(11, Math.round((num(q, 'kind', 244) * 11) / 256)));
    this.bypass = num(q, 'bypass', 256) > 0;
    this.mix = num(q, 'mix', 256) / 256;
    this.x = num(q, 'x', 128) / 256;
    this.y = num(q, 'y', 128) / 256;
    this.rate = Math.max(0, Math.min(8, Math.floor((num(q, 'rate', 28) + 16) / 32)));
    this.tempoMul = Math.pow(2, 3.33 * (num(q, 'tempo', 0) / 256));
    this.modX = (num(q, 'modX', 128) - 128) / 128;
    this.modY = (num(q, 'modY', 128) - 128) / 128;
    this.shape = Math.max(0, Math.min(2, Math.floor(num(q, 'shape', 0) / 128 + 0.5)));
    const il = num(q, 'input', 256) / 256;
    this.inGain = il * il;
    this.outGain = Math.pow(10, (((num(q, 'output', 128) - 128) / 128) * 24) / 20);
    this.tail = this.kind === 6 ? Math.min(30, 0.52 * Math.exp(3.32 * 1) + 0.5) : this.kind === 5 ? 8 : this.kind === 9 ? 9 : 0.5;
    if (this.first) {
      this.xs = this.x; this.ys = this.y; this.mixS = this.mix; this.inS = this.inGain; this.outS = this.outGain;
      this.first = false;
    }
  }

  reset(): void {
    this.dist[0] = this.dist[1] = 0; this.holdPh = 0; this.held[0] = this.held[1] = 0;
    for (const l of [...this.fl, ...this.dl, ...this.st, ...this.gr]) l.reset();
    for (const ch of [...this.combs, ...this.aps]) for (const l of ch) l.reset();
    this.combLp.fill(0); this.apState.fill(0); this.phFb[0] = this.phFb[1] = 0;
    for (const b of [...this.filt, ...this.vox]) b.reset();
    this.dlLp.fill(0); this.dlHp.fill(0); this.dlHpX.fill(0);
    this.phase = 0; this.transT = 1e9; this.transPrev = -1; this.grPh = 0; this.grPrev = -1; this.ringPh = 0;
    this.xs = this.x; this.ys = this.y; this.mixS = this.mix; this.inS = this.inGain; this.outS = this.outGain;
  }

  /** LFO value (-1..1) at a phase: sine, falling saw or square. */
  private lfoAt(ph: number): number {
    const p = ph - Math.floor(ph);
    return this.shape === 0 ? Math.sin(TWO_PI * p) : this.shape === 1 ? 1 - 2 * p : p < 0.5 ? 1 : -1;
  }

  /** LFO period in samples (Mod Rate in beats times the tempo multiplier). */
  private periodSamples(tempo: number): number {
    return Math.max(16, ((RATE_BEATS[this.rate] * 60) / Math.max(10, tempo) / this.tempoMul) * this.sr);
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (n <= 0) return;
    const sr = this.sr;
    // input meter
    let pin = this.peakIn;
    for (let i = 0; i < n; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > pin) pin = a; }
    this.peakIn = pin;
    if (this.bypass) { this.peakOut = Math.max(this.peakOut, pin); return; }
    const tempo = ctx.tempo || 120;
    const period = this.periodSamples(tempo);
    // LFO phase: song-aligned while playing
    const beatsPerCycle = (RATE_BEATS[this.rate]) / this.tempoMul;
    if (ctx.playing) this.phase = ((ctx.pos / Math.max(1, ctx.ppq)) / beatsPerCycle) % 1;
    const dPh = n / period;
    this.lfo = this.lfoAt(this.phase + dPh * 0.5);
    // smoothed controls (per block) with the LFO applied
    const sm = 1 - Math.exp(-n / (0.012 * sr));
    const xT = clamp01(this.x + this.modX * 0.5 * this.lfo), yT = clamp01(this.y + this.modY * 0.5 * this.lfo);
    this.xs += (xT - this.xs) * sm; this.ys += (yT - this.ys) * sm;
    const X = this.xs, Y = this.ys;
    this.lastX = X; this.lastY = Y;
    const mix0 = this.mixS, mix1 = this.mixS + (this.mix - this.mixS) * sm;
    const in0 = this.inS, in1 = this.inS + (this.inGain - this.inS) * sm;
    const out0 = this.outS, out1 = this.outS + (this.outGain - this.outS) * sm;
    this.mixS = mix1; this.inS = in1; this.outS = out1;
    this.prepare(X, Y, period);
    let pout = this.peakOut;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const g = in0 + (in1 - in0) * t;
      const dl = L[i] * g, dr = R[i] * g;
      this.tick(dl, dr, period, ctx, i);
      const wl = this.oL, wr = this.oR;
      const m = mix0 + (mix1 - mix0) * t;
      const og = out0 + (out1 - out0) * t;
      let ol = (dl + (wl - dl) * m) * og;
      let or = (dr + (wr - dr) * m) * og;
      if (!(ol === ol) || ol > 1e6 || ol < -1e6) ol = 0;
      if (!(or === or) || or > 1e6 || or < -1e6) or = 0;
      L[i] = ol; R[i] = or;
      const a = Math.max(Math.abs(ol), Math.abs(or));
      if (a > pout) pout = a;
    }
    this.peakOut = pout;
    this.phase = (this.phase + dPh) % 1;
    for (let k = 0; k < 4; k++) this.filt[k].flush();
    for (let k = 0; k < 3; k++) this.vox[k].flush();
    for (let k = 0; k < this.apState.length; k++) if (Math.abs(this.apState[k]) < TINY) this.apState[k] = 0;
    if (Math.abs(this.dlLp[0]) < TINY) this.dlLp[0] = 0;
    if (Math.abs(this.dlLp[1]) < TINY) this.dlLp[1] = 0;
    for (let k = 0; k < 16; k++) if (Math.abs(this.combLp[k]) < TINY) this.combLp[k] = 0;
  }

  private oL = 0;
  private oR = 0;

  // per-block coefficient set-up
  private distA = 0; private distK = 5.3;
  private holdN = 1; private qStep = 0;
  private flD = 3; private flFb = 0;
  private apA = -0.75; private apFb = 0;
  private fMode = 0; private fGain = 1;
  private dlD = 5000; private dlG = 0; private dlLpA = 1; private dlHpA = 0;
  private rvFb = 0.8; private rvWet = 0.1; private rvDamp = 0.2;
  private stD = 3; private stFar = 0; private stG = 1;
  private transDrop = 0.25; private transRel = 0.05;
  private ringInc = 0;
  private readonly voxF = new Float64Array(3);

  private prepare(X: number, Y: number, period: number): void {
    const sr = this.sr;
    switch (this.kind) {
      case 0: {
        this.distA = Y >= 1 ? 1 : lerpTab([0, 0.25, 0.5, 0.75, 1], [0, 0.0113, 0.109, 0.488, 1], Y);
        this.distA = 1 - Math.pow(1 - this.distA, 1 / this.k44); // keep the cutoff in Hz
        this.distK = 5.3 + 78.7 * (1 - Math.exp(-X * 4.27));
        break;
      }
      case 1: this.holdN = 1 + 127 * X * X * X; this.qStep = (Y * Y) / 32; break;
      case 2: this.flD = Math.max(1, (3 + 218 * X * X) * this.k44); this.flFb = -0.96 * Y; break;
      case 3: {
        const a44 = -0.9977 + 0.324 * X + 0.34 * X * X;
        // map the 44.1 kHz coefficient to this rate via its corner frequency
        const fc = Math.atan((1 + a44) / (1 - a44)) * 44100 / Math.PI;
        const tt = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr);
        this.apA = (tt - 1) / (tt + 1);
        this.apFb = 0.7 * Y;
        break;
      }
      case 4: {
        const q = 0.707 + Y * Y * 6;
        if (X < 0.47) {
          const fc = 25 * Math.pow(800, X / 0.5);
          for (let k = 0; k < 4; k++) this.filt[k].set('lp', fc, k === 3 ? q : BW_Q[k], sr);
          this.fMode = 1; this.fGain = Math.pow(10, (-2.4 - 4.9 * Y) / 20);
        } else if (X > 0.53) {
          const fc = 12 * Math.pow(8, (X - 0.5) * 8);
          for (let k = 0; k < 4; k++) this.filt[k].set('hp', fc, k === 3 ? q : BW_Q[k], sr);
          this.fMode = 2;
          this.fGain = Math.pow(10, lerpTab([0.53, 0.625, 0.75, 0.875, 1], [0, -0.6, -4.6, -16, -44], X) / 20);
        } else this.fMode = 0;
        break;
      }
      case 5: {
        this.dlD = this.dlDTempo(period);
        this.dlG = X * X;
        const lpFc = Y <= 0.5 ? lerpTab([0, 0.125, 0.25, 0.5], [30, 2500, 5000, 22000], Y, true) : 22000;
        this.dlLpA = 1 - Math.exp((-TWO_PI * Math.min(lpFc, sr * 0.45)) / sr);
        const hpFc = Y > 0.5 ? lerpTab([0.5, 0.75, 1], [20, 1000, 2500], Y, true) : 0;
        this.dlHpA = hpFc > 0 ? Math.exp((-TWO_PI * hpFc) / sr) : 0;
        break;
      }
      case 6: {
        const rt = 0.52 * Math.exp(3.32 * X);
        // comb feedback for the mean comb length
        this.rvFb = Math.pow(10, (-3 * (1350 / 44100)) / rt);
        // wet level: from Y, and rising with X as in FL (impulse energies 0.080 / 0.127 / 0.640 at X 0 / 0.5 / 1)
        this.rvWet = (0.15 + 0.85 * Y) * 0.042 * lerpTab([0, 0.5, 1], [0.179, 0.2, 0.703], X, true);
        this.rvDamp = 0.2;
        break;
      }
      case 7: {
        const pan = 2 * X - 1;
        this.stD = 3 * this.k44;
        this.stFar = pan < 0 ? 1 : pan > 0 ? 0 : -1; // which channel is delayed (1 = right)
        this.stG = 1 - Math.max(0, 2 * Y - 1) * (1 - Math.min(1, 2 * (1 - Math.abs(pan))));
        this.stExtra = 86 * Math.abs(pan) * this.k44;
        break;
      }
      case 8: this.transDrop = Y * Y; this.transRel = (0.03 + 0.095 * X * X) * sr; break;
      case 10: {
        const s = Math.pow(2, Y - 0.5);
        for (let k = 0; k < 3; k++) {
          this.voxF[k] = voxFormant(k, X);
          this.vox[k].set('bp', this.voxF[k] * s, 11, sr);
        }
        break;
      }
      case 11: this.ringInc = (32 * Math.pow(13308 / 32, X)) / sr; break;
      default: break;
    }
  }
  private stExtra = 0;

  private dlDTempo(period: number): number {
    // the Mod Rate as delay time, halved until it fits 1 s (FL: 4/1 and 8/1 give 2 beats at 130 BPM)
    let d = period * this.tempoMul; // rate only (the tempo multiplier does not change the delay)
    while (d > this.sr) d *= 0.5;
    return Math.max(1, d);
  }

  /** One stereo sample of the selected effect into oL / oR (no allocation). */
  private tick(l: number, r: number, period: number, ctx: FxContext, i: number): void {
    switch (this.kind) {
      case 0: { // DISTORT: low band through the clipper, high band clean
        const k = this.distK, norm = 0.5 / ((0.5 * k) / (1 + 0.5 * k)), a = this.distA;
        const lpL = (this.dist[0] += a * (l - this.dist[0]));
        const lpR = (this.dist[1] += a * (r - this.dist[1]));
        const uL = k * lpL, uR = k * lpR;
        this.oL = (norm * uL) / (1 + Math.abs(uL)) + (l - lpL);
        this.oR = (norm * uR) / (1 + Math.abs(uR)) + (r - lpR);
        return;
      }
      case 1: { // LO-FI
        this.holdPh += 1;
        if (this.holdPh >= this.holdN) { this.holdPh -= this.holdN; this.held[0] = l; this.held[1] = r; }
        let a = this.held[0], b = this.held[1];
        if (this.qStep > 0) { a = Math.trunc(a / this.qStep) * this.qStep; b = Math.trunc(b / this.qStep) * this.qStep; }
        this.oL = a; this.oR = b;
        return;
      }
      case 2: { // FLANGER
        const dL = this.fl[0].read(this.flD), dR = this.fl[1].read(this.flD);
        this.fl[0].push(l + this.flFb * dL);
        this.fl[1].push(r + this.flFb * dR);
        this.oL = l - dL; this.oR = r - dR;
        return;
      }
      case 3: { // PHASER
        const a = this.apA;
        for (let c = 0; c < 2; c++) {
          const x = c === 0 ? l : r;
          let v = x + this.apFb * this.phFb[c];
          for (let k = 0; k < 6; k++) {
            const j = c * 6 + k;
            const yv = a * v + this.apState[j];
            this.apState[j] = v - a * yv;
            v = yv;
          }
          this.phFb[c] = v;
          if (c === 0) this.oL = x + v; else this.oR = x + v;
        }
        return;
      }
      case 4: { // FILTER
        if (this.fMode === 0) { this.oL = l; this.oR = r; return; }
        let a = l, b = r;
        for (let k = 0; k < 4; k++) { a = this.filt[k].tick(0, a); b = this.filt[k].tick(1, b); }
        this.oL = a * this.fGain; this.oR = b * this.fGain;
        return;
      }
      case 5: { // DELAY: x + echoes (gain X^2 per pass through the echo filter)
        for (let c = 0; c < 2; c++) {
          const x = c === 0 ? l : r;
          const ln = this.dl[c];
          let e = ln.read(this.dlD);
          this.dlLp[c] += this.dlLpA * (e - this.dlLp[c]);
          e = this.dlLp[c];
          if (this.dlHpA > 0) { const hy = this.dlHpA * (this.dlHp[c] + e - this.dlHpX[c]); this.dlHpX[c] = e; this.dlHp[c] = hy; e = hy; }
          e *= this.dlG;
          ln.push(x + e);
          if (c === 0) this.oL = x + e; else this.oR = x + e;
        }
        return;
      }
      case 6: { // REVERB
        const inp = (l + r) * 0.5;
        for (let c = 0; c < 2; c++) {
          let acc = 0;
          const cs = this.combs[c];
          for (let k = 0; k < 8; k++) {
            const ln = cs[k];
            const d = ln.read(ln.n - 1);
            const j = c * 8 + k;
            this.combLp[j] = d + this.rvDamp * (this.combLp[j] - d);
            ln.push(inp + this.combLp[j] * this.rvFb);
            acc += d;
          }
          const ap = this.aps[c];
          for (let k = 0; k < 4; k++) {
            const ln = ap[k];
            const d = ln.read(ln.n - 1);
            ln.push(acc + d * 0.5);
            acc = d - acc;
          }
          if (c === 0) this.oL = l + acc * this.rvWet; else this.oR = r + acc * this.rvWet;
        }
        return;
      }
      case 7: { // STEREO (Haas)
        const base = this.stD;
        const dL = this.stFar === 0 ? base + this.stExtra : base;
        const dR = this.stFar === 1 ? base + this.stExtra : base;
        let a = this.st[0].read(Math.max(1, dL)), b = this.st[1].read(Math.max(1, dR));
        this.st[0].push(l); this.st[1].push(r);
        if (this.stFar === 0) a *= this.stG; else if (this.stFar === 1) b *= this.stG;
        this.oL = a; this.oR = b;
        return;
      }
      case 8: { // TRANS: drop at each period start, recover over the release
        const ph = (ctx.playing ? (ctx.pos / Math.max(1, ctx.ppq)) / (RATE_BEATS[this.rate] / this.tempoMul) : this.phase) + i / period;
        const cyc = Math.floor(ph);
        if (cyc !== this.transPrev) { this.transPrev = cyc; this.transT = 0; }
        const tt = Math.min(1, this.transT / Math.max(1, this.transRel));
        this.transT++;
        const g = this.transDrop + (1 - this.transDrop) * Math.pow(tt, 2.5);
        this.oL = l * g; this.oR = r * g;
        return;
      }
      case 9: { // GRAIN: every two periods, the last period is played twice
        const P = Math.min((this.gr[0].n - 4) / 2, Math.max(64, period));
        this.grPh += 1;
        if (this.grPh >= 2 * P) this.grPh -= 2 * P;
        const second = this.grPh >= P;
        const pos = second ? this.grPh - P : this.grPh;
        const d = second ? 2 * P : P;
        // grain window: rises over the first 35 % of the period, falls over the last 10 % (FL's envelope)
        const u = pos / P;
        const f = u < 0.35 ? 0.5 - 0.5 * Math.cos((Math.PI * u) / 0.35) : u > 0.9 ? 0.5 + 0.5 * Math.cos((Math.PI * (u - 0.9)) / 0.1) : 1;
        this.oL = this.gr[0].read(d) * f; this.oR = this.gr[1].read(d) * f;
        this.gr[0].push(l); this.gr[1].push(r);
        return;
      }
      case 10: { // VOX
        let a = 0, b = 0;
        for (let k = 0; k < 3; k++) { a += this.vox[k].tick(0, l); b += this.vox[k].tick(1, r); }
        this.oL = a; this.oR = b;
        return;
      }
      case 11: { // RING
        this.ringPh += this.ringInc;
        if (this.ringPh >= 1) this.ringPh -= 1;
        const m = Math.sin(TWO_PI * this.ringPh);
        this.oL = l * m; this.oR = r * m;
        return;
      }
      default: this.oL = l; this.oR = r;
    }
  }

  monitor(): FxMonitor {
    const m: FxMonitor = { peakIn: this.peakIn, peakOut: this.peakOut, x: this.lastX, y: this.lastY, lfo: this.lfo };
    this.peakIn = this.peakOut = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'effector',
  create: (sr) => new Effector(sr),
};
