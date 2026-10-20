import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, formatParam, fxDef } from '../../src/model/fx/registry';
import { bassBoostGain, bassBoostHz } from '../../src/model/fx/plugins/bassboost';
import { peak, render } from './util';

function ir(sr: number, freq: number, amount: number, n = sr): Float32Array {
  const fx = createEffect('bassboost', sr, 512);
  fx.setParams({ ...defaultFxParams('bassboost'), freq, amount });
  const x = new Float32Array(n);
  x[0] = 1;
  return render(fx, x, x, 512, { sampleRate: sr })[0];
}

function dbAt(h: Float32Array, f: number, sr: number): number {
  let re = 0, im = 0;
  for (let i = 0; i < h.length; i++) { re += h[i] * Math.cos((2 * Math.PI * f * i) / sr); im -= h[i] * Math.sin((2 * Math.PI * f * i) / sr); }
  return 20 * Math.log10(Math.hypot(re, im));
}

describe('Bass Boost', () => {
  it('is registered as a hidden legacy plugin with FL\'s ranges and texts', () => {
    const d = fxDef('bassboost')!;
    expect(d.name).toBe('Bass Boost');
    expect(d.hidden).toBe(true);
    expect([d.width, d.height]).toEqual([335, 55]);
    expect(d.params.map((p) => [p.key, p.name, p.index, p.min, p.max, p.def])).toEqual([
      ['freq', 'Frequency', 0, 0, 1024, 512], ['amount', 'Amount', 1, 0, 1024, 768],
    ]);
    expect(d.presets).toEqual([{ name: 'Default', params: { freq: 512, amount: 768 } }]);
    const f = (v: number) => formatParam(d.params[0], v);
    expect([0, 32, 96, 512, 1024].map(f)).toEqual(['20 Hz', '22 Hz', '28 Hz', '60 Hz', '100 Hz']); // banker's rounding of 22.5 / 27.5
    expect(bassBoostHz(1000)).toBe(98);
    // FL's amount hint is a bar of "|" (19 at the maximum)
    expect(formatParam(d.params[1], 768)).toBe('|'.repeat(14));
    expect(formatParam(d.params[1], 1024)).toBe('|'.repeat(19));
    expect(formatParam(d.params[1], 0)).toBe('');
    expect(bassBoostGain(768)).toBe(Math.fround(2.520052671432495));
    expect(bassBoostGain(1024)).toBe(5);
    expect(bassBoostGain(0)).toBe(0);
  });

  it('matches FL\'s impulse responses sample for sample', () => {
    // flfxhost renders of FL's plugin (impulse at t = 0, 512-frame blocks)
    const at = [0, 1, 2, 5, 50, 300, 1000, 3000];
    const cases: [number, number, number, number[], number][] = [
      [44100, 512, 768, [1.000184178352356, 0.00036514527164399624, 0.0005430158926174045, 0.0010583027033135295, 0.006104340776801109, 0.004212370608001947, 3.6832632758887485e-05, 7.323632152111959e-12], 3.520052697873444],
      [44100, 0, 1024, [1.0000405311584473, 8.083119610091671e-05, 0.00012090109521523118, 0.00023973982024472207, 0.0017920994432643056, 0.0051820166409015656, 0.0023435468319803476, 2.398674223513808e-05], 5.999999999647485],
      [44100, 1024, 300, [1.00010347366333, 0.00020386415417306125, 0.0003014084359165281, 0.0005772417644038796, 0.002563474467024207, 0.0004258216649759561, 8.62288445091508e-08, 7.857905626524056e-19], 1.5094051941478648],
      [48000, 512, 768, [1.0001553297042847, 0.0003081795875914395, 0.00045862613478675485, 0.0008957364480011165, 0.005333938170224428, 0.004385823383927345, 6.170152482809499e-05, 4.3920728165502965e-11], 3.520052684400554],
    ];
    for (const [sr, freq, amount, ref, sum] of cases) {
      const h = ir(sr, freq, amount);
      at.forEach((i, k) => expect(h[i]).toBe(Math.fround(ref[k])));
      expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 5);
    }
  });

  it('has FL\'s frequency response (default: +9.9 dB at 20 Hz, +4.2 at 60, dip above)', () => {
    const h = ir(44100, 512, 768);
    const ref: [number, number][] = [[20, 9.9], [40, 7.3274], [60, 4.1829], [80, 1.2899], [120, -1.7571], [250, -1.0911], [1000, -0.0769]];
    for (const [f, db] of ref) expect(dbAt(h, f, 44100)).toBeCloseTo(db, 2);
  });

  it('silence in, silence out; finite at the extremes', () => {
    const fx = createEffect('bassboost', 48000, 128);
    fx.setParams({ freq: 1024, amount: 1024 });
    const [L] = render(fx, new Float32Array(4096));
    expect(peak(L)).toBe(0);
    const loud = new Float32Array(48000).map((_, i) => (i % 400 < 200 ? 1 : -1));
    const [M] = render(fx, loud);
    expect(M.every(Number.isFinite)).toBe(true);
    fx.setParams({ freq: NaN, amount: 'x' });
    const [N] = render(fx, new Float32Array(1024).fill(0.1));
    expect(N.every(Number.isFinite)).toBe(true);
  });
});
