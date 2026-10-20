// Sawer's oscillator tables. FL loads one cycle of its saw (8192 floats) from the plugin
// folder's data.saw into table 1 and derives table 2 (the "square" of the sub oscillator)
// as table1[i] - table1[(i + 4096) mod 8192]. data.saw is FL content: by default the
// engine uses a synthesized stand-in with the same layout and a similar shape (a rounded
// analog-style descending ramp ending at -1); the user can import FL's own file from their
// FL install (plugin menu), which reaches the engine as a pool sample (txPack-style pack).

export const SW_TABLE_SIZE = 8192;

let substitute: Float32Array | null = null;

/** The stand-in for data.saw: band-limited, slowly rising, falling quickly to -1 at the cycle's end. */
export function swSubstituteTable(): Float32Array {
  if (substitute) return substitute;
  const n = SW_TABLE_SIZE;
  const t = new Float32Array(n);
  // additive: a 1/k ramp with a softened top end, phase-shifted like an RC-loaded analog saw
  const K = 160;
  for (let k = 1; k <= K; k++) {
    const amp = (k === 1 ? 0.26 : k === 2 ? 0.22 : 0.25 / k) * Math.exp(-k / 120);
    const ph = (k === 1 ? -175 : k === 2 ? -124 : -110 + Math.min(10, k)) * (Math.PI / 180);
    const w = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) t[i] += amp * Math.cos(w * i + ph);
  }
  let lo = Infinity, hi = -Infinity, mean = 0;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, t[i]); hi = Math.max(hi, t[i]); mean += t[i]; }
  mean /= n;
  // scale so the minimum is -1 (FL's file spans about -1 .. 0.22)
  const s = 1 / (mean - lo);
  for (let i = 0; i < n; i++) t[i] = Math.fround((t[i] - mean) * s - 0.054);
  substitute = t;
  return t;
}

/** Table 2 from table 1 (FL: t1[i] - t1[(i + 4096) & 8191], four at a time). */
export function swDerivedTable(t1: Float32Array): Float32Array {
  const n = SW_TABLE_SIZE, h = n >> 1;
  const t2 = new Float32Array(n);
  for (let i = 0; i < n; i++) t2[i] = Math.fround(t1[i] - t1[(i + h) & (n - 1)]);
  return t2;
}

const PACK_MAGIC = 1398233425; // 'SAWQ'

/** data.saw as a pool-sample pack: magic, size, checksum, then the 8192 floats. */
export function swPackTable(t: Float32Array): Float32Array {
  const out = new Float32Array(4 + SW_TABLE_SIZE);
  out[0] = PACK_MAGIC; out[1] = SW_TABLE_SIZE;
  let s = 0;
  for (let i = 0; i < SW_TABLE_SIZE; i++) { out[4 + i] = t[i]; s += t[i]; }
  out[2] = Math.fround(s);
  return out;
}

/** The table back from swPackTable's data (null when it is not such a pack, e.g. resampled by a decoder). */
export function swUnpackTable(d: Float32Array | undefined | null): Float32Array | null {
  if (!d || d.length < 4 + SW_TABLE_SIZE) return null;
  if (d[0] !== Math.fround(PACK_MAGIC) || d[1] !== SW_TABLE_SIZE) return null;
  const t = d.slice(4, 4 + SW_TABLE_SIZE);
  let s = 0;
  for (let i = 0; i < SW_TABLE_SIZE; i++) { const v = t[i]; if (!(v >= -4 && v <= 4)) return null; s += v; }
  return Math.fround(s) === d[2] ? t : null;
}

/** Parse the user's data.saw (exactly 8192 little-endian floats, all finite and bounded); null otherwise. */
export function swParseDataSaw(buf: ArrayBuffer): Float32Array | null {
  if (buf.byteLength !== SW_TABLE_SIZE * 4) return null;
  const dv = new DataView(buf);
  const t = new Float32Array(SW_TABLE_SIZE);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < SW_TABLE_SIZE; i++) {
    const v = dv.getFloat32(i * 4, true);
    if (!Number.isFinite(v) || Math.abs(v) > 4) return null;
    t[i] = v;
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return hi - lo > 0.1 ? t : null;
}
