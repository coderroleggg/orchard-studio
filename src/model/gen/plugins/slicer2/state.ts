// Fruity Slicer 2's plugin state as JSON, the parameter keys and the slice / key
// logic shared by the definition, the engine and the editor. FL keeps the state in
// its engine (engine.dylib, "slc1" stream version 4, see docs/research/gen/slicer2.md):
// per instance the global settings, the sample reference and up to 128 slice records
// (name, key, start, end, gain, pan, transpose, detune, play mode, filter type,
// cutoff, res, attack, release and envelope fields the editor does not show).
// Here the eight automatable per-slice values (and the five global ones) are FL
// parameters (indices 0..1039, control units of FL's editor); the rest is state.

const f32 = Math.fround;

/** Most slices FL keeps (engine: 128 records; the editor and the keys use the first 128). */
export const SL2_MAX = 128;

/** A slice (FL's engine slice record). */
export interface Slicer2Slice {
  /** First frame and the frame after the last one (frames of the loaded sample). */
  start: number;
  end: number;
  /** Trigger key, -1 = base key + slice index (FL's default). */
  key: number;
  /** Marker name ('' = FL shows the slice number). */
  name: string;
  /** Play options: bit 0 Hold, bit 1 Play to end, bit 2 Reverse (FL's record +0x18). */
  mode: number;
  /** Slice filter type: 0 Off, 1 LP12, 2 HP12, 3 BP12 (record +0x38). */
  ftype: number;
  /** Record fields FL's editor does not show (kept for states that set them): end fade (s),
   * envelope hold, decay and sustain (normalised). */
  fade: number;
  hold: number;
  decay: number;
  sustain: number;
}

/** The state keys besides FL's parameters. */
export interface Slicer2State {
  /** Pool sample id of the loaded audio ('' = none). */
  sample: string;
  /** The loaded file's name (FL keeps the file path). */
  file: string;
  slices: Slicer2Slice[];
  /** Time stretching mode: 0 None, 1 Resample, 2 Stretch (engine S+0x10). */
  stretch: number;
  /** Global filter type 0 Off, 1 LP12, 2 HP12, 3 BP12 (engine S+0x1c). */
  gftype: number;
  /** Original sample tempo (BPM, float32; FL: the file's tempo, 120 when it has none). */
  tempo: number;
  /** Original sample length in beats (FL's wrapper, float32). */
  beats: number;
  /** Chromatic slice (-1 = none): the one slice every key plays transposed. */
  chromatic: number;
  /** Key of the first slice: 60, an octave lower per 12 slices past key 124. */
  baseKey: number;
  /** Auto-dump the score to the piano roll after loading (FL's DumpMenu "Auto-Dump"). */
  autoDump: boolean;
  /** The loaded file's own markers (frames, names), for "Use sample built-in slicing". */
  markers: { pos: number; name: string }[];
  /** Editor: selected slices (the first is the edited one), pad bank, filter target (slice / global). */
  sel: number[];
  bank: number;
  filterSlice: boolean;
}

/** Default record values (FL's slice record constructor, engine 0xd1cc). */
export function defaultSlice(start = 0, end = 0): Slicer2Slice {
  return { start, end, key: -1, name: '', mode: 0, ftype: 0, fade: 0, hold: 0, decay: 0.5, sustain: 1 };
}

export function defaultSlicer2State(): Slicer2State {
  return {
    sample: '', file: '', slices: [], stretch: 0, gftype: 0, tempo: 120, beats: 0, chromatic: -1, baseKey: 60,
    autoDump: true, markers: [], sel: [0], bank: 0, filterSlice: true,
  };
}

/**
 * FL's state of a new Fruity Slicer 2 (Plugin database/Generators/Drum/Fruity Slicer 2.fst =
 * Default.fst, "slc1" version 3): no sample, one empty slice named "1" whose gain is 0.77
 * (an older default: 154000 in the gain wheel's units).
 */
export function flDefaultState(): Record<string, unknown> {
  const sl = defaultSlice();
  sl.name = '1';
  return { ...defaultSlicer2State(), slices: [sl], g1: 154000 };
}

// ------------------------------------------------------------------ parameter keys
/** Per-slice parameter blocks in FL's index order (16 + 128 * block + slice). */
export const SL2_BLOCKS = ['t', 'd', 'g', 'p', 'a', 'r', 'c', 'q'] as const;
export type Sl2Block = (typeof SL2_BLOCKS)[number];
export const SL2_BLOCK_NAMES: Record<Sl2Block, string> = {
  t: 'Transpose', d: 'Detune', g: 'Gain', p: 'Pan', a: 'Attack', r: 'Release', c: 'Cutoff', q: 'Res',
};
/** Key of slice parameter `b` of slice index `i` (0-based): "t1" .. "q128". */
export function sl2Key(b: Sl2Block, i: number): string {
  return `${b}${i + 1}`;
}
/** FL parameter index of slice parameter `b` of slice `i`. */
export function sl2Index(b: Sl2Block, i: number): number {
  return 16 + 128 * SL2_BLOCKS.indexOf(b) + i;
}
/** Control ranges (FL's form) and defaults of the slice parameters. */
export const SL2_BLOCK_RANGE: Record<Sl2Block, [number, number, number]> = {
  t: [-24, 24, 0], d: [0, 200, 100], g: [0, 200000, 153880], p: [0, 200000, 100000],
  a: [0, 100000, 0], r: [0, 100000, 10000], c: [0, 100000, 100000], q: [0, 100000, 0],
};
/** The five global parameters (indices 0..4). */
export const SL2_GLOBAL = ['mono', 'cutoff', 'res', 'transpose', 'detune'] as const;

/**
 * FL's wrapper -> engine value (TTestPlug.ProcessParam): (value - min) / (max - min) in
 * double precision, clamped to 0..1, as a float32 (the engine's parameter value).
 */
export function sl2Norm(x: number, min: number, max: number): number {
  const v = (x - min) * (1 / (max - min));
  return f32(v < 0 ? 0 : v > 1 ? 1 : v);
}

// ------------------------------------------------------------------ keys
/** The key that triggers slice `i` (FL: the record's key, or base key + index). */
export function sliceKey(slices: readonly Slicer2Slice[], baseKey: number, i: number): number {
  const k = slices[i]?.key ?? -1;
  return k >= 0 ? k : baseKey + i;
}

/** FL's base key for n slices (wrapper 0x699f0): 60, an octave lower while base + n > 124 (down to 12). */
export function baseKeyFor(n: number): number {
  let b = 60;
  while (b + n > 124 && b >= 12) b -= 12;
  return b;
}

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** FL's note name (60 = C5). */
export function noteName(k: number): string {
  return `${NOTE[((k % 12) + 12) % 12]}${Math.floor(k / 12)}`;
}

// ------------------------------------------------------------------ normalisation
const num = (x: unknown, d: number, lo: number, hi: number, int = true): number => {
  if (typeof x !== 'number' || !Number.isFinite(x)) return d;
  const v = int ? Math.round(x) : x;
  return v < lo ? lo : v > hi ? hi : v;
};

function normSlice(x: unknown): Slicer2Slice {
  const s = (x && typeof x === 'object' ? x : {}) as Partial<Slicer2Slice>;
  const d = defaultSlice();
  const start = num(s.start, 0, 0, 0x7fffffff);
  return {
    start,
    end: num(s.end, start, 0, 0x7fffffff),
    key: num(s.key, -1, -1, 127),
    name: typeof s.name === 'string' ? s.name.slice(0, 255) : '',
    mode: num(s.mode, 0, 0, 7),
    ftype: num(s.ftype, 0, 0, 3),
    fade: num(s.fade, d.fade, 0, 60, false),
    hold: num(s.hold, d.hold, 0, 1, false),
    decay: num(s.decay, d.decay, 0, 1, false),
    sustain: num(s.sustain, d.sustain, 0, 1, false),
  };
}

/** Fill / repair a stored state (the parameter keys are the registry's). */
export function normalizeSlicer2State(p: Record<string, unknown>): Record<string, unknown> {
  const q: Record<string, unknown> = { ...p };
  const d = defaultSlicer2State();
  q.sample = typeof q.sample === 'string' ? q.sample : '';
  q.file = typeof q.file === 'string' ? q.file : '';
  const sl = Array.isArray(q.slices) ? q.slices.slice(0, SL2_MAX) : [];
  q.slices = sl.map(normSlice);
  q.stretch = num(q.stretch, d.stretch, 0, 2);
  q.gftype = num(q.gftype, d.gftype, 0, 3);
  q.tempo = num(q.tempo, d.tempo, 10, 999, false);
  q.beats = num(q.beats, d.beats, 0, 999, false);
  const n = (q.slices as Slicer2Slice[]).length;
  q.chromatic = num(q.chromatic, -1, -1, Math.max(-1, n - 1));
  q.baseKey = num(q.baseKey, d.baseKey, 0, 127);
  q.autoDump = typeof q.autoDump === 'boolean' ? q.autoDump : d.autoDump;
  const mk = Array.isArray(q.markers) ? q.markers.slice(0, 1024) : [];
  q.markers = mk.filter((m): m is { pos: number; name: string } => !!m && typeof m === 'object' && typeof (m as { pos: unknown }).pos === 'number')
    .map((m) => ({ pos: num(m.pos, 0, 0, 0x7fffffff), name: typeof m.name === 'string' ? m.name.slice(0, 255) : '' }));
  const sel = Array.isArray(q.sel) ? q.sel.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < SL2_MAX) : [];
  q.sel = sel.length ? [...new Set(sel)] : [0];
  q.bank = num(q.bank, 0, 0, SL2_MAX / 8 - 1);
  q.filterSlice = typeof q.filterSlice === 'boolean' ? q.filterSlice : d.filterSlice;
  return q;
}

/** The state as typed fields (after normalisation). */
export function slicer2State(p: Record<string, unknown>): Slicer2State {
  return p as unknown as Slicer2State;
}
