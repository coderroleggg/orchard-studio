// Harmor's partial-level units and shaping-map tables, ported from FL 2026's
// Harmor_x64 (arm64 slice). Map tables (built on every state / parameter change,
// FL 0xd09f0): pluck shape 14 (0xe04d0 -> part+0x258), protection 5 (0xe0680 ->
// +0x90), randomness 4 (0xe0790 -> +0xa0), clipping 6 (0xe0930 -> +0xb0, +0x10c),
// harmonizer local mask 23 (0xe1290 -> +0x610), blur local mask 24 (0xe13b0 ->
// +0x280), image freq mask 25 (0xe14d0 -> +0x180), harmonizer distribution 16
// (0xe0f40 -> +0x5dc), prism 7 (0xe0bb0 -> +0xf8, +0x108), unison pitch 8
// (0xe0d10 -> +0x70) and formant 9 (0xe0e10 -> +0x78); the local EQ (0xe1070)
// and timbre tables (0xe5d60) are PlugDsp's. Units (called per control block on
// the voice's partial levels sb.amps / frequencies sb.freq): 1 prism 0xdda80, 2
// randomness 0xdde30, 3 harmonizer 0xdcbf0, 7 pluck 0xdf500 (coefficients
// 0xdff70), 8 time / harmonic blur 0xdd670, 9 protection 0xdd150, 10 clipping
// 0xdd190; the harmonic blur kernel (0xe2724..0xe29c0) and the prism amount
// (0xe30b8..0xe3178) of the voice render; the unit chain rules of 0xca920.
// Maps 10..13, 15, 17..22 have no table builders (filters / phaser read them).

import type { PartDsp, PlugDsp } from './core';
import type { HVoice } from './voice';
import type { UnitCtx } from './units';
import { mapConstant, mapFill32, mapAt, curveLength, mapIterInit, mapIterNext, CurveState, type Curve } from './env';
import {
  f32bits, thresholdGT32f, subCRev32fI, convert32f64f, mul64fI, addC64fI, mul32fI, copy32f, set32f, zero32f,
  mulC32f, mulC32fI, powx32f, exp32f, expm132f, flip32f, vectorSlope32f, sum32f,
} from './ipp';
import {
  kProtect, kMaskMix, kMaskBlend, kBlend, kPluck, kScale, kLerp, kStrideFma, kTimeBlur, kTimeBlurC,
  kClipMin, kClipMinT, kClipSharp, kClipSharpT, kClipSoft, kClipSoftT, kClipSub, kClipSubT, kClipGate, kClipGateT,
  kPrismAdd, kPrismMul, kPrismFlat, conv32f,
} from './partials-vec';

const f = Math.fround;
/** Sine bank slots (core.ts SLOTS; not imported: core imports this module). */
const SLOTS = 520;
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634;
/** 0x8f6e9c: 0.001 (float32). */
const K001 = f(0.001);
/** G[0xa2d264]: ln 3 (float32). */
const LN3F = f(Math.log(3));
/** 2^-24 (0x8ec63c / G[0xa2d224]). */
const TINY = 5.960464477539063e-8;
/** 0x8ec568: clipping table scale per clipping mode (High threshold, Soft low, Sharp low, Hard low, Subtraction). */
const CLIP_K = [4, 128, 32, 2, 2];
/** 0x8ec4d0 (+4, +8): harmonic index positions of sub slots 2 / 3 per sub-harmonic mode. */
const SUB_POS = [[0.5, 1.5], [0, 0]];
/** TMMap default level (+0xac) of the unison pitch (8) and formant (9) maps: "default" = flat at it. */
const DEF_LEVEL_8_9 = 0.5;

// scratch (FL: the builders' temporary tables; REND+0x30 / +0x40 and the double
// views of REND+0x20 / +0x28 in the units)
const TB = new Float32Array(SLOTS);
const TB_U = new Uint32Array(TB.buffer);
const TD = new Float64Array(SLOTS);
const W30 = new Float32Array(SLOTS + 2 * 128 + 2 * 128 + 8);
const W40 = new Float32Array(SLOTS);
const W28D = new Float64Array(SLOTS);
const MST = new CurveState();

/** FL's level law (0xcac00 / 0xe0f40): x == 1 ? 1 : (exp(x ln 3) - 1) / 2 in float32 steps. */
function law3(x: number): number {
  const s = f(x);
  if (s === 1) return 1;
  return f((Math.exp(f(s * LN3F)) - 1) * 0.5);
}

/** 0xcf60: frac(x) = x - trunc(x) (double; phase randomness and image positions). */
export function frac(x: number): number {
  return x - Math.trunc(x);
}

// ---------------------------------------------------------------- map tables

/**
 * 0xcb8b0: trim a table to the range differing from v (bitwise): offset = the
 * first differing index rounded down to 8, end = one past the last differing
 * index rounded up to 8 (at most the count). Returns [offset, count].
 */
function trim(t: Float32Array, u: Uint32Array, count: number, v: number): [number, number] {
  const vb = f32bits(v);
  let i = 0;
  while (i < count && u[i] === vb) i++;
  const ofs = ((Math.max(i - 7, 0) + 7) & ~7);
  let j = count;
  while (ofs < j && u[j - 1] === vb) j--;
  const end = Math.min((j + 7) & ~7, count);
  void t;
  return [ofs, end - ofs];
}

/** 0xe02c0: the double version of the map reader 0xe00b0 (prism table). */
function mapLog64(pt: PartDsp, c: Curve, buf: Float64Array, flag: boolean): void {
  const off = flag ? 4 : 0;
  const k = mapConstant(c);
  if (k !== null) {
    buf.fill(k - c.offset, 0, off + 516);
  } else {
    const d8 = curveLength(c) / 9;
    mapIterInit(c, MST);
    let x = 0;
    for (let j = 0; j < 516; j++) {
      buf[off + j] = MST.out;
      const nx = Math.log(j + 2) * INV_LN2 * d8;
      mapIterNext(c, MST, nx - x);
      x = nx;
    }
    if (flag) {
      buf[1] = buf[4];
      // FL reads the slot-2 position for slot 3 as well (+4 both times)
      const p = Math.log(f(1 + SUB_POS[pt.subMode ? 1 : 0][0])) * INV_LN2 * d8;
      buf[2] = f(mapAt(c, p));
      buf[3] = f(mapAt(c, p));
    }
  }
  if (flag) buf[0] = 1;
}

/** TMMap.IsDefault (0x451900) for maps without a default point list: flat at the default level. */
function mapIsDefault(c: Curve, level: number): boolean {
  const k = mapConstant(c);
  return k !== null && k === level;
}

/** 0xe04d0: pluck shape (map 14): 2^(16 (v - 1)) in Pluck blending, else its reciprocal. */
function pluckTable(plug: PlugDsp, pt: PartDsp): void {
  const c = pt.maps[14];
  if (!c) return;
  const b = TB;
  plug.mapLog(pt, c, b, true);
  const T = pt.pluckTab;
  T[0] = b[0];
  for (let i = 1; i < SLOTS; i++) {
    const e = Math.exp(f(f(b[i] - 1) * 16) * LN2);
    T[i] = pt.blend === 5 ? f(e) : f(1 / e);
  }
}

/** 0xe0680: protection (map 5): v^2 over the non-zero range. */
function protectTable(plug: PlugDsp, pt: PartDsp): void {
  const c = pt.maps[5];
  if (!c) return;
  const b = TB;
  plug.mapLog(pt, c, b, true);
  const [ofs, cnt] = trim(b, TB_U, SLOTS, 0);
  for (let i = Math.max(ofs, 1); i <= ofs + cnt - 1; i++) b[i] = f(b[i] * b[i]);
  pt.protectTab.set(b);
  pt.protectOfs = ofs;
  pt.protectCount = cnt;
}

/** 0xe0790: randomness (map 4, linear harmonic axis): v * 8 ln 2 (applied from index 0 over `count`, as FL). */
function randTable(pt: PartDsp): void {
  const c = pt.maps[4];
  if (!c) return;
  const b = TB;
  mapFill32(c, b, 4, 516, 0);
  const d8 = curveLength(c) / 515;
  b[0] = 0;
  b[1] = b[4];
  const sp = SUB_POS[pt.subMode ? 1 : 0];
  b[2] = f(mapAt(c, sp[0] * d8));
  b[3] = f(mapAt(c, sp[1] * d8));
  const [ofs, cnt] = trim(b, TB_U, SLOTS, 0);
  const k = f(8 * LN2);
  for (let i = 0; i < cnt; i++) b[i] = f(b[i] * k);
  pt.randTab.set(b);
  pt.randOfs = ofs;
  pt.randCount = cnt;
}

/** 0xe0930: clipping (map 6) thresholds per mode, and the flat level part+0x10c. */
function clipTable(plug: PlugDsp, pt: PartDsp): void {
  const c = pt.maps[6];
  if (!c) return;
  const b = TB, mode = pt.clipMode;
  plug.mapLog(pt, c, b, true);
  const [ofs, cnt] = trim(b, TB_U, SLOTS, mode === 0 ? 1 : 0);
  const inv = mode === 1 || mode === 2;
  const K = CLIP_K[Math.max(0, Math.min(4, mode))];
  for (let i = ofs; i <= ofs + cnt - 1; i++) {
    if (mode === 0 && b[i] === 1) { b[i] = 3.3999999521443642e38; continue; }
    const v = f(b[i] * 2);
    const d = v * v * K;
    b[i] = inv ? f(1 / (d > TINY ? d : TINY)) : f(d);
  }
  pt.clipTab.set(b);
  pt.clipOfs = ofs;
  pt.clipCount = cnt;
  const k = mapConstant(c);
  if (k === null) pt.clipFlat = -1;
  else if (mode === 0 && k === 1) pt.clipFlat = NaN; // FL stores 0x7fffffff: clipping off
  else { const v = f(k * 2); pt.clipFlat = f(v * v * K); }
}

/** 0xe1290 / 0xe13b0: a local mask (516 values, harmonics): v^2, count 0 when all ones. */
function squareMask(plug: PlugDsp, pt: PartDsp, m: number, out: Float32Array): number {
  const c = pt.maps[m];
  if (!c) return 0;
  const b = TB;
  plug.mapLog(pt, c, b, false);
  let ones = true;
  for (let i = 0; i < 516; i++) {
    if (b[i] !== 1) ones = false;
    out[i] = f(b[i] * b[i]);
  }
  return ones ? 0 : 516;
}

/** 0xe14d0: image freq local mask (map 25), trimmed to the range differing from 1. */
function imgMaskTable(plug: PlugDsp, pt: PartDsp): void {
  const c = pt.maps[25];
  if (!c) return;
  const b = TB;
  plug.mapLog(pt, c, b, false);
  const [ofs, cnt] = trim(b, TB_U, 516, 1);
  pt.imgMask.set(b.subarray(0, 516));
  pt.imgMaskOfs = ofs;
  pt.imgMaskCount = cnt;
}

/** 0xe0f40: harmonizer distribution (map 16): 9 levels through the 3x law of 2 v. */
function hzDistTable(pt: PartDsp): void {
  const c = pt.maps[16];
  if (!c) return;
  const d = pt.hzDist;
  mapFill32(c, d, 0, 9, 0);
  for (let i = 0; i < 9; i++) d[i] = law3(f(d[i] * 2));
}

/** 0xe0bb0: prism (map 7, double): 2 (v - 0.5) (+1 in multiply mode without level link); part+0x108 = flat level x 2. */
function prismTable(pt: PartDsp): void {
  const c = pt.maps[7];
  if (!c) return;
  const d = TD;
  mapLog64(pt, c, d, true);
  d[0] = 0;
  const k = mapConstant(c);
  pt.prismFlat = k !== null ? f(k * 2) : -1;
  const add = pt.prismMode > 0 && pt.prismVol === 0 ? 1 : 0;
  const T = pt.prismTab;
  for (let i = 0; i < SLOTS; i++) { const x = d[i] * 2; T[i] = add ? x + 1 : x; }
}

/** 0xe0d10: unison pitch (map 8): (2 v)^2, none at the default (flat 0.5). */
function uniPitchTable(plug: PlugDsp, pt: PartDsp): void {
  const c = pt.maps[8];
  if (!c) return;
  if (mapIsDefault(c, DEF_LEVEL_8_9)) { pt.uniPitchTab = null; return; }
  const b = pt.uniPitchBuf;
  plug.mapLog(pt, c, b, true);
  for (let i = 0; i < SLOTS; i++) { const v = f(b[i] * 2); b[i] = f(v * v); }
  pt.uniPitchTab = b;
}

/** 0xe0e10: formant (map 9): (i + 1) 2^(-2 v) per harmonic (516 map values; FL reads 4 unset ones at the end). */
function formantTable(plug: PlugDsp, pt: PartDsp): void {
  const c = pt.maps[9];
  if (!c) return;
  if (mapIsDefault(c, DEF_LEVEL_8_9)) { pt.formantTab = null; return; }
  const b = pt.formantBuf;
  b.fill(0, 516);
  plug.mapLog(pt, c, b, false);
  for (let i = 0; i < SLOTS; i++) b[i] = f((i + 1) * Math.exp(f(f(-b[i]) * 2) * LN2));
  pt.formantTab = b;
}

/**
 * 0xca920's flags this module owns: part+0xb69 (the harmonizer's energy mode:
 * set by the local EQ unit, cleared by the harmonizer, in chain order).
 */
function chainFlags(pt: PartDsp): void {
  let b69 = pt.b69;
  for (let i = 0; i < 12; i++) {
    const u = pt.order[i];
    if (u === 0 && !pt.b68) b69 = true;
    else if (u === 3) b69 = false;
  }
  pt.b69 = b69;
}

/**
 * 0xca920: the part's unit chain into `out` (unit ids in processing order,
 * units FL leaves out skipped: local EQ when folded into the timbres, randomness /
 * protection / clipping without a table range, pluck when it replaces the blur
 * decay). Returns the chain length; the envelope volume unit (11) is dropped when
 * it is last (FL applies it after the loop).
 */
export function unitChain(pt: PartDsp, out: Int32Array): number {
  let n = 0, env = -1;
  for (let i = 0; i < 12; i++) {
    const u = pt.order[i];
    switch (u) {
      case 0: if (pt.b68) continue; break;
      case 2: if (pt.randCount <= 0) continue; break;
      case 7: if (pt.pluckBlur) continue; break;
      case 9: if (pt.protectCount <= 0) continue; break;
      case 10: if (pt.clipCount <= 0) continue; break;
      case 11: env = n; break;
      default: if (u < 0 || u > 11) continue; break;
    }
    out[n++] = u;
  }
  if (env === n - 1) n--;
  return n;
}

/** Rebuild the part's map tables (after a state / parameter change; PlugDsp.applyAll). */
export function mapTables(plug: PlugDsp, pt: PartDsp): void {
  if (pt.maps.length < 26) return;
  pluckTable(plug, pt);
  protectTable(plug, pt);
  randTable(pt);
  clipTable(plug, pt);
  pt.hzMaskOfs = 0;
  pt.hzMaskCount = squareMask(plug, pt, 23, pt.hzMask);
  pt.blurMaskOfs = 0;
  pt.blurMaskCount = squareMask(plug, pt, 24, pt.blurMask);
  imgMaskTable(plug, pt);
  hzDistTable(pt);
  prismTable(pt);
  uniPitchTable(plug, pt);
  formantTable(plug, pt);
  chainFlags(pt);
}

// ---------------------------------------------------------------- per-voice state

/** TriggerVoice's unit fields (0xdb1ac..0xdb298): pluck gains / cache, blur state reset. */
export function unitsTrigger(v: HVoice): void {
  v.pluckFill = 0;
  v.pluckGain[1] = 1;
  v.pluckS = -1;
  v.pluckOn = false;
  v.blurReset = 1;
}

// ---------------------------------------------------------------- units

/** Unit 1 (0xdda80): prism, frequencies spread by the prism table (add) or around the fundamental (multiply). */
export function prismUnit(v: HVoice, ctx: UnitCtx): void {
  if (v.prismAmt === 0) return;
  const part = v.part, sb = v.sb, n = sb.count;
  let tab = part.prismTab;
  if (part.prismVol > 0) {
    const w = ctx.w20;
    thresholdGT32f(sb.amps, w, n, 1);
    if (part.prismVol === 2) subCRev32fI(1, w, n);
    convert32f64f(w, W28D, n);
    mul64fI(part.prismTab, W28D, n);
    if (part.prismMode !== 0) addC64fI(1, W28D, n);
    tab = W28D;
    ctx.recalc = true;
    v.pitchCache = 2147483648;
  } else if (!ctx.recalc) return;
  const fn = v.fNorm, amt = v.prismAmt;
  // FL's NEON paths (G[0xa343a1] bit 0, set on arm64)
  if (part.prismMode === 0) kPrismAdd(sb.freq, tab, n, fn * part.ratio * amt);
  else if (part.prismFlat < 0 || part.prismVol > 0) kPrismMul(sb.freq, tab, n, fn, amt, f(1 - amt));
  else {
    const k = f(f(part.prismFlat * amt) + f(1 - amt));
    kPrismFlat(sb.freq, n, k, fn - fn * k);
  }
  v.derived = 0;
}

/** Unit 2 (0xdde30): randomness, levels times the voice's random gains (V+0xd8, drawn at the trigger). */
export function randomUnit(v: HVoice, ctx: UnitCtx): void {
  if (v.part.randCount <= 0) return;
  const sb = v.sb, o = v.rndOfs;
  let n = sb.count - o;
  if (n > v.rndCount) n = v.rndCount;
  if (n > 0) mul32fI(v.rnd, sb.amps, n, o, o);
  void ctx;
}

/** Unit 3 (0xdcbf0): harmonizer, stretched copies of the harmonic spectrum added at stepped offsets / strides. */
export function harmonizerUnit(v: HVoice, ctx: UnitCtx): void {
  const part = v.part, P = v.plug.p, o = part.pofs, A = v.arts.out, sb = v.sb;
  const mixRaw = P[o + 27];
  if (mixRaw <= 0) return;
  let s = f(f(mixRaw * K001) * A[19]);
  if (!(s < 1)) s = 1;
  if (!(s > 0)) return;
  const mix = f(s * s);
  let w = f(part.hzWidth * A[20]);
  if (!(w < 1)) w = 1;
  if (!(w > 0)) return;
  const step = f(1 / f(1 + f(w * 8)));
  let x = f(1 - step);
  let sum = 1;
  let k20 = 2, k40 = 2;
  const o28 = P[o + 30], w27 = P[o + 32];
  let s38 = P[o + 31], s30 = 1, w24 = P[o + 33], w25 = 1;
  if (s38 < 0) { s30 = 1 - s38; s38 = 0; }
  if (w24 < 0) { w25 = 1 - w24; w24 = 0; }
  const N = sb.count - 4, amps = sb.amps, cp = ctx.w28;
  let copied = false, idx = 0;
  if (part.hzMaskCount > 0) { copy32f(amps, cp, N, 4, 0); copied = true; }
  while (x > 0) {
    let g = part.b69 ? f(f(x * x) * part.hzStr) : f(f(f(x * x) * x) * part.hzStr);
    if (!(g < 1)) g = 1;
    g = f(f(g * mix) * part.hzDist[idx]);
    sum = f(sum + g);
    const start = (o28 + k20) | 0, stride = (w27 + k40) | 0;
    if (stride !== 0) { // FL raises a division by zero here
      const cnt = (Math.trunc((N - 1 - start) / stride) + 1) | 0;
      if (cnt > 0 && start < N && (f32bits(g) | 0) >= 0x33800000) {
        if (!copied) { copy32f(amps, cp, cnt, 4, 0); copied = true; }
        kStrideFma(cp, 0, amps, 4 + start, cnt, stride, g);
      }
    }
    k20 = (s38 + Math.imul(s30, k20)) | 0;
    k40 = (w24 + Math.imul(w25, k40)) | 0;
    x = f(x - step);
    idx++;
  }
  if (part.b69) sum = f(Math.sqrt(sum));
  const k = f(1 / sum);
  if (part.hzMaskCount > 0) kMaskMix(part.hzMask, 0, cp, 0, amps, 4, N, k);
  else mulC32fI(k, amps, N, 4);
}

/** 0xdff70: pluck decay coefficients V+0x1f0 = exp(ln 0.01 blk / sr / (rate + 1/4) / shape). */
function pluckCoefs(v: HVoice, ctx: UnitCtx): void {
  const sb = v.sb, n = sb.count, part = v.part;
  if ((f32bits(v.pluckRate) | 0) < 0) { set32f(1, v.pluckCoef, n); return; }
  const s8 = f(v.plug.f1110 / (v.pluckRate + 0.25));
  const w = ctx.w20;
  if (part.blend === 5) {
    let m = f(part.tmix * v.arts.out[3]);
    if (!(m < 1)) m = 1;
    kLerp(part.pluckTab, part.t2, w, n, f(1 - m));
    for (let i = 0; i < n; i++) w[i] = f(s8 / w[i]); // ippsDivCRev_32f_I (fdiv)
  } else kScale(part.pluckTab, w, n, s8);
  exp32f(w, v.pluckCoef, n); // plug+0x1160: ippsExp_32f_A11 / A24 (same kernel)
}

/** Pluck rate V+0x1d8 for a pluck control s < 1: 20000 x 2^(17 (s - 1)). */
function pluckRate(s: number): number {
  return f(Math.exp(f(f(s - 1) * 17) * LN2) * 20000);
}

/** Unit 7 (0xdf500): pluck, per-partial exponential decay from the first block on (counter V+0x1e0). */
export function pluckUnit(v: HVoice, ctx: UnitCtx): void {
  const part = v.part;
  if (part.pluckBlur) return;
  const sb = v.sb, n = sb.count;
  const s = f(part.pluck + v.arts.out[15]);
  if ((f32bits(s) | 0) < 0x3f800000) v.pluckOn = true;
  if (!v.pluckOn) return;
  if (v.e1e0 >= 0) {
    if (f32bits(s) !== f32bits(v.pluckS)) {
      v.pluckS = s;
      v.pluckRate = (f32bits(s) | 0) >= 0x3f800000 ? -1 : pluckRate(s);
      pluckCoefs(v, ctx);
      if (v.pluckFill < n) {
        const m = n - v.pluckFill;
        if (v.e1e0 <= 0) set32f(1, v.pluckGain, m, v.pluckFill);
        else powx32f(v.pluckCoef, v.e1e0, v.pluckGain, m, v.pluckFill, v.pluckFill);
        v.pluckFill = n;
      }
    }
    kPluck(v.pluckGain, sb.amps, v.pluckCoef, n);
  }
  v.e1e0++;
}

/** Unit 8 (0xdd670): time blur (attack / decay one-poles per partial), harmonic blur (kernel convolution), blur mix. */
export function blurUnit(v: HVoice, ctx: UnitCtx): void {
  const part = v.part, sb = v.sb, n = sb.count, amps = sb.amps;
  let src = amps;
  let s = 0, timeBlur: boolean;
  if (part.pluckBlur) { s = f(part.pluck + v.arts.out[15]); timeBlur = true; }
  else timeBlur = f32bits(part.blurAtt) !== 0 || f32bits(part.blurDec) !== 0;
  const st = v.blurState;
  if (timeBlur) {
    if (v.blurReset > 0) {
      if (v.first === 0) { copy32f(amps, st, n); zero32f(st, SLOTS - n, n); }
      else zero32f(st, SLOTS);
      v.blurReset = 0;
    }
    if (part.pluckBlur) {
      if (f32bits(s) !== f32bits(v.pluckS)) {
        v.pluckS = s;
        v.pluckRate = pluckRate(s);
        pluckCoefs(v, ctx);
      }
      kTimeBlurC(amps, st, n, v.pluckCoef, part.blurAtt);
    } else kTimeBlur(amps, st, n, part.blurAtt, part.blurDec);
    src = W40;
    copy32f(st, W40, n);
  } else if (sb.precision >= 1) {
    copy32f(amps, st, n);
    if (v.blurReset > 0) zero32f(st, SLOTS - n, n);
    v.blurReset = 0;
  } else v.blurReset = 1;
  const w = v.blurW;
  if (w > 0) {
    const K = 2 * w + 1, m = n - 4, W20 = ctx.w20;
    copy32f(src, W20, m, 4, w);
    set32f(W20[w], W20, w, 0);
    set32f(0, W20, w, w + m);
    conv32f(W20, 0, m + 2 * w, v.kern, 0, K, W30, 0, 2 * w, 2 * w + m); // only the outputs used below
    if (src === amps) { src = W40; copy32f(amps, W40, 4); }
    mulC32f(W30, v.blurNorm, src, m, 2 * w, 4);
  }
  if (src !== amps) {
    if (part.blurMaskCount > 0) kMaskBlend(part.blurMask, 0, src, 0, amps, 0, n, part.blurMix);
    else if (f32bits(part.blurMix) === 0x3f800000) copy32f(src, amps, n);
    else kBlend(src, 0, amps, 0, n, part.blurMix);
  }
}

/** Unit 9 (0xdd150): harmonic protection, levels pulled back toward the timbre levels (V+0x1b0). */
export function protectionUnit(v: HVoice, ctx: UnitCtx): void {
  const part = v.part;
  if (part.protectCount <= 0) return;
  kProtect(v.sb.amps, v.tamp, part.protectTab, part.protectOfs + part.protectCount, part.protect);
  void ctx;
}

/** Unit 10 (0xdd190): clipping by mode (threshold from the clipping articulator 21, flat map or table). */
export function clippingUnit(v: HVoice, ctx: UnitCtx): void {
  const part = v.part, sb = v.sb, a = sb.amps, mode = part.clipMode;
  if (part.clipCount <= 0) return;
  const thr = f(part.clip * v.arts.out[21]);
  const tb = f32bits(thr) | 0;
  if (mode === 0 ? tb >= 0x3f800000 : tb <= 0) return;
  const t2 = f(thr * thr), t4 = f(t2 * t2);
  const fl = part.clipFlat;
  const flat = fl >= 0 || fl !== fl;
  const o = part.clipOfs;
  let cnt = sb.count - o;
  if (cnt > part.clipCount) cnt = part.clipCount;
  const T = part.clipTab;
  switch (mode) {
    case 0:
      if (flat) { if (fl !== fl) return; kClipMin(a, 0, sb.count, f(t4 * fl)); }
      else if (cnt > 0) kClipMinT(T, o, a, o, cnt, t4 > 2.3283064365386963e-10 ? t4 : 2.3283064365386963e-10);
      break;
    case 1: case 2: {
      if (flat) {
        let k = f(t4 * fl);
        if (!(k > TINY)) k = TINY;
        k = f(1 / k);
        if (mode === 1) kClipSoft(a, 0, sb.count, k); else kClipSharp(a, 0, sb.count, k);
      } else if (cnt > 0) {
        const k = f(1 / (t4 > TINY ? t4 : TINY));
        if (mode === 1) kClipSoftT(T, o, a, o, cnt, k); else kClipSharpT(T, o, a, o, cnt, k);
      }
      break;
    }
    case 3:
      if (flat) kClipGate(a, 0, sb.count, f(t4 * fl));
      else if (cnt > 0) kClipGateT(T, o, a, o, cnt, t4);
      break;
    default:
      if (flat) kClipSub(a, 0, sb.count, f(t4 * fl));
      else if (cnt > 0) kClipSubT(T, o, a, o, cnt, t4);
      break;
  }
  void ctx;
}

// ---------------------------------------------------------------- voice-render pieces

/**
 * Harmonic blur kernel (voice +0x200, 0xe2724..0xe29c0) for half width w and
 * control c: a triangle 1 - d |i - w| (d = 1 / (c / 2 + 1)), each side shaped by
 * the part's bottom / top tension (expm1(x ln e) / (e - 1), part+0x260..+0x26c);
 * returns the normalisation 1 / sum (+0x210).
 */
export function blurKernelShape(kern: Float32Array, w: number, c: number, part: PartDsp): number {
  const d = f(1 / f(f(c * 0.5) + 1));
  const off = f(1 - d * w);
  const H = part.hblur, tmp = W40;
  if (f32bits(H[0]) === f32bits(H[2])) {
    vectorSlope32f(kern, w + 1, off, d);
    if (f32bits(H[0]) !== 0) {
      mulC32f(kern, H[0], tmp, w);
      expm132f(tmp, kern, w);
      mulC32fI(H[1], kern, w);
    }
    flip32f(kern, kern, w, 0, w + 1);
  } else {
    vectorSlope32f(kern, 2 * w + 1, off, d);
    subCRev32fI(2, kern, w, w + 1);
    for (let j = 0; j < 2; j++) {
      const p = j ? w + 1 : 0;
      if (f32bits(H[2 * j]) !== 0) {
        mulC32f(kern, H[2 * j], tmp, w, p, 0);
        expm132f(tmp, kern, w, 0, p);
        mulC32fI(H[2 * j + 1], kern, w, p);
      }
    }
  }
  const sum = sum32f(kern, 2 * w + 1);
  return sum > TINY ? f(1 / sum) : 1;
}

/** Prism amount V+0xd0 from the prism control (0xe30b8..0xe3178): add mode 4 c |c|, multiply mode c clamped to [-1, 1]. */
export function prismAmount(pt: PartDsp, ctl: number): number {
  if (ctl === 0) return 0;
  if (pt.prismMode === 0) {
    const sg = f32bits(ctl) >>> 31 ? -1 : 1;
    return f(f(f(sg * ctl) * ctl) * 4);
  }
  return ctl < -1 ? -1 : ctl > 1 ? 1 : ctl;
}
