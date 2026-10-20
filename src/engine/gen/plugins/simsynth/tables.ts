// SimSynth: the engine's process-wide tables and counters (globals of
// SimSynth_eng_x64.dylib, shared by every instance like in FL's process):
// - init_soft_clip (0x24c4): the pitch clamp table, the noise table, the saw /
//   sine / sine^4 / triangle wavetables (4096 points each);
// - 0x5d00 (from synth::f_generate): per sample rate, the phase increment and
//   period tables over 30000 cents (4.0886817 Hz x 2^(i/1200));
// - the 16-bit noise read counter (0xc2d14) every oscillator start phase, noise
//   oscillator sample and LFO random value advances;
// - the chorus instance counter (Mod::inst, 0xc2d30).

import { cvtzu, f32 } from './fmath';

/** Pitch clamp (0x10330, 65568 x u16): [0..41] 10, [42..73] 0, [74..30027] k - 32, then 29996. */
export const CLAMP = new Uint16Array(65568);
/** Noise (0x30370): rand() / 2^31 after srand(666) (macOS rand: Park-Miller 16807). */
export const NOISE = new Float32Array(65536);
/** Saw (0x70370): sin(x pi/2), x = 1 - i/2048. */
export const SAW = new Float32Array(4096);
/** Sine (0x74370) and sine^4 (0x78370), sinf of a float-accumulated phase. */
export const SINE = new Float32Array(4096);
export const SINE4 = new Float32Array(4096);
/** Triangle (0x7c370). */
export const TRI = new Float32Array(4096);

/** One-ulp corrections of the sine table (index, direction in value). */
const SINE_ULP: [number, number][] = [
  [92, 1], [99, 1], [117, 1], [153, 1], [163, 1], [304, -1], [307, -1], [361, -1], [387, -1], [403, -1], [462, 1], [481, 1], [483, 1], [486, 1], [489, 1], [1542, -1], [1551, 1], [1577, 1], [1656, -1], [1671, -1], [1727, -1], [1815, 1], [1856, 1], [1863, 1], [1875, 1], [1897, 1], [2166, -1], [2169, -1], [2188, -1], [2200, -1], [2202, -1], [2229, -1], [2261, -1], [2262, -1], [2275, -1], [2356, 1], [2357, 1], [2390, 1], [2442, 1], [2499, -1], [2530, -1], [2580, 1], [3375, 1], [3608, -1], [3690, 1], [3717, 1], [3736, 1], [3737, 1], [3756, 1], [3887, -1], [3935, -1], [3938, -1], [3944, -1], [3946, -1], [3970, -1], [3983, -1], [4027, -1],
];

{
  for (let k = 0; k < 42; k++) CLAMP[k] = 10;
  for (let i = 0; i < 0x7502; i++) CLAMP[74 + i] = i + 42;
  for (let k = 30028; k < 65568; k++) CLAMP[k] = 29996;
  // patch::start calls srand(666) before every table rebuild but the very first one in a
  // process, whose noise values are all replaced before they can matter
  let ctx = 666;
  for (let i = 0; i < 65536; i++) {
    const hi = Math.floor(ctx / 127773), lo = ctx % 127773;
    let x = 16807 * lo - 2836 * hi;
    if (x < 0) x += 0x7fffffff;
    ctx = x;
    NOISE[i] = f32(f32(x) * 4.656612873077393e-10);
  }
  // the compiler vectorised the loops in 4 lanes with float phase accumulators
  const lane = (init: number[], step: number, n: number, out: Float32Array, off: number, fn: (x: number) => number) => {
    const x = init.map(f32);
    for (let i = 0; i < n; i += 4) for (let l = 0; l < 4; l++) { out[off + i + l] = fn(x[l]); x[l] = f32(x[l] + step); }
  };
  const HALF_PI = 1.5707963267948966;
  lane([1, 0.99951171875, 0.9990234375, 0.99853515625], f32(-0.001953125), 4096, SAW, 0, (x) => f32(Math.sin(x * HALF_PI)));
  const u = new Float32Array(new Uint32Array([0, 0x3ac90fdb, 0x3b490fdb, 0x3b96cbe4]).buffer);
  const st = new Float32Array(new Uint32Array([0x3bc90fdb]).buffer)[0];
  lane(Array.from(u), st, 4096, SINE, 0, (x) => f32(Math.sin(x)));
  // Apple's sinf is not correctly rounded: FL's table differs from the exact rounding by one
  // ulp at these points (FL's runtime table, read with lldb)
  const fb = new Float32Array(1), ib = new Int32Array(fb.buffer);
  for (const [i, d] of SINE_ULP) { fb[0] = SINE[i]; ib[0] += fb[0] >= 0 ? d : -d; SINE[i] = fb[0]; }
  for (let i = 0; i < 4096; i++) { const s = SINE[i], q = f32(s * s); SINE4[i] = f32(q * q); }
  lane([0, 0.0009765625, 0.001953125, 0.0029296875], 0.00390625, 1024, TRI, 0, (x) => x);
  lane([1, 0.9990234375, 0.998046875, 0.9970703125], -0.00390625, 2048, TRI, 1024, (x) => x);
  lane([-1, -0.9990234375, -0.998046875, -0.9970703125], 0.00390625, 1024, TRI, 3072, (x) => x);
}

/**
 * Phase increments (0x80370, 30000 x u32) followed by the period table (0x9d830,
 * samples per cycle), rebuilt in place when the table rate changes (0x5d00): FL's
 * setfrq reads 20 entries past an index (the "warm" second oscillator), so indices
 * near the top run into the period table.
 */
export let INC: Uint32Array = new Uint32Array(60000);
let incRate = -1;
/** Built tables by rate: FL rebuilds them on every rate change; the values only depend on the rate. */
const incCache = new Map<number, Uint32Array>();

/** 0x5d00: the tables for a table rate (2 x the sample rate in FL's quality mode). */
export function setTableRate(rate: number): void {
  const r = f32(rate);
  if (incRate === r) return;
  incRate = r;
  const hit = incCache.get(r);
  if (hit) { INC = hit; return; }
  const t = new Uint32Array(60000);
  const inv = f32(1 / r);
  const C = 4.088681697845459;
  for (let i = 0; i < 30000; i++) {
    const fr = f32(Math.pow(2, i * 0.0008333333333333334) * C);
    t[30000 + i] = cvtzu(f32(r / fr));
    t[i] = cvtzu(f32(f32(fr * 4294967296) * inv));
  }
  if (incCache.size >= 4) incCache.clear();
  incCache.set(r, t);
  INC = t;
}

/** Process-wide engine state (FL keeps these as globals of the engine library). */
export const G = {
  /** 0xc2d14: the noise table read position (16 bit). */
  counter: 0,
  /** 0xc2d30: Mod::inst, the chorus rate offset. */
  modInst: 0,
  /** 0x10284 / 0x10288 / 0x1028c / 0x10280: sample rate, rate multiplier / divisor, samples per ms. */
  grate: 44100,
  rateMul: 1,
  rateDiv: 1,
  spm: f32(44.1),
};

/** The next noise value (advances the shared counter). */
export function nextNoise(): number {
  const v = NOISE[G.counter];
  G.counter = (G.counter + 1) & 0xffff;
  return v;
}

/** Tests / parity: back to a freshly loaded engine library. */
export function resetGlobals(): void {
  G.counter = 0;
  G.modInst = 0;
  G.grate = 44100;
  G.rateMul = 1;
  G.rateDiv = 1;
  G.spm = f32(44.1);
  incRate = -1;
}
