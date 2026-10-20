import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { processNotes } from '../../src/engine/effects/plugins/vfxlevelscaler';
import { lsBand, lsChannel, lsCurve, tensionCurve } from '../../src/model/fx/plugins/vfxlevelscaler';
import { note, seeded, vfxContext } from '../../src/model/fx/plugins/vfx/notes';
import { makeCtx } from './util';

const base = () => defaultFxParams('vfxlevelscaler');

describe('VFX Level Scaler', () => {
  it('is registered with FL parameter names, ranges and defaults', () => {
    const d = fxDef('vfxlevelscaler')!;
    expect(d.width).toBe(566);
    expect(d.height).toBe(481);
    expect(d.params).toHaveLength(36);
    expect(d.params[0]).toMatchObject({ name: 'Velocity - Center', index: 0, min: 0, max: 8192, def: 0 });
    expect(d.params[1]).toMatchObject({ name: 'Velocity - Multiplier', min: -16384, max: 16384, def: 8192 });
    expect(d.params[5]).toMatchObject({ name: 'Velocity - Humanize mode', min: 0, max: 2, def: 1 });
    expect(d.params[12]).toMatchObject({ name: 'Fine Pitch - Center', def: 4096 });
    expect(d.params[18]).toMatchObject({ name: 'Pan - Center', def: 0 });
    expect(d.params[35]).toMatchObject({ name: 'Mod Y - Humanize mode', index: 35 });
    expect(formatParam(d.params[5], 1)).toBe('Spread');
    expect(formatParam(d.params[1], 8192)).toBe('100%');
  });

  it('passes notes unchanged at the default settings', () => {
    const n = [note({ key: 60, vel: 100, rel: 64, pan: 30, fine: 150, modX: 10, modY: 200 })];
    expect(processNotes(n, base(), vfxContext())).toEqual(n);
  });

  it('multiplies velocity, adds the offset and clamps to the property range', () => {
    const p = { ...base(), velMul: 4096 }; // x0.5
    expect(processNotes([note({ key: 60, vel: 100 })], p)[0].vel).toBe(50);
    const q = { ...base(), velOfs: 2048 }; // +25%
    expect(processNotes([note({ key: 60, vel: 64 })], q)[0].vel).toBe(96);
    expect(processNotes([note({ key: 60, vel: 120 })], q)[0].vel).toBe(128);
    const inv = { ...base(), velMul: -8192, velOfs: 8192 }; // 1 - x
    expect(processNotes([note({ key: 60, vel: 32 })], inv)[0].vel).toBe(96);
  });

  it('multiplies around the centre (fine pitch: around no detune)', () => {
    const p = { ...base(), pitchMul: 16384 }; // x2 around the centre (120 of 240)
    expect(processNotes([note({ key: 60, fine: 130 })], p)[0].fine).toBe(140);
    expect(processNotes([note({ key: 60, fine: 110 })], p)[0].fine).toBe(100);
  });

  it('bends the line around the centre with tension (S-curve, inverse S when negative)', () => {
    expect(tensionCurve(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 9);
    expect(tensionCurve(0, 0.5, 0.5)).toBeCloseTo(0, 9);
    expect(tensionCurve(1, 0.5, 0.5)).toBeCloseTo(1, 9);
    expect(tensionCurve(0.6, 0.5, 0.5)).toBeGreaterThan(0.6); // steep at the centre
    expect(tensionCurve(0.4, 0.5, 0.5)).toBeLessThan(0.4);
    expect(tensionCurve(0.6, 0.5, -0.5)).toBeLessThan(0.6); // flat at the centre
    // centre 0 (velocity default): positive tension lifts soft notes
    expect(tensionCurve(0.25, 0, 0.5)).toBeGreaterThan(0.25);
    const c = lsChannel({ ...base(), velTension: 4096 }, 0);
    const out = processNotes([note({ key: 60, vel: 32 })], { ...base(), velTension: 4096 })[0].vel;
    expect(out).toBe(Math.round(lsCurve(32 / 128, c) * 128));
  });

  it('humanizes within the shown band: Spread both ways, Add up, Subtract down', () => {
    const run = (mode: number) => {
      const p = { ...base(), velHum: 4096, velHumMode: mode };
      const ctx = vfxContext({ random: seeded(7) });
      return Array.from({ length: 200 }, () => processNotes([note({ key: 60, vel: 64 })], p, ctx)[0].vel - 64);
    };
    const spread = run(1), add = run(2), sub = run(0);
    expect(Math.min(...spread)).toBeLessThan(-10);
    expect(Math.max(...spread)).toBeGreaterThan(10);
    expect(Math.min(...add)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...sub)).toBeLessThanOrEqual(0);
    const c = lsChannel({ ...base(), velHum: 4096, velHumMode: 1 }, 0);
    const [lo, hi] = lsBand(0.5, c);
    expect(hi - lo).toBeCloseTo(1, 6); // sqrt(0.25) both ways
    for (const d of spread) { expect(64 + d).toBeGreaterThanOrEqual(Math.floor(lo * 128)); expect(64 + d).toBeLessThanOrEqual(Math.ceil(hi * 128)); }
  });

  it('does nothing to audio in a mixer slot', () => {
    const fx = createEffect('vfxlevelscaler', 48000, 128);
    fx.setParams(base());
    const L = new Float32Array(128).fill(0.4), R = new Float32Array(128).fill(0.1);
    fx.process(L, R, 128, makeCtx());
    expect(L[10]).toBeCloseTo(0.4, 7);
    expect(R[120]).toBeCloseTo(0.1, 7);
  });
});
