// Ogun's timbre engine: FL's TFFTSynth (one per plugin, FL object at plug+0x240) and the voice oscillator that reads it
// (FL voice+0xe50), ported from Ogun_x64.dylib (FL 2026, arm64 slice; addresses in brackets). Harmonic amplitudes come from two
// seeded random spectra (IPP ippsRandUniform_Direct_32f), the forced / impulse / decay / release harmonic maps and the
// pre-decay shaping; a spectrum with fixed random phases is turned into one period of N = 2^order samples by an inverse FFT
// every `hop` samples, the running spectrum multiplied by a per-harmonic decay factor in between; two successive periods
// are cross-faded linearly over the hop and read by a resampler at the note's pitch (one read position per unison voice).
//
// Arithmetic follows the binary operation by operation: float32 where FL keeps float32, double elsewhere; the vector
// calls use the bit-exact IPP ports of the Harmor port (../harmor/ipp.ts).

import {
  addC32fI, add32fI, copy32f, exp32f, fftInitR32f, fftInvPackToR32f, fma64, mul32f, mulC32f, mulC32fI, mul32fI, randUniform32f,
  realToCplx32f, set32f, sqr32f, sub32f, sub32fI, subCRev32fI, sum32f, vectorSlope64f, zero32f, type FFTSpecR32f,
} from '../harmor/ipp';
import { rint } from '../harmor/fx-util';
import { OgunSinc } from './sinc';
import { exp as lexp, log as llog } from '../harmor/fx-libm';

const f32 = Math.fround;
const LN_001 = -4.605170185988091; // G[3f4a88] = ln(0.01)
const EPS = 5.960464477539063e-8; // 2^-24 (float 5.96046448e-08)
/** G[3fd258]: the float FL stores at plugin load (note 132 in Hz x 2). */
export const G_RATE = 33488.07421875;

/** Bob Jenkins' mix(a, b, c), returning c (0x6b260): FL's hash of a timbre seed. */
export function jenkins(a: number, b: number, c: number): number {
  a >>>= 0; b >>>= 0; c >>>= 0;
  a = (a - b - c) >>> 0; a = (a ^ (c >>> 13)) >>> 0;
  b = (b - c - a) >>> 0; b = (b ^ (a << 8)) >>> 0;
  c = (c - a - b) >>> 0; c = (c ^ (b >>> 13)) >>> 0;
  a = (a - b - c) >>> 0; a = (a ^ (c >>> 12)) >>> 0;
  b = (b - c - a) >>> 0; b = (b ^ (a << 16)) >>> 0;
  c = (c - a - b) >>> 0; c = (c ^ (b >>> 5)) >>> 0;
  a = (a - b - c) >>> 0; a = (a ^ (c >>> 3)) >>> 0;
  b = (b - c - a) >>> 0; b = (b ^ (a << 10)) >>> 0;
  c = (c - a - b) >>> 0; c = (c ^ (b >>> 15)) >>> 0;
  return c;
}

/** FL's seed hash of a timbre seed value (ProcessParam 0x6c0b0): 32-bit, treated as a signed int by FL (negative = none / random). */
export function seedHash(seed: number): number {
  if (seed - 1 < 0) return -1;
  return jenkins(seed - 1 + 20, 499, 7919) | 0;
}

/** Zero values below 2^-24 in magnitude (0x7a5d0). */
function flushDenorm(a: Float32Array, off: number, n: number): void {
  for (let i = 0; i < n; i++) if (Math.abs(a[off + i]) < EPS) a[off + i] = 0;
}

/** ippsThreshold_LT_32s_I(buf, n, 0) on float bits: negative values (sign bit set) become +0. */
function clampNegative(a: Float32Array, n: number): void {
  const u = new Int32Array(a.buffer, a.byteOffset, n);
  for (let i = 0; i < n; i++) if (u[i] < 0) u[i] = 0;
}

/** ippsDivCRev_32f_I(val, pSrcDst, len): srcDst = val / srcDst. */
function divCRev32fI(val: number, a: Float32Array, n: number): void {
  const v = f32(val);
  for (let i = 0; i < n; i++) a[i] = v / a[i];
}

/** The map slots of TFFTSynth (FL objects 13..16 -> slots -2..1). */
export const SLOT_FORCED = -2, SLOT_IMPULSE = -1, SLOT_DECAY = 0, SLOT_RELEASE = 1;

export class FftSynth {
  /** +0x08 order, +0x0c N, +0x10 harmonics, +0x14 shift */
  order = 0;
  N = 0;
  hcount = 0;
  shift = 0;
  spec: FFTSpecR32f | null = null;
  /** +0x20 alternate decay mode, +0x21 enabled */
  alt = false;
  enabled = true;
  /** +0x24 / +0x28: first / last+1 nonzero harmonic of the impulse (and decay) spectrum */
  lo = 0;
  hi = 0;
  /** +0x30: sqrt(1/h)-scaled (cos, sin) of the random phases, from index 1 */
  phases = new Float32Array(0);
  /** +0x38..0x50 slots -2..1 and their counts +0x58..0x64 */
  readonly slot: (Float32Array | null)[] = [null, null, null, null];
  readonly count = [0, 0, 0, 0];
  /** +0x78 sample rate, +0x80, +0x88 silence threshold, +0x8c level normalisation, +0x90 silence time */
  sr = 44100;
  d80 = 0;
  silence = f32(lexp(-80 * f32(0.115129254758358)));
  norm = 1;
  silenceSamples = 4410;

  /** Scratch arrays shared by the oscillators (FL allocates them on the stack). */
  private tmp = new Float32Array(0);
  private tmp2 = new Float32Array(0);
  private out = new Float32Array(0);
  private onesBuf: Float32Array[] = [];

  constructor() {
    this.setRate(44100);
  }

  scratch(n: number): Float32Array { if (this.tmp.length < n) this.tmp = new Float32Array(n); return this.tmp; }
  scratch2(n: number): Float32Array { if (this.tmp2.length < n) this.tmp2 = new Float32Array(n); return this.tmp2; }
  outBuf(n: number): Float32Array { if (this.out.length < n) this.out = new Float32Array(n); return this.out; }
  /** A map slot of all ones (used when a slot was never uploaded). */
  ones(k: number): Float32Array {
    if (!this.onesBuf[k] || this.onesBuf[k].length < this.hcount) this.onesBuf[k] = new Float32Array(this.hcount).fill(1);
    return this.onesBuf[k];
  }

  /** 0x26b180: sample rate. */
  setRate(sr: number): void {
    this.sr = sr;
    this.d80 = (G_RATE * (1 << this.shift)) / sr;
    this.silenceSamples = rint(sr * 0.1);
  }

  /** 0x26b080: richness `order` (harmonics = 2^(order-1) >> shift - 1) and the frame oversampling shift. */
  setOrder(order: number, shift: number): void {
    this.order = order;
    this.shift = shift;
    this.spec = fftInitR32f(order + shift, 1);
    this.N = 1 << (order + shift);
    this.hcount = ((1 << (order + shift - 1)) >> shift) - 1;
    this.d80 = (G_RATE * (1 << this.shift)) / this.sr;
    this.lo = 0;
    this.hi = 0;
    for (let i = 0; i < 4; i++) { this.slot[i] = null; this.count[i] = 0; }
    this.buildPhases();
  }

  /** 0x26b2a0: random phases of the harmonics (seed 3). */
  buildPhases(): void {
    const N = this.N, h = this.hcount;
    this.phases = new Float32Array(N);
    const ph = new Float32Array(h);
    randUniform32f(ph, h, 0, f32(6.28318548), new Uint32Array([3]));
    const scale = 1 / Math.sqrt(h);
    for (let i = 0; i < h; i++) {
      const a = ph[i];
      this.phases[2 * i + 1] = f32(scale * Math.cos(a));
      this.phases[2 * i + 2] = f32(scale * Math.sin(a));
    }
    flushDenorm(this.phases, 0, N);
  }

  /** 0x26b240: alternate decay mode (changing it drops the decay and release slots). */
  setAlt(alt: boolean): void {
    if (this.alt === alt) return;
    this.alt = alt;
    this.slot[2] = null;
    this.slot[3] = null;
    this.updateNorm();
  }

  /** 0x26b590: upload a map slot (-2..1). A null source drops the slot. */
  setSlot(idx: number, src: Float32Array | null, n: number): void {
    const k = idx + 2;
    if (!src) { this.slot[k] = null; return; }
    while (this.hcount < n && n > 1 && src[n - 1] === src[n - 2]) n--;
    const a = new Float32Array(n);
    copy32f(src, a, n);
    this.slot[k] = a;
    this.count[k] = n;
    if (idx === -2) subCRev32fI(1, a, n);
    const hc = this.hcount;
    if (idx === -1 || (idx === 0 && this.alt)) {
      this.lo = hc;
      this.hi = hc;
      const a1 = this.slot[1], a2 = this.slot[2];
      if (this.alt && a1 && a2) {
        for (let i = 0; i < hc; i++) {
          if (Math.abs(f32(a1[i] - a2[i])) > EPS) { if (this.lo > i) this.lo = i; this.hi = i + 1; }
        }
      } else {
        for (let i = 0; i < hc; i++) {
          if (a[i] > EPS) { if (this.lo > i) this.lo = i; this.hi = i + 1; }
        }
      }
    }
    this.updateNorm();
  }

  /** 0x26b4c0: rms of a slot over the harmonic count. */
  private rms(idx: number): number {
    const k = idx + 2, a = this.slot[k];
    if (!a) return 0;
    const n = this.count[k];
    const t = new Float32Array(n);
    sqr32f(a, t, n);
    const s = sum32f(t, n);
    return f32(Math.sqrt(f32(s / f32(this.hcount))));
  }

  /** 0x26b400: level normalisation 0.5 / rms of the impulse (or decay) slot. */
  updateNorm(): void {
    this.norm = 1;
    if (!this.enabled) return;
    let d = this.rms(-1);
    if (this.alt) { const r = this.rms(0); d = d > r ? d : r; }
    if (d > EPS) this.norm = f32(0.5 / d);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The voice oscillator (FL voice+0xe50, constructor 0x26bbd0)

const bitsToF32 = (u: number[]): Float32Array => new Float32Array(new Uint32Array(u).buffer);
/** 0x3791e0: the six stages of the 6-point, 5th-order interpolator (3 coefficients per stage). */
const HERMITE6 = bitsToF32([
  0xbd2aaaab, 0x3e555555, 0xbed55555, 0x3caaaaab, 0xbd800000, 0x3d2aaaab, 0x3dd55555, 0xbf300000, 0x3fc55555,
  0xbd555555, 0x3ed00000, 0xbeb55555, 0xbcc00000, 0x3e22aaab, 0xbfae0000, 0x3c400000, 0xbdc80000, 0x3f160000,
]);

/** 0x26c200: the contrast curve applied to the random numbers (c = fullness-derived s40). */
function shapeCurve(src: Float32Array, dst: Float32Array, n: number, c: number): void {
  if (c === 0) { copy32f(src, dst, n); return; }
  if (c > 0) {
    const t = f32(1 + c);
    mulC32fI(f32(llog(t)), src, n);
    exp32f(src, dst, n);
    addC32fI(-1, dst, n);
  } else {
    const cc = f32(1 - c);
    subCRev32fI(1, src, n);
    mulC32fI(f32(llog(cc)), src, n);
    exp32f(src, dst, n);
    subCRev32fI(cc, dst, n);
  }
}

/**
 * out = a * m with the map m shifted by `shift` harmonics (positive: the first `shift` values use m[0]; negative: m starts
 * at -shift) and extended with its last value (the common block of 0x26c390). All lengths are kept non-negative.
 */
function shiftMul(a: Float32Array, m: Float32Array, cnt: number, shift: number, out: Float32Array, n: number): void {
  let ao = 0, mo = 0, oo = 0;
  if (shift === 0 && cnt >= n) { mul32f(a, m, out, n); return; }
  if (shift > 0) {
    const k = Math.min(shift, n);
    mulC32f(a, m[0], out, k);
    ao = k; oo = k; n -= k;
  } else { mo = -shift; cnt += shift; }
  if (cnt < 0) cnt = 0;
  if (mo > m.length) mo = m.length;
  if (n > cnt) {
    const last = m[Math.max(mo + cnt - 1, 0)] ?? 0;
    mulC32f(a, last, out, n - cnt, ao + cnt, oo + cnt);
    n = cnt;
  }
  mul32f(a, m, out, n, ao, mo, oo);
}

/** 0x26bb60: index of the first smallest square (below 1000) in a[0..n). */
function findMinSq(a: Float32Array, n: number): number {
  let min = 1000, idx = 0;
  for (let i = 0; i < n; i++) {
    const s = f32(a[i] * a[i]);
    if (!(s >= min)) { min = s; idx = i; }
  }
  return idx;
}

/** 0x3e14: true when every sample lies within [-thr, thr] (NaN counts as silent). */
export function isSilent(a: Float32Array, n: number, thr: number): boolean {
  const t = f32(thr);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    if (x > t || x < -t) return false;
  }
  return true;
}

/** One unison voice of the oscillator (64-byte record in FL): read position, rate and the cross-fade gains. */
export class UniSlot {
  /** f0 / f4 gain of the new frame (left, right), f8 / fC of the previous one, f10 / f14 and f18 / f1c their steps. */
  readonly g = new Float32Array(8);
  /** d20 read position (frame samples), d28 rate multiplier, f30 / f34 target gains. */
  pos = 0;
  rate = 1;
  tl = 0;
  tr = 0;
}

/** The inputs of the oscillator constructor (0x26bbd0). */
export interface OscInit {
  hop: number;
  seedA: number;
  seedB: number;
  morph: number;
  preDecay: number;
  decay: number;
  fullness: number;
  quality: number;
  rate: number;
  unison: number;
  rotation: number;
  shift: number;
}

export class FftOsc {
  readonly S: FftSynth;
  readonly hop: number;
  readonly seedA: number;
  readonly seedB: number;
  readonly morph: number;
  readonly N: number;
  /** w14 position in the current hop block, w18 next boundary, w1c age within the hop */
  pos = 0;
  next: number;
  age = 0;
  /** w20 / w24 first / last+1 packed index of the active spectrum, w28 harmonics below Nyquist */
  w20 = 0;
  w24 = 0;
  w28 = 0;
  /** w2c rotation (harmonics), w30 random-array rotation */
  readonly w2c: number;
  readonly w30: number;
  /** s40 contrast of the random spectrum */
  readonly s40: number;
  /** w44 silence countdown, w48 decay state (1 while infinite decay is being built, -1 frozen) */
  w44: number;
  w48 = 0;
  readonly d50: number;
  readonly d58: number;
  d60 = 0;
  b68 = true;
  b69: boolean;
  /** dB8 resampler step of rate 1 (rate * S.d80) */
  ratio: number;
  readonly spec0: Float32Array;
  readonly spec1: Float32Array;
  readonly dest: Float32Array;
  frameA: Float32Array;
  frameB: Float32Array;
  /** N + 64 complex samples (re = newer frame, im = older frame) */
  readonly ext: Float32Array;
  readonly slots: UniSlot[] = [];
  readonly kind: number;
  private sinc: OgunSinc | null = null;
  private readonly seedBuf = new Uint32Array(1);

  constructor(S: FftSynth, p: OscInit) {
    this.S = S;
    this.hop = p.hop;
    this.seedA = p.seedA | 0;
    this.seedB = p.seedB | 0;
    this.morph = f32(p.morph);
    this.N = S.N;
    this.next = p.hop;
    const hc = S.hcount;
    const fa = f32(Math.abs(p.fullness));
    const mag = f32(f32(lexp(fa * 16.118095750958314) - 1));
    const d14 = mag * 0.01;
    const sgn = p.fullness < 0 ? -1 : p.fullness > 0 ? 1 : 0;
    this.s40 = f32(d14 * -sgn);
    this.w44 = S.silenceSamples;
    this.b69 = S.alt;
    this.w2c = this.toInt(f32(f32(p.rotation) * hc));
    const rem = this.toInt(f32(f32(f32(p.shift) * hc) + f32(hc << 8)));
    this.w30 = hc === 0 ? 0 : rem % hc;
    this.d50 = p.preDecay;
    this.d58 = p.decay;
    this.ratio = p.rate * S.d80;
    const N = this.N;
    this.spec0 = new Float32Array(N);
    this.spec1 = new Float32Array(N);
    this.dest = new Float32Array((hc + 3) & ~3);
    this.frameA = new Float32Array(N);
    this.frameB = new Float32Array(N);
    this.ext = new Float32Array(2 * (N + 64));
    for (let i = 0; i < p.unison; i++) this.slots.push(new UniSlot());
    // resampler byte 1 -> linear, 2 -> the 6-point interpolator, 6 -> the 32-point windowed sinc (the bytes 3..5 are not used)
    this.kind = p.quality <= 1 ? 1 : p.quality <= 2 ? 2 : 3;
    if (this.kind === 3) this.sinc = new OgunSinc();
  }

  /** frintx + fcvtzs (round half to even). */
  private toInt(x: number): number {
    const r = Math.round(x);
    return ((r - x === 0.5 && r % 2 !== 0) ? r - 1 : r) | 0;
  }

  /** 0x26d4a0: set the rate, start phase (kept when already nonzero) and the gains of a unison voice. */
  setSlot(i: number, rate: number, phase: number, gl: number, gr: number): void {
    const s = this.slots[i];
    s.tl = f32(gl);
    s.tr = f32(gr);
    s.rate = rate;
    if (s.pos === 0) s.pos = phase;
  }

  /** 0x26d4f0: restart the cross-fade (new frame 0 -> target, previous frame target -> 0, over a hop). */
  slotReset(): void {
    const inv = f32(1 / this.hop);
    for (const s of this.slots) {
      const g = s.g;
      g[0] = 0; g[1] = 0;
      g[2] = s.tl; g[3] = s.tr;
      g[4] = f32(s.tl * inv); g[5] = f32(s.tr * inv);
      g[6] = -g[4]; g[7] = -g[5];
    }
  }

  /** 0x26d350: the n uniform randoms of a seed, rotated by w30 positions, into dst (tmp is scratch). */
  private rotRand(seed: number, dst: Float32Array, tmp: Float32Array, n: number): void {
    this.seedBuf[0] = seed >>> 0;
    const rot = this.w30;
    if (rot > 0) {
      randUniform32f(tmp, n, 0, 1, this.seedBuf);
      copy32f(tmp, dst, n - rot, 0, rot);
      copy32f(tmp, dst, rot, n - rot, 0);
    } else randUniform32f(dst, n, 0, 1, this.seedBuf);
  }

  /** 0x26c390: build the starting spectrum (which = 0, with the pre-decay and decay time in samples) or the release factors. */
  buildSpectrum(which: number, aD: number, tD: number): void {
    const S = this.S, n = S.hcount, N = this.N;
    const t = S.scratch(4 * n);
    const b0 = t.subarray(0, n), b1 = t.subarray(n, 2 * n), b2 = t.subarray(2 * n, 3 * n), b3 = t.subarray(3 * n, 4 * n);
    const d10 = (S.sr * 0.025) / this.hop;
    let d11 = tD / this.hop - d10;
    if (!(d11 > 0)) d11 = 0;
    const slotK = which + 2;
    const slot = S.slot[slotK] ?? S.ones(slotK);
    const cnt = S.slot[slotK] ? S.count[slotK] : n;
    this.w48 = tD < 0 ? 1 : 0;
    if (this.b69 && this.w48 === 0) this.d60 = 1 - lexp(LN_001 / d11);
    const dest = this.dest;
    if (which === 0) {
      let d8 = aD > 0.001 ? aD : 0.001;
      d8 = 1 / d8;
      const inv = this.s40 === 0 ? 1 : f32(1 / Math.abs(this.s40));
      const morph = this.morph;
      let flag = morph === 0;
      if (!flag) {
        this.rotRand(this.seedB, b0, b2, n);
        shapeCurve(b0, dest, n, this.s40);
        mulC32fI(f32(morph * inv), dest, n);
      }
      if (morph < 1) {
        if (this.seedA < 0) {
          if (flag) set32f(f32(1 - morph), dest, n); else addC32fI(f32(1 - morph), dest, n);
        } else {
          this.rotRand(this.seedA, b0, b2, n);
          const target = flag ? dest : b1;
          shapeCurve(b0, target, n, this.s40);
          mulC32fI(f32(f32(1 - morph) * inv), target, n);
          if (target !== dest) add32fI(target, dest, n);
          flag = false;
        }
      }
      if (!flag) clampNegative(dest, n);
      const F = S.slot[0];
      if (F) { mul32fI(F, dest, n); addC32fI(1, dest, n); sub32fI(F, dest, n); }
      mulC32f(dest, f32(d8), b1, n);
      addC32fI(f32(0.001), b1, n);
      if (this.b69 || this.w48) {
        if (!this.b69) set32f(1, b2, n);
        divCRev32fI(LN_001, b1, n);
        exp32f(b1, b3, n);
      } else {
        shiftMul(dest, slot, cnt, this.w2c, b0, n);
        mulC32fI(f32(d11), b0, n);
        addC32fI(f32(d10), b0, n);
        divCRev32fI(LN_001, t, 2 * n);
        exp32f(t, t, 2 * n, 0, 2 * n);
      }
      sqr32f(b3, b0, n);
      let rms = sum32f(b0, n);
      rms = f32(Math.sqrt(f32(rms / n)));
      if (rms > 0) mulC32fI(f32(S.norm / rms), b3, n);
      let x = Math.trunc(((n * (1 << S.shift)) * 0.90702947845804993) / this.ratio);
      if (!(x > 0)) x = 0;
      if (x > n) x = n;
      this.w28 = x;
      if (this.w2c === 0) {
        this.w20 = Math.min(Math.max(S.lo, 0), n);
        this.w24 = Math.min(this.w28, S.hi);
      } else {
        this.w20 = 0;
        this.w24 = this.w28;
      }
      const lo = this.b69 ? 0 : this.w20, hi = this.b69 ? this.w28 : this.w24;
      const imp = S.slot[1] ?? S.ones(1);
      const impN = S.slot[1] ? S.count[1] : n;
      zero32f(this.spec0, 2 * lo + 1);
      if (N - (2 * hi + 1) > 0) zero32f(this.spec0, N - (2 * hi + 1), 2 * hi + 1);
      shiftMul(b3, imp, impN, this.w2c, b0, n);
      const ph = S.phases, sp0 = this.spec0;
      for (let i = lo; i <= hi - 1; i++) {
        const v = b0[i], k = 2 * i + 1;
        sp0[k] = f32(ph[k] * v);
        sp0[k + 1] = f32(ph[k + 1] * v);
      }
      if (this.b69) {
        shiftMul(b3, slot, cnt, this.w2c, b0, n);
        const sp1 = this.spec1;
        for (let i = this.w20; i <= this.w24 - 1; i++) {
          const v = b0[i], k = 2 * i + 1;
          sp1[k] = f32(ph[k] * v);
          sp1[k + 1] = f32(ph[k + 1] * v);
        }
      }
      this.w20 = 2 * this.w20 + 1;
      this.w24 = 2 * this.w24 + 1;
      if (this.w24 > this.w20) {
        flushDenorm(sp0, this.w20, this.w24 - this.w20);
        if (this.b69) flushDenorm(this.spec1, this.w20, this.w24 - this.w20);
      }
    } else {
      shiftMul(dest, slot, cnt, this.w2c, b0, n);
      mulC32fI(f32(d11), b0, n);
      addC32fI(f32(d10), b0, n);
      divCRev32fI(LN_001, b0, n);
      exp32f(b0, b2, n);
      if (this.b69) {
        this.b69 = false;
        this.w20 = 0;
        this.w24 = 2 * this.w28 + 1;
      }
    }
    if (!this.b69) {
      flushDenorm(b2, 0, n);
      this.spec1[0] = 0;
      this.spec1[N - 1] = 0;
      realToCplx32f(b2, b2, this.spec1, n, 0, 0, 1);
    }
  }

  /** 0x26c030: next period of the spectrum (swap frames, inverse FFT), interleaved for the resampler when `inter`; then decay. */
  irfft(inter: boolean): void {
    if (this.w48 < 0) return;
    const S = this.S, N = this.N;
    const tmp = this.frameA; this.frameA = this.frameB; this.frameB = tmp;
    fftInvPackToR32f(this.spec0, this.frameA, S.spec!);
    if (inter) {
      realToCplx32f(this.frameA, this.frameB, this.ext, N);
      copy32f(this.ext, this.ext, 128, 0, 2 * N);
    }
    if (this.w48 !== 0) return;
    const n = this.w24 - this.w20;
    if (n <= 0) return;
    if (this.b69) {
      const d = S.scratch2(n);
      sub32f(this.spec0, this.spec1, d, n, this.w20, this.w20, 0);
      mulC32fI(this.d60, d, n);
      add32fI(d, this.spec0, n, 0, this.w20);
    } else {
      mul32fI(this.spec1, this.spec0, n, this.w20, this.w20);
    }
  }

  /** 0x26bf30: build the spectrum and the first two periods, and place the unison read positions on the quietest sample. */
  rebuild(): void {
    this.b68 = false;
    this.buildSpectrum(0, this.d50, this.d58);
    this.irfft(false);
    this.irfft(true);
    const N = this.N;
    const w21 = (findMinSq(this.frameA, N) + (2 * N - 32)) | 0;
    for (const s of this.slots) s.pos = s.pos * N + w21;
    this.slotReset();
    if (this.w48 > 0) this.w48 = -1;
  }

  /** 0x26d5d0: start the release (decay factors for `rel` samples). */
  release(rel: number): void {
    if (this.b68) this.rebuild();
    this.buildSpectrum(1, 0, rel);
    if (this.pos !== 0) {
      const a = f32(this.age / this.hop);
      const N = this.N;
      mulC32fI(a, this.frameA, N);
      mulC32fI(f32(1 - a), this.frameB, N);
      add32fI(this.frameB, this.frameA, N);
      this.irfft(true);
      this.next = this.hop + this.pos;
      this.slotReset();
    }
  }

  /** 0x26d8e0: render `count` stereo samples (interleaved L R) into dst. */
  render(dst: Float32Array, dstOff: number, count: number): void {
    const S = this.S, N = this.N;
    const mask = N;
    let remaining = count, cursor = dstOff;
    const tmp = S.outBuf(2 * count);
    while (remaining > 0) {
      const chunk = Math.min(remaining, this.next - this.pos);
      remaining -= chunk;
      this.age += chunk;
      if (this.b68) this.rebuild();
      for (let k = 0; k < this.slots.length; k++) {
        const sl = this.slots[k];
        sl.pos = this.resample(sl.pos, this.ratio * sl.rate, chunk, tmp, mask);
        this.mix(tmp, dst, cursor, chunk, sl, k === 0);
      }
      cursor += 2 * chunk;
      this.pos += chunk;
      if (this.pos >= this.next) {
        this.irfft(true);
        this.next += this.hop;
        this.age = 0;
        this.slotReset();
      }
    }
    if (isSilent(dst.subarray(dstOff, dstOff + 2 * count), 2 * count, S.silence)) this.w44 -= count;
    else this.w44 = S.silenceSamples;
  }

  private readonly posBuf = new Float64Array(64);

  /** 0x26b980 with the 1 / 3 tap interpolators (quality 1 / 2 and up): resample the (re, im) pairs at pos + i * step. */
  private resample(pos0: number, step: number, count: number, out: Float32Array, N: number): number {
    const ext = this.ext, kind = this.kind;
    const sinc = this.sinc;
    if (sinc) sinc.setSpeed(step);
    const pb = count > this.posBuf.length ? new Float64Array(count) : this.posBuf;
    vectorSlope64f(pb, count, pos0, step);
    for (let i = 0; i < count; i++) {
      const p = pb[i];
      const ip = Math.trunc(p), fr = p - ip;
      const c = 32 + (ip - Math.floor(ip / N) * N);
      if (kind === 3) {
        sinc!.run(ext, c, fr, out, 2 * i);
      } else if (kind === 1) {
        const w = 1 - fr, o = 2 * c;
        out[2 * i] = f32(ext[o] * w + ext[o + 2] * fr);
        out[2 * i + 1] = f32(ext[o + 1] * w + ext[o + 3] * fr);
      } else {
        const o = 2 * (c - 2);
        const z = fr - 0.5;
        for (let ch = 0; ch < 2; ch++) {
          const y0 = ext[o + ch], y1 = ext[o + 2 + ch], y2 = ext[o + 4 + ch], y3 = ext[o + 6 + ch], y4 = ext[o + 8 + ch], y5 = ext[o + 10 + ch];
          const e1 = f32(y0 + y5), o1 = f32(y0 - y5), e2 = f32(y1 + y4), o2 = f32(y1 - y4), e3 = f32(y2 + y3), o3 = f32(y2 - y3);
          const C = HERMITE6;
          let s = f32(f32(f32(C[0] * o1) + f32(C[1] * o2)) + f32(C[2] * o3));
          s = f32(s * z);
          s = f32(f32(f32(f32(C[3] * e1) + f32(C[4] * e2)) + f32(C[5] * e3)) + s);
          s = f32(s * z);
          s = f32(f32(f32(f32(C[6] * o1) + f32(C[7] * o2)) + f32(C[8] * o3)) + s);
          s = f32(s * z);
          s = f32(f32(f32(f32(C[9] * e1) + f32(C[10] * e2)) + f32(C[11] * e3)) + s);
          s = f32(s * z);
          s = f32(f32(f32(f32(C[12] * o1) + f32(C[13] * o2)) + f32(C[14] * o3)) + s);
          s = f32(s * z);
          out[2 * i + ch] = f32(f32(f32(f32(C[15] * e1) + f32(C[16] * e2)) + f32(C[17] * e3)) + s);
        }
      }
    }
    return pos0 + count * step;
  }

  /** 0x26d6e0 / 0x26d7d0: mix the (new, previous) frame pairs of a unison voice into stereo with the cross-fade gains. */
  private mix(src: Float32Array, dst: Float32Array, off: number, count: number, sl: UniSlot, first: boolean): void {
    const g = sl.g;
    let g0 = g[0], g1 = g[1], g2 = g[2], g3 = g[3];
    const i0 = g[4], i1 = g[5], i2 = g[6], i3 = g[7];
    for (let i = 0; i < count; i++) {
      const a = src[2 * i], b = src[2 * i + 1];
      const l = f32(f32(a * g0) + f32(b * g2));
      const r = f32(f32(a * g1) + f32(b * g3));
      const o = off + 2 * i;
      if (first) { dst[o] = l; dst[o + 1] = r; } else { dst[o] = f32(dst[o] + l); dst[o + 1] = f32(dst[o + 1] + r); }
      g0 = f32(g0 + i0); g1 = f32(g1 + i1); g2 = f32(g2 + i2); g3 = f32(g3 + i3);
    }
    g[0] = g0; g[1] = g1; g[2] = g2; g[3] = g3;
  }
}
