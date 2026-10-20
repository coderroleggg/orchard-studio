import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { render, sine, peak } from './util';

// Reference values were read from FL's Hyper Chorus with flfxhost (44.1 kHz,
// fresh instances: FL starts from its constructor values and glides to the set
// ones, which also fixes the LFO phases). Taps are first-moment centroids
// (samples after the impulse) and sums of each cluster.
const SR = 44100;
const txt = (key: string, v: number) => formatParam(fxParamDef('hyperchorus', key)!, v);
const DEF = defaultFxParams('hyperchorus');

function make(p: Record<string, number> = {}) {
  const fx = createEffect('hyperchorus', SR, 128);
  fx.setParams({ ...DEF, ...p });
  return fx;
}

/** Clusters above thr after t0: [centroid, sum] (as the FL measurement script). */
function taps(Y: Float32Array, t0: number, count: number, thr = 0.02): [number, number][] {
  const out: [number, number][] = [];
  const idx: number[] = [];
  for (let i = 0; i < 1200; i++) if (Math.abs(Y[t0 + i]) > thr) idx.push(i);
  let g: number[] = [];
  const flush = () => {
    if (!g.length) return;
    let s = 0, m = 0;
    for (let k = g[0] - 3; k <= g[g.length - 1] + 3; k++) { s += Y[t0 + k]; m += k * Y[t0 + k]; }
    out.push([m / s, s]);
    g = [];
  };
  for (const i of idx) { if (g.length && i - g[g.length - 1] > 6) flush(); g.push(i); }
  flush();
  return out.slice(0, count);
}

function expectTaps(got: [number, number][], want: [number, number][]) {
  expect(got.length).toBe(want.length);
  want.forEach(([pos, sum], i) => {
    expect(Math.abs(got[i][0] - pos)).toBeLessThan(0.003);
    expect(Math.abs(got[i][1] - sum)).toBeLessThan(5e-4);
  });
}

function impulses(at: number[], n: number): Float32Array {
  const x = new Float32Array(n);
  for (const t of at) x[t] = 1;
  return x;
}

describe('Hyper Chorus', () => {
  it('is registered with FL ranges, Default-preset values, factory presets and value texts', () => {
    const d = fxDef('hyperchorus')!;
    expect([d.width, d.height]).toEqual([747, 217]);
    expect(DEF).toEqual({
      delay: 500, feedback: 500, modRate: 500, modAmount: 500, movement: 500, movementRate: 500,
      lines: 0, lowPass: 22000, highPass: 120, mix: 500, phaseDiff: 500,
    });
    expect(d.presets?.length).toBe(12);
    // FL's texts (swept with flfxhost)
    expect(txt('delay', 500)).toBe('50.00%');
    expect(txt('feedback', 333)).toBe('33.30%');
    expect(txt('lowPass', 22000)).toBe('22000.0 Hz');
    expect(txt('lowPass', 12000)).toBe('2190.7 Hz');
    expect(txt('lowPass', 7140)).toBe('714.0 Hz');
    expect(txt('highPass', 120)).toBe('12.0 Hz');
    expect(txt('highPass', 2000)).toBe('26.3 Hz');
    expect(txt('highPass', 10900)).toBe('1090.0 Hz');
    expect(txt('mix', 500)).toBe('50% Dry / 50% Wet');
    expect(txt('mix', 5)).toBe('100% Dry / 0% Wet');
    expect(txt('mix', 15)).toBe('98% Dry / 2% Wet');
    expect(txt('mix', 250)).toBe('75% Dry / 25% Wet');
    expect(txt('lines', 1)).toBe('8');
  });

  it('reproduces FL\'s taps with the Default preset (delays, LFO phases, levels, both channels)', () => {
    const n = Math.round(SR * 2.6);
    const x = impulses([44100, 110250], n);
    const [L, R] = render(make(), x, x, 128, { sampleRate: SR });
    // FL: dry tap (0.7071) then the four lines; the right channel's LFOs lead
    expectTaps(taps(L, 44100, 5), [[0, 0.70711], [175.7382, 0.37123], [235.0652, 0.47658], [319.7252, 0.36017], [353.9503, 0.13208]]);
    expectTaps(taps(R, 44100, 5), [[0, 0.70711], [181.0855, 0.4239], [231.7292, 0.29157], [321.5227, 0.43398], [364.5109, 0.15012]]);
    expectTaps(taps(L, 110250, 5), [[0, 0.70711], [172.0489, 0.32233], [285.2388, 0.45457], [320.4411, 0.34284], [347.4583, 0.54794]]);
    expectTaps(taps(R, 110250, 5), [[0, 0.70711], [177.1818, 0.46517], [280.9931, 0.32653], [322.9969, 0.4529], [345.3751, 0.35744]]);
  });

  it('runs 8 lines like FL (half the level per line; lines 5-8 join 15 ms after start-up)', () => {
    const n = Math.round(SR * 2.6);
    const x = impulses([44100, 110250], n);
    const [L, R] = render(make({ lines: 1 }), x, x, 128, { sampleRate: SR });
    expectTaps(taps(L, 44100, 5), [[0, 0.70711], [175.7784, 0.18738], [235.1189, 0.23953], [319.7433, 0.18085], [353.9151, 0.06663]]);
    expectTaps(taps(R, 44100, 5), [[0, 0.70711], [181.0855, 0.21195], [231.7251, 0.14564], [321.5273, 0.21721], [364.5109, 0.07506]]);
    expectTaps(taps(L, 110250, 5), [[0, 0.70711], [172.0489, 0.16116], [285.2506, 0.22665], [320.4721, 0.17023], [347.4949, 0.27619]]);
  });

  it('balances each line\'s input with the movement LFOs (FL, 100 % movement)', () => {
    const n = Math.round(SR * 2.6);
    const x = impulses([44100, 110250], n);
    const [L, R] = render(make({ feedback: 0, mix: 1000, movement: 1000, movementRate: 800 }), x, x, 128, { sampleRate: SR });
    expectTaps(taps(L, 44100, 4), [[175.7382, 0.36605], [235.1196, 0.29037], [319.7251, 0.37255], [378.8744, 0.43757]]);
    expectTaps(taps(R, 44100, 4), [[181.0855, 0.70744], [231.729, 0.73773], [321.5163, 0.70487], [390.1222, 0.68104]]);
    expectTaps(taps(L, 110250, 4), [[171.9956, 0.79156], [285.2644, 0.76681], [320.4345, 0.78932], [347.758, 0.77149]]);
    expectTaps(taps(R, 110250, 4), [[177.2218, 0.08092], [280.9936, 0.20542], [322.9612, 0.12317], [345.2684, 0.16086]]);
  });

  it('feeds each line back 0.7 x Feedback one sample late (FL echoes)', () => {
    const x = impulses([44100], Math.round(SR * 1.2));
    const [L] = render(make({ delay: 0, feedback: 1000, modAmount: 0, movement: 0, mix: 1000 }), x, x, 128, { sampleRate: SR });
    expectTaps(taps(L, 44100, 10, 0.01), [
      [88.989, 0.55896], [152.854, 0.55923], [178.6277, 0.39399], [219.8974, 0.56855], [269.1917, 0.27418],
      [281.9882, 0.56323], [306.9308, 0.39591], [359.3812, 0.19189], [443.3334, 0.52797], [460.7461, 0.26969],
    ]);
  });

  it('follows FL\'s mix law and wet gain (DC through 4 lines)', () => {
    const fl: [number, number][] = [[0, 0.5], [250, 0.865452], [500, 1.149042], [750, 1.229109], [1000, 1.124991]];
    for (const [mix, want] of fl) {
      const x = new Float32Array(SR).fill(0.5);
      const [L] = render(make({ feedback: 0, movement: 0, mix }), x, x, 128, { sampleRate: SR });
      expect(Math.abs(L[30000] - want)).toBeLessThan(5e-5);
    }
  });

  it('filters the wet signal with FL\'s low / high pass (two first-order sections each)', () => {
    const level = (p: Record<string, number>, f: number) => {
      const x = sine(f, 1, 0.3, SR);
      const [L] = render(make({ feedback: 0, movement: 0, modAmount: 0, mix: 1000, ...p }), x, x, 128, { sampleRate: SR });
      let s = 0, c = 0;
      for (let i = 22050; i < L.length; i++) { const w = (2 * Math.PI * f * i) / SR; s += L[i] * Math.sin(w); c += L[i] * Math.cos(w); }
      return (2 * Math.hypot(s, c)) / (L.length - 22050);
    };
    // FL: 0.088080 / 0.176234 at the 2190.7 Hz setting (-6.02 dB), 0.066067 at 8743.6 Hz
    expect(Math.abs(level({ lowPass: 12000 }, 2190.73) - 0.08808)).toBeLessThan(2e-4);
    expect(Math.abs(level({ lowPass: 22000 }, 2190.73) - 0.176234)).toBeLessThan(3e-4);
    expect(Math.abs(level({ lowPass: 18000 }, 8743.6) - 0.066067)).toBeLessThan(2e-4);
    // the high pass is off at its minimum (DC passes), on one step above it
    const dc = (highPass: number) => {
      const x = new Float32Array(SR).fill(0.5);
      const [L] = render(make({ feedback: 0, movement: 0, mix: 1000, highPass }), x, x, 128, { sampleRate: SR });
      return L[Math.round(0.9 * SR)];
    };
    expect(dc(120)).toBeCloseTo(1.12499, 4);
    expect(Math.abs(dc(2000))).toBeLessThan(1e-3);
  });

  it('glides from FL\'s constructor values at start-up, then applies changes at once', () => {
    // FL (DC 0.5, constructor settings but 100 % wet): the mix glides from 50 %
    const x = new Float32Array(SR).fill(0.5);
    const p = { delay: 400, feedback: 0, modRate: 400, modAmount: 400, movement: 0, movementRate: 300, mix: 1000, phaseDiff: 100 };
    const [L] = render(make(p), x, x, 128, { sampleRate: SR });
    const fl: [number, number][] = [[0, 0.3532], [100, 0.3182], [441, 1.2908], [882, 1.4387], [1323, 1.3472], [2205, 1.2128], [4410, 1.1336], [8820, 1.1249]];
    for (const [i, v] of fl) expect(Math.abs(L[i] - v)).toBeLessThan(3e-4);
    // later the mix jumps (FL: the next sample is plain dry)
    const fx = make(p);
    const a = render(fx, x.subarray(0, 22016), x.subarray(0, 22016), 128, { sampleRate: SR });
    expect(a[0][22015]).toBeCloseTo(1.125, 3);
    fx.setParams({ ...DEF, ...p, mix: 0 });
    const [L2] = render(fx, x.subarray(0, 256), x.subarray(0, 256), 128, { sampleRate: SR });
    expect(L2[0]).toBeCloseTo(0.5, 6);
  });

  it('freezes lines 5-8 while 4 lines run (FL: they resume where they stopped)', () => {
    // an impulse that enters while only 4 lines run leaves no taps on lines 5-8
    const fx = make({ feedback: 0, mix: 1000, movement: 0 });
    const n = 4096;
    render(fx, new Float32Array(SR), new Float32Array(SR), 128, { sampleRate: SR });   // past the start-up glide
    const x = new Float32Array(n); x[1000] = 1;
    const [L] = render(fx, x, x, 128, { sampleRate: SR });
    fx.setParams({ ...DEF, feedback: 0, mix: 1000, movement: 0, lines: 1 });
    const [L2] = render(fx, new Float32Array(n), new Float32Array(n), 128, { sampleRate: SR });
    expect(peak(L, 1000 + 700)).toBeLessThan(1e-3);   // only the 22 kHz low-pass tail
    expect(peak(L2)).toBeLessThan(1e-3);
  });

  it('keeps the output finite at extreme settings and with bad input', () => {
    const x = Float32Array.from(sine(220, 2, 0.9, SR), (v, i) => (i === 5000 ? NaN : i === 7000 ? Infinity : v));
    const [L, R] = render(make({ feedback: 1000, modAmount: 1000, modRate: 1000, movement: 1000, movementRate: 1000, lines: 1, highPass: 10900, lowPass: 7140, mix: 1000 }), x, x, 128, { sampleRate: SR });
    expect(L.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
    expect(peak(L, SR)).toBeLessThan(10);
  });
});
