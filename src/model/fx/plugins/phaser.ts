// Phaser (FL: Fruity Phaser, a Smart Electronix port of Bram's SupaPhaser).
// Form: 500 x 155, FL's TTestPlug grid of 9 knobs. Value texts and mappings were
// read from FL's binary with flfxhost; see docs/research/fx/phaser.md. Defaults
// are FL's "Default" factory preset (it differs from the constructor in 7 of 9
// parameters: 0.3 Hz, depth 0..0.9, 12 stages, feedback 0.693, 100 % wet, 0 dB).

import type { FxPluginDef } from '../types';

const fixed5 = (x: number) => (x + 1e-10).toFixed(5);

/** Delphi's Round(): halves go to the even neighbour ("62 % wet" at 62.5). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Number of first-order allpass sections for the Stages control (FL uses at least 3). */
export function phaserSections(v: number): number {
  return Math.max(3, Math.round(v) + 1);
}

/** Dry - Wet: the control is the dry share (0 = 100 % wet). */
export function phaserDryShare(v: number): number {
  return Math.max(0, Math.min(1, v / 1024));
}

/** Output gain, linear (2500 = unity, 5000 = +6 dB). */
export function phaserGain(v: number): number {
  return Math.max(0, v) / 2500;
}

/** "Frequency range": large above half way. */
export function phaserLargeRange(v: number): boolean {
  return v > 512;
}

export const def: FxPluginDef = {
  id: 'phaser',
  name: 'Phaser',
  category: 'Flanger',
  width: 500,
  height: 155,
  description: 'Allpass phaser with up to 23 stages and feedback',
  params: [
    { key: 'sweep', name: 'Sweep frequency', index: 0, min: 0, max: 5000, def: 1500, format: (v) => `${fixed5(v / 5000)} Hz`, parse: (hz) => hz * 5000 },
    { key: 'minDepth', name: 'Minimum depth', index: 1, min: 0, max: 1000, def: 0, format: (v) => fixed5(v / 1000), parse: (x) => x * 1000 },
    { key: 'maxDepth', name: 'Maximum depth', index: 2, min: 0, max: 1000, def: 900, format: (v) => fixed5(v / 1000), parse: (x) => x * 1000 },
    { key: 'range', name: 'Frequency range', index: 3, min: 0, max: 1024, def: 0, format: (v) => (phaserLargeRange(v) ? 'large' : 'small') },
    { key: 'stereo', name: 'Stereo', index: 4, min: 0, max: 1024, def: 512, format: (v) => `${fixed5(v / 1024)} phase`, parse: (x) => x * 1024 },
    { key: 'stages', name: 'Number of stages', index: 5, min: 0, max: 22, def: 11, format: (v) => String(Math.round(v) + 1), parse: (n) => n - 1 },
    { key: 'feedback', name: 'Feedback', index: 6, min: 0, max: 1000, def: 693, format: (v) => `${fixed5(v / 1000)} amount`, parse: (x) => x * 1000 },
    { key: 'dryWet', name: 'Dry - Wet', index: 7, min: 0, max: 1024, def: 0, format: (v) => `${roundEven(100 * (1 - v / 1024))} % wet`, parse: (pc) => (1 - pc / 100) * 1024 },
    {
      key: 'gain', name: 'Output gain', index: 8, min: 0, max: 5000, def: 2500,
      format: (v) => (v <= 0 ? '-oo   dB' : `${(20 * Math.log10(Math.fround(v / 2500)) + 1e-12).toFixed(5)} dB`),
      parse: (db) => 2500 * Math.pow(10, db / 20),
    },
  ],
  // FL's factory presets (read from the .fst files through flfxhost; values that
  // differ from the defaults)
  presets: [
    { name: 'Ambience', params: { sweep: 2385, minDepth: 365, maxDepth: 504, range: 309, feedback: 700, dryWet: 320 } },
    { name: 'Aqua Bright', params: { sweep: 810, minDepth: 143, maxDepth: 246, range: 592, stages: 3, feedback: 765 } },
    { name: 'Aqua Nice', params: { sweep: 966, maxDepth: 1000, range: 592, stereo: 595, feedback: 497, dryWet: 560, gain: 2578 } },
    { name: 'Deep Fish', params: { sweep: 628, maxDepth: 820, range: 395, stereo: 717, stages: 8, feedback: 932, gain: 2044 } },
    { name: 'Default', params: {} },
    { name: 'Dreamin', params: { sweep: 2620, minDepth: 495, maxDepth: 1000, range: 395, stereo: 739, stages: 15, feedback: 943, dryWet: 152, gain: 2044 } },
    { name: 'Euro Rave', params: { sweep: 2448, minDepth: 510, maxDepth: 417, range: 1024, stereo: 1024, stages: 16, feedback: 508 } },
    { name: 'Good Old', params: { sweep: 1786, maxDepth: 146, range: 453, stereo: 701, stages: 2, feedback: 471, dryWet: 21, gain: 2539 } },
    { name: 'Metalic', params: { sweep: 625, minDepth: 812, maxDepth: 953, stereo: 768, stages: 22, feedback: 941, gain: 3359 } },
    { name: 'Moog It 01', params: { sweep: 3739, minDepth: 227, maxDepth: 620, range: 395, stereo: 824, feedback: 315, dryWet: 59, gain: 2643 } },
    { name: 'Moog It 02', params: { sweep: 4547, minDepth: 36, maxDepth: 406, range: 557, stereo: 517, stages: 12, feedback: 0, dryWet: 83, gain: 2812 } },
    { name: 'Old Fashioned', params: { sweep: 859, minDepth: 266, maxDepth: 797, range: 1024, stereo: 128, stages: 7, feedback: 580 } },
    { name: 'Ouch', params: { sweep: 417, minDepth: 995, maxDepth: 1000, stereo: 1024, stages: 3, feedback: 705, gain: 2943 } },
    { name: 'Phazor', params: { sweep: 719, minDepth: 750, maxDepth: 410, range: 96, stereo: 0, feedback: 700, dryWet: 309, gain: 2292 } },
    { name: 'Raegga', params: { sweep: 2893, maxDepth: 620, range: 395, stereo: 408, stages: 5, feedback: 442, dryWet: 200, gain: 2851 } },
    { name: 'Sow Low 01', params: { sweep: 380, maxDepth: 322, range: 592, stereo: 501, feedback: 437 } },
    { name: 'Sow Low 02', params: { sweep: 380, maxDepth: 1000, range: 688, stereo: 488, feedback: 137, dryWet: 109, gain: 2578 } },
    { name: 'Stereo Enhance 01', params: { sweep: 1406, minDepth: 594, maxDepth: 875, range: 1024, stages: 22, feedback: 541, dryWet: 592, gain: 3047 } },
    { name: 'Stereo Enhance 02', params: { sweep: 5000, minDepth: 438, maxDepth: 547, range: 1024, stages: 22, feedback: 0, gain: 3047 } },
    { name: 'Stompit 01', params: { sweep: 3414, minDepth: 112, maxDepth: 336, range: 395, stages: 8, feedback: 333, dryWet: 64, gain: 2513 } },
    { name: 'Stompit 02', params: { sweep: 4547, minDepth: 266, maxDepth: 654, range: 557, stereo: 517, stages: 7, feedback: 619, dryWet: 221, gain: 2930 } },
    { name: 'Subtle', params: { sweep: 1083, maxDepth: 233, stereo: 533, stages: 5, feedback: 276, dryWet: 491 } },
    { name: 'Talking Phaser', params: { sweep: 781, minDepth: 672, maxDepth: 859, range: 1024, stereo: 1024, feedback: 371, dryWet: 336, gain: 3984 } },
    { name: 'Tech Wash', params: { sweep: 755, minDepth: 89, maxDepth: 828, range: 1024, stereo: 683, stages: 20, feedback: 778 } },
    { name: 'Weird Effect', params: { sweep: 2734, minDepth: 594, maxDepth: 1000, range: 1024, stages: 22, feedback: 928, gain: 3047 } },
    { name: 'Whales Singing', params: { sweep: 547, minDepth: 953, maxDepth: 1000, range: 1024, stages: 22, feedback: 990, gain: 3047 } },
    { name: 'Wishwash', params: { sweep: 2031, maxDepth: 1000, range: 1024, stages: 4, feedback: 758 } },
  ],
};
