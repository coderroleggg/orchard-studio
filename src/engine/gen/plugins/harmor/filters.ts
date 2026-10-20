// Harmor's shapes, filters, resonance and phaser, ported from Harmor_x64 (FL
// 2026, arm64) operation by operation:
// - shape objects (0x38 bytes: +0x8 type, +0xc count, +0x10 precision, +0x14
//   index offset, +0x18 / +0x1c filter range factors, +0x20 / +0x24 scales,
//   +0x28 table, +0x30 mix, +0x34 active flag) and their table generator
//   0xcc010 for every type id (filters 0..18, resonance 100..111, phaser
//   200..210, main shape 300 = Global EQ map, masks 400..800 = shaping maps
//   18..22), set up per part by 0xcb280 (filter range 0xcb430, resonance scale
//   0xcb6e0); main / mask tables are indexed by log2 Hz at 240 points per
//   octave from C0;
// - the table readers 0xcbb40 (clamped; nearest 0x4fcc at "Average"
//   precision, linear 0xcba80 above) and 0xcbcb0 (wrapping, phaser);
// - units 4 / 5 (0xddea0: filter + resonance / noise of the filter selected by
//   REND+0x84, with the parallel / serial filter mix) and unit 6 (0xdef50:
//   phaser, amplitude or frequency).
// libm calls (exp / log / sin / cos) use the exact ports in ./fx-libm.

import type { PartDsp, PlugDsp } from './core';
import type { HVoice, RenderCtx } from './voice';
import type { UnitCtx } from './units';
import type { Curve } from './env';
import { mapFill32 } from './env';
import { exp as lexp, log as llog, sin as lsin, cos as lcos } from './fx-libm';
import { exp32f, randUniform32f, thresholdLTVal32fI, thresholdGTVal32fI, thresholdLT32fI } from './ipp';

const f = Math.fround;
const LN2 = 0.6931471805599453;
const PI = 3.141592653589793;
/** G[0xa97140] log2 C0 (double), G[0xa97138] (double), G[0xa9712c] / G[0xa97130] filter range (float), G[0xa9714c] noise tilt (float). */
const LOG2_C0 = 4.03135971352466;
const G138 = -7.031359713524659;
const F_LO = 6.198026180267334;
const F_HI = 14.114692687988281;
const NOISE_K = -5.637077629216947e-5;
/** G[0xa2d274]: f32(ln 10 / 20). */
const DB = 0.115129254758358;
const K001 = f(0.001);
const F00075 = f(0.00075);
const LN2F = f(LN2);
const TINY = 5.960464477539063e-8;

/** A shape object (FL 0x38 bytes) with its table (FL GetMem of count + 1 floats). */
export class Shape {
  /** +0x8 type id, +0xc point count, +0x10 lookup precision (plug+0x1150). */
  type = -1;
  count = 0;
  prec = 0;
  /** +0x14 index offset, +0x18 / +0x1c range factors (filter shapes), +0x20 index scale, +0x24. */
  x14 = 0;
  y18 = 1;
  z1c = 0;
  scale = 1024;
  s24 = 1024;
  /** +0x28 table (null when !hasTab), +0x30 mix (main shape: Global EQ mix), +0x34 bit 0 = shape active. */
  readonly tab: Float32Array;
  hasTab = false;
  mix = 1;
  flags = 0;
  /** Generation cache: inputs of the current table. */
  cType = -1;
  cSrc: Curve | null = null;
  cMix = NaN;
  cOfs = NaN;
  constructor(cap: number) {
    this.tab = new Float32Array(cap);
  }
}

/** A part's shape objects. */
export class PartShapes {
  /** part+0x298 main shape (type 300). */
  readonly main = new Shape(2421);
  /** part+0x2d0 + i * 0x38: filter 1 / 2 masks, resonance 1 / 2 masks, phaser mask (types 400..800). */
  readonly masks = [new Shape(2161), new Shape(2161), new Shape(2161), new Shape(2161), new Shape(2161)];
  /** part+0x3f0 / +0x4b0 filter shapes, part+0x428 / +0x4e8 resonance shapes. */
  readonly flt = [new Shape(4097), new Shape(4097)];
  readonly res = [new Shape(1537), new Shape(1537)];
  /** part+0x568 phaser shape. */
  readonly ph = new Shape(2049);
}

// ------------------------------------------------------------- generator

/** 0xcbf50 / inline: f32(exp(f32(f32(x * -72) * ln10/20))) * (1 - x^16), double. */
function g72(x: number): number {
  const e = f(lexp(f(f(x * -72) * DB)));
  const x4 = x * x * x * x;
  return e * (1 - x4 * x4 * x4 * x4);
}

/** 0xcf980: count n, table, d = 1 / (n - 1); position (0, 1, 0); scales 1024. */
function alloc(S: Shape, n: number): number {
  S.count = n;
  S.hasTab = true;
  S.x14 = f(0 * (n - 1));
  S.y18 = 1;
  S.z1c = 0;
  S.scale = 1024;
  S.s24 = 1024;
  return 1 / (n - 1);
}

/** 0xcbfd0. */
function place(S: Shape, a: number, b: number, c: number): void {
  S.x14 = f(a * (S.count - 1));
  S.y18 = f(b);
  S.z1c = f(c);
}

/** 0xcbde0: scale the table to RMS `target`. */
function rmsNorm(T: Float32Array, n: number, target: number): void {
  let s = 0;
  for (let i = 0; i < n; i++) s += f(T[i] * T[i]);
  const r = Math.sqrt(s / n);
  if (r > 0) {
    const k = f(target / r);
    for (let i = 0; i < n; i++) T[i] = f(T[i] * k);
  }
}

/** Raised-cosine helper used by most shapes: 1 - (cos(a) + 1) * 0.5. */
const hc = (a: number): number => 1 - (lcos(a) + 1) * 0.5;

/** Shaping map read by a custom / mask / main shape type (FL part+0x670 + 8 * w20), or -1. */
function mapIndex(type: number): number {
  if (type === 17 || type === 18) return type - 7;
  if (type === 110 || type === 111) return type - 98;
  if (type === 209 || type === 210) return 15;
  if (type >= 300 && type <= 9999) return ((type - 300) / 100 | 0) + 17;
  return -1;
}

/** 0xcc010: build the table of shape `S` for `type`. */
function gen(pt: PartDsp, S: Shape, type: number): void {
  S.type = type;
  S.hasTab = false;
  S.flags &= ~1;
  const T = S.tab;
  let d: number, n: number, k: number;
  if (type >= 0 && type <= 18 || type >= 100 && type <= 111 || type >= 200 && type <= 210 || type >= 300 && type <= 9999) {
    // valid ids; others leave no table
  } else type = -1;
  const mi = mapIndex(type);
  if (mi >= 0 && !(type >= 0 && type < 17) && !(type >= 100 && type < 110) && !(type >= 200 && type < 209)) {
    const c: Curve | undefined = pt.maps[mi];
    if (mi === 17) {
      // main shape: Global EQ (9 octaves from C1) with a raised-cosine octave below and a 19-point fade above
      n = Math.round(10.083333333333334 * 240);
      alloc(S, n);
      S.scale = f(n / 10.083333333333334);
      S.s24 = f(n);
      if (c) mapFill32(c, T, 240, 2161, 0); else T.fill(0.25, 240, 2401);
      if (S.mix !== 1) {
        for (let i = 0; i < 2161; i++) T[240 + i] = f(T[240 + i] * S.mix);
        const a = f(f(1 - S.mix) * 0.25);
        for (let i = 0; i < 2161; i++) T[240 + i] = f(T[240 + i] + a);
      }
      let d9 = f(T[240] * 0.5);
      let d8 = 1 / 240;
      for (let i = 0; i <= 239; i++) T[i] = f((lcos((1 - i * d8) * PI) + 1) * d9);
      d9 = f(T[2400] * 0.5);
      const m = n - 2400 - 1;
      d8 = 1 / m;
      for (let i = 1; i <= m; i++) T[2400 + i] = f((lcos(i * d8 * PI) + 1) * d9);
      for (let i = 0; i < n; i++) { const v = f(T[i] * 4); T[i] = f(v * v); }
      place(S, (-LOG2_C0 + 0.0020833334419876337) / 10.083333333333334, 1, 1);
      let w = n - 1;
      while (w > 0 && !(T[w] > 0)) w--;
      pt.maxFreq = f(lexp((LOG2_C0 + w / 240) * LN2));
    } else if (mi > 17) {
      // masks: 9 octaves from C1
      n = 2160;
      alloc(S, n);
      S.scale = f(n / 9);
      S.s24 = f(n);
      if (c) mapFill32(c, T, 0, 2161, 0); else T.fill(1, 0, 2161);
      for (let i = 0; i < n; i++) T[i] = f(T[i] * T[i]);
      place(S, ((-LOG2_C0 - 1) + 0.0020833334419876337) / 9, 1, 1);
    } else {
      // custom filter / resonance / phaser shapes
      n = 1024;
      alloc(S, n);
      S.scale = mi === 15 ? f(n) : f(n * 0.25);
      S.s24 = f(n);
      if (c) mapFill32(c, T, 0, 1024, 0); else T.fill(mi === 12 || mi === 13 || mi === 15 ? 0 : 1, 0, 1024);
      place(S, 0.5, 1, 1);
      if (mi === 12 || mi === 13) {
        for (let i = 0; i < n; i++) T[i] = f(T[i] * 24);
      } else if (type === 209) {
        for (let i = 0; i < n; i++) T[i] = f(T[i] * 2);
      } else {
        for (let i = 0; i < n; i++) T[i] = f(T[i] * T[i]);
        if (mi === 15) rmsNorm(T, n, 1);
        if (mi === 10 || mi === 11) {
          const h = n >>> 1;
          let w = 0;
          while (h > w && T[w] === 1) w++;
          S.z1c = f(1 - (w * 2) / n);
          w = 0;
          while (h > w && T[n - 1 - w] === 1) w++;
          S.y18 = f(1 - (w * 2) / n);
        }
      }
    }
  } else switch (type) {
    // ---- filter shapes
    case 0: d = alloc(S, 2048); for (let i = 0; i < 2048; i++) T[i] = f(g72(i * d)); break;
    case 1: case 2: {
      alloc(S, 4096); d = 2 / 4096;
      for (let i = 0; i < 4096; i++) {
        const x = 1 - Math.abs(1 - ((i + 2048) % 4096) * d);
        T[i] = type === 1 ? f(g72(x)) : f(1 - g72(x));
      }
      place(S, 0.5, 1, 1);
      break;
    }
    case 3: d = alloc(S, 2048); for (let i = 0; i < 2048; i++) T[i] = f(g72(1 - i * d)); place(S, 1, 0, 1); break;
    case 4: d = alloc(S, 1024); for (let i = 0; i < 1024; i++) { const a = hc((1 - i * d) * PI); T[i] = f(a * a); } break;
    case 5: d = alloc(S, 2048); for (let i = 0; i < 2048; i++) { const a = hc((1 - i * d) * PI * 2); T[i] = f(a * a); } place(S, 0.5, 1, 1); break;
    case 6: d = alloc(S, 2048); for (let i = 0; i < 2048; i++) { const a = (lcos((1 - i * d) * PI * 2) + 1) * 0.5; T[i] = f(a * a); } place(S, 0.5, 1, 1); break;
    case 7: d = alloc(S, 1024); for (let i = 0; i < 1024; i++) { const a = (lcos((1 - i * d) * PI) + 1) * 0.5; T[i] = f(a * a); } place(S, 1, 0, 1); break;
    case 8: d = alloc(S, 682); for (let i = 0; i < 682; i++) T[i] = f(1 - (lcos((1 - i * d * 0.5) * PI) + 1)); break;
    case 9: {
      d = alloc(S, 1024);
      for (let i = 0; i < 1024; i++) {
        const x = 1 - i * d;
        const s = f(f(lexp(f(x) * 6.9087547793152204) - 1) * F00075);
        T[i] = f(s + x * 0.25);
      }
      break;
    }
    case 10: d = alloc(S, 1365); for (let i = 0; i < 1365; i++) T[i] = f(g72(1 - (1 - (lcos((1 - i * d * 0.5) * PI) + 1)))); break;
    case 11: d = alloc(S, 1024); for (let i = 0; i < 1024; i++) T[i] = f(hc((1 - i * d) * PI * 3) * hc((1 - i * d) * PI)); break;
    case 12: {
      d = alloc(S, 4096);
      for (let i = 0; i < 4096; i++) {
        if (i >= 2048) T[i] = f(g72((i - 2048) * d * 2));
        else { const a = 1 - (lcos((1 - i * d) * PI * 2) + 1) * 0.25; T[i] = f(a * a); }
      }
      place(S, 0.5, 1, 0);
      break;
    }
    case 13: d = alloc(S, 1024); for (let i = 0; i < 1024; i++) T[i] = f(lexp(f(f(-18 + hc((1 - i * d) * PI) * 18) * DB))); break;
    case 14: d = alloc(S, 4096); for (let i = 0; i < 4096; i++) { const a = (lcos((1 - i * d) * PI * 8) + 1) * 0.5; T[i] = f(a * a); } place(S, 0.5, 1, 1); break;
    case 15: {
      d = alloc(S, 4096);
      for (let i = 0; i < 4096; i++) {
        const a = (lcos((1 - i * d) * PI * 12) + 1) * 0.5, b = hc((1 - i * d) * PI * 2);
        T[i] = f(a * a * b * b + b * 0.125);
      }
      place(S, 0.5, 1, 1);
      break;
    }
    case 16: {
      alloc(S, 2048); T.fill(1, 0, 2048);
      k = 682; const e = f(f(0.5) / f(k));
      for (let i = 0; i < k; i++) { const a = hc((1 - i * e) * PI * 2); T[i] = T[2047 - i] = f(a * a); }
      place(S, 0.5, 1, 1);
      break;
    }
    // ---- resonance shapes
    case 100: d = alloc(S, 1024); for (let i = 0; i < 1024; i++) T[i] = f(hc((1 - i * d) * PI * 2) * 7 - 1); place(S, 0.5, 1, 0); break;
    case 101: {
      d = alloc(S, 1536); const d10 = 9.4247779607693793 * d;
      for (let i = 0; i < 1536; i++) T[i] = f(lcos((i - 768) * d10) * hc((1 - i * d) * PI * 2) * 6.25);
      place(S, 0.5, 1, 0);
      break;
    }
    case 102: case 104: {
      const n0 = type === 102 ? 512 : 1024;
      alloc(S, n0); T.fill(type === 102 ? f(5.8) : f(5.4), 0, n0);
      k = n0 / 3 | 0; const e = f(f(0.5) / f(k));
      for (let i = 0; i < k; i++) {
        const a = hc((1 - i * e) * PI * 2);
        T[i] = T[n0 - 1 - i] = type === 102 ? f(a * 5.8) : f(a * a * 5.4);
      }
      place(S, 0.5, 1, 0);
      break;
    }
    case 103: alloc(S, 512); d = 2 / 512; for (let i = 0; i < 512; i++) T[i] = f(Math.abs(1 - ((i + 256) % 512) * d) * 6.9); place(S, 0.5, 1, 0); break;
    case 105: d = alloc(S, 1536); for (let i = 0; i < 1536; i++) { const a = hc((1 - i * d) * PI * 4); T[i] = f(a * a * 6.2); } place(S, 0.5, 1, 0); break;
    case 106: d = alloc(S, 682); for (let i = 0; i < 682; i++) T[i] = f(-hc((1 - i * d) * PI * 2) * 8); place(S, 0.5, 1, 0); break;
    case 107: {
      d = alloc(S, 1024);
      for (let i = 0; i < 1024; i++) {
        const a = hc((1 - i * d) * PI * 2);
        let s = (i - 512) * 2 * d * PI * 2;
        s = i === 512 ? 1 : lsin(s) / s;
        const p = a === 0 ? 0 : lexp(0.00125 * llog(a));
        T[i] = f(-s * p * 10);
      }
      place(S, 0.5, 1, 0);
      break;
    }
    case 108: {
      d = alloc(S, 1024);
      for (let i = 0; i < 1024; i++) {
        let a = hc((1 - i * d) * PI * 2) * 6.8 - 0.8;
        if (i > 512) a = a - (lcos((1 - i * d) * PI * 2) + 1) * 0.5 * 6;
        T[i] = f(a);
      }
      place(S, 0.5, 1, 0);
      break;
    }
    case 109: S.flags |= 1; break; // noise: no table
    // ---- phaser shapes
    case 200: case 203: case 205: {
      alloc(S, 1024); S.scale = 1024; S.s24 = 1024; d = 2 * PI / 1024;
      for (let i = 0; i < 1024; i++) {
        const s = lsin(((i + 768) % 1024) * d);
        if (type === 200) T[i] = f(s + 1);
        else {
          let a = s * 0.5 + 0.5;
          if (type === 203) { a = a * a * a; T[i] = f(a * a); } else { a = a * a; T[i] = f(g72(1 - a * a)); }
        }
      }
      rmsNorm(T, 1024, 1);
      break;
    }
    case 201: case 204: {
      alloc(S, 1024); S.scale = 1024; S.s24 = 1024; d = 2 / 1024;
      for (let i = 0; i < 1024; i++) {
        const a = Math.abs(1 - ((i + 512) % 1024) * d);
        T[i] = type === 201 ? f(a * a) : f(g72(1 - a));
      }
      rmsNorm(T, 1024, 1);
      break;
    }
    case 202: alloc(S, 1024); S.scale = 1024; S.s24 = 1024; d = PI / 1024; for (let i = 0; i < 1024; i++) T[i] = f(lsin(i * d)); rmsNorm(T, 1024, 1); break;
    case 206: {
      alloc(S, 2048); S.scale = 2048; S.s24 = f(2048 * 0.5); d = 2 * PI / 2048;
      for (let i = 0; i < 2048; i++) T[i] = f(g72(1 - (lsin(((i + 512) % 2048) * d) * 0.5 + 0.5)));
      for (let i = 0; i < 2048; i++) {
        const a = lsin(((i + 1536) % 2048) * d) * 0.5 + 0.5;
        T[i] = f(T[i] + g72(1 - a * a) * 4);
      }
      rmsNorm(T, 2048, 1);
      break;
    }
    case 207: {
      d = alloc(S, 2048); S.scale = 2048; S.s24 = f(2048 * 0.25);
      for (let i = 0; i < 2048; i++) {
        const a = lsin((i * 4 * d + 0.75) * PI * 2) + 1;
        T[(i + 256) % 2048] = f(a * (1 - i * d));
      }
      rmsNorm(T, 2048, 1);
      break;
    }
    case 208: {
      alloc(S, 2048); S.scale = 2048; S.s24 = 2048; d = 12.566370614359172 / 2048;
      T.fill(0, 0, 2048);
      for (let i = 0; i < 1024; i++) {
        const s = lsin(((i + 768) % 2048) * d);
        const e = f(f(f(lexp(f(1 - Math.abs(s)) * 13.815511557963774) - 1) / 1000000));
        const sg = s === 0 ? 0 : s < 0 ? -1 : 1;
        const v = f(f(f(1 - e) * sg) + 1);
        T[i + 512] = f(v * v * v);
      }
      rmsNorm(T, 2048, 1);
      break;
    }
    default: break;
  }
  if (!S.hasTab) return;
  // tail: flush, trim (not phaser shapes), guard point, active flag
  n = S.count;
  for (let i = 0; i < n; i++) if (!(Math.abs(T[i]) >= TINY)) T[i] = 0;
  const t = S.type;
  if (!(t >= 200 && t <= 299)) trim(S);
  n = S.count;
  T[n] = T[0];
  let act = 1;
  if (n <= 1) act = T[0] !== (t >= 100 && t <= 199 ? 0 : 1) ? 1 : 0;
  S.flags |= act;
}

const fb = new Float32Array(1), ub = new Uint32Array(fb.buffer);
const bits = (x: number): number => { fb[0] = x; return ub[0]; };

/** 0xcf890 / 0x103020: drop the leading run equal to the first point and the trailing run equal to the last. */
function trim(S: Shape): void {
  const T = S.tab;
  let n = S.count;
  const first = bits(T[0]);
  let r = 1;
  while (r < n && bits(T[r]) === first) r++;
  r--;
  n -= r;
  if (r > 0) T.copyWithin(0, r, r + n);
  const last = bits(T[n - 1]);
  while (n > 1 && bits(T[n - 2]) === last) n--;
  if (n !== S.count) {
    S.count = n;
    S.x14 = f(S.x14 - r);
  }
}

/** Build the table of `S` for shape type `type` now (0xcc010; tests and tools). */
export function buildShape(pt: PartDsp, S: Shape, type: number): void {
  gen(pt, S, type);
  S.cType = -1;
}

/** Regenerate `S` when its inputs (type, map curve, mix, map offset) changed. */
function update(pt: PartDsp, S: Shape, type: number, mix: number): boolean {
  const mi = mapIndex(type);
  const c = mi >= 0 && !(type < 17) && !(type >= 100 && type < 110) && !(type >= 200 && type < 209) ? pt.maps[mi] ?? null : null;
  const ofs = c ? c.offset : NaN;
  if (S.cType === type && S.cSrc === c && S.cMix === mix && (S.cOfs === ofs || ofs !== ofs)) return false;
  S.mix = mix;
  gen(pt, S, type);
  S.cType = type; S.cSrc = c; S.cMix = mix; S.cOfs = ofs;
  return true;
}

// ------------------------------------------------------------- setup

/** 0xcb430: filter `w` frequency range from its width and shape, then re-apply frequency / envelope (params 52 / 56). */
export function filterRange(plug: PlugDsp, pt: PartDsp, w: number): void {
  const F = pt.flt[w], S = pt.shp.flt[w], P = plug.p, o = pt.pofs + 12 * w;
  F.pofs = o;
  F.width = f(P[o + 54] * 0.004);
  const s2 = f(0.6666666666666666 / lexp(f(1 - F.width) * LN2));
  const cut = (x: number): number => {
    const sg = x === 0 ? 0 : x < 0 || (x === 0 && 1 / x < 0) ? -1 : 1;
    return f(x - f(sg * (x < 1 ? x : 1)));
  };
  const s0 = cut(f(s2 * S.y18)), s1 = cut(f(s2 * S.z1c));
  F.base = f(F_LO - s0);
  F.top = f(F_HI + s1);
  F.scale = f(F.top - F.base);
  F.scale2 = f(F.scale * 2);
  F.inv = f(1 / F.scale);
  F.half = f(F.scale * 0.5);
  F.center = f(f(F.base + F.top) * 0.5);
  plug.param(o + 52, P[o + 52]);
  plug.param(o + 56, P[o + 56]);
}

/** 0xcb6e0: resonance `w` index scale from the resonance scale / adaptive switches. */
export function resSetup(plug: PlugDsp, pt: PartDsp, w: number): void {
  const F = pt.flt[w], R = pt.shp.res[w], P = plug.p, o = pt.pofs + 12 * w;
  const hz = (n: number): number => 440 * lexp((n - 57) * 0.057762265046662105);
  if (P[o + 58] === 0) {
    if (P[o + 61] > 0) { F.b4 = f(R.scale * hz(30)); F.b8 = 0.875; } else { F.b4 = R.scale; F.b8 = -0.125; }
  } else if (P[o + 61] > 0) { F.b4 = f(0.000375 * R.scale * hz(42)); F.b8 = 0.5; } else { F.b4 = f(0.000375 * R.scale); F.b8 = -1.5; }
}

/** 0xcfa60: phaser tempo base (per sample) and speed after a tempo / sample rate change. */
export function phaserTempo(plug: PlugDsp, pt: PartDsp): void {
  pt.phTempo = f(plug.tempo / f(plug.sr * 3840));
  plug.param(pt.pofs + 80, plug.p[pt.pofs + 80]);
}

/** Per-part setup after a state / parameter change: the 11 shapes (0xcb280 0..10) with their filter / resonance setups. */
export function filterSetup(plug: PlugDsp, pt: PartDsp): void {
  const st = pt.st, sh = pt.shp;
  if (!st) return;
  const prec = Math.min(plug.precision, 2);
  // shape 5 first sets the phaser map bipolar for "Freq" (0x444350)
  const m15 = pt.maps[15];
  if (m15 && (m15.offset === 0.5) !== (pt.phType === 9)) m15.setOffset(pt.phType === 9 ? 0.5 : 0);
  if (update(pt, sh.main, 300, f(st.eqMix))) plug.countBases(pt);
  for (let w = 0; w < 2; w++) {
    const F = pt.flt[w];
    F.type = (w ? st.f2Type : st.f1Type) | 0;
    F.resType = (w ? st.r2Type : st.r1Type) | 0;
    update(pt, sh.flt[w], F.type, 1);
    update(pt, sh.res[w], F.resType, 1);
    filterRange(plug, pt, w);
    resSetup(plug, pt, w);
  }
  update(pt, sh.ph, 200 + pt.phType, 1);
  for (let i = 0; i < 5; i++) update(pt, sh.masks[i], 400 + 100 * i, 1);
  sh.main.prec = prec; sh.ph.prec = prec;
  for (let i = 0; i < 5; i++) sh.masks[i].prec = prec;
  for (let w = 0; w < 2; w++) { sh.flt[w].prec = prec; sh.res[w].prec = prec; }
}

// ------------------------------------------------------------- readers

/** fcvtns to int32 (round to nearest even, saturating, NaN 0). */
function cvtns(x: number): number {
  if (x !== x) return 0;
  if (x >= 2147483647.5) return 2147483647;
  if (x < -2147483648.5) return -2147483648;
  const r = Math.round(x);
  return (r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r) | 0;
}

/** frintx + fcvtzs, low 32 bits (0xcba80). */
function rneI(x: number): number {
  if (x !== x) return 0;
  let r = Math.round(x);
  if (r - x === 0.5 && r % 2 !== 0) r -= 1;
  if (r >= 9223372036854775807) return -1;
  if (r <= -9223372036854775808) return 0;
  return r | 0;
}

/** 0xcbb40: table value per element at index src * scale + ofs (clamped). */
function lookup(S: Shape, src: Float32Array, out: Float32Array, n: number, scale: number, ofs: number): void {
  const T = S.tab, c = S.count;
  if (S.prec < 1) {
    const hi = f(c - 1), m = (n + 7) & ~7;
    for (let i = 0; i < m; i++) {
      let x = f(f(src[i] * scale) + ofs);
      x = x > 0 ? x : 0;
      x = x < hi ? x : hi;
      out[i] = T[cvtns(x)];
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const s = f(f(src[i] * scale) + ofs);
    const j = rneI(f(s - 0.5));
    if (j < 0) out[i] = T[0];
    else if (c - 1 <= j) out[i] = T[c - 1];
    else { const r = f(s - f(j)); out[i] = f(f(T[j] * f(1 - r)) + f(T[j + 1] * r)); }
  }
}

/** 0xcbcb0: wrapping table read (phaser shapes, count a power of 2). */
function lookupWrap(S: Shape, src: Float32Array, out: Float32Array, n: number, scale: number, ofs: number): void {
  const T = S.tab, mask = S.count - 1;
  if (S.prec < 1) {
    const m = (n + 7) & ~7;
    for (let i = 0; i < m; i++) out[i] = T[cvtns(f(f(src[i] * scale) + ofs)) & mask];
    return;
  }
  for (let i = 0; i < n; i++) {
    const s = f(f(src[i] * scale) + ofs);
    const j0 = rneI(f(s - 0.5));
    const r = f(s - f(j0));
    const j = j0 & mask;
    out[i] = f(f(T[j] * f(1 - r)) + f(T[j + 1] * r));
  }
}

/** Main shape gains per partial (0xcbb40 on part+0x298) over log2 Hz. */
export function mainShape(pt: PartDsp, logf: Float32Array, out: Float32Array, n: number): void {
  const S = pt.shp.main;
  if (S.count < 1) { out.fill(1, 0, n); return; }
  lookup(S, logf, out, n, S.scale, S.x14);
}

// ------------------------------------------------------------- units

/** 0x4264: amps = mask * (gain * amps) + (amps - mask * amps). */
function maskMix(m: Float32Array, g: Float32Array, a: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) { const x = a[i]; a[i] = f(f(m[i] * f(g[i] * x)) + f(x - f(m[i] * x))); }
}

/** 0x4524: b = a * k + b * (1 - k). */
function blend(a: Float32Array, b: Float32Array, n: number, k: number): void {
  const k1 = f(1 - k);
  for (let i = 0; i < n; i++) b[i] = f(f(a[i] * k) + f(b[i] * k1));
}

/** Jenkins' 96-bit mix of the noise seed (0xdea08). */
function noiseSeed(s: number): number {
  let a = s | 0, b = 0x6b89, c = 0x197e1;
  a = (a - b - c) ^ (c >>> 13); b = (b - c - a) ^ (a << 8); c = (c - a - b) ^ (b >>> 13);
  a = (a - b - c) ^ (c >>> 12); b = (b - c - a) ^ (a << 16); c = (c - a - b) ^ (b >>> 5);
  a = (a - b - c) ^ (c >>> 3); b = (b - c - a) ^ (a << 10); c = (c - a - b) ^ (b >>> 15);
  return c | 0;
}

/** Units 4 / 5 (0xddea0): the filter REND+0x84 selects (the chain's first filter unit gets filter part+0xb64). */
export function filterUnit(v: HVoice, ctx: UnitCtx, which: 0 | 1): void {
  void which;
  const R = ctx as RenderCtx;
  const part = v.part, plug = v.plug, sb = v.sb, N = sb.count, P = plug.p, A = v.arts.out;
  const w = R.fmixUnit;
  const isA = w === part.b64;
  let buf = sb.amps;
  if (R.fmixSign < 0) {
    if (isA) { R.w58.set(sb.amps.subarray(0, N)); R.f88 = f(1 - R.fmixAmt); } else buf = R.w58;
  }
  const F = part.flt[w], o = part.pofs + 12 * w;
  const tgt = w === 0 ? f(part.flt[0].freq + part.f48) : part.flt[1].freq; // REND+0xa4 / +0xa8
  if (v.first > 0 && isA) {
    // first block (0xe252c): V+0x27c / +0x280 start at the targets
    v.fTgt[0] = f(part.flt[0].freq + part.f48); v.fTgt[1] = part.flt[1].freq;
  }
  v.fTgt[w] = f(tgt + f(f(v.fTgt[w] - tgt) * plug.modK[0]));
  const key = f((v.fLog + G138) * part.fKey[w]);
  const r94 = f(F.base + key);
  let envAmt = f(F.env * A[31 + w]);
  let r98 = f(f(v.fTgt[w] + key) + f(A[4 + w] * F.scale2));
  const art = v.ap.arts[4 + w];
  if (art.envOn) {
    const eo = v.arts.env[4 + w].out;
    if (F.adapt) {
      envAmt = f(f(envAmt * eo) * 4);
      r98 = envAmt > 0 ? f(r98 + f(envAmt * f(F.top - r98))) : f(r98 + f(envAmt * f(F.top - r94)));
    } else r98 = f(r98 + f(f(eo * envAmt) * F.scale2));
  }
  if (v.first > 0) v.fCur[w] = r98;
  else { v.fCur[w] = f(r98 + f(f(v.fCur[w] - r98) * art.smooth)); r98 = v.fCur[w]; }
  const ac = f(f(f(P[o + 57]) * K001) * A[8 + w]);
  const fc = f(lexp(r98 * LN2));
  if (w === 0) { R.ac = ac; R.resHz = fc; }
  const sh = part.shp;
  // filter shape
  const S = sh.flt[w];
  if (S.flags !== 0 && R.f88 !== 0) {
    let k = f(lexp(f(1 - f(F.width * A[6 + w])) * LN2) * S.scale);
    if (P[o + 53] === 0) {
      if (v.derived < 2) v.deriveLog();
      lookup(S, v.logf, R.w20, N, k, f(S.x14 - f(r98 * k)));
    } else {
      k = f(k * 0.9);
      if (v.derived < 1) v.deriveHz();
      lookup(S, v.hz, R.w20, N, f(k / fc), f(S.x14 - k));
    }
    const M = sh.masks[w];
    if (M.flags > 0) {
      if (v.derived < 2) v.deriveLog();
      lookup(M, v.logf, R.w38, N, M.scale, M.x14);
      maskMix(R.w38, R.w20, buf, N);
    } else for (let i = 0; i < N; i++) buf[i] = f(buf[i] * R.w20[i]);
  }
  // resonance / noise
  const Rs = sh.res[w];
  if (ac > 0 && Rs.flags !== 0 && R.f88 !== 0) {
    const g = R.w20;
    if (Rs.type === 109) {
      const s0 = f(F.resWidth * A[10 + w]);
      if (bits(s0) !== bits(v.nWidth)) {
        v.nWidth = s0;
        v.nScale = 9999 / (1.9954648526077097 + (lexp(f(s0 * 0.25) * 6.6858609470683596) - 1) * 1.2475056689342403);
        v.nRate = plug.blk * 0.1000100010001 * (1 / plug.sr) * v.nScale;
      }
      const a2 = f(ac * ac);
      let s9 = f(a2 * a2 * a2 * v.nScale * 2);
      if (P[o + 58] > 0) s9 = f(s9 * 2);
      const s8 = f(s9 + 1);
      R.nseed[0] = v.nSeed >>> 0;
      randUniform32f(g, N, 0, s8, R.nseed);
      const s10 = f(Math.sqrt(s8));
      const tilt = P[o + 58] === 0;
      if (tilt) {
        if (v.derived < 1) v.deriveHz();
        for (let i = 0; i < N; i++) g[i] = f(g[i] + f(v.hz[i] * NOISE_K));
      }
      if (P[o + 61] === 0) {
        thresholdLTVal32fI(g, N, s9, 0);
        thresholdGTVal32fI(g, N, 0, s10);
      } else {
        for (let i = 0; i < N; i++) g[i] = f(g[i] + -s9);
        thresholdLT32fI(g, N, 0);
        if (tilt) for (let i = 0; i < N; i++) {
          if (g[i] > 0) { const t = f(1 + f(v.hz[i] * NOISE_K)); if (t > 0) g[i] = f(g[i] / t); }
        }
        const k2 = f(s10 * 2);
        for (let i = 0; i < N; i++) { const x = g[i]; g[i] = f(f(x * x) * k2); }
      }
      const M = sh.masks[2 + w];
      if (M.flags > 0) {
        if (v.derived < 2) v.deriveLog();
        lookup(M, v.logf, R.w38, N, M.scale, M.x14);
        maskMix(R.w38, g, buf, N);
      } else for (let i = 0; i < N; i++) buf[i] = f(buf[i] * g[i]);
      v.nPhase += v.nRate;
      if (v.nPhase >= 1) { v.nPhase -= Math.trunc(v.nPhase); v.nSeed = noiseSeed(v.nSeed); }
    } else {
      let s8 = P[o + 61] > 0 ? f(F.b4 / v.fHz) : F.b4;
      s8 = f(s8 * lexp(f(1 - f(F.resWidth * A[10 + w])) * LN2));
      if (P[o + 58] === 0) {
        if (v.derived < 2) v.deriveLog();
        const s0 = f(f(r98 + F.resOfs) + f(A[12 + w] * 8));
        lookup(Rs, v.logf, g, N, s8, f(Rs.x14 - f(s0 * s8)));
      } else {
        if (v.derived < 1) v.deriveHz();
        const e = lexp(f(A[12 + w] * 8) * LN2);
        lookup(Rs, v.hz, g, N, s8, f(Rs.x14 - f(fc * F.resOfsMul) * e * s8));
      }
      const kk = f(ac * LN2);
      const M = sh.masks[2 + w];
      if (M.flags > 0) {
        if (v.derived < 2) v.deriveLog();
        lookup(M, v.logf, R.w38, N, M.scale, M.x14);
        for (let i = 0; i < N; i++) g[i] = f(f(g[i] * R.w38[i]) * kk);
      } else for (let i = 0; i < N; i++) g[i] = f(g[i] * kk);
      exp32f(g, R.w28, N);
      for (let i = 0; i < N; i++) buf[i] = f(buf[i] * R.w28[i]);
    }
  }
  // filter mix: serial keeps the first filter's output, parallel blends with the input copy
  if (R.fmixSign > 0) {
    if (isA) R.w58.set(sb.amps.subarray(0, N));
    else blend(R.w58, sb.amps, N, f(1 - R.f88));
  } else if (R.fmixSign < 0 && !isA) blend(R.w58, sb.amps, N, R.f88);
  R.f88 = R.fmixAmt;
  R.fmixUnit = w ^ 1;
}

/** Unit 6 (0xdef50): phaser (amplitude, or frequency for the "Freq" type). */
export function phaserUnit(v: HVoice, ctx: UnitCtx): void {
  const part = v.part, plug = v.plug, P = plug.p, o = part.pofs;
  if (P[o + 76] <= 0) return;
  const R = ctx as RenderCtx, sb = v.sb, A = v.arts.out, N = sb.count;
  let m = f(f(f(P[o + 76]) * K001) * A[16]);
  if (!(m < 1)) m = 1;
  if (!(m > 0)) return;
  const sh = part.shp, S = sh.ph;
  v.phKey = f(f(v.fLog * f(P[o + 81])) * K001);
  const s0 = f(f(f(-P[o + 79]) * K001) - A[18]);
  let ofs = f(f(s0 * S.scale) - f(v.phPh * S.s24));
  let scale: number, src: Float32Array;
  switch (P[o + 77]) {
    case 0: {
      if (v.derived < 2) v.deriveLog();
      src = v.logf;
      const e = lexp(f(f(f(part.phOfs - 1) * 8) + f(A[17] * 2)) * LN2);
      scale = e * 12 * S.s24;
      ofs = ofs - v.phKey * scale;
      break;
    }
    case 1: {
      if (v.derived < 1) v.deriveHz();
      src = v.hz;
      scale = lexp(f(f(f(part.phOfs - 1) + A[17]) * 8) * LN2) * 0.005 * S.s24;
      ofs = ofs - f(v.phKey * S.scale);
      break;
    }
    default: {
      if (v.derived < 1) v.deriveHz();
      src = v.hz;
      scale = f(f(f(2 - f(part.phOfs + A[17])) * S.s24) / v.fHz);
      ofs = ofs - f(v.phKey * S.scale);
      break;
    }
  }
  const g = R.w20;
  lookupWrap(S, src, g, N, f(scale), f(ofs));
  const M = sh.masks[4];
  if (part.phType === 9) {
    const m3 = f(f(m * m) * m);
    if (M.flags > 0) {
      if (v.derived < 2) v.deriveLog();
      lookup(M, v.logf, R.w38, N, M.scale, M.x14);
      for (let i = 0; i < N; i++) g[i] = f(f(g[i] * R.w38[i]) * m3);
    } else for (let i = 0; i < N; i++) g[i] = f(g[i] * m3);
    const F = sb.freq;
    if (S.prec === 0) {
      for (let i = 0; i < N; i++) g[i] = f(g[i] * LN2F);
      exp32f(g, R.w28, N);
      for (let i = 0; i < N; i++) F[i] = F[i] * R.w28[i];
    } else for (let i = 0; i < N; i++) F[i] = F[i] * lexp(g[i] * LN2);
    v.derived = 0;
    R.recalc = true;
    v.pitchCache = 2147483648;
    return;
  }
  const amps = sb.amps;
  if (M.flags > 0) {
    if (v.derived < 2) v.deriveLog();
    lookup(M, v.logf, R.w38, N, M.scale, M.x14);
    for (let i = 0; i < N; i++) {
      const x = amps[i], mk = R.w38[i];
      amps[i] = f(x + f(x * f(f(f(mk * g[i]) * m) - f(mk * m))));
    }
  } else {
    const c = f(1 - m);
    for (let i = 0; i < N; i++) amps[i] = f(amps[i] * f(f(g[i] * m) + c));
  }
}
