// Mobile Rack utility and multi-effect modules: Analyzer, Tuner, Multi FX and
// Pitcher 2.
//  - Analyzer / Tuner pass audio through and feed the editor displays
//    (spectrum and scope; detected pitch).
//  - Multi FX: one of eight effects with its two main settings on the X / Y
//    pad (Delay: time / feedback, Reverb: size / mix, LP and HP filter:
//    cutoff / resonance, Flanger: delay / feedback, Phaser: frequency /
//    feedback, Panner: position / width, Vox: vowel / resonance) and an LFO on
//    X. FL's exact mappings were not identified (approximated).
//  - Pitcher 2: pitch detection, the nearest enabled scale note (with speed
//    smoothing, stability, humanisation and vibrato) and a two-grain pitch
//    shifter; formant shifting is not reproduced.

import { DelayLine, rbj, Biquad2 } from '../hardcore/dsp';
import { FdnReverb } from '../hardcore/reverb';
import { Phasor, Scope, Sm, beatsToSec, clamp, fl, lfoShape, smoothK, type MrCtx, type MrModule } from './common';
import { PitchTracker } from './pitch';

const trunc = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.trunc(v * (n - 1) + 1e-7)));

const FFT_N = 1024;

/** In-place radix-2 FFT (re, im of length FFT_N). */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export class Analyzer implements MrModule {
  private readonly sr: number;
  private readonly scope = new Scope(4096);
  private readonly re = new Float32Array(FFT_N);
  private readonly im = new Float32Array(FFT_N);
  private readonly win = new Float32Array(FFT_N);
  private readonly spec = new Float32Array(FFT_N / 2);
  private readonly wave = new Float32Array(512);
  private pkL = 0; private pkR = 0; private rms = 0;

  constructor(sr: number) {
    this.sr = sr;
    for (let i = 0; i < FFT_N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
  }

  set(): void {}

  process(L: Float32Array, R: Float32Array, n: number): void {
    this.scope.push(L, R, n);
    let pl = 0, pr = 0, s = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a > pl) pl = a; if (b > pr) pr = b;
      s += 0.5 * (L[i] * L[i] + R[i] * R[i]);
    }
    this.pkL = Math.max(pl, this.pkL * 0.93); this.pkR = Math.max(pr, this.pkR * 0.93);
    const r = Math.sqrt(s / Math.max(1, n));
    this.rms += (r - this.rms) * 0.2;
  }

  reset(): void { this.scope.clear(); this.pkL = this.pkR = this.rms = 0; }
  tail(): number { return 0; }

  monitor() {
    this.scope.latest(this.re);
    this.im.fill(0);
    for (let i = 0; i < FFT_N; i++) this.re[i] *= this.win[i];
    fft(this.re, this.im);
    const norm = 4 / FFT_N;
    for (let k = 0; k < FFT_N / 2; k++) {
      const m = Math.hypot(this.re[k], this.im[k]) * norm;
      const db = m > 1e-9 ? 20 * Math.log10(m) : -180;
      this.spec[k] = Math.max(db, this.spec[k] - 1.5);
    }
    this.scope.latest(this.wave);
    return { spec: this.spec, wave: this.wave, sr: this.sr, l: this.pkL, r: this.pkR, rms: this.rms };
  }
}

export class Tuner implements MrModule {
  private readonly tracker: PitchTracker;
  private hz = 0;
  constructor(sr: number) { this.tracker = new PitchTracker(sr); }
  set(): void {}
  process(L: Float32Array, R: Float32Array, n: number): void {
    this.tracker.push(L, R, n);
    const h = this.tracker.hz;
    this.hz = h > 0 ? (this.hz > 0 ? this.hz + (h - this.hz) * 0.3 : h) : 0;
  }
  reset(): void { this.tracker.reset(); this.hz = 0; }
  tail(): number { return 0; }
  monitor() { return { hz: this.hz, clarity: this.tracker.clarity, level: this.tracker.level }; }
}

// ---------------------------------------------------------------------------

export class MultiFx implements MrModule {
  private readonly sr: number;
  private kind = 0;
  private xv = 0.5; private yv = 0.5;
  private lfoHz = 1; private lfoAmt = 0; private lfoShapeI = 0;
  private readonly lfo = new Phasor();
  private readonly dl: DelayLine;
  private readonly dr: DelayLine;
  private readonly rev: FdnReverb;
  private readonly revL: Float32Array;
  private readonly revR: Float32Array;
  private readonly f1 = new Biquad2();
  private readonly f2 = new Biquad2();
  private readonly ap = new Float64Array(24);
  private apyL = 0; private apyR = 0;
  private readonly dT: Sm;
  private readonly bs: number;

  constructor(sr: number, bs: number) {
    this.sr = sr; this.bs = bs;
    this.dl = new DelayLine(1.05 * sr + 16); this.dr = new DelayLine(1.05 * sr + 16);
    this.rev = new FdnReverb(sr, 40, 1.3);
    this.revL = new Float32Array(bs); this.revR = new Float32Array(bs);
    this.dT = new Sm(0.25 * sr, smoothK(80, sr));
  }

  set(p: Float64Array): void {
    const k = trunc(p[1], 8);
    if (k !== this.kind) { this.kind = k; this.reset(); }
    this.xv = p[2]; this.yv = p[3];
    this.lfoHz = 0.05 + 9.95 * p[4] * p[4];
    this.lfoAmt = p[5];
    this.lfoShapeI = Math.min(2, Math.max(0, Math.round(p[6] * 2)));
  }

  snap(): void { this.dT.snap(); }

  private allpass6(x: number, a: number, off: number): number {
    const s = this.ap;
    for (let k = 0; k < 6; k++) {
      const i = off + 2 * k;
      const y = a * x + s[i] - a * s[i + 1];
      s[i] = x; s[i + 1] = y; x = y;
    }
    return x;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    for (let o = 0; o < n; o += this.bs) {
      const m = Math.min(this.bs, n - o);
      this.block(L.subarray(o, o + m), R.subarray(o, o + m), m, ctx);
    }
  }

  private block(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void {
    void ctx;
    const sr = this.sr;
    const ph = this.lfo.advance(this.lfoHz, n, sr);
    const lv = lfoShape(this.lfoShapeI, ph);
    const x = clamp(this.xv + 0.5 * this.lfoAmt * lv, 0, 1), y = this.yv;
    switch (this.kind) {
      case 0: { // Delay: X time 20 ms..1 s, Y feedback
        this.dT.set((0.02 + 0.98 * x * x) * sr);
        const fb = 0.9 * y, maxD = this.dl.size - 2;
        for (let i = 0; i < n; i++) {
          const d = clamp(this.dT.next(), 1, maxD);
          const tl = this.dl.read(d), tr = this.dr.read(d);
          this.dl.write(fl(L[i] + fb * tl)); this.dr.write(fl(R[i] + fb * tr));
          L[i] += 0.5 * tl; R[i] += 0.5 * tr;
        }
        break;
      }
      case 1: { // Reverb: X size / decay, Y mix
        this.rev.set(0.3 + 6 * x * x, 9000, 10, 0.5 + 0.8 * x);
        this.rev.process(L, R, this.revL, this.revR, n);
        for (let i = 0; i < n; i++) { L[i] = L[i] * (1 - 0.5 * y) + this.revL[i] * 1.5 * y; R[i] = R[i] * (1 - 0.5 * y) + this.revR[i] * 1.5 * y; }
        break;
      }
      case 2: case 3: { // LP / HP filter: X cutoff, Y resonance
        const f = 30 * Math.pow(600, x), q = 0.5 + 9.5 * y * y;
        const c = rbj(this.kind === 2 ? 'lp' : 'hp', Math.min(f, sr * 0.45), sr, 0, q);
        this.f1.set(c); this.f1.process(L, R, n);
        break;
      }
      case 4: { // Flanger: X delay 0.2..8 ms, Y feedback
        const d = (0.0002 + 0.0078 * x * x) * sr, fb = 0.9 * y;
        for (let i = 0; i < n; i++) {
          const tl = this.dl.read(Math.max(1, d)), tr = this.dr.read(Math.max(1, d));
          this.dl.write(fl(L[i] + fb * tl)); this.dr.write(fl(R[i] + fb * tr));
          L[i] = 0.7 * (L[i] + tl); R[i] = 0.7 * (R[i] + tr);
        }
        break;
      }
      case 5: { // Phaser: X frequency, Y feedback
        const t = (60 + 8000 * x * x) / sr, a = (t - 1) / (t + 1), fb = 0.85 * y;
        for (let i = 0; i < n; i++) {
          const yl = this.allpass6(L[i] + fb * this.apyL, a, 0);
          const yr = this.allpass6(R[i] + fb * this.apyR, a, 12);
          this.apyL = fl(yl); this.apyR = fl(yr);
          L[i] = 0.5 * (L[i] + yl); R[i] = 0.5 * (R[i] + yr);
        }
        break;
      }
      case 6: { // Panner: X position, Y width
        const pos = 2 * x - 1, w = y;
        const gl = Math.min(1, 1 - pos), gr = Math.min(1, 1 + pos);
        for (let i = 0; i < n; i++) {
          const m = 0.5 * (L[i] + R[i]), s = 0.5 * (L[i] - R[i]) * w * 2;
          L[i] = (m + s) * gl; R[i] = (m - s) * gr;
        }
        break;
      }
      default: { // Vox: X vowel (a-e-i-o-u formants), Y resonance
        const F1 = [730, 530, 270, 570, 300], F2 = [1090, 1840, 2290, 840, 870];
        const pos = x * 4, i0 = Math.min(3, Math.floor(pos)), fr = pos - i0;
        const f1 = F1[i0] + (F1[i0 + 1] - F1[i0]) * fr, f2 = F2[i0] + (F2[i0 + 1] - F2[i0]) * fr;
        const q = 2 + 10 * y;
        this.f1.set(rbj('peak', f1, sr, 12, q)); this.f2.set(rbj('peak', f2, sr, 10, q));
        this.f1.process(L, R, n); this.f2.process(L, R, n);
        for (let i = 0; i < n; i++) { L[i] *= 0.35; R[i] *= 0.35; }
      }
    }
  }

  reset(): void { this.dl.clear(); this.dr.clear(); this.rev.reset(); this.f1.reset(); this.f2.reset(); this.ap.fill(0); this.apyL = this.apyR = 0; }
  tail(): number { return this.kind === 0 ? 10 : this.kind === 1 ? 7 : 0.2; }
}

// ---------------------------------------------------------------------------

/** Two-grain delay-line pitch shifter (one channel). */
class GrainShifter {
  private readonly buf: Float32Array;
  private readonly N: number;
  private w = 0;
  private ph = 0;
  private readonly win: number;
  constructor(sr: number) {
    this.win = Math.round(0.04 * sr);
    this.N = 1 << Math.ceil(Math.log2(this.win * 4));
    this.buf = new Float32Array(this.N);
  }
  tick(x: number, ratio: number): number {
    const N = this.N, mask = N - 1, W = this.win;
    this.buf[this.w] = x;
    // grain phase: delay sweeps W..0 (ratio > 1) or 0..W (ratio < 1)
    this.ph += (1 - ratio) / W;
    this.ph -= Math.floor(this.ph);
    let y = 0;
    for (let g = 0; g < 2; g++) {
      const p = (this.ph + g * 0.5) % 1;
      const d = 2 + p * W;
      const pos = this.w - d;
      const i = Math.floor(pos), f = pos - i;
      const a = this.buf[i & mask], b = this.buf[(i + 1) & mask];
      const s = a + (b - a) * f;
      y += s * Math.sin(Math.PI * p);
    }
    this.w = (this.w + 1) & mask;
    return y * 0.7071;
  }
  reset(): void { this.buf.fill(0); this.w = 0; this.ph = 0; }
}

export class Pitcher2 implements MrModule {
  private readonly sr: number;
  private readonly tracker: PitchTracker;
  private readonly gL: GrainShifter;
  private readonly gR: GrainShifter;
  private readonly notes = new Uint8Array(12);
  private speed = 0.5;
  private ref = 1;
  private stability = 0.5; private human = 0; private snapping = false;
  private readonly mix: Sm;
  private sens = 0.5; private vib = 0;
  private ratio = 1;
  private target = 1;
  private vibPh = 0;
  private humT = 0; private hum = 0; private seed = 99;
  private shownHz = 0; private shownTarget = 0;
  private readonly mono: Float32Array;

  constructor(sr: number, bs: number) {
    this.sr = sr;
    this.tracker = new PitchTracker(sr);
    this.gL = new GrainShifter(sr); this.gR = new GrainShifter(sr);
    this.mix = new Sm(1, smoothK(10, sr));
    this.mono = new Float32Array(bs);
  }

  set(p: Float64Array): void {
    for (let i = 0; i < 12; i++) this.notes[i] = p[1 + i] >= 0.5 ? 1 : 0;
    this.speed = p[13];
    this.ref = trunc(p[18], 3);
    this.stability = p[19]; this.human = p[20]; this.snapping = p[21] >= 0.5;
    this.mix.set(p[22]);
    this.sens = p[23]; this.vib = p[24];
    this.tracker.threshold = 0.08 + 0.3 * this.sens;
  }

  snap(): void { this.mix.snap(); }

  private rand(): number { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296 * 2 - 1; }

  /** Correction ratio for a detected frequency: nearest enabled note. */
  private correction(hz: number): number {
    const midi = 69 + 12 * Math.log2(hz / 440);
    let best = 0, bestD = 1e9;
    for (let k = -1; k <= 1; k++) {
      const base = Math.round(midi) + k;
      for (let j = -6; j <= 6; j++) {
        const m = base + j, pc = ((m % 12) + 12) % 12;
        if (!this.notes[pc]) continue;
        const d = Math.abs(m - midi);
        if (d < bestD) { bestD = d; best = m; }
      }
    }
    if (bestD > 12) return 1;
    let diff = best - midi;
    if (!this.snapping) {
      // stability keeps small deviations (natural pitch variation)
      const keep = 0.15 * (1 - this.stability);
      if (Math.abs(diff) < keep) diff = 0;
    }
    this.shownTarget = 440 * Math.pow(2, (best - 69) / 12);
    return Math.pow(2, diff / 12);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const m = this.mono;
    for (let i = 0; i < n; i++) m[i] = this.ref === 0 ? L[i] : this.ref === 2 ? R[i] : 0.5 * (L[i] + R[i]);
    this.tracker.push(m, null, n);
    const hz = this.tracker.hz;
    this.shownHz = hz;
    if (hz > 0 && this.tracker.clarity > 0.4) this.target = this.correction(hz);
    else this.target = 1;
    const k = smoothK(1 + 300 * this.speed * this.speed, this.sr) * n;
    this.ratio += (this.target - this.ratio) * Math.min(1, k);
    // humanisation and vibrato (cents)
    this.humT += n / this.sr;
    if (this.humT > 0.25) { this.humT = 0; this.hum = this.rand(); }
    this.vibPh += (5.5 * n) / this.sr; this.vibPh -= Math.floor(this.vibPh);
    const cents = 25 * this.human * this.hum + 50 * this.vib * Math.sin(2 * Math.PI * this.vibPh);
    const r = this.ratio * Math.pow(2, cents / 1200);
    for (let i = 0; i < n; i++) {
      const w = this.mix.next();
      const yl = this.gL.tick(L[i], r), yr = this.gR.tick(R[i], r);
      L[i] += (yl - L[i]) * w; R[i] += (yr - R[i]) * w;
    }
  }

  reset(): void { this.tracker.reset(); this.gL.reset(); this.gR.reset(); this.ratio = 1; }
  tail(): number { return 0.05; }
  monitor() { return { hz: this.shownHz, target: this.shownTarget, ratio: this.ratio }; }
}

void beatsToSec;
