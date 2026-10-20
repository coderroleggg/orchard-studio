// FL's SoundFont Player resampler (Soundfont Player_x64.dylib, arm64 slice; unit Sobanth): the voices read the
// sample through polyphase kernels with 4096 phases (the top 12 bits of the 32 bit fractional position).
// Resampling menu (SetResampling 0x1eba70 -> per-voice function 0x1d5fc0):
//   Crunchy  (mode 1): 2-tap linear interpolation (0x1febe0: a (1 - f) + b f, float32 fma);
//   Standard (mode 4): 8-tap, HQ (mode 6): 32-tap, Extreme HQ (mode 8): 128-tap windowed sinc, built per
//   semitone band (tables 0x1ec380, 64 bands, 4096 phases): kernel(b, p, t) = sin(pi c d) / (pi d) x Kaiser(d / N)
//   with c = 2^(-b/12) (band 0: 1), d = t - (p / 4096 - 0.5) - N, N = taps / 2, Kaiser beta 0.1102 (144.49 - 8.7)
//   (stop band 2^-24), normalised by I0(beta), stored as float32. The kernels are NOT renormalised, so the
//   gain of a band is c (measured: pitching up 2 octaves loses 4.7 dB with 8 taps).
// A voice reads sample[int(pos) - N + t] for t = 0..taps-1 (output(n) = signal(pos - 0.5)), position pos in 32.32
// fixed point; a band is floor(12 log2 step) (clamped 0..63) blended with the next band by the step's position
// between the two bands' exact steps (0x1e0f58..0x1e1118). The tables of the band-limited modes are built lazily
// per band here (FL builds all 64 bands when the mode is selected: "Calculating resampling lookup tables...").

export const PHASES = 4096;
const TWO32 = 4294967296;

/** FL's stop band attenuation (-20 log10 2^-24 dB) and the Kaiser beta from it (Kaiser's formula, A > 50). */
const KAISER_BETA = 0.1102 * (-20 * Math.log10(5.960464477539063e-8) - 8.7);

/** Modified Bessel function of the first kind, order 0 (power series). */
export function bessel0(x: number): number {
  const q = (x * x) / 4;
  let term = 1, sum = 1;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** The thresholds of the 64 bands: step of 2^(b/12) in 32.32 fixed point (FL 0x1fd7d0: trunc(2^32 2^(b/12))). */
export const BAND_STEPS: number[] = (() => {
  const t: number[] = [];
  for (let b = 0; b < 64; b++) t.push(Math.trunc(TWO32 * Math.exp(b * 0.0833333358168602 * 0.6931471805599453) * 1) );
  return t;
})();

/** Band cutoff c = min(1, 2^(-b/12)) in float32 (the table builder 0x1ec380 computes it in single precision). */
function bandCutoff(b: number): number {
  if (b === 0) return 1;
  const s = Math.fround(1 / Math.exp(b * 0.0833333358168602 * 0.6931471805599453));
  return Math.fround(Math.fround(Math.abs(s) + 1) - Math.abs(Math.fround(s - 1))) * 0.5;
}

/** One mode's kernel tables: taps, the (shared) window table and the lazily built bands. */
export class SincTables {
  readonly taps: number;
  private readonly win: Float64Array;
  private readonly bands: (Float32Array | null)[] = new Array(64).fill(null);

  constructor(taps: number) {
    this.taps = taps;
    const n = taps >> 1;
    const w = new Float64Array(PHASES * taps);
    const i0b = bessel0(KAISER_BETA);
    for (let p = 0; p < PHASES; p++) {
      const phase = p / PHASES - 0.5;
      for (let t = 0; t < taps; t++) {
        const x = (t - phase - n) / n;
        w[p * taps + t] = Math.abs(x) < 1 ? bessel0(KAISER_BETA * Math.sqrt(1 - x * x)) / i0b : 0;
      }
    }
    this.win = w;
  }

  /** The kernel table of a band: PHASES x taps float32. */
  band(b: number): Float32Array {
    let k = this.bands[b];
    if (k) return k;
    const taps = this.taps, n = taps >> 1;
    const c = bandCutoff(b);
    k = new Float32Array(PHASES * taps);
    for (let p = 0; p < PHASES; p++) {
      const phase = p / PHASES - 0.5;
      for (let t = 0; t < taps; t++) {
        const d = t - phase - n;
        const s = Math.abs(d) < 1e-10 ? c : Math.sin(Math.PI * c * d) / (Math.PI * d);
        k[p * taps + t] = s * this.win[p * taps + t];
      }
    }
    this.bands[b] = k;
    return k;
  }
}

const tablesCache = new Map<number, SincTables>();

/** The (cached) tables for a tap count. */
export function sincTables(taps: number): SincTables {
  let t = tablesCache.get(taps);
  if (!t) { t = new SincTables(taps); tablesCache.set(taps, t); }
  return t;
}

/** FL's SetResampling modes of the Resampling menu (Tag): taps of the sinc modes, 2 = linear. */
export function tapsOfMode(mode: number): number {
  switch (mode) {
    case 1: return 2;
    case 4: return 8;
    case 5: return 16;
    case 6: return 32;
    case 7: return 64;
    case 8: return 128;
    default: return 8;
  }
}

/** The band (0..63) and its blend for a step (32.32 fixed point as a double): floor(12 log2 step), next band, weight. */
export function bandOf(step: number): { b0: number; b1: number; mix: number } {
  const v = Math.floor(Math.log(step / TWO32) * 17.31234049066756);
  const b0 = v < 0 ? 0 : v > 63 ? 63 : v;
  let b1 = b0;
  if (step !== BAND_STEPS[b0]) b1 = b0 + 1 > 63 ? 63 : b0 + 1;
  let mix = 0;
  if (BAND_STEPS[b0] < BAND_STEPS[b1]) {
    mix = (step - BAND_STEPS[b0]) / (BAND_STEPS[b1] - BAND_STEPS[b0]);
    mix = mix < 0 ? 0 : mix > 1 ? 1 : mix;
  }
  return { b0, b1, mix };
}
