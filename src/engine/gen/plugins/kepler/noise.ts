// The DCO noise source of Kepler / Kepler Exo: FL's engine plays a recorded noise loop (682245 signed
// 16-bit points, mildly low-passed: neighbouring points correlate by about 0.29, RMS 6645) starting at
// point 0 in every voice, one point per oversampled sample. The recording is FL content, so a synthesised
// substitute of the same level and colour stands in unless the user's table is imported (setNoiseTable).

export const NOISE_LEN = 682245;

let table: Int16Array | null = null;

/** Use FL's recorded noise (an Int16Array of NOISE_LEN points), or null for the synthesised substitute. */
export function setNoiseTable(t: Int16Array | null): void {
  table = t && t.length >= NOISE_LEN ? t : null;
}

export function setNoiseTableForTest(t: Int16Array | null): void { setNoiseTable(t); }

/** Uniform pseudo-random value in -1..1 from the point index (stateless: any point can be asked for). */
function hash(i: number): number {
  let x = (Math.imul(i | 0, 0x9e3779b1) + 0x7f4a7c15) | 0;
  x ^= x >>> 15; x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 2147483648 - 1;
}

/** Point i of the loop as a signed 16-bit value. */
export function noiseSample(i: number, own?: Int16Array): number {
  const t = own ?? table;
  if (t) return t[i];
  // two-tap smoothing gives a lag-1 correlation of about 0.29; scale to the recording's RMS
  const v = (hash(i) + 0.33 * hash(i - 1)) * 0.3336 * 32768;
  return Math.max(-32768, Math.min(32767, Math.trunc(v)));
}
