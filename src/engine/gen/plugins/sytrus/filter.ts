// Sytrus filter units (3 per voice), ported from Sytrus_x64: input volume
// ramp, 13 filter types in cascades of 1..3 stages (modes x1..x3, ALT x2/x3
// with staggered cutoffs), FLAT, HQ (2x zero-order-hold oversampling), and the
// waveshaper with its dry/wet mix. Coefficients are recomputed for every audio
// chunk (0x7d390) and ramped linearly where FL does (types 0..2). Kernels:
// 0 = Chamberlin SVF with low/band/high mix (0x916e0), 1/2 = resonant 2-pole
// low/high pass (0x91da0 / 0x92000), 3..10 = RBJ biquads (design 0x90eb0,
// DF1 kernel 0x230c), 11 = 4-pole ladder with optional rational-tanh drive
// (0x92540 / 0x920f0), 12 = allpass phaser with feedback (0xfe920).
// docs/research/gen/sytrus.md "Filters".

import type { FltCfg, Patch } from './patch';
import type { SyCtx, SyVoice, UnitVoice } from './voice';

const ALT_EXP = [0.5, 0.75];
/** Biquad design kind per filter type 3..10 (FL table 0x38515c). */
const BQ_KIND = [1, 2, 3, 4, 5, 6, 7, 8];
const TINY = 5.960464477539063e-8;
const LN2_HALF = 0.34657359027997264;
const F32_TINY_BITS = 5.960464477539063e-8;

const f32 = Math.fround;

/** FL's ramp helper (0x8eb60): returns [start, inc, end]; start is the previous end. */
function ramp(state: Float64Array, i: number, target: number, n: number, maxStep: number): void {
  // state[i] = start (value used now), state[i+1] = inc, state[i+2] = end (cur)
  const start = state[i + 2];
  state[i] = start;
  let inc = f32(target - start);
  if (inc !== 0) {
    state[i + 2] = target;
    inc = f32(inc / n);
    if (Math.abs(inc) > maxStep) {
      inc = inc < 0 ? -maxStep : maxStep;
      let end = f32(start + f32(inc * n));
      if (Math.abs(end) < F32_TINY_BITS) { end = 0; inc = f32(-start / n); }
      state[i + 2] = end;
    }
  }
  state[i + 1] = inc;
}

function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const svfTableCache = new Map<number, [Float32Array, Float32Array]>();

/** SVF coefficient tables (0x7d1e0): 2 sin(asin(x) * 44100 / sr), x = (0.01 + i / 2048) / 2, cut at 1.175. */
export function svfTables(rate: number): [Float32Array, Float32Array] {
  let t = svfTableCache.get(rate);
  if (t) return t;
  const out: Float32Array[] = [];
  let d9 = 44100 / rate;
  for (let k = 0; k < 2; k++) {
    const tab = new Float32Array(4096);
    let len = 4096;
    for (let i = 0; i < 4096; i++) {
      let x = f32((0.01 + i * 0.00048828125) * 0.5);
      if (x >= 1) x = 1;
      const y = f32(Math.asin(x));
      const d8 = 2 * Math.sin(y * d9);
      if (d8 >= 1.175) { tab[i] = f32(1.175); len = i + 1; break; }
      tab[i] = f32(d8);
    }
    out.push(tab.slice(0, len));
    d9 *= 0.5;
  }
  t = [out[0], out[1]];
  svfTableCache.set(rate, t);
  return t;
}

/** One cascade stage (FL's 0x78-byte record). */
class Stage {
  kind = 0;
  /** f / q (start values used by the kernel), their increments and end values. */
  r = new Float64Array(6); // [f, incF, curF, q, incQ, curQ]
  // biquad
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  // SVF / 2-pole
  s0 = 0; s1 = 0;
  // ladder
  g = 0; t = 0; outG = 0; q = 0;
  l0 = 0; l1 = 0; l2 = 0; l3 = 0; last = 0;

  reset(q0: number): void {
    this.kind = 0;
    this.r.fill(0);
    this.r[2] = 0.5; this.r[5] = q0; this.r[3] = q0;
    this.b0 = this.b1 = this.b2 = this.a1 = this.a2 = 0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.s0 = this.s1 = 0;
    this.g = this.t = this.outG = this.q = 0;
    this.l0 = this.l1 = this.l2 = this.l3 = this.last = 0;
  }

  /** RBJ design (0x90eb0): A = gain, alpha, sin, cos. */
  design(A: number, alpha: number, sn: number, cs: number): void {
    switch (this.kind) {
      case 1: { const inv = 1 / (1 + alpha); this.a1 = -2 * cs * inv; this.a2 = (1 - alpha) * inv; this.b1 = (1 - cs) * inv; this.b0 = this.b1 * 0.5; this.b2 = this.b0; break; }
      case 2: { const inv = 1 / (1 + alpha); this.a1 = -2 * cs * inv; this.a2 = (1 - alpha) * inv; this.b1 = 0; this.b0 = inv * alpha; this.b2 = inv * -alpha; break; }
      case 3: { const inv = 1 / (1 + alpha); this.a1 = -2 * cs * inv; this.a2 = (1 - alpha) * inv; this.b1 = this.a1; this.b0 = inv; this.b2 = inv; break; }
      case 4: { const inv = 1 / (1 + alpha); this.a1 = -2 * cs * inv; this.a2 = (1 - alpha) * inv; this.b1 = inv * -(1 + cs); this.b0 = -this.b1 * 0.5; this.b2 = this.b0; break; }
      case 5: { const inv = 1 / (1 + alpha); this.a1 = -2 * cs * inv; this.a2 = (1 - alpha) * inv; this.b1 = this.a1; this.b0 = this.a2; this.b2 = 1; break; }
      case 6: {
        const d4 = (A - 1) * cs, d6 = alpha * sn;
        const inv = 1 / (A + 1 + d4 + d6);
        this.a1 = inv * (-2 * ((A - 1) + (A + 1) * cs));
        this.a2 = inv * ((A + 1) + d4 - d6);
        this.b1 = inv * (2 * A * ((A - 1) - (A + 1) * cs));
        this.b0 = inv * (A * ((A + 1) - d4 + d6));
        this.b2 = inv * (A * ((A + 1) - d4 - d6));
        break;
      }
      case 7: {
        const d4 = alpha / A;
        const inv = 1 / (1 + d4);
        this.a1 = inv * (-2 * cs);
        this.a2 = inv * (1 - d4);
        this.b1 = this.a1;
        const e = alpha * A;
        this.b0 = inv * (1 + e);
        this.b2 = inv * (1 - e);
        break;
      }
      case 8: {
        const d4 = (A - 1) * cs, d6 = alpha * sn;
        const inv = 1 / (A + 1 - d4 + d6);
        this.a1 = inv * (2 * ((A - 1) - (A + 1) * cs));
        this.a2 = inv * ((A + 1) - d4 - d6);
        this.b1 = inv * (-2 * A * ((A - 1) + (A + 1) * cs));
        this.b0 = inv * (A * ((A + 1) + d4 + d6));
        this.b2 = inv * (A * ((A + 1) + d4 - d6));
        break;
      }
    }
  }
}

function flush(x: number): number {
  return Math.abs(x) < TINY ? 0 : x;
}

/** Sinh / tanh as FL computes them (0x1e7f60, 0x12c600). */
function sinh(x: number): number { return (Math.exp(x) - Math.exp(-x)) * 0.5; }
function tanh(x: number): number {
  if (x > 5678.22249441322) return 1;
  if (x < -5678.22249441322) return -1;
  const e = Math.exp(-2 * x);
  return (1 - e) / (1 + e);
}

/** Rational tanh approximation of the drive ladder (0x920f0). */
function tanhApprox(a: number): number {
  const s4 = Math.abs(a);
  const s5 = f32(f32(f32(3 + s4) * s4) + 6);
  return f32(f32(a * s5) / f32(f32(s4 * s5) + 12));
}

const SCRATCH = { band: new Float32Array(0), high: new Float32Array(0), os: new Float32Array(0), ws: new Float32Array(0) };

export class FilterUnit {
  type = 0;
  order = -1;
  alt = false;
  expo = 1;
  bwScale = 0;
  fnorm = 1;
  os = false;
  flat = false;
  first = true;
  stages = [new Stage(), new Stage(), new Stage()];
  /** Input volume ramp [start, inc, end]. */
  vol = new Float64Array(3);
  /** Type 0 mix gains low / band / high: [start, inc, end] x 3. */
  mix = new Float64Array(9);
  /** WS mix ramp. */
  wsMix = new Float64Array(3);
  drive = 0;
  /** Phaser (type 12). */
  phN = 0;
  phA = 0;
  phFb = 0;
  phLast = 0;
  phS: Float32Array = new Float32Array(32);
  private bufBand: Float32Array;
  private bufHigh: Float32Array;
  private bufOs: Float32Array;
  private bufWs: Float32Array;

  constructor(maxBlock: number) {
    // scratch shared by every filter (voices render one after another)
    if (SCRATCH.band.length < maxBlock * 2) {
      SCRATCH.band = new Float32Array(maxBlock * 2); SCRATCH.high = new Float32Array(maxBlock * 2);
      SCRATCH.os = new Float32Array(maxBlock * 2); SCRATCH.ws = new Float32Array(maxBlock);
    }
    this.bufBand = SCRATCH.band; this.bufHigh = SCRATCH.high; this.bufOs = SCRATCH.os; this.bufWs = SCRATCH.ws;
  }

  /** Voice start (filter part of 0x7a3b0). */
  reset(cfg: FltCfg, c: SyCtx, volArt: number, wsArt: number): void {
    this.type = cfg.type;
    this.first = true;
    let q0 = 1;
    if (this.type === 0) q0 = 1; else if (this.type === 1 || this.type === 2) q0 = f32(0.1);
    this.order = cfg.mode - 1;
    this.bwScale = this.order + 1;
    this.alt = false;
    for (const s of this.stages) s.reset(q0);
    if (this.order >= 0) {
      this.flat = cfg.flat;
      const rate = c.sampleRate * c.osFactor;
      this.os = (cfg.hq && rate < 176400) || (this.type === 11 && rate < 88200);
      this.fnorm = f32(44100 / rate);
      if (this.os) this.fnorm = f32(this.fnorm * 0.5);
      if (this.type === 12) {
        let n = this.order + 1;
        if (this.flat) n += 5;
        this.phN = n;
        this.phFb = 0;
        this.phLast = 0;
        if (this.phS.length < 2 * n) this.phS = new Float32Array(2 * n);
        this.phS.fill(0);
      } else {
        this.alt = this.order >= 3;
        if (this.alt) this.order -= 2;
        this.expo = this.type === 11 ? f32(1 / (this.order * 0.25 + 1)) : f32(1 / (this.order + 1));
        // the bandwidth scale keeps the full mode (ALT x2 / x3: 4 / 5), set before the ALT reduction (0x7b6c8)
        if (this.type === 5) this.bwScale = f32(1 / this.bwScale);
        for (let i = 1; i <= this.order; i++) { this.stages[i].r[3] = q0; this.stages[i].r[5] = q0; }
      }
    } else this.bwScale = 0;
    this.bwScale = f32(this.bwScale * LN2_HALF);
    this.vol[0] = volArt; this.vol[1] = 0; this.vol[2] = volArt;
    this.mix.fill(0);
    const m = clamp01(f32(wsArt * cfg.wsMix));
    this.wsMix[0] = m; this.wsMix[1] = 0; this.wsMix[2] = m;
    this.drive = 0;
  }

  /** Coefficients for this chunk (0x7d390). cut / res: parameter + articulator. */
  private coefs(cut: number, res: number, c: SyCtx, cfg: FltCfg): void {
    const st = this.stages;
    const T = this.type;
    if (T === 0) {
      if (cut <= 0) cut = 0;
      else cut = f32(Math.exp(f32(cut) * 3.258096538021482) - 1) * 0.0396;
      const tab = c.svf[this.os ? 1 : 0];
      const hi = tab.length - 1;
      for (let i = this.order; i >= 0; i--) {
        let idx = roundEven(cut * 2048);
        if (idx > hi) idx = hi;
        st[i].r[0] = tab[idx];
        if (this.alt) cut = Math.pow(cut, ALT_EXP[this.order - 1]);
      }
      if (res <= 0) res = 1;
      else if (res >= 1) res = 0.2;
      else res = 1 - res * 0.8;
      if (this.flat) res *= res;
      st[0].r[3] = f32(res);
      return;
    }
    if (T === 1 || T === 2) {
      if (this.flat) res = res * (cut + 1) * 0.5;
      if (cut <= 0) cut = 0;
      else { cut = f32(Math.exp(f32(cut) * 4.330733340286331) - 1) * 0.01324; if (cut > 1.6) cut = 1.6; }
      if (res <= 0) res = 1;
      else if (res >= 1) res = 50;
      else res = 1 + f32(Math.exp(f32(res) * 6.90875477931522) - 1) * 0.049;
      if (this.order > 0) res = Math.pow(res, this.expo);
      const d11 = this.fnorm * Math.PI * 0.5;
      for (let i = this.order; i >= 0; i--) {
        const w = (0.007 + cut) * d11;
        const cs = w > 1.2566370614359172 ? 0.30901699437494745 : Math.cos(w);
        st[i].r[0] = f32(2 - 2 * cs);
        const d = cs - 1;
        let q = f32(1 + (Math.sqrt(-d * d * d) * f32(Math.SQRT2)) / (res * d));
        if (q < 0.1) q = f32(0.1);
        st[i].r[3] = q;
        if (this.alt) cut = Math.pow(cut, ALT_EXP[this.order - 1]);
      }
      return;
    }
    if (T === 12) {
      if (cut <= 0) cut = 0;
      else cut = f32(Math.exp(f32(cut) * 5.017279836814924) - 1) * 0.006666;
      if (res <= 0) res = 0;
      else if (res >= 1) res = 0.9;
      else res = f32(Math.log(f32(f32(res * 10) + 1)) / 2.3978952727983707) * 0.9;
      let d12 = (0.0001 + cut) * this.fnorm;
      if (d12 > 1) d12 = 1;
      this.phFb = f32(res);
      this.phA = f32((1 - d12) / (1 + d12));
      return;
    }
    if (T === 11) {
      if (cut <= 0) cut = 0;
      else { cut = f32(Math.exp(f32(cut) * 5.303304908059076) - 1) * 0.014950000000000001; if (cut > 3) cut = 3; }
      const d13 = 0 + f32(Math.exp(this.drive * 5.5254529391317835) - 1) * 0.12;
      const lin = d13 < 0.001;
      const d10 = lin ? 0 : 1 / d13;
      if (res <= 0) res = 0;
      else {
        let x = f32(d13);
        if (x >= 1) x = 1;
        const top = 1.9 + x * 0.6;
        res = res >= 1 ? top : 0 + (top - 0) * res;
      }
      if (this.order > 0) res = Math.pow(res + 1, this.expo) - 1;
      res = -res;
      const d11 = f32(this.fnorm * 0.5);
      for (let i = this.order; i >= 0; i--) {
        const s = st[i];
        let d12 = (0.01 + cut) * d11;
        if (d12 > 0.65) d12 = 0.65;
        const d15 = d12 * d12;
        const fcr = 1.873 * d12 * d15 + 0.4955 * d15 - 0.649 * d12 + 0.9988;
        s.g = 1 - Math.exp(-Math.PI * fcr * d12);
        const acr = -3.9364 * d15 + 1.8409 * d12 + 0.9968;
        s.q = f32(res * acr);
        if (lin) {
          s.outG = f32(0.5 * f32(1 - s.q));
          s.t = 0;
        } else {
          s.t = 2 * d13;
          s.g *= d10;
          s.outG = f32(tanh(4 * d10));
          if (this.flat) s.q = f32(s.q * s.outG);
          s.outG = f32(f32(f32(1 / s.outG) * 0.5) * f32(1 - s.q));
        }
        if (this.alt) cut = Math.pow(cut, ALT_EXP[this.order - 1]);
      }
      return;
    }
    // biquads 3..10
    if (this.flat) res = res * (cut + 1) * 0.5;
    let wOfs = 0.0001;
    let cutMax = 1.0001;
    let cutMul = 0.0003999333333333333;
    if (T === 3) { wOfs = 0.003; cutMul = 0.0006646666666666667; cutMax = Infinity; } else if (T === 6) cutMax = 0.6001;
    if (cut <= 0) cut = 0;
    else { cut = f32(Math.exp(f32(cut) * 7.313886831633462) - 1) * cutMul; if (cut > cutMax) cut = cutMax; }
    let A = 0;
    let p = 0; // alpha factor (3, 6, 7), bandwidth (4, 5), shelf / peak params
    if (T === 3 || T === 6 || T === 7) {
      if (res <= 0) res = 0.1;
      else if (res >= 1) res = 50;
      else res = 0.1 + f32(Math.exp(f32(res) * 7.601402334583733) - 1) * 0.02495;
      if (this.order > 0) res = Math.pow(res, this.expo);
      p = 0.5 / res;
    } else if (T === 4 || T === 5) {
      if (res <= 0) res = 0.01;
      else if (res >= 1) res = 12;
      else res = 0.01 + f32(Math.exp(f32(res) * 4.61512051684126) - 1) * 0.1199;
      p = res * this.bwScale;
    } else if (T === 8 || T === 10) {
      res = 1 - res;
      if (res <= 0) res = 0.1;
      else if (res >= 1) res = 1;
      else res = 0.1 + f32(Math.exp(f32(res) * 1.0986122886681098) - 1) * 0.45;
      A = this.drive;
      if (this.order > 0) A = Math.pow(A, this.expo);
      p = Math.sqrt(A) * Math.sqrt((A + 1 / A) * (1 / res - 1) + 2);
    } else if (T === 9) {
      res = 1 - res;
      if (res <= 0) res = 0.1;
      else if (res >= 1) res = 100;
      else res = 0.1 + f32(Math.exp(f32(res) * 7.601402334583733) - 1) * 0.04995;
      A = this.drive;
      if (this.order > 0) A = Math.pow(A, this.expo);
      p = 2 * res;
    }
    const d11 = this.fnorm * Math.PI * 2;
    const kind = BQ_KIND[T - 3];
    for (let i = this.order; i >= 0; i--) {
      const s = st[i];
      s.kind = kind;
      let w = (wOfs + cut) * d11;
      if (w > 2.849517146113191) w = 2.849517146113191;
      else if (w < 0) w = 0;
      const sn = Math.sin(w), cs = Math.cos(w);
      if (T === 3 || T === 6 || T === 7) s.design(0, sn * p, sn, cs);
      else if (T === 4 || T === 5) s.design(0, sn * sinh((p * w) / sn), sn, cs);
      else if (T === 8 || T === 10) s.design(A, p, sn, cs);
      else s.design(A, sn / p, sn, cs);
      if (this.alt) cut = Math.pow(cut, ALT_EXP[this.order - 1]);
    }
  }

  /** Process one chunk: input (already summed in uv.buf) -> volume -> filter -> waveshaper. */
  process(uv: UnitVoice, v: SyVoice, P: Patch, c: SyCtx, f: number, cnt: number): void {
    void v;
    const cfg = P.flt[f];
    const b = uv.buf;
    const arts = uv.arts;
    const maxStep = c.maxParamStep;
    // input volume (vol articulator), ramped
    ramp(this.vol, 0, f32(arts[1].value), cnt, maxStep);
    mulRampPairs(b, cnt, this.vol[0], this.vol[1]);
    if (this.order >= 0) {
      let buf = b;
      let n = cnt;
      if (this.os) {
        buf = this.bufOs;
        for (let i = cnt - 1; i >= 0; i--) { const x = b[i]; buf[2 * i] = x; buf[2 * i + 1] = x; }
        n = cnt * 2;
      }
      const cut = f32(cfg.cut + f32(arts[2].value));
      const res = f32(cfg.res + f32(arts[3].value));
      this.run(buf, n, cut, res, cfg, uv, c);
      if (this.os) for (let i = 0; i < cnt; i++) b[i] = f32(f32(buf[2 * i] + buf[2 * i + 1]) * 0.5);
    }
    if (cfg.wsTable) this.waveshape(b, cnt, cfg, uv, c);
    this.first = false;
  }

  private run(buf: Float32Array, n: number, cut: number, res: number, cfg: FltCfg, uv: UnitVoice, c: SyCtx): void {
    const st = this.stages;
    const T = this.type;
    const maxStep = c.maxParamStep;
    const arts = uv.arts;
    if (T === 0) {
      const mixT = [cfg.low, cfg.band, cfg.high];
      const g = [0, 0, 0];
      for (let k = 0; k < 3; k++) g[k] = f32(mixT[k] * f32(arts[4 + k].value));
      if (this.order > 0) for (let k = 0; k < 3; k++) g[k] = g[k] > 0 ? f32(Math.pow(g[k], this.expo)) : 0;
      this.coefs(cut, res, c, cfg);
      if (this.first) {
        for (let k = 0; k < 3; k++) this.mix[3 * k + 2] = g[k];
        for (let i = 0; i <= this.order; i++) { const r = st[i].r; r[2] = r[0]; r[5] = r[3]; }
      }
      for (let k = 0; k < 3; k++) ramp(this.mix, 3 * k, g[k], n, maxStep);
      for (let i = 0; i <= this.order; i++) ramp(st[i].r, 0, st[i].r[0], n, maxStep);
      ramp(st[0].r, 3, st[0].r[3], n, maxStep);
      if (this.flat) {
        for (let i = 0; i <= this.order; i++) {
          const r = st[i].r;
          const m = r[0] > r[2] ? r[0] : r[2];
          if (i > 0) r[3] = f32(this.fnorm / m);
          else r[3] = f32(f32(r[3] * this.fnorm) / m);
        }
      }
      const bb = this.bufBand, bh = this.bufHigh;
      for (let i = 0; i <= this.order; i++) {
        const s = st[i], r = s.r;
        let low = s.s0, band = s.s1;
        let fq = r[0], q = r[3];
        const dF = r[1], dQ = i === 0 ? r[4] : 0;
        for (let j = 0; j < n; j++) {
          low = low + band * fq;
          const x = buf[j];
          buf[j] = f32(low);
          const high = x - (band * q + low);
          bh[j] = f32(high);
          band = high * fq + band;
          bb[j] = f32(band);
          q += dQ; fq += dF;
        }
        s.s0 = flush(low); s.s1 = flush(band);
        mulRampPairs(buf, n, this.mix[0], this.mix[1]);
        addRamp(buf, bb, n, this.mix[3], this.mix[4]);
        addRamp(buf, bh, n, this.mix[6], this.mix[7]);
      }
      return;
    }
    if (T === 1 || T === 2) {
      this.coefs(cut, res, c, cfg);
      if (this.first) for (let i = 0; i <= this.order; i++) { const r = st[i].r; r[2] = r[0]; r[5] = r[3]; }
      for (let i = 0; i <= this.order; i++) {
        const s = st[i], r = s.r;
        ramp(r, 0, r[0], n, maxStep);
        ramp(r, 3, r[3], n, maxStep);
        let pos = s.s0, vel = s.s1;
        let fq = r[0], q = r[3];
        const dF = r[1], dQ = r[4];
        if (T === 1) {
          for (let j = 0; j < n; j++) {
            vel = vel + (buf[j] - pos) * fq;
            pos = pos + vel;
            buf[j] = f32(pos);
            fq += dF;
            vel = vel * q;
            q += dQ;
          }
        } else {
          for (let j = 0; j < n; j++) {
            const x = buf[j];
            vel = vel + (x - pos) * fq;
            pos = pos + vel;
            buf[j] = f32(x - pos);
            fq += dF;
            vel = vel * q;
            q += dQ;
          }
        }
        s.s0 = flush(pos); s.s1 = flush(vel);
      }
      return;
    }
    if (T === 12) {
      this.coefs(cut, res, c, cfg);
      const S = this.phS, a = this.phA, na = -a, fb = this.phFb, N = this.phN;
      let last = this.phLast;
      for (let j = 0; j < n; j++) {
        let x = f32(f32(last * fb) + buf[j]);
        for (let k = 0, w = 0; k < N; k++, w += 2) {
          const t = f32(f32(x * na) + S[w]);
          S[w] = f32(x + f32(t * a));
          const y = f32(f32(t * na) + S[w + 1]);
          S[w + 1] = f32(t + f32(y * a));
          x = y;
        }
        buf[j] = x;
        last = x;
      }
      this.phLast = last;
      for (let k = 0; k < 2 * N; k++) S[k] = flush(S[k]);
      return;
    }
    if (T === 11) {
      this.drive = f32(f32(cfg.lowRaw * 0.0078125) * f32(arts[4].value));
      this.coefs(cut, res, c, cfg);
      for (let i = 0; i <= this.order; i++) {
        const s = st[i];
        const g = f32(s.g), q = s.q, og = s.outG;
        let a0 = s.l0, a1 = s.l1, a2 = s.l2, a3 = s.l3, last = s.last;
        if (s.t === 0) {
          for (let j = 0; j < n; j++) {
            const fbv = f32(last * q);
            a0 = f32(a0 + f32(f32(f32(fbv + buf[j]) - a0) * g));
            a1 = f32(a1 + f32(f32(a0 - a1) * g));
            a2 = f32(a2 + f32(f32(a1 - a2) * g));
            const n3 = f32(a3 + f32(f32(a2 - a3) * g));
            last = f32(a3 + n3);
            a3 = n3;
            buf[j] = f32(og * last);
          }
        } else {
          const t = s.t, gd = s.g;
          for (let j = 0; j < n; j++) {
            const fbv = f32(last * q);
            const x = f32(fbv + buf[j]);
            let A = tanhApprox(f32(x * t)), B = tanhApprox(f32(a0 * t));
            a0 = f32(a0 + f32(A - B) * gd);
            A = tanhApprox(f32(a0 * t)); B = tanhApprox(f32(a1 * t));
            a1 = f32(a1 + f32(A - B) * gd);
            A = tanhApprox(f32(a1 * t)); B = tanhApprox(f32(a2 * t));
            a2 = f32(a2 + f32(A - B) * gd);
            A = tanhApprox(f32(a2 * t)); B = tanhApprox(f32(a3 * t));
            const n3 = f32(f32(A - B) * gd + a3);
            last = f32(a3 + n3);
            a3 = n3;
            buf[j] = f32(og * last);
          }
        }
        s.l0 = flush(a0); s.l1 = flush(a1); s.l2 = flush(a2); s.l3 = flush(a3); s.last = flush(last);
      }
      return;
    }
    // biquads (3..10)
    if (T >= 8) {
      const lw = f32(f32(cfg.lowRaw) * f32(arts[4].value));
      this.drive = f32(0.125 + f32(f32(Math.exp(f32(lw * 0.015625) * 2.0794415416798357) - 1) * 0.125));
    }
    this.coefs(cut, res, c, cfg);
    for (let i = 0; i <= this.order; i++) {
      const s = st[i];
      const b0 = s.b0, b1 = s.b1, b2 = s.b2, a1 = s.a1, a2 = s.a2;
      let x1 = s.x1, x2 = s.x2, y1 = s.y1, y2 = s.y2;
      for (let j = 0; j < n; j++) {
        const x = buf[j];
        const y = b0 * x + (b2 * x2 + b1 * x1 - a1 * y1 - a2 * y2);
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        buf[j] = f32(y);
      }
      s.x1 = x1; s.x2 = x2; s.y1 = y1; s.y2 = y2;
    }
  }

  /** Waveshaper and its dry / wet mix (0x80830..0x80b34). */
  private waveshape(b: Float32Array, n: number, cfg: FltCfg, uv: UnitVoice, c: SyCtx): void {
    const t = cfg.wsTable!, N = cfg.wsN;
    const o = this.bufWs;
    const pre = cfg.wsAmp;
    const hq = c.rendering || c.patch.g.hqWs !== 0;
    if (!cfg.wsBip) {
      const s2 = f32(pre * N), s1 = 3.0517578125e-5;
      if (!hq) {
        for (let i = 0; i < n; i++) {
          const x = b[i];
          const sg = x < 0 ? -1 : 1;
          let idx = Math.trunc(f32(Math.abs(x) * s2));
          if (idx > N) idx = N;
          o[i] = f32(t[idx] * sg * s1);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const x = b[i];
          const pos = f32(x * s2);
          let ii = Math.trunc(pos);
          const fr = f32(pos - ii);
          let v: number;
          if (ii < 0) {
            ii = -ii; if (ii > N) ii = N;
            const a = t[ii];
            v = f32(0 - f32(a - f32(f32(t[ii + 1] - a) * fr)));
          } else {
            if (ii > N) ii = N;
            const a = t[ii];
            v = f32(a + f32(f32(t[ii + 1] - a) * fr));
          }
          o[i] = f32(v * s1);
        }
      }
    } else {
      const s1 = 3.0517578125e-5, s3 = f32(N * 0.5), s2 = f32(pre * s3);
      if (!hq) {
        for (let i = 0; i < n; i++) {
          let idx = roundEven(f32(f32(b[i] * s2) + s3));
          if (idx < 0) idx = 0; else if (idx > N) idx = N;
          o[i] = f32(t[idx] * s1);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const pos = f32(f32(b[i] * s2) + s3);
          const ii = Math.trunc(pos);
          const k = ii < 0 ? 0 : ii > N ? N : ii;
          const fr = f32(pos - ii);
          const v = f32(f32(t[k] * f32(1 - fr)) + f32(t[k + 1] * fr));
          o[i] = f32(v * s1);
        }
      }
    }
    const m = clamp01(f32(f32(uv.arts[7].value) * cfg.wsMix));
    if (this.first) this.wsMix[2] = m;
    ramp(this.wsMix, 0, m, n, c.maxParamStep);
    const g = this.wsMix[0], inc = this.wsMix[1];
    if (inc === 0) {
      if (g === 0) return;
      if (g === 1) { b.set(o.subarray(0, n)); return; }
      const d = f32(1 - g);
      for (let i = 0; i < n; i++) b[i] = f32(f32(b[i] * d) + f32(o[i] * g));
    } else {
      mulRampPairs(b, n, f32(1 - g), -inc);
      addRamp(b, o, n, g, inc);
    }
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * In-place multiply by a ramped gain the way FL does it here: its stereo-frame
 * ramp routine (0x8c2c0) is applied to mono buffers, so the gain steps once per
 * PAIR of samples (half the intended rate; the routine also runs n samples
 * past the chunk, into unused buffer space).
 */
function mulRampPairs(b: Float32Array, n: number, g: number, inc: number): void {
  if (inc === 0) {
    if (g === 1) return;
    for (let i = 0; i < n; i++) b[i] = f32(b[i] * g);
    return;
  }
  let g0 = f32(g), g1 = f32(g + inc);
  const inc2 = f32(inc + inc);
  for (let i = 0; i + 1 < n; i += 4) {
    b[i] = f32(b[i] * g0); b[i + 1] = f32(b[i + 1] * g0);
    if (i + 2 < n) b[i + 2] = f32(b[i + 2] * g1);
    if (i + 3 < n) b[i + 3] = f32(b[i + 3] * g1);
    g0 = f32(g0 + inc2); g1 = f32(g1 + inc2);
  }
  if (n & 1 && (n - 1) % 4 === 0) b[n - 1] = f32(b[n - 1] * g0);
}

/** dst += src x ramped gain. */
function addRamp(dst: Float32Array, src: Float32Array, n: number, g: number, inc: number): void {
  if (inc === 0) {
    if (g === 0) return;
    for (let i = 0; i < n; i++) dst[i] = f32(dst[i] + src[i] * g);
    return;
  }
  let gg = g;
  for (let i = 0; i < n; i++) { dst[i] = f32(dst[i] + src[i] * gg); gg += inc; }
}
