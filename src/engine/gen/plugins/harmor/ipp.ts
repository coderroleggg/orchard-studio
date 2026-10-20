// FL Studio's IPP-compatible vector library as Harmor calls it on Apple
// Silicon: /Applications/FL Studio 2026.app/.../Shared/dsp_ippv2_x64.dylib,
// arm64 slice. On macOS that library is a thin wrapper: the IPP math entry
// points forward to Apple's Accelerate (vForce vvsinf / vvexpm1f / vvpowsf
// ..., vDSP_sve, vDSP_fft_zrip ...), with A11 / A21 / A24 variants all calling
// the same vForce routine. The ports below reproduce the arm64 NEON code of
// those Accelerate routines (macOS 26.3, libvMisc / libvDSP in the dyld shared
// cache) operation by operation: float32 rounding after every operation
// (Math.fround), fused multiply-adds (fmla / fmadd) emulated exactly
// (fma32 / fma64 below), the same constants, lane grouping and summation
// order. Results were checked bit for bit against the real library (see
// tests/gen/harmor-ipp.test.ts for pinned outputs).
//
// Notes valid for every function:
// - FPCR is assumed default (round to nearest even, no flush-to-zero); the
//   library's ippSetFlushToZero / ippSetDenormAreZeros are no-ops.
// - NaN results are NaN, but NaN payload bits are not reproduced.

const f32 = Math.fround;

// Bit casts (little-endian, as on every platform the app runs on).
const cvtBuf = new ArrayBuffer(8);
const cvtF64 = new Float64Array(cvtBuf);
const cvtF32 = new Float32Array(cvtBuf);
const cvtU32 = new Uint32Array(cvtBuf);

/** Float32 bits of a float32 value. */
export function f32bits(x: number): number {
  cvtF32[0] = x;
  return cvtU32[0];
}

/** Float32 value of 32 bits. */
export function bitsf32(u: number): number {
  cvtU32[0] = u;
  return cvtF32[0];
}

/** Double from two 32-bit halves. */
function bitsf64(hi: number, lo: number): number {
  cvtU32[0] = lo;
  cvtU32[1] = hi;
  return cvtF64[0];
}

// ---------------------------------------------------------------------------
// Exact fused multiply-add

/**
 * Float32 fused multiply-add a*b + c with a single rounding (ARM fmla.4s /
 * fmadd s). a, b, c must be float32 values. The product is exact in double;
 * the double sum can only mis-round (double rounding) when it lands exactly on
 * a float32 midpoint while being inexact, which is detected and resolved with
 * the TwoSum error term.
 */
export function fma32(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const r = f32(s);
  if (r === s) return r;
  const o = r + 2 * (s - r); // the other float32 neighbour if s is a midpoint
  if (f32(o) !== o) return r;
  const t = s - p;
  const e = (p - (s - t)) + (c - t);
  if (e === 0) return r; // exact tie: fround already rounded to even
  return (e > 0) === (o > r) ? o : r;
}

const SPLIT = 134217729; // 2^27 + 1

/** s = x + y rounded to odd (exact when representable). */
function addRoundOdd(x: number, y: number): number {
  const s = x + y;
  const bb = s - x;
  const err = (x - (s - bb)) + (y - bb);
  if (err === 0) return s;
  cvtF64[0] = s;
  if (cvtU32[0] & 1) return s;
  if ((s > 0) === (err > 0)) {
    cvtU32[0] = cvtU32[0] + 1;
    if (cvtU32[0] === 0) cvtU32[1] = cvtU32[1] + 1;
  } else {
    if (cvtU32[0] === 0) cvtU32[1] = cvtU32[1] - 1;
    cvtU32[0] = cvtU32[0] - 1;
  }
  return cvtF64[0];
}

/**
 * Float64 fused multiply-add a*b + c with a single rounding (ARM fmla.2d /
 * fmadd d): Dekker product, then the Boldo-Melquiond round-to-odd sum; exact
 * BigInt arithmetic for extreme magnitudes and special values.
 */
export function fma64(a: number, b: number, c: number): number {
  const p = a * b;
  const ap = Math.abs(p), aa = Math.abs(a), ab = Math.abs(b), ac = Math.abs(c);
  if (!(ap < 1e290 && ap > 1e-280 && aa < 1e290 && ab < 1e290 && ac < 1e300)) return fma64Big(a, b, c);
  let t = SPLIT * a;
  const ah = t - (t - a), al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b), bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  if (e === 0) return p + c;
  const th = c + e;
  let bb = th - c;
  const tl = (c - (th - bb)) + (e - bb);
  const vh = p + th;
  bb = vh - p;
  const vl = (p - (vh - bb)) + (th - bb);
  return vh + addRoundOdd(tl, vl);
}

function decompose(x: number): [bigint, number] {
  cvtF64[0] = x;
  const hi = cvtU32[1], lo = cvtU32[0];
  const ex = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e = -1074;
  if (ex !== 0) { m |= 1n << 52n; e = ex - 1075; }
  return [hi >>> 31 ? -m : m, e];
}

/** q * 2^k for an integer q <= 2^53 whose result is representable (or overflows). */
function ldexpExact(q: number, k: number): number {
  if (k > 900) return q * 2 ** 900 * 2 ** (k - 900);
  if (k < -900) return q * 2 ** (k + 600) * 2 ** -600;
  return q * 2 ** k;
}

/** Exact fma64 with BigInt arithmetic (slow path). */
function fma64Big(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || a === 0 || b === 0) return a * b + c;
  const [ma, ea] = decompose(a), [mb, eb] = decompose(b);
  const ep = ea + eb, mp = ma * mb;
  let s: bigint, emin: number;
  if (c === 0) { s = mp; emin = ep; } else {
    const [mc, ec] = decompose(c);
    emin = Math.min(ep, ec);
    s = (mp << BigInt(ep - emin)) + (mc << BigInt(ec - emin));
  }
  if (s === 0n) return 0;
  const neg = s < 0n;
  const A = neg ? -s : s;
  const L = A.toString(2).length;
  const shift = Math.max(L - 53, -1074 - emin);
  let r: number;
  if (shift <= 0) r = ldexpExact(Number(A), emin);
  else {
    const sh = BigInt(shift);
    let q = A >> sh;
    const rem = A - (q << sh), half = 1n << (sh - 1n);
    if (rem > half || (rem === half && (q & 1n) === 1n)) q += 1n;
    r = ldexpExact(Number(q), emin + shift);
  }
  return neg ? -r : r;
}

// ---------------------------------------------------------------------------
// Conversions

/** fcvtns (float -> int32, nearest even, saturating, NaN -> 0). */
function cvtns32(v: number): number {
  if (v !== v) return 0;
  if (v >= 2147483647) return 2147483647;
  if (v <= -2147483648) return -2147483648;
  let r = Math.round(v);
  if (r - v === 0.5 && r % 2 !== 0) r -= 1;
  return r;
}

/** fcvtns.2d as a double (int64 nearest even, saturating to +-2^63 after scvtf, NaN -> 0) and its parity. */
let cvtnsOdd = 0;
function cvtns64(v: number): number {
  if (v !== v) { cvtnsOdd = 0; return 0; }
  if (v >= 9223372036854775807) { cvtnsOdd = 1; return 9223372036854775808; }
  if (v <= -9223372036854775808) { cvtnsOdd = 0; return -9223372036854775808; }
  let r = Math.round(v);
  if (r - v === 0.5 && r % 2 !== 0) r -= 1;
  cvtnsOdd = Math.abs(r % 2);
  return r;
}

// ---------------------------------------------------------------------------
// Sums (vDSP_sve / vDSP_sveD, stride 1)

// vDSP_sve's vector accumulators: v0..v3 (16 lanes, element j of a 16-block goes
// to lane j) and the second set v20..v23 used from 96 elements on.
const sveV = new Float32Array(16);
const sveW = new Float32Array(16);

function add16(acc: Float32Array, src: Float32Array, p: number): void {
  for (let l = 0; l < 16; l++) acc[l] += src[p + l];
}

/**
 * ippsSum_32f -> vDSP_sve(src, 1, &sum, n), float32 result. Lane structure of
 * the NEON code: v0 = x[0..3], v1 = x[4..7], v2 | v3 = x[8..15]; from 32 on
 * x[16..31] is added lanewise to v0..v3, from 64 on 16-element blocks
 * alternate between v0..v3 and a second accumulator set (added back after the
 * loop) in 32-element steps; then v0 += v2, v1 += v3, v0 += v1, 4-element
 * steps into v0, a [x, x, 0, 0] + [x, 0, 0, 0] tail added lanewise, and the
 * pairwise (l0 + l1) + (l2 + l3).
 */
export function sum32f(src: Float32Array, n: number, off = 0): number {
  if (n <= 0) return 0;
  const v = sveV;
  v.fill(0);
  let p = off, rem = n;
  if (n >= 4) {
    for (let l = 0; l < 4; l++) v[l] = src[p + l];
    if (n < 8) { p += 4; rem = n - 4; } else {
      for (let l = 0; l < 4; l++) v[4 + l] = src[p + 4 + l];
      if (n < 16) { p += 8; rem = n - 8; } else {
        for (let l = 0; l < 8; l++) v[8 + l] = src[p + 8 + l];
        if (n < 32) { p += 16; rem = n - 16; } else {
          let s: number;
          if (n < 64) { s = p + 16; rem = n - 32; } else {
            add16(v, src, p + 16);
            s = p + 32;
            let x3 = n - 96;
            if (x3 >= 0) {
              const w = sveW;
              w.fill(0);
              while (x3 >= 0) {
                add16(v, src, s);
                add16(w, src, s + 16);
                s += 32;
                x3 -= 32;
              }
              for (let l = 0; l < 16; l++) v[l] += w[l];
            }
            add16(v, src, s);
            s += 16;
            rem = x3 + 32;
          }
          add16(v, src, s);
          p = s + 16;
        }
        for (let l = 0; l < 4; l++) { v[l] += v[8 + l]; v[4 + l] += v[12 + l]; }
      }
      for (let l = 0; l < 4; l++) v[l] += v[4 + l];
      while (rem >= 4) {
        for (let l = 0; l < 4; l++) v[l] += src[p + l];
        p += 4;
        rem -= 4;
      }
    }
  }
  if (rem > 0) {
    let b0 = 0, b1 = 0, c0 = 0;
    if (rem & 2) { b0 = src[p]; b1 = src[p + 1]; p += 2; }
    if (rem & 1) c0 = src[p];
    v[0] += b0; v[1] += b1; v[2] += 0; v[3] += 0;
    v[0] += c0; v[1] += 0; v[2] += 0; v[3] += 0;
  }
  return f32(f32(v[0] + v[1]) + f32(v[2] + v[3]));
}

/**
 * ippsSum_64f -> vDSP_sveD(src, 1, &sum, n) (8-byte aligned source). Below 24
 * elements: four 2-lane accumulators over 8-element steps. From 24 on: twelve
 * 2-lane accumulators over 24-element blocks (the last block is added at the
 * end), folded as (a16 + (a0 + a8)), (a18 + (a10 + a2)), (a20 + (a12 + a4)),
 * (a22 + (a14 + a6)); then 8-element steps, (b1 + b0) and (b3 + b2) combined,
 * 2-element steps, the pairwise lane sum and the odd last element.
 */
export function sum64f(src: Float64Array, n: number, off = 0): number {
  if (n <= 0) return 0;
  let p = off, rem = n;
  // v3, v2, v1, v0 (2 lanes each) of the 8-element stage
  let a30 = 0, a31 = 0, a20 = 0, a21 = 0, a10 = 0, a11 = 0, a00 = 0, a01 = 0;
  if (n >= 24) {
    // twelve accumulators, lane pairs of a 24-block: acc[j] for elements 2j, 2j+1
    const acc = sveAccD;
    acc.fill(0);
    let x9 = n - 24;
    let blk = p; // last loaded block
    p += 24;
    while (x9 > 23) {
      for (let j = 0; j < 24; j++) acc[j] += src[blk + j];
      blk = p;
      p += 24;
      x9 -= 24;
    }
    for (let j = 0; j < 24; j++) acc[j] = acc[j] + src[blk + j];
    // fold: v2 = acc01 + acc89; v6 = acc10_11 + acc23; v5 = acc12_13 + acc45; v4 = acc14_15 + acc67
    const v2a = acc[0] + acc[8], v2b = acc[1] + acc[9];
    const v6a = acc[10] + acc[2], v6b = acc[11] + acc[3];
    const v5a = acc[12] + acc[4], v5b = acc[13] + acc[5];
    const v4a = acc[14] + acc[6], v4b = acc[15] + acc[7];
    a30 = acc[16] + v2a; a31 = acc[17] + v2b;
    a20 = acc[18] + v6a; a21 = acc[19] + v6b;
    a10 = acc[20] + v5a; a11 = acc[21] + v5b;
    a00 = acc[22] + v4a; a01 = acc[23] + v4b;
    rem = x9;
  }
  while (rem >= 8) {
    a30 += src[p]; a31 += src[p + 1]; a20 += src[p + 2]; a21 += src[p + 3];
    a10 += src[p + 4]; a11 += src[p + 5]; a00 += src[p + 6]; a01 += src[p + 7];
    p += 8;
    rem -= 8;
  }
  let s0 = (a00 + a10) + (a20 + a30), s1 = (a01 + a11) + (a21 + a31);
  while (rem >= 2) {
    s0 += src[p];
    s1 += src[p + 1];
    p += 2;
    rem -= 2;
  }
  let r = s0 + s1;
  if (rem) r += src[p];
  return r;
}

const sveAccD = new Float64Array(24);

// ---------------------------------------------------------------------------
// Ramps (the library's own NEON loops)

/**
 * ippsVectorSlope_32f: dst[i] = fma32(float(i), slope, offset) (16-wide fmla
 * loop and fmadd tail compute the same expression). offset / slope are
 * rounded to float32 like the C float arguments.
 */
export function vectorSlope32f(dst: Float32Array, n: number, offset: number, slope: number, dstOff = 0): void {
  const o = f32(offset), s = f32(slope);
  for (let i = 0; i < n; i++) dst[dstOff + i] = fma32(f32(i), s, o);
}

/** ippsVectorSlope_64f: dst[i] = fma64(double(i), slope, offset). */
export function vectorSlope64f(dst: Float64Array, n: number, offset: number, slope: number, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = fma64(i, slope, offset);
}

// ---------------------------------------------------------------------------
// expm1 (vForce vvexpm1f; ippsExpm1_32f_A11 / A21 / A24)

const EM1_LO = bitsf32(0xc2ce8ed0); // -103.278931
const EM1_HI = bitsf32(0x42b17218); // 88.7228394
const LOG2E = bitsf32(0x3fb8aa3b);
const NLN2_HI = bitsf32(0xbf318000); // -0.693359375
const LN2_LO = bitsf32(0x395e8083);
const EM1_C6 = bitsf32(0x39506967), EM1_C5 = bitsf32(0x3ab743ce), EM1_C4 = bitsf32(0x3c088908);
const EM1_C3 = bitsf32(0x3d2aa9c1), EM1_C2 = bitsf32(0x3e2aaaaa);
const TWO_M33 = bitsf32(0x2f000000);

/**
 * One element of vvexpm1f (every path of the routine computes this):
 * x clamped to [-103.278931, 88.7228394], k = nearest(x*log2e), r = x - k*ln2
 * (two fused steps), q = r + r^2*P(r) (degree 5 in Horner fmas, constant 1/2),
 * then ((q + [k != 0]) * 2^(k-1)) * 2 - [k != 0] for x > 0 and
 * ((q + [k != 0]) * 2^(k+33)) * 2^-33 - [k != 0] for x <= 0.
 */
export function expm1f1(x: number): number {
  let v = x !== x ? x : x < EM1_LO ? EM1_LO : x;
  v = v !== v ? v : v > EM1_HI ? EM1_HI : v;
  const k = cvtns32(f32(v * LOG2E));
  const neg = v <= 0;
  let r = fma32(NLN2_HI, k, v);
  r = fma32(LN2_LO, k, r);
  let p = fma32(EM1_C6, r, EM1_C5);
  p = fma32(p, r, EM1_C4);
  p = fma32(p, r, EM1_C3);
  p = fma32(p, r, EM1_C2);
  p = fma32(p, r, 0.5);
  const q = fma32(f32(r * r), p, r);
  const m = k !== 0 ? -1 : 0;
  const scale = bitsf32((k + (neg ? 0xa0 : 0x7e)) << 23);
  return f32(f32(f32(f32(q - m) * scale) * (neg ? TWO_M33 : 2)) + m);
}

/** ippsExpm1_32f_A11 / A21 / A24 (all vvexpm1f). */
export function expm132f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = expm1f1(src[srcOff + i]);
}
export const expm132fA11 = expm132f;
export const expm132fA21 = expm132f;
export const expm132fA24 = expm132f;

// ---------------------------------------------------------------------------
// sin (vForce vvsinf; ippsSin_32f_A21 / A24)

// Payne-Hanek style table of vvsinf's large-argument path: for the even part
// e of the biased exponent, (T[e], T[e+1]) are the bits of 1/pi that matter
// modulo 2 at that magnitude (double; T[e] with 27 low bits clear).
const SIN_TAB_HEX =
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  'bfc7419f24000000bdeb1bbead603d8bbfad067c920000003dc391054a7f09d63f77cc1b720000003d9c882a53f84eb0bf6067c91b000000bd6bbead603d8a83' +
  'bf09f246c70000003d0054a7f09d5f48bf09f246c70000003d0054a7f09d5f48bf09f246c70000003d0054a7f09d5f483ee836e4e40000003d0054a7f09d5f48' +
  'becf246c6f0000003ca529fc2757d1f53e7b727221000000bc95ac07b1505c163e7b727221000000bc95ac07b1505c16be5236377d000000bc76b01ec5417056' +
  '3e4b9391050000003c629fc2757d1f53be21b1bbeb0000003c34fe13abe8fa9abdeb1bbead000000bc080f62a0b82b2dbdeb1bbead000000bc080f62a0b82b2d' +
  '3dc391054a0000003befc2757d1f534e3d9c882a54000000bb7ec54170565912bd6bbead60000000bb7ec54170565912bd6bbead60000000bb7ec54170565912' +
  '3d41054a7f0000003b33abe8fa9a6ee03d0054a7f1000000bb28a82e0acb223f3d0054a7f1000000bb28a82e0acb223f3ca529fc270000003ac5f47d4d377037' +
  '3ca529fc270000003ac5f47d4d3770373ca529fc270000003ac5f47d4d3770373c84a7f09d0000003aa7d1f534ddc0db3c629fc2750000003a8f47d4d377036e' +
  '3c34fe13ac000000ba370565911f924fbc2603d8a8000000ba370565911f924fbc080f62a10000003a21f534ddc0db633befc2757d00000039ef534ddc0db629' +
  'bb7ec54170000000b99596447e493ad5bb7ec54170000000b99596447e493ad5bb7ec54170000000b99596447e493ad53b33abe8fb000000b9596447e493ad4d' +
  '3b33abe8fb000000b9596447e493ad4dbb28a82e0b000000393a6ee06db14acd3b0d5f47d5000000b916447e493ad4cebad505c159000000b8f911f924eb5336' +
  '3ac5f47d4d00000038dbb81b6c52b3283aa7d1f535000000b8b11f924eb533623a8f47d4d300000038adc0db6295993cba37056591000000b83f924eb53361de' +
  'ba37056591000000b83f924eb53361de3a21f534de000000b83f924eb53361de39ef534ddc00000037db6c52b327887239ef534ddc00000037db6c52b3278872' +
  'b99596447e000000b7b24eb53361de38b99596447e000000b7b24eb53361de383984d3770300000037ab6295993c439039634ddc0e000000b78275a99b0ef1bf';
const SIN_TAB = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const h = SIN_TAB_HEX.substr(16 * i, 16);
  SIN_TAB[i] = bitsf64(parseInt(h.substr(0, 8), 16), parseInt(h.substr(8, 8), 16));
}

const SIN_BIG = bitsf32(0x49742400); // 1e6: fast path limit
const INV_PI = bitsf32(0x3ea2f983);
const NPI1 = bitsf32(0xc0490fdb), PI2 = bitsf32(0x33bbbd2e), PI3 = bitsf32(0x27772ced);
const PI_F = bitsf32(0x40490fdb);
const SF4 = bitsf32(0x362edef8), SF3 = bitsf32(0xb94fb7ff), SF2 = bitsf32(0x3c088766), SF1 = bitsf32(0xbe2aaaa6);
const SS4 = bitsf32(0x362ec33b), SS3 = bitsf32(0xb94fb6c5), SS2 = bitsf32(0x3c088767);

/**
 * vvsinf fast path (every lane of a 16-element group has |x| <= 1e6):
 * k = nearest(|x|/pi) in float, r = |x| - k*pi with three fused steps, sign
 * flipped for odd k, sin(r) = r + r^3*P(r^2) (fused Horner), sign of x.
 */
function sinFast(x: number): number {
  const a = Math.abs(x);
  const k = cvtns32(f32(a * INV_PI));
  let r = fma32(NPI1, k, a);
  r = fma32(PI2, k, r);
  r = fma32(PI3, k, r);
  if (k & 1) r = -r;
  const r2 = f32(r * r), r3 = f32(r2 * r);
  let p = fma32(SF4, r2, SF3);
  p = fma32(p, r2, SF2);
  p = fma32(p, r2, SF1);
  const s = fma32(p, r3, r);
  return x < 0 || (x === 0 && 1 / x < 0) ? -s : s;
}

/**
 * vvsinf large-argument path (used for a whole 16-element group as soon as
 * one lane has |x| > 1e6 or is not finite): in double, p = T[e]*x,
 * f = p - nearest(p) + T[e+1]*x (fused), negated for an odd integer part,
 * then in float f*pi and f + (f^2*P(f^2))*f with its own coefficients.
 */
function sinSlow(x: number): number {
  const e = (f32bits(x) >>> 23) & 0xfe;
  const p = SIN_TAB[e] * x;
  const k = cvtns64(p);
  const odd = cvtnsOdd;
  let r = fma64(SIN_TAB[e + 1], x, p - k);
  if (odd) r = -r;
  const f = f32(f32(r) * PI_F);
  const s2 = f32(f * f);
  let q = fma32(SS4, s2, SS3);
  q = fma32(q, s2, SS2);
  q = fma32(q, s2, SF1);
  return fma32(f32(s2 * q), f, f);
}

/** Whether all n values from off satisfy vvsinf's fast-path test 1e6 >= |x| (false for NaN). */
function allSmall(src: Float32Array, off: number, n: number, lim: number): boolean {
  for (let i = 0; i < n; i++) if (!(lim >= Math.abs(src[off + i]))) return false;
  return true;
}

/**
 * vvsinf over a vector. Lane groups as in the NEON code: n < 16 is one group;
 * otherwise a head group x[0..15] (written last), an aligned body of
 * 16-element groups starting at 16 - align, and a tail group x[n-16..n-1]
 * (written after the body), all read from the original inputs (in place is
 * exact). A group uses the fast path when all its lanes pass |x| <= 1e6.
 * align = (FL dst address mod 16) / 4 (0 for 16-byte aligned buffers).
 */
function sinVec(src: Float32Array, dst: Float32Array, n: number, srcOff: number, dstOff: number, align: number): void {
  if (n <= 0) return;
  if (n < 16) {
    const fast = allSmall(src, srcOff, n, SIN_BIG);
    for (let i = 0; i < n; i++) { const x = src[srcOff + i]; dst[dstOff + i] = fast ? sinFast(x) : sinSlow(x); }
    return;
  }
  const headFast = allSmall(src, srcOff, 16, SIN_BIG);
  const tailFast = allSmall(src, srcOff + n - 16, 16, SIN_BIG);
  const h = 16 - (align & 3);
  const groups = Math.max(0, Math.floor((n - h) / 16));
  const tail = n - h - 16 * groups !== 0;
  const tailStart = tail ? n - 16 : n;
  for (let g = 0; g < groups; g++) {
    const s = h + 16 * g;
    const fast = allSmall(src, srcOff + s, 16, SIN_BIG);
    const lo = Math.max(s, 16), hi = Math.min(s + 16, tailStart);
    for (let i = lo; i < hi; i++) { const x = src[srcOff + i]; dst[dstOff + i] = fast ? sinFast(x) : sinSlow(x); }
  }
  for (let i = Math.max(tailStart, 16); i < n; i++) { const x = src[srcOff + i]; dst[dstOff + i] = tailFast ? sinFast(x) : sinSlow(x); }
  for (let i = 0; i < 16; i++) { const x = src[srcOff + i]; dst[dstOff + i] = headFast ? sinFast(x) : sinSlow(x); }
}

/** ippsSin_32f_A21 (vvsinf). */
export function sin32fA21(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0, align = 0): void {
  sinVec(src, dst, n, srcOff, dstOff, align);
}
/** ippsSin_32f_A24 (also vvsinf). */
export const sin32fA24 = sin32fA21;

// ---------------------------------------------------------------------------
// Uniform random numbers (the library's own code)

// Four 32-bit LCG lanes (x' = 1664525 x + 1013904223), seeded with seed ^
// 0x01000000, seed ^ 0x10000, seed ^ 8 and seed; each step yields four floats
// u = (x >>> 9) * 2^-23 in [0, 1). The seed written back is lane 3.
const rng = new Uint32Array(4);
const rngU = new Float32Array(4);
function rngInit(seed: number): void {
  rng[0] = (seed ^ 0x01000000) >>> 0;
  rng[1] = (seed ^ 0x10000) >>> 0;
  rng[2] = (seed ^ 8) >>> 0;
  rng[3] = seed >>> 0;
}
function rngStep(): void {
  for (let l = 0; l < 4; l++) {
    const x = (Math.imul(rng[l], 1664525) + 1013904223) >>> 0;
    rng[l] = x;
    rngU[l] = (x >>> 9) * 1.1920928955078125e-7;
  }
}

/**
 * ippsRandUniform_Direct_32f(pDst, len, low, high, pSeed). Note FL's code
 * computes u*(high - low) - low (not + low): groups of four as
 * fl(fl(u*range) - low), the 1..3 remaining values as fma(u, range, -low).
 * seed[0] is updated (unchanged when n < 1).
 */
export function randUniform32f(dst: Float32Array, n: number, low: number, high: number, seed: Uint32Array, dstOff = 0): void {
  if (n < 1) return;
  const lo = f32(low), range = f32(f32(high) - lo);
  rngInit(seed[0]);
  let i = 0;
  for (; i + 3 < n; i += 4) {
    rngStep();
    for (let l = 0; l < 4; l++) dst[dstOff + i + l] = f32(f32(rngU[l] * range) - lo);
  }
  if (i < n) {
    rngStep();
    for (let l = 0; i + l < n; l++) dst[dstOff + i + l] = fma32(rngU[l], range, -lo);
  }
  seed[0] = rng[3];
}

/** ippsRandUniform_Direct_64f: as the 32f version in double, u*(high - low) - low (separate mul and sub). */
export function randUniform64f(dst: Float64Array, n: number, low: number, high: number, seed: Uint32Array, dstOff = 0): void {
  if (n < 1) return;
  const range = high - low;
  rngInit(seed[0]);
  for (let i = 0; i < n; i += 4) {
    rngStep();
    for (let l = 0; l < 4 && i + l < n; l++) dst[dstOff + i + l] = rngU[l] * range - low;
  }
  seed[0] = rng[3];
}

// ---------------------------------------------------------------------------
// Division (vForce vvdivf: plain IEEE fdiv lanes)

/** ippsDiv_32f_A11 / A21 / A24(pSrc1, pSrc2, pDst, len): FL's library computes dst = src1 / src2. */
export function div32f(src1: Float32Array, src2: Float32Array, dst: Float32Array, n: number, off1 = 0, off2 = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src1[off1 + i] / src2[off2 + i];
}
export const div32fA11 = div32f;
export const div32fA21 = div32f;
export const div32fA24 = div32f;

// ---------------------------------------------------------------------------
// APPROXIMATIONS still to be replaced by exact ports (marked APPROX): libm
// results rounded to float32, typically within 1 ulp of FL's.





// powx: see the exact port below (section "pow").







/** Alias of expm132fA11. */
export const expm1_32fA11 = expm132f;

// ---------------------------------------------------------------------------
// Reciprocal estimate / step (architecturally defined ARM FRECPE / FRECPS)

/** ARM FRECPE (single, FPCR default): 8-bit table-free reciprocal estimate. */
export function frecpe32(x: number): number {
  const b = f32bits(x);
  const sign = b & 0x80000000;
  const ex = (b >>> 23) & 0xff;
  let frac = b & 0x7fffff;
  if (ex === 0xff) return frac ? NaN : sign ? -0 : 0;
  if (ex === 0 && frac === 0) return sign ? -Infinity : Infinity;
  if (Math.abs(x) < 2.938735877055719e-39) return sign ? -Infinity : Infinity; // 2^-128: overflow
  let e = ex;
  if (e === 0) {
    if ((frac & 0x400000) === 0) { e = -1; frac = (frac & 0x1fffff) << 2; } else frac = (frac & 0x3fffff) << 1;
  }
  const a = (256 | (frac >>> 15)) * 2 + 1;
  const r = (Math.floor(524288 / a) + 1) >> 1;
  let re = 253 - e;
  let rf = (r & 0xff) << 15;
  if (re === 0) rf = 0x400000 | (rf >>> 1);
  else if (re === -1) { rf = 0x200000 | (rf >>> 2); re = 0; }
  return bitsf32((sign | (re << 23) | rf) >>> 0);
}

/** ARM FRECPS: 2 - a*b fused (2 for inf * 0). */
export function frecps32(a: number, b: number): number {
  if ((a === 0 && Math.abs(b) === Infinity) || (b === 0 && Math.abs(a) === Infinity)) return 2;
  return fma32(-a, b, 2);
}

// ---------------------------------------------------------------------------
// pow (vForce vvpowsf; ippsPowx_32f_A11 / A21 / A24)

const PW_TA = [0x42fe0000, 0x42fda900, 0x42fd5b2c, 0x42fd14c4, 0x42fcd480, 0x42fc9960, 0x42fc62a2, 0x42fc2fac].map(bitsf32);
const PW_TB = [0x00000000, 0xb651cfdf, 0x35f6865c, 0x37307f34, 0xb5d1cfdf, 0xb48e4789, 0x364055fe, 0x3492d9f8].map(bitsf32);
const PW_T2 = [0x3f800000, 0x3f8b95c2, 0x3f9837f0, 0x3fa5fed7, 0x3fb504f3, 0x3fc5672a, 0x3fd744fd, 0x3feac0c7].map(bitsf32);
const PW_C7 = bitsf32(0x3e547ede), PW_C6 = bitsf32(0xbe777cc7), PW_C5 = bitsf32(0x3e93badc), PW_C4 = bitsf32(0xbeb8a9ea);
const PW_C3 = bitsf32(0x3ef6384f), PW_D1 = bitsf32(0xb239c255), PW_D0 = bitsf32(0x32a56f15);
const PW_L1 = bitsf32(0x3fb8aa3b), PW_L2 = bitsf32(0xbf38aa3b);
const PW_SH = bitsf32(0x49c003f8), PW_NSH = bitsf32(0xc9c003f8); // +-(1.5*2^20 + 127)
const PW_E3 = bitsf32(0x3d636078), PW_E2 = bitsf32(0x3e7607c9), PW_E1 = bitsf32(0x3f317218);
const PW_XMAX = bitsf32(0x7e400000), PW_XMIN = bitsf32(0x00800000), PW_TMAX = bitsf32(0x42fb0000);

let powSpecial = false;
/**
 * One lane of vvpowsf's vector path (x^y). log2(x): c = reciprocal estimate of
 * x refined once and rounded to 4 significant bits, u = c*x - 1, log2(x) =
 * (TA - E) + log2e*u - log2e/2*u^2 (with exact error terms) + TB + u*P(u);
 * times y as a float-float product; exp2 by rounding to 1/8 with the
 * 1.5*2^20 + 127 shifter, 2^(i/8) table and a cubic, scaled by the exponent
 * bits. Sets powSpecial when FL instead calls libm powf for the lane
 * (x < 2^-126, x > 6.338e37 or NaN, |y*log2 x| > 125.5 or NaN).
 */
function powLane(x: number, y: number): number {
  const r0 = frecpe32(x);
  const r1 = f32(r0 * frecps32(x, r0));
  const rb = (f32bits(r1) + 0x80000) >>> 0;
  const c = bitsf32((rb & 0xfff00000) >>> 0);
  const u = fma32(c, x, -1);
  const idx = (rb >>> 20) & 7;
  const hi0 = f32(PW_TA[idx] - (rb >>> 23));
  const u2 = f32(u * u);
  const a = fma32(PW_C7, u, PW_C6);
  const b = fma32(PW_C5, u, PW_C4);
  const p1 = fma32(u2, a, b);
  const p2 = fma32(u, p1, PW_C3);
  const p3 = fma32(PW_D1, u, PW_D0);
  const P = fma32(u2, p2, p3);
  const l1 = fma32(PW_L1, u, hi0);
  const l2 = fma32(PW_L2, u2, l1);
  const d1 = f32(l1 - hi0);
  const e2 = fma32(PW_L2, u2, -f32(l2 - l1));
  const e1 = fma32(PW_L1, u, -d1);
  const lo = fma32(u, P, f32(f32(e1 + PW_TB[idx]) + e2));
  const ph = f32(l2 * y);
  const T = fma32(y, lo, ph);
  const tlo = f32(fma32(y, l2, -ph) + fma32(y, lo, -f32(T - ph)));
  const sh = f32(T + PW_SH);
  const n8 = f32(sh + PW_NSH);
  const f = f32(f32(T - n8) + tlo);
  const q = fma32(PW_E3, f, PW_E2);
  const q2 = fma32(f, q, PW_E1);
  const t2 = PW_T2[f32bits(sh) & 7];
  const m = fma32(q2, f32(f * t2), t2);
  const scale = bitsf32(((f32bits(sh) << 20) & 0x7f800000) >>> 0);
  powSpecial = x < PW_XMIN || !(x <= PW_XMAX) || !(Math.abs(T) <= PW_TMAX);
  return f32(m * scale);
}

// Apple libm powf (libsystem_m, used by vvpowsf for its special lanes):
// double-precision 128*log2(x) from a 128-entry (1/c, 128*log2 c) table and a
// quartic, times y, clamped to +-32768, exp2 from a 128-entry table of
// 2^(i/128) bit patterns (pre-biased by -(i << 45)) and a quadratic, rounded
// once to float.
function hexDoubles(h: string): Float64Array {
  const n = h.length / 16, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = bitsf64(parseInt(h.substr(16 * i, 8), 16), parseInt(h.substr(16 * i + 8, 8), 16));
  return out;
}
const PF_T1 = hexDoubles(
  '3ff6c16c16c16c17c05042bd4b9a7c993ff6a13cd1537290c050014332be00333ff6816816816817c04f804ae8d0cd023ff661ec6a5122f9c04efec61b011f85' +
  '3ff642c8590b2164c04e7df5fe538ab33ff623fa77016240c04dfdd89d586e2b3ff6058160581606c04d7e6c0abc35793ff5e75bb8d015e7c04cffae611ad12b' +
  '3ff5c9882b931057c04c819dc2d45fe43ff5ac056b015ac0c04c043859e2fdb33ff58ed2308158edc04b877c57b1b0703ff571ed3c506b3ac04b0b67f4f46810' +
  '3ff5555555555555c04a8ff971810a5e3ff5390948f40febc04a152f142981b43ff51d07eae2f815c0499b072a96c6b23ff5015015015015c04921800924dd3b' +
  '3ff4e5e0a72f0539c048a8980abfbd323ff4cab88725af6ec048304d90c11fd33ff4afd6a052bf5bc047b89f02cf2aad3ff49539e3b2d067c047418acebbf18f' +
  '3ff47ae147ae147bc046cb0f6865c8ea3ff460cbc7f5cf9ac046552b499862773ff446f86562d9fbc045dfdcf1eeae0e3ff42d6625d51f87c0456b22e6b578e5' +
  '3ff4141414141414c044f6fbb2cec5983ff3fb013fb013fbc0448365e695d7973ff3e22cbce4a902c044106017c3eca33ff3c995a47babe7c0439de8e1559f6f' +
  '3ff3b13b13b13b14c0432bfee370ee683ff3991c2c187f63c042baa0c34be1ec3ff3813813813814c04249cd2b13cd6c3ff3698df3de0748c041d982c9d52708' +
  '3ff3521cfb2b78c1c04169c05363f1583ff33ae45b57bcb2c040fa848044b3513ff323e34a2b10bfc0408bce0d95fa383ff30d190130d190c0401d9bbcfa61d4' +
  '3ff2f684bda12f68c03f5fd8a9063e353ff2e025c04b8097c03e857d3d3613683ff2c9fb4d812ca0c03dac22d3e441d33ff2b404ad012b40c03cd3c712d31109' +
  '3ff29e4129e4129ec03bfc67a7fff4cc3ff288b01288b013c03b2602497d53463ff27350b8812735c03a5094b54d28283ff25e22708092f1c0397c1cb13c7ec1' +
  '3ff2492492492492c038a8980abfbd323ff23456789abcdfc037d60496cfbb4c3ff21fb78121fb78c037046031c79f853ff20b470c67c0d9c03633a8bf437ce1' +
  '3ff1f7047dc11f70c03563dc29ffacb23ff1e2ef3b3fb874c03494f863b8df353ff1cf06ada2811dc033c6fb650cde513ff1bb4a4046ed29c032f9e32d5bfdd1' +
  '3ff1a7b9611a7b96c0322dadc2ab34973ff19453808ca29cc03162593186da703ff1811811811812c03097e38ce606493ff16e0689427379c02f9c95dc1d1165' +
  '3ff15b1e5f75270dc02e0b1ae8f2fd563ff1485f0e0acd3bc02c7b528b70f1c53ff135c81135c811c02aed391ab6674e3ff12358e75d3033c02960caf9abb7ca' +
  '3ff1111111111111c027d60496cfbb4c3ff0fef010fef011c0264ce26c0671573ff0ecf56be69c90c024c560fe68af883ff0db20a88f4696c0233f7cde14cf5a' +
  '3ff0c9714fbcda3bc021bb32a600549d3ff0b7e6ec259dc8c020387efbca869e3ff0a6810a6810a7c01d6ebd1f1febfe3ff0953f39010954c01a6f9c377dd31b' +
  '3ff0842108421084c0177394c9d958d53ff073260a47f7c6c0147aa07357704f3ff0624dd2f1a9fcc01184b8e4c56af83ff05197f7d73404c00d23afc49139f9' +
  '3ff0410410410410c00743ee861f35563ff03091b51f5e1ac0016a21e20a0a453ff0204081020408bff72c7ba20f73273ff0101010101010bfe720d9c06a835f' +
  '3ff000000000000000000000000000003fefc07f01fc07f03ff6fe50b6ef08513fef81f81f81f8204006e79685c2d22a3fef44659e4a427140111cd1d5133413' +
  '3fef07c1f07c1f084016bad3758efd873feecc07b301ecc0401c4dfab90aab5f3fee9131abf0b7674020eb389fa29f9b3fee573ac901e5744023aa2fdd27f1c3' +
  '3fee1e1e1e1e1e1e402663f6fac913163fede5d6e3f8868a402918a16e46335b3fedae6076b981db402bc84240adabba3fed77b654b82c34402e72ec117fa5b2' +
  '3fed41d41d41d41d40308c588cda79e43fed0cb58f6ec0744031dcd197552b7b3fecd85689039b0b40332ae9e278ae1a3feca4b3055ee191403476a9f983f74d' +
  '3fec71c71c71c71c4035c01a39fbd6883fec3f8f01c3f8f040370742d4ef027f3fec0e070381c0e040384c2bd02f03b33febdd2b899406f740398edd077e70df' +
  '3febacf914c1bad0403acf5e2db4ec943feb7d6c3dda338b403c0db6cdd94dee3feb4e81b4e81b4f403d49ee4c3259703feb2036406c80d9403e840be74e6a4d' +
  '3feaf286bca1af28403fbc16b902680a3feac5701ac5701b4040790adbb030093fea98ef606a63be40411307dad30b763fea6d01a6d01a6d4041ac05b291f070' +
  '3fea41a41a41a41a40424407ab0e073a3fea16d3f97a4b024042db10fc4d9aaf3fe9ec8e951033d940437124cea4cded3fe9c2d14ee4a102404406463b1b0449' +
  '3fe999999999999a40449a784bcd1b8b3fe970e4f80cb87240452dbdfc4c96b33fe948b0fcd6e9e04045c01a39fbd6883fe920fb49d0e2294046518fe4677ba7' +
  '3fe8f9c18f9c18fa4046e221cd9d0cde3fe8d3018d3018d3404771d2ba7efb3c3fe8acb90f6bf3aa404800a563161c543fe886e5f0abb04a40488e9c72e0b226' +
  '3fe861861861861840491bba891f17093fe83c977ab2bedd4049a802391e232f3fe8181818181818404a33760a7f60513fe7f405fd017f40404abe18797f1f49' +
  '3fe7d05f417d05f4404b47ebf73882a13fe7ad2208e0ecc3404bd0f2e9e790313fe78a4c8178a4c8404c592fad295b563fe767dce434a9b1404ce0a4923a587d' +
  '3fe745d1745d1746404d6753e032ea0f3fe724287f46debc404ded3fd442364c3fe702e05c0b8170404e726aa1e754d23fe6e1f76b4337c7404ef6d67328e220');
const PF_T2_HEX =
  '3ff00000000000003feff63da9fb33353fefec9a3e7780613fefe315e86e7f853fefd9b0d31585743fefd06b29ddf6de3fefc74518759bc83fefbe3ecac6f383' +
  '3fefb5586cf9890f3fefac922b7247f73fefa3ec32d3d1a23fef9b66affed31b3fef9301d0125b513fef8abdc06c31cc3fef829aaea92de03fef7a98c8a58e51' +
  '3fef72b83c7d517b3fef6af9388c8dea3fef635beb6fcb753fef5be084045cd43fef54873168b9aa3fef4d5022fcd91d3fef463b88628cd63fef3f49917ddc96' +
  '3fef387a6e7562383fef31ce4fb2a63f3fef2b4565e27cdd3fef24dfe1f563813fef1e9df51fdee13fef187fd0dad9903fef1285a6e4030b3fef0cafa93e2f56' +
  '3fef06fe0a31b7153fef0170fc4cd8313feefc08b26416ff3feef6c55f929ff13feef1a7373aa9cb3feeecae6d05d8663feee7db34e59ff73feee32dc313a8e5' +
  '3feedea64c1234223feeda4504ac801c3feed60a21f72e2a3feed1f5d950a8973feece086061892d3feeca41ed1d00573feec6a2b5c13cd03feec32af0d7d3de' +
  '3feebfdad5362a273feebcb299fddd0d3feeb9b2769d2ca73feeb6daa2cf66423feeb42b569d4f823feeb1a4ca5d920f3feeaf4736b527da3feead12d497c7fd' +
  '3feeab07dd4854293feea9268a5946b73feea76f15ad21483feea5e1b976dc093feea47eb03a55853feea34634ccc3203feea238825522253feea155d44ca973' +
  '3feea09e667f3bcd3feea012750bdabf3fee9fb23c651a2f3fee9f7df95194843fee9f75e8ec5f743fee9f9a48a581743fee9feb564267c93feea0694fde5d3f' +
  '3feea11473eb01873feea1ed0130c1323feea2f336cf4e623feea427543e1a123feea589994cce133feea71a4623c7ad3feea8d99b4492ed3feeaac7d98a6699' +
  '3feeace5422aa0db3feeaf3216b5448c3feeb1ae991577363feeb45b0b91ffc63feeb737b0cdc5e53feeba44cbc8520f3feebd829fde4e503feec0f170ca07ba' +
  '3feec49182a3f0903feec86319e323233feecc667b5de5653feed09bec4a2d333feed503b23e255d3feed99e1330b3583feede6b5579fdbf3feee36bbfd3f37a' +
  '3feee89f995ad3ad3feeee07298db6663feef3a2b84f15fb3feef9728de5593a3feeff76f2fb5e473fef05b030a1064a3fef0c1e904bc1d23fef12c25bd71e09' +
  '3fef199bdd85529c3fef20ab5fffd07a3fef27f12e57d14b3fef2f6d9406e7b53fef3720dcef90693fef3f0b555dc3fa3fef472d4a07897c3fef4f87080d89f2' +
  '3fef5818dcfba4873fef60e316c983983fef69e603db32853fef7321f301b4603fef7c97337b9b5f3fef864614f5a1293fef902ee78b3ff63fef9a51fbc74c83' +
  '3fefa4afa2a490da3fefaf482d8e67f13fefba1bee615a273fefc52b376bba973fefd0765b6e45403fefdbfdad9cbe143fefe7c1819e90d83feff3c22b8f71f1';
const PF_T2HI = new Int32Array(128), PF_T2LO = new Uint32Array(128);
for (let i = 0; i < 128; i++) {
  PF_T2HI[i] = parseInt(PF_T2_HEX.substr(16 * i, 8), 16) | 0;
  PF_T2LO[i] = parseInt(PF_T2_HEX.substr(16 * i + 8, 8), 16) >>> 0;
}
const PF_C = hexDoubles('c0471559dca827eb404ec71c53b3b1e8c05715476529654c40671547652aef42');
const PF_E = hexDoubles('3eeebfbdff30d6563f762e4453e10dae');

/** Apple libm powf(x, y) for float32 x, y (C99 special cases as in the binary). */
export function powfLibm(x: number, y: number): number {
  if (x === 1) return 1;
  if (y === 1) return x;
  const wx = f32bits(x), wy = f32bits(y);
  const ay = wy & 0x7fffffff;
  let sign = false;
  let w0 = wx;
  if (((ay - 1) >>> 0) >= 0x7f7fffff) {
    if (ay > 0x7f800000) return NaN;
    if (ay === 0) return 1;
    const ax = wx & 0x7fffffff; // y = +-inf
    if (ax === 0) return powZeroInf(x, wy);
    if (ax > 0x7f800000) return NaN;
    if (ax === 0x3f800000) return 1;
    return ((ax - 0x3f800000) ^ wy) < 0 ? 0 : Infinity;
  }
  if (((wx - 0x800000) >>> 0) >= 0x7f000000) {
    const ax = wx & 0x7fffffff;
    if (((ax - 1) >>> 0) >= 0x7f7fffff) {
      if (ax > 0x7f800000) return NaN;
      return powZeroInf(x, wy);
    }
    if (wx & 0x80000000) {
      if (ay < 0x3f800000) return NaN;
      const yc = bitsf32(ay <= 0x4b800000 ? ay : 0x4b800000);
      if (Math.trunc(yc) !== yc) return NaN;
      if (yc & 1) sign = true;
      w0 = ax;
    }
    if (w0 < 0x800000) w0 = (f32bits(f32(bitsf32((w0 | 0x3f800000) >>> 0) - 1)) - 0x3f000000) | 0;
  }
  const d = (w0 - 0x3f338000) | 0;
  const idx = (d >> 16) & 0x7f;
  const eb = d & 0xff800000;
  const m = bitsf32((w0 - eb) >>> 0);
  const r = fma64(m, PF_T1[2 * idx], -1);
  const hi = PF_T1[2 * idx + 1] + (eb >> 16);
  const r2 = r * r;
  const a = fma64(fma64(r, PF_C[0], PF_C[1]), r2, fma64(r, PF_C[2], PF_C[3]));
  const L = fma64(a, r, hi);
  let t = y * L;
  if (t > 32768) t = 32768;
  if (t < -32768) t = -32768;
  const n = t < 0 ? -Math.floor(0.5 - t) : Math.floor(t + 0.5);
  const f = t - n;
  const i = n & 127;
  const scale = bitsf64((PF_T2HI[i] + n * 8192) | 0, PF_T2LO[i]);
  const res = f32(fma64(fma64(PF_E[0], f, PF_E[1]) * f, scale, scale));
  return sign ? -res : res;
}

/** powf for x = +-0 or +-inf (and y = +-inf with x = +-0): sign kept for odd integer y, reciprocal for y < 0. */
function powZeroInf(x: number, wy: number): number {
  const ay = wy & 0x7fffffff;
  let r = x;
  if (ay < 0x3f800000) r = Math.abs(x);
  else {
    const yc = bitsf32(ay <= 0x4b800000 ? ay : 0x4b800000);
    if (Math.trunc(yc) !== yc || !(yc & 1)) r = Math.abs(x);
  }
  if (wy & 0x80000000) r = f32(1 / r);
  return r;
}

/** One element of vvpowsf. */
export function powf1(x: number, y: number): number {
  const r = powLane(x, y);
  return powSpecial ? powfLibm(x, y) : r;
}

/** ippsPowx_32f_A11 / A21 / A24(pSrc, val, pDst, len): dst = src^val (vvpowsf). */
export function powx32f(src: Float32Array, val: number, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  const y = f32(val);
  for (let i = 0; i < n; i++) dst[dstOff + i] = powf1(src[srcOff + i], y);
}
export const powx32fA11 = powx32f;
export const powx32fA21 = powx32f;
export const powx32fA24 = powx32f;

// ---------------------------------------------------------------------------
// exp (vForce vvexpf; ippsExp_32f_A11 / A21 / A24)

const EXP_LO = bitsf32(0xc2cff1b5); // -103.972084
const EXP_HI = bitsf32(0x42b17218); // 88.7228394
const EXP_C6 = bitsf32(0x3aea6bc0), EXP_C5 = bitsf32(0x3c045bfb), EXP_C4 = bitsf32(0x3d2aee9a);
const EXP_C3 = bitsf32(0x3e2aa92b), EXP_C2 = bitsf32(0x3f000001);
const TWO_M127 = bitsf32(0x00400000);

/**
 * One element of vvexpf: x clamped to [-103.972084, 88.7228394], k =
 * floor(x*log2e), r = x - k*ln2 (two fused steps), e^r = 1 + r*(1 + r*P(r))
 * (fused Horner, degree 6), times 2^k built from the exponent bits (k <= -127
 * as 2^(k+127) * 2^-127).
 */
export function expf1(x: number): number {
  let v = x !== x ? x : x < EXP_LO ? EXP_LO : x;
  v = v !== v ? v : v > EXP_HI ? EXP_HI : v;
  const k = Math.floor(f32(v * LOG2E));
  let r = fma32(NLN2_HI, k, v);
  r = fma32(LN2_LO, k, r);
  let p = fma32(EXP_C6, r, EXP_C5);
  p = fma32(p, r, EXP_C4);
  p = fma32(p, r, EXP_C3);
  p = fma32(p, r, EXP_C2);
  p = fma32(p, r, 1);
  const q = fma32(r, p, 1);
  const ki = k !== k ? 0 : k;
  const e = ki + 0x7f;
  if (e <= 0) return f32(f32(q * bitsf32((ki + 0xfe) << 23)) * TWO_M127);
  return f32(q * bitsf32(e << 23));
}

/** ippsExp_32f_A11 / A21 / A24 (all vvexpf). */
export function exp32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = expf1(src[srcOff + i]);
}
export const exp32fA11 = exp32f;
export const exp32fA21 = exp32f;
export const exp32fA24 = exp32f;

// ---------------------------------------------------------------------------
// ln (vForce vvlogf; ippsLn_32f_A11 / A21 / A24)

// 1/c and log2(c) (offset by -1 from index 4 on, where the exponent is taken
// one higher) for the 3 rounded leading mantissa bits.
const LN_TA = [0x3f800000, 0x3f642f47, 0x3f4d34fa, 0x3f3a8deb, 0x3f2ad23b, 0x3f1d7339, 0x3f12c6ac, 0x3f0827e9, 0x3f000000].map(bitsf32);
const LN_TB = [0x00000000, 0x3e29ecac, 0x3ea35c65, 0x3ee9c09e, 0xbed52af4, 0xbe98f5dc, 0xbe4a3655, 0xbdb68248, 0x00000000].map(bitsf32);
const LN_W1 = bitsf32(0xbf38aa2d), LN_W2 = bitsf32(0x3fb8aa3b), LN_W3 = bitsf32(0xbeb92e1d), LN_W4 = bitsf32(0x3ef63993);
const LN_W5 = bitsf32(0x3e920aa5);
const LN2F = bitsf32(0x3f317218);

/**
 * One element of vvlogf: x = 2^E * 1.m with E taken one higher for 1.m >=
 * 1.4375 (denormals normalised with clz), i = rounded top 3 mantissa bits,
 * u = 1.m * (1/c_i) - 1, log2 x = u*(W2 + W1 u + u^2 (W4 + W3 u)) + (E +
 * log2 c_i + u^4 * (u*W5)), times ln2 in float. 0 -> -inf, +inf -> +inf,
 * negative or NaN -> NaN.
 */
export function lnf1(x: number): number {
  if (!(x > 0) || x === Infinity) return x === 0 ? -Infinity : x === Infinity ? Infinity : NaN;
  const b = f32bits(x);
  let m: number, E: number;
  if (b < 0x800000) {
    const lz = Math.clz32(b);
    m = (b << (lz - 8)) & 0x7fffff;
    E = (((m + 0xc0c80000) | 0) >> 23) - lz + 9;
  } else {
    m = b & 0x7fffff;
    E = ((b + 0xc0c80000) | 0) >> 23;
  }
  const idx = (m + 0x80000) >> 20;
  const u = fma32(LN_TA[idx], bitsf32(m | 0x3f800000), -1);
  const u2 = f32(u * u);
  const P = fma32(u2, fma32(LN_W3, u, LN_W4), fma32(LN_W1, u, LN_W2));
  const t = fma32(f32(u2 * u2), f32(u * LN_W5), f32(E + LN_TB[idx]));
  return f32(f32(f32(u * P) + t) * LN2F);
}

/** ippsLn_32f_A11 / A21 / A24 (all vvlogf). */
export function ln32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = lnf1(src[srcOff + i]);
}
export const ln32fA11 = ln32f;
export const ln32fA21 = ln32f;
export const ln32fA24 = ln32f;

// ---------------------------------------------------------------------------
// tanh (vForce vvtanhf; ippsTanh_32f_A11 / A24)

const TH_CLAMP = bitsf32(0x42b17217); // 88.7228317

/**
 * One element of vvtanhf: t = min(2|x|, 88.7228317), e = expm1(t) with the
 * vvexpm1f kernel (k = nearest(t*log2e), ((q + [k != 0]) * 2^(k-1)) * 2 -
 * [k != 0]), tanh = e / (e + 2), sign of x or'ed in.
 */
export function tanhf1(x: number): number {
  const a = Math.abs(x);
  let t = f32(a + a);
  t = t !== t ? t : t > TH_CLAMP ? TH_CLAMP : t;
  const k = cvtns32(f32(t * LOG2E));
  let r = fma32(NLN2_HI, k, t);
  r = fma32(LN2_LO, k, r);
  let p = fma32(EM1_C6, r, EM1_C5);
  p = fma32(p, r, EM1_C4);
  p = fma32(p, r, EM1_C3);
  p = fma32(p, r, EM1_C2);
  p = fma32(p, r, 0.5);
  const q = fma32(f32(r * r), p, r);
  const m = k !== 0 ? -1 : 0;
  const e = f32(f32(q - m) * bitsf32(((k << 23) + 0x3f000000) >>> 0));
  const em1 = f32(f32(e + e) + m);
  const res = f32(em1 / f32(em1 + 2));
  return x < 0 || (x === 0 && 1 / x < 0) || (x !== x && f32bits(x) >>> 31) ? -res : res;
}

/** ippsTanh_32f_A11 / A24 (vvtanhf). */
export function tanh32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = tanhf1(src[srcOff + i]);
}
export const tanh32fA11 = tanh32f;
export const tanh32fA24 = tanh32f;

// ---------------------------------------------------------------------------
// sqrt (vForce vvsqrtf; ippsSqrt_32f_A11 / A21 / A24)

// ARM RecipSqrtEstimate for scaled inputs 128..511 (FPCR.AH = 0).
const RSQRT_EST = new Int32Array(512);
for (let a0 = 128; a0 < 512; a0++) {
  const a = a0 < 256 ? a0 * 2 + 1 : (((a0 >> 1) << 1) + 1) * 2;
  let b = 512;
  while (a * (b + 1) * (b + 1) < 268435456) b++;
  RSQRT_EST[a0] = (b + 1) >> 1;
}

/** ARM FRSQRTE (single, FPCR default). */
export function frsqrte32(x: number): number {
  const bits = f32bits(x);
  let ex = (bits >>> 23) & 0xff;
  let frac = bits & 0x7fffff;
  if (ex === 0xff && frac) return NaN;
  if (ex === 0 && frac === 0) return bits >>> 31 ? -Infinity : Infinity;
  if (bits >>> 31) return NaN;
  if (ex === 0xff) return 0;
  if (ex === 0) {
    while ((frac & 0x400000) === 0) { frac <<= 1; ex--; }
    frac = (frac << 1) & 0x7fffff;
  }
  const scaled = (ex & 1) === 0 ? 256 | (frac >>> 15) : 128 | (frac >>> 16);
  const re = Math.floor((380 - ex) / 2);
  return bitsf32(((re & 0xff) << 23) | ((RSQRT_EST[scaled] & 0xff) << 15));
}

/** ARM FRSQRTS: (3 - a*b) / 2 fused (1.5 for inf * 0). */
export function frsqrts32(a: number, b: number): number {
  if ((a === 0 && Math.abs(b) === Infinity) || (b === 0 && Math.abs(a) === Infinity)) return 1.5;
  return f32(fma32(-a, b, 3) * 0.5);
}

/**
 * One element of vvsqrtf: e = frsqrte(x) refined by two frsqrts Newton steps
 * (e *= frsqrts(x*e, e)), result x*e; +inf and +-0 pass through unchanged.
 */
export function sqrtf1(x: number): number {
  if (x === 0 || x === Infinity) return x;
  let e = frsqrte32(x);
  e = f32(e * frsqrts32(f32(x * e), e));
  e = f32(e * frsqrts32(f32(x * e), e));
  return f32(x * e);
}

/** ippsSqrt_32f_A11 / A21 / A24 and ippsSqrt_32f (all vvsqrtf). */
export function sqrt32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = sqrtf1(src[srcOff + i]);
}
export const sqrt32fA11 = sqrt32f;
export const sqrt32fA21 = sqrt32f;
export const sqrt32fA24 = sqrt32f;

// ---------------------------------------------------------------------------
// cbrt (the library's own NEON code for groups of four, Apple libm cbrtf for
// the n % 4 remaining elements; ippsCbrt_32f_A11 / A24 are identical)

// libm cbrtf table: for 64 leading-mantissa cells x 3 exponent residues,
// (c = r^3, r, 1/c) in double.
const CBF_TAB = hexDoubles(
  '3ff00000000000003ff00000000000003ff0000000000000400037e2000000003ff44000000000003fdf91bd1b62b9cf' +
  '40103158000000003ff98000000000003fcf9e7cba5753af3ff060c0800000003ff02000000000003fef42f61dacddc6' +
  '40005ff4c356ff403ff450a0000000003fdf447b132ca3ac40106e9aa00000003ff9a000000000003fcf289bb31fd41c' +
  '3ff09fe97c0b2e803ff034a0000000003feecc3168ac46e44000853ec00000003ff46000000000003fdefde7dcdacefd' +
  '4010ac77000000003ff9c000000000003fceb501ca81bb3e3ff0c304000000003ff04000000000003fee8bb1d5b6e585' +
  '4000d390000000003ff48000000000003fde6da80ced15234010eaede00000003ff9e000000000003fce43a0fc24fe4b' +
  '3ff126cd800000003ff06000000000003fedd9fb30af3365400122d7400000003ff4a000000000003fdde0e209af882e' +
  '40112a00000000003ffa0000000000003fcdd46baab49c243ff15f9b5b4800003ff07200000000003fed786108fd7a9f' +
  '40017316000000003ff4c000000000003fdd577b2f5c6f87401169ae200000003ffa2000000000003fcd67549c6f9b67' +
  '3ff18c20000000003ff08000000000003fed2d9cbd756afd40019fb2ce6205403ff4d1a0000000003fdd0d34ccd78141' +
  '4011a9f9000000003ffa4000000000003fccfc4ef7db5bff3ff1f2fe800000003ff0a000000000003fec86636f753a66' +
  '4001c44dc00000003ff4e000000000003fdcd159cdbba7144011eae1600000003ffa6000000000003fcc934e4095d202' +
  '3ff21fac7ca59c003ff0adc0000000003fec40112c606d3e40021680000000003ff50000000000003fdc4e651e0c37d7' +
  '40122c68000000003ffa8000000000003fcc2c46544650c13ff25b6c000000003ff0c000000000003febe41e7ee3f7ed' +
  '400269ae400000003ff52000000000003fdbce853967753c40126e8da00000003ffaa000000000003fcbc72b67ab9ce7' +
  '3ff29ff9aaaa2c003ff0d4c0000000003feb7d7596e800074002bdda000000003ff54000000000003fdb51a30f9739f8' +
  '4012b153000000003ffac000000000003fcb63f203c60c073ff2c56b800000003ff0e000000000003feb469f4adc7794' +
  '4002dfff74f29dc03ff54ce0000000003fdb2037084297994012f4b8e00000003ffae000000000003fcb028f031c8644' +
  '3ff33100000000003ff10000000000003feaadb93d39ae9c40031304c00000003ff56000000000003fdad7a85e593e54' +
  '401338c0000000003ffb0000000000003fcaa2f78f1b4cc63ff35fb6f4579c003ff10dc0000000003fea6d6548fa984d' +
  '40036930000000003ff58000000000003fda607fa909db1f40137d69200000003ffb2000000000003fca45211d8b748a' +
  '3ff39e2c800000003ff12000000000003fea1941b013022d40039fe541ac78403ff59420000000003fda16f787114257' +
  '40139ffaac0000003ffb3000000000003fca16db0ec408b23ff3dfc1312b00003ff13300000000003fe9c322b87f17e8' +
  '4003c05d400000003ff5a000000000003fd9ec1430b0dfc74013c2b5000000003ffb4000000000003fc9e9016e2211b6' +
  '3ff40cf4000000003ff14000000000003fe9890fd4bf368f4004188e000000003ff5c000000000003fd97a51ec6b707e' +
  '401408a4600000003ffb6000000000003fc98e8e88261b623ff47d59800000003ff16000000000003fe8fcfc9c44e2f4' +
  '400471c3c00000003ff5e000000000003fd90b25822e2a9f40144f38000000003ffb8000000000003fc935beb82c1ae7' +
  '3ff49feb2bc0dc003ff169c0000000003fe8d31a9f2d47fb40049fcfb130a6c03ff5f060000000003fd8d33bb2686480' +
  '40149670a00000003ffba000000000003fc8de888de6c48f3ff4ef60000000003ff18000000000003fe874e2a121159f' +
  '4004cc00000000003ff60000000000003fd89e7c3fdb12464014de4f000000003ffbc000000000003fc888e2da0ba19d' +
  '3ff51ff889bc60003ff18d80000000003fe83ca00a5a8f3240052744400000003ff62000000000003fd8344414a70cbd' +
  '401526d3e00000003ffbe000000000003fc834c4ac4afd3b3ff5630a800000003ff1a000000000003fe7f09e124e78b8' +
  '40055fc05a5df1403ff633a0000000003fd7f44d50c76c8e40157000000000003ffc0000000000003fc7e225515a4f1d' +
  '3ff59fc8db9a7e803ff1b0a0000000003fe7ad5e68ed5f8c40058392000000003ff64000000000003fd7cc6b8acae7cb' +
  '4015b9d4200000003ffc2000000000003fc790fc511067513ff5d85c000000003ff1c000000000003fe7700c9f78cc63' +
  '4005e0eac00000003ff66000000000003fd766e1c17c26ec4015dfdce58113603ffc3060000000003fc7680273c586ed' +
  '3ff61fbc0c5154003ff1d340000000003fe7246f92d40d4c40063f50000000003ff68000000000003fd70396672a04e5' +
  '40160451000000003ffc4000000000003fc741416c92a70b3ff64f57800000003ff1e000000000003fe6f30d6649f11b' +
  '40065fa1cdfa11c03ff68ae0000000003fd6e257c2026aef40164f77600000003ffc6000000000003fc6f2ec9c929a29' +
  '3ff69fc04b6889803ff1f560000000003fe6a17c8a1a662e40069ec3400000003ff6a000000000003fd6a279b3fb4a4e' +
  '40169b48000000003ffc8000000000003fc6a5f60f9b4c973ff6c800000000003ff20000000000003fe67980e0bf08c7' +
  '4006ff46000000003ff6c000000000003fd6437c6489c8e04016e7c3a00000003ffca000000000003fc65a56286dbe08' +
  '3ff71fc3c58700003ff21700000000003fe6243421ae7a8440071fef1bff26003ff6cac0000000003fd6240aa2fa0dfd' +
  '401734eb000000003ffcc000000000003fc610057c6bdd383ff74258800000003ff22000000000003fe60348d4756756' +
  '400760d9c00000003ff6e000000000003fd5e68fb4d877a740175fb34f0902a03ffcd1a0000000003fc5e7a396f89f71' +
  '3ff7be64000000003ff24000000000003fe5904842e0271b40079fec8fa790003ff6f480000000003fd5ac1740057116' +
  '401782bee00000003ffce000000000003fc5c6fcd2117a653ff7dfa08e1620003ff24880000000003fe57242f8b50298' +
  '4007c380000000003ff70000000000003fd58ba55b8156094017d140000000003ffd0000000000003fc57f351f7aa6ea' +
  '3ff83c25800000003ff26000000000003fe520635a583b964008273a400000003ff72000000000003fd532af851862ac' +
  '4018206f200000003ffd2000000000003fc538a788f6fdd63ff85fd33ff900003ff26900000000003fe50176a58004f0' +
  '40085fccde2400003ff73200000000003fd5017c2589970e4018704d000000003ffd4000000000003fc4f34d5fa956d6' +
  '3ff8bba0000000003ff28000000000003fe4b37f67f9d05c40088c0a000000003ff74000000000003fd4dba0cfc11861' +
  '40189fbb1ca4e0e03ffd52e0000000003fc4caf2b205f9dd3ff8dfca525900003ff28900000000003fe495664ea7f47d' +
  '4008f1f0c00000003ff76000000000003fd4866c46f405db4018c0da600000003ffd6000000000003fc4af2020336a59' +
  '3ff93cd6800000003ff2a000000000003fe44982ca42a2eb40091fabaf07d2003ff76e40000000003fd461102bc1cb8f' +
  '40191218000000003ffd8000000000003fc46c19716cf2c03ff95ff68a951e803ff2a8a0000000003fe42d6dab45c848' +
  '400958f0000000003ff78000000000003fd433055f7235db40196406a00000003ffda000000000003fc42a332325db6b' +
  '3ff9bfcc000000003ff2c000000000003fe3e254e465d72c40099ffaac1ec3c03ff795e0000000003fd3fb056724ebb2' +
  '4019b6a7000000003ffdc000000000003fc3e9672cf3131d3ff9dfc708557c003ff2c7c0000000003fe3c9c1357411b6' +
  '4009c109400000003ff7a000000000003fd3e15ff3643c494019dfe6c1816fe03ffdcfe0000000003fc3c9a8f2a1f8a5' +
  '3ffa1f8756df74803ff2d720000000003fe39976b1b376fb400a2a3e000000003ff7c000000000003fd391703ea2d9b9' +
  '401a09f9e00000003ffde000000000003fc3a9afad059b873ffa4483800000003ff2e000000000003fe37dde124a87f2' +
  '400a5fad7a3ee0403ff7d020000000003fd369cab16c4bb8401a5e00000000003ffe0000000000003fc36b06e70b7421' +
  '3ffa9fbaa05b1c003ff2f5c0000000003fe33b1676d97a5b400a948fc00000003ff7e000000000003fd3432adb274266' +
  '401ab2ba200000003ffe2000000000003fc32d67431a02803ffacb00000000003ff30000000000003fe31c079d2b089f' +
  '400adffcaf5350003ff7f680000000003fd30d1b5accf7d2401adfb1053dbae03ffe30e0000000003fc30d50fe844fd2' +
  '3ffb1ff52f4000003ff31400000000003fe2e02d4701d501400b0000000000003ff80000000000003fd2f684bda12f68' +
  '401b0829000000003ffe4000000000003fc2f0cb4ca19e1e3ffb5344800000003ff32000000000003fe2bcbbb0cb73f6' +
  '400b6c90400000003ff82000000000003fd2ab733230f96f401b5e4d600000003ffe6000000000003fc2b52db169e95e' +
  '3ffb9fa0378e5c003ff331c0000000003fe288f0567537ff400b9fd76ec780003ff82f00000000003fd288cb4a41a9b5' +
  '401bb528000000003ffe8000000000003fc27a894096a4f53ffbdd54000000003ff34000000000003fe25fe5513ebf45' +
  '400bda42000000003ff84000000000003fd261ebd944131e401bdfd332712ca03ffe8fa0000000003fc25e3ff656ec87' +
  '3ffc1fc1c05694003ff34f40000000003fe2347ec39d66b0400c1fd3bf5cf8403ff85420000000003fd234731d751ccc' +
  '401c0cb9a00000003ffea000000000003fc240d8e9b4ae5d3ffc6931800000003ff36000000000003fe2057051321929' +
  '400c4916c00000003ff86000000000003fd219e4a4924f1f401c6503000000003ffec000000000003fc20817bbcedd1f' +
  '3ffc9fc4ad339d803ff36c60000000003fe1e3144d16fd97400cb910000000003ff88000000000003fd1d353d43a7247' +
  '401cbe04e00000003ffee000000000003fc1d040e48a75cd3ffcf6e0000000003ff38000000000003fe1ad4948b6e145' +
  '400cdfd1815980003ff88b00000000003fd1bb66cda74540401cdfeef07244203ffeec20000000003fc1bb54ba55bb8e' +
  '3ffd1f9c6201cc803ff38920000000003fe1948fa1f5ff30400d2a2f400000003ff8a000000000003fd18e2ff3fca5ac' +
  '401d17c0000000003fff0000000000003fc1994faf4aec923ffd5f8615bde1803ff39760000000003fe16e4ee12da718' +
  '400d5f9b878780003ff8af00000000003fd16e4227697dbf401d7235200000003fff2000000000003fc1633f845cb3de' +
  '3ffd8662800000003ff3a000000000003fe1575d8c8402f4400d9c76000000003ff8c000000000003fd14a6fd8916ecf' +
  '401d9fb5ac0000003fff3000000000003fc1488a6b10c1483ffddfdfe805bc003ff3b3c0000000003fe1236b509d4023' +
  '400ddff55aa1e6003ff8d2c0000000003fd1235f02ce295a401dcd65000000003fff4000000000003fc12e0be826d695' +
  '3ffe17bc000000003ff3c000000000003fe1039b25a7f122400e0fe5c00000003ff8e000000000003fd1080a9d1be542' +
  '401e2950600000003fff6000000000003fc0f9b07a631f923ffe5ff3ecf6fc003ff3cfc0000000003fe0db275be001a6' +
  '400e5fefa40c00003ff8f600000000003fd0db29bc986108401e5fe06d9140e03fff72e0000000003fc0db322dce8431' +
  '3ffeaaef800000003ff3e000000000003fe0b1f0c9a4ed7c400e8480000000003ff90000000000003fd0c6f7a0b5ed8d' +
  '401e85f8000000003fff8000000000003fc0c628f55c92de3ffedfb5912a51803ff3eb60000000003fe0956733c0be03' +
  '400efa46400000003ff92000000000003fd0872e8415508d401ee35ca00000003fffa000000000003fc093712d33ff42' +
  '3fff1fd112ab0c803ff3f920000000003fe0733ed7907e73400f1fc8b255bc403ff92a20000000003fd0734344eaebef' +
  '401f1ff2ff2d4ba03fffb4a0000000003fc0732ce999c3d13fff4000000000003ff40000000000003fe0624dd2f1a9fc' +
  '400f713a000000003ff94000000000003fd048a727489527401f417f000000003fffc000000000003fc061850f2a7123' +
  '3fff9fe36d7a7d803ff41460000000003fe030a055aebedd400f9f8b6ce70ec03ff94c60000000003fd030cd637fd65e' +
  '401fa05fe00000003fffe000000000003fc03060a0f151c23fffd6f0800000003ff42000000000003fe014a239d8b1a9' +
  '400fe95cc00000003ff96000000000003fd00b59a78a8ffc402000000000000040000000000000003fc0000000000000');
const CBF_K = hexDoubles('3f9ee8e4463c656ebf980b1460621e80bfa511e8c911a9623faf9add36935873bfbc71c71c71d3473fd55555555555f1');

/**
 * Apple libm cbrtf: y = 2^(e mod 3) * 1.m in [1, 8), t = (y - c)/c from a
 * table cell, cbrt(y) = r * (1 + t*P(t)) in double (degree 6, fused Horner),
 * rounded to float, times the signed power of two 2^((e - 1) div 3 - 42)
 * (denormals pre-scaled by 2^45).
 */
export function cbrtfLibm(x: number): number {
  if (x !== x) return x;
  const a = Math.abs(x);
  if (a === Infinity) return x;
  let s = a, base = 0x2a800000;
  if (a < 1.1754943508222875e-38) {
    if (x === 0) return x;
    s = f32(a * 35184372088832);
    base = 0x23000000;
  }
  const w = f32bits(s);
  const e1 = (w >>> 23) - 1;
  const q = (e1 * 0x5556) >>> 16;
  const rem = e1 - 3 * q;
  const row = (((w >>> 17) & 0x3f) * 3 + rem) * 3;
  const y = bitsf32((((rem << 23) | (w & 0x7fffff)) + 0x3f800000) >>> 0);
  const t = (y - CBF_TAB[row]) * CBF_TAB[row + 2];
  let p = fma64(t, CBF_K[1], CBF_K[0]);
  p = fma64(p, t, CBF_K[2]);
  p = fma64(p, t, CBF_K[3]);
  p = fma64(p, t, CBF_K[4]);
  p = fma64(p, t, CBF_K[5]);
  const c = f32(CBF_TAB[row + 1] * fma64(p, t, 1));
  const scale = bitsf32((base + (q << 23)) >>> 0);
  return f32((x < 0 ? -scale : scale) * c);
}

const CB_L9 = bitsf32(0x3d9021bb), CB_L8 = bitsf32(0xbdebd1b8), CB_L7 = bitsf32(0x3def251a), CB_L6 = bitsf32(0xbdfe5d4f);
const CB_L5 = bitsf32(0x3e11e9bf), CB_L4 = bitsf32(0xbe2aae50), CB_L3 = bitsf32(0x3e4cceac), CB_L2 = bitsf32(0xbe7ffffc);
const CB_L1 = bitsf32(0x3eaaaaaa), CB_SQH = bitsf32(0x3f3504f3), CB_THIRD = bitsf32(0x3eaaaaab), CB_MAX = bitsf32(0x42b0c0a5);

/**
 * FL's vector logf (cephes style) of a non-negative float given by its bits:
 * mantissa m in [0.5, 1) from the bit fields, r = (m - 1) + (m < sqrt(1/2) ?
 * m : 0), degree 8 polynomial (fused Horner), log = (r + E*ln2) + r^2*P(r).
 */
function cephesLog(b: number): number {
  const m = bitsf32(((b & 0x807fffff) | 0x3f000000) >>> 0);
  const small = m < CB_SQH;
  let E = (b >> 23) - 127;
  if (!small) E = E + 1;
  const r = f32(f32(m - 1) + (small ? m : 0));
  let p = fma32(r, CB_L9, CB_L8);
  p = fma32(p, r, CB_L7);
  p = fma32(p, r, CB_L6);
  p = fma32(p, r, CB_L5);
  p = fma32(p, r, CB_L4);
  p = fma32(p, r, CB_L3);
  p = fma32(p, r, CB_L2);
  p = fma32(p, r, CB_L1);
  p = fma32(p, r, -0.5);
  return fma32(f32(r * r), p, fma32(E, LN2F, r));
}

/**
 * One lane of FL's vector cbrt, from the raw float bits: cephes-style logf of
 * |x| taken from the bit fields (mantissa in [sqrt(1/2), sqrt(2)), degree 8
 * polynomial), divided by 3 (times float 1/3), clamped to +-88.3762589,
 * cephes-style expf (k = floor(z*log2e + 1/2) via truncation, one fused ln2
 * step, degree 5), sign of x or'ed in. |x| = 0 -> +0 (also for -0); denormals,
 * inf and NaN follow the formula on their bit fields (a NaN gives a finite
 * value).
 */
export function cbrtVecLane(bits: number): number {
  const b = bits & 0x7fffffff;
  if (b === 0) return 0;
  let l = f32(cephesLog(b) * CB_THIRD);
  if (l > CB_MAX) l = CB_MAX;
  if (l < -CB_MAX) l = -CB_MAX;
  const z = fma32(l, LOG2E, 0.5);
  const zt = Math.trunc(z);
  const k = zt > z ? zt - 1 : zt;
  const rr = fma32(-k, LN2F, l);
  let q = fma32(rr, EM1_C6, EM1_C5);
  q = fma32(q, rr, EM1_C4);
  q = fma32(q, rr, EM1_C3);
  q = fma32(q, rr, EM1_C2);
  q = fma32(q, rr, 0.5);
  const y = f32(fma32(f32(rr * rr), q, f32(rr + 1)) * bitsf32(((k << 23) + 0x3f800000) >>> 0));
  return bits >>> 31 ? -y : y;
}

/** Raw bits of src[i] (exact also for NaN payloads; allocates a view only for NaNs). */
function rawBits(src: Float32Array, i: number): number {
  const x = src[i];
  if (x === x) return f32bits(x);
  return new Uint32Array(src.buffer, src.byteOffset + 4 * i, 1)[0];
}

/** ippsCbrt_32f_A11 / A24: vector lanes for the first 4*floor(n/4) elements, libm cbrtf for the rest. */
export function cbrt32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  const nv = n >= 4 ? n & ~3 : 0;
  for (let i = 0; i < nv; i++) dst[dstOff + i] = cbrtVecLane(rawBits(src, srcOff + i));
  for (let i = nv; i < n; i++) dst[dstOff + i] = cbrtfLibm(src[srcOff + i]);
}
export const cbrt32fA11 = cbrt32f;
export const cbrt32fA24 = cbrt32f;

// ---------------------------------------------------------------------------
// Elementwise helpers. Checked in the dylib: each is one IEEE operation per
// element (vDSP_vadd / vsub / vmul / vsmul / vsadd / vsq / vabs, or the
// library's own loops), no fused operations, so vector width and lane order do
// not matter. Argument order follows the IPP prototypes.

/** ippsAdd_32f(pSrc1, pSrc2, pDst, len): dst = src1 + src2. */
export function add32f(src1: Float32Array, src2: Float32Array, dst: Float32Array, n: number, off1 = 0, off2 = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src1[off1 + i] + src2[off2 + i];
}
/** ippsAdd_32f_I(pSrc, pSrcDst, len): srcDst += src. */
export function add32fI(src: Float32Array, srcDst: Float32Array, n: number, srcOff = 0, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] + src[srcOff + i];
}
/** ippsSub_32f(pSrc1, pSrc2, pDst, len): dst = src2 - src1 (vDSP_vsub). */
export function sub32f(src1: Float32Array, src2: Float32Array, dst: Float32Array, n: number, off1 = 0, off2 = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src2[off2 + i] - src1[off1 + i];
}
/** ippsSub_32f_I(pSrc, pSrcDst, len): srcDst -= src. */
export function sub32fI(src: Float32Array, srcDst: Float32Array, n: number, srcOff = 0, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] - src[srcOff + i];
}
/** ippsMul_32f(pSrc1, pSrc2, pDst, len): dst = src1 * src2. */
export function mul32f(src1: Float32Array, src2: Float32Array, dst: Float32Array, n: number, off1 = 0, off2 = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src1[off1 + i] * src2[off2 + i];
}
/** ippsMul_32f_I(pSrc, pSrcDst, len): srcDst *= src. */
export function mul32fI(src: Float32Array, srcDst: Float32Array, n: number, srcOff = 0, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] * src[srcOff + i];
}
/** ippsMulC_32f(pSrc, val, pDst, len): dst = src * val. */
export function mulC32f(src: Float32Array, val: number, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  const v = f32(val);
  for (let i = 0; i < n; i++) dst[dstOff + i] = src[srcOff + i] * v;
}
/** ippsMulC_32f_I(val, pSrcDst, len): srcDst *= val. */
export function mulC32fI(val: number, srcDst: Float32Array, n: number, off = 0): void {
  const v = f32(val);
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] * v;
}
/** ippsAddC_32f(pSrc, val, pDst, len): dst = src + val. */
export function addC32f(src: Float32Array, val: number, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  const v = f32(val);
  for (let i = 0; i < n; i++) dst[dstOff + i] = src[srcOff + i] + v;
}
/** ippsAddC_32f_I(val, pSrcDst, len): srcDst += val. */
export function addC32fI(val: number, srcDst: Float32Array, n: number, off = 0): void {
  const v = f32(val);
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] + v;
}
/** ippsSubCRev_32f(pSrc, val, pDst, len): dst = val - src. */
export function subCRev32f(src: Float32Array, val: number, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  const v = f32(val);
  for (let i = 0; i < n; i++) dst[dstOff + i] = v - src[srcOff + i];
}
/** ippsSubCRev_32f_I(val, pSrcDst, len): srcDst = val - srcDst. */
export function subCRev32fI(val: number, srcDst: Float32Array, n: number, off = 0): void {
  const v = f32(val);
  for (let i = 0; i < n; i++) srcDst[off + i] = v - srcDst[off + i];
}
/** ippsSqr_32f(pSrc, pDst, len): dst = src * src. */
export function sqr32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) { const x = src[srcOff + i]; dst[dstOff + i] = x * x; }
}
/** ippsSqr_32f_I(pSrcDst, len). */
export function sqr32fI(srcDst: Float32Array, n: number, off = 0): void {
  for (let i = 0; i < n; i++) { const x = srcDst[off + i]; srcDst[off + i] = x * x; }
}
/** ippsAbs_32f(pSrc, pDst, len) (sign bit cleared). */
export function abs32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = Math.abs(src[srcOff + i]);
}
/** ippsAbs_32f_I(pSrcDst, len). */
export function abs32fI(srcDst: Float32Array, n: number, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = Math.abs(srcDst[off + i]);
}
/** ippsRound_32f(pSrc, pDst, len): frinta (nearest, ties away from zero; sign of zero kept). */
export function round32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) {
    const x = src[srcOff + i];
    dst[dstOff + i] = x === 0 ? x : x < 0 ? -Math.floor(0.5 - x) || -0 : Math.floor(x + 0.5);
  }
}
/** ippsAndC_32u_I(val, pSrcDst, len). */
export function andC32uI(val: number, srcDst: Uint32Array | Int32Array, n: number, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] & val;
}
/** ippsOrC_32u_I(val, pSrcDst, len) (0xff000000 goes through vImage, same result). */
export function orC32uI(val: number, srcDst: Uint32Array | Int32Array, n: number, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] | val;
}
/** ippsAdd_64f(pSrc1, pSrc2, pDst, len). */
export function add64f(src1: Float64Array, src2: Float64Array, dst: Float64Array, n: number, off1 = 0, off2 = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src1[off1 + i] + src2[off2 + i];
}
/** ippsAdd_64f_I(pSrc, pSrcDst, len). */
export function add64fI(src: Float64Array, srcDst: Float64Array, n: number, srcOff = 0, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] + src[srcOff + i];
}
/** ippsSub_64f_I(pSrc, pSrcDst, len): srcDst -= src. */
export function sub64fI(src: Float64Array, srcDst: Float64Array, n: number, srcOff = 0, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] - src[srcOff + i];
}
/** ippsMul_64f(pSrc1, pSrc2, pDst, len). */
export function mul64f(src1: Float64Array, src2: Float64Array, dst: Float64Array, n: number, off1 = 0, off2 = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src1[off1 + i] * src2[off2 + i];
}
/** ippsMul_64f_I(pSrc, pSrcDst, len). */
export function mul64fI(src: Float64Array, srcDst: Float64Array, n: number, srcOff = 0, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] * src[srcOff + i];
}
/** ippsMulC_64f(pSrc, val, pDst, len). */
export function mulC64f(src: Float64Array, val: number, dst: Float64Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src[srcOff + i] * val;
}
/** ippsMulC_64f_I(val, pSrcDst, len). */
export function mulC64fI(val: number, srcDst: Float64Array, n: number, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] * val;
}
/** ippsAddC_64f(pSrc, val, pDst, len) / ippsAddC_64f_I(val, pSrcDst, len). */
export function addC64f(src: Float64Array, val: number, dst: Float64Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src[srcOff + i] + val;
}
export function addC64fI(val: number, srcDst: Float64Array, n: number, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = srcDst[off + i] + val;
}

/** fmaxnm / fminnm: NaN operands are ignored in favour of the number. */
function fmaxnm(a: number, b: number): number { return a !== a ? b : b !== b ? a : Math.max(a, b); }
function fminnm(a: number, b: number): number { return a !== a ? b : b !== b ? a : Math.min(a, b); }

/**
 * ippsThreshold_LT_32f(pSrc, pDst, len, level): max(x, level); the first
 * 16*floor(n/16) elements use fmax (a NaN stays NaN), the rest fmaxnm (NaN ->
 * level).
 */
export function thresholdLT32f(src: Float32Array, dst: Float32Array, n: number, level: number, srcOff = 0, dstOff = 0): void {
  const l = f32(level), nb = n & ~15;
  for (let i = 0; i < n; i++) { const x = src[srcOff + i]; dst[dstOff + i] = i < nb ? Math.max(x, l) : fmaxnm(x, l); }
}
/** ippsThreshold_LT_32f_I(pSrcDst, len, level). */
export function thresholdLT32fI(srcDst: Float32Array, n: number, level: number, off = 0): void {
  thresholdLT32f(srcDst, srcDst, n, level, off, off);
}
/** ippsThreshold_GT_32f(pSrc, pDst, len, level): min(x, level), fmin for 16-blocks, fminnm for the rest. */
export function thresholdGT32f(src: Float32Array, dst: Float32Array, n: number, level: number, srcOff = 0, dstOff = 0): void {
  const l = f32(level), nb = n & ~15;
  for (let i = 0; i < n; i++) { const x = src[srcOff + i]; dst[dstOff + i] = i < nb ? Math.min(x, l) : fminnm(x, l); }
}
/** ippsThreshold_GT_32f_I(pSrcDst, len, level). */
export function thresholdGT32fI(srcDst: Float32Array, n: number, level: number, off = 0): void {
  thresholdGT32f(srcDst, srcDst, n, level, off, off);
}
/**
 * ippsThreshold_LTVal_32f_I(pSrcDst, len, level, value): x < level ? value :
 * x; a NaN stays NaN inside 16-blocks (fcmgt) and becomes value in the n % 16
 * tail (fcmp + fcsel lt, true when unordered).
 */
export function thresholdLTVal32fI(srcDst: Float32Array, n: number, level: number, value: number, off = 0): void {
  const l = f32(level), v = f32(value), nb = n & ~15;
  for (let i = 0; i < n; i++) {
    const x = srcDst[off + i];
    if (i < nb ? l > x : !(x >= l)) srcDst[off + i] = v;
  }
}
/**
 * ippsThreshold_GTVal_32f_I(pSrcDst, len, level, value): x > level ? value :
 * x; a NaN becomes value inside 16-blocks (!(level >= x)) and stays NaN in the
 * n % 16 tail.
 */
export function thresholdGTVal32fI(srcDst: Float32Array, n: number, level: number, value: number, off = 0): void {
  const l = f32(level), v = f32(value), nb = n & ~15;
  for (let i = 0; i < n; i++) {
    const x = srcDst[off + i];
    if (i < nb ? !(l >= x) : x > l) srcDst[off + i] = v;
  }
}
/**
 * ippsThreshold_LTValGTVal_32f_I(pSrcDst, len, levelLT, valueLT, levelGT,
 * valueGT): x < levelLT ? valueLT : x > levelGT ? valueGT : x; a NaN stays NaN
 * inside 16-blocks and becomes valueLT in the tail.
 */
export function thresholdLTValGTVal32fI(srcDst: Float32Array, n: number, levelLT: number, valueLT: number, levelGT: number, valueGT: number, off = 0): void {
  const l1 = f32(levelLT), v1 = f32(valueLT), l2 = f32(levelGT), v2 = f32(valueGT), nb = n & ~15;
  for (let i = 0; i < n; i++) {
    const x = srcDst[off + i];
    const lt = i < nb ? l1 > x : !(x >= l1);
    srcDst[off + i] = lt ? v1 : x > l2 ? v2 : x;
  }
}
/** ippsThreshold_LT_64f_I(pSrcDst, len, level): fmaxnm (NaN -> level). */
export function thresholdLT64fI(srcDst: Float64Array, n: number, level: number, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = fmaxnm(srcDst[off + i], level);
}
/** ippsThreshold_GT_64f_I(pSrcDst, len, level): fminnm (NaN -> level). */
export function thresholdGT64fI(srcDst: Float64Array, n: number, level: number, off = 0): void {
  for (let i = 0; i < n; i++) srcDst[off + i] = fminnm(srcDst[off + i], level);
}
/** ippsThreshold_LTVal_64f_I(pSrcDst, len, level, value): x < level ? value : x; NaN -> value in the n % 8 tail. */
export function thresholdLTVal64fI(srcDst: Float64Array, n: number, level: number, value: number, off = 0): void {
  const nb = n & ~7;
  for (let i = 0; i < n; i++) {
    const x = srcDst[off + i];
    if (i < nb ? level > x : !(x >= level)) srcDst[off + i] = value;
  }
}

/** ippsConvert_32f64f(pSrc, pDst, len) (vDSP_vspdp, exact). */
export function convert32f64f(src: Float32Array, dst: Float64Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src[srcOff + i];
}
/** ippsConvert_64f32f(pSrc, pDst, len) (vDSP_vdpsp, round to nearest even). */
export function convert64f32f(src: Float64Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src[srcOff + i];
}

const mmAcc = new Float64Array(32);
/**
 * vDSP_maxv (stride 1): scalar fcmp/fcsel head until the address is 16-byte
 * aligned (align = FL src address mod 16 / 4), eight fmax accumulators over
 * 32-element blocks folded (a0 a1)(a2 a3)(a4 a5)(a6 a7) pairwise, 4-element
 * fmax steps, fmaxv, scalar tail. Differs from a plain max only for NaN (fmax
 * propagates, the scalar parts skip) and +-0.
 */
export function max32f(src: Float32Array, n: number, off = 0, align = 0): number {
  let s = -Infinity, p = off, rem = n;
  const head = Math.min(rem, (4 - (align & 3)) & 3);
  for (let i = 0; i < head; i++) { const x = src[p++]; if (s < x) s = x; }
  rem -= head;
  const a = mmAcc; // 8 accumulators x 4 lanes: acc j lanes at 4j..4j+3; a0 starts at dup(s)
  for (let l = 0; l < 32; l++) a[l] = l < 4 ? s : -Infinity;
  while (rem >= 32) {
    for (let l = 0; l < 32; l++) a[l] = Math.max(a[l], src[p + l]);
    p += 32; rem -= 32;
  }
  for (let l = 0; l < 4; l++) {
    // accumulator order in the asm: v0, v2, v7, v6, v5, v4, v3, v1 for blocks 0..7
    const v0 = a[l], v2 = a[4 + l], v7 = a[8 + l], v6 = a[12 + l], v5 = a[16 + l], v4 = a[20 + l], v3 = a[24 + l], v1 = a[28 + l];
    a[l] = Math.max(Math.max(Math.max(v0, v2), Math.max(v7, v6)), Math.max(Math.max(v5, v4), Math.max(v3, v1)));
  }
  while (rem >= 4) {
    for (let l = 0; l < 4; l++) a[l] = Math.max(a[l], src[p + l]);
    p += 4; rem -= 4;
  }
  s = Math.max(Math.max(a[0], a[1]), Math.max(a[2], a[3]));
  while (rem-- > 0) { const x = src[p++]; if (s < x) s = x; }
  return s;
}

/** vDSP_minv (4-byte aligned, stride 1): fmin accumulators from +inf, same block structure without a head, scalar tail. */
export function min32f(src: Float32Array, n: number, off = 0): number {
  let p = off, rem = n;
  const a = mmAcc;
  for (let l = 0; l < 32; l++) a[l] = Infinity;
  while (rem >= 32) {
    for (let l = 0; l < 32; l++) a[l] = Math.min(a[l], src[p + l]);
    p += 32; rem -= 32;
  }
  for (let l = 0; l < 4; l++) {
    // accumulator order: v2, v7, v6, v5, v4, v3, v1, v0 for blocks 0..7
    const v2 = a[l], v7 = a[4 + l], v6 = a[8 + l], v5 = a[12 + l], v4 = a[16 + l], v3 = a[20 + l], v1 = a[24 + l], v0 = a[28 + l];
    a[l] = Math.min(Math.min(Math.min(v2, v7), Math.min(v6, v5)), Math.min(Math.min(v4, v3), Math.min(v1, v0)));
  }
  while (rem >= 4) {
    for (let l = 0; l < 4; l++) a[l] = Math.min(a[l], src[p + l]);
    p += 4; rem -= 4;
  }
  let s = Math.min(Math.min(a[0], a[1]), Math.min(a[2], a[3]));
  while (rem-- > 0) { const x = src[p++]; if (x < s) s = x; }
  return s;
}

/** ippsMinMax_32f(pSrc, len, pMin, pMax): out[outOff] = min, out[outOff + 1] = max. */
export function minMax32f(src: Float32Array, n: number, out: Float32Array, off = 0, outOff = 0, align = 0): void {
  out[outOff] = min32f(src, n, off);
  out[outOff + 1] = max32f(src, n, off, align);
}

/** ippsFlip_32f(pSrc, pDst, len): dst[i] = src[n-1-i] (memcpy then vDSP_vrvrs). */
export function flip32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  if (src !== dst || srcOff !== dstOff) copy32f(src, dst, n, srcOff, dstOff);
  flip32fI(dst, n, dstOff);
}
/** ippsFlip_32f_I(pSrcDst, len). */
export function flip32fI(srcDst: Float32Array, n: number, off = 0): void {
  for (let i = 0, j = n - 1; i < j; i++, j--) { const t = srcDst[off + i]; srcDst[off + i] = srcDst[off + j]; srcDst[off + j] = t; }
}
/** ippsCopy_32f(pSrc, pDst, len). */
export function copy32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  if (n > 0) dst.set(src.subarray(srcOff, srcOff + n), dstOff);
}
/** ippsMove_32f(pSrc, pDst, len) (overlap-safe). */
export function move32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  if (n <= 0) return;
  if (src === dst) dst.copyWithin(dstOff, srcOff, srcOff + n);
  else dst.set(src.subarray(srcOff, srcOff + n), dstOff);
}
/** ippsSet_32f(val, pDst, len). */
export function set32f(val: number, dst: Float32Array, n: number, off = 0): void {
  if (n > 0) dst.fill(val, off, off + n);
}
/** ippsZero_32f(pDst, len). */
export function zero32f(dst: Float32Array, n: number, off = 0): void {
  if (n > 0) dst.fill(0, off, off + n);
}
/** ippsRealToCplx_32f(pSrcRe, pSrcIm, pDst, len): interleaved re, im (both sources required, vDSP_ztoc). */
export function realToCplx32f(re: Float32Array, im: Float32Array, dst: Float32Array, n: number, reOff = 0, imOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) { dst[dstOff + 2 * i] = re[reOff + i]; dst[dstOff + 2 * i + 1] = im[imOff + i]; }
}
/** ippsCplxToReal_32fc(pSrc, pDstRe, pDstIm, len) (vDSP_ctoz). */
export function cplxToReal32fc(src: Float32Array, re: Float32Array, im: Float32Array, n: number, srcOff = 0, reOff = 0, imOff = 0): void {
  for (let i = 0; i < n; i++) { re[reOff + i] = src[srcOff + 2 * i]; im[imOff + i] = src[srcOff + 2 * i + 1]; }
}
/** ippsInterleave_32f(ppSrc, numChannels, len, pDst): dst[i*ch + c] = src[c][i]. */
export function interleave32f(srcs: Float32Array[], channels: number, n: number, dst: Float32Array, dstOff = 0, srcOff = 0): void {
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) dst[dstOff + i * channels + c] = srcs[c][srcOff + i];
}
/** ippsDeinterleave_32f(pSrc, numChannels, len, ppDst): dst[c][i] = src[i*ch + c]. */
export function deinterleave32f(src: Float32Array, channels: number, n: number, dsts: Float32Array[], srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) dsts[c][dstOff + i] = src[srcOff + i * channels + c];
}

/**
 * ippsMagnitude_32fc(pSrc, pDst, len) (the library's own loop): groups of four
 * compute sqrt(fma(re, re, im*im)), the n % 4 tail sqrt(fma(im, im, re*re));
 * fsqrt is correctly rounded. src holds interleaved re, im.
 */
export function magnitude32fc(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  const nv = n >= 4 ? n & ~3 : 0;
  for (let i = 0; i < n; i++) {
    const re = src[srcOff + 2 * i], im = src[srcOff + 2 * i + 1];
    const s = i < nv ? fma32(re, re, f32(im * im)) : fma32(im, im, f32(re * re));
    dst[dstOff + i] = Math.sqrt(s);
  }
}

// ---------------------------------------------------------------------------
// cos (vForce vvcosf; ippsCos_32f_A11 / A21 / A24), sincos (vvsincosf;
// ippsSinCos_32f_A21)

const PIO2_F = bitsf32(0x3fc90fdb);
const CF4 = bitsf32(0x362ec335), CF3 = bitsf32(0xb94fb6cf), CF2 = bitsf32(0x3c088764);

/**
 * vvcosf fast path: k = nearest((|x| + pi/2)/pi), r = |x| - (k - 1/2)*pi in
 * three fused steps, negated for odd k, cos = r + r^3*P(r^2).
 */
function cosFast(x: number): number {
  const a = Math.abs(x);
  const k = cvtns32(f32(f32(a + PIO2_F) * INV_PI));
  const kh = f32(k - 0.5);
  let r = fma32(NPI1, kh, a);
  r = fma32(PI2, kh, r);
  r = fma32(PI3, kh, r);
  if (k & 1) r = -r;
  const r2 = f32(r * r);
  let p = fma32(CF4, r2, CF3);
  p = fma32(p, r2, CF2);
  p = fma32(p, r2, SF1);
  return fma32(p, f32(r2 * r), r);
}

/** vvcosf large-argument path: as sinSlow with p = T[e]*x + 1/2 (fused). */
function cosSlow(x: number): number {
  const e = (f32bits(x) >>> 23) & 0xfe;
  const p = fma64(SIN_TAB[e], x, 0.5);
  const k = cvtns64(p);
  const odd = cvtnsOdd;
  let r = fma64(SIN_TAB[e + 1], x, p - k);
  if (odd) r = -r;
  const f = f32(f32(r) * PI_F);
  const s2 = f32(f * f);
  let q = fma32(SS4, s2, SS3);
  q = fma32(q, s2, SS2);
  q = fma32(q, s2, SF1);
  return fma32(f32(s2 * q), f, f);
}

/** vvcosf over a vector (same lane groups as vvsinf, see sinVec). */
function cosVec(src: Float32Array, dst: Float32Array, n: number, srcOff: number, dstOff: number, align: number): void {
  if (n <= 0) return;
  if (n < 16) {
    const fast = allSmall(src, srcOff, n, SIN_BIG);
    for (let i = 0; i < n; i++) { const x = src[srcOff + i]; dst[dstOff + i] = fast ? cosFast(x) : cosSlow(x); }
    return;
  }
  const headFast = allSmall(src, srcOff, 16, SIN_BIG);
  const tailFast = allSmall(src, srcOff + n - 16, 16, SIN_BIG);
  const h = 16 - (align & 3);
  const groups = Math.max(0, Math.floor((n - h) / 16));
  const tailStart = n - h - 16 * groups !== 0 ? n - 16 : n;
  for (let g = 0; g < groups; g++) {
    const s = h + 16 * g;
    const fast = allSmall(src, srcOff + s, 16, SIN_BIG);
    const lo = Math.max(s, 16), hi = Math.min(s + 16, tailStart);
    for (let i = lo; i < hi; i++) { const x = src[srcOff + i]; dst[dstOff + i] = fast ? cosFast(x) : cosSlow(x); }
  }
  for (let i = Math.max(tailStart, 16); i < n; i++) { const x = src[srcOff + i]; dst[dstOff + i] = tailFast ? cosFast(x) : cosSlow(x); }
  for (let i = 0; i < 16; i++) { const x = src[srcOff + i]; dst[dstOff + i] = headFast ? cosFast(x) : cosSlow(x); }
}

/** ippsCos_32f_A11 / A21 / A24 (vvcosf). align as for sin32fA21. */
export function cos32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0, align = 0): void {
  cosVec(src, dst, n, srcOff, dstOff, align);
}
export const cos32fA11 = cos32f;
export const cos32fA21 = cos32f;
export const cos32fA24 = cos32f;

/**
 * vvsincosf fast-path cosine: from the sine reduction r_s = |x| - k*pi, k' =
 * k +- 1/2 (sign of r_s), r_c = |x| - k'*pi (three fused steps), sign flipped
 * unless (sign r_s) xor (k odd), then the sine polynomial.
 */
function cosFastSC(x: number): number {
  const a = Math.abs(x);
  const k = cvtns32(f32(a * INV_PI));
  let rs = fma32(NPI1, k, a);
  rs = fma32(PI2, k, rs);
  rs = fma32(PI3, k, rs);
  const neg = rs < 0 || (rs === 0 && 1 / rs < 0);
  const kc = f32(k + (neg ? -0.5 : 0.5));
  let c = fma32(NPI1, kc, a);
  c = fma32(PI2, kc, c);
  c = fma32(PI3, kc, c);
  if (((neg ? 1 : 0) ^ (k & 1)) === 0) c = -c;
  const c2 = f32(c * c);
  let p = fma32(SF4, c2, SF3);
  p = fma32(p, c2, SF2);
  p = fma32(p, c2, SF1);
  return fma32(p, f32(c2 * c), c);
}

/**
 * ippsSinCos_32f_A21(pSrc, pDstSin, pDstCos, len) (vvsincosf): consecutive
 * 16-element groups from the start, the n % 16 rest as one zero-padded group;
 * a group with all |x| <= 1e6 uses the fast path (sine as vvsinf's fast path,
 * cosine from the shared reduction), otherwise vvsinf's / vvcosf's
 * large-argument paths.
 */
export function sinCos32f(src: Float32Array, dstSin: Float32Array, dstCos: Float32Array, n: number, srcOff = 0, sinOff = 0, cosOff = 0): void {
  for (let s = 0; s < n; s += 16) {
    const len = Math.min(16, n - s);
    const fast = allSmall(src, srcOff + s, len, SIN_BIG);
    for (let i = s; i < s + len; i++) {
      const x = src[srcOff + i];
      const sv = fast ? sinFast(x) : sinSlow(x);
      const cv = fast ? cosFastSC(x) : cosSlow(x);
      dstSin[sinOff + i] = sv;
      dstCos[cosOff + i] = cv;
    }
  }
}
export const sinCos32fA21 = sinCos32f;

// ---------------------------------------------------------------------------
// atan (vForce vvatanf; ippsAtan_32f_A11 / A21), atan2 (vvatan2f;
// ippsAtan2_32f_A21)

const AT_T1 = bitsf32(0x3ed413cd), AT_T3 = bitsf32(0x401a827a); // tan(pi/8), tan(3pi/8)
const AT_C4 = bitsf32(0x3da4f0d1), AT_C3 = bitsf32(0xbe0e1b85), AT_C2 = bitsf32(0x3e4c925f), AT_C1 = bitsf32(0xbeaaaa2a);
const PIO4_F = bitsf32(0x3f490fdb), P3IO4_F = bitsf32(0x4016cbe4);
const AT_LO = bitsf32(0x20000000), AT_HI = bitsf32(0x5f000000); // 2^-63, 2^63

/**
 * One element of vvatanf (cephes atanf): a = |x| reduced with tan(pi/8) /
 * tan(3pi/8) to y = (a-1)/(a+1) or -1/a (fdiv), atan = base + y + y*z*P(z)
 * with z = y^2 (z taken as 0 when |x| is outside [2^-63, 2^63]), sign or'ed.
 */
export function atanf1(x: number): number {
  const a = Math.abs(x);
  const valid = a >= AT_LO && AT_HI >= a;
  const g1 = a > AT_T1, g3 = a > AT_T3;
  let num = g1 ? f32(a - 1) : a;
  let den = g1 ? f32(a + 1) : 1;
  if (g3) { den = a; num = -1; }
  const y = f32(num / den);
  const z = valid ? f32(y * y) : 0;
  let p = fma32(AT_C4, z, AT_C3);
  p = fma32(p, z, AT_C2);
  p = fma32(p, z, AT_C1);
  const r = fma32(p, f32(y * z), y);
  const res = f32((g3 ? PIO2_F : g1 ? PIO4_F : 0) + r);
  return (f32bits(x) >>> 31) ? -res : res;
}

/** ippsAtan_32f_A11 / A21 (vvatanf). */
export function atan32f(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = atanf1(src[srcOff + i]);
}
export const atan32fA11 = atan32f;
export const atan32fA21 = atan32f;

/** Sign bit of a float32 value as 0 / 1 (NaN: +). */
function signbit(x: number): number {
  return x < 0 || (x === 0 && 1 / x < 0) ? 1 : 0;
}

/**
 * One element of vvatan2f(y, x): q = (|x| >= |y| ? y/x : -x/y), base angle
 * (0 / pi for x signbit / pi/2, +-pi/4 or 3pi/4 for inf/inf) with the sign of
 * y, plus sign(q)*atan(|q|) by the vvatanf kernel (one tan(pi/8) split);
 * NaN when x or y is NaN.
 */
export function atan2f1(y: number, x: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  const xge = ax >= ay;
  const xneg = (f32bits(x) >>> 31) === 1;
  let base = xge ? (xneg ? PI_F : 0) : PIO2_F;
  if (ax === Infinity && ay === Infinity) base = xneg ? P3IO4_F : PIO4_F;
  const q = xge ? f32(y / x) : f32(-x / y);
  const aq = Math.abs(q);
  const big = aq > AT_T1;
  const z = big ? f32(f32(aq - 1) / f32(aq + 1)) : aq;
  const z2 = aq >= AT_LO ? f32(z * z) : 0;
  let p = fma32(AT_C4, z2, AT_C3);
  p = fma32(p, z2, AT_C2);
  p = fma32(p, z2, AT_C1);
  const r = f32((big ? PIO4_F : 0) + fma32(p, f32(z * z2), z));
  const ordered = x >= y || y > x;
  const b = ordered ? (signbit(y) ? -base : base) : NaN;
  if (q !== q) return b;
  return f32(b + (signbit(q) ? -r : r));
}

/** ippsAtan2_32f_A21(pSrc1, pSrc2, pDst, len): dst = atan2(src1, src2) (vvatan2f). */
export function atan232f(src1: Float32Array, src2: Float32Array, dst: Float32Array, n: number, off1 = 0, off2 = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = atan2f1(src1[off1 + i], src2[off2 + i]);
}
export const atan232fA21 = atan232f;

// ---------------------------------------------------------------------------
// phase (ippsPhase_32fc -> vDSP_zvphas with stride 2, which calls Apple libm
// atan2f per element)

const AF_C = hexDoubles(
  '4002609372076e2cc00792d5bf17c0bc40038f4c070b63c14015e43168d7c2b6' +
  '3f953db49b9fcf6bc013e370146726b3400e4fa479729042401ae0fb08f2dc00' +
  '3f680bc0fe23203d');
const AF_PI = 3.141592653589793, AF_PIO2 = 1.5707963267948966, AF_PI_LO = bitsf64(0x400921fb, 0x40080000);
const AF_3PIO4 = 2.356194490192345, AF_PIO4 = 0.7853981633974483;

/** libm atan2f kernel: atan(q) = (Q0*Q2*E) * (Q1*Q3*q), Q_i = t^2 + a_i t + b_i (fused), t = q^2, in double. */
function atanPolyD(q: number): number {
  const t = q * q;
  const a = fma64(t + AF_C[0], t, AF_C[2]);
  const b = fma64(t + AF_C[1], t, AF_C[3]);
  const c = fma64(t + AF_C[4], t, AF_C[6]);
  const d = fma64(t + AF_C[5], t, AF_C[7]);
  return ((a * c) * AF_C[8]) * ((b * d) * q);
}

/** Apple libm atan2f(y, x) for float32 y, x (octant split, double kernel, one rounding to float). */
export function atan2fLibm(y: number, x: number): number {
  if (y < x) {
    if (-x < y) return f32(atanPolyD(y / x));
    if (-x === y) return f32(-AF_PIO4);
    return f32(-AF_PIO2 - atanPolyD(x / y));
  }
  if (y === x) {
    if (y < 0) return f32(-AF_3PIO4);
    if (y === 0) return signbit(x) ? f32(signbit(y) ? -AF_PI_LO : AF_PI_LO) : y;
    return f32(AF_PIO4);
  }
  if (y !== y || x !== x) return y + x;
  if (-x < y) return f32(AF_PIO2 - atanPolyD(x / y));
  if (-x === y) return f32(AF_3PIO4);
  const q = y / x;
  if (Math.abs(q) < 2.384185791015625e-7) return f32(signbit(y) ? -AF_PI_LO : AF_PI_LO);
  return f32(atanPolyD(q) + (signbit(y) ? -AF_PI : AF_PI));
}

/** ippsPhase_32fc(pSrc, pDst, len): dst = atan2f(im, re) (libm), src interleaved re, im. */
export function phase32fc(src: Float32Array, dst: Float32Array, n: number, srcOff = 0, dstOff = 0): void {
  for (let i = 0; i < n; i++) dst[dstOff + i] = atan2fLibm(src[srcOff + 2 * i + 1], src[srcOff + 2 * i]);
}

// ---------------------------------------------------------------------------
// tone (ippsTone_Direct_32f: the library's own NEON cosine for 16-element
// groups, Apple libm cosf for the n % 16 tail)

// Apple libm cosf: 64-entry (by top byte) 1/pi table for |x| >= 2^26.
const CSF_TAB = hexDoubles(
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  '3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b3fd45f306e000000bdeb1bbead603d8b' +
  'bfc7419f24000000bdeb1bbead603d8bbfad067c920000003dc391054a7f09d63f77cc1b720000003d9c882a53f84eb0bf6067c91b000000bd6bbead603d8a83' +
  'bf09f246c70000003d0054a7f09d5f48bf09f246c70000003d0054a7f09d5f48bf09f246c70000003d0054a7f09d5f483ee836e4e40000003d0054a7f09d5f48' +
  'becf246c6f0000003ca529fc2757d1f53e7b727221000000bc95ac07b1505c163e7b727221000000bc95ac07b1505c16be5236377d000000bc76b01ec5417056' +
  '3e4b9391050000003c629fc2757d1f53be21b1bbeb0000003c34fe13abe8fa9abdeb1bbead000000bc080f62a0b82b2dbdeb1bbead000000bc080f62a0b82b2d' +
  '3dc391054a0000003befc2757d1f534e3d9c882a54000000bb7ec54170565912bd6bbead60000000bb7ec54170565912bd6bbead60000000bb7ec54170565912' +
  '3d41054a7f0000003b33abe8fa9a6ee03d0054a7f1000000bb28a82e0acb223f3d0054a7f1000000bb28a82e0acb223f3ca529fc270000003ac5f47d4d377037' +
  '3ca529fc270000003ac5f47d4d3770373ca529fc270000003ac5f47d4d3770373c84a7f09d0000003aa7d1f534ddc0db3c629fc2750000003a8f47d4d377036e' +
  '3c34fe13ac000000ba370565911f924fbc2603d8a8000000ba370565911f924fbc080f62a10000003a21f534ddc0db633befc2757d00000039ef534ddc0db629' +
  'bb7ec54170000000b99596447e493ad5bb7ec54170000000b99596447e493ad5bb7ec54170000000b99596447e493ad53b33abe8fb000000b9596447e493ad4d' +
  '3b33abe8fb000000b9596447e493ad4dbb28a82e0b000000393a6ee06db14acd3b0d5f47d5000000b916447e493ad4cebad505c159000000b8f911f924eb5336' +
  '3ac5f47d4d00000038dbb81b6c52b3283aa7d1f535000000b8b11f924eb533623a8f47d4d300000038adc0db6295993cba37056591000000b83f924eb53361de' +
  'ba37056591000000b83f924eb53361de3a21f534de000000b83f924eb53361de39ef534ddc00000037db6c52b327887239ef534ddc00000037db6c52b3278872' +
  'b99596447e000000b7b24eb53361de38b99596447e000000b7b24eb53361de383984d3770300000037ab6295993c439039634ddc0e000000b78275a99b0ef1bf');
const CSF_C = hexDoubles('3ef99169fc938f4abf56c07f16945df43fa55553c7899699bfdffffffcb82e97');
const CSF_S = hexDoubles('bf29943e0fc4818f3f811073afd145ebbfc555545268a02a');
const CSF_L = hexDoubles('c010a8b9fc97b22cc00d31f4a0a55230402ef88f0b1250c1400537b6744fa7793fb39502de83d49c');
const CSF_2OPI = bitsf64(0x3fe45f30, 0x6dc9c883), CSF_PIO2HI = bitsf64(0x3ff921fb, 0x54442d18), CSF_PIO2LO = bitsf64(0x3c91a626, 0x33145c07);

/** Nearest-even rounding of a double (frintn). */
function rintn(v: number): number {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Apple libm cosf: |x| < 2^-12 -> 1; < pi/4 -> even polynomial in double;
 * < 2^26 -> n = nearest(|x|*2/pi), r = |x| - n*pi/2 (one fused step below
 * 120, two above), sin or cos polynomial by the quadrant n + 1; larger ->
 * 1/pi table reduction and a product-form polynomial; inf / NaN -> NaN.
 */
export function cosfLibm(x: number): number {
  const a = Math.abs(x);
  const w = f32bits(a);
  if (w >= 0x7f800000) return NaN;
  const d = a;
  let r: number, q: number;
  if (w < 0x3f490fdb) {
    if (w < 0x39800000) return f32(f32(67108864 - a) * 1.4901161193847656e-8);
    const r2 = d * d;
    return f32(fma64(r2, fma64(r2 * r2, fma64(r2, CSF_C[0], CSF_C[1]), fma64(r2, CSF_C[2], CSF_C[3])), 1));
  }
  if (w < 0x4c800000) {
    const t = d * CSF_2OPI;
    const n = rintn(t);
    q = n + 1;
    r = fma64(-n, CSF_PIO2HI, d);
    if (w >= 0x42f00000) r = fma64(-n, CSF_PIO2LO, r);
  } else {
    const e = (w >>> 24) - 0x40;
    const t = d * CSF_TAB[2 * e] + 0.5;
    const lo = d * CSF_TAB[2 * e + 1];
    const n = rintn(t);
    let f = (t - n) + lo;
    const odd = Math.abs(n % 2) === 1;
    const sf = odd ? -f : f;
    f = f * f;
    const p1 = fma64(f, f + CSF_L[0], CSF_L[2]);
    const p2 = fma64(f, f + CSF_L[1], CSF_L[3]);
    return f32((sf * p1) * (CSF_L[4] * p2));
  }
  let res: number;
  const r2 = r * r;
  if (q % 2 === 1) {
    res = fma64(r2, fma64(r2 * r2, fma64(r2, CSF_C[0], CSF_C[1]), fma64(r2, CSF_C[2], CSF_C[3])), 1);
  } else {
    const r3 = r * r2;
    res = fma64(r2 * r3, fma64(r2, CSF_S[0], CSF_S[1]), fma64(r3, CSF_S[2], r));
  }
  if (Math.floor(q / 2) % 2 === 1) res = -res;
  return f32(res);
}

const TN_4OPI = bitsf32(0x3fa2f983), TN_PIO4 = bitsf32(0x3f490fdb), TN_I2PI = bitsf32(0x3e22f983), TN_N2PI = bitsf32(0xc0c90fdb);
const TN_C0 = bitsf32(0x37ccf5ce), TN_C1 = bitsf32(0xbab6061a), TN_C2 = bitsf32(0x3d2aaaa5);
const TN_S0 = bitsf32(0x394ca1f9), TN_S1 = bitsf32(0x3c08839e), TN_S2 = bitsf32(0xbe2aaaa3);
const TWO_PI_D = 6.283185307179586;

/** FL's vector cosine (cephes cosf: octant j = trunc(|p|*4/pi), one fused pi/4 step, cos/sin polynomials). */
function toneCos(p: number): number {
  const a = Math.abs(p);
  const t = f32(a * TN_4OPI);
  const j = t !== t ? 0 : t >= 4294967295 ? 4294967295 : Math.trunc(t);
  const j1 = (j + 1) >>> 0;
  const y = (j1 & ~1) >>> 0;
  const x = fma32(-y, TN_PIO4, a);
  const z = f32(x * x);
  let r: number;
  if ((j1 & 2) === 0) {
    let c = fma32(z, TN_C0, TN_C1);
    c = fma32(c, z, TN_C2);
    c = fma32(c, z, -0.5);
    r = fma32(c, z, 1);
  } else {
    let s = fma32(-z, TN_S0, TN_S1);
    s = fma32(s, z, TN_S2);
    r = fma32(f32(z * x), s, x);
  }
  return (((j - 1) >>> 0) & 4) === 0 ? -r : r;
}

const toneP = new Float32Array(4);
/**
 * ippsTone_Direct_32f(pDst, len, magn, rFreq, pPhase, hint): dst[i] = magn *
 * cos(phase_i); w = float(rFreq*2pi in double). 16-element groups: lane
 * phases p, p + w, fma(2, w, p), fma(3, w, p), stepped by float(4w) per vector,
 * re-wrapped after each group with fma(trunc(p/2pi), -2pi, p), FL's cosine;
 * the n % 16 tail uses libm cosf with phase += w and a double compare against
 * 2pi. phase[0] is updated.
 */
export function tone32f(dst: Float32Array, n: number, magn: number, rFreq: number, phase: Float32Array, dstOff = 0, phaseOff = 0): void {
  const m = f32(magn);
  const w = f32(f32(rFreq) * TWO_PI_D);
  const p0 = phase[phaseOff];
  const P = toneP;
  P[0] = p0; P[1] = p0 + w; P[2] = fma32(2, w, p0); P[3] = fma32(3, w, p0);
  let i = 0;
  if (n >= 16) {
    const w4 = f32(w * 4);
    for (; n - i >= 16; i += 16) {
      for (let q = 0; q < 4; q++) {
        if (q > 0) for (let l = 0; l < 4; l++) P[l] = P[l] + w4;
        for (let l = 0; l < 4; l++) dst[dstOff + i + 4 * q + l] = toneCos(P[l]) * m;
      }
      for (let l = 0; l < 4; l++) {
        const v = f32(P[l] + w4);
        P[l] = fma32(Math.trunc(f32(v * TN_I2PI)), TN_N2PI, v);
      }
    }
  }
  let s = P[0];
  for (; i < n; i++) {
    dst[dstOff + i] = cosfLibm(s) * m;
    s = f32(s + w);
    if (s > TWO_PI_D) s = f32(s - TWO_PI_D);
  }
  phase[phaseOff] = s;
}

// ---------------------------------------------------------------------------
// Gaussian random numbers (ippsRandGauss_Direct_32f, the library's own code)

const rgU1 = new Float32Array(4), rgU2 = new Float32Array(4), rgOut = new Float32Array(8);
const RG_NPIO4 = bitsf32(0xbf490fdb), RG_2PI = bitsf32(0x40c90fdb);

/**
 * ippsRandGauss_Direct_32f(pDst, len, mean, stdDev, pSeed): Box-Muller on the
 * uniform LCG lanes (see randUniform32f), 8 outputs per step from two
 * 4-lane draws u1 = 1 - u, u2: r = sqrt(-2*log(u1)) * stdDev (FL's cephes
 * logf), theta = u2*2pi, cephes sin/cos with one fused pi/4 step; dst =
 * fma(r, cos, mean) for lanes 0..3 and fma(r, sin, mean) for 4..7; the last
 * step is computed fully and truncated. seed[0] is updated.
 */
export function randGauss32f(dst: Float32Array, n: number, mean: number, stdDev: number, seed: Uint32Array, dstOff = 0): void {
  if (n < 1) return;
  const mu = f32(mean), sd = f32(stdDev);
  rngInit(seed[0]);
  for (let i = 0; i < n; i += 8) {
    rngStep();
    for (let l = 0; l < 4; l++) rgU1[l] = 1 - rngU[l];
    rngStep();
    for (let l = 0; l < 4; l++) rgU2[l] = rngU[l];
    for (let l = 0; l < 4; l++) {
      const u1 = rgU1[l];
      const rad = f32(f32(Math.sqrt(f32(cephesLog(f32bits(u1)) * -2))) * sd);
      const th = f32(rgU2[l] * RG_2PI);
      const a = Math.abs(th);
      const t = f32(a * TN_4OPI);
      const j = t >= 4294967295 ? 4294967295 : Math.trunc(t);
      const j1 = (j + 1) >>> 0;
      const x = fma32((j1 & ~1) >>> 0, RG_NPIO4, a);
      const z = f32(x * x);
      let c = fma32(z, TN_C0, TN_C1);
      c = fma32(c, z, TN_C2);
      const cv = f32(fma32(f32(z * z), c, f32(z * -0.5)) + 1);
      let sp = fma32(z, -TN_S0, TN_S1);
      sp = fma32(sp, z, TN_S2);
      const sv = fma32(f32(z * x), sp, x);
      const m2 = (j1 & 2) === 0;
      let so = m2 ? sv : cv, co = m2 ? cv : sv;
      if (!(((j1 & 4) === 0) !== (th < 0))) so = -so;
      if ((((j - 1) >>> 0) & 4) === 0) co = -co;
      rgOut[l] = fma32(rad, co, mu);
      rgOut[4 + l] = fma32(rad, so, mu);
    }
    for (let l = 0; l < 8 && i + l < n; l++) dst[dstOff + i + l] = rgOut[l];
  }
  seed[0] = rng[3];
}

// ---------------------------------------------------------------------------
// Real FFT (ippsFFTInit_R_32f / FFTFwd_RToPack_32f / FFTInv_PackToR_32f and the
// _I forms; Apple vDSP_fft_zrop / zrip with stride-2 split complex)
//
// FL's wrapper views the N real samples as N/2 complex values z[j] = x[2j] +
// i x[2j+1] (stride 2) and calls vDSP's real FFT, then scales (0.5, 0.5/N or
// 0.5/sqrt(N) forward; 1, 1/N or 1/sqrt(N) inverse, per the IPP flag) and
// moves between vDSP's packing ([2 DC, 2 Nyquist, re1, im1, ...]) and IPP's
// Pack format ([DC, re1, im1, ..., Nyquist]). vDSP's real FFT on this machine
// (M4 Pro, strided path) is: a complex FFT of size M = N/2, then a split pass
// with twiddles c_k = cosf(k*w), s_k = sin(k*w) (libm, w = float(2pi)/N).
// The complex FFT (forward = the e^(+i) kernel on swapped re/im) is an
// in-place Cooley-Tukey with natural-order input and bit-reversed output:
// a radix-4 (log2 M even) or radix-8 (odd) first pass without twiddles, then
// radix-4 passes whose group twiddles W^bitrev(g) are kept in tangent form
// (cos t, tan t, cos 2t, tan 2t, cos 3t / cos t, tan 3t from double sincos)
// and applied with fused multiply-adds, the last pass on groups of 4, then
// the bit-reversal permutation. M < 16 uses vDSP's unrolled 1/2/4/8 kernels.

/** IPP FFT flags. */
export const IPP_FFT_DIV_FWD_BY_N = 1, IPP_FFT_DIV_INV_BY_N = 2, IPP_FFT_DIV_BY_SQRTN = 4, IPP_FFT_NODIV_BY_ANY = 8;

export interface FFTSpecR32f {
  order: number;
  flag: number;
  /** real length N = 2^order */
  n: number;
  /** split-pass twiddles: [0, N/4) cos, [N/4, N/2) sin */
  tw: Float32Array;
  /** tangent-form group twiddles, 6 floats per group */
  gt: Float32Array;
  /** bit-reversal permutation of the complex size */
  rev: Int32Array;
  // work buffers (complex components and permutation scratch)
  p: Float32Array;
  q: Float32Array;
  tp: Float32Array;
  tq: Float32Array;
}

const FFT_R = bitsf32(0x3f3504f3); // sqrt(1/2)

function fftGroupTwiddles(count: number): Float32Array {
  const t = new Float32Array(6 * Math.max(count, 1));
  for (let g = 0; g < count; g++) {
    // angle 2pi * bitreverse64(4g) / 2^64
    let d = 0;
    for (let x = g, b = 0; x > 0; x = Math.floor(x / 2), b++) if (x & 1) d += 2 ** (-3 - b);
    const th = d * 6.283185307179586;
    const c1 = Math.cos(th), s1 = Math.sin(th);
    const th2 = th + th, c2 = Math.cos(th2), s2 = Math.sin(th2);
    const th3 = th * 3, c3 = Math.cos(th3), s3 = Math.sin(th3);
    t[6 * g] = c1; t[6 * g + 1] = s1 / c1; t[6 * g + 2] = c2; t[6 * g + 3] = s2 / c2; t[6 * g + 4] = c3 / c1; t[6 * g + 5] = s3 / c3;
  }
  return t;
}

/** ippsFFTInit_R_32f(order, flag): spec with tables and work buffers (allocates; do it at setup time). */
export function fftInitR32f(order: number, flag: number): FFTSpecR32f {
  const n = 2 ** order, m = Math.max(n >> 1, 1);
  const tw = new Float32Array(Math.max(n >> 1, 1));
  if (n >= 4) {
    const w = f32(f32(6.283185307179586) / n), q4 = n >> 2;
    for (let k = 1; k <= q4; k++) {
      const a = f32(k * w);
      tw[k - 1] = cosfLibm(a);
      tw[q4 + k - 1] = Math.sin(a);
    }
  }
  const lg = Math.max(order - 1, 0);
  const rev = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    let r = 0;
    for (let b = 0, x = i; b < lg; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  return {
    order, flag, n, tw, gt: fftGroupTwiddles(m >> 2), rev,
    p: new Float32Array(m), q: new Float32Array(m), tp: new Float32Array(m), tq: new Float32Array(m),
  };
}

/** Radix-4 butterfly without twiddles on a, a+s, a+2s, a+3s (outputs in bit-reversed order). */
function fftBf4(p: Float32Array, q: Float32Array, a: number, s: number): void {
  const b = a + s, c = b + s, d = c + s;
  const ap = p[a], aq = q[a], bp = p[b], bq = q[b], cp = p[c], cq = q[c], dp = p[d], dq = q[d];
  const s16 = f32(ap + cp), s17 = f32(aq + cq), s18 = f32(bp + dp), s19 = f32(bq + dq);
  const s0 = f32(ap - cp), s1 = f32(aq - cq), s2 = f32(bp - dp), s3 = f32(bq - dq);
  p[a] = s16 + s18; q[a] = s17 + s19;
  p[b] = s16 - s18; q[b] = s17 - s19;
  p[c] = s0 - s3; q[c] = s1 + s2;
  p[d] = s0 + s3; q[d] = s1 - s2;
}

/** Radix-4 butterfly with tangent-form twiddles T[o..o+5] (fused multiply-adds). */
function fftBf4T(p: Float32Array, q: Float32Array, a: number, s: number, T: Float32Array, o: number): void {
  const b = a + s, c = b + s, d = c + s;
  const c1 = T[o], t1 = T[o + 1], c2 = T[o + 2], t2 = T[o + 3], c3 = T[o + 4], t3 = T[o + 5];
  const ap = p[a], aq = q[a], bp = p[b], bq = q[b], cp = p[c], cq = q[c], dp = p[d], dq = q[d];
  const x0 = fma32(-t2, cq, cp), x1 = fma32(t2, cp, cq);
  const y0 = fma32(-t1, bq, bp), y1 = fma32(t1, bp, bq);
  const z0 = fma32(-t3, dq, dp), z1 = fma32(t3, dp, dq);
  const u0 = fma32(c2, x0, ap), u1 = fma32(-c2, x0, ap);
  const v0 = fma32(c3, z0, y0), v1 = fma32(-c3, z0, y0);
  const w0 = fma32(c3, z1, y1), w1 = fma32(-c3, z1, y1);
  const r0 = fma32(c2, x1, aq), r1 = fma32(-c2, x1, aq);
  p[a] = fma32(c1, v0, u0); q[a] = fma32(c1, w0, r0);
  p[b] = fma32(-c1, v0, u0); q[b] = fma32(-c1, w0, r0);
  p[c] = fma32(-c1, w1, u1); q[c] = fma32(c1, v1, r1);
  p[d] = fma32(c1, w1, u1); q[d] = fma32(-c1, v1, r1);
}

/** vDSP's radix-8 first pass (no twiddles; sqrt(1/2) multiplies not fused). */
function fftBf8(p: Float32Array, q: Float32Array, j: number, s: number): void {
  const i0 = j, i1 = j + s, i2 = i1 + s, i3 = i2 + s, i4 = i3 + s, i5 = i4 + s, i6 = i5 + s, i7 = i6 + s;
  const e0p = p[i0], e0q = q[i0], e1p = p[i1], e1q = q[i1], e2p = p[i2], e2q = q[i2], e3p = p[i3], e3q = q[i3];
  const e4p = p[i4], e4q = q[i4], e5p = p[i5], e5q = q[i5], e6p = p[i6], e6q = q[i6], e7p = p[i7], e7q = q[i7];
  const a0 = f32(e0p + e4p), a1 = f32(e0q + e4q), a2 = f32(e1p + e5p), a3 = f32(e1q + e5q);
  const a4 = f32(e2p + e6p), a5 = f32(e2q + e6q), a6 = f32(e3p + e7p), a7 = f32(e3q + e7q);
  const d1 = f32(e0p - e4p), d2 = f32(e0q - e4q), d3 = f32(e1p - e5p), d4 = f32(e1q - e5q);
  const d5 = f32(e2p - e6p), d6 = f32(e2q - e6q), d7 = f32(e3p - e7p), d8 = f32(e3q - e7q);
  const b0 = f32(a0 + a4), b1 = f32(a1 + a5), b2 = f32(a2 + a6), b3 = f32(a3 + a7);
  const b4 = f32(a0 - a4), b5 = f32(a1 - a5), b6 = f32(a2 - a6), b7 = f32(a3 - a7);
  const u0 = f32(d1 - d6), u1 = f32(d2 + d5), u2 = f32(d3 - d8), u3 = f32(d4 + d7);
  const u4 = f32(d1 + d6), u5 = f32(d2 - d5), u6 = f32(d3 + d8), u7 = f32(d4 - d7);
  const w0 = f32(f32(u2 - u3) * FFT_R), w1 = f32(f32(u3 + u2) * FFT_R), w2 = f32(f32(u7 + u6) * FFT_R), w3 = f32(f32(u6 - u7) * FFT_R);
  p[i0] = b0 + b2; q[i0] = b1 + b3;
  p[i1] = b0 - b2; q[i1] = b1 - b3;
  p[i2] = b4 - b7; q[i2] = b5 + b6;
  p[i3] = b4 + b7; q[i3] = b5 - b6;
  p[i4] = u0 + w0; q[i4] = u1 + w1;
  p[i5] = u0 - w0; q[i5] = u1 - w1;
  p[i6] = u4 - w2; q[i6] = u5 + w3;
  p[i7] = u4 + w2; q[i7] = u5 - w3;
}

/** vDSP's unrolled complex FFT for sizes 1, 2, 4, 8 (strided variants; natural order). */
function fftSmall(p: Float32Array, q: Float32Array, m: number): void {
  if (m === 2) {
    const a = p[0], b = q[0], c = p[1], d = q[1];
    p[0] = a + c; q[0] = b + d; p[1] = a - c; q[1] = b - d;
  } else if (m === 4) {
    const e0p = p[0], e0q = q[0], e1p = p[1], e1q = q[1], e2p = p[2], e2q = q[2], e3p = p[3], e3q = q[3];
    const s16 = f32(e0p + e2p), s17 = f32(e0q + e2q), s0 = f32(e0p - e2p), s1 = f32(e0q - e2q);
    const s2 = f32(e1p + e3p), s3 = f32(e1q + e3q), s4 = f32(e1p - e3p), s5 = f32(e1q - e3q);
    p[0] = s16 + s2; q[0] = s17 + s3;
    p[2] = s16 - s2; q[2] = s17 - s3;
    p[1] = s0 - s5; q[1] = s1 + s4;
    p[3] = s0 + s5; q[3] = s1 - s4;
  } else if (m === 8) {
    const e0p = p[0], e0q = q[0], e1p = p[1], e1q = q[1], e2p = p[2], e2q = q[2], e3p = p[3], e3q = q[3];
    const e4p = p[4], e4q = q[4], e5p = p[5], e5q = q[5], e6p = p[6], e6q = q[6], e7p = p[7], e7q = q[7];
    const a0 = f32(e0p + e4p), a1 = f32(e0q + e4q), a2 = f32(e1p + e5p), a3 = f32(e1q + e5q);
    const a4 = f32(e2p + e6p), a5 = f32(e2q + e6q), a6 = f32(e3p + e7p), a7 = f32(e3q + e7q);
    const d0 = f32(e0p - e4p), d1 = f32(e0q - e4q), d2 = f32(e1p - e5p), d3 = f32(e1q - e5q);
    const d4 = f32(e2p - e6p), d5 = f32(e2q - e6q), d6 = f32(e3p - e7p), d7 = f32(e3q - e7q);
    const b0 = f32(a0 + a4), b1 = f32(a1 + a5), b2 = f32(a2 + a6), b3 = f32(a3 + a7);
    const b4 = f32(a0 - a4), b5 = f32(a1 - a5), b6 = f32(a2 - a6), b7 = f32(a3 - a7);
    const u0 = f32(d0 - d5), u1 = f32(d1 + d4), u2 = f32(d2 - d7), u3 = f32(d3 + d6);
    const u4 = f32(d0 + d5), u5 = f32(d1 - d4), u6 = f32(d2 + d7), u7 = f32(d3 - d6);
    const v0 = f32(u2 - u3), v1 = f32(u3 + u2), v2 = f32(u7 + u6), v3 = f32(u6 - u7);
    p[0] = b0 + b2; q[0] = b1 + b3;
    p[4] = b0 - b2; q[4] = b1 - b3;
    p[2] = b4 - b7; q[2] = b5 + b6;
    p[6] = b4 + b7; q[6] = b5 - b6;
    p[1] = fma32(v0, FFT_R, u0); q[1] = fma32(v1, FFT_R, u1);
    p[5] = fma32(-v0, FFT_R, u0); q[5] = fma32(-v1, FFT_R, u1);
    p[3] = fma32(-v2, FFT_R, u4); q[3] = fma32(v3, FFT_R, u5);
    p[7] = fma32(v2, FFT_R, u4); q[7] = fma32(-v3, FFT_R, u5);
  }
}

/** vDSP complex FFT kernel (e^+i) of size m on the spec's (p, q) buffers, natural-order result. */
function fftComplex(sp: FFTSpecR32f, m: number): void {
  const p = sp.p, q = sp.q;
  if (m < 16) { fftSmall(p, q, m); return; }
  const T = sp.gt;
  let groups: number, size: number;
  if ((Math.round(Math.log2(m)) & 1) === 0) {
    size = m >> 2;
    for (let j = 0; j < size; j++) fftBf4(p, q, j, size);
    groups = 4;
  } else {
    size = m >> 3;
    for (let j = 0; j < size; j++) fftBf8(p, q, j, size);
    groups = 8;
  }
  if (size >= 5) {
    for (;;) {
      const gs = size, qs = size >> 2;
      for (let j = 0; j < qs; j++) fftBf4(p, q, j, qs);
      for (let g = 1; g < groups; g++) {
        const base = g * gs;
        for (let j = 0; j < qs; j++) fftBf4T(p, q, base + j, qs, T, 6 * g);
      }
      groups *= 4;
      size = qs;
      if (gs <= 19) break;
    }
  }
  for (let g = 0; g < groups; g++) fftBf4T(p, q, 4 * g, 1, T, 6 * g);
  const tp = sp.tp, tq = sp.tq, rev = sp.rev;
  tp.set(p.subarray(0, m)); tq.set(q.subarray(0, m));
  for (let f = 0; f < m; f++) { const s = rev[f]; p[f] = tp[s]; q[f] = tq[s]; }
}

/** vDSP forward real FFT of x[xo .. xo+n) into vDSP packing at y[yo ..] (zrop / zrip forward, stride 2). */
function vdspRealFwd(sp: FFTSpecR32f, x: Float32Array, xo: number, y: Float32Array, yo: number): void {
  const n = sp.n, m = n >> 1, p = sp.p, q = sp.q, T = sp.tw;
  // forward = e^+i kernel with the components swapped: first = odd samples, second = even
  for (let j = 0; j < m; j++) { q[j] = x[xo + 2 * j]; p[j] = x[xo + 2 * j + 1]; }
  fftComplex(sp, m);
  // split pass on C.re = q, C.im = p
  const s0 = f32(q[0] + q[0]), s1 = f32(p[0] + p[0]);
  q[0] = s0 + s1; p[0] = s0 - s1;
  if (n >= 4) {
    const q4 = n >> 2;
    for (let k = 1; k <= q4; k++) {
      const b = m - k;
      const ar = q[k], ai = p[k], br = q[b], bi = p[b];
      const e = f32(ar + br), f = f32(ai - bi), g = f32(ai + bi), h = f32(br - ar);
      const c = T[k - 1], s = T[q4 + k - 1];
      const u = fma32(c, g, f32(h * s));
      const v = fma32(c, h, -f32(s * g));
      q[k] = e + u; p[k] = f + v;
      p[b] = v - f; q[b] = e - u;
    }
  }
  for (let j = 0; j < m; j++) { y[yo + 2 * j] = q[j]; y[yo + 2 * j + 1] = p[j]; }
}

/** vDSP inverse real FFT (zrip, stride 2) of vDSP-packed x[xo ..] into y[yo .. yo+n). */
function vdspRealInv(sp: FFTSpecR32f, x: Float32Array, xo: number, y: Float32Array, yo: number): void {
  const n = sp.n, m = n >> 1, p = sp.p, q = sp.q, T = sp.tw;
  for (let j = 0; j < m; j++) { p[j] = x[xo + 2 * j]; q[j] = x[xo + 2 * j + 1]; }
  const a0 = p[0], b0 = q[0];
  p[0] = a0 + b0; q[0] = a0 - b0;
  if (n >= 4) {
    const q4 = n >> 2;
    for (let k = 0; k < q4; k++) {
      const a = k + 1, b = m - k - 1;
      const ar = p[a], ai = q[a], br = p[b], bi = q[b];
      const e = f32(ar + br), f = f32(ai - bi), g = f32(ai + bi), h = f32(ar - br);
      const c = T[k], s = T[q4 + k];
      const u = fma32(c, g, f32(h * s));
      const v = fma32(c, h, -f32(s * g));
      p[a] = e - u; q[a] = f + v;
      p[b] = e + u; q[b] = v - f;
    }
  }
  fftComplex(sp, m);
  for (let j = 0; j < m; j++) { y[yo + 2 * j] = p[j]; y[yo + 2 * j + 1] = q[j]; }
}

function fftFwdScale(sp: FFTSpecR32f): number {
  if (sp.flag & IPP_FFT_DIV_FWD_BY_N) return f32(0.5 / sp.n);
  if (sp.flag & IPP_FFT_DIV_BY_SQRTN) return f32(0.5 / f32(Math.sqrt(sp.n)));
  return 0.5;
}

function fftInvScale(sp: FFTSpecR32f): number {
  if (sp.flag & IPP_FFT_DIV_INV_BY_N) return f32(1 / sp.n);
  if (sp.flag & IPP_FFT_DIV_BY_SQRTN) return f32(1 / Math.sqrt(sp.n));
  return 1;
}

/**
 * ippsFFTFwd_RToPack_32f(pSrc, pDst, pSpec, pBuffer): n = 2^order real samples
 * -> Pack [DC, re1, im1, ..., re(n/2-1), im(n/2-1), Nyquist] (in place allowed).
 */
export function fftFwdRToPack32f(src: Float32Array, dst: Float32Array, spec: FFTSpecR32f, srcOff = 0, dstOff = 0): void {
  const n = spec.n;
  vdspRealFwd(spec, src, srcOff, dst, dstOff);
  const s = fftFwdScale(spec);
  for (let i = 0; i < n; i++) dst[dstOff + i] *= s;
  if (n >= 2) {
    const nyq = dst[dstOff + 1];
    dst.copyWithin(dstOff + 1, dstOff + 2, dstOff + n);
    dst[dstOff + n - 1] = nyq;
  }
}

/** ippsFFTFwd_RToPack_32f_I(pSrcDst, pSpec, pBuffer). */
export function fftFwdRToPack32fI(srcDst: Float32Array, spec: FFTSpecR32f, off = 0): void {
  fftFwdRToPack32f(srcDst, srcDst, spec, off, off);
}

/** ippsFFTInv_PackToR_32f(pSrc, pDst, pSpec, pBuffer): Pack -> n real samples (in place allowed). */
export function fftInvPackToR32f(src: Float32Array, dst: Float32Array, spec: FFTSpecR32f, srcOff = 0, dstOff = 0): void {
  const n = spec.n;
  if (n >= 2) {
    const nyq = src[srcOff + n - 1], dc = src[srcOff];
    if (src === dst) dst.copyWithin(dstOff + 2, srcOff + 1, srcOff + n - 1);
    else dst.set(src.subarray(srcOff + 1, srcOff + n - 1), dstOff + 2);
    dst[dstOff] = dc;
    dst[dstOff + 1] = nyq;
  } else dst[dstOff] = src[srcOff];
  vdspRealInv(spec, dst, dstOff, dst, dstOff);
  const s = fftInvScale(spec);
  for (let i = 0; i < n; i++) dst[dstOff + i] *= s;
}

/** ippsFFTInv_PackToR_32f_I(pSrcDst, pSpec, pBuffer). */
export function fftInvPackToR32fI(srcDst: Float32Array, spec: FFTSpecR32f, off = 0): void {
  fftInvPackToR32f(srcDst, srcDst, spec, off, off);
}

/**
 * ippsFFTFwd_RToCCS_32f_I(pSrcDst, pSpec, pBuffer) with pBuffer = NULL (FL's
 * stride-2 path; FL takes a different vDSP path when a buffer is passed):
 * CCS [re0, 0, re1, im1, ..., re(n/2), 0], n + 2 floats.
 */
export function fftFwdRToCCS32fI(srcDst: Float32Array, spec: FFTSpecR32f, off = 0): void {
  const n = spec.n;
  vdspRealFwd(spec, srcDst, off, srcDst, off);
  const s = fftFwdScale(spec);
  for (let i = 0; i < n; i++) srcDst[off + i] *= s;
  const nyq = srcDst[off + 1];
  srcDst[off + 1] = 0;
  srcDst[off + n] = nyq;
  srcDst[off + n + 1] = 0;
}

/** ippsFFTInv_CCSToR_32f_I(pSrcDst, pSpec, pBuffer): CCS (n + 2 floats) -> n real samples. */
export function fftInvCCSToR32fI(srcDst: Float32Array, spec: FFTSpecR32f, off = 0): void {
  const n = spec.n;
  srcDst[off + 1] = srcDst[off + n];
  vdspRealInv(spec, srcDst, off, srcDst, off);
  const s = fftInvScale(spec);
  for (let i = 0; i < n; i++) srcDst[off + i] *= s;
}
