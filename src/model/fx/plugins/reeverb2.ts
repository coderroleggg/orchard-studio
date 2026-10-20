// Reeverb 2 (FL: Fruity Reeverb 2): algorithmic reverb (Ultrafunk / Daniel
// Schaack). Form: 530 x 160; parameter indices, ranges, initial values and
// value texts read from FL's own plugin (flfxhost info/sweep).
// Non-parameter state: `side` (MID / SIDE input switch) and `tempo`
// (tempo-based predelay check box), both Tag -1 controls in FL's form.

import type { FxPluginDef } from '../types';

/** "75Hz", "Off" at the minimum. */
export function lowCutText(v: number): string {
  return v <= 19 ? 'Off' : `${Math.round(v)}Hz`;
}

/** High cut / high damping: tenths of kHz, "Off" at the maximum ("4.0kHz"). */
export function kHzText(v: number): string {
  return v >= 221 ? 'Off' : `${(Math.round(v) / 10).toFixed(1)}kHz`;
}

/** Predelay in ms (FL truncates): 0..384 = 0..1000 ms. */
export function predelayText(v: number): string {
  return `${Math.floor((Math.round(v) * 1000) / 384)}ms`;
}

/** Tempo-based predelay: ticks at 48 per step, shown as steps:ticks ("2:24"). */
export function predelayTempoText(v: number): string {
  const t = Math.round(v);
  return `${Math.floor(t / 48)}:${String(t % 48).padStart(2, '0')}`;
}

export function decayText(v: number): string {
  return `${(Math.round(v) / 10).toFixed(1)}sec`;
}

/** Stereo separation: "Original", "50% separated" (negative), "50% merged". */
export function sepText(v: number): string {
  const p = Math.round((Math.abs(v) / 64) * 100);
  if (p === 0) return 'Original';
  return `${p}% ${v < 0 ? 'separated' : 'merged'}`;
}

/** Dry / ER / wet level: 128 = 100%. */
export function levelText(v: number): string {
  return `${Math.round((v / 128) * 100)}%`;
}

export function modText(v: number): string {
  return `${Math.round((v / 2048) * 100)}%`;
}

export const def: FxPluginDef = {
  id: 'reeverb2',
  name: 'Reeverb 2',
  category: 'Delay reverb',
  width: 530,
  height: 160,
  description: 'Algorithmic reverb with early reflections, bass decay and modulation',
  params: [
    { key: 'lowCut', name: 'Low cut', index: 0, min: 19, max: 3000, def: 75, format: lowCutText, parse: (hz) => hz },
    { key: 'highCut', name: 'High cut', index: 1, min: 5, max: 221, def: 40, format: kHzText, parse: (khz) => khz * 10 },
    { key: 'predelay', name: 'Predelay', index: 2, min: 0, max: 384, def: 0, format: predelayText, parse: (ms) => (ms * 384) / 1000 },
    { key: 'room', name: 'Room size', index: 3, min: 1, max: 100, def: 50 },
    { key: 'diffusion', name: 'Diffusion', index: 4, min: 0, max: 100, def: 100 },
    { key: 'decay', name: 'Decay time', index: 5, min: 1, max: 200, def: 15, format: decayText, parse: (s) => s * 10 },
    { key: 'damping', name: 'High damping', index: 6, min: 5, max: 221, def: 40, format: kHzText, parse: (khz) => khz * 10 },
    { key: 'bass', name: 'Bass multiplier', index: 7, min: 20, max: 300, def: 100, format: (v) => `${Math.round(v)}%`, parse: (p) => p },
    { key: 'cross', name: 'Crossover', index: 8, min: 25, max: 2000, def: 500, format: (v) => `${Math.round(v)}Hz`, parse: (hz) => hz },
    { key: 'sep', name: 'Stereo separation', index: 9, min: -64, max: 64, def: 0, bipolar: true, format: sepText },
    { key: 'dry', name: 'Dry level', index: 10, min: 0, max: 160, def: 128, format: levelText, parse: (p) => (p * 128) / 100 },
    // defaults: FL's factory "Default" preset (applied on insertion): ER 100%, wet 68%
    { key: 'er', name: 'Early reflection level', index: 11, min: 0, max: 160, def: 128, format: levelText, parse: (p) => (p * 128) / 100 },
    { key: 'wet', name: 'Wet level', index: 12, min: 0, max: 160, def: 87, format: levelText, parse: (p) => (p * 128) / 100 },
    { key: 'modSpeed', name: 'Mod Speed', index: 13, min: 0, max: 2048, def: 684, format: modText, parse: (p) => (p * 2048) / 100 },
    { key: 'modDepth', name: 'Mod Depth', index: 14, min: 0, max: 2048, def: 0, format: modText, parse: (p) => (p * 2048) / 100 },
  ],
  state: () => ({ side: false, tempo: false }),
  normalize: (p) => ({ ...p, side: !!p.side, tempo: !!p.tempo }),
  // FL's factory presets (values read from FL with flfxhost info --preset); all keep MID and ms predelay
  presets: [
    { name: 'Cathedral', params: preset(33, 21, 27, 90, 100, 45, 31, 150, 298, 0, 128, 128, 90) },
    { name: 'Default', params: preset(75, 40, 0, 50, 100, 15, 40, 100, 500, 0, 128, 128, 87) },
    { name: 'Drum Room', params: preset(100, 36, 0, 35, 100, 6, 36, 100, 330, 0, 128, 128, 99) },
    { name: 'Large Hall', params: preset(19, 112, 18, 40, 100, 22, 50, 100, 500, 0, 128, 128, 116) },
    { name: 'Small Studio', params: preset(100, 60, 0, 17, 100, 5, 30, 90, 330, 0, 128, 128, 96) },
    { name: 'The Venue', params: preset(400, 60, 31, 60, 65, 23, 37, 70, 330, 0, 128, 128, 102) },
  ],
};

/** Parameter values in FL's index order 0..12 (mod speed / depth at their defaults). */
function preset(...v: number[]): Record<string, unknown> {
  const keys = ['lowCut', 'highCut', 'predelay', 'room', 'diffusion', 'decay', 'damping', 'bass', 'cross', 'sep', 'dry', 'er', 'wet'];
  const p: Record<string, unknown> = { modSpeed: 684, modDepth: 0, side: false, tempo: false };
  keys.forEach((k, i) => { p[k] = v[i]; });
  return p;
}
