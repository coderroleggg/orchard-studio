import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import { freqText, levelText, mainText, peqFreqHz, peqFreqValue, peqMainGain, widthText } from '../../src/model/fx/plugins/peq';
import { peqDesign } from '../../src/engine/effects/plugins/peq';
import { magnitude, type BiquadCoefs } from '../../src/engine/dsp/biquad';
import { makeCtx, render, rms, sine, peak } from './util';

function fx(p: Record<string, number> = {}) {
  const e = createEffect('peq', 48000, 128);
  e.setParams({ ...defaultFxParams('peq'), ...p });
  e.reset();
  return e;
}

describe('Parametric EQ', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('peq')!;
    expect(d.name).toBe('Parametric EQ');
    expect([d.width, d.height]).toEqual([240, 350]);
    expect(d.params).toHaveLength(29);
    expect(d.params.map((p) => p.index)).toEqual(Array.from({ length: 29 }, (_, i) => i));
    expect(d.params[0].name).toBe('Band 1 level');
    expect(d.params[13].name).toBe('Band 7 freq');
    expect(d.params[27].options![7]).toBe('High shelf');
    const p = defaultFxParams('peq');
    expect(p.freq1).toBe(5777);
    expect(p.width5).toBe(24000);
    expect(p.type1).toBe(5);
    expect(p.type7).toBe(7);
    expect(p.main).toBe(128);
    // FL's texts (flfxhost sweep)
    expect(freqText(5777)).toBe('90Hz');
    expect(freqText(32768)).toBe('1457Hz');
    expect(freqText(65536)).toBe('16000Hz');
    expect(levelText(-1800)).toBe('-18.0dB');
    expect(widthText(17500)).toBe('27%');
    expect(mainText(128)).toBe('50%');
    expect(peqFreqValue(peqFreqHz(40000))).toBe(40000);
    // FL's 21 factory presets; Default equals the initial state
    expect(d.presets).toHaveLength(21);
    expect(d.presets!.find((q) => q.name === 'Default')!.params).toEqual(p);
    expect(d.presets!.find((q) => q.name === 'Phone')!.params.type2).toBe(7);
  });

  it('uses FL coefficients (fitted from FL impulse responses at 48 kHz)', () => {
    const c: BiquadCoefs = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };
    const cases: [number, number, number[]][] = [
      [1, 0, [0.008903, 0.0178061, 0.008903, -1.9282204, 0.9638326]],
      [2, 0, [0.0180837, 0, -0.0180837, -1.9282204, 0.9638326]],
      [4, 0, [0.9819163, -1.9282204, 0.9819163, -1.9282204, 0.9638326]],
      [5, 12, [1.1251159, -1.7325065, 0.6718263, -1.7566316, 0.7728171]],
      [6, 12, [1.2083637, -1.826476, 0.6518454, -1.8264759, 0.8602089]],
      [7, 12, [3.5383661, -6.2156034, 2.7345077, -1.5398465, 0.597117]],
    ];
    for (const [type, db, want] of cases) {
      expect(peqDesign(c, type, db, 32768, 17500, 48000)).toBe(true);
      // peaking Q = 0.1 + 0.0999 (1001^t - 1) (FL's code)
      [c.b0, c.b1, c.b2, c.a1, c.a2].forEach((v, i) => expect(v).toBeCloseTo(want[i], 5));
    }
    // a 0 dB peak or shelf runs (FL keeps it for fs/5 samples) with identity coefficients; disabled bands do not run
    expect(peqDesign(c, 6, 0, 32768, 17500, 48000)).toBe(true);
    expect(c.b0).toBeCloseTo(1, 12);
    expect(c.b1).toBeCloseTo(c.a1, 12);
    expect(c.b2).toBeCloseTo(c.a2, 12);
    expect(peqDesign(c, 0, 6, 32768, 17500, 48000)).toBe(false);
  });

  it('is transparent at its defaults and applies the main level', () => {
    const x = sine(1000, 0.2);
    const [y] = render(fx(), x);
    for (let i = 0; i < x.length; i += 97) expect(y[i]).toBeCloseTo(x[i], 6);
    const [q] = render(fx({ main: 64 }), x);
    expect(peak(q, 2000) / peak(x)).toBeCloseTo(peqMainGain(64), 3);
    expect(peqMainGain(256)).toBeCloseTo(12, 5);
  });

  it('boosts a peaking band by its level at the band frequency', () => {
    const f = peqFreqHz(32768);
    const [y] = render(fx({ level4: 1200, freq4: 32768, width4: 32768 }), sine(f, 0.5, 0.1));
    expect(20 * Math.log10(rms(y, 12000) / rms(sine(f, 0.5, 0.1), 12000))).toBeCloseTo(12, 1);
    const c: BiquadCoefs = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };
    peqDesign(c, 3, 0, 32768, 17500, 48000); // high pass
    expect(magnitude(c, 100, 48000)).toBeLessThan(0.01);
  });

  it('switches coefficients at the next block (FL, direct form I keeps its state) and settles on the target', () => {
    const e = fx({ level4: 0, freq4: 32768, width4: 32768 });
    const f = peqFreqHz(32768);
    const x = sine(f, 0.4, 0.2);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const ctx = makeCtx();
    let maxStep = 0;
    for (let i = 0; i < x.length; i += 128) {
      if (i === 9600) e.setParams({ ...defaultFxParams('peq'), level4: 1800, freq4: 32768, width4: 32768 });
      e.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, ctx);
    }
    for (let i = 9500; i < 12000; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
    // a sine of amplitude a has a per-sample step of at most a * 2 pi f / fs
    const bound = 0.2 * Math.pow(10, 18 / 20) * 2 * Math.PI * f / 48000;
    expect(maxStep).toBeLessThan(bound * 1.2);
    expect(20 * Math.log10(rms(L, 16000) / rms(x, 16000))).toBeCloseTo(18, 1);
  });

  it('stays silent on silence and finite at extreme settings', () => {
    const [s] = render(fx({ level1: 1800 }), new Float32Array(4800));
    expect(rms(s)).toBe(0);
    const noise = new Float32Array(48000);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 2;
    const p: Record<string, number> = { main: 256 };
    for (let b = 1; b <= 7; b++) { p[`type${b}`] = 6; p[`level${b}`] = 1800; p[`freq${b}`] = 0; p[`width${b}`] = 65536; }
    const [y] = render(fx(p), noise);
    expect(y.every((v) => Number.isFinite(v))).toBe(true);
    for (let b = 1; b <= 7; b++) { p[`type${b}`] = 1 + (b % 7); p[`freq${b}`] = 65536; p[`width${b}`] = 0; }
    const [z] = render(fx(p), noise);
    expect(z.every((v) => Number.isFinite(v))).toBe(true);
    expect(fx(p).tail).toBeGreaterThan(0);
  });

  it('clears a band state on a type change and stops a 0 dB peak after fs/5 samples (FL)', () => {
    // band 4 alone (the default 0 dB bands would ring out for fs/5 samples as well)
    const p0 = { ...defaultFxParams('peq'), level4: 1200, width4: 50000, type1: 0, type2: 0, type3: 0, type5: 0, type6: 0, type7: 0 } as Record<string, number>;
    const noise = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 1.7) * 0.3);
    const ctx = makeCtx({ sampleRate: 48000 });
    const go = (e: ReturnType<typeof fx>, x: Float32Array) => { const L = Float32Array.from(x), R = Float32Array.from(x); for (let i = 0; i < L.length; i += 128) e.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i), ctx); return L; };
    // type change: the band's state is cleared, so zero input gives exactly zero
    const a = fx(p0);
    go(a, noise);
    a.setParams({ ...p0, type4: 1 });
    expect(peak(go(a, new Float32Array(256)))).toBe(0);
    // 0 dB: the band keeps running (ringing with 0 dB coefficients) for 48000 / 5 samples, then is cleared
    const b = fx(p0);
    go(b, noise);
    b.setParams({ ...p0, level4: 0 });
    const tail = go(b, new Float32Array(9600 + 512));
    expect(peak(tail, 0, 256)).toBeGreaterThan(0);
    expect(peak(tail, 9600)).toBe(0);
  });
});
