// Mappings from normalised control positions to physical units (and back).
// These are shared by the UI (hint bar, displays) and the audio engine so that
// what you read is exactly what you hear.

import { clamp } from '../engine/dsp/math';

// ------------------------------------------------------------- FL volume law
/**
 * FL's single volume curve: G(x) = (11^x - 1) / 10, x = 1 is unity. It is the
 * law FL's own code uses (Balance volume, Soft Clipper post gain read from the
 * binaries). Used for the channel volume knob (x = knob), note velocity
 * (x = vel / 100) and the mixer fader (x = v / 0.8).
 */
export function flGain(x: number): number {
  if (x <= 0) return 0;
  return (Math.pow(11, x) - 1) / 10;
}

// ---------------------------------------------------------------- mixer fader
// Position v in 0..1, 0.8 = 0 dB, 1.0 = +5.6 dB (gain 1.903). The law
// g(v) = (11^(v/0.8) - 1) / 10 (FL's volume curve) matches FL's readback values
// as well as the earlier e^(3v) fit, which approximated it.
export const FADER_DEFAULT = 0.8;
const LN11 = Math.log(11);

export function faderToGain(v: number): number {
  if (v <= 0) return 0;
  return (Math.exp((LN11 * v) / FADER_DEFAULT) - 1) / 10;
}

export function faderToDb(v: number): number {
  const g = faderToGain(v);
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

export function gainToFader(g: number): number {
  if (g <= 0) return 0;
  return clamp((Math.log(1 + g * 10) / LN11) * FADER_DEFAULT, 0, 1);
}

export function dbToFader(db: number): number {
  if (!isFinite(db)) return 0;
  return gainToFader(Math.pow(10, db / 20));
}

// ------------------------------------------------------------- channel volume
// The channel volume knob (0..100%) spans the fader law up to 0 dB: 100% plays
// the sample at its original level and the default 78% is -5.2 dB.
export const CHANNEL_VOLUME_DEFAULT = 100 / 128;

export function channelVolumeToGain(v: number): number {
  return flGain(clamp(v, 0, 1));
}

export function channelVolumeToDb(v: number): number {
  const g = channelVolumeToGain(v);
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

// ------------------------------------------------------------------- panning
/**
 * Instrument (channel) panning with the project's Circular pan law (the
 * default): constant power, -3 dB at centre, 0 dB at the extremes. Applied as
 * a balance on stereo samples. Returns [gainL, gainR].
 */
export function panGains(pan: number, out: [number, number] = [1, 1]): [number, number] {
  const th = (clamp(pan, -1, 1) + 1) * Math.PI / 4;
  out[0] = Math.cos(th);
  out[1] = Math.sin(th);
  return out;
}

/**
 * Mixer panning ("merge & pan"): the far channel is poured into the near one
 * and the result is normalised with the circular (constant power) law.
 * Returns the 2x2 matrix [ll, lr, rl, rr] so that L' = ll*L + lr*R, R' = rl*L + rr*R.
 */
export function mixerPanMatrix(pan: number, out = new Float64Array(4)): Float64Array {
  const p = clamp(pan, -1, 1);
  const a = Math.abs(p);
  const k = 1 / Math.sqrt(1 + a * a);
  if (p < 0) { out[0] = k; out[1] = a * k; out[2] = 0; out[3] = (1 - a) * k; }
  else { out[0] = (1 - a) * k; out[1] = 0; out[2] = a * k; out[3] = k; }
  return out;
}

// ---------------------------------------------------------- mixer built-in EQ
/** f(x) = 10 + 159.9 * (101^x - 1) Hz: 10 Hz .. 16 kHz. */
export function eqFreqHz(x: number): number {
  return 10 + 159.9 * (Math.pow(101, clamp(x, 0, 1)) - 1);
}

export function eqHzToNorm(f: number): number {
  return clamp(Math.log(1 + (f - 10) / 159.9) / Math.log(101), 0, 1);
}

export function eqWidthQ(w: number): number {
  return 0.2 * Math.pow(100, clamp(w, 0, 1));
}

export function formatHz(f: number): string {
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`;
}

// --------------------------------------------------------------- formatting
export function formatDb(db: number, digits = 1): string {
  if (!isFinite(db)) return '-inf dB';
  const s = db.toFixed(digits);
  return (db > 0 ? '+' : '') + (s === '-0.0' ? '0.0' : s) + ' dB';
}

export function formatPan(pan: number): string {
  const pct = Math.round(Math.abs(pan) * 100);
  if (pct === 0) return 'Centered';
  return `${pct}% ${pan < 0 ? 'left' : 'right'}`;
}

export function formatSeparation(k: number): string {
  const pct = Math.round(Math.abs(k) * 100);
  if (pct === 0) return 'No effect';
  return `${pct}% ${k > 0 ? 'merged' : 'separated'}`;
}

export function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}
