// Parametric EQ 2: parameters, defaults and the band -> biquad design shared by
// the audio engine and the editor's curve display (docs/research/peq2.md,
// measured laws in docs/research/fx/peq2.md and ./peq2design.ts).

import type { BiquadCoefs } from '../engine/dsp/biquad';
import {
  bandSpecs, biquadResponse, draftSection, hqSection, LIN_EXPONENT, octQ, peakOct,
  type SectionSpec,
} from './peq2design';

export type { SectionSpec } from './peq2design';

export type PEQ2Type = 'off' | 'lowpass' | 'bandpass' | 'highpass' | 'notch' | 'lowshelf' | 'peaking' | 'highshelf';
export const PEQ2_TYPES: PEQ2Type[] = ['off', 'lowpass', 'bandpass', 'highpass', 'notch', 'lowshelf', 'peaking', 'highshelf'];
export const PEQ2_TYPE_LABELS: Record<PEQ2Type, string> = {
  off: 'Off', lowpass: 'Low pass', bandpass: 'Band pass', highpass: 'High pass', notch: 'Notch',
  lowshelf: 'Low shelf', peaking: 'Peaking', highshelf: 'High shelf',
};
/** Names used in the token popup menu. */
export const PEQ2_TYPE_MENU: Partial<Record<PEQ2Type, string>> = {
  lowpass: 'Low Pass', bandpass: 'Band Pass', highpass: 'High Pass', notch: 'Band Cut',
  lowshelf: 'Low Shelf', peaking: 'Peaking', highshelf: 'High Shelf',
};

/** Order enum -3..3: Steep 8/6/4, "2", Gentle 4/6/8. */
export const PEQ2_ORDERS = [-3, -2, -1, 0, 1, 2, 3];
export function orderLabel(o: number): string {
  if (o === 0) return '2';
  return `${o < 0 ? 'Steep' : 'Gentle'} ${2 + 2 * Math.abs(o)}`;
}
export function orderDbPerOct(o: number): number {
  return 12 * (1 + Math.abs(o));
}

export type PEQ2HqMode = 'plus' | 'legacy' | 'enhanced';
export type PEQ2Monitor = 'off' | 'input' | 'output';

export interface PEQ2Band {
  type: PEQ2Type;
  level: number; // dB, -18..18
  freq: number; // normalised 0..1 -> 20 Hz .. 20 kHz (log)
  bw: number; // normalised 0..1 -> 0.1 .. 5.0 octaves
  order: number; // -3..3
  enabled: boolean; // mute switch (lit = enabled)
  solo: boolean;
}

export interface PEQ2Bank {
  bands: PEQ2Band[];
  mainLevel: number; // dB
}

export interface PEQ2Options {
  lockSpare: boolean;
  soloOnShift: boolean;
  soloMode: 'bandpass' | 'adaptive';
  inheritBw: boolean;
  minPhaseModSpeed: 0 | 1 | 2; // Off / Medium / Smooth
  linModSpeed: 0 | 1 | 2 | 3; // Normal / Fast / Faster / Ultra
  phaseRotation: boolean;
  monitorInput: 'mid' | 'side' | 'left' | 'right';
  histogram: boolean;
  range: -60 | -90 | -120;
  pivot: 0 | 1.5 | 3 | 4.5 | 6;
  freqPrecision: 0 | 1 | 2 | 3; // Low / Medium / High / Highest
  timeSmoothing: 0 | 1 | 2 | 3 | 4; // Fastest .. Slowest
  average: boolean;
  heatmap: boolean;
  heatmapHighPrecision: boolean;
  enhancedFreq: boolean;
  heatmapPosition: 'top' | 'bottom' | 'full';
}

export interface PEQ2Params extends PEQ2Bank {
  spare: PEQ2Bank;
  onSpare: boolean; // compare: currently showing the spare bank
  lin: boolean;
  linPrecision: number; // 0..5 (Lowest .. Highest), default 2 (Medium)
  hq: boolean;
  hqMode: PEQ2HqMode;
  showTokens: boolean;
  monitor: PEQ2Monitor;
  opts: PEQ2Options;
}

export const PEQ2_LEVEL_MAX = 18;
export const PEQ2_MAIN_MAX = 18;

/** Band colours (violet, pink, salmon, yellow, green, aqua, blue). */
export const PEQ2_BAND_COLORS = ['#b17dec', '#ec7dcd', '#ec917e', '#ebed7e', '#89ec7e', '#7cecd5', '#7cabed'];

export const BW_DEFAULT_PEAK = 25412 / 65536; // 2.0 octaves
export const BW_DEFAULT_SHELF = 40124 / 65536; // 3.1 octaves

export function defaultBand(k: number): PEQ2Band {
  const type: PEQ2Type = k === 0 ? 'lowshelf' : k === 6 ? 'highshelf' : 'peaking';
  return {
    type,
    level: 0,
    freq: Math.round(((2 * k + 3) / 18) * 65536) / 65536, // FL's 10923 .. 54613 of 65536: 63 Hz .. 6.3 kHz, 1/3 decade apart
    bw: type === 'peaking' ? BW_DEFAULT_PEAK : BW_DEFAULT_SHELF,
    order: 0,
    enabled: true,
    solo: false,
  };
}

export function defaultBank(): PEQ2Bank {
  return { bands: Array.from({ length: 7 }, (_, k) => defaultBand(k)), mainLevel: 0 };
}

export function defaultPEQ2(): PEQ2Params {
  const main = defaultBank();
  return {
    ...main,
    spare: defaultBank(),
    onSpare: false,
    lin: false,
    linPrecision: 2,
    hq: true,
    hqMode: 'plus', // FL's default state: HQ on, HQ+ (stored HQ = 3)
    showTokens: true,
    monitor: 'output',
    opts: {
      lockSpare: false,
      soloOnShift: false,
      soloMode: 'adaptive',
      inheritBw: false,
      minPhaseModSpeed: 0,
      linModSpeed: 0,
      phaseRotation: false,
      monitorInput: 'mid',
      histogram: true,
      range: -120,
      pivot: 4.5,
      freqPrecision: 1,
      timeSmoothing: 2,
      average: false,
      heatmap: false,
      heatmapHighPrecision: false,
      enhancedFreq: false,
      heatmapPosition: 'full',
    },
  };
}

export function normalizePEQ2(p: Partial<PEQ2Params> | undefined): PEQ2Params {
  const d = defaultPEQ2();
  if (!p) return d;
  const bands = (p.bands ?? d.bands).map((b, i) => ({ ...defaultBand(i), ...b }));
  return { ...d, ...p, bands, spare: p.spare ?? defaultBank(), opts: { ...d.opts, ...(p.opts ?? {}) } };
}

// ---------------------------------------------------------------- mappings
export function freqHz(x: number): number {
  return 20 * Math.pow(10, 3 * x);
}

export function freqNorm(f: number): number {
  return Math.min(1, Math.max(0, Math.log10(f / 20) / 3));
}

/** The BW knob in octaves as peaking bands read it (0.1 .. 5.0). */
export function bwOctaves(x: number): number {
  return peakOct(Math.min(1, Math.max(0, x)));
}

/** Analog Q for a bandwidth in octaves (between half-gain points). */
export function octToQ(oct: number): number {
  return octQ(oct);
}

export function bwQ(x: number): number {
  return octToQ(bwOctaves(x));
}

export function typeHasLevel(t: PEQ2Type): boolean {
  return t === 'lowshelf' || t === 'peaking' || t === 'highshelf';
}

export function formatFreq(f: number): string {
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz`;
  return `${f >= 100 ? Math.round(f) : f.toFixed(1)} Hz`;
}

// ----------------------------------------------------------------- design

/** Bands active for processing (respects mute and solo). */
export function activeBands(bank: PEQ2Bank): PEQ2Band[] {
  const anySolo = bank.bands.some((b) => b.solo && b.enabled && b.type !== 'off');
  return bank.bands.filter((b) => b.enabled && b.type !== 'off' && (!anySolo || b.solo));
}

/** True when the band is an exact pass-through (peaking / shelf at 0 dB). */
export function bandIsFlat(b: PEQ2Band): boolean {
  return typeHasLevel(b.type) && b.level === 0;
}

/** Translate one band into cascaded second-order sections (empty = identity). */
export function bandSections(b: PEQ2Band): SectionSpec[] {
  if (!b.enabled || b.type === 'off' || bandIsFlat(b)) return [];
  return bandSpecs(b.type, b.freq, b.bw, b.level, b.order);
}

/** draft = HQ off (RBJ at the host rate), plus = HQ+ (decramped), os2 = HQ Legacy / Enhanced (RBJ at twice the rate). */
export type DesignMode = 'draft' | 'plus' | 'os2';

/** Design the biquad for a section at sample rate fs (os2 callers pass the oversampled rate). */
export function designSection(s: SectionSpec, fs: number, mode: DesignMode): BiquadCoefs {
  return mode === 'plus' ? hqSection(s, fs) : draftSection(s, fs);
}

/** Mode used for processing / display given the plugin settings. */
export function designModeOf(p: Pick<PEQ2Params, 'hq' | 'hqMode'>): DesignMode {
  if (!p.hq) return 'draft';
  return p.hqMode === 'plus' ? 'plus' : 'os2';
}

/** Design rate for a mode. */
export function designRate(fs: number, mode: DesignMode): number {
  return mode === 'os2' ? fs * 2 : fs;
}

/**
 * Total response (magnitude, phase) of the bank at frequency f. LIN applies
 * the minimum-phase design's magnitude as 2^(dB/6) (as FL does) with no phase.
 */
export function bankResponse(
  bank: PEQ2Bank, f: number, fs: number, mode: DesignMode, lin: boolean,
  cache?: Map<PEQ2Band, BiquadCoefs[]>,
): [number, number] {
  let mag = 1;
  let ph = 0;
  const dfs = designRate(fs, mode);
  for (const b of activeBands(bank)) {
    let coefs = cache?.get(b);
    if (!coefs) { coefs = bandSections(b).map((s) => designSection(s, dfs, mode)); cache?.set(b, coefs); }
    for (const c of coefs) {
      const [m, p] = biquadResponse(c, f, dfs);
      mag *= m;
      ph += p;
    }
  }
  if (lin) return [Math.pow(mag, LIN_EXPONENT) * Math.pow(10, bank.mainLevel / 20), 0];
  return [mag * Math.pow(10, bank.mainLevel / 20), ph];
}

/** Response of a single band (for drawing the hovered band's own curve). */
export function bandResponse(b: PEQ2Band, f: number, fs: number, mode: DesignMode, lin = false): number {
  const dfs = designRate(fs, mode);
  let mag = 1;
  for (const s of bandSections(b)) mag *= biquadResponse(designSection(s, dfs, mode), f, dfs)[0];
  return lin ? Math.pow(mag, LIN_EXPONENT) : mag;
}
