// SimSynth: the arm64 float semantics FL's engine relies on (SimSynth_eng_x64.dylib,
// clang -O2: single precision with fused multiply-adds where the compiler emitted them).
// Plain float32 +, -, *, / are exact as Math.fround of the double result (double
// rounding is innocuous for them); a fused a*b+c needs the care below.

export const f32 = Math.fround;

/**
 * Float32 fused multiply-add a*b + c, correctly rounded once (arm64 FMADD Sd).
 * a*b of two floats is exact in double; the double sum can only round wrongly
 * when it lands exactly on a float midpoint, which the exact error decides.
 */
export function fmaf(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const r = f32(s);
  const d = s - r;
  if (d === 0) return r;
  const o = r + 2 * d;
  if (f32(o) !== o) return r;
  const bb = s - p;
  const err = (p - (s - bb)) + (c - bb);
  if (err === 0) return r;
  return (err > 0) === (d > 0) ? o : r;
}

const SPLIT = 134217729; // 2^27 + 1 (Veltkamp)
const bits = new Float64Array(1);
const words = new Uint32Array(bits.buffer);
const LO = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 0 : 1;

/**
 * Double fused multiply-add a*b + c, correctly rounded once (arm64 FMADD Dd):
 * exact product and sums, the low part rounded to odd, one final rounding
 * (Boldo & Melquiond). Used for FL's coefficient computations, not per sample.
 */
export function fma(a: number, b: number, c: number): number {
  const p = a * b;
  if (!Number.isFinite(p) || !Number.isFinite(c)) return p + c;
  let t = SPLIT * a;
  const ah = t - (t - a), al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b), bl = b - bh;
  const pe = ((ah * bh - p) + ah * bl + al * bh) + al * bl; // a*b = p + pe exactly
  // c + pe = th + tl
  const th = c + pe;
  let bb = th - c;
  const tl = (c - (th - bb)) + (pe - bb);
  // p + th = vh + vl
  const vh = p + th;
  bb = vh - p;
  const vl = (p - (vh - bb)) + (th - bb);
  // w = vl + tl rounded to odd
  let w = vl + tl;
  bb = w - vl;
  const we = (vl - (w - bb)) + (tl - bb);
  if (we !== 0) {
    bits[0] = w;
    if ((words[LO] & 1) === 0) {
      // move one ulp toward the exact value (makes the last bit odd)
      const up = (we > 0) === (w > 0);
      if (w === 0) {
        w = we > 0 ? 5e-324 : -5e-324;
      } else {
        if (up) { if (++words[LO] === 0) words[1 - LO]++; } else { if (words[LO]-- === 0) words[1 - LO]--; }
        w = bits[0];
      }
    }
  }
  return vh + w;
}

/** arm64 FCVTZS (float -> int32, toward zero, saturating, NaN -> 0). */
export function cvtzs(x: number): number {
  if (x !== x) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return Math.trunc(x) | 0;
}

/** arm64 FCVTZU (float -> uint32, toward zero, saturating, NaN / negative -> 0). */
export function cvtzu(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 4294967295) return 4294967295;
  return Math.trunc(x) >>> 0;
}

/** arm64 FCVTMS (toward minus infinity, saturating). */
export function cvtms(x: number): number {
  if (x !== x) return 0;
  const v = Math.floor(x);
  return v >= 2147483647 ? 2147483647 : v <= -2147483648 ? -2147483648 : v | 0;
}

/** Round half to even (FRINTX in the default mode; lrint). */
export function rint(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r;
}

/** Signed 16-bit view of an integer (ldrsh). */
export const s16 = (v: number): number => (v << 16) >> 16;
/** Unsigned 16-bit view (ldrh / uxth). */
export const u16 = (v: number): number => v & 0xffff;
