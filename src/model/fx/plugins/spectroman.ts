// Spectroman (FL: Fruity Spectroman): spectrum analyser with two displays,
// spectrograph (bars with band peaks) and sonograph (scrolling intensity).
// Form: 285 x 159 (also FL's minimum window size). Parameters (host):
// 0 Output mode 0..1 (1 = sonograph), 1 Amplification 0..128 (64 = "50%"),
// 2 Frequency scale (Center frequency) 0..128 (64 = "3058Hz" at 44.1 kHz).
// STEREO / SHOW PEAKS / WINDOWING are non-automatable state (defaults off/on/on).

import type { FxPluginDef } from '../types';

/** FFT size and analysis hop (FL keeps the last 512 samples between frames). */
export const SPM_FFT = 2048;
export const SPM_HOP = 1536;
/** Display columns (FL's scope is 128 columns wide at 100%). */
export const SPM_COLS = 128;

/** Round half to even (ARM frintx in FL's code). */
export function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const f32 = Math.fround;

/** Frequency-scale curvature k (1..2000) for a scale wheel value. */
export function spmCurve(v: number): number {
  const s = f32(f32(v) * 0.0078125);
  const e = f32(Math.exp(s * 7.600902459542082) - 1);
  return roundEven(e) + 1;
}

/** First FFT bin of display column i (0..128) for curvature k; column i covers bins [bin(i), bin(i+1)). */
export function spmBin(i: number, k: number): number {
  const t = f32((i * 0.0078125 + 0.03) / 1.03);
  const l = Math.log(f32(f32(k) + 1));
  const e = f32(Math.exp(t * l) - 1);
  return roundEven(f32(f32(e * 1024) / f32(k)));
}

/** Bin table for a scale value: 129 entries, table[0] = 0. */
export function spmTable(scale: number, out: Int32Array = new Int32Array(SPM_COLS + 1)): Int32Array {
  const k = spmCurve(scale);
  out[0] = 0;
  for (let i = 1; i <= SPM_COLS; i++) out[i] = spmBin(i, k);
  return out;
}

/** Sample rate used for the "Center frequency" value text (set by the editor from the audio host). */
let textRate = 44100;
export function setSpectromanRate(sr: number): void {
  if (sr > 0) textRate = sr;
}

/** FL's value text of the scale wheel: the frequency at the display centre, "3058Hz". */
export function spmScaleText(v: number, sr = textRate): string {
  const k = spmCurve(v);
  const bin = (spmBin(64, k) + spmBin(65, k)) >> 1;
  return `${roundEven(bin * sr * (1 / 2048))}Hz`;
}

/** Hint frequency for display column `col` (FL: mean of the column's first bins). */
export function spmColumnHz(table: Int32Array, col: number, sr: number): number {
  const c = Math.max(0, Math.min(SPM_COLS - 1, Math.floor(col)));
  return ((table[c] + table[c + 1]) >> 1) * sr / 2048;
}

export function spmAmpText(v: number): string {
  return `${Math.round((v * 100) / 128)}%`;
}

export const SPM_MODES = ['spectrograph', 'sonograph'];

export const def: FxPluginDef = {
  id: 'spectroman',
  name: 'Spectroman',
  category: 'Visual',
  width: 285,
  height: 159,
  description: 'Spectrum analyser: spectrograph and sonograph',
  params: [
    { key: 'mode', name: 'Output mode', index: 0, min: 0, max: 1, def: 1, options: SPM_MODES },
    { key: 'amp', name: 'Amplification', index: 1, min: 0, max: 128, def: 64, format: spmAmpText, parse: (pct) => Math.round((pct * 128) / 100) },
    { key: 'scale', name: 'Frequency scale (Center frequency)', index: 2, min: 0, max: 128, def: 64, format: (v) => spmScaleText(v) },
  ],
  state: () => ({ stereo: false, peaks: true, windowing: true }),
  // FL's factory preset (its state blob: mode 1, amp 64, scale 64, windowing 1, peaks 1, stereo 0)
  presets: [{ name: 'Default', params: { mode: 1, amp: 64, scale: 64, stereo: false, peaks: true, windowing: true } }],
  normalize: (p) => ({
    ...p,
    stereo: !!p.stereo,
    peaks: p.peaks === undefined ? true : !!p.peaks,
    windowing: p.windowing === undefined ? true : !!p.windowing,
  }),
};
