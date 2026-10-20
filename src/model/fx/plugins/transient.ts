// Transient Processor (FL: Transient Processor, Image-Line / Daniel Schaack).
// Form: 547 x 318 (meters at both sides, wheels, scrolling meter graph at the
// bottom). Parameters in FL's order (Tag = parameter index), all wheels 0..160:
//   0 Attack (80 = 0%), 1 Drive, 2 Release (80 = 0%), 3 Gain (80 = 0 dB, +-9 dB),
//   4 Attack Shape / 5 Release Shape (0 Sharp, 1 Mid, 2 Slow; FL's spinners),
//   6 Split Frequency (5..1000 Hz, quadratic), 7 Split Balance (dry/wet), 8 Effect.
// Value texts reproduce FL's own (single-precision arithmetic and rounding
// included), checked against FL's plugin for every control value.

import type { FxPluginDef } from '../types';

const f = Math.fround;

/** Round half away from zero (Delphi Format '%.0f'). */
function roundAway(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

/** Round half to even (Delphi Round). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Attack / Release: "-100%" .. "0%" .. "100%". */
export function bipolarPctText(v: number): string {
  const r = roundAway(f(((v - 80) / 80) * 100));
  return `${r === 0 ? 0 : r}%`;
}

/** Drive: "0%" .. "100%". */
export function drivePctText(v: number): string {
  return `${roundAway(f(f(f(v) * f(1 / 160)) * 100))}%`;
}

/** Output gain: "-9.0 dB" .. "0.0 dB" .. "9.0 dB" (no plus sign, as in FL). */
export function tpGainDb(v: number): number {
  return ((v - 80) / 80) * 9;
}
export function tpGainText(v: number): string {
  const db = f(f(f(f(v / 160) * 2) - 1) * 9);
  const r = roundAway(db * 10) / 10;
  return `${(r === 0 ? 0 : r).toFixed(1)} dB`;
}

/** Split frequency in Hz: 5 Hz .. 1000 Hz, quadratic in the control value. */
export function splitFreqHz(v: number): number {
  const t = v / 160;
  return 5 + 995 * t * t;
}
export function splitFreqText(v: number): string {
  const t = f(v / 160);
  return `${f(5 + f(995 * f(t * t))).toFixed(1)} Hz`;
}

/** Split balance gains: dry (lowpass) and wet (highpass) parts, both 1 at the centre. */
export function splitGains(v: number): { dry: number; wet: number } {
  return { dry: Math.min(1, (160 - v) / 80), wet: Math.min(1, v / 80) };
}
/** "100% Wet" at the centre; "x% Wet" toward the dry side, "x% Dry" toward the wet side. */
export function splitBalanceText(v: number): string {
  const n = f(f(v) / 160);
  const dryRaw = f(2 - f(n * 2));
  if (v <= 80) {
    const wet = f(2 - dryRaw);
    return `${roundEven(f(Math.min(1, wet) * 100))}% Wet`;
  }
  return `${roundEven(f(Math.min(1, dryRaw) * 100))}% Dry`;
}

export const SHAPES = ['Sharp', 'Mid', 'Slow'];

export const def: FxPluginDef = {
  id: 'transient',
  name: 'Transient Processor',
  category: 'Dynamics',
  width: 547,
  height: 318,
  description: 'Attack and release shaping with split filter and saturation',
  // meter graph view (not automatable): input / output peaks, transient process, scroll speed
  state: () => ({ visI: true, visO: true, visS: true, speed: 50 }),
  params: [
    { key: 'attack', name: 'Attack', index: 0, min: 0, max: 160, def: 80, bipolar: true, format: bipolarPctText, parse: (p) => Math.round(80 + (p / 100) * 80) },
    { key: 'drive', name: 'Drive', index: 1, min: 0, max: 160, def: 0, format: drivePctText, parse: (p) => Math.round((p / 100) * 160) },
    { key: 'release', name: 'Release', index: 2, min: 0, max: 160, def: 80, bipolar: true, format: bipolarPctText, parse: (p) => Math.round(80 + (p / 100) * 80) },
    { key: 'gain', name: 'Gain', index: 3, min: 0, max: 160, def: 80, bipolar: true, format: tpGainText, parse: (db) => Math.round(80 + (db / 9) * 80) },
    { key: 'attackShape', name: 'Attack Shape', index: 4, min: 0, max: 2, def: 1, options: SHAPES },
    { key: 'releaseShape', name: 'Release Shape', index: 5, min: 0, max: 2, def: 1, options: SHAPES },
    { key: 'splitFreq', name: 'Split Frequency', index: 6, min: 0, max: 160, def: 80, format: splitFreqText, parse: (hz) => Math.round(160 * Math.sqrt(Math.max(0, (hz - 5) / 995))) },
    { key: 'splitBal', name: 'Split Balance', index: 7, min: 0, max: 160, def: 80, bipolar: true, format: splitBalanceText },
    { key: 'effect', name: 'Effect', index: 8, min: 0, max: 1, def: 1, options: ['Off', 'On'] },
  ],
  // FL's factory presets (Plugin presets/Effects/Transient Processor), values read with the FL host
  presets: [
    { name: 'Default', params: {} },
    { name: 'Expander', params: { release: 36 } },
    { name: 'Max attack', params: { attack: 160, drive: 38, attackShape: 2, splitFreq: 0 } },
    { name: 'Max highs', params: { attack: 160, drive: 38, release: 160, attackShape: 2, releaseShape: 2 } },
    { name: 'Max release', params: { release: 160, releaseShape: 2, splitFreq: 0 } },
    { name: 'Max transients', params: { attack: 160, drive: 38, release: 160, attackShape: 2, releaseShape: 2, splitFreq: 0 } },
    { name: 'Overdiven', params: { attack: 120, drive: 110, release: 160, gain: 53, attackShape: 2, splitFreq: 50 } },
    { name: 'Soft attack', params: { attack: 40, attackShape: 2 } },
    { name: 'Subtle attack', params: { attack: 132, attackShape: 0, splitFreq: 0 } },
    { name: 'Subtle release', params: { release: 120, splitFreq: 0 } },
  ],
};
