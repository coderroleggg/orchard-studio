// Vocoder (FL: Fruity Vocoder): zero-latency filter-bank vocoder. The left
// channel is the modulator and the right channel the carrier (swappable).
// Form: 406 x 300. Parameters 0..11 are FL's (names, ranges, defaults and value
// texts read from the plugin through the FL test host); the band count, filter
// order, listen mode, L/R swap and per-band levels are FL's non-parameter state
// (the plugin's saved state, version 2, holds them in the same order).

import type { FxPluginDef, FxParams } from '../types';

/** Band counts offered by the BANDS selector. */
export const VOC_BANDS = [4, 8, 16, 32, 64, 128];
/** Filter orders offered by the FILTER selector. */
export const VOC_ORDERS = [1, 2, 3];
/** Listen selector: solo modulator, solo carrier, normal (wet) output. */
export const VOC_LISTEN = ['Modulator', 'Carrier', 'Wet'];

/** Frequency of the MIN / MAX knobs (0..65536): 10 Hz .. 16 kHz on FL's (101^x - 1) curve. */
export function vocKnobHz(v: number): number {
  return 10 + (15990 * (Math.pow(101, v / 65536) - 1)) / 100;
}

/** Level sliders (0..160, 128 = 100%): gain (11^(v/128) - 1) / 10, so 64 is -12.7 dB and 160 is +5.6 dB. */
export function vocLevelGain(v: number): number {
  return (Math.pow(11, v / 128) - 1) / 10;
}

/**
 * Band edges for `n` bands between fmin and fmax: FL's scale curve
 * e_k = fmin + (fmax - fmin) (B^(k/n) - 1) / (B - 1) with B = 1 + 10^(4 scale),
 * scale = 0..1 (B = 2 at 0%, 101 at 50%, 10001 at 100%). Band i is centred at
 * sqrt(e_i e_(i+1)) and spans log2(e_(i+1) / e_i) octaves.
 */
export function vocEdges(n: number, fmin: number, fmax: number, scale: number, out?: Float64Array): Float64Array {
  const e = out && out.length >= n + 1 ? out : new Float64Array(n + 1);
  const B = 1 + Math.pow(10, 4 * scale);
  const inv = 1 / (B - 1);
  for (let k = 0; k <= n; k++) e[k] = fmin + (fmax - fmin) * (Math.pow(B, k / n) - 1) * inv;
  return e;
}

const pct128 = (v: number) => `${Math.round((v / 128) * 100)}%`;
const onOff = (v: number) => (v >= 0.5 ? 'ON' : 'OFF');

/** Formant text: "+0.00 cent", "-1.00 cent", "+250.00 cents". */
export function vocFormantText(v: number): string {
  const a = Math.abs(v);
  return `${v < 0 ? '-' : '+'}${a.toFixed(2)} ${a <= 1 ? 'cent' : 'cents'}`;
}

export interface VocoderState {
  /** Index into VOC_BANDS. */
  bands: number;
  /** Filter order 1..3. */
  order: number;
  /** 0 = modulator, 1 = carrier, 2 = wet. */
  listen: number;
  /** Modulator taken from the right channel (carrier from the left). */
  swap: boolean;
  /** Per-band output levels (1 = 0 dB), one per band. */
  levels: number[];
}

export const VOC_DEFAULT_BANDS = 2; // 16 bands, FL's default

export function vocBandCount(p: FxParams): number {
  const i = typeof p.bands === 'number' ? Math.round(p.bands) : VOC_DEFAULT_BANDS;
  return VOC_BANDS[Math.min(VOC_BANDS.length - 1, Math.max(0, i))];
}

/**
 * Resample a band-level curve to a new band count (the curve is kept when the
 * band count changes): nearest band by relative position.
 */
export function vocResampleLevels(levels: number[], n: number): number[] {
  if (levels.length === n) return levels.slice();
  if (levels.length === 0) return new Array(n).fill(1);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.min(levels.length - 1, Math.floor(((i + 0.5) / n) * levels.length));
    out[i] = levels[j];
  }
  return out;
}

export const def: FxPluginDef = {
  id: 'vocoder',
  name: 'Vocoder',
  category: 'Misc',
  width: 406,
  height: 300,
  description: 'Filter-bank vocoder: modulator on the left channel, carrier on the right',
  params: [
    { key: 'fmin', name: 'Starting freq', index: 0, min: 0, max: 65536, def: 0, format: (v) => `${Math.round(vocKnobHz(v))}Hz` },
    { key: 'fmax', name: 'Ending freq', index: 1, min: 0, max: 65536, def: 65536, format: (v) => `${Math.round(vocKnobHz(v))}Hz` },
    { key: 'scale', name: 'Freq scale', index: 2, min: 0, max: 128, def: 64, format: pct128 },
    { key: 'invert', name: 'Invert modulator freqs', index: 3, min: 0, max: 1, def: 0, options: ['OFF', 'ON'], format: onOff },
    { key: 'formant', name: 'Formant', index: 4, min: -1200, max: 1200, def: 0, bipolar: true, format: vocFormantText, parse: (c) => Math.round(c) },
    { key: 'bw', name: 'Bandwidth', index: 5, min: 5, max: 200, def: 50, format: (v) => `${Math.round(v / 2)}%`, parse: (p) => Math.round(p * 2) },
    { key: 'att', name: 'Attack', index: 6, min: 10, max: 1000, def: 20, format: (v) => `${Math.round(v)}ms`, parse: (ms) => Math.round(ms) },
    { key: 'rel', name: 'Release', index: 7, min: 10, max: 1000, def: 100, format: (v) => `${Math.round(v)}ms`, parse: (ms) => Math.round(ms) },
    { key: 'hold', name: 'Hold modulator', index: 8, min: 0, max: 1, def: 0, options: ['OFF', 'ON'], format: onOff },
    { key: 'modLvl', name: 'Modulator level', index: 9, min: 0, max: 160, def: 0, format: pct128 },
    { key: 'carLvl', name: 'Carrier level', index: 10, min: 0, max: 160, def: 0, format: pct128 },
    { key: 'wetLvl', name: 'Wet level', index: 11, min: 0, max: 160, def: 128, format: pct128 },
  ],
  state: () => ({ bands: VOC_DEFAULT_BANDS, order: 2, listen: 2, swap: false, levels: new Array(16).fill(1) }),
  // FL's factory presets (read from FL's preset files through the test host)
  presets: [
    {
      name: 'Clear',
      params: {
        bw: 87, bands: 3, order: 2,
        levels: [
          0.80076, 0.80076, 0.8469, 0.8469, 0.8469, 0.89541, 0.89541, 0.9464, 0.9464, 0.9464, 1, 1, 1, 1.0563, 1.0563, 1.1156,
          1.1156, 1.1156, 1.1778, 1.1778, 1.1778, 1.2433, 1.2433, 1.3121, 1.3121, 1.3121, 1.3845, 1.3845, 1.3845, 1.4605, 1.4605, 1.5404,
        ],
      },
    },
    { name: 'Default', params: {} },
  ],
  normalize: (p) => {
    const n = vocBandCount(p);
    const order = typeof p.order === 'number' ? Math.min(3, Math.max(1, Math.round(p.order))) : 2;
    const listen = typeof p.listen === 'number' ? Math.min(2, Math.max(0, Math.round(p.listen))) : 2;
    const raw = Array.isArray(p.levels) ? (p.levels as unknown[]).map((x) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, x) : 1)) : [];
    return { ...p, order, listen, swap: !!p.swap, levels: vocResampleLevels(raw.length ? raw : new Array(n).fill(1), n) };
  },
};
