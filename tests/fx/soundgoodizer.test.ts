import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { sgMaximusState } from '../../src/model/fx/plugins/soundgoodizer';
import { makeCtx } from './util';

// Reference numbers measured on FL Studio 2026's own Soundgoodizer with flfxhost
// (state = version 3, mode, amount; docs/research/fx/soundgoodizer.md).

const SR = 44100;

function render(st: Record<string, unknown>, L: Float32Array, R: Float32Array = Float32Array.from(L)) {
  const fx = createEffect('soundgoodizer', SR, 128);
  fx.setParams(st);
  fx.reset();
  const ctx = makeCtx({ sampleRate: SR });
  for (let i = 0; i < L.length; i += 128) fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i), ctx);
  return { fx, L, R };
}

const sine = (f: number, db: number, n: number) => Float32Array.from({ length: n }, (_, i) => Math.pow(10, db / 20) * Math.sin((2 * Math.PI * f * i) / SR));
const rms = (b: Float32Array, a: number) => { let s = 0; for (let i = a; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / (b.length - a)); };
const peak = (b: Float32Array, a: number) => { let m = 0; for (let i = a; i < b.length; i++) m = Math.max(m, Math.abs(b[i])); return m; };

describe('Soundgoodizer', () => {
  it('is registered like FL (no automatable parameters, amount 60 %, mode A)', () => {
    const d = fxDef('soundgoodizer')!;
    expect(d.width).toBe(210);
    expect(d.height).toBe(294);
    expect(d.category).toBe('Dynamics');
    expect(defaultFxParams('soundgoodizer')).toEqual({ amount: 600, mode: 0 });
    expect(d.params.every((p) => p.noAuto)).toBe(true);
    expect(formatParam(d.params[0], 600)).toBe('60%');
    expect(formatParam(d.params[1], 3)).toBe('D');
  });

  it('runs the Maximus "Soundgoodizer presets" with the amount as LMH mix', () => {
    const st = sgMaximusState(2, 450);
    expect(st.lmhMix).toBe(450);
    expect(st.highFreq).toBe(43329);
    expect(st.lowSlope).toBe(1);
    expect(st.highSlope).toBe(0);
  });

  it('reports FL latency per mode (153, 88, 153, 176 samples at 44.1 kHz)', () => {
    const want = [153, 88, 153, 176];
    for (let mode = 0; mode < 4; mode++) {
      const { fx } = render({ mode, amount: 600 }, new Float32Array(128));
      expect(fx.latency).toBe(want[mode]);
    }
  });

  it('matches FL levels', () => {
    // mode A, 60 %, 1 kHz at -6 dBFS: FL RMS 0.50996, peak 0.72087 (from 0.5 s)
    const a = render({ mode: 0, amount: 600 }, sine(1000, -6, SR));
    expect(rms(a.L, SR / 2)).toBeCloseTo(0.50996, 3);
    expect(peak(a.L, SR / 2)).toBeCloseTo(0.72087, 2);
    // mode C, 100 %, 100 Hz at -3 dBFS: FL RMS 0.67999, peak 0.92443
    const c = render({ mode: 2, amount: 1000 }, sine(100, -3, SR));
    expect(rms(c.L, SR / 2)).toBeCloseTo(0.67999, 3);
    expect(peak(c.L, SR / 2)).toBeCloseTo(0.92443, 2);
  });

  it('louder with more amount, silent in silence, finite with hot input', () => {
    const lo = render({ mode: 1, amount: 0 }, sine(300, -12, SR / 2));
    const hi = render({ mode: 1, amount: 1000 }, sine(300, -12, SR / 2));
    expect(rms(hi.L, SR / 4)).toBeGreaterThan(rms(lo.L, SR / 4) * 1.5);
    const s = render({ mode: 3, amount: 1000 }, new Float32Array(SR / 4));
    expect(peak(s.L, 0)).toBe(0);
    const hot = Float32Array.from({ length: SR / 4 }, (_, i) => (i % 100 < 3 ? 20 : -0.5));
    for (let mode = 0; mode < 4; mode++) {
      const r = render({ mode, amount: 1000 }, Float32Array.from(hot));
      for (let i = 0; i < r.L.length; i++) expect(Number.isFinite(r.L[i])).toBe(true);
      expect(peak(r.L, 2000)).toBeLessThan(1.5);
    }
  });

  it('ramps amount changes (no zipper)', () => {
    const fx = createEffect('soundgoodizer', SR, 128);
    fx.setParams({ mode: 2, amount: 1000 });
    fx.reset();
    const ctx = makeCtx({ sampleRate: SR });
    const x = sine(200, -10, 8192), y = Float32Array.from(x);
    for (let i = 0; i < 4096; i += 128) fx.process(x.subarray(i, i + 128), y.subarray(i, i + 128), 128, ctx);
    fx.setParams({ mode: 2, amount: 0 });
    let maxStep = 0;
    for (let i = 4096; i < 8192; i += 128) {
      fx.process(x.subarray(i, i + 128), y.subarray(i, i + 128), 128, ctx);
    }
    for (let i = 4097; i < 4300; i++) maxStep = Math.max(maxStep, Math.abs(x[i] - x[i - 1]));
    // a 200 Hz sine at -10 dB changes by at most ~0.0095 per sample; a jump would be far larger
    expect(maxStep).toBeLessThan(0.05);
  });
});
