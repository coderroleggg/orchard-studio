// Compiles patterns / playlist clips into sorted event lists and answers
// "which notes start in this tick window" queries for the engine.

import type { Clip, Id, Note, Pattern, PlaylistTrack } from '../model/types';

export interface SeqNote {
  pos: number; // ticks (pattern-local, swing applied)
  len: number; // ticks; zero-length (step) notes are gated for one step
  oneShot: boolean; // came from the step sequencer (zero length)
  key: number;
  vel: number;
  rel: number;
  pan: number;
  fine: number;
  modX: number;
  modY: number;
  slide: boolean;
  porta: boolean;
  color: number;
  chId: Id;
}

export interface CompiledPattern {
  id: Id;
  notes: SeqNote[]; // sorted by pos
  length: number; // ticks, whole bars, >= 1 bar
}

export interface NoteEventSink {
  (note: SeqNote, frame: number, len: number): void;
}

export interface SwingInfo {
  /** Global swing 0..1 (channel rack knob). */
  global: number;
  ticksPerStep: number;
  /** Per-channel swing multiplier (FUNC "swing mix"), default 1. */
  channelMix: (chId: Id) => number;
}

/**
 * Swing delays every second step (the even 16ths). At 100% the delayed step
 * moves by half a step. Notes that are not on a step boundary are shifted by
 * a piecewise-linear time warp of the step pair.
 */
export function swingOffset(pos: number, amount: number, ticksPerStep: number): number {
  if (amount <= 0) return 0;
  const pair = ticksPerStep * 2;
  const inPair = ((pos % pair) + pair) % pair;
  // piecewise-linear time warp of the step pair: [0, tps] -> [0, tps*(1+s)], [tps, 2tps] -> [tps*(1+s), 2tps]
  const s = amount / 2; // 100% swing = half a step
  const warpPoint = ticksPerStep * (1 + s);
  let warped: number;
  if (inPair <= ticksPerStep) warped = (inPair / ticksPerStep) * warpPoint;
  else warped = warpPoint + ((inPair - ticksPerStep) / ticksPerStep) * (pair - warpPoint);
  return warped - inPair;
}

export function compilePattern(p: Pattern, barTicks: number, swing: SwingInfo, enabledChannel: (id: Id) => boolean): CompiledPattern {
  const out: SeqNote[] = [];
  let maxEnd = 0;
  for (const chId of Object.keys(p.notes)) {
    const notes: Note[] = p.notes[chId];
    const mix = swing.channelMix(chId);
    for (const n of notes) {
      const end = n.pos + Math.max(n.len, 1);
      if (end > maxEnd) maxEnd = end;
      if (n.muted || !enabledChannel(chId)) continue;
      const sw = swing.global > 0 && mix > 0 ? swingOffset(n.pos, swing.global * mix, swing.ticksPerStep) : 0;
      out.push({
        pos: n.pos + sw + (n.shift ?? 0), len: n.len > 0 ? n.len : swing.ticksPerStep, oneShot: n.len === 0, key: n.key, vel: n.vel, rel: n.rel, pan: n.pan, fine: n.fine,
        modX: n.modX, modY: n.modY, slide: n.slide, porta: n.porta, color: n.color, chId,
      });
    }
  }
  out.sort((a, b) => a.pos - b.pos || (a.slide === b.slide ? 0 : a.slide ? 1 : -1));
  const auto = Math.max(barTicks, Math.ceil(maxEnd / barTicks - 1e-9) * barTicks);
  const length = p.lengthSteps && p.lengthSteps > 0 ? p.lengthSteps * swing.ticksPerStep : auto;
  return { id: p.id, notes: out, length };
}

const WINDOW_EPS = 1e-6; // ticks

/** First index with notes[i].pos >= t. */
function lowerBound(notes: SeqNote[], t: number): number {
  let lo = 0, hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].pos < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Emit notes of a compiled pattern whose start lies in [t0, t1) (pattern-local
 * ticks), mapping them to block frames.
 */
export function collectPatternWindow(
  cp: CompiledPattern, t0: number, t1: number, frameAtT0: number, framesPerTick: number,
  sink: NoteEventSink, lenLimit = Infinity, tickShift = 0,
): void {
  const notes = cp.notes;
  // Windows are shifted by a tiny epsilon so float drift in the running
  // position never drops an event that sits exactly on a window boundary.
  const a = t0 - WINDOW_EPS, b = t1 - WINDOW_EPS;
  for (let i = lowerBound(notes, a); i < notes.length; i++) {
    const n = notes[i];
    if (n.pos >= b) break;
    // nearest frame; may equal the block length (voice delays carry into the next block)
    const frame = Math.round(frameAtT0 + (n.pos - t0) * framesPerTick);
    sink(n, frame, Math.min(n.len, lenLimit - (n.pos + tickShift)));
  }
}

export interface CompiledClip {
  start: number;
  end: number;
  offset: number;
  patternId: Id;
  track: number;
}

export function compileClips(clips: Clip[], tracks: PlaylistTrack[]): CompiledClip[] {
  const out: CompiledClip[] = [];
  for (const c of clips) {
    if (c.muted || c.kind === 'audio') continue; // audio clips are played by AudioClips.ts
    const tr = tracks[c.track];
    if (tr && !tr.enabled) continue;
    out.push({ start: c.start, end: c.start + c.length, offset: c.offset, patternId: c.patternId, track: c.track });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Song length in ticks: end of the last clip rounded up to a whole bar (min 1 bar). */
export function songLength(clips: Clip[], barTicks: number): number {
  let end = 0;
  for (const c of clips) end = Math.max(end, c.start + c.length);
  return Math.max(barTicks, Math.ceil(end / barTicks - 1e-9) * barTicks);
}

/**
 * Emit notes of all clips that start in the song-tick window [t0, t1).
 * Note lengths are cut at the clip end.
 */
export function collectSongWindow(
  clips: CompiledClip[], patterns: Map<Id, CompiledPattern>, t0: number, t1: number,
  frameAtT0: number, framesPerTick: number, sink: NoteEventSink, repeat = false,
): void {
  if (repeat) { collectSongWindowRepeat(clips, patterns, t0, t1, frameAtT0, framesPerTick, sink); return; }
  for (const c of clips) {
    if (c.start >= t1) break;
    if (c.end <= t0) continue;
    const cp = patterns.get(c.patternId);
    if (!cp) continue;
    const a = Math.max(t0, c.start), b = Math.min(t1, c.end);
    // song tick -> pattern-local: local = song - start + offset
    const shift = c.start - c.offset;
    const l0 = a - shift, l1 = b - shift;
    // "Play truncated notes in clips": a clip that starts inside a note plays its remainder
    if (c.offset > 0 && c.start >= t0 - WINDOW_EPS && c.start < t1 - WINDOW_EPS) {
      collectSounding(cp, c.offset, frameAtT0 + (c.start - t0) * framesPerTick, sink, c.end - c.start);
    }
    collectPatternWindow(cp, l0, l1, frameAtT0 + (a - t0) * framesPerTick, framesPerTick, sink, c.end, shift);
  }
}

/** Notes (with a real length) that are sounding at pattern-local tick `at`. */
export function collectSounding(cp: CompiledPattern, at: number, frame: number, sink: NoteEventSink, maxLen = Infinity): void {
  for (const n of cp.notes) {
    if (n.pos >= at - WINDOW_EPS) break;
    if (n.oneShot || n.slide) continue;
    const end = n.pos + n.len;
    if (end > at + WINDOW_EPS) sink(n, Math.round(frame), Math.min(end - at, maxLen));
  }
}

/** Song-level: notes sounding at song tick `t` (for relocation / loop starts). */
export function collectSongSounding(
  clips: CompiledClip[], patterns: Map<Id, CompiledPattern>, t: number, frame: number, sink: NoteEventSink,
): void {
  for (const c of clips) {
    if (c.start > t) break;
    if (c.end <= t) continue;
    const cp = patterns.get(c.patternId);
    if (!cp) continue;
    collectSounding(cp, t - (c.start - c.offset), frame, sink, c.end - t);
  }
}

/** Variant where a clip longer than its pattern loops the pattern. */
function collectSongWindowRepeat(
  clips: CompiledClip[], patterns: Map<Id, CompiledPattern>, t0: number, t1: number,
  frameAtT0: number, framesPerTick: number, sink: NoteEventSink,
): void {
  for (const c of clips) {
    if (c.start >= t1) break;
    if (c.end <= t0) continue;
    const cp = patterns.get(c.patternId);
    if (!cp || cp.length <= 0) continue;
    const a = Math.max(t0, c.start), b = Math.min(t1, c.end);
    // iterate over pattern repetitions overlapping [a, b)
    const base = c.start - c.offset;
    let k = Math.floor((a - base) / cp.length);
    for (; base + k * cp.length < b; k++) {
      const repStart = base + k * cp.length;
      const ra = Math.max(a, repStart), rb = Math.min(b, repStart + cp.length);
      if (rb <= ra) continue;
      collectPatternWindow(cp, ra - repStart, rb - repStart, frameAtT0 + (ra - t0) * framesPerTick, framesPerTick, sink, c.end, repStart);
    }
  }
}
