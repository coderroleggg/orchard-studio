// Fruity Slicer's "Dump beat to piano roll" (FL 0x65e30): the score FL writes into the
// channel's piano roll (FHD_AddNotesToPR, target piano roll, flags "empty first" + "use
// selection"), one note per slice, for the 15 dump modes of FL's DumpToPRMenu.
// See docs/research/gen/slicer.md.

import { sliceKey, type SlicerSlice } from './state';

const f32 = Math.fround;

/** FL's dump modes (DumpToPRMenu tags). */
export const DUMP_MODES = [
  { mode: 0, name: 'Normal', hint: 'Dump normally' },
  { mode: 1, name: 'Reverse', hint: 'Reverse slices' },
  { mode: 4, name: 'Random', hint: 'Randomize slices' },
  { mode: 5, name: 'Flatten (groove)', hint: 'Keep the groove only' },
  { mode: -1, name: '-', hint: '' },
  { mode: 10, name: 'Shift up', hint: 'Shift slices once up' },
  { mode: 11, name: 'Shift down', hint: 'Shift slices once down' },
  { mode: -1, name: '-', hint: '' },
  { mode: 2, name: 'Quantize', hint: 'Quantize times' },
  { mode: 3, name: 'Swing', hint: 'Add swing' },
  { mode: -1, name: '-', hint: '' },
  { mode: 6, name: 'Accentuate beat', hint: 'Accentuate beat-aligned slices' },
  { mode: 7, name: 'Pitch up beat', hint: 'Pitch up odd beats' },
  { mode: 8, name: 'Widen stereo', hint: 'Separate slices in the stereo field' },
  { mode: 12, name: 'Crazy', hint: 'Randomize levels' },
  { mode: -1, name: '-', hint: '' },
  { mode: 13, name: 'Stutter (half)', hint: 'Repeat slices twice' },
  { mode: 14, name: 'Stutter (fourth)', hint: 'Repeat slices four times' },
  { mode: -1, name: '-', hint: '' },
  { mode: 9, name: 'Original length', hint: "Don't stretch" },
] as const;

/** A dumped note in FL's TNoteParams terms. */
export interface DumpNote {
  /** Position and length in ticks (PPQ). */
  pos: number;
  len: number;
  /** Panning -64..64 (0 = centre). */
  pan: number;
  /** Volume 0..1 (0.78125 = velocity 100). */
  vol: number;
  /** Key. */
  note: number;
  /** Fine pitch in cents. */
  pitch: number;
}

export interface DumpInput {
  slices: readonly SlicerSlice[];
  baseKey: number;
  /** Loop length in beats (FL field 0x130). */
  beats: number;
  /** Length of the loaded sample in frames (FL field 0x170) and its rate. */
  frames: number;
  rate: number;
  /** Project PPQ and steps per beat (FL's time signature: 4 in a 16-step / 4-beat bar). */
  ppq: number;
  stepsPerBeat: number;
  /** Project tempo (BPM). */
  tempo: number;
}

/** FPC's Random(n): an integer in [0, n). */
export type RandomInt = (n: number) => number;
const defaultRandom: RandomInt = (n) => Math.floor(Math.random() * n);

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** The notes of FL's dump `mode` (0..14) for the slices, in FL's order. */
export function dumpNotes(d: DumpInput, mode: number, random: RandomInt = defaultRandom): DumpNote[] {
  const n = d.slices.length;
  if (n <= 0) return [];
  const PPQ = d.ppq;
  const scale = d.frames !== 0 ? f32(f32(f32(f32(PPQ * d.stepsPerBeat) * f32(d.beats)) / f32(d.frames)) * 0.25) : 0;
  let beat = -Math.trunc(PPQ / 8);
  const grid = Math.trunc(PPQ / 4);
  const parts = mode >= 13 ? 1 << (mode - 13 + 1) : 1;
  let total = 0;
  if (mode === 9) total = f32(f32(f32(d.frames / (d.rate * 60)) * f32(d.tempo)) * f32(PPQ));
  const conv = (pos: number) => (mode === 9 ? f32(f32(f32(pos) * total) / f32(d.frames)) : f32(f32(pos) * scale));
  const quant = (t: number) => {
    if (mode !== 2 && mode !== 3) return roundEven(t);
    const q = roundEven(f32(t / f32(grid)));
    let r = q * grid;
    if (mode === 3 && (q & 1) === 1) r += Math.trunc(grid / 3);
    return r;
  };
  const times = new Array<number>(n + 1);
  for (let i = 0; i < n; i++) {
    const s = d.slices[i];
    const t = s.time >= 0 && mode !== 9 ? f32(s.time * f32(PPQ)) : conv(s.pos);
    times[i] = quant(t);
  }
  times[n] = mode === 9 ? roundEven(total) : roundEven(f32(f32(f32(f32(d.beats) * f32(PPQ)) * f32(d.stepsPerBeat)) * 0.25));
  const out: DumpNote[] = [];
  let pan = -16;
  for (let i = 0; i < n; i++) {
    const pos = times[i];
    let len = 0x7fffffff;
    for (let j = 0; j <= n; j++) if (times[j] > pos) len = Math.min(len, times[j] - pos);
    if (len === 0x7fffffff) len = 1;
    const note: DumpNote = { pos, len, pan: 0, vol: 0.78125, note: 0, pitch: 0 };
    let idx = i;
    if (mode === 1) idx = n - 1 - i;
    else if (mode === 4) idx = random(n);
    else if (mode === 5) idx = 0;
    else if (mode === 10) idx = i - 1;
    else if (mode === 11) idx = i + 1;
    idx = (idx + n) % n;
    note.note = sliceKey(d.slices, d.baseKey, idx);
    if (mode === 6) {
      if (pos >= beat) { note.vol = 0.859375; beat += PPQ; } else note.vol = 0.7421875;
    } else if (mode === 7) {
      if (pos >= beat) {
        if (beat + PPQ > pos) note.pitch = 300;
        else beat += 2 * PPQ;
      }
    } else if (mode === 8) {
      note.pan = pan;
      pan = -pan;
    } else if (mode === 12) {
      note.pan = random(17) - 8;
      note.vol = f32((random(20) + 90) * 0.0078125);
      note.pitch = random(801) - 200;
    }
    if (parts > 1) {
      const p0 = note.pos, l0 = note.len;
      let p = p0;
      for (let k = 1; k <= parts; k++) {
        const next = p0 + Math.trunc((k * l0) / parts);
        out.push({ ...note, pos: p, len: Math.max(1, next - p) });
        p = next;
      }
    } else out.push(note);
  }
  return out;
}
