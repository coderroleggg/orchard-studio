// 3x Osc (FL: 3x Osc): the HQ oscillators ("High quality (anti aliased
// oscillators)"), a port of FL's `3x Osc/engine.dylib` (C++ with symbols:
// Osc::addOsc, Osc::selectWaveTable, Osc::processWaveInternal2,
// Osc::setCustomWave, MipMapGenerator::createMipMapForWaveform,
// KissFFTFilterSIMD, kiss_fft), single precision with FL's fused
// multiply-adds.
//
// - Sine: sinf(2 pi phase) per sample (macOS libm's sinf, ported). Noise: a global 32-bit LCG (seed
//   67998, x = x * 0x0bb38435 + 0x3619636b per sample, value x / 2^31),
//   shared by every 3x Osc in the process like engine.dylib's static.
// - Triangle, square, saw, rounded saw (FL's own 2048-sample shapes, not the
//   host tables) and the custom shape (the 16384-point shape averaged to 2048
//   points) play from mip-mapped tables: the shape is upsampled 16x by linear
//   interpolation (32768 points, one cycle), transformed with kiss_fft
//   (float, radix 4^7 x 2), and level l keeps harmonics 0..cut_l (cut_0 =
//   1024, divided by 2^(1/4) per level, 44 levels); the table is the inverse
//   transform / 32768. A voice uses level trunc(clamp(4 log2(f / 8.176 Hz) - 5,
//   0, 42)) with linear interpolation between table points; below 0.0005
//   cycles per sample (22 Hz at 44.1 kHz) the naive shape is computed instead
//   (the custom shape is silent there, as in FL).
// - Every output sample is fma(s * m, gain, out) with m = 1, or m = -out for
//   the AM oscillator (out = out - out * s * gain).
//
// The tables of a shape (44 inverse FFTs, ~50 ms) are built when HQ plays it
// for the first time (setParams), and shared by all instances; FL builds them
// once per process when the first 3x Osc loads.

const fr = Math.fround;
const K32 = 2.3283064365386963e-10; // 2^-32
const TWO_PI_F = fr(6.2831854820251465);
const N0 = 2048;
const OS = 16;
const M = N0 * OS; // 32768
const NUM_LEVELS = 44; // trunc(log2(2048) * 4)
const LOG10_2 = 0.3010299956639812;
const RS_END = 0.8333333333333334; // rounded saw: -1 from 5/6 of the cycle
const RS_KNEE = 0.4638671875; // 950 / 2048: +1 from here
const RS_KNEE_F = fr(0.4638671875);

// -------------------------------------------------------------------------- float helpers

/** Single-precision fused multiply-add round(a * b + c) for floats a, b, c (exact, ties to even). */
export function fma32(a: number, b: number, c: number): number {
  const p = a * b; // exact: 24 x 24 bits
  const s = p + c;
  const r = fr(s);
  const bb = s - p;
  const err = (p - (s - bb)) + (c - bb); // p + c = s + err exactly
  if (err === 0 || r === s) return r;
  const h = s - r; // exact
  const t = s + h; // the other neighbour when s is a midpoint
  if (fr(t) !== t || t === r) return r;
  // s is exactly halfway between r and t: the exact value lies on the side of err
  if ((err > 0) === (h > 0)) return t;
  return r;
}

/**
 * sinf as macOS's libm computes it (libsystem_m: quadrant reduction by pi / 2
 * and short double polynomials, then rounded to float; not correctly rounded:
 * about 0.1 % of results differ from a correctly rounded sine). Ported for
 * |x| < 120 (3x Osc's arguments lie in 0..2 pi); bit-identical to the system
 * sinf on 29 million float arguments in 0..2 pi. Double operations need not
 * be fused: the float result was the same either way.
 */
export function sinf(x: number): number {
  const ax = Math.abs(x);
  if (!(ax < 120)) return fr(Math.sin(x));
  if (ax < 0.7853981852531433) {
    if (ax < 0.000244140625) return x;
    return fr(sinPoly(x));
  }
  const t = x * 0.6366197723675814;
  let q = Math.round(t);
  if (q - t === 0.5 && q % 2 !== 0) q -= 1; // ties to even
  const r = x - q * 1.5707963267948966;
  const v = (q & 1) !== 0 ? cosPoly(r) : sinPoly(r);
  return fr((q & 2) !== 0 ? -v : v);
}

function sinPoly(r: number): number {
  const r2 = r * r, r3 = r * r2, r5 = r2 * r3;
  return r5 * (r2 * -0.00019515283191485737 + 0.008332160761855575) + (r3 * -0.16666654609548576 + r);
}

function cosPoly(r: number): number {
  const r2 = r * r, r4 = r2 * r2;
  const a = r2 * 2.4383567311838599e-05 + -0.0013886681647984319;
  const b = r2 * 0.041666620357131375 + -0.49999999694475988;
  return r2 * (r4 * a + b) + 1.0;
}

// -------------------------------------------------------------------------- kiss_fft (float, FL's build)

class KissFFT {
  readonly n: number;
  readonly inverse: boolean;
  readonly twr: Float32Array;
  readonly twi: Float32Array;
  readonly factors: number[] = [];

  constructor(n: number, inverse: boolean) {
    this.n = n;
    this.inverse = inverse;
    this.twr = new Float32Array(n);
    this.twi = new Float32Array(n);
    const d9 = -6.283185307179586;
    for (let i = 0; i < n; i++) {
      let ph = (i * d9) / n;
      if (inverse) ph = -ph;
      this.twr[i] = Math.cos(ph);
      this.twi[i] = Math.sin(ph);
    }
    // kf_factor
    let p = 4, nn = n;
    const floorSqrt = Math.floor(Math.sqrt(n));
    do {
      while (nn % p) {
        p = p === 4 ? 2 : p === 2 ? 3 : p + 2;
        if (p > floorSqrt) p = nn;
      }
      nn /= p;
      this.factors.push(p, nn);
    } while (nn > 1);
  }

  /** Out-of-place transform of (inR, inI) into (outR, outI). */
  run(inR: Float32Array, inI: Float32Array, outR: Float32Array, outI: Float32Array): void {
    this.work(outR, outI, 0, inR, inI, 0, 1, 0);
  }

  private work(oR: Float32Array, oI: Float32Array, fo: number, iR: Float32Array, iI: Float32Array, fi: number, fstride: number, fac: number): void {
    const p = this.factors[fac], m = this.factors[fac + 1];
    const end = fo + p * m;
    if (m === 1) {
      for (let o = fo; o < end; o++) { oR[o] = iR[fi]; oI[o] = iI[fi]; fi += fstride; }
    } else {
      for (let o = fo; o < end; o += m) { this.work(oR, oI, o, iR, iI, fi, fstride * p, fac + 2); fi += fstride; }
    }
    if (p === 2) this.bfly2(oR, oI, fo, fstride, m);
    else if (p === 4) this.bfly4(oR, oI, fo, fstride, m);
    else throw new Error('3x Osc HQ: unsupported FFT factor');
  }

  private bfly2(R: Float32Array, I: Float32Array, fo: number, fstride: number, m: number): void {
    const twr = this.twr, twi = this.twi;
    for (let k = 0, t = 0; k < m; k++, t += fstride) {
      const a = fo + k, b = a + m;
      const wr = twr[t], wi = twi[t], br = R[b], bi = I[b];
      const tr = fma32(wr, br, -fr(wi * bi));
      const ti = fma32(wi, br, fr(wr * bi));
      const ar = R[a], ai = I[a];
      R[b] = ar - tr; I[b] = ai - ti;
      R[a] = tr + ar; I[a] = ti + ai;
    }
  }

  private bfly4(R: Float32Array, I: Float32Array, fo: number, fstride: number, m: number): void {
    const twr = this.twr, twi = this.twi, inv = this.inverse;
    for (let k = 0; k < m; k++) {
      const a0 = fo + k, a1 = a0 + m, a2 = a1 + m, a3 = a2 + m;
      const t1 = k * fstride, t2 = 2 * t1, t3 = 3 * t1;
      let wr = twr[t1], wi = twi[t1], xr = R[a1], xi = I[a1];
      const s0r = fma32(wr, xr, -fr(wi * xi)), s0i = fma32(wi, xr, fr(wr * xi));
      wr = twr[t2]; wi = twi[t2]; xr = R[a2]; xi = I[a2];
      const s1r = fma32(wr, xr, -fr(wi * xi)), s1i = fma32(wi, xr, fr(wr * xi));
      wr = twr[t3]; wi = twi[t3]; xr = R[a3]; xi = I[a3];
      const s2r = fma32(wr, xr, -fr(wi * xi)), s2i = fma32(wi, xr, fr(wr * xi));
      const f0r = R[a0], f0i = I[a0];
      const s5r = fr(f0r - s1r), s5i = fr(f0i - s1i);
      const g0r = fr(s1r + f0r), g0i = fr(s1i + f0i);
      const s3r = fr(s0r + s2r), s3i = fr(s0i + s2i);
      const s4r = fr(s0r - s2r), s4i = fr(s0i - s2i);
      R[a2] = g0r - s3r; I[a2] = g0i - s3i;
      R[a0] = s3r + g0r; I[a0] = s3i + g0i;
      if (inv) {
        R[a1] = s5r - s4i; I[a1] = s5i + s4r;
        R[a3] = s5r + s4i; I[a3] = s5i - s4r;
      } else {
        R[a1] = s5r + s4i; I[a1] = s5i - s4r;
        R[a3] = s5r - s4i; I[a3] = s5i + s4r;
      }
    }
  }
}

let fftFwd: KissFFT | null = null;
let fftInv: KissFFT | null = null;
let workR: Float32Array | null = null, workI: Float32Array | null = null, outR: Float32Array | null = null, outI: Float32Array | null = null;

function ffts(): void {
  if (fftFwd) return;
  fftFwd = new KissFFT(M, false);
  fftInv = new KissFFT(M, true);
  workR = new Float32Array(M); workI = new Float32Array(M);
  outR = new Float32Array(M); outI = new Float32Array(M);
}

/** Harmonic cut-off of each mip level (FL: 1024, then / 2^(1/4) per level, at least 1). */
const CUT: number[] = (() => {
  const c: number[] = [];
  const step = Math.pow(2, 1 / 4);
  let d = N0 * 0.5;
  for (let l = 0; l < NUM_LEVELS; l++) { const t = Math.trunc(d); c.push(t > 1 ? t : 1); d /= step; }
  return c;
})();

// -------------------------------------------------------------------------- mip-mapped wavetables

/** One shape's mip map: its spectrum and the level tables built so far (32768 + 10 points; [M], [M+1] wrap). */
export class MipMap {
  private readonly specR = new Float32Array(M);
  private readonly specI = new Float32Array(M);
  private readonly levels: (Float32Array | null)[] = new Array(NUM_LEVELS).fill(null);

  /** createMipMapForWaveform: upsample the 2048-point shape 16x and transform it. */
  constructor(wave: Float32Array) {
    ffts();
    const up = workR!, zero = workI!;
    let pos = 0;
    for (let i = 0; i < M; i++) {
      const s3 = fr(pos);
      const i0 = Math.trunc(s3);
      const frac = fr(s3 - i0);
      const i1 = i0 + 1 >= N0 ? 0 : i0 + 1;
      up[i] = fma32(wave[i0], fr(1 - frac), fr(frac * wave[i1]));
      pos += 1 / OS;
    }
    zero.fill(0);
    fftFwd!.run(up, zero, this.specR, this.specI);
  }

  /** Build every level now (the voices then never allocate). */
  buildAll(): void {
    for (let l = 0; l < NUM_LEVELS; l++) this.level(l);
  }

  /** Level l's table (built on first use). */
  level(l: number): Float32Array {
    const have = this.levels[l];
    if (have) return have;
    const cut = CUT[l];
    const R = workR!, I = workI!;
    R.set(this.specR);
    I.set(this.specI);
    // bins cut+1 .. M-cut-1 are zero (FL zeroes them lane by lane, cumulatively)
    for (let k = cut + 1; k <= M - cut - 1; k++) { R[k] = 0; I[k] = 0; }
    fftInv!.run(R, I, outR!, outI!);
    const t = new Float32Array(M + 10);
    const sc = fr(1 / M);
    const o = outR!;
    for (let i = 0; i < M; i++) t[i] = o[i] * sc;
    t[M] = t[0];
    t[M + 1] = t[1];
    this.levels[l] = t;
    return t;
  }
}

/** FL's HQ shapes (2048 points): triangle, square, saw, rounded saw (Osc::Osc). */
function hqShape(k: number): Float32Array {
  const w = new Float32Array(N0);
  for (let i = 0; i < N0; i++) {
    const x = fr(i * (1 / N0));
    w[i] = naive(k + 1, x);
  }
  return w;
}

/** The naive shape value at phase x (0..1), FL's Osc::processWaveInternal2 below 0.0005 cycles / sample. */
function naive(shape: number, x: number): number {
  switch (shape) {
    case 1: // triangle (starting at 0, rising)
      if (x < 0.25) return fr(x * 4);
      if (x < 0.75) return fma32(fr(x - 0.25), -4, 1);
      return fma32(fr(x - 0.75), 4, -1);
    case 2: return x < 0.5 ? 1 : -1;
    case 3: return fma32(x, 2, -1); // -(x * -2) - 1
    case 4: {
      if (x >= RS_END) return -1;
      if (x >= RS_KNEE_F) return 1;
      const p = Math.pow(0.997, (x / RS_KNEE) * 7600);
      return fr((1 - p) * 2 + -1);
    }
    default: return 0;
  }
}

const globalMips: (MipMap | null)[] = [null, null, null, null];

function shapeMip(shape: number): MipMap {
  const i = shape - 1;
  let m = globalMips[i];
  if (!m) { m = new MipMap(hqShape(i)); globalMips[i] = m; }
  return m;
}

/** engine.dylib's noise state (static, shared by every 3x Osc). */
let noiseSeed = 67998;

/** Restart the HQ noise generator (FL: once per process, seed 67998). */
export function resetHqNoise(seed = 67998): void {
  noiseSeed = seed | 0;
}

// -------------------------------------------------------------------------- Osc

/** One plugin's HQ oscillator engine (FL: an Osc object in engine.dylib per 3x Osc). */
export class HqOsc {
  private invSR = 1 / 44100;
  private freq = 0;
  private table: Float32Array | null = null;
  private shape = 0;
  private custom: MipMap | null = null;
  private customSrc: Float32Array | null = null;

  setSampleRate(sr: number): void {
    this.invSR = 1 / sr;
  }

  /** Build the mip map of an HQ shape before voices need it (FL builds its tables when the plugin loads). */
  prepare(shape: number): void {
    if (shape >= 1 && shape <= 4) shapeMip(shape).buildAll();
    else if (shape === 6) this.custom?.buildAll();
  }

  /** Osc::setCustomWave: the 16384-point shape averaged over 8 points. */
  setCustomWave(w16384: Float32Array | null): void {
    if (this.customSrc === w16384) return;
    this.customSrc = w16384;
    this.custom = null;
    if (!w16384) return;
    const w = new Float32Array(N0);
    for (let i = 0; i < N0; i++) {
      let s = 0;
      for (let j = 0; j < 8; j++) s = fr(s + w16384[i * 8 + j]);
      w[i] = fr(s / 8);
    }
    this.custom = new MipMap(w);
  }

  private select(x: number, custom: boolean): void {
    const mip = custom ? this.custom : shapeMip(this.shape);
    let l = fr(x * 4 + -5);
    const top = NUM_LEVELS - 2;
    const s1 = top < l ? top : l;
    l = l < 0 ? 0 : s1;
    const idx = Number.isNaN(l) ? 0 : Math.trunc(l);
    this.table = mip ? mip.level(idx) : null;
  }

  private sampleAt(x: number): number {
    if (this.freq >= 0.0005) {
      const t = this.table;
      if (!t) return 0;
      const s0 = fr(x * 2048);
      const s1 = fr(s0 * 16);
      const i = Math.trunc(s1);
      const frac = fr(s1 - i);
      return fma32(t[i], fr(1 - frac), fr(t[i + 1] * frac));
    }
    return naive(this.shape, x);
  }

  /**
   * Osc::addOsc: add `n` samples of oscillator `shape` (0 sine, 1 triangle, 2
   * square, 3 saw, 4 rounded saw, 5 noise, 6 custom) to out[0..n), starting at
   * the 32-bit phase, advancing by `speed`; am = amplitude-modulate out instead.
   * Returns the new phase.
   */
  add(shape: number, out: Float32Array, n: number, gain: number, phase: number, speed: number, am: boolean): number {
    if (shape === 0) {
      for (let k = 0; k < n; k++) {
        const s = sinf(fr(fr(K32 * phase) * TWO_PI_F));
        const d = out[k];
        out[k] = fma32(fr(s * (am ? -d : 1)), gain, d);
        phase = (phase + speed) >>> 0;
      }
      return phase;
    }
    if (shape === 5) {
      let x = noiseSeed;
      for (let k = 0; k < n; k++) {
        x = (Math.imul(x, 0x0bb38435) + 0x3619636b) | 0;
        const v = fr(x) * 4.656612873077393e-10;
        const d = out[k];
        out[k] = fma32(fr(v * (am ? -d : 1)), gain, d);
      }
      noiseSeed = x;
      return (phase + Math.imul(speed, n)) >>> 0;
    }
    this.freq = speed * K32;
    this.shape = shape;
    this.select(Math.log10(this.freq / (this.invSR * 8.176)) / LOG10_2, shape === 6);
    for (let k = 0; k < n; k++) {
      const s = this.sampleAt(fr(K32 * phase));
      const d = out[k];
      out[k] = fma32(fr(s * (am ? -d : 1)), gain, d);
      phase = (phase + speed) >>> 0;
    }
    return phase;
  }
}
