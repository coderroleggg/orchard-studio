import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, fxOutputs, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { makeCtx } from './util';

const SR = 44100;
const spt = (SR * 60) / (130 * 96); // samples per tick at 130 BPM, 96 PPQ

/** Run `ticks` song ticks (130 BPM, 96 PPQ) and return the outputs after each. */
function ticks(params: Record<string, unknown>, n: number) {
  const fx = createEffect('xyctrl', SR, 512);
  fx.setParams({ ...defaultFxParams('xyctrl'), ...params });
  const out: number[][] = [];
  const L = new Float32Array(512), R = new Float32Array(512);
  const ctx = makeCtx({ sampleRate: SR, tempo: 130, ppq: 96 });
  let left = 0;
  while (out.length < n) {
    const tick = left <= 0;
    if (tick) left += spt;
    const m = Math.max(1, Math.ceil(left - 1e-9));
    fx.process(L.subarray(0, m), R.subarray(0, m), m, ctx);
    left -= m;
    if (tick) out.push(Array.from(fx.controls!()));
  }
  return { fx, out };
}

describe('X-Y Controller', () => {
  it("is registered with FL's parameters, texts and outputs", () => {
    const d = fxDef('xyctrl')!;
    expect([d.width, d.height]).toEqual([239, 352]);
    expect(fxOutputs('xyctrl')).toEqual(['X', 'Y']);
    expect(defaultFxParams('xyctrl')).toMatchObject({ xLevel: 32768, xMin: 0, xMax: 65536, speed: 1536, accel: 1024 });
    const f = (k: string, v: number) => formatParam(fxParamDef('xyctrl', k)!, v);
    expect(f('xLevel', 8192)).toBe('13%');
    expect(f('speed', 1536)).toBe('50%');
    expect(f('accel', 352)).toBe('13%');
    expect(f('yTension', -96)).toBe('-75%');
    expect(d.presets!.length).toBe(8);
  });

  it("glides from the bottom-left corner like FL's (first step 104 / 65536)", () => {
    const { out } = ticks({}, 1);
    // FL's plugin sends 1703936 (= 104 x 2^14) for X and Y on its first tick
    expect(out[0][0]).toBe(1703936 / 1073741824);
    expect(out[0][1]).toBe(out[0][0]);
  });

  it('reaches the goal at constant speed with full acceleration', () => {
    // thrust 0.0022544 per tick: 0.7071 / 0.0022544 = 314 ticks to the centre
    const { out } = ticks({}, 330);
    expect(out[200][0]).toBeLessThan(0.5);
    expect(out[320][0]).toBe(0.5);
    expect(out[320][1]).toBe(0.5);
  });

  it('full speed jumps; inertia overshoots with low acceleration', () => {
    expect(ticks({ speed: 2048, xLevel: 65536, yLevel: 0 }, 2).out[1]).toEqual([1, 0]);
    const slow = ticks({ speed: 2047, accel: 256, xLevel: 65536, yLevel: 0 }, 600).out.map((o) => o[0]);
    expect(Math.max(...slow)).toBe(1);
    expect(slow[599]).toBeGreaterThan(0.95);
  });

  it('maps through Min / Max and the tension curve (a reversed range sticks at Max, as in FL)', () => {
    const r = ticks({ speed: 2048, xMin: 16384, xMax: 49152 }, 2).out[1];
    expect(r[0]).toBeCloseTo(0.5, 9);
    expect(ticks({ speed: 2048, xLevel: 65536, xMin: 16384, xMax: 49152 }, 2).out[1][0]).toBeCloseTo(0.75, 9);
    expect(ticks({ speed: 2048, xMin: 60000, xMax: 10000 }, 2).out[1][0]).toBeCloseTo(10000 / 65536, 9);
    const k = 100; // tension 128
    expect(ticks({ speed: 2048, xTension: 128 }, 2).out[1][0]).toBeCloseTo(Math.round(((k + 1 - Math.sqrt(k + 1)) / k) * 65536) / 65536, 9);
  });

  it('passes audio and stays finite', () => {
    const fx = createEffect('xyctrl', SR, 128);
    fx.setParams({ ...defaultFxParams('xyctrl'), speed: 1024, accel: 256, xLevel: 0, yLevel: 65536 });
    const L = new Float32Array(128).fill(0.5), R = new Float32Array(128).fill(0.5);
    for (let b = 0; b < 200; b++) fx.process(L, R, 128, makeCtx({ tempo: 522, ppq: 960 }));
    expect(L[3]).toBe(0.5);
    for (const v of Array.from(fx.controls!())) expect(Number.isFinite(v)).toBe(true);
    const m = fx.monitor!() as { x: number; y: number };
    expect(Number.isFinite(m.x) && Number.isFinite(m.y)).toBe(true);
  });
});
