// Dance (FL: Fruity Dance, Plugin database > Generators > Visual): an animated
// character in its own transparent window that dances to the song. Notes in
// the Piano roll pick the dance move (and show / hide the window); there is no
// audio. Everything below was measured on FL 2026's own plugin in the test host
// (docs/research/gen/dance.md): the seven parameters, the note -> parameter
// table, the animation law (frames, speed, blend), Sync changes, Freestyle, the
// sprite sheet rules and the window geometry.
//
// From FL's binary / test host: category Visual, flags Generator | GetNoteInput
// | NoProcess | NoWindow | NewVoiceParams (no audio, notes through
// TriggerVoice, which kills the voice at once), seven parameters (index 0
// "Dance move" 0..9 with the move names as value text, 1 "Mirror character
// horizontally" 0..1, 2 "Show window" 0..1, 3 "Motion blending" 0..256, 4 "Speed
// multiplicator" -96..96, 5 / 6 "X coordinate" / "Y coordinate" -8192..8192; the
// host reports no value text for 1..6), the editor form (SynthPanel 558 x 224)
// and FL's saved state (version 2, the seven values, the reflection, four
// switches and the sprite sheet's file name). Plugin default: move 2
// "Stepping", mirror off, window shown, blend 64, speed 0.
//
// The plugin's non-parameter state (Sync changes, Solid, Keep in front, On
// desktop, Reflect, the loaded sprite sheet) lives in the keys listed in
// DanceState. This file also holds the pure helpers the engine plugin, the
// editor and the tests share.

import type { GenPluginDef } from '../types';
import type { FxParams } from '../../fx/types';

// ------------------------------------------------------------------ moves

/** FL's Dance move list: item 0 is Freestyle, then the rows of FL Chan's sprite sheet (Dance.txt). */
export const DANCE_MOVES = ['Freestyle', 'Waiting', 'Stepping', 'Jumping', 'Zombie', 'Waving', 'Hula', 'Windmill', 'Zitabata', 'Dervish'];

/** Row names of the built-in character sheet: the nine moves, then "Held" (the mouse holds the character). */
export const DANCE_SHEET_NAMES = [...DANCE_MOVES.slice(1), 'Held'];

/** The built-in countdown sheet: one row. */
export const DANCE_COUNT_NAMES = ['Count'];

/** Frames of one dance cycle (a sprite sheet is 8 cells wide). */
export const DANCE_FRAMES = 8;
/** Frames per beat at speed 0: one dance cycle lasts two beats. */
export const DANCE_FRAMES_PER_BEAT = 4;
/** The Speed slider's reach: the period grows by |speed| / 32 (96 = four times slower). */
export const DANCE_SPEED_UNIT = 32;

// ------------------------------------------------------------------ note table

/** What a note does to the plugin's parameters (FL's TriggerVoice). */
export interface DanceKeyEffect {
  move?: number;
  mirror?: number;
  visible?: number;
}

/** The largest Dance move value (the parameter's range is 0..9, FL's own: a sheet with more moves keeps its first 9 selectable). */
export const DANCE_MAX_MOVE = 9;

/**
 * Number of moves the note table reaches for a sprite sheet with `rows` rows (names): every row but the held
 * one (at most 9); Freestyle is item 0 besides. (FL's range grows with a larger sheet: measured with 12 names,
 * keys 59..70 and 48..37 reach moves 0..11.)
 */
export function danceKeyMovesOf(rows: number): number {
  return Math.min(DANCE_MAX_MOVE, Math.max(0, rows - 1));
}

/**
 * FL's note -> parameter table, measured with the test host (key = FL's key
 * number, C5 = 60). Keys 59..68 select the move 0..9 with Mirror off, keys
 * 48..39 the move 0..9 with Mirror on, key 53 hides the window and key 54
 * shows it. Every other key does nothing; velocity, note colour, pan, fine
 * pitch and length are not read. The moves follow the loaded sprite sheet:
 * `moves` (default: FL Chan's 9) is the number of moves after Freestyle that
 * the keys reach (the sheet's rows but the last; a one-row sheet has none): a
 * key beyond them does nothing.
 */
export function danceKeyEffect(key: number, moves = 9): DanceKeyEffect | null {
  const k = Math.round(key);
  if (k >= 59 && k <= 59 + moves) return { move: k - 59, mirror: 0 };
  if (k <= 48 && k >= 48 - moves) return { move: 48 - k, mirror: 1 };
  if (k === 53) return { visible: 0 };
  if (k === 54) return { visible: 1 };
  return null;
}

// ------------------------------------------------------------------ animation law

/** The factor the dance period grows by at Speed `speed`: 1 + |speed| / 32 (the sign of the speed does not matter). */
export function danceSpeedFactor(speed: number): number {
  return 1 + Math.abs(speed) / DANCE_SPEED_UNIT;
}

/**
 * Frames per beat at Speed `speed`. FL's plugin has a quirk that is reproduced here (measured with
 * 40 changes between speeds from -48 to 48 and chains of them): a speed that is SET (loaded, or
 * changed from 0 or from a negative speed) slows the dance by 1 + |speed| / 32 (`inverse` false), but a
 * speed CHANGED FROM A POSITIVE SPEED to another one speeds it up by that factor instead (`inverse`
 * true): +24 -> +16 plays 1.5 times faster than speed 0, +16 -> +24 1.75 times faster, +24 -> -24
 * 1.75 times. Only changes of the speed decide it (see danceSpeedInverse); move, mirror, blend changes
 * and rewriting the same speed leave it as it is.
 */
export function danceFramesPerBeat(speed: number, inverse = false): number {
  const f = danceSpeedFactor(speed);
  return inverse ? DANCE_FRAMES_PER_BEAT * f : DANCE_FRAMES_PER_BEAT / f;
}

/** The speed mode after the speed changed from `prev` to `next`: inverse when it was positive (see danceFramesPerBeat). */
export function danceSpeedInverse(prev: number, next: number): boolean {
  return prev > 0 && next !== prev;
}

/**
 * The animation's position in frames at `beats` of song position and Speed
 * `speed` (measured: frame = floor(beats x 4 / (1 + |speed| / 32)) mod 8, so
 * one cycle takes 2 beats at speed 0 and 8 beats at +-96; the sign of the speed
 * does not matter; but see danceFramesPerBeat for the quirk after a change from a positive speed).
 * The phase is a function of the song position alone.
 */
export function dancePhase(beats: number, speed: number, inverse = false): number {
  return beats * danceFramesPerBeat(speed, inverse);
}

/**
 * Motion blending (0..256): the share of the next frame mixed into the
 * current one at fraction `frac` (0..1) of the frame's time. FL crossfades
 * linearly over the last B = blend / 256 of each frame, reaching the full next
 * frame at the end: t = clamp((frac - (1 - B)) / B, 0, 1). Blend 256 is a
 * continuous crossfade, 0 shows the frames unmixed.
 */
export function danceBlend(frac: number, blend: number): number {
  const b = Math.min(1, Math.max(0, blend / 256));
  if (b <= 0) return 0;
  return Math.min(1, Math.max(0, (frac - (1 - b)) / b));
}

/**
 * The Held row (the mouse holds the character) always crossfades over the last
 * two thirds of each frame, whatever the Blend slider says, even at 0 (measured
 * at blend 0, 16, 32, 64, 128, 256: the same ramp from a third of the frame).
 */
export const DANCE_HELD_BLEND = (256 * 2) / 3;

// ------------------------------------------------------------------ sprite sheet rules

/** A sprite sheet's grid: 8 cells wide, one row per name of its .txt file. */
export interface DanceSheetGrid {
  cellW: number;
  cellH: number;
  rows: number;
}

/**
 * FL's sprite sheet layout (measured with sheets of other sizes): the sheet
 * is 8 cells wide and has one row per name in its text file, so a cell is
 * width / 8 by height / names; a sheet whose size is not a whole number of
 * cells is refused (FL keeps its previous sheet). null = refused.
 */
export function danceSheetGrid(width: number, height: number, names: number): DanceSheetGrid | null {
  if (!(width >= DANCE_FRAMES) || !(height >= 1) || !(names >= 1)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width % DANCE_FRAMES !== 0 || height % names !== 0) return null;
  return { cellW: width / DANCE_FRAMES, cellH: height / names, rows: names };
}

/** Row names from a sprite sheet's text file: one name per line (CR LF, empty lines dropped). */
export function parseSheetNames(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 64).map((s) => s.slice(0, 80));
}

/**
 * The moves a list of row names offers: every row but the last one (the
 * "Held" row the mouse holds the character with); a single row is both.
 */
export function danceMovesOf(names: readonly string[]): string[] {
  return names.length >= 2 ? names.slice(0, -1) : names.slice();
}

/** The sheet row shown while the mouse holds the character (the last one). */
export function danceHeldRow(names: readonly string[]): number {
  return names.length >= 2 ? names.length - 1 : 0;
}

/**
 * The sheet row a move plays (item 0 of the list is Freestyle, which plays
 * `freeRow`; item m >= 1 plays row m - 1; moves beyond the list play its last row).
 */
export function danceRowOf(move: number, moves: number, freeRow: number): number {
  const last = Math.max(0, moves - 1);
  const m = Math.round(move);
  if (m <= 0) return Math.min(last, Math.max(0, freeRow));
  return Math.min(last, m - 1);
}

/**
 * Freestyle plays a random one of the moves after the first (FL: never
 * Waiting, the idle move; measured over 160 cycles) for every dance cycle;
 * `r` is a random number in [0, 1).
 */
export function danceFreeRow(moves: number, r: number): number {
  if (moves < 2) return 0;
  return 1 + Math.min(moves - 2, Math.floor(Math.max(0, Math.min(0.9999999, r)) * (moves - 1)));
}

// ------------------------------------------------------------------ window geometry

/** The character window's size in CSS px: a sprite is drawn at half its pixel size (sheets are @2x), plus the reflection below. */
export interface DanceBox {
  /** Character (cell) size. */
  w: number;
  h: number;
  /** Height of the reflection area below the cell (0 when Reflect is 0). */
  refl: number;
}

/**
 * FL's window: the cell at half size (110 x 128 for FL Chan's 220 x 256
 * cells) and, with Reflect above 0, a reflection area of a third of the
 * height below it (43 px under 128).
 */
export function danceBox(cellW: number, cellH: number, reflect: number): DanceBox {
  const w = Math.max(1, Math.round(cellW / 2));
  const h = Math.max(1, Math.round(cellH / 2));
  return { w, h, refl: reflect > 0 ? Math.round(h / 3) : 0 };
}

/** The reflection's opacity at row `y` of its `refl` rows: Reflect / 256 at the feet fading linearly to 0 (measured). */
export function danceReflectAlpha(y: number, refl: number, reflect: number): number {
  if (refl <= 0) return 0;
  return Math.max(0, Math.min(1, reflect / 256)) * Math.max(0, 1 - y / refl);
}

/** Pixels of the window that stay on screen when it is moved out sideways or down (measured: 16). */
export const DANCE_KEEP = 16;

/**
 * The window's top-left from the X / Y coordinate parameters: X is the
 * character's horizontal centre and Y the bottom of the character cell (its
 * feet), both measured from the top left of the screen in FL's pixels (the
 * macOS build stores doubled points). FL keeps the window on screen: 16 px of
 * it stay visible at the left, right and bottom edges and it never goes above
 * the top of the work area (measured with positions beyond the edges).
 */
export function danceWindowPos(x: number, y: number, box: DanceBox, vw: number, vh: number): { left: number; top: number } {
  const left = Math.min(vw - DANCE_KEEP, Math.max(DANCE_KEEP - box.w, x - box.w / 2));
  const top = Math.min(vh - DANCE_KEEP, Math.max(0, y - box.h));
  return { left, top };
}

/** The parameters X / Y of a window whose top-left is (left, top): the inverse of danceWindowPos before clamping. */
export function danceCoordsOf(left: number, top: number, box: DanceBox): { x: number; y: number } {
  return { x: Math.round(left + box.w / 2), y: Math.round(top + box.h) };
}

// ------------------------------------------------------------------ state

/** Which sprite sheet the character is drawn from. */
export type DanceSheetId = 'pippin' | 'countdown' | 'user';

/**
 * The plugin's state (the channel's plugin params): FL's seven parameters and
 * the settings FL keeps in its saved state.
 */
export interface DanceState {
  /** Parameter 0 "Dance move": 0 Freestyle, 1.. = the sheet's moves. */
  move: number;
  /** Parameter 1. */
  mirror: boolean;
  /** Parameter 2 "Show window". */
  visible: boolean;
  /** Parameter 3 "Motion blending" 0..256. */
  blend: number;
  /** Parameter 4 "Speed multiplicator" -96..96. */
  speed: number;
  /** Parameters 5 / 6: the character's centre x and feet y (see danceWindowPos). */
  x: number;
  y: number;
  /** Sync changes: a new move / mirror waits for the end of the running cycle (while the song plays). */
  sync: boolean;
  /** Solid: the character takes mouse clicks (off: they pass through). */
  solid: boolean;
  /** Keep in front: above every other window. */
  front: boolean;
  /** On desktop (no meaning in a browser; the option is kept like FL's saved state). */
  desktop: boolean;
  /** Reflect 0..256: the reflection's opacity (0 = none). */
  reflect: number;
  /** The sprite sheet: the built-in character, the built-in countdown or a file the user loaded. */
  sheet: DanceSheetId;
  /** User sheet: the file's name. */
  sheetName: string;
  /** User sheet: the row names (the last one is the Held row). */
  sheetNames: string[];
  /** User sheet: the encoded image as a data URL (small sheets live in the project). */
  sheetData: string;
  /** User sheet: key of the image in the browser's file store (large sheets; '' = none). */
  sheetKey: string;
  /** User sheet: pixel size of the image. */
  sheetSize: [number, number];
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const flag = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' ? v >= 0.5 : d);
/** A stored sprite sheet image: only an inline image data URL is accepted (never a link the page would fetch). */
const imageUrl = (v: unknown, max = 4_000_000): string => (typeof v === 'string' && v.length <= max && /^data:image\/(png|jpeg|gif|bmp|webp);base64,/.test(v) ? v : '');

/** Default character position (FL starts at a random x of 400..800 and y 500: a new Orchard instance picks its x at random too, this is the fallback and the parameter's default). */
export const DANCE_DEFAULT_POS = { x: 600, y: 500 };
/** The Reflect slider's default. */
export const DANCE_DEFAULT_REFLECT = 64;

/** Read the state from a params object (missing or invalid fields take their defaults). */
export function danceState(p: FxParams): DanceState {
  const names = Array.isArray(p.sheetNames) ? p.sheetNames.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 64).map((s) => s.slice(0, 80)) : [];
  const sheet: DanceSheetId = p.sheet === 'countdown' ? 'countdown' : p.sheet === 'user' && names.length > 0 ? 'user' : 'pippin';
  const size = Array.isArray(p.sheetSize) && p.sheetSize.length === 2 ? [num(p.sheetSize[0], 0, 0, 65536), num(p.sheetSize[1], 0, 0, 65536)] as [number, number] : [0, 0] as [number, number];
  return {
    move: Math.round(num(p.move, 2, 0, 9)),
    mirror: flag(p.mirror, false),
    visible: flag(p.visible, true),
    blend: Math.round(num(p.blend, 64, 0, 256)),
    speed: Math.round(num(p.speed, 0, -96, 96)),
    x: Math.round(num(p.x, DANCE_DEFAULT_POS.x, -8192, 8192)),
    y: Math.round(num(p.y, DANCE_DEFAULT_POS.y, -8192, 8192)),
    sync: flag(p.sync, true),
    solid: flag(p.solid, true),
    front: flag(p.front, true),
    desktop: flag(p.desktop, true),
    reflect: Math.round(num(p.reflect, DANCE_DEFAULT_REFLECT, 0, 256)),
    sheet,
    sheetName: typeof p.sheetName === 'string' ? p.sheetName.slice(0, 200) : '',
    sheetNames: names,
    sheetData: imageUrl(p.sheetData),
    sheetKey: typeof p.sheetKey === 'string' ? p.sheetKey.slice(0, 80) : '',
    sheetSize: size,
  };
}

/** The row names of the state's sprite sheet (the last one is Held). */
export function danceSheetNames(s: Pick<DanceState, 'sheet' | 'sheetNames'>): string[] {
  return s.sheet === 'user' && s.sheetNames.length > 0 ? s.sheetNames : s.sheet === 'countdown' ? DANCE_COUNT_NAMES : DANCE_SHEET_NAMES;
}

/** Items of the Dance move list for a state: Freestyle, then the sheet's moves (FL: GetName of parameter 0). */
export function danceMoveList(s: Pick<DanceState, 'sheet' | 'sheetNames'>): string[] {
  return ['Freestyle', ...danceMovesOf(danceSheetNames(s)).slice(0, DANCE_MAX_MOVE)];
}

/** FL's value text of the Dance move parameter: the name of the (clamped) item. */
export function danceMoveText(v: number, state?: FxParams): string {
  const list = danceMoveList(state ? danceState(state) : { sheet: 'pippin', sheetNames: [] });
  return list[Math.min(list.length - 1, Math.max(0, Math.round(v)))] ?? '';
}

/**
 * The names the plugin gives its keys in the Piano roll (FL: GetName(FPN_Semitone), measured
 * for FL Chan's sheet and three others): "Freestyle", "Waiting".. on keys 59.., "M Freestyle",
 * "M Waiting".. on keys 48 down, "Hide" on 53 and "Show" on 54; a sheet with fewer moves has fewer keys.
 */
export function danceKeyNames(state: FxParams): Record<number, string> {
  const s = danceState(state);
  const names = danceSheetNames(s);
  const moves = danceKeyMovesOf(names.length);
  const out: Record<number, string> = { 53: 'Hide', 54: 'Show' };
  for (let i = 0; i <= moves; i++) {
    const n = i === 0 ? 'Freestyle' : names[i - 1];
    out[59 + i] = n;
    out[48 - i] = `M ${n}`;
  }
  return out;
}

// ------------------------------------------------------------------ definition

export const def: GenPluginDef = {
  id: 'dance',
  name: 'Dance',
  category: 'Visual',
  notes: 'voices',
  noAudio: true,
  width: 558,
  height: 224,
  description: 'Animated character that dances to the song',
  keyNames: danceKeyNames,
  params: [
    { key: 'move', name: 'Dance move', index: 0, min: 0, max: 9, def: 2, options: DANCE_MOVES, format: danceMoveText },
    { key: 'mirror', name: 'Mirror character horizontally', index: 1, min: 0, max: 1, def: 0 },
    { key: 'visible', name: 'Show window', index: 2, min: 0, max: 1, def: 1 },
    { key: 'blend', name: 'Motion blending', index: 3, min: 0, max: 256, def: 64 },
    { key: 'speed', name: 'Speed multiplicator', index: 4, min: -96, max: 96, def: 0, bipolar: true },
    { key: 'x', name: 'X coordinate', index: 5, min: -8192, max: 8192, def: DANCE_DEFAULT_POS.x },
    { key: 'y', name: 'Y coordinate', index: 6, min: -8192, max: 8192, def: DANCE_DEFAULT_POS.y },
  ],
  // a new instance starts at a random x of 400..799 like FL's (state() is applied after the parameter defaults), so that
  // several characters do not stand on top of each other; saved states keep their own x
  state: () => ({
    x: 400 + Math.floor(Math.random() * 400),
    sync: true, solid: true, front: true, desktop: true, reflect: DANCE_DEFAULT_REFLECT,
    sheet: 'pippin', sheetName: '', sheetNames: [], sheetData: '', sheetKey: '', sheetSize: [0, 0],
  }),
  normalize: (p) => {
    const s = danceState(p);
    return {
      ...p,
      move: s.move, mirror: s.mirror ? 1 : 0, visible: s.visible ? 1 : 0, blend: s.blend, speed: s.speed, x: s.x, y: s.y,
      sync: s.sync, solid: s.solid, front: s.front, desktop: s.desktop, reflect: s.reflect,
      sheet: s.sheet, sheetName: s.sheetName, sheetNames: s.sheetNames.slice(), sheetData: s.sheetData, sheetKey: s.sheetKey, sheetSize: [s.sheetSize[0], s.sheetSize[1]],
    };
  },
};
