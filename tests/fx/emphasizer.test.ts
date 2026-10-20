import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { ezClip } from '../../src/engine/effects/plugins/emphasizer';
import { render, peak, rms } from './util';

const SR = 48000;
const LAT = 96; // FL: 2 ms (88 @ 44.1 kHz, 96 @ 48 kHz, 192 @ 96 kHz)

function make(p: Record<string, unknown> = {}) {
  const fx = createEffect('emphasizer', SR, 128);
  fx.setParams({ ...defaultFxParams('emphasizer'), ...p });
  fx.reset();
  return fx;
}

function text(key: string, v: number): string {
  const d = fxDef('emphasizer')!;
  return formatParam(d.params.find((q) => q.key === key)!, v);
}

function tone(freq: number, db: number, secs: number, start = 0): Float32Array {
  const n = Math.round(secs * SR), a = Math.pow(10, db / 20), b = new Float32Array(n);
  for (let i = Math.round(start * SR); i < n; i++) b[i] = a * Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}

function thd(out: Float32Array, freq: number, from: number): number {
  const P = SR / freq, a = Math.round(from * SR), n = Math.floor(Math.floor(4800 / P) * P);
  let ss = 0, sc = 0;
  for (let i = 0; i < n; i++) { const ph = (2 * Math.PI * freq * (i + a - LAT)) / SR; ss += out[a + i] * Math.sin(ph); sc += out[a + i] * Math.cos(ph); }
  const A = (2 * ss) / n, B = (2 * sc) / n;
  let res = 0, fund = 0;
  for (let i = 0; i < n; i++) { const ph = (2 * Math.PI * freq * (i + a - LAT)) / SR, f = A * Math.sin(ph) + B * Math.cos(ph); res += (out[a + i] - f) ** 2; fund += f * f; }
  return 100 * Math.sqrt(res / fund);
}

/** Stage-1 gain (dB) read from a quiet 3 kHz carrier on R while L carries the loud tone (stage 1 is linked). */
function stage1Gain(p: Record<string, unknown>, lv: number, secs: number, at: number[]): number[] {
  const n = Math.round(secs * SR), Lb = new Float32Array(n), Rb = new Float32Array(n);
  const a = Math.pow(10, lv / 20), c = Math.pow(10, -30 / 20);
  for (let i = 0; i < n; i++) { Lb[i] = i > SR / 2 ? a * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0; Rb[i] = c * Math.sin((2 * Math.PI * 3000 * i) / SR); }
  const [, R] = render(make(p), Lb, Rb);
  return at.map((s) => { const i = Math.round(s * SR); return 20 * Math.log10(rms(R, i + LAT, i + LAT + 480) / rms(Rb, i, i + 480)); });
}

describe('Emphasizer', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('emphasizer')!;
    expect(d.width).toBe(580);
    expect(d.height).toBe(120);
    expect(defaultFxParams('emphasizer')).toMatchObject({ inputGain: 0, emphasis: 5013, clipping: 0, levelMatch: 0, bypass: 0, outputGain: 10000 });
    expect(text('inputGain', 6979)).toBe('16.7 dB');
    expect(text('emphasis', 5013)).toBe('50%');
    expect(text('clipping', 1)).toBe('Soft');
    expect(text('outputGain', 0)).toBe('-Inf dB');
    expect(text('outputGain', 5000)).toBe('-12.7 dB');
    expect(make().latency).toBe(LAT);
  });

  it('passes quiet signals unchanged with FL\'s 2 ms delay and bypasses exactly', () => {
    const x = tone(1000, -12, 0.3);
    const [L] = render(make(), x);
    for (let i = LAT; i < x.length; i += 23) expect(L[i]).toBeCloseTo(x[i - LAT], 6);
    const y = tone(500, 6, 0.3);
    const [B] = render(make({ bypass: 1 }), y);
    for (let i = LAT; i < y.length; i += 23) expect(B[i]).toBeCloseTo(y[i - LAT], 6);
  });

  it('clips like FL: hard at 0 dBFS, soft from 0.86 toward 1', () => {
    expect(ezClip(1.5, false)).toBe(1);
    expect(ezClip(0.5, true)).toBe(0.5);
    expect(ezClip(0.96, true)).toBeCloseTo(0.9396, 2); // FL 0.9396
    expect(ezClip(1.26, true)).toBeCloseTo(0.9898, 2); // FL 0.9898
    expect(ezClip(-2.98, true)).toBeCloseTo(-0.9995, 3);
  });

  it('matches FL\'s distortion vs Emphasis (200 Hz tone, 0.6 s in)', () => {
    // FL, hard: 0 % -> 0.0, 50 % -> 5.6 (any level), 100 % at +6 dB -> 23.2; soft 0 % -> 1.5
    const x6 = tone(200, 6, 1.0), x3 = tone(200, 3, 1.0);
    expect(thd(render(make({ emphasis: 0 }), x6)[0], 200, 0.6)).toBeLessThan(0.2);
    expect(Math.abs(thd(render(make({ emphasis: 5000 }), x3)[0], 200, 0.6) - 5.6)).toBeLessThan(1);
    expect(thd(render(make({ emphasis: 10000 }), x6)[0], 200, 0.6)).toBeCloseTo(23.2, 0);
    expect(thd(render(make({ emphasis: 0, clipping: 1 }), x6)[0], 200, 0.6)).toBeCloseTo(1.5, 0);
  });

  it('lets stage 1 take over sustained reduction like FL (dead time, then a slow approach)', () => {
    // FL, +12 dB tone: 50 % -> -0.2 / -4.6 / -10.6 / -10.9 dB at 50 ms / 100 ms / 0.5 s / 2 s; 100 % -> -6.07 dB at 3 s
    const g = stage1Gain({ emphasis: 5000 }, 12, 3.0, [0.55, 0.6, 1.0, 2.5]);
    expect(g[0]).toBeGreaterThan(-1);
    expect(g[1]).toBeCloseTo(-4.6, -0.3);
    expect(g[2]).toBeCloseTo(-10.6, 0);
    expect(g[3]).toBeCloseTo(-10.94, 0);
    const h = stage1Gain({ emphasis: 10000 }, 12, 4.0, [3.6]);
    expect(h[0]).toBeCloseTo(-6.07, 0);
    // 0 % = look-ahead limiter to -0.1 dBFS: full reduction from the start
    const z = stage1Gain({ emphasis: 0 }, 12, 1.0, [0.502, 0.8]);
    expect(z[0]).toBeCloseTo(-12.1, 0);
    expect(z[1]).toBeCloseTo(-12.1, 0);
  });

  it('recovers like FL after the signal stops (20 ms hold, fast, then ~20 dB/s)', () => {
    // FL at 0 %: -12.10 / -6.74 / -2.81 dB at 15 / 100 / 300 ms after a +12 dB burst
    const n = Math.round(2 * SR), Lb = new Float32Array(n), Rb = new Float32Array(n);
    for (let i = 0; i < n; i++) { Lb[i] = i >= SR / 2 && i < SR ? 3.98 * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0; Rb[i] = 0.03 * Math.sin((2 * Math.PI * 3000 * i) / SR); }
    const [, R] = render(make({ emphasis: 0 }), Lb, Rb);
    const gAt = (ms: number) => { const i = SR + Math.round((ms * SR) / 1000); return 20 * Math.log10(rms(R, i + LAT, i + LAT + 480) / rms(Rb, i, i + 480)); };
    expect(gAt(15)).toBeCloseTo(-12.1, 0);
    expect(gAt(100)).toBeCloseTo(-6.74, 0);
    expect(gAt(300)).toBeCloseTo(-2.81, 0);
  });

  it('applies output attenuation and level matching (inverse input gain)', () => {
    const x = tone(1000, -20, 0.5);
    const [o] = render(make({ outputGain: 5000 }), x);
    expect(20 * Math.log10(rms(o, LAT + 4800) / rms(x, 4800))).toBeCloseTo(-12.7, 1);
    const [m] = render(make({ inputGain: 2500, levelMatch: 1 }), x);
    expect(20 * Math.log10(rms(m, LAT + 4800) / rms(x, 4800))).toBeCloseTo(0, 1);
  });

  it('never exceeds 0 dBFS, stays finite and silent on silence', () => {
    const big = new Float32Array(SR).map((_, i) => Math.sin(i * 0.05) * (i % 7000 < 200 ? 100 : 3));
    for (const p of [{ inputGain: 10000, emphasis: 0 }, { inputGain: 10000, emphasis: 10000, clipping: 1 }, { inputGain: 5000, emphasis: 2500 }]) {
      const fx = make(p);
      const [L, R] = render(fx, big);
      for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error('non-finite');
      expect(Math.max(peak(L), peak(R))).toBeLessThanOrEqual(1);
      const m = fx.monitor!()!;
      expect(Number(m.gr)).toBeGreaterThan(0);
    }
    const [Z] = render(make({ inputGain: 10000 }), new Float32Array(SR / 4));
    expect(peak(Z)).toBe(0);
  });
});
