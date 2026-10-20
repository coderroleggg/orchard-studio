// Kepler / Kepler Exo FL content: the two tables FL's engine library carries (an analog-looking LFO sine of 2170
// signed 16-bit points and a recorded noise loop of 682245 points). Orchard ships synthesised stand-ins; the user
// can import FL's own tables from their FL Studio install ("Import FL content..." picks the plugin's engine.dylib,
// the same data sits in Kepler/engine.dylib and Kepler Exo/engine.dylib, in both slices of the universal binary).
// The tables are found by fingerprint (a hash of their first 16 bytes and a weighted checksum of the whole
// table), so the file is never trusted: nothing is parsed but a window scan, and a file without them gives null.

export const KP_LFO_N = 2170;
export const KP_NOISE_N = 682245;

interface Fingerprint { n: number; head: number; sum: number }
const FP_LFO: Fingerprint = { n: KP_LFO_N, head: 0x173e617c, sum: 0x490a2aa9 };
const FP_NOISE: Fingerprint = { n: KP_NOISE_N, head: 0xcf35a617, sum: 0x22eb78af };

/** FNV-1a (32 bit) of 16 bytes. */
function fnv16(b: Uint8Array, o: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < 16; i++) { h ^= b[o + i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Weighted checksum of n little-endian int16 values at byte offset o: sum of v[i] * (i + 1) mod 2^32. */
function weightedSum(b: Uint8Array, o: number, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    let v = b[o + 2 * i] | (b[o + 2 * i + 1] << 8);
    if (v & 0x8000) v -= 0x10000;
    s = (s + Math.imul(v, i + 1)) | 0;
  }
  return s >>> 0;
}

function toInt16(b: Uint8Array, o: number, n: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = (b[o + 2 * i] | (b[o + 2 * i + 1] << 8)) << 16 >> 16;
  return out;
}

/** The table of fingerprint `fp` in `b`, or null. */
function findTable(b: Uint8Array, fp: Fingerprint): Int16Array | null {
  const last = b.length - 2 * fp.n;
  for (let o = 0; o <= last; o += 2) {
    if (fnv16(b, o) !== fp.head) continue;
    if (weightedSum(b, o, fp.n) === fp.sum) return toInt16(b, o, fp.n);
  }
  return null;
}

export interface KeplerTables { lfo: Int16Array; noise: Int16Array }

/** FL's tables from the bytes of an engine library, or null when the file does not hold both. */
export function kpFindTables(file: Uint8Array): KeplerTables | null {
  if (file.length < 2 * KP_NOISE_N || file.length > (64 << 20)) return null;
  const lfo = findTable(file, FP_LFO);
  const noise = lfo ? findTable(file, FP_NOISE) : null;
  return lfo && noise ? { lfo, noise } : null;
}

const PACK_MAGIC = 0x4b5052; // 'KPR' (exact in a float)
const HEAD = 4;

/** The tables as one float pool sample: [magic, lfo length, noise length, checksum] then the points. */
export function kpPackTables(t: KeplerTables): Float32Array {
  const out = new Float32Array(HEAD + KP_LFO_N + KP_NOISE_N);
  out[0] = PACK_MAGIC; out[1] = KP_LFO_N; out[2] = KP_NOISE_N;
  let s = 0;
  for (let i = 0; i < KP_LFO_N; i++) { out[HEAD + i] = t.lfo[i]; s += t.lfo[i] * ((i % 13) + 1); }
  for (let i = 0; i < KP_NOISE_N; i++) { out[HEAD + KP_LFO_N + i] = t.noise[i]; s += t.noise[i] * ((i % 7) + 1); }
  out[3] = Math.fround(s);
  return out;
}

/** The tables back from kpPackTables' data (null when it is not such a pack, e.g. resampled by a decoder). */
export function kpUnpackTables(d: ArrayLike<number> | undefined | null): KeplerTables | null {
  if (!d || d.length < HEAD + KP_LFO_N + KP_NOISE_N) return null;
  if (d[0] !== PACK_MAGIC || d[1] !== KP_LFO_N || d[2] !== KP_NOISE_N) return null;
  const lfo = new Int16Array(KP_LFO_N), noise = new Int16Array(KP_NOISE_N);
  let s = 0;
  for (let i = 0; i < KP_LFO_N; i++) { const v = d[HEAD + i]; if (!(v >= -32768 && v <= 32767) || v !== Math.trunc(v)) return null; lfo[i] = v; s += v * ((i % 13) + 1); }
  for (let i = 0; i < KP_NOISE_N; i++) { const v = d[HEAD + KP_LFO_N + i]; if (!(v >= -32768 && v <= 32767) || v !== Math.trunc(v)) return null; noise[i] = v; s += v * ((i % 7) + 1); }
  if (Math.fround(s) !== d[3]) return null;
  return { lfo, noise };
}
