import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { phaserRate } from '../../src/engine/effects/plugins/phaser';
import { makeCtx, render, sine, peak } from './util';

const SR = 44100;
const txt = (key: string, v: number) => formatParam(fxParamDef('phaser', key)!, v);
/** Static settings: frozen LFO (min = max), wet only, unity gain. */
const STATIC = { sweep: 0, range: 0, stereo: 0, feedback: 0, dryWet: 0, gain: 2500 };

function make(p: Record<string, number> = {}) {
  const fx = createEffect('phaser', SR, 128);
  fx.setParams({ ...defaultFxParams('phaser'), ...p });
  return fx;
}

function ir(p: Record<string, number>, n = 64): Float32Array {
  const x = new Float32Array(n); x[0] = 1;
  return render(make(p), x, x, 128, { sampleRate: SR })[0];
}

describe('Phaser', () => {
  it('is registered with FL ranges, Default-preset values and value texts', () => {
    const d = fxDef('phaser')!;
    expect([d.width, d.height]).toEqual([500, 155]);
    expect(defaultFxParams('phaser')).toEqual({ sweep: 1500, minDepth: 0, maxDepth: 900, range: 0, stereo: 512, stages: 11, feedback: 693, dryWet: 0, gain: 2500 });
    expect(d.presets?.length).toBe(27);
    expect(txt('sweep', 2500)).toBe('0.50000 Hz');
    expect(txt('minDepth', 100)).toBe('0.10000');
    expect(txt('range', 512)).toBe('small');
    expect(txt('range', 513)).toBe('large');
    expect(txt('stereo', 512)).toBe('0.50000 phase');
    expect(txt('stages', 7)).toBe('8');
    expect(txt('feedback', 400)).toBe('0.40000 amount');
    expect(txt('dryWet', 0)).toBe('100 % wet');
    expect(txt('dryWet', 384)).toBe('62 % wet');
    expect(txt('dryWet', 1024)).toBe('0 % wet');
    expect(txt('gain', 4000)).toBe('4.08240 dB');
    expect(txt('gain', 0)).toBe('-oo   dB');
  });

  it('runs at least three first-order allpasses with coefficient = depth (FL impulse responses)', () => {
    // a = 0.5, Stages 1 (3 sections): FL's first samples
    const h = ir({ ...STATIC, minDepth: 500, maxDepth: 500, stages: 0 });
    [-0.125, 0.5625, -0.5625, -0.28125, 0.070312, 0.246094].forEach((r, i) => expect(h[i]).toBeCloseTo(r, 5));
    // the section count: h0 = (-a)^k with k = max(3, stages + 1)
    expect(ir({ ...STATIC, minDepth: 500, maxDepth: 500, stages: 2 })[0]).toBeCloseTo(-0.125, 6);
    expect(ir({ ...STATIC, minDepth: 500, maxDepth: 500, stages: 7 })[0]).toBeCloseTo(0.5 ** 8, 6);
    // depth 0 = three sample delay, depth 1 = inversion
    expect(ir({ ...STATIC, minDepth: 0, maxDepth: 0, stages: 0 })[3]).toBeCloseTo(1, 6);
    expect(ir({ ...STATIC, minDepth: 1000, maxDepth: 1000, stages: 0 })[0]).toBeCloseTo(-1, 6);
  });

  it('feeds back 0.99 fb of the output and scales the input by sqrt(1 - fb^2) (FL)', () => {
    const h = ir({ ...STATIC, minDepth: 500, maxDepth: 500, stages: 0, feedback: 500 });
    [-0.108253, 0.493837, -0.547837, -0.042028, -0.211478, 0.294526].forEach((r, i) => expect(h[i]).toBeCloseTo(r, 5));
    // the dry share gets the input scaling too: half dry, a = 0.4, feedback 0.5
    const m = ir({ ...STATIC, minDepth: 400, maxDepth: 400, stages: 0, feedback: 500, dryWet: 512 });
    [0.4053, 0.175469, -0.307894, 0.045448].forEach((r, i) => expect(m[i]).toBeCloseTo(r, 5));
    // output gain is linear: 5000 = x2
    expect(ir({ ...STATIC, minDepth: 1000, maxDepth: 1000, stages: 0, gain: 5000 })[0]).toBeCloseTo(-2, 6);
  });

  it('sweeps the coefficient with FL rates and stereo phase', () => {
    // FL: rate = R (e^(4x) - 1) / (e^4 - 1), measured 1.19072 Hz (large, x = 0.5) and 2.0003 Hz (small, x = 1)
    expect(phaserRate(2500, true)).toBeCloseTo(1.19072, 2);
    expect(phaserRate(5000, false)).toBeCloseTo(2.0, 3);
    expect(phaserRate(4500, true)).toBeCloseTo(6.64236, 2);
    // the coefficient follows lo + (hi - lo)(1 + sin)/2, right channel half a cycle on at Stereo 1024
    const fx = make({ ...STATIC, sweep: 5000, range: 1024, minDepth: 200, maxDepth: 600, stages: 0, stereo: 1024 });
    const n = 4410, P = 441;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i += P) x[i] = 1;
    const [L, R] = render(fx, x, x, 128, { sampleRate: SR });
    for (let i = 0; i < n; i += P) {
      const ph = (10 * i) / SR;
      const aL = 0.2 + 0.2 * (1 + Math.sin(2 * Math.PI * ph));
      const aR = 0.2 + 0.2 * (1 + Math.sin(2 * Math.PI * (ph + 0.5)));
      expect(Math.cbrt(-L[i])).toBeCloseTo(aL, 3);
      expect(Math.cbrt(-R[i])).toBeCloseTo(aR, 3);
    }
  });

  it('applies Dry - Wet and Output gain at once and keeps unused sections still, like FL', () => {
    // FL (flfxhost --at): every change takes effect on the next sample, no glide; the
    // sections beyond the stage count stand still (new ones start from rest)
    const run = (change: boolean) => {
      const fx = make({ sweep: 2000, stages: 3, feedback: 500, dryWet: change ? 512 : 900, gain: change ? 2500 : 4000 });
      const x = sine(300, 1, 0.5, SR);
      const L = Float32Array.from(x), R = Float32Array.from(x);
      const ctx = makeCtx({ sampleRate: SR });
      for (let i = 0; i < L.length; i += 128) {
        if (change && i === 128 * 100) fx.setParams({ ...defaultFxParams('phaser'), sweep: 2000, stages: 3, feedback: 500, dryWet: 900, gain: 4000 });
        fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, ctx);
      }
      return L;
    };
    const a = run(true), b = run(false);
    let after = 0;
    for (let i = 128 * 100; i < a.length; i++) after = Math.max(after, Math.abs(a[i] - b[i]));
    expect(after).toBeLessThan(1e-6);
  });

  it('stays finite at extreme settings and is silent after its tail', () => {
    const loud = new Float32Array(SR);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i * 0.37) * 4;
    for (const p of [
      { sweep: 5000, minDepth: 0, maxDepth: 1000, range: 1024, stereo: 1024, stages: 22, feedback: 1000, dryWet: 0, gain: 5000 },
      { sweep: 0, minDepth: 1000, maxDepth: 1000, range: 0, stereo: 0, stages: 0, feedback: 1000, dryWet: 1024, gain: 0 },
    ]) {
      const [a, b] = render(make(p), loud, loud, 64, { sampleRate: SR });
      expect(a.every(Number.isFinite) && b.every(Number.isFinite)).toBe(true);
    }
    const fx = make();
    const x = new Float32Array(SR * 3);
    x.set(sine(440, 0.2, 0.8, SR));
    const [L] = render(fx, x, x, 128, { sampleRate: SR });
    expect(peak(L, Math.round((0.2 + fx.tail!) * SR))).toBeLessThan(1e-3);
  });
});
