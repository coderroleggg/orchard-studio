import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { makeCtx, render, peak } from './util';

const fmt = (key: string, v: number) => formatParam(fxParamDef('softclipper', key)!, v);

function make(p: Record<string, unknown> = {}) {
  const fx = createEffect('softclipper', 44100, 128);
  fx.setParams({ ...defaultFxParams('softclipper'), ...p });
  return fx;
}

/** Ramp 0..4 in 40001 steps through the plugin (FL measured the same ramp). */
function ramp(p: Record<string, unknown>): { x: Float32Array; y: Float32Array } {
  const n = 40001;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (4 * i) / (n - 1);
  const [y] = render(make(p), x, x, 128);
  return { x, y };
}

describe('Soft Clipper', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('softclipper')!;
    expect(d.name).toBe('Soft Clipper');
    expect(d.category).toBe('Distortion');
    expect(d.alsoIn).toEqual(['Dynamics']);
    expect([d.width, d.height]).toEqual([270, 130]);
    expect(d.params.map((p) => [p.name, p.index, p.min, p.max, p.def])).toEqual([['Threshold', 0, 1, 127, 100], ['Post gain', 1, 0, 160, 128]]);
    expect([1, 7, 64, 100, 121, 127].map((v) => fmt('thres', v))).toEqual(['-51.8dB', '-34.5dB', '-11.1dB', '-4.4dB', '-0.9dB', '0.0dB']);
    expect([0, 8, 128, 160].map((v) => fmt('post', v))).toEqual(['0%', '5%', '80%', '100%']);
    expect(make().latency ?? 0).toBe(0);
  });

  it('follows FL\'s transfer curves (knee at thres/128, exponential approach to full scale)', () => {
    // FL output at input 1.0 and 4.0 for several thresholds (post 128 = unity)
    const fl: [number, number, number][] = [[1, 0.63499, 0.98225], [16, 0.67811, 0.98956], [64, 0.81606, 0.99954], [100, 0.91953, 1.0], [127, 0.99713, 1.0]];
    for (const [v, y1, y4] of fl) {
      const { y } = ramp({ thres: v });
      expect(y[10000]).toBeCloseTo(y1, 4);
      expect(y[40000]).toBeCloseTo(y4, 4);
    }
    const { x, y } = ramp({});
    for (let i = 0; i < 7800; i++) expect(y[i]).toBeCloseTo(x[i], 6); // linear below 100/128
    expect(y[8000]).toBeCloseTo(0.79922, 4);
  });

  it('applies FL\'s post gain law (11^(v/128) - 1)/10', () => {
    const at = (post: number) => {
      const L = new Float32Array(64).fill(0.001), R = new Float32Array(64).fill(0.001);
      make({ thres: 127, post }).process(L, R, 64, makeCtx());
      return L[32] / 0.001;
    };
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(32)).toBeCloseTo(0.082116, 5);
    expect(at(96)).toBeCloseTo(0.504011, 5);
    expect(at(128)).toBeCloseTo(1, 6);
    expect(at(160)).toBeCloseTo(1.903277, 5);
  });

  it('processes channels independently and symmetrically', () => {
    const L = Float32Array.from([0.5, -0.5, 2, -2]), R = Float32Array.from([1, -1, 0.1, -0.1]);
    make({ thres: 1 }).process(L, R, 4, makeCtx());
    expect(L[0]).toBeCloseTo(0.39583, 4);
    expect(L[1]).toBeCloseTo(-0.39583, 4);
    expect(L[2]).toBeCloseTo(-L[3], 6);
    expect(R[0]).toBeCloseTo(0.63499, 4);
  });

  it('steps parameter changes at the next block (FL has no smoothing) and stays finite', () => {
    const fx = make({ post: 128 });
    const a = new Float32Array(128).fill(0.2);
    fx.process(a, Float32Array.from(a), 128, makeCtx());
    fx.setParams({ ...defaultFxParams('softclipper'), post: 160 });
    const L = new Float32Array(512).fill(0.2), R = new Float32Array(512).fill(0.2);
    fx.process(L, R, 512, makeCtx());
    expect(L[0]).toBeCloseTo(0.2 * 1.903277, 5);
    expect(L[511]).toBe(L[0]);
    const x = Float32Array.from([NaN, Infinity, -Infinity, 1e30, 0]);
    const [y] = render(make({ thres: 1, post: 160 }), x, x, 5);
    for (const v of y) expect(Number.isFinite(v)).toBe(true);
    expect(peak(y)).toBeLessThanOrEqual(1.9033);
    expect(peak(render(make(), new Float32Array(256))[0])).toBe(0);
  });

  it('feeds the output meter', () => {
    const fx = make();
    const L = new Float32Array(128).fill(0.5), R = new Float32Array(128).fill(0.25);
    fx.process(L, R, 128, makeCtx());
    const m = fx.monitor!()!;
    expect(m.peakL).toBeCloseTo(0.5, 6);
    expect(m.peakR).toBeCloseTo(0.25, 6);
    expect(fx.monitor!()!.peakL).toBe(0);
  });
});
