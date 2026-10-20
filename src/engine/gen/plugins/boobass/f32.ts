// Single-precision helpers for line-by-line ports of FL's arm64 code: float32
// constants from their bit patterns, and the fused multiply-add of the arm64
// FMADD / FMSUB / FNMSUB / FMLA instructions (one rounding to float32).

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** The float32 with the IEEE bit pattern `u` (FL's literal pool constants). */
export function u2f(u: number): number {
  U32[0] = u >>> 0;
  return F32[0];
}

export const f = Math.fround;

/**
 * float32 fused multiply-add a*b + c rounded once (arm64 FMADD Sd, Sn, Sm, Sa
 * with Sn = a, Sm = b, Sa = c) for float32 inputs. The product of two float32
 * values is exact in double; the double sum can only round the wrong way when
 * it lands exactly halfway between two float32 values, which the exact error
 * of the double sum (TwoSum) then resolves.
 */
export function fma32(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const r = f(s);
  const d = s - r;
  if (d === 0) return r;
  const o = f(s + d);
  if (o === r || o - s !== d) return r;
  const bb = s - p;
  const e = (p - (s - bb)) + (c - bb);
  if (e === 0) return r;
  return (e > 0) === (o > r) ? o : r;
}
