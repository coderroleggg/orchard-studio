// Fruity Slicer 2's slicing (FL 2026 wrapper Fruity Slicer 2_x64.dylib + engine.dylib):
// what FL makes of a loaded sample and of the Slicing menu, as slice lists. The beat
// detector itself is FL's TBeatDetector (unit DSP_BeatDetection), shared with Fruity Slicer
// and Slicex and ported in ../slicer/slicing.ts (autoSlice; checked against Slicer 2's own
// results). See docs/research/gen/slicer2.md.
//
// - Loading (DecodeAudioFile 0x68020 -> engine 0x10334): the file's markers when it has
//   some (slice ends one frame before the next marker, the last at length - 1), else
//   TBeatDetector mode 1 = medium auto-slicing (AUTO 100 / 100); FL drops slices at or past
//   the end and keeps one slice at 0 when none is found; each slice ends at the next start.
// - Slicing menu (0x69180): Dull / Medium / Sharp (AUTO 33 / 100 / 167), Beat .. 1/6 beat
//   (0x28d9b0: step = (length / beats) / div in double precision, rounded to float32, at
//   least 16 frames; names "k" and "k - Beat n"), No slicing (one slice named after the
//   file); the slices go through FL's editor regions, so each ends one frame before the
//   next one (the last at length - 1).

import { autoSlice } from '../slicer/slicing';
import { defaultSlice, type Slicer2Slice } from './state';

const f32 = Math.fround;

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** FL's Dull / Medium / Sharp AUTO thresholds (wrapper table 0x367a40). */
export const SL2_AUTO = [[33, 33], [100, 100], [167, 167]] as const;

export interface Marker { pos: number; name: string }

/** Slices from start positions: each ends at the next start (`gap` 0) or one frame before (`gap` 1). */
export function slicesFrom(starts: readonly { pos: number; name?: string }[], len: number, gap: 0 | 1): Slicer2Slice[] {
  return starts.map((s, i) => {
    const next = i + 1 < starts.length ? starts[i + 1].pos : len;
    const sl = defaultSlice(s.pos, Math.max(s.pos, next - gap));
    sl.name = s.name ?? '';
    return sl;
  });
}

/** FL's slice list check (0x28dc70): no slice at or past the end; one slice at 0 when none. */
function check(pos: number[], len: number): number[] {
  const cut = pos.findIndex((p) => p >= len);
  const out = cut >= 0 ? pos.slice(0, cut) : pos;
  return out.length || len <= 0 ? out : [0];
}

/** Auto-slicing (TBeatDetector) with AUTO thresholds `low` / `high`: slice starts. */
export function autoStarts(channels: readonly Float32Array[], sampleRate: number, low: number, high: number): number[] {
  const len = channels[0]?.length ?? 0;
  return check(autoSlice(channels, sampleRate, low, high), len);
}

/** The slices FL makes when a sample is loaded. */
export function loadSlices(channels: readonly Float32Array[], sampleRate: number, markers: readonly Marker[]): Slicer2Slice[] {
  const len = channels[0]?.length ?? 0;
  if (markers.length) {
    const ms = [...markers].filter((m) => m.pos >= 0 && m.pos < len).sort((a, b) => a.pos - b.pos);
    if (ms.length) return slicesFrom(ms, len, 1);
  }
  return slicesFrom(autoStarts(channels, sampleRate, 100, 100).map((pos) => ({ pos })), len, 0);
}

/** Beat-division slice starts (0x28d9b0) for a sample of `len` frames lasting `beats` beats. */
export function beatStarts(len: number, beats: number, div: number): Marker[] {
  const out: Marker[] = [];
  if (len <= 0 || !(beats > 0) || div <= 0) return out;
  let step = f32(len / beats / div);
  if (!(step > 16)) step = 16;
  let t = 0;
  for (let k = 0; len > roundEven(t); k++) {
    out.push({ pos: roundEven(t), name: k % div === 0 ? `${k + 1} - Beat ${Math.trunc(k / div) + 1}` : `${k + 1}` });
    t = f32(t + step);
  }
  return out;
}

/**
 * The Slicing menu (FL tags): 20 / 21 / 22 Dull / Medium / Sharp, 101 / 102 / 103 / 104 / 106
 * Beat .. 1/6 beat, 0 No slicing. `file` names the single slice of "No slicing".
 */
export function menuSlices(channels: readonly Float32Array[], sampleRate: number, tag: number, beats: number, file: string): Slicer2Slice[] {
  const len = channels[0]?.length ?? 0;
  let starts: Marker[];
  if (tag >= 20 && tag <= 22) starts = autoStarts(channels, sampleRate, SL2_AUTO[tag - 20][0], SL2_AUTO[tag - 20][1]).map((pos) => ({ pos, name: '' }));
  else if (tag > 100 && tag <= 1000) starts = beatStarts(len, beats, tag - 100);
  else starts = [];
  if (!starts.length && len > 0) starts = [{ pos: 0, name: file }];
  return slicesFrom(starts.filter((s) => s.pos < len), len, 1);
}

/** FL's beats from the tempo (0x7bb30): length x tempo / (rate x 60), float32. */
export function beatsOf(len: number, rate: number, tempo: number): number {
  return rate > 0 ? f32((len * tempo) / (rate * 60)) : 0;
}

/** The tempo from the beats (TempoSelect / LengthSelect, 0x69630): beats x rate x 60 / length, float32. */
export function tempoOf(len: number, rate: number, beats: number): number {
  return len > 0 ? f32((f32(beats) * rate * 60) / len) : 0;
}

/** Beats after a tempo change (0x6d620): (length x tempo in float32) / (rate x 60). */
export function beatsAfterTempo(len: number, rate: number, tempo: number): number {
  return rate > 0 ? f32(f32(len * f32(tempo)) / (rate * 60)) : 0;
}
