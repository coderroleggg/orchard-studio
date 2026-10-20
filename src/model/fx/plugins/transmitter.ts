// Transmitter (FL Studio 2026): a zero-latency transient detector that splits
// the input into complementary Transient and Sustain parts, each with its own
// tilt EQ, effect (saturation, bounce, diffusion, blur, delay), level and
// optional send to another mixer track. Form: 740 x 366.
//
// Parameters 0..32 are FL's automatable parameters (Transmitter reports 33);
// the switches and selectors with Tags 33..41 are stored in the same state but
// are not automatable in FL (noAuto). Ranges, names and value texts were read
// from the real plugin (flfxhost info / sweep); defaults are FL's factory
// "Default" preset, which FL applies on insert (the constructor state has both
// levels at -120 dB).

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';

/** FL's number texts never show "-0.0". */
export function fix(v: number, digits: number): string {
  const s = v.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
}

/** Hold / release time in ms: 1 .. 250 ms, linear. */
export const holdMs = (v: number) => 1 + (249 * v) / 10000;
/** Level slider (0..12800) in dB: -120 + 132·(v/12800)^0.25 (8743 = 0 dB). */
export const levelDb = (v: number) => -120 + 132 * Math.pow(Math.max(0, v) / 12800, 0.25);
export const levelFromDb = (db: number) => Math.round(12800 * Math.pow(Math.max(0, (db + 120) / 132), 4));
/** Tilt in dB at the high end (the low end gets the opposite), -6 .. +6. */
export const tiltDb = (v: number) => ((v - 5000) / 5000) * 6;
/** Diffuser depth 0 .. 0.99. */
export const diffDepth = (v: number) => (0.99 * v) / 10000;
/** Diffuser delay ("length of the diffusion field") 0.1 .. 10 s, logarithmic. */
export const diffDelaySec = (v: number) => 0.1 * Math.pow(100, v / 10000);
/** Saturation drive 0 .. 18 dB. */
export const driveDb = (v: number) => (18 * v) / 10000;
/** Bounce curves -1 .. 1. */
export const curve = (v: number) => (v - 5000) / 5000;
/** Delay time 1 ms .. 2 s, quadratic. */
export const delaySec = (v: number) => 0.001 + 1.999 * Math.pow(v / 10000, 2);
/** Tempo-synced delay: steps:ticks with 48 ticks per step (1..768 = 16 steps). */
export const syncText = (v: number) => `${Math.floor(v / 48)}:${Math.round(v) % 48}`;
export const syncSteps = (v: number) => v / 48;

export const FX_NAMES = ['SATURATION', 'BOUNCE', 'DIFFUSION', 'BLUR', 'DELAY', 'OFF'];
export const FX_HINTS = ['Saturation', 'Bounce', 'Diffusion', 'Blur', 'Delay', 'Off'];
export const MODE_NAMES = ['SMOOTH', 'BALANCED', 'DENSE'];
export const FX = { SAT: 0, BOUNCE: 1, DIFF: 2, BLUR: 3, DELAY: 4, OFF: 5 } as const;

// FL normalises the control value in single precision (v / 10000 as a float)
// before scaling it in double precision; reproducing that gets the rounding of
// every value text right (e.g. 2450 -> "0.25", 3150 -> "0.31").
const n32 = (v: number, span = 10000) => Math.fround(v / span);
const f2 = (v: number) => fix(n32(v), 2);
const ms = (v: number) => fix(1 + 249 * n32(v), 1) + ' ms';
const lvl = (v: number) => fix(-120 + 132 * Math.pow(n32(v, 12800), 0.25), 1);
const tilt = (v: number) => fix((n32(v) - 0.5) * 12, 1);
const depth = (v: number) => fix(n32(v) * 0.99, 2);
const ddel = (v: number) => fix(0.1 * Math.pow(100, n32(v)), 2) + ' s';
const drive = (v: number) => fix(n32(v) * 18, 1);
const crv = (v: number) => fix((n32(v) - 0.5) * 2, 1);
const dly = (v: number) => { const x = n32(v); return fix(0.001 + 1.999 * x * x, 3) + ' s'; };
const onOff = (v: number) => (v ? 'On' : 'Off');

const P = (key: string, name: string, index: number, def: number, format: (v: number) => string, extra: Partial<FxParamDef> = {}): FxParamDef => ({
  key, name, index, min: 0, max: 10000, def, format, ...extra,
});

/** Parameter keys in FL's index order (0..41). */
export const KEYS = [
  'sens', 'hold', 'release', 'tLevel', 'sLevel', 'tTilt', 'sTilt',
  'tDiffMix', 'tDiffDepth', 'tDiffDelay', 'sDiffMix', 'sDiffDepth', 'sDiffDelay',
  'tSatMix', 'tSatDrive', 'tSatWarmth', 'sSatMix', 'sSatDrive', 'sSatWarmth',
  'tBncMix', 'tBncAmp', 'tBncTime', 'sBncMix', 'sBncAmp', 'sBncTime',
  'tDlyMix', 'tDlyTime', 'tDlySync', 'tDlyFb', 'sDlyMix', 'sDlyTime', 'sDlySync', 'sDlyFb',
  'lookahead', 'stereoLink', 'mode', 'tOn', 'sOn', 'tFx', 'sFx', 'tTempo', 'sTempo',
] as const;

const params: FxParamDef[] = [
  P('sens', 'Sensitivity', 0, 7475, f2),
  P('hold', 'Hold time', 1, 1968, ms, { parse: (t) => Math.round(((t - 1) * 10000) / 249) }),
  P('release', 'Release time', 2, 1968, ms, { parse: (t) => Math.round(((t - 1) * 10000) / 249) }),
  P('tLevel', 'Transient level', 3, 8743, lvl, { max: 12800, parse: levelFromDb }),
  P('sLevel', 'Sustain level', 4, 8743, lvl, { max: 12800, parse: levelFromDb }),
  P('tTilt', 'Transient tilt', 5, 5000, tilt, { bipolar: true, parse: (db) => Math.round(5000 + (db / 6) * 5000) }),
  P('sTilt', 'Sustain tilt', 6, 5000, tilt, { bipolar: true, parse: (db) => Math.round(5000 + (db / 6) * 5000) }),
  P('tDiffMix', 'Transient diffuser mix', 7, 10000, f2),
  P('tDiffDepth', 'Transient diffuser depth', 8, 9112, depth),
  P('tDiffDelay', 'Transient diffuser delay', 9, 0, ddel),
  P('sDiffMix', 'Sustain diffuser mix', 10, 5000, f2),
  P('sDiffDepth', 'Sustain diffuser depth', 11, 5051, depth),
  P('sDiffDelay', 'Sustain diffuser delay', 12, 5000, ddel),
  P('tSatMix', 'Transient saturation mix', 13, 10000, f2),
  P('tSatDrive', 'Transient saturation drive', 14, 3333, drive),
  P('tSatWarmth', 'Transient saturation warmth', 15, 0, f2),
  P('sSatMix', 'Sustain saturation mix', 16, 10000, f2),
  P('sSatDrive', 'Sustain saturation drive', 17, 3342, drive),
  P('sSatWarmth', 'Sustain saturation warmth', 18, 0, f2),
  P('tBncMix', 'Transient bounce mix', 19, 10000, f2),
  P('tBncAmp', 'Transient bounce amp curve', 20, 5320, crv, { bipolar: true }),
  P('tBncTime', 'Transient bounce delay curve', 21, 5275, crv, { bipolar: true }),
  P('sBncMix', 'Sustain bounce mix', 22, 10000, f2),
  P('sBncAmp', 'Sustain bounce amp curve', 23, 4443, crv, { bipolar: true }),
  P('sBncTime', 'Sustain bounce delay drive', 24, 4642, crv, { bipolar: true }),
  P('tDlyMix', 'Transient delay mix', 25, 10000, f2),
  P('tDlyTime', 'Transient delay delay', 26, 3531, dly),
  P('tDlySync', 'Transient delay delay', 27, 144, syncText, { min: 1, max: 768 }),
  P('tDlyFb', 'Transient delay feedback', 28, 0, f2),
  P('sDlyMix', 'Sustain delay mix', 29, 10000, f2),
  P('sDlyTime', 'Sustain delay delay', 30, 3156, dly),
  P('sDlySync', 'Sustain delay delay', 31, 240, syncText, { min: 1, max: 768 }),
  P('sDlyFb', 'Sustain delay feedback', 32, 0, f2),
  // switches and selectors (not automatable in FL)
  { key: 'lookahead', name: 'Lookahead', index: 33, min: 0, max: 1, def: 1, format: onOff, noAuto: true },
  { key: 'stereoLink', name: 'Stereo link', index: 34, min: 0, max: 1, def: 1, format: onOff, noAuto: true },
  { key: 'mode', name: 'Detection mode', index: 35, min: 0, max: 2, def: 1, options: ['Smooth', 'Balanced', 'Dense'], noAuto: true },
  { key: 'tOn', name: 'Transient enabled', index: 36, min: 0, max: 1, def: 1, format: onOff, noAuto: true },
  { key: 'sOn', name: 'Sustain enabled', index: 37, min: 0, max: 1, def: 1, format: onOff, noAuto: true },
  { key: 'tFx', name: 'Transient FX', index: 38, min: 0, max: 5, def: 0, options: FX_HINTS, noAuto: true },
  { key: 'sFx', name: 'Sustain FX', index: 39, min: 0, max: 5, def: 2, options: FX_HINTS, noAuto: true },
  { key: 'tTempo', name: 'Transient tempo-based time', index: 40, min: 0, max: 1, def: 0, format: onOff, noAuto: true },
  { key: 'sTempo', name: 'Sustain tempo-based time', index: 41, min: 0, max: 1, def: 0, format: onOff, noAuto: true },
];

// FL's factory presets: values of parameters 0..41 (state blob order).
const PRESETS: [string, number[]][] = [
  ['Adding presence', [10000,1575,0,8743,8743,7140,2045,10000,5051,1469,1215,3099,0,4165,2243,6917,0,0,0,428,9970,5468,6242,22,2932,4343,968,144,0,10000,5715,240,2220,1,0,1,1,1,4,2,0,1]],
  ['Attack delayer', [10000,442,5273,8743,8743,6653,5000,10000,5051,1469,10000,5051,1469,10000,0,10000,0,0,0,9865,6082,6232,10000,7500,7500,1463,2225,144,4710,10000,5715,240,2220,1,0,1,1,1,4,5,1,1]],
  ['Blown away transients', [7475,964,2972,8743,8743,5000,5000,10000,5051,1469,10000,5051,5000,10000,5013,0,10000,3342,10000,2686,6368,2438,3950,7500,7560,4343,968,144,0,10000,5715,240,2220,1,1,1,1,1,2,0,0,1]],
  ['Body shift', [7475,964,2972,8743,8743,5000,5000,10000,5051,5000,10000,2043,0,10000,5013,0,10000,3342,10000,2686,6368,2438,3950,7500,7560,4343,968,144,0,10000,3156,240,0,1,1,1,1,1,5,4,0,0]],
  ['Body swing', [7475,964,2972,8743,8743,5000,5000,10000,5051,5000,10000,2043,0,10000,5013,0,10000,3342,10000,2686,6368,2438,3950,7500,7560,4343,968,144,0,10000,5715,240,2220,1,1,1,1,1,5,2,0,1]],
  ['Bottled wind', [10000,0,990,8743,8743,3292,1160,10000,5051,1469,5132,3180,0,4165,2243,6917,0,0,0,428,9970,5468,6242,22,2932,3870,1760,144,0,10000,5715,240,2220,1,0,1,1,1,0,2,0,1]],
  ['Bouncing transient with normal sustain', [10000,0,3218,8743,8743,8458,2963,10000,5051,1469,1215,3099,0,0,0,0,0,0,0,2686,6368,2438,3039,1147,7560,4343,968,144,0,10000,5715,240,2220,1,0,0,1,1,1,5,0,1]],
  ['Clouds', [7475,964,2972,8743,8743,5000,5000,10000,5051,5000,10000,2043,0,10000,5013,0,10000,3342,10000,7968,4281,4250,7994,5493,5479,4343,968,144,0,10000,3156,240,0,1,1,1,1,1,1,1,0,0]],
  ['Colliding clouds', [7475,964,2972,8743,8743,5000,5000,10000,5051,5000,10000,2043,0,10000,5013,0,10000,3342,10000,10000,8901,931,10000,1212,8830,4343,968,144,0,10000,3156,240,0,1,1,1,1,1,1,1,0,0]],
  ['Default', [7475,1968,1968,8743,8743,5000,5000,10000,9112,0,5000,5051,5000,10000,3333,0,10000,3342,0,10000,5320,5275,10000,4443,4642,10000,3531,144,0,10000,3156,240,0,1,1,1,1,1,0,2,0,0]],
  ['Drum accentor', [5000,0,2122,7893,8743,5603,5492,10000,5051,1469,3136,3016,0,10000,7388,6503,0,0,0,2686,6368,2438,3669,10000,0,4343,968,144,0,2433,2207,49,0,1,0,0,1,1,0,2,0,0]],
  ['Drum toms stage positioning', [5000,210,3075,8743,8743,6740,3222,1906,2096,0,1215,3099,0,0,0,0,0,0,0,2686,6368,2438,3039,1147,7560,4343,4058,144,0,2748,2385,240,0,1,0,0,1,1,2,4,0,0]],
  ['Drumkit sharpener', [5000,0,2122,7893,8743,5603,5000,10000,5051,1469,1215,3099,0,10000,7388,6503,0,0,0,2686,6368,2438,3039,1147,7560,4343,968,144,0,10000,5715,240,2220,1,0,0,1,1,0,5,0,1]],
  ['Electric bass driver', [4961,7930,0,8743,8743,7307,9177,10000,5051,1469,1215,3099,0,8005,6775,0,1470,10000,10000,2686,6368,2438,3039,1147,7560,4343,968,144,0,10000,5715,240,2220,1,0,0,1,1,0,0,0,1]],
  ['Full body', [7475,964,2972,8743,8743,5000,5000,10000,5051,1469,10000,5051,5000,10000,0,0,10000,6667,10000,2686,6368,2438,3950,7500,7560,4343,968,144,0,10000,5715,240,2220,1,1,1,1,1,5,0,0,1]],
  ['Full fat', [7475,964,2972,8743,8743,5000,5000,10000,5051,1469,10000,5051,5000,10000,5013,0,10000,6667,10000,2686,6368,2438,3950,7500,7560,4343,968,144,0,10000,5715,240,2220,1,1,1,1,1,0,0,0,1]],
  ['Many worlds', [7475,964,2972,8743,8743,5000,5000,10000,5051,5000,10000,2043,0,10000,5013,0,10000,3342,10000,10000,5320,5275,10000,4443,4642,4343,968,144,0,10000,3156,240,0,1,1,1,1,1,1,1,0,0]],
  ['Sharp transients', [7475,964,2972,8743,8743,5000,5000,10000,5051,1469,10000,5051,5000,10000,3356,0,0,0,0,2686,6368,2438,3950,7500,7560,4343,968,144,0,10000,5715,240,2220,1,1,1,1,1,0,5,0,1]],
  ['Soft bouncing transient', [10000,4784,3200,8743,8743,8458,2963,10000,5051,1469,1215,3099,0,0,0,0,0,0,0,2686,6368,2438,3039,1147,7560,4343,968,144,0,10000,5715,240,2220,1,0,2,1,1,1,5,0,1]],
  ['Spectral body sustain', [7475,964,2972,8743,8743,5000,5000,10000,2539,1556,10000,7594,10000,10000,5013,0,10000,3342,10000,10000,5320,5275,10000,4443,4642,4343,968,144,0,10000,3156,240,0,1,1,1,1,1,5,2,0,0]],
  ['Spectral sSustain', [7475,964,2972,8743,8743,5000,5000,10000,7545,10000,10000,7594,10000,10000,5013,0,10000,3342,10000,10000,5320,5275,10000,4443,4642,4343,968,144,0,10000,3156,240,0,1,1,1,1,1,2,2,0,0]],
  ['Sprunger', [10000,442,5273,8743,8743,3428,1070,10000,5051,1469,10000,5051,1469,10000,0,10000,0,0,0,9865,6082,6232,6242,22,2932,3870,1760,144,0,10000,5715,240,2220,1,0,1,1,1,4,1,0,1]],
  ['Sustain only', [7475,1968,1968,8743,8743,5000,5000,10000,9112,0,5000,5051,5000,10000,3333,0,10000,3342,0,10000,5320,5275,10000,4443,4642,10000,3531,144,0,10000,3156,240,0,1,1,1,0,1,5,5,0,0]],
  ['The sailor', [7475,964,2972,8743,8743,5000,5000,10000,5051,5000,10000,5100,5000,10000,5013,0,10000,3342,10000,2686,6368,2438,3950,7500,7560,4343,968,144,0,10000,5715,240,2220,1,1,1,1,1,2,2,0,1]],
  ['Thick transients', [7475,964,2972,8743,8743,5000,5000,10000,5051,1469,10000,5051,5000,10000,6669,10000,0,0,0,2686,6368,2438,3950,7500,7560,4343,968,144,0,10000,5715,240,2220,1,1,1,1,1,0,5,0,1]],
  ['Transient dust', [7475,964,2972,8743,8743,5000,5000,10000,9112,0,10000,7594,10000,10000,5013,0,10000,3342,10000,10000,5320,5275,10000,4443,4642,10000,3531,144,0,10000,3156,240,0,1,1,1,1,1,2,5,0,0]],
  ['Transient only', [7475,1968,1968,8743,8743,5000,5000,10000,9112,0,5000,5051,5000,10000,3333,0,10000,3342,0,10000,5320,5275,10000,4443,4642,10000,3531,144,0,10000,3156,240,0,1,1,1,1,0,5,5,0,0]],
  ['Transient with bouncing sustain', [10000,0,1140,8743,8743,7140,2963,10000,5051,1469,1215,3099,0,4165,2243,6917,0,0,0,428,9970,5468,3039,1147,7560,4343,968,144,0,10000,5715,240,2220,1,0,0,1,1,5,1,0,1]],
  ['Vocal boost repeater', [5000,698,3855,8743,6993,5877,7988,10000,293,743,1215,3099,0,0,0,0,10000,10000,10000,2070,1635,3106,3039,1147,7560,4343,968,144,0,10000,5715,240,2220,1,0,0,1,1,1,0,0,1]],
  ['Vocal segmented echo', [5000,3375,3608,8168,6993,6815,6645,1043,1470,743,1215,3099,0,0,0,0,10000,10000,10000,4432,1635,3106,3039,1147,7560,4343,968,144,0,2305,5715,144,2220,1,0,0,1,1,2,4,0,1]],
  ['Vocal warmer', [5000,915,1215,8743,8743,3428,8770,2949,1316,734,1215,3099,0,0,0,0,4973,5702,8130,1140,1718,383,3039,1147,7560,1567,2309,48,5085,10000,5715,240,2220,0,1,1,1,1,4,0,1,1]],
  ['Warmer transients', [7475,964,2972,8743,8743,5000,5000,10000,5051,1469,10000,5051,5000,10000,3356,10000,0,0,0,2686,6368,2438,3950,7500,7560,4343,968,144,0,10000,5715,240,2220,1,1,1,1,1,0,5,0,1]],
  ['Warping bodies', [7475,964,2972,8743,8743,5000,5000,10000,5051,5000,10000,2043,0,10000,5013,0,10000,3342,10000,2686,6368,2438,7994,7500,7560,4343,968,144,0,10000,3156,240,0,1,1,1,0,1,5,1,0,0]],
  ['Warping transients', [7475,964,2972,8743,8743,5000,5000,10000,5051,5000,10000,2043,0,10000,5013,0,10000,3342,10000,4999,7337,7688,7994,7500,7560,4343,968,144,0,10000,3156,240,0,1,1,1,1,0,1,5,0,0]],
];

function presetParams(v: number[]): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  KEYS.forEach((k, i) => { p[k] = v[i]; });
  return p;
}

export const presets: FxPreset[] = PRESETS.map(([name, v]) => ({ name, params: presetParams(v) }));

/** Display / routing state (not parameters). */
export interface TransmitterState {
  /** Detection sidechain: FL's sidechain input number (1 = first track routed here), 0 = none. */
  scIn: number;
  /** Transient / sustain send target (mixer track), -1 = none. */
  tOut: number;
  sOut: number;
  /** Waveform display: scroll speed 10..90, waveform / transient / sustain layers. */
  speed: number;
  showWave: boolean;
  showT: boolean;
  showS: boolean;
  /** Level sliders linked (the chain buttons). */
  linked: boolean;
  /** Editor colour theme (Options > Theme). */
  theme: number;
}

const intOr = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d;
};

export const def: FxPluginDef = {
  id: 'transmitter',
  name: 'Transmitter',
  category: 'Misc',
  width: 740,
  height: 366,
  description: 'Transient / sustain splitter with per-part effects and sends',
  params,
  outputs: ['TSS Envelope'],
  presets,
  state: (): Record<string, unknown> => ({
    scIn: 0, tOut: -1, sOut: -1, speed: 90, showWave: true, showT: true, showS: false, linked: false, theme: 0,
  } satisfies TransmitterState),
  normalize: (p) => ({
    ...p,
    scIn: intOr(p.scIn, 0, 0, 999),
    tOut: intOr(p.tOut, -1, -1, 999),
    sOut: intOr(p.sOut, -1, -1, 999),
    speed: intOr(p.speed, 90, 10, 90),
    showWave: p.showWave !== false,
    showT: p.showT !== false,
    showS: !!p.showS,
    linked: !!p.linked,
    theme: intOr(p.theme, 0, 0, 3),
  }),
};
