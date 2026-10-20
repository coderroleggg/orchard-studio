import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { colorIndex } from '../../src/model/fx/plugins/reeverb';
import { legacyToReeverb2 } from '../../src/engine/effects/plugins/reeverb';
import { makeCtx, render, peak, rms } from './util';

const SR = 48000;
/**
 * The configuration FL's reference values were measured in (flfxhost, 48 kHz):
 * room 32438 (= size 50), diffusion 0, decay 13107 (4.0 s), cuts / damping off,
 * dry 0, reverb 65536.
 */
const BASE = { lowCut: 0, highCut: 65536, predelay: 0, room: 32438, diffusion: 0, color: 20, decay: 13107, damping: 65536, dry: 0, reverb: 65536 };

function ir(params: Record<string, unknown>, seconds: number) {
  const fx = createEffect('reeverb', SR, 128);
  fx.setParams({ ...defaultFxParams('reeverb'), ...params });
  fx.reset();
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  L[0] = 1; R[0] = 1;
  return render(fx, L, R, 128);
}

const fmt = (key: string, v: number) => formatParam(fxParamDef('reeverb', key)!, v);

describe('Reeverb (legacy)', () => {
  it('is registered hidden with FL\'s ranges, Default preset values and editor texts', () => {
    const d = fxDef('reeverb')!;
    expect(d.hidden).toBe(true);
    expect(d.width).toBe(335);
    expect(d.height).toBe(255);
    expect(d.params.map((q) => q.name)).toEqual(['Low cut', 'High cut', 'Predelay', 'Room size', 'Diffusion', 'Color', 'Decay', 'High damping', 'Dry', 'Reverb']);
    expect(d.params.map((q) => q.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(d.params.map((q) => q.max)).toEqual([65536, 65536, 250, 65536, 65536, 40, 65536, 65536, 65536, 65536]);
    expect(defaultFxParams('reeverb')).toMatchObject({ lowCut: 1231, highCut: 10682, predelay: 0, room: 26345, diffusion: 65536, color: 20, decay: 4614, damping: 10879, dry: 65536, reverb: 13238 });
    // the texts FL's editor shows for the constructor state
    expect(fmt('lowCut', 1250)).toBe('75 Hz');
    expect(fmt('lowCut', 0)).toBe('OFF');
    expect(fmt('highCut', 10800)).toBe('4.0 kHz');
    expect(fmt('highCut', 65536)).toBe('OFF');
    expect(fmt('predelay', 0)).toBe('0 ms');
    expect(fmt('room', 26000)).toBe('40 size');
    expect(fmt('diffusion', 65536)).toBe('100');
    expect(fmt('color', 20)).toBe('Flat');
    expect(fmt('decay', 4700)).toBe('1.5  sec');
    expect(fmt('damping', 10800)).toBe('4.0 kHz');
    expect(fmt('dry', 65536)).toBe('100 %');
    expect(fmt('reverb', 13120)).toBe('20 %');
    // Color is Round(v / 10) with Delphi's banker's rounding (measured: 5 = Brighter, 15 / 25 = Flat, 35 = Warmer)
    expect([0, 5, 10, 15, 20, 25, 28, 30, 35, 40].map(colorIndex)).toEqual([0, 0, 1, 2, 2, 2, 3, 3, 4, 4]);
    expect([0, 10, 30, 40].map((v) => fmt('color', v))).toEqual(['Brighter', 'Bright', 'Warm', 'Warmer']);
    expect(d.presets?.length).toBe(21);
    expect(d.presets?.find((p) => p.name === 'Internal/Cathedral')?.params).toMatchObject({ room: 59113, color: 28, decay: 14746 });
  });

  it('maps the raw values onto the Reeverb 2 engine like FL', () => {
    const p = legacyToReeverb2(defaultFxParams('reeverb'));
    expect(p).toMatchObject({ lowCut: 74, highCut: 40, room: 40, diffusion: 100, decay: 15, damping: 40, bass: 100, cross: 500, er: 0, ovEr: 0, ovDry: 1 });
    expect(legacyToReeverb2({ ...BASE, lowCut: 21, highCut: 65535, room: 65536, decay: 0, color: 0 })).toMatchObject({ lowCut: 19, highCut: 220, room: 100, decay: 1, bass: 20 });
  });

  it('matches FL\'s impulse response (echo times, staged decay, linear reverb level)', () => {
    const [L, R] = ir(BASE, 0.45);
    // FL: L 2817 = 1.0, 4429 = 0.93087, 8430 = 0.82717, 15164 = -0.7128, 17254 = 0.68421, 19272 = 0.63691
    const fl: [number, number][] = [[2817, 1], [4429, 0.93087], [8430, 0.82717], [15164, -0.7128], [17254, 0.68421], [19272, 0.63691]];
    for (const [i, a] of fl) expect(L[i]).toBeCloseTo(a, 4);
    expect(L[2816]).toBe(0);
    expect(L[2818]).toBe(0);
    for (const [i, a] of [[2615, 1], [4913, -0.93087], [8631, 0.82717]] as [number, number][]) expect(R[i]).toBeCloseTo(a, 4);
    const [h] = ir({ ...BASE, reverb: 20000 }, 0.1);
    expect(h[2817]).toBeCloseTo(0.305176, 5); // reverb is linear: 20000 / 65536
  });

  it('applies the five color steps as FL\'s bass decay', () => {
    // FL, decay 4614 (1.5 s): second-pass echo and the shelf's ringing after it
    const fl: Record<number, [number, number, number]> = {
      0: [0.30086, -0.10041, -0.06053],
      10: [0.35893, -0.00873, -0.00796],
      30: [0.36561, 0.0041, 0.00384],
      40: [0.36812, 0.00895, 0.00838],
    };
    for (const [col, ref] of Object.entries(fl)) {
      const [L] = ir({ ...BASE, decay: 4614, color: Number(col) }, 0.4);
      expect(L[4429]).toBeCloseTo(0.84116, 4);
      expect(L[17254]).toBeCloseTo(ref[0], 4);
      expect(L[17255]).toBeCloseTo(ref[1], 4);
      expect(L[17256]).toBeCloseTo(ref[2], 4);
    }
  });

  it('delays by whole milliseconds and passes dry linearly', () => {
    const first = (x: Float32Array) => x.findIndex((v) => Math.abs(v) > 1e-6);
    expect(first(ir({ ...BASE, predelay: 70 }, 0.3)[0])).toBe(6176); // FL: 2817 + 3359
    expect(first(ir({ ...BASE, predelay: 1 }, 0.3)[0])).toBe(2864); // FL: 2817 + 47
    const [d] = ir({ ...BASE, dry: 30000, reverb: 0 }, 0.2);
    expect(d[0]).toBeCloseTo(0.457764, 5);
    expect(peak(d, 1)).toBe(0);
  });

  it('matches FL with cuts, damping and diffusion (Cathedral at size 50)', () => {
    const [L, R] = ir({ lowCut: 338, highCut: 4981, predelay: 0, room: 32438, diffusion: 65536, color: 28, decay: 14746, damping: 7930, dry: 0, reverb: 26345 }, 2);
    // FL window RMS (L / R)
    const win: [number, number, number, number][] = [
      [0, 4800, 2.074298e-3, 1.957898e-3],
      [4800, 24000, 1.756043e-3, 1.854469e-3],
      [24000, 48000, 9.907443e-4, 1.017124e-3],
      [48000, 96000, 4.43589e-4, 4.492973e-4],
    ];
    for (const [a, b, l, r] of win) {
      expect(rms(L, a, b) / l).toBeCloseTo(1, 3);
      expect(rms(R, a, b) / r).toBeCloseTo(1, 3);
    }
    // single samples agree to about 0.1 % (the diffusers' allpass laws are fitted)
    expect(L[3000] / -0.00500278).toBeCloseTo(1, 2);
    expect(L[12000] / -0.000328201).toBeCloseTo(1, 2);
  });

  it('is silent for silence, has a bounded tail and stays finite', () => {
    const fx = createEffect('reeverb', SR, 128);
    fx.setParams(defaultFxParams('reeverb'));
    fx.reset();
    const z = new Float32Array(SR / 2);
    const [L, R] = render(fx, z, z);
    expect(peak(L)).toBe(0);
    expect(peak(R)).toBe(0);
    expect(fx.tail).toBeGreaterThan(1.388 * 1.5);
    expect(fx.tail).toBeLessThan(5);
    fx.setParams({ ...defaultFxParams('reeverb'), decay: 65536, color: 40, predelay: 250, room: 65536 });
    expect(fx.tail).toBeLessThan(70);
    expect(fx.tail).toBeGreaterThan(40);
    const noise = new Float32Array(SR / 2);
    let seed = 3;
    for (let i = 0; i < noise.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = (seed / 0x7fffffff - 0.5) * 1.8; }
    for (const e of [{ room: 0, decay: 65536, color: 40, diffusion: 65536, reverb: 65536 }, { room: 65536, decay: 0, color: 0, lowCut: 65536, highCut: 0, damping: 0 }]) {
      fx.setParams({ ...defaultFxParams('reeverb'), ...e });
      fx.reset();
      const [a, b] = render(fx, noise, noise);
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error(`non-finite at ${i}`);
      expect(peak(a)).toBeLessThan(60);
    }
    // FL's legacy Reeverb switches its dry and reverb levels at once (measured: dry 100 % -> 30.5 % from the next sample)
    fx.setParams({ ...defaultFxParams('reeverb'), reverb: 0 });
    fx.reset();
    fx.setParams({ ...defaultFxParams('reeverb'), reverb: 0, dry: 20000 });
    const one = new Float32Array(128).fill(1);
    const o = Float32Array.from(one), o2 = Float32Array.from(one);
    fx.process(o, o2, 128, makeCtx());
    expect(o[0]).toBeCloseTo(20000 / 65536, 6);
    expect(o[127]).toBeCloseTo(20000 / 65536, 6);
  });
});
