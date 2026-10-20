// Fruity Slicer's editor operations (main thread): loading audio (FL's 0x63810 load flow:
// slicing, beats / tempo, slice check, AUTO-FIT, AUTO-DUMP), re-slicing from the Slicing
// menu and the AUTO wheels, BPM / BEATS edits, the dump into the channel's piano roll and
// the processed sample for the displays. See docs/research/gen/slicer.md.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { uid } from '../../../../model/defaults';
import type { Note } from '../../../../model/types';
import { channelOfSlot } from '../../../../model/gen/ids';
import { getRaw, onSamplesChanged } from '../../../../audio/samples';
import {
  baseKeyFor, beatsOf, loopTiming, newSlice, slicerState, tempoOf, type SlicerSlice, type SlicerState,
} from '../../../../model/gen/plugins/slicer/state';
import { AUTO_PRESETS, autoSlice, beatSlices, zeroCross } from '../../../../model/gen/plugins/slicer/slicing';
import { dumpNotes } from '../../../../model/gen/plugins/slicer/dump';
import { processSlices, sliceLayout, tsForRatio, type Processed } from '../../../../engine/gen/plugins/slicer/process';
import { elastique } from '../../../../engine/gen/plugins/slicer/elastique';
import { processKey } from '../../../../engine/gen/plugins/slicer';

export interface Audio { channels: Float32Array[]; sampleRate: number }

/** The loaded audio of a state (pool sample), if available. */
export function audioOf(s: SlicerState): Audio | null {
  if (!s.sample) return null;
  const r = getRaw(s.sample);
  return r && r.channels.length ? { channels: r.channels, sampleRate: r.sampleRate } : null;
}

// ------------------------------------------------------------------ processed sample (display)
const procCache = new Map<string, Processed>();
/** The processed sample (FL's TWAVSample after processing) for the editor displays. */
export function processedOf(s: SlicerState): Processed | null {
  const a = audioOf(s);
  if (!a) return null;
  const key = processKey(s);
  let p = procCache.get(key);
  if (!p) {
    p = processSlices(a, s.slices, s, elastique);
    procCache.set(key, p);
    if (procCache.size > 6) procCache.delete(procCache.keys().next().value as string);
  }
  return p;
}
export { onSamplesChanged };

// ------------------------------------------------------------------ slicing
/** FL's slice check (0x64570): slices past the end dropped, one slice when none, base key. */
function checked(slices: SlicerSlice[], frames: number): { slices: SlicerSlice[]; baseKey: number } {
  const lay = sliceLayout(frames, slices.map((s) => s.pos));
  const out = lay.map((l, i) => slices[i] ?? newSlice(l.pos));
  return { slices: out, baseKey: baseKeyFor(out.length) };
}

/** Slicing modes (FL 0x63810): -1 / 1 file slices or Medium, 2 none, 20..22 Dull / Medium / Sharp, 101..106 beats. */
export function sliceAudio(a: Audio, mode: number, s: SlicerState, regions: number[] = []): { slices: SlicerSlice[]; autoLow?: number; autoHigh?: number } {
  const frames = a.channels[0].length;
  if (mode === 2) return { slices: [newSlice(0)] };
  if (mode >= 101 && mode <= 106) return { slices: beatSlices(frames, s.beats, mode - 100).map((b) => newSlice(b.pos, b.name)) };
  if ((mode === -1 || mode === 1) && regions.length) return { slices: regions.map((p) => newSlice(p)) };
  const preset = mode >= 20 && mode <= 22 ? AUTO_PRESETS[mode - 20] : mode === -1 || mode === 1 ? AUTO_PRESETS[1] : [s.autoLow, s.autoHigh];
  return { slices: autoSlice(a.channels, a.sampleRate, preset[0], preset[1]).map((p) => newSlice(p)), autoLow: preset[0], autoHigh: preset[1] };
}

// ------------------------------------------------------------------ dump
/** Write FL's dump of `mode` into the channel's notes of the current pattern (FL: NPF_EmptyFirst). */
export function dumpToPianoRoll(slotId: string, s: SlicerState, mode: number): void {
  const a = audioOf(s);
  const chId = channelOfSlot(slotId);
  const p = store.project;
  if (!chId || !s.slices.length) return;
  const frames = a ? a.channels[0].length : 0;
  const notes = dumpNotes({
    slices: s.slices, baseKey: s.baseKey, beats: s.beats, frames, rate: a?.sampleRate ?? s.rate,
    ppq: p.ppq, stepsPerBeat: p.stepsPerBeat, tempo: p.tempo,
  }, mode);
  const out: Note[] = notes.map((n) => ({
    id: uid('n'), key: n.note, pos: n.pos, len: n.len, vel: Math.max(0, Math.min(128, Math.round(n.vol * 128))), rel: 64,
    pan: Math.max(0, Math.min(128, 64 + n.pan)), fine: Math.max(0, Math.min(240, 120 + Math.round(n.pitch / 10))),
    modX: 128, modY: 128, color: 0, slide: false, porta: false, muted: false,
  }));
  A.setChannelNotes(p.currentPatternId, chId, out, 'Dump beat to piano roll');
}

// ------------------------------------------------------------------ AUTO-FIT
/** FL 0x65a40: TS fitting the loop to the project tempo (clamped >= 0 when `noShrink`). */
export function fitTs(s: SlicerState, frames: number, rate: number, noShrink: boolean): number {
  const loopTempo = tempoOf(s.beats, frames, rate);
  const ratio = Math.fround(loopTempo / Math.fround(store.project.tempo));
  let ts = Math.round(tsForRatio(ratio));
  if (!Number.isFinite(ts)) ts = 0;
  ts = Math.max(-20000, Math.min(20000, ts));
  return noShrink ? Math.max(0, ts) : ts;
}

// ------------------------------------------------------------------ edits
type Draft = Record<string, unknown>;

/** Apply a state change through the store (one undo step). */
function edit(slotId: string, label: string, fn: (d: Draft, s: SlicerState) => void): void {
  A.editFx(slotId, label, (d) => fn(d as Draft, slicerState(d)));
}

function current(slotId: string): SlicerState {
  return slicerState(A.findFx(store.project, slotId)?.fx.params);
}

/**
 * Load audio into the slicer (FL's file drop / Load sample: 0x63810 mode -1, options 7): the
 * file's slices or Medium auto-slicing, beats / tempo from the file's tempo, the slice check,
 * AUTO-FIT, then AUTO-DUMP (mode 9 for .speech files).
 */
export function loadAudio(slotId: string, sampleId: string, file: string, a: Audio, fileTempo = 0, regions: number[] = []): void {
  const s0 = current(slotId);
  const frames = a.channels[0].length;
  const t = loopTiming(frames, a.sampleRate, fileTempo);
  const res = sliceAudio(a, -1, { ...s0, beats: t.beats }, regions);
  const c = checked(res.slices, frames);
  let next: SlicerState = { ...s0, sample: sampleId, file, rate: a.sampleRate, slices: c.slices, baseKey: c.baseKey, beats: t.beats, tempo: t.tempo, sel: 0 };
  if (res.autoLow !== undefined) next = { ...next, autoLow: res.autoLow, autoHigh: res.autoHigh ?? next.autoHigh };
  if (next.autoFit) next = { ...next, ts: fitTs(next, frames, a.sampleRate, true) };
  edit(slotId, 'Load sample', (d) => { Object.assign(d, next); });
  if (next.autoDump) dumpToPianoRoll(slotId, next, /\.speech$/i.test(file) ? 9 : 0);
}

/** Re-slice from the Slicing menu (FL SensRoughMenuClick: 0x63810 with the menu tag, options 6). */
export function reslice(slotId: string, mode: number): void {
  const s = current(slotId);
  const a = audioOf(s);
  if (!a) return;
  const frames = a.channels[0].length;
  const res = sliceAudio(a, mode, s);
  const c = checked(res.slices, frames);
  let next: SlicerState = { ...s, slices: c.slices, baseKey: c.baseKey, sel: 0 };
  if (res.autoLow !== undefined && mode >= 20) next = { ...next, autoLow: res.autoLow, autoHigh: res.autoHigh ?? next.autoHigh };
  if (next.autoFit) next = { ...next, ts: fitTs(next, frames, a.sampleRate, true) };
  edit(slotId, 'Slicing', (d) => { Object.assign(d, next); });
  if (next.autoDump) dumpToPianoRoll(slotId, next, 0);
}

/** AUTO LOW / HIGH changed (FL: auto-slicing with the wheels, AUTO-DUMP on release). */
export function autoReslice(slotId: string, low: number, high: number, dump: boolean): void {
  const s = current(slotId);
  const a = audioOf(s);
  if (!a) return;
  const frames = a.channels[0].length;
  const c = checked(autoSlice(a.channels, a.sampleRate, low, high).map((p) => newSlice(p)), frames);
  const next: SlicerState = { ...s, slices: c.slices, baseKey: c.baseKey, autoLow: low, autoHigh: high, sel: Math.min(s.sel, c.slices.length - 1) };
  A.editFx(slotId, 'Auto-slicing', (d) => { Object.assign(d, next); }, 'slicer-auto');
  if (dump && next.autoDump) dumpToPianoRoll(slotId, next, 0);
}

/** "Zero-cross check slices" (FL: slice points moved to their nearest zero crossing, +-50 ms). */
export function zeroCrossSlices(slotId: string): void {
  const s = current(slotId);
  const a = audioOf(s);
  if (!a) return;
  edit(slotId, 'Zero-cross check slices', (d) => {
    d.slices = s.slices.map((sl) => ({ ...sl, pos: zeroCross(a.channels, a.sampleRate, sl.pos) }));
  });
}

/** BPM / BEATS edits (FL TempoSelectChange / LengthSelectChange), then AUTO-FIT and AUTO-DUMP. */
export function setTiming(slotId: string, what: 'tempo' | 'beats', v: number, finish: boolean): void {
  const s = current(slotId);
  const a = audioOf(s);
  const frames = a ? a.channels[0].length : 0, rate = a?.sampleRate ?? s.rate;
  let next: SlicerState = what === 'tempo'
    ? { ...s, tempo: Math.fround(v), beats: beatsOf(v, frames, rate) }
    : { ...s, beats: Math.fround(v), tempo: tempoOf(v, frames, rate) };
  if (finish && next.autoFit && a) next = { ...next, ts: fitTs(next, frames, rate, true) };
  A.editFx(slotId, what === 'tempo' ? 'Original sample tempo' : 'Original sample length', (d) => { Object.assign(d, next); }, 'slicer-timing');
  if (finish && next.autoDump) dumpToPianoRoll(slotId, next, 0);
}

/** TS wheel menu "Autodetect" (FL FGAutoMenuClick: adapt to the current tempo). */
export function autodetectTs(slotId: string): void {
  const s = current(slotId);
  const a = audioOf(s);
  if (!a) return;
  const ts = fitTs(s, a.channels[0].length, a.sampleRate, false);
  edit(slotId, 'Fit (stretch slices) length', (d) => { d.ts = ts; });
}

/** Remove the selected slice (FL "Remove slice"); the first slice stays. */
export function removeSlice(slotId: string, i: number): void {
  const s = current(slotId);
  if (s.slices.length <= 1 || i <= 0 || i >= s.slices.length) return;
  edit(slotId, 'Remove slice', (d) => {
    const sl = s.slices.filter((_, k) => k !== i);
    d.slices = sl;
    d.baseKey = baseKeyFor(sl.length);
    d.sel = Math.max(0, i - 1);
  });
}

/** Split the slice at a frame (FL "Split slice": a new slice there). */
export function splitSlice(slotId: string, pos: number): void {
  const s = current(slotId);
  const a = audioOf(s);
  if (!a || pos <= 0 || pos >= a.channels[0].length || s.slices.some((x) => x.pos === pos)) return;
  edit(slotId, 'Split slice', (d) => {
    const sl = [...s.slices, newSlice(Math.round(pos))].sort((x, y) => x.pos - y.pos);
    d.slices = sl;
    d.baseKey = baseKeyFor(sl.length);
    d.sel = sl.findIndex((x) => x.pos === Math.round(pos));
  });
}

// ------------------------------------------------------------------ files
/** FL's sample tempo from a WAV file: the 'acid' chunk's tempo (else 0), and cue points as slices. */
export function wavInfo(buf: ArrayBuffer): { tempo: number; regions: number[] } {
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  let tempo = 0;
  const regions: number[] = [];
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { tempo, regions };
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = tag(o), n = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'acid' && n >= 24 && body + 24 <= buf.byteLength) tempo = dv.getFloat32(body + 20, true);
    else if (id === 'cue ' && n >= 4 && body + 4 <= buf.byteLength) {
      const cnt = dv.getUint32(body, true);
      for (let k = 0; k < cnt && body + 4 + (k + 1) * 24 <= buf.byteLength; k++) regions.push(dv.getUint32(body + 4 + k * 24 + 20, true));
    }
    o = body + n + (n & 1);
  }
  regions.sort((x, y) => x - y);
  return { tempo: Number.isFinite(tempo) ? tempo : 0, regions: [...new Set(regions)] };
}
