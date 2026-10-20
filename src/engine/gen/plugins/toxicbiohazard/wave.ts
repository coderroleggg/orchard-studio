// Toxic Biohazard waveforms, ported from FL 2026's Toxic Biohazard plugin:
// every waveform (6 operators, 2 LFOs) is 128 harmonics (amplitude, phase in
// cycles); FL sums them into 128 band-limited single-cycle tables of 256
// samples (table j keeps harmonics 1..128 - j) with Catmull-Rom coefficients
// per sample (c0..c3, cubic in the fraction). The operators pick the table
// whose highest harmonic stays below half the sample rate; the LFOs read the
// full table.
// Built-in shapes 1..5 are FL's formulas (exact). Shapes 6..32 are FL's
// analysed harmonic tables (FL content, not shipped): by default they are
// replaced by synthesized equivalents (the DFT of the named shapes, see
// builtinHarmonics); tables imported from the user's own FL installation
// (setImportedTables) restore FL's exact spectra.

import { f32, fmaD } from '../poizone/dsp';

export const TX_WAVE_NAMES = [
  'Custom', 'Sine', 'Sine 1', 'Sine 2', 'Sine 3', 'Organ', 'Triangle', 'TriPow2', 'Square', 'SquSmth',
  'Squ PW1', 'Squ PW2', 'Saw', 'TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6', 'TX7',
  'Noise 1', 'Noise 2', 'Noise 3', 'Noise 4', 'Gate 1', 'Gate 2', 'Gate 3', 'Gate 4', 'Gate 5', 'Gate 6',
  'Gate 7', 'Gate 8', 'Gate 9',
];

const TWO_PI = 6.28318530718; // FL's constant (not Math.PI * 2)

/** One waveform: 128 band-limited tables of 256 x 4 Catmull-Rom coefficients. */
export class TxWave {
  readonly amp = new Float32Array(128);
  readonly phase = new Float32Array(128);
  /** 128 tables x 1024 floats (table 0: all 128 harmonics, table 127: the fundamental). */
  readonly tab = new Float32Array(128 * 1024);

  /** FL's harmonics -> tables (the partial sums use libm sin in double, accumulated in float). */
  build(amp: ArrayLike<number>, phase: ArrayLike<number>): void {
    for (let h = 0; h < 128; h++) { this.amp[h] = amp[h] ?? 0; this.phase[h] = phase[h] ?? 0; }
    const acc = new Float32Array(260);
    const part = new Float32Array(128 * 260);
    for (let h = 1; h <= 128; h++) {
      const a = this.amp[h - 1], p = this.phase[h - 1];
      const step = h * 0.00390625;
      if (a !== 0) {
        for (let i = 0; i < 256; i++) {
          const x = (p + i * step) * TWO_PI;
          acc[i] = fmaD(Math.sin(x), a, acc[i]);
        }
      }
      acc[256] = acc[0]; acc[257] = acc[1]; acc[258] = acc[2]; acc[259] = acc[3];
      part.set(acc, (h - 1) * 260);
    }
    const T = this.tab;
    for (let t = 0; t < 128; t++) {
      const src = t * 260;
      const dst = (127 - t) * 1024;
      for (let i = 0; i < 256; i++) {
        const ym1 = part[src + (i === 0 ? 255 : i - 1)];
        const y0 = part[src + i], y1 = part[src + i + 1], y2 = part[src + i + 2];
        const c1 = f32(f32(y1 - ym1) * 0.5);
        const c3 = f32(f32(y2 - ym1) * 0.5 + f32(y0 - y1) * 1.5);
        const c2 = f32(f32(ym1 + c1) - f32(y0 + c3));
        const o = dst + i * 4;
        T[o] = y0; T[o + 1] = c1; T[o + 2] = c2; T[o + 3] = c3;
      }
    }
  }

  /** FL's table for a frequency (table 0 below sr / 256). Returns the offset into tab. */
  tableFor(freq: number, sr: number): number {
    if (sr * 0.00390625 >= freq) return 0;
    let j = 128 - Math.trunc(sr / (freq + freq));
    if (j < 0) j = 0;
    return j > 127 ? 127 * 1024 : j * 1024;
  }

  /** LFO read (full table, phase 0..1 scaled by 255 as in FL). */
  lfo(phase: number): number {
    const x = f32(phase * 255);
    let i = Math.trunc(x);
    if (i < 0) i = 0;
    if (i > 255) i = 255;
    const f = f32(x - i);
    const T = this.tab, o = i * 4;
    let y = f32(T[o + 3] * f + T[o + 2]);
    y = f32(y * f + T[o + 1]);
    return f32(y * f + T[o]);
  }
}

/** Harmonic tables of the built-in shapes 6..32 imported from the user's FL installation (amp[128] + phase[128] each). */
let imported: Float32Array[] | null = null;

export function setImportedTables(t: Float32Array[] | null): void { imported = t; }
export function hasImportedTables(): boolean { return imported !== null; }

/** Pool-sample pack of the 27 tables: 8 header values (magic, count, size, checksum), then amp[128] + phase[128] each. */
const PACK_MAGIC = [1414089044, 27, 256];
export function txPackTables(t: Float32Array[]): Float32Array {
  const out = new Float32Array(8 + 27 * 256);
  out[0] = PACK_MAGIC[0]; out[1] = PACK_MAGIC[1]; out[2] = PACK_MAGIC[2];
  let sum = 0;
  for (let k = 0; k < 27; k++) for (let i = 0; i < 256; i++) { const v = t[k][i]; out[8 + k * 256 + i] = v; sum += v; }
  out[3] = Math.fround(sum);
  return out;
}

/** The tables back from txPackTables' data (null when the data is not such a pack, e.g. resampled by a decoder). */
export function txUnpackTables(d: Float32Array | undefined | null): Float32Array[] | null {
  if (!d || d.length < 8 + 27 * 256) return null;
  if (d[0] !== Math.fround(PACK_MAGIC[0]) || d[1] !== 27 || d[2] !== 256) return null;
  let sum = 0;
  const out: Float32Array[] = [];
  for (let k = 0; k < 27; k++) {
    const t = d.slice(8 + k * 256, 8 + (k + 1) * 256);
    for (let i = 0; i < 256; i++) {
      const v = t[i];
      if (!(v >= 0 && v <= 2)) return null;
      sum += v;
    }
    out.push(t);
  }
  return Math.fround(sum) === d[3] ? out : null;
}

/**
 * Locate Toxic Biohazard's built-in harmonic tables in its plugin binary (the user's own copy): 27 pairs of
 * 128-float arrays (amplitudes 0..2, phases in 0..1 near multiples of 1/256) at a 0x400 stride. Defensive scan;
 * returns null when no plausible block is found.
 */
export function findToxicTables(bin: ArrayBuffer): Float32Array[] | null {
  const n = bin.byteLength & ~3;
  const dv = new DataView(bin, 0, n);
  const okAmp = (o: number): boolean => {
    let nz = 0;
    for (let i = 0; i < 128; i++) {
      const v = dv.getFloat32(o + i * 4, true);
      if (!(v >= 0 && v <= 2)) return false;
      if (v !== 0) nz++;
    }
    return nz > 0;
  };
  const okPh = (o: number): boolean => {
    for (let i = 0; i < 128; i++) {
      const v = dv.getFloat32(o + i * 4, true);
      if (!(v >= 0 && v < 1)) return false;
      const q = v * 256;
      if (Math.abs(q - Math.round(q)) > 0.01) return false;
    }
    return true;
  };
  const valid = (o: number): boolean => {
    for (let k = 0; k < 27; k++) if (!okAmp(o + k * 0x400) || !okPh(o + k * 0x400 + 0x200)) return false;
    return true;
  };
  let first = -1;
  for (let o = 0; o + 27 * 0x400 <= n; o += 4) if (valid(o)) { first = o; break; }
  if (first < 0) return null;
  // a block shifted by a few floats can pass too: keep the alignment with the most non-zero fundamentals
  let best = first, bestScore = -1;
  for (let o = first; o < first + 0x400 && o + 27 * 0x400 <= n; o += 4) {
    if (!valid(o)) continue;
    let score = 0;
    for (let k = 0; k < 27; k++) if (dv.getFloat32(o + k * 0x400, true) > 0) score++;
    if (score > bestScore) { bestScore = score; best = o; }
  }
  const out: Float32Array[] = [];
  for (let k = 0; k < 27; k++) out.push(new Float32Array(bin.slice(best + k * 0x400, best + k * 0x400 + 0x400)));
  return out;
}

/** DFT of a 256-sample single cycle into FL's harmonic form (amplitude, phase in cycles of a sine series). */
function dft(w: Float64Array): [Float32Array, Float32Array] {
  const amp = new Float32Array(128), ph = new Float32Array(128);
  for (let h = 1; h <= 128; h++) {
    let re = 0, im = 0;
    for (let i = 0; i < 256; i++) {
      const a = (2 * Math.PI * h * i) / 256;
      re += w[i] * Math.cos(a); im += w[i] * Math.sin(a);
    }
    const s = h === 128 ? 1 : 2;
    re *= s / 256; im *= s / 256;
    const m = Math.hypot(re, im);
    if (m < 1e-6) continue;
    // w = sum m sin(2 pi (h i / 256 + p)): sin coefficient im, cos coefficient re
    let p = Math.atan2(re, im) / (2 * Math.PI);
    if (p < 0) p += 1;
    amp[h - 1] = m;
    ph[h - 1] = Math.round(p * 256) / 256 % 1;
  }
  return [amp, ph];
}

function shape(f: (x: number) => number): Float64Array {
  const w = new Float64Array(256);
  for (let i = 0; i < 256; i++) w[i] = f(i / 256);
  return w;
}

let lcgSeed = 0x2545f491;
function rnd(): number {
  lcgSeed = (Math.imul(lcgSeed, 1103515245) + 12345) >>> 0;
  return lcgSeed / 4294967296;
}

const subst: ([Float32Array, Float32Array] | undefined)[] = [];

/** Synthesized stand-ins for FL's analysed shapes 6..32 (named shapes; noises and gates are seeded). */
function substitute(idx: number): [Float32Array, Float32Array] {
  const c = subst[idx];
  if (c) return c;
  const tri = (x: number): number => (x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4);
  const sq = (x: number, pw = 0.5): number => (x < pw ? 0.75 : -0.75);
  let w: Float64Array;
  switch (idx) {
    case 6: w = shape(tri); break;
    case 7: w = shape((x) => { const t = tri(x); return Math.sign(t) * t * t; }); break;
    case 8: w = shape((x) => sq(x)); break;
    case 9: w = shape((x) => 0.75 * Math.tanh(4 * Math.sin(2 * Math.PI * x))); break;
    case 10: w = shape((x) => sq(x, 0.25)); break;
    case 11: w = shape((x) => sq(x, 0.125)); break;
    case 12: w = shape((x) => 1 - 2 * x); break;
    case 13: w = shape((x) => { const s = Math.sin(2 * Math.PI * x); return Math.sign(s) * s * s; }); break;
    case 14: w = shape((x) => (x < 0.5 ? Math.sin(2 * Math.PI * x) : 0)); break;
    case 15: w = shape((x) => { const s = Math.sin(2 * Math.PI * x); return x < 0.5 ? s * s : 0; }); break;
    case 16: w = shape((x) => Math.abs(Math.sin(2 * Math.PI * x)) * (x < 0.5 ? 1 : -1)); break;
    case 17: w = shape((x) => (x < 0.5 ? Math.sin(4 * Math.PI * x) : 0)); break;
    case 18: w = shape((x) => { const s = Math.sin(4 * Math.PI * x); return x < 0.5 ? s * s : 0; }); break;
    case 19: w = shape((x) => (x < 0.5 ? Math.abs(Math.sin(4 * Math.PI * x)) : 0)); break;
    case 20: case 21: case 22: case 23: {
      lcgSeed = 0x2545f491 + idx;
      const n = new Float64Array(256);
      const smooth = [0, 0.0, 0.5, 0.75, 0.9][idx - 19];
      let y = 0;
      for (let i = 0; i < 512; i++) { y = y * smooth + (rnd() * 2 - 1) * (1 - smooth); if (i >= 256) n[i - 256] = y; }
      w = n;
      break;
    }
    default: {
      // gates 1..9: pulse trains of 1..9 segments
      const k = idx - 23;
      w = shape((x) => (Math.floor(x * 2 * k) % 2 === 0 ? 0.75 : -0.75));
    }
  }
  const r = dft(w);
  subst[idx] = r;
  return r;
}

/** Harmonics of a built-in shape (1..32): FL's formulas for 1..5, imported or synthesized tables for 6..32. */
export function builtinHarmonics(idx: number, tables: Float32Array[] | null = imported): [Float32Array, Float32Array] {
  const amp = new Float32Array(128), ph = new Float32Array(128);
  switch (idx) {
    case 1: amp[0] = 1; return [amp, ph];
    case 2: amp[0] = 0.5; amp[1] = 0.5; return [amp, ph];
    case 3: amp[0] = f32(0.4); amp[1] = f32(0.4); amp[3] = f32(0.4); return [amp, ph];
    case 4: amp[0] = 0.5; amp[1] = 0.25; amp[3] = 0.125; return [amp, ph];
    case 5: amp[0] = f32(0.8); amp[1] = f32(0.256); amp[7] = f32(0.008); return [amp, ph];
  }
  if (idx >= 6 && idx <= 32) {
    if (tables) {
      const t = tables[idx - 6];
      return [t.subarray(0, 128), t.subarray(128, 256)];
    }
    return substitute(idx);
  }
  return [amp, ph];
}
