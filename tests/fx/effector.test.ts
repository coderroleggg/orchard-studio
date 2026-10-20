import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { def as efDef, effectIndex, effectValue, rateIndex, rateValue } from '../../src/model/fx/plugins/effector';
import { makeCtx, render, rms, peak } from './util';

const SR = 44100;
const text = (key: string, v: number) => formatParam(efDef.params.find((p) => p.key === key)!, v);

function make(over: Record<string, unknown> = {}) {
  const fx = createEffect('effector', SR, 128);
  fx.setParams({ ...defaultFxParams('effector'), bypass: 0, ...over });
  fx.reset();
  return fx;
}
const kind = (k: number) => effectValue(k);

function impulse(fx: ReturnType<typeof make>, n = 8192, at = 100, ctx = {}) {
  const x = new Float32Array(n);
  x[at] = 0.5;
  const [L, R] = render(fx, x, x, 128, ctx);
  return [Float64Array.from(L.subarray(at), (v) => v / 0.5), Float64Array.from(R.subarray(at), (v) => v / 0.5)];
}

describe('Effector', () => {
  it('is registered with FL parameters and constructor defaults', () => {
    const d = fxDef('effector')!;
    expect(d.name).toBe('Effector');
    expect([d.width, d.height]).toEqual([430, 418]);
    expect(d.params.map((p) => p.name)).toEqual([
      'Effect kind', 'FX Bypass', 'Wet Mix', 'Param X', 'Param Y', 'Mod Rate', 'Tempo reduce',
      'Mod Amount X', 'Mod Amount Y', 'Mod shape', 'Input Level', 'Output Gain',
    ]);
    d.params.forEach((p, i) => { expect(p.index).toBe(i); expect(p.max).toBe(256); });
    const p = defaultFxParams('effector');
    expect(p.kind).toBe(244);
    expect(p.bypass).toBe(256);
    expect(p.rate).toBe(28);
  });

  it('shows FL value texts and maps the selectors like FL', () => {
    expect(text('kind', 244)).toBe('Vox');
    expect(text('kind', 11)).toBe('Distort');
    expect(text('kind', 12)).toBe('Lo-fi');
    expect(text('kind', 245)).toBe('Ring');
    expect(text('bypass', 1)).toBe('On');
    expect(text('mix', 256)).toBe('100.00%');
    expect(text('x', 128)).toBe('50.00%');
    expect(text('rate', 28)).toBe('1/4');
    expect(text('rate', 15)).toBe('1/8');
    expect(text('rate', 240)).toBe('8/1');
    expect(text('modX', 0)).toBe('-100.00%');
    expect(text('modX', 128)).toBe('0.00%');
    expect(text('shape', 64)).toBe('Saw');
    expect(text('shape', 192)).toBe('Square');
    expect(text('output', 0)).toBe('-24.00 dB');
    expect(text('output', 160)).toBe('6.00 dB');
    for (let k = 0; k < 12; k++) expect(effectIndex(effectValue(k))).toBe(k);
    for (let i = 0; i < 9; i++) expect(rateIndex(rateValue(i))).toBe(i);
  });

  it('passes the input untouched when bypassed and applies FL\'s gain laws', () => {
    const by = make({ bypass: 256, kind: kind(11) });
    const x = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) x[i] = Math.sin(i * 0.1) * 0.4;
    const [L] = render(by, x, x, 128);
    expect(peak(Float32Array.from(L, (v, i) => v - x[i]))).toBeLessThan(1e-7);
    // input level 128 -> gain 0.25 (FL: (v/256)^2), output 192 -> +12 dB, filter at the centre is flat
    const g = make({ kind: kind(4), x: 128, input: 128 });
    const n = SR / 2;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const [gl] = render(g, s, s, 128);
    expect(rms(gl, n / 2) / rms(s, n / 2)).toBeCloseTo(0.25, 2);
    const o = make({ kind: kind(4), x: 128, output: 192 });
    const [ol] = render(o, s, s, 128);
    expect(20 * Math.log10(rms(ol, n / 2) / rms(s, n / 2))).toBeCloseTo(12, 1);
  });

  it('LO-FI holds 1 + 127 X^3 samples and quantises with a Y^2/32 step', () => {
    const fx = make({ kind: kind(1), x: 128, y: 0 });
    const n = 20000;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR);
    const [L] = render(fx, s, s, 128);
    const runs: number[] = [];
    let c = 1;
    for (let i = 5001; i < 15000; i++) { if (L[i] === L[i - 1]) c++; else { runs.push(c); c = 1; } }
    expect(runs.reduce((a, b) => a + b, 0) / runs.length).toBeCloseTo(17, 0); // FL: 17
    const q = make({ kind: kind(1), x: 0, y: 256 });
    const [Q] = render(q, s, s, 128);
    for (let i = 5000; i < 5200; i++) expect(Math.abs(Q[i] / 0.03125 - Math.round(Q[i] / 0.03125))).toBeLessThan(1e-3);
  });

  it('FLANGER subtracts a copy delayed by 3 + 218 X^2 samples', () => {
    const [h] = impulse(make({ kind: kind(2), x: 128, y: 0 }));
    expect(h[0]).toBeCloseTo(1, 5);
    expect(h[57]).toBeCloseTo(-0.5, 3); // FL: 57 -> -0.5, 58 -> -0.5
    expect(h[58]).toBeCloseTo(-0.5, 3);
    const [h2] = impulse(make({ kind: kind(2), x: 256, y: 256 }));
    expect(h2[221]).toBeCloseTo(-1, 3);
    expect(h2[442]).toBeCloseTo(0.96, 2); // FL: 0.96
  });

  it('DELAY repeats at the Mod Rate with X^2 echo gain', () => {
    const [h] = impulse(make({ kind: kind(5), x: 256, y: 64 }), Math.round(0.5 * SR), 100, { tempo: 130 });
    const d = Math.round((60 / 130 / 4) * SR); // 1/4 beat = 0.1154 s
    const e = (k: number) => { let s = 0; for (let i = k * d - 300; i < k * d + 300; i++) s += h[i] * h[i]; return Math.sqrt(s); };
    expect(h[0]).toBeCloseTo(1, 5); // the dry signal is part of the effect
    expect(e(1)).toBeGreaterThan(0.5);
    expect(e(2) / e(1)).toBeGreaterThan(0.7);
    const [h0] = impulse(make({ kind: kind(5), x: 0, y: 128 }), Math.round(0.3 * SR), 100, { tempo: 130 });
    let late = 0;
    for (let i = 100; i < h0.length; i++) late = Math.max(late, Math.abs(h0[i]));
    expect(late).toBeLessThan(1e-6); // FL: no echoes at X = 0
  });

  it('STEREO pans by delaying the far channel and RING modulates at 32 * 415.6^X Hz', () => {
    const [l, r] = impulse(make({ kind: kind(7), x: 0, y: 0 }));
    expect(l[3]).toBeCloseTo(1, 5); // FL: 3 samples base delay
    expect(r[89]).toBeCloseTo(1, 5); // FL: right channel 86 samples later
    const [, r2] = impulse(make({ kind: kind(7), x: 0, y: 256 }));
    expect(peak(Float32Array.from(r2))).toBeLessThan(1e-6); // FL: far channel off at full binaural level
    // ring at X = 0.5: modulator 653 Hz -> a DC input becomes a 653 Hz sine
    const fx = make({ kind: kind(11), x: 128 });
    const n = SR;
    const dc = new Float32Array(n).fill(0.5);
    const [rl] = render(fx, dc, dc, 128);
    let zc = 0;
    for (let i = 1; i < n; i++) if ((rl[i] >= 0) !== (rl[i - 1] >= 0)) zc++;
    expect(zc / 2).toBeGreaterThan(645);
    expect(zc / 2).toBeLessThan(661);
  });

  it('TRANS drops to Y^2 at each LFO period', () => {
    const fx = make({ kind: kind(8), x: 0, y: 128, rate: 28 });
    const n = SR;
    const s = new Float32Array(n).fill(0.5);
    const [L] = render(fx, s, s, 128, { tempo: 130 });
    let mn = 1;
    for (let i = SR / 4; i < n; i++) mn = Math.min(mn, L[i]);
    expect(mn / 0.5).toBeCloseTo(0.25, 2); // FL: 0.13 / 0.5
  });

  it('keeps every effect finite and silent for silence, with the LFO at full depth', () => {
    for (let k = 0; k < 12; k++) {
      const extremes = [
        { kind: kind(k), x: 256, y: 256, modX: 256, modY: 0, tempo: 256, shape: 256, output: 256 },
        { kind: kind(k), x: 0, y: 0, modX: 0, modY: 256, rate: 240, shape: 128 },
      ];
      for (const over of extremes) {
        const fx = make(over);
        const n = SR;
        const x = new Float32Array(n);
        let seed = 3 + k;
        for (let i = 0; i < n / 2; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; x[i] = ((seed / 2 ** 32) * 2 - 1) * 0.9; }
        const [L, R] = render(fx, x, x, 128);
        let ok = true;
        for (let i = 0; i < n; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) ok = false;
        expect(ok).toBe(true);
        expect(peak(L)).toBeLessThan(1e4);
      }
      const q = make({ kind: kind(k) });
      const z = new Float32Array(SR / 4);
      const [zl] = render(q, z, z, 128);
      expect(peak(zl)).toBe(0);
    }
  });

  it('smooths X changes (no zipper steps on a filter sweep)', () => {
    const fx = make({ kind: kind(11), x: 0 });
    const s = new Float32Array(4096).fill(0.5);
    render(fx, s, s, 128);
    fx.setParams({ ...defaultFxParams('effector'), bypass: 0, kind: kind(11), x: 256 });
    const L = new Float32Array(128).fill(0.5), R = new Float32Array(128).fill(0.5);
    fx.process(L, R, 128, makeCtx());
    // the modulator frequency glides: the first block is still mostly low-frequency
    let zc = 0;
    for (let i = 1; i < 128; i++) if ((L[i] >= 0) !== (L[i - 1] >= 0)) zc++;
    expect(zc).toBeLessThan(40);
  });
});
