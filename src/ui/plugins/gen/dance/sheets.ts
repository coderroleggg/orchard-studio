// Sprite sheets of the Dance character: the built-in ones (art.ts) and the
// sheets users load. FL loads a PNG (or JPG / GIF / BMP) that is 8 cells wide
// with a text file of the same name naming its rows (the last one is the
// "Held" row), from the plugin's Artwork folder or dropped on the plugin. A
// browser has no such folder, so the file chooser takes the image (and its
// text file with it) and drag & drop takes them too. The sheet is kept with
// the project: small sheets (re-encoded) as a data URL in the plugin's state,
// larger ones as the original file in the browser's file store (IndexedDB)
// under a key the state holds, like the Video Player's file and the user
// samples. A sheet that is not in the store (another browser) falls back to the
// built-in character.

import { useEffect, useState } from 'react';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { flashHint } from '../../../hint';
import {
  DANCE_COUNT_NAMES, DANCE_MAX_MOVE, DANCE_SHEET_NAMES, danceMovesOf, danceSheetGrid, parseSheetNames, type DanceState,
} from '../../../../model/gen/plugins/dance';
import { CELL_H, CELL_W, COUNT_CELL, makeCountSheet, makePippinSheet } from './art';

/** A sprite sheet ready to draw. */
export interface SpriteSheet {
  /** Cache key. */
  key: string;
  image: CanvasImageSource;
  /** One cell in image pixels (the window shows it at half size). */
  cellW: number;
  cellH: number;
  /** Row names, the last one is the Held row. */
  names: string[];
}

export const sheetMoves = (s: SpriteSheet): string[] => danceMovesOf(s.names);

// ------------------------------------------------------------------ built-in

let pippin: SpriteSheet | null = null;
let counter: SpriteSheet | null = null;

/** The built-in character's sheet (drawn on first use). */
export function pippinSheet(): SpriteSheet {
  if (!pippin) pippin = { key: 'pippin', image: makePippinSheet(), cellW: CELL_W, cellH: CELL_H, names: DANCE_SHEET_NAMES };
  return pippin;
}

/** The built-in countdown sheet. */
export function countSheet(): SpriteSheet {
  if (!counter) counter = { key: 'countdown', image: makeCountSheet(), cellW: COUNT_CELL, cellH: COUNT_CELL, names: DANCE_COUNT_NAMES };
  return counter;
}

// ------------------------------------------------------------------ file store

const DB_NAME = 'orchard-dance';
const STORE = 'sheets';
const session = new Map<string, Blob>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putBlob(key: string, blob: Blob): Promise<void> {
  session.set(key, blob);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* storage unavailable or full: the sheet lives for this session only */
  }
}

async function getBlob(key: string): Promise<Blob | undefined> {
  const s = session.get(key);
  if (s) return s;
  try {
    const db = await openDb();
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Blob | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (blob instanceof Blob) { session.set(key, blob); return blob; }
  } catch {
    /* storage unavailable */
  }
  return undefined;
}

function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

// ------------------------------------------------------------------ loading

/** Largest sprite sheet taken (pixels), and the biggest data URL kept in the project. */
const MAX_PIXELS = 24_000_000;
const MAX_FILE = 40_000_000;
const INLINE_MAX = 500_000;

const userSheets = new Map<string, SpriteSheet>();

/** The cache key of a state's user sheet. */
export function userSheetKey(s: DanceState): string {
  const id = s.sheetKey || `d${s.sheetData.length.toString(36)}${fnv(2166136261, s.sheetData.slice(-400)).toString(36)}`;
  return `user:${id}:${s.sheetNames.join('|')}`;
}

async function bitmapOf(blob: Blob): Promise<ImageBitmap | HTMLImageElement | null> {
  try {
    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
  } catch {
    /* fall through to an image element */
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  } finally {
    // a decoded image element keeps its pixels
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const sizeOf = (im: ImageBitmap | HTMLImageElement): [number, number] =>
  'naturalWidth' in im ? [im.naturalWidth, im.naturalHeight] : [im.width, im.height];

async function loadUser(s: DanceState): Promise<SpriteSheet | null> {
  const key = userSheetKey(s);
  const hit = userSheets.get(key);
  if (hit) return hit;
  let blob: Blob | undefined;
  if (s.sheetData) {
    try { blob = await (await fetch(s.sheetData)).blob(); } catch { blob = undefined; }
  }
  if (!blob && s.sheetKey) blob = await getBlob(s.sheetKey);
  if (!blob) return null;
  const im = await bitmapOf(blob);
  if (!im) return null;
  const [w, h] = sizeOf(im);
  const grid = danceSheetGrid(w, h, s.sheetNames.length);
  if (!grid) return null;
  const sheet: SpriteSheet = { key, image: im, cellW: grid.cellW, cellH: grid.cellH, names: s.sheetNames.slice() };
  userSheets.set(key, sheet);
  return sheet;
}

/**
 * The sprite sheet of a state. The built-in character stands in while a
 * user sheet loads and when the file is not available.
 */
export function useSheet(s: DanceState): { sheet: SpriteSheet; missing: boolean } {
  const want = s.sheet === 'user' ? userSheetKey(s) : s.sheet;
  const [, bump] = useState(0);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    if (s.sheet !== 'user' || userSheets.has(want)) return;
    let alive = true;
    void loadUser(s).then((sh) => {
      if (!alive) return;
      if (sh) bump((n) => n + 1);
      else setFailed(want);
    });
    return () => { alive = false; };
  }, [want]); // eslint-disable-line react-hooks/exhaustive-deps
  if (s.sheet === 'countdown') return { sheet: countSheet(), missing: false };
  if (s.sheet === 'user') {
    const hit = userSheets.get(want);
    if (hit) return { sheet: hit, missing: false };
    return { sheet: pippinSheet(), missing: failed === want };
  }
  return { sheet: pippinSheet(), missing: false };
}

// ------------------------------------------------------------------ importing

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;

/** FL's open dialog filter, as the browser's file chooser takes it. */
export const SHEET_ACCEPT = 'image/png,image/jpeg,image/gif,image/bmp,image/webp,.png,.jpg,.jpeg,.gif,.bmp,.webp,.txt,text/plain';

/**
 * Row names for a sheet that came without its text file: FL refuses such a
 * sheet; here the rows are guessed from the cell shape (square cells) and
 * named "Move 1".., the last row "Held".
 */
function guessNames(w: number, h: number): string[] | null {
  const cw = w / 8;
  if (!Number.isInteger(cw) || cw < 1) return null;
  const guess = Math.max(1, Math.round(h / cw));
  // the row count nearest to the guess that divides the height
  let rows = 0;
  for (let d = 0; d <= h && !rows; d++) {
    for (const r of [guess - d, guess + d]) if (r >= 1 && r <= h && h % r === 0) { rows = r; break; }
  }
  if (rows < 1) return null;
  if (rows === 1) return ['Move 1'];
  return [...Array.from({ length: rows - 1 }, (_, i) => `Move ${i + 1}`), 'Held'];
}

async function encode(im: ImageBitmap | HTMLImageElement, w: number, h: number): Promise<string> {
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return '';
    g.drawImage(im, 0, 0);
    const blobs = await Promise.all(['image/png', 'image/webp'].map((t) => new Promise<Blob | null>((r) => c.toBlob(r, t, 0.92))));
    let best: Blob | null = null;
    for (const b of blobs) if (b && (!best || b.size < best.size)) best = b;
    if (!best || best.size * 1.4 > INLINE_MAX) return '';
    const url = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => resolve('');
      r.readAsDataURL(best);
    });
    return url.length <= INLINE_MAX ? url : '';
  } catch {
    return '';
  }
}

/**
 * Load a sprite sheet into the Dance plugin of `slotId` ("ch:<channel id>")
 * from the files the user picked or dropped: an image and, optionally, its
 * text file of row names. Resolves false when the files cannot be used.
 */
export async function importSheet(slotId: string, files: File[]): Promise<boolean> {
  const image = files.find((f) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name));
  if (!image) { flashHint('Pick a PNG, JPG, GIF or BMP sprite sheet (and its .txt file with the row names)'); return false; }
  const base = image.name.replace(/\.[^.]+$/, '').toLowerCase();
  const txts = files.filter((f) => /\.txt$/i.test(f.name) || f.type === 'text/plain');
  const txt = txts.find((f) => f.name.replace(/\.[^.]+$/, '').toLowerCase() === base) ?? txts[0];
  if (image.size > MAX_FILE) { flashHint('The sprite sheet is too large'); return false; }
  flashHint(`Loading ${image.name}...`);
  const im = await bitmapOf(image);
  if (!im) { flashHint(`There was an error loading the file: "${image.name}".`); return false; }
  const [w, h] = sizeOf(im);
  if (w * h > MAX_PIXELS) { flashHint('The sprite sheet is too large'); return false; }
  let names = txt ? parseSheetNames(await txt.text()) : [];
  let guessed = false;
  if (names.length === 0) { names = guessNames(w, h) ?? []; guessed = true; }
  const grid = names.length > 0 ? danceSheetGrid(w, h, names.length) : null;
  if (!grid) {
    flashHint(`The sprite sheet must be 8 cells wide, with a whole number of rows for its ${names.length || 'listed'} row names`);
    return false;
  }
  const key = `s${fnv(fnv(2166136261, `${image.name}|${image.size}|${image.lastModified}`), names.join('|')).toString(36)}${image.size.toString(36)}`;
  const data = await encode(im, w, h);
  if (!data) await putBlob(key, image);
  const loc = A.findFx(store.project, slotId);
  if (!loc) return false;
  const moves = Math.min(DANCE_MAX_MOVE, danceMovesOf(names).length);
  A.editFx(slotId, 'Load sprite sheet', (p) => {
    p.sheet = 'user';
    p.sheetName = image.name;
    p.sheetNames = names.slice();
    p.sheetData = data;
    p.sheetKey = data ? '' : key;
    p.sheetSize = [w, h];
    if (typeof p.move === 'number' && p.move > moves) p.move = moves;
  });
  const extra = danceMovesOf(names).length > DANCE_MAX_MOVE ? ` (only its first ${DANCE_MAX_MOVE} moves can be selected)` : '';
  flashHint(guessed ? `Loaded ${image.name} (no .txt file: rows named Move 1...)${extra}` : `Loaded ${image.name}${extra}`);
  return true;
}

/** The file chooser (FL: the folder button's open dialog). */
export function pickSheet(slotId: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = SHEET_ACCEPT;
  input.multiple = true;
  input.onchange = () => {
    const list = input.files ? [...input.files] : [];
    if (list.length) void importSheet(slotId, list);
  };
  input.click();
}

/** Choose a built-in sheet. */
export function chooseBuiltinSheet(slotId: string, id: 'pippin' | 'countdown'): void {
  const loc = A.findFx(store.project, slotId);
  if (!loc) return;
  const moves = id === 'countdown' ? 1 : 9;
  A.editFx(slotId, id === 'countdown' ? 'Sprite sheet: Countdown' : 'Sprite sheet: Pippin', (p) => {
    p.sheet = id;
    if (typeof p.move === 'number' && p.move > moves) p.move = moves;
  });
}

/** The state's sheet name for menus. */
export function sheetLabel(s: DanceState): string {
  return s.sheet === 'countdown' ? 'Countdown' : s.sheet === 'user' ? s.sheetName || 'Custom sheet' : 'Pippin';
}
