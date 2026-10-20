// Transistor Bass oscillator wavetables: FL's mip-mapped band-limited saw, as
// the plugin's engine builds it at load time (decoded from FL 2026's engine):
// - the source is a 1024-point falling ramp w[i] = 1 - 2 i / 1024;
// - a bank of 16384 sub-phase kernels of 64 taps,
//   h[j] = hann((j - f) / 64)^2 * sinc(pi (j - 32 - f) / r) / r, r = 2^(1/4);
// - level 0 is the ramp, level k (k = 1..47) resamples level k-1 to
//   round(len / r) points (a quarter octave shorter) through the kernels;
// - every level is then resampled 16 times longer through the same kernels and
//   gets guard points (t[0] = last, t[len+1] = first, t[len+2] = second), so a
//   read at phase index i interpolates t[i+1] and t[i+2].
// Kernels are float, sums double, outputs float (as FL's code).

const KTAPS = 64;
const KPHASES = 16384;
const LEVELS = 48;
const UPSAMPLE = 16;
const R = Math.pow(2, 1 / 4);

export interface TbWavetables {
  /** Tables per level (length len + 3: guard, data, two guards). */
  tables: Float32Array[];
  /** Data length per level (without guards). */
  lengths: Int32Array;
}

let cache: TbWavetables | null = null;

function buildKernels(): Float32Array {
  const k = new Float32Array(KPHASES * KTAPS);
  for (let p = 0; p < KPHASES; p++) {
    const frac = p * (1 / KPHASES);
    for (let j = 0; j < KTAPS; j++) {
      let x = (j - frac) * 0.015625;
      if (x < 0) x = 0;
      const c = 0.5 + -0.5 * Math.cos(x * 2 * Math.PI);
      const win = c * c;
      let t = j - 32 - frac;
      if (t < -32) t = -32;
      const a = (t / R) * Math.PI;
      const s = a === 0 ? 1 : Math.sin(a) / a;
      k[p * KTAPS + j] = (win * s) / R;
    }
  }
  return k;
}

/** FL's polyphase interpolation of a periodic table at position `pos` (0x2e50). */
function interp(kern: Float32Array, src: Float32Array, pos: number, len: number): number {
  const ip = Math.trunc(pos);
  const fr = pos - ip;
  const kp = Math.trunc(fr * 16384) * KTAPS;
  const base = len * 100 + ip - 32;
  let acc = 0;
  for (let j = 0; j < KTAPS; j++) {
    const idx = (base + j) % len;
    acc += src[idx] * kern[kp + j];
  }
  return Math.fround(acc);
}

export function tbWavetables(): TbWavetables {
  if (cache) return cache;
  const kern = buildKernels();
  const src = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) src[i] = Math.fround(-(((2 * i) * 0.0009765625) - 1));
  const levels: Float32Array[] = [src];
  const lens: number[] = [1024];
  for (let l = 1; l < LEVELS; l++) {
    const prev = levels[l - 1];
    const pl = lens[l - 1];
    const nl = Math.max(2, Math.trunc(pl / R + 0.5));
    const out = new Float32Array(nl);
    const step = pl / nl;
    let pos = 0;
    for (let n = 0; n < nl; n++) { out[n] = interp(kern, prev, pos, pl); pos += step; }
    levels.push(out);
    lens.push(nl);
  }
  const tables: Float32Array[] = [];
  const lengths = new Int32Array(LEVELS);
  for (let l = 0; l < LEVELS; l++) {
    const pl = lens[l];
    const nl = pl * UPSAMPLE;
    const t = new Float32Array(nl + 3);
    let pos = 0;
    const step = 1 / UPSAMPLE;
    for (let n = 0; n < nl; n++) { t[n + 1] = interp(kern, levels[l], pos, pl); pos += step; }
    t[0] = t[nl];
    t[nl + 1] = t[1];
    t[nl + 2] = t[2];
    tables.push(t);
    lengths[l] = nl;
  }
  cache = { tables, lengths };
  return cache;
}
