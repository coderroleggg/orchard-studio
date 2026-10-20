import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { fastLpF, fastLpR } from '../../src/model/fx/plugins/fastlp';
import { makeCtx, render, rms, sine, peak } from './util';

function impulse(p: Record<string, number>, n = 8): Float32Array {
  const fx = createEffect('fastlp', 48000, 128);
  fx.setParams({ cutoff: 1024, res: 0, ...p });
  fx.reset();
  const x = new Float32Array(512); x[0] = 1;
  return render(fx, x)[0].slice(0, n);
}

describe('Fast LP', () => {
  it('is registered as a hidden legacy plugin with FL ranges', () => {
    const d = fxDef('fastlp')!;
    expect(d.name).toBe('Fast LP');
    expect(d.hidden).toBe(true);
    expect([d.width, d.height]).toEqual([335, 55]);
    expect(defaultFxParams('fastlp')).toEqual({ cutoff: 1024, res: 0 });
    expect(d.params.map((p) => [p.name, p.index, p.min, p.max])).toEqual([['Cutoff', 0, 0, 1024], ['Resonance', 1, 0, 1024]]);
    expect(formatParam(fxParamDef('fastlp', 'cutoff')!, 512)).toBe('50%');
  });

  it('maps the wheels like FL (measured coefficients, any sample rate)', () => {
    expect(fastLpF(1024)).toBeCloseTo(1, 9);
    expect(fastLpF(768)).toBeCloseTo(0.20575762, 6);
    expect(fastLpF(512)).toBeCloseTo(0.04128657, 7);
    expect(fastLpF(128)).toBeCloseTo(0.00238096, 7);
    expect(fastLpF(0)).toBeCloseTo(0.00017524, 7);
    expect(fastLpR(0)).toBe(0);
    expect(fastLpR(256)).toBeCloseTo(0.6330933, 5);
    expect(fastLpR(512)).toBeCloseTo(0.86604632, 5);
    expect(fastLpR(1024)).toBeCloseTo(0.98330438, 6);
  });

  it('matches FL impulse responses', () => {
    expect(Array.from(impulse({ cutoff: 1024 }))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    // FL: cutoff 768 (one pole)
    [0.20576, 0.16342, 0.1298, 0.10309, 0.08188, 0.06503].forEach((v, i) => expect(impulse({ cutoff: 768 })[i]).toBeCloseTo(v, 4));
    // FL: cutoff 512, resonance 512 / 1024 (y = f x + (1 + r - f) y1 - r y2)
    [0.04129, 0.07534, 0.10172, 0.12036, 0.13154, 0.13579].forEach((v, i) => expect(impulse({ cutoff: 512, res: 512 })[i]).toBeCloseTo(v, 4));
    [0.04129, 0.08018, 0.11511, 0.14471, 0.16784, 0.18365].forEach((v, i) => expect(impulse({ cutoff: 512, res: 1024 })[i]).toBeCloseTo(v, 4));
  });

  it('low passes with a resonant peak', () => {
    const fx = createEffect('fastlp', 48000, 128);
    fx.setParams({ cutoff: 400, res: 900 });
    fx.reset();
    expect(rms(render(fx, sine(8000, 0.5))[0], 12000)).toBeLessThan(0.01);
    fx.reset();
    expect(rms(render(fx, sine(60, 0.5))[0], 12000)).toBeGreaterThan(0.3);
  });

  it('applies resonance at once and ramps the cutoff (measured on parameter jumps)', () => {
    const fx = createEffect('fastlp', 48000, 512);
    fx.setParams({ cutoff: 600, res: 0 });
    fx.reset();
    const x = new Float32Array(512).fill(0.5);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    fx.process(L, R, 512, makeCtx({ blockSize: 512 }));
    fx.setParams({ cutoff: 600, res: 1000 });
    const L2 = new Float32Array(512), R2 = new Float32Array(512);
    fx.process(L2, R2, 512, makeCtx({ blockSize: 512 }));
    // with r applied at once the decay overshoots immediately (momentum)
    expect(L2[200]).toBeLessThan(0);
  });

  it('stays finite and silent', () => {
    const fx = createEffect('fastlp', 48000, 128);
    fx.setParams({ cutoff: 0, res: 1024 });
    fx.reset();
    const out = render(fx, sine(30, 1, 1))[0];
    expect(Number.isFinite(rms(out))).toBe(true);
    const z = render(fx, new Float32Array(96000))[0];
    expect(peak(z, 95000)).toBeLessThan(1e-4);
  });
});
