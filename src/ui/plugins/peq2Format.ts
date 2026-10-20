// Text formatting for the Parametric EQ 2 editor: hint bar, popup menus and
// the floating value bubble.

import {
  bwOctaves, formatFreq, freqHz, orderDbPerOct, orderLabel, PEQ2_TYPE_LABELS, typeHasLevel,
  type PEQ2Band,
} from '../../model/peq2';
import { keyName } from '../../model/notes';
import { keyToHz } from '../../engine/dsp/math';

/** Typographic minus for the drawn axis labels. Hint and control texts use '-' like the
 *  rest of the app, so "Type in value..." pre-fills the sign. */
export const MINUS = '−';

export const ABOUT = 'Parametric EQ 2: 7-band parametric equalizer with spectrum analyzer';

/** Signed level: "+2.5 dB", "-3.4 dB", "+0.0 dB". */
export function fmtDb(db: number, digits = 1): string {
  if (!isFinite(db)) return '-inf dB';
  const r = Number(db.toFixed(digits));
  return `${r < 0 ? '-' : '+'}${Math.abs(r).toFixed(digits)} dB`;
}

/** The number a control's "Type in value..." prompt pre-fills for a formatted value. */
export function typedDefault(text: string): number {
  return parseFloat(text.replace(/[^0-9.+-]/g, ''));
}

/** Bandwidth knob value: "39% (2.0 oct)". */
export function fmtBw(x: number): string {
  return `${Math.round(x * 100)}% (${bwOctaves(x).toFixed(1)} oct)`;
}

/** Order with its slope: "Steep 8 (48 dB/oct)", "2 (12 dB/oct)". */
export function fmtOrder(o: number): string {
  return `${orderLabel(o)} (${orderDbPerOct(o)} dB/oct)`;
}

export function fmtFreq(x: number): string {
  return formatFreq(freqHz(x));
}

/** Token hint: "Band 3: 294 Hz, +2.5 dB, BW 39% (2.0 oct)". */
export function bandHint(b: PEQ2Band, k: number): string {
  const parts = [fmtFreq(b.freq)];
  if (typeHasLevel(b.type)) parts.push(fmtDb(b.level));
  parts.push(`BW ${fmtBw(b.bw)}`);
  if (!typeHasLevel(b.type)) parts.push(PEQ2_TYPE_LABELS[b.type]);
  let s = `Band ${k + 1}: ${parts.join(', ')}`;
  if (!b.enabled) s += ' (muted)';
  else if (b.solo) s += ' (solo)';
  return s;
}

// ---------------------------------------------------------------- key list
export interface KeyNote {
  key: number;
  name: string; // FL naming: MIDI 60 = "C5", A5 = 440 Hz
  hz: number;
}

export interface KeyOctave {
  octave: number;
  notes: KeyNote[];
}

let octaves: KeyOctave[] | null = null;

/** Equal-tempered notes (A5 = 440 Hz) inside 20 Hz .. 20 kHz, grouped by octave. */
export function keyOctaves(): KeyOctave[] {
  if (octaves) return octaves;
  const out: KeyOctave[] = [];
  for (let key = 0; key < 144; key++) {
    const hz = keyToHz(key);
    if (hz < 20 || hz > 20000) continue;
    const octave = Math.floor(key / 12);
    let o = out[out.length - 1];
    if (!o || o.octave !== octave) {
      o = { octave, notes: [] };
      out.push(o);
    }
    o.notes.push({ key, name: keyName(key), hz });
  }
  octaves = out;
  return out;
}

/** Distance between two frequencies in cents. */
export function cents(a: number, b: number): number {
  return 1200 * Math.log2(a / b);
}
