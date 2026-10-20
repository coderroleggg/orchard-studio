import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { fsFreqText, fsHz, fsMixText, fsRingHz } from '../../src/model/fx/plugins/freqshifter';
import { makeCtx, render, rms, sine } from './util';

const SR = 48000;

/** Level (dBFS of a sine's peak) at a frequency, by correlation over a window. */
function level(x: Float32Array, f: number, a = 12000, n = 48000): number {
  let re = 0, im = 0, w = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const t = (2 * Math.PI * f * (a + i)) / SR;
    re += x[a + i] * Math.cos(t) * h;
    im += x[a + i] * Math.sin(t) * h;
    w += h;
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / w + 1e-12);
}

function run(params: Record<string, unknown>, input: Float32Array, ctx: Record<string, unknown> = {}) {
  const fx = createEffect('freqshifter', SR, 512);
  fx.setParams({ ...defaultFxParams('freqshifter'), ...params });
  fx.reset();
  return render(fx, input, input, 512, { tempo: 120, ...ctx });
}

const HZ100 = 63617; // +100 Hz in the 200 Hz range

describe('Frequency Shifter', () => {
  it('is registered with FL parameters, defaults (Default preset) and value texts', () => {
    const d = fxDef('freqshifter')!;
    expect(d.width).toBe(460);
    expect(d.params.map((p) => p.name)).toEqual(['Dry/Wet mix', 'Type', 'Frequency', 'L/R Phase', 'Left shape', 'Right Shape', 'Feedback', 'Stereo', 'Type', 'Start phase']);
    const p = defaultFxParams('freqshifter');
    expect([p.mix, p.type, p.freq, p.lrphase, p.lshape, p.rshape, p.feedback, p.stereo, p.range, p.start]).toEqual([10000, 0, 70000, 0, 10000, 10000, 5000, 10000, 1, 5000]);
    // FL's GetName texts
    expect(fsFreqText(5000, 0)).toBe('0.24Hz');
    expect(fsFreqText(-35000, 0)).toBe('-44.7Hz');
    expect(fsFreqText(45000, 0)).toBe('256Hz');
    expect(fsFreqText(70000, 0)).toBe('20000Hz');
    expect(fsFreqText(0, 0)).toBe('0.00Hz');
    expect(fsFreqText(40000, 1)).toBe('7.70Hz');
    expect(fsFreqText(70000, 1)).toBe('200Hz');
    expect(fsFreqText(50000, 1, 2)).toBe('67.5Hz');
    // tempo range: FL's own single-precision rounding
    const tempo: [number, string][] = [[10000, '63:47'], [-10000, '-64:0'], [30000, '15:47'], [-30000, '-16:0'], [50000, '3:47'], [-60000, '-1:47'], [0, '128:0'], [5000, '90:24'], [70000, '1:0']];
    for (const [v, t] of tempo) expect(fsFreqText(v, 2)).toBe(t);
    expect(fsMixText(0)).toBe('100% Dry');
    expect(fsMixText(1250)).toBe('88% Dry');
    expect(fsMixText(3750)).toBe('62% Dry');
    expect(fsMixText(5000)).toBe('50% Wet');
    expect(fsMixText(6250)).toBe('62% Wet');
    expect(formatParam(d.params[7], 3750)).toBe('38% Stereo');
    expect(formatParam(d.params[3], 0)).toBe('-100.0%');
    expect(formatParam(d.params[1], 2)).toBe('Ring Modulator');
    expect(formatParam(d.params[8], 2)).toBe('Tempo');
    expect(d.presets!.map((q) => q.name)).toEqual(['+800 Hz', '-800 Hz', 'Default', 'Dry', 'Phaser', 'Phaser feedback', 'Phaser stereo', 'Ring mod', 'Stereoizer']);
    expect(fsHz(51542, 0)).toBeGreaterThan(799);
    expect(fsHz(51542, 0)).toBeLessThan(802);
    expect(fsRingHz(HZ100, 1)).toBeCloseTo(141.4, 0);
  });

  it('shifts a sine up by the set frequency with FL\'s sideband suppression', () => {
    // FL (same measurement on its output): 1100 Hz at -6.00 dBFS, 900 Hz at -55.0 dBFS, 1000 Hz below -140
    for (const type of [0, 1]) {
      const [L] = run({ type, range: 1, freq: HZ100 }, sine(1000, 2));
      expect(level(L, 1100)).toBeCloseTo(-6.0, 1);
      expect(Math.abs(level(L, 900) + 55.0)).toBeLessThan(2.5);
      expect(level(L, 1000)).toBeLessThan(-100);
    }
  });

  it('follows the sideband shape: -100% shifts down, 0% gives both sidebands (FL levels)', () => {
    const [dn] = run({ type: 1, range: 1, freq: HZ100, lshape: 0, rshape: 0 }, sine(1000, 2));
    expect(level(dn, 900)).toBeCloseTo(-6.0, 1);
    expect(Math.abs(level(dn, 1100) + 55.0)).toBeLessThan(2.5);
    const [both] = run({ type: 1, range: 1, freq: HZ100, lshape: 5000, rshape: 5000 }, sine(1000, 2));
    expect(level(both, 1100)).toBeCloseTo(-12.03, 1);
    expect(level(both, 900)).toBeCloseTo(-12.03, 1);
    const [half] = run({ type: 1, range: 1, freq: HZ100, lshape: 7500, rshape: 7500 }, sine(1000, 2));
    expect(level(half, 1100)).toBeCloseTo(-8.50, 1);
    expect(level(half, 900)).toBeCloseTo(-18.05, 1);
  });

  it('folds at Nyquist in the normal mode and filters the fold in HQ (FL: -6.6 vs -61.7 dB)', () => {
    const x = sine(15000, 2);
    const [n] = run({ type: 1, range: 0, freq: 66025 }, x); // +10 kHz: 25 kHz folds to 23 kHz
    expect(Math.abs(level(n, 23000) + 6.57)).toBeLessThan(1);
    const [h] = run({ type: 0, range: 0, freq: 66025 }, x);
    expect(level(h, 23000)).toBeLessThan(-58);
    // through zero: 1 kHz - 2 kHz folds to 1 kHz in the normal mode (FL -6.0 dB), HQ removes it (FL -103 dB)
    const [zn] = run({ type: 1, range: 0, freq: -56795 }, sine(1000, 2));
    expect(level(zn, 1000)).toBeCloseTo(-6.0, 1);
    const [z] = run({ type: 0, range: 0, freq: -56795 }, sine(1000, 2));
    expect(level(z, 1000)).toBeLessThan(-95);
  });

  it('syncs to the tempo: one step per cycle at 120 BPM is an 8 Hz shift', () => {
    const [L] = run({ type: 1, range: 2, freq: 70000 }, sine(1000, 2));
    expect(level(L, 1008)).toBeCloseTo(-6.0, 1);
    expect(Math.abs(level(L, 992) + 55.0)).toBeLessThan(2.5);
    expect(level(L, 1000)).toBeLessThan(-100);
    // 60 BPM halves it
    const [S] = run({ type: 1, range: 2, freq: 70000 }, sine(1000, 2), { tempo: 60 });
    expect(level(S, 1004)).toBeCloseTo(-6.0, 1);
  });

  it('ring-modulates with FL\'s ring frequency curve and passes the input for negative values', () => {
    // FL: "100 Hz" rings at sqrt(200 * 100) = 141.4 Hz: sidebands 858.6 / 1141.4 Hz at -12.03 dBFS, no carrier
    const [L] = run({ type: 2, range: 1, freq: HZ100 }, sine(1000, 2));
    expect(level(L, 858.58)).toBeCloseTo(-12.03, 1);
    expect(level(L, 1141.42)).toBeCloseTo(-12.03, 1);
    expect(level(L, 1000)).toBeLessThan(-100);
    // 1 kHz in the 20 kHz range rings at sqrt(20000 * 1000) = 4472 Hz (FL: 1472 / 7472 Hz at -12.03)
    const [K] = run({ type: 2, range: 0, freq: 52820 }, sine(3000, 1));
    expect(level(K, 1472.1, 6000, 24000)).toBeCloseTo(-12.03, 1);
    expect(level(K, 7472.1, 6000, 24000)).toBeCloseTo(-12.03, 1);
    // negative values: the input passes unmodulated (FL -6.01)
    const [neg] = run({ type: 2, range: 1, freq: -70000 }, sine(3000, 1));
    expect(level(neg, 3000, 6000, 24000)).toBeCloseTo(-6.0, 1);
  });

  it('uses the sidechain as the ring modulator when one is selected', () => {
    const n = SR;
    const mod = sine(50, 1, 1);
    const fx = createEffect('freqshifter', SR, 512);
    fx.setParams({ ...defaultFxParams('freqshifter'), type: 2, sidechain: 3 });
    fx.reset();
    const x = sine(1000, 1);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    for (let i = 0; i < n; i += 512) {
      const m = Math.min(512, n - i);
      const ctx = makeCtx({ sidechain: [{ source: 3, L: mod.subarray(i, i + m), R: mod.subarray(i, i + m) }] });
      fx.process(L.subarray(i, i + m), R.subarray(i, i + m), m, ctx);
    }
    expect(level(L, 1050, 6000, 24000)).toBeCloseTo(-12, 0);
    expect(level(L, 950, 6000, 24000)).toBeCloseTo(-12, 0);
  });

  it('mixes dry and wet each at full level up to the middle (FL: 75% dry = dry 0 dB, wet -6 dB)', () => {
    const [L] = run({ type: 1, range: 1, freq: HZ100, mix: 2500 }, sine(1000, 1));
    expect(level(L, 1000, 6000, 24000)).toBeCloseTo(-6.0, 1);
    expect(level(L, 1100, 6000, 24000)).toBeCloseTo(-12.02, 1);
  });

  it('builds a decaying series of shifted copies with feedback (FL levels at +50%, +100%, -100%)', () => {
    const x = sine(1000, 2, Math.pow(10, -12 / 20));
    const fl: [number, number[]][] = [[7500, [-12.02, -18.05, -24.14, -30.26]], [10000, [-12.17, -13.21, -14.53, -16.06]], [0, [-12.17, -13.21, -14.53, -16.06]]];
    for (const [feedback, want] of fl) {
      const [L] = run({ type: 1, range: 1, freq: HZ100, feedback }, x);
      [1100, 1200, 1300, 1400].forEach((f, k) => expect(Math.abs(level(L, f) - want[k])).toBeLessThan(0.3));
    }
    // a loud input at 100% stays bounded
    const [M] = run({ type: 1, range: 1, freq: HZ100, feedback: 10000 }, sine(1000, 2, 0.5));
    expect(Math.max(...M.map(Math.abs))).toBeLessThan(4);
  });

  it('offsets the right oscillator by the L/R phase (0..90 degrees) and narrows with Stereo', () => {
    // FL: the mono sum of a 5 Hz shift is -6.00 / -6.69 / -9.01 dB at L/R phase -100% / 0% / +100% (0 / 45 / 90 degrees)
    for (const [lrphase, want] of [[0, -6.0], [5000, -6.69], [10000, -9.01]]) {
      const [L, R] = run({ type: 1, range: 1, freq: 36028, lrphase }, sine(1000, 2));
      const m = L.map((v, i) => 0.5 * (v + R[i]));
      expect(level(m, 1005)).toBeCloseTo(want, 1);
      expect(level(R, 1005)).toBeCloseTo(-6.0, 1);
    }
    const [l2, r2] = run({ type: 1, range: 1, freq: 36028, lrphase: 10000, stereo: 0 }, sine(1000, 1));
    for (let i = 20000; i < 21000; i++) expect(l2[i]).toBeCloseTo(r2[i], 6);
  });

  it('smooths frequency and mix changes, keeps silence silent and stays finite', () => {
    // step changes of the shift and of the mix: no step in the output (a 1.1 kHz sine at 0.5 moves < 0.072 per sample)
    const step = (a: Record<string, number>, b: Record<string, number>): number => {
      const fx = createEffect('freqshifter', SR, 512);
      fx.setParams({ ...defaultFxParams('freqshifter'), type: 1, range: 1, ...a });
      fx.reset();
      const x = sine(1000, 0.1);
      const L = Float32Array.from(x), R = Float32Array.from(x);
      fx.process(L.subarray(0, 2048), R.subarray(0, 2048), 2048, makeCtx());
      fx.setParams({ ...defaultFxParams('freqshifter'), type: 1, range: 1, ...b });
      for (let i = 2048; i < 4096; i += 128) fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, makeCtx());
      let jump = 0;
      for (let i = 1024; i < 4096; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
      return jump;
    };
    expect(step({ freq: 0 }, { freq: HZ100 })).toBeLessThan(0.075);
    expect(step({ freq: HZ100, mix: 0 }, { freq: HZ100, mix: 10000 })).toBeLessThan(0.075);
    expect(step({ freq: HZ100, lshape: 10000, rshape: 10000 }, { freq: HZ100, lshape: 0, rshape: 0 })).toBeLessThan(0.075);
    // the frequency glides (20 ms): 2 ms after a jump to +20 kHz the shift is still far below it
    const fx = createEffect('freqshifter', SR, 128);
    fx.setParams({ ...defaultFxParams('freqshifter'), type: 1, range: 0, freq: 0 });
    fx.reset();
    const x = sine(1000, 0.05);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    fx.process(L.subarray(0, 1024), R.subarray(0, 1024), 1024, makeCtx());
    fx.setParams({ ...defaultFxParams('freqshifter'), type: 1, range: 0, freq: 70000 });
    fx.process(L.subarray(1024, 1120), R.subarray(1024, 1120), 96, makeCtx());
    let crossings = 0;
    for (let i = 1025; i < 1120; i++) if ((L[i - 1] < 0) !== (L[i] < 0)) crossings++;
    expect(crossings).toBeLessThan(25); // 21 kHz would cross ~84 times in 2 ms
    const [s] = run({ type: 0, freq: 30000, feedback: 10000 }, new Float32Array(SR / 4));
    expect(rms(s)).toBe(0);
    for (const type of [0, 1, 2]) {
      for (const freq of [-70000, -1, 1, 70000]) {
        const n = new Float32Array(SR / 2);
        for (let i = 0; i < n.length; i++) n[i] = (Math.random() * 2 - 1) * (i % 1000 === 0 ? 20 : 1);
        const [o] = run({ type, freq, range: 0, feedback: 0, lrphase: 10000, start: 0 }, n);
        expect(o.every((v) => Number.isFinite(v))).toBe(true);
      }
    }
  });
});
