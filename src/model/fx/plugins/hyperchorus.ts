// Hyper Chorus (FL: Hyper Chorus, code Daniel Schaack, concept Sean Tyas):
// 4 or 8 modulated delay lines with per-line feedback and auto-balance
// ("movement"), wet low / high pass and a vectorscope. Form: 747 x 217.
// Parameters, ranges and texts from FL's binary (flfxhost info/sweep); the
// DSP was measured from FL's renders, see docs/research/fx/hyperchorus.md.
// Defaults are FL's "Default" preset (the constructor differs in six controls).

import type { FxPluginDef } from '../types';

const pos = (v: number, min: number, max: number) => Math.max(0, Math.min(1, (v - min) / (max - min)));

/** Wet low pass (7140..22000): 714 Hz x (22000 / 714)^x. */
export const hyperLowPassHz = (v: number) => 714 * Math.pow(22000 / 714, pos(v, 7140, 22000));
/** Wet high pass (120..10900): 12 Hz x (1090 / 12)^x. */
export const hyperHighPassHz = (v: number) => 12 * Math.pow(1090 / 12, pos(v, 120, 10900));

/** Mix law: the share w(x) of one side, sqrt 2 x below the middle, sqrt(1 - 2 (1 - x)^2) above. */
export function hyperMixShare(x: number): number {
  x = Math.max(0, Math.min(1, x));
  return x <= 0.5 ? Math.SQRT2 * x : Math.sqrt(Math.max(0, 1 - 2 * (1 - x) * (1 - x)));
}

const pct = (v: number) => `${(v / 10 + 1e-9).toFixed(2)}%`;

/** FL rounds the wet share half to even ("100% Dry / 0% Wet" at 0.5 %). */
function mixText(v: number): string {
  const x = v / 10, f = Math.floor(x);
  const w = Math.abs(x - f - 0.5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(x);
  return `${100 - w}% Dry / ${w}% Wet`;
}

const F = Math.fround;
const lpText = (v: number) => `${F(714 * F(Math.pow(F(22000 / 714), F(F(Math.max(7140, Math.min(22000, v)) - 7140) / 14860)))).toFixed(1)} Hz`;
const hpText = (v: number) => `${F(12 * F(Math.pow(F(1090 / 12), F(F(Math.max(120, Math.min(10900, v)) - 120) / 10780)))).toFixed(1)} Hz`;

export const def: FxPluginDef = {
  id: 'hyperchorus',
  name: 'Hyper Chorus',
  category: 'Flanger',
  width: 747,
  height: 217,
  description: 'Super-saw style chorus: 4 or 8 modulated delay lines with feedback, movement and a vectorscope',
  params: [
    { key: 'delay', name: 'Delay', index: 0, min: 0, max: 1000, def: 500, format: pct, parse: (pc) => pc * 10 },
    { key: 'feedback', name: 'Feedback', index: 1, min: 0, max: 1000, def: 500, format: pct, parse: (pc) => pc * 10 },
    { key: 'modRate', name: 'Modulation rate', index: 2, min: 0, max: 1000, def: 500, format: pct, parse: (pc) => pc * 10 },
    { key: 'modAmount', name: 'Modulation amount', index: 3, min: 0, max: 1000, def: 500, format: pct, parse: (pc) => pc * 10 },
    { key: 'movement', name: 'Movement amount', index: 4, min: 0, max: 1000, def: 500, format: pct, parse: (pc) => pc * 10 },
    { key: 'movementRate', name: 'Movement rate', index: 5, min: 0, max: 1000, def: 500, format: pct, parse: (pc) => pc * 10 },
    { key: 'lines', name: 'Delay lines', index: 6, min: 0, max: 1, def: 0, options: ['4', '8'] },
    { key: 'lowPass', name: 'Low pass', index: 7, min: 7140, max: 22000, def: 22000, format: lpText, parse: (hz) => 7140 + 14860 * (Math.log(Math.max(714, hz) / 714) / Math.log(22000 / 714)) },
    { key: 'highPass', name: 'High pass', index: 8, min: 120, max: 10900, def: 120, format: hpText, parse: (hz) => 120 + 10780 * (Math.log(Math.max(12, hz) / 12) / Math.log(1090 / 12)) },
    { key: 'mix', name: 'Mix', index: 9, min: 0, max: 1000, def: 500, format: mixText, bipolar: true, parse: (w) => w * 10 },
    { key: 'phaseDiff', name: 'LFO phase difference', index: 10, min: 0, max: 1000, def: 500, format: pct, parse: (pc) => pc * 10 },
  ],
  // FL's factory presets (values read from FL with flfxhost; omitted = Default)
  presets: [
    { name: 'Basic wide', params: { delay: 0, feedback: 0, phaseDiff: 1000 } },
    { name: 'Default', params: {} },
    { name: 'Drift stacker', params: { delay: 476, feedback: 644, modRate: 273, modAmount: 689, movement: 1000, movementRate: 1000, highPass: 1974, mix: 900 } },
    { name: 'Fullexciter', params: { delay: 1000, feedback: 0, modRate: 160, modAmount: 259, movement: 198, movementRate: 576, phaseDiff: 0 } },
    { name: 'Giant droner', params: { delay: 1000, feedback: 555, modRate: 0, modAmount: 400, movement: 300, movementRate: 300, lines: 1, mix: 350, phaseDiff: 750 } },
    { name: 'Mild chorus', params: { delay: 250, modRate: 348, modAmount: 296, movement: 786, movementRate: 488, mix: 800, phaseDiff: 800 } },
    { name: 'Orion belt', params: { delay: 675, feedback: 685, modRate: 323, modAmount: 452, movement: 136, movementRate: 850, lines: 1, lowPass: 20512, highPass: 7878, mix: 364, phaseDiff: 777 } },
    { name: 'Sandy crust', params: { delay: 562, feedback: 919, modRate: 499, modAmount: 505, movement: 501, movementRate: 473, lines: 1, lowPass: 19247, highPass: 10900, mix: 503, phaseDiff: 1000 } },
    { name: 'Top shell', params: { delay: 192, feedback: 0, modRate: 298, modAmount: 526, movement: 531, movementRate: 330, highPass: 5608, mix: 503, phaseDiff: 1000 } },
    { name: 'Viral 90s', params: { delay: 800, feedback: 0, modRate: 689, movement: 1000, movementRate: 1000, lines: 1, mix: 650, phaseDiff: 474 } },
    { name: 'Warm padder', params: { delay: 933, feedback: 353, modRate: 478, modAmount: 380, movement: 1000, movementRate: 1000, lines: 1, lowPass: 10419, highPass: 1542, phaseDiff: 875 } },
    { name: 'Wild chorus', params: { delay: 319, feedback: 763, modRate: 397, modAmount: 713, movement: 830, movementRate: 1000, phaseDiff: 1000 } },
  ],
};
