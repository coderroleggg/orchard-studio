// BeepMap's own state format (FL's SaveRestoreState, BeepMap_x64.dylib 0x5df70),
// read for "Import FL content...": FL's factory presets are .fst files (an FL
// event file whose event 213 holds the plugin state) and every one of them
// carries its bitmap, which is FL content: it is read from the user's own FL
// install at run time and never shipped.
//
//   int32 version (0 or 1)
//   int32 x 15: FREQ, LENGTH, scale, blue, grainy, loop, widen, 7 reserved
//               (read as part of the state, unused), Max bitmap height
//   version 1 only: 91 integers of INS settings (the channel's INS tab here)
//   int32 n, then n bytes: the bitmap, a BMP file (FL writes 32 bits)
//
// Version 0 (the factory presets) has no Widen of its own: the integer that
// would hold it is 0 in them. The input is untrusted: every length is checked.

import { MAXH_DEFAULT, MAXH_MAX, MAXH_MIN } from './image';

/** Largest state accepted (bytes). */
export const MAX_STATE_BYTES = 64 << 20;

export interface BeepMapFlState {
  version: number;
  /** Parameters by state key, clamped to FL's ranges. */
  params: { freq: number; length: number; scale: number; blue: number; grainy: number; loop: number; widen: number };
  /** FL's "Max bitmap height". */
  maxH: number;
  /** The embedded BMP file (a view into the input), null when absent. */
  bmp: Uint8Array | null;
}

/**
 * The plugin state of an FL event file (.fst preset: FLhd header, FLdt chunk,
 * event 213 = plugin data); a raw state blob is returned as is. Null when the
 * file holds no plugin state.
 */
export function flPluginState(file: Uint8Array): Uint8Array | null {
  if (file.length > MAX_STATE_BYTES) return null;
  const tag = (o: number) => String.fromCharCode(file[o], file[o + 1], file[o + 2], file[o + 3]);
  if (file.length < 8 || tag(0) !== 'FLhd') return file;
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let p = 8 + dv.getUint32(4, true);
  if (p + 8 > file.length || tag(p) !== 'FLdt') return null;
  const end = Math.min(file.length, p + 8 + dv.getUint32(p + 4, true));
  p += 8;
  let blob: Uint8Array | null = null;
  while (p < end) {
    const ev = file[p++];
    let n: number;
    if (ev < 64) n = 1;
    else if (ev < 128) n = 2;
    else if (ev < 192) n = 4;
    else {
      n = 0;
      for (let sh = 0; ; sh += 7) {
        if (p >= end || sh > 28) return blob;
        const b = file[p++];
        n += (b & 0x7f) * 2 ** sh;
        if (!(b & 0x80)) break;
      }
    }
    if (p + n > end) return blob;
    if (ev === 213) blob = file.subarray(p, p + n);
    p += n;
  }
  return blob;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Parse a BeepMap state blob; null when it is not one (unknown version, too short). */
export function parseBeepMapState(blob: Uint8Array): BeepMapFlState | null {
  if (blob.length < 64 || blob.length > MAX_STATE_BYTES) return null;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const version = dv.getInt32(0, true);
  if (version !== 0 && version !== 1) return null;
  const i = (k: number) => dv.getInt32(4 * k, true);
  const params = {
    freq: clamp(i(1), 24, 9600),
    length: clamp(i(2), 0, 4096),
    scale: clamp(i(3), 0, 2),
    blue: i(4) ? 1 : 0,
    grainy: i(5) ? 1 : 0,
    loop: i(6) ? 1 : 0,
    widen: i(7) ? 1 : 0,
  };
  const maxH = clamp(i(15), MAXH_MIN, MAXH_MAX);
  // the bitmap follows the 15 integers (version 0) or the 106 of the INS block (version 1)
  const at = version === 0 ? 64 : 4 + 0x1a8;
  let bmp: Uint8Array | null = null;
  if (blob.length >= at + 4) {
    const n = dv.getInt32(at, true);
    if (n > 0 && at + 4 + n <= blob.length) bmp = blob.subarray(at + 4, at + 4 + n);
  }
  return { version, params, maxH: Number.isFinite(maxH) ? maxH : MAXH_DEFAULT, bmp };
}

/** Parse a .fst file or a raw state blob. */
export function parseBeepMapFile(file: Uint8Array): BeepMapFlState | null {
  const blob = flPluginState(file);
  return blob ? parseBeepMapState(blob) : null;
}
