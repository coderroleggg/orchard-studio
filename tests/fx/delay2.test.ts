import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { d2CutoffCoef, d2Gain, d2OffsetMs } from '../../src/model/fx/plugins/delay2';
import { makeCtx, render, peak } from './util';

// Reference numbers were measured from FL Studio 2026's Fruity Delay 2 with
// flfxhost (docs/research/fx/delay2.md).

const SR = 44100;
const base = (over: Record<string, number> = {}) => ({ ...defaultFxParams('delay2'), ...over });

function run(params: Record<string, unknown>, L: Float32Array, R: Float32Array = L, tempo = 120, sr = SR) {
  const fx = createEffect('delay2', sr, 128);
  fx.setParams(params);
  return { fx, out: render(fx, L, R, 128, { sampleRate: sr, tempo }) };
}

function impulse(n: number, at = 0, amp = 0.5): Float32Array {
  const b = new Float32Array(n);
  b[at] = amp;
  return b;
}

const taps = (b: Float32Array, thr = 1e-6) => Array.from(b).flatMap((v, i) => (Math.abs(v) > thr ? [[i, Number(v.toFixed(5))]] : []));

describe('Delay 2', () => {
  it('is registered with FL ranges, defaults, presets and texts', () => {
    const d = fxDef('delay2')!;
    expect([d.width, d.height]).toEqual([400, 100]);
    expect(defaultFxParams('delay2')).toMatchObject({ pan: 0, vol: 128, dry: 128, feedback: 64, time: 144, offset: 0, mode: 0, cutoff: 128 });
    expect(d.presets?.length).toBe(6);
    const f = (k: string, v: number) => formatParam(d.params.find((q) => q.key === k)!, v);
    expect(f('vol', 128)).toBe('80%');
    expect(f('vol', 92)).toBe('58%'); // FL rounds 57.5 up
    expect(f('pan', -80)).toBe('-63%');
    expect(f('feedback', 39)).toBe('31%'); // feedback text is raw / 127
    expect(f('time', 144)).toBe('3:00');
    expect(f('time', 80)).toBe('1:32');
    expect(f('offset', -512)).toBe('500.0ms left');
    expect(f('offset', -256)).toBe('15.3ms left');
    expect(f('offset', 7)).toBe('0.0ms right');
    expect(f('mode', 2)).toBe('P.Pong');
  });

  it('maps volume, cutoff and offset like FL', () => {
    expect(d2Gain(128)).toBeCloseTo(1, 9);
    expect(d2Gain(64)).toBeCloseTo(0.23166, 5);
    expect(d2Gain(160)).toBeCloseTo(1.90328, 4);
    expect(d2CutoffCoef(64, 44100)).toBeCloseTo(0.179129, 5);
    expect(d2CutoffCoef(128, 48000)).toBeCloseTo(0.91875, 5);
    expect(d2OffsetMs(512)).toBeCloseTo(500, 9);
  });

  it('echoes on round-half-even samples at the tempo, feedback raw / 128', () => {
    // 3 steps at 120 BPM = 16537.5 -> 16538; 1 step = 5512.5 -> 5512 (FL)
    expect(taps(run(base({ dry: 0 }), impulse(40000)).out[0]).slice(0, 2)).toEqual([[16538, 0.5], [33076, 0.25]]);
    expect(taps(run(base({ dry: 0, time: 48, feedback: 96 }), impulse(12000)).out[0]).slice(0, 2)).toEqual([[5512, 0.5], [11024, 0.375]]);
    expect(taps(run(base({ dry: 0, feedback: 0, time: 144 }), impulse(22000), undefined, 97).out[0])[0][0]).toBe(20459);
  });

  it('filters the feedback with a one-pole low-pass (FL coefficients)', () => {
    const r = run(base({ dry: 0, time: 48, cutoff: 64 }), impulse(12000)).out[0];
    expect(r[5512] / 0.5).toBeCloseTo(0.179129, 5);
    expect(r[5513] / 0.5).toBeCloseTo(0.147042, 5);
    expect(r[11024] / 0.5).toBeCloseTo(0.016044, 5); // second pass, x 0.5 feedback
    expect(peak(run(base({ dry: 0, cutoff: 0 }), impulse(40000)).out[0])).toBe(0);
  });

  it('feedback modes and input pan follow FL', () => {
    const L = impulse(20000), Z = new Float32Array(20000);
    const inv = run(base({ dry: 0, time: 48, mode: 1 }), L, Z).out;
    expect(peak(inv[0])).toBe(0);
    expect(inv[1][5512]).toBeCloseTo(0.5, 6);
    const pp = run(base({ dry: 0, time: 48, mode: 2 }), L, Z).out;
    expect(pp[1][5512]).toBeCloseTo(0.5, 6);
    expect(pp[0][11024]).toBeCloseTo(0.25, 6);
    const pan = run(base({ dry: 0, time: 48, feedback: 0, pan: 64 }), L, Z).out;
    expect(pan[0][5512] / 0.5).toBeCloseTo(0.5, 5);
    expect(pan[1][5512] / 0.5).toBeCloseTo(0.25, 5);
  });

  it('offsets one input by up to 500 ms (left when negative)', () => {
    const r = run(base({ dry: 0, time: 48, offset: -256, feedback: 0 }), impulse(12000)).out;
    expect(taps(r[0])[0][0]).toBe(6188);
    expect(taps(r[1])[0][0]).toBe(5512);
  });

  it('clears its lines when the time changes (FL), and ramps volume per block', () => {
    const fx = createEffect('delay2', SR, 128);
    const p = base({ dry: 0, time: 48, feedback: 100 });
    fx.setParams(p);
    const ctx = makeCtx({ sampleRate: SR });
    const N = SR, L = new Float32Array(N);
    for (let i = 0; i < N; i += 441) L[i] = 0.1;
    const R = Float32Array.from(L);
    for (let s = 0; s < N; s += 128) {
      if (s === 22016) fx.setParams({ ...p, time: 60 });
      fx.process(L.subarray(s, s + 128), R.subarray(s, s + 128), 128, ctx);
    }
    // silence for the new delay length (6891), then echoes again
    expect(peak(L, 22020, 22016 + 6880)).toBe(0);
    expect(peak(L, 22016 + 6891, 22016 + 7400)).toBeGreaterThan(0.05);
  });

  it('is finite at extremes and quiet after its tail', () => {
    const x = new Float32Array(SR * 2);
    for (let i = 0; i < 4410; i++) x[i] = Math.sin(i * 0.1);
    const { out, fx } = run(base({ feedback: 127, vol: 160, cutoff: 128, time: 1, mode: 2, offset: 512 }), x);
    expect(out[0].every(Number.isFinite) && out[1].every(Number.isFinite)).toBe(true);
    expect(fx.tail).toBeLessThanOrEqual(60);
    const q = run(base({ feedback: 64, time: 12 }), x).out[0];
    expect(peak(q, SR + 30000, SR * 2)).toBeLessThan(1e-4);
  });

  it('switches the dry level at the next block (FL, no ramp)', () => {
    const fx = createEffect('delay2', SR, 128);
    fx.setParams({ ...defaultFxParams('delay2'), feedback: 0 });
    render(fx, new Float32Array(256).fill(0.25), undefined, 128, { sampleRate: SR, tempo: 120 });
    fx.setParams({ ...defaultFxParams('delay2'), feedback: 0, dry: 40 });
    const [L] = render(fx, new Float32Array(128).fill(0.25), undefined, 128, { sampleRate: SR, tempo: 120 });
    expect(L[0]).toBeCloseTo(0.25 * d2Gain(40), 7);
    expect(L[127]).toBeCloseTo(0.25 * d2Gain(40), 7);
  });
});
