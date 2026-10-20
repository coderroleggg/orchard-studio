// BooBass tables, built the way FL's engine builds them at load time
// (BooBass_Eng_x64.dylib, WaveTable::Create 0x262c, readfile 0x254c,
// WaveTable::ConvertSnip 0x246c), from 12 PCM tables: six pluck "strikes"
// (16 kHz recordings, one per zone B0, E1, B1, E2, B2, E3) and six single
// cycles, one per zone. FL embeds those recordings in its binary; Orchard
// never ships them: the engine gets them from the user's own FL install
// (imported into the sample pool, see packFlData / unpackFlData) or uses the
// synthesized substitutes of ./synth.ts.

import { f, fma32, u2f } from './f32';
import { exp10f } from './libm';

/** Wavetable length (points per cycle). */
export const WT_LEN = 16384;
/** Distance between two zones' wavetables in FL's shared buffer: 4 padding + 16384 + 4 padding. */
export const WT_STRIDE = 16392;
export const ZONES = 6;

/** Strike level per zone (dB below the recording, x 0.5): FL's table at 0x3cd0. */
const STRIKE_DB = [0x3f2a7efa, 0xbeaa7efa, 0xbf400000, 0xbfc00000, 0xc0000000, 0xc0400000].map(u2f);
/** Single-cycle level per zone (dB below, x -0.5 in ConvertSnip): FL's table at 0x3ce8. */
const WAVE_DB = [0x40800000, 0x40600000, 0x40400000, 0x40500000, 0x40600000, 0x40400000].map(u2f);
const M005 = u2f(0xbd4ccccd); // -0.05

/** The 12 source tables as 16-bit sample values (FL's PcmFile data). */
export interface BooPcm {
  /** Strikes per zone (16 kHz), int16 values. */
  strikes: ArrayLike<number>[];
  /** Single cycles per zone, int16 values. */
  waves: ArrayLike<number>[];
}

/** What the engine plays from: FL's six wavetables and six strikes. */
export interface BooTables {
  /** FL's shared wavetable buffer: zone z's table starts at 4 + z * WT_STRIDE, with 4 wrapped values on either side. */
  waves: Float32Array;
  /** Per zone: FL's readfile buffer (4 copies of the first value, the data, 4 copies of the last); data starts at index 4. */
  strikes: Float32Array[];
  /** Samples per strike (FL's strikeLen). */
  strikeLen: Int32Array;
  /** The source tables (FL keeps them in memory; its period table lookup below key 36 reads them). */
  pcm: BooPcm;
}

/**
 * FL's readfile: int16 -> float x 2^-15 into a buffer with 4 copies of the
 * first value before and 4 copies of the last after the data.
 */
function readfile(src: ArrayLike<number>): Float32Array {
  const n = src.length;
  const b = new Float32Array(n + 8);
  for (let i = 0; i < n; i++) b[4 + i] = f(src[i] * 3.0517578125e-5);
  for (let k = 0; k < 4; k++) { b[k] = b[4]; b[n + 4 + k] = b[n + 3]; }
  return b;
}

/**
 * FL's WaveTable::ConvertSnip: resample one cycle of `len` samples to 16384
 * points (circular 4-point cubic, FL's float32 operation order), then scale by
 * -0.5 x gain.
 */
function convertSnip(src: Float32Array, off: number, len: number, dst: Float32Array, dOff: number, gain: number): void {
  const step = f(len * 6.103515625e-5);
  let pos = 0;
  for (let i = 0; i < WT_LEN; i++) {
    const w9 = pos | 0;
    const fr = f(pos - Math.trunc(pos));
    const x0 = src[off + w9];
    const x1 = src[off + (w9 + 1) % len];
    const xm1 = src[off + (w9 === 0 ? len : w9) - 1];
    const c1 = f(f(x1 - xm1) * 0.5);
    const x2 = src[off + (w9 + 2) % len];
    const t22 = f(x2 - xm1);
    const t23 = f(f(x0 - x1) * 1.5);
    const c3 = fma32(t22, 0.5, t23);
    const t19 = fma32(x0, -2.5, xm1);
    const t18 = fma32(x1, 2, t19);
    const c2 = fma32(x2, -0.5, t18);
    let t = fma32(c3, fr, c2);
    pos = f(pos + step);
    t = fma32(t, fr, c1);
    dst[dOff + i] = fma32(t, fr, x0);
  }
  if (gain !== 0) {
    const g = f(gain * -0.5);
    for (let i = 0; i < WT_LEN; i++) dst[dOff + i] = f(dst[dOff + i] * g);
  }
}

/** Build the engine tables from the 12 PCM tables (FL's WaveTable::Create, first instance). */
export function buildTables(pcm: BooPcm): BooTables {
  const strikes: Float32Array[] = [];
  const strikeLen = new Int32Array(ZONES);
  for (let z = 0; z < ZONES; z++) {
    const b = readfile(pcm.strikes[z]);
    const n = pcm.strikes[z].length;
    strikeLen[z] = n;
    const g = f(exp10f(f(STRIKE_DB[z] * M005)) * 0.5);
    // FL scales the first n values of the buffer from its start (the 4 leading copies included),
    // so the last 4 data values and the trailing copies keep the recording's level
    for (let i = 0; i < n; i++) b[i] = f(g * b[i]);
    strikes.push(b);
  }
  const waves = new Float32Array(ZONES * WT_STRIDE + 24);
  for (let z = 0; z < ZONES; z++) {
    const src = readfile(pcm.waves[z]);
    const base = 4 + z * WT_STRIDE;
    convertSnip(src, 4, pcm.waves[z].length, waves, base, exp10f(f(WAVE_DB[z] * M005)));
    for (let k = 0; k < 4; k++) {
      waves[base - 4 + k] = waves[base + WT_LEN - 4 + k];
      waves[base + WT_LEN + k] = waves[base + k];
    }
  }
  return { waves, strikes, strikeLen, pcm };
}

// ------------------------------------------------------------------ pool packing
// The tables imported from the user's FL install travel through the sample
// pool as one mono "sample" of 16-bit values (x / 32768): a header (magic,
// version, the 12 lengths in two 14-bit digits each), then the strikes and the
// single cycles. Decoding rounds every value to the 16-bit grid, so the pool's
// 24-bit WAV storage (dithered) and float copies give the exact data back.

const MAGIC = [0x4242, 0x0b05, 0x7a11, 0x1e55];
const VERSION = 1;
const HEADER = MAGIC.length + 2 + 2 * 2 * ZONES;
/** Largest table the pack (and the engine's tables) accept, in samples. */
export const MAX_TABLE = 1 << 18;

export function packFlData(pcm: BooPcm): Float32Array {
  const all = [...pcm.strikes, ...pcm.waves];
  let total = HEADER;
  for (const t of all) total += t.length;
  const out = new Float32Array(total);
  let o = 0;
  const put = (v: number) => { out[o++] = v / 32768; };
  for (const m of MAGIC) put(m);
  put(VERSION);
  put(ZONES);
  for (const t of all) { put(t.length >> 14); put(t.length & 0x3fff); }
  for (const t of all) for (let i = 0; i < t.length; i++) put(t[i]);
  return out;
}

/** The PCM tables of a pool sample made by packFlData; null when it is not one (or damaged). */
export function unpackFlData(d: Float32Array | undefined): BooPcm | null {
  if (!d || d.length < HEADER) return null;
  let o = 0;
  const get = () => Math.max(-32768, Math.min(32767, Math.round(d[o++] * 32768)));
  for (const m of MAGIC) if (get() !== m) return null;
  if (get() !== VERSION || get() !== ZONES) return null;
  const lens: number[] = [];
  let total = HEADER;
  for (let i = 0; i < 2 * ZONES; i++) {
    const hi = get(), lo = get();
    const n = hi * 16384 + lo;
    if (hi < 0 || lo < 0 || n < 4 || n > MAX_TABLE) return null;
    lens.push(n);
    total += n;
  }
  if (d.length < total) return null;
  const tabs: Int16Array[] = lens.map((n) => {
    const t = new Int16Array(n);
    for (let i = 0; i < n; i++) t[i] = get();
    return t;
  });
  return { strikes: tabs.slice(0, ZONES), waves: tabs.slice(ZONES) };
}
