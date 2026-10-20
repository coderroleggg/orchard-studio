// Fruity Slicer 2 editor operations: loading audio (Browser drag, OS files, Load sample),
// the Slicing menu, the BPM / BEATS selectors, marker edits and the score dump to the piano
// roll, as FL's wrapper does them (docs/research/gen/slicer2.md). Every state change is one
// undo step through the store.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { uid } from '../../../../model/defaults';
import type { Note } from '../../../../model/types';
import { channelOfSlot } from '../../../../model/gen/ids';
import { getRaw, onSamplesChanged } from '../../../../audio/samples';
import { dumpNotes } from '../../../../model/gen/plugins/slicer/dump';
import {
  SL2_BLOCKS, SL2_BLOCK_RANGE, SL2_MAX, baseKeyFor, defaultSlice, sl2Key, slicer2State, type Slicer2Slice, type Slicer2State,
} from '../../../../model/gen/plugins/slicer2/state';
import { beatsAfterTempo, beatsOf, loadSlices, menuSlices, tempoOf, type Marker } from '../../../../model/gen/plugins/slicer2/slicing';

export { onSamplesChanged };

export interface Audio { channels: Float32Array[]; sampleRate: number }

/** The loaded audio of a state (pool sample), if available. */
export function audioOf(s: Slicer2State): Audio | null {
  if (!s.sample) return null;
  const r = getRaw(s.sample);
  return r && r.channels.length && r.channels[0].length ? { channels: r.channels, sampleRate: r.sampleRate } : null;
}

type Draft = Record<string, unknown>;

function current(slotId: string): Slicer2State {
  return slicer2State(A.findFx(store.project, slotId)?.fx.params ?? {});
}

function edit(slotId: string, label: string, fn: (d: Draft) => void, merge?: string): void {
  A.editFx(slotId, label, (d) => fn(d as Draft), merge);
}

/** One undo step for an edit and the auto-dump that follows it. */
function step(label: string, fn: () => void): void {
  if (store.inGesture) { fn(); return; }
  store.beginGesture(label);
  try { fn(); } finally { store.endGesture(); }
}

/** The base key FL sets with a new slice list (wrapper 0x699f0). */
function withSlices(d: Draft, slices: Slicer2Slice[]): void {
  d.slices = slices;
  d.baseKey = baseKeyFor(slices.length);
  const chrom = d.chromatic as number;
  if (chrom >= slices.length) d.chromatic = -1;
  d.sel = [0];
  d.bank = 0;
}

/**
 * Load audio (FL's FPD_LoadFile / Load sample: DecodeAudioFile, then the engine): the file's
 * markers or medium auto-slicing, tempo from the file (else 120 BPM), beats from the tempo,
 * the slice keys from C5 (an octave lower per 12 slices past key 124), then the auto-dump.
 */
export function loadAudio(slotId: string, sampleId: string, file: string, a: Audio, meta: { markers: Marker[]; tempo: number }): void {
  const len = a.channels[0].length;
  const slices = loadSlices(a.channels, a.sampleRate, meta.markers);
  const tempo = Math.fround(meta.tempo > 0 ? meta.tempo : 120);
  const beats = beatsOf(len, a.sampleRate, tempo);
  step('Load sample', () => {
    edit(slotId, 'Load sample', (d) => {
      d.sample = sampleId;
      d.file = file;
      d.tempo = tempo;
      d.beats = beats;
      d.markers = meta.markers.map((m) => ({ pos: m.pos, name: m.name }));
      withSlices(d, slices);
    });
    autoDump(slotId);
  });
}

/** The Slicing menu (FL tags; 1 = "Use sample built-in slicing": the load slicing again). */
export function reslice(slotId: string, tag: number): void {
  const s = current(slotId);
  const a = audioOf(s);
  if (!a) return;
  const slices = tag === 1 ? loadSlices(a.channels, a.sampleRate, s.markers) : menuSlices(a.channels, a.sampleRate, tag, s.beats, s.file.replace(/\.[^.]*$/, ''));
  step('Slicing', () => {
    edit(slotId, 'Slicing', (d) => withSlices(d, slices));
    autoDump(slotId);
  });
}

/** BPM (TempoSelect) / BEATS (LengthSelect) changes (0x6d620 / 0x69680), then the auto-dump. */
export function setTiming(slotId: string, what: 'tempo' | 'beats', v: number, finish: boolean): void {
  const s = current(slotId);
  const a = audioOf(s);
  const len = a ? a.channels[0].length : 0, rate = a?.sampleRate ?? 44100;
  let tempo: number;
  if (what === 'tempo') tempo = Math.fround(v);
  else tempo = len > 0 ? tempoOf(len, rate, v) : s.tempo;
  const beats = len > 0 ? beatsAfterTempo(len, rate, tempo) : s.beats;
  edit(slotId, what === 'tempo' ? 'Original sample tempo' : 'Original sample length', (d) => { d.tempo = tempo; d.beats = beats; }, 'slicer2-timing');
  if (finish && current(slotId).autoDump) dumpToPianoRoll(slotId, 0);
}

/** The dump (FL 0x6c720): one note per slice into the channel's piano roll (current pattern, emptied first). */
export function dumpToPianoRoll(slotId: string, mode: number): void {
  const s = current(slotId);
  const a = audioOf(s);
  const chId = channelOfSlot(slotId);
  const p = store.project;
  if (!chId || !s.slices.length) return;
  const frames = a ? a.channels[0].length : 0;
  const notes = dumpNotes({
    slices: s.slices.map((sl) => ({ pos: sl.start, key: sl.key, name: sl.name, time: -1, rev: false })),
    baseKey: s.baseKey, beats: s.beats, frames, rate: a?.sampleRate ?? 44100, ppq: p.ppq, stepsPerBeat: p.stepsPerBeat, tempo: p.tempo,
  }, mode);
  const out: Note[] = notes.map((n) => ({
    id: uid('n'), key: n.note, pos: n.pos, len: n.len, vel: Math.max(0, Math.min(128, Math.round(n.vol * 128))), rel: 64,
    pan: Math.max(0, Math.min(128, 64 + n.pan)), fine: Math.max(0, Math.min(240, 120 + Math.round(n.pitch / 10))),
    modX: 128, modY: 128, color: 0, slide: false, porta: false, muted: false,
  }));
  A.setChannelNotes(p.currentPatternId, chId, out, 'Dump score to piano roll');
}

// ------------------------------------------------------------------ slice edits
/** Move slice i's start (its predecessor's end follows, FL's region drag). */
export function moveStart(slotId: string, i: number, pos: number, merge: string): void {
  const s = current(slotId);
  const a = audioOf(s);
  const len = a ? a.channels[0].length : 0;
  if (i < 0 || i >= s.slices.length) return;
  const lo = i > 0 ? s.slices[i - 1].start + 1 : 0;
  const hi = i + 1 < s.slices.length ? s.slices[i + 1].start - 1 : len - 1;
  const p = Math.max(lo, Math.min(hi, Math.round(pos)));
  edit(slotId, 'Move marker', (d) => {
    const sl = (d.slices as Slicer2Slice[]);
    const gap = i > 0 && sl[i - 1].end < sl[i].start ? 1 : 0;
    sl[i].start = p;
    if (i > 0) sl[i - 1].end = Math.max(sl[i - 1].start, p - gap);
  }, merge);
}

/** Add a marker (Ctrl+click): splits the slice containing `pos`; later slices' settings move up. */
export function addMarker(slotId: string, pos: number): void {
  const s = current(slotId);
  const a = audioOf(s);
  if (!a || s.slices.length >= SL2_MAX) return;
  const len = a.channels[0].length;
  const p = Math.max(0, Math.min(len - 1, Math.round(pos)));
  let i = s.slices.findIndex((sl) => sl.start > p);
  if (i < 0) i = s.slices.length;
  if (s.slices.some((sl) => sl.start === p)) return;
  step('Add marker', () => {
    edit(slotId, 'Add marker', (d) => {
      const sl = [...(d.slices as Slicer2Slice[])];
      const next = i < sl.length ? sl[i].start : len;
      const ns = defaultSlice(p, Math.max(p, next - 1));
      if (i > 0) sl[i - 1] = { ...sl[i - 1], end: Math.max(sl[i - 1].start, p - 1) };
      sl.splice(i, 0, ns);
      shiftParams(d, i, 1, s.slices.length);
      withSlices(d, sl);
    });
    autoDump(slotId);
  });
}

/** Delete slice i (its predecessor takes its range); later slices' settings move down. */
export function deleteSlice(slotId: string, i: number): void {
  const s = current(slotId);
  if (i < 0 || i >= s.slices.length || s.slices.length <= 1) return;
  step('Delete marker', () => {
    edit(slotId, 'Delete marker', (d) => {
      const sl = [...(d.slices as Slicer2Slice[])];
      if (i > 0) sl[i - 1] = { ...sl[i - 1], end: sl[i].end };
      sl.splice(i, 1);
      shiftParams(d, i, -1, s.slices.length);
      withSlices(d, sl);
    });
    autoDump(slotId);
  });
}

/** FL dumps again after every slice change when Auto-Dump is on (wrapper 0x696d0). */
export function autoDump(slotId: string): void {
  if (current(slotId).autoDump) dumpToPianoRoll(slotId, 0);
}

/** Shift the per-slice parameters from index `from` by `by` (insert / delete). */
function shiftParams(d: Draft, from: number, by: number, n: number): void {
  for (const b of SL2_BLOCKS) {
    const def = SL2_BLOCK_RANGE[b][2];
    if (by > 0) {
      for (let k = Math.min(SL2_MAX - 1, n); k > from; k--) d[sl2Key(b, k)] = d[sl2Key(b, k - 1)];
      d[sl2Key(b, from)] = def;
    } else {
      for (let k = from; k < SL2_MAX - 1; k++) d[sl2Key(b, k)] = d[sl2Key(b, k + 1)];
      d[sl2Key(b, SL2_MAX - 1)] = def;
    }
  }
}

/** Set fields of the selected slices (FL applies most controls to every selected pad). */
export function setSliceField(slotId: string, sel: number[], label: string, fn: (s: Slicer2Slice) => void): void {
  edit(slotId, label, (d) => {
    const sl = d.slices as Slicer2Slice[];
    for (const i of sel) if (sl[i]) fn(sl[i]);
  });
}

/** Reset the per-slice settings of the selected slices (pad menu "Reset all"). */
export function resetSlices(slotId: string, sel: number[]): void {
  edit(slotId, 'Reset all', (d) => {
    const sl = d.slices as Slicer2Slice[];
    for (const i of sel) {
      for (const b of SL2_BLOCKS) d[sl2Key(b, i)] = SL2_BLOCK_RANGE[b][2];
      if (sl[i]) { sl[i].mode = 0; sl[i].ftype = 0; }
    }
  });
}
