// Fast Dist (FL: Fruity Fast Dist). Form: 380 x 120. Five parameters in
// FL's raw units; value texts as FL prints them (pre amp is a percentage of
// 192, threshold tenths, mix / post percentages of 128).

import type { FxPluginDef } from '../types';

export const preAmpText = (v: number): string => `${Math.round((v / 192) * 100)}%`;
export const thresText = (v: number): string => `${Math.round(v) * 10}%`;
export const pct128Text = (v: number): string => `${Math.round((v / 128) * 100)}%`;

export const def: FxPluginDef = {
  id: 'fastdist',
  name: 'Fast Dist',
  category: 'Distortion',
  width: 380,
  height: 120,
  description: 'CPU-friendly table distortion (types A / B)',
  params: [
    { key: 'preAmp', name: 'Pre amp', index: 0, min: 64, max: 192, def: 128, format: preAmpText, parse: (t) => Math.round((t / 100) * 192) },
    { key: 'thres', name: 'Threshold', index: 1, min: 1, max: 10, def: 10, format: thresText, parse: (t) => Math.round(t / 10) },
    { key: 'type', name: 'Distortion type', index: 2, min: 0, max: 1, def: 0, options: ['A', 'B'] },
    { key: 'mix', name: 'Mix level', index: 3, min: 0, max: 128, def: 128, format: pct128Text, parse: (t) => Math.round((t / 100) * 128) },
    { key: 'post', name: 'Post gain', index: 4, min: 0, max: 128, def: 128, format: pct128Text, parse: (t) => Math.round((t / 100) * 128) },
  ],
  // FL's factory presets, read through FL's plugin (flfxhost info --preset)
  presets: [
    { name: 'Default', params: { preAmp: 128, thres: 10, type: 0, mix: 128, post: 128 } },
    { name: 'Some Oomph', params: { preAmp: 181, thres: 5, type: 0, mix: 124, post: 109 } },
    { name: 'Something', params: { preAmp: 157, thres: 5, type: 1, mix: 128, post: 116 } },
    { name: 'The Heat', params: { preAmp: 171, thres: 10, type: 1, mix: 128, post: 113 } },
    { name: 'compressor', params: { preAmp: 192, thres: 1, type: 0, mix: 104, post: 93 } },
    { name: 'fuzz', params: { preAmp: 192, thres: 10, type: 1, mix: 128, post: 80 } },
    { name: 'overdrive', params: { preAmp: 192, thres: 10, type: 0, mix: 128, post: 93 } },
    { name: 'warmth', params: { preAmp: 82, thres: 7, type: 0, mix: 128, post: 128 } },
  ],
};
