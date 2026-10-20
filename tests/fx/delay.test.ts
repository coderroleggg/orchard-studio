import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { delayCutoffCoef, delayMode, delayTempo } from '../../src/model/fx/plugins/delay';
import { makeCtx, render, peak } from './util';

// Reference numbers were measured from FL Studio 2026's (legacy) Fruity Delay
// with flfxhost (docs/research/fx/delay.md).

const SR = 44100;
const base = (over: Record<string, number> = {}) => ({ ...defaultFxParams('delay'), ...over });

function run(params: Record<string, unknown>, L: Float32Array, R: Float32Array = new Float32Array(L.length), tempo = 120, sr = SR) {
  const fx = createEffect('delay', sr, 128);
  fx.setParams(params);
  return { fx, out: render(fx, L, R, 128, { sampleRate: sr, tempo }) };
}

function impulse(n: number, at = 0, amp = 0.5): Float32Array {
  const b = new Float32Array(n);
  b[at] = amp;
  return b;
}

const taps = (b: Float32Array, thr = 1e-6) => Array.from(b).flatMap((v, i) => (Math.abs(v) > thr ? [[i, Number(v.toFixed(6))]] : []));

describe('Delay (legacy)', () => {
  it('is registered (hidden) with FL ranges, defaults, presets and labels', () => {
    const d = fxDef('delay')!;
    expect(d.hidden).toBe(true);
    expect([d.width, d.height]).toEqual([500, 105]);
    expect(defaultFxParams('delay')).toEqual({ input: 338, feedback: 512, cutoff: 1024, tempo: 0, steps: 3, mode: 0 });
    expect(d.presets?.map((p) => p.name)).toEqual(['Default', 'Ambient', 'Double attack', 'Half step at 140', 'Lowpass', 'Single echo']);
    const f = (k: string, v: number) => formatParam(d.params.find((q) => q.key === k)!, v);
    expect(f('tempo', 0)).toBe('Auto bpm');
    expect(f('tempo', 64)).toBe('74 bpm');
    expect(f('tempo', 1024)).toBe('280 bpm');
    expect(f('steps', 3)).toBe('3 notes');
    expect(f('mode', 341)).toBe('Normal');
    expect(f('mode', 342)).toBe('Inv. stereo');
    expect(f('mode', 683)).toBe('Ping pong');
    expect([delayMode(682), delayMode(1024), delayTempo(1), delayTempo(512)]).toEqual([1, 2, 60, 170]);
  });

  it('echoes at steps x round(samples per step), input linear, dry always at unity', () => {
    const p = { input: 1024, feedback: 0, steps: 4 };
    expect(taps(run(base(p), impulse(30000)).out[0])).toEqual([[0, 0.5], [22048, 0.5]]); // 4 x 5512
    expect(taps(run(base({ ...p, steps: 3 }), impulse(30000), undefined, 97).out[0])[1][0]).toBe(20460); // 3 x 6820
    expect(taps(run(base({ ...p, tempo: 64 }), impulse(40000)).out[0])[1][0]).toBe(35756); // 74 BPM
    expect(taps(run(base({ input: 338, feedback: 0, steps: 1 }), impulse(6000)).out[0])).toEqual([[0, 0.5], [5512, 0.165039]]);
    expect(taps(run(base({ input: 0 }), impulse(30000)).out[0])).toEqual([[0, 0.5]]);
  });

  it('feeds back 0.99 x v / 1024 through FL\'s one-pole low-pass', () => {
    const t = taps(run(base({ input: 1024, feedback: 512, steps: 1 }), impulse(20000)).out[0]);
    expect(t[2][1] / t[1][1]).toBeCloseTo(0.495, 6);
    const t2 = taps(run(base({ input: 1024, feedback: 1024, steps: 1 }), impulse(20000)).out[0]);
    expect(t2[2][1] / t2[1][1]).toBeCloseTo(0.99, 6);
    expect(delayCutoffCoef(512)).toBeCloseTo(0.179129, 6);
    const lp = run(base({ input: 1024, feedback: 512, cutoff: 512, steps: 1 }), impulse(12000)).out[0];
    expect(lp[5512] / 0.5).toBeCloseTo(0.179129, 5);
    expect(lp[11024] / 0.5).toBeCloseTo(0.015883, 5); // second pass: a^2 x 0.495
    const lp48 = run(base({ input: 1024, feedback: 0, cutoff: 512, steps: 1 }), impulse(7000), undefined, 120, 48000).out[0];
    expect(lp48[6000] / 0.5).toBeCloseTo(0.179129, 5); // no sample-rate scaling
  });

  it('inverted stereo and ping pong route like FL', () => {
    const inv = run(base({ input: 1024, feedback: 512, steps: 1, mode: 600 }), impulse(20000)).out;
    expect(taps(inv[0])).toEqual([[0, 0.5]]);
    expect(taps(inv[1]).slice(0, 2)).toEqual([[5512, 0.5], [11024, 0.2475]]);
    const pp = run(base({ input: 1024, feedback: 512, steps: 1, mode: 1024 }), impulse(20000)).out;
    expect(taps(pp[1])[0]).toEqual([5512, 0.5]);
    expect(taps(pp[0])[1]).toEqual([11024, 0.2475]);
  });

  it('ramps input and feedback per block (0.001 per sample) and clears on a length change', () => {
    const fx = createEffect('delay', SR, 512);
    const p = base({ input: 1024, feedback: 0, steps: 1 });
    fx.setParams(p);
    const ctx = makeCtx({ sampleRate: SR, blockSize: 512 });
    const N = 512 * 20, L = new Float32Array(N).fill(0.5), R = new Float32Array(N);
    for (let s = 0; s < N; s += 512) {
      if (s === 512) fx.setParams({ ...p, input: 0 });
      fx.process(L.subarray(s, s + 512), R.subarray(s, s + 512), 512, ctx);
    }
    const wet = (i: number) => L[i] / 0.5 - 1;
    expect(wet(512 + 5512)).toBeCloseTo(1, 6);
    expect(wet(512 + 5513)).toBeCloseTo(0.999, 6);
    expect(wet(512 + 5512 + 511)).toBeCloseTo(0.489, 5);
    expect(wet(512 + 5512 + 1100)).toBeCloseTo(0, 6);

    const fx2 = createEffect('delay', SR, 128);
    const q = base({ input: 1024, feedback: 800, steps: 2 });
    fx2.setParams(q);
    const M = SR, X = new Float32Array(M), Y = new Float32Array(M);
    for (let i = 0; i < M; i += 441) X[i] = 0.1;
    const dry = Float32Array.from(X);
    for (let s = 0; s < M; s += 128) {
      if (s === 22016) fx2.setParams({ ...q, steps: 3 });
      fx2.process(X.subarray(s, s + 128), Y.subarray(s, s + 128), 128, ctx);
    }
    const w = X.map((v, i) => v - dry[i]);
    expect(peak(w, 22020, 22016 + 16530)).toBe(0); // FL: next echoes at +16536
    expect(peak(w, 22016 + 16536, 22016 + 17000)).toBeGreaterThan(0.05);
  });

  it('is finite at extremes and quiet after its tail', () => {
    const x = new Float32Array(SR * 2);
    for (let i = 0; i < 4410; i++) x[i] = Math.sin(i * 0.1);
    const { out, fx } = run(base({ input: 1024, feedback: 1024, cutoff: 1024, steps: 1, tempo: 1024, mode: 1024 }), x);
    expect(out[0].every(Number.isFinite) && out[1].every(Number.isFinite)).toBe(true);
    expect(fx.tail).toBeLessThanOrEqual(60);
    const q = run(base({ steps: 1, feedback: 400 }), x).out[0];
    expect(peak(q, SR + 30000, SR * 2)).toBeLessThan(1e-4);
  });
});
