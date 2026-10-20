// Soft Clipper (FL: Fruity Soft Clipper): memoryless soft limiter with a post
// gain. Form: 270 x 130 (two wheels, output meter, transfer-curve display).
// Value texts were read from FL's plugin (host sweep); the DSP law was measured
// on FL's binary (docs/research/fx/softclipper.md).

import type { FxPluginDef } from '../types';

/** Threshold as FL displays it: (7^(v/127) - 1)/6 in dB ("-4.4dB"). */
export function scThresholdDisplayGain(v: number): number {
  return (Math.pow(7, v / 127) - 1) / 6;
}

/** Threshold the DSP uses: the knee starts at v/128 of full scale. */
export const scThreshold = (v: number): number => v / 128;

/** Post gain: (11^(v/128) - 1)/10, 128 = unity ("80%"), 160 = +5.6 dB. */
export const scPostGain = (v: number): number => (Math.pow(11, v / 128) - 1) / 10;

/** Soft clip curve: identity below t, then t + (1 - t)(1 - e^(-(x - t)/(1 - t))). */
export function scCurve(x: number, t: number): number {
  const a = x < 0 ? -x : x;
  if (a <= t) return x;
  const d = 1 - t;
  const y = d > 0 ? t + d * (1 - Math.exp(-(a - t) / d)) : t;
  return x < 0 ? -y : y;
}

export function scThresholdText(v: number): string {
  let s = (20 * Math.log10(scThresholdDisplayGain(v))).toFixed(1);
  if (s === '-0.0') s = '0.0';
  return s + 'dB';
}

export const scPostText = (v: number): string => `${Math.floor(v / 1.6 + 0.5)}%`;

export const def: FxPluginDef = {
  id: 'softclipper',
  name: 'Soft Clipper',
  category: 'Distortion',
  alsoIn: ['Dynamics'],
  width: 270,
  height: 130,
  description: 'CPU-friendly soft limiter with post gain',
  params: [
    {
      key: 'thres', name: 'Threshold', index: 0, min: 1, max: 127, def: 100, format: scThresholdText,
      parse: (db) => Math.round(Math.min(127, Math.max(1, (127 * Math.log(1 + 6 * Math.pow(10, db / 20))) / Math.log(7)))),
    },
    { key: 'post', name: 'Post gain', index: 1, min: 0, max: 160, def: 128, format: scPostText, parse: (pct) => Math.round(Math.min(160, Math.max(0, pct * 1.6))) },
  ],
  presets: [{ name: 'Default', params: { thres: 100, post: 128 } }],
};
