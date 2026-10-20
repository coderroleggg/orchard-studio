// Delay Bank (FL: Fruity Delay Bank): 8 identical delay units, each with input
// pan / volume, a multi-mode input filter (pre or post delay), a delay with
// feedback pan / volume / stereo separation, a feedback filter, an echo
// "grain" chopper and an output that can also feed the next unit. Form:
// 580 x 280. Parameter indices, ranges, names, value texts, the state layout
// and every mapping below were read from / measured on FL's own plugin with
// flfxhost (docs/research/fx/delaybank.md).

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';

/** Per-unit settings that are not automatable parameters (FL keeps them in the plugin state). */
export interface DbUnit {
  /** Unit on (FL: the LED above the unit tab). */
  enable: number;
  /** 1 = "leave first echo" (the first echo skips the feedback section). */
  leave: number;
  /** 1 = tempo-based time (otherwise the time follows a fixed 120 BPM). */
  tempo: number;
  /** 1 = input filter after the delay (POST). */
  post: number;
  /** Input / feedback filter type (DB_FILTERS) and slope (0 single, 1 dual, 2 triple). */
  inType: number;
  inMode: number;
  fbType: number;
  fbMode: number;
  /** Feedback mode: 0 off (no delay), 1 normal, 2 inverted, 3 ping-pong. */
  mode: number;
  /** Grain division 0..16 (0 = off) and shape -128..128. */
  div: number;
  shape: number;
}

export const DB_UNITS = 8;
export const DB_FILTERS = ['OFF', 'LP', 'BP', 'NOT', 'HP', 'LS', 'PK', 'HS'];
export const DB_FILTER_NAMES = ['Off', 'Low pass', 'Band pass', 'Notch', 'High pass', 'Low shelf', 'Peaking', 'High shelf'];
export const DB_MODES = ['off', 'normal', 'inverted', 'ping-pong'];
export const DB_SLOPES = ['single', 'dual', 'triple'];

/** Unit parameters in FL's index order (unit u, 0-based, starts at index 4 + 16 u). */
export const DB_UNIT_PARAMS: readonly (readonly [string, string])[] = [
  ['InPan', 'Input panning'], ['InVol', 'Input volume'], ['InCut', 'Input filter cutoff frequency'],
  ['InRes', 'Input filter resonance / bandwidth'], ['InGain', 'Input filter gain'],
  ['FbPan', 'Feedback panning'], ['FbVol', 'Feedback volume'], ['Sep', 'Feedback stereo separation'],
  ['Time', 'Time'], ['Ofs', 'Time stereo offset'],
  ['FbCut', 'Feedback filter cutoff frequency'], ['FbRes', 'Feedback filter resonance / bandwidth'], ['FbGain', 'Feedback filter gain'],
  ['OutPan', 'Output panning'], ['OutVol', 'Output volume'], ['Next', 'To next delay'],
];

/** Parameter key of unit `u` (0-based), e.g. dbKey(0, 'Time') = 'u1Time'. */
export const dbKey = (u: number, k: string): string => `u${u + 1}${k}`;

export function dbDefaultUnit(enable = 0): DbUnit {
  return { enable, leave: 0, tempo: 1, post: 0, inType: 0, inMode: 0, fbType: 0, fbMode: 0, mode: 1, div: 0, shape: 0 };
}

const clampInt = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;

/** The 8 unit settings of a stored state (repairs missing / malformed entries). */
export function dbUnits(raw: unknown): DbUnit[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: DbUnit[] = [];
  for (let u = 0; u < DB_UNITS; u++) {
    const s = (arr[u] && typeof arr[u] === 'object' ? arr[u] : {}) as Partial<Record<keyof DbUnit, unknown>>;
    const d = dbDefaultUnit(u === 0 ? 1 : 0);
    out.push({
      enable: clampInt(s.enable, 0, 1, d.enable), leave: clampInt(s.leave, 0, 1, d.leave),
      tempo: clampInt(s.tempo, 0, 1, d.tempo), post: clampInt(s.post, 0, 1, d.post),
      inType: clampInt(s.inType, 0, 7, d.inType), inMode: clampInt(s.inMode, 0, 2, d.inMode),
      fbType: clampInt(s.fbType, 0, 7, d.fbType), fbMode: clampInt(s.fbMode, 0, 2, d.fbMode),
      mode: clampInt(s.mode, 0, 3, d.mode), div: clampInt(s.div, 0, 16, d.div), shape: clampInt(s.shape, -128, 128, d.shape),
    });
  }
  return out;
}

// ---------------------------------------------------------------- mappings

/** Volume wheels (unit in / out / to next, global dry / wet / input): sign(v) (11^(|v|/128) - 1) / 10. */
export function dbVol(v: number): number {
  const a = Math.min(160, Math.abs(v));
  return Math.sign(v) * (Math.pow(11, a / 128) - 1) / 10;
}

/**
 * FL's pan law (input, feedback and output pan): theta = |p| pi / 4,
 * the far side x (cos - sin), the near side gets 1/2 (cos + sin - cos 2theta)
 * of the far input plus 1/2 (cos + sin + cos 2theta) of itself.
 * Returns [far gain k0, pour k1, near total K = k1 + near own gain].
 */
export function dbPanGains(p: number): [number, number, number] {
  const th = (Math.min(128, Math.abs(p)) / 128) * (Math.PI / 4);
  const c = Math.cos(th), s = Math.sin(th);
  return [c - s, 0.5 * (c + s - Math.cos(2 * th)), c + s];
}

/** Stereo separation: L' = a L + b R, R' = b L + a R. Returns [a, b]. */
export function dbSep(v: number): [number, number] {
  const x = Math.min(1, Math.max(-1, v / 128));
  if (x < 0) return [1 - (x * x) / 4, x / 2 + (x * x) / 4];
  const b = (Math.pow(5, x) - 1) / 8;
  return [1 - b, b];
}

/** Filter cutoff in Hz (absolute, any sample rate), clamped to 20 kHz. */
export function dbCutoffHz(type: number, v: number): number {
  const x = Math.min(1, Math.max(0, v / 65536));
  const k = (Math.pow(1501, x) - 1) / 1500;
  return Math.min(20000, type === 1 ? 132.3 + 43967.7 * k : 4.4079 + 26455.59 * k);
}

/** Low / high pass Q. */
export function dbFilterQ(v: number): number {
  return 0.1 + (49.9 * (Math.pow(2001, Math.min(1, Math.max(0, v / 65536))) - 1)) / 2000;
}

/** Band pass / notch bandwidth in octaves (RBJ BW form). */
export function dbFilterBW(v: number): number {
  return 0.02892 + (34.5951 * (Math.pow(101, Math.min(1, Math.max(0, v / 65536))) - 1)) / 100;
}

/** Peaking Q (the wheel narrows the peak). */
export function dbPeakQ(v: number): number {
  return 0.1 + (99.9 * (Math.pow(2001, 1 - Math.min(1, Math.max(0, v / 65536))) - 1)) / 2000;
}

/** Shelf slope S. */
export function dbShelfS(v: number): number {
  return 0.1 + 0.45 * (Math.pow(3, 1 - Math.min(1, Math.max(0, v / 65536))) - 1);
}

/** Filter gain wheel -> RBJ amplitude A (10% .. 200%); the shelf / peak gain is A^2. */
export function dbFilterAmp(g: number): number {
  const v = Math.min(256, Math.max(0, g));
  return v <= 128 ? 0.1 + 8.1 * (Math.pow(10 / 9, v / 128) - 1) : 1 + 9 * (Math.pow(10 / 9, (v - 128) / 128) - 1);
}

/** Stereo time offset in ms: (1001^(|v|/512) - 1) / 2 (up to 500 ms). */
export function dbOffsetMs(v: number): number {
  return (Math.pow(1001, Math.min(512, Math.abs(v)) / 512) - 1) / 2;
}

/** Delay time in beats: raw / 1920 (tenths of 1/48 step). */
export const dbTimeBeats = (v: number): number => Math.min(7680, Math.max(0, v)) / 1920;

/**
 * Grain envelope at phase x (0..1 across one grain): a Hann window bent by
 * the shape wheel, (N^h - 1) / (N - 1) with N = 10000^(-shape/128).
 */
export function dbGrainEnv(x: number, shape: number): number {
  const s = Math.sin(Math.PI * x);
  const h = s * s;
  if (shape === 0) return h;
  const k = -(shape / 128) * Math.log(10000);
  return Math.expm1(k * h) / Math.expm1(k);
}

// ---------------------------------------------------------------- texts

/** Half away from zero on the exact ratio (FL's percent texts). */
const rnd = (num: number, den: number): number => Math.sign(num) * Math.round(Math.abs(num) / den);

/** Round half to even (FL's pan texts). */
function roundEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export const dbPctText = (den: number) => (v: number): string => `${rnd(v * 100, den)}%`;
export function dbPanText(v: number): string {
  if (Math.round(v) === 0) return 'Centered';
  return `${roundEven((Math.abs(v) * 100) / 128)}% ${v < 0 ? 'left' : 'right'}`;
}
export const dbGainText = (v: number): string => `${Math.round(dbFilterAmp(v) * 100)}%`;
export function dbTimeText(v: number): string {
  const t = Math.trunc(Math.max(0, v) / 10);
  return `${Math.floor(t / 48)}:${String(t % 48).padStart(2, '0')}`;
}
export const dbOffsetText = (v: number): string => `${dbOffsetMs(v).toFixed(1)}ms ${v < 0 ? 'left' : 'right'}`;

// ---------------------------------------------------------------- definition

function unitParams(u: number): FxParamDef[] {
  const base = 4 + 16 * u;
  const name = (i: number) => `Delay ${u + 1} - ${DB_UNIT_PARAMS[i][1]}`;
  const k = (i: number) => dbKey(u, DB_UNIT_PARAMS[i][0]);
  const pct = dbPctText(128), pctBig = dbPctText(65536);
  const list: FxParamDef[] = [
    { key: k(0), name: name(0), index: base, min: -128, max: 128, def: 0, bipolar: true, format: dbPanText },
    { key: k(1), name: name(1), index: base + 1, min: -160, max: 160, def: 128, bipolar: true, format: pct },
    { key: k(2), name: name(2), index: base + 2, min: 0, max: 65536, def: 33145, format: pctBig },
    { key: k(3), name: name(3), index: base + 3, min: 0, max: 65536, def: 17500, format: pctBig },
    { key: k(4), name: name(4), index: base + 4, min: 0, max: 256, def: 0, format: dbGainText },
    { key: k(5), name: name(5), index: base + 5, min: -128, max: 128, def: 0, bipolar: true, format: dbPanText },
    { key: k(6), name: name(6), index: base + 6, min: -128, max: 128, def: 64, bipolar: true, format: pct },
    { key: k(7), name: name(7), index: base + 7, min: -128, max: 128, def: 0, bipolar: true, format: pct },
    { key: k(8), name: name(8), index: base + 8, min: 0, max: 7680, def: 1440, format: dbTimeText },
    { key: k(9), name: name(9), index: base + 9, min: -512, max: 512, def: 0, bipolar: true, format: dbOffsetText },
    { key: k(10), name: name(10), index: base + 10, min: 0, max: 65536, def: 33145, format: pctBig },
    { key: k(11), name: name(11), index: base + 11, min: 0, max: 65536, def: 17500, format: pctBig },
    { key: k(12), name: name(12), index: base + 12, min: 0, max: 256, def: 0, format: dbGainText },
    { key: k(13), name: name(13), index: base + 13, min: -128, max: 128, def: 0, bipolar: true, format: dbPanText },
    { key: k(14), name: name(14), index: base + 14, min: -160, max: 160, def: 128, bipolar: true, format: pct },
  ];
  if (u < DB_UNITS - 1) list.push({ key: k(15), name: name(15), index: base + 15, min: -160, max: 160, def: 0, bipolar: true, format: pct });
  return list;
}

const PARAMS: FxParamDef[] = [
  { key: 'dry', name: 'Dry', index: 0, min: 0, max: 128, def: 128, format: dbPctText(128) },
  { key: 'wet', name: 'Wet', index: 1, min: 0, max: 128, def: 128, format: dbPctText(128) },
  { key: 'input', name: 'Input', index: 2, min: 0, max: 128, def: 128, format: dbPctText(128) },
  { key: 'feedback', name: 'Feedback', index: 3, min: 0, max: 128, def: 128, format: dbPctText(128) },
  ...Array.from({ length: DB_UNITS }, (_, u) => unitParams(u)).flat(),
];

/** Parameter key by FL index. */
const KEY_BY_INDEX = new Map(PARAMS.map((p) => [p.index!, p.key]));

/** A factory preset from FL's state: parameter changes by FL index, unit changes by unit (0-based). */
function preset(name: string, params: Record<number, number>, units: Record<number, Partial<DbUnit>>, extra?: { oversample?: number }): FxPreset {
  const p: Record<string, unknown> = {};
  for (const [i, v] of Object.entries(params)) {
    const k = KEY_BY_INDEX.get(Number(i));
    if (k) p[k] = v;
  }
  p.units = Array.from({ length: DB_UNITS }, (_, u) => ({ ...dbDefaultUnit(u === 0 ? 1 : 0), ...(units[u] ?? {}) }));
  p.oversample = extra?.oversample ?? 0;
  p.solo = -1;
  return { name, params: p };
}

export const def: FxPluginDef = {
  id: 'delaybank',
  name: 'Delay Bank',
  category: 'Delay reverb',
  width: 580,
  height: 280,
  description: 'Bank of 8 chainable delays with filters, feedback processing and grain chopping',
  params: PARAMS,
  // tab = the unit shown in the editor (FL does not save it)
  state: () => ({ units: dbUnits(undefined), solo: -1, oversample: 0, tab: 0 }),
  normalize: (p) => ({
    ...p,
    units: dbUnits(p.units),
    solo: clampInt(p.solo, -1, DB_UNITS - 1, -1),
    oversample: clampInt(p.oversample, 0, 1, 0),
    tab: clampInt(p.tab, 0, DB_UNITS - 1, 0),
  }),
  // FL's factory presets (Plugin presets > Effects > Fruity Delay Bank), decoded
  // from the plugin state FL produces for each (flfxhost --save-state).
  presets: [
    preset('Default', {}, {}),
    preset('3 echoes', { 5: 113, 8: 128, 10: 0, 16: 128, 17: -14, 19: 76, 21: 0, 24: 128, 26: 0, 32: 128, 33: 14, 35: 64, 37: 0, 40: 128, 42: 0, 48: 128, 56: 128, 64: 128, 72: 128, 80: 128, 88: 128, 96: 128, 104: 128, 112: 128, 120: 128, 128: 128 }, { 0: { mode: 3, leave: 1 }, 1: { enable: 1, leave: 1 }, 2: { enable: 1, leave: 1 } }),
    preset('6 voice choir', { 3: 96, 10: 71, 12: 50, 14: 28281, 15: 24668, 16: 33, 26: 44, 28: 70, 30: 55673, 31: 30044, 42: 53, 44: 90, 46: 47993, 47: 34908, 60: 120, 62: 45433, 63: 31068, 64: 36, 76: 190, 92: 230 }, { 0: { tempo: 0 }, 1: { enable: 1, tempo: 0 }, 2: { fbMode: 1, enable: 1, tempo: 0 }, 3: { enable: 1, tempo: 0 }, 4: { enable: 1, tempo: 0 }, 5: { enable: 1, tempo: 0 } }),
    preset('Alternate', { 10: 95, 11: 52, 12: 2880, 16: 108, 26: 0, 27: -52, 35: 129, 37: 0, 43: -52, 44: 2880, 48: 107 }, { 0: { fbType: 5 }, 1: { mode: 3, enable: 1, leave: 1 }, 2: { fbType: 7, mode: 3, enable: 1 } }),
    preset('Alternate 2', { 10: 80, 11: -54, 13: 68, 14: 46713, 15: 30556, 19: 125, 21: -60, 26: 78, 27: -41, 28: 2880, 29: -28 }, { 0: { fbType: 4, mode: 3 }, 1: { mode: 3, enable: 1 } }),
    preset('Big res', { 0: 0, 3: 73, 6: 32377, 7: 38748, 8: 45, 10: 71, 11: -36, 12: 960, 13: 144, 14: 36217, 15: 32860, 16: 128, 25: -24, 26: 44, 27: 46, 28: 960, 30: 39801, 31: 39004, 41: 21, 42: 53, 43: -79, 44: 2880, 45: -108, 46: 26745, 47: 39260, 57: -19, 58: 45, 59: 88, 60: 2880, 62: 42617, 63: 40028, 64: 36, 73: 42, 74: 47, 75: -61, 76: 5280, 77: 232, 78: 26745, 79: 37980, 89: 32, 91: 128, 92: 5760, 94: 19321, 95: 40540 }, { 0: { inType: 4, fbType: 4, fbMode: 1, mode: 3 }, 1: { fbType: 1, mode: 3, enable: 1 }, 2: { fbType: 1, fbMode: 1, mode: 3, enable: 1 }, 3: { fbType: 1, mode: 3, div: 13, shape: -14, enable: 1, leave: 1 }, 4: { fbType: 1, fbMode: 1, mode: 3, div: 4, shape: 51, enable: 1 }, 5: { fbType: 1, fbMode: 1, mode: 3, div: 8, shape: 39, enable: 1 } }),
    preset('Brighter echoes', { 5: 97, 10: 80, 13: -48, 15: 18268, 16: 47 }, { 0: { fbType: 5, mode: 3, leave: 1 } }),
    preset('Classic 3 steps', { 5: 118, 10: 48, 13: -136 }, { 0: { mode: 3, leave: 1 } }),
    preset('Classic ping pong', { 4: -83, 6: 21113, 10: 68, 14: 48505, 15: 21852 }, { 0: { inType: 4, fbType: 1, mode: 3 } }),
    preset('Clearer echoes', { 0: 0, 6: 13433, 10: 0, 12: 0, 13: -48, 21: 103, 22: 26489, 26: 0, 29: 48, 37: 78, 38: 39801, 42: 0, 44: 2880, 45: -48, 53: 52, 54: 52857, 58: 0, 60: 4320, 61: 48, 69: 26, 74: 0, 76: 5760, 77: -48, 83: 128, 85: 0 }, { 0: { inType: 1, leave: 1 }, 1: { inType: 1, enable: 1, leave: 1 }, 2: { inType: 1, enable: 1, leave: 1 }, 3: { inType: 1, enable: 1, leave: 1 }, 4: { enable: 1, leave: 1 }, 5: { mode: 3, enable: 1 } }, { oversample: 1 }),
    preset('Crowded', { 1: 101, 4: -29, 9: -23, 10: 93, 11: -8, 12: 2400, 19: 110, 20: 62, 22: 8313, 23: 46940, 24: 199, 25: 70, 26: 66, 27: 68, 28: 960, 30: 15481, 31: 35932, 32: 151, 35: 160, 37: 151, 38: 46201, 39: 39772, 41: 41, 42: 72, 44: 960, 51: 74, 52: -59, 54: 19833, 55: 52060, 57: 44, 68: 79, 70: 33657, 71: 49500, 73: -119, 74: 109, 76: 1920, 86: 38777, 87: 47196, 89: 52, 90: 43, 92: 960, 94: 39289, 95: 38748, 99: 95, 100: -80, 102: 44921, 103: 47964, 105: -91, 106: 77, 107: 56, 110: 20089, 111: 36700, 115: 160, 116: 90, 118: 17785, 119: 53340, 122: 66, 123: 33, 127: 42076 }, { 0: { mode: 2 }, 1: { inType: 5, fbType: 1, post: 1, mode: 3, enable: 1 }, 2: { inType: 4, post: 1, mode: 2, enable: 1 }, 3: { inType: 1, post: 1, enable: 1 }, 4: { inType: 4, mode: 3, enable: 1 }, 5: { inType: 2, fbType: 5, mode: 3, enable: 1 }, 6: { inType: 4, fbType: 1, post: 1, enable: 1 }, 7: { inType: 7, fbType: 3, post: 1, enable: 1, leave: 1 } }),
    preset('Diffuse', { 13: 188, 19: 91, 28: 960, 29: -244, 35: 111, 44: 480, 45: 332 }, { 0: { mode: 3 }, 1: { mode: 3, enable: 1 }, 2: { enable: 1 } }),
    preset('Funky tin roof', { 3: 88, 9: -23, 10: 93, 11: -8, 12: 70, 19: 110, 22: 43897, 24: 131, 25: 70, 26: 90, 27: 68, 28: 480, 30: 37497, 31: 32092, 32: 79, 35: 160, 37: 151, 38: 46201, 39: 39772, 41: 41, 44: 960, 51: 74 }, { 0: { mode: 2, tempo: 0 }, 1: { inType: 7, fbType: 4, post: 1, mode: 3, enable: 1 }, 2: { inType: 4, post: 1, mode: 2, enable: 1 } }),
    preset('Millisecond offset', { 0: 0, 12: 0 }, { 0: { leave: 1, tempo: 0 } }),
    preset('Mono echoes', { 11: 59 }, { 0: { mode: 3 } }),
    preset('Ringy modder', { 3: 114, 4: -47, 6: 21881, 7: 34396, 10: 121, 11: -1, 12: 150, 13: -132, 14: 22137, 19: 160, 20: -128 }, { 0: { inType: 4, post: 1, mode: 3, div: 8, shape: 14, leave: 1, tempo: 0 }, 1: { mode: 3, enable: 1 } }),
    preset('Something', { 0: 0, 3: 86, 10: 71, 11: -36, 12: 1710, 13: 144, 14: 28281, 15: 24668, 16: 33, 25: -24, 26: 44, 27: 46, 28: 2560, 30: 55673, 31: 30044, 41: 21, 42: 53, 43: -79, 44: 5120, 45: -108, 46: 47993, 47: 34908, 57: -19, 58: 45, 59: 88, 60: 5980, 62: 45433, 63: 31068, 64: 36, 73: 42, 74: 47, 75: -61, 76: 6830, 77: 232, 89: 32, 91: 128, 92: 7680 }, { 0: { mode: 3, tempo: 0 }, 1: { mode: 3, enable: 1, tempo: 0 }, 2: { fbMode: 1, mode: 3, div: 3, shape: -44, enable: 1, tempo: 0 }, 3: { mode: 3, enable: 1, leave: 1, tempo: 0 }, 4: { mode: 3, enable: 1, tempo: 0 }, 5: { mode: 3, div: 1, enable: 1, tempo: 0 } }),
    preset('Techno beat', { 3: 96, 10: 71, 12: 2060, 14: 28281, 15: 24668, 16: 33, 26: 44, 28: 2880, 30: 55673, 31: 30044, 42: 53, 44: 1240, 46: 47993, 47: 34908 }, { 0: { fbType: 1, mode: 3, tempo: 0 }, 1: { fbType: 1, mode: 3, enable: 1, tempo: 0 }, 2: { fbType: 1, fbMode: 1, mode: 3, enable: 1, tempo: 0 } }),
    preset('Tin roof', { 3: 88, 9: -87, 10: 93, 12: 30, 19: 110, 22: 43897, 24: 131, 25: 70, 26: 90, 27: 68, 28: 40, 30: 37497, 31: 32092, 32: 79, 35: 160, 37: 151, 38: 46201, 39: 39772, 41: 41, 44: 140, 51: 74 }, { 0: { mode: 3, tempo: 0 }, 1: { inType: 7, fbType: 4, post: 1, mode: 3, enable: 1 }, 2: { inType: 4, post: 1, mode: 2, enable: 1 } }),
    preset('Tribal beats', { 3: 96, 10: 71, 12: 4120, 14: 28281, 15: 24668, 16: 33, 26: 44, 28: 4940, 30: 55673, 31: 30044, 42: 53, 44: 2880, 46: 47993, 47: 34908, 60: 2060, 62: 45433, 63: 31068, 64: 36 }, { 0: { fbType: 1, mode: 3, tempo: 0 }, 1: { fbType: 1, mode: 3, enable: 1, tempo: 0 }, 2: { fbType: 1, fbMode: 1, mode: 3, enable: 1, tempo: 0 }, 3: { fbType: 1, enable: 1, tempo: 0 } }),
    preset('Whistlin sixes', { 12: 480, 14: 20857, 15: 35932, 28: 960, 30: 20345, 31: 28764, 60: 1920, 62: 30073, 63: 36444, 64: 91, 76: 2400, 78: 49273, 79: 30812, 92: 2880, 94: 31097, 95: 35676 }, { 0: { fbType: 1 }, 1: { fbType: 2, enable: 1 }, 2: { fbType: 2, enable: 1 }, 3: { fbType: 4, fbMode: 1, enable: 1 }, 4: { fbType: 2, enable: 1 }, 5: { fbType: 1, enable: 1 } }),
  ],
};
