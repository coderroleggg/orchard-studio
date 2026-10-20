// Flanger (FL: Fruity Flanger, a Smart Electronix port). Form: 500 x 205, FL's
// TTestPlug grid of 12 knobs. Mappings and value texts were read from FL's
// binary (flfxhost info/sweep); see docs/research/fx/flanger.md. Defaults are
// FL's "Default" factory preset (Phase 119, Feed 24; the constructor has 118/23).

import type { FxPluginDef } from '../types';

/** FL's skewed knob law x / (k - (k - 1) x) (k = 5: delay/depth, k = 10: rate). */
const skew = (x: number, k: number) => x / (k - (k - 1) * x);

/** Minimum delay in ms (0..1024 -> 0..20 ms). */
export function flangerDelayMs(v: number): number {
  return 20 * skew(v / 1024, 5);
}

/** Sweep depth in ms (0..5000 -> 0..20 ms). */
export function flangerDepthMs(v: number): number {
  return 20 * skew(v / 5000, 5);
}

/** LFO rate in Hz (0..5000 -> 0..5 Hz). */
export function flangerRateHz(v: number): number {
  return 5 * skew(v / 5000, 10);
}

/** Feedback gain for the Feed (0..100) and Invert feedback controls: FL scales 100 % to 0.98. */
export function flangerFeedback(feed: number, invert: number): number {
  return (flangerOn(invert) ? -0.98 : 0.98) * (feed / 100);
}

/** Switch knobs (Invert feedback / wet): on above half way. */
export function flangerOn(v: number): boolean {
  return v / 1024 > 0.5;
}

/** Dry / Wet / Cross text: "-3.09804 dB", "   -oo   dB" at zero. */
export function flangerDbText(v: number): string {
  if (v <= 0) return '   -oo   dB';
  return `${(20 * Math.log10(Math.fround(v / 5000)) + 1e-12).toFixed(5)} dB`;
}

/** Delphi's Round(): halves go to the even neighbour. */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Shape text: a marker on a 14-step bar from sine (s) to triangle (t). */
export function flangerShapeText(v: number): string {
  const p = Math.max(0, Math.min(13, roundEven((v * 13) / 1024)));
  return `s${'-'.repeat(p)}|${'-'.repeat(13 - p)}t`;
}

const fixed5 = (x: number) => (x + 1e-10).toFixed(5);

export const def: FxPluginDef = {
  id: 'flanger',
  name: 'Flanger',
  category: 'Flanger',
  width: 500,
  height: 205,
  description: 'Flanger with feedback, damping and cross mix',
  params: [
    {
      key: 'delay', name: 'Delay', index: 0, min: 0, max: 1024, def: 0,
      format: (v) => `${fixed5(flangerDelayMs(v))} ms`,
      parse: (ms) => { const y = Math.max(0, Math.min(1, ms / 20)); return (1024 * 5 * y) / (1 + 4 * y); },
    },
    {
      key: 'depth', name: 'Depth', index: 1, min: 0, max: 5000, def: 2000,
      format: (v) => `${fixed5(flangerDepthMs(v))} ms`,
      parse: (ms) => { const y = Math.max(0, Math.min(1, ms / 20)); return (5000 * 5 * y) / (1 + 4 * y); },
    },
    {
      key: 'rate', name: 'Rate', index: 2, min: 0, max: 5000, def: 2000,
      format: (v) => `${fixed5(flangerRateHz(v))} Hz`,
      parse: (hz) => { const y = Math.max(0, Math.min(1, hz / 5)); return (5000 * 10 * y) / (1 + 9 * y); },
    },
    {
      key: 'phase', name: 'Phase', index: 3, min: 0, max: 360, def: 119,
      format: (v) => `${Math.round(v)} degrees`,
      parse: (deg) => deg,
    },
    {
      key: 'damp', name: 'Damp', index: 4, min: 0, max: 5000, def: 0,
      format: (v) => fixed5(v / 5000),
      parse: (x) => x * 5000,
    },
    { key: 'shape', name: 'Shape', index: 5, min: 0, max: 1024, def: 0, format: flangerShapeText },
    {
      key: 'feed', name: 'Feed', index: 6, min: 0, max: 100, def: 24,
      format: (v) => `${Math.round(v)} percent`,
      parse: (pc) => pc,
    },
    { key: 'invFeedback', name: 'Invert feedback', index: 7, min: 0, max: 1024, def: 1024, format: (v) => (flangerOn(v) ? 'on' : 'off') },
    { key: 'invWet', name: 'Invert wet', index: 8, min: 0, max: 1024, def: 1024, format: (v) => (flangerOn(v) ? 'on' : 'off') },
    { key: 'dry', name: 'Dry', index: 9, min: 0, max: 5000, def: 3500, format: flangerDbText, parse: (db) => 5000 * Math.pow(10, Math.min(0, db) / 20) },
    { key: 'wet', name: 'Wet', index: 10, min: 0, max: 5000, def: 3000, format: flangerDbText, parse: (db) => 5000 * Math.pow(10, Math.min(0, db) / 20) },
    { key: 'cross', name: 'Cross', index: 11, min: 0, max: 5000, def: 2500, format: flangerDbText, parse: (db) => 5000 * Math.pow(10, Math.min(0, db) / 20) },
  ],
  // FL's factory presets (values read from the .fst files through flfxhost; only
  // values that differ from the defaults are listed)
  presets: [
    { name: 'Bad Leslie', params: { delay: 597, depth: 938, rate: 4740, phase: 165, damp: 4010, shape: 501, feed: 82, invFeedback: 629, invWet: 747, dry: 4323, wet: 3281, cross: 4323 } },
    { name: 'Chorusy', params: { delay: 512, depth: 2344, rate: 3646, phase: 181, damp: 547, shape: 1024, feed: 33, dry: 4010, wet: 2031, cross: 2448 } },
    { name: 'Classic Deep', params: { depth: 2469, rate: 1167, phase: 61, damp: 1667, feed: 61, invFeedback: 0, invWet: 0, dry: 4021, wet: 2687, cross: 3229 } },
    { name: 'Classic Flanger', params: { delay: 112, depth: 1062, feed: 30, invFeedback: 0, invWet: 0 } },
    { name: 'Deep Flanger', params: { depth: 1406, rate: 859, phase: 11, damp: 1953, shape: 256, feed: 52, dry: 5000, wet: 781, cross: 5000 } },
    { name: 'Default', params: {} },
    { name: 'Disto Chorus', params: { delay: 528, depth: 4101, rate: 385, phase: 0, damp: 2500, shape: 917, feed: 51, invFeedback: 0, dry: 5000, wet: 4167 } },
    { name: 'Double Trouble', params: { delay: 747, depth: 4167, rate: 2469, phase: 160, shape: 480, feed: 25, invWet: 336, dry: 3359, wet: 0, cross: 3880 } },
    { name: 'Doubling', params: { delay: 784, depth: 5000, rate: 1687, phase: 271, shape: 512, feed: 30, invWet: 336, dry: 3359, wet: 1719, cross: 3359 } },
    { name: 'Fast Flanger', params: { delay: 640, depth: 3125, rate: 2645, phase: 45, damp: 2500, feed: 50, dry: 2504, wet: 2500, cross: 2480 } },
    { name: 'Feel This', params: { delay: 160, depth: 807, rate: 1766, phase: 46, damp: 1797, feed: 88, dry: 3255, wet: 833 } },
    { name: 'Modulation', params: { depth: 1406, rate: 5000, phase: 11, shape: 256, feed: 0, invFeedback: 0, invWet: 0, dry: 0, wet: 5000, cross: 0 } },
    { name: 'Moving', params: { depth: 1094, rate: 3406, phase: 85, damp: 1797, feed: 50, dry: 3359, wet: 3281, cross: 3359 } },
    { name: 'Moving Distortion', params: { delay: 528, depth: 5000, rate: 906, phase: 0, shape: 512, feed: 86, invWet: 0, dry: 2816 } },
    { name: 'Simple', params: { delay: 56, depth: 3984, rate: 848, phase: 34, damp: 2500, shape: 512, feed: 0, dry: 2812, wet: 2812, cross: 2812 } },
    { name: 'Slight Detune', params: { delay: 416, depth: 3177, rate: 3646, phase: 169, damp: 4010, invWet: 469, dry: 5000, wet: 5000, cross: 2188 } },
    { name: 'Slow Flanger', params: { delay: 528, depth: 5000, rate: 906, phase: 96, feed: 0, dry: 3519, wet: 3937, cross: 4453 } },
    { name: 'Subtle', params: { delay: 176, depth: 958, rate: 802, damp: 2656, shape: 629, feed: 18, invFeedback: 747, invWet: 0, wet: 3521 } },
    { name: 'Swirrly', params: { delay: 107, depth: 3932, rate: 880, phase: 34, damp: 286, shape: 437, feed: 84, invFeedback: 336, invWet: 779, dry: 1641, wet: 3281, cross: 0 } },
    { name: 'The Mover', params: { depth: 437, phase: 66, damp: 3594, shape: 128, dry: 3073, wet: 0, cross: 3646 } },
    { name: 'Trance 01', params: { delay: 427, depth: 2469, rate: 3771, damp: 3958, invWet: 747, wet: 3989 } },
    { name: 'Trance 02', params: { delay: 213, depth: 1583, rate: 3802, phase: 34, damp: 781, feed: 50, invWet: 843, dry: 0, wet: 4583, cross: 781 } },
    { name: 'Ultra Fat Chorus', params: { delay: 1024, depth: 3125, rate: 2656, phase: 124, damp: 1094, shape: 336, feed: 45, invFeedback: 0, dry: 5000, wet: 5000, cross: 0 } },
    { name: 'Ultra Thin', params: { delay: 32, depth: 938, rate: 2500, phase: 0, shape: 1024, feed: 0, dry: 5000, wet: 5000, cross: 0 } },
    { name: 'Vexed Fifths', params: { delay: 75, depth: 5000, rate: 5000, phase: 180, damp: 4010, shape: 971, feed: 7, invFeedback: 565, invWet: 1003, dry: 1823, wet: 4740, cross: 4531 } },
    { name: 'Weird', params: { delay: 1024, depth: 5000, rate: 156, phase: 0, damp: 547, shape: 512, feed: 91, invFeedback: 0, invWet: 336, dry: 0, wet: 5000, cross: 0 } },
    { name: 'Wide Flanger', params: { delay: 160, depth: 3828, rate: 1766, phase: 181, damp: 1797, shape: 1024, feed: 92, invFeedback: 176, invWet: 352, dry: 1641, wet: 3281, cross: 0 } },
  ],
};
