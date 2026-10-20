import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import type { FxEnv } from '../../src/engine/effects/types';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { SC_SAMPLE_PREFIX } from '../../src/model/fx/plugins/scratcher';
import { makeCtx, render, rms, sine } from './util';

const SR = 48000;

/** A sample pool with one test sample: a 2 s ramp (left) and its negative (right). */
function pool(len = 2 * SR): { env: FxEnv; L: Float32Array } {
  const L = new Float32Array(len), R = new Float32Array(len);
  for (let i = 0; i < len; i++) { L[i] = -1 + (2 * i) / len; R[i] = -L[i]; }
  return { L, env: { sample: (id) => (id === SC_SAMPLE_PREFIX + 's1' ? { channels: [L, R], sampleRate: SR } : undefined) } };
}

const INFO = { id: 's1', name: 'ramp', frames: 2 * SR, sampleRate: SR, channels: 2, source: { kind: 'user', key: 's1' } };

function make(params: Record<string, unknown> = {}, env = pool().env) {
  const fx = createEffect('scratcher', SR, 256, env);
  fx.setParams({ ...defaultFxParams('scratcher'), sample: INFO, ...params });
  fx.reset();
  return fx;
}

describe('Scratcher', () => {
  it('is registered with FL parameters and value texts', () => {
    const d = fxDef('scratcher')!;
    expect(d.name).toBe('Scratcher');
    expect(d.params.map((p) => p.name)).toEqual([
      'Wave position', 'Mute', 'Turntable speed', 'Turntable acceleration', 'Pan', 'Volume', 'Turntable hold',
      'Turntable sensitivity', 'Transport', 'Smooth 1', 'Smooth 2', 'Smooth 3', 'Smooth 4', 'Rotations',
    ]);
    expect(d.params.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const p = defaultFxParams('scratcher');
    expect([p.pos, p.mute, p.speed, p.acc, p.pan, p.vol, p.hold, p.sens, p.transport, p.sm1, p.sm2, p.sm3, p.sm4, p.rot])
      .toEqual([690, 1, 50, 25, 0, 199, 0, 50, 0, 500, 908, 999, 400, 9]);
    // FL's GetName texts
    const t = (k: string, v: number) => formatParam(d.params.find((q) => q.key === k)!, v);
    expect(t('pos', 690)).toBe('0.023000');
    expect(t('mute', 1)).toBe('Off');
    expect(t('mute', 0)).toBe('On');
    expect(t('speed', 50)).toBe('0.500000 x');
    expect(t('acc', 25)).toBe('25%');
    expect(t('pan', -102)).toBe('-80%');
    expect(t('vol', 199)).toBe('78%');
    expect(t('vol', 26)).toBe('10%');
    expect(t('transport', -1)).toBe('Reverse');
    expect(t('transport', 1)).toBe('Forward');
    expect(t('sm2', 908)).toBe('0.908000');
    expect(t('rot', 9)).toBe('0.500000');
  });

  it('passes the input through unchanged without a sample (FL behaviour)', () => {
    const fx = createEffect('scratcher', SR, 256);
    fx.setParams({ ...defaultFxParams('scratcher'), transport: 1 });
    const x = sine(440, 0.2);
    const [L] = render(fx, x);
    for (let i = 0; i < x.length; i += 997) expect(L[i]).toBeCloseTo(x[i], 6);
  });

  it('adds the record to the input and stays still while paused', () => {
    const fx = make({ pos: 15000, transport: 0 });
    const z = new Float32Array(SR / 4);
    const [L, R] = render(fx, z, z, 256);
    // paused at the middle of the ramp: a constant ~0 (+ its negative on the right)
    expect(Math.abs(L[5000])).toBeLessThan(0.01);
    expect(L[5000]).toBeCloseTo(L[10000], 6);
    expect(R[5000]).toBeCloseTo(-L[5000], 5);
  });

  it('spins up with the motor (Transport forward) to 1x at the default speed', () => {
    const fx = make({ pos: 0, transport: 1, acc: 100 });
    const z = new Float32Array(SR);
    const [L] = render(fx, z, z, 256);
    // with full acceleration the platter reaches the motor speed at once: the ramp plays at 1x
    const slope = (L[40000] - L[30000]) / 10000;
    expect(slope).toBeCloseTo(2 / (2 * SR), 6);
    // speed 100 = 2x
    const f2 = make({ pos: 0, transport: 1, acc: 100, speed: 100 });
    const [L2] = render(f2, z, z, 256);
    expect((L2[20000] - L2[15000]) / 5000).toBeCloseTo(2 * (2 / (2 * SR)), 6);
  });

  it('accelerates gradually with low acceleration (platter mass)', () => {
    const fast = make({ pos: 0, transport: 1, acc: 80 });
    const slow = make({ pos: 0, transport: 1, acc: 10 });
    const z = new Float32Array(SR / 2);
    const [a] = render(fast, z, z, 256);
    const [b] = render(slow, z, z, 256);
    const v = (y: Float32Array, i: number) => (y[i + 100] - y[i]) / 100 / (2 / (2 * SR));
    expect(v(a, 12000)).toBeGreaterThan(0.9);
    expect(v(b, 12000)).toBeLessThan(0.5);
    expect(v(b, 12000)).toBeGreaterThan(0);
  });

  it('plays backwards in reverse and brakes with Turntable hold', () => {
    const z = new Float32Array(SR / 2);
    const [rev] = render(make({ pos: 15000, transport: -1, acc: 100 }), z, z, 256);
    expect(rev[20000]).toBeLessThan(rev[10000]);
    const [held] = render(make({ pos: 15000, transport: 1, acc: 100, hold: 1 }), z, z, 256);
    expect(held[20000]).toBeCloseTo(held[15000], 4);
  });

  it('follows the platter when the wave position moves (scratch) and keeps momentum', () => {
    const fx = make({ pos: 15000, transport: 0 });
    const L = new Float32Array(SR), R = new Float32Array(SR);
    const c = makeCtx();
    // move the platter forward by 1/30 of the sample over 0.1 s, in 5 ms steps
    let pos = 15000;
    for (let i = 0; i < L.length; i += 240) {
      if (i < 4800) { pos += 50; fx.setParams({ ...defaultFxParams('scratcher'), sample: INFO, pos, transport: 0 }); }
      fx.process(L.subarray(i, i + 240), R.subarray(i, i + 240), 240, c);
    }
    // the record has moved forward by about the hand's travel (1000/30000 of the ramp = 0.0667)
    expect(L[30000] - L[100]).toBeGreaterThan(0.04);
    expect(L[30000] - L[100]).toBeLessThan(0.1);
    // after release the paused motor stops it again
    expect(Math.abs(L[47000] - L[46000])).toBeLessThan(1e-3);
  });

  it('applies volume, pan and mute to the record only', () => {
    const x = sine(220, 0.1, 0.25);
    const [m] = render(make({ pos: 3000, mute: 0 }), x, x, 256);
    for (let i = 1000; i < x.length; i += 777) expect(m[i]).toBeCloseTo(x[i], 6);
    const z = new Float32Array(SR / 10);
    const [L, R] = render(make({ pos: 3000, pan: 128 }), z, z, 256);
    expect(Math.abs(L[3000])).toBeLessThan(1e-4);
    expect(Math.abs(R[3000])).toBeGreaterThan(0.5);
    const [q] = render(make({ pos: 3000, vol: 0 }), z, z, 256);
    expect(Math.abs(q[3000])).toBeLessThan(1e-4);
  });

  it('follows a time code signal on the input (DVS) and mutes the input', () => {
    // Serato-like carrier: 1 kHz quadrature at normal speed -> 1x forward
    const n = SR / 2;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = 0.3 * Math.cos((2 * Math.PI * 1000 * i) / SR); R[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR); }
    const fx = make({ pos: 0, timecode: 1 });
    const [oL] = render(fx, L, R, 256);
    const v = (oL[20000] - oL[18000]) / 2000 / (2 / (2 * SR));
    expect(v).toBeGreaterThan(0.95);
    expect(v).toBeLessThan(1.05);
  });

  it('stays finite and silent-in silent-out without a running record', () => {
    const fx = make({ pos: 0, transport: 0, mute: 0 });
    const z = new Float32Array(SR / 4);
    const [L] = render(fx, z, z, 128);
    expect(rms(L)).toBe(0);
    const wild = make({ pos: 30000, transport: 1, speed: 100, acc: 100, sm1: 1000, sm2: 0, sm3: 0, sm4: 1000 });
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
    x[100] = NaN;
    const L2 = Float32Array.from(x), R2 = Float32Array.from(x);
    const c = makeCtx();
    for (let i = 0; i < L2.length; i += 128) {
      if (i % 1280 === 0) wild.setParams({ ...defaultFxParams('scratcher'), sample: INFO, pos: Math.round(Math.random() * 30000), sm1: 1000, sm2: 0 });
      wild.process(L2.subarray(i, i + 128), R2.subarray(i, i + 128), 128, c);
    }
    for (let i = 0; i < L2.length; i++) if (i !== 100) expect(Number.isFinite(L2[i])).toBe(true);
  });
});
