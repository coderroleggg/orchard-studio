// GMS's oscillator tables (FL 2026 GMS_x64 0x17270): a wave file is read (channel 0),
// resampled to 1024 points with 4-point Hermite interpolation (point i reads around
// frames x i / 1024, between samples k + 1 and k + 2 of the four from k), transformed
// (vDSP complex FFT: magnitude / 1024 and phase of harmonics 0..512), and 512 band-limited
// levels are built: level k holds harmonics 1..k + 1 (DC dropped) as a cosine sum, each
// level the previous plus one harmonic. The oscillator picks level trunc(sr / 2f) (511 at
// most). The waves are FL content ("Synth Waves" folder): Orchard synthesizes stand-ins under
// the same names, and the user can import FL's files (plugin menu), which reach the engine
// as pool samples; tables are cached per wave.

import { f32 } from '../poizone/dsp';

export const GMS_LEVELS = 512;
export const GMS_TABLE = 1024;

/** Hermite read of x around position k + frac (FL 0x22ec0: samples k .. k + 3, 0 past the end). */
function hermite(x: Float32Array, k: number, fr: number): number {
  const n = x.length;
  if (k >= n) return 0;
  const y0 = x[k], y1 = k + 1 < n ? x[k + 1] : 0, y2 = k + 2 < n ? x[k + 2] : 0, y3 = k + 3 < n ? x[k + 3] : 0;
  const c1 = f32(f32(y2 - y0) * 0.5);
  const c3 = f32(f32(y3 - y0) * 0.5 + f32(f32(y1 - y2) * 1.5));
  const c2 = f32(f32(y0 + c1) - f32(y1 + c3));
  let r = f32(c3 * fr + c2);
  r = f32(r * fr + c1);
  return f32(r * fr + y1);
}

/** The 1024-point cycle FL analyses (from a wave of any length). */
export function gmsResample(x: Float32Array): Float32Array {
  const out = new Float32Array(GMS_TABLE);
  const step = x.length * 0.0009765625;
  for (let i = 0; i < GMS_TABLE; i++) {
    const p = i * step;
    const k = Math.trunc(p);
    out[i] = hermite(x, k, f32(p - k));
  }
  return out;
}

/** Magnitude / N and phase of harmonics 0..512 (double DFT; FL uses vDSP in float). */
function spectrum(c: Float32Array): { mag: Float32Array; ph: Float32Array } {
  const N = GMS_TABLE, H = N / 2;
  const mag = new Float32Array(H + 1), ph = new Float32Array(H + 1);
  const cs = new Float64Array(N), sn = new Float64Array(N);
  for (let j = 0; j < N; j++) { cs[j] = Math.cos((2 * Math.PI * j) / N); sn[j] = Math.sin((2 * Math.PI * j) / N); }
  for (let h = 0; h <= H; h++) {
    let re = 0, im = 0;
    for (let j = 0, q = 0; j < N; j++, q = (q + h) & (N - 1)) { re += c[j] * cs[q]; im -= c[j] * sn[q]; }
    mag[h] = f32(Math.hypot(re, im) / N);
    ph[h] = f32(Math.atan2(im, re));
  }
  return { mag, ph };
}

/** The 512 x 1024 band-limited levels of a wave (FL's cumulative cosine sums). */
export function gmsBuildTable(wave: Float32Array): Float32Array {
  const c = gmsResample(wave);
  const { mag, ph } = spectrum(c);
  const out = new Float32Array(GMS_LEVELS * GMS_TABLE);
  const buf = new Float32Array(GMS_TABLE);
  for (let lv = 0; lv < GMS_LEVELS; lv++) {
    const h = lv + 1;
    const w = f32(h) * 0.006135923151542565;
    const a = mag[h], b = ph[h];
    if (a !== 0) for (let j = 0; j < GMS_TABLE; j++) buf[j] = f32(buf[j] + Math.cos(b + j * w) * a);
    out.set(buf, lv * GMS_TABLE);
  }
  return out;
}

// ------------------------------------------------------------------ stand-ins for FL's Synth Waves
const N = GMS_TABLE;
function additive(amps: (k: number) => number, phs: (k: number) => number, K = 200): Float32Array {
  const x = new Float32Array(N);
  for (let k = 1; k <= K; k++) {
    const a = amps(k);
    if (!a) continue;
    const p = phs(k);
    for (let i = 0; i < N; i++) x[i] += a * Math.sin((2 * Math.PI * k * i) / N + p);
  }
  let pk = 0;
  for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(x[i]));
  if (pk > 0) for (let i = 0; i < N; i++) x[i] = f32((x[i] / pk) * 0.9);
  return x;
}
function seeded(name: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; };
}

/** A synthesized stand-in for one of FL's Synth Waves (by file name). */
export function gmsSubstitute(name: string): Float32Array {
  const base = name.replace(/\.(wav|aif|aiff|wv|ogg)$/i, '').toLowerCase();
  const sawA = (k: number) => 1 / k;
  const zero = () => 0;
  switch (base) {
    case 'sine': return additive((k) => (k === 1 ? 1 : 0), zero, 1);
    case 'saw': return additive(sawA, () => Math.PI);
    case 'saw retro': return additive((k) => (1 / k) * Math.exp(-k / 40), () => Math.PI);
    case 'saw mean': return additive((k) => (1 / k) * (1 + 0.6 * Math.sin(k * 0.7)), (k) => Math.PI + k * 0.1);
    case 'square': return additive((k) => (k % 2 ? 1 / k : 0), zero);
    case 'square retro': return additive((k) => (k % 2 ? (1 / k) * Math.exp(-k / 30) : 0.04 / k), zero);
    case 'square smooth': return additive((k) => (k % 2 ? (1 / k) * Math.exp(-k / 12) : 0), zero);
    case 'triangle': return additive((k) => (k % 2 ? 1 / (k * k) : 0), (k) => (((k - 1) / 2) % 2 ? Math.PI : 0) + Math.PI / 2);
    case 'smooth sub': return additive((k) => (k === 1 ? 1 : k === 2 ? 0.25 : k === 3 ? 0.08 : 0), zero, 3);
    default: {
      // a deterministic spectrum per name: a saw-like slope with formant bumps
      const rnd = seeded(base);
      const f1 = 2 + rnd() * 10, f2 = 8 + rnd() * 30, slope = 0.6 + rnd() * 0.9, odd = rnd() < 0.35;
      const ph = Array.from({ length: 201 }, () => rnd() * 2 * Math.PI);
      return additive(
        (k) => (odd && k % 2 === 0 ? 0.2 : 1) * Math.pow(k, -slope) * (1 + 1.5 * Math.exp(-((k - f1) ** 2) / 6) + Math.exp(-((k - f2) ** 2) / 40)),
        (k) => ph[k],
      );
    }
  }
}

/** FL's Synth Waves file names (the stand-ins cover all of them). */
export const GMS_SYNTH_WAVES = [
  'Beast.wav', 'Crunch.wav', 'Digital.wav', 'Dirt.wav', 'Double Spike.wav', 'Electro.wav', 'Filth.wav', 'Fox.wav', 'Funky.wav',
  'Grubby.wav', 'Keys.wav', 'Liquid.wav', 'Ogre.wav', 'Rhodes.wav', 'Saw Mean.wav', 'Saw Retro.wav', 'Saw.wav', 'Silk.wav',
  'Sine.wav', 'Smooth Sub.wav', 'Square Retro.wav', 'Square Smooth.wav', 'Square.wav', 'Strat.wav', 'String.wav', 'Throat.wav',
  'Triangle.wav', 'Troll.wav', 'Vocal.wav',
];

const cache = new Map<string, Float32Array>();
/** Cached tables by key (wave name or pool sample id). */
export function gmsTable(key: string, make: () => Float32Array): Float32Array {
  let t = cache.get(key);
  if (!t) {
    t = gmsBuildTable(make());
    cache.set(key, t);
    if (cache.size > 24) cache.delete(cache.keys().next().value as string);
  }
  return t;
}
