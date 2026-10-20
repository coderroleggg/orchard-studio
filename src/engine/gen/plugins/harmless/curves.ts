// Harmless's spectral curves (FL 2026 Harmless_x64.dylib, arm64): the filter
// (17 types), resonance (9) and phaser (10) shapes are tables computed by
// 0x66d40 (types 0..16, 100..108, 200..209), RMS-normalised (0x66c50), with
// their position / extents (0x66d00) and an interpolation mode (0x66970: the
// quality, nearest lookup below 2). Voices map each harmonic's log2 or linear
// frequency onto a table: 0x669b0 clamped (kernel 0x4908 nearest, 0x668f0 +
// linear interpolation), 0x66b20 periodic (kernel 0x49b0, mask = n - 1).

import { DB2NPF, LN2, cos, exp, f32, log, rint, sin } from './fl';

export class Curve {
  /** Type id (C+0x0): 0..16 filter, 100.. resonance, 200.. phaser; 0x7fffffff = none. */
  type = 0x7fffffff;
  /** Table length (C+0x4). */
  n = 0;
  /** Interpolation mode (C+0x8): < 2 nearest, else linear. */
  mode = 0;
  /** Centre position in table units (C+0xc) and the extents (C+0x10, C+0x14). */
  c = 0;
  e1 = 0;
  e2 = 0;
  /** Phaser scales (C+0x18 offset, C+0x1c width): the table length, some types scale +0x1c. */
  s18 = 0;
  s1c = 0;
  /** n + 1 floats; table[n] = table[0]. */
  table = new Float32Array(1);
}

const abs = Math.abs;

/** 0x699e0: allocate n (+1) entries; returns the builder's default step 1 / (n - 1). */
function alloc(C: Curve, n: number): number {
  C.n = n;
  C.table = new Float32Array(n + 1);
  setPos(C, 0, 1, 0);
  C.s18 = f32(n);
  C.s1c = C.s18;
  return 1 / (n - 1);
}

/** 0x66d00: centre = f32(pos * (n - 1)), extents. */
function setPos(C: Curve, pos: number, e1: number, e2: number): void {
  C.c = f32(pos * (C.n - 1));
  C.e1 = f32(e1);
  C.e2 = f32(e2);
}

/** 0x66c50: scale the table to an RMS of `target` (double sum of float squares). */
function normalize(C: Curve, target: number): void {
  const t = C.table, n = C.n;
  let s = 0;
  for (let i = 0; i < n; i++) s += f32(t[i] * t[i]);
  const rms = Math.sqrt(s / n);
  if (rms > 0) {
    const k = f32(target / rms);
    for (let i = 0; i < n; i++) t[i] = f32(t[i] * k);
  }
}

/** C % n of FPC's sdiv / msub (non-negative here). */
const mod = (a: number, n: number) => a - Math.trunc(a / n) * n;

/** -72 dB style taper used by the phaser types: f32(exp(f32(f32(x * -72) * DB2NP))). */
function taper(x: number): number {
  return f32(exp(f32(f32(x * -72) * DB2NPF)));
}

/** (1 - x^16) with FL's double steps: x4 = x*x*x*x; x16 = x4*x4*x4*x4. */
function oneMinus16(x: number): number {
  let d = x * x * x * x;
  d = d * d * d * d;
  return 1 - d;
}

/** 0x66d40: (re)build the curve for `type` (no-op when unchanged). */
export function buildCurve(C: Curve, type: number): void {
  if (C.type === type) return;
  C.type = type;
  C.n = 0;
  C.table = new Float32Array(1);
  let step: number;
  const T = () => C.table;
  switch (type) {
    // ---------------------------------------------------------------- phaser types
    case 200: { // Classic: 1 + sin(2 pi ((i + 3n/4) mod n) / n)
      alloc(C, 0x400);
      step = 6.2831853071795862 / C.n;
      const o = Math.trunc((C.n * 3) / 4);
      for (let i = 0; i < C.n; i++) T()[i] = f32(sin(mod(o + i, C.n) * step) + 1);
      normalize(C, 1);
      break;
    }
    case 201: { // Triangle: |1 - ((i + n/2) mod n) * 2/n|^2
      alloc(C, 0x400);
      step = 2 / C.n;
      const o = C.n >>> 1;
      for (let i = 0; i < C.n; i++) { const d = abs(1 - mod(o + i, C.n) * step); T()[i] = f32(d * d); }
      normalize(C, 1);
      break;
    }
    case 202: { // Eggs: sin(i pi / n)
      alloc(C, 0x400);
      step = 3.1415926535897931 / C.n;
      for (let i = 0; i < C.n; i++) T()[i] = f32(sin(i * step));
      normalize(C, 1);
      break;
    }
    case 203: { // Deep: ((sin * 0.5 + 0.5)^3)^2
      alloc(C, 0x400);
      step = 6.2831853071795862 / C.n;
      const o = Math.trunc((C.n * 3) / 4);
      for (let i = 0; i < C.n; i++) {
        let d = sin(mod(o + i, C.n) * step) * 0.5 + 0.5;
        d = d * d * d;
        T()[i] = f32(d * d);
      }
      normalize(C, 1);
      break;
    }
    case 204: { // Deeper: x = |1 - ((i + n/2) mod n) * 2/n|; taper(1 - x) * (1 - (1 - x)^16)
      alloc(C, 0x400);
      step = 2 / C.n;
      const o = C.n >>> 1;
      for (let i = 0; i < C.n; i++) {
        const x = abs(1 - mod(o + i, C.n) * step);
        const y = 1 - x;
        T()[i] = f32(f32(taper(y)) * oneMinus16(y));
      }
      normalize(C, 1);
      break;
    }
    case 205: { // Condom: s = (sin * 0.5 + 0.5)^2; y = 1 - s^2
      alloc(C, 0x400);
      step = 6.2831853071795862 / C.n;
      const o = Math.trunc((C.n * 3) / 4);
      for (let i = 0; i < C.n; i++) {
        let s = sin(mod(o + i, C.n) * step) * 0.5 + 0.5;
        s = s * s;
        const y = 1 - s * s;
        T()[i] = f32(f32(taper(y)) * oneMinus16(y));
      }
      normalize(C, 1);
      break;
    }
    case 206: { // Twins: two tapers (offsets n/4 and 3n/4)
      alloc(C, 0x800);
      step = 6.2831853071795862 / C.n;
      let o = C.n >>> 2;
      for (let i = 0; i < C.n; i++) {
        const s = sin(mod(o + i, C.n) * step) * 0.5 + 0.5;
        const y = 1 - s;
        T()[i] = f32(f32(taper(y)) * oneMinus16(y));
      }
      o = Math.trunc((C.n * 3) / 4);
      for (let i = 0; i < C.n; i++) {
        const s = sin(mod(o + i, C.n) * step) * 0.5 + 0.5;
        const prev = T()[i];
        const y = 1 - s * s;
        T()[i] = f32(prev + f32(taper(y)) * oneMinus16(y) * 4);
      }
      normalize(C, 1);
      C.s1c = f32(C.s1c * 0.5);
      break;
    }
    case 207: { // Cascade: (1 + sin((4i/(n-1) + 0.75) 2 pi)) * (1 - i/(n-1)) at (i + n/8) mod n
      step = alloc(C, 0x800);
      const o = C.n >>> 3;
      for (let i = 0; i < C.n; i++) {
        const a = sin((i * 4 * step + 0.75) * 3.1415926535897931 * 2) + 1;
        T()[mod(o + i, C.n)] = f32(a * (1 - i * step));
      }
      normalize(C, 1);
      C.s1c = f32(C.s1c * 0.25);
      break;
    }
    case 208: { // Box
      alloc(C, 0x800);
      step = 12.566370614359172 / C.n;
      const o = Math.trunc((C.n * 3) / 8);
      T().fill(0, 0, C.n);
      const h = C.n >>> 1, q = C.n >>> 2;
      for (let i = 0; i < h; i++) {
        const s = sin(mod(o + i, C.n) * step);
        const e = f32(1 - abs(s));
        let v = f32(f32(exp(e * 13.815511557963774) - 1) / 1000000);
        v = f32(1 - v);
        const sg = s === 0 ? 0 : s < 0 ? -1 : 1;
        v = f32(f32(v * sg) + 1);
        T()[q + i] = f32(v * v * v);
      }
      normalize(C, 1);
      break;
    }
    case 209: { // Freq: sin (used as a frequency modulation)
      alloc(C, 0x800);
      step = 6.2831853071795862 / C.n;
      const o = Math.trunc((C.n * 3) / 4);
      for (let i = 0; i < C.n; i++) T()[i] = f32(sin(mod(o + i, C.n) * step));
      normalize(C, 1);
      break;
    }
    // ---------------------------------------------------------------- resonance types
    case 100: case 108: { // Classic (and Noise): (1 - (cos((1 - i/(n-1)) pi 2) + 1) / 2)^3, RMS 7, centre 0.5
      step = alloc(C, 0x400);
      for (let i = 0; i < C.n; i++) {
        const d = 1 - (cos((1 - i * step) * 3.1415926535897931 * 2) + 1) * 0.5;
        T()[i] = f32(d * d * d);
      }
      normalize(C, 7);
      setPos(C, 0.5, 1, 0);
      break;
    }
    default:
      buildCurveMore(C, type);
      return;
  }
  finish(C);
}

/** The tail of 0x66d40: flush |x| < 2^-24 to 0 (0x786f0), table[n] = table[0]. */
function finish(C: Curve): void {
  const t = C.table;
  for (let i = 0; i < C.n; i++) if (abs(t[i]) < 5.960464477539063e-8) t[i] = 0;
  if (C.n > 0) t[C.n] = t[0];
}

const PI = 3.1415926535897931;
/** 1 - (cos(x) + 1) * 0.5 */
const hump = (x: number) => 1 - (cos(x) + 1) * 0.5;

/** Filter types 0..16 and resonance types 101..107 (0x66d40, second half). */
function buildCurveMore(C: Curve, type: number): void {
  const T = () => C.table;
  let step: number;
  switch (type) {
    case 101: { // Spring: hump * sinc
      step = alloc(C, 0x2aa);
      const h = Math.trunc(C.n / 2);
      for (let i = 0; i < C.n; i++) {
        const d8 = hump((1 - i * step) * PI * 2);
        let d9 = (i - h) * 2 * step * PI * 2;
        d9 = i === h ? 1 : sin(d9) / d9;
        T()[i] = f32(d9 * d8);
      }
      normalize(C, 9);
      setPos(C, 0.5, 1, 0);
      break;
    }
    case 102: case 104: case 16: { // Pedestal (341, RMS 10), Wide bump (2048, RMS 5), Flat band pass (2048): flat top, hump flanks
      alloc(C, type === 102 ? 0x155 : 0x800);
      T().fill(1, 0, C.n);
      const k = Math.trunc(C.n / 3);
      step = f32(f32(0.5) / f32(k));
      for (let i = 0; i < k; i++) {
        let d8 = hump((1 - i * step) * PI * 2);
        d8 = d8 * d8;
        T()[i] = f32(d8);
        T()[C.n - 1 - i] = f32(d8);
      }
      if (type === 102) normalize(C, 10);
      else if (type === 104) normalize(C, 5);
      setPos(C, 0.5, 1, type === 16 ? 1 : 0);
      break;
    }
    case 103: { // Sedge hat
      alloc(C, 0x200);
      step = 2 / C.n;
      const o = C.n >>> 1;
      for (let i = 0; i < C.n; i++) {
        const y = 1 - abs(1 - mod(o + i, C.n) * step);
        T()[i] = f32(f32(taper(y)) * oneMinus16(y));
      }
      normalize(C, 18);
      setPos(C, 0.5, 1, 0);
      break;
    }
    case 105: { // Double cone: hump(4 pi)^4
      step = alloc(C, 0x600);
      for (let i = 0; i < C.n; i++) {
        const d8 = hump((1 - i * step) * PI * 4);
        T()[i] = f32(d8 * d8 * d8 * d8);
      }
      normalize(C, 5);
      setPos(C, 0.5, 1, 0);
      break;
    }
    case 106: { // Well: -x^2 (not normalised)
      alloc(C, 0x300);
      step = 2 / C.n;
      const o = C.n >>> 1;
      for (let i = 0; i < C.n; i++) {
        const d8 = abs(1 - mod(o + i, C.n) * step);
        T()[i] = f32(-d8 * d8);
      }
      setPos(C, 0.5, 1, 0);
      break;
    }
    case 107: { // Wormhole: -sinc * hump^0.125
      step = alloc(C, 0x400);
      const h = Math.trunc(C.n / 2);
      for (let i = 0; i < C.n; i++) {
        const d8 = hump((1 - i * step) * PI * 2);
        let d9 = (i - h) * 2 * step * PI * 2;
        d9 = i === h ? 1 : sin(d9) / d9;
        T()[i] = f32(-d9 * fpcPowerF(f32(d8), 0.125));
      }
      normalize(C, 10);
      setPos(C, 0.5, 1, 0);
      break;
    }
    // ---------------------------------------------------------------- filter types
    case 0: { // Classic low pass
      step = alloc(C, 0x800);
      for (let i = 0; i < C.n; i++) { const y = i * step; T()[i] = f32(f32(taper(y)) * oneMinus16(y)); }
      break;
    }
    case 1: case 2: { // Classic band pass / band stop
      alloc(C, 0x1000);
      step = 2 / C.n;
      const o = C.n >>> 1;
      for (let i = 0; i < C.n; i++) {
        const y = 1 - abs(1 - mod(o + i, C.n) * step);
        const v = f32(taper(y)) * oneMinus16(y);
        T()[i] = f32(type === 1 ? v : 1 - v);
      }
      setPos(C, 0.5, 1, 1);
      break;
    }
    case 3: { // Classic high pass
      step = alloc(C, 0x800);
      for (let i = 0; i < C.n; i++) { const y = 1 - i * step; T()[i] = f32(f32(taper(y)) * oneMinus16(y)); }
      setPos(C, 1, 0, 1);
      break;
    }
    case 4: { // Crude low pass
      step = alloc(C, 0x400);
      for (let i = 0; i < C.n; i++) { const d8 = hump((1 - i * step) * PI); T()[i] = f32(d8 * d8); }
      break;
    }
    case 5: case 6: { // Crude band pass / band stop
      step = alloc(C, 0x800);
      for (let i = 0; i < C.n; i++) {
        const x = (1 - i * step) * PI * 2;
        const d8 = type === 5 ? hump(x) : (cos(x) + 1) * 0.5;
        T()[i] = f32(d8 * d8);
      }
      setPos(C, 0.5, 1, 1);
      break;
    }
    case 7: { // Crude high pass
      step = alloc(C, 0x400);
      for (let i = 0; i < C.n; i++) { const d8 = (cos((1 - i * step) * PI) + 1) * 0.5; T()[i] = f32(d8 * d8); }
      setPos(C, 1, 0, 1);
      break;
    }
    case 8: { // Hill low pass: -cos((1 - x/2) pi)
      step = alloc(C, 0x2aa);
      for (let i = 0; i < C.n; i++) T()[i] = f32(1 - (cos((1 - i * step * 0.5) * PI) + 1));
      break;
    }
    case 9: { // Leg low pass
      step = alloc(C, 0x400);
      for (let i = 0; i < C.n; i++) {
        const d8 = 1 - i * step;
        const e = f32(f32(exp(f32(d8) * 6.9087547793152204) - 1) * f32(0.000750000007));
        T()[i] = f32(e + d8 * 0.25);
      }
      break;
    }
    case 10: { // Hybrid low pass
      step = alloc(C, 0x555);
      for (let i = 0; i < C.n; i++) {
        const d8 = 1 - (cos((1 - i * step * 0.5) * PI) + 1);
        const y = 1 - d8;
        T()[i] = f32(f32(taper(y)) * oneMinus16(y));
      }
      break;
    }
    case 11: { // Snake low pass
      step = alloc(C, 0x400);
      for (let i = 0; i < C.n; i++) {
        const d8 = hump((1 - i * step) * PI * 3);
        T()[i] = f32(d8 * hump((1 - i * step) * PI));
      }
      break;
    }
    case 12: { // Fin low pass
      step = alloc(C, 0x1000);
      const h = C.n >>> 1;
      for (let i = 0; i < C.n; i++) {
        if (i >= h) {
          const y = (i - h) * step * 2;
          T()[i] = f32(f32(taper(y)) * oneMinus16(y));
        } else {
          const d8 = 1 - (cos((1 - i * step) * PI * 2) + 1) * 0.25;
          T()[i] = f32(d8 * d8);
        }
      }
      setPos(C, 0.5, 1, 0);
      break;
    }
    case 13: { // Leaky low pass: -18 dB .. 0 dB
      step = alloc(C, 0x400);
      for (let i = 0; i < C.n; i++) {
        const d8 = hump((1 - i * step) * PI);
        T()[i] = f32(exp(f32(f32(-18 + d8 * 18) * DB2NPF)));
      }
      break;
    }
    case 14: { // Phaser
      step = alloc(C, 0x1000);
      for (let i = 0; i < C.n; i++) { const d8 = (cos((1 - i * step) * PI * 8) + 1) * 0.5; T()[i] = f32(d8 * d8); }
      setPos(C, 0.5, 1, 1);
      break;
    }
    case 15: { // Band phaser
      step = alloc(C, 0x1000);
      for (let i = 0; i < C.n; i++) {
        const d8 = (cos((1 - i * step) * PI * 12) + 1) * 0.5;
        const d9 = hump((1 - i * step) * PI * 2);
        T()[i] = f32(d8 * d8 * d9 * d9 + d9 * 0.125);
      }
      setPos(C, 0.5, 1, 1);
      break;
    }
    default:
      return;
  }
  finish(C);
}

/** FPC Power(single, single) (0x1558f0): 1 for y = 0, 0 for x = 0 < y, IntPower for whole y, else exp(y ln x). */
export function fpcPowerF(x: number, y: number): number {
  x = f32(x); y = f32(y);
  if (y === 0) return 1;
  if (x === 0 && y > 0) return 0;
  if (Math.trunc(y) === y) return f32(Math.pow(x, y));
  return f32(exp(y * log(x)));
}

// ---------------------------------------------------------------- lookups

/**
 * 0x669b0: out[i] = curve at src[i] * scale + offset, clamped to the table
 * (nearest: kernel 0x4908 rounds to even and processes whole groups of 8;
 * linear: 0x668f0 splits into int / frac, then interpolates). `frac` is scratch.
 */
export function mapClamped(C: Curve, src: Float32Array, out: Float32Array, frac: Float32Array, n: number, scale: number, offset: number): void {
  const t = C.table, last = C.n - 1;
  const s = f32(scale), o = f32(offset);
  if (C.mode < 2) {
    const mx = f32(last);
    const m = (n + 7) & ~7;
    for (let i = 0; i < m; i++) {
      let x = f32(f32(src[i] * s) + o);
      // fmax(x, 0) then fmin(x, max): NaN -> NaN in NEON fmax / fmin; fcvtns of NaN = 0
      x = x !== x ? NaN : x > 0 ? x : 0;
      x = x !== x ? NaN : x < mx ? x : mx;
      const k = x !== x ? 0 : rint(x);
      out[i] = t[k];
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const p = f32(f32(src[i] * s) + o);
    const ip = Math.trunc(rint(f32(p - 0.5))) | 0;
    out[i] = ip;
    frac[i] = f32(p - f32(ip));
  }
  for (let i = 0; i < n; i++) {
    const k = out[i] | 0;
    if (k < 0) out[i] = t[0];
    else if (last <= k) out[i] = t[C.n - 1];
    else { const f = frac[i]; out[i] = f32(f32(t[k] * f32(1 - f)) + f32(t[k + 1] * f)); }
  }
}

/** 0x66b20: the periodic lookup (index & (n - 1)); nearest = kernel 0x49b0 over whole groups of 8. */
export function mapPeriodic(C: Curve, src: Float32Array, out: Float32Array, frac: Float32Array, n: number, scale: number, offset: number): void {
  const t = C.table, mask = C.n - 1;
  const s = f32(scale), o = f32(offset);
  if (C.mode < 2) {
    const m = (n + 7) & ~7;
    for (let i = 0; i < m; i++) {
      const x = f32(f32(src[i] * s) + o);
      const k = (x !== x ? 0 : clampI32(rint(x))) & mask;
      out[i] = t[k];
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const p = f32(f32(src[i] * s) + o);
    const ip = Math.trunc(rint(f32(p - 0.5))) | 0;
    out[i] = ip;
    frac[i] = f32(p - f32(ip));
  }
  for (let i = 0; i < n; i++) {
    const k = (out[i] | 0) & mask;
    const f = frac[i];
    out[i] = f32(f32(t[k] * f32(1 - f)) + f32(t[k + 1] * f));
  }
}

/** fcvtns saturation to int32. */
function clampI32(x: number): number {
  return x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : x | 0;
}
