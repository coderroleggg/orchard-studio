// Delay 2 (FL: Fruity Delay 2): tempo-based stereo delay with input pan /
// volume, a one-pole low-pass in the feedback, normal / invert / ping-pong
// feedback and a stereo time offset. Form: 400 x 100. Parameter indices,
// ranges, names and value texts were read from FL's plugin (flfxhost); the
// mappings were measured from its DSP (docs/research/fx/delay2.md).

import type { FxPluginDef } from '../types';

/** FL's rounding for these texts: half away from zero on the exact ratio. */
const rnd = (num: number, den: number) => Math.sign(num) * Math.round(Math.abs(num) / den);

/** Volume knobs (input, dry): 128 = unity, 160 = +5.6 dB; gain = (11^(v/128) - 1) / 10. */
export function d2Gain(v: number): number {
  return (Math.pow(11, Math.max(0, v) / 128) - 1) / 10;
}

/** Feedback filter: one-pole coefficient (21^(v/128) - 1) / 20, scaled by 44.1 kHz / sr (1 = open at 44.1 kHz). */
export function d2CutoffCoef(v: number, sr: number): number {
  return Math.min(1, ((Math.pow(21, Math.max(0, v) / 128) - 1) / 20) * (44100 / sr));
}

/** Stereo offset in ms: (1001^(|v|/512) - 1) / 2, up to 500 ms. */
export function d2OffsetMs(v: number): number {
  return (Math.pow(1001, Math.min(512, Math.abs(v)) / 512) - 1) / 2;
}

/** Delay time: raw / 192 beats (48 ticks per step). */
export function d2TimeText(v: number): string {
  const r = Math.round(v);
  return `${Math.floor(r / 48)}:${String(r % 48).padStart(2, '0')}`;
}

export function d2OffsetText(v: number): string {
  return `${d2OffsetMs(v).toFixed(1)}ms ${v < 0 ? 'left' : 'right'}`;
}

export const D2_MODES = ['Normal', 'Invert', 'P.Pong'];

const KEYS = ['pan', 'vol', 'dry', 'feedback', 'time', 'offset', 'mode', 'cutoff'];

function preset(name: string, raw: number[]): { name: string; params: Record<string, number> } {
  const params: Record<string, number> = {};
  KEYS.forEach((k, i) => { params[k] = raw[i]; });
  return { name, params };
}

export const def: FxPluginDef = {
  id: 'delay2',
  name: 'Delay 2',
  category: 'Delay reverb',
  width: 400,
  height: 100,
  description: 'Tempo-based stereo delay with feedback filter and ping pong',
  params: [
    { key: 'pan', name: 'Input panning', index: 0, min: -128, max: 128, def: 0, bipolar: true, format: (v) => `${rnd(v * 100, 128)}%` },
    { key: 'vol', name: 'Input volume', index: 1, min: 0, max: 160, def: 128, format: (v) => `${rnd(v * 100, 160)}%` },
    { key: 'dry', name: 'Dry level', index: 2, min: 0, max: 160, def: 128, format: (v) => `${rnd(v * 100, 160)}%` },
    { key: 'feedback', name: 'Feedback level', index: 3, min: 0, max: 127, def: 64, format: (v) => `${rnd(v * 100, 127)}%` },
    { key: 'time', name: 'Time', index: 4, min: 1, max: 768, def: 144, format: d2TimeText },
    { key: 'offset', name: 'Time stereo offset', index: 5, min: -512, max: 512, def: 0, bipolar: true, format: d2OffsetText },
    { key: 'mode', name: 'Feedback mode', index: 6, min: 0, max: 2, def: 0, options: D2_MODES },
    { key: 'cutoff', name: 'Cutoff freq', index: 7, min: 0, max: 128, def: 128, format: (v) => `${rnd(v * 100, 128)}%` },
  ],
  // FL's factory presets (raw values read from the .fst state, parameter-index order)
  presets: [
    preset('Default', [0, 128, 128, 64, 144, 0, 0, 128]),
    preset('Default (send)', [0, 128, 0, 64, 144, 0, 0, 128]),
    preset('Stereo effect', [66, 128, 128, 64, 144, -128, 2, 119]),
    preset('Stereo effect (send)', [66, 128, 0, 64, 144, -128, 2, 119]),
    preset('Weird (send)', [28, 128, 0, 107, 48, -358, 2, 89]),
    preset('Widen', [106, 103, 128, 23, 6, -394, 2, 128]),
  ],
};
