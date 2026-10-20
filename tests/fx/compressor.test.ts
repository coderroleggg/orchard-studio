import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef, normalizeFxParams } from '../../src/model/fx/registry';
import { makeCtx, render, sine, peak } from './util';

const SR = 44100;
const fmt = (key: string, v: number) => formatParam(fxParamDef('compressor', key)!, v);

function make(p: Record<string, unknown> = {}, sr = SR) {
  const fx = createEffect('compressor', sr, 128);
  fx.setParams({ ...defaultFxParams('compressor'), ...p });
  return fx;
}

/** Constant-magnitude test signal (alternating sign at Nyquist): segments of [amplitude, samples]. */
function nyq(segs: [number, number][]): Float32Array {
  const n = segs.reduce((a, [, len]) => a + len, 0);
  const b = new Float32Array(n);
  let o = 0;
  for (const [v, len] of segs) for (let i = 0; i < len; i++, o++) b[o] = o % 2 === 0 ? v : -v;
  return b;
}

function run(x: Float32Array, p: Record<string, unknown> = {}): Float32Array {
  const [L] = render(make(p), x, x, 128, { sampleRate: SR });
  return L;
}

/** Output gain at input index i (the plugin delays by 64 samples). */
const gainAt = (y: Float32Array, x: Float32Array, i: number) => Math.abs(y[i + 64] / x[i]);

describe('Compressor', () => {
  it('is registered with FL parameter names, ranges, defaults and value texts', () => {
    const d = fxDef('compressor')!;
    expect(d.name).toBe('Compressor');
    expect(d.category).toBe('Dynamics');
    expect([d.width, d.height]).toEqual([500, 105]);
    expect(d.params.map((p) => [p.name, p.index, p.min, p.max, p.def])).toEqual([
      ['Threshold', 0, -600, 0, 0], ['Ratio', 1, 4, 300, 10], ['Gain', 2, -300, 300, 0],
      ['Attack', 3, 0, 4000, 150], ['Release', 4, 1, 4000, 200], ['Type', 5, 0, 7, 0],
    ]);
    expect(defaultFxParams('compressor')).toMatchObject({ sidechain: 0, reportLatency: true });
    expect([-600, -84, -1, 0].map((v) => fmt('thr', v))).toEqual(['-60.0 dB', '-8.4 dB', '-0.1 dB', '0.0 dB']);
    expect([4, 10, 32, 300].map((v) => fmt('ratio', v))).toEqual(['0.4 : 1', '1.0 : 1', '3.2 : 1', '30.0 : 1']);
    expect([-300, 0, 34, 300].map((v) => fmt('gain', v))).toEqual(['-30.0 dB', '0.0 dB', '3.4 dB', '30.0 dB']);
    expect([0, 108, 150, 4000].map((v) => fmt('att', v))).toEqual(['0.0 ms', '10.8 ms', '15.0 ms', '400.0 ms']);
    expect([1, 117, 4000].map((v) => fmt('rel', v))).toEqual(['1 ms', '117 ms', '4000 ms']);
    expect([0, 2, 7].map((v) => fmt('type', v))).toEqual(['Hard', 'Vintage', 'Soft/R']);
    expect(d.presets).toHaveLength(20);
    expect(d.presets?.find((p) => p.name === 'External/Master 1')?.params).toEqual({ thr: -84, ratio: 32, gain: 34, att: 108, rel: 117, type: 7 });
  });

  it('reports FL\'s fixed 64-sample look-ahead (unless Report latency is off)', () => {
    expect(make().latency).toBe(64);
    expect(make({}, 48000).latency).toBe(64);
    expect(make({ reportLatency: false }).latency).toBe(0);
  });

  it('applies FL\'s 3 Hz DC blocker and delay (impulse response measured on FL)', () => {
    const x = new Float32Array(400);
    x[100] = 0.5;
    const y = run(x);
    const h = (k: number) => y[100 + 64 + k] / 0.5;
    expect(h(-1)).toBeCloseTo(0, 6);
    expect(h(0)).toBeCloseTo(0.9997863, 6);
    expect(h(1)).toBeCloseTo(-0.0004273, 6);
    expect(h(100)).toBeCloseTo(-0.00040957, 7);
  });

  it('matches FL\'s static curves: hard, medium (±6 dB), soft (±15 dB) and vintage knees', () => {
    const at = (p: Record<string, unknown>, amp: number) => { const x = nyq([[amp, 6000]]); return gainAt(run(x, { att: 0, rel: 1, ...p }), x, 5000); };
    const m10 = Math.pow(10, -10 / 20);
    expect(at({ thr: -200, ratio: 40, type: 0 }, m10)).toBeCloseTo(0.421656, 4);
    expect(at({ thr: -200, ratio: 40, type: 1 }, m10)).toBeCloseTo(0.421656, 4);
    expect(at({ thr: -200, ratio: 40, type: 2 }, m10)).toBeCloseTo(0.445251, 4);
    expect(at({ thr: -200, ratio: 40, type: 3 }, m10)).toBeCloseTo(0.406758, 4);
    expect(at({ thr: -200, ratio: 40, type: 1 }, 0.1)).toBeCloseTo(0.878464, 4);
    expect(at({ thr: -200, ratio: 40, type: 3 }, 0.1)).toBeCloseTo(0.723351, 4);
    // vintage returns to 1:1: maximum reduction (1 - 1/R)·1.25·R^¼ nepers (11.52 dB at 4:1)
    expect(at({ thr: -600, ratio: 40, type: 2 }, 0.1)).toBeCloseTo(0.265572, 4);
    expect(at({ thr: -600, ratio: 40, type: 2 }, 0.001)).toBeCloseTo(0.806733, 4);
  });

  it('matches FL\'s attack and release envelopes', () => {
    const xa = nyq([[0.01, 10000], [0.5, 4000]]);
    const ya = run(xa, { thr: -200, ratio: 300, att: 100, rel: 200 });
    const fla: [number, number][] = [[0, 0.99569], [10, 0.95577], [30, 0.88191], [64, 0.77277], [128, 0.61318], [192, 0.49892], [1000, 0.2152]];
    for (const [k, v] of fla) expect(Math.abs(gainAt(ya, xa, 10000 + k) - v)).toBeLessThan(2e-4);
    const xr = nyq([[0.01, 10000], [0.5, 20000], [0.01, 17000]]);
    const yr = run(xr, { thr: -200, ratio: 40, att: 100, rel: 200 });
    const flr: [number, number][] = [[500, 0.38467], [1000, 0.4602], [2000, 0.58438], [4000, 0.75334], [8000, 0.91303], [16000, 0.98925]];
    // the quiet release segment (0.01) shows FL's float32 DC-blocker noise: compare to 1e-3
    for (const [k, v] of flr) expect(Math.abs(gainAt(yr, xr, 30000 + k) - v)).toBeLessThan(1e-3);
  });

  it('shortens the release after transients with TCR, and Vintage/R settles at -2.1 dB like FL', () => {
    const x = nyq([[0.01, 8820], [0.5, 2205], [0.01, 5000]]);
    const y = run(x, { thr: -200, ratio: 300, att: 10, rel: 500, type: 4 });
    const db = (i: number) => 20 * Math.log10(gainAt(y, x, i));
    expect(db(11025 + 441)).toBeCloseTo(-8.383, 1);
    expect(db(11025 + 2205)).toBeCloseTo(-3.729, 1);
    expect(db(11025 + 4410)).toBeCloseTo(-2.441, 1);
    const xv = nyq([[0.01, 8820], [0.5, 22050], [0.01, 46000]]);
    const yv = run(xv, { thr: -200, ratio: 300, att: 10, rel: 500, type: 6 });
    expect(20 * Math.log10(gainAt(yv, xv, 30870 + 44100))).toBeCloseTo(-2.096, 2);
  });

  it('limits the output to -0.1 dBFS with its look-ahead limiter (FL: 0.988553)', () => {
    expect(peak(run(sine(1000, 0.5, 2, SR)), 11025)).toBeCloseTo(0.988553, 5);
    expect(peak(run(sine(1000, 0.5, 0.25, SR), { gain: 300 }), 11025)).toBeLessThanOrEqual(0.98856);
  });

  it('keys the detector from the selected sidechain input', () => {
    const fx = make({ thr: -200, ratio: 300, att: 0, rel: 1, sidechain: 1 });
    const n = 4096;
    const L = nyq([[0.1, n]]), R = nyq([[0.1, n]]);
    const sc = new Float32Array(n).fill(0.5);
    for (let i = 0; i < n; i += 128) {
      fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, makeCtx({ sampleRate: SR, sidechain: [{ source: 2, L: sc.subarray(i, i + 128), R: sc.subarray(i, i + 128) }] }));
    }
    // (20·log10(0.5) + 20)·(1 - 1/30) = 13.51 dB of reduction on the quiet main signal
    expect(Math.abs(L[3000] / 0.1)).toBeCloseTo(Math.pow(10, -13.513 / 20), 3);
  });

  it('steps makeup gain changes (FL, no ramp) and stays finite and silent where it should', () => {
    const fx = make({ gain: 0 });
    const a = new Float32Array(256).fill(0.1);
    fx.process(a, Float32Array.from(a), 256, makeCtx({ sampleRate: SR }));
    fx.setParams({ ...defaultFxParams('compressor'), gain: 120 });
    const L = new Float32Array(512).fill(0.1), R = new Float32Array(512).fill(0.1);
    fx.process(L, R, 512, makeCtx({ sampleRate: SR }));
    // the new makeup applies to the first sample after the change, heard after the 64-sample look-ahead
    expect(L[64] / L[63]).toBeCloseTo(Math.pow(10, 120 / 200), 2);
    expect(peak(run(new Float32Array(4096)))).toBeLessThan(1e-20);
    const noise = new Float32Array(SR);
    let s = 7;
    for (let i = 0; i < noise.length; i++) { s = (s * 16807) % 2147483647; noise[i] = (s / 2147483647 - 0.5) * 50; }
    noise[500] = NaN;
    for (const p of [{ thr: -600, ratio: 4, gain: 300, att: 0, rel: 1, type: 6 }, { thr: -600, ratio: 300, att: 4000, rel: 4000, type: 7 }, { thr: 0, ratio: 4, gain: 300, type: 2 }]) {
      const [L2, R2] = render(make(p), noise, noise, 128, { sampleRate: SR });
      for (let i = 0; i < L2.length; i++) { expect(Number.isFinite(L2[i])).toBe(true); expect(Number.isFinite(R2[i])).toBe(true); }
      expect(peak(L2)).toBeLessThan(1);
    }
  });

  it('repairs stored states', () => {
    expect(normalizeFxParams('compressor', { sidechain: -3, reportLatency: 0 })).toMatchObject({ sidechain: 0, reportLatency: true });
    expect(normalizeFxParams('compressor', { reportLatency: false }).reportLatency).toBe(false);
  });
});
