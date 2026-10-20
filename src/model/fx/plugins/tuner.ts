// Tuner (FL: Tuner): monophonic pitch display. Form: 300 x 360 (a 300 x 300
// display above a 60 px control strip). Parameters (host): 0 Reference
// 0..6000 (400..480 Hz, 3000 = "440.0 Hz"), 1 Reactivity 0..6000 ("50.0 %"),
// 2 Bass mode Off/On. The display mode (dial or basic) is saved state:
// FL stores 2 = circular (dial), 1 = horizontal (basic).

import type { FxPluginDef } from '../types';

export const TUNER_DIAL = 2;
export const TUNER_BASIC = 1;

/** Reference pitch of A4 in Hz for a wheel value. */
export function tunerRefHz(v: number): number {
  return 400 + (v * 80) / 6000;
}

export function tunerRefText(v: number): string {
  return `${tunerRefHz(v).toFixed(1)} Hz`;
}

/** FL computes the percentage in single precision. */
export function tunerReactText(v: number): string {
  return `${Math.fround(Math.fround(v / 6000) * 100).toFixed(1)} %`;
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface TunerNote {
  /** Nearest MIDI key (FL numbering: key 60 = C5). */
  key: number;
  name: string;
  octave: number;
  /** Offset from the nearest note in cents, rounded (-50..50). */
  cents: number;
  /** Unrounded offset. */
  exact: number;
}

/** Nearest note and cent offset of a frequency for an A4 reference. */
export function tunerNote(hz: number, refHz = 440): TunerNote | null {
  if (!(hz > 0) || !(refHz > 0)) return null;
  const k = 69 + 12 * Math.log2(hz / refHz);
  const key = Math.round(k);
  const exact = (k - key) * 100;
  return { key, name: NOTE_NAMES[((key % 12) + 12) % 12], octave: Math.floor(key / 12), cents: Math.round(exact) || 0, exact };
}

/** FL's texts: "65.4 Hz" and "+1 cent" (always singular, explicit sign). */
export function tunerHzText(hz: number): string {
  return hz > 0 ? `${hz.toFixed(1)} Hz` : '0 Hz';
}

export function tunerCentText(c: number): string {
  const r = Math.round(c) || 0;
  return `${r < 0 ? '-' : '+'}${Math.abs(r)} cent`;
}

/** Detection range: F1 (21.8 Hz, FL naming) up to E7 (slow) .. C10 (fast); Bass mode adds an octave below. */
export function tunerRange(react: number, bass: boolean): { lo: number; hi: number } {
  const r = Math.max(0, Math.min(1, react / 6000));
  const lo = 440 * Math.pow(2, (17 - 69) / 12) / (bass ? 2 : 1);
  const hi = 440 * Math.pow(2, (88 + r * (120 - 88) - 69) / 12);
  return { lo, hi };
}

export const def: FxPluginDef = {
  id: 'tuner',
  name: 'Tuner',
  category: 'Visual',
  width: 300,
  height: 360,
  description: 'Pitch tuner for monophonic sounds',
  params: [
    { key: 'ref', name: 'Reference', index: 0, min: 0, max: 6000, def: 3000, format: tunerRefText, parse: (hz) => Math.round(((hz - 400) * 6000) / 80) },
    { key: 'react', name: 'Reactivity', index: 1, min: 0, max: 6000, def: 3000, format: tunerReactText, parse: (pct) => Math.round(pct * 60) },
    { key: 'bass', name: 'Bass mode', index: 2, min: 0, max: 1, def: 0, options: ['Off', 'On'] },
  ],
  state: () => ({ display: TUNER_DIAL }),
  normalize: (p) => ({ ...p, display: p.display === TUNER_BASIC ? TUNER_BASIC : TUNER_DIAL }),
  // FL's factory presets (Circular/ and Horizontal/ folders), values read with flfxhost
  presets: [
    { name: 'Circular/Average', params: { ref: 3000, react: 0, bass: 0, display: TUNER_DIAL } },
    { name: 'Circular/Bass', params: { ref: 3000, react: 1, bass: 1, display: TUNER_DIAL } },
    { name: 'Circular/Default', params: { ref: 3000, react: 1, bass: 0, display: TUNER_DIAL } },
    { name: 'Horizontal/Average', params: { ref: 3000, react: 0, bass: 0, display: TUNER_BASIC } },
    { name: 'Horizontal/Bass', params: { ref: 3000, react: 1, bass: 1, display: TUNER_BASIC } },
    { name: 'Horizontal/Default', params: { ref: 3000, react: 1, bass: 0, display: TUNER_BASIC } },
  ],
};
