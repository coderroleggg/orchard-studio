import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, fxOutputs, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { linearMap } from '../../src/model/fx/plugins/xyzctrl';
import type { AutoPoint } from '../../src/model/automation';
import { makeCtx } from './util';

const SR = 48000;

function setup(params: Record<string, unknown>) {
  const fx = createEffect('xyzctrl', SR, 128);
  fx.setParams({ ...defaultFxParams('xyzctrl'), ...params });
  return fx;
}

/** Process `blocks` blocks (120 BPM, 96 PPQ: 250 samples per tick). */
function run(fx: ReturnType<typeof setup>, blocks: number) {
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let b = 0; b < blocks; b++) fx.process(L, R, 128, makeCtx({ sampleRate: SR }));
  return Array.from(fx.controls!());
}

describe('X-Y-Z Controller', () => {
  it("is registered with FL's parameters, texts, outputs and presets", () => {
    const d = fxDef('xyzctrl')!;
    expect(fxOutputs('xyzctrl')).toEqual(['X', 'Y', 'Z']);
    expect(d.params.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(defaultFxParams('xyzctrl')).toMatchObject({ xValue: 32768, xSpeed: 2048, xAcc: 3072, globalSpeed: 2048, extSpeed: 1024 });
    expect(formatParam(fxParamDef('xyzctrl', 'xAcc')!, 1024)).toBe('33%');
    expect(formatParam(fxParamDef('xyzctrl', 'extSpeed')!, 1024)).toBe('25%');
    expect(d.presets!.map((p) => p.name)).toEqual(['Default', 'First half', 'Instant', 'Inverted', 'Last half', 'Slow', 'Smooth', 'Steppy', 'Tension down', 'Tension up', 'Wobbler']);
  });

  it('starts on its values (FL snaps the smoothers when a state loads)', () => {
    expect(run(setup({ xValue: 16384, yValue: 49152, zValue: 65536 }), 2)).toEqual([0.25, 0.75, 1]);
  });

  it('global speed 0 is instant, otherwise the axes glide', () => {
    const fast = setup({ globalSpeed: 0 });
    run(fast, 2);
    fast.setParams({ ...defaultFxParams('xyzctrl'), globalSpeed: 0, xValue: 65536 });
    expect(run(fast, 3)[0]).toBe(1);
    const slow = setup({});
    run(slow, 2);
    slow.setParams({ ...defaultFxParams('xyzctrl'), xValue: 65536 });
    const a = run(slow, 20)[0]; // ~10 ticks of a ~75-tick smoothing time
    expect(a).toBeGreaterThan(0.5);
    expect(a).toBeLessThan(0.9);
    expect(run(slow, 3000)[0]).toBe(1); // settles exactly (snap within 1.5e-6)
  });

  it('applies the input and output mapping curves', () => {
    const inv: AutoPoint[] = [{ pos: 0, value: 1, tension: 0, mode: 'single' }, { pos: 1, value: 0, tension: 0, mode: 'single' }];
    expect(run(setup({ xValue: 16384, outMap: [inv, linearMap(), linearMap()] }), 2)[0]).toBeCloseTo(0.75, 6);
    const half: AutoPoint[] = [{ pos: 0, value: 0, tension: 0, mode: 'single' }, { pos: 1, value: 0.5, tension: 0, mode: 'single' }];
    expect(run(setup({ yValue: 65536, inMap: [linearMap(), half, linearMap()] }), 2)[1]).toBeCloseTo(0.5, 6);
    // Steppy: a stairs segment quantises the output
    const steps = fxDef('xyzctrl')!.presets!.find((p) => p.name === 'Steppy')!.params;
    // 7 levels (tension 0.65: 5 steps + both ends): 0.458 -> 3/6
    expect(run(setup({ ...steps, xValue: 30000 }), 2)[0]).toBeCloseTo(0.5, 6);
  });

  it('stays finite at extreme settings and passes audio', () => {
    const fx = setup({ globalSpeed: 4096, xSpeed: 4096, xAcc: 0, yAcc: 1500, zSpeed: 0 });
    const L = new Float32Array(128).fill(0.7), R = new Float32Array(128).fill(0.7);
    for (let b = 0; b < 50; b++) fx.process(L, R, 128, makeCtx({ tempo: 10, ppq: 960 }));
    expect(L[0]).toBeCloseTo(0.7, 6);
    for (const v of Array.from(fx.controls!())) expect(Number.isFinite(v)).toBe(true);
  });
});
