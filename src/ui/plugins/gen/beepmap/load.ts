// BeepMap's bitmap on the main thread: Open (file picker), drag and drop, Copy /
// Paste (clipboard), reset to the stand-in picture, and "Import FL content...".
//
// Every load goes through fitBitmap (FL's rules: at most "Max bitmap height"
// rows, at least 3, a taller picture is resampled) and replaces the instrument's
// bitmap in one undo step (state key `bmp`, text form: model/gen/plugins/beepmap/
// image.ts). BMP files are read by our own defensive parser first (FL's own files:
// 8-bit palettes, 24 / 32 bits); anything else (PNG, JPEG, GIF, WebP...) by the
// browser's decoder.
//
// "Import FL content..." reads the user's own FL install at run time: a preset
// file (.fst: FL's factory presets each hold their bitmap and its resampling) or
// an image file (Plugins/Fruity/Generators/BeepMap/Images/*.bmp); FL's bytes are
// only ever held in the user's own project / browser storage.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { flashHint } from '../../../hint';
import { bitmapOf, encodeBitmap, MAXH_DEFAULT, MAXH_MAX, MAXH_MIN, type Bitmap } from '../../../../model/gen/plugins/beepmap/image';
import { parseBmp } from '../../../../model/gen/plugins/beepmap/bmp';
import { fitBitmap } from '../../../../model/gen/plugins/beepmap/resize';
import { parseBeepMapFile } from '../../../../model/gen/plugins/beepmap/flstate';

/** Largest file read (bytes) and largest picture the browser decoder is asked for (pixels). */
const MAX_FILE_BYTES = 64 << 20;
const MAX_DECODE_PIXELS = 1 << 25;
const MAX_FILES = 5000;
const IMAGE_EXT = /\.(bmp|png|jpe?g|gif|webp|avif)$/i;

const paramsOf = (slotId: string): Record<string, unknown> | null => {
  const loc = A.findFx(store.project, slotId);
  return loc ? (loc.fx.params as Record<string, unknown>) : null;
};

const maxHOf = (ps: Record<string, unknown> | null): number => {
  const h = Number(ps?.maxH);
  return Number.isFinite(h) ? Math.max(MAXH_MIN, Math.min(MAXH_MAX, Math.round(h))) : MAXH_DEFAULT;
};

/** Whether a bitmap is loaded (not the stand-in picture). */
export function hasBitmap(slotId: string): boolean {
  const t = paramsOf(slotId)?.bmp;
  return typeof t === 'string' && t !== '';
}

/** The bitmap the instrument plays now (the stand-in picture while none is loaded). */
export function currentBitmap(slotId: string): Bitmap {
  return bitmapOf(paramsOf(slotId)?.bmp);
}

/** Decode an image blob: BMP by our parser, anything else by the browser. Null when it cannot be read. */
export async function decodeImage(blob: Blob): Promise<Bitmap | null> {
  if (blob.size > MAX_FILE_BYTES || blob.size < 1) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const b = parseBmp(bytes);
    if (b) return b;
  }
  if (typeof createImageBitmap !== 'function') return null;
  let bm: ImageBitmap;
  try {
    bm = await createImageBitmap(new Blob([bytes], { type: blob.type }));
  } catch {
    return null;
  }
  try {
    if (bm.width < 1 || bm.height < 1 || bm.width * bm.height > MAX_DECODE_PIXELS) return null;
    const cv = document.createElement('canvas');
    cv.width = bm.width;
    cv.height = bm.height;
    const g = cv.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(bm, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    const px = new Uint32Array(cv.width * cv.height);
    for (let i = 0; i < px.length; i++) px[i] = ((d[4 * i] << 16) | (d[4 * i + 1] << 8) | d[4 * i + 2]) >>> 0;
    return { w: cv.width, h: cv.height, px };
  } finally {
    bm.close();
  }
}

/**
 * Load a picture into the instrument (one undo step): fitted to its Max bitmap
 * height (`opts.maxH` sets it, as loading an FL preset does); a picture of fewer
 * than 3 rows is refused (FL keeps the old bitmap).
 */
export function loadBitmap(slotId: string, b: Bitmap, label: string, opts: { maxH?: number } = {}): Bitmap | null {
  const ps = paramsOf(slotId);
  if (!ps) return null;
  const fit = fitBitmap(b, opts.maxH ?? maxHOf(ps));
  if (!fit) {
    flashHint('BeepMap: a bitmap needs at least 3 rows');
    return null;
  }
  const text = encodeBitmap(fit);
  A.editFx(slotId, label, (p) => {
    p.bmp = text;
    if (opts.maxH !== undefined) p.maxH = opts.maxH;
  });
  flashHint(`BeepMap: bitmap ${fit.w} x ${fit.h}${fit.h !== b.h ? ` (from ${b.w} x ${b.h})` : ''}`);
  return fit;
}

/** Back to the stand-in picture. */
export function resetBitmap(slotId: string): void {
  A.editFx(slotId, 'Reset bitmap', (p) => { p.bmp = ''; });
  flashHint('BeepMap: the stand-in bitmap');
}

async function loadFile(slotId: string, file: File): Promise<boolean> {
  const b = await decodeImage(file);
  if (!b) {
    flashHint(`BeepMap: "${file.name}" is not an image BeepMap can read`);
    return false;
  }
  return loadBitmap(slotId, b, 'Load bitmap') !== null;
}

function pick(accept: string, multiple: boolean, folder = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple || folder;
    if (folder) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    else input.accept = accept;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** FL's OPEN: pick a picture. */
export async function openBitmap(slotId: string): Promise<void> {
  const files = await pick('image/*,.bmp', false);
  if (files[0]) await loadFile(slotId, files[0]);
}

/** FL's COPY: the bitmap to the clipboard as a PNG. */
export async function copyBitmap(slotId: string): Promise<void> {
  const b = currentBitmap(slotId);
  try {
    const cv = document.createElement('canvas');
    cv.width = b.w;
    cv.height = b.h;
    const g = cv.getContext('2d');
    if (!g) throw new Error('no canvas');
    const img = g.createImageData(b.w, b.h);
    for (let i = 0; i < b.px.length; i++) {
      const c = b.px[i];
      img.data[4 * i] = (c >>> 16) & 255; img.data[4 * i + 1] = (c >>> 8) & 255; img.data[4 * i + 2] = c & 255; img.data[4 * i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const png = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
    if (!png) throw new Error('no PNG');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    flashHint('BeepMap: bitmap copied');
  } catch {
    flashHint('BeepMap: the bitmap could not be copied (clipboard access refused)');
  }
}

/** FL's PASTE: the clipboard's picture. */
export async function pasteBitmap(slotId: string): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const b = await decodeImage(await it.getType(type));
      if (b) { loadBitmap(slotId, b, 'Paste bitmap'); return; }
    }
    flashHint('BeepMap: no picture on the clipboard');
  } catch {
    flashHint('BeepMap: the clipboard could not be read');
  }
}

/** Pictures dropped on the panel (or pasted with Ctrl+V as files). */
export async function dropFiles(slotId: string, files: ArrayLike<File>): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (IMAGE_EXT.test(f.name) || f.type.startsWith('image/')) { if (await loadFile(slotId, f)) return; }
    else if (/\.fst$/i.test(f.name)) { if ((await importFst(slotId, f)) !== null) return; }
  }
  flashHint('BeepMap: drop a picture (BMP, PNG, JPEG, GIF, WebP)');
}

// ------------------------------------------------------------ FL content

const baseName = (f: File) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, '/').split('/').pop() ?? f.name;
const stem = (s: string) => s.replace(/\.[^.]*$/, '').toLowerCase();

/** An FL preset's bitmap into the instrument; the bitmap's name for the report, null when the file holds none. */
async function importFst(slotId: string, f: File): Promise<string | null> {
  if (f.size > MAX_FILE_BYTES) return null;
  const st = parseBeepMapFile(new Uint8Array(await f.arrayBuffer()));
  const bmp = st?.bmp ? parseBmp(st.bmp) : null;
  if (!st || !bmp) return null;
  // FL's saved bitmap is within its Max bitmap height (a taller one would be resampled on loading, as FL does)
  const fit = loadBitmap(slotId, bmp, 'Import FL content', { maxH: st.maxH });
  return fit ? `${fit.w} x ${fit.h} from ${stem(baseName(f))}` : null;
}

/**
 * Import the FL content of the current preset from the picked files: the .fst
 * preset named like it (its exact bitmap), else the image named like it (resampled
 * to the Max bitmap height, as FL does), else, when one file was picked, that file.
 * A new instance (no preset yet) looks for what FL inserts: Plugin database's
 * BeepMap.fst, then Default.
 */
export async function importFlContent(slotId: string, files: File[]): Promise<string> {
  const ps = paramsOf(slotId);
  if (!ps) return 'BeepMap: no instrument';
  const preset = typeof ps.__preset === 'string' ? ps.__preset : '';
  const names = preset ? [preset.toLowerCase()] : ['beepmap', 'default'];
  const list = files.slice(0, MAX_FILES).filter((f) => /\.(fst|bmp|png|jpe?g|gif|webp)$/i.test(f.name));
  if (!list.length) return 'BeepMap: no FL preset (.fst) or bitmap among the picked files';
  const named = (ext: RegExp) => {
    for (const n of names) {
      const f = list.find((x) => ext.test(x.name) && stem(baseName(x)) === n);
      if (f) return f;
    }
    return undefined;
  };
  const fst = named(/\.fst$/i);
  if (fst) {
    const r = await importFst(slotId, fst);
    if (r) return `BeepMap: imported ${r}`;
  }
  const img = named(/\.(bmp|png|jpe?g|gif|webp)$/i);
  const only = list.length === 1 ? list[0] : undefined;
  const f = img ?? only;
  if (f) {
    if (/\.fst$/i.test(f.name)) {
      const r = await importFst(slotId, f);
      return r ? `BeepMap: imported ${r}` : `BeepMap: "${f.name}" holds no bitmap`;
    }
    return (await loadFile(slotId, f)) ? `BeepMap: imported "${f.name}"` : `BeepMap: "${f.name}" could not be read`;
  }
  return `BeepMap: no file named "${preset || 'BeepMap'}" among the picked files`;
}

/** The menu action: pick FL's BeepMap preset folder (or files) and import the current preset's bitmap. */
export async function runImport(slotId: string, mode: 'folder' | 'files'): Promise<void> {
  const files = await pick('.fst,.bmp,.png,.jpg,.jpeg,.gif,.webp', true, mode === 'folder');
  if (!files.length) return;
  flashHint('BeepMap: importing FL content...');
  try {
    flashHint(await importFlContent(slotId, files));
  } catch {
    flashHint('BeepMap: the FL content could not be imported');
  }
}
