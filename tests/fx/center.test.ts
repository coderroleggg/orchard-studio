import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, formatParam, fxDef, fxInCategory } from '../../src/model/fx/registry';
import { peak, render } from './util';

function make(sr: number, params: Record<string, unknown> = {}) {
  const fx = createEffect('center', sr, 512);
  fx.setParams({ ...defaultFxParams('center'), ...params });
  return fx;
}

describe('Center', () => {
  it('is registered as a hidden legacy plugin with FL\'s switch', () => {
    const d = fxDef('center')!;
    expect(d.name).toBe('Center');
    expect(d.hidden).toBe(true);
    expect(fxInCategory(d.category).some((x) => x.id === 'center')).toBe(false);
    expect([d.width, d.height]).toEqual([170, 55]);
    expect(d.params.map((p) => [p.key, p.name, p.index, p.min, p.max, p.def])).toEqual([['status', 'Status', 0, 0, 1, 1]]);
    expect(formatParam(d.params[0], 0)).toBe('Off');
    expect(formatParam(d.params[0], 1)).toBe('On');
    expect(d.presets).toEqual([{ name: 'Default', params: { status: 1 } }]);
  });

  it('matches FL\'s DC step response sample for sample (44.1 and 48 kHz)', () => {
    // flfxhost renders of FL's plugin, 0.5 DC from t = 0, 512-frame blocks
    const idx = [0, 1, 2, 10, 100, 1000, 10000, 44099];
    const ref: Record<number, number[]> = {
      44100: [0.49999770522117615, 0.499993234872818, 0.4999866485595703, 0.49986767768859863, 0.49559450149536133, 0.4470888078212738, 0.1595396101474762, 0.0032158419489860535],
      48000: [0.49999791383743286, 0.49999380111694336, 0.49998775124549866, 0.4998784363269806, 0.4959515333175659, 0.451180636882782, 0.17509785294532776, 0.004850977566093206],
    };
    for (const sr of [44100, 48000]) {
      const [L, R] = render(make(sr), new Float32Array(44100).fill(0.5), undefined, 512, { sampleRate: sr });
      idx.forEach((i, k) => {
        expect(L[i]).toBe(Math.fround(ref[sr][k]));
        expect(R[i]).toBe(L[i]);
      });
    }
  });

  it('removes a DC offset and keeps the audio', () => {
    const sr = 48000;
    const x = new Float32Array(sr * 4).map((_, i) => 0.3 + 0.4 * Math.sin((2 * Math.PI * 1000 * i) / sr));
    const [L] = render(make(sr), x, undefined, 128, { sampleRate: sr });
    let mean = 0;
    for (let i = sr * 3; i < sr * 4; i++) mean += L[i];
    mean /= sr;
    expect(Math.abs(mean)).toBeLessThan(0.002);
    expect(peak(L, sr * 3)).toBeCloseTo(0.4, 2);
  });

  it('Status Off passes the input untouched and freezes the follower', () => {
    const sr = 44100;
    const fx = make(sr);
    const dc = new Float32Array(4096).fill(0.5);
    const [a] = render(fx, dc, undefined, 512, { sampleRate: sr });
    fx.setParams({ status: 0 });
    const [b] = render(fx, dc, undefined, 512, { sampleRate: sr });
    expect(Array.from(b.subarray(0, 8))).toEqual(Array(8).fill(0.5));
    fx.setParams({ status: 1 });
    const [c] = render(fx, dc, undefined, 512, { sampleRate: sr });
    // continues from where it stopped (not from a fresh state)
    expect(c[0]).toBeLessThan(a[4095]);
    expect(Math.abs(c[0] - a[4095])).toBeLessThan(1e-4);
  });

  it('silence in, silence out; recovers from non-finite input', () => {
    const fx = make(48000);
    const [L] = render(fx, new Float32Array(2048));
    expect(peak(L)).toBe(0);
    const bad = new Float32Array(512).fill(NaN);
    render(fx, bad);
    const [M] = render(fx, new Float32Array(1024).fill(0.25));
    expect(M.every(Number.isFinite)).toBe(true);
  });
});
