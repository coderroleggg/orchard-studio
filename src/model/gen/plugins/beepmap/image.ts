// BeepMap's bitmap: the picture the instrument plays (FL's BeepMap keeps a
// 32-bit bitmap in its state, saved inside the FLP / FST). Here a bitmap is a
// small value type, a stand-in picture drawn by code (FL's own bitmaps are FL
// content: never shipped), and the text form it has in the instrument's state.
//
// State key `bmp`: "<w>x<h>:<base64>", the pixels row by row, top row first, 3
// bytes (R, G, B) each (FL ignores the alpha byte); '' = the stand-in picture.
// It lives in the plugin state, not in the sample pool: the pool decodes user
// samples with the session's audio context, which may resample (a 44.1 kHz
// float file decoded at 48 kHz would no longer hold the exact pixel values),
// and a picture is only tens of kilobytes (FL stores it in the project too).

/** A picture: `px[y * w + x]` = 0xRRGGBB, row 0 at the top (the highest pitch). */
export interface Bitmap {
  w: number;
  h: number;
  px: Uint32Array;
}

/** Largest bitmap accepted (columns, rows, pixels); FL's own limits are not known (rows: the Max bitmap height wheel's 999). */
export const MAX_W = 8192;
export const MAX_H = 999;
export const MAX_PIXELS = 1 << 21;

/** FL's "Max bitmap height" wheel (HeightSelect: 3..999, default 23). */
export const MAXH_MIN = 3;
export const MAXH_MAX = 999;
export const MAXH_DEFAULT = 23;

export function validSize(w: number, h: number): boolean {
  return Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1 && w <= MAX_W && h <= MAX_H && w * h <= MAX_PIXELS;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

const inv = (code: number): number => (code < 128 ? B64_INV[code] : -1);

/** The text form of a bitmap for the instrument's state (see the header): one base64 group (4 characters) per pixel. */
export function encodeBitmap(b: Bitmap): string {
  const n = b.w * b.h;
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < n; i++) {
    const v = b.px[i] & 0xffffff;
    chunk += B64[v >>> 18] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63] + B64[v & 63];
    if (chunk.length >= 16384) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return `${b.w}x${b.h}:${parts.join('')}`;
}

/** The bitmap of a state's `bmp` text; null when it is empty, damaged or out of range. */
export function decodeBitmap(text: unknown): Bitmap | null {
  if (typeof text !== 'string' || text.length < 5 || text.length > 4 * MAX_PIXELS + 32) return null;
  const colon = text.indexOf(':');
  const x = text.indexOf('x');
  if (colon < 0 || x < 1 || x > colon) return null;
  const w = Number(text.slice(0, x)), h = Number(text.slice(x + 1, colon));
  // FL refuses fewer than 3 rows (its loader keeps the old bitmap)
  if (!validSize(w, h) || h < MAXH_MIN || text.length - colon - 1 !== w * h * 4) return null;
  const px = new Uint32Array(w * h);
  let o = colon + 1;
  for (let i = 0; i < w * h; i++, o += 4) {
    const a = inv(text.charCodeAt(o)), b = inv(text.charCodeAt(o + 1)), c = inv(text.charCodeAt(o + 2)), d = inv(text.charCodeAt(o + 3));
    if ((a | b | c | d) < 0) return null;
    px[i] = ((a << 18) | (b << 12) | (c << 6) | d) >>> 0;
  }
  return { w, h, px };
}

const rgb = (r: number, g: number, b: number) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);

let standin: Bitmap | null = null;

/**
 * The picture BeepMap plays while no bitmap is loaded (and for a bitmap sample
 * that is missing or damaged): an original drawing in the spirit of FL's default
 * (a landscape of glides), 300 x 23: a bright yellow band that climbs and falls
 * (equal red and green: centred), a red glide rising on the left and a green
 * glide falling on the right, a low drone, and a little blue where the bands
 * meet (Use Blue narrows the frequency range there).
 */
export function standinBitmap(): Bitmap {
  if (standin) return standin;
  const w = 300, h = 23;
  const px = new Uint32Array(w * h);
  const bump = (y: number, c: number, s: number) => Math.exp(-((y - c) * (y - c)) / (s * s));
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1);
    // bright band: rises over the first third, then slides down
    const cA = 17 - 11 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 4 * t;
    const aA = 1.1 * Math.min(1, t * 6) * Math.min(1, (1 - t) * 8 + 0.15);
    // red glide (left channel) rising, green glide (right channel) falling
    const cR = 20 - 12 * t;
    const cG = 6 + 11 * t;
    const fade = Math.sin(Math.PI * Math.min(1, t * 1.05));
    for (let y = 0; y < h; y++) {
      const a = aA * bump(y, cA, 1.25);
      const r = a + 1.0 * fade * bump(y, cR, 1.15) + 0.6 * bump(y, 22, 0.7) * (0.4 + 0.6 * t);
      const g = a + 1.0 * fade * bump(y, cG, 1.15) + 0.6 * bump(y, 22, 0.7) * (1 - 0.6 * t);
      const b = 0.55 * Math.sqrt(bump(y, cA, 2.6) * bump(y, (cR + cG) / 2, 3.2));
      px[y * w + x] = rgb(Math.round(Math.min(1, r) * 255), Math.round(Math.min(1, g) * 255), Math.round(Math.min(1, b) * 255));
    }
  }
  standin = { w, h, px };
  return standin;
}

/** The bitmap of a state's `bmp` text, or the stand-in picture. */
export function bitmapOf(text: unknown): Bitmap {
  return decodeBitmap(text) ?? standinBitmap();
}
