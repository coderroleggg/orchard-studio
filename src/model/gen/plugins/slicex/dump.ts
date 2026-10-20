// Slicex's "Dump score to piano roll" (FL 0x7dbe0, also run after loading / editing deck A while
// "Dump deck A to piano roll after editing" is on): one note per region, sent with
// FHD_AddNotesToPR (target piano roll, flags 3 = empty first + use selection, the plugin's channel,
// the current pattern). The 20 entries of FL's dump menu are its tags (table 0x3acc10, separators
// included): the same algorithm family as Fruity Slicer's dump with Slicex's own numbering, double
// precision time scale, regions starting at the same time dumped once, deck B's notes in colour 1.

import { sxRegionKey } from './state';
import type { SxDeck } from './types';

const f32 = Math.fround;

/** FL's dump menu: tag (= position, -1 for separators), caption, hint. */
export const SX_DUMP_MODES: readonly { mode: number; name: string; hint: string }[] = [
  { mode: 0, name: 'Normal', hint: 'Dump normally' },
  { mode: 1, name: 'Reverse', hint: 'Reverse slices' },
  { mode: 2, name: 'Flatten (groove)', hint: 'Keep the groove only' },
  { mode: 3, name: 'Random', hint: 'Randomize slices' },
  { mode: -1, name: '-', hint: '' },
  { mode: 5, name: 'Shift up', hint: 'Shift slices once up' },
  { mode: 6, name: 'Shift down', hint: 'Shift slices once down' },
  { mode: -1, name: '-', hint: '' },
  { mode: 8, name: 'Quantize', hint: 'Quantize times' },
  { mode: 9, name: 'Swing', hint: 'Add swing' },
  { mode: -1, name: '-', hint: '' },
  { mode: 11, name: 'Accentuate beat', hint: 'Accentuate beat-aligned slices' },
  { mode: 12, name: 'Pitch up beat', hint: 'Pitch up odd beats' },
  { mode: 13, name: 'Widen stereo', hint: 'Separate slices in the stereo field' },
  { mode: 14, name: 'Crazy', hint: 'Randomize levels' },
  { mode: -1, name: '-', hint: '' },
  { mode: 16, name: 'Stutter (half)', hint: 'Repeat slices twice' },
  { mode: 17, name: 'Stutter (fourth)', hint: 'Repeat slices four times' },
  { mode: -1, name: '-', hint: '' },
  { mode: 19, name: 'Original length', hint: "Don't stretch" },
];

/** A dumped note (FL's TNoteParams). */
export interface SxDumpNote {
  /** Position and length in ticks of the project PPQ. */
  pos: number;
  len: number;
  /** Panning -64..64. */
  pan: number;
  /** Volume 0..1 (FL: 0.78125 = velocity 100) and the velocity it stands for (vol x 128). */
  vol: number;
  vel: number;
  key: number;
  /** Note colour (deck B: 1). */
  color: number;
  /** Fine pitch in cents. */
  pitch: number;
}

export interface SxDumpContext {
  /** Project PPQ, steps per beat and tempo (BPM). */
  ppq: number;
  stepsPerBeat: number;
  tempo: number;
  /** The deck's sample length (frames) and rate. */
  frames: number;
  sampleRate: number;
}

/** FPC's Random(n): an integer in [0, n). */
export type SxRandom = (n: number) => number;
const defaultRandom: SxRandom = (n) => Math.floor(Math.random() * n);

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * The notes of FL's dump `mode` (SX_DUMP_MODES tags) for a deck, in FL's order. Region times
 * scale by the deck's loop length in beats when its tempo is known (else, and in "Original
 * length", by real time at the project tempo).
 */
export function sxDumpScore(deck: SxDeck, mode: number, c: SxDumpContext, deckIndex = 0, random: SxRandom = defaultRandom): SxDumpNote[] {
  const n = deck.regions.length;
  const frames = Math.trunc(c.frames);
  if (frames <= 0 || n <= 0) return [];
  const PPQ = Math.trunc(c.ppq), spb = Math.trunc(c.stepsPerBeat), rate = c.sampleRate;
  let pan = -16;
  let beat = -Math.trunc(PPQ / 8);
  const grid = Math.trunc(PPQ / 4);
  const parts = mode - 16 >= 0 && mode - 16 < 2 ? 1 << (mode - 16 + 1) : 1;
  const orig = mode === 19 || !(deck.tempo > 0);
  let scale: number, end: number;
  if (orig) {
    const total = ((frames / (rate * 60)) * f32(c.tempo)) * PPQ;
    scale = total / frames;
    end = roundEven(total);
  } else {
    const beats = (frames * deck.tempo) / (rate * 60);
    scale = (((PPQ * spb) * beats) / frames) * 0.25;
    end = roundEven(((beats * PPQ) * spb) * 0.25);
  }
  const quant = (t: number): number => {
    if (mode !== 8 && mode !== 9) return roundEven(t);
    const q = roundEven(f32(t / f32(grid))) | 0;
    let r = Math.imul(q, grid);
    if (mode === 9 && (q & 1) === 1) r += Math.trunc(grid / 3);
    return r;
  };
  const times = new Array<number>(n + 1);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const t = f32(deck.regions[i].s * scale);
    times[i] = t === prev ? -1 : quant(t);
    prev = t;
  }
  times[n] = end;
  const out: SxDumpNote[] = [];
  for (let i = 0; i < n; i++) {
    const pos = times[i];
    if (pos < 0) continue;
    let len = 0x7fffffff;
    for (let j = 0; j <= n; j++) if (times[j] > pos && len > times[j] - pos) len = times[j] - pos;
    if (len === 0x7fffffff) len = 1;
    let idx: number;
    switch (mode) {
      case 1: idx = n - 1 - i; break;
      case 2: idx = 0; break;
      case 3: idx = random(n); break;
      case 5: idx = i - 1; break;
      case 6: idx = i + 1; break;
      default: idx = i;
    }
    idx = (n + idx) % n;
    const note: SxDumpNote = { pos, len, pan: 0, vol: 0.78125, vel: 100, key: sxRegionKey(deck, idx), color: 0, pitch: 0 };
    if (mode === 11) {
      if (pos >= beat) { note.vol = 0.859375; beat += PPQ; } else note.vol = 0.7421875;
    } else if (mode === 12) {
      if (pos >= beat) {
        if (beat + PPQ > pos) note.pitch = 300;
        else beat += 2 * PPQ;
      }
    } else if (mode === 13) {
      note.pan = pan;
      pan = -pan;
    } else if (mode === 14) {
      note.pan = random(17) - 8;
      note.vol = f32((random(20) + 90) * 0.0078125);
      note.pitch = random(801) - 200;
    }
    note.vel = note.vol * 128;
    // FL writes the deck as colour into the first part only; the stutter copies keep colour 0
    const p0 = note.pos, l0 = note.len;
    let p = p0;
    for (let k = 1; k <= parts; k++) {
      const next = p0 + Math.trunc((k * l0) / parts);
      out.push({ ...note, pos: p, len: parts > 1 ? Math.max(1, next - p) : l0, color: k === 1 ? deckIndex : 0 });
      p = next;
    }
  }
  return out;
}
