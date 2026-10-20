// Frequency Shifter (FL: Frequency Shifter): single-sideband frequency
// shifting (Hilbert transformer), with an HQ variant, and a ring modulator
// driven by an oscillator or a sidechain input. Form: 460 x 220. Parameters
// (FL Tags): 0 Dry/Wet mix, 1 Type (HQ / shifter / ring modulator),
// 2 Frequency (-70000..70000, exponential: 0.1 Hz * 200000^|x| in the 20 kHz
// range, 0.1 Hz * 2000^|x| in the 200 Hz range, 2^(7(1-|x|)) steps per cycle
// in the tempo range), 3 L/R Phase, 4 / 5 Left / Right shape (sideband),
// 6 Feedback, 7 Stereo, 8 range ("Type": 20kHz / 200Hz / Tempo),
// 9 Start phase. Value texts are FL's (flfxhost sweeps). FL's insert state is
// its Default preset: HQ, 200 Hz range at +200 Hz.

import type { FxPluginDef } from '../types';

export const FS_TYPES = ['Frequency Shifter HQ', 'Frequency Shifter', 'Ring Modulator'];
export const FS_RANGES = ['20kHz', '200Hz', 'Tempo'];
export const FS_FREQ_MAX = 70000;

/** FL normalises the frequency control to s = 2 * (raw + 70000) / 140000 - 1 in single precision. */
export function fsNorm(raw: number): number {
  const n = Math.fround((Math.min(FS_FREQ_MAX, Math.max(-FS_FREQ_MAX, raw)) + FS_FREQ_MAX) / (2 * FS_FREQ_MAX));
  return Math.fround(Math.fround(2 * n) - 1);
}

/** Cycle length in steps in the tempo range: 2^(7(1 - |s|)), 1 step at the ends, 128 steps at the centre. */
export function fsTempoSteps(raw: number): number {
  const s = fsNorm(raw);
  return Math.fround(Math.pow(2, Math.fround(7 * Math.fround(1 - Math.abs(s)))));
}

/** Shift in Hz for a frequency control value, range and tempo (0 Hz exactly at 0). */
export function fsHz(raw: number, range: number, tempo = 120): number {
  if (raw === 0) return 0;
  const s = fsNorm(raw);
  const sign = s < 0 ? -1 : 1;
  const a = Math.abs(s);
  if (range === 2) {
    const steps = fsTempoSteps(raw);
    return (sign * (tempo * 4)) / 60 / steps;
  }
  const base = range === 0 ? 200000 : 2000;
  return sign * 0.1 * Math.pow(base, a);
}

/**
 * Ring modulator frequency: FL's ring curve is the geometric mean of the
 * shifter frequency and the range's top (20 kHz, 200 Hz or one step); the
 * modulator stops (0 Hz) for negative values.
 */
export function fsRingHz(raw: number, range: number, tempo = 120): number {
  const hz = fsHz(raw, range, tempo);
  const top = range === 2 ? (tempo * 4) / 60 : range === 0 ? 20000 : 200;
  return hz > 0 ? Math.sqrt(top * hz) : 0;
}

/**
 * FL's frequency text: "0.24Hz", "18.7Hz", "1462Hz"; tempo range "steps:ticks"
 * (48 ticks a step). In ring modulation (type 2) it shows the ring frequency.
 */
export function fsFreqText(raw: number, range: number, type = 0): string {
  const ring = type === 2;
  if (range === 2) {
    let p = fsTempoSteps(raw);
    if (ring) p = raw > 0 ? Math.sqrt(p) : 0;
    const whole = Math.floor(p);
    const ticks = Math.floor((p - whole) * 48);
    return `${raw < 0 && !ring ? '-' : ''}${whole}:${ticks}`;
  }
  const hz = ring ? fsRingHz(raw, range) : fsHz(raw, range);
  const a = Math.abs(hz);
  const txt = a < 10 ? a.toFixed(2) : a < 100 ? a.toFixed(1) : Math.round(a).toString();
  return `${hz < 0 && Number(txt) !== 0 ? '-' : ''}${txt}Hz`;
}

/** Delphi Round (half to even). */
function roundEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

export function fsMixText(v: number): string {
  return v < 5000 ? `${roundEven(100 - v / 100)}% Dry` : `${roundEven(v / 100)}% Wet`;
}

/** Bipolar percentage with one decimal: 0 -> "-100.0%", 5000 -> "0.0%". */
export function fsBipolarText(v: number): string {
  return `${((v - 5000) / 50).toFixed(1)}%`;
}

export const def: FxPluginDef = {
  id: 'freqshifter',
  name: 'Frequency Shifter',
  category: 'Misc',
  width: 460,
  height: 220,
  description: 'Frequency shifter (single sideband) and ring modulator',
  params: [
    { key: 'mix', name: 'Dry/Wet mix', index: 0, min: 0, max: 10000, def: 10000, format: fsMixText },
    { key: 'type', name: 'Type', index: 1, min: 0, max: 2, def: 0, options: FS_TYPES },
    // the text depends on the range parameter; the editor shows fsFreqText(value, range)
    { key: 'freq', name: 'Frequency', index: 2, min: -FS_FREQ_MAX, max: FS_FREQ_MAX, def: 70000, bipolar: true, format: (v) => fsFreqText(v, 1) },
    { key: 'lrphase', name: 'L/R Phase', index: 3, min: 0, max: 10000, def: 0, format: fsBipolarText },
    { key: 'lshape', name: 'Left shape', index: 4, min: 0, max: 10000, def: 10000, bipolar: true, format: fsBipolarText },
    { key: 'rshape', name: 'Right Shape', index: 5, min: 0, max: 10000, def: 10000, bipolar: true, format: fsBipolarText },
    { key: 'feedback', name: 'Feedback', index: 6, min: 0, max: 10000, def: 5000, bipolar: true, format: fsBipolarText },
    { key: 'stereo', name: 'Stereo', index: 7, min: 0, max: 10000, def: 10000, format: (v) => `${roundEven(v / 100)}% Stereo` },
    { key: 'range', name: 'Type', index: 8, min: 0, max: 2, def: 1, options: FS_RANGES },
    { key: 'start', name: 'Start phase', index: 9, min: 0, max: 10000, def: 5000, bipolar: true, format: fsBipolarText },
  ],
  state: () => ({
    /** Sidechain source (mixer track number, 0 = none) for the ring modulator. */
    sidechain: 0,
    /** Shape knobs linked (the link button between L and R). */
    link: true,
    /** Visualiser: 0 spectrum, 1 oscilloscope. */
    vis: 0,
  }),
  // FL's factory presets (values read with flfxhost --preset)
  presets: [
    { name: '+800 Hz', params: { freq: 51542, range: 0 } },
    { name: '-800 Hz', params: { freq: -51537, range: 0 } },
    { name: 'Default', params: {} },
    { name: 'Dry', params: { type: 1, freq: 0 } },
    { name: 'Phaser', params: { mix: 4960, freq: 29990, range: 2 } },
    { name: 'Phaser feedback', params: { mix: 4960, freq: 29990, lshape: 0, feedback: 8751, range: 2 } },
    { name: 'Phaser stereo', params: { mix: 4960, freq: 29990, lshape: 0, range: 2 } },
    { name: 'Ring mod', params: { mix: 4960, type: 2 } },
    { name: 'Stereoizer', params: { freq: 0, lrphase: 8751 } },
  ],
};
