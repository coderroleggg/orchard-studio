// Harmor's own small NEON vector helpers (Harmor_x64 arm64 slice, 0x2aa8..0x4b60):
// float32 lane-wise loops over groups of 8 values. They process floor(n / 8) * 8
// elements (the remainder is left untouched, as in FL) unless noted. Every
// product / sum is rounded to float32 per operation (no fused multiply-add).

const f = Math.fround;

/** 0x41c4: b[i] *= a[i] (groups of 8). */
export function mulV(a: Float32Array, b: Float32Array, n: number, ao = 0, bo = 0): void {
  const m = (n >> 3) << 3;
  for (let i = 0; i < m; i++) b[bo + i] = f(b[bo + i] * a[ao + i]);
}

/** 0x4204: dst[i] = a[i] * b[i] (groups of 8, then one group of 4 when 4..7 remain). */
export function mul3V(a: Float32Array, b: Float32Array, dst: Float32Array, n: number, ao = 0, bo = 0, dsto = 0): void {
  let m = (n >> 3) << 3;
  if (n - m >= 4) m += 4;
  for (let i = 0; i < m; i++) dst[dsto + i] = f(a[ao + i] * b[bo + i]);
}

/** 0x44e8: dst[i] = src[i] * s (groups of 8). */
export function mulCV(src: Float32Array, dst: Float32Array, n: number, s: number, so = 0, dsto = 0): void {
  const m = (n >> 3) << 3;
  const c = f(s);
  for (let i = 0; i < m; i++) dst[dsto + i] = f(src[so + i] * c);
}

/** 0x44bc: x[i] *= s (groups of 8). */
export function mulCI(x: Float32Array, n: number, s: number, o = 0): void {
  const m = (n >> 3) << 3;
  const c = f(s);
  for (let i = 0; i < m; i++) x[o + i] = f(x[o + i] * c);
}

/** 0x4524: dst[i] = src[i] * s + dst[i] * (1 - s) (groups of 8; 1 - s in float32). */
export function lerpV(src: Float32Array, dst: Float32Array, n: number, s: number, so = 0, dsto = 0): void {
  const m = (n >> 3) << 3;
  const a = f(s), b = f(1 - a);
  for (let i = 0; i < m; i++) dst[dsto + i] = f(f(src[so + i] * a) + f(dst[dsto + i] * b));
}

/** 0x4b60: dst[i] = a[i] * s1 + b[i] * s0 over `groups` groups of 8 (Harmor passes s1 = 1 - s0). */
export function mixV(groups: number, a: Float32Array, b: Float32Array, dst: Float32Array, s0: number, s1: number): void {
  const m = groups << 3;
  const c0 = f(s0), c1 = f(s1);
  for (let i = 0; i < m; i++) dst[i] = f(f(a[i] * c1) + f(b[i] * c0));
}

/**
 * 0x2aa8: sum of squares (groups of 8; two 4-lane accumulators, lanes 0..3 and
 * 4..7 of each group; then acc = acc1 + acc0 lane-wise, (l0 + l1) + (l2 + l3)).
 * Returns 0 when n < 8.
 */
export function sumSq(x: Float32Array, n: number, o = 0): number {
  const g = n >> 3;
  if (g === 0) return 0;
  let a0 = 0, a1 = 0, a2 = 0, a3 = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0;
  for (let k = 0, i = o; k < g; k++, i += 8) {
    a0 = f(a0 + f(x[i] * x[i])); a1 = f(a1 + f(x[i + 1] * x[i + 1]));
    a2 = f(a2 + f(x[i + 2] * x[i + 2])); a3 = f(a3 + f(x[i + 3] * x[i + 3]));
    b0 = f(b0 + f(x[i + 4] * x[i + 4])); b1 = f(b1 + f(x[i + 5] * x[i + 5]));
    b2 = f(b2 + f(x[i + 6] * x[i + 6])); b3 = f(b3 + f(x[i + 7] * x[i + 7]));
  }
  const l0 = f(b0 + a0), l1 = f(b1 + a1), l2 = f(b2 + a2), l3 = f(b3 + a3);
  return f(f(l0 + l1) + f(l2 + l3));
}

/** 0xd9b60: x[0..3] *= s[0..3] (the sub-harmonic slot levels). */
export function mul4(s: Float32Array, x: Float32Array): void {
  for (let i = 0; i < 4; i++) x[i] = f(x[i] * s[i]);
}

/** FL's Round (frintx, ties to even) for doubles. */
export function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r;
}

/** FPC Trunc toward zero (fcvtzs) clamped to int32. */
export function trunc32(x: number): number {
  if (!(x === x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return x < 0 ? Math.ceil(x) : Math.floor(x);
}

/** IPP Threshold_GT (in place): x[i] = min(x[i], level). */
export function thresholdGT(x: Float32Array | Float64Array, n: number, level: number, o = 0): void {
  for (let i = 0; i < n; i++) if (x[o + i] > level) x[o + i] = level;
}

/** IPP Threshold_LT (in place): x[i] = max(x[i], level). */
export function thresholdLT(x: Float32Array | Float64Array, n: number, level: number, o = 0): void {
  for (let i = 0; i < n; i++) if (x[o + i] < level) x[o + i] = level;
}
