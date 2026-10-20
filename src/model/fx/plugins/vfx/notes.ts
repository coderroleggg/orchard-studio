// VFX (voice effect) note events: what FL's VFX plugins receive from the
// piano roll inside Patcher and pass on to the next module. Note properties
// use the project's piano-roll ranges (src/model/types.ts Note):
// key 0..131 (60 = C5), pos / len in ticks, vel and rel 0..128, pan 0..128
// (64 = centre), fine 0..240 (120 = centre), modX / modY 0..255 (128 =
// centre), colour group 0..15.
//
// Each plugin's `processNotes(notes, params, ctx)` is a pure function of a
// note list. Patcher plays it live on the notes reaching a VFX module
// (src/engine/effects/plugins/patcher.ts, LiveVfx): each note when it starts
// (the Sequencer: the held chord together), with `ctx.state` keeping a
// module's counters (Key Mapper's cycle positions) from note to note.

export type VfxProp = 'vel' | 'pitch' | 'pan' | 'modX' | 'modY' | 'rel' | 'fine';

export interface VfxNote {
  key: number;
  pos: number;
  len: number;
  vel: number;
  rel: number;
  pan: number;
  fine: number;
  modX: number;
  modY: number;
  color: number;
  slide?: boolean;
  /** Output voice port (0-based) for plugins with several voice outputs. */
  port?: number;
  /** Gain compensation for chords (Key Mapper "All (gain-compensated)"), 1 = none. */
  gain?: number;
  /**
   * Property changes during the note (VFX Envelope / Key Mapper slides):
   * [ticks from the note start, value] in the property's own units
   * (pitch: semitone offset from the key).
   */
  mod?: Partial<Record<VfxProp, [number, number][]>>;
}

export interface VfxContext {
  /** Ticks per quarter note. */
  ppq: number;
  /** Tempo (BPM). */
  tempo: number;
  /** Random source 0..1 (deterministic in tests). */
  random: () => number;
  /** Steps per bar etc. are derived from ppq: one bar = 4 * ppq (4/4). */
  beatsPerBar?: number;
  /** Persistent per-module state for live processing (Patcher): counters that carry over from call to call. */
  state?: Record<string, unknown>;
}

export function note(p: Partial<VfxNote> & { key: number }): VfxNote {
  return { pos: 0, len: 96, vel: 100, rel: 64, pan: 64, fine: 120, modX: 128, modY: 128, color: 0, ...p };
}

/** Small deterministic PRNG (mulberry32) for tests and humanizers. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function vfxContext(over: Partial<VfxContext> = {}): VfxContext {
  return { ppq: 96, tempo: 120, random: seeded(1), ...over };
}

export const clampKey = (k: number): number => Math.max(0, Math.min(131, Math.round(k)));
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** FL's octave numbering (C5 = 60) note name: "C5", "F#3". */
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function keyText(k: number): string {
  return NAMES[((k % 12) + 12) % 12] + Math.floor(k / 12);
}
