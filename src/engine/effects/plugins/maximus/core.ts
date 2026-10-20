// Maximus DSP core, shared by Maximus and Soundgoodizer. Every stage below was
// measured on FL Studio 2026's own plugin through flfxhost (docs/research/fx/maximus.md):
//
//  input -> low cut (8th-order high-pass, -3 dB at 0.8 x the shown frequency)
//        -> band split (Linkwitz-Riley 12 dB = LR2, 24 dB = LR4, FL's exact topology and signs)
//        -> per band: stereo separation, pre gain, compressor, post gain, soft saturation
//        -> LMH mix with the (equally delayed) dry signal -> MASTER band -> output
//
// Compressor (per band): detector = max(|L|, |R|) -> sustain window (sliding peak
// or box RMS) -> REL: N-stage release in the level domain -> static curve on the
// level scale p = ln(1 + 2a) / ln 9 -> target gain -> ATT / REL 2: N-stage smoothing
// in the gain domain -> applied to the band delayed by the lookahead (LMH delay for
// LOW / MID / HIGH, the attack time for MASTER). Stage coefficients:
// c = 1 - exp(-K sqrt(N) / T), K = ln 316.2 (-50 dB) for the attack and
// ln 100 (-40 dB) for both releases. The 0.2 dB compressor safety scales a
// compressing band by 0.975.

import { curveAt, curveTable, LN9, type CurvePoint } from '../../../../model/fx/plugins/maximus/curve';
import { SAT_A, SAT_A_AMT, SAT_A_U } from './satA';

/** Compression table: output level for input levels 0..4 in steps of 1/8192 (as FL's). */
export const MX_TABLE_STEP = 8192;
export const MX_TABLE_N = 4 * MX_TABLE_STEP;
const SAFETY = 0.975;
const SILENCE = 1e-6;
const K_ATT = 2.5 * Math.LN10;
const K_REL = 2 * Math.LN10;
const SAT_LSTEP = Math.log(150 / 4) / 48;
export const MX_CHUNK = 64;
const MON_CHUNKS = 1024;
const MON_FIELDS = 17;
const SPEC_N = 4096;

// ------------------------------------------------------------------ config

export interface MxBandConfig {
  /** 0 on, 1 compression off, 2 muted, 3 off. */
  mode: number;
  pre: number;
  post: number;
  /** Side-signal gain (stereo separation). */
  side: number;
  /** Saturation: -1..1 (A < 0 < B); ceiling as a linear level. */
  satThres: number;
  satCeil: number;
  attMs: number;
  /** 0 = Default (same as the attack). */
  rel2Ms: number;
  attCurve: number;
  relMs: number;
  relCurve: number;
  susMs: number;
  rms: boolean;
  curve: CurvePoint[];
}

export interface MxConfig {
  f1: number;
  f2: number;
  slope1: number;
  slope2: number;
  lmhDelayMs: number;
  mix: number;
  /** Low cut frequency as shown (0 = off). */
  lowCutHz: number;
  bands: MxBandConfig[];
  solo: boolean;
  soloBand: number;
  midMode: boolean;
  safety: boolean;
  /** Monitor input for the bands display spectrum: 0 all, 1 mid, 2 side, 3 left, 4 right. */
  monInput: number;
  /** Oversampling (FL's option): 0 off, else 2x around LOW / MID / HIGH. */
  oversample: number;
  /** Linear-phase band split (FL's LIN / legacy FIR filters, +2 ms). */
  linear: boolean;
  /**
   * Allpass compensation of the low band for a 24 dB high crossover. On in
   * Maximus; Soundgoodizer's built-in engine omits it (measured).
   */
  lowComp?: boolean;
}

// ------------------------------------------------------------------ biquad (RBJ, bilinear with prewarping)

class BQ {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  // direct form I state (FL's structure: shows when coefficients switch): x1, x2, y1, y2 per channel
  lx1 = 0; lx2 = 0; ly1 = 0; ly2 = 0; rx1 = 0; rx2 = 0; ry1 = 0; ry2 = 0;

  set(kind: 'lp' | 'hp' | 'ap', f: number, q: number, sr: number): void {
    const w0 = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const c = Math.cos(w0), al = Math.sin(w0) / (2 * q), a0 = 1 + al;
    if (kind === 'lp') { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; }
    else if (kind === 'hp') { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; }
    else { this.b0 = (1 - al) / a0; this.b1 = -2 * c / a0; this.b2 = 1; }
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al) / a0;
  }

  l(x: number): number {
    const y = this.b0 * x + this.b1 * this.lx1 + this.b2 * this.lx2 - this.a1 * this.ly1 - this.a2 * this.ly2;
    this.lx2 = this.lx1; this.lx1 = x; this.ly2 = this.ly1; this.ly1 = y;
    return y;
  }

  r(x: number): number {
    const y = this.b0 * x + this.b1 * this.rx1 + this.b2 * this.rx2 - this.a1 * this.ry1 - this.a2 * this.ry2;
    this.rx2 = this.rx1; this.rx1 = x; this.ry2 = this.ry1; this.ry1 = y;
    return y;
  }

  flush(): void {
    // denormal / runaway guard (called once per block)
    if (!(Math.abs(this.ly1) < 1e10 && Math.abs(this.ly2) < 1e10 && Math.abs(this.lx1) < 1e10 && Math.abs(this.lx2) < 1e10)) this.lx1 = this.lx2 = this.ly1 = this.ly2 = 0;
    if (!(Math.abs(this.ry1) < 1e10 && Math.abs(this.ry2) < 1e10 && Math.abs(this.rx1) < 1e10 && Math.abs(this.rx2) < 1e10)) this.rx1 = this.rx2 = this.ry1 = this.ry2 = 0;
    if (Math.abs(this.ly1) + Math.abs(this.ly2) + Math.abs(this.lx1) + Math.abs(this.lx2) < 1e-25) this.lx1 = this.lx2 = this.ly1 = this.ly2 = 0;
    if (Math.abs(this.ry1) + Math.abs(this.ry2) + Math.abs(this.rx1) + Math.abs(this.rx2) < 1e-25) this.rx1 = this.rx2 = this.ry1 = this.ry2 = 0;
  }

  reset(): void { this.lx1 = this.lx2 = this.ly1 = this.ly2 = this.rx1 = this.rx2 = this.ry1 = this.ry2 = 0; }
}

const Q_BW2 = Math.SQRT1_2;
/**
 * Low cut: FL's 8th-order high-pass is close to Butterworth with -3 dB at 0.8 x the
 * shown frequency; these four sections (frequency factor, Q) are a fit to its measured
 * complex response (error -62 dB, plain Butterworth -42 dB); the shape scales with
 * the frequency.
 */
const LOW_CUT: [number, number][] = [[0.77317, 0.47248], [0.80842, 0.63391], [0.81347, 0.92018], [0.79798, 2.51405]];

/** One crossover filter: LR2 (one Q=0.5 biquad) or LR4 (two Butterworth biquads). */
class LR {
  a = new BQ();
  b = new BQ();
  four = false;
  set(kind: 'lp' | 'hp', f: number, four: boolean, sr: number): void {
    this.four = four;
    if (four) { this.a.set(kind, f, Q_BW2, sr); this.b.set(kind, f, Q_BW2, sr); }
    else this.a.set(kind, f, 0.5, sr);
  }
  l(x: number): number { const y = this.a.l(x); return this.four ? this.b.l(y) : y; }
  r(x: number): number { const y = this.a.r(x); return this.four ? this.b.r(y) : y; }
  flush(): void { this.a.flush(); this.b.flush(); }
  reset(): void { this.a.reset(); this.b.reset(); }
}

// ------------------------------------------------------------------ saturation

/** Type A base curve N(u) (normalised so N(4) = 1) for an amount 0..1. */
export function satABase(u: number, amount: number): number {
  if (u <= 0) return 0;
  const A = SAT_A_AMT, last = A.length - 1;
  if (amount <= A[0]) return satRow(0, u);
  if (amount >= A[last]) return satRow(last, u);
  let k = 1;
  while (k < last && A[k] < amount) k++;
  const w = (amount - A[k - 1]) / (A[k] - A[k - 1]);
  const a = satRow(k - 1, u), b = satRow(k, u);
  return a + (b - a) * w;
}

function satRow(k: number, u: number): number {
  const row = SAT_A[k];
  if (u < 4) {
    const f = u * 32, i = Math.floor(f), t = f - i;
    return row[i] + (row[i + 1] - row[i]) * t;
  }
  if (u < 150) {
    const f = 128 + Math.log(u / 4) / SAT_LSTEP;
    const i = Math.min(175, Math.floor(f)), t = f - i;
    return row[i] + (row[i + 1] - row[i]) * t;
  }
  if (k === SAT_A.length - 1) return Math.atan(u) / Math.atan(4);
  // tail ~ N(inf) - K/u, fitted to the last two samples
  const u0 = SAT_A_U[175], u1 = SAT_A_U[176];
  const K = (row[176] - row[175]) / (1 / u0 - 1 / u1);
  return row[176] + K * (1 / u1 - 1 / u);
}

/**
 * Saturation transfer for one sample, in the band's pre-post-gain domain with the
 * ceiling cp = ceiling / post gain (measured: FL applies the post gain after it).
 * B is analytic; A uses the measured tables, normalised at xc (the band's maximum
 * level: 4 for an uncompressed band, else the curve's maximum output, at least 1)
 * and clamped at max(xc, cp).
 */
function saturate(x: number, type: number, th: number, cp: number, aAmt: number, aNorm: number, clampAt: number): number {
  const ax = x < 0 ? -x : x;
  let y: number;
  if (type === 2) {
    const u = ax / cp;
    if (u <= th) y = ax;
    else { const w = 1 - th; y = cp * (th + w * (1 - Math.exp(-(u - th) / w))); }
  } else if (ax >= clampAt) y = cp;
  else y = cp * satABase(ax / cp, aAmt) * aNorm;
  return x < 0 ? -y : y;
}

// ------------------------------------------------------------------ band processor

class BandProc {
  // targets and ramped values
  mode = 0;
  pre = 1; post = 1; side = 1; ceil = 1;
  tPre = 1; tPost = 1; tSide = 1; tCeil = 1;
  satType = 0; satTh = 0; satAmt = 0; satNorm = 1;
  table = new Float32Array(MX_TABLE_N + 1);
  posTable = new Float32Array(4097);
  curveKey = '';
  attN = 2; relN = 3;
  attC = 1; rel2C = 1; relC = 1;
  /** Gain at level 0 (FL's initial smoother state). */
  g0 = 1;
  /** Maximum output level of the curve (without the safety factor). */
  curveMax = 1;
  susW = 0; rms = false;
  // state
  relSt = new Float64Array(8);
  gSt = new Float64Array(8).fill(1);
  dqV: Float32Array = new Float32Array(1);
  dqT: Int32Array = new Int32Array(1);
  dqHead = 0; dqLen = 0; t = 0;
  sq: Float32Array = new Float32Array(1);
  sqPos = 0; sqSum = 0; sqCount = 0;
  dL: Float32Array = new Float32Array(1);
  dR: Float32Array = new Float32Array(1);
  dPos = 0;
  delay = 0;
  // monitor accumulators (current chunk) and the chunks closed in this block
  mIn = 0; mOut = 0; mEnv = 0; mGain = 1;
  cv: Float32Array = new Float32Array(4 * 8);
  cn = 0;
  lastGain = 1;

  ensureDelay(n: number): void {
    if (this.dL.length < n + 1) {
      const sz = Math.max(n + 1, this.dL.length * 2);
      this.dL = new Float32Array(sz); this.dR = new Float32Array(sz); this.dPos = 0;
    }
  }

  ensureSustain(w: number): void {
    if (this.dqV.length < w + 1) {
      const sz = w + 1;
      this.dqV = new Float32Array(sz); this.dqT = new Int32Array(sz); this.dqHead = 0; this.dqLen = 0;
      this.sq = new Float32Array(sz); this.sqPos = 0; this.sqSum = 0; this.sqCount = 0;
    }
  }

  configure(c: MxBandConfig, sr: number, delay: number, safety: boolean): void {
    this.mode = c.mode;
    this.tPre = c.pre; this.tPost = c.post; this.tSide = c.side; this.tCeil = c.satCeil;
    const th = c.satThres;
    this.satType = th > 0 ? 2 : th < 0 ? 1 : 0;
    this.satTh = 1 - Math.abs(th);
    this.satAmt = Math.abs(th);
    this.attN = Math.max(1, Math.min(8, Math.round(c.attCurve)));
    this.relN = Math.max(1, Math.min(8, Math.round(c.relCurve)));
    // with a lookahead of D samples FL stretches the attack to at least D samples
    // and holds the detector level for at least D samples (measured)
    const sa = Math.max((c.attMs * sr) / 1000, delay), sr2 = (c.rel2Ms * sr) / 1000, srl = (c.relMs * sr) / 1000;
    this.attC = sa > 0 ? 1 - Math.exp((-K_ATT * Math.sqrt(this.attN)) / sa) : 1;
    this.rel2C = sr2 > 0 ? 1 - Math.exp((-K_REL * Math.sqrt(this.attN)) / sr2) : this.attC;
    this.relC = srl > 0 ? 1 - Math.exp((-K_REL * Math.sqrt(this.relN)) / srl) : 1;
    const w = Math.max(Math.round((c.susMs * sr) / 1000), delay);
    if (w !== this.susW || c.rms !== this.rms) { this.dqLen = 0; this.sqSum = 0; this.sqCount = 0; this.sqPos = 0; }
    this.susW = w;
    this.rms = c.rms;
    this.ensureSustain(w);
    const key = JSON.stringify(c.curve) + (safety ? 's' : '');
    if (key !== this.curveKey) {
      this.curveKey = key;
      // FL's table: output level (incl. safety) for input levels k / 8192, k = 0 .. 4 * 8192
      const s = safety ? SAFETY : 1;
      const t = this.table, pts = c.curve;
      let mx = 0;
      for (let k = 0; k <= MX_TABLE_N; k++) {
        const y = curveAt(pts, Math.min(1, Math.log(1 + (2 * k) / MX_TABLE_STEP) / LN9));
        if (y > mx) mx = y;
        t[k] = ((Math.exp(y * LN9) - 1) / 2) * s;
      }
      this.g0 = t[1] * MX_TABLE_STEP;
      // the curve's own maximum (also between table points)
      const fine = curveTable(pts, 4096, this.posTable);
      for (let k = 0; k <= 4096; k++) if (fine[k] > mx) mx = fine[k];
      this.curveMax = (Math.exp(mx * LN9) - 1) / 2;
    }
    this.ensureDelay(delay);
    this.delay = delay;
  }

  /** Static gain for a detector level (FL: table indexed by level, 1/8192 steps). */
  gainOf(lvl: number): number {
    if (lvl <= SILENCE) return 1;
    const f = lvl * MX_TABLE_STEP;
    if (f < 1) return this.g0;
    if (f >= MX_TABLE_N) return this.table[MX_TABLE_N] / lvl;
    const i = f | 0, t = f - i;
    return (this.table[i] + (this.table[i + 1] - this.table[i]) * t) / lvl;
  }

  /**
   * Detector chain for one sample: returns the smoothed gain. d is the peak
   * level max(|L|, |R|), d2 the mean square (L^2 + R^2) / 2 (RMS mode).
   */
  detect(d: number, d2: number): number {
    // sustain window
    const W = this.susW;
    if (this.rms && W === 0) d = Math.sqrt(d2);
    if (W > 0) {
      if (this.rms) {
        const s2 = d2;
        this.sqSum += s2 - this.sq[this.sqPos];
        this.sq[this.sqPos] = s2;
        if (++this.sqPos >= W) this.sqPos = 0;
        if (this.sqSum < 0) this.sqSum = 0;
        d = Math.sqrt(this.sqSum / W);
      } else {
        // sliding maximum (monotonic deque in a ring)
        const cap = this.dqV.length, t = this.t++;
        while (this.dqLen > 0 && this.dqV[(this.dqHead + this.dqLen - 1) % cap] <= d) this.dqLen--;
        const at = (this.dqHead + this.dqLen) % cap;
        this.dqV[at] = d; this.dqT[at] = t; this.dqLen++;
        while (t - this.dqT[this.dqHead] >= W) { this.dqHead = (this.dqHead + 1) % cap; this.dqLen--; }
        d = this.dqV[this.dqHead];
        if (this.t > 0x3fffffff) this.rebaseDeque();
      }
    }
    // REL: release stages in the level domain (instant rise)
    const rs = this.relSt, cr = this.relC;
    for (let k = 0, N = this.relN; k < N; k++) {
      const s = rs[k];
      const v = d > s ? d : s + cr * (d - s);
      rs[k] = v; d = v;
    }
    if (d > this.mEnv) this.mEnv = d;
    // silence: FL passes the sample unchanged and leaves the gain smoother alone
    if (d <= SILENCE) return 1;
    // static curve -> target gain, then ATT / REL 2 in the gain domain
    let g = this.gainOf(d);
    const gs = this.gSt, ca = this.attC, c2 = this.rel2C;
    for (let k = 0, N = this.attN; k < N; k++) {
      const s = gs[k];
      const v = g < s ? s + ca * (g - s) : s + c2 * (g - s);
      gs[k] = v; g = v;
    }
    return g;
  }

  rebaseDeque(): void {
    const cap = this.dqV.length, base = this.t;
    for (let k = 0; k < this.dqLen; k++) { const i = (this.dqHead + k) % cap; this.dqT[i] -= base; }
    this.t = 0;
  }

  flushState(): void {
    for (let k = 0; k < 8; k++) {
      if (!(this.relSt[k] < 1e10) || this.relSt[k] < 1e-20) this.relSt[k] = 0;
      if (!(this.gSt[k] < 1e10) || !(this.gSt[k] >= 0)) this.gSt[k] = 1;
    }
    if (!(this.sqSum < 1e20)) { this.sqSum = 0; this.sq.fill(0); }
  }

  reset(): void {
    this.relSt.fill(0); this.gSt.fill(this.mode === 0 ? this.g0 : 1);
    this.dqLen = 0; this.dqHead = 0; this.t = 0;
    this.sq.fill(0); this.sqSum = 0; this.sqPos = 0;
    this.dL.fill(0); this.dR.fill(0); this.dPos = 0;
    this.pre = this.tPre; this.post = this.tPost; this.side = this.tSide; this.ceil = this.tCeil;
    this.lastGain = this.mode === 0 ? this.g0 : 1;
  }

  /**
   * Process n samples in place (aL / aR: band audio). detL / detR, when given,
   * feed the detector instead of the audio (Master mid mode).
   */
  ensureChunks(n: number, chunk: number): void {
    const need = 4 * (Math.ceil(n / chunk) + 2);
    if (this.cv.length < need) this.cv = new Float32Array(need);
  }

  /** Close the current monitor chunk. */
  close(): void {
    const o = this.cn * 4;
    const on = this.mode === 0;
    this.cv[o] = this.mIn; this.cv[o + 1] = this.mOut;
    this.cv[o + 2] = on ? this.mEnv : this.mIn; this.cv[o + 3] = on ? this.mGain : 1;
    this.cn++;
    this.mIn = 0; this.mOut = 0; this.mEnv = 0; this.mGain = 1;
  }

  /**
   * Process n samples in place (aL / aR: band audio). detL / detR, when given,
   * feed the detector instead of the audio (Master mid mode). mix0..mix1 is the
   * LMH mix ramp: FL mixes each band with its own dry signal (delayed like the
   * band), so a muted band contributes nothing at all.
   */
  run(aL: Float32Array, aR: Float32Array, n: number, detL: Float32Array | null, detR: Float32Array | null, monOff: number, chunk: number, mix0 = 1, mix1 = 1): void {
    this.cn = 0;
    const on = this.mode === 0, muted = this.mode === 2;
    // FL steps the band pre / post gains and the ceiling at the block start (post: measured exact);
    // the LMH mix ramps across the block (measured exact). Stereo separation: FL glides it over
    // ~400 samples (two linear segments, not reproduced); we ramp it across the block.
    const dPre = 0, dPost = 0, dSide = (this.tSide - this.side) / n, dCeil = 0, dMix = (mix1 - mix0) / n;
    let pre = this.tPre, post = this.tPost, side = this.side, ceil = this.tCeil, mix = mix0;
    const D = this.delay, dl = this.dL, dr = this.dR, cap = dl.length;
    let pos = this.dPos;
    const satType = this.satType, th = this.satTh, amt = this.satAmt;
    // type A normalisation point (the band's maximum level) at the block's mean ceiling
    const xc = on ? Math.max(1, this.curveMax) : 4;
    let clampAt = xc;
    if (satType === 1) {
      const cpm = Math.max(1e-9, (ceil + dCeil * (n / 2)) / Math.max(1e-9, post + dPost * (n / 2)));
      clampAt = Math.max(xc, cpm);
      this.satNorm = 1 / satABase(clampAt / cpm, amt);
    }
    const norm = this.satNorm;
    let g = this.lastGain;
    for (let i = 0; i < n; i++) {
      pre += dPre; post += dPost; side += dSide; ceil += dCeil; mix += dMix;
      const rawL = aL[i], rawR = aR[i];
      // detector: the current (undelayed) band, stereo separation and pre gain applied
      let a = detL ? detL[i] : rawL, b = detR ? detR[i] : rawR;
      if (side !== 1) { const m = (a + b) * 0.5, sd = (a - b) * 0.5 * side; a = m + sd; b = m - sd; }
      if (on) {
        a *= pre; b *= pre;
        const d = Math.max(a < 0 ? -a : a, b < 0 ? -b : b);
        if (d > this.mIn) this.mIn = d;
        g = this.detect(d, (a * a + b * b) * 0.5);
        if (g < this.mGain) this.mGain = g;
      } else {
        const d = Math.max(a < 0 ? -a : a, b < 0 ? -b : b);
        if (d > this.mIn) this.mIn = d;
        g = 1;
      }
      // lookahead: the raw band is delayed, the gain applies to the delayed band
      let l = rawL, r = rawR;
      if (D > 0) {
        dl[pos] = rawL; dr[pos] = rawR;
        let rp = pos - D; if (rp < 0) rp += cap;
        l = dl[rp]; r = dr[rp];
        if (++pos >= cap) pos = 0;
      }
      if (muted) { l = 0; r = 0; }
      else {
        if (side !== 1) { const m = (l + r) * 0.5, sd = (l - r) * 0.5 * side; l = m + sd; r = m - sd; }
        // the dry signal of the LMH mix includes the band's stereo separation (measured)
        const dryL = l, dryR = r;
        const k = on ? g * pre : 1;
        l *= k; r *= k;
        if (satType !== 0) {
          if (ceil > 1e-9 && post > 1e-9) {
            const cp = ceil / post;
            l = post * saturate(l, satType, th, cp, amt, norm, clampAt);
            r = post * saturate(r, satType, th, cp, amt, norm, clampAt);
          } else { l = 0; r = 0; }
        } else { l *= post; r *= post; }
        if (mix < 1) { l = dryL + (l - dryL) * mix; r = dryR + (r - dryR) * mix; }
      }
      aL[i] = l; aR[i] = r;
      const o = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (o > this.mOut) this.mOut = o;
      if (((i + monOff + 1) & (chunk - 1)) === 0) this.close();
    }
    this.dPos = pos;
    this.pre = this.tPre; this.post = this.tPost; this.side = this.tSide; this.ceil = this.tCeil;
    this.lastGain = g;
    this.flushState();
  }

  /** MASTER in mode OFF: FL still applies its post gain (only). */
  postOnly(aL: Float32Array, aR: Float32Array, n: number): void {
    const post = this.tPost; // stepped at the block start (FL)
    for (let i = 0; i < n; i++) { aL[i] *= post; aR[i] *= post; }
    this.post = this.tPost; this.pre = this.tPre; this.side = this.tSide; this.ceil = this.tCeil;
  }

  /** A band that does not run this block (OFF, or LOW / HIGH in mid mode). */
  idle(n: number, monOff: number, chunk: number, aL?: Float32Array, aR?: Float32Array): void {
    this.cn = 0;
    for (let i = 0; i < n; i++) {
      if (aL && aR) {
        const l = aL[i], r = aR[i];
        const o = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
        if (o > this.mIn) this.mIn = o;
        if (o > this.mOut) this.mOut = o;
      }
      if (((i + monOff + 1) & (chunk - 1)) === 0) this.close();
    }
  }
}

// ------------------------------------------------------------------ 2x polyphase IIR halfband (HIIR design)

/** Elliptic polyphase halfband coefficients (Valenzuela-Constantinides, as in HIIR). */
function halfbandCoefs(n: number, transition: number): Float64Array {
  const k0 = Math.pow(Math.tan(((1 - transition * 2) * Math.PI) / 4), 2);
  const kk = Math.pow(1 - k0 * k0, 0.25);
  const e = (0.5 * (1 - kk)) / (1 + kk);
  const e2 = e * e, e4 = e2 * e2;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  const order = n * 2 + 1;
  const out = new Float64Array(n);
  for (let idx = 0; idx < n; idx++) {
    const c = idx + 1;
    let num = 0, den = 0;
    for (let i = 0, j = 1; i < 64; i++, j = -j) {
      const t = Math.pow(q, i * (i + 1)) * Math.sin(((i * 2 + 1) * c * Math.PI) / order) * j;
      num += t;
      if (Math.abs(t) < 1e-100) break;
    }
    for (let i = 1, j = -1; i < 64; i++, j = -j) {
      const t = Math.pow(q, i * i) * Math.cos((i * 2 * c * Math.PI) / order) * j;
      den += t;
      if (Math.abs(t) < 1e-100) break;
    }
    num *= Math.pow(q, 0.25);
    den += 0.5;
    const ww = num / den, wwsq = ww * ww;
    const x = Math.sqrt((1 - wwsq * k0) * (1 - wwsq / k0)) / (1 + wwsq);
    out[idx] = (1 - x) / (1 + x);
  }
  return out;
}

// FL uses HIIR with 6 coefficients and a 0.1 transition band (its os IR matches exactly)
const HB_COEFS = halfbandCoefs(6, 0.1);

/** One polyphase allpass pair (two paths of first-order allpass stages at the low rate). */
class HalfbandState {
  x = new Float64Array(HB_COEFS.length);
  y = new Float64Array(HB_COEFS.length);
  /** Runs both paths; returns them in out[0] / out[1]. */
  run(s0: number, s1: number, out: Float64Array): void {
    const c = HB_COEFS, x = this.x, y = this.y;
    for (let k = 0; k < c.length; k += 2) {
      const t0 = (s0 - y[k]) * c[k] + x[k];
      const t1 = (s1 - y[k + 1]) * c[k + 1] + x[k + 1];
      x[k] = s0; x[k + 1] = s1; y[k] = t0; y[k + 1] = t1;
      s0 = t0; s1 = t1;
    }
    out[0] = s0; out[1] = s1;
  }
  flush(): void {
    for (let k = 0; k < this.x.length; k++) {
      if (!(Math.abs(this.x[k]) < 1e10) || Math.abs(this.x[k]) < 1e-25) this.x[k] = 0;
      if (!(Math.abs(this.y[k]) < 1e10) || Math.abs(this.y[k]) < 1e-25) this.y[k] = 0;
    }
  }
  reset(): void { this.x.fill(0); this.y.fill(0); }
}

/** Stereo 2x up / down sampler. */
class Resampler2x {
  private upL = new HalfbandState(); private upR = new HalfbandState();
  private dnL = new HalfbandState(); private dnR = new HalfbandState();
  private t = new Float64Array(2);
  /** Group delay at low frequencies of up + down, in base-rate samples. */
  readonly delay: number;
  constructor() {
    // measure the cascade's low-frequency group delay once
    const n = 512, iL = new Float32Array(n), o2 = new Float32Array(2 * n), o = new Float32Array(n);
    iL[0] = 1;
    this.up(iL, iL, o2, o2, n);
    this.down(o2, o2, o, o, n);
    let num = 0, den = 0;
    for (let k = 0; k < n; k++) { num += k * o[k]; den += o[k]; }
    this.delay = den !== 0 ? num / den : 0;
    this.reset();
  }
  up(L: Float32Array, R: Float32Array, oL: Float32Array, oR: Float32Array, n: number): void {
    const t = this.t;
    for (let i = 0; i < n; i++) {
      this.upL.run(L[i], L[i], t); oL[2 * i] = t[0]; oL[2 * i + 1] = t[1];
      this.upR.run(R[i], R[i], t); oR[2 * i] = t[0]; oR[2 * i + 1] = t[1];
    }
    this.upL.flush(); this.upR.flush();
  }
  down(L: Float32Array, R: Float32Array, oL: Float32Array, oR: Float32Array, n: number): void {
    const t = this.t;
    for (let i = 0; i < n; i++) {
      this.dnL.run(L[2 * i + 1], L[2 * i], t); oL[i] = 0.5 * (t[0] + t[1]);
      this.dnR.run(R[2 * i + 1], R[2 * i], t); oR[i] = 0.5 * (t[0] + t[1]);
    }
    this.dnL.flush(); this.dnR.flush();
  }
  reset(): void { this.upL.reset(); this.upR.reset(); this.dnL.reset(); this.dnR.reset(); }
}

// ------------------------------------------------------------------ linear-phase band split (FL's legacy FIR mode)

/**
 * FL's linear-phase split: 2 ms half-length FIRs (177 taps at 44.1 kHz). The low
 * pass is a sinc windowed by a bell whose width scales with 1 / cutoff and is
 * not normalised (as measured: FL's legacy low band is -7 dB at DC for 200 Hz);
 * low = LP(f1), mid = LP(f2) - LP(f1), high = delayed input - LP(f2).
 */
class FirSplit {
  readonly half: number;
  readonly len: number;
  private k1: Float32Array; private k2: Float32Array;
  private hL: Float32Array; private hR: Float32Array;
  private pos = 0;
  private f1 = -1; private f2 = -1;
  constructor(readonly sr: number) {
    this.half = Math.round(0.002 * sr);
    this.len = 2 * this.half + 1;
    this.k1 = new Float32Array(this.len); this.k2 = new Float32Array(this.len);
    // history doubled so a kernel always reads one contiguous window
    this.hL = new Float32Array(2 * this.len); this.hR = new Float32Array(2 * this.len);
  }
  private s1 = -1; private s2 = -1;
  /** Window fitted to FL's kernels: exp(-|k fc / (C sr)|^p), 12 dB: C 0.1205 p 2, 24 dB: C 0.252 p 1.5. */
  private kernel(out: Float32Array, fc: number, slope24: boolean): void {
    const sr = this.sr, h = this.half;
    const C = slope24 ? 0.252 : 0.1205, p = slope24 ? 1.5 : 2;
    for (let i = 0; i < this.len; i++) {
      const k = i - h;
      const sinc = k === 0 ? (2 * fc) / sr : Math.sin((2 * Math.PI * fc * k) / sr) / (Math.PI * k);
      const u = Math.abs((k * fc) / (C * sr));
      out[i] = sinc * Math.exp(-Math.pow(u, p));
    }
  }
  set(f1: number, f2: number, s1: number, s2: number): void {
    if (f1 !== this.f1 || s1 !== this.s1) { this.f1 = f1; this.s1 = s1; this.kernel(this.k1, f1, s1 === 1); }
    if (f2 !== this.f2 || s2 !== this.s2) { this.f2 = f2; this.s2 = s2; this.kernel(this.k2, f2, s2 === 1); }
  }
  /** Push one stereo sample; returns [lp1L, lp1R, lp2L, lp2R, delayedL, delayedR] in out. */
  push(l: number, r: number, out: Float64Array): void {
    const n = this.len, hL = this.hL, hR = this.hR;
    hL[this.pos] = l; hL[this.pos + n] = l; hR[this.pos] = r; hR[this.pos + n] = r;
    this.pos = (this.pos + 1) % n;
    const o = this.pos; // oldest sample
    const k1 = this.k1, k2 = this.k2;
    let a = 0, b = 0, c = 0, d = 0;
    for (let i = 0; i < n; i++) {
      const xl = hL[o + i], xr = hR[o + i];
      const w1 = k1[n - 1 - i], w2 = k2[n - 1 - i];
      a += w1 * xl; b += w1 * xr; c += w2 * xl; d += w2 * xr;
    }
    out[0] = a; out[1] = b; out[2] = c; out[3] = d;
    out[4] = hL[o + this.half]; out[5] = hR[o + this.half];
  }
  reset(): void { this.hL.fill(0); this.hR.fill(0); this.pos = 0; }
}

// ------------------------------------------------------------------ LOW / MID / HIGH section

/** Band split and the three band processors, at the base rate or oversampled. */
class LmhSection {
  readonly sr: number;
  readonly chunk: number;
  readonly bands = [new BandProc(), new BandProc(), new BandProc()];
  delay = 0;
  private lp1 = new LR(); private hp1 = new LR(); private lp2 = new LR(); private hp2 = new LR();
  private comp = new BQ();
  private f1 = 200; private f2 = 3000; private tf1 = 200; private tf2 = 3000;
  private slope1 = 1; private slope2 = 1;
  private mix = 1; private tMix = 1;
  private configured = false;
  private midMode = false; private solo = -1;
  private bL: Float32Array[] = []; private bR: Float32Array[] = [];
  private fir: FirSplit | null = null;
  private linear = false;
  private lowComp = true;
  private fo = new Float64Array(6);
  /** Extra delay of the linear-phase split (samples). */
  splitDelay = 0;

  constructor(sr: number, maxBlock: number, chunk: number, readonly mult = 1) {
    this.sr = sr;
    this.chunk = chunk;
    this.grow(maxBlock);
  }

  grow(n: number): void {
    if (!this.bL.length || this.bL[0].length < n) {
      this.bL = [0, 1, 2].map(() => new Float32Array(n));
      this.bR = [0, 1, 2].map(() => new Float32Array(n));
    }
    for (const b of this.bands) b.ensureChunks(n, this.chunk);
  }

  private setCrossover(force: boolean): void {
    const sr = this.sr;
    this.lp1.set('lp', this.f1, this.slope1 === 1, sr);
    this.hp1.set('hp', this.f1, this.slope1 === 1, sr);
    this.lp2.set('lp', this.f2, this.slope2 === 1, sr);
    this.hp2.set('hp', this.f2, this.slope2 === 1, sr);
    this.comp.set('ap', this.f2, 0.5, sr);
    if (force) { this.lp1.reset(); this.hp1.reset(); this.lp2.reset(); this.hp2.reset(); this.comp.reset(); }
  }

  configure(c: MxConfig): void {
    const sr = this.sr;
    this.tf1 = Math.max(10, Math.min(sr * 0.45, c.f1));
    this.tf2 = Math.max(10, Math.min(sr * 0.45, c.f2));
    const slopes = c.slope1 !== this.slope1 || c.slope2 !== this.slope2;
    this.slope1 = c.slope1; this.slope2 = c.slope2;
    if (!this.configured) { this.f1 = this.tf1; this.f2 = this.tf2; }
    if (slopes || !this.configured) this.setCrossover(true);
    this.tMix = Math.max(0, Math.min(1, c.mix));
    if (!this.configured) this.mix = this.tMix;
    this.midMode = c.midMode;
    this.solo = c.solo && c.soloBand < 3 ? c.soloBand : -1;
    this.lowComp = c.lowComp !== false;
    if (c.linear && !this.fir) this.fir = new FirSplit(sr);
    if (c.linear !== this.linear) this.fir?.reset();
    this.linear = c.linear;
    this.splitDelay = c.linear && this.fir ? this.fir.half : 0;
    // the LMH delay applies while an LMH band compresses
    const lmhOn = (c.midMode ? [c.bands[1]] : c.bands.slice(0, 3)).some((b) => b.mode === 0);
    // oversampled: the base-rate delay, doubled
    this.delay = lmhOn ? this.mult * Math.round((c.lmhDelayMs * sr) / this.mult / 1000) : 0;
    for (let k = 0; k < 3; k++) this.bands[k].configure(c.bands[k], sr, this.delay, c.safety);
    if (!this.configured) for (const b of this.bands) b.reset();
    this.configured = true;
  }

  /** Linear-phase split (FL's FIR mode), same topology rules as the IIR split. */
  private splitFir(xL: Float32Array, xR: Float32Array, n: number, lowOff: boolean, highOff: boolean): void {
    const f = this.fir!, o = this.fo, bL = this.bL, bR = this.bR;
    f.set(this.f1, this.f2, this.slope1, this.slope2);
    for (let i = 0; i < n; i++) {
      f.push(xL[i], xR[i], o);
      const l1 = o[0], r1 = o[1], l2 = o[2], r2 = o[3], dl = o[4], dr = o[5];
      if (this.midMode) { bL[0][i] = highOff ? (lowOff ? dl : dl - l1) : (lowOff ? l2 : l2 - l1); bR[0][i] = highOff ? (lowOff ? dr : dr - r1) : (lowOff ? r2 : r2 - r1); bL[1][i] = dl; bR[1][i] = dr; continue; }
      bL[0][i] = lowOff ? 0 : l1; bR[0][i] = lowOff ? 0 : r1;
      const ml = highOff ? dl : l2, mr = highOff ? dr : r2;
      bL[1][i] = lowOff ? ml : ml - l1; bR[1][i] = lowOff ? mr : mr - r1;
      bL[2][i] = highOff ? 0 : dl - l2; bR[2][i] = highOff ? 0 : dr - r2;
    }
  }

  reset(): void {
    this.lp1.reset(); this.hp1.reset(); this.lp2.reset(); this.hp2.reset(); this.comp.reset();
    for (const b of this.bands) b.reset();
    this.f1 = this.tf1; this.f2 = this.tf2; this.setCrossover(true);
    this.mix = this.tMix;
  }

  /** x (n samples at this section's rate) -> LMH sum in out. */
  process(xL: Float32Array, xR: Float32Array, n: number, outL: Float32Array, outR: Float32Array, monOff: number): void {
    if (this.f1 !== this.tf1 || this.f2 !== this.tf2) {
      // FL switches the crossover coefficients at the next block (filter states kept)
      this.f1 = this.tf1; this.f2 = this.tf2;
      this.setCrossover(false);
    }
    const [lowB, midB, highB] = this.bands;
    const bL = this.bL, bR = this.bR;
    const lowOff = lowB.mode === 3, midOff = midB.mode === 3, highOff = highB.mode === 3;
    const s1 = this.slope1 === 1 ? 1 : -1, s2 = this.slope2 === 1 ? 1 : -1;
    const compOn = this.slope2 === 1 && !highOff && this.lowComp;
    const lp1 = this.lp1, hp1 = this.hp1, lp2 = this.lp2, hp2 = this.hp2, cp = this.comp;
    const chunk = this.chunk, m0 = this.mix, m1 = this.tMix;
    if (this.midMode) {
      // MID drives the whole signal: its detector hears the mid band, its gain,
      // post gain and saturation apply to the full-band signal
      const dl = bL[0], dr = bR[0];
      if (this.linear && this.fir) this.splitFir(xL, xR, n, lowOff, highOff);
      else {
        for (let i = 0; i < n; i++) {
          let l = xL[i], r = xR[i];
          if (!lowOff) { l = hp1.l(l); r = hp1.r(r); }
          if (!highOff) { l = lp2.l(l); r = lp2.r(r); }
          dl[i] = l; dr[i] = r;
          bL[1][i] = xL[i]; bR[1][i] = xR[i];
        }
        hp1.flush(); lp2.flush();
      }
      if (midOff) { bL[1].fill(0, 0, n); bR[1].fill(0, 0, n); midB.idle(n, monOff, chunk); }
      else midB.run(bL[1], bR[1], n, dl, dr, monOff, chunk, m0, m1);
      lowB.idle(n, monOff, chunk); highB.idle(n, monOff, chunk);
      for (let i = 0; i < n; i++) { outL[i] = bL[1][i]; outR[i] = bR[1][i]; }
    } else {
      // band split (FL's topology: an OFF band's range goes to MID). FL quirk: with LOW and
      // MID both OFF the HIGH band's output reaches MASTER twice (measured)
      const highTwice = lowOff && midOff;
      if (this.linear && this.fir) this.splitFir(xL, xR, n, lowOff, highOff);
      else for (let i = 0; i < n; i++) {
        const xl = xL[i], xr = xR[i];
        let rl = xl, rr = xr;
        if (!lowOff) {
          let ll = lp1.l(xl), lr = lp1.r(xr);
          if (compOn) { ll = cp.l(ll); lr = cp.r(lr); }
          bL[0][i] = s1 * ll; bR[0][i] = s1 * lr;
          rl = hp1.l(xl); rr = hp1.r(xr);
        } else { bL[0][i] = 0; bR[0][i] = 0; }
        if (!highOff) {
          bL[1][i] = lp2.l(rl); bR[1][i] = lp2.r(rr);
          bL[2][i] = s2 * hp2.l(rl); bR[2][i] = s2 * hp2.r(rr);
        } else { bL[1][i] = rl; bR[1][i] = rr; bL[2][i] = 0; bR[2][i] = 0; }
      }
      if (!this.linear) { lp1.flush(); hp1.flush(); lp2.flush(); hp2.flush(); cp.flush(); }
      outL.fill(0, 0, n); outR.fill(0, 0, n);
      for (let k = 0; k < 3; k++) {
        const b = this.bands[k];
        if (b.mode === 3) { b.idle(n, monOff, chunk); continue; }
        b.run(bL[k], bR[k], n, null, null, monOff, chunk, m0, m1);
        if (this.solo >= 0 && this.solo !== k) continue;
        const al = bL[k], ar = bR[k];
        for (let i = 0; i < n; i++) { outL[i] += al[i]; outR[i] += ar[i]; }
      }
      if (highTwice && !highOff && (this.solo < 0 || this.solo === 2)) {
        // FL quirk: the HIGH band's output is summed a second time
        const al = bL[2], ar = bR[2];
        for (let i = 0; i < n; i++) { outL[i] += al[i]; outR[i] += ar[i]; }
      }
    }
    this.mix = this.tMix;
  }
}

// ------------------------------------------------------------------ core

export class MaximusCore {
  readonly sr: number;
  readonly maxBlock: number;
  latency = 0;

  private lc = LOW_CUT.map(() => new BQ());
  private lowCutOn = false;
  private lcHz = 0;
  private lmh: LmhSection;
  private lmhOs: LmhSection | null = null;
  private rs: Resampler2x | null = null;
  private os = false;
  private master = new BandProc();
  private cfg: MxConfig | null = null;
  // scratch
  private xL: Float32Array; private xR: Float32Array;
  private mL: Float32Array; private mR: Float32Array;
  private uL: Float32Array; private uR: Float32Array;
  private vL: Float32Array; private vR: Float32Array;
  // monitor
  private mon = new Float32Array(MON_CHUNKS * MON_FIELDS);
  private monW = 0; private monR = 0; private monPos = 0;
  private mainPeak = 0;
  private mainCv: Float32Array = new Float32Array(8);
  private spec = new Float32Array(SPEC_N);
  private specPos = 0;

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    this.maxBlock = Math.max(1, blockSize);
    this.lmh = new LmhSection(sampleRate, this.maxBlock, MX_CHUNK);
    this.xL = this.xR = this.mL = this.mR = this.uL = this.uR = this.vL = this.vR = new Float32Array(0);
    this.grow(this.maxBlock);
  }

  /** Scratch for the block size (and larger blocks, should one arrive). */
  private grow(n: number): void {
    if (this.xL.length < n) {
      const mk = (k = 1) => new Float32Array(n * k);
      this.xL = mk(); this.xR = mk(); this.mL = mk(); this.mR = mk();
      this.uL = mk(2); this.uR = mk(2); this.vL = mk(2); this.vR = mk(2);
    }
    const need = Math.ceil(n / MX_CHUNK) + 2;
    if (this.mainCv.length < need) this.mainCv = new Float32Array(need);
    this.master.ensureChunks(n, MX_CHUNK);
    this.lmh.grow(n);
    this.lmhOs?.grow(2 * n);
  }

  configure(c: MxConfig): void {
    const sr = this.sr;
    const first = !this.cfg;
    this.cfg = c;
    // low cut: 8th-order high-pass, -3 dB at 0.8 x the shown frequency
    this.lowCutOn = c.lowCutHz > 0;
    if (this.lowCutOn && c.lowCutHz !== this.lcHz) {
      this.lcHz = c.lowCutHz;
      LOW_CUT.forEach(([f, q], k) => this.lc[k].set('hp', f * c.lowCutHz, q, sr));
    }
    // oversampling (allocated on first use, outside the audio callback's hot path)
    const os = c.oversample > 0;
    if (os && !this.lmhOs) {
      this.lmhOs = new LmhSection(2 * sr, 2 * this.xL.length, 2 * MX_CHUNK, 2);
      this.rs = new Resampler2x();
    }
    if (os !== this.os) { this.lmhOs?.reset(); this.rs?.reset(); this.lmh.reset(); }
    this.os = os;
    this.lmh.configure(c);
    this.lmhOs?.configure(c);
    const m = c.bands[3];
    const masterD = m.mode === 0 ? Math.round((m.attMs * sr) / 1000) : 0;
    this.master.configure(m, sr, masterD, c.safety);
    if (first) this.master.reset();
    // oversampled: FL reports the base-rate LMH delay only (its resampler pair is not
    // reported; measured on the Pow preset for lmhDelay 0..4000 and LMH bands on / off)
    const lmhLat = os && this.lmhOs ? Math.round((this.lmhOs.delay + this.lmhOs.splitDelay) / 2) : this.lmh.delay + this.lmh.splitDelay;
    this.latency = lmhLat + masterD;
  }

  reset(): void {
    for (const q of this.lc) q.reset();
    this.lmh.reset();
    this.lmhOs?.reset(); this.rs?.reset();
    this.master.reset();
    this.monW = this.monR = this.monPos = 0;
    this.mainPeak = 0;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (n > this.xL.length) this.grow(n);
    const c = this.cfg;
    if (!c) return;
    const xL = this.xL, xR = this.xR;
    // input peak (main input) per monitor chunk and the bands-display spectrum feed
    let mp = this.mainPeak;
    const spec = this.spec, mi = c.monInput;
    let sp = this.specPos, mc = 0;
    const monOff = this.monPos;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (a > mp) mp = a;
      if (((i + monOff + 1) & (MX_CHUNK - 1)) === 0) { this.mainCv[mc++] = mp; mp = 0; }
      spec[sp] = mi === 2 ? (l - r) * 0.5 : mi === 3 ? l : mi === 4 ? r : (l + r) * 0.5;
      if (++sp >= SPEC_N) sp = 0;
    }
    this.specPos = sp;
    this.mainPeak = mp;
    const chunks = mc;
    // low cut (base rate)
    if (this.lowCutOn) {
      const q0 = this.lc[0], q1 = this.lc[1], q2 = this.lc[2], q3 = this.lc[3];
      for (let i = 0; i < n; i++) {
        xL[i] = q3.l(q2.l(q1.l(q0.l(L[i]))));
        xR[i] = q3.r(q2.r(q1.r(q0.r(R[i]))));
      }
      for (const q of this.lc) q.flush();
    } else { xL.set(L.subarray(0, n)); xR.set(R.subarray(0, n)); }
    // LOW / MID / HIGH, oversampled when the option is on
    const mL = this.mL, mR = this.mR;
    const sec = this.os && this.lmhOs && this.rs ? this.lmhOs : this.lmh;
    if (sec === this.lmhOs && this.rs) {
      this.rs.up(xL, xR, this.uL, this.uR, n);
      sec.process(this.uL, this.uR, 2 * n, this.vL, this.vR, 2 * monOff);
      this.rs.down(this.vL, this.vR, mL, mR, n);
    } else sec.process(xL, xR, n, mL, mR, monOff);
    // MASTER (base rate)
    const masterB = this.master;
    if (masterB.mode === 3) { masterB.postOnly(mL, mR, n); masterB.idle(n, monOff, MX_CHUNK, mL, mR); }
    else masterB.run(mL, mR, n, null, null, monOff, MX_CHUNK);
    for (let i = 0; i < n; i++) {
      const l = mL[i], r = mR[i];
      L[i] = l === l && l < 1e6 && l > -1e6 ? l : 0;
      R[i] = r === r && r < 1e6 && r > -1e6 ? r : 0;
    }
    this.monPos = (monOff + n) & (MX_CHUNK - 1);
    // monitor records: main input, then in / out / envelope / gain per band
    const all = [sec.bands[0], sec.bands[1], sec.bands[2], masterB];
    for (let k = 0; k < chunks; k++) {
      const base = this.monW * MON_FIELDS;
      this.mon[base] = this.mainCv[k];
      for (let b = 0; b < 4; b++) {
        const cv = all[b].cv, o = k * 4, d = base + 1 + b * 4;
        if (k < all[b].cn) { this.mon[d] = cv[o]; this.mon[d + 1] = cv[o + 1]; this.mon[d + 2] = cv[o + 2]; this.mon[d + 3] = cv[o + 3]; }
        else { this.mon[d] = 0; this.mon[d + 1] = 0; this.mon[d + 2] = 0; this.mon[d + 3] = 1; }
      }
      this.monW = (this.monW + 1) % MON_CHUNKS;
      if (this.monW === this.monR) this.monR = (this.monR + 1) % MON_CHUNKS;
    }
  }

  /** New monitor chunks since the last call: MON_FIELDS floats each (main, then per band in/out/env/gain). */
  takeChunks(): Float32Array {
    const cnt = (this.monW - this.monR + MON_CHUNKS) % MON_CHUNKS;
    const out = new Float32Array(cnt * MON_FIELDS);
    for (let k = 0; k < cnt; k++) {
      const src = ((this.monR + k) % MON_CHUNKS) * MON_FIELDS;
      out.set(this.mon.subarray(src, src + MON_FIELDS), k * MON_FIELDS);
    }
    this.monR = this.monW;
    return out;
  }

  /** Current smoothed gain per band (compression indicators). */
  gains(): number[] {
    const sec = this.os && this.lmhOs ? this.lmhOs : this.lmh;
    return [...sec.bands, this.master].map((b) => (b.mode === 0 ? b.lastGain : 1));
  }

  /** Magnitude spectrum (dB, 0 dB = full-scale sine) of the monitored input, log-spaced 20 Hz..20 kHz. */
  spectrum(bins: number): Float32Array {
    const N = SPEC_N;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = this.spec[(this.specPos + i) % N] * w;
    }
    fft(re, im);
    const out = new Float32Array(bins);
    const norm = 4 / N;
    for (let k = 0; k < bins; k++) {
      const fa = 20 * Math.pow(1000, k / bins), fb = 20 * Math.pow(1000, (k + 1) / bins);
      const ia = Math.max(1, Math.floor((fa * N) / this.sr)), ib = Math.max(ia, Math.min(N / 2 - 1, Math.floor((fb * N) / this.sr)));
      let m = 0;
      for (let i = ia; i <= ib; i++) { const v = re[i] * re[i] + im[i] * im[i]; if (v > m) m = v; }
      out[k] = 10 * Math.log10(m * norm * norm + 1e-20);
    }
    return out;
  }
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
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
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
