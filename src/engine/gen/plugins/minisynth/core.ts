// MiniSynth core (FL: MiniSynth, MiniSynth_x64.dylib, the FL Studio Mobile
// synth "MiniSynthInstance"): parameters, voice allocation (POLY / MONO /
// LEAD with slide), 99 voices, the LFO and the global effects, ported from
// FL's arm64 code (addresses in docs/research/gen/minisynth.md) in FL's
// precision: float32 where FL stores floats (Math.fround), double where FL
// computes in double. FL's float fused multiply-adds are exact here; its double
// ones are unfused by default (a difference below -150 dB, near zero crossings
// only) and exact with miniSynthExact(true) (research renders).
//
// FL renders in sub-blocks of at most 32 samples: per sub-block the LFO, then
// every active voice (index order 0..98: each voice's per-block controls, then
// its samples), then distortion, delay, phaser and chorus on the voice sum.
// All voices draw from FL's one global noise generator (a 32-bit LCG shared by
// every instance in the process), in that order: the noise, the oscillators'
// phase dither and the filter drift depend on it.

import { oscTables, TABLE_LEN } from './tables';

const f32 = Math.fround;
const F64 = new Float64Array(1);
const W32 = new Uint32Array(F64.buffer);
/**
 * Float fused multiply-add as FL's fmadd s: a * b + c rounded once to float. a * b is exact in double;
 * the double sum is rounded again only where it lands exactly halfway between two floats, then the
 * sum's rounding error decides (as a single rounding would).
 */
function fmaf(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  F64[0] = s;
  if ((W32[0] & 0x1fffffff) !== 0x10000000) return f32(s);
  const bb = s - p;
  const e = (p - (s - bb)) + (c - bb);
  if (e === 0) return f32(s);
  const d = Math.abs(s) * 9.094947017729282e-13; // 2^-40: past the midpoint, well inside the float step
  return f32(e > 0 ? s + d : s - d);
}

/**
 * FL's double fused multiply-adds (fmadd / fmsub / fmla d). By default computed as a * b + c (two
 * roundings): the difference to FL's single rounding stays below float resolution except near zero
 * crossings (1 ulp, about -150 dB) and costs a third of the CPU. miniSynthExact(true) emulates the single
 * rounding exactly (research: bit-exact renders against FL with FL's own oscillator data).
 */
let EXACT = false;
export function miniSynthExact(on?: boolean): boolean {
  if (on !== undefined) EXACT = on;
  return EXACT;
}
function fmad(a: number, b: number, c: number): number {
  if (!EXACT) return a * b + c;
  return fmaExact(a, b, c);
}
/** a * b + c rounded once (Dekker product, two-sum). */
function fmaExact(a: number, b: number, c: number): number {
  const p = a * b;
  let t = 134217729 * a;
  const ah = t - (t - a), al = a - ah;
  t = 134217729 * b;
  const bh = t - (t - b), bl = b - bh;
  const pe = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  const s = p + c;
  const bb = s - p;
  const se = (p - (s - bb)) + (c - bb);
  return s + (se + pe);
}

// ---------------------------------------------------------------- the platform's exp10f
/** 2^(j / 128), j = 0..127. */
const POW2_128 = new Float64Array(128);
for (let j = 0; j < 128; j++) POW2_128[j] = Math.pow(2, j / 128);
/**
 * exp10f as FL's macOS build gets it from the system math library (libsystem_m __exp10f, arm64): a
 * 128-entry 2^(j/128) table and a quadratic, rounded to float. Its results differ from the correctly
 * rounded 10^x in about 0.6 % of inputs, so FL's distortion needs this exact algorithm.
 */
function exp10f(x: number): number {
  if (!(Math.abs(x) < 64)) return x > 0 ? Infinity : x < 0 ? 0 : x;
  const d = x * 425.20679614558236;
  const r = d < 0 ? -Math.round(-d) : Math.round(d);
  const f = d - r;
  const scale = POW2_128[r & 127] * Math.pow(2, (r - (r & 127)) / 128);
  const p = fmaExact(1.4662262378543872e-5, f, 0.005415217308896754) * f;
  return f32(fmaExact(p, scale, scale));
}

// ---------------------------------------------------------------- FL's global noise generator
const LCG_A = 0x0bb38435;
const LCG_C = 0x3619636b;
/** FL's static seed (MiniSynth_x64 0x5509c), zero at load, shared by all instances like FL's. */
let SEED = 0;
const lcg = (s: number): number => (Math.imul(s, LCG_A) + LCG_C) >>> 0;
/** FL's noise scale 2^-31 (1 + 2^-32) (0x3e00000000100000). */
const INV31 = 4.656612874161595e-10;
/** Read / set FL's global noise seed (tests reproduce a fresh FL process). */
export function miniSynthSeed(v?: number): number {
  if (v !== undefined) SEED = v >>> 0;
  return SEED;
}

// ---------------------------------------------------------------- constants (FL's literals)
const F_1E5 = 9.999999747378752e-6; // 1e-5f
const F_001 = 0.009999999776482582; // 0.01f
const F_008 = 0.07999999821186066; // 0.08f
const F_0005 = 0.004999999888241291; // 0.005f
const F_12TH = 0.0833333358168602; // 1/12 f
const F_DETUNE = 0.006250000558793545; // 0x3bccccce
const D_12TH = 0.08333333333333333;
const IN_SCALE = 0.20000000298023224; // 0.2f as double
const IN_OFS = 0.06999999985098837; // 0.35 * 0.2f
const OUT_SCALE = 4.999999925494195; // 1 / 0.2f
const U32 = 4294967295.0;
const CUT_DIV = 655.36; // 0x40847ae147ae147b
const RES_K = -4.050000190734863;
const D_0005F = 0.004999999888241291;
const ENV_A = 4.0000000000000003e-7;
const ENV_D = 4e-6;
const THR_D = 0.001;
const THR_F = 0.0010000000474974513;
/** LFO / phaser rates in beats (12 steps of the Rate selectors). */
const RATES = [0.25, 0.375, 0.5, 0.75, 1, 2, 4, 8, 16, 64, 128, 256];

/** Number of voices (FL: 99, constructor 0x351a8). */
export const MS_VOICES = 99;

/** FL's envelope rate (setParam 0x363e0): 1 at 0, else c / (0.95 v + 0.05)^4 unless (..)^4 * mul < 0.001. */
function envCoef(v: number, mul: number, c: number): number {
  if (v < THR_F) return 1;
  let d = v * 0.95 + 0.05;
  d *= d; d *= d;
  if (d * mul < THR_D) return 1;
  return f32(c / d);
}

/** AMP Rel (setParam 0x36920): FL maps the knob through 0.95 v + 0.05 twice, then x10. */
function ampRelCoef(v: number): number {
  let d = v * 0.95 + 0.05;
  if (d < THR_F) return 10;
  d = d * 0.95 + 0.05;
  d *= d; d *= d;
  if (d * 50 < THR_D) return 10;
  return f32(f32(ENV_D / d) * 10);
}

/** FL's float-saturating uint32 conversion (fcvtzu). */
function u32(x: number): number {
  if (!(x > 0)) return 0;
  return x >= 4294967295 ? 4294967295 : Math.trunc(x) >>> 0;
}

// ---------------------------------------------------------------- voice
export class MsVoice {
  /** Key 0..127, -1 = free (FL: int8 at +0x4c). */
  key = -1;
  vel = 0;
  /** Allocation counter (+0x44) and slide position in semitones (+0x48). */
  age = 0;
  slide = 0;
  readonly phase = new Uint32Array(8);
  readonly inc = new Uint32Array(8);
  readonly gain = new Float32Array(8);
  /** Oscillator frequencies of the current sub-block (Hz). */
  private readonly fr = new Float64Array(8);
  nOsc = 0;
  /** Offset of oscillator 0's table: every oscillator reads it (FL). */
  tab = 0;
  /** Filter states (doubles, +0x110..+0x128) and the 4 x 5 state matrix, column-major m[r + 4c]. */
  s0 = 0; s1 = 0; s2 = 0; s3 = 0;
  readonly m = new Float64Array(20);
  /** Filter / amp envelopes: value, target, rate (floats, +0x1d0..+0x1e4). */
  fe = 0; feT = 0; feC = 0;
  ae = 0; aeT = 0; aeC = 0;
  pitch = 0; freq = 0;
  /** DC tracker (+0x200), gain targets (+0x204) and smoothed gains (+0x20c), drift (+0x214). */
  dc = 0; tL = 0; tR = 0; gL = 0; gR = 0; drift = 0;
  released = false;
  sr = 44100;

  constructor(private readonly syn: MsCore) {}

  /** FL's voice reset (0x2564c): new random oscillator phases from the global seed, voice freed. */
  reset(sr: number): void {
    if (sr !== 0) this.sr = sr;
    let s = SEED;
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 256; i++) s = lcg(s);
      this.phase[j] = s;
    }
    SEED = s;
    this.key = -1;
    this.vel = 0;
    this.s0 = this.s1 = this.s2 = this.s3 = 0;
    this.fe = 0;
    this.ae = 0;
    this.released = true;
    this.gL = -1;
    this.gR = -1;
  }

  /** FL's voice note on (0x2575c): retrigger the envelopes unless legato on a held voice. */
  noteOn(key: number, vel: number, legato: boolean): void {
    this.key = key;
    this.vel = vel;
    if (!legato || this.released) {
      const c = this.syn;
      this.fe = 0;
      this.feT = 4;
      this.feC = c.egfAtk;
      this.aeT = 4;
      this.aeC = c.ampAtk;
    }
    this.released = false;
  }

  /** FL's voice release (0x257a0). */
  release(): void {
    const c = this.syn;
    this.released = true;
    this.feT = 0;
    this.feC = c.egfRel;
    this.aeT = 0;
    this.aeC = c.ampRel;
  }

  /** Per sub-block controls (0x2607c): gains, drift, slide, pitch, oscillators, filter. false = voice ended. */
  private perBlock(): boolean {
    const c = this.syn;
    let s0 = this.vel;
    if (this.ae < F_1E5 && this.aeT === 0) s0 = 0;
    const k = this.key;
    this.tL = f32(c.keyL[k] * s0);
    this.tR = f32(c.keyR[k] * s0);
    if (this.gL < 0) this.gL = this.tL;
    if (this.gR < 0) this.gR = this.tR;
    if (this.released && s0 === 0 && this.gL < F_1E5 && this.gR < F_1E5) {
      this.reset(0);
      return false;
    }
    const nz = f32(SEED * INV31 - 1);
    SEED = lcg(SEED);
    this.drift = fmaf(f32(nz - this.drift), F_001, this.drift);
    this.slide = fmaf(f32(k - this.slide), c.slideCoef, this.slide);
    const p0 = fmaf(this.drift, F_008, f32(this.slide + c.transpose));
    let d = p0 + c.bend;
    if (c.lfoDest === 1) d += f32(c.lfo * 12);
    d += c.keyPitch[k];
    this.pitch = d;
    this.freq = Math.pow(2, fmad(d, D_12TH, -4.75)) * 220;
    this.oscSetup();
    this.filterSetup();
    return true;
  }

  /** Oscillator setup per kind (0x25be4). */
  private oscSetup(): void {
    const c = this.syn;
    const ph = this.phase, gn = this.gain;
    let m = c.oscMod;
    if (c.lfoDest === 2) m = fmaf(c.lfo, 12, m);
    let t = f32(m + -1);
    t = f32(m + t);
    const semis = Math.trunc(t * 12);
    const ratio = f32(Math.pow(2, fmaf(f32(semis), F_12TH, F_DETUNE)));
    const f = this.freq;
    const fr = this.fr;
    this.nOsc = 0;
    switch (c.oscKind) {
      case 0: { // SAW: saw(p) - saw(p + d) + saw(p), d = (1 - |mod|) of a cycle
        this.nOsc = 3;
        fr[0] = f; fr[1] = f; fr[2] = f;
        gn[0] = 1; gn[1] = -1; gn[2] = 1;
        const d = u32(f32(1 - Math.abs(m)) * U32);
        ph[1] = (ph[0] + d) >>> 0;
        ph[2] = ph[0];
        if (d === 0) this.nOsc = 1;
        break;
      }
      case 1: // SAW+SAW: second saw transposed by trunc((2 mod - 1) * 12) semitones + 0.075
        this.nOsc = 2;
        fr[0] = f; fr[1] = f * ratio;
        gn[0] = 1; gn[1] = 1;
        break;
      case 2: { // PULSE: saw(p) - saw(p + (1 - |mod|))
        this.nOsc = 2;
        fr[0] = f; fr[1] = f;
        gn[0] = 1; gn[1] = -1;
        ph[1] = (ph[0] + u32(f32(1 - Math.abs(m)) * U32)) >>> 0;
        break;
      }
      case 3: // SQR+SAW: square + transposed saw
        this.nOsc = 3;
        fr[0] = f; fr[1] = f; fr[2] = f * ratio;
        gn[0] = 1; gn[1] = -1; gn[2] = 1;
        ph[1] = (ph[0] + 0x7fffffff) >>> 0;
        break;
      case 4: // SQR+SQR: two 56 % pulses, the second transposed
        this.nOsc = 4;
        fr[0] = f; fr[1] = f; fr[2] = f * ratio; fr[3] = fr[2];
        gn[0] = 1; gn[1] = -1; gn[2] = 1; gn[3] = -1;
        ph[1] = (ph[0] + 0x8fffffff) >>> 0;
        ph[3] = (ph[2] + 0x8fffffff) >>> 0;
        break;
      case 5: { // SUPERSAW: 8 saws detuned by mod x {-5, -3.75, -2.5, -1.25, 0, 1.25, 2.5, 3.75} %
        this.nOsc = 8;
        const md = m;
        fr[0] = fmad(-0.05 * md, f, f);
        fr[1] = fmad(-0.037500000000000006 * md, f, f);
        fr[2] = fmad(-0.025 * md, f, f);
        fr[3] = fmad(-0.0125 * md, f, f);
        fr[4] = f;
        fr[5] = fmad(0.0125 * md, f, f);
        fr[6] = fmad(0.025 * md, f, f);
        fr[7] = fmad(md * 0.037500000000000006, f, f);
        for (let j = 0; j < 8; j++) gn[j] = 0.5;
        break;
      }
      case 6: { // BELL: 6 saws at phase offsets of |mod| / 2 cycle
        this.nOsc = 6;
        const d = u32(Math.abs(m * 0.5) * U32);
        let o = 0;
        const p0 = ph[0];
        for (let j = 0; j < 6; j++) {
          fr[j] = f;
          gn[j] = 0.5;
          ph[j] = (o + p0) >>> 0;
          o = (o + d) >>> 0;
        }
        break;
      }
      case 7: // DEAF SAW: saw(p) + saw(p + (1 - |mod|))
        this.nOsc = 2;
        fr[0] = f; fr[1] = f;
        gn[0] = 1; gn[1] = 1;
        ph[1] = (ph[0] + u32(f32(1 - Math.abs(m)) * U32)) >>> 0;
        break;
      case 8: // SAW SPREAD: octave below (detuned by mod), note, octave above
        this.nOsc = 3;
        fr[0] = fmad(m, -0.005, 0.5) * f; fr[1] = f; fr[2] = fmad(m, 0.02, 2) * f;
        gn[0] = 1; gn[1] = 1; gn[2] = 1;
        break;
      case 9: // SAW SPREAD 2: fifth below the octave, note, octave above
        this.nOsc = 3;
        fr[0] = fmad(m, -0.015, 1.5) * f; fr[1] = f; fr[2] = fmad(m, 0.02, 2) * f;
        gn[0] = 1; gn[1] = 1; gn[2] = 1;
        break;
      default:
        return;
    }
    // increments and oscillator 0's table (harmonics up to sr / 2f)
    const srf = f32(this.sr);
    const lim = f32(srf * 0.00048828125);
    const isr = 1 / this.sr;
    for (let j = 0; j < this.nOsc; j++) {
      const fj = fr[j];
      this.inc[j] = u32(fj * U32 * isr);
      if (j === 0) {
        const fs = f32(fj);
        let t2 = 0;
        if (lim < fs) {
          t2 = 1023 - Math.trunc(srf / (fs + fs));
          if (t2 < 0) t2 = 0;
          if (t2 > 1023) t2 = 1023;
        }
        this.tab = t2 * TABLE_LEN;
      }
    }
  }

  /** Filter cutoff / resonance and the per-sample state matrix (0x257c8). */
  private filterSetup(): void {
    const c = this.syn;
    let d0 = fmad(this.drift, 0.01, c.fltFreq);
    d0 = fmad(d0, 10.3, 4.0);
    d0 = fmad(fmad(this.pitch, D_12TH, -4.0), c.fltKbd, d0);
    d0 = fmad(c.fltVel * 14, this.vel + -0.5, d0);
    if (c.lfoDest === 0) d0 = fmad(c.lfo, 4.0, d0);
    if (c.mwDest === 0) d0 = fmad(f32(c.mwAmt * c.modWheel), 4.0, d0);
    const k = this.key;
    const d8 = d0 + c.keyFcut[k];
    const base = Math.pow(2, d8);
    let res = c.keyFres[k] + c.fltPeak;
    res = res > 0 ? (res < 1 ? res : 1) : 0;
    const top = Math.pow(2, fmad(c.egfAmt, 10.0, d8));
    let cut = fmad(top - base, this.fe, base);
    if (cut > 20000) cut = 20000;
    let g = cut / (this.sr * CUT_DIV);
    g = g > 0 ? (g < 1 ? g : 1) : 0;
    const d17 = 1 - g;
    const kk = res * RES_K;
    // FL's fine-step ladder (4 one-pole stages, cascade, feedback k): column-major registers
    let d26 = kk * g;
    let d1 = fmad(-g, g, g);
    let d23 = d26 * g;
    let d21 = g * g;
    let d4 = d1 * g;
    let d18 = d23 * g;
    let d20 = d21 * g;
    let d2 = d4 * g;
    let sp38 = fmad(d18, g, d17);
    let d3 = d20 * g;
    let d29 = 0, d16 = d1, d25 = d17, d30 = 0, d7 = d4, d22 = d1, d31 = d17, d10 = 0;
    let d6 = g, d17r = d17;
    let d0r = 0, d5 = 0, d8r = 0, d9 = 0, d11 = 0, d12 = 0, d13 = 0, d14 = 0, d15 = 0, d19 = 0, d24 = 0, d27 = 0, d28 = 0;
    let sp8 = 0, sp10 = 0, sp18 = 0, sp20 = 0, sp28 = 0, sp30 = 0;
    // 12 squarings of the augmented matrix [A | B] -> A^4096 (FL's loop 0x259bc, its operation order)
    for (let it = 0; it < 12; it++) {
      d24 = d2;
      d27 = d4;
      d14 = d30 * d22;
      d8r = fmad(d31, d31, d14);
      d0r = d29 * d7;
      sp28 = d0r; sp30 = d20;
      d9 = d8r + d0r;
      d8r = d25 + d31;
      d11 = d29 * d31;
      d12 = d26 * d31;
      d13 = d6 * d31;
      d0r = d7 * d31;
      sp8 = d0r;
      d15 = d2 * d31;
      d0r = fmad(d26, d2, d9);
      sp18 = d0r;
      d9 = d16 * d29;
      d9 = fmad(d8r, d30, d9);
      d11 = fmad(d10, d30, d11);
      d12 = fmad(d23, d30, d12);
      d13 = fmad(d21, d30, d13);
      d5 = d30 * d7;
      d28 = d30 * d2;
      d0r = fmad(d4, d26, d9);
      sp20 = d0r;
      d9 = fmad(d17r, d29, d11);
      d11 = fmad(d18, d29, d12);
      d12 = fmad(d20, d29, d13);
      d13 = d29 * d22;
      d19 = d29 * d2;
      d0r = fmad(d1, d26, d9);
      sp10 = d0r;
      d9 = fmad(d3, d26, d12);
      d12 = d10 * d7;
      d8r = fmad(d8r, d22, d12);
      d12 = fmad(d25, d25, d14);
      d13 = fmad(d10, d25, d13);
      d14 = d26 * d22;
      d14 = fmad(d23, d25, d14);
      d0r = sp8;
      d31 = fmad(d16, d22, d0r);
      d15 = fmad(d4, d22, d15);
      d22 = d6 * d22;
      d29 = d6;
      d0r = fmad(d21, d25, d22);
      d30 = fmad(d25, d16, d5);
      d28 = fmad(d25, d4, d28);
      d6 = d26 * d7;
      d5 = d3;
      d3 = sp38;
      d22 = fmad(d3, d26, d11);
      sp8 = d22;
      d26 = d26 * d2;
      d22 = fmad(d23, d2, d8r);
      d8r = fmad(d17r, d10, d13);
      d13 = fmad(d18, d10, d14);
      d0r = fmad(d20, d10, d0r);
      d11 = d20;
      d19 = fmad(d10, d4, d19);
      d14 = d16 * d10;
      d25 = d12 + d14;
      d25 = fmad(d4, d23, d25);
      d10 = fmad(d1, d23, d8r);
      d20 = fmad(d5, d23, d0r);
      d12 = fmad(d23, d16, d6);
      d26 = fmad(d23, d4, d26);
      d23 = fmad(d3, d23, d13);
      d6 = d29 * d2;
      d27 = fmad(d21, d4, d6);
      d6 = d9 + d29;
      d24 = d29 * d7;
      d24 = fmad(d21, d16, d24);
      d21 = d20 + d21;
      d0r = sp28;
      d20 = d14 + d0r;
      d8r = d1;
      d0r = fmad(d17r, d7, d31);
      d9 = fmad(d1, d7, d15);
      d30 = fmad(d16, d17r, d30);
      d28 = fmad(d16, d1, d28);
      d20 = fmad(d17r, d17r, d20);
      d29 = fmad(d18, d17r, d12);
      d24 = fmad(d11, d17r, d24);
      d19 = fmad(d17r, d1, d19);
      d27 = fmad(d11, d1, d27);
      d26 = fmad(d18, d1, d26);
      d7 = fmad(d18, d2, d0r);
      d16 = fmad(d4, d18, d30);
      d31 = sp18; d30 = sp20;
      d17r = fmad(d1, d18, d20);
      d20 = sp30;
      d0r = fmad(d5, d18, d24);
      d18 = fmad(d3, d18, d29);
      d20 = d0r + d20;
      d0r = d3;
      d2 = fmad(d3, d2, d9);
      d4 = fmad(d4, d3, d28);
      d1 = fmad(d1, d3, d19);
      d3 = fmad(d3, d3, d26);
      d26 = sp8; d29 = sp10;
      sp38 = d3;
      d3 = d5;
      d0r = fmad(d5, d0r, d27);
      d3 = d0r + d5;
    }
    void d8r; void d24;
    const M = this.m;
    // column 0..4, rows 0..3 (FL's stores at +0x130..+0x1c8)
    M[0] = d31; M[1] = d22; M[2] = d7; M[3] = d2;
    M[4] = d30; M[5] = d25; M[6] = d16; M[7] = d4;
    M[8] = d29; M[9] = d10; M[10] = d17r; M[11] = d1;
    M[12] = d26; M[13] = d23; M[14] = d18; M[15] = sp38;
    M[16] = d6; M[17] = d21; M[18] = d20; M[19] = d3;
  }

  /** Render n samples into L / R at offset o (FL's voice render 0x26280). */
  render(L: Float32Array, R: Float32Array, o: number, n: number): void {
    if (!this.perBlock()) return;
    if (this.key < 0 || n === 0) return;
    const c = this.syn;
    const T = c.tables;
    const tab = this.tab;
    const ph = this.phase, inc = this.inc, gn = this.gain;
    const nOsc = this.nOsc;
    const noiseAmt = c.oscNoise;
    const M = this.m;
    const m00 = M[0], m10 = M[1], m20 = M[2], m30 = M[3];
    const m01 = M[4], m11 = M[5], m21 = M[6], m31 = M[7];
    const m02 = M[8], m12 = M[9], m22 = M[10], m32 = M[11];
    const m03 = M[12], m13 = M[13], m23 = M[14], m33 = M[15];
    const m04 = M[16], m14 = M[17], m24 = M[18], m34 = M[19];
    let s0 = this.s0, s1 = this.s1, s2 = this.s2, s3 = this.s3;
    let fe = this.fe, feT = this.feT, feC = this.feC;
    let ae = this.ae, aeT = this.aeT, aeC = this.aeC;
    let dc = this.dc, gL = this.gL, gR = this.gR;
    const tL = this.tL, tR = this.tR;
    let seed = SEED;
    for (let i = 0; i < n; i++) {
      // noise and oscillators (phase dithered by the seed's low 22 bits)
      const nzD = fmad(seed, INV31, -1);
      seed = lcg(seed);
      const dith = seed & 0x3fffff;
      let sum = 0;
      for (let j = 0; j < nOsc; j++) {
        const p = ph[j];
        sum += f32(gn[j] * T[tab + (((dith + p) >>> 0) >>> 21)]);
        ph[j] = (p + inc[j]) >>> 0;
      }
      const inp = sum + f32(noiseAmt * f32(nzD));
      const x = fmad(inp, IN_SCALE, IN_OFS) * ae;
      // ladder outputs from the current states
      const r0 = fmad(m04, x, fmad(m03, s3, fmad(m02, s2, fmad(m01, s1, m00 * s0))));
      const r3 = fmad(m33, s3, fmad(m32, s2, fmad(m31, s1, m30 * s0)));
      const out = r3 + m34 * x;
      const o5 = OUT_SCALE * out;
      dc = f32(fmad(o5 - dc, D_0005F, dc));
      // envelopes (per sample) and gain smoothing
      fe = fmaf(f32(feT - fe), feC, fe);
      ae = fmaf(f32(aeT - ae), aeC, ae);
      gL = fmaf(f32(tL - gL), F_0005, gL);
      gR = fmaf(f32(tR - gR), F_0005, gR);
      if (fe > 1) { fe = 1; feT = c.egfSus; feC = c.egfDec; }
      if (ae > 1) { ae = 1; aeT = c.ampSus; aeC = c.ampDec; }
      // state update: S0 saturates (x / (1 + x^2))
      const n1 = fmad(m14, x, fmad(m13, s3, fmad(m12, s2, fmad(m11, s1, m10 * s0))));
      const n2 = fmad(m24, x, fmad(m23, s3, fmad(m22, s2, fmad(m21, s1, m20 * s0))));
      s0 = r0 / (1 + r0 * r0);
      s1 = n1;
      s2 = n2;
      s3 = out;
      const y = o5 - dc;
      L[o + i] = f32(fmad(y, gL, L[o + i]));
      R[o + i] = f32(fmad(y, gR, R[o + i]));
    }
    SEED = seed;
    this.s0 = s0; this.s1 = s1; this.s2 = s2; this.s3 = s3;
    this.fe = fe; this.feT = feT; this.feC = feC;
    this.ae = ae; this.aeT = aeT; this.aeC = aeC;
    this.dc = dc; this.gL = gL; this.gR = gR;
  }
}

// ---------------------------------------------------------------- the synth (MiniSynthInstance)
export class MsCore {
  readonly sr: number;
  readonly tables: Float32Array;
  readonly voices: MsVoice[] = [];
  /** Raw parameters 0..42 (floats 0..1, FL's +0x4010). */
  readonly p = new Float32Array(43);

  // derived parameters (FL's setParam 0x36290)
  poly = true; legato = false;
  transpose = 0; slideCoef = 0; mwDest = 0; mwAmt = 0;
  oscKind = 0; oscMod = 0; oscNoise = 0;
  fltFreq = 0; fltPeak = 0; fltKbd = 0; fltVel = 0;
  egfAtk = 1; egfDec = 1; egfSus = 0; egfRel = 1; egfAmt = 0;
  lfoShape = 0; lfoDest = 0; lfoRate = 0.25; lfoAmt = 0;
  ampAtk = 1; ampDec = 1; ampSus = 0; ampRel = 1;
  delayOn = false; delayChanged = true; delayTime = 0.25;
  chorusOn = false; chorusChanged = true;
  phaserOn = false; phaserChanged = true; phaserRate = 0.25;

  /** Mod wheel 0..1 (MIDI CC 1) and pitch bend in semitones (FL: from MIDI only, 0 here). */
  modWheel = 0;
  bend = 0;
  /**
   * Max polyphony in POLY mode (FL: FPE_MaxPoly, 0 = 99). The synth plays nothing in POLY mode until the
   * host sends it; FL sends the channel's polyphony, 8 for this plugin (TFruityPlugInfo.DefPoly).
   */
  maxPoly = 8;
  /** LFO output and phase (cycles). */
  lfo = 0;
  lfoPhase = 0;
  /** Song position in beats, tempo, transport sync (FL's +0xc30, +0xc28, +0x39b4). */
  pos = 0;
  tempo = 130;
  sync = false;

  /** Per-key levels from FL's voice levels (wrapper): gains L / R, pitch offset (semitones), Mod X / Y. */
  readonly keyL = new Float32Array(128);
  readonly keyR = new Float32Array(128);
  readonly keyPitch = new Float32Array(128);
  readonly keyFcut = new Float32Array(128);
  readonly keyFres = new Float32Array(128);
  /** Held keys' velocities (+0x3adc), the MIDI note-on velocities (+0x1068), keys rendered this call (+0xa20). */
  readonly keyVel = new Float32Array(128);
  readonly velIn = new Float32Array(128);
  readonly active = new Uint8Array(128);
  lastKey = 0;
  ageCounter = 1;

  /** The synth's sub-block output buffers (FL renders voices and effects there, then adds them to the host buffer). */
  private readonly bufL = new Float32Array(32);
  private readonly bufR = new Float32Array(32);
  // effects state
  private readonly delayBuf: Float32Array;
  private delayIdx = 0;
  private delayLp = 0;
  private readonly chorusBuf: Float32Array;
  private chorusIdx = 0;
  private chPhL = 0.6200000047683716;
  private chPhR = 0.10000000149011612;
  private readonly phs = new Float32Array(15);
  private phSmooth = -1;
  private decCount = 0;
  private decL = 0;
  private decR = 0;
  /** Effects idle counter (+0x40bc): -1 until a voice has played. */
  private fxCount = -1;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.tables = oscTables();
    for (let i = 0; i < MS_VOICES; i++) {
      const v = new MsVoice(this);
      this.voices.push(v);
      v.reset(0); // FL's voice constructor
    }
    this.delayBuf = new Float32Array(Math.max(1, Math.trunc(sampleRate * 1.5)));
    this.chorusBuf = new Float32Array(Math.max(1, Math.trunc(sampleRate * 0.01)));
    for (let i = 0; i < 43; i++) this.setParam(i, 0);
  }

  /** FL's setSampleRate (0x36ecc): clears held keys, resets the LFO and every voice. */
  resetAll(): void {
    this.keyVel.fill(0);
    this.lfoPhase = 0;
    const sr = f32(this.sr);
    for (const v of this.voices) v.reset(sr);
    this.fxCount = -1;
    this.delayChanged = true;
    this.chorusChanged = true;
    this.phaserChanged = true;
    this.decCount = 0;
    this.decL = 0;
    this.decR = 0;
  }

  setParam(i: number, value: number): void {
    const v = f32(value > 0 ? (value < 1 ? value : 1) : 0);
    this.p[i] = v;
    switch (i) {
      case 0: {
        const m = Math.trunc(f32(v * 2));
        if (m === 0) { this.poly = true; this.legato = false; }
        else if (m === 1) { this.poly = false; this.legato = false; }
        else if (m === 2) { this.poly = false; this.legato = true; }
        break;
      }
      case 1: this.transpose = Math.trunc(fmaf(v, 24, -12)); break;
      case 2: {
        const a = f32(1 - v);
        let s = f32(a - v * a);
        s = f32(s * s);
        this.slideCoef = f32(s * 0.9 + 0.01);
        break;
      }
      case 3: this.mwDest = Math.trunc(v); break;
      case 4: this.mwAmt = v; break;
      case 5: this.oscKind = Math.trunc(f32(v * 9)); break;
      case 6: this.oscMod = v; break;
      case 7: this.oscNoise = f32(v * v); break;
      case 8: this.fltFreq = v; break;
      case 9: this.fltPeak = f32(v * 0.9900000095367432); break;
      case 10: this.fltKbd = v; break;
      case 11: this.fltVel = v; break;
      case 12: this.egfAtk = envCoef(v, 500, ENV_A); break;
      case 13: this.egfDec = envCoef(v, 50, ENV_D); break;
      case 14: this.egfSus = v; break;
      case 15: this.egfRel = envCoef(v, 50, ENV_D); break;
      case 16: this.egfAmt = f32(f32(v + v) + -1); break;
      case 17: this.lfoShape = Math.trunc(f32(v + v)); break;
      case 18: this.lfoDest = Math.trunc(f32(v + v)); break;
      case 19: { const k = Math.trunc(f32(v * 11)); if (k <= 11) this.lfoRate = RATES[k]; break; }
      case 20: this.lfoAmt = f32(f32(v + v) + -1); break;
      case 21: this.ampAtk = envCoef(v, 500, ENV_A); break;
      case 22: this.ampDec = envCoef(v, 50, ENV_D); break;
      case 23: this.ampSus = v; break;
      case 24: this.ampRel = ampRelCoef(v); break;
      case 28: { const on = v !== 0; if (on !== this.delayOn) this.delayChanged = true; this.delayOn = on; break; }
      case 29: this.delayTime = Math.trunc(f32(v * 3)) * 0.25 + 0.25; break;
      case 33: { const on = v !== 0; if (on !== this.chorusOn) this.chorusChanged = true; this.chorusOn = on; break; }
      case 37: { const on = v !== 0; if (on !== this.phaserOn) this.phaserChanged = true; this.phaserOn = on; break; }
      case 38: { const k = Math.trunc(f32(v * 11)); if (k <= 11) this.phaserRate = RATES[k]; break; }
      default: break;
    }
  }

  /** FL's note handler (0x36c40): vel 0 = note off. */
  note(key: number, velocity: number): void {
    if (key < 0 || key > 127) return;
    const vel = f32(velocity > 0 ? (velocity < 1 ? velocity : 1) : 0);
    this.keyVel[key] = vel;
    const V = this.voices;
    if (vel === 0) {
      for (let i = 0; i < MS_VOICES; i++) {
        const v = V[i];
        if (v.key !== key) continue;
        if (this.poly || !this.legato) { v.release(); continue; }
        // LEAD: hand the voice to the nearest held key (highest below, else lowest above)
        let below = -1, bv = 0;
        for (let k = 0; k < key; k++) if (this.keyVel[k] !== 0) { below = k; bv = this.keyVel[k]; }
        let above = -1, av = 0;
        if (key !== 127) for (let k = 127; k > key; k--) if (this.keyVel[k] !== 0) { above = k; av = this.keyVel[k]; }
        if (bv !== 0) { v.key = below; v.vel = bv; this.lastKey = below; }
        else if (key !== 127 && av !== 0) { v.key = above; v.vel = av; this.lastKey = above; }
        else v.release();
      }
      return;
    }
    let v: MsVoice | null = null;
    if (!this.poly) v = V[0];
    else {
      const n = Math.min(this.maxPoly, 99);
      if (n < 1) return;
      for (let i = 0; i < n; i++) if (V[i].key < 0) v = V[i];
      if (!v) {
        let min = 0xffffffff;
        for (let i = 0; i < n; i++) {
          const a = V[i].age >>> 0;
          if (a <= min) { v = V[i]; min = a; }
        }
      }
      if (!v) return;
    }
    this.ageCounter = (this.ageCounter + 1) | 0;
    v.age = this.ageCounter;
    v.slide = f32(this.lastKey);
    if (this.legato) {
      let other = false;
      for (let k = 0; k < 128; k++) if (this.keyVel[k] !== 0 && k !== key) { other = true; break; }
      if (!other) v.slide = key;
    }
    v.noteOn(key, vel, this.legato);
    this.lastKey = key;
  }

  /** FL's process (0x37c80): adds n samples into L / R at offset o, in sub-blocks of 32. */
  process(L: Float32Array, R: Float32Array, o: number, n: number): void {
    const bL = this.bufL, bR = this.bufR;
    const sr = this.sr;
    const tempo = this.tempo;
    let pos = this.pos;
    this.active.fill(0);
    const limit = Math.trunc(sr * 0.5);
    const beatsPerSample = tempo * 0.016666666666666666;
    let ran = false;
    let off = o;
    let rem = n;
    while (rem > 0) {
      const m = rem < 32 ? rem : 32;
      rem -= m;
      bL.fill(0, 0, m);
      bR.fill(0, 0, m);
      // LFO (value from the current phase, then the phase moves)
      switch (this.lfoShape) {
        case 0: this.lfo = f32(Math.sin(this.lfoPhase * 6.283185307179586)); break;
        case 1: this.lfo = f32(1 - (this.lfoPhase + this.lfoPhase)); break;
        case 2: this.lfo = f32(f32(this.lfoPhase < 0.5 ? 2 : 0) + -1); break;
        default: break;
      }
      const a0 = this.lfoAmt;
      let a1 = a0;
      if (this.mwDest === 1) a1 = fmaf(this.mwAmt, this.modWheel, a0);
      if (a0 > 1) a1 = 1;
      if (a0 < -1) a1 = -1;
      a1 = f32(a1 * a1);
      this.lfo = a0 < 0 ? f32(-(a1 * this.lfo)) : f32(a1 * this.lfo);
      let ph: number;
      if (this.sync) ph = pos / this.lfoRate;
      else ph = (tempo * m) / (this.lfoRate * 60 * sr) + this.lfoPhase;
      this.lfoPhase = ph - Math.trunc(ph);
      const dpos = (beatsPerSample * m) / sr;
      // voices
      let any = false;
      const V = this.voices;
      for (let i = 0; i < MS_VOICES; i++) {
        const v = V[i];
        if (v.key < 0) continue;
        any = true;
        this.active[v.key] = 1;
        v.render(bL, bR, 0, m);
      }
      pos += dpos;
      // FL's effects gate: skipped until a voice has played (counter -1); see the note
      let fx: boolean;
      if (any || ran) { this.fxCount = 0; fx = true; }
      else if (this.fxCount === -1) fx = false;
      else { this.fxCount += m; fx = this.fxCount < limit; }
      if (fx) {
        this.dist(bL, bR, 0, m);
        this.delay(bL, bR, 0, m);
        this.phaser(bL, bR, 0, m, pos);
        this.chorus(bL, bR, 0, m);
        ran = true;
      } else ran = false;
      for (let i = 0; i < m; i++) { L[off + i] += bL[i]; R[off + i] += bR[i]; }
      off += m;
    }
    this.pos = pos;
  }

  /** Whether any voice sounds. */
  voicesActive(): boolean {
    for (const v of this.voices) if (v.key >= 0) return true;
    return false;
  }

  // ------------------------------------------------------------ effects
  /** DIST (0x375b8): exponential soft clipper, Overdrive = drive, Decimator = sample hold. */
  private dist(L: Float32Array, R: Float32Array, o: number, n: number): void {
    const p = this.p;
    if (p[25] === 0) return;
    const od = p[26];
    const s1 = f32(od * od);
    const pos = f32(s1 * 20);
    let dec2 = f32(p[27] * p[27]);
    if (dec2 > 1) dec2 = 1;
    const hold = Math.trunc(dec2 * 64);
    let gg = f32(pos * -0.0625 + 1);
    gg = f32(gg * gg); gg = f32(gg * gg); gg = f32(gg * gg);
    const gain = f32(fmad(gg, 0.7, 0.3));
    const neg = f32(s1 * -20);
    for (let i = 0; i < n; i++) {
      const xl = L[o + i], xr = R[o + i];
      let yl: number, yr: number;
      if (xl >= 0) { const e = exp10f(f32(neg * xl)); yl = fmad(xl, e, -e) + 1; }
      else { const e = exp10f(f32(xl * pos)); yl = fmad(xl, e, e) + -1; }
      if (xr >= 0) { const e = exp10f(f32(neg * xr)); yr = fmad(xr, e, -e) + 1; }
      else { const e = exp10f(f32(xr * pos)); yr = fmad(xr, e, e) + -1; }
      let ol = f32(yl * gain), or = f32(yr * gain);
      if (hold !== 0) {
        const c = this.decCount;
        if (c < 1) { this.decL = ol; this.decR = or; this.decCount = Math.trunc(f32(c + hold) + -1); }
        else { ol = this.decL; or = this.decR; this.decCount = Math.trunc(f32(c) + -1); }
      }
      L[o + i] = ol;
      R[o + i] = or;
    }
  }

  /** DELAY (0x37a64): mono tempo-synced echo with a lowpassed feedback. */
  private delay(L: Float32Array, R: Float32Array, o: number, n: number): void {
    if (!this.delayOn) return;
    const buf = this.delayBuf;
    const size = buf.length;
    if (this.delayChanged) {
      this.delayChanged = false;
      buf.fill(0);
      this.delayIdx = 0;
      this.delayLp = 0;
    }
    const p = this.p;
    const filt = p[31], fb = p[30], mixRaw = p[32];
    let t = (this.delayTime * 40) / this.tempo;
    while (t > 1) t *= 0.5;
    let len = Math.trunc(t * (size - 1));
    if (!(len > 1)) len = 1;
    if (len > size) len = size;
    if (n === 0) return;
    const fc = f32(filt > 0 ? (filt < 1 ? filt : 1) : 0);
    const a = f32(fc * 0.9900000095367432 + F_001);
    const mix = f32(mixRaw * mixRaw);
    let idx = this.delayIdx;
    let lp = this.delayLp;
    for (let i = 0; i < n; i++) {
      if (idx >= len) idx = 0;
      const fbv = f32(buf[idx] * fb) + 1e-30;
      lp = f32(fmad(fbv - lp, a, lp));
      const wet = f32(mix * lp);
      buf[idx] = f32(f32(R[o + i] + L[o + i]) + lp);
      if (Math.abs(wet) > 1e-5) this.fxCount = 0;
      L[o + i] = f32(L[o + i] + wet);
      R[o + i] = f32(R[o + i] + wet);
      idx++;
    }
    this.delayIdx = idx;
    this.delayLp = lp;
  }

  /** PHASER (0x371a8): 6 first-order allpasses per side with feedback, LFO in opposite phase L / R. */
  private phaser(L: Float32Array, R: Float32Array, o: number, n: number, pos: number): void {
    if (!this.phaserOn) return;
    const st = this.phs;
    if (this.phaserChanged) {
      this.phaserChanged = false;
      st.fill(0);
      this.phSmooth = -1;
    }
    const p = this.p;
    const sr = this.sr;
    const width = p[39];
    const fbk = f32(Math.cbrt(p[40]));
    const fq = f32(p[42] * p[42]);
    const mix = p[41];
    const target = fq > F_1E5 ? fq : F_1E5;
    if (this.phSmooth < 0) this.phSmooth = target;
    // LFO phase (float) then its cosine for this block
    let ph: number;
    if (this.sync) ph = pos / this.phaserRate;
    else ph = (n * this.tempo) / (this.phaserRate * 60 * sr) + st[14];
    let phf = f32(ph);
    phf = f32(phf - Math.trunc(phf));
    st[14] = phf;
    const cs = Math.cos(phf * 6.283185307179586);
    if (n < 1) return;
    const h = 0.5 / sr;
    const lo = f32(h * 100);
    const hi = f32(h * 40000);
    const w3 = f32(f32(width * width) * f32(width * 0.5));
    const fbg = f32(fbk * 0.98);
    const wet = mix > F_1E5 ? mix : F_1E5;
    const modL = f32(fmad(cs, w3, w3));
    const modR = f32(fmad(-cs, w3, w3));
    const span = f32(hi - lo);
    let sm = this.phSmooth;
    for (let i = 0; i < n; i++) {
      const xl = f32(L[o + i] + 1e-30);
      const xr = f32(R[o + i] + 1e-30);
      let cl = fmaf(f32(sm + modL), span, lo);
      cl = cl < 0.49900001287460327 ? cl : 0.49900001287460327;
      cl = cl > F_1E5 ? cl : F_1E5;
      let cr = fmaf(f32(sm + modR), span, lo);
      cr = cr < 0.49900001287460327 ? cr : 0.49900001287460327;
      cr = cr > F_1E5 ? cr : F_1E5;
      sm = f32(fmad(f32(target - sm), 0.001, sm));
      const al = f32(f32(1 - cl) / f32(cl + 1));
      const ar = f32(f32(1 - cr) / f32(cr + 1));
      // left chain
      let xin = fmaf(st[6], fbg, xl);
      let y = fmaf(-xin, al, st[0]);
      let ay = f32(y * al);
      st[0] = f32(ay + xin);
      let y2 = f32(st[1] - ay);
      ay = f32(y2 * al);
      st[1] = f32(ay + y);
      y = f32(st[2] - ay);
      ay = f32(y * al);
      st[2] = f32(ay + y2);
      y2 = f32(st[3] - ay);
      ay = f32(y2 * al);
      st[3] = f32(ay + y);
      y = f32(st[4] - ay);
      ay = f32(y * al);
      st[4] = f32(ay + y2);
      const yl = f32(st[5] - ay);
      st[5] = fmaf(yl, al, y);
      st[6] = yl;
      // right chain
      xin = fmaf(st[13], fbg, xr);
      y = fmaf(-xin, ar, st[7]);
      ay = f32(y * ar);
      st[7] = f32(ay + xin);
      y2 = f32(st[8] - ay);
      ay = f32(y2 * ar);
      st[8] = f32(ay + y);
      y = f32(st[9] - ay);
      ay = f32(y * ar);
      st[9] = f32(ay + y2);
      y2 = f32(st[10] - ay);
      ay = f32(y2 * ar);
      st[10] = f32(ay + y);
      y = f32(st[11] - ay);
      ay = f32(y * ar);
      st[11] = f32(ay + y2);
      const yr = f32(st[12] - ay);
      st[12] = fmaf(yr, ar, y);
      st[13] = yr;
      L[o + i] = fmaf(yl, wet, L[o + i]);
      R[o + i] = fmaf(yr, wet, R[o + i]);
    }
    this.phSmooth = sm;
  }

  /** CHORUS (0x377cc): mono 10 ms modulated delay (the right tap only crossfades, as in FL). */
  private chorus(L: Float32Array, R: Float32Array, o: number, n: number): void {
    if (!this.chorusOn) return;
    const buf = this.chorusBuf;
    const len = buf.length;
    if (this.chorusChanged) {
      this.chorusChanged = false;
      buf.fill(0);
      this.chorusIdx = 0;
      this.chPhL = 0.6200000047683716;
      this.chPhR = 0.10000000149011612;
    }
    const p = this.p;
    const depth = p[35];
    const mix = f32(p[36] * p[36]);
    const rate = f32(f32(p[34] * p[34]) * 4);
    const incL = f32(f32(rate + 0.20000000298023224) / this.sr);
    const incR = f32(f32(rate + 0.25) / this.sr);
    const dep = fmaf(depth, 0.35999998450279236, 0.04000000283122063);
    const span = f32(dep * f32(len));
    let w = this.chorusIdx;
    let phL = this.chPhL, phR = this.chPhR;
    for (let i = 0; i < n; i++) {
      if (w >= len) w = 0;
      buf[w] = f32(L[o + i] + R[o + i]);
      // left tap: delay (0.5 + dep sin)^2 * dep * len samples ahead of the write position
      let d = f32(fmad(Math.sin(phL * 6.283185307179586), dep, 0.5));
      d = f32(f32(d * d) * span);
      const di = Math.trunc(d);
      let j = w + di;
      if (j >= len) j -= len;
      const a0 = buf[j];
      let j1 = j + 1;
      if (j1 >= len) j1 -= len;
      const a1 = buf[j1];
      const tapL = fmaf(f32(d - di), f32(a1 - a0), a0);
      // right tap: 0.5 + dep sin samples (FL's code)
      const e = f32(fmad(Math.sin(phR * 6.283185307179586), dep, 0.5));
      const ei = Math.trunc(e);
      let k = w + ei;
      if (k >= len) k -= len;
      const b0 = buf[k];
      let k1 = k + 1;
      if (k1 >= len) k1 -= len;
      const b1 = buf[k1];
      phL = f32(phL + incL); phL = f32(phL - Math.trunc(phL));
      phR = f32(phR + incR); phR = f32(phR - Math.trunc(phR));
      L[o + i] = fmaf(tapL, mix, L[o + i]);
      R[o + i] = fmaf(fmaf(f32(e - ei), f32(b1 - b0), b0), mix, R[o + i]);
      w++;
    }
    this.chorusIdx = w;
    this.chPhL = phL;
    this.chPhR = phR;
  }
}
