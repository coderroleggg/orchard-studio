// The two macOS libm routines FL's BooBass depends on bit for bit, emulated
// (disassembled from libsystem_m.dylib, macOS 26 arm64; checked against the
// real functions on all FL pan values and 50 000 random inputs):
// - exp10f: BooBass_Eng's EQ gains and table levels call it; Apple's is not
//   correctly rounded (about 0.6 % of inputs differ by one ulp from
//   Math.pow rounded to float), e.g. the B0 strike's level;
// - __sincosf_stret: FL's circular pan law (FLEngine 0x33b0) for
//   ComputeLRVol. Math.sin / Math.cos rounded to float differ in ~1.3 %.
// JavaScript's Math.pow(2, x) and Math.sin agree with Apple's exp2 / sin for
// every value BooBass rounds to float (checked over all its inputs).

import { f, fma32 } from './f32';

const SPLIT = 134217729; // 2^27 + 1

/** Double fused multiply-add a*b + c (Dekker's exact product, then the sum), arm64 FMADD Dd. */
export function fmaD(a: number, b: number, c: number): number {
  const p = a * b;
  let t = SPLIT * a;
  const ah = t - (t - a), al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b), bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  const s = p + c;
  const bb = s - p;
  const err = (p - (s - bb)) + (c - bb);
  return s + (err + e);
}

// ------------------------------------------------------------------ exp10f
const EXP2_128 = new Float64Array(128);
for (let j = 0; j < 128; j++) EXP2_128[j] = Math.pow(2, j / 128);
const K10 = 425.20679614558236; // 128 log2(10)
const C1 = 0.005415217308896754;
const C2 = 1.4662262378543872e-5;

/** Apple's exp10f: 2^(k/128) from a table times a quadratic in the remainder, in double, rounded to float. */
export function exp10f(x: number): number {
  if (!(Math.abs(x) < 64)) return f(Math.pow(10, x));
  const t = x * K10;
  const a = Math.abs(t);
  let k = Math.floor(a);
  if (a - k >= 0.5) k += 1;
  if (t < 0) k = -k;
  const r = t - k;
  const s = EXP2_128[k & 127] * Math.pow(2, k >> 7);
  const p = fmaD(C2, r, C1) * r;
  return f(fmaD(p, s, s));
}

// ------------------------------------------------------------------ sincosf
const TWO_OVER_PI = 0.6366197723675814;
const A0 = -14.11962047131294, A1 = -8.36721486831633;
const B0 = -15.469930309596, B1 = -14.71749014926;
const SC0 = 0.00015820674370772955, SC1 = 0.0009036317034594685;
const D0 = 40.5713390182018, D1 = 7.367313974172263;
const E0 = 244.7234259671355, E1 = 150.210178361388;

/** Result of sincosf (reused). */
export const sincos = { s: 0, c: 0 };

/** Apple's __sincosf_stret (|x| < 120): sets sincos.s / sincos.c. */
export function sincosf(x: number): void {
  const ax = Math.abs(x);
  if (ax < 2.44140625e-4) {
    sincos.c = f(f(67108864 - ax) * 1.4901161193847656e-8);
    sincos.s = f(fma32(x, 67108864, x) * 1.4901161193847656e-8);
    return;
  }
  if (!(ax < 120)) { sincos.s = f(Math.sin(x)); sincos.c = f(Math.cos(x)); return; }
  const d2 = x * TWO_OVER_PI;
  const fl = Math.floor(d2);
  const fr = d2 - fl;
  const q = fr > 0.5 ? fl + 1 : fr < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1);
  const r = d2 - q;
  const r2 = r * r;
  const v5a = fmaD(r2, r2 + A0, D0), v5b = fmaD(r2, r2 + A1, D1);
  const v6a = fmaD(r2, r2 + B0, E0), v6b = fmaD(r2, r2 + B1, E1);
  let s = f(((r * SC0) * v5a) * v6a);
  let c = f((SC1 * v5b) * v6b);
  const qi = q & 3;
  if (qi & 2) { s = -s; c = -c; }
  if (qi & 1) { sincos.s = c; sincos.c = -s; } else { sincos.s = s; sincos.c = c; }
}
