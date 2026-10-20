// Fruity Slicer's plugin state (FL's SaveRestoreState 0x61660, version 16), as JSON, and the
// slice / key logic shared by the engine and the editor. See docs/research/gen/slicer.md.

const f32 = Math.fround;

/** A slice (FL's slice record: name, position, key, region time, REV). */
export interface SlicerSlice {
  /** Start in frames of the loaded sample. */
  pos: number;
  /** Key triggering the slice, -1 = base key + slice index (FL's default). */
  key: number;
  /** Slice name ('' = FL shows "Slice #n"). */
  name: string;
  /** Beat position from the file's region data (FL TSampleRegion.Time), -1 = none. */
  time: number;
  /** REV: the slice plays reversed. */
  rev: boolean;
}

/** The state keys (FL's saved fields; FL's own layout in the research note). */
export interface SlicerState {
  /** Pool sample id of the loaded audio ('' = none). */
  sample: string;
  /** The file name FL shows (NameLabel). */
  file: string;
  /** Sample rate the slice positions refer to (FL saves it to rescale positions). */
  rate: number;
  slices: SlicerSlice[];
  /** Loop length in beats and tempo (FL fields 0x130 / 0x134, float32; 0 = unknown). */
  beats: number;
  tempo: number;
  /** PS: pitch shift -1200..1200 cents. */
  ps: number;
  /** TS: time stretch -20000..20000 (factor 2^(ts/10000)). */
  ts: number;
  /** Stretching method 0..7 (Fill gaps ... Speech). */
  method: number;
  /** ATT / DEC: slice fade in / out 0..100 ms. */
  fadeIn: number;
  fadeOut: number;
  declick: boolean;
  playToEnd: boolean;
  autoDump: boolean;
  autoFit: boolean;
  animate: boolean;
  /** Key of the first slice (FL: 60, an octave lower per 12 slices past key 124). */
  baseKey: number;
  /** FL's saved editor value (editor field 0xa60, 0 in every state seen). */
  view: number;
  /** AUTO LOW / HIGH auto-slicing thresholds 0..200 (editor wheels, not saved by FL). */
  autoLow: number;
  autoHigh: number;
  /** Selected slice (editor). */
  sel: number;
}

export const STRETCH_METHODS = ['Fill gaps', 'Alternate fill gaps', 'Pro default', 'Pro transient', 'Transient', 'Tonal', 'Monophonic', 'Speech'] as const;
export const STRETCH_HINTS = [
  'BeatSlicer gap filling', 'BeatSlicer gap filling, alternate', 'Elastique pro, default mode', 'Elastique pro, transient mode',
  'Elastique efficient, transient mode', 'Elastique efficient, tonal mode', 'Elastique soloist, monophonic mode', 'Elastique soloist, speech mode',
] as const;

/**
 * The state FL loads when Fruity Slicer is added (Plugin database > Generators > Drum >
 * Fruity Slicer.fst, state version 15): no sample, Transient stretching, auto-dump,
 * declick and auto-fit on.
 */
export function defaultSlicerState(): SlicerState {
  return {
    sample: '', file: '', rate: 44100, slices: [], beats: 0, tempo: 0, ps: 0, ts: 0, method: 4,
    fadeIn: 0, fadeOut: 0, declick: true, playToEnd: false, autoDump: true, autoFit: true, animate: false,
    baseKey: 60, view: 0, autoLow: 100, autoHigh: 100, sel: 0,
  };
}

const num = (v: unknown, d: number, lo: number, hi: number, int = true): number => {
  let x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(x)) x = d;
  if (int) x = Math.round(x);
  return Math.min(hi, Math.max(lo, x));
};

/** Repair a stored state (types, ranges, slice list). */
export function normalizeSlicerState(p: Record<string, unknown>): Record<string, unknown> {
  const d = defaultSlicerState();
  const rawSlices = Array.isArray(p.slices) ? p.slices : [];
  const slices: SlicerSlice[] = [];
  for (const r of rawSlices) {
    if (!r || typeof r !== 'object') continue;
    const s = r as Record<string, unknown>;
    slices.push({
      pos: num(s.pos, 0, 0, 2 ** 31 - 1),
      key: num(s.key, -1, -1, 124),
      name: typeof s.name === 'string' ? s.name.slice(0, 255) : '',
      time: Number.isFinite(s.time) ? f32(s.time as number) : -1,
      rev: !!s.rev,
    });
  }
  return {
    ...p,
    sample: typeof p.sample === 'string' ? p.sample : '',
    file: typeof p.file === 'string' ? p.file : '',
    rate: num(p.rate, d.rate, 1, 1e7),
    slices,
    beats: Number.isFinite(p.beats) && (p.beats as number) >= 0 ? f32(p.beats as number) : 0,
    tempo: Number.isFinite(p.tempo) && (p.tempo as number) >= 0 ? f32(p.tempo as number) : 0,
    ps: num(p.ps, 0, -1200, 1200),
    ts: num(p.ts, 0, -20000, 20000),
    method: num(p.method, d.method, 0, 7),
    fadeIn: num(p.fadeIn, 0, 0, 100),
    fadeOut: num(p.fadeOut, 0, 0, 100),
    declick: p.declick === undefined ? d.declick : !!p.declick,
    playToEnd: !!p.playToEnd,
    autoDump: p.autoDump === undefined ? d.autoDump : !!p.autoDump,
    autoFit: p.autoFit === undefined ? d.autoFit : !!p.autoFit,
    animate: !!p.animate,
    baseKey: num(p.baseKey, 60, 0, 124),
    view: num(p.view, 0, -(2 ** 31), 2 ** 31 - 1),
    autoLow: num(p.autoLow, 100, 0, 200),
    autoHigh: num(p.autoHigh, 100, 0, 200),
    sel: num(p.sel, 0, 0, 1e6),
  };
}

/** Read a (normalised) state with defaults. */
export function slicerState(p: unknown): SlicerState {
  return normalizeSlicerState((p && typeof p === 'object' ? p : {}) as Record<string, unknown>) as unknown as SlicerState;
}

/** The key triggering slice i (FL 0x65dd0): its own key, else base key + i, within 0..124. */
export function sliceKey(slices: readonly SlicerSlice[], baseKey: number, i: number): number {
  let k = slices[i]?.key ?? -1;
  if (k < 0) k = i + baseKey;
  return k < 0 ? 0 : k > 124 ? 124 : k;
}

/** FL's key -> slice index map (0x67090): 125 keys, later slices win, -1 = no slice. */
export function sliceKeyMap(slices: readonly SlicerSlice[], baseKey: number, out = new Int32Array(125)): Int32Array {
  out.fill(-1);
  for (let i = 0; i < slices.length; i++) out[sliceKey(slices, baseKey, i)] = i;
  return out;
}

/** FL's base key for n slices (0x64570): 60, an octave lower while base + n > 124 (down to 12). */
export function baseKeyFor(n: number): number {
  let b = 60;
  while (b + n > 124 && b >= 12) b -= 12;
  return b;
}

/** The name FL shows for slice i (GetName): its name, else "Slice #n". */
export function sliceName(slices: readonly SlicerSlice[], i: number): string {
  const n = slices[i]?.name ?? '';
  return n !== '' ? n : `Slice #${i + 1}`;
}

/** A new slice record (FL 0x67050): no reverse, default key, no region time. */
export function newSlice(pos: number, name = ''): SlicerSlice {
  return { pos, key: -1, name, time: -1, rev: false };
}

/** FL's tempo from the beats (0x61440): beats * rate * 60 / length (float32). */
export function tempoOf(beats: number, frames: number, rate: number): number {
  return frames > 0 ? f32((f32(beats) * rate * 60) / frames) : 0;
}

/** FL's beats from the tempo (0x613e0): length * tempo / (rate * 60) (float32). */
export function beatsOf(tempo: number, frames: number, rate: number): number {
  return frames > 0 ? f32(f32(frames * f32(tempo)) / (rate * 60)) : 0;
}

/**
 * FL's beats / tempo for a loaded sample (0x6aef0 + 0x772e0): FL's host reports the file's
 * tempo (embedded tempo information, e.g. a WAV 'acid' chunk; 0 without), the beats follow
 * as length * tempo / (rate * 60); without a tempo both stay 0.
 */
export function loopTiming(frames: number, rate: number, fileTempo: number): { beats: number; tempo: number } {
  const t = f32(fileTempo);
  if (t !== 0 && Number.isFinite(t)) return { beats: f32((frames * t) / (rate * 60)), tempo: t };
  return { beats: 0, tempo: 0 };
}
