// MiniSynth oscillator wavetables (FL: MiniSynth, the FL Studio Mobile synth).
//
// FL's constructor (MiniSynth_x64.dylib arm64 0x35130..0x353a0) reads 1024
// harmonic amplitudes and 1024 phases (float32, its oscdata.dat) and builds
// 1024 band-limited tables of 2048 floats by additive synthesis: table
// 1023 - h holds harmonics 1..h+1, accumulated in float, one harmonic per step:
//   acc[n] = f32(acc[n] + amp[h] * cos((h + 1) * 2pi/2048 * n + phase[h]))
// (the products and the phase in double; table 0 = all 1024 harmonics).
// The oscillators pick the table whose harmonics stay below sr/2.
//
// The spectrum is not copied from FL's file: it is the analysis of our model
// of FL's waveform, measured from FL's data: a naive (mid-sample) 2048-point
// ramp-down sawtooth s[n] = 0.5 - (n + 0.5)/2048, mixed with the same ramp
// through a one-pole lowpass (periodic steady state, coefficient G):
//   w[n] = ALPHA s[n] + BETA lp(s)[n]
// analysed with a 2048-point DFT, amplitude 2|X_k|/2048 (also for the Nyquist
// bin, as FL's data has it) and phase arg(X_k), rounded to float. The model
// reproduces FL's table waveform to -117 dB (max 8e-7); see
// docs/research/gen/minisynth.md.

/** Table length (samples per cycle) and number of tables (harmonic counts 1024..1). */
export const TABLE_LEN = 2048;
export const TABLE_COUNT = 1024;

/** Waveform model (fitted to FL's oscillator data, least squares). */
const G = 0.007499962691498151;
const ALPHA = 0.4348975439700553;
const BETA = 0.5651046991457248;

/** FL's harmonic data as our model gives it: amp[h], phase[h] for harmonic h + 1 (float32). */
export function oscSpectrum(): { amp: Float32Array; phase: Float32Array } {
  const N = TABLE_LEN;
  const s = new Float64Array(N);
  for (let n = 0; n < N; n++) s[n] = 0.5 - (n + 0.5) / N;
  // periodic steady state of y[n] = G s[n] + (1 - G) y[n-1]
  const y = new Float64Array(N);
  let v = 0;
  for (let rep = 0; rep < 4; rep++) for (let n = 0; n < N; n++) { v = G * s[n] + (1 - G) * v; y[n] = v; }
  const w = new Float64Array(N);
  for (let n = 0; n < N; n++) w[n] = ALPHA * s[n] + BETA * y[n];
  // DFT bins 1..1024 with exact twiddles (angle index k*n mod N)
  const c = new Float64Array(N), sn = new Float64Array(N);
  for (let i = 0; i < N; i++) { c[i] = Math.cos((2 * Math.PI * i) / N); sn[i] = Math.sin((2 * Math.PI * i) / N); }
  const amp = new Float32Array(TABLE_COUNT), phase = new Float32Array(TABLE_COUNT);
  for (let k = 1; k <= TABLE_COUNT; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const j = (k * n) % N;
      re += w[n] * c[j];
      im -= w[n] * sn[j];
    }
    amp[k - 1] = (2 * Math.hypot(re, im)) / N;
    phase[k - 1] = Math.atan2(im, re);
  }
  return { amp, phase };
}

/** FL's 1024 band-limited tables, built like FL's constructor (table t at offset t * 2048). */
export function buildTables(): Float32Array {
  const { amp, phase } = oscSpectrum();
  const N = TABLE_LEN;
  const out = new Float32Array(TABLE_COUNT * N);
  const acc = new Float32Array(N);
  const W = 0.0030679615757712823; // 2 pi / 2048 (FL's constant)
  for (let h = 0; h < TABLE_COUNT; h++) {
    const a = amp[h];
    const p = phase[h];
    const w = Math.fround(h + 1) * W;
    for (let n = 0; n < N; n++) acc[n] = acc[n] + a * Math.cos(p + n * w);
    out.set(acc, (TABLE_COUNT - 1 - h) * N);
  }
  return out;
}

let shared: Float32Array | null = null;

/** The tables, built once per process on first use (8 MB, shared by every instance). */
export function oscTables(): Float32Array {
  if (!shared) shared = buildTables();
  return shared;
}

/** Replace the shared tables (research: compare against tables built from other harmonic data). */
export function setOscTables(t: Float32Array | null): void {
  shared = t;
}
