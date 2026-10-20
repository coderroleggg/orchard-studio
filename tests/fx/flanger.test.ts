import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { makeCtx, render, sine, peak, rms } from './util';

const SR = 44100;
const txt = (key: string, v: number) => formatParam(fxParamDef('flanger', key)!, v);

/** Static settings for impulse tests: no sweep, unity wet, no dry/cross/feedback. */
const STATIC = { depth: 0, rate: 0, feed: 0, damp: 0, invFeedback: 0, invWet: 0, dry: 0, wet: 5000, cross: 0 };

function make(p: Record<string, number> = {}) {
  const fx = createEffect('flanger', SR, 128);
  fx.setParams({ ...defaultFxParams('flanger'), ...p });
  return fx;
}

/** Impulse into the left channel (or both). */
function impulse(p: Record<string, number>, n = 4096, at = 100, both = false): [Float32Array, Float32Array] {
  const x = new Float32Array(n); x[at] = 1;
  return render(make(p), x, both ? x : new Float32Array(n), 128, { sampleRate: SR });
}

describe('Flanger', () => {
  it('is registered with FL ranges, Default-preset values and value texts', () => {
    const d = fxDef('flanger')!;
    expect(d.name).toBe('Flanger');
    expect([d.width, d.height]).toEqual([500, 205]);
    expect(defaultFxParams('flanger')).toEqual({
      delay: 0, depth: 2000, rate: 2000, phase: 119, damp: 0, shape: 0, feed: 24,
      invFeedback: 1024, invWet: 1024, dry: 3500, wet: 3000, cross: 2500,
    });
    expect(d.presets?.length).toBe(27);
    expect(d.presets?.find((p) => p.name === 'Default')?.params).toEqual({});
    // texts read from FL's binary
    expect(txt('delay', 0)).toBe('0.00000 ms');
    expect(txt('delay', 500)).toBe('3.20513 ms');
    expect(txt('delay', 1024)).toBe('20.00000 ms');
    expect(txt('depth', 2000)).toBe('2.35294 ms');
    expect(txt('rate', 2000)).toBe('0.31250 Hz');
    expect(txt('rate', 4500)).toBe('2.36842 Hz');
    expect(txt('phase', 119)).toBe('119 degrees');
    expect(txt('damp', 500)).toBe('0.10000');
    expect(txt('shape', 0)).toBe('s|-------------t');
    expect(txt('shape', 512)).toBe('s------|-------t');
    expect(txt('shape', 1024)).toBe('s-------------|t');
    expect(txt('feed', 24)).toBe('24 percent');
    expect(txt('invWet', 512)).toBe('off');
    expect(txt('invWet', 513)).toBe('on');
    expect(txt('dry', 0)).toBe('   -oo   dB');
    expect(txt('dry', 1)).toBe('-73.97940 dB');
    expect(txt('dry', 3500)).toBe('-3.09804 dB');
    expect(txt('wet', 6)).toBe('-58.41637 dB');
    expect(txt('cross', 5000)).toBe('0.00000 dB');
  });

  it('delays, mixes and cross-feeds like FL (static measurements)', () => {
    // 20 ms = 882 samples, unity wet
    let [L, R] = impulse({ ...STATIC, delay: 1024 });
    expect(L[100 + 882]).toBeCloseTo(1, 6);
    expect(peak(R)).toBe(0);
    // dry = control / 5000, invert wet flips the wet only
    [L] = impulse({ ...STATIC, delay: 1024, dry: 2500, invWet: 1024 });
    expect(L[100]).toBeCloseTo(0.5, 6);
    expect(L[100 + 882]).toBeCloseTo(-1, 6);
    // cross sends the left wet to the right output
    [L, R] = impulse({ ...STATIC, delay: 1024, wet: 0, cross: 5000 });
    expect(peak(L)).toBe(0);
    expect(R[100 + 882]).toBeCloseTo(1, 6);
    // fractional delay is read with linear interpolation: 0.00391 ms = 0.1724 samples
    // (FL's float32 read position rounds it to 706/4096)
    [L] = impulse({ ...STATIC, delay: 1 });
    expect(L[100]).toBeCloseTo(0.827637, 4);
    expect(L[101]).toBeCloseTo(0.172363, 4);
  });

  it('feeds back 0.98 x Feed through the damping filter (FL measurements)', () => {
    // feed 50 % -> echoes of 0.49 every Delay + 1 samples (the loop feeds back the
    // previous output), alternating with Invert feedback
    let [L] = impulse({ ...STATIC, delay: 512, feed: 50 });
    expect(L[100 + 147]).toBeCloseTo(1, 5);
    expect(L[100 + 295]).toBeCloseTo(0.49, 5);
    expect(L[100 + 443]).toBeCloseTo(0.2401, 5);
    [L] = impulse({ ...STATIC, delay: 512, feed: 50, invFeedback: 1024 });
    expect(L[100 + 295]).toBeCloseTo(-0.49, 5);
    // damp 0.2: one-pole low-pass 0.8, 0.16, 0.032 ...
    [L] = impulse({ ...STATIC, delay: 0, damp: 1000 });
    expect([L[100], L[101], L[102]].map((v) => +v.toFixed(5))).toEqual([0.8, 0.16, 0.032]);
    // damping sits inside the loop: the second echo is filtered twice
    [L] = impulse({ ...STATIC, delay: 512, feed: 50, damp: 2500 });
    expect(L[100 + 147]).toBeCloseTo(0.5, 5);
    expect(L[100 + 295]).toBeCloseTo(0.1225, 5);
    expect(L[100 + 296]).toBeCloseTo(0.1225, 5);
    expect(L[100 + 297]).toBeCloseTo(0.091875, 5);
    // the input is written before the read: zero delay with feedback rings sample by sample
    [L] = impulse({ ...STATIC, delay: 0, feed: 50 });
    expect([L[100], L[101], L[102]].map((v) => +v.toFixed(5))).toEqual([1, 0.49, 0.2401]);
  });

  it('sweeps Delay + Depth/2 +- floor(Depth/2) with a sine-to-triangle LFO', () => {
    // FL: depth 2000 (103.765 samples) sweeps 0.88 .. 102.88 samples (half-width 51, a whole number)
    const fx = make({ ...STATIC, depth: 2000, rate: 3000, phase: 0 });
    const P = 128, n = P * 600;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i += P) x[i] = 1;
    const [L] = render(fx, x, x, 128, { sampleRate: SR });
    let lo = Infinity, hi = -Infinity;
    for (let i = P; i < n - P; i += P) {
      let s = 0, m = 0;
      for (let j = 0; j < 120; j++) { s += L[i + j]; m += j * L[i + j]; }
      if (s > 0.9) { lo = Math.min(lo, m / s); hi = Math.max(hi, m / s); }
    }
    expect(lo).toBeGreaterThan(0.86);
    expect(lo).toBeLessThan(1.2);
    expect(hi).toBeGreaterThan(102.5);
    expect(hi).toBeLessThan(102.9);
    // shape 512 = half sine + half triangle: the right LFO 60 degrees on sits at 0.766 of the half-width
    const [, R] = impulse({ ...STATIC, depth: 2000, rate: 0, phase: 60, shape: 512, wet: 5000 }, 2048, 0, true);
    let s = 0, m = 0;
    for (let j = 0; j < 200; j++) { s += R[j]; m += j * R[j]; }
    const u = 0.5 * Math.sin(Math.PI / 3) + 0.5 * (2 / 3);
    expect(m / s).toBeCloseTo(103.765 / 2 + 51 * u, 1);
  });

  it('reports a feedback-dependent tail', () => {
    const quiet = make();
    expect(quiet.tail!).toBeLessThan(0.1);
    const ring = make({ delay: 1024, depth: 5000, feed: 100 });
    expect(ring.tail!).toBeGreaterThan(10);
    expect(ring.tail!).toBeLessThanOrEqual(30);
  });

  it('applies parameter changes at once, like FL (the delay jumps)', () => {
    // FL (flfxhost --at): Delay, Depth, Feed, Damp, Phase, Shape, Dry, Wet, Cross and the
    // inverts take effect on the next sample; with no feedback the output then equals a
    // render that had the new settings all along
    const run = (change: boolean) => {
      const fx = make({ ...STATIC, delay: change ? 0 : 1024, dry: 0, feed: 0 });
      const x = sine(211, 1, 0.5, SR);
      const L = Float32Array.from(x), R = Float32Array.from(x);
      const ctx = makeCtx({ sampleRate: SR });
      for (let i = 0; i < L.length; i += 128) {
        if (change && i === 128 * 100) fx.setParams({ ...defaultFxParams('flanger'), ...STATIC, delay: 1024, dry: 0, feed: 0 });
        fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, ctx);
      }
      return L;
    };
    const a = run(true), b = run(false);
    let before = 0, after = 0;
    for (let i = 128 * 99; i < 128 * 100; i++) before = Math.max(before, Math.abs(a[i] - b[i]));
    for (let i = 128 * 100; i < a.length; i++) after = Math.max(after, Math.abs(a[i] - b[i]));
    expect(before).toBeGreaterThan(0.1);
    expect(after).toBeLessThan(1e-6);
  });

  it('is silent after its tail and stays finite at extreme settings', () => {
    const fx = make();
    const x = new Float32Array(SR);
    x.set(sine(330, 0.3, 0.8, SR));
    const [L] = render(fx, x, x, 128, { sampleRate: SR });
    expect(peak(L, Math.round((0.3 + fx.tail!) * SR) + 10)).toBeLessThan(1e-5);

    const loud = new Float32Array(SR * 2);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i * 0.37) * 4 + ((i * 7919) % 13) / 13;
    for (const p of [
      { delay: 1024, depth: 5000, rate: 5000, phase: 360, damp: 0, shape: 1024, feed: 100, invFeedback: 0, invWet: 1024, dry: 5000, wet: 5000, cross: 5000 },
      { delay: 0, depth: 0, rate: 0, phase: 0, damp: 5000, shape: 0, feed: 100, invFeedback: 1024, invWet: 0, dry: 0, wet: 0, cross: 0 },
      { delay: 0, depth: 5000, rate: 5000, phase: 180, damp: 4999, shape: 512, feed: 100, invFeedback: 1024, invWet: 0, dry: 5000, wet: 5000, cross: 5000 },
    ]) {
      const f = make(p);
      const [a, b] = render(f, loud, loud, 64, { sampleRate: SR });
      expect(a.every(Number.isFinite) && b.every(Number.isFinite)).toBe(true);
      expect(peak(a)).toBeLessThan(500);
    }
    // damp 1 silences the wet path completely (FL: "full filtering - no output")
    const mute = make({ ...STATIC, damp: 5000 });
    const [m] = render(mute, loud, loud, 128, { sampleRate: SR });
    expect(rms(m)).toBe(0);
  });
});
