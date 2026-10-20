// Compressor (FL: Fruity Compressor, by Ultrafunk; FL lists it under Dynamics
// and calls it legacy). Form: 500 x 105, six knobs with value texts, a
// sidechain input selector and an options button (Report latency). Ranges,
// defaults and value texts were read from FL's plugin (host info/sweep); the
// DSP is documented in docs/research/fx/compressor.md.

import type { FxPluginDef, FxParamDef, FxPreset } from '../types';

export const COMP_TYPES = ['Hard', 'Medium', 'Vintage', 'Soft', 'Hard/R', 'Medium/R', 'Vintage/R', 'Soft/R'];

/** "x.x" without a negative zero. */
function fixed1(x: number): string {
  const s = x.toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

export const compThresholdText = (v: number): string => `${fixed1(v / 10)} dB`;
export const compRatioText = (v: number): string => `${fixed1(v / 10)} : 1`;
export const compGainText = (v: number): string => `${fixed1(v / 10)} dB`;
export const compAttackText = (v: number): string => `${fixed1(v / 10)} ms`;
export const compReleaseText = (v: number): string => `${Math.round(v)} ms`;

export const COMPRESSOR_PARAMS: FxParamDef[] = [
  { key: 'thr', name: 'Threshold', index: 0, min: -600, max: 0, def: 0, format: compThresholdText, parse: (db) => Math.round(db * 10) },
  { key: 'ratio', name: 'Ratio', index: 1, min: 4, max: 300, def: 10, format: compRatioText, parse: (r) => Math.round(r * 10) },
  { key: 'gain', name: 'Gain', index: 2, min: -300, max: 300, def: 0, bipolar: true, format: compGainText, parse: (db) => Math.round(db * 10) },
  { key: 'att', name: 'Attack', index: 3, min: 0, max: 4000, def: 150, format: compAttackText, parse: (ms) => Math.round(ms * 10) },
  { key: 'rel', name: 'Release', index: 4, min: 1, max: 4000, def: 200, format: compReleaseText, parse: (ms) => Math.round(ms) },
  { key: 'type', name: 'Type', index: 5, min: 0, max: 7, def: 0, options: COMP_TYPES },
];

const preset = (name: string, v: number[]): FxPreset => ({
  name, params: { thr: v[0], ratio: v[1], gain: v[2], att: v[3], rel: v[4], type: v[5] },
});

/** FL's factory presets (External / Internal folders), values read from FL's plugin with each preset loaded. */
export const COMPRESSOR_PRESETS: FxPreset[] = [
  preset('External/Blower', [0, 42, 150, 317, 252, 7]),
  preset('External/Default', [0, 10, 0, 150, 200, 0]),
  preset('External/Fast Master', [-39, 18, 19, 160, 54, 0]),
  preset('External/Leveler 1', [0, 30, 9, 983, 2167, 0]),
  preset('External/Leveler 2', [0, 15, 16, 160, 54, 5]),
  preset('External/Light', [-75, 17, 5, 494, 1210, 0]),
  preset('External/Master 1', [-84, 32, 34, 108, 117, 7]),
  preset('External/Master 2', [-103, 73, 36, 140, 710, 3]),
  preset('External/Master V', [-220, 49, 75, 181, 262, 6]),
  preset('External/Opto Master', [0, 24, -22, 181, 637, 0]),
  preset('External/Opto V', [0, 48, -70, 390, 387, 2]),
  preset('External/V Driver', [-402, 182, 252, 365, 4000, 2]),
  preset('External/Vari Mu 1', [0, 47, 101, 117, 929, 3]),
  preset('External/Vari Mu 2', [-125, 47, 10, 117, 690, 3]),
  preset('External/Vintage', [-150, 80, 86, 292, 1532, 2]),
  preset('Internal/Brickwall', [-130, 100, 130, 0, 800, 4]),
  preset('Internal/Complete Mix', [-160, 30, 90, 180, 440, 3]),
  preset('Internal/Drums', [-125, 75, 90, 100, 200, 5]),
  preset('Internal/Full Reset', [0, 10, 0, 150, 200, 0]),
  preset('Internal/Vintage Mix', [-200, 66, 90, 150, 438, 6]),
];

export interface CompressorState {
  /** Sidechain input (0 = none, k = FL's input k -> ctx.sidechain[k - 1]). */
  sidechain: number;
  /** Options > Report latency (64 samples of look-ahead reported for PDC). */
  reportLatency: boolean;
}

function compressorState(): Record<string, unknown> {
  const s: CompressorState = { sidechain: 0, reportLatency: true };
  return s as unknown as Record<string, unknown>;
}

function normalizeCompressor(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  out.sidechain = Math.max(0, Math.round(Number(out.sidechain) || 0));
  out.reportLatency = out.reportLatency !== false;
  return out;
}

export const def: FxPluginDef = {
  id: 'compressor',
  name: 'Compressor',
  category: 'Dynamics',
  width: 500,
  height: 105,
  description: 'Variable-knee compressor with sidechain, transient controlled release and peak limiting',
  params: COMPRESSOR_PARAMS,
  state: compressorState,
  normalize: normalizeCompressor,
  presets: COMPRESSOR_PRESETS,
};
