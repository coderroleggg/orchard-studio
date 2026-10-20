// Pitcher (FL: Pitcher): real-time pitch correction and harmonization.
// FL's Pitcher is a C++ plugin with a bitmap editor and no extracted form; the
// 21 automatable parameters (names, raw 0..256 ranges, defaults and value
// texts) were read through the FL test host, the option lists (Min: 25..220
// Hz, Minor / Major / Pentatonic, reference Left / Both / Right) from the
// binary's strings, and the editor size (415 x 280) from the manual
// screenshot. Scale, key, A3 tuning, the note switches, the minimum
// frequency, the reference channel, FORMANT, the MIDI / OCTAVES / HARMONIZE
// switches, REPLACE/MIX, VEL and the MIDI input port are FL's non-parameter
// state. MIDI mode follows the notes of a MIDI Out channel on Pitcher's port.

import type { FxPluginDef, FxParamDef } from '../types';

export const PIT_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** FL's list order (binary strings): Minor, Major, Pentatonic. */
export const PIT_SCALES = ['Minor', 'Major', 'Pentatonic'];
export const PIT_SCALE_STEPS = [[0, 2, 3, 5, 7, 8, 10], [0, 2, 4, 5, 7, 9, 11], [0, 2, 4, 7, 9]];
export const PIT_MIN_HZ = [25, 55, 80, 110, 170, 220];
export const PIT_REFS = ['Left', 'Both', 'Right'];

/** Note switches for a scale and key (key 0 = C). */
export function pitScaleNotes(scale: number, key: number): boolean[] {
  const steps = PIT_SCALE_STEPS[Math.max(0, Math.min(PIT_SCALE_STEPS.length - 1, scale))];
  const out = new Array(12).fill(false);
  for (const s of steps) out[(key + s) % 12] = true;
  return out;
}

/** Correction glide time constant (ms) for the speed knob 0..256: FL measured 348 ms at 0, 144 at 64, 43 at 128. */
export function pitSpeedTau(v: number): number {
  const s = Math.min(1, Math.max(0, v / 256));
  return 348 * Math.pow(1 - s, 3);
}

// FL's value texts end with a space ("100 ") and truncate toward -inf.
const pct = (v: number) => `${Math.floor((v * 100) / 256)} `;
const bip = (v: number) => `${Math.floor(((v - 128) * 100) / 128)} `;
const byp = (v: number) => (v > 0 ? 'Bypassed ' : 'Enabled ');

const keyParams: FxParamDef[] = PIT_NOTES.map((n, i) => ({
  key: `byp${i}`, name: `Key ${n} Bypass`, index: 5 + i, min: 0, max: 256, def: 0, step: 256, format: byp,
}));

export const def: FxPluginDef = {
  id: 'pitcher',
  name: 'Pitcher',
  category: 'Misc',
  width: 415,
  height: 280,
  description: 'Real-time pitch correction and harmonization',
  params: [
    { key: 'speed', name: 'Correction Speed', index: 0, min: 0, max: 256, def: 256, format: pct },
    { key: 'stereo', name: 'Stereo', index: 1, min: 0, max: 256, def: 256, format: pct },
    { key: 'gender', name: 'Gender', index: 2, min: 0, max: 256, def: 128, bipolar: true, format: bip },
    { key: 'fine', name: 'Fine Tune', index: 3, min: 0, max: 256, def: 128, bipolar: true, format: bip },
    { key: 'bypass', name: 'Bypass All', index: 4, min: 0, max: 256, def: 0, step: 256, format: pct },
    ...keyParams,
    { key: 'pan1', name: 'Voice 1 Pan', index: 17, min: 0, max: 256, def: 128, bipolar: true, format: bip },
    { key: 'pan2', name: 'Voice 2 Pan', index: 18, min: 0, max: 256, def: 128, bipolar: true, format: bip },
    { key: 'pan3', name: 'Voice 3 Pan', index: 19, min: 0, max: 256, def: 128, bipolar: true, format: bip },
    { key: 'pan4', name: 'Voice 4 Pan', index: 20, min: 0, max: 256, def: 128, bipolar: true, format: bip },
  ],
  state: () => ({
    scale: 0, key: 0, a3: 440, notes: new Array(12).fill(true), minHz: 3, ref: 0,
    formant: false, midi: false, octaves: false, harmonize: false, replace: true, vel: false, port: -1,
  }),
  normalize: (p) => {
    const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    const notes = Array.isArray(p.notes) && p.notes.length === 12 ? (p.notes as unknown[]).map((x) => !!x) : new Array(12).fill(true);
    // notes latched in the editor before MIDI input reached effects: MIDI mode now follows MIDI notes
    const { held: _held, ...rest } = p;
    void _held;
    return {
      ...rest,
      scale: Math.round(num(p.scale, 0, 0, PIT_SCALES.length - 1)),
      key: Math.round(num(p.key, 0, 0, 11)),
      a3: num(p.a3, 440, 400, 480),
      notes,
      minHz: Math.round(num(p.minHz, 3, 0, PIT_MIN_HZ.length - 1)),
      ref: Math.round(num(p.ref, 0, 0, 2)),
      formant: !!p.formant, midi: !!p.midi, octaves: !!p.octaves, harmonize: !!p.harmonize,
      replace: p.replace === undefined ? true : !!p.replace, vel: !!p.vel,
      port: Math.round(num(p.port, -1, -1, 255)),
    };
  },
};
