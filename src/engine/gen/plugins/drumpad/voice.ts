// The Drumpad voice (FL: Drumpad and Drumaxx, by Maxx Claster; the same engine
// code in both plugins' engine dylibs), ported from FL 2026 in its single
// precision and operation order: mallet + noise, the 128 x 4 comb membrane, SOF,
// LOW, HIGH and MID filters, hold, Lo-Fi, and FL's resampler / gain ramp
// (docs/research/gen/drumpad.md). Drumpad uses one voice (polyphony 1); Drumaxx
// one per pad, allocated at construction (no first-use quirk) and with a cut
// flag (cut groups: the voice's hold ends at once).

import { cosf, exp10f, exp2d, exp2f, fma32, fmaD, powf, sincos, sincosf, sinf } from './libm';

const f32 = Math.fround;
/** Single-precision fused multiply-add (arm64 FMADD: one rounding), exact. */
const fma = fma32;
/** The same, rounded via double (the membrane's inner loop: wrong only on exact float ties after the double rounding). */
const fmaF = (a: number, b: number, c: number) => f32(a * b + c);
const LCG_A = 0x0bb38435;
const LCG_C = 0x3619636b;
const INT_RATE = 38000;
const F_INV_RATE = f32(1 / 38000);
export { INT_RATE as DP_INT_RATE };
const LINES = 128;
/** FL's internal buffer holds 1024 floats; ours more, so extreme pitches at low rates do not overflow. */
const IBUF = 8192;

/** Engine defaults (a fresh FL instance plays these until a control is touched). */
export const DP_ENGINE_DEFAULTS = [0, 0, 0.5, 0.5, 0, 0, f32(0.9), f32(0.35), f32(0.3), 0.5, 0.5, 1, 1, 0, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0, 1, 0.5,
  0, 0, 0, 0, 0, 0, 0, 0];

const lcg = (x: number) => (Math.imul(x, LCG_A) + LCG_C) >>> 0;

/** The voices' noise seeds: FL's constructor advances a global LCG (from 0) 3000 steps per voice. */
export const DP_SEEDS = (() => {
  const s = new Uint32Array(16);
  let g = 0;
  for (let v = 0; v < 16; v++) { for (let k = 0; k < 3000; k++) g = lcg(g); s[v] = g; }
  return s;
})();


/** FL's circular pan law in single precision (ComputeLRVol). */
export function flLRVol(pan: number, vol: number, out: { l: number; r: number }): void {
  const p = !(pan >= -1) ? -1 : pan > 1 ? 1 : pan;
  sincosf(f32(f32(p + 1) * 0.7853981633974483));
  out.l = f32(sincos.c * vol);
  out.r = f32(sincos.s * vol);
}

const F_1E9 = f32(1e-9);
const flush = (x: number) => (x < F_1E9 && x > -F_1E9 ? 0 : x);

/** FL's RBJ-style biquad (types 0 low shelf, 1 peaking, 2 high shelf; A = 10^(dB / 20), bandwidth in octaves). */
export class Rbj {
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  fs = 44100; gain = 0; freq = 1000; q = 1; dirty = true; type = 1;
  constructor() { this.update(44100); }

  update(fs: number): void {
    if (this.fs !== fs) this.dirty = true;
    this.fs = fs;
    if (!this.dirty) return;
    this.dirty = false;
    const A = exp10f(f32(this.gain * f32(0.05)));
    let w = f32((this.freq * 6.283185) / fs);
    w = w < 3 ? w : 3;
    w = w > 0 ? w : 0;
    const bw = this.q * 0.3465736 * w;
    const sn = sinf(w);
    const sh = f32(2 * Math.sinh(bw / sn));
    const s11 = f32(f32(Math.sqrt(A)) * sh);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (this.type === 1) {
      const al = f32(f32(sh * 0.5) * sn);
      const s12 = f32(al / A);
      a0 = f32(s12 + 1);
      const s8 = f32(al * A);
      b0 = f32(s8 + 1);
      const cs = cosf(w);
      a1 = b1 = f32(cs * -2);
      b2 = f32(1 - s8);
      a2 = f32(1 - s12);
    } else if (this.type === 2 || this.type === 0) {
      const ap = f32(A + 1), am = f32(A - 1);
      const cs = cosf(w);
      const amc = fma(A, cs, -cs); // (A - 1) cos, fused
      const apc = fma(A, cs, cs); // (A + 1) cos, fused
      const s4 = f32(sn * s11);
      if (this.type === 2) {
        const s2 = f32(amc + ap);
        b0 = f32(f32(s2 + s4) * A);
        b1 = f32(f32(A * -2) * f32(apc + am));
        b2 = f32(f32(s2 - s4) * A);
        a0 = f32(f32(ap - amc) + s4);
        const t = f32(am - apc);
        a1 = f32(t + t);
        a2 = f32(ap - f32(s4 + amc));
      } else {
        const s3 = f32(amc + ap);
        a0 = f32(s3 + s4);
        b0 = f32(f32(f32(ap - amc) + s4) * A);
        const t = f32(am - apc);
        b1 = f32(A * f32(t + t));
        b2 = f32(f32(ap - f32(s4 + amc)) * A);
        a1 = f32(f32(apc + am) * -2);
        a2 = f32(s3 - s4);
      }
    } else return;
    const r = f32(1 / a0);
    this.b0 = flush(f32(b0 * r)); this.b1 = flush(f32(b1 * r)); this.b2 = flush(f32(b2 * r));
    this.a1 = flush(f32(a1 * r)); this.a2 = flush(f32(a2 * r));
  }
}

/** One of FL's Drumpad / Drumaxx voices (the same engine code in both). */
export class DpVoice {
  readonly index: number;
  note = -1;
  stamp = 0;
  /** Velocity (MIDI / 127)^0.5. */
  vel = 0;
  rng: number;
  active = false;
  /** Still waiting for the output to exceed 1e-4 (FL: byte 0x49dd). */
  quiet = false;
  // parameters (read at note-on)
  lpC = 0; fb = 0; phase = 0; tension = 0; material = 0; size = 0; shape = 128;
  malletAmp = 0; malletDec = 0; mallet = 0; noiseV = 0; noiseInv = 1; retrig = false; seed = 0;
  first = 0; count = 0; dirtyW = true;
  sofV = 0; sofDec = 0; sofLvl = 0; s1 = 0; s2 = 0; s3 = 0; s4 = 0; g0 = 0; k2 = 0; sofEnv = 1;
  // LOW (FL's sub-filter design: high-pass)
  lowOn = false; lowFreqP = 0; lowQP = 0;
  lF = 100; lQ = 1; lFs = 44100; c1 = f32(0.9928763508796692); c2 = f32(-1.9717060327529907); c3 = f32(0.9719060659408569);
  lx1 = 0; lx2 = 0; ly1 = 0; ly2 = 0;
  // HIGH / MID
  readonly high = new Rbj();
  readonly mid = new Rbj();
  highOn = false; hiF = 0; hiQ = 0; hiG = 0;
  midOn = false; mF = 0; mFm = 0; mL = 0; mLm = 0; mQ = 0; mAtt = 0; mEnv = 1; mEnvC = 0; mCnt = 0; mRetrig = 0; mRetrigP = 0;
  lofi = 0; hold = 0; pitchP = 1;
  // output stage
  holdGain = 0; holdT = 0; silT = 0;
  // resampler
  cnt = 0; pos = 0;
  readonly buf = new Float32Array(IBUF + 2);
  tgtL = 0; tgtR = 0; gL = -1; gR = -1;
  ratio = 1; pitchRatio = 1; sr = 38000;
  // membrane
  allocated = false;
  lines: Float32Array[] = [];
  readonly cur = new Int32Array(LINES);
  readonly lp = new Float32Array(512);
  readonly w = new Float32Array(512);

  /** FL's per-note voice counts (shared by the instance's voices). */
  private readonly counts: Int32Array;

  /** Drumaxx: cut (cut group): the hold ends now (FL: voice byte 0x48). */
  cut = false;
  /** firstUseQuirk (Drumpad): FL allocates the membrane at the voice's first note and counts the voice as free then. */
  constructor(index: number, counts: Int32Array, firstUseQuirk = true) {
    this.index = index;
    this.counts = counts;
    this.rng = DP_SEEDS[index];
    this.mid.type = 1;
    this.shape = 128;
    if (!firstUseQuirk) this.allocate();
    this.reset(INT_RATE);
  }

  private allocate(): void {
    this.allocated = true;
    this.lines = [];
    for (let i = 0; i < LINES; i++) this.lines.push(new Float32Array((512 - 4 * i) * 4));
  }

  /** FL's voice reset (sample rate): silence, clear the membrane and the filters. */
  reset(sr: number): void {
    if (sr !== 0) this.sr = sr;
    this.releaseSlot();
    if (sr > 0) this.ratio = f32(INT_RATE / f32(sr));
    this.active = false; this.quiet = false;
    this.silT = 0;
    this.mEnv = 1;
    if (this.allocated) {
      for (let i = 0; i < LINES; i++) { this.lines[i].fill(0); this.cur[i] = 0; }
      this.lp.fill(0);
    }
    this.buf.fill(0);
    this.mid.x1 = this.mid.x2 = this.mid.y1 = this.mid.y2 = 0;
    this.holdGain = 1;
    this.lx1 = this.lx2 = this.ly1 = this.ly2 = 0;
    this.high.x1 = this.high.x2 = this.high.y1 = this.high.y2 = 0;
    this.gL = this.gR = -1;
    this.s1 = this.s2 = this.s3 = this.s4 = 0;
    this.sofEnv = 1;
  }

  /** FL's voice parameter setup (velocity-modulated parameter values). */
  private setup(get: (i: number) => number): void {
    const c = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
    let v = c(get(7));
    this.lpC = f32(v * v);
    this.fb = -powf(c(get(6)), f32(0.3));
    v = c(get(9)); if (v !== this.phase) { this.phase = v; this.dirtyW = true; }
    v = c(get(8)); if (v !== this.tension) { this.tension = v; this.dirtyW = true; }
    v = c(get(10)); if (v !== this.material) { this.material = v; this.dirtyW = true; }
    v = c(f32(1 - get(11)));
    let k = Math.min(Math.trunc(v * 512), 511);
    if (k !== this.size) { this.size = k; this.dirtyW = true; }
    const sh = get(12) * 128;
    k = !(sh > -2147483648) ? -2147483648 : sh >= 2147483647 ? 2147483647 : Math.trunc(sh);
    k = k > 1 ? k : 1;
    k = k < 128 ? k : 128;
    if (k !== this.shape) { this.shape = k; this.dirtyW = true; }
    v = c(get(2));
    this.malletAmp = f32(Math.pow(10, fmaD(v, 4, -4)));
    v = c(get(3));
    const iv = f32(1 - v);
    let t = fma(-v, iv, iv);
    t = f32(t * t);
    this.malletDec = f32(fmaD(t, 0.05, 1e-4));
    v = c(get(4));
    this.noiseV = v; this.noiseInv = f32(1 - v);
    this.retrig = get(-1) !== 0;
    const sd = get(5) * 4294967295;
    this.seed = !(sd > 0) ? 0 : sd >= 4294967295 ? 4294967295 : Math.trunc(sd);
    v = c(get(27));
    if (v >= 0.01) {
      const a = f32(1 - v);
      const a2 = a * a, a4 = a2 * a2;
      this.lofi = Math.trunc(fmaD(a4, a * 65536, 4));
    } else this.lofi = 0;
    v = c(get(28));
    this.hold = fma(f32(v * v), f32(3 * v), f32(0.001));
    v = c(get(29));
    this.pitchP = exp2d(v * 2 - 1);
    let raw = get(13);
    this.lowOn = raw !== 0;
    this.lowFreqP = exp2f(fma(c(raw), 11, 2));
    this.lowQP = f32(c(get(14)) * 8 + 1);
    this.hiF = exp2f(fma(c(get(24)), f32(4.1), 8));
    this.hiQ = f32(f32(1 - c(get(26))) * 2 + 0.5);
    this.hiG = f32(c(get(25)) * 36 - 18);
    this.highOn = Math.abs(this.hiG) > f32(0.01);
    this.mF = exp2f(fma(c(get(18)), 9, 5));
    this.mFm = fma(c(get(21)), 32, -16);
    raw = get(19);
    const on1 = raw !== 0.5;
    this.mL = f32(c(raw) * 32 - 16);
    raw = get(22);
    const on2 = raw !== 0.5;
    this.midOn = on1 || on2;
    this.mLm = f32(c(raw) * 48 - 24);
    this.mQ = f32(f32(1 - c(get(20))) * 4 + 0.5);
    v = c(get(23));
    const iw = f32(1 - v);
    t = fma(-v, iw, iw);
    t = f32(t * t);
    this.mAtt = f32(fmaD(t, 0.01, 1e-5));
    const r3 = f32(get(-2) * 3);
    k = Math.trunc(r3);
    this.mRetrigP = k > 0 ? (k < 3 ? k : 3) : 0;
    this.sofV = c(get(15));
    t = f32(c(get(16)) * 0.5);
    t = f32(t * t); t = f32(t * t);
    this.sofDec = f32(fmaD(t, 0.01, 1e-5));
    raw = get(17);
    this.sofOn = raw !== 0;
    const d = c(raw), d2 = d * d, d4 = d2 * d2;
    this.sofLvl = f32(d4 * d4 * 0.5);
  }
  sofOn = false;

  /** FL's voice note-on: allocate on first use, set up, start the envelopes. */
  noteOn(get: (i: number) => number): void {
    if (!this.allocated) {
      this.allocate();
      // FL releases the note slot (the voice counts as free) and resets the voice
      this.releaseSlot();
      this.reset(this.sr);
    }
    this.setup(get);
    if (this.retrig) this.rng = this.seed >>> 0;
    this.cut = false;
    this.holdT = 0; this.silT = 0;
    this.mallet = this.malletAmp;
    this.mEnv = 1; this.mEnvC = this.mAtt; this.mRetrig = this.mRetrigP;
    if (this.dirtyW) { this.dirtyW = false; this.weights(); }
    this.lowCoefs(this.lowFreqP, this.lowQP, INT_RATE);
    const h = this.high;
    if (h.type !== 2) h.dirty = true;
    h.type = 2;
    if (h.gain !== this.hiG) h.dirty = true;
    h.gain = this.hiG;
    const hf = this.hiF > 0 ? this.hiF : 0, hq = this.hiQ > 1e-4 ? this.hiQ : f32(1e-4);
    if (h.freq !== hf || h.q !== hq) h.dirty = true;
    h.freq = hf; h.q = hq;
    h.update(INT_RATE);
    this.mCnt = 0;
    this.g0 = Math.min(f32(exp2f(f32(fmaD(this.sofV, 4.65, 5.93000001385808))) * 0.00015789473684210527), 1);
    this.g0 = f32(this.g0);
    this.k2 = f32(this.g0 * 333.3333333333333);
    this.sofEnv = 1;
    this.active = true; this.quiet = true;
  }

  /** Comb weights and the active vector lines (FL: when phase / tension / material / size / shape changed). */
  private weights(): void {
    const s = this.size;
    const first = Math.min(s >> 2, 127);
    const e = Math.min(this.shape + s, 511);
    this.count = (e >> 2) - first + ((e & 3) !== 0 ? 1 : 0);
    this.first = first;
    const m = f32(this.material * 2 - 1);
    let m4 = f32(m * m); m4 = f32(m4 * m4);
    const expo = m < 0 ? f32(1 / fma(m4, 20, 1)) : fma(m4, 20, 1);
    let t4 = f32(this.tension * this.tension); t4 = f32(t4 * t4);
    const inc = f32(t4 * 0.5);
    let ph = this.phase;
    const w = this.w;
    for (let n = 511; n >= 0; n--) {
      let y = 0;
      if (n >= s && n <= e) {
        let x = f32(ph * 2 - 1);
        if (x > 0.5) x = f32(1 - x);
        if (x < -0.5) x = f32(-1 - x);
        x = f32(x + x);
        y = x >= 0 ? powf(x, expo) : -powf(-x, expo);
      }
      w[n] = y;
      const p2 = f32(ph + inc);
      ph = p2 > 1 ? f32(p2 - 1) : p2;
    }
  }

  /** LOW filter coefficients (FL: only when frequency, Q or rate changed). */
  private lowCoefs(fr: number, q: number, fs: number): void {
    if (fr === this.lF && q === this.lQ && fs === this.lFs) return;
    this.lF = fr; this.lQ = q; this.lFs = fs;
    const w = f32((fr * 6.283185307179586) / fs);
    sincosf(w);
    const sn = sincos.s, cs = sincos.c;
    const s2 = f32(sn + q);
    const a = f32(f32(cs + 1) / f32(f32(sn / q) + 2));
    const b = f32((q * -2 * cs) / s2);
    const cc = f32(f32(q - sn) / s2);
    this.c1 = flush(a); this.c2 = flush(b); this.c3 = flush(cc);
  }

  /** FL's internal render: n samples at 38 kHz into out[o..o + n). */
  render(out: Float32Array, o: number, n: number): void {
    if (!this.active) { out.fill(0, o, o + n); return; }
    const lines = this.lines, cur = this.cur, lp = this.lp, w = this.w;
    const lpC = this.lpC, fb = this.fb;
    const first = this.first, last = this.first + this.count;
    const h = this.high, md = this.mid;
    for (let i = 0; i < n; i++) {
      // mallet: impulse decaying to 1e-7, mixed with the noise
      const r = f32(this.rng) * 2.3283064365386963e-10;
      this.rng = lcg(this.rng);
      const lvl = f32(fmaD(1e-7 - this.mallet, this.malletDec, this.mallet));
      this.mallet = lvl;
      const exc = f32(f32(this.noiseInv + f32((r - 0.5) * this.noiseV)) * lvl);
      // membrane: the comb lines, four lanes each
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let l = first; l < last; l++) {
        const b = lines[l];
        const L = 512 - 4 * l;
        let k = cur[l];
        if (k === L - 1) b[4 * k + 1] = b[1];
        else if (k === L - 2) { b[4 * k + 2] = b[2]; b[4 * k + 6] = b[6]; }
        else if (k === L - 3) { b[4 * k + 3] = b[3]; b[4 * k + 7] = b[7]; b[4 * k + 11] = b[11]; }
        const q = 4 * k, p = 4 * l;
        const y0 = b[q], y1 = b[q + 1], y2 = b[q + 2], y3 = b[q + 3];
        let s = fmaF(f32(y0 - lp[p]), lpC, lp[p]); lp[p] = s; b[q] = fmaF(s, fb, exc);
        s = fmaF(f32(y1 - lp[p + 1]), lpC, lp[p + 1]); lp[p + 1] = s; b[q + 1] = fmaF(s, fb, exc);
        s = fmaF(f32(y2 - lp[p + 2]), lpC, lp[p + 2]); lp[p + 2] = s; b[q + 2] = fmaF(s, fb, exc);
        s = fmaF(f32(y3 - lp[p + 3]), lpC, lp[p + 3]); lp[p + 3] = s; b[q + 3] = fmaF(s, fb, exc);
        if (++k === L) {
          // FL's wrap: lane j moves down by j vectors (its line is j shorter)
          for (let m = 0; m < L - 1; m++) b[4 * m + 1] = b[4 * m + 5];
          for (let m = 0; m < L - 2; m++) b[4 * m + 2] = b[4 * m + 10];
          for (let m = 0; m < L - 3; m++) b[4 * m + 3] = b[4 * m + 15];
          k = 0;
        }
        cur[l] = k;
        a0 = fmaF(y0, w[p], a0); a1 = fmaF(y1, w[p + 1], a1); a2 = fmaF(y2, w[p + 2], a2); a3 = fmaF(y3, w[p + 3], a3);
      }
      let x = f32(f32(a0 + a1) + f32(a2 + a3));
      // SOF: ladder with a closing cutoff, added to the signal
      if (this.sofOn) {
        const k2 = this.k2, env = this.sofEnv;
        const g = f32(this.g0 / f32(k2 + 1 - f32(env * k2)));
        const y4 = this.s4;
        const u = fma(y4, -100000, x);
        x = fma(this.sofLvl, y4, x);
        const sc = f32(u / fmaD(Math.abs(u), 0.005, 1));
        this.s1 = fma(f32(sc - this.s1), g, this.s1);
        this.s2 = fma(f32(this.s1 - this.s2), g, this.s2);
        this.s3 = fma(f32(this.s2 - this.s3), g, this.s3);
        this.s4 = fma(f32(this.s3 - y4), g, y4);
        this.sofEnv = fma(-this.sofDec, env, env);
      }
      // LOW: high-pass (b = c1 (1, -2, 1))
      if (this.lowOn) {
        const t = f32(f32(this.lx2 - f32(this.lx1 + this.lx1)) + x);
        const u = fma(this.ly2, -this.c3, -f32(this.ly1 * this.c2));
        const y = fma(t, this.c1, u);
        this.ly2 = this.ly1; this.lx2 = this.lx1; this.lx1 = x; this.ly1 = y;
        x = y;
      }
      // HIGH: shelf
      if (this.highOn) {
        let t1 = f32(h.x1 * h.b1);
        let t2 = f32(h.y1 * h.a1);
        t2 = fma(h.y2, h.a2, t2);
        t1 = fma(h.x2, h.b2, t1);
        t1 = f32(t1 - t2);
        const y = fma(x, h.b0, t1);
        h.x2 = h.x1; h.x1 = x; h.y2 = h.y1; h.y1 = y;
        x = y;
      }
      // MID: peaking, swept by the attack envelope (coefficients every 6 samples)
      if (this.midOn) {
        if (this.mCnt === 0) {
          const env = this.mEnv, ie = f32(1 - env);
          const gain = f32(fma(-env, this.mLm, this.mLm) + this.mL);
          if (md.gain !== gain) md.dirty = true;
          md.gain = gain;
          const fm = this.mFm;
          let fr: number;
          if (fm >= 0) fr = fma(f32(fm * ie), this.mF, this.mF);
          else fr = f32(this.mF / (1 - f32(fm * ie)));
          fr = fr > 32 ? fr : 32;
          fr = fr < 12000 ? fr : 12000;
          fr = fr > 0 ? fr : 0;
          if (md.freq !== fr) md.dirty = true;
          md.freq = fr;
          const q = this.mQ > f32(1e-4) ? this.mQ : f32(1e-4);
          if (md.q !== q) md.dirty = true;
          md.q = q;
          md.update(INT_RATE);
        }
        this.mCnt = this.mCnt + 1 === 6 ? 0 : this.mCnt + 1;
        let env = fma(-this.mEnvC, this.mEnv, this.mEnv);
        if (this.mRetrig !== 0 && env < 0.01) { env = 1; this.mRetrig--; }
        this.mEnv = env;
        let t = f32(md.b0 * x);
        const u0 = f32(md.a1 * md.y1);
        const u = fma(md.a2, md.y2, u0);
        t = fma(md.b1, md.x1, t);
        t = fma(md.b2, md.x2, t);
        const y = f32(t - u);
        md.x2 = md.x1; md.x1 = x; md.y2 = md.y1; md.y1 = y;
        x = y;
      }
      // hold, clip, Lo-Fi
      let gd: number;
      if (this.holdT < this.hold && !this.cut) gd = fmaD(f32(1 - this.holdGain), 0.1, this.holdGain);
      else gd = this.holdGain * 0.999;
      x = x < 1 ? x : 1;
      x = x > -1 ? x : -1;
      this.holdGain = f32(gd);
      this.holdT = f32(this.holdT + F_INV_RATE);
      x = f32(x * this.holdGain);
      if (this.lofi !== 0) { const st = f32(this.lofi); x = f32(Math.trunc(f32(x * st)) / st); }
      if (Math.abs(x) <= f32(1e-4)) this.silT = f32(this.silT + F_INV_RATE);
      else { this.silT = 0; this.quiet = false; }
      out[o + i] = x;
    }
    if ((this.silT > 0.025 && !this.quiet) || this.silT > 0.5) this.end();
  }

  /** The voice has finished: FL frees its note slot and resets it. */
  private end(): void {
    this.releaseSlot();
    this.reset(this.sr);
  }

  /** FL's note assignment: the per-note voice counts follow. */
  assign(note: number): void {
    const c = this.counts;
    if (this.note >= 0 && this.note <= 127 && c[this.note] >= 1) c[this.note]--;
    this.note = note;
    if (note >= 0 && note <= 127) c[note]++;
  }

  /** FL's note release (voice end, first use): the voice counts as free. */
  releaseSlot(): void {
    const c = this.counts;
    if (this.note >= 0 && this.note <= 127 && c[this.note] >= 1) c[this.note]--;
    this.note = -1;
  }

  /** FL's voice process: resample into L / R (from off, n frames) with the ramped gains. */
  process(L: Float32Array, R: Float32Array, off: number, n: number): void {
    if (!this.active) return;
    if (this.gL < 0) this.gL = this.tgtL;
    if (this.gR < 0) this.gR = this.tgtR;
    const buf = this.buf;
    if (n >= 1) {
      const step = this.ratio * (this.pitchP * this.pitchRatio);
      let pos = this.pos;
      let o = off;
      const G = f32(0.001);
      while (n > 0) {
        const c = n < 256 ? n : 256;
        n -= c;
        let rem = c;
        if (pos < 0) {
          const prev = this.cnt;
          let w8 = c;
          for (;;) {
            const d3 = pos + prev;
            const ii = Math.trunc(d3);
            const fr = f32(d3 - ii);
            const a = buf[ii];
            const smp = fma(f32(buf[ii + 1] - a), fr, a);
            L[o] = f32(L[o] + f32(smp * this.gL));
            R[o] = f32(R[o] + f32(this.gR * smp));
            o++;
            pos += step;
            rem = w8 - 1;
            this.gL = fma(f32(this.tgtL - this.gL), G, this.gL);
            this.gR = fma(f32(this.tgtR - this.gR), G, this.gR);
            if (pos >= 0 || w8 === 1) break;
            w8 = rem;
          }
          this.pos = pos;
          if (rem === 0) continue;
        }
        const d0 = fmaD(step, rem, pos);
        let cnt = Math.trunc(d0);
        if (d0 > cnt) cnt++;
        this.cnt = cnt;
        this.render(buf, 1, cnt);
        pos = this.pos;
        for (let w8 = rem + 1; w8 > 1; w8--) {
          const ii = Math.trunc(pos);
          const fr = f32(pos - ii);
          const a = buf[ii];
          const smp = fma(f32(buf[ii + 1] - a), fr, a);
          L[o] = f32(L[o] + f32(smp * this.gL));
          R[o] = f32(R[o] + f32(this.gR * smp));
          o++;
          pos += step;
          this.gL = fma(f32(this.tgtL - this.gL), G, this.gL);
          this.gR = fma(f32(this.tgtR - this.gR), G, this.gR);
        }
        pos -= this.cnt;
        this.pos = pos;
        buf[0] = buf[this.cnt];
      }
    }
    if ((this.silT > 0.025 && !this.quiet) || this.silT > 0.5) this.end();
  }
}

