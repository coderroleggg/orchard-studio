// Stereo Shaper (FL: Fruity Stereo Shaper): a 2x2 L/R mixer matrix with
// polarity (four bipolar sliders), a one-channel delay and a one-channel
// all-pass ("dephasing") applied before or after the matrix, and an
// "In/Out difference" output (input minus output) sent to another track.
// Form: 271 x 313; sliders (Tag 0..3) -25600..25600 (12800 = 0 dB normal),
// DelWheel (Tag 4) and APFreqWheel (Tag 5) -4096..4096. The effects position
// (pre / post mixer) and the difference target are not parameters (FL keeps
// them in the plugin state).

import type { FxPluginDef, FxPreset } from '../types';

/** Slider gain magnitude: (3^(|v|/12800) - 1) / 2 (12800 = 1, 25600 = 4). */
export function shaperGain(v: number): number {
  const x = Math.abs(v) / 12800;
  if (x === 1) return 1;
  return (Math.pow(3, x) - 1) / 2;
}

/** Inverse of shaperGain for a non-negative gain. */
export function shaperPosFromGain(g: number): number {
  return (12800 * Math.log(Math.max(0, g) * 2 + 1)) / Math.log(3);
}

/** Slider text: "0.0dB normal", "-6.0dB inverted", "-InfdB inverted" (v <= 0 reads inverted). */
export function shaperVolText(v: number): string {
  const g = shaperGain(v);
  const db = g > 0 ? (20 * Math.log10(g)).toFixed(1) : '-Inf';
  return `${db === '-0.0' ? '0.0' : db}dB ${v > 0 ? 'normal' : 'inverted'}`;
}

/** Delay in units of 10 us: (1001^(|v|/4096) - 1) * 50, float32 like FL (500 ms at the ends). */
export function shaperDelayUnits(v: number): number {
  const x = Math.fround(Math.abs(Math.round(v)) * 0.000244140625);
  return Math.fround(Math.fround(Math.exp(x * 6.90875477931522) - 1) * 50);
}

export function shaperDelayText(v: number): string {
  return `${(shaperDelayUnits(v) / 100).toFixed(1)}ms ${v < 0 ? 'left' : 'right'}`;
}

export function shaperPhaseText(v: number): string {
  return `${Math.floor((Math.abs(v) / 4096) * 100 + 0.5)}% ${v < 0 ? 'left' : 'right'}`;
}

/** All-pass centre frequency for a dephasing value: 10 + 4.398 (5001^(1 - |v|/4096) - 1) Hz (float32). */
export function shaperAllpassHz(v: number): number {
  const s = Math.fround(1 - Math.abs(Math.round(v)) * 0.000244140625);
  const e = Math.fround(Math.exp(s * 8.517393171418904) - 1);
  return Math.fround(e * 4.398 + 10);
}

const P = (name: string, v: number[], fxpos: number, diffIdx = 0): FxPreset => ({
  name,
  params: { rl: v[0], lvol: v[1], rvol: v[2], lr: v[3], delay: v[4], dephase: v[5], fxpos, ...(diffIdx ? { diffIdx } : {}) },
});

/**
 * FL's factory presets (Default, Effects/*, Mixing/*), read from FL's preset
 * states. `diffIdx` is FL's difference-output index (2 = the second track
 * this track routes to); the editor maps it to that track when loaded.
 */
const PRESETS: FxPreset[] = [
  P('Default', [0, 12800, 12800, 0, 0, 0], 1),
  P('Effects/Delay', [0, 12800, 12800, 0, 2416, 0], 1),
  P('Effects/Old', [12800, 12800, 12800, 12800, 240, 0], 0),
  P('Effects/Old 2', [-8076, 12800, 12800, -8076, 0, 864], 0),
  P('Effects/Phaser', [12800, 12800, 12800, 12800, 0, 1744], 0),
  P('Effects/Phaser 2', [-8076, 12800, 12800, -8076, -22, 0], 0),
  P('Effects/Shrinked', [8176, 12800, 12800, 8076, -1952, 0], 0),
  P('Effects/Stereoize', [0, 12800, 12800, 0, 0, 2080], 1),
  P('Effects/Stereoize 2', [0, 12800, 12800, 0, 1552, 0], 1),
  P('Effects/Stereoize 3', [0, 12800, 12800, 0, 1408, -2496], 1),
  P('Mixing/Invert', [0, -12800, -12800, 0, 0, 0], 1),
  P('Mixing/Invert Left', [0, -12800, 12800, 0, 0, 0], 1),
  P('Mixing/Invert Right', [0, 12800, -12800, 0, 0, 0], 1),
  P('Mixing/LR to LL', [0, 12800, 0, 12800, 0, 0], 1),
  P('Mixing/LR to MS', [8076, 8076, -8076, 8076, 0, 0], 1),
  P('Mixing/LR to RL', [12800, 0, 0, 12800, 0, 0], 1),
  P('Mixing/LR to RR', [12800, 0, 12800, 0, 0, 0], 1),
  P('Mixing/Left - Right splitter', [0, 12800, 0, 0, 0, 0], 1, 2),
  P('Mixing/MS to LR', [12800, 12800, -12800, 12800, 0, 0], 1),
  P('Mixing/Mid', [8076, 8076, 8076, 8076, 0, 0], 1),
  P('Mixing/Mid - aSide splitter', [8076, 8076, 8076, 8076, 0, 0], 1, 2),
  P('Mixing/Side', [-8076, 8076, -8076, 8076, 0, 0], 1),
  P('Mixing/Side - residual splitter', [-8076, 8076, -8076, 8076, 0, 0], 1, 2),
  P('Mixing/aSide', [-8076, 8076, 8076, -8076, 0, 0], 1),
  P('Mixing/aSide - Mid splitter', [-8076, 8076, 8076, -8076, 0, 0], 1, 2),
];

const volParam = (key: string, name: string, index: number, def: number) => ({
  key, name, index, min: -25600, max: 25600, def, bipolar: true, step: 1, format: shaperVolText,
  parse: (db: number) => Math.round(shaperPosFromGain(Math.pow(10, db / 20))),
});

export const def: FxPluginDef = {
  id: 'stereoshaper',
  name: 'Stereo Shaper',
  category: 'Gain',
  width: 271,
  height: 313,
  description: 'L/R mixer matrix with polarity, delay and all-pass, and a difference output for mid/side work',
  params: [
    volParam('rl', 'Right into left channel volume', 0, 0),
    volParam('lvol', 'Left channel volume', 1, 12800),
    volParam('rvol', 'Right channel volume', 2, 12800),
    volParam('lr', 'Left into right channel volume', 3, 0),
    {
      key: 'delay', name: 'Left / right delay', index: 4, min: -4096, max: 4096, def: 0, bipolar: true, format: shaperDelayText,
      parse: (ms) => Math.sign(ms) * Math.round((4096 * Math.log(Math.min(500, Math.abs(ms)) * 2 + 1)) / Math.log(1001)),
    },
    {
      key: 'dephase', name: 'Left / right dephasing', index: 5, min: -4096, max: 4096, def: 0, bipolar: true, format: shaperPhaseText,
      parse: (pct) => Math.round(Math.max(-100, Math.min(100, pct)) * 40.96),
    },
  ],
  // fxpos: effects before (0, "pre mixer") or after (1, "post mixer") the matrix;
  // diff: mixer track receiving input - output (-1 = none)
  state: () => ({ fxpos: 1, diff: -1 }),
  normalize: (p) => {
    const t = Number(p.diff);
    return { ...p, fxpos: Number(p.fxpos) === 0 ? 0 : 1, diff: Number.isInteger(t) && t >= 0 ? t : -1 };
  },
  presets: PRESETS,
};
