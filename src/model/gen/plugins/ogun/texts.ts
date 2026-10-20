// Ogun value texts: a port of FL's value text function (TTestPlug.GetName FPN_ParamValue ->
// 0x6c3e0 in Ogun_x64.dylib, FL 2026 arm64 slice), equal to the test host's texts at every value of every
// parameter (`flfxhost sweep`, 793 000 points; tests/gen/ogun.test.ts pins samples and digests).
//
// FL rounds in several ways, each as the plugin's code does it: the percentage texts round half away from zero (14.5 -> 15),
// the time and frequency texts take the single-precision result to the nearest integer with ties to even (frintx), and the
// decimal texts go through FPC's FloatToStrF (0x38240 / 0x381e0).

import { exp } from '../../../../engine/gen/plugins/harmor/fx-libm';

const f32 = Math.fround;

/** Round half away from zero. */
function roundAway(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

/** "N%" of v / denominator (FL divides by Max / 100 for the 1000 ranges: 14.5 stays exact). */
export function pctText(v: number, denom: number): string {
  const x = denom % 100 === 0 ? v / (denom / 100) : (v / denom) * 100;
  return `${roundAway(x)}%`;
}

/** Round half to even (frintx). */
function rne(x: number): number {
  const r = Math.floor(x + 0.5);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * One decimal of a single as FL prints it (FloatToStrF(x, ffFixed, 7, 1) through Str): the exact binary value rounded half up, except
 * that a value from 10 up that lies just below a tie (within 2.4e-7: the single nearest to xx.x5) still rounds up (-15.95f prints
 * -16.0, -9.95f prints -9.9). An empirical rule that reproduces all 3 601 values of the sweeps; the formatter's digit generation is
 * not ported.
 */
export function flFixed1(x: number): string {
  const ax = Math.abs(x);
  const y = ax * 10;
  const fl = Math.floor(y);
  const fr = y - fl;
  const n = fl + (fr >= 0.5 || (ax >= 10 && fr >= 0.5 - 2.4e-6) ? 1 : 0);
  const t = `${Math.floor(n / 10)}.${n % 10}`;
  return x < 0 && n !== 0 ? `-${t}` : t;
}

/** Fixed decimals of the exact binary value (used where FL's formatter works on a double). */
function fixed(x: number, d: number): string {
  const t = Math.abs(x).toFixed(d);
  return x < 0 && Number(t) !== 0 ? `-${t}` : t;
}

/**
 * FL's exponential time ranges: 50 ms .. 20 s (997.5 x (21^(v/10000) - 1) + 50). The steps are those of 0x6c7ac: the exponent
 * v x 1e-4 is rounded to single, exp(x ln 21) - 1 is rounded to single, and so is the sum.
 */
export function timbreMs(v: number): number {
  const x = f32(v * 0.0001);
  const e = f32(exp(x * 3.044522437723423) - 1);
  return f32(50 + e * 997.5);
}

export function decayText(v: number): string {
  return v >= 10000 ? 'Infinite' : `${rne(timbreMs(v))}ms`;
}

export function releaseText(v: number): string {
  return `${rne(timbreMs(v))}ms`;
}

/** The delay / predelay times in ticks of 1/48 while tempo-based: "beats:ticks". */
export function delayTimeText(v: number): string {
  return `${Math.floor(v / 48)}:${String(v % 48).padStart(2, '0')}`;
}

/** The same times in milliseconds (384 units = 1 s) while not tempo-based. */
export function msTimeText(v: number): string {
  return `${Math.trunc((v * 1000) / 384)}ms`;
}

/** Stereo offset: 0.5 x (1001^(|v|/512) - 1) ms, "left" for negative values. */
export function offsetMs(v: number): number {
  return ((Math.fround(Math.exp(Math.abs(v) * 0.001953125 * 6.9087547793152204)) - 1) * 50) / 100;
}

export function offsetText(v: number): string {
  return `${fixed(offsetMs(v), 1)}ms ${v < 0 ? 'left' : 'right'}`;
}

/** EQ frequency: 10 + 159.9 x (101^(v/65536) - 1) Hz (0x6cfc0: the exponent v / 65536 and exp(x ln 101) - 1 are rounded to single). */
export function eqFreqHz(v: number): number {
  const x = f32(v * 1.52587890625e-05);
  const e = f32(exp(x * 4.6151205168412597) - 1);
  return 10 + e * 159.9;
}

export const eqFreqText = (v: number): string => `${rne(eqFreqHz(v))}Hz`;
export const eqWidthText = (v: number): string => fixed(v / 65536, 2);
export const eqLevelText = (v: number): string => `${flFixed1(f32(v * f32(0.01)))}dB`;
export const seed1Text = (v: number): string => (v === 0 ? 'None' : String(v));
export const seed2Text = (v: number): string => (v === 0 ? 'Random' : String(v));
export const reverbLowText = (v: number): string => (v > 19 ? `${v}Hz` : 'Off');
export const reverbHighText = (v: number): string => (v >= 221 ? 'Off' : `${fixed(Math.fround(v * Math.fround(0.1)), 1)}kHz`);
export const reverbPredelayText = (v: number): string => msTimeText(v);
export const reverbDecayText = (v: number): string => `${fixed(Math.fround(v * Math.fround(0.1)), 1)}sec`;

export const DELAY_MODES = ['norm', 'inv', 'pong'];
export const REVERB_COLORS = ['Brighter', 'Bright', 'Flat', 'Warm', 'Warmer'];

/**
 * LFO speed (phase): FL's text comes from the envelope editor (0xca2a0) and follows the LFO's own mode (tempo, global, harmonic
 * ratio of the note); the parameter's own text is a placeholder until the LFO unit is ported (the raw control value).
 */
export const lfoSpeedText = (v: number): string => String(v);
