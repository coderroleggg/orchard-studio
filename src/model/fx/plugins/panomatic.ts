// PanOMatic (FL: Fruity PanOMatic): merge-pan and volume with an LFO that
// modulates either of them. Form: 300 x 160; PanWheel (Tag 0) 0..256 with
// 128 = centre, VolWheel (Tag 1) 0..320 with 256 = 0 dB, LFOShapeSelect
// (Tag 2: Sine / Triangle / Square), LFODestSelect (Tag 3: OFF / PAN / VOL),
// LFOAmtWheel (Tag 4) 0..128 and LFOSpdWheel (Tag 5) 0..55000. Value texts,
// laws and the LFO period formula were read from FL's plugin binary and
// checked against renders of it (see docs/research/fx/panomatic.md).

import type { FxPluginDef } from '../types';

export const LFO_SHAPES = ['Sine', 'Triangle', 'Square'];
export const LFO_TARGETS = ['OFF', 'PAN', 'VOL'];

/** Delphi Round(): half to even. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Format('%.0f'): half away from zero. */
function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
}

/** Volume wheel (0..320, 256 = unity) -> linear gain: (11^(v/256) - 1) / 10. */
export function panoVolGain(v: number): number {
  const s = v / 256;
  if (s === 1) return 1;
  return Math.max(0, (Math.pow(11, s) - 1) * 0.1);
}

/** Gain -> volume wheel position (inverse of panoVolGain). */
export function panoVolFromGain(g: number): number {
  return (256 * Math.log(Math.max(0, g) * 10 + 1)) / Math.log(11);
}

/**
 * FL's pan text: the pan is first rounded to FL's -64..64 pan scale, then
 * shown as a percentage ("Centered", "2% left", "100% right").
 */
export function panomaticPanText(v: number): string {
  const p64 = roundHalfEven((v - 128) / 2);
  if (p64 === 0) return 'Centered';
  return `${roundHalfEven((Math.abs(p64) * 100) / 64)}% ${p64 < 0 ? 'left' : 'right'}`;
}

/** Volume text: "-6.0dB", "0.0dB", "5.6dB", "-InfdB". */
export function panomaticVolText(v: number): string {
  const g = panoVolGain(v);
  if (!(g > 0)) return '-InfdB';
  const s = (20 * Math.log10(g)).toFixed(1);
  return (s === '-0.0' ? '0.0' : s) + 'dB';
}

export function panomaticAmtText(v: number): string {
  return `${roundHalfUp((v / 128) * 100)}%`;
}

export function panomaticSpeedText(v: number): string {
  return `${roundHalfUp((v / 55000) * 100)}%`;
}

export const def: FxPluginDef = {
  id: 'panomatic',
  name: 'PanOMatic',
  category: 'Gain',
  width: 300,
  height: 160,
  description: 'Panning and volume, with an LFO for automatic panning or tremolo',
  params: [
    {
      key: 'pan', name: 'Panning', index: 0, min: 0, max: 256, def: 128, bipolar: true, format: panomaticPanText,
      parse: (pct) => Math.round(128 + (Math.max(-100, Math.min(100, pct)) * 128) / 100),
    },
    {
      key: 'vol', name: 'Volume', index: 1, min: 0, max: 320, def: 256, format: panomaticVolText,
      parse: (db) => Math.round(panoVolFromGain(Math.pow(10, db / 20))),
    },
    { key: 'shape', name: 'LFO shape', index: 2, min: 0, max: 2, def: 0, options: LFO_SHAPES },
    { key: 'target', name: 'LFO target', index: 3, min: 0, max: 2, def: 0, options: LFO_TARGETS },
    { key: 'amount', name: 'LFO amount', index: 4, min: 0, max: 128, def: 64, format: panomaticAmtText, parse: (pct) => Math.round(pct * 1.28) },
    { key: 'speed', name: 'LFO speed', index: 5, min: 0, max: 55000, def: 27500, format: panomaticSpeedText, parse: (pct) => Math.round(pct * 550) },
  ],
  // FL inserts the plugin with its factory "Default" preset, which differs from
  // the wheels' reset values (form DefaultValue 128 / 256): pan 127, volume
  // 239 (-1.5 dB). The insert state follows the preset; Alt-click / Reset on a
  // wheel still returns to the form default, as in FL.
  state: () => ({ pan: 127, vol: 239 }),
  presets: [
    { name: 'Default', params: { pan: 127, vol: 239, shape: 0, target: 0, amount: 64, speed: 27500 } },
  ],
};
