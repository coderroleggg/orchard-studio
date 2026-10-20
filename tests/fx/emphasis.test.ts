import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { emCeilingGain } from '../../src/model/fx/plugins/emphasis';
import { render, peak, rms } from './util';

const SR = 48000;
const LAT = 2592; // FL reports 2592 samples at 48 kHz (54 ms) for every oversampling factor

function make(p: Record<string, unknown> = {}) {
  const fx = createEffect('emphasis', SR, 128);
  fx.setParams({ ...defaultFxParams('emphasis'), ceiling: 10000, ...p });
  fx.reset();
  return fx;
}

function text(key: string, v: number): string {
  const d = fxDef('emphasis')!;
  return formatParam(d.params.find((q) => q.key === key)!, v);
}

function tone(freq: number, db: number, secs: number): Float32Array {
  const n = Math.round(secs * SR), a = Math.pow(10, db / 20), b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = a * Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}

/** THD (%) of the output after the latency, measured over whole periods from 0.6 s. */
function thd(out: Float32Array, freq: number): number {
  const P = SR / freq, a = LAT + Math.round(0.6 * SR), n = Math.floor(Math.floor(4800 / P) * P);
  let ss = 0, sc = 0;
  for (let i = 0; i < n; i++) { const ph = (2 * Math.PI * freq * (i + a - LAT)) / SR; ss += out[a + i] * Math.sin(ph); sc += out[a + i] * Math.cos(ph); }
  const A = (2 * ss) / n, B = (2 * sc) / n;
  let res = 0, fund = 0;
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * freq * (i + a - LAT)) / SR, f = A * Math.sin(ph) + B * Math.cos(ph);
    res += (out[a + i] - f) ** 2; fund += f * f;
  }
  return 100 * Math.sqrt(res / fund);
}

describe('Emphasis', () => {
  it('is registered with FL ranges, defaults, value texts and presets', () => {
    const d = fxDef('emphasis')!;
    expect(d.width).toBe(740);
    expect(d.height).toBe(366);
    expect(d.params.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 26, 27]);
    expect(defaultFxParams('emphasis')).toMatchObject({ mode: 0, inputGain: 0, linking: 10000, emphasis: 10000, ceiling: 9912, oversampling: 2, hardness: 7, envOrder: 1 });
    // texts read from FL's plugin
    expect(text('ceiling', 0)).toBe('-Inf dB');
    expect(text('ceiling', 1)).toBe('-92.4 dB');
    expect(text('ceiling', 5000)).toBe('-12.7 dB');
    expect(text('ceiling', 9912)).toBe('-0.2 dB');
    expect(text('inputGain', 6979)).toBe('16.7 dB');
    expect(text('inputGain', 10000)).toBe('24.0 dB');
    expect(text('linking', 150)).toBe('1%');
    expect(text('emphasis', 9970)).toBe('100%');
    expect(text('mode', 2)).toBe('Transient');
    expect(text('oversampling', 4)).toBe('16x');
    expect(d.presets?.length).toBe(21);
    expect(d.presets?.find((p) => p.name === 'Hard-clipper')?.params).toMatchObject({ mode: 3, hardness: 9 });
  });

  it('reports FL\'s 54 ms latency for every oversampling factor and bypasses exactly', () => {
    for (const os of [0, 2, 4]) expect(make({ oversampling: os }).latency).toBe(LAT);
    const x = tone(440, -6, 0.3);
    const [L] = render(make({ bypass: 1 }), x);
    for (let i = LAT; i < x.length; i += 37) expect(L[i]).toBeCloseTo(x[i - LAT], 6);
  });

  it('passes signals below the ceiling unchanged (delayed)', () => {
    const x = tone(1000, -20, 0.4);
    const [L] = render(make({ oversampling: 0 }), x);
    let err = 0;
    for (let i = LAT + 2000; i < x.length; i++) err = Math.max(err, Math.abs(L[i] - x[i - LAT]));
    expect(err).toBeLessThan(1e-6);
    const [L4] = render(make({ oversampling: 2 }), x);
    expect(20 * Math.log10(rms(L4, LAT + 2000) / rms(x, 2000, x.length - LAT))).toBeCloseTo(0, 1);
  });

  it('holds the ceiling (sample peaks, and true peaks with True peak on)', () => {
    let s = 7;
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; x[i] = (s / 2147483647 - 0.5) * 2 * (1 + 3 * (i % 9000 < 300 ? 1 : 0)); }
    for (const p of [{ hardness: 0 }, { hardness: 7 }, { hardness: 9, mode: 3 }, { inputGain: 10000, oversampling: 4 }]) {
      const [L, R] = render(make(p), x);
      expect(Math.max(peak(L), peak(R))).toBeLessThanOrEqual(1.0000001);
    }
    const [L] = render(make({ ceiling: 5000, inputGain: 5000 }), x);
    expect(peak(L)).toBeLessThanOrEqual(emCeilingGain(5000) * 1.000001);
    // true peak: 4x-interpolated output stays within the ceiling (+0.2 dB interpolation slack)
    const [T] = render(make({ truePeak: 1, inputGain: 5000 }), tone(11000, -1, 0.5));
    let tp = 0;
    for (let i = 4; i < T.length - 4; i++) {
      for (const f of [0.25, 0.5, 0.75]) {
        let acc = 0;
        for (let k = -3; k <= 4; k++) { const t = k - f; const sinc = Math.sin(Math.PI * t) / (Math.PI * t); acc += T[i + k] * sinc * (0.5 + 0.5 * Math.cos((Math.PI * t) / 4.5)); }
        tp = Math.max(tp, Math.abs(acc));
      }
    }
    expect(20 * Math.log10(tp)).toBeLessThan(0.25);
  });

  it('shapes like FL by hardness (THD of a 200 Hz tone 6 dB over the ceiling, Steady mode)', () => {
    // FL: hardness 0 -> 0.0 %, 5 -> 4.7 %, 7 -> 17.9 %, 9 -> 21.0 %
    const x = tone(200, 6, 1.2);
    const ref: [number, number, number][] = [[0, 0, 0.3], [5, 4.7, 3], [7, 17.9, 3], [9, 21.0, 3]];
    for (const [h, want, tol] of ref) {
      const [L] = render(make({ mode: 3, hardness: h, oversampling: 0 }), x);
      expect(Math.abs(thd(L, 200) - want)).toBeLessThan(tol);
    }
  });

  it('keeps bass clean in Versatile mode and lets Emphasis set the shaping share', () => {
    const x = tone(50, 6, 1.2);
    // FL: Versatile 0.0 %, Steady 22.1 % at 50 Hz
    expect(thd(render(make({ mode: 0, oversampling: 0 }), x)[0], 50)).toBeLessThan(1.5);
    expect(thd(render(make({ mode: 3, oversampling: 0 }), x)[0], 50)).toBeGreaterThan(15);
    const y = tone(200, 6, 1.2);
    // FL, Steady 200 Hz: emphasis 0 -> 0.0 %, 50 -> 14.5 %
    expect(thd(render(make({ mode: 3, emphasis: 0, oversampling: 0 }), y)[0], 200)).toBeLessThan(0.5);
    expect(Math.abs(thd(render(make({ mode: 3, emphasis: 5000, oversampling: 0 }), y)[0], 200) - 14.5)).toBeLessThan(3);
  });

  it('pre-ducks ahead of a transient at hardness 0 (look-ahead), like FL', () => {
    // FL, +12 dB step at 6 kHz: -2.54 dB 10 ms before the step, -12 dB at the step, -12.47 dB 2 ms after
    const n = Math.round(1.5 * SR), x = new Float32Array(n), on = SR;
    for (let i = 0; i < n; i++) x[i] = (i < on ? 0.1 : 3.98) * Math.sin((2 * Math.PI * 6000 * i) / SR);
    const [L] = render(make({ hardness: 0, oversampling: 0 }), x);
    const gainAt = (ms: number) => {
      const i = on + Math.round((ms * SR) / 1000);
      let pi = 0, po = 0;
      for (let k = i; k < i + 8; k++) { pi = Math.max(pi, Math.abs(x[k])); po = Math.max(po, Math.abs(L[k + LAT])); }
      return 20 * Math.log10(po / pi);
    };
    expect(gainAt(-30)).toBeGreaterThan(-0.1);
    expect(gainAt(-10)).toBeLessThan(-0.8);
    expect(gainAt(-10)).toBeGreaterThan(-4);
    expect(gainAt(2)).toBeCloseTo(-12.47, 0);
  });

  it('scales the output by the ceiling, matches levels and plays the delta like FL', () => {
    const x = tone(1000, -6, 2.0);
    const seg = (b: Float32Array) => rms(b, Math.round(1.5 * SR), Math.round(1.9 * SR));
    // ceiling 5000 = -12.7 dB on an unlimited signal (FL: -18.71 dB peak for a -6 dB sine)
    const [c] = render(make({ ceiling: 5000 }), x);
    expect(20 * Math.log10(peak(c, SR) )).toBeCloseTo(-18.71, 1);
    // +12 dB input gain limited, level matching brings the RMS back to the input's (FL: -6.02 dB peak)
    const [m] = render(make({ inputGain: 5000, levelMatch: 1 }), x);
    expect(20 * Math.log10(seg(m) / rms(x))).toBeCloseTo(0, 0);
    // delta without level matching: residual scaled back by the input gain (FL: -12.05 dB peak)
    const [d] = render(make({ inputGain: 5000, delta: 1 }), x);
    expect(20 * Math.log10(peak(d, Math.round(1.5 * SR), Math.round(1.9 * SR)))).toBeCloseTo(-12.05, 0);
  });

  it('switches to the low-latency timing from the Options menu state', () => {
    const fx = make({ lowLatency: true });
    expect(fx.latency).toBe(576);
    const x = tone(300, 6, 0.5);
    const [L] = render(fx, x);
    expect(peak(L)).toBeLessThanOrEqual(1.0000001);
  });

  it('stays silent on silence and finite at extreme settings, with display data', () => {
    const [Z] = render(make({ inputGain: 10000 }), new Float32Array(SR / 4));
    expect(peak(Z)).toBe(0);
    const big = new Float32Array(SR / 2).map((_, i) => (i % 100 < 50 ? 1e4 : -1e4));
    for (const p of [{ inputGain: 10000, hardness: 9, oversampling: 4, truePeak: 1 }, { mode: 2, emphasis: 0, channelMode: 1, linking: 0, dcBlock: 1, instantRecovery: 1 }]) {
      const fx = make(p);
      const [A, B] = render(fx, big);
      for (let i = 0; i < A.length; i++) if (!Number.isFinite(A[i]) || !Number.isFinite(B[i])) throw new Error('non-finite');
      expect(Math.max(peak(A), peak(B))).toBeLessThanOrEqual(1.0000001);
      const m = fx.monitor!()!;
      expect(Array.isArray(m.hPk)).toBe(true);
      expect(Number(m.grHard)).toBeLessThan(1);
    }
  });
});
