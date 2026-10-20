// Keyboard Controller (FL: Fruity Keyboard Controller, Plugin database >
// Generators > Controller): an internal controller that turns the notes it
// plays into two outputs, "Note" (a value per key) and "Velocity". Form:
// SynthPanel 558 x 232; two parameters (Tags 0 and 1): the smoothing
// envelope's attack and release times (0..256, text "35ms" at 32).
// Everything else is plugin state (docs/research/gen/keyboardctrl.md): a
// value per key (0..1, FL's 132 keys), the key range the plugin answers to,
// the note off value and its switch ("Note off value" / auto release), the
// link switch of the two smoothing sliders and the editor's view.

import type { GenPluginDef } from '../types';
import type { FxPreset } from '../../fx/types';

/** FL's keys: 0..131, C5 = 60 (C0 = 0). */
export const KB_KEYS = 132;
/** The highest key an Auto map with an open range ("hi" 256) maps up to (the editor's 10 octaves). */
export const KB_AUTO_CAP = 119;
/** The Velocity output reaches 65512 / 65536 of the controller range at velocity 128 (measured). */
export const KB_VEL_SCALE = 65512 / 65536;
/** FL's range value for "no upper limit" (Full keyboard preset). */
export const KB_RANGE_OPEN = 256;

/**
 * Smoothing time in ms for a control value 0..256 (FL's text): 1000 ms x
 * (11^(v/256) - 1) / 10 (1 ms at 1, 35 ms at 32, 232 ms at 128, 1 s at 256).
 * The time is the time to settle to 1% (the per-tick factor is 0.01^(tick / time)).
 */
export function kbSmoothMs(v: number): number {
  const x = Math.min(256, Math.max(0, v));
  return (1000 * (Math.pow(11, x / 256) - 1)) / 10;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const WHITE = [true, false, true, false, true, true, false, true, false, true, false, true];

/** FL's name of a key ("C5" = 60). */
export function kbKeyName(key: number): string {
  const k = Math.min(KB_KEYS - 1, Math.max(0, Math.round(key)));
  return `${NOTE_NAMES[k % 12]}${Math.floor(k / 12)}`;
}

export const kbIsWhite = (key: number): boolean => WHITE[((key % 12) + 12) % 12];

/**
 * The editor's Auto map (and what FL's factory presets were made with): fills
 * the keys of the range lo..hi (clamped to KB_AUTO_CAP) evenly from 0 to 1,
 * keys below it 0 and above it 1. `white` maps only the white keys (the black
 * keys take the value of the white key below them). `interpolate` runs from the
 * values the range's end keys already have instead of 0 and 1. Returns a new
 * array (`values` is not changed).
 */
export function kbAutoMap(values: number[], lo: number, hi: number, white: boolean, interpolate = false): number[] {
  const out = values.slice(0, KB_KEYS);
  while (out.length < KB_KEYS) out.push(1);
  const a = Math.max(0, Math.min(KB_KEYS - 1, Math.round(lo)));
  const b = Math.max(a, Math.min(KB_AUTO_CAP, Math.round(hi)));
  const v0 = interpolate ? values[a] ?? 0 : 0;
  const v1 = interpolate ? values[b] ?? 1 : 1;
  const at = (f: number) => v0 + (v1 - v0) * f;
  if (!white) {
    for (let k = 0; k < KB_KEYS; k++) {
      if (k < a) { if (!interpolate) out[k] = 0; }
      else if (k <= a) out[k] = at(0);
      else if (k >= b) { if (k === b || !interpolate) out[k] = at(1); }
      else out[k] = at((k - a) / (b - a));
    }
    return out;
  }
  const whites: number[] = [];
  for (let k = a; k <= b; k++) if (kbIsWhite(k)) whites.push(k);
  const w = whites.length;
  const val = new Map<number, number>();
  whites.forEach((k, i) => val.set(k, at(w > 1 ? i / (w - 1) : 0)));
  for (let k = 0; k < KB_KEYS; k++) {
    if (k < a) { if (!interpolate) out[k] = 0; continue; }
    if (k > b) { if (!interpolate) out[k] = at(1); continue; }
    let j = k;
    while (j > a && !kbIsWhite(j)) j--;
    out[k] = val.get(j) ?? at(0);
  }
  return out;
}

/** The value a key sends: the stored value (keys beyond the table repeat its last value). */
export function kbValueOf(values: number[], key: number): number {
  const k = Math.max(0, Math.min(KB_KEYS - 1, Math.round(key)));
  const v = values[k];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

const smoothText = (v: number) => `${Math.round(kbSmoothMs(v))}ms`;

/** FL's plugin database state (Controller/Fruity Keyboard Controller.fst): range 48..71, white keys only, no smoothing. */
export const KB_DEFAULT_RANGE = { lo: 48, hi: 71 };

export function kbDefaultState(): Record<string, unknown> {
  return {
    attack: 0, release: 0,
    values: kbAutoMap(new Array(KB_KEYS).fill(0), KB_DEFAULT_RANGE.lo, KB_DEFAULT_RANGE.hi, true),
    lo: KB_DEFAULT_RANGE.lo, hi: KB_DEFAULT_RANGE.hi,
    noteOff: 0, autoRel: false, link: false,
    key: 60, scroll: 170,
  };
}

const preset = (name: string, lo: number, hi: number, white: boolean): FxPreset => ({
  name,
  params: {
    attack: 0, release: 0,
    values: kbAutoMap(new Array(KB_KEYS).fill(0), lo, hi, white),
    lo, hi, noteOff: 0, autoRel: false,
  },
});

const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);

export const def: GenPluginDef = {
  id: 'keyboardctrl',
  name: 'Keyboard Controller',
  category: 'Controller',
  notes: 'voices',
  noAudio: true,
  width: 558,
  height: 232,
  description: 'Turns keyboard strokes into knob tweaks (internal controller plugin)',
  params: [
    { key: 'attack', name: 'Smoothing envelope attack time', index: 0, min: 0, max: 256, def: 32, format: smoothText },
    { key: 'release', name: 'Smoothing envelope release time', index: 1, min: 0, max: 256, def: 32, format: smoothText },
  ],
  outputs: ['Note', 'Velocity'],
  // a new instance starts as FL's plugin database state (no smoothing, range 48..71, white keys mapped)
  state: kbDefaultState,
  normalize: (p) => {
    const d = kbDefaultState();
    const raw = Array.isArray(p.values) ? p.values : [];
    const values = Array.from({ length: KB_KEYS }, (_, k) => {
      const v = raw[k];
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : (d.values as number[])[k];
    });
    const no = typeof p.noteOff === 'number' && Number.isFinite(p.noteOff) ? Math.min(1, Math.max(0, p.noteOff)) : 0;
    return {
      ...p, values,
      lo: int(p.lo, 0, KB_RANGE_OPEN, 48), hi: int(p.hi, 0, KB_RANGE_OPEN, 71),
      noteOff: no, autoRel: !!p.autoRel, link: !!p.link,
      key: int(p.key, 0, KB_KEYS - 1, 60), scroll: typeof p.scroll === 'number' && Number.isFinite(p.scroll) ? p.scroll : 0,
    };
  },
  // the editor's view (current key, scroll) survives preset loads
  viewState: ['key', 'scroll', 'link'],
  // FL's factory presets (Plugin presets/Generators/Fruity Keyboard Controller, state version 0: both smoothing times 0)
  presets: [
    preset('1 octave (white + black)', 60, 71, false),
    preset('1 octave (white only)', 60, 71, true),
    preset('Default', 48, 71, true),
    preset('Full keyboard (white only)', 0, KB_RANGE_OPEN, true),
    preset('Gross Beat - white + black', 48, 83, false),
    preset('Gross Beat - white only', 48, 108, true),
    preset('To pitch knob (transposing)', 12, 108, false),
  ],
};
