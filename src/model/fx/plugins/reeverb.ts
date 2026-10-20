// Reeverb (FL: Fruity Reeverb), the legacy reverb (Ultrafunk). FL keeps it
// loadable for old projects but no longer lists it in the plugin database, so
// it is hidden here too. Form: 335 x 255, ten wheels in bevels.
//
// Measured with FL's own plugin (flfxhost): it runs the same engine as
// Reeverb 2. Every parameter is a raw integer (0..65536, predelay 0..250 ms,
// color 0..40) that FL truncates to Reeverb 2's units; dry / reverb are linear
// gains, there are no early reflections, no stereo separation and no
// modulation. The plugin has no value texts of its own (GetName is empty); the
// texts below are the ones its editor shows.

import type { FxPluginDef, FxPreset } from '../types';

const U = 65536;

/** Low cut (Hz); 19 = filter off. */
export function lowCutHz(v: number): number {
  return Math.floor(19 + (2981 * v) / U);
}

/** High cut / high damping in tenths of kHz; 221 = off. */
export function kHzTenths(v: number): number {
  return Math.floor(5 + (216 * v) / U);
}

export function roomSize(v: number): number {
  return Math.floor(1 + (99 * v) / U);
}

export function diffusionPct(v: number): number {
  return Math.floor((100 * v) / U);
}

/** Decay in tenths of a second. */
export function decayTenths(v: number): number {
  return Math.floor(1 + (199 * v) / U);
}

/** Color step 0..4 = Delphi Round(v / 10): halves go to the even step (5 -> 0, 15 -> 2, 25 -> 2, 35 -> 4). */
export function colorIndex(v: number): number {
  const x = v / 10;
  let r = Math.floor(x + 0.5);
  if (r - x === 0.5 && r % 2 !== 0) r -= 1;
  return Math.min(4, Math.max(0, r));
}

export const COLOR_NAMES = ['Brighter', 'Bright', 'Flat', 'Warm', 'Warmer'];
/** Each color step is Reeverb 2's bass multiplier (%) at a 500 Hz crossover. */
export const COLOR_BASS = [20, 60, 100, 150, 300];
export const COLOR_CROSS = 500;

export function lowCutText(v: number): string {
  const hz = lowCutHz(v);
  return hz <= 19 ? 'OFF' : `${hz} Hz`;
}

export function kHzText(v: number): string {
  const t = kHzTenths(v);
  return t >= 221 ? 'OFF' : `${(t / 10).toFixed(1)} kHz`;
}

/** FL shows two spaces before "sec". */
export function decayText(v: number): string {
  return `${(decayTenths(v) / 10).toFixed(1)}  sec`;
}

export function percentText(v: number): string {
  return `${Math.round((v / U) * 100)} %`;
}

/** Smallest raw value whose truncated mapping reaches `target` (for typed values). */
function inverse(map: (v: number) => number, target: number, max: number): number {
  let lo = 0, hi = max;
  if (map(max) < target) return max;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map(mid) >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Parameter values in index order: low cut, high cut, predelay, room size, diffusion, color, decay, high damping, dry, reverb. */
function preset(name: string, v: number[]): FxPreset {
  const keys = ['lowCut', 'highCut', 'predelay', 'room', 'diffusion', 'color', 'decay', 'damping', 'dry', 'reverb'];
  const params: Record<string, number> = {};
  keys.forEach((k, i) => { params[k] = v[i]; });
  return { name, params };
}

export const def: FxPluginDef = {
  id: 'reeverb',
  name: 'Reeverb',
  category: 'Delay reverb',
  width: 335,
  height: 255,
  hidden: true,
  description: 'Legacy algorithmic reverb (superseded by Reeverb 2)',
  // defaults: FL's factory "Default" preset (the constructor's are 1250, 10800, 0, 26000, 65536, 20, 4700, 10800, 65536, 13120)
  params: [
    { key: 'lowCut', name: 'Low cut', index: 0, min: 0, max: U, def: 1231, format: lowCutText, parse: (hz) => (hz <= 19 ? 0 : inverse(lowCutHz, Math.round(hz), U)) },
    { key: 'highCut', name: 'High cut', index: 1, min: 0, max: U, def: 10682, format: kHzText, parse: (khz) => inverse(kHzTenths, Math.round(khz * 10), U) },
    { key: 'predelay', name: 'Predelay', index: 2, min: 0, max: 250, def: 0, format: (v) => `${Math.round(v)} ms`, parse: (ms) => ms },
    { key: 'room', name: 'Room size', index: 3, min: 0, max: U, def: 26345, format: (v) => `${roomSize(v)} size`, parse: (s) => inverse(roomSize, Math.round(s), U) },
    { key: 'diffusion', name: 'Diffusion', index: 4, min: 0, max: U, def: U, format: (v) => `${diffusionPct(v)}`, parse: (d) => inverse(diffusionPct, Math.round(d), U) },
    { key: 'color', name: 'Color', index: 5, min: 0, max: 40, def: 20, format: (v) => COLOR_NAMES[colorIndex(v)] },
    { key: 'decay', name: 'Decay', index: 6, min: 0, max: U, def: 4614, format: decayText, parse: (s) => inverse(decayTenths, Math.round(s * 10), U) },
    { key: 'damping', name: 'High damping', index: 7, min: 0, max: U, def: 10879, format: kHzText, parse: (khz) => inverse(kHzTenths, Math.round(khz * 10), U) },
    { key: 'dry', name: 'Dry', index: 8, min: 0, max: U, def: U, format: percentText, parse: (p) => (p * U) / 100 },
    { key: 'reverb', name: 'Reverb', index: 9, min: 0, max: U, def: 13238, format: percentText, parse: (p) => (p * U) / 100 },
  ],
  // FL's factory presets ("External" and "Internal" folders), values read with flfxhost info --preset
  presets: [
    preset('External/Acoustic Drums', [0, 0, 0, 0, 0, 0, 11264, 1024, 65536, 27648]),
    preset('External/Acoustic Room', [0, 65536, 0, 0, 65536, 0, 2048, 10240, 49152, 45056]),
    preset('External/Ambiance', [0, 65536, 0, 65536, 65536, 40, 22528, 49152, 44032, 9216]),
    preset('External/Blur 100', [0, 65536, 0, 65536, 65536, 0, 0, 65536, 0, 33792]),
    preset('External/Blur 25', [0, 65536, 0, 16384, 65536, 0, 0, 65536, 0, 33792]),
    preset('External/Blur 50', [0, 65536, 0, 32768, 65536, 0, 0, 65536, 0, 33792]),
    preset('External/Cave', [0, 65536, 0, 65536, 36864, 0, 3072, 65536, 37888, 20480]),
    preset('External/Default', [1231, 10682, 0, 26345, 65536, 20, 4614, 10879, 65536, 13238]),
    preset('External/Default send', [1231, 10682, 0, 26345, 65536, 20, 4614, 10879, 0, 65536]),
    preset('External/Echoey', [0, 65536, 0, 65536, 0, 40, 2048, 44032, 34816, 31744]),
    preset('External/Electro Drums', [0, 21504, 0, 38912, 65536, 0, 2048, 65536, 41984, 26624]),
    preset('External/For Strings', [1231, 10682, 0, 26345, 65536, 20, 4614, 10879, 65536, 26550]),
    preset('External/Late Reflection', [0, 33792, 180, 65536, 65536, 40, 2048, 65536, 41984, 26624]),
    preset('External/Subtle', [1789, 16712, 0, 21447, 65536, 20, 0, 7602, 65536, 9552]),
    preset('External/Tube', [1231, 10682, 0, 26345, 65536, 20, 0, 10879, 65536, 65536]),
    preset('Internal/Cathedral', [338, 4981, 70, 59113, 65536, 28, 14746, 7930, 65536, 26345]),
    preset('Internal/Default', [1231, 10682, 0, 26345, 65536, 20, 4614, 10879, 65536, 13238]),
    preset('Internal/Drum Room', [1789, 9503, 0, 23069, 65536, 20, 1966, 9437, 65536, 19792]),
    preset('Internal/Large Hall', [0, 33423, 45, 26345, 65536, 20, 7209, 13763, 65536, 26345]),
    preset('Internal/Small Studio', [1789, 16712, 0, 11207, 65536, 20, 1638, 7602, 65536, 19792]),
    preset('Internal/The Venue', [8389, 16712, 80, 39453, 42926, 14, 7537, 9830, 65536, 16515]),
  ],
};
