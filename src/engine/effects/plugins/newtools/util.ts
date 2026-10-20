// Shared helpers for Newtone / Newtime (pure TS: runs in the editor, in the
// editors' Web Worker and in Node tests): anti-alias decimation, medians,
// interpolation, a compact base64 codec for analysis tracks stored in the
// plugin state, and a string hash for edit fingerprints.

/** Windowed-sinc low-pass FIR (Blackman), normalised cutoff fc in cycles/sample (0..0.5). */
export function lowpassKernel(fc: number, taps: number): Float32Array {
  const n = taps | 1;
  const h = new Float32Array(n);
  const m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = i - m;
    const s = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = s * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

/** Low-pass and keep every `factor`-th sample (output[i] ~ x[i * factor]). */
export function decimate(x: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return x;
  const taps = 8 * factor + 1;
  const h = lowpassKernel(0.45 / factor, taps);
  const m = (taps - 1) >> 1;
  const n = Math.floor(x.length / factor);
  const y = new Float32Array(n);
  const len = x.length;
  for (let i = 0; i < n; i++) {
    const c = i * factor;
    let s = 0;
    const j0 = Math.max(0, c - m), j1 = Math.min(len - 1, c + m);
    for (let j = j0; j <= j1; j++) s += x[j] * h[j - c + m];
    y[i] = s;
  }
  return y;
}

/** Mono mix of up to two channels. */
export function monoMix(ch: Float32Array[]): Float32Array {
  if (ch.length === 1) return ch[0];
  const a = ch[0], b = ch[1];
  const n = Math.min(a.length, b.length);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = 0.5 * (a[i] + b[i]);
  return y;
}

export function median(v: ArrayLike<number>, a = 0, z = v.length): number {
  const n = z - a;
  if (n <= 0) return NaN;
  const t: number[] = [];
  for (let i = a; i < z; i++) t.push(v[i]);
  t.sort((p, q) => p - q);
  return n & 1 ? t[n >> 1] : 0.5 * (t[(n >> 1) - 1] + t[n >> 1]);
}

/** Linear interpolation of a frame track at a fractional frame position (clamped). */
export function trackAt(v: ArrayLike<number>, pos: number): number {
  const n = v.length;
  if (n === 0) return 0;
  if (pos <= 0) return v[0];
  if (pos >= n - 1) return v[n - 1];
  const i = Math.floor(pos), f = pos - i;
  return v[i] + (v[i + 1] - v[i]) * f;
}

/** Cubic (Catmull-Rom) read of a buffer at a fractional index; zero outside. */
export function readCubic(x: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  const n = x.length;
  const xm1 = i - 1 >= 0 && i - 1 < n ? x[i - 1] : 0;
  const x0 = i >= 0 && i < n ? x[i] : 0;
  const x1 = i + 1 >= 0 && i + 1 < n ? x[i + 1] : 0;
  const x2 = i + 2 >= 0 && i + 2 < n ? x[i + 2] : 0;
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

/** Hz <-> MIDI cents (A4 = 440 Hz = 6900). */
export const hzToCents = (hz: number): number => 6900 + 1200 * Math.log2(hz / 440);
export const centsToHz = (c: number): number => 440 * Math.pow(2, (c - 6900) / 1200);

// ------------------------------------------------------------------ base64
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function bytesToB64(b: Uint8Array): string {
  let s = '';
  const n = b.length;
  let i = 0;
  const parts: string[] = [];
  for (; i + 2 < n; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (s.length > 8192) { parts.push(s); s = ''; }
  }
  if (i < n) {
    const v = (b[i] << 16) | ((i + 1 < n ? b[i + 1] : 0) << 8);
    s += B64[v >> 18] + B64[(v >> 12) & 63] + (i + 1 < n ? B64[(v >> 6) & 63] : '=') + '=';
  }
  parts.push(s);
  return parts.join('');
}

export function b64ToBytes(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s[len - 1] === '=') len--;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64I[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < out.length) out[o++] = (acc >> bits) & 255;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** Int16 track -> base64 (little endian). */
export function i16ToB64(v: ArrayLike<number>): string {
  const b = new Uint8Array(v.length * 2);
  for (let i = 0; i < v.length; i++) {
    const x = Math.max(-32768, Math.min(32767, Math.round(v[i]))) & 0xffff;
    b[2 * i] = x & 255;
    b[2 * i + 1] = x >> 8;
  }
  return bytesToB64(b);
}

export function b64ToI16(s: string): Int16Array {
  const b = b64ToBytes(s);
  const n = b.length >> 1;
  const v = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = b[2 * i] | (b[2 * i + 1] << 8);
    v[i] = x >= 32768 ? x - 65536 : x;
  }
  return v;
}

/** 32-bit FNV-1a hash of a string, as 8 hex digits. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Deterministic pseudo random sequence (xorshift32), 0..1. */
export function rng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1000003) / 1000003;
  };
}

/** Generator driver: run to completion synchronously (worker / tests). */
export function runSync<T>(g: Generator<number, T, void>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
