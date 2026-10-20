import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import { processNotes } from '../../src/engine/effects/plugins/vfxkeysplitter';
import { KEY_SPAN, defaultZones, type SplitZone } from '../../src/model/fx/plugins/vfxkeysplitter';
import { envAt, flatEnv } from '../../src/model/fx/plugins/vfx/envelope';
import { note, seeded, vfxContext } from '../../src/model/fx/plugins/vfx/notes';
import { pluginPorts } from '../../src/model/fx/plugins/patcher';
import { makeCtx } from './util';

const preset = (name: string) => {
  const p = fxDef('vfxkeysplitter')!.presets!.find((q) => q.name === name)!;
  return { ...defaultFxParams('vfxkeysplitter'), ...structuredClone(p.params) };
};
const route = (p: Record<string, unknown>, key: number, vel = 100) => processNotes([note({ key, vel })], p).map((n) => [n.port, n.key, n.vel]);

describe('VFX Keyboard Splitter', () => {
  it('is registered without parameters, 16 zones (all keys to zone 1) and the decoded factory presets', () => {
    const d = fxDef('vfxkeysplitter')!;
    expect(d.width).toBe(941);
    expect(d.height).toBe(388);
    expect(d.params).toHaveLength(0);
    const zs = defaultFxParams('vfxkeysplitter').zones as SplitZone[];
    expect(zs).toHaveLength(16);
    expect(envAt(zs[0].key, 0.5)).toBe(1);
    expect(envAt(zs[1].key, 0.5)).toBe(0);
    expect(d.presets!.map((p) => p.name)).toContain('Keyboard\\Basic C5 split');
    expect(d.presets).toHaveLength(17);
    expect(pluginPorts('vfxkeysplitter').eventsOut).toBe(16);
    // stored zones are repaired
    const n = normalizeFxParams('vfxkeysplitter', { zones: [{ key: 'x', transpose: 99 }] }).zones as SplitZone[];
    expect(n).toHaveLength(16);
    expect(n[0].transpose).toBe(48);
  });

  it('sends every note to zone 1 by default', () => {
    const p = defaultFxParams('vfxkeysplitter');
    expect(route(p, 0)).toEqual([[0, 0, 100]]);
    expect(route(p, 131)).toEqual([[0, 131, 100]]);
  });

  it('splits at C5 with the factory preset (keys below C5 to zone 1, from C5 to zone 2)', () => {
    const p = preset('Keyboard\\Basic C5 split');
    expect(route(p, 59)).toEqual([[0, 59, 100]]);
    expect(route(p, 60)).toEqual([[1, 60, 100]]);
    expect(route(p, 100)).toEqual([[1, 100, 100]]);
  });

  it('transposes per zone (3 zone split transposed) and maps single notes to their roots', () => {
    const p = preset('Keyboard\\3 zone split transposed');
    expect(route(p, 40)).toEqual([[0, 76, 100]]); // zone 1: +36
    expect(route(p, 60)).toEqual([[1, 60, 100]]);
    expect(route(p, 90)).toEqual([[2, 54, 100]]); // zone 3: -36
    const roots = preset('Keyboard\\16 note split root notes');
    expect(route(roots, 60)).toEqual([[0, 60, 100]]);
    expect(route(roots, 63)).toEqual([[3, 60, 100]]);
    expect(route(roots, 59)).toEqual([]); // outside every zone
  });

  it('cross-fades overlapping zones by scaling velocity (3 zone fade)', () => {
    const p = preset('Keyboard\\3 zone fade');
    const out = route(p, 45);
    expect(out.map((r) => r[0])).toEqual([0, 1]);
    for (const r of out) expect(r[2]).toBeGreaterThan(0);
    for (const r of out) expect(r[2]).toBeLessThan(100);
  });

  it('applies velocity envelopes: multiply, absolute (Compressed) and velocity splits', () => {
    const comp = preset('Velocity\\Compressed');
    const soft = route(comp, 60, 32)[0][2] as number;
    expect(soft).toBeGreaterThan(32); // absolute curve with positive tension lifts soft notes
    expect(route(comp, 60, 128)[0][2]).toBe(128);
    const split = preset('Velocity\\Split high low multiply');
    expect(route(split, 60, 40).map((r) => r[0])).toEqual([0]);
    expect(route(split, 60, 100).map((r) => r[0])).toEqual([1]);
  });

  it('uses the keyboard mapping as a probability with Random', () => {
    const zs = defaultZones();
    zs[0] = { ...zs[0], key: flatEnv(0.25), random: true };
    zs[1] = { ...zs[1], key: flatEnv(1), random: true };
    const p = { ...defaultFxParams('vfxkeysplitter'), zones: zs };
    const ctx = vfxContext({ random: seeded(5) });
    let z0 = 0, z1 = 0;
    for (let i = 0; i < 400; i++) for (const n of processNotes([note({ key: 60, vel: 90 })], p, ctx)) { if (n.port === 0) { z0++; expect(n.vel).toBe(90); } else z1++; }
    expect(z1).toBe(400);
    expect(z0).toBeGreaterThan(60);
    expect(z0).toBeLessThan(140);
    expect(KEY_SPAN).toBe(132);
  });

  it('does nothing to audio in a mixer slot', () => {
    const fx = createEffect('vfxkeysplitter', 48000, 128);
    fx.setParams(defaultFxParams('vfxkeysplitter'));
    const L = new Float32Array(128).fill(0.2), R = new Float32Array(128).fill(0.2);
    fx.process(L, R, 128, makeCtx());
    expect(R[99]).toBeCloseTo(0.2, 7);
  });
});
