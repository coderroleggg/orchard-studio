// FL Harmor's hand-written NEON kernels used by the partial units (FL 2026
// Harmor_x64, arm64 slice: 0x2500..0x2a40, 0x4000..0x4910). Every kernel works in
// 8-element blocks (4 for 0x46f0) and silently skips the n % 8 tail unless noted;
// float32 lanes round after every operation, exactly like fmul.4s / fadd.4s, and
// fmadd is a single-rounding fused multiply-add.

import { fma32 } from './ipp';

const f = Math.fround;

/** Elements an 8-lane FL kernel processes for a count n (floor(n / 8) * 8). */
export function n8(n: number): number {
  return n >= 8 ? n & ~7 : 0;
}

/** Elements the 8 + 4 kernels (0x4344, 0x43d0) process: 8-blocks, then one 4-block. */
function n84(n: number): number {
  if (n < 4) return 0;
  const a = n8(n);
  return n - a >= 4 ? a + 4 : a;
}

/** 0x40b4 (protection): d[i] += (s[i] - d[i]) * (t[i] * k). */
export function kProtect(d: Float32Array, s: Float32Array, t: Float32Array, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) {
    const w = f(t[i] * k);
    d[i] = f(d[i] + f(f(s[i] - d[i]) * w));
  }
}

/** 0x4344 (harmonizer mask): d[i] = s[i] + m[i] * (d[i] * k - s[i]) (8 + 4 blocks). */
export function kMaskMix(m: Float32Array, mo: number, s: Float32Array, so: number, d: Float32Array, dof: number, n: number, k: number): void {
  const c = n84(n);
  for (let i = 0; i < c; i++) {
    const x = f(f(d[dof + i] * k) - s[so + i]);
    d[dof + i] = f(s[so + i] + f(m[mo + i] * x));
  }
}

/** 0x43d0 (masked blur mix): d[i] += (m[i] * k) * (s[i] - d[i]) (8 + 4 blocks). */
export function kMaskBlend(m: Float32Array, mo: number, s: Float32Array, so: number, d: Float32Array, dof: number, n: number, k: number): void {
  const c = n84(n);
  for (let i = 0; i < c; i++) {
    const w = f(m[mo + i] * k);
    d[dof + i] = f(d[dof + i] + f(w * f(s[so + i] - d[dof + i])));
  }
}

/** 0x4524 (blur mix): d[i] = s[i] * k + d[i] * (1 - k). */
export function kBlend(s: Float32Array, so: number, d: Float32Array, dof: number, n: number, k: number): void {
  const m = n8(n), k1 = f(1 - k);
  for (let i = 0; i < m; i++) d[dof + i] = f(f(s[so + i] * k) + f(d[dof + i] * k1));
}

/** 0x445c (pluck): a[i] *= g[i]; g[i] *= c[i]. */
export function kPluck(g: Float32Array, a: Float32Array, c: Float32Array, n: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) {
    const x = g[i];
    a[i] = f(x * a[i]);
    g[i] = f(x * c[i]);
  }
}

/** 0x44e8: d[i] = s[i] * k. */
export function kScale(s: Float32Array, d: Float32Array, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) d[i] = f(s[i] * k);
}

/** 0x457c: d[i] = a[i] * k + b[i] * (1 - k). */
export function kLerp(a: Float32Array, b: Float32Array, d: Float32Array, n: number, k: number): void {
  const m = n8(n), k1 = f(1 - k);
  for (let i = 0; i < m; i++) d[i] = f(f(a[i] * k) + f(b[i] * k1));
}

/** 0x4818 (harmonizer): d[j * stride] = fma(s[j], g, d[j * stride]) for every j < n. */
export function kStrideFma(s: Float32Array, so: number, d: Float32Array, dof: number, n: number, stride: number, g: number): void {
  for (let j = 0; j < n; j++) {
    const k = dof + j * stride;
    d[k] = fma32(s[so + j], g, d[k]);
  }
}

/** 0x2658 (time blur): attack toward rising levels, decay toward falling ones. */
export function kTimeBlur(a: Float32Array, st: Float32Array, n: number, att: number, dec: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) {
    const x = a[i], s = st[i];
    const lo = Math.min(x, s);
    const up = f(x + f(f(s - lo) * dec));
    st[i] = f(f(f(lo - x) * att) + up);
  }
}

/** 0x26c4: the same with a per-partial decay coefficient (pluck replaces blur decay). */
export function kTimeBlurC(a: Float32Array, st: Float32Array, n: number, c: Float32Array, att: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) {
    const x = a[i], s = st[i];
    const lo = Math.min(x, s);
    const up = f(x + f(f(s - lo) * c[i]));
    st[i] = f(f(f(lo - x) * att) + up);
  }
}

// ---------------------------------------------------------------- clipping (0x257c..0x29f8)

/** 0x257c: a = min(a, k). */
export function kClipMin(a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) a[ao + i] = Math.min(a[ao + i], k);
}
/** 0x25e0: a = min(a, t * k). */
export function kClipMinT(t: Float32Array, to: number, a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) a[ao + i] = Math.min(a[ao + i], f(t[to + i] * k));
}
/** 0x273c (sharp low): v = 1 - min(a k, 1); a -= a v^2. */
export function kClipSharp(a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) {
    const x = a[ao + i];
    let v = f(1 - Math.min(f(x * k), 1));
    v = f(v * v);
    a[ao + i] = f(x - f(x * v));
  }
}
/** 0x2790: sharp low with a table: v = 1 - min(t a k, 1). */
export function kClipSharpT(t: Float32Array, to: number, a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) {
    const x = a[ao + i];
    let v = f(1 - Math.min(f(f(t[to + i] * x) * k), 1));
    v = f(v * v);
    a[ao + i] = f(x - f(x * v));
  }
}
/** 0x2800 (soft low): v = (1 - min(a k, 1))^16; a -= a v. */
export function kClipSoft(a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) {
    const x = a[ao + i];
    let v = f(1 - Math.min(f(x * k), 1));
    v = f(v * v); v = f(v * v); v = f(v * v); v = f(v * v);
    a[ao + i] = f(x - f(x * v));
  }
}
/** 0x286c: soft low with a table. */
export function kClipSoftT(t: Float32Array, to: number, a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) {
    const x = a[ao + i];
    let v = f(1 - Math.min(f(f(t[to + i] * x) * k), 1));
    v = f(v * v); v = f(v * v); v = f(v * v); v = f(v * v);
    a[ao + i] = f(x - f(x * v));
  }
}
/** 0x28f4 (subtraction): a = max(a - k, 0). */
export function kClipSub(a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) a[ao + i] = Math.max(f(a[ao + i] - k), 0);
}
/** 0x292c: a = max(a - t k, 0). */
export function kClipSubT(t: Float32Array, to: number, a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) a[ao + i] = Math.max(f(a[ao + i] - f(t[to + i] * k)), 0);
}
/** 0x297c (hard low): a = a > k ? a : 0 (fcmgt mask). */
export function kClipGate(a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) { const x = a[ao + i]; a[ao + i] = x > k ? x : 0; }
}
/** 0x29b0: a = a > t k ? a : 0. */
export function kClipGateT(t: Float32Array, to: number, a: Float32Array, ao: number, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) { const x = a[ao + i]; a[ao + i] = x > f(t[to + i] * k) ? x : 0; }
}

// ---------------------------------------------------------------- prism (double lanes)

/** 0x47ac (prism add): f[i] += t[i] * k. */
export function kPrismAdd(fr: Float64Array, t: Float64Array, n: number, k: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) fr[i] = fr[i] + t[i] * k;
}
/** 0x46f0 (prism multiply, 4-blocks): f[i] = c + (f[i] - c) * (t[i] * a + b). */
export function kPrismMul(fr: Float64Array, t: Float64Array, n: number, c: number, a: number, b: number): void {
  const m = n >= 4 ? n & ~3 : 0;
  for (let i = 0; i < m; i++) fr[i] = c + (fr[i] - c) * (b + t[i] * a);
}
/** 0x4758 (flat prism multiply): f[i] = c + f[i] * k. */
export function kPrismFlat(fr: Float64Array, n: number, k: number, c: number): void {
  const m = n8(n);
  for (let i = 0; i < m; i++) fr[i] = c + fr[i] * k;
}

// ---------------------------------------------------------------- convolution

// Accelerate's vDSP_conv kernel for a reversed filter (libvDSP, the routine
// vDSP_conv tail-calls for unit strides and filter stride -1), as scalar tap
// schedules. 16-output blocks keep three accumulators per output (A, B, C) and
// take the taps in 8-tap blocks (first block and later ones assign them
// differently; the second output vector of a block has its own order), then a
// 4-tap block (B, C, B, A), single taps into A, and B + C + A; 4-output blocks
// use four accumulators per output (taps j and j + 4 of an 8-block apart, folded
// after the 8-blocks); single outputs fold two 4-lane accumulators pairwise and
// add the remaining taps by fmadd. Verified against vDSP_conv bit for bit.
// Pairs (tap offset, accumulator 0 = A, 1 = B, 2 = C) per 8-tap block.
const CV_FIRST = [[0, 0, 3, 0, 6, 0, 1, 1, 4, 1, 7, 1, 2, 2, 5, 2], [0, 0, 4, 0, 7, 0, 1, 1, 5, 1, 3, 1, 2, 2, 6, 2]];
const CV_LATER = [[0, 2, 3, 2, 6, 2, 1, 0, 4, 0, 7, 0, 2, 1, 5, 1], [0, 2, 4, 2, 7, 2, 1, 0, 5, 0, 3, 0, 2, 1, 6, 1]];
const CV_PAD = new Float32Array(2048);
const CV_REV = new Float32Array(512);
const CV_ACC = new Float64Array(8);
const CV_SET = new Uint8Array(8);

/** One tap into accumulator k: the first product rounds (fmul), later ones fuse (fmla). */
function cvOp(k: number, x: number, r: number): void {
  if (CV_SET[k]) CV_ACC[k] = fma32(x, r, CV_ACC[k]);
  else { CV_ACC[k] = f(x * r); CV_SET[k] = 1; }
}
function cvV(k: number): number {
  return CV_SET[k] ? CV_ACC[k] : 0;
}

/**
 * ippsConv_32f(src (len ns), kern (len nk), dst (len ns + nk - 1)) as FL's IPP
 * library runs it: vDSP_conv over the signal padded with nk - 1 zeros (and zeros
 * after it), filter reversed.
 */
export function conv32f(src: Float32Array, so: number, ns: number, kern: Float32Array, ko: number, nk: number, dst: Float32Array, dof: number,
  outLo = 0, outHi = Infinity): void {
  // outLo / outHi: only outputs n in [outLo, outHi) are computed (each with the summation schedule of the
  // full-length call, which depends on n's place among the N outputs); the others are left untouched
  const N = ns + nk - 1, P = nk;
  const A = CV_PAD, R = CV_REV, acc = CV_ACC, set = CV_SET;
  A.fill(0, 0, N + P + 8);
  for (let i = 0; i < ns; i++) A[P - 1 + i] = src[so + i];
  for (let j = 0; j < P; j++) R[j] = kern[ko + P - 1 - j];
  const nb8 = P >> 3, rem = P - 8 * nb8, has4 = rem >= 4, nsg = has4 ? rem - 4 : rem;
  const op = cvOp;
  let n0 = 0;
  for (; N - n0 >= 16; n0 += 16) {
    if (n0 + 16 <= outLo || n0 >= outHi) continue;
    for (let q = 0; q < 16; q++) {
      const n = n0 + q, cls = (q >> 2) === 1 ? 1 : 0;
      if (n < outLo || n >= outHi) continue;
      set[0] = set[1] = set[2] = 0;
      for (let b = 0; b < nb8; b++) {
        const T = b === 0 ? CV_FIRST[cls] : CV_LATER[cls];
        for (let t = 0; t < 16; t += 2) {
          // cvOp inlined: the fused multiply-add's fast path (sum already a float32) without the call
          const j = 8 * b + T[t], k = T[t + 1], x = A[n + j];
          if (set[k]) {
            const a = acc[k];
            if (x === 0 && a !== 0) continue; // a + (+-0) = a exactly
            const r = R[j], s = x * r + a, rr = f(s);
            if (rr === s) acc[k] = rr;
            else {
              const o = rr + 2 * (s - rr); // the other float32 neighbour when s is a midpoint
              acc[k] = f(o) !== o ? rr : fma32(x, r, a);
            }
          } else { acc[k] = f(x * R[j]); set[k] = 1; }
        }
      }
      let j = 8 * nb8;
      if (has4) {
        op(1, A[n + j], R[j]); op(2, A[n + j + 1], R[j + 1]); op(1, A[n + j + 2], R[j + 2]); op(0, A[n + j + 3], R[j + 3]);
        j += 4;
      }
      for (let k = 0; k < nsg; k++, j++) { if (!set[0]) { acc[0] = 0; set[0] = 1; } op(0, A[n + j], R[j]); }
      dst[dof + n] = f(f(cvV(1) + cvV(2)) + cvV(0));
    }
  }
  for (; N - n0 >= 4; n0 += 4) {
    for (let q = 0; q < 4; q++) {
      const n = n0 + q;
      if (n < outLo || n >= outHi) continue;
      set.fill(0);
      for (let b = 0; b < nb8; b++) for (let o = 0; o < 8; o++) { const j = 8 * b + o; op(o, A[n + j], R[j]); }
      if (nb8) for (let i = 0; i < 4; i++) acc[i] = f(acc[i] + acc[4 + i]);
      let j = 8 * nb8;
      if (has4) { for (let o = 0; o < 4; o++) op(o, A[n + j + o], R[j + o]); j += 4; }
      for (let k = 0; k < nsg; k++, j++) { if (!set[0]) { acc[0] = 0; set[0] = 1; } op(0, A[n + j], R[j]); }
      dst[dof + n] = f(f(cvV(0) + cvV(1)) + f(cvV(2) + cvV(3)));
    }
  }
  for (; N - n0 >= 1; n0++) {
    const n = n0;
    if (n < outLo || n >= outHi) continue;
    let s = 0;
    if (nb8) {
      for (let o = 0; o < 8; o++) acc[o] = 0;
      for (let b = 0; b < nb8; b++) for (let o = 0; o < 8; o++) { const j = 8 * b + o; acc[o] = fma32(A[n + j], R[j], acc[o]); }
      const v0 = f(acc[0] + acc[4]), v1 = f(acc[1] + acc[5]), v2 = f(acc[2] + acc[6]), v3 = f(acc[3] + acc[7]);
      s = f(f(v0 + v1) + f(v2 + v3));
    }
    for (let j = 8 * nb8; j < P; j++) s = fma32(A[n + j], R[j], s);
    dst[dof + n] = s;
  }
}
