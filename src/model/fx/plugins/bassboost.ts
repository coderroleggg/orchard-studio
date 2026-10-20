// Bass Boost (FL: Fruity Bass Boost, legacy): "a fancy bass knob". The
// input plus Amount times a resonant two-pole low-pass of it (see the
// engine). Form: 335 x 55; FrequencyWheel (Tag 0) and AmountWheel (Tag 1),
// both 0..1024 (defaults 512 = 60 Hz and 768); the AmountSlider (Tag -1) is
// a read-only bar that mirrors the amount. Not listed in FL's plugin database.

import type { FxPluginDef } from '../types';

function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function norm(v: number, d: number): number {
  return Math.fround(Math.min(1, Math.max(0, (Number.isFinite(v) ? v : d) / 1024)));
}

/** Boost frequency in whole Hz, 20..100: FL's Round(float32(x·80) + 20) (banker's rounding). */
export function bassBoostHz(v: number): number {
  return roundHalfEven(Math.fround(Math.fround(norm(v, 512) * 80) + 20));
}

/** Amount gain of the low-passed signal: float32(11^x - 1) / 2 (0 .. 5; 768 gives 2.52). */
export function bassBoostGain(v: number): number {
  return Math.fround(Math.fround(Math.exp(norm(v, 768) * 2.3978952727983707) - 1) * 0.5);
}

/** FL's amount hint: a bar of Round(float32(x·19)) "|" characters. */
export function bassBoostAmountText(v: number): string {
  return '|'.repeat(roundHalfEven(Math.fround(norm(v, 768) * 19)));
}

export const def: FxPluginDef = {
  id: 'bassboost',
  name: 'Bass Boost',
  category: 'Filter',
  width: 335,
  height: 55,
  hidden: true,
  description: 'Bass enhancer: boosts the frequencies around the chosen frequency',
  params: [
    {
      key: 'freq', name: 'Frequency', index: 0, min: 0, max: 1024, def: 512, format: (v) => `${bassBoostHz(v)} Hz`,
      parse: (hz) => Math.round((Math.max(20, Math.min(100, hz)) - 20) * 12.8),
    },
    { key: 'amount', name: 'Amount', index: 1, min: 0, max: 1024, def: 768, format: bassBoostAmountText },
  ],
  // FL's factory preset folder holds Default.fst (= the constructor state)
  presets: [{ name: 'Default', params: { freq: 512, amount: 768 } }],
};
