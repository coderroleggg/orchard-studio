// Vintage Chorus (FL: Vintage Chorus, a Juno-6 BBD chorus model by Daniel
// Schaack). Form: 747 x 217. Parameters, ranges and texts from FL's binary
// (flfxhost info/sweep); the DSP was measured from FL's renders, see
// docs/research/fx/vchorus.md. Defaults are FL's "Default" preset (it differs
// from the constructor only in Speed: 80 instead of 49152).

import type { FxPluginDef } from '../types';

export const VCHORUS_MODES = ['Chorus 1', 'Chorus 2', 'Custom'];

const F = Math.fround;

/** Position of the Speed control (1..245760) in 0..1. */
const speedX = (v: number) => Math.max(0, Math.min(1, (v - 1) / 245759));

/** LFO speed (Hz) for the Speed control: 10 x^2. */
export function vchorusSpeedHz(v: number): number {
  const x = speedX(v);
  return 10 * x * x;
}

/** Tempo-synced LFO period in ticks (48 per step), 6144 (128 steps) .. 1: FL rounds an
 *  exponential curve to whole ticks (reproduces all swept texts and measured periods). */
export function vchorusSyncTicks(v: number): number {
  const g = Math.pow(128, 1 - speedX(v)) - 1;
  return Math.max(1, Math.floor((6143 / 127) * g + 1.1));
}

/** Tempo-synced LFO period in steps. */
export function vchorusSyncSteps(v: number): number {
  return vchorusSyncTicks(v) / 48;
}

/** FL's text for a tempo-synced speed: "steps:ticks" (48 ticks per step). */
export function vchorusSyncText(v: number): string {
  const ticks = vchorusSyncTicks(v);
  return `${Math.floor(ticks / 48)}:${ticks % 48}`;
}

/** BBD delay (ms) for a Time control value (0..6000, shown as 0..1000 "ms"). */
export function vchorusDelayMs(v: number): number {
  return 0.244 + 0.0098 * (v / 6);
}

/** Wet high-pass cut-off (Hz): 10 + 160 x^2. */
export function vchorusHighPassHz(v: number): number {
  const x = Math.max(0, Math.min(1, v / 6000));
  return 10 + 160 * x * x;
}

/** Noise level (linear): -90 .. -40 dB, silent at 0. */
export function vchorusNoise(v: number): number {
  if (v <= 0) return 0;
  return Math.pow(10, (-90 + (50 * Math.min(6000, v)) / 6000) / 20);
}

const deg = (v: number) => `${((v / 6000) * 360).toFixed(2)}°`;
const onOff = ['Off', 'On'];

/** "50% Dry / 50% Wet": FL rounds the dry share (Delphi Round: halves to even). */
function mixText(v: number): string {
  const x = (100 * (6000 - v)) / 6000;
  const f = Math.floor(x);
  const d = Math.abs(x - f - 0.5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(x);
  return `${d}% Dry / ${100 - d}% Wet`;
}

/** Speed text, computed in single precision like FL. */
function speedText(v: number): string {
  const x = F((v - 1) / 245759);
  return `${F(10 * F(x * x)).toFixed(2)} Hz`;
}

/** High-pass text, computed in single precision like FL ("10.02 Hz" at 10.025). */
function hpText(v: number): string {
  const x = F(v / 6000);
  return `${F(10 + F(160 * F(x * x))).toFixed(2)} Hz`;
}

export const def: FxPluginDef = {
  id: 'vchorus',
  name: 'Vintage Chorus',
  category: 'Flanger',
  width: 747,
  height: 217,
  description: 'Juno-style BBD chorus with modes I, II, I+II and a custom mode',
  params: [
    { key: 'mode', name: 'Mode', index: 0, min: 0, max: 2, def: 0, options: VCHORUS_MODES },
    { key: 'link', name: 'Link Chorus I+II', index: 1, min: 0, max: 1, def: 0, options: onOff },
    { key: 'speed', name: 'Speed', index: 2, min: 1, max: 245760, def: 80, format: (v, st) => (Number(st?.sync) >= 0.5 ? vchorusSyncText(v) : speedText(v)), parse: (hz) => 1 + 245759 * Math.sqrt(Math.max(0, hz) / 10) },
    { key: 'lfoType', name: 'LFO type', index: 3, min: 0, max: 1, def: 0, options: ['Triangle', 'Sine'] },
    { key: 'lrPhase', name: 'LR Phase', index: 4, min: 0, max: 6000, def: 3000, format: deg, parse: (d) => (d / 360) * 6000 },
    { key: 'time1', name: 'Time 1', index: 5, min: 0, max: 6000, def: 60, format: (v) => `${(v / 6).toFixed(1)} ms`, parse: (ms) => ms * 6 },
    { key: 'time2', name: 'Time 2', index: 6, min: 0, max: 6000, def: 3000, format: (v) => `${(v / 6).toFixed(1)} ms`, parse: (ms) => ms * 6 },
    { key: 'mix', name: 'Mix', index: 7, min: 0, max: 6000, def: 3000, format: mixText, parse: (w) => (w / 100) * 6000 },
    { key: 'mono', name: 'Mono input', index: 8, min: 0, max: 1, def: 0, options: onOff },
    { key: 'invert', name: 'Invert wet', index: 9, min: 0, max: 1, def: 0, options: onOff },
    { key: 'feedback', name: 'Feedback', index: 10, min: 0, max: 6000, def: 0, format: (v) => `${((v / 6000) * 100 + 1e-9).toFixed(1)}%`, parse: (pc) => (pc / 100) * 6000 },
    { key: 'highPass', name: 'High pass', index: 11, min: 0, max: 6000, def: 3000, format: hpText, parse: (hz) => 6000 * Math.sqrt(Math.max(0, hz - 10) / 160) },
    { key: 'gain', name: 'Gain', index: 12, min: 0, max: 6000, def: 0, format: (v) => `${((v / 6000) * 12).toFixed(2)} dB`, parse: (db) => (db / 12) * 6000 },
    { key: 'noise', name: 'Noise', index: 13, min: 0, max: 6000, def: 3000, format: (v) => (v <= 0 ? '-∞' : `${(-90 + (50 * v) / 6000 - 1e-9).toFixed(1)} dB`), parse: (db) => ((db + 90) / 50) * 6000 },
    { key: 'gate', name: 'Noise gate', index: 14, min: 0, max: 1, def: 0, options: onOff },
    { key: 'sync', name: 'Tempo sync', index: 15, min: 0, max: 1, def: 0, options: onOff },
    { key: 'startPhase', name: 'Start phase', index: 16, min: 0, max: 6000, def: 0, format: deg, parse: (d) => (d / 360) * 6000 },
  ],
  // FL's factory presets (values read from FL with flfxhost; omitted = Default)
  presets: [
    { name: 'At the corner', params: { mode: 2, speed: 47491, lrPhase: 2228, time1: 6000, time2: 5688, mix: 6000, invert: 1, feedback: 6000, highPass: 0, noise: 0 } },
    { name: 'Chiptuner', params: { mode: 2, speed: 245760, lrPhase: 0, time1: 6000, time2: 0, invert: 1, highPass: 0, noise: 0 } },
    { name: 'Crystal Twister', params: { mode: 2, speed: 211046, lfoType: 1, lrPhase: 2411, time1: 960, time2: 1985, mix: 5121, invert: 1, feedback: 4420, highPass: 6000, gain: 273, noise: 0 } },
    { name: 'Default', params: {} },
    { name: 'Feedback Folder', params: { mode: 2, speed: 1, lrPhase: 0, time1: 675, time2: 2660, invert: 1, feedback: 6000, highPass: 0, noise: 0 } },
    { name: 'Feedback Shaper', params: { mode: 2, speed: 1, lrPhase: 0, time1: 0, time2: 2660, feedback: 6000, highPass: 0, noise: 0 } },
    { name: 'Juno 106 Mode I', params: { mode: 2, speed: 55812, lrPhase: 3036, time1: 2940, time2: 0, highPass: 0, gain: 917, noise: 1788 } },
    { name: 'Juno 106 Mode II', params: { mode: 2, speed: 70351, lrPhase: 3036, time1: 2802, time2: 0, highPass: 0, gain: 917, noise: 1788 } },
    { name: 'Juno 6 Mode I', params: { mode: 2, speed: 49095, time1: 536, time2: 3081 } },
    { name: 'Juno 6 Mode I + II', params: { mode: 2, speed: 219818, lfoType: 1, lrPhase: 171, time1: 1622, time2: 1943 } },
    { name: 'Juno 6 Mode II', params: { mode: 2, speed: 60103, time1: 536, time2: 3081 } },
    { name: 'Neon Smudge', params: { mode: 2, speed: 9973, lfoType: 1, lrPhase: 4500, time1: 0, time2: 6000, mix: 4055, invert: 1, feedback: 3000, highPass: 0, noise: 0, gate: 1, startPhase: 3000 } },
    { name: 'Presencer', params: { mode: 2, speed: 73838, time1: 0, time2: 338, mix: 2770, invert: 1, feedback: 2379, highPass: 1414, noise: 0 } },
    { name: 'Pseudoubler', params: { mode: 2, speed: 1, lfoType: 1, lrPhase: 0, time1: 0, highPass: 0, noise: 0 } },
    { name: 'Pulse Rocker', params: { mode: 2, speed: 245760, lfoType: 1, lrPhase: 0, time1: 824, time2: 418, invert: 1, highPass: 6000, noise: 0 } },
    { name: 'Pulsifier for saw', params: { mode: 2, speed: 1, time1: 0, time2: 0, mono: 1, invert: 1, highPass: 0, gain: 2845, noise: 0 } },
    { name: 'PWM for saw', params: { mode: 2, speed: 88495, lrPhase: 0, time1: 0, time2: 2320, mono: 1, invert: 1, highPass: 0, gain: 1752, noise: 0 } },
    { name: 'Quick Vibe', params: { mode: 2, speed: 37553, lrPhase: 1748, time1: 2289, time2: 1792, mix: 2127, feedback: 6000, highPass: 3938, noise: 1050 } },
    { name: 'Retro Chorus MKI', params: { mode: 2, speed: 12288, lrPhase: 2873, time1: 4122, time2: 812, mix: 3043, feedback: 435, highPass: 0, noise: 2143 } },
    { name: 'Retro Flipper', params: { mode: 2, speed: 1, time1: 0, time2: 0, mix: 6000, invert: 1, highPass: 0, noise: 0 } },
    { name: 'Slow PWM', params: { mode: 2, speed: 22373, lfoType: 1, lrPhase: 0, time1: 0, time2: 844, mix: 2389, mono: 1, invert: 1, highPass: 3134, gain: 177, noise: 0, startPhase: 3536 } },
    { name: 'Vintage Shaper', params: { mode: 2, speed: 1, lrPhase: 0, time1: 0, time2: 0, mix: 6000, feedback: 6000, highPass: 6000, noise: 0 } },
  ],
};
