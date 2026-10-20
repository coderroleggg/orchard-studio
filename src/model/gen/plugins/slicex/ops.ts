// Slicex's deck operations, as FL's editor runs them (FL 2026 Slicex_x64.dylib; FL's shared
// sample editor TWAVEditor + TWAVSample code inside it): sample load with FL's tempo guess and
// auto-slicing, the Regions menu's slicing / zero-crossing / key assignment tools, region edits,
// the option setter. Pure functions returning new decks; the editor calls them and writes the
// results into the state (docs/research/gen/slicex.md "Editing").
//
// FL keeps Slicex's per-region settings (the 68-byte records) linked to the regions (region
// +0x34 holds the record index, re-linked by 0x7d3f0 on every change), so a region keeps its
// settings when other regions are added or removed; new regions get the default record. Here the
// record fields live in SxRegion itself. Regions are kept sorted by start (FL 0x1fd860, a stable
// bubble sort after each insertion).

import { exp, log } from '../../../../engine/gen/plugins/slicex/libm';
import { autoSlice, zeroCross } from '../slicer/slicing';
import { defaultRegion, settingsFromRaw } from './defaults';
import { sxBaseNote, sxKeyLists, sxRegionEnd, sxRegionKey } from './state';
import type { SxArt, SxDeck, SxRegion, SxSettings } from './types';
import { parseSxWav, type WavData } from './wav';

const f32 = Math.fround;

export interface SxAudio {
  channels: readonly Float32Array[];
  sampleRate: number;
}

/** FL's default project tempo (BPM), used when the caller has none. */
export const SX_DEFAULT_TEMPO = 130;
/** AUTO wheel values of the Dull / Medium / Sharp auto-slicing presets (FL table 0x3acff8: 0.33, 1, 1.67). */
export const SX_AUTO_WHEELS = [33, 100, 167] as const;
/** Small / medium / large grid in beats (the editor's grid levels +0x1598 / +0x1590 / +0x1588 in 4/4). */
export const SX_GRID_BEATS = [0.25, 1, 4] as const;
/** Purpose of the regions FL's slicing tools replace (bit mask 4 of 0x1ff590: 'beat', the default). */
export const SX_PUR_SLICE = 2;

const frames = (a: SxAudio): number => a.channels[0]?.length ?? 0;

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Stable sort by start (FL 0x1fd860). */
function sorted(regions: SxRegion[]): SxRegion[] {
  return regions.map((r, i) => [r, i] as const).sort((a, b) => a[0].s - b[0].s || a[1] - b[1]).map((x) => x[0]);
}

/** Deck copy with new regions (sorted). */
function withRegions(deck: SxDeck, regions: SxRegion[]): SxDeck {
  return { ...deck, regions: sorted(regions) };
}

/** Index of region object `r` in a deck's regions. */
const indexOf = (deck: SxDeck, r: SxRegion): number => deck.regions.indexOf(r);

/** FL's frames -> milliseconds of a sample (0x1ffbf0). */
export function sxFramesToMs(n: number, rate: number): number {
  return (n * 1000) / rate;
}

/**
 * Beats -> frames (0x1ffc20): at the deck's tempo, else at the given (project) tempo; FL's editor
 * converts its grid this way while its tempo mode (+0x12f1) is on, the default.
 */
export function sxBeatsToFrames(beats: number, rate: number, deckTempo: number, projectTempo: number): number {
  return deckTempo > 0 ? (beats * rate * 60) / deckTempo : (beats * rate * 60) / projectTempo;
}

/**
 * FL's tempo guess for a loaded sample without tempo information (0x8ee20): the length in bars
 * of the project tempo, rounded to whole bars (2 beats under 3/4 of a bar, at most 256 beats);
 * the tempo follows from the beats and is kept only within 30..240 BPM.
 */
export function sxGuessTempo(n: number, rate: number, projectTempo: number): { tempo: number; beats: number } {
  const bar = (240000 / projectTempo) * rate * 0.001;
  let beats = 4;
  if (n > 0) {
    const r = n / bar;
    beats = r < 0.75 ? 2 : Math.min(256, roundEven(r) * 4);
  }
  const tempo = n > 0 ? (rate * beats * 60) / n : 0;
  return tempo >= 30 && tempo <= 240 ? { tempo, beats } : { tempo: 0, beats: 0 };
}

/** File name without folders and extension. */
function baseName(file: string): string {
  const b = file.split(/[\\/]/).pop() ?? '';
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

/**
 * FL's deck load (the editor's kind-5 change, Slicex 0x790d0): the WAV's regions (cue / adtl /
 * tlst) and tempo ('acid'); then, for samples of 1..30 s without a tempo or without regions,
 * FL's tempo guess and FL's auto-slicing with the editor's default (Medium) preset over the
 * whole sample. `wav` is the file's bytes (or its parsed data), null for other formats.
 */
export function sxLoadDeck(audio: SxAudio, wav: Uint8Array | WavData | null, fileName: string, projectTempo = SX_DEFAULT_TEMPO): SxDeck {
  const w = wav instanceof Uint8Array ? parseSxWav(wav) : wav;
  const n = frames(audio);
  const rate = audio.sampleRate;
  let regions = sorted((w?.regions ?? []).filter((r) => r.s >= 0 && r.s < n).map((r) => ({ ...r })));
  let tempo = w && w.tempo > 0 ? w.tempo : 0;
  let beats = tempo > 0 ? (n * tempo) / (rate * 60) : 0;
  if (tempo === 0 || regions.length === 0) {
    const ms = sxFramesToMs(n, rate);
    if (ms >= 1000 && ms <= 30000) {
      if (tempo === 0) ({ tempo, beats } = sxGuessTempo(n, rate, projectTempo > 0 ? projectTempo : SX_DEFAULT_TEMPO));
      if (regions.length === 0) regions = autoSlice(audio.channels, rate, SX_AUTO_WHEELS[1], SX_AUTO_WHEELS[1]).map((p) => defaultRegion(p, -1));
    }
  }
  return { title: w?.title || baseName(fileName), file: fileName, tempo, beats, regions };
}

/** The range a Regions-menu tool works on: the selection, else the whole sample (0xa47c0). */
function toolRange(n: number, sel: readonly [number, number] | null | undefined): [number, number] {
  if (sel && sel[1] >= sel[0]) return [Math.max(0, Math.round(sel[0])), Math.min(n - 1, Math.round(sel[1]))];
  return [0, n - 1];
}

/** FL 0x1ff590 with mask 4: drop the slice-purpose regions starting or ending inside [a, b]. */
function dropSlices(regions: readonly SxRegion[], a: number, b: number): SxRegion[] {
  return regions.filter((r) => {
    if (r.pur !== SX_PUR_SLICE || r.s < 0) return true;
    const e = r.e < 0 ? r.s : r.e;
    return !((r.s >= a && r.s <= b) || (e >= a && e <= b));
  });
}

/**
 * Regions > Dull / Medium / Sharp auto-slicing (0xaa8c0): FL's beat detector on the whole sample
 * (factor 2^table - 1), slice-purpose regions in the range replaced by markers at the detected
 * positions inside it. kind: 0 dull, 1 medium, 2 sharp.
 */
export function sxAutoSlice(deck: SxDeck, audio: SxAudio, kind: 0 | 1 | 2, sel: readonly [number, number] | null = null): SxDeck {
  const n = frames(audio);
  if (n <= 0) return deck;
  const [a, b] = toolRange(n, sel);
  const w = SX_AUTO_WHEELS[kind] ?? SX_AUTO_WHEELS[1];
  const pos = autoSlice(audio.channels, audio.sampleRate, w, w).filter((p) => p >= a && p <= b);
  return withRegions(deck, [...dropSlices(deck.regions, a, b), ...pos.map((p) => defaultRegion(p, -1))]);
}

/**
 * Regions > Small / Medium / Large grid-slicing (0x99870): slice-purpose regions in the range
 * replaced by markers every grid step from the range start (beats at the deck's tempo, else the
 * project tempo). size: 0 small (a step), 1 medium (a beat), 2 large (a bar); `grid` overrides
 * the beats per level (time signatures other than 4/4).
 */
export function sxGridSlice(
  deck: SxDeck, audio: SxAudio, size: 0 | 1 | 2, sel: readonly [number, number] | null = null,
  projectTempo = SX_DEFAULT_TEMPO, grid: readonly number[] = SX_GRID_BEATS,
): SxDeck {
  const n = frames(audio);
  if (n <= 0) return deck;
  const [a, b] = toolRange(n, sel);
  let beats = grid[size] ?? 1;
  if (!(beats > 0)) beats = grid[1] ?? 1;
  const step = sxBeatsToFrames(beats, audio.sampleRate, deck.tempo, projectTempo > 0 ? projectTempo : SX_DEFAULT_TEMPO);
  if (!(step > 0) || !Number.isFinite(step)) return deck;
  const add: SxRegion[] = [];
  // FL has no limit; 65536 markers keep a pathological grid from hanging the editor
  for (let p = a; p <= b && add.length < 65536; p += step) add.push(defaultRegion(roundEven(p), -1));
  return withRegions(deck, [...dropSlices(deck.regions, a, b), ...add]);
}

/**
 * Regions > Zero-cross check all regions (0xa10e0): starts (after the first frame) to the nearest
 * zero crossing within 50 ms (0x1ff710); a region's end moves with the crossing nearest the frame
 * after it, never before its start.
 */
export function sxZeroCrossAll(deck: SxDeck, audio: SxAudio): SxDeck {
  const n = frames(audio);
  if (n <= 0 || deck.regions.length === 0) return deck;
  const rate = audio.sampleRate;
  const regions = deck.regions.map((r) => {
    const q = { ...r };
    if (q.s > 0) q.s = zeroCross(audio.channels, rate, q.s);
    if (q.e >= 0) {
      const e1 = Math.min(q.e + 1, n - 1);
      let e = q.e + zeroCross(audio.channels, rate, e1) - e1;
      if (e < q.s) e = q.s;
      q.e = e;
    }
    return q;
  });
  return withRegions(deck, regions);
}

/** Pad layouts of Regions > Assign to MPC / Trigger Finger / padKontrol pads (FL 0x3acff8 tables, region index -> key). */
const PADS: readonly (readonly number[])[] = [
  [37, 36, 42, 82, 40, 38, 46, 44, 48, 47, 45, 43, 49, 55, 51, 53, 54, 69, 81, 80, 65, 66, 76, 77, 56, 62, 63, 64, 73, 74, 71, 39,
    52, 57, 58, 59, 60, 61, 67, 68, 70, 72, 75, 78, 79, 35, 41, 50, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98],
  [36, 38, 40, 37, 50, 48, 45, 41, 56, 39, 42, 46, 49, 57, 51, 53],
  [48, 52, 54, 58, 49, 51, 68, 56, 60, 59, 57, 55, 61, 70, 65, 63],
];
const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

/**
 * Regions > Assign (0xa2e60), FL's RegionsTo*Menu tags: 0 whole keyboard, 1 white keys, 2 black
 * keys (from the automatic base note), 3 default / none (automatic mapping), 4 all on C5, 5 MPC,
 * 6 Trigger Finger, 7 padKontrol pads (regions past the pad table continue above the highest pad
 * key used; unnamed regions are named "Pad #n"). Notes are capped at 124.
 */
export function sxAssignAll(deck: SxDeck, mode: number): SxDeck {
  let k = mode === 3 ? -1 : mode === 4 ? 60 : sxBaseNote(deck.regions.length);
  let over = false, top = 0;
  const regions = deck.regions.map((r, i) => {
    const q = { ...r };
    if (mode === 1) while (BLACK[((k % 12) + 12) % 12]) k++;
    if (mode === 2) while (!BLACK[((k % 12) + 12) % 12]) k++;
    if (mode >= 5) {
      if (!over) {
        const t = PADS[mode - 5];
        const v = t && i <= 63 ? t[i] ?? -1 : -1;
        if (v >= 0) {
          k = v;
          if (!q.name) q.name = `Pad #${i + 1}`;
          if (k > top) top = k;
        } else {
          over = true;
          k = top + 1;
        }
      }
      // FL steps once more for every region past the pads, the first one included (top + 2, ...)
      if (over) k++;
    }
    q.note = Math.min(k, 124);
    if (mode < 3) k++;
    return q;
  });
  return { ...deck, regions };
}

/** Regions > Set all cut groups to... (0x64910): every region of the deck, 0..99. */
export function sxSetAllCutGroups(deck: SxDeck, cut: number): SxDeck {
  const c = Math.max(0, Math.min(99, Math.trunc(cut) || 0));
  return { ...deck, regions: deck.regions.map((r) => ({ ...r, cut: c })) };
}

// ------------------------------------------------------------------ region edits

export interface SxEditResult {
  deck: SxDeck;
  /** The edited / new region's index after sorting (-1 if none). */
  index: number;
}

/** Add a marker at frame f (FL's AddRegion 0x1fe240 with no end): default record, slice purpose. */
export function sxAddMarker(deck: SxDeck, f: number, n: number): SxEditResult {
  const r = defaultRegion(Math.max(0, Math.min(Math.max(0, n - 1), Math.round(f))), -1);
  const d = withRegions(deck, [...deck.regions, r]);
  return { deck: d, index: indexOf(d, r) };
}

/** Add a region [s, e] (AddRegion: the end capped at the last frame, the start at the end). */
export function sxAddRegion(deck: SxDeck, s: number, e: number, n: number): SxEditResult {
  let end = Math.min(Math.round(Math.max(s, e)), n - 1);
  if (end < 0) end = 0;
  const start = Math.max(0, Math.min(Math.round(Math.min(s, e)), end));
  const r = defaultRegion(start, end);
  const d = withRegions(deck, [...deck.regions, r]);
  return { deck: d, index: indexOf(d, r) };
}

/** Delete region i. */
export function sxDeleteRegion(deck: SxDeck, i: number): SxDeck {
  if (i < 0 || i >= deck.regions.length) return deck;
  return { ...deck, regions: deck.regions.filter((_, j) => j !== i) };
}

/** Delete every region (Regions > Delete all). */
export function sxClearRegions(deck: SxDeck): SxDeck {
  return { ...deck, regions: [] };
}

/** Move region i's start to frame f (kept within the sample and before its end), re-sorted. */
export function sxMoveStart(deck: SxDeck, i: number, f: number, n: number): SxEditResult {
  const r = deck.regions[i];
  if (!r) return { deck, index: -1 };
  let s = Math.max(0, Math.min(Math.max(0, n - 1), Math.round(f)));
  if (r.e >= 0 && s > r.e) s = r.e;
  const q = { ...r, s };
  const d = withRegions(deck, deck.regions.map((x, j) => (j === i ? q : x)));
  return { deck: d, index: indexOf(d, q) };
}

/** Move region i's end to frame f (a marker becomes a region), kept within [start, last frame]. */
export function sxMoveEnd(deck: SxDeck, i: number, f: number, n: number): SxEditResult {
  const r = deck.regions[i];
  if (!r) return { deck, index: -1 };
  const e = Math.max(r.s, Math.min(Math.max(0, n - 1), Math.round(f)));
  const q = { ...r, e };
  const d = { ...deck, regions: deck.regions.map((x, j) => (j === i ? q : x)) };
  return { deck: d, index: i };
}

/** Region i as a region with an explicit end (its current extent). */
export function sxToRegion(deck: SxDeck, i: number, n: number): SxDeck {
  const r = deck.regions[i];
  if (!r || r.e >= 0) return deck;
  const e = sxRegionEnd(deck, i, n);
  return { ...deck, regions: deck.regions.map((x, j) => (j === i ? { ...x, e } : x)) };
}

/** Region i as a marker (no end). */
export function sxToMarker(deck: SxDeck, i: number): SxDeck {
  const r = deck.regions[i];
  if (!r || r.e < 0) return deck;
  return { ...deck, regions: deck.regions.map((x, j) => (j === i ? { ...x, e: -1 } : x)) };
}

/** Clone region i (name, purpose, record) over [s, e] (a marker clone when e < 0). */
export function sxCloneRegion(deck: SxDeck, i: number, s: number, e: number, n: number): SxEditResult {
  const r = deck.regions[i];
  if (!r) return { deck, index: -1 };
  const start = Math.max(0, Math.min(Math.max(0, n - 1), Math.round(s)));
  const q: SxRegion = { ...r, s: start, e: e < 0 ? -1 : Math.max(start, Math.min(n - 1, Math.round(e))) };
  const d = withRegions(deck, [...deck.regions, q]);
  return { deck: d, index: indexOf(d, q) };
}

/** Change region i's fields (name, note, record values ...); a start change re-sorts. */
export function sxSetRegion(deck: SxDeck, i: number, patch: Partial<SxRegion>): SxEditResult {
  const r = deck.regions[i];
  if (!r) return { deck, index: -1 };
  const q = { ...r, ...patch };
  const d = withRegions(deck, deck.regions.map((x, j) => (j === i ? q : x)));
  return { deck: d, index: indexOf(d, q) };
}

// ------------------------------------------------------------------ options

/** Byte offsets of the named settings in FL's option block (+0x1304). */
const OPT_BYTES: Partial<Record<keyof SxSettings, number>> = {
  sameDeck: 0x132e, smooth: 0x1329, startWhole: 0x132c, velVol: 0x132f, loopHalf: 0x1331,
  hqEnv: 0x132d, autoDump: 0x132a, noEmbed: 0x1332, loop: 0x1325, kbShown: 0x1330, noAutoScroll: 0x1326, dual: 0x132b,
};

/** Set one named option, keeping FL's raw block in step. */
export function sxSetOption<K extends keyof SxSettings>(opt: SxSettings, key: K, value: SxSettings[K]): SxSettings {
  const raw = [...opt.raw];
  while (raw.length < 47) raw.push(0);
  const setW = (o: number, v: number) => { for (let i = 0; i < 4; i++) raw[o - 0x1304 + i] = (v >>> (8 * i)) & 0xff; };
  if (key === 'lmode') setW(0x1304, Math.max(0, Math.min(7, Math.trunc(Number(value)) || 0)));
  else if (key === 'xfade') setW(0x1308, Math.max(0, Math.min(4, Math.trunc(Number(value)) || 0)));
  else if (key === 'dispMode') setW(0x1314, Math.max(0, Math.min(3, Math.trunc(Number(value)) || 0)));
  else if (key === 'lockAudio') return { ...opt, lockAudio: !!value };
  else if (key !== 'raw') {
    const o = OPT_BYTES[key];
    if (o !== undefined) raw[o - 0x1304] = value ? 1 : 0;
  } else return { ...settingsFromRaw(value as number[]), lockAudio: opt.lockAudio };
  return { ...settingsFromRaw(raw), lockAudio: opt.lockAudio };
}

// ------------------------------------------------------------------ macros (options menu)

export type SxMacro = 'wholeKeyboard' | 'blackWhite' | 'layerDecks' | 'layerSelections' | 'layerHomonymous'
  | 'deckAToArt1' | 'deckBToArt2' | 'normalizeLayered';

export interface SxMacroInput {
  /** Each deck's selection [s, e] (Layer selections in both decks), null when none. */
  sels?: readonly (readonly [number, number] | null)[];
  /** Each deck's audio (Normalize layered region levels). */
  audio?: readonly (SxAudio | null)[];
  /** "Layer regions of same deck only" (the key lists Normalize layered region levels walks). */
  sameDeck?: boolean;
}

/** A region's gain from its volume (FL's record float +0x48, 0x7f7e0): (3^v - 1) / 2, v = vol / 8000. */
export function sxRegionGain(vol: number): number {
  const v = f32(vol * 0.000125);
  return v === 1 ? 1 : f32((exp(f32(v * f32(1.0986123085021973))) - 1) * 0.5);
}

/** FL's RMS of frames [s, e] over all channels (TWAVSample 0x1fcaf0). */
function rmsOf(a: SxAudio, s: number, e: number): number {
  const n = a.channels[0]?.length ?? 0;
  const lo = Math.max(0, s), hi = Math.min(n - 1, e);
  let sum = 0;
  for (let i = lo; i <= hi; i++) for (const c of a.channels) sum += c[i] * c[i];
  return Math.sqrt(sum / ((e - s + 1) * a.channels.length));
}

/** ASCII upper case (FPC UpperCase). */
const upper = (t: string): string => t.replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32));

/**
 * Slicex's options-menu macros (FL 0x812d0, 0x808f0, 0x814b0, 0x80c00, 0x80950, 0x80710, 0x81880):
 * - wholeKeyboard "Assign both decks to whole keyboard": deck A then deck B on consecutive keys from
 *   the base note of both decks' region count (capped at 124);
 * - blackWhite "Assign both decks to black & white notes": deck A on white, deck B on black keys;
 * - layerDecks "Layer both decks": each deck on the whole keyboard from its own base note;
 * - layerSelections: the regions matching each deck's selection exactly share deck A's trigger
 *   note, else deck B's, else deck A's current key;
 * - layerHomonymous: regions with the same name (ASCII case-insensitive, both decks) share a key;
 * - deckAToArt1 / deckBToArt2: every section of the deck's regions on articulator 1 / 2;
 * - normalizeLayered: in every key layer the other regions' volumes match the first one's level
 *   (RMS of the first 100 ms times the region gain).
 */
export function sxMacro(decks: readonly SxDeck[], arts: readonly SxArt[], kind: SxMacro, input: SxMacroInput = {}): { decks: SxDeck[]; arts: SxArt[] } {
  const ds = decks.map((d) => ({ ...d, regions: d.regions.map((r) => ({ ...r })) }));
  const out = () => ({ decks: ds, arts: [...arts] });
  switch (kind) {
    case 'wholeKeyboard': {
      const total = ds[0].regions.length + (ds[1]?.regions.length ?? 0);
      const x = total + 60 - 1 - 124;
      let k = x > 0 ? Math.max(0, 60 - Math.trunc((x + 11) / 12) * 12) : 60;
      for (const d of ds) for (const r of d.regions) { r.note = Math.min(k, 124); k++; }
      return out();
    }
    case 'blackWhite':
      ds[0] = sxAssignAll(ds[0], 1);
      if (ds[1]) ds[1] = sxAssignAll(ds[1], 2);
      return out();
    case 'layerDecks':
      ds[0] = sxAssignAll(ds[0], 0);
      if (ds[1]) ds[1] = sxAssignAll(ds[1], 0);
      return out();
    case 'layerSelections': {
      const hit = ds.map((d, i) => {
        const sel = input.sels?.[i];
        if (!sel) return -1;
        const n = input.audio?.[i]?.channels[0]?.length ?? sel[1] + 1;
        // the region spanning exactly the selection, loops excluded (0x1fe450, purpose mask 0xfe)
        return d.regions.findIndex((r, j) => r.pur !== 0 && r.s === sel[0] && sxRegionEnd(d, j, n) === sel[1]);
      });
      if (hit[0] < 0 || (hit[1] ?? -1) < 0) return out();
      const a = ds[0].regions[hit[0]], b = ds[1].regions[hit[1]];
      let key = a.note >= 0 ? a.note : b.note >= 0 ? b.note : sxRegionKey(ds[0], hit[0]);
      key = Math.max(0, Math.min(127, key));
      a.note = key;
      b.note = key;
      return out();
    }
    case 'layerHomonymous': {
      ds.forEach((d) => d.regions.forEach((r, i) => {
        const nm = upper(r.name);
        if (!nm) return;
        const old = r.note;
        const key = sxRegionKey(d, i);
        let count = 0;
        for (const d2 of ds) for (const r2 of d2.regions) if (upper(r2.name) === nm) { r2.note = key; count++; }
        if (count <= 1) r.note = old;
      }));
      return out();
    }
    case 'deckAToArt1':
    case 'deckBToArt2': {
      const t = kind === 'deckAToArt1' ? 0 : 1;
      if (ds[t]) for (const r of ds[t].regions) { r.aArt = t; r.fArt = t; r.sArt = t; r.oArt = t; }
      return out();
    }
    case 'normalizeLayered': {
      // the key lists do not change here (only volumes do)
      const lists = sxKeyLists(decks, !!input.sameDeck);
      for (let d = 0; d < ds.length; d++) {
        for (let key = 0; key < 128; key++) {
          const list = lists[d]?.[key] ?? [];
          if (list.length <= 1) continue;
          let ref = 0;
          list.forEach((e, j) => {
            const dd = e >> 16, r = e & 0xffff;
            const deck = ds[dd], a = input.audio?.[dd];
            const rg = deck?.regions[r];
            if (!rg || !a) return;
            const s = rg.s;
            const e2 = Math.min(sxRegionEnd(deck, r, a.channels[0]?.length ?? 0), s + roundEven(100 * a.sampleRate * 0.001));
            const lvl = f32(rmsOf(a, s, e2));
            if (j === 0) { ref = f32(lvl * sxRegionGain(rg.vol)); return; }
            const g = f32(ref / (lvl > 5.96046448e-8 ? lvl : f32(5.96046448e-8)));
            let v = roundEven(f32(f32(log(f32(f32(g * 2) + 1)) * f32(0.91023922)) * 8000));
            if (v < 0) v = 0;
            if (v > 16000) v = 16000;
            rg.vol = v;
          });
        }
      }
      return out();
    }
    default:
      return out();
  }
}

/** Keyboard menu "Assign current region to this key" (0x81510). */
export function sxAssignToKey(deck: SxDeck, i: number, key: number): SxDeck {
  if (i < 0 || i >= deck.regions.length) return deck;
  return { ...deck, regions: deck.regions.map((r, j) => (j === i ? { ...r, note: key } : r)) };
}

/** Keyboard menu "Select region assigned to this key" (0x81680): the first region on the key in deck d's list (-1 none). */
export function sxRegionOnKey(decks: readonly SxDeck[], d: number, key: number, sameDeck: boolean): { deck: number; region: number } | null {
  if (key < 0 || key > 127) return null;
  const e = sxKeyLists(decks, sameDeck)[d]?.[key]?.[0];
  return e === undefined ? null : { deck: e >> 16, region: e & 0xffff };
}
