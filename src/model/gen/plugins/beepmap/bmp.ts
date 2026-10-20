// Defensive BMP reader for BeepMap's "Import FL content..." and "Open": FL's own
// bitmaps are plain Windows BMP files (24-bit, 32-bit, or an 8-bit palette). The
// input is untrusted: every size is checked before anything is allocated, and
// anything that is not understood returns null (the caller can try the browser's
// image decoder instead).

import type { Bitmap } from './image';

/** Largest BMP accepted (pixels): bigger files are refused instead of decoded. */
const MAX_PIXELS = 1 << 25;
const MAX_SIDE = 1 << 15;

/** The contiguous run of set bits in a colour mask: [shift, bits]. */
function maskShift(mask: number): [number, number] {
  if (!mask) return [0, 0];
  let s = 0;
  while (!((mask >>> s) & 1)) s++;
  let n = 0;
  while ((mask >>> (s + n)) & 1 && s + n < 32) n++;
  return [s, n];
}

/** A channel value of `bits` bits scaled to 0..255. */
const scale8 = (v: number, bits: number): number => (bits >= 8 ? v >>> (bits - 8) : bits === 0 ? 0 : Math.round((v * 255) / ((1 << bits) - 1)));

/**
 * Decode a BMP file (BITMAPCOREHEADER, BITMAPINFOHEADER and later headers;
 * 1, 4, 8, 16, 24 and 32 bits per pixel; BI_RGB and BI_BITFIELDS; top-down or
 * bottom-up) into a Bitmap (0xRRGGBB, top row first; alpha is ignored as FL
 * does). RLE-compressed files and anything inconsistent return null.
 */
export function parseBmp(b: Uint8Array): Bitmap | null {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dataOff = dv.getUint32(10, true);
  const hs = dv.getUint32(14, true);
  let w: number, h: number, bpp: number, comp = 0, used = 0;
  let palEntry = 4;
  if (hs === 12) {
    w = dv.getUint16(18, true);
    h = dv.getUint16(20, true);
    bpp = dv.getUint16(24, true);
    palEntry = 3;
  } else if (hs >= 40 && 14 + hs <= b.length) {
    w = dv.getInt32(18, true);
    h = dv.getInt32(22, true);
    bpp = dv.getUint16(28, true);
    comp = dv.getUint32(30, true);
    used = dv.getUint32(46, true);
  } else return null;
  const topDown = h < 0;
  h = Math.abs(h);
  if (w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) return null;
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null;
  if (comp !== 0 && comp !== 3 && comp !== 6) return null;
  const stride = Math.floor((w * bpp + 31) / 32) * 4;
  if (dataOff < 14 + hs || dataOff + stride * h > b.length) return null;

  // palette (1 .. 8 bits)
  let pal: Uint32Array | null = null;
  if (bpp <= 8) {
    const n = used > 0 && used <= 1 << bpp ? used : 1 << bpp;
    const base = 14 + hs;
    if (base + n * palEntry > b.length) return null;
    pal = new Uint32Array(1 << bpp);
    for (let i = 0; i < n; i++) pal[i] = (b[base + i * palEntry + 2] << 16) | (b[base + i * palEntry + 1] << 8) | b[base + i * palEntry];
  }

  // channel masks (16 / 32 bits)
  let rM = 0, gM = 0, bM = 0;
  if (bpp === 16) { rM = 0x7c00; gM = 0x03e0; bM = 0x001f; }
  else if (bpp === 32) { rM = 0xff0000; gM = 0xff00; bM = 0xff; }
  if (comp !== 0 && (bpp === 16 || bpp === 32)) {
    const mo = hs >= 52 ? 54 : 14 + hs; // masks follow a 40-byte header, or are inside a larger one
    if (mo + 12 > b.length) return null;
    rM = dv.getUint32(mo, true); gM = dv.getUint32(mo + 4, true); bM = dv.getUint32(mo + 8, true);
  }
  const [rS, rN] = maskShift(rM), [gS, gN] = maskShift(gM), [bS, bN] = maskShift(bM);

  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = dataOff + (topDown ? y : h - 1 - y) * stride;
    const out = y * w;
    for (let x = 0; x < w; x++) {
      let c: number;
      switch (bpp) {
        case 1: c = pal![(b[row + (x >> 3)] >> (7 - (x & 7))) & 1]; break;
        case 4: c = pal![(b[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15]; break;
        case 8: c = pal![b[row + x]]; break;
        case 16: {
          const v = b[row + x * 2] | (b[row + x * 2 + 1] << 8);
          c = (scale8((v & rM) >>> rS, rN) << 16) | (scale8((v & gM) >>> gS, gN) << 8) | scale8((v & bM) >>> bS, bN);
          break;
        }
        case 24: c = (b[row + x * 3 + 2] << 16) | (b[row + x * 3 + 1] << 8) | b[row + x * 3]; break;
        default: {
          const v = dv.getUint32(row + x * 4, true);
          c = (scale8((v & rM) >>> rS, rN) << 16) | (scale8((v & gM) >>> gS, gN) << 8) | scale8((v & bM) >>> bS, bN);
        }
      }
      px[out + x] = c >>> 0;
    }
  }
  return { w, h, px };
}
