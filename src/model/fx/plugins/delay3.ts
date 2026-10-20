// Delay 3 (FL: Fruity Delay 3): analog-style tempo-synced delay with delay
// models, modulation, diffusion, a feedback filter, feedback distortion and
// sample-rate / bit reduction. Form: 747 x 217. Parameter indices, ranges,
// names and value texts were read from FL's own plugin (flfxhost info/sweep);
// the mappings below were measured from its DSP (see docs/research/fx/delay3.md).
// Defaults are FL's "Default" factory preset, which FL loads on insert.

import type { FxParamDef, FxPluginDef } from '../types';

// ---------------------------------------------------------------- mappings

const f32 = Math.fround;

/**
 * Unsynced time: 1 ms .. 1000 ms over raw 1..768. FL's engine law (x = the
 * knob's single-precision position): T = 0.001 + 0.999 ((0.06 + 0.94 x)^3 - 0.06^3) / (1 - 0.06^3).
 */
export function d3TimeMs(v: number): number {
  const x = Math.fround((Math.min(768, Math.max(1, v)) - 1) / 767);
  let t = x * 0.94 + 0.06;
  t = t * t * t;
  t = (t - 0.000216) * 1.0002160466660799;
  return (t * 0.999 + 0.001) * 1000;
}

/** Synced time in beats: raw units are 1/48 step = 1/192 beat (768 = 1 bar). */
export function d3TimeBeats(v: number): number {
  return Math.min(768, Math.max(1, v)) / 192;
}

/** Delay time in seconds for the current mode and tempo. */
export function d3TimeSec(v: number, sync: boolean, tempo: number): number {
  return sync ? (d3TimeBeats(v) * 60) / Math.max(1, tempo) : d3TimeMs(v) / 1000;
}

/** FL's time text: "4.6ms" free, "steps:ticks" (48 ticks per step, unpadded) synced. */
export function d3TimeText(v: number, sync: boolean): string {
  const r = Math.round(v);
  return sync ? `${Math.floor(r / 48)}:${r % 48}` : `${d3TimeMs(r).toFixed(1)}ms`;
}

/** Feedback cutoff tables: knob position x (0..1) -> Hz, linear between quarters. */
const CUT_LP = [270, 480, 1300, 7000, 22000];
const CUT_HP = [20, 90, 400, 1300, 4200];

function table(t: number[], x: number): number {
  const p = Math.min(4, Math.max(0, x * 4));
  const i = Math.min(3, Math.floor(p));
  return t[i] + (t[i + 1] - t[i]) * (p - i);
}

/**
 * Feedback filter cutoff (Hz) for a knob position x = raw/6000 and filter mode
 * (0 LP, 1 HP, 2 BP, 3 off): LP / HP read their tables at x * 3.999, BP reads
 * the LP table at x * 3.6 (FL's engine, single precision).
 */
export function d3CutoffHz(x: number, mode: number): number {
  const F = f32;
  const t = mode === 1 ? CUT_HP : CUT_LP;
  const idx = F(F(Math.min(1, Math.max(0, x))) * F(mode === 2 ? 3.6 : 3.999));
  const i = Math.min(3, Math.max(0, Math.trunc(idx)));
  const u = F(idx - i);
  return F(F(1 - u) * t[i] + F(u * t[i + 1]));
}

/** Output tone: negative = first-order low-pass, positive = high-pass, 0 = off. */
export function d3ToneLpHz(t: number): number {
  return table(CUT_LP, 1 + t);
}
export function d3ToneHpHz(t: number): number {
  return table(CUT_HP, t);
}

/** Feedback filter Q: LP / HP 0.707 + r^2, BP 0.107 + 1.15 r^2 (r = resonance 0..1). */
export function d3FilterQ(r: number, mode: number): number {
  return mode === 2 ? 0.107 + 1.15 * r * r : 0.707 + r * r;
}

/** FL's LFO period table (s), 7 knots, read at index = value x 5.9994 (display) or value x 0.99 x 5.9994 (DSP). */
const RATE_T = [8.872, 3.808, 1.833, 0.878, 0.398, 0.15, 0.05].map((v) => Math.fround(v));

function periodAt(idx: number): number {
  const F = Math.fround;
  const i = Math.min(5, Math.max(0, Math.trunc(idx)));
  const f = F(idx - i);
  return F(F(1 - f) * RATE_T[i] + F(f * RATE_T[i + 1]));
}

/** Modulation rate shown by FL (Hz). */
export function d3ModRateHz(v: number): number {
  const F = Math.fround;
  return F(1 / periodAt(F(F(Math.min(6000, Math.max(0, v)) / 6000) * F(5.9994))));
}

/** The LFO period FL's DSP runs at (s): the table read at 0.99 x the knob, up to 12 % slower than displayed. */
export function d3LfoPeriod(v: number): number {
  const F = Math.fround;
  return periodAt(F(F(F(Math.min(6000, Math.max(0, v)) / 6000) * F(0.99)) * F(5.9994)));
}

/** FL's sample & hold length polynomial (44.1 kHz samples) of s1 (0..127). */
function holdOf(s1: number): number {
  const F = Math.fround;
  const p2 = F(F(s1 * F(0.0002)) * s1), p3 = F(F(s1 * F(-0.0171)) * s1);
  return Math.max(1, F(F(s1 * F(0.7435) + F(p2 * s1 + p3)) + 1));
}

/** Sample-rate reduction as FL displays it: 44100 / hold with s1 = 127 (1 - n) ("Max Hz" at the top). */
export function d3RateHzDisplay(v: number): number {
  const F = Math.fround;
  const n = F(Math.min(60000, Math.max(0, v)) / 60000);
  return F(44100 / holdOf(F(F(1 - n) * 127)));
}

/**
 * The average sample-and-hold rate FL's DSP uses: s1 = 127 (1 - n)^3 (the
 * display uses 1 - n), independent of the sample rate.
 */
export function d3RateHzDsp(v: number): number {
  const F = Math.fround;
  const n = F(Math.min(60000, Math.max(0, v)) / 60000);
  const s = F(1 - n);
  return 44100 / holdOf(F(F(F(s * s) * s) * 127));
}

/** Bit depth: 2 .. 16 bits (16 - 14 sqrt(1 - n)); the maximum bypasses the quantizer. */
export function d3Bits(v: number): number {
  const n = Math.min(6000, Math.max(0, v)) / 6000;
  return 16 - 14 * Math.sqrt(1 - n);
}

/** Saturation / limiter level: drive multiplier 10^(1.425 level) (x26.61, +28.5 dB at 100 %). */
export const D3_DRIVE_LN = 1.425 * Math.LN10;

/** Output scale of the saturator, which is also the limiter threshold (measured every 50 raw units). */
const SAT_C = [
  1, 0.97287011, 0.94618088, 0.91995132, 0.8941986, 0.86893773, 0.84418172, 0.81994152, 0.79622626, 0.77304292, 0.75039709, 0.72829252,
  0.70673114, 0.68571371, 0.66523945, 0.64530623, 0.62591088, 0.60704887, 0.58871496, 0.57090294, 0.55360574, 0.53681558, 0.52052426, 0.5047226,
  0.48940143, 0.47455102, 0.46016115, 0.44622162, 0.43272173, 0.419651, 0.40699854, 0.39475352, 0.38290513, 0.37144247, 0.36035484, 0.34963152,
  0.33926189, 0.32923561, 0.31954229, 0.31017184, 0.30111423, 0.29235986, 0.28389901, 0.27572256, 0.26782119, 0.26018608, 0.25280863, 0.24568033,
  0.23879306, 0.23213881, 0.22570987, 0.21949866, 0.21349806, 0.20770089, 0.20210041, 0.1966901, 0.19146341, 0.18641429, 0.18153681, 0.17682518,
  0.17227386, 0.16787755, 0.16363104, 0.15952942, 0.15556784, 0.15174176, 0.14804679, 0.14447854, 0.14103302, 0.13770634, 0.13449463, 0.13139427,
  0.12840188, 0.12551409, 0.12272771, 0.12003972, 0.11744725, 0.11494744, 0.11253777, 0.11021561, 0.10797866, 0.10582468, 0.10375158, 0.10175723,
  0.099839851, 0.097997643, 0.096229076, 0.094532542, 0.092906743, 0.091350436, 0.089862503, 0.088442042, 0.08708816, 0.085800238, 0.084577791, 0.083420604,
  0.082328357, 0.081301257, 0.080339506, 0.079443656, 0.07861463, 0.077853367, 0.077161297, 0.076540291, 0.075992599, 0.075520828, 0.075128421, 0.074819185,
  0.074597999, 0.074470565, 0.074443638, 0.074525341, 0.074725516, 0.075056024, 0.07553111, 0.076168545, 0.076989591, 0.078021437, 0.07929761, 0.080861002,
  0.082767084,
];
const SAT_LN = SAT_C.map((c) => Math.log(c));
const SAT_N = SAT_LN.length - 1;

/** Saturator output scale / limiter threshold for level l (0..1), Catmull-Rom in the log domain. */
export function d3SatScale(l: number): number {
  const p = Math.min(1, Math.max(0, l)) * SAT_N;
  const i = Math.min(SAT_N - 1, Math.floor(p));
  const t = p - i;
  const y1 = SAT_LN[i], y2 = SAT_LN[i + 1];
  // quadratic extrapolation for the points beyond the ends
  const y0 = i > 0 ? SAT_LN[i - 1] : 3 * y1 - 3 * y2 + SAT_LN[2];
  const y3 = i + 2 <= SAT_N ? SAT_LN[i + 2] : 3 * y2 - 3 * y1 + SAT_LN[SAT_N - 2];
  const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
  const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c = -0.5 * y0 + 0.5 * y2;
  return Math.exp(((a * t + b) * t + c) * t + y1);
}

/**
 * The distortion transfer curve (saturation; the limiter is dynamic and is
 * drawn as a hard ceiling). level, knee, symmetry are 0..1.
 */
export function d3SatCurve(x: number, level: number, knee: number, sym: number): number {
  const c = d3SatScale(level);
  const u = x * Math.exp(level * D3_DRIVE_LN);
  if (u >= 0) {
    const P = 1 + sym;
    return c * P * d3Knee(u / P, knee);
  }
  const N = 1 - sym;
  return N <= 0 ? 0 : -c * N * d3Knee(-u / N, knee);
}

/** Unit soft-knee shape: linear to a, quadratic to the ceiling 1 at 2 - a. */
export function d3Knee(u: number, a: number): number {
  if (u <= a) return u;
  if (u >= 2 - a) return 1;
  return u - ((u - a) * (u - a)) / (4 * (1 - a));
}

// ---------------------------------------------------------------- texts
// FL formats single-precision values with correct (round-half-even) rounding;
// these helpers reproduce its texts exactly (checked against full sweeps).


/** One decimal, round half to even on the exact value (x * 10 must be exact: true for float32 inputs). */
export function d3Fixed1(x: number): string {
  const r = x * 10;
  const fl = Math.floor(r);
  const d = r - fl;
  const k = d > 0.5 ? fl + 1 : d < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1;
  return (k / 10).toFixed(1);
}

/** "62.5%": the knob's single-precision position times 100. */
const pct = (v: number, full: number) => `${d3Fixed1(f32(Math.round(v) / full) * 100)}%`;

export const D3_MODELS = ['Fake Stereo', 'True Stereo', 'Ping Pong', 'OFF'];
export const D3_FILTERS = ['LP', 'HP', 'BP', 'OFF'];
export const D3_DIST = ['Limit', 'Saturate'];

/** Cutoff text, computed in single precision like FL's engine (tables read at x * 3.999, BP x * 3.6). */
export function d3CutoffText(v: number, mode: number): string {
  const F = f32;
  const t = mode === 1 ? CUT_HP : CUT_LP;
  const idx = F(F(Math.round(v) / 6000) * F(mode === 2 ? 3.6 : 3.999));
  const i = Math.min(3, Math.max(0, Math.trunc(idx)));
  const u = F(idx - i);
  const hz = F(F(1 - u) * t[i] + F(u * t[i + 1]));
  return `${d3Fixed1(hz)}Hz`;
}

/** Feedback text: single-precision percent x 1.25 ("62.5%", up to "125.0%"). */
export function d3FeedbackText(v: number): string {
  return `${d3Fixed1(f32(f32(f32(Math.round(v) / 6000) * 100) * 1.25))}%`;
}

export function d3RateText(v: number): string {
  return Math.round(v) >= 60000 ? 'Max Hz' : `${d3Fixed1(d3RateHzDisplay(Math.round(v)))} Hz`;
}

export function d3BitsText(v: number): string {
  return Math.round(v) >= 6000 ? 'Max bits' : `${d3Bits(Math.round(v)).toFixed(1)} bits`;
}

// ---------------------------------------------------------------- definition

/** Parameter keys in FL's parameter-index order. */
const KEYS = [
  'inWet', 'model', 'sync', 'keepPitch', 'time', 'offset', 'smoothing', 'spread', 'modRate', 'modTime', 'modCutoff',
  'diffLevel', 'diffSpread', 'distType', 'feedback', 'filterType', 'cutoff', 'res', 'distLevel', 'distKnee', 'distSym',
  'rate', 'bits', 'wet', 'tone', 'dry',
];

/** A factory preset from FL's 26 raw values in parameter-index order (read with flfxhost info --preset). */
function preset(name: string, raw: number[]): { name: string; params: Record<string, number> } {
  const params: Record<string, number> = {};
  KEYS.forEach((k, i) => { params[k] = raw[i]; });
  return { name, params };
}

const onOff = ['Off', 'On'];
const p = (q: FxParamDef) => q;

export const def: FxPluginDef = {
  id: 'delay3',
  name: 'Delay 3',
  category: 'Delay reverb',
  width: 747,
  height: 217,
  description: 'Analog-style tempo-synced delay with modulation, diffusion, feedback filter and distortion',
  params: [
    p({ key: 'inWet', name: 'Input wet', index: 0, min: 0, max: 6000, def: 6000, format: (v) => pct(v, 6000) }),
    p({ key: 'model', name: 'Delay type', index: 1, min: 0, max: 3, def: 1, options: D3_MODELS }),
    p({ key: 'sync', name: 'Tempo sync', index: 2, min: 0, max: 1, def: 1, options: onOff }),
    p({ key: 'keepPitch', name: 'Keep pitch', index: 3, min: 0, max: 1, def: 0, options: onOff }),
    // the text follows Tempo sync (steps:ticks synced, ms free)
    p({ key: 'time', name: 'Time', index: 4, min: 1, max: 768, def: 192, format: (v, st) => d3TimeText(v, st ? Number(st.sync ?? 1) >= 0.5 : true) }),
    p({ key: 'offset', name: 'Delay time R/L offset', index: 5, min: 0, max: 6000, def: 3000, bipolar: true, format: (v) => `${((v - 3000) / 30).toFixed(1)}%` }),
    p({ key: 'smoothing', name: 'Time smooth', index: 6, min: 0, max: 1000, def: 500, format: (v) => pct(v, 1000) }),
    p({ key: 'spread', name: 'Stereo spread', index: 7, min: 0, max: 6000, def: 6000, format: (v) => pct(v, 6000) }),
    p({ key: 'modRate', name: 'Modulation rate', index: 8, min: 0, max: 6000, def: 3000, format: (v) => `${d3ModRateHz(v).toFixed(1)}Hz` }),
    p({ key: 'modTime', name: 'Modulation time', index: 9, min: 0, max: 6000, def: 0, format: (v) => pct(v, 6000) }),
    p({ key: 'modCutoff', name: 'Modulation cutoff', index: 10, min: 0, max: 6000, def: 0, format: (v) => pct(v, 6000) }),
    p({ key: 'diffLevel', name: 'Diffusion level', index: 11, min: 0, max: 6000, def: 0, format: (v) => pct(v, 6000) }),
    p({ key: 'diffSpread', name: 'Diffusion spread', index: 12, min: 0, max: 6000, def: 0, format: (v) => pct(v, 6000) }),
    p({ key: 'distType', name: 'Distortion type', index: 13, min: 0, max: 1, def: 1, options: D3_DIST }),
    p({ key: 'feedback', name: 'Feedback level', index: 14, min: 0, max: 6000, def: 3000, format: d3FeedbackText }),
    p({ key: 'filterType', name: 'Filter mode', index: 15, min: 0, max: 3, def: 0, options: D3_FILTERS }),
    // the text depends on Filter mode (passed by the editor); LP form elsewhere
    p({ key: 'cutoff', name: 'Feedback cutoff', index: 16, min: 0, max: 6000, def: 6000, format: (v) => d3CutoffText(v, 0) }),
    p({ key: 'res', name: 'Feedback resonance', index: 17, min: 0, max: 6000, def: 0, format: (v) => pct(v, 6000) }),
    // FL names all three feedback distortion wheels "Distortion" (level, knee, symmetry)
    p({ key: 'distLevel', name: 'Distortion', index: 18, min: 0, max: 6000, def: 0, format: (v) => pct(v, 6000) }),
    p({ key: 'distKnee', name: 'Distortion', index: 19, min: 0, max: 6000, def: 0, format: (v) => pct(v, 6000) }),
    p({ key: 'distSym', name: 'Distortion', index: 20, min: 0, max: 6000, def: 0, format: (v) => pct(v, 6000) }),
    p({ key: 'rate', name: 'Rate reduction', index: 21, min: 0, max: 60000, def: 60000, format: d3RateText }),
    p({ key: 'bits', name: 'Bits reduction', index: 22, min: 0, max: 6000, def: 6000, format: d3BitsText }),
    p({ key: 'wet', name: 'Output wet', index: 23, min: 0, max: 6000, def: 6000, format: (v) => pct(v, 6000) }),
    p({ key: 'tone', name: 'Output tone', index: 24, min: -3000, max: 3000, def: 0, bipolar: true, format: (v) => `${(v / 30).toFixed(1)}%` }),
    p({ key: 'dry', name: 'Output dry', index: 25, min: 0, max: 6000, def: 6000, format: (v) => pct(v, 6000) }),
  ],
  presets: [
    preset('Bandpass', [6000, 1, 1, 1, 144, 3000, 500, 6000, 3000, 1275, 0, 0, 0, 1, 3000, 2, 3562, 2138, 2485, 0, 0, 60000, 6000, 6000, 0, 6000]),
    preset('Chorus', [6000, 1, 0, 0, 0, 3000, 500, 6000, 1032, 3806, 0, 0, 0, 0, 0, 0, 4950, 0, 0, 0, 0, 60000, 6000, 6000, 0, 6000]),
    preset('Default', [6000, 1, 1, 0, 192, 3000, 500, 6000, 3000, 0, 0, 0, 0, 1, 3000, 0, 6000, 0, 0, 0, 0, 60000, 6000, 6000, 0, 6000]),
    preset('Diffused', [6000, 1, 1, 0, 144, 3000, 500, 6000, 3000, 0, 0, 5025, 5082, 0, 3038, 0, 5137, 0, 492, 0, 0, 60000, 6000, 6000, 900, 6000]),
    preset('Mono', [6000, 0, 1, 0, 96, 3000, 500, 6000, 3000, 0, 0, 0, 0, 1, 3506, 0, 4481, 0, 399, 0, 0, 60000, 6000, 6000, 0, 6000]),
    preset('Ping pong', [6000, 2, 1, 1, 96, 0, 500, 6000, 2109, 1819, 0, 0, 0, 1, 3000, 0, 4612, 975, 398, 0, 0, 60000, 6000, 6000, 0, 6000]),
    preset('Resonator', [6000, 1, 0, 0, 37, 3000, 500, 6000, 3000, 0, 0, 0, 0, 0, 4200, 0, 4762, 0, 2390, 0, 0, 60000, 6000, 2997, 0, 6000]),
    preset('Saturated', [6000, 1, 1, 1, 192, 3000, 500, 6000, 3000, 1819, 0, 0, 0, 1, 3000, 0, 4744, 975, 2086, 492, 0, 60000, 6000, 6000, 0, 6000]),
    preset('Stereoized', [6000, 0, 1, 0, 144, 3469, 500, 6000, 3000, 0, 0, 0, 0, 1, 2681, 0, 4481, 0, 399, 0, 0, 60000, 6000, 6000, 1088, 6000]),
    preset('Tape', [6000, 1, 1, 1, 144, 3000, 500, 6000, 1969, 2737, 0, 0, 0, 1, 3000, 0, 3787, 919, 258, 0, 0, 60000, 6000, 6000, 900, 6000]),
  ],
};
