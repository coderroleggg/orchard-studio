// Small, allocation-free math helpers shared by the audio engine and the UI.

export const TWO_PI = Math.PI * 2;
export const LN10_20 = Math.LN10 / 20;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dbToGain(db: number): number {
  return Math.exp(db * LN10_20);
}

export function gainToDb(g: number): number {
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

/** Equal-tempered frequency of a MIDI key (69 = A 440 Hz; FL calls key 60 "C5"). */
export function keyToHz(key: number): number {
  return 440 * Math.pow(2, (key - 69) / 12);
}

export function semitonesToRatio(semi: number): number {
  return Math.pow(2, semi / 12);
}

/** Flush denormals / tiny values to zero (cheap guard for IIR state). */
export function flush(x: number): number {
  return x > 1e-20 || x < -1e-20 ? x : 0;
}
