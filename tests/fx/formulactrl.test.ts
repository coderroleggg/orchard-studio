import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, fxOutputs, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { compileFormula } from '../../src/model/formula';
import { makeCtx } from './util';

const SR = 48000;

function run(params: Record<string, unknown>, blocks = 4, ctx = {}) {
  const fx = createEffect('formulactrl', SR, 128);
  fx.setParams({ ...defaultFxParams('formulactrl'), ...params });
  const L = new Float32Array(128).fill(0.25), R = new Float32Array(128).fill(0.25);
  for (let b = 0; b < blocks; b++) fx.process(L, R, 128, makeCtx({ playing: false, ...ctx }));
  return { fx, out: fx.controls!()[0], L };
}

describe('Formula Controller', () => {
  it("is registered with FL's knobs, default formula and presets", () => {
    const d = fxDef('formulactrl')!;
    expect([d.width, d.height]).toEqual([521, 370]);
    expect(fxOutputs('formulactrl')).toEqual(['Out']);
    expect(defaultFxParams('formulactrl')).toMatchObject({ a: 0, b: 0, c: 0, formula: 'a+b+c' });
    expect(formatParam(fxParamDef('formulactrl', 'a')!, 32768)).toBe('50.0%');
    expect(formatParam(fxParamDef('formulactrl', 'b')!, 8192)).toBe('12.5%');
    const names = d.presets!.map((p) => p.name);
    expect(names).toContain('LFO/3 steps LFO');
    expect(names).toContain('Mapping/Tension');
    // every factory formula compiles
    for (const p of d.presets!) if (p.params.formula) expect(compileFormula(String(p.params.formula)).ok, p.name).toBe(true);
  });

  it('outputs the formula of a, b, c, clamped to 0..1', () => {
    expect(run({ a: 16384, b: 32768, c: 0 }).out).toBeCloseTo(0.75, 6);
    expect(run({ a: 65536, b: 65536, c: 65536 }).out).toBe(1);
    expect(run({ formula: 'a-0.5' }).out).toBe(0);
    expect(run({ formula: '0/0' }).out).toBe(0); // NaN -> 0
    expect(run({ formula: 'Sqrt(b)', b: 16384 }).out).toBeCloseTo(0.5, 6);
  });

  it('reads the song position in quarter notes while playing', () => {
    // 1.5 beats in: Frac(SongTime) = 0.5
    expect(run({ formula: 'Frac(SongTime)' }, 1, { playing: true, pos: 144, ppq: 96 }).out).toBeCloseTo(0.5, 3);
    // stopped: the position holds
    expect(run({ formula: 'SongTime/4' }, 3, { playing: false, pos: 192, ppq: 96 }).out).toBeCloseTo(0.5, 6);
  });

  it('keeps its last output when the formula does not compile', () => {
    const fx = createEffect('formulactrl', SR, 128);
    const L = new Float32Array(128), R = new Float32Array(128);
    fx.setParams({ ...defaultFxParams('formulactrl'), formula: '0.3' });
    fx.process(L, R, 128, makeCtx());
    fx.setParams({ ...defaultFxParams('formulactrl'), formula: '0.3+(' });
    fx.process(L, R, 128, makeCtx());
    expect(fx.controls!()[0]).toBeCloseTo(0.3, 6);
  });

  it('passes the audio through and runs every tick', () => {
    const { fx, L } = run({ formula: 'Rand' }, 1);
    expect(L[10]).toBe(0.25);
    const seen = new Set<number>();
    const l = new Float32Array(128), r = new Float32Array(128);
    for (let b = 0; b < 40; b++) { fx.process(l, r, 128, makeCtx()); seen.add(fx.controls!()[0]); }
    expect(seen.size).toBeGreaterThan(15); // 5120 samples = 20 ticks of 250 samples
    const m = fx.monitor!() as { v: number[] };
    expect(m.v.length).toBeGreaterThan(10);
  });
});
