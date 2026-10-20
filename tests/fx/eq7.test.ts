import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { render, rms, sine, peak } from './util';

function impulse(p: Record<string, number>, n = 6, sr = 48000): Float32Array {
  const fx = createEffect('eq7', sr, 128);
  fx.setParams(p);
  fx.reset();
  const x = new Float32Array(2048); x[0] = 1;
  return render(fx, x)[0].slice(0, n);
}

const gainAt = (p: Record<string, number>, f: number, sr = 48000) => {
  const fx = createEffect('eq7', sr, 128);
  fx.setParams(p);
  fx.reset();
  return rms(render(fx, sine(f, 1, 0.1, sr))[0], sr / 2) / (0.1 / Math.SQRT2);
};

describe('7 Band EQ', () => {
  it('is registered as a hidden legacy plugin with FL ranges, texts and presets', () => {
    const d = fxDef('eq7')!;
    expect(d.name).toBe('7 Band EQ');
    expect(d.hidden).toBe(true);
    expect([d.width, d.height]).toEqual([340, 150]);
    const def = defaultFxParams('eq7');
    expect(Object.keys(def)).toEqual(['band1', 'band2', 'band3', 'band4', 'band5', 'band6', 'band7']);
    expect(Object.values(def).every((v) => v === 0)).toBe(true);
    expect(formatParam(fxParamDef('eq7', 'band1')!, 0)).toBe('0.0dB');
    expect(formatParam(fxParamDef('eq7', 'band3')!, -1130)).toBe('-11.3dB');
    expect(d.presets!.length).toBe(14);
    expect(d.presets!.find((p) => p.name === 'Telephone')!.params).toEqual({ band1: -1800, band2: -1800, band3: -56, band4: 1800, band5: 1181, band6: -900, band7: -1800 });
  });

  it('matches FL impulse responses (48 kHz)', () => {
    [1.158653, 0.283033, 0.215301, 0.150446, 0.09066, 0.037542].forEach((v, i) => expect(impulse({ band4: 900 })[i]).toBeCloseTo(v, 5));
    [3.474343, -3.185147, 0.914997, -0.262851, 0.075509, -0.021691].forEach((v, i) => expect(impulse({ band7: 1800 })[i]).toBeCloseTo(v, 5));
    [0.993354, -0.013174, -0.01294, -0.01271, -0.012485, -0.012263].forEach((v, i) => expect(impulse({ band1: -1200 })[i]).toBeCloseTo(v, 5));
    const tel = { band1: -1800, band2: -1800, band3: -56, band4: 1800, band5: 1181, band6: -900, band7: -1800 };
    [0.35661, 0.466092, 0.472278, 0.458241, 0.397159, 0.273342].forEach((v, i) => expect(impulse(tel)[i]).toBeCloseTo(v, 5));
  });

  it('flat bands pass the signal unchanged; bands sit at their 44.1 kHz design frequencies', () => {
    expect(Array.from(impulse({}))).toEqual([1, 0, 0, 0, 0, 0]);
    // peaking 1500 Hz band: +12 dB at 1500 Hz at 44.1 kHz, at 1500 * 48 / 44.1 Hz at 48 kHz
    expect(20 * Math.log10(gainAt({ band4: 1200 }, 1500, 44100))).toBeCloseTo(12, 1);
    expect(20 * Math.log10(gainAt({ band4: 1200 }, 1500 * 48 / 44.1, 48000))).toBeCloseTo(12, 1);
    // first order shelves: half the gain at the midpoint frequency
    expect(20 * Math.log10(gainAt({ band7: 1200 }, 8000, 44100))).toBeCloseTo(6, 1);
    expect(20 * Math.log10(gainAt({ band1: -1200 }, 63, 44100))).toBeCloseTo(-6, 1);
  });

  it('stays finite and silent', () => {
    const fx = createEffect('eq7', 48000, 128);
    fx.setParams({ band1: 1800, band2: 1800, band3: 1800, band4: 1800, band5: 1800, band6: 1800, band7: 1800 });
    fx.reset();
    expect(Number.isFinite(rms(render(fx, sine(50, 0.5, 1))[0]))).toBe(true);
    expect(peak(render(fx, new Float32Array(48000))[0], 47000)).toBeLessThan(1e-4);
  });
});
