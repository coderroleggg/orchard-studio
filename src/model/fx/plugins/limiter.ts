// Limiter (FL: Fruity Limiter): single-band compressor (RMS, sidechain),
// look-ahead peak limiter with integrated noise gate, and soft saturation.
// Form: 626 x 300. Parameter list, ranges, defaults and value texts were read
// from FL's own plugin (host info/sweep); every knob law below reproduces FL's
// value texts exactly (docs/research/fx/limiter.md).

import type { FxPluginDef, FxParamDef, FxPreset } from '../types';

/** FL's exponential knob law: 0..1 -> 0..1 with (b^x - 1) / (b - 1). */
export function expLaw(x: number, b: number): number {
  return (Math.pow(b, x) - 1) / (b - 1);
}

/** Inverse of expLaw. */
export function expLawInv(y: number, b: number): number {
  return Math.log(1 + y * (b - 1)) / Math.log(b);
}

/** Gain, noise gain, noise threshold, comp threshold (0..1000 or 0..2000, 1000 = 0 dB): b = 7, max +18.06 dB. */
export const limGain = (v: number): number => expLaw(v / 1000, 7);
/** Limiter ceiling and saturation threshold: b = 3, max +12.04 dB. */
export const limCeil = (v: number): number => expLaw(v / 1000, 3);
/** Compressor threshold: limGain clamped to -60 dB. */
export const limCompThres = (v: number): number => Math.max(0.001, limGain(v));
/** Times in ms: 0..10000 -> 0..max ms with b = 501. */
export const limTime = (v: number, maxMs: number): number => (maxMs * (Math.pow(501, v / 10000) - 1)) / 500;
/** Attack, peak window, comp attack and RMS window reach 1 s; releases 2 s. */
export const LIM_SHORT_MS = 1000;
export const LIM_LONG_MS = 2000;

/** Compression ratio as "R" (output dB per input dB = 1/R). v > 0: 1:1..20:1, v < 0: expansion 1:1..1:4. */
export function limRatio(v: number): number {
  const x = Math.abs(v) / 1000;
  const k = (Math.pow(51, x) - 1) / 50;
  return v >= 0 ? 1 + 19 * k : 1 / (1 + 3 * k);
}

/**
 * Compressor static gain (linear) for a detector level (linear): FL reshapes the
 * overshoot o (dB) with its knob curve on u = o + 1 before applying the ratio:
 * knee > 0: u' = ln(1 + u(b-1)) / ln b, b = 1 + F; knee < 0: u' = (b^u - 1)/(b - 1),
 * b = 1 + F/5; F = (201^|knee| - 1)/200 (|knee| 0..1). Gain dB = (u' - 1)/R - o.
 */
export function limCompGain(level: number, thrLin: number, invR: number, kneeV: number): number {
  if (!(level > thrLin)) return 1;
  const o = 20 * Math.log10(level / thrLin);
  const K = Math.abs(kneeV) / 1000;
  let op = o;
  if (K > 0) {
    const F = (Math.pow(201, K) - 1) / 200;
    const u = o + 1;
    if (kneeV > 0) op = Math.log(1 + u * F) / Math.log(1 + F) - 1;
    else { const b = 1 + 0.2 * F; op = (Math.pow(b, u) - 1) / (b - 1) - 1; }
  }
  const g = Math.pow(10, (op * invR - o) / 20);
  return g < 1e6 ? g : 1e6;
}

/** Round half away from zero (FL's percent texts). */
function roundAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** FL's dB text: "0.0dB", "-11.2dB", "18.1dB", "-InfdB" (no sign for positive values, no "-0.0"). */
export function limDbText(g: number): string {
  if (!(g > 0)) return '-InfdB';
  let s = (20 * Math.log10(g)).toFixed(1);
  if (s === '-0.0') s = '0.0';
  return s + 'dB';
}

export const limMsText = (ms: number): string => ms.toFixed(2) + 'ms';

export function limRatioText(v: number): string {
  const x = Math.abs(v) / 1000;
  const k = (Math.pow(51, x) - 1) / 50;
  return v > 0 ? `${(1 + 19 * k).toFixed(1)}:1` : `1:${(1 + 3 * k).toFixed(1)}`;
}

export const limKneeText = (v: number): string => `${roundAway(v / 10)}%`;

/** Typed dB -> control value for a b-law gain knob. */
function dbParse(b: number, top: number) {
  return (db: number) => Math.round(Math.min(top, Math.max(0, 1000 * expLawInv(Math.pow(10, db / 20), b))));
}

/** Typed ms -> control value. */
function msParse(maxMs: number) {
  return (ms: number) => Math.round(Math.min(10000, Math.max(0, 10000 * (Math.log(1 + (Math.max(0, ms) * 500) / maxMs) / Math.log(501)))));
}

const gainP = (key: string, name: string, index: number, max: number, def: number): FxParamDef => ({
  key, name, index, min: 0, max, def, format: (v) => limDbText(limGain(v)), parse: dbParse(7, max),
});

const timeP = (key: string, name: string, index: number, maxMs: number, def: number): FxParamDef => ({
  key, name, index, min: 0, max: 10000, def, format: (v) => limMsText(limTime(v, maxMs)), parse: msParse(maxMs),
});

const curveP = (key: string, name: string, index: number, def: number): FxParamDef => ({
  key, name, index, min: 1, max: 8, def, format: (v) => String(Math.round(v)), parse: (n) => Math.round(n),
});

/** FL's parameter list (Tag order). */
export const LIMITER_PARAMS: FxParamDef[] = [
  gainP('gain', 'Gain', 0, 2000, 1000),
  { key: 'sat', name: 'Soft saturation threshold', index: 1, min: 0, max: 1000, def: 1000, format: (v) => limDbText(limCeil(v)), parse: dbParse(3, 1000) },
  { key: 'ceil', name: 'Limiter ceiling', index: 2, min: 0, max: 2000, def: 1000, format: (v) => limDbText(limCeil(v)), parse: dbParse(3, 2000) },
  timeP('att', 'Limiter attack time', 3, LIM_SHORT_MS, 1115),
  curveP('attCurve', 'Limiter attack curve', 4, 3),
  timeP('rel', 'Limiter release time', 5, LIM_LONG_MS, 5000),
  curveP('relCurve', 'Limiter release curve', 6, 3),
  timeP('sustain', 'Limiter peak window', 7, LIM_SHORT_MS, 2882),
  { key: 'cThres', name: 'Comp threshold', index: 8, min: 0, max: 1000, def: 1000, format: (v) => limDbText(limCompThres(v)), parse: dbParse(7, 1000) },
  { key: 'cRatio', name: 'Comp ratio', index: 9, min: -1000, max: 1000, def: 0, bipolar: true, format: limRatioText },
  { key: 'cKnee', name: 'Comp knee', index: 10, min: -1000, max: 1000, def: 0, bipolar: true, format: limKneeText, parse: (pct) => Math.round(pct * 10) },
  timeP('cAtt', 'Comp attack time', 11, LIM_SHORT_MS, 0),
  timeP('cRel', 'Comp release time', 12, LIM_LONG_MS, 6666),
  curveP('cCurve', 'Comp curve', 13, 1),
  timeP('cSustain', 'Comp RMS window', 14, LIM_SHORT_MS, 650),
  gainP('nGain', 'Noise gain', 15, 1000, 1000),
  // FL starts at 0 (-inf: gate off); its knob resets to 100 (the editor overrides the reset value)
  gainP('nThres', 'Noise threshold', 16, 1000, 0),
  timeP('nRel', 'Noise release time', 17, LIM_LONG_MS, 4187),
];

/** Knob reset value FL uses for the noise threshold (form DefaultValue). */
export const NOISE_THRES_RESET = 100;

export type LimiterTab = 0 | 1; // LIMIT, COMP

export interface LimiterState {
  /** TargetSel: 0 = LIMIT, 1 = COMP. */
  tab: LimiterTab;
  /** Sidechain input (0 = none, k = FL's input k -> ctx.sidechain[k - 1]). */
  sidechain: number;
  /** Options > 0.2 dB limiter safety (ceiling x 0.975). */
  safety: boolean;
  /** Display: input peaks, output peaks, analysis & gain envelopes, level markers. */
  showIn: boolean;
  showOut: boolean;
  showEnv: boolean;
  showLevels: boolean;
  /** Scrolling speed slider 0..100. */
  speed: number;
  /** A/B spare state (parameter values). */
  spare: Record<string, number>;
}

export function limiterDefaults(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const p of LIMITER_PARAMS) o[p.key] = p.def;
  return o;
}

function limiterState(): Record<string, unknown> {
  const s: LimiterState = {
    tab: 0, sidechain: 0, safety: true, showIn: true, showOut: true, showEnv: true, showLevels: true, speed: 50,
    spare: limiterDefaults(),
  };
  return s as unknown as Record<string, unknown>;
}

function normalizeLimiter(p: Record<string, unknown>): Record<string, unknown> {
  const d = limiterState();
  const out: Record<string, unknown> = { ...p };
  for (const k of Object.keys(d)) if (out[k] === undefined || typeof out[k] !== typeof d[k]) out[k] = d[k];
  out.tab = out.tab === 1 ? 1 : 0;
  out.sidechain = Math.max(0, Math.round(Number(out.sidechain) || 0));
  out.speed = Math.min(100, Math.max(0, Number(out.speed)));
  const spare = (out.spare && typeof out.spare === 'object' ? out.spare : {}) as Record<string, unknown>;
  const fixed: Record<string, number> = {};
  for (const q of LIMITER_PARAMS) {
    const v = Number(spare[q.key]);
    fixed[q.key] = Number.isFinite(v) ? Math.min(q.max, Math.max(q.min, v)) : q.def;
  }
  out.spare = fixed;
  return out;
}

/** A factory preset from its 18 values in FL's parameter order. */
function preset(name: string, v: number[], extra: Record<string, unknown> = {}): FxPreset {
  const params: Record<string, unknown> = {};
  LIMITER_PARAMS.forEach((q, i) => { params[q.key] = v[i]; });
  return { name, params: { ...params, ...extra } };
}

/** FL's factory presets (values read from FL's own plugin with each preset loaded; tab/speed as saved). */
export const LIMITER_PRESETS: FxPreset[] = [
  preset('Default', [1000, 1000, 1000, 1115, 3, 5000, 3, 2882, 1000, 0, 0, 0, 6666, 1, 650, 1000, 0, 4187]),
  preset('Drum compression', [1764, 1000, 1000, 0, 3, 0, 3, 1008, 200, 1000, 644, 3936, 7178, 2, 650, 1000, 0, 4187], { tab: 1 }),
  preset('Drum compression 2', [1820, 1000, 1000, 267, 3, 5000, 1, 2882, 144, 684, 1000, 7424, 7450, 2, 650, 1000, 0, 4187], { tab: 1 }),
  preset('Drum compression 3', [1164, 1000, 1000, 411, 2, 7320, 1, 1147, 548, 0, -1000, 0, 6000, 1, 650, 1000, 0, 4187], { speed: 55 }),
  preset('Drum expanding', [564, 1000, 1000, 411, 2, 5592, 4, 411, 192, 0, -776, 0, 7898, 2, 650, 1000, 0, 4187]),
  preset('Ducking music behind voice', [1000, 1000, 1000, 7547, 2, 8968, 2, 7547, 1000, 0, 0, 0, 6666, 1, 650, 1000, 0, 4187]),
  preset('For drums', [1700, 1000, 1000, 1115, 2, 6360, 6, 1115, 1000, 0, 0, 0, 6666, 1, 650, 1000, 0, 4187]),
  preset('For drums (slight saturation)', [1700, 920, 1108, 1115, 2, 6360, 6, 1115, 1000, 0, 0, 0, 6666, 1, 650, 1000, 0, 4187]),
  preset('Max loudness', [1654, 1000, 1000, 1115, 3, 5000, 3, 1115, 1000, 0, 0, 0, 6666, 1, 650, 1000, 0, 4187]),
  preset('Max loudness (slight saturation)', [1712, 760, 1180, 1115, 3, 5000, 3, 1115, 1000, 0, 0, 0, 6666, 1, 650, 1000, 0, 4187]),
  preset('Max loudness except noise', [1654, 1000, 1000, 1115, 3, 5000, 3, 1115, 1000, 0, 0, 0, 6666, 1, 650, 1000, 108, 7424]),
  preset('Noise gate', [1000, 1000, 1000, 1115, 3, 5000, 3, 2882, 1000, 0, 0, 0, 6666, 1, 650, 0, 88, 6523]),
  preset('Transient shaping', [1352, 1000, 1000, 0, 3, 5000, 3, 2882, 200, 0, 1000, 7424, 8170, 2, 650, 1000, 0, 4187], { tab: 1 }),
];

export const def: FxPluginDef = {
  id: 'limiter',
  name: 'Limiter',
  category: 'Dynamics',
  width: 626,
  height: 300,
  description: 'Compressor, look-ahead limiter, noise gate and soft saturation',
  params: LIMITER_PARAMS,
  state: limiterState,
  normalize: normalizeLimiter,
  presets: LIMITER_PRESETS,
};
