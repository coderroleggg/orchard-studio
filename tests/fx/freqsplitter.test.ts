import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { fsBandMags, fsFreqHz, fsGain } from '../../src/model/fx/plugins/freqsplitter';
import { makeCtx, render, rms, sine, peak } from './util';

const base = () => defaultFxParams('freqsplitter') as Record<string, unknown>;

function impulse(p: Record<string, unknown>, n = 6, len = 4096): Float32Array {
  const fx = createEffect('freqsplitter', 48000, 128);
  fx.setParams({ ...base(), ...p });
  fx.reset();
  const x = new Float32Array(len); x[0] = 1;
  return render(fx, x)[0].slice(0, n);
}

describe('Frequency Splitter', () => {
  it('is registered with FL parameters, texts and presets', () => {
    const d = fxDef('freqsplitter')!;
    expect(d.name).toBe('Frequency Splitter');
    expect([d.width, d.height]).toEqual([770, 340]);
    expect(d.params.filter((p) => p.index !== undefined).length).toBe(14);
    const t = (k: string, v: number) => formatParam(fxParamDef('freqsplitter', k)!, v);
    // FL's value texts (test host sweeps)
    expect(t('f1', 0)).toBe('30.0 Hz');
    expect(t('f1', 19800)).toBe('200.0 Hz');
    expect(t('f1', 32768)).toBe('692.8 Hz');
    expect(t('f2', 65536)).toBe('16000.0 Hz');
    expect(t('s1', 4)).toBe('36 dB');
    expect(t('quality', 2)).toBe('Medium');
    expect(t('speed', 45820)).toBe('50.0 ms');
    expect(t('speed', 0)).toBe('2.0 ms');
    expect(t('mLow', -1800)).toBe('-inf');
    expect(t('mLow', -1350)).toBe('-12.0 dB');
    expect(t('mLow', 450)).toBe('8.7 dB');
    expect(t('mLow', 1800)).toBe('18.0 dB');
    expect(t('sMid', 2)).toBe('0.1 dB');
    expect(d.presets!.length).toBe(9);
    expect((d.presets!.find((p) => p.name === 'Isolate below 200Hz')!.params.fs as { mainOn: number[] }).mainOn).toEqual([1, 0, 0]);
    expect(fsFreqHz(48065)).toBeCloseTo(3000.13, 1);
    expect(fsGain(-900)).toBeCloseTo(0.5, 9);
  });

  it('matches FL impulse responses (normal mode, 48 kHz)', () => {
    [0.553144, -0.637881, -0.21712, 0.040994, 0.175166, 0.222455].forEach((v, i) => expect(impulse({})[i]).toBeCloseTo(v, 3));
    [0.012921, 0.025508, 0.024849, 0.024207, 0.023581, 0.022972].forEach((v, i) => expect(impulse({ bands: 0, s1: 0, mHigh: -1800 })[i]).toBeCloseTo(v, 5));
    [3.109224, -3.62019, -1.318666, 0.025626, 0.65655, 0.816683].forEach((v, i) => expect(impulse({ mLow: 600, mMid: -700, mHigh: 1200 })[i]).toBeCloseTo(v, 3));
  });

  it('bands split at -6 dB and sum flat (LR / Butterworth crossovers)', () => {
    for (const s of [0, 1, 2, 3, 5, 6, 7]) {
      const [l, m, h] = fsBandMags({ s1: s, s2: 3 }, 200);
      expect(20 * Math.log10(l)).toBeCloseTo(s === 0 || s === 2 ? -3.01 : -6.02, 1);
      void m; void h;
    }
    const gainAt = (p: Record<string, unknown>, f: number) => {
      const fx = createEffect('freqsplitter', 48000, 128);
      fx.setParams({ ...base(), ...p });
      fx.reset();
      return rms(render(fx, sine(f, 0.6, 0.1))[0], 14400) / (0.1 / Math.SQRT2);
    };
    for (const f of [60, 200, 1000, 3000, 9000]) expect(gainAt({}, f)).toBeCloseTo(1, 2);
    expect(gainAt({ mMid: -1800, mHigh: -1800 }, 50)).toBeCloseTo(1, 2);
    expect(gainAt({ mMid: -1800, mHigh: -1800 }, 2000)).toBeLessThan(0.001);
  });

  it('smooths level changes with a 2.2 ms one pole (measured: 0.99045 per sample at 48 kHz)', () => {
    const fx = createEffect('freqsplitter', 48000, 128);
    fx.setParams({ ...base(), mMid: -1800, mHigh: -1800 });
    fx.reset();
    const dc = new Float32Array(48000).fill(0.5);
    render(fx, dc);
    fx.setParams({ ...base(), mLow: -900, mMid: -1800, mHigh: -1800 });
    const L = new Float32Array(128).fill(0.5), R = new Float32Array(128).fill(0.5);
    fx.process(L, R, 128, makeCtx());
    const d0 = L[10] / 0.5 - 0.5, d1 = L[11] / 0.5 - 0.5;
    expect(d1 / d0).toBeCloseTo(0.99045, 4);
  });

  it('sends bands to their target tracks', () => {
    const fx = createEffect('freqsplitter', 48000, 128);
    fx.setParams({ ...base(), fs: { mainOn: [1, 1, 1], sendOn: [1, 1, 1], mainSolo: -1, sendSolo: -1, sendTarget: [3, -1, 5] } });
    fx.reset();
    expect(fx.sendTargets!()).toEqual([3, 5]);
    const got: Record<number, number> = {};
    const ctx = makeCtx({ sendTo: (t, l, _r, n) => { let s = 0; for (let i = 0; i < n; i++) s += l[i] * l[i]; got[t] = (got[t] ?? 0) + s; } });
    const lo = sine(60, 0.32);
    for (let i = 0; i + 128 <= lo.length; i += 128) fx.process(lo.slice(i, i + 128), lo.slice(i, i + 128), 128, ctx);
    expect(got[3]).toBeGreaterThan(100 * (got[5] ?? 0));
  });

  it('linear phase mode is delay-compensated, zero phase and amplitude complementary', () => {
    const fx = createEffect('freqsplitter', 48000, 128);
    fx.setParams({ ...base(), lin: 1 });
    fx.reset();
    expect(fx.latency).toBe(2048);
    const x = new Float32Array(8192); x[100] = 1;
    const y = render(fx, x)[0];
    let pk = 0; for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[pk])) pk = i;
    expect(pk).toBe(100 + 2048);
    expect(y[pk]).toBeCloseTo(1, 3);
    // FL's FFT band shape: 1 - r^k / 2 below the split
    const [l] = fsBandMags({ lin: 1, s1: 3 }, 100);
    expect(20 * Math.log10(l)).toBeCloseTo(-0.28, 1);
  });

  it('stays finite and silent', () => {
    for (const lin of [0, 1]) {
      const fx = createEffect('freqsplitter', 48000, 128);
      fx.setParams({ ...base(), lin, s1: 7, s2: 7, f1: 0, f2: 65536, mLow: 1800 });
      fx.reset();
      expect(Number.isFinite(rms(render(fx, sine(40, 0.5, 1))[0]))).toBe(true);
      expect(peak(render(fx, new Float32Array(48000))[0], 47000)).toBeLessThan(1e-4);
    }
  });
});
