// Stereo Enhancer (FL: Fruity Stereo Enhancer): stereo separation (merge /
// widen), a one-channel delay ("phase offset", before or after the other
// processing), channel polarity inversion, balance pan and volume.
// Form: 400 x 110; PanWheel (Tag 0) -128..128, VolWheel (Tag 1) 0..320 with
// 256 = unity, SepWheel (Tag 2) -96..96, PhaseWheel (Tag 3) -512..512,
// PosSelect (Tag 4: PRE / POST), InvSelect (Tag 5: NONE / LEFT / RIGHT).
// Laws and texts were read from FL's binary and checked against renders.

import type { FxPluginDef } from '../types';

export const ENH_POS = ['PRE', 'POST'];
export const ENH_INV = ['NONE', 'LEFT', 'RIGHT'];

function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Volume gain: (11^(v/256) - 1) / 10 (the wheel reads v/320 as a percentage). */
export function enhVolGain(v: number): number {
  const s = v / 256;
  if (s === 1) return 1;
  return Math.max(0, (Math.pow(11, s) - 1) * 0.1);
}

/** Phase offset delay in units of 10 us: (1001^(|v|/512) - 1) * 50 (500 ms at the ends), float32 like FL. */
export function enhDelayUnits(v: number): number {
  const x = Math.fround(Math.abs(Math.round(v)) * 0.001953125);
  return Math.fround(Math.fround(Math.exp(x * 6.90875477931522) - 1) * 50);
}

/** Pan text: Round(|v| * 100 / 128) (half even), "Centered" only at 0. */
export function enhPanText(v: number): string {
  if (v === 0) return 'Centered';
  return `${roundHalfEven((Math.abs(v) * 100) / 128)}% ${v < 0 ? 'left' : 'right'}`;
}

export function enhVolText(v: number): string {
  return `${Math.floor((v / 320) * 100 + 0.5)}%`;
}

export function enhSepText(v: number): string {
  if (v === 0) return 'Original';
  return `${Math.floor((Math.abs(v) / 96) * 100 + 0.5)}% ${v < 0 ? 'separated' : 'merged'}`;
}

export function enhPhaseText(v: number): string {
  return `${(enhDelayUnits(v) / 100).toFixed(1)}ms ${v < 0 ? 'left' : 'right'}`;
}

export const def: FxPluginDef = {
  id: 'stereoenhancer',
  name: 'Stereo Enhancer',
  category: 'Gain',
  width: 400,
  height: 110,
  description: 'Stereo separation, phase offset delay, channel inversion, pan and volume',
  params: [
    {
      key: 'pan', name: 'Panning', index: 0, min: -128, max: 128, def: 0, bipolar: true, format: enhPanText,
      parse: (pct) => Math.round((Math.max(-100, Math.min(100, pct)) * 128) / 100),
    },
    { key: 'vol', name: 'Volume', index: 1, min: 0, max: 320, def: 256, format: enhVolText, parse: (pct) => Math.round(pct * 3.2) },
    {
      key: 'sep', name: 'Stereo separation', index: 2, min: -96, max: 96, def: 0, bipolar: true, format: enhSepText,
      parse: (pct) => Math.round(pct * 0.96),
    },
    {
      key: 'phase', name: 'Phase offset', index: 3, min: -512, max: 512, def: 0, bipolar: true, format: enhPhaseText,
      parse: (ms) => {
        const m = Math.min(500, Math.abs(ms));
        return Math.sign(ms) * Math.round((512 * Math.log(m * 2 + 1)) / Math.log(1001));
      },
    },
    { key: 'pos', name: 'Phase effect position', index: 4, min: 0, max: 1, def: 1, options: ENH_POS },
    { key: 'inv', name: 'Phase inversion', index: 5, min: 0, max: 2, def: 0, options: ENH_INV },
  ],
  presets: [
    { name: 'Default', params: { pan: 0, vol: 256, sep: 0, phase: 0, pos: 1, inv: 0 } },
    { name: 'For strings', params: { pan: -18, vol: 256, sep: -54, phase: -248, pos: 1, inv: 0 } },
    { name: 'Subtle', params: { pan: 0, vol: 256, sep: -40, phase: -24, pos: 1, inv: 0 } },
  ],
};
