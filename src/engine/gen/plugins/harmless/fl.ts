// FL Studio 2026 Harmless_x64.dylib (arm64 slice; addresses below are that
// binary's) — numeric helpers and the runtime constants the plugin computes at
// start-up (0x7bae0, 0x1a4d10). FPC code: single-precision operations round to
// float32 after every operation (f32), double ones stay double; FPC's Round is
// ARM frintx (round half to even) then fcvtzs.

export const f32 = Math.fround;

/** ARM frintx (default rounding: nearest, ties to even) of a double. */
export function rint(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** FPC Round(x) to int64, as Harmless uses it (frintx + fcvtzs); results stay small here. */
export function fpcRound(x: number): number {
  const r = rint(x);
  return r !== r ? 0 : r;
}

/** Truncated 32-bit integer of a double (fcvtzs w). */
export function truncI(x: number): number {
  return x !== x ? 0 : Math.trunc(x) | 0;
}

/** FPC frac(x) = x - trunc(x) (0x7e60). */
export function frac(x: number): number {
  return x - Math.trunc(x);
}

const cvt = new DataView(new ArrayBuffer(8));
/** Float32 bits as a signed int32 (FL compares float bits as integers in several places). */
export function fbits(x: number): number {
  cvt.setFloat32(0, x, true);
  return cvt.getInt32(0, true);
}
/** Float32 from int32 bits. */
export function bitsF(u: number): number {
  cvt.setInt32(0, u | 0, true);
  return cvt.getFloat32(0, true);
}

// Runtime constants (0x7bae0): doubles unless noted.
/** ln 2 (0x2fb9a0) and 1 / ln 2 (0x2fb9a8). */
export const LN2 = 0.6931471805599453;
export const INV_LN2 = 1 / LN2;
/** float32 ln 11 (0x2fb9d4: 0x4019771e), ln 3 (0x2fb9dc), ln 7 (0x2fb9e4), ln 10 / 20 (0x2fb9ec). */
export const LN11F = bitsF(0x4019771e);
export const LN3F = bitsF(0x3f8c9f54);
export const LN7F = bitsF(0x3ff91395);
export const DB2NPF = bitsF(0x3debc8e3);
/** ln 2 / 12 (0x2fb9c0), ln 2 / 1200 (0x2fb9b8). */
export const LN2_12 = 0.0577622650466621;
export const LN2_1200 = LN2_12 / 100;
export const LOG2_440 = log(440 * exp(0 * LN2_12)) * INV_LN2;
/** log2(440) (0x2fb9f0): log(440 * exp(0 * ln2/12)) / ln 2 with libm. */
/** float32 1 / ln 2 (0x3153c8: 0x3fb8aa3b). */
export const INV_LN2F = bitsF(0x3fb8aa3b);
/** ln 0.01 (0x303c18): time constants "to 1 % in t samples". */
export const LN001 = -4.605170185988091;
/** float32 2^-24 (0x2fb99c, 0x2c4cec). */
export const TINY = bitsF(0x33800000);
/** float32 2 pi (0x2cc39c). */
export const TWO_PI_F = f32(2 * Math.PI);

/** FPC exp / ln / sin / cos of doubles: macOS libm, ported bit for bit (../harmor/fx-libm.ts). */
export { exp, log, sin, cos } from '../harmor/fx-libm';
import { exp, log } from '../harmor/fx-libm';

/** FL's 11-base law (LogVol, ProcessParam): x == 1 ? 1 : (11^x - 1) / 10 with float32 steps. */
export function law11(x: number): number {
  x = f32(x);
  return x === 1 ? 1 : f32((exp(f32(x * LN11F)) - 1) * f32(0.1));
}

/** FL's 3-base law: x == 1 ? 1 : (3^x - 1) / 2 with float32 steps. */
export function law3(x: number): number {
  x = f32(x);
  return x === 1 ? 1 : f32((exp(f32(x * LN3F)) - 1) * 0.5);
}
