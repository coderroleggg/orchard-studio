// Spreader (FL: Spreader): mono-compatible stereo widener. The band above
// the low bypass (Linkwitz-Riley crossover) gets a delayed (up to 6.35 ms)
// copy of its mid added to the side and of its side added to the mid, scaled
// by Spread; Separation scales the side, Mono collapses the low band.
// Form: 540 x 255; SpreadWheel (Tag 0) 0..10000, SeparationWheel (Tag 1)
// -10000..10000, LFBypassWheel (Tag 2) 1000..1000000, MonoSwitch (Tag 3),
// OnOffCheckBox (Tag 4). The pre/post scope switches and the theme are
// editor settings (not parameters).

import type { FxPluginDef } from '../types';

/**
 * Low bypass frequency (Hz) for a wheel value: two linear segments, 0..500 Hz
 * then 500..10000 Hz, from FL's normalised value rounded to float32 (the DSP
 * clamps it to at least 10 Hz).
 */
export function spreaderBypassHz(v: number): number {
  const x = Math.fround(Math.min(1, Math.max(0, (v - 1000) * (1 / 999000))));
  return x <= 0.5 ? 1000 * Math.exp(Math.log(x)) : 500 + 9500 * Math.exp(Math.log((x - 0.5) * 2));
}

export function spreaderBypassFromHz(hz: number): number {
  const h = Math.max(0, Math.min(10000, hz));
  const x = h <= 500 ? h / 1000 : 0.5 + (h - 500) / 19000;
  return Math.round(1000 + x * 999000);
}

function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** "50.0%": one decimal, halves rounded up as in FL's decimal formatting (315 reads 3.2%). */
export function spreaderSpreadText(v: number): string {
  const tenths = Math.floor(Math.abs(v) / 10 + 0.5 + 1e-9) * Math.sign(v);
  return `${(tenths / 10).toFixed(1)}%`;
}

/** "Original" whenever FL's rounded percentage is 0, else "N% merged" / "N% separated". */
export function spreaderSepText(v: number): string {
  const p = roundHalfEven(-(v / 10000) * 100);
  if (p === 0) return 'Original';
  return p > 0 ? `${p}% merged` : `${-p}% separated`;
}

export function spreaderBypassText(v: number): string {
  return `${spreaderBypassHz(v).toFixed(2)} Hz`;
}

export const def: FxPluginDef = {
  id: 'spreader',
  name: 'Spreader',
  category: 'Gain',
  width: 540,
  height: 255,
  description: 'Mono-compatible stereo widener with low-frequency bypass and vectorscope',
  params: [
    { key: 'spread', name: 'Spread', index: 0, min: 0, max: 10000, def: 5000, format: spreaderSpreadText, parse: (pct) => Math.round(pct * 100) },
    { key: 'sep', name: 'Stereo separation', index: 1, min: -10000, max: 10000, def: 0, bipolar: true, format: spreaderSepText, parse: (pct) => Math.round(pct * 100) },
    { key: 'lowbypass', name: 'Low-Frequency Bypass', index: 2, min: 1000, max: 1000000, def: 10990, format: spreaderBypassText, parse: (hz) => spreaderBypassFromHz(hz) },
    { key: 'mono', name: 'Mono', index: 3, min: 0, max: 1, def: 0, options: ['Off', 'On'] },
    { key: 'enabled', name: 'Enabled', index: 4, min: 0, max: 1, def: 1, options: ['Off', 'On'] },
  ],
  // scope switches (PRE-FX / POST-FX) and the Options > Theme choice
  state: () => ({ showPre: 1, showPost: 1, theme: 1 }),
};
