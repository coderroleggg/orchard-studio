import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { filterF, filterMix, filterQ } from '../../src/model/fx/plugins/filter';
import { makeCtx, render, rms, sine } from './util';

const DEF = { cutoff: 1024, res: 205, lp: 1024, bp: 0, hp: 512, x2: 0, center: 1 };

/** Impulse response of the filter with the given settings (steady state, no ramps). */
function impulse(p: Record<string, number>, n = 64): Float32Array {
  const fx = createEffect('filter', 48000, 128);
  fx.setParams({ ...DEF, ...p });
  fx.reset();
  const x = new Float32Array(n); x[0] = 1;
  return render(fx, x)[0];
}

describe('Filter', () => {
  it('is registered with FL ranges and defaults', () => {
    const d = fxDef('filter')!;
    expect(d.name).toBe('Filter');
    expect(d.category).toBe('Filter');
    expect([d.width, d.height]).toEqual([500, 105]);
    expect(defaultFxParams('filter')).toEqual(DEF);
    expect(d.params.filter((p) => p.index !== undefined).map((p) => p.name)).toEqual(['Cutoff frequency', 'Resonance', 'Low pass', 'Band pass', 'High pass', 'X 2']);
    expect(formatParam(fxParamDef('filter', 'res')!, 205)).toBe('20%');
    expect(formatParam(fxParamDef('filter', 'x2')!, 1)).toBe('On');
    // FL's factory presets; Default equals the initial state
    expect(d.presets!.map((p) => p.name)).toEqual(['Default', 'Party next door', 'Retro sound', 'Tiny speakers']);
    expect(d.presets![0].params).toEqual(DEF);
  });

  it('maps the wheels like FL (measured coefficients)', () => {
    expect(filterF(1024)).toBeCloseTo(1, 6);
    expect(filterF(512)).toBeCloseTo(0.163957, 5);
    expect(filterF(256)).toBeCloseTo(0.050323, 5);
    expect(filterQ(0)).toBe(1);
    expect(filterQ(1024)).toBeCloseTo(0.2, 6);
    expect(filterMix(512)).toBeCloseTo(0.231658, 5);
    expect(filterMix(768)).toBeCloseTo(0.504, 4);
  });

  it('matches FL impulse responses', () => {
    // values rendered by FL's Fruity Filter (48 kHz, CENTER on)
    const lp = impulse({ cutoff: 1024, res: 205, lp: 1024, bp: 0, hp: 0 });
    [0, 0.99998, 0.16011, -0.13457, -0.04727, 0.01388].forEach((v, i) => expect(lp[i]).toBeCloseTo(v, 4));
    const bp = impulse({ cutoff: 512, res: 0, lp: 0, bp: 1024, hp: 0 });
    [0.16396, 0.13266, 0.10293, 0.0753, 0.05017, 0.02781].forEach((v, i) => expect(bp[i]).toBeCloseTo(v, 4));
    const hp = impulse({ cutoff: 1024, res: 0, lp: 0, bp: 0, hp: 1024 });
    [0.99998, -2, 1, 0].forEach((v, i) => expect(hp[i]).toBeCloseTo(v, 4));
    // X 2: second stage without resonance, mix applied twice
    const x2 = impulse({ cutoff: 768, res: 0, lp: 512, bp: 0, hp: 0, x2: 1 });
    [0, 0, 0.001679, 0.00471, 0.007962, 0.010342].forEach((v, i) => expect(x2[i]).toBeCloseTo(v, 5));
    const x2r = impulse({ cutoff: 900, res: 1024, lp: 0, bp: 1024, hp: 0, x2: 1 });
    [0.4368, 0.1455, -0.3148, -0.544, -0.4269, -0.0792].forEach((v, i) => expect(x2r[i]).toBeCloseTo(v, 3));
  });

  it('low pass attenuates above the cutoff', () => {
    const fx = createEffect('filter', 48000, 128);
    fx.setParams({ ...DEF, cutoff: 400, res: 0, hp: 0 }); // f = 0.105, ~800 Hz
    fx.reset();
    const lo = render(fx, sine(100, 0.5))[0];
    fx.reset();
    const hi = render(fx, sine(8000, 0.5))[0];
    expect(rms(lo, 12000)).toBeGreaterThan(0.3);
    expect(rms(hi, 12000)).toBeLessThan(0.01);
  });

  it('ramps parameter changes across a block like FL', () => {
    const fx = createEffect('filter', 48000, 128);
    fx.setParams({ ...DEF, lp: 1024, hp: 512 });
    fx.reset();
    fx.setParams({ ...DEF, lp: 1024, hp: 0 });
    // impulse train: each impulse's first sample shows the high pass gain (HP[0] = 1, LP[0] = 0)
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let i = 0; i < 128; i += 16) { L[i] = 1; R[i] = 1; }
    fx.process(L, R, 128, makeCtx());
    expect(L[0]).toBeCloseTo(0.2299, 3);
    expect(L[64]).toBeCloseTo(0.2317 * (1 - 65 / 128), 2);
    expect(Math.abs(L[112])).toBeLessThan(0.04);
  });

  it('removes DC with CENTER on and passes it with CENTER off', () => {
    const dc = new Float32Array(48000).fill(0.5);
    const on = createEffect('filter', 48000, 128);
    on.setParams({ ...DEF, hp: 0 });
    on.reset();
    expect(Math.abs(render(on, dc)[0][47999])).toBeLessThan(0.01);
    const off = createEffect('filter', 48000, 128);
    off.setParams({ ...DEF, hp: 0, center: 0 });
    off.reset();
    expect(render(off, dc)[0][47999]).toBeCloseTo(0.5, 3);
  });

  it('stays silent on silence and finite at extreme settings', () => {
    const fx = createEffect('filter', 48000, 128);
    fx.setParams(DEF);
    fx.reset();
    const [s] = render(fx, new Float32Array(4800));
    expect(rms(s)).toBe(0);
    const noise = new Float32Array(48000);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 4;
    for (const p of [
      { cutoff: 1024, res: 1024, lp: 1024, bp: 1024, hp: 1024, x2: 1 },
      { cutoff: 0, res: 1024, lp: 1024, bp: 1024, hp: 1024, x2: 1 },
      { cutoff: 1, res: 1024, lp: 0, bp: 1024, hp: 0, x2: 0, center: 0 },
    ]) {
      fx.setParams({ ...DEF, ...p });
      fx.reset();
      const [o] = render(fx, noise);
      expect(o.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});
