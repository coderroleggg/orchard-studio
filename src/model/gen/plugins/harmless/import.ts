// Harmless content that Orchard Studio does not ship: the custom timbre colour
// (524 harmonic amplitudes + phases) of FL's factory presets is FL's waveform
// analysis. "Import FL content..." reads the user's own FL presets at runtime
// and stores the colour in the project's sample pool (`customSample`, a mono
// float sample: amplitudes then phases). Pure helpers, defensive parsing.

import { HL_KEYS } from './params';
import { CUSTOM_N, HL_EXTRAS, hlDecodeBlob, hlFstBlob, type HlDecoded } from './state';

/** A Harmless state blob from an FL preset (.fst) or raw state file; null when it is not one. */
export function decodeHarmlessFile(bytes: Uint8Array): HlDecoded | null {
  const blob = hlFstBlob(bytes);
  if (!blob) return null;
  try {
    return hlDecodeBlob(blob);
  } catch {
    return null;
  }
}

/** How well a decoded FL preset matches a state: 1 = every parameter and extra control equal. */
export function presetScore(d: HlDecoded, state: Record<string, unknown>): number {
  let same = 0, n = 0;
  HL_KEYS.forEach((k, i) => { n++; if (Number(state[k]) === d.params[i]) same++; });
  HL_EXTRAS.forEach((e, i) => { n++; if (Number(state[e.key]) === d.extras[i]) same++; });
  return same / n;
}

/** The custom colour as the pool sample's frames (CUSTOM_N amplitudes, then CUSTOM_N phases in cycles). */
export function customFrames(custom: Float32Array): Float32Array {
  const out = new Float32Array(CUSTOM_N * 2);
  const n = Math.min(CUSTOM_N, custom.length >> 1);
  const half = custom.length >> 1;
  for (let i = 0; i < n; i++) {
    out[i] = custom[i];
    out[CUSTOM_N + i] = custom[half + i];
  }
  return out;
}

/**
 * "Analyze single-cycle waveform" (FL 0x74380 / 0x744e0): the file is one
 * period. FL resamples it to 2048 samples, takes a real FFT and keeps bins
 * 1..524: amplitude |X_k| scaled so that the largest is 1, phase
 * arg(X_k) / 2 pi + 0.25 (cycles, not wrapped). Here a DFT of the period at
 * its own length stands in for FL's resampler (the same bins for a
 * band-limited period).
 */
export function analyzeCycle(x: Float32Array): Float32Array {
  const out = new Float32Array(CUSTOM_N * 2);
  const N = x.length;
  if (N < 2) return out;
  const kmax = Math.min(CUSTOM_N, Math.floor(N / 2));
  let peak = 0;
  for (let k = 1; k <= kmax; k++) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * k) / N;
    for (let n = 0; n < N; n++) { re += x[n] * Math.cos(w * n); im -= x[n] * Math.sin(w * n); }
    const a = Math.fround(Math.hypot(re, im));
    out[k - 1] = a;
    out[CUSTOM_N + k - 1] = Math.fround(Math.fround(Math.atan2(im, re)) * 0.15915494309189535 + 0.25);
    if (a > peak) peak = a;
  }
  if (peak > 0) { const g = Math.fround(1 / peak); for (let k = 0; k < CUSTOM_N; k++) out[k] = Math.fround(out[k] * g); }
  return out;
}

/** A mono 32-bit float WAV (44.1 kHz) of the frames: what the pool stores and decodes back unchanged. */
export function floatWav(data: Float32Array, rate = 44100): ArrayBuffer {
  const b = new ArrayBuffer(44 + data.length * 4);
  const v = new DataView(b);
  const s = (o: number, t: string) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + data.length * 4, true); s(8, 'WAVE');
  s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 32, true);
  s(36, 'data'); v.setUint32(40, data.length * 4, true);
  for (let i = 0; i < data.length; i++) v.setFloat32(44 + i * 4, data[i], true);
  return b;
}
