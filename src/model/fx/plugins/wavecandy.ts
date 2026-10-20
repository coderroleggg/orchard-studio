// Wave Candy (FL: Wave Candy): oscilloscope, spectrum (sonogram), level
// meter and vectorscope shown in a separate display window, configured by a
// 592 x 315 settings panel. One parameter (0 "Hold visualization"); all the
// rest is state, decoded from FL's saved state (version 9): Input, Appearance,
// 28 colour targets, the four mode sheets and the display window rectangles.
// Defaults are FL's "Default" factory preset (applied on insert); the other 37
// factory presets come from FL's preset files (see ./wavecandy/presets.ts).

import type { FxPluginDef, FxPreset } from '../types';
import { WC_DEFAULT, WC_PRESET_DIFFS } from './wavecandy/presets';

export const WC_MODES = ['Oscilloscope', 'Spectrum', 'Meter', 'Vectorscope'];
export const WC_METER_MODES = ['Peak', 'PPM', 'RMS', 'Vu', 'Leq(A)', 'ITU-R BS.1770'];
export const WC_METER_HINTS = ['Classic peak meter', 'PPM style meter', 'RMS measurement', 'VU style meter', 'RMS based A-weighted loudness measurement', 'ITU-R BS.1770 based loudness measurement'];
export const WC_VEC_MODES = ['String', 'Spaghetti', 'Tube', 'Glowstick'];
export const WC_BANDS = ['32 bands', '64 bands', '128 bands', '256 bands', '512 bands', '1024 bands', '2048 bands', '4096 bands', '8192 bands'];

/** FL's colour target list: entries starting with '-' are section headers. */
export const WC_TARGET_ITEMS = [
  '-Frame', 'Background', 'Background punches', 'Border', '-Bevel', 'Bevel top', 'Bevel bottom', '-Glass', 'Reflection top',
  'Reflection bottom', '-Text', 'Title', 'Labels', 'Hint', '-Helpers', 'Hint location', '-Oscilloscope', 'Oscilloscope ruler',
  'Waveform', '-Spectrum', 'Spectrum gradient color 1', 'Spectrum gradient color 2', 'Spectrum gradient color 3',
  'Spectrum gradient color 4', 'Spectrum gradient color 5', '-Peak meter', 'Meter background', 'Meter gradient color -INFdB',
  'Meter gradient color -6dB', 'Meter gradient color -0dB', 'Meter gradient color +0dB', 'Meter gradient color +6dB',
  '-Vectorscope', 'Vectorscope ruler', 'Lissajou', '-Eye candy', 'Glowing lights', 'Glass effect',
];
/** Colour target indices (order of the saved colour block). */
export const T = {
  background: 0, punches: 1, border: 2, bevelTop: 3, bevelBottom: 4, reflTop: 5, reflBottom: 6, title: 7, labels: 8,
  hint: 9, hintLoc: 10, oscRuler: 11, waveform: 12, spec1: 13, spec2: 14, spec3: 15, spec4: 16, spec5: 17, meterBg: 18,
  meterInf: 19, meter6: 20, meter0: 21, meterP0: 22, meterP6: 23, vecRuler: 24, lissajou: 25, glow: 26, glass: 27,
} as const;

/** A colour target: [object opacity, colour opacity, hue, lightness, saturation], all 0..256. */
export type WcColorTarget = [number, number, number, number, number];

export interface WcRgba { r: number; g: number; b: number; a: number; oa: number }

/** HLS (hue 0..256 = 0..360 deg) to RGB 0..255, as FL computes the stored colours. */
export function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  const L = l / 256, S = s / 256, H = (((h / 256) * 360) % 360 + 360) % 360;
  const C = (1 - Math.abs(2 * L - 1)) * S;
  const X = C * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = L - C / 2;
  const [r, g, b] = H < 60 ? [C, X, 0] : H < 120 ? [X, C, 0] : H < 180 ? [0, C, X] : H < 240 ? [0, X, C] : H < 300 ? [X, 0, C] : [C, 0, X];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** RGB 0..255 to FL's HLS 0..256 (colour button). */
export function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d > 1e-9) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [Math.round((h / 360) * 256) % 256, Math.round(l * 256), Math.round(Math.min(1, s) * 256)];
}

export function wcColor(c: readonly number[] | undefined): WcRgba {
  const t = c && c.length >= 5 ? c : [256, 256, 0, 256, 0];
  const [r, g, b] = hlsToRgb(t[2], t[3], t[4]);
  return { r, g, b, a: Math.max(0, Math.min(1, t[1] / 256)), oa: Math.max(0, Math.min(1, t[0] / 256)) };
}

export function rgba(c: WcRgba, alpha = c.a * c.oa): string {
  return `rgba(${c.r},${c.g},${c.b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export interface WcState {
  mode: number; auto: boolean; gain: number; fade: number; reflect: number; punches: number; corners: number; glow: boolean;
  visible: boolean; mini: boolean; background: boolean; solid: boolean; onDesktop: boolean; stayOnTop: boolean;
  title: string; font: string; fontSize: number; fontStyle: number; titleAlign: number;
  oscUpdate: number; oscWindow: number; oscSep: number; oscPinch: boolean; oscInterp: boolean;
  specUpdate: number; specRes: number; specScale: number; specRange: number; specNatural: boolean; specEnhanced: boolean;
  meterScale: number; meterHold: number; meterMode: number; meterSpeed: number;
  vecUpdate: number; vecThickness: number; vecMode: number; vecAdd: boolean;
  rect: number[]; miniRect: number[]; colors: number[][];
}

const RANGES: Record<string, [number, number]> = {
  mode: [0, 3], gain: [-120, 120], fade: [0, 5001], reflect: [-256, 256], punches: [-24, 24], corners: [0, 512],
  fontSize: [6, 96], fontStyle: [0, 15], titleAlign: [0, 2], oscUpdate: [500, 5000], oscWindow: [1000, 10000], oscSep: [-1, 1000],
  specUpdate: [500, 10000], specRes: [0, 8], specScale: [0, 256], specRange: [48, 144], meterScale: [0, 256], meterHold: [0, 5001],
  meterMode: [0, 5], meterSpeed: [1, 5000], vecUpdate: [500, 5000], vecThickness: [100, 600], vecMode: [0, 3],
};
const BOOLS = ['auto', 'glow', 'visible', 'mini', 'background', 'solid', 'onDesktop', 'stayOnTop', 'oscPinch', 'oscInterp', 'specNatural', 'specEnhanced', 'vecAdd'];

/** A fresh copy of the Default preset state (JSON clone: this module also loads in the AudioWorklet). */
function defaults(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(WC_DEFAULT)) as Record<string, unknown>;
}

/** A complete, valid Wave Candy state from any stored object. */
export function wcState(p: Record<string, unknown>): WcState {
  const d = defaults();
  const o: Record<string, unknown> = { ...d };
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = Number(p[k]);
    o[k] = Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d[k];
  }
  for (const k of BOOLS) o[k] = p[k] === undefined ? d[k] : !!p[k];
  for (const k of ['title', 'font']) o[k] = typeof p[k] === 'string' ? (p[k] as string).slice(0, 128) : d[k];
  for (const k of ['rect', 'miniRect']) {
    const r = p[k];
    o[k] = Array.isArray(r) && r.length === 4 && r.every((x) => Number.isFinite(Number(x))) ? r.map((x) => Math.round(Number(x))) : d[k];
  }
  const cols = (d.colors as number[][]).map((c) => [...c]);
  if (Array.isArray(p.colors)) {
    (p.colors as unknown[]).forEach((c, i) => {
      if (i < cols.length && Array.isArray(c) && c.length >= 5) cols[i] = c.slice(0, 5).map((x) => Math.max(0, Math.min(256, Math.round(Number(x) || 0))));
    });
  }
  o.colors = cols;
  return o as unknown as WcState;
}

/** The display mode actually shown: the mini view is a meter; "Auto visual mode" picks by window shape. */
export function wcEffectiveMode(s: Pick<WcState, 'mode' | 'auto' | 'mini' | 'rect'>): number {
  if (s.mini) return 2;
  if (!s.auto) return s.mode;
  const w = Math.max(1, s.rect[2]), h = Math.max(1, s.rect[3]);
  const ratio = w / h;
  if (ratio < 0.45) return 2; // tall and narrow: meter
  if (ratio < 0.8) return 1; // tall: spectrum
  if (ratio < 1.25) return 3; // square: vectorscope
  return 0; // wide: oscilloscope
}

// ------------------------------------------------------------------ scales

/** Visual gain: value / 10 dB (FL: exp(value * 0.1 * ln10 / 20)). */
export function wcGain(v: number): number {
  return Math.pow(10, v / 200);
}

/** Meter scale: amplitude shown at the top of the meter, and the curve exponent (128 = linear amplitude, as FL's default). */
export const WC_METER_TOP = 1.25;
export function wcMeterFrac(amp: number, scale: number): number {
  const e = Math.pow(2, (128 - scale) / 64);
  return Math.pow(Math.max(0, Math.min(1, amp / WC_METER_TOP)), e);
}
export function wcMeterAmp(frac: number, scale: number): number {
  const e = Math.pow(2, (128 - scale) / 64);
  return WC_METER_TOP * Math.pow(Math.max(0, Math.min(1, frac)), 1 / e);
}

/**
 * Spectrum frequency axis (fraction from the bottom, 20 Hz .. 20 kHz). At Scale 0
 * FL's labels follow ln(1 + f/300) (fitted to the manual screenshot); turning right
 * moves toward a log axis, which is exact (piano keyboard) at 256.
 */
export function wcFreqFrac(f: number, scale: number): number {
  const fc = Math.max(20, Math.min(20000, f));
  if (scale >= 256) return Math.log(fc / 20) / Math.log(1000);
  const f0 = 300 * Math.pow(1 / 15, scale / 256);
  return Math.log(1 + (fc - 20) / f0) / Math.log(1 + 19980 / f0);
}
export function wcFracFreq(y: number, scale: number): number {
  const t = Math.max(0, Math.min(1, y));
  if (scale >= 256) return 20 * Math.pow(1000, t);
  const f0 = 300 * Math.pow(1 / 15, scale / 256);
  return 20 + f0 * (Math.pow(1 + 19980 / f0, t) - 1);
}

/** Display rows the DSP sends per spectrum column (log spaced, 20 Hz .. 20 kHz). */
export const WC_SPEC_ROWS = 384;
export function wcRowFreq(i: number): number {
  return 20 * Math.pow(1000, i / (WC_SPEC_ROWS - 1));
}

/** Wheel value texts (FL shows ms / dB and the hold extremes). */
export function wcMsText(v: number): string { return `${Math.round(v)} ms`; }
export function wcHoldText(v: number): string { return v <= 0 ? 'No hold' : v >= 5001 ? 'Infinite hold' : `${Math.round(v)} ms`; }
export function wcGainText(v: number): string { return `${v > 0 ? '+' : ''}${(v / 10).toFixed(1)} dB`; }

function presetParams(diff: Record<string, unknown>): Record<string, unknown> {
  const base = defaults();
  const out: Record<string, unknown> = { ...base, hold: 0 };
  for (const [k, v] of Object.entries(diff)) {
    if (k === 'colors') {
      const cols = (base.colors as number[][]).map((c) => [...c]);
      for (const [i, c] of Object.entries(v as Record<string, number[]>)) cols[Number(i)] = [...c];
      out.colors = cols;
    } else out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

export const WC_PRESETS: FxPreset[] = WC_PRESET_DIFFS.map(([name, diff]) => ({ name, params: presetParams(diff) }));

export const def: FxPluginDef = {
  id: 'wavecandy',
  name: 'Wave Candy',
  category: 'Visual',
  width: 592,
  height: 315,
  description: 'Oscilloscope, spectrum, meter and vectorscope',
  params: [
    { key: 'hold', name: 'Hold visualization', index: 0, min: 0, max: 1, def: 0, format: () => '' },
  ],
  state: defaults,
  normalize: (p) => ({ ...p, ...wcState(p) }),
  presets: WC_PRESETS,
};
