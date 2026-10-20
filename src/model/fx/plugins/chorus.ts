// Chorus (FL: Fruity Chorus, a Smart Electronix port). Form: 500 x 205, a grid
// of 12 knob bevels. Value texts and mappings were read from FL's plugin
// binary (flfxhost info/sweep); see docs/research/fx/chorus.md. Defaults are
// FL's "Default" factory preset (LFO 1 Wave 0; the constructor has 23).

import type { FxPluginDef } from '../types';

const F = Math.fround;
// FL prints values with 5 decimals; exact ties round up (the epsilon reproduces
// FL's "5.66563 ms" where a double would print "5.66562").
const fixed5 = (x: number) => (x + 1e-10).toFixed(5);

/** Minimum delay in ms for Delay control value v (0..1024): 0.05 .. 30 ms. */
export function chorusDelayMs(v: number): number {
  return 0.05 + (v / 1024) * 29.95;
}

/** Depth in ms (0..5000 -> 0..5 ms). */
export function chorusDepthMs(v: number): number {
  return v / 1000;
}

/** LFO rate in Hz (0..5000 -> 0..5 Hz, quadratic). */
export function chorusLfoHz(v: number): number {
  const x = v / 5000;
  return 5 * x * x;
}

/** LFO rate text: FL computes it in single precision ("0.00005 Hz" at v = 15). */
function lfoText(v: number): string {
  const x = F(v / 5000);
  return `${F(F(x * x) * 5).toFixed(5)} Hz`;
}

/** Stereo: right-channel LFO phase lead in degrees (0..1024 -> 0..180). */
export function chorusStereoDeg(v: number): number {
  return (v / 1024) * 180;
}

/** Cross-over cutoff in Hz: MIDI note v*127/5000 (8.18 Hz .. 12.5 kHz). */
export function chorusCutoffHz(v: number): number {
  return 440 * Math.pow(2, ((v * 127) / 5000 - 69) / 12);
}

export const CHORUS_WAVES = ['sin', 'sin^3', 'multi-sin', 'multi-sin^3'];

/** LFO wave index for a Wave control value: FL truncates v*3/1024 (multi-sin^3 only at the very end). */
export function chorusWave(v: number): number {
  return Math.max(0, Math.min(3, Math.floor((v * 3) / 1024)));
}

/** Cross type: "Process LF" above a quarter of the range. */
export function chorusProcessLF(v: number): boolean {
  return v / 100 > 0.25;
}

/** Wet only: "yes" above a quarter of the range. */
export function chorusWetOnly(v: number): boolean {
  return v / 1024 > 0.25;
}

export const def: FxPluginDef = {
  id: 'chorus',
  name: 'Chorus',
  category: 'Flanger',
  width: 500,
  height: 205,
  description: 'Three-voice chorus with a cross-over filter',
  params: [
    {
      key: 'delay', name: 'Delay', index: 0, min: 0, max: 1024, def: 512,
      format: (v) => `${fixed5(chorusDelayMs(v))} ms`,
      parse: (ms) => ((ms - 0.05) / 29.95) * 1024,
    },
    {
      key: 'depth', name: 'Depth', index: 1, min: 0, max: 5000, def: 2250,
      format: (v) => `${fixed5(chorusDepthMs(v))} ms`,
      parse: (ms) => ms * 1000,
    },
    {
      key: 'stereo', name: 'Stereo', index: 2, min: 0, max: 1024, def: 341,
      format: (v) => `${Math.floor((v * 180) / 1024)} degrees`,
      parse: (deg) => (deg / 180) * 1024,
    },
    ...[1, 2, 3].map((k) => ({
      key: `lfo${k}Freq`, name: `LFO ${k} Frequency`, index: 2 + k, min: 0, max: 5000, def: [1500, 2500, 3500][k - 1],
      format: lfoText,
      parse: (hz: number) => 5000 * Math.sqrt(Math.max(0, hz) / 5),
    })),
    ...[1, 2, 3].map((k) => ({
      key: `lfo${k}Wave`, name: `LFO ${k} Wave`, index: 5 + k, min: 0, max: 1024, def: 0,
      format: (v: number) => CHORUS_WAVES[chorusWave(v)],
      parse: (i: number) => Math.round((Math.max(0, Math.min(3, Math.round(i))) * 1024) / 3 + (i >= 3 ? 0 : 1)),
    })),
    {
      key: 'crossType', name: 'Cross Type', index: 9, min: 0, max: 100, def: 0,
      format: (v) => (chorusProcessLF(v) ? 'Process LF' : 'Process HF'),
    },
    {
      key: 'crossCutoff', name: 'Cross Cutoff', index: 10, min: 0, max: 5000, def: 2500,
      format: (v) => `${F(chorusCutoffHz(v)).toFixed(5)} Hz`,
      parse: (hz) => ((69 + 12 * Math.log2(Math.max(1e-3, hz) / 440)) * 5000) / 127,
    },
    {
      key: 'wetOnly', name: 'Wet only', index: 11, min: 0, max: 1024, def: 0,
      format: (v) => (chorusWetOnly(v) ? 'yes' : 'no'),
    },
  ],
  // FL's factory presets (values read from the .fst files through flfxhost; only
  // values that differ from the defaults are listed)
  presets: [
    { name: '50 Detune', params: { delay: 40, depth: 4375, stereo: 149, lfo1Freq: 3229, lfo2Freq: 0, lfo3Freq: 781, lfo1Wave: 587, lfo3Wave: 1024, crossType: 65, crossCutoff: 4531, wetOnly: 491 } },
    { name: 'CE Chorus', params: { delay: 115, depth: 3669, stereo: 0, lfo1Freq: 1458, lfo2Freq: 0, lfo3Freq: 0, crossCutoff: 1719 } },
    { name: 'Default', params: {} },
    { name: 'Fat Clean', params: { delay: 0, depth: 336, stereo: 640, lfo1Freq: 0, lfo2Freq: 4375, lfo3Freq: 0, lfo2Wave: 427, crossType: 76, crossCutoff: 4740 } },
    { name: 'Filtro', params: { delay: 40, depth: 388, stereo: 352, lfo1Freq: 1458, lfo2Freq: 1615, lfo3Freq: 1719, lfo3Wave: 117, crossCutoff: 4062, wetOnly: 491 } },
    { name: 'Light HF', params: { delay: 128, depth: 1534, stereo: 480, lfo1Freq: 2695, lfo2Freq: 0, lfo3Freq: 1914, lfo3Wave: 949, crossCutoff: 4479 } },
    { name: 'Low Enhance', params: { delay: 243, depth: 4336, stereo: 416, lfo1Freq: 0, lfo2Freq: 0, lfo3Freq: 781, lfo3Wave: 1024, crossType: 65, crossCutoff: 4635, wetOnly: 96 } },
    { name: 'Poly Chorus', params: { delay: 72, depth: 1898, stereo: 160, lfo1Freq: 0, lfo2Freq: 3490, lfo3Freq: 0, crossCutoff: 2760 } },
  ],
};
