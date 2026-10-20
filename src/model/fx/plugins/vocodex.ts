// Vocodex (FL: Vocodex): FL's advanced channel vocoder. Form: 593 x 603.
// Parameters 0..19 are FL's (names, ranges, value texts and the factory
// "Default" preset values read through the FL test host). Band count, filter
// order, unison order, envelope-follower mode, the switches, the inputs, the
// 13 mapping envelopes and the internal carrier synthesizer are FL's
// non-parameter state.

import type { FxPluginDef, FxParams } from '../types';

// ---- value curves (fitted to FL's value texts over every raw value) ----

/** Wet level / added noise: (7^x - 1) / 6, x = v / 1000 (wet) or v / 12800 (noise). */
export const vcxCurve7 = (x: number) => (Math.pow(7, x) - 1) / 6;
/** Pass-through levels: (11^x - 1) / 10, x = v / 12800 (12800 = 0 dB). */
export const vcxCurve11 = (x: number) => (Math.pow(11, x) - 1) / 10;
/** Envelope times: T (501^x - 1) / 500, x = v / 10000. */
export const vcxTime = (v: number, maxMs: number) => (maxMs * (Math.pow(501, v / 10000) - 1)) / 500;
/** HP / LP pass-through frequencies: 40 * 375^(v/65536) Hz (15 kHz at the top). */
export const vcxFilterHz = (v: number) => 40 * Math.pow(375, v / 65536);
/** Band width in percent of the band spacing: 100 (5^(v/1000) - 1). */
export const vcxBandWidth = (v: number) => Math.pow(5, v / 1000) - 1;
/** Envelope curve exponent 1..4: 2^(v/1000). */
export const vcxCurveExp = (v: number) => Math.pow(2, v / 1000);
/** Modulator band width multiplier x0.25 .. x4. */
export const vcxModBwMul = (v: number) => Math.pow(4, (v - 2000) / 2000);

function dbText(g: number): string {
  if (!(g > 1e-9)) return '-InfdB';
  const s = (20 * Math.log10(g)).toFixed(1);
  return `${s === '-0.0' ? '0.0' : s}dB`;
}

const pct = (v: number, div: number) => `${Math.round(v / div)}%`;

/** Cents text: "+0.00 cent", "-1200.00 cents". */
export function vcxCentsText(v: number): string {
  const a = Math.abs(v);
  return `${v < 0 ? '-' : '+'}${a.toFixed(2)} ${a <= 1 ? 'cent' : 'cents'}`;
}

// ---- mapping envelopes ----

/** FL's 13 mapping envelopes, in the editor's order (ArtSelect without the group headers). */
export const VCX_ENVELOPES = [
  'Band gain multiplier', 'Band panning', 'Band gain offset', 'Modulator noise level', 'Modulator pass-through',
  'Hold', 'Envelope attack', 'Envelope release',
  'Band distribution', 'Band width', 'Modulator pitch shift',
  'Saturation mix', 'Saturation curve',
];
/** The editor's target menu with FL's group headers ('-' prefix). */
export const VCX_ENV_MENU = [
  '-Equalizer', 'Band gain multiplier', 'Band panning', 'Band gain offset', 'Modulator noise level', 'Modulator pass-through',
  '-Envelope follower', 'Hold', 'Envelope attack', 'Envelope release',
  '-Spectral distribution', 'Band distribution', 'Band width', 'Modulator pitch shift',
  '-Envelope saturation', 'Saturation mix', 'Saturation curve',
];
export const VCX_ENV = {
  gain: 0, pan: 1, offset: 2, noise: 3, modPass: 4, hold: 5, attack: 6, release: 7,
  distribution: 8, width: 9, pitch: 10, satMix: 11, satCurve: 12,
} as const;

/** A mapping envelope point: [x 0..1, y 0..1, tension -1..1]. */
export type VcxPoint = [number, number, number];

/** FL's default envelopes (factory "Default" preset). */
export function vcxDefaultEnvelopes(): VcxPoint[][] {
  const flat = (y: number): VcxPoint[] => [[0, y, 0], [1, y, 0]];
  return [
    flat(0.5), flat(0.5), flat(0.5), flat(0), flat(0),
    flat(0.5), flat(0.5), flat(0.5),
    [[0, 0.14293710887432098, 0], [1, 0.9917563796043396, 0]],
    flat(0.5), flat(0.5),
    flat(0), [[0, 0, 0], [1, 1, 0]],
  ];
}

/** Evaluate an envelope at x (piecewise, FL tension curves; x clamped to 0..1). */
export function vcxEnvAt(pts: readonly VcxPoint[], x: number): number {
  const n = pts.length;
  if (n === 0) return 0;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < n; i++) {
    const p1 = pts[i];
    if (x <= p1[0]) {
      const p0 = pts[i - 1];
      const w = p1[0] - p0[0];
      let s = w > 1e-12 ? (x - p0[0]) / w : 1;
      const t = p1[2];
      if (t > 1e-6 || t < -1e-6) s = Math.pow(s, Math.pow(2, -t * 4));
      return p0[1] + (p1[1] - p0[1]) * s;
    }
  }
  return pts[n - 1][1];
}

// ---- frequency scale of the mapping envelopes / band distribution ----

/**
 * Frequency at a band-distribution level u (0..1): measured from FL: a cubic
 * in log frequency (21.1 kHz at the top), linear 606 Hz/unit below u = 0.11,
 * and never below 20 Hz.
 */
export function vcxScaleHz(u: number): number {
  if (u < 0.11) return Math.max(20, 606.06 * u);
  return Math.exp(((-0.03147339 * u + 0.06790693) * u + 6.42446453) * u + 3.49558394);
}

/** Inverse of vcxScaleHz (for the display's frequency axis). */
export function vcxScaleU(hz: number): number {
  if (hz <= vcxScaleHz(0.11)) return Math.max(0, Math.min(0.11, hz / 606.06));
  let lo = 0.11, hi = 1.2;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (vcxScaleHz(m) < hz) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

// ---- carrier synthesizer ----

/**
 * Internal carrier tones: FL's list (its Sytrus "Vocoder carriers"); the
 * sounds here are approximations made with a small built-in synth.
 */
export const VCX_TONES = [
  '(none)', 'Bright', 'Car horn', 'Chip', 'Elderly', 'Ensemble', 'Flanged pulse', 'Flanged saw', 'Gargling', 'Growling',
  'Harsh', 'Machine', 'Machine 2', 'Organ', 'Panner', 'Phased', 'Phased 2', 'Power', 'Pulse', 'PWM', 'Robot saw', 'Saw',
  'Scythe', 'Supersaw', 'Tube', 'Weird',
];
const tone = (name: string) => Math.max(0, VCX_TONES.indexOf(name));

export const VCX_BANDS_MIN = 5;
export const VCX_BANDS_MAX = 100;

export interface VocodexState {
  bands: number; order: number; unison: number; holdMode: number;
  minTimes: boolean; lr: boolean; draft: boolean; threaded: boolean;
  contToMod: boolean; contToNoise: boolean; contFromCar: boolean; contFromCons: boolean;
  modIn: number; carIn: number;
  envs: VcxPoint[][]; envSel: number; pitchFollow: boolean[];
  tone: number; notes: number[]; subDenoise: boolean;
}

function vcxState(): VocodexState {
  return {
    bands: 47, order: 2, unison: 0, holdMode: 0,
    minTimes: true, lr: false, draft: true, threaded: true,
    contToMod: true, contToNoise: true, contFromCar: false, contFromCons: true,
    modIn: 1, carIn: 0,
    envs: vcxDefaultEnvelopes(), envSel: 0,
    pitchFollow: [false, false, false, true, true, false, false, false, false, false, false, false, false],
    tone: 0, notes: [60], subDenoise: false,
  };
}

function normEnv(e: unknown, fallback: VcxPoint[]): VcxPoint[] {
  if (!Array.isArray(e) || e.length < 1) return fallback;
  const out: VcxPoint[] = [];
  let px = 0;
  for (const p of e) {
    if (!Array.isArray(p)) continue;
    const x = Math.min(1, Math.max(px, Number(p[0]) || 0));
    const y = Math.min(1, Math.max(0, Number(p[1]) || 0));
    const t = Math.min(1, Math.max(-1, Number(p[2]) || 0));
    out.push([x, y, t]);
    px = x;
  }
  return out.length ? out : fallback;
}

const P = (v: number) => v; // raw-value presets helper (readability)

export const def: FxPluginDef = {
  id: 'vocodex',
  name: 'Vocodex',
  category: 'Misc',
  width: 593,
  height: 603,
  description: 'Channel vocoder with mapping envelopes, unison and an internal carrier',
  params: [
    { key: 'wet', name: 'Wet level', index: 0, min: 0, max: 2000, def: 1000, format: (v) => dbText(vcxCurve7(v / 1000)) },
    { key: 'sg', name: 'Soundgoodizing level', index: 1, min: 0, max: 1000, def: 150, format: (v) => pct(v, 10) },
    { key: 'modLvl', name: 'Modulator pass-through level', index: 2, min: 0, max: 16000, def: 12800, format: (v) => dbText(vcxCurve11(v / 12800)) },
    { key: 'modHp', name: 'Modulator pass-through highpass frequency', index: 3, min: 0, max: 65536, def: 55000, format: (v) => (v <= 0 ? 'Off' : `${Math.round(vcxFilterHz(v))}Hz`) },
    { key: 'carLvl', name: 'Carrier pass-through level', index: 4, min: 0, max: 16000, def: 0, format: (v) => dbText(vcxCurve11(v / 12800)) },
    { key: 'carLp', name: 'Carrier pass-through lowpass frequency', index: 5, min: 0, max: 65536, def: 28000, format: (v) => (v >= 65536 ? 'Off' : `${Math.round(vcxFilterHz(v))}Hz`) },
    { key: 'noise', name: 'Carrier added noise level', index: 6, min: 0, max: 12800, def: 0, format: (v) => pct(v, 128) },
    { key: 'noiseHp', name: 'Carrier added noise highpass frequency', index: 7, min: 0, max: 65536, def: 55000, format: (v) => (v <= 0 ? 'Off' : `${Math.round(vcxFilterHz(v))}Hz`) },
    { key: 'hold', name: 'Hold time', index: 8, min: 0, max: 10000, def: 1666, format: (v) => `${vcxTime(v, 250).toFixed(2)}ms` },
    { key: 'att', name: 'Attack time', index: 9, min: 0, max: 10000, def: 1115, format: (v) => `${vcxTime(v, 1000).toFixed(2)}ms` },
    { key: 'attCurve', name: 'Attack curve', index: 10, min: 0, max: 2000, def: 0, format: (v) => vcxCurveExp(v).toFixed(2) },
    { key: 'rel', name: 'Release time', index: 11, min: 0, max: 10000, def: 3500, format: (v) => `${vcxTime(v, 2000).toFixed(2)}ms` },
    { key: 'relCurve', name: 'Release curve', index: 12, min: 0, max: 2000, def: 0, format: (v) => vcxCurveExp(v).toFixed(2) },
    { key: 'freeze', name: 'Freeze envelope', index: 13, min: 0, max: 1, def: 0, format: () => '' },
    { key: 'bw', name: 'Band width', index: 14, min: 5, max: 1000, def: 349, format: (v) => `${Math.round(100 * vcxBandWidth(v))}%` },
    { key: 'flat', name: 'Filter flatness', index: 15, min: 0, max: 100, def: 100, format: (v) => `${Math.round(v)}%` },
    { key: 'modBw', name: 'Modulator band width multiplier', index: 16, min: 0, max: 4000, def: 2000, format: (v) => `x${vcxModBwMul(v).toFixed(3)}` },
    { key: 'pitch', name: 'Modulator pitch shift', index: 17, min: -1200, max: 1200, def: 0, bipolar: true, format: vcxCentsText },
    { key: 'uniShift', name: 'Modulator unison shift', index: 18, min: 0, max: 1000, def: 250, format: (v) => pct(v, 10) },
    { key: 'uniPan', name: 'Modulator unison panning', index: 19, min: -256, max: 256, def: 128, bipolar: true, format: (v) => `${Math.round(v / 2.56)}%` },
  ],
  state: () => ({ ...vcxState() }),
  normalize: (p: FxParams) => {
    const d = vcxState();
    const num = (v: unknown, dv: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dv);
    const bool = (v: unknown, dv: boolean) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : dv);
    const envs = Array.isArray(p.envs) ? (p.envs as unknown[]) : [];
    const pf = Array.isArray(p.pitchFollow) ? (p.pitchFollow as unknown[]) : [];
    return {
      ...p,
      bands: num(p.bands, d.bands, VCX_BANDS_MIN, VCX_BANDS_MAX),
      order: num(p.order, d.order, 1, 4),
      unison: num(p.unison, d.unison, 0, 4),
      holdMode: num(p.holdMode, d.holdMode, 0, 1),
      minTimes: bool(p.minTimes, d.minTimes), lr: bool(p.lr, d.lr), draft: bool(p.draft, d.draft), threaded: bool(p.threaded, d.threaded),
      contToMod: bool(p.contToMod, d.contToMod), contToNoise: bool(p.contToNoise, d.contToNoise),
      contFromCar: bool(p.contFromCar, d.contFromCar), contFromCons: bool(p.contFromCons, d.contFromCons),
      modIn: num(p.modIn, d.modIn, -1, 64), carIn: num(p.carIn, d.carIn, -1, 64),
      envs: d.envs.map((e, i) => normEnv(envs[i], e)),
      envSel: num(p.envSel, d.envSel, 0, VCX_ENVELOPES.length - 1),
      pitchFollow: d.pitchFollow.map((v, i) => (typeof pf[i] === 'boolean' ? (pf[i] as boolean) : v)),
      tone: num(p.tone, d.tone, 0, VCX_TONES.length - 1),
      notes: Array.isArray(p.notes) ? (p.notes as unknown[]).filter((n): n is number => typeof n === 'number' && n >= 0 && n < 128).map(Math.round) : d.notes,
      subDenoise: bool(p.subDenoise, d.subDenoise),
    };
  },
  presets: vcxPresets(),
};

/**
 * FL's factory presets (values read through the FL test host from FL's
 * preset files, mapped to this plugin's keys). Presets made with an older
 * Vocodex (no noise highpass parameter) leave it at its default.
 */
function vcxPresets(): { name: string; params: Record<string, unknown> }[] {
  const keys = ['wet', 'sg', 'modLvl', 'modHp', 'carLvl', 'carLp', 'noise', 'noiseHp', 'hold', 'att', 'attCurve', 'rel', 'relCurve', 'freeze', 'bw', 'flat', 'modBw', 'pitch', 'uniShift', 'uniPan'];
  const v5 = (vals: number[]) => Object.fromEntries(vals.map((v, i) => [keys[i], P(v)]));
  // older presets: 19 parameters (no noise highpass) and no contour switches
  const v2 = (vals: number[]) => ({
    ...Object.fromEntries(vals.map((v, i) => [keys[i < 7 ? i : i + 1], P(v)])),
    contToMod: false, contToNoise: false, contFromCons: false, contFromCar: false,
  });
  const flat = (y: number): VcxPoint[] => [[0, y, 0], [1, y, 0]];
  const envs = (over: Record<number, VcxPoint[]>) => vcxDefaultEnvelopes().map((e, i) => over[i] ?? e);
  const bark = barkDistribution();
  const S = (o: Partial<VocodexState>) => o;
  // contour switch sets used by the newer presets [toMod, toNoise, fromCar, fromCons]
  const C = (m: number, n: number, c: number, k: number, threaded = true) =>
    ({ contToMod: !!m, contToNoise: !!n, contFromCar: !!c, contFromCons: !!k, threaded });
  const old = [1000, 150, 0, 62000, 0, 28000, 0, 1666, 1115, 0, 3500, 0, 0, 349, 100, 2000, 0, 250, 128];
  return [
    { name: 'Default', params: {} },
    // Configuration
    { name: 'Bark scale', params: { ...v2(old), ...S({ envs: envs({ 8: bark }) }) } },
    { name: 'Sidechained carrier', params: { ...v2(old), ...S({ modIn: 0, carIn: 1 }) } },
    { name: 'Sidechained modulator', params: { ...v2(old), ...S({ modIn: 1, carIn: 0 }) } },
    { name: 'Stereo interlacing', params: { ...v2(old), ...S({ lr: true }) } },
    // Immediate (internal carrier)
    { name: 'Autovocoding', params: { ...v5([1000, 150, 12800, 55000, 3600, 65536, 3000, 55000, 1666, 1115, 0, 3500, 0, 0, 349, 100, 2000, -1200, 250, 128]), ...S({ modIn: 0, carIn: 0, notes: [] }), ...C(1, 1, 0, 1) } },
    { name: 'Chord', params: { ...v5([1000, 150, 12800, 55000, 0, 28000, 0, 55000, 1666, 1115, 0, 4348, 0, 0, 349, 100, 2000, 0, 250, 128]), ...S({ modIn: 0, carIn: -1, tone: tone('PWM'), notes: [60, 77, 69] }), ...C(1, 1, 1, 1, false) } },
    { name: 'Clearer', params: { ...v5([1000, 150, 12800, 42840, 0, 28000, 0, 58000, 1666, 1115, 0, 3500, 0, 0, 349, 100, 2000, 0, 250, 128]), ...S({ modIn: 0, carIn: -1, tone: tone('Ensemble'), notes: [64, 67] }), ...C(1, 1, 0, 1, false) } },
    { name: 'Elderly', params: { ...v2(old), ...S({ holdMode: 1, modIn: 0, carIn: -1, tone: tone('Elderly'), notes: [60] }) } },
    { name: 'For drums 2', params: { ...v5([1196, 150, 12800, 0, 0, 28000, 5400, 38784, 0, 0, 2000, 5484, 0, 0, 349, 100, 3344, 0, 378, 128]), ...S({ bands: 80, modIn: 0, carIn: -1, tone: tone('Growling'), notes: [71, 77], envs: envs({ 0: [[0, 0.781, 0], [1, 0.219, 0]] }) }), ...C(0, 1, 0, 0, false) } },
    { name: 'For drums', params: { ...v2([876, 150, 9800, 0, 0, 28000, 0, 0, 0, 0, 4812, 0, 0, 485, 100, 2000, 0, 250, 128]), ...S({ bands: 13, modIn: 0, carIn: -1, tone: tone('Phased 2'), notes: [60] }) } },
    { name: 'Group', params: { ...v2([1136, 687, 0, 62000, 0, 28000, 0, 1666, 1115, 0, 4684, 0, 0, 349, 100, 2000, -224, 346, 128]), ...S({ unison: 4, modIn: 0, carIn: -1, tone: tone('Supersaw'), notes: [55] }) } },
    { name: 'Helium', params: { ...v2([1224, 150, 0, 62000, 0, 28000, 0, 1666, 1115, 0, 4348, 0, 0, 349, 100, 2000, 500, 250, 128]), ...S({ modIn: 0, carIn: -1, tone: tone('Saw'), notes: [60] }) } },
    { name: 'More testosterone', params: { ...v2([1224, 150, 0, 62000, 0, 28000, 0, 1666, 1115, 0, 4348, 0, 0, 349, 100, 2000, -500, 250, 128]), ...S({ modIn: 0, carIn: -1, tone: tone('Saw'), notes: [60] }) } },
    { name: 'Old school', params: { ...v2([1000, 687, 0, 62000, 0, 28000, 0, 1666, 1115, 0, 4684, 0, 0, 443, 100, 2000, 0, 346, 128]), ...S({ unison: 4, bands: 8, modIn: 0, carIn: -1, tone: tone('Robot saw'), notes: [67], envs: envs({ 8: bark }) }) } },
    { name: 'Power', params: { ...v2(old), ...S({ holdMode: 1, modIn: 0, carIn: -1, tone: tone('Power'), notes: [60] }) } },
    { name: 'Robot', params: { ...v5([780, 662, 0, 55000, 0, 28000, 6100, 55000, 1666, 1115, 0, 3500, 0, 0, 365, 100, 1744, -120, 346, 128]), ...S({ holdMode: 1, order: 1, bands: 24, modIn: 0, carIn: -1, tone: tone('Robot saw'), notes: [76], envs: envs({ 8: bark }) }), ...C(1, 1, 0, 1) } },
    // Special effects
    { name: 'Backing voices', params: { ...v5([1000, 150, 12800, 0, 0, 28000, 9600, 0, 6048, 1115, 0, 3500, 0, 0, 349, 100, 2000, 176, 200, 128]), ...S({ holdMode: 1, unison: 2, modIn: 0, carIn: -1, envs: envs({ 3: flat(0.344), 7: [[0, 0.531, 0], [1, 0.5, 0]] }) }), ...C(0, 1, 0, 0, false) } },
    { name: 'Droplets', params: { ...v2([1412, 150, 0, 62000, 0, 28000, 0, 5554, 5067, 0, 6380, 0, 0, 301, 100, 2000, 0, 250, 128]), ...S({ modIn: 0, carIn: -1, tone: tone('Power'), notes: [60], envs: envs({ 11: flat(1) }) }) } },
    { name: 'Reverb 2', params: { ...v5([1000, 0, 12800, 0, 0, 28000, 5600, 0, 4432, 3803, 0, 8720, 0, 0, 429, 100, 2000, 0, 250, 128]), ...S({ holdMode: 1, order: 3, bands: 51, modIn: 0, carIn: -1, envs: envs({ 0: [[0, 0.656, 0], [1, 0.094, 0]], 7: [[0, 0.75, 0], [1, 0.438, 0]] }) }), ...C(0, 1, 0, 0, false) } },
    { name: 'Reverb', params: { ...v5([1000, 0, 12800, 0, 0, 28000, 5600, 0, 6048, 3803, 0, 8448, 0, 0, 349, 100, 2000, 0, 250, 128]), ...S({ holdMode: 1, modIn: 0, carIn: -1, envs: envs({ 0: [[0, 0.594, 0], [1, 0.312, 0]], 7: [[0, 0.812, 0], [1, 0.344, 0]] }) }), ...C(0, 0, 0, 0) } },
  ];
}

/** FL's "Bark scale" band distribution (from the factory preset; 24 points). */
function barkDistribution(): VcxPoint[] {
  const ys = [0.0983, 0.2356, 0.3146, 0.3667, 0.4072, 0.442, 0.4738, 0.5029, 0.5289, 0.5538, 0.5781, 0.6015, 0.6248, 0.6479,
    0.6711, 0.6947, 0.7191, 0.745, 0.7729, 0.8018, 0.8307, 0.8614, 0.8958, 0.9339];
  return ys.map((y, i) => [i === ys.length - 1 ? 1 : i / (ys.length - 1), y, 0] as VcxPoint);
}
