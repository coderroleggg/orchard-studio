import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { llShape } from '../../src/engine/effects/plugins/lowlifter';
import { render, peak } from './util';

const SR = 48000;

function make(p: Record<string, unknown> = {}, sr = SR) {
  const fx = createEffect('lowlifter', sr, 128);
  fx.setParams({ ...defaultFxParams('lowlifter'), ...p });
  fx.reset();
  return fx;
}

function text(key: string, v: number): string {
  const d = fxDef('lowlifter')!;
  return formatParam(d.params.find((q) => q.key === key)!, v);
}

function tone(freq: number, db: number, secs: number): Float32Array {
  const n = Math.round(secs * SR), a = Math.pow(10, db / 20), b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = a * Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}

/** Amplitude (dB) of the `freq` component over [from, from + dur] seconds (whole cycles). */
function amp(y: Float32Array, freq: number, from: number, dur = 0.5): number {
  const a = Math.round(from * SR), n = Math.round(Math.floor(dur * freq) * (SR / freq));
  let s = 0, c = 0;
  for (let i = a; i < a + n; i++) { const ph = (2 * Math.PI * freq * i) / SR; s += y[i] * Math.sin(ph); c += y[i] * Math.cos(ph); }
  return 20 * Math.log10((2 * Math.hypot(s, c)) / n);
}

// low band alone, nearly linear shaper (slope -60 dB), no boost, no look-ahead
const LIN = { highBand: 0, slope: 0, preGain: 0, lookahead: 0 };

describe('Low Lifter', () => {
  it('is registered with FL ranges, defaults, value texts and presets', () => {
    const d = fxDef('lowlifter')!;
    expect(d.width).toBe(680);
    expect(d.height).toBe(280);
    // FL's "Default" preset (the constructor differs: dry/wet 0, slope -6 dB, no boost, 80 Hz)
    expect(defaultFxParams('lowlifter')).toMatchObject({
      enabled: 1, dryWet: 10000, lowGain: 4999, slope: 6993, lookahead: 1, invert: 0, preGain: 4998, diffMix: 0,
      diffDepth: 5000, highGain: 10000, crossover: 8920, lowCut: 0, multiband: 0, highBand: 1, lowBand: 1,
    });
    // texts read from FL (all 90021 values match)
    expect(text('lowGain', 0)).toBe('-inf');
    expect(text('lowGain', 1)).toBe('-82.78 dB');
    expect(text('lowGain', 4999)).toBe('0.00 dB');
    expect(text('lowGain', 10000)).toBe('12.00 dB');
    expect(text('slope', 1)).toBe('-56.91 dB');
    expect(text('slope', 6993)).toBe('-6.53 dB');
    expect(text('highGain', 1)).toBe('-100.98 dB');
    expect(text('highGain', 5000)).toBe('-15.53 dB');
    expect(text('preGain', 75)).toBe('0.13 dB');
    expect(text('preGain', 625)).toBe('1.13 dB');
    expect(text('preGain', 4998)).toBe('9.00 dB');
    expect(text('crossover', 72)).toBe('20.01 Hz');
    expect(text('crossover', 7750)).toBe('80.00 Hz');
    expect(text('crossover', 8920)).toBe('99.53 Hz');
    expect(text('lowCut', 10000)).toBe('120.00 Hz');
    expect(text('diffMix', 50)).toBe('0.00');
    expect(text('diffMix', 1250)).toBe('0.13');
    expect(text('diffDepth', 1)).toBe('-0.99');
    expect(text('diffDepth', 2500)).toBe('-0.50');
    expect(text('dryWet', 50)).toBe('1%');
    expect(text('dryWet', 2650)).toBe('26%');
    expect(text('multiband', 1)).toBe('On');
    expect(d.presets?.map((p) => p.name)).toEqual(['Bass isolator', 'Bottom end', 'Default', 'Density', 'Mastering bass boost', 'Nightclub next door', 'Sub presence']);
    // FL: 10 ms look-ahead (480 @ 48 kHz, 441 @ 44.1 kHz), none without it
    expect(make().latency).toBe(480);
    expect(make({}, 44100).latency).toBe(441);
    expect(make({ lookahead: 0 }).latency).toBe(0);
  });

  it('splits at the crossover with LR4 filters, a 20 Hz DC blocker on the low band and the low cut on the sum', () => {
    // FL (crossover 80 Hz, low cut 20 Hz), dB at 10 / 20 / 40 / 80 / 160 Hz
    const lowRef = [-24.68, -6.31, -1.04, -6.06, -24.64];
    const highRef = [-84.16, -51.41, -24.82, -6.01, -0.53];
    [10, 20, 40, 80, 160].forEach((f, i) => {
      const x = tone(f, -20, 2);
      const [lo] = render(make({ ...LIN, crossover: 7750 }), x);
      const [hi] = render(make({ ...LIN, crossover: 7750, highBand: 1, lowBand: 0 }), x);
      expect(amp(lo, f, 1.2) + 20).toBeCloseTo(lowRef[i], 0);
      if (i > 0) expect(amp(hi, f, 1.2) + 20).toBeCloseTo(highRef[i], 0);
    });
    // low cut at 120 Hz: -3 dB there (2nd order high-pass)
    const [lc] = render(make({ ...LIN, highBand: 1, lowBand: 0, lowCut: 10000, crossover: 0 }), tone(120, -20, 2));
    expect(amp(lc, 120, 1.2) + 20).toBeCloseTo(-3.0, 0);
  });

  it('keeps the dry path flat (crossover allpass + phase-matched low cut), also when disabled', () => {
    for (const p of [{ dryWet: 0 }, { enabled: 0 }]) {
      for (const f of [15, 60, 1000]) {
        const [y] = render(make({ ...p, lookahead: 0 }), tone(f, -12, 2));
        expect(Math.abs(amp(y, f, 1.2) + 12)).toBeLessThan(0.05);
      }
    }
  });

  it('adds 2nd and 3rd harmonics with the Chebyshev shaper (FL levels)', () => {
    // FL, 40 Hz, crossover 80 Hz, slope 0 dB (w = 1), no boost: h1 / h2 / h3 in dBFS
    const ref: Record<number, number[]> = { [-12]: [-17.35, -34.64, -47.14], 0: [-14.25, -10.64, -11.14] };
    for (const lv of [-12, 0]) {
      const [y] = render(make({ ...LIN, crossover: 7750, slope: 10000 }), tone(40, lv, 2));
      for (let k = 1; k <= 3; k++) expect(amp(y, 40 * k, 1.2)).toBeCloseTo(ref[lv][k - 1], 0);
      expect(amp(y, 160, 1.2)).toBeLessThan(-90); // no 4th harmonic
    }
    // shaper: (T1 + w T2 + w^2 T3) / (1 + 2w), T2 without its constant
    expect(llShape(0.5, 1)).toBeCloseTo((0.5 + 0.5 + (4 * 0.125 - 1.5)) / 3, 12);
    expect(llShape(0, 0.7)).toBe(0);
  });

  it('limits the boosted low band to 0 dBFS per channel (and per band in multiband mode)', () => {
    // FL: 40 Hz +12 dB, no boost -> -0.55 dB after the 20 Hz filters; multiband -> +5.97 dB
    const x = tone(40, 12, 2.5);
    const [y] = render(make({ ...LIN, crossover: 7750 }), x);
    expect(amp(y, 40, 1.8)).toBeCloseTo(-0.55, 1);
    const [m] = render(make({ ...LIN, crossover: 7750, multiband: 1 }), x);
    expect(amp(m, 40, 1.8)).toBeCloseTo(5.97, 0);
    // not linked: a quiet right channel passes untouched
    const [, r] = render(make({ ...LIN, crossover: 7750 }), x, tone(40, -20, 2.5));
    expect(amp(r, 40, 1.8)).toBeCloseTo(-21.08, 1);
    // pre-shaping boost is not compensated: +9 dB on a quiet tone
    const [b0] = render(make({ ...LIN, crossover: 7750 }), tone(40, -30, 2));
    const [b9] = render(make({ ...LIN, crossover: 7750, preGain: 4998 }), tone(40, -30, 2));
    expect(amp(b9, 40, 1.2) - amp(b0, 40, 1.2)).toBeCloseTo(9, 1);
    // look-ahead: the gain is down before a +12 dB burst arrives (FL peaks at 1.023 after the
    // 20 Hz filters, the clone at 1.06)
    const n = Math.round(1.5 * SR), burst = new Float32Array(n);
    for (let i = 0; i < n; i++) burst[i] = (i > SR / 2 && i < SR ? 4 : 0.05) * Math.sin((2 * Math.PI * 50 * i) / SR);
    const [la] = render(make({ ...LIN, lookahead: 1, crossover: 10000 }), burst);
    expect(peak(la, 480 + SR / 2, 480 + SR)).toBeLessThan(1.08);
    // release: still reduced 30 ms after the burst, recovered after 200 ms (hold ~47 ms + 4 x 6.9 ms)
    const q = (t: number) => amp(la, 50, t, 0.02);
    const ref = amp(la, 50, 0.3, 0.1);
    expect(q(1.03 + 0.01)).toBeLessThan(ref - 3);
    expect(Math.abs(q(1.2 + 0.01) - ref)).toBeLessThan(0.3);
  });

  it('matches FL in multiband mode (bands at fc/4 and fc/2, the top band leaking 1/16 into the middle one)', () => {
    // FL, crossover 120 Hz, no boost: 100 Hz tone, output fundamental (linear)
    const ref: Record<number, number> = { 0: 0.7092, 6: 1.2242, 12: 1.4512 };
    for (const lv of [0, 6, 12]) {
      const [y] = render(make({ ...LIN, multiband: 1, crossover: 10000 }), tone(100, lv, 2.5));
      expect(Math.pow(10, amp(y, 100, 1.8) / 20)).toBeCloseTo(ref[lv], 2);
    }
    // FL, default crossover 99.53 Hz: 70 Hz at 0 dB -> -1.56 dB
    const [z] = render(make({ ...LIN, multiband: 1 }), tone(70, 0, 2.5));
    expect(amp(z, 70, 1.8)).toBeCloseTo(-1.56, 1);
  });

  it('diffuses the low band with allpasses totalling one crossover period, crossfaded by Mix', () => {
    // coefficient 0 (depth 50 %): a pure delay of sr / fc = 400 samples at 120 Hz
    const n = SR, x = new Float32Array(n);
    let s = 1;
    for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; x[i] = (s / 2147483647 - 0.5) * 0.2; }
    const [d0] = render(make({ ...LIN, crossover: 10000 }), x);
    const [d1] = render(make({ ...LIN, crossover: 10000, diffMix: 10000, diffDepth: 5000 }), x);
    let best = 0, lag = 0;
    for (let k = 380; k <= 420; k++) { let c = 0; for (let i = 2000; i < n - 500; i++) c += d0[i] * d1[i + k]; if (c > best) { best = c; lag = k; } }
    expect(lag).toBe(398);
    // mix 50 % at c = 0: a comb, (1 + z^-400) / 2, which nulls 60 Hz
    const [h] = render(make({ ...LIN, crossover: 10000, diffMix: 5000 }), tone(60, -12, 2));
    expect(amp(h, 60, 1.2)).toBeLessThan(-40);
  });

  it('inverts the low band, mixes dry/wet linearly and smooths gain changes like FL (~8 ms)', () => {
    const x = tone(50, -12, 1.5);
    const [a] = render(make({ highBand: 0 }), x);
    const [b] = render(make({ highBand: 0, invert: 1 }), x);
    let err = 0; for (let i = SR; i < 1.4 * SR; i++) err = Math.max(err, Math.abs(a[i] + b[i]));
    expect(err).toBeLessThan(1e-6);
    // dry/wet: out(25 %) = 0.75 dry + 0.25 wet
    const p = { lookahead: 0, slope: 10000 };
    const [dry] = render(make({ ...p, dryWet: 0 }), x), [wet] = render(make({ ...p, dryWet: 10000 }), x), [mid] = render(make({ ...p, dryWet: 2500 }), x);
    let e2 = 0; for (let i = SR; i < 1.4 * SR; i++) e2 = Math.max(e2, Math.abs(mid[i] - (0.75 * dry[i] + 0.25 * wet[i])));
    expect(e2).toBeLessThan(1e-5);
    // high gain step 0 dB -> -15.5 dB: FL reaches 63 % of the change about 8 ms later
    const fx = make({ lookahead: 0, lowBand: 0 });
    const y = tone(1000, -12, 0.6);
    const L = Float32Array.from(y), R = Float32Array.from(y);
    const ctx = { sampleRate: SR, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: true, track: 1, sidechain: [], sendTo: () => {} };
    for (let i = 0; i < L.length; i += 128) {
      if (i === 0.3 * SR - (0.3 * SR) % 128) fx.setParams({ ...defaultFxParams('lowlifter'), lookahead: 0, lowBand: 0, highGain: 5000 });
      fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, ctx);
    }
    const t0 = 0.3 * SR - (0.3 * SR) % 128;
    const lvl = (i: number) => peak(L, i, i + 48);
    const g0 = lvl(t0 - 480), g1 = lvl(t0 + 9600), g8 = lvl(t0 + 384);
    expect((g0 - g8) / (g0 - g1)).toBeGreaterThan(0.5);
    expect((g0 - g8) / (g0 - g1)).toBeLessThan(0.75);
  });

  it('is silent for silence and stays finite at extreme settings', () => {
    const [s] = render(make(), new Float32Array(SR));
    expect(peak(s)).toBe(0);
    const n = SR, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (i % 97 < 3 ? 8 : -2) * Math.sin(i * 0.01);
    for (const p of [
      { preGain: 10000, slope: 10000, lowGain: 10000, diffMix: 10000, diffDepth: 0, crossover: 0, multiband: 1 },
      { preGain: 10000, slope: 10000, diffMix: 10000, diffDepth: 10000, crossover: 10000, lowCut: 10000, lookahead: 0 },
    ]) {
      const fx = make(p);
      const [y] = render(fx, x);
      expect(y.every(Number.isFinite)).toBe(true);
      expect(peak(y)).toBeLessThan(200);
      expect(fx.tail).toBeGreaterThan(0.15);
      expect(fx.tail).toBeLessThan(40);
    }
  });
});
