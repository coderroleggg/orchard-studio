// Harmor's global DISTORTION (FX unit id 0), ported from FL Studio 2026's
// Harmor_x64.dylib (arm64 slice). Addresses are that binary's.
//
// Unit 0xeb170 (runs only while the FX tail counter plug+0x295c > 0), always
// oversampled (plug+0x2cf4 = 4 from the constructor, never changed):
//   1. TPolyphase upsampling (0x46db60, x[plug+0x2ce0]) of bus 0 by 2^order,
//      order = clamp(precision + 1, 1, 3) (0xd07c4: precision 0 Average / 1 High /
//      2 Perfect, forced to 2 when FL renders with "HQ for offline rendering");
//      each stage is FL's NEON polyphase IIR halfband (kernel 0x1fe0, two
//      3-stage allpass chains in double, 6 coefficients), states flushed below
//      2^-24 after every block (0xfd000);
//   2. dry copy D = x * mix (ramp plug+0x2b34, 0x4604a0);
//   3. asymmetry offset (models 1..7 and 10): x += offset (0x4609c0 fill, with
//      FL's one-block kick after a change, then ippsAdd_32f_I);
//   4. pre gain x *= pre (ramp plug+0x2b0c);
//   5. the model's shaper on the interleaved oversampled block (IPP calls,
//      Tanh/Exp/Ln/Sqrt/Cbrt from plug+0x1160.. = the A11 or A24 variants):
//      1 Classic tanh(x); 2 Hill exp(tanh x) - 1; 3 Flat hat tanh(exp(x) - 1);
//      4 Cube tanh(x)^3; 5 Log sign(x) ln(1 + |x|); 6 Softsat cbrt(tanh(x^3));
//      7 Rubber sign(x) sin(sqrt|x|); 8 Ribbon tanh(x) tanh(x + o) tanh(x + 2o);
//      9 Sincrush sin(x) + x * 4^(asym/500); 10 Bitcrush round(x);
//      11 Bitjam sign(x) expm1(round(ln(1 + |x|) c) / c);
//   6. D += shaped * wet (ramp plug+0x2b5c, 0x460370);
//   7. high cut (plug+0x2bf0, unless the knob is at its maximum 1100): two
//      identical RBJ low pass biquads (Q 0.7071) in series on the stereo block,
//      Direct Form I in double (0x23a0), at the oversampled rate;
//   8. TPolyphase downsampling (0x46dd00, kernel 0x1eb0, x[plug+0x2ce8]);
//   9. DC remover (plug+0x2b88, kernel 0xfdee0) writing bus 0.
// Parameters (ProcessParam 0xd314c for 789..792 and 0xd39a0 for 793, applied
// immediately): see setParams(). A model change (editor 0xc3eb0) resets the
// polyphase stages, the high cut and the DC remover and snaps the ramps.
//
// IPP: the transcendental shapers use ./ipp (FL's dsp_ippv2 = Apple vForce on
// macOS, ported by the IPP agent); exactness of the shapers follows ipp.ts.

import { cbrt32fA11, exp32fA11, expm132fA11, ln32fA11, sin32fA21, sqrt32fA11, tanh32fA11 } from './ipp';
import { cos, exp, log, sin } from './fx-libm';
import {
  EPS24, F001, F01, FlBiquad, FlRamp, FlRate, LN001, LN2, NOTE0_HZ,
  abs, add3, addCI, addI, f32, ibitsOf, mulC, mulCI, mulI, round, signOne, sqr, tanhFpc, volLaw,
} from './fx-util';

const PI = 3.1415926535897931;
const SQRT1_2 = 0.7071067811865475;

function f64FromBits(hi: number, lo: number): number {
  const b = new ArrayBuffer(8);
  const u = new Uint32Array(b);
  u[0] = lo >>> 0;
  u[1] = hi >>> 0;
  return new Float64Array(b)[0];
}
// TPolyphase halfband coefficients: exact bit patterns from the kernels 0x1eb0 / 0x1fe0.
const K0 = f64FromBits(0x3fc2dd40, 0xd58c3526);
const K1 = f64FromBits(0x3fa40bad, 0x9fb6183a);
const K2 = f64FromBits(0x3fdee0c3, 0xbd22db5f);
const K3 = f64FromBits(0x3fd35e90, 0xe2f3bc08);
const K4 = f64FromBits(0x3fec4193, 0xc17c4250);
const K5 = f64FromBits(0x3fe59674, 0x1f70a58f);

/** Flush |s| < 2^-24 to 0 in the first 12 doubles of a stage (0xfd000 with count 12). */
function flushStage(s: Float64Array): void {
  for (let i = 0; i < 12; i++) if (Math.abs(s[i]) < EPS24) s[i] = 0;
}

/**
 * FL's TPolyphase (VMT 0x844c58): `order` halfband stages, each 24 doubles of
 * state (12 slots x L/R lanes): slots 0..5 = previous outputs of the six
 * allpass sections, 6..11 = their previous inputs.
 */
export class Polyphase {
  order = 0;
  readonly stages: Float64Array[] = [];

  setOrder(order: number): void {
    while (this.stages.length < order) this.stages.push(new Float64Array(24));
    this.order = order;
    this.reset();
  }

  reset(): void {
    for (const s of this.stages) s.fill(0);
  }

  /** 0x46db60: src n frames -> dst n * 2^order frames (tmp: scratch of the same size). */
  up(src: Float32Array, so: number, dst: Float32Array, tmp: Float32Array, n: number): void {
    // FL runs stage order-1 first, then down to stage 0, each doubling.
    let inp = src, io = so;
    let m = n;
    for (let s = this.order - 1; s >= 0; s--) {
      // the last stage writes dst; earlier ones alternate so that the final one lands in dst
      const out = ((s & 1) === 0) ? dst : tmp;
      upStage(this.stages[s], inp, io, out, m);
      flushStage(this.stages[s]);
      inp = out;
      io = 0;
      m <<= 1;
    }
  }

  /** 0x46dd00: buf n * 2^order frames -> dst n frames (buf is overwritten). */
  down(buf: Float32Array, dst: Float32Array, nOs: number): void {
    let m = nOs;
    for (let s = this.order - 1; s >= 0; s--) {
      m >>= 1;
      downStage(this.stages[s], buf, s === 0 ? dst : buf, m);
      flushStage(this.stages[s]);
    }
  }
}

/** Kernel 0x1fe0: n input frames -> 2n output frames (path B first, then path A). */
function upStage(S: Float64Array, src: Float32Array, so: number, dst: Float32Array, n: number): void {
  for (let ch = 0; ch < 2; ch++) {
    let s0 = S[0 + ch], s1 = S[2 + ch], s2 = S[4 + ch], s3 = S[6 + ch], s4 = S[8 + ch], s5 = S[10 + ch];
    let s6 = S[12 + ch], s7 = S[14 + ch], s8 = S[16 + ch], s9 = S[18 + ch], s10 = S[20 + ch], s11 = S[22 + ch];
    for (let i = 0; i < n; i++) {
      const x = src[so + 2 * i + ch];
      const a0 = s6 + (x - s0) * K0;
      const b0 = s9 + (x - s3) * K1;
      const a1 = s7 + (a0 - s1) * K2;
      const b1 = s10 + (b0 - s4) * K3;
      const a2 = s8 + (a1 - s2) * K4;
      const b2 = s11 + (b1 - s5) * K5;
      s6 = x; s7 = a0; s0 = a0; s1 = a1; s8 = a1; s9 = x;
      s2 = a2; s3 = b0; s10 = b0; s11 = b1; s4 = b1; s5 = b2;
      dst[4 * i + ch] = b2;
      dst[4 * i + 2 + ch] = a2;
    }
    S[0 + ch] = s0; S[2 + ch] = s1; S[4 + ch] = s2; S[6 + ch] = s3; S[8 + ch] = s4; S[10 + ch] = s5;
    S[12 + ch] = s6; S[14 + ch] = s7; S[16 + ch] = s8; S[18 + ch] = s9; S[20 + ch] = s10; S[22 + ch] = s11;
  }
}

/** Kernel 0x1eb0: 2n input frames -> n output frames, (A + B) * 0.5. In place allowed (dst <= src). */
function downStage(S: Float64Array, src: Float32Array, dst: Float32Array, n: number): void {
  for (let ch = 0; ch < 2; ch++) {
    let s0 = S[0 + ch], s1 = S[2 + ch], s2 = S[4 + ch], s3 = S[6 + ch], s4 = S[8 + ch], s5 = S[10 + ch];
    let s6 = S[12 + ch], s7 = S[14 + ch], s8 = S[16 + ch], s9 = S[18 + ch], s10 = S[20 + ch], s11 = S[22 + ch];
    for (let i = 0; i < n; i++) {
      const xa = src[4 * i + ch];
      const xb = src[4 * i + 2 + ch];
      const a0 = s6 + (xa - s0) * K0;
      s6 = xa; s0 = a0;
      const b0 = s9 + (xb - s3) * K1;
      const a1 = s7 + (a0 - s1) * K2;
      const b1 = s10 + (b0 - s4) * K3;
      s9 = xb; s10 = b0;
      const a2 = s8 + (a1 - s2) * K4;
      s7 = a0; s8 = a1; s1 = a1; s2 = a2; s3 = b0; s4 = b1;
      const b2 = s11 + (b1 - s5) * K5;
      s11 = b1; s5 = b2;
      dst[2 * i + ch] = (a2 + b2) * 0.5;
    }
    S[0 + ch] = s0; S[2 + ch] = s1; S[4 + ch] = s2; S[6 + ch] = s3; S[8 + ch] = s4; S[10 + ch] = s5;
    S[12 + ch] = s6; S[14 + ch] = s7; S[16 + ch] = s8; S[18 + ch] = s9; S[20 + ch] = s10; S[22 + ch] = s11;
  }
}

/** The DC remover record plug+0x2b88 (coefficients 0xd078c, kernel 0xfdee0, reset 0xfda20). */
class DcRemover {
  c1 = 0;
  c2 = f32(0.96);
  private al = 0;
  private ar = 0;
  private bl = 0;
  private br = 0;

  reset(): void {
    this.al = this.ar = this.bl = this.br = 0;
  }

  process(src: Float32Array, dst: Float32Array, n: number): void {
    const c1 = this.c1, c2 = this.c2;
    let al = this.al, bl = this.bl, ar = this.ar, br = this.br;
    for (let i = 0; i < n; i++) {
      const xl = src[2 * i];
      bl = bl + (xl - al) * c1;
      al = al + bl;
      bl = bl * c2;
      dst[2 * i] = xl - al;
      const xr = src[2 * i + 1];
      br = br + (xr - ar) * c1;
      ar = ar + br;
      br = br * c2;
      dst[2 * i + 1] = xr - ar;
    }
    if (Math.abs(al) < EPS24) al = 0;
    if (Math.abs(bl) < EPS24) bl = 0;
    if (Math.abs(ar) < EPS24) ar = 0;
    if (Math.abs(br) < EPS24) br = 0;
    this.al = al; this.bl = bl; this.ar = ar; this.br = br;
  }
}

/** Raw FL parameter values the distortion reads (plug ints). */
export interface DistRaw {
  amt: number; // 789
  asym: number; // 790
  wet: number; // 791
  mix: number; // 792
  hc: number; // 793
}

export class HarmorDist {
  /** plug+0x2cf0: 0 Off, 1 Classic .. 11 Bitjam. */
  mode = 0;
  private readonly rate: FlRate;
  private readonly pre = new FlRamp(); // plug+0x2b0c
  private readonly dry = new FlRamp(); // plug+0x2b34
  private readonly wet = new FlRamp(); // plug+0x2b5c
  private readonly asymR = new FlRamp(); // plug+0x2ae4
  private asymOn = true; // b[plug+0x2d08]
  private bjA = 0; // plug+0x2cfc
  private bjC = 0; // plug+0x2d00
  private bjCi = 0; // plug+0x2d04
  private readonly hc = [new FlBiquad(), new FlBiquad()]; // plug+0x2bf0, +0x2c68
  private readonly dc = new DcRemover();
  private readonly up = new Polyphase(); // x[plug+0x2ce0]
  private readonly down = new Polyphase(); // x[plug+0x2ce8]
  private factor = 2; // plug+0x2cf8
  private raw: DistRaw = { amt: 500, asym: 0, wet: 1000, mix: 0, hc: 950 };
  // scratch: REND+0x38 (x), +0x20 (S), +0x28 (T1), +0x30 (T2), +0x40 (D), ribbon offsets, upsampling temp
  private readonly x: Float32Array;
  private readonly s: Float32Array;
  private readonly t1: Float32Array;
  private readonly t2: Float32Array;
  private readonly d: Float32Array;
  private readonly o: Float32Array;
  private readonly tmp: Float32Array;

  constructor(rate: FlRate, maxBlock: number) {
    this.rate = rate;
    const sz = 2 * 8 * Math.max(1, maxBlock);
    this.x = new Float32Array(sz);
    this.s = new Float32Array(sz);
    this.t1 = new Float32Array(sz);
    this.t2 = new Float32Array(sz);
    this.d = new Float32Array(sz);
    this.o = new Float32Array(sz);
    this.tmp = new Float32Array(sz);
    // constructor 0xc8800: both high cut records are low passes
    this.hc[0].type = 1;
    this.hc[1].type = 1;
    this.setPrecision(0);
  }

  /** Part of 0xd0190 (sample rate / precision setup) that concerns the distortion. */
  setPrecision(precision: number): void {
    const r = this.rate;
    this.dc.c1 = f32(2.2834999999999997e-05 * r.r441);
    this.dc.c2 = f32(0.96);
    const order = Math.min(3, Math.max(1, (precision | 0) + 1));
    this.up.setOrder(order);
    this.down.setOrder(order);
    this.factor = 1 << order;
    this.designHC();
    const k = f32(exp(LN001 / (f32(15 * this.factor) * 0.001 * r.sr)));
    this.asymR.k = k;
    this.pre.k = k;
    this.dry.k = k;
    this.wet.k = k;
  }

  /** 0xeaa30: high cut coefficients for the oversampled rate. */
  private designHC(): void {
    const r = this.rate;
    const maxF = f32(r.nyq * this.factor);
    const w = r.w / this.factor;
    for (const b of this.hc) {
      if (b.freq > maxF) b.freq = maxF;
      const x = b.freq * w;
      const s = sin(x), c = cos(x);
      b.design(0, s * SQRT1_2, s, c);
    }
  }

  /** ProcessParam 0xd314c (params 789..792; also re-run by the model change). */
  setParams(raw: DistRaw): void {
    this.raw = raw;
    const wetLaw = volLaw(raw.wet);
    let d9 = wetLaw;
    const m = f32(f32(raw.mix) * F001);
    this.dry.set(m, m);
    d9 = d9 * (1 - Math.abs(m));
    this.asymOn = true;
    const mode = this.mode;
    const amt = raw.amt;
    if (mode >= 1 && mode <= 3 || mode === 8) {
      const g = exp(f32(f32(f32(amt) * F01) - 4) * LN2);
      const p = f32(g * PI);
      this.pre.set(p, p);
      const w = f32(d9 / (tanhFpc(g) * PI));
      this.wet.set(w, w);
    } else if (mode === 4) {
      const g = exp(f32(f32(f32(amt) * F01) - 2) * LN2);
      const t = tanhFpc(g * 4);
      const p = f32(g * PI);
      this.pre.set(p, p);
      const w = f32(d9 / (t * t * t * PI));
      this.wet.set(w, w);
    } else if (mode === 5) {
      const b = exp((amt * 0.025 - 5) * LN2);
      const p = f32(b);
      this.pre.set(p, p);
      const w = f32(d9 / (log(b + 1) * f32(1 + f32(f32(amt) * F001))));
      this.wet.set(w, w);
    } else if (mode === 6) {
      const h = exp((amt * 0.005 - 3) * LN2);
      const p = f32(h * PI);
      this.pre.set(p, p);
      const w = f32(d9 / (tanhFpc(h) * PI));
      this.wet.set(w, w);
    } else if (mode === 7) {
      const k = exp((amt * 0.002 - 1) * LN2) * PI;
      const p = f32(k * k);
      this.pre.set(p, p);
      const w = f32(d9 / Math.sqrt(k));
      this.wet.set(w, w);
    } else if (mode === 9) {
      const a = f32(exp(raw.asym * 0.004 * LN2));
      this.asymR.set(a, a);
      const p = f32(exp((7 - amt * 0.007) * LN2) * PI);
      this.pre.set(p, p);
      const w = f32(d9 / f32(this.pre.tgt[1] * this.asymR.tgt[0]));
      this.wet.set(w, w);
      this.asymOn = false;
    } else if (mode === 10) {
      const L = f32(exp((9 - amt * 0.007) * LN2));
      this.pre.set(L, L);
      const w = f32(d9 / this.pre.tgt[1]);
      this.wet.set(w, w);
    } else {
      // 11 Bitjam (and the default branch)
      const A = f32(1024 * exp(raw.asym * 0.02 * LN2));
      this.bjA = A;
      this.pre.set(A, A);
      const c10 = exp((10 - amt * 0.007) * LN2);
      this.bjC = f32(c10 / log(f32(A + 1)));
      this.bjCi = f32(1 / this.bjC);
      const w = f32(d9 / A);
      this.wet.set(w, w);
      this.asymOn = false;
    }
    if (this.asymOn) {
      const a = f32(raw.asym * 0.002);
      let off: number;
      if (mode >= 10) off = f32(a / this.pre.tgt[1]);
      else if (mode === 8) off = f32(f32(a * a) * this.pre.tgt[1]);
      else off = f32(f32(a * a) * 0.75);
      if (ibitsOf(a) > 0) this.asymR.set(off, off);
      else this.asymR.set(off, -off);
      this.asymOn = mode !== 8;
    }
  }

  /** ProcessParam 0xd39a0 (param 793, high cut). */
  setHighCut(v: number): void {
    if (v === 1100) {
      this.hc[0].type = 0;
      return;
    }
    if (this.hc[0].type === 0) {
      this.hc[0].type = 1;
      this.hc[0].resetState();
      this.hc[1].resetState();
    }
    const f = f32(exp(f32(f32(v) * F01) * LN2) * NOTE0_HZ);
    this.hc[0].freq = f;
    this.hc[1].freq = f;
    this.designHC();
  }

  /** Editor 0xc3eb0 (distortion type change): params (current raw values), resets, ramps snapped. */
  setMode(mode: number, raw: DistRaw): void {
    this.mode = mode | 0;
    this.setParams(raw);
    this.up.reset();
    this.down.reset();
    this.hc[0].resetState();
    this.hc[1].resetState();
    this.dc.reset();
    for (const r of [this.asymR, this.pre, this.dry, this.wet]) {
      r.cur[0] = r.tgt[0];
      r.cur[1] = r.tgt[1];
    }
  }

  reset(): void {
    this.up.reset();
    this.down.reset();
    this.hc[0].resetState();
    this.hc[1].resetState();
    this.dc.reset();
    for (const r of [this.asymR, this.pre, this.dry, this.wet]) {
      r.cur[0] = r.tgt[0];
      r.cur[1] = r.tgt[1];
    }
  }

  /** Unit 0xeb170 on interleaved bus 0 (n frames, in place). */
  process(bus: Float32Array, n: number, tailActive: boolean): void {
    if (!tailActive || n <= 0) return;
    const { x, s, t1, t2, d } = this;
    this.up.up(bus, 0, x, this.tmp, n);
    const no = n * this.factor;
    const N = 2 * no;
    this.dry.gain(x, 0, d, 0, no);
    if (this.asymOn && !this.asymR.isZero()) {
      this.asymR.fill(s, 0, no);
      addI(s, 0, x, 0, N);
    }
    this.pre.gain(x, 0, x, 0, no);
    switch (this.mode) {
      case 1:
        tanh32fA11(x, s, N);
        break;
      case 2:
        tanh32fA11(x, t1, N);
        exp32fA11(t1, s, N);
        addCI(-1, s, 0, N);
        break;
      case 3:
        exp32fA11(x, t1, N);
        addCI(-1, t1, 0, N);
        tanh32fA11(t1, s, N);
        break;
      case 4:
        tanh32fA11(x, s, N);
        sqr(s, 0, t2, 0, N);
        mulI(t2, 0, s, 0, N);
        break;
      case 5:
        abs(x, 0, t1, 0, N);
        addCI(1, t1, 0, N);
        ln32fA11(t1, s, N);
        signOne(x, 0, N);
        mulI(x, 0, s, 0, N);
        break;
      case 6:
        sqr(x, 0, t1, 0, N);
        mulI(x, 0, t1, 0, N);
        tanh32fA11(t1, t2, N);
        cbrt32fA11(t2, s, N);
        break;
      case 7:
        abs(x, 0, s, 0, N);
        sqrt32fA11(s, t1, N);
        sin32fA21(t1, s, N);
        signOne(x, 0, N);
        mulI(x, 0, s, 0, N);
        break;
      case 8: {
        const o = this.o;
        tanh32fA11(x, s, N);
        this.asymR.fill(o, 0, no);
        add3(x, 0, o, 0, t1, 0, N);
        tanh32fA11(t1, t2, N);
        mulI(t2, 0, s, 0, N);
        addI(o, 0, t1, 0, N);
        tanh32fA11(t1, t2, N);
        mulI(t2, 0, s, 0, N);
        break;
      }
      case 9:
        sin32fA21(x, s, N);
        this.asymR.addGain(x, 0, s, 0, no);
        break;
      case 10:
        round(x, 0, s, 0, N);
        break;
      default:
        abs(x, 0, s, 0, N);
        addCI(1, s, 0, N);
        ln32fA11(s, t1, N);
        mulCI(this.bjC, t1, 0, N);
        round(t1, 0, s, 0, N);
        mulC(s, 0, this.bjCi, t1, 0, N);
        expm132fA11(t1, s, N);
        signOne(x, 0, N);
        mulI(x, 0, s, 0, N);
        break;
    }
    this.wet.addGain(s, 0, d, 0, no);
    if (this.hc[0].type !== 0) {
      this.hc[0].process(d, 0, no);
      this.hc[1].process(d, 0, no);
    }
    this.down.down(d, x, no);
    this.dc.process(x, bus, n);
  }

  /** Bitjam level count (for tests / monitor). */
  get bitjamA(): number {
    return this.bjA;
  }
}
