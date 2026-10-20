// Distructor (FL: Distructor). A rack of up to four modules processed left to
// right; each module is a Distortion (18 models), Filter (22 models), Chorus
// (3 models) or Speaker (59-entry cabinet list) with its own In / Mix / Out.
// Form: 924 x 385.
//
// FL exposes 49 parameters per module slot (196 in all), named
// "Module N: <model> - <control>" whatever the slot's current type; index =
// 49 * slot + control. The module structure (type, models, oversampling,
// Center, Smooth, power, accent colour) and the two global switches are
// non-parameter state, as in FL's SaveRestoreState (version 5; module blocks
// version 4). See docs/research/fx/distructor.md.

import type { FxPluginDef, FxParamDef, FxPreset } from '../types';
import { DX_PRESETS } from './distructor/presets';

export type DxType = 0 | 1 | 2 | 3;

/** One module slot (FL's per-module state besides its 49 parameters). */
export interface DxModule {
  /** 0 Distortion, 1 Filter, 2 Chorus, 3 Speaker. */
  type: number;
  /** Distortion model 0..17. */
  dist: number;
  /** Filter model 0..21. */
  filter: number;
  /** Chorus model: 0 Stereo, 1 Mono, 2 Wide (FL's stored order). */
  chorus: number;
  /** Cabinet index 0..58 (FL's list, with group headers at 0, 20, 27, 38). */
  cab: number;
  /** Oversampling 0..4 = 1x..16x (whole module, dry path included). */
  os: number;
  /** Distortion "Center" (DC remover). */
  center: number;
  /** Filter "Smooth". */
  smooth: number;
  /** Power switch off. */
  bypass: number;
  /** Accent colour (0 orange, 1 green, 2 blue, 3 purple): follows the module when it moves. */
  color: number;
}

export const DX_TYPES = ['DISTORTION', 'FILTER', 'CHORUS', 'SPEAKER'];
export const DX_TYPE_MENU = ['Distortion', 'Filter', 'Chorus', 'Amp/Cab'];

export const DX_DIST_MODELS = [
  'Blood overdrive', 'Fast dist', 'Soft clipper',
  'Harmor Classic', 'Harmor Hill', 'Harmor Flathat', 'Harmor Cube', 'Harmor Log', 'Harmor Softsat',
  'Harmor Rubber', 'Harmor Ribbon', 'Harmor Sincrush', 'Harmor Bitcrush', 'Harmor Bitjam',
  'Wave folder', 'Aperture', 'Abrasive', 'Crusher',
];

/** Display names (manual) in FL's stored model order. */
export const DX_FILTER_MODELS = [
  'Low pass 6', 'High pass 6', 'Low pass 12', 'High pass 12', 'Band pass 12', 'Low pass 24', 'High pass 24', 'Notch',
  'Low pass 12 Alt', 'Band pass 12 Alt', 'High pass 12 Alt', 'Low pass 24 Alt', 'Peak', 'Comb +', 'Comb -', 'Vowel',
  'Phaser 1', 'Phaser 2', 'Phaser 3', 'Low shelf', 'High shelf', 'All pass',
];

/** Second knob label per filter model (manual). */
export const DX_FILTER_RES = [
  '', '', 'RESONANCE', 'RESONANCE', 'RESONANCE', 'RESONANCE', 'RESONANCE', 'WIDTH',
  'RESONANCE', 'RESONANCE', 'RESONANCE', 'RESONANCE', 'BOOST', 'INTENSITY', 'INTENSITY', 'SHIFT',
  'SPREAD', 'SPREAD', 'SPREAD', 'GAIN', 'GAIN', 'WIDTH',
];

/** Chorus models in FL's stored order. */
export const DX_CHORUS_MODELS = ['Stereo', 'Mono', 'Wide'];

/** FL's cabinet list (null = group header). */
export const DX_CABS: (string | null)[] = [
  null, 'Blues', 'Guitaro', 'Metal', 'Muffled', 'Wide',
  'Combo 01', 'Combo 02', 'Combo 03', 'Combo 04', 'Combo 05', 'Combo 06', 'Combo 07',
  'Combo 08', 'Combo 09', 'Combo 10', 'Combo 11', 'Combo 12', 'Combo 13', 'Combo 14',
  null, 'Closest', 'Closer', 'Close', 'Medium', 'Far', 'Farther',
  null, 'Model AB', 'Model CD', 'Model EF', 'Model GH', 'Model IJ', 'Model KL', 'Model MN', 'Model OP', 'Model QR', 'Model ST',
  null, 'Model A', 'Model B', 'Model C', 'Model D', 'Model E', 'Model F', 'Model G', 'Model H', 'Model I', 'Model J',
  'Model K', 'Model L', 'Model M', 'Model N', 'Model O', 'Model P', 'Model Q', 'Model R', 'Model S', 'Model T',
];
export const DX_CAB_GROUPS: [name: string, header: number][] = [
  ['Cabinets Stereo', 0], ['Cabinets Mono', 20], ['Hardcore Stereo', 27], ['Hardcore Mono', 38],
];

export const DX_OVERSAMPLE = ['1x', '2x', '4x', '8x', '16x'];

/** Accent colours of the four module colours (knob arcs, LEDs, titles). */
export const DX_COLORS = ['#f0a090', '#9ee29a', '#94cdf0', '#c9a6ee'];

// ---------------------------------------------------------------- value texts
// FL formats single-precision values with round-half-even.

function rhe(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5 + 1e-9) return f + 1;
  if (d < 0.5 - 1e-9) return f;
  return f % 2 === 0 ? f : f + 1;
}
const f32 = Math.fround;
const fx1 = (x: number): string => {
  const s = (rhe(x * 10) / 10).toFixed(1);
  return s === '-0.0' ? '0.0' : s;
};
/** Integer percent, rounded half up (FL's texts of the 0..100 % knobs). */
const pctI = (x: number): string => `${Math.floor(x + 0.5)}%`;
/** toFixed (FL's distortion texts round half away from zero on the exact value), never "-0". */
const tfix = (x: number, d: number): string => {
  const s = x.toFixed(d);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
};
/** Signed percent from the knob's single-precision position (crossover, asymmetry). */
const pctS = (v: number): string => `${tfix(f32(f32(v / 5000) - 1) * 100, 0)}%`;
/** One-decimal percent of a single-precision fraction (chorus knobs). */
const pct1 = (v: number, full: number): string => {
  const s = `${fx1(f32(v / full) * 100)}%`;
  return v < 0 && s === '0.0%' ? '-0.0%' : s;
};
const dbT = (g: number): string => (g <= 0 ? '-InfdB' : `${fx1(20 * Math.log10(g))}dB`);

export const dxGain = (v: number): number => v / 5000;
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Harmor filter cut in Hz (note 72 + 0.12 (v - 500), FL stops at 1099). */
export function dxHarmorCutHz(v: number): number {
  const n = 72 + 0.12 * (Math.min(1099, Math.max(500, v)) - 500);
  return 440 * Math.pow(2, (n - 69) / 12);
}
function hzNote(hz: number): string {
  const m = Math.round(69 + 12 * Math.log2(hz / 440));
  return `${NOTE[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** Crusher: displayed sample rate (FL: 44100 / cubic hold length, as Delay 3). */
export function dxCrushHz(v: number): number {
  const n = 1 - Math.min(10000, Math.max(0, v)) / 10000;
  const hold = 229.295186 - 771.842478 * n + 953.2239 * n * n - 409.676608 * n * n * n;
  return 44100 / Math.max(1, hold);
}
export const dxCrushBits = (v: number): number => 16 - 14 * Math.sqrt(Math.min(10000, Math.max(0, v)) / 10000);

/** Chorus delay in ms (Delay 3's time law on raw / 768). */
export function dxChorusDelayMs(v: number): number {
  const x = Math.min(216, Math.max(1, v)) / 768;
  const a = 0.83076237, b = 0.15908363;
  return 1 + 999 * (a * x * x * x + b * x * x + (1 - a - b) * x);
}

/** Chorus speed as FL displays it (Delay 3's modulation-rate knots). */
const RATE_P = [8.870681, 3.809854, 1.833118, 0.878177, 0.398177, 0.15009, 0.050028];
export function dxChorusRateHz(v: number): number {
  const c = Math.min(6000, Math.max(0, v));
  const k = Math.min(5, Math.floor(c / 1000));
  const t = (c - 1000 * k) / 1000;
  return 1 / (RATE_P[k] * (1 - t) + RATE_P[k + 1] * t);
}

const sepText = (v: number): string => {
  const r = Math.round(v);
  const q = rhe(f32(Math.abs(r) / 1000) * 100);
  return q === 0 ? 'Original' : `${q}% ${r < 0 ? 'separated' : 'merged'}`;
};

// ---------------------------------------------------------------- parameters

interface PSpec { key: string; name: string; min: number; max: number; def: number; fmt?: (v: number) => string; options?: string[]; bipolar?: boolean }

const P: PSpec[] = [
  { key: 'boPreBand', name: 'Blood overdrive - Pre band', min: 0, max: 10000, def: 0, fmt: (v) => pctI(v / 100) },
  { key: 'boColor', name: 'Blood overdrive - Color', min: 0, max: 10000, def: 5000, fmt: (v) => pctI(v / 100) },
  { key: 'boPreAmp', name: 'Blood overdrive - Pre amp', min: 0, max: 10000, def: 0, fmt: (v) => pctI(v / 100) },
  { key: 'boPostGain', name: 'Blood overdrive - Post gain', min: 0, max: 10000, def: 10000, fmt: (v) => pctI(v / 100) },
  { key: 'boPostFilter', name: 'Blood overdrive - Post filter', min: 0, max: 10000, def: 0, fmt: (v) => pctI(v / 100) },
  { key: 'boX100', name: 'Blood overdrive - X100', min: 0, max: 1, def: 0, options: ['Off', 'On'] },
  { key: 'wfPreAmp', name: 'Wave folder - Pre amp', min: 0, max: 10000, def: 500, fmt: (v) => dbT(1 + v / 500) },
  { key: 'wfCross', name: 'Wave folder - Crossover', min: 0, max: 10000, def: 5000, fmt: pctS, bipolar: true },
  { key: 'wfAsym', name: 'Wave folder - Asymmetry', min: 0, max: 10000, def: 5000, fmt: pctS, bipolar: true },
  { key: 'wfThres', name: 'Wave folder - Threshold', min: 0, max: 10000, def: 10000, fmt: (v) => dbT(0.1 + 0.9 * v / 10000) },
  { key: 'apPreAmp', name: 'Aperture - Pre amp', min: 0, max: 10000, def: 500, fmt: (v) => dbT(1 + v / 500) },
  { key: 'apCross', name: 'Aperture - Crossover', min: 0, max: 10000, def: 5000, fmt: pctS, bipolar: true },
  { key: 'apAsym', name: 'Aperture - Asymmetry', min: 0, max: 10000, def: 5000, fmt: pctS, bipolar: true },
  { key: 'apThres', name: 'Aperture - Threshold', min: 0, max: 10000, def: 10000, fmt: (v) => dbT(0.5 + 0.5 * v / 10000) },
  { key: 'apWarp', name: 'Aperture - Warp point', min: 0, max: 10000, def: 2000, fmt: (v) => pctI(v / 100) },
  { key: 'apMode', name: 'Aperture - Mode', min: 0, max: 1, def: 0, options: ['A', 'B'] },
  { key: 'fdPreAmp', name: 'Fast dist - Pre amp', min: 64, max: 192, def: 128, fmt: (v) => pctI((v - 64) / 192 * 100) },
  { key: 'fdThres', name: 'Fast dist - Threshold', min: 1, max: 10, def: 10, fmt: (v) => `${Math.round(v - 1) * 10}%` },
  { key: 'fdPost', name: 'Fast dist - Postgain', min: 0, max: 128, def: 128, fmt: (v) => pctI(v / 128 * 100) },
  { key: 'fdMix', name: 'Fast dist - Mix', min: 0, max: 128, def: 128, fmt: (v) => pctI(v / 128 * 100) },
  { key: 'fdType', name: 'Fast dist - Type', min: 0, max: 1, def: 0, options: ['Off', 'On'] },
  { key: 'scThres', name: 'Soft clipper - Threshold', min: 1, max: 127, def: 100, fmt: (v) => pctI((v - 1) / 127 * 100) },
  { key: 'scPost', name: 'Soft clipper - Post gain', min: 0, max: 160, def: 128, fmt: (v) => pctI(v / 160 * 100) },
  { key: 'hmPreAmp', name: 'Harmor classic - Pre amp', min: 0, max: 1000, def: 500, fmt: (v) => pctI(v / 10) },
  {
    key: 'hmAsym', name: 'Harmor classic - Asymmetry', min: -500, max: 500, def: 0, bipolar: true,
    fmt: (v) => (Math.round(v) === 0 ? '0%' : `${rhe(Math.abs(v) / 5)}% ${v < 0 ? 'stereo' : 'mono'}`),
  },
  { key: 'hmWet', name: 'Harmor classic - Wet vol', min: 0, max: 2000, def: 1000, fmt: (v) => pctI(v / 20) },
  { key: 'hmDry', name: 'Harmor classic - Dry mix', min: -1000, max: 1000, def: 0, fmt: (v) => `${Math.trunc(v / 10)}%`, bipolar: true },
  { key: 'hmCut', name: 'Harmor classic - Filter cut', min: 500, max: 1100, def: 950, fmt: (v) => { const hz = dxHarmorCutHz(v); return `${hz.toFixed(2)}Hz ${hzNote(hz)}`; } },
  { key: 'abPreAmp', name: 'Abrasive - Pre amp', min: 0, max: 10000, def: 2000, fmt: (v) => dbT(1 + v / 5000) },
  { key: 'abGate', name: 'Abrasive - Gate thresh', min: 0, max: 10000, def: 5000, fmt: (v) => dbT(v / 10000) },
  { key: 'abMix', name: 'Abrasive - Dry/wet', min: 0, max: 10000, def: 2000, fmt: (v) => pctI(v / 100) },
  { key: 'abPost', name: 'Abrasive - Post gain', min: 0, max: 10000, def: 5000, fmt: (v) => dbT(1 + v / 5000) },
  { key: 'abNoise', name: 'Abrasive - Noise bp', min: 0, max: 10000, def: 8400, fmt: (v) => pctI(v / 100) },
  { key: 'abFilter', name: 'Abrasive - Filter', min: 0, max: 1, def: 0, options: ['Off', 'On'] },
  { key: 'crRate', name: 'Crusher - Rate crush', min: 0, max: 10000, def: 0, fmt: (v) => (Math.round(v) <= 0 ? 'Max Hz' : `${dxCrushHz(v).toFixed(2)} Hz`) },
  { key: 'crBits', name: 'Crusher - Bit crush', min: 0, max: 10000, def: 0, fmt: (v) => (Math.round(v) <= 0 ? 'Max bits' : `${dxCrushBits(v).toFixed(2)} bits`) },
  { key: 'input', name: 'Input volume', min: 0, max: 10000, def: 5000, fmt: (v) => dbT(v / 5000) },
  { key: 'mix', name: 'Mix volume', min: 0, max: 10000, def: 10000, fmt: (v) => pctI(v / 100) },
  { key: 'output', name: 'Output volume', min: 0, max: 10000, def: 5000, fmt: (v) => dbT(v / 5000) },
  { key: 'cutoff', name: 'Filter Cutoff', min: 0, max: 10000, def: 10000, fmt: (v) => pctI(v / 100) },
  { key: 'res', name: 'Filter Resonance', min: 0, max: 10000, def: 0, fmt: (v) => pctI(v / 100) },
  { key: 'sepIn', name: 'Input stereo separation', min: -1000, max: 1000, def: 0, fmt: sepText, bipolar: true },
  { key: 'sepOut', name: 'Output stereo separation', min: -1000, max: 1000, def: 0, fmt: sepText, bipolar: true },
  { key: 'chDelay', name: 'Chorus delay', min: 1, max: 216, def: 108, fmt: (v) => `${fx1(dxChorusDelayMs(v))}ms` },
  { key: 'chFeedback', name: 'Chorus feedback', min: 0, max: 3840, def: 2880, fmt: (v) => `${fx1(f32(f32(f32(v / 6000) * 100) * 1.25))}%` },
  { key: 'chSpeed', name: 'Chorus speed', min: 0, max: 6000, def: 1500, fmt: (v) => `${fx1(dxChorusRateHz(v))}Hz` },
  { key: 'chDepth', name: 'Chorus depth', min: 300, max: 6000, def: 1995, fmt: (v) => pct1(v, 6000) },
  { key: 'chBlur', name: 'Chorus blur', min: 0, max: 6000, def: 0, fmt: (v) => pct1(v, 6000) },
  { key: 'chColor', name: 'Chorus color', min: -3000, max: 3000, def: 0, fmt: (v) => pct1(v, 3000), bipolar: true },
];

/** Control keys in FL's per-module parameter order (index within the module). */
export const DX_KEYS = P.map((p) => p.key);
export const DX_NPARAMS = P.length; // 49
/** FL's constructor defaults of one module (new modules start from these). */
export const DX_MODULE_DEFAULTS = P.map((p) => p.def);
export const dxSpec = (k: number): PSpec => P[k];

/** Key of control k (0..48) of module slot s (0..3). */
export const dxKey = (s: number, k: number): string => `m${s + 1}_${P[k].key}`;
export const dxIndex = (key: string): number => DX_KEYS.indexOf(key);

/** FL's "Default" factory preset, which FL loads when the plugin is inserted. */
export const DX_DEFAULT_MODULES: DxModule[] = [
  { type: 0, dist: 3, filter: 2, chorus: 0, cab: 1, os: 0, center: 1, smooth: 1, bypass: 0, color: 0 },
  { type: 1, dist: 0, filter: 2, chorus: 0, cab: 1, os: 0, center: 1, smooth: 1, bypass: 0, color: 1 },
  { type: 2, dist: 0, filter: 2, chorus: 0, cab: 1, os: 0, center: 1, smooth: 1, bypass: 0, color: 2 },
  { type: 3, dist: 0, filter: 2, chorus: 0, cab: 10, os: 0, center: 1, smooth: 1, bypass: 0, color: 3 },
];
/** The Default preset's parameter values that differ from the constructor's. */
const DEFAULT_OVERRIDES: Record<string, number> = { m1_hmCut: 1100, m2_res: 2616, m3_chDelay: 1 };

/** A new module of the given type (FL's constructor state). */
export function dxNewModule(type: number, color: number): DxModule {
  return { type, dist: 0, filter: 2, chorus: 0, cab: 1, os: type <= 1 ? 1 : 0, center: 1, smooth: 1, bypass: 0, color };
}

const int = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : typeof v === 'boolean' ? (v ? 1 : 0) : d;
  return Math.min(hi, Math.max(lo, n));
};

/** Repair a stored module list (0..4 modules, every field in range). */
export function dxModules(raw: unknown): DxModule[] {
  if (!Array.isArray(raw)) return DX_DEFAULT_MODULES.map((m) => ({ ...m }));
  return raw.slice(0, 4).map((r, i) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return {
      type: int(o.type, 0, 3, 0),
      dist: int(o.dist, 0, 17, 0),
      filter: int(o.filter, 0, 21, 2),
      chorus: int(o.chorus, 0, 2, 0),
      cab: int(o.cab, 0, 58, 1),
      os: int(o.os, 0, 4, 0),
      center: int(o.center, 0, 1, 1),
      smooth: int(o.smooth, 0, 1, 1),
      bypass: int(o.bypass, 0, 1, 0),
      color: int(o.color, 0, 3, i),
    };
  });
}

function params(): FxParamDef[] {
  const out: FxParamDef[] = [];
  for (let s = 0; s < 4; s++) {
    P.forEach((p, k) => {
      const key = dxKey(s, k);
      out.push({
        key,
        name: `Module ${s + 1}: ${p.name}`,
        index: 49 * s + k,
        min: p.min,
        max: p.max,
        def: DEFAULT_OVERRIDES[key] ?? p.def,
        ...(p.options ? { options: p.options } : {}),
        ...(p.fmt ? { format: p.fmt } : {}),
        ...(p.bipolar ? { bipolar: true } : {}),
      });
    });
  }
  return out;
}

export const def: FxPluginDef = {
  id: 'distructor',
  name: 'Distructor',
  category: 'Distortion',
  width: 924,
  height: 385,
  description: 'Modular rack of distortion, filter, chorus and amp/cab modules',
  params: params(),
  state: () => ({ modules: DX_DEFAULT_MODULES.map((m) => ({ ...m })), softClip: 1, meters: 1 }),
  normalize: (p) => ({
    ...p,
    modules: dxModules(p.modules),
    softClip: int(p.softClip, 0, 1, 1),
    meters: int(p.meters, 0, 1, 1),
  }),
  presets: DX_PRESETS as FxPreset[],
};
