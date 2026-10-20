// SF2 modulators (spec 8.2 / 8.4): the default modulator list, source curves and the evaluation of a voice's
// modulator list, ported from FL's Sobanth (0x1d7070 source value, 0x1d7cf0 modulator value, 0x1fada0 modulator
// insertion). Controllers are doubles in 0..127 (the pitch wheel 0..16383, centre 8192, divisor 16384); a source maps them by its
// direction / polarity / type: linear
// (d / 127, bipolar -1 + 2 d / 127), concave / convex (float32 tables 0x1fd430: concave[127 - i] =
// -(20/96) log10(i^2 / 127^2), convex[i] = 1 - concave[127 - i], entries 0 and 127 fixed; linear interpolation with the
// fraction of the controller; bipolar sources use the table at 2 (d - 64) on either side of 64) or a switch (d >= 64).
// The controllers' FL defaults (measured with probe modulators): CC7 127, CC10 64, CC11 127, CC100 / CC101 127, all
// other CCs 0 (CC1 is the "Modulation" parameter), pitch wheel centred, no pressure.

import type { Sf2Mod } from '../../../../model/gen/plugins/soundfont/sf2';

/** The SF2 default modulators (spec 8.4.1 - 8.4.10; the pan amount is FL's measured one, 500). */
export const DEFAULT_MODS: Sf2Mod[] = [
  { src: 0x0502, dest: 48, amount: 960, amtSrc: 0, trans: 0 }, // note-on velocity -> initial attenuation (concave, negative)
  { src: 0x0102, dest: 8, amount: -2400, amtSrc: 0x0d02, trans: 0 }, // note-on velocity -> initial filter cutoff (FL: x 1/2 below velocity 64)
  { src: 0x000d, dest: 6, amount: 50, amtSrc: 0, trans: 0 }, // channel pressure -> vibrato LFO to pitch
  { src: 0x0081, dest: 6, amount: 50, amtSrc: 0, trans: 0 }, // CC1 (mod wheel) -> vibrato LFO to pitch
  { src: 0x0587, dest: 48, amount: 960, amtSrc: 0, trans: 0 }, // CC7 volume -> initial attenuation (concave, negative)
  { src: 0x028a, dest: 17, amount: 500, amtSrc: 0, trans: 0 }, // CC10 pan -> pan (bipolar)
  { src: 0x058b, dest: 48, amount: 960, amtSrc: 0, trans: 0 }, // CC11 expression -> initial attenuation
  { src: 0x00db, dest: 16, amount: 200, amtSrc: 0, trans: 0 }, // CC91 reverb -> reverb send
  { src: 0x00dd, dest: 15, amount: 200, amtSrc: 0, trans: 0 }, // CC93 chorus -> chorus send
  { src: 0x020e, dest: 52, amount: 12700, amtSrc: 0x0010, trans: 0 }, // pitch wheel x sensitivity -> fine tune
];

/** Identity of a modulator for overriding / adding: same source, destination and amount source (FL ignores the transform). */
export function modKey(m: Sf2Mod): string {
  return `${m.src}.${m.dest}.${m.amtSrc}`;
}

// ------------------------------------------------------------------ curves
const f32 = Math.fround;
const CONCAVE = new Float32Array(128);
const CONVEX = new Float32Array(128);
(() => {
  for (let i = 1; i < 127; i++) {
    const x = (-0.2083333395421505 * Math.log((i * i) / 16129) * 0.43429448190325176);
    CONCAVE[127 - i] = f32(x);
    CONVEX[i] = f32(1 - x);
  }
  CONCAVE[0] = 0; CONCAVE[127] = 1;
  CONVEX[0] = 0; CONVEX[127] = 1;
})();

/** FL's table lookups (0x1d7070): the concave one tests the truncated integer, the convex one the value; both interpolate with the fraction. */
function tabConcave(v: number): number {
  const x = Math.trunc(v);
  if (x <= 0) return 0;
  if (x >= 127) return 1;
  return CONCAVE[x] + f32(CONCAVE[x + 1] - CONCAVE[x]) * (v - x);
}

function tabConvex(v: number): number {
  if (!(v > 0)) return 0;
  if (!(v < 127)) return 1;
  const x = Math.trunc(v);
  return CONVEX[x] + f32(CONVEX[x + 1] - CONVEX[x]) * (v - x);
}

/** The controller values a voice's modulators see. */
export interface SfControls {
  cc: Uint8Array;
  velocity: number;
  key: number;
  polyPressure: number;
  chanPressure: number;
  /** The pitch wheel, 0..16383 (FL divides it by 16384: 8192 is the centre, a bipolar linear source is exactly 0). */
  pitchWheel: number;
  /** Pitch wheel sensitivity in semitones (RPN 0; 2 by default). */
  pitchSens: number;
  /** The "Velocity filter cutoff" option: off removes the velocity -> filter cutoff modulators. */
  velFc: boolean;
}

export function defaultControls(): SfControls {
  const cc = new Uint8Array(128);
  cc[7] = 127; cc[10] = 64; cc[11] = 127; cc[100] = 127; cc[101] = 127;
  return { cc, velocity: 0, key: 0, polyPressure: 0, chanPressure: 0, pitchWheel: 8192, pitchSens: 2, velFc: true };
}

/** A source word FL cannot decode (a curve type above 3, 0x1fb0b0): its modulator is added with amount 0. */
function badSource(code: number): boolean {
  return ((code >> 10) & 0x3f) > 3;
}

/** The value of a source (0x1d7070): index 0 and unsupported controllers give 0 (1 for an amount source). */
function source(code: number, c: SfControls, isAmount: boolean): number {
  const index = code & 0x7f;
  const none = isAmount ? 1 : 0;
  if (index === 0) return none;
  let d: number;
  if (code & 0x80) d = c.cc[index] ?? 0;
  else if (index === 2) d = c.velocity;
  else if (index === 3) d = c.key;
  else if (index === 10) d = c.polyPressure;
  else if (index === 13) d = c.chanPressure;
  else if (index === 14) d = c.pitchWheel;
  else if (index === 16) d = c.pitchSens;
  else return none; // 127 (the output of a linked modulator) is not supported
  // flags: bit 0 negative direction, bit 1 bipolar, bits 2..3 the type (linear, concave, convex, switch)
  const flags = ((code >> 8) & 1) | (((code >> 9) & 1) << 1) | (((code >> 10) & 3) << 2);
  const div = index === 14 && !(code & 0x80) ? 16384 : 127;
  switch (flags) {
    case 0: return d / div;
    case 1: return 1 - d / div;
    case 2: return -1 + (2 * d) / div;
    case 3: return 1 - (2 * d) / div;
    case 4: return tabConcave(d);
    case 5: return tabConcave(127 - d);
    case 6: return d > 64 ? tabConcave(2 * (d - 64)) : -tabConcave(2 * (64 - d));
    case 7: return d > 64 ? -tabConcave(2 * (d - 64)) : tabConcave(2 * (64 - d));
    case 8: return tabConvex(d);
    case 9: return tabConvex(127 - d);
    case 10: return d > 64 ? tabConvex(2 * (d - 64)) : -tabConvex(2 * (64 - d));
    case 11: return d > 64 ? -tabConvex(2 * (d - 64)) : tabConvex(2 * (64 - d));
    case 12: return d < 64 ? 0 : 1;
    case 13: return d < 64 ? 1 : 0;
    case 14: return d < 64 ? -1 : 1;
    default: return d < 64 ? 1 : -1;
  }
}

/** The output of a modulator in its destination's units (0x1d7cf0). */
export function modValue(m: Sf2Mod, c: SfControls): number {
  // FL: modulators with a transform (absolute value) or an undecodable source contribute nothing; a zero amount is zero
  if (m.amount === 0 || m.trans !== 0 || badSource(m.src) || badSource(m.amtSrc)) return 0;
  if (m.dest === 8 && (m.src & 0xff) === 2 && m.src >> 8 === 1) {
    // velocity (linear, negative) -> initial filter cutoff: with the velocity switch as amount source (the SF2
    // default, 0x0c02 / 0x0d02) the value is half the amount below velocity 64 and the linear ramp above; the plain form
    // is the spec's. "Velocity filter cutoff" off silences both.
    const s2 = m.amtSrc;
    if ((s2 & 0xff) === 2 && (s2 >> 8 === 0x0c || s2 >> 8 === 0x0d)) {
      if (!c.velFc) return 0;
      return c.velocity < 64 ? m.amount * 0.5 : m.amount * (127 - c.velocity) * 0.007874015718698502;
    }
    if (s2 === 0 && !c.velFc) return 0;
  }
  const a = source(m.src, c, false);
  if (a === 0) return 0;
  return a * source(m.amtSrc, c, true) * m.amount;
}
