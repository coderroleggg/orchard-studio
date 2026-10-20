// Harmless's static tables (FL 2026 Harmless_x64.dylib, arm64): the global
// tables 0x65810 computes once from the undetuned ratio table (timbre EQ band
// weights 0x65c00, the top-harmonic fade, the low-harmonics-protection weights,
// the multisine LFO's partials), the timbre colours (0x71c30), the unison
// detune tables (0x2c49c0) and the harmonizer table (0x2c4a2c).

import { INV_LN2, LN7F, cos, exp, f32, log, rint, sin } from './fl';
import { fpcPowerF } from './curves';

/** Oscillators per bank: 4 special slots (self-oscillation, sub 1, sub 3, sub 4) + 524 harmonics. */
export const NOSC = 0x210;
export const NHARM = 0x20c;

/** The constructor's frequency ratios (PL+0x5a0): 1, 0.5, 1.5, 2.5, then 1..524. */
export function baseRatios(): Float64Array {
  const r = new Float64Array(NOSC);
  r[0] = 1; r[1] = 0.5; r[2] = 1.5; r[3] = 2.5;
  for (let i = 0; i < NHARM; i++) r[4 + i] = i + 1;
  return r;
}

export interface EqBand { start: number; count: number; w: Float32Array }

/** 0x65c00: band weights over log2(ratio): raised cosine of width 1 octave around `center`; flags 1 / 2 = shelf below / above. */
function eqBand(ratios: Float64Array, center: number, flags: number): EqBand {
  const w = new Float32Array(NOSC);
  let start = 0x7fffffff, count = 0;
  const inv = 1 / 1;
  for (let i = 0; i < NOSC; i++) {
    const t = (log(ratios[i]) * INV_LN2 - center) * inv;
    let v: number;
    if ((t < 0 && (flags & 1)) || (t > 0 && (flags & 2))) v = 1;
    else {
      const c = t < -1 ? -1 : t > 1 ? 1 : t;
      v = (cos(3.1415926535897931 * c) + 1) * 0.5;
    }
    w[i] = f32(v);
    if (v !== 0) {
      if (start === 0x7fffffff) start = i;
      count = i - start + 1;
    }
  }
  return { start, count, w };
}

export interface GlobalTables {
  /** Timbre EQ bands 1..6 (G[315358] records). */
  eq: EqBand[];
  /** Fade of the top 64 bank slots (G[3153b8], applied from slot 464). */
  topFade: Float32Array;
  /** Low-harmonics protection weights of slots 0..7 (G[3153c0]). */
  lowProt: Float32Array;
  /** Multisine LFO: multipliers 1..12 then partial gains (G[2fb960]). */
  multisine: Float32Array;
}

let tables: GlobalTables | null = null;

/** 0x65810 (once per process, from the undetuned ratios). */
export function globalTables(): GlobalTables {
  if (tables) return tables;
  const r = baseRatios();
  const eq = [eqBand(r, 0, 1), eqBand(r, 1, 0), eqBand(r, 2, 0), eqBand(r, 3, 0), eqBand(r, 4, 0), eqBand(r, 5, 2)];
  const topFade = new Float32Array(64);
  const d9 = 0.0483321946706122;
  for (let i = 0; i < 64; i++) topFade[i] = f32((cos((i - 1) * d9) + 1) * 0.5);
  const lowProt = new Float32Array(8);
  const inv5 = 1 / (log(r[8]) * INV_LN2);
  for (let i = 0; i < 8; i++) {
    let t = log(r[i]) * INV_LN2;
    if (!(t > 0)) t = 0;
    const c = (cos(t * inv5 * 3.1415926535897931) + 1) * 0.5;
    lowProt[i] = f32(c * c * c * c * c);
  }
  const multisine = new Float32Array(24);
  for (let k = 1; k <= 12; k++) multisine[k - 1] = f32(k);
  const d9b = 0.26179938779914941, d10 = -11.148862085948322;
  for (let k = 1; k <= 12; k++) {
    const d8 = sin(k * d9b) / k;
    multisine[12 + k - 1] = f32((d10 / k) * d8 * d8);
  }
  tables = { eq, topFade, lowProt, multisine };
  return tables;
}

/**
 * Timbre colour of harmonic index k (0 = fundamental; 0.5 / 1.5 for the sub
 * slots), 0x71c30: [amplitude, phase in cycles]. `custom` = 524 amplitudes then
 * 524 phases, or null (FL: amplitude and phase 0).
 */
export function timbreOf(colour: number, k: number, custom: Float32Array | null, out: Float32Array): void {
  const s8 = f32(k);
  let a = 0, ph = 0;
  const par = () => fpcTruncI(s8) & 1;
  switch (colour) {
    case 1: a = f32(0.70710678118654757 / f32(1 + f32(s8 * 0.5))); break;
    case 2: a = f32(0.5 / f32(1 + f32(s8 * 0.25))); break;
    case 5:
      if (par() === 0) { a = f32(1.1000000000000001 / f32(1 + s8)); ph = 0; }
      else { a = f32(1.1000000000000001 / f32(f32(1 + s8) * s8)); ph = 0.25; }
      break;
    case 6:
      if (par() === 0) { a = f32(1.1000000000000001 / f32(1 + s8)); ph = 0; }
      else { a = f32((1.1000000000000001 / f32(1 + s8)) * f32(1 / fpcPowerF(s8, 0.2))); ph = 0.25; }
      break;
    case 7: {
      const e = exp(f32(1 / f32(1 + s8)) * 1.9459101490553132);
      a = f32(f32(e - 1) * f32(0.291666657));
      ph = f32(f32(par()) * 0.75);
      void LN7F;
      break;
    }
    case 8:
      a = f32(0.5 / f32(1 + s8));
      if (par() === 1) a = f32(a + f32(0.5 / f32(1 + f32(s8 * 0.5))));
      break;
    case 9:
      a = f32(1 / f32(3 * f32(1 + s8)));
      if (par() === 1) a = f32(a + f32(1 / f32(3 * f32(1 + f32(s8 * 0.5)))));
      if ((fpcTruncI(s8) & 3) === 3) a = f32(a + f32(1 / f32(3 * f32(1 + f32(s8 * 0.25)))));
      break;
    case 10:
      a = f32(0.5 / f32(1 + s8));
      if (par() === 1) a = f32(a + f32(0.25 / f32(1 + f32(s8 * 0.5))));
      if ((fpcTruncI(s8) & 3) === 3) a = f32(a + f32(0.125 / f32(1 + f32(s8 * 0.25))));
      break;
    case 11:
      if (custom) { const i = fpcRoundI(s8); a = custom[i] ?? 0; ph = custom[i + NHARM] ?? 0; }
      break;
    default: // 0 Saw, 3 Dephased saw, 4 Dephased saw 2
      a = f32(1 / f32(1 + s8));
      if (colour === 3) ph = f32(f32(par()) * 0.25);
      if (colour === 4) ph = f32(f32((fpcTruncI(s8) & 3) === 1 ? 1 : 0) * 0.5);
      break;
  }
  out[0] = a;
  out[1] = ph;
}

/** FPC Round of a float (frintx): ties to even. */
function fpcRoundI(x: number): number {
  return rint(x) | 0;
}

/** FPC Trunc of a float (0x14e0c0, fcvtzs): the parity tests (the sub slot 1.5 counts as odd). */
function fpcTruncI(x: number): number {
  return Math.trunc(x) | 0;
}

/** Unison detune multipliers per type (Classic, Uniform, Blurred) and unison voice (0x2c49c0). */
export const UNISON_TABLE: Float32Array[] = [
  new Float32Array([0.877, 1.069, 0.929, 1.181, 1.031, 1.129, 0.887, 1.117, 0.977].map(f32)),
  new Float32Array(9).fill(1),
  new Float32Array([0.8904719352722168, 1.0764262676239014, 0.911577045917511, 1.1025358438491821, 1.0341261625289917, 1.1668611764907837, 0.8539709448814392, 1.2062726020812988, 1]),
];

/** Harmonizer types (0x2c4a2c): offset a, k' = b + c k, step scale d. */
export const HARMONIZER = [
  [-1, 0, 2, 5], [0, 0, 2, 5], [1, 0, 2, 5], [-1, 1, 1, 10], [0, 2, 1, 10],
];
