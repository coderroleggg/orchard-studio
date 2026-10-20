import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import type { FxContext } from '../../src/engine/effects/types';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { def as txDef, levelDb, levelFromDb } from '../../src/model/fx/plugins/transmitter';
import { bounceTapTime, satCurve } from '../../src/engine/effects/plugins/transmitter';
import { makeCtx, render, rms, peak } from './util';

const SR = 44100;

function make(over: Record<string, unknown> = {}, sr = SR) {
  const fx = createEffect('transmitter', sr, 128);
  fx.setParams({ ...defaultFxParams('transmitter'), ...over });
  fx.reset();
  return fx;
}

/** Both effects off, sustain muted to -120 dB: the output is the transient part T * x. */
const T_ONLY = { tFx: 5, sFx: 5, sLevel: 0, lookahead: 0 };
const text = (key: string, v: number) => formatParam(txDef.params.find((p) => p.key === key)!, v);

describe('Transmitter', () => {
  it('is registered with FL parameters, factory defaults and presets', () => {
    const d = fxDef('transmitter')!;
    expect(d.name).toBe('Transmitter');
    expect(d.category).toBe('Misc');
    expect([d.width, d.height]).toEqual([740, 366]);
    // FL's 33 automatable parameters + the 9 switches (Tags 33..41)
    expect(d.params.length).toBe(42);
    expect(d.params.filter((p) => !p.noAuto).length).toBe(33);
    d.params.forEach((p, i) => expect(p.index).toBe(i));
    const p = defaultFxParams('transmitter');
    // FL's factory "Default" preset (applied on insert)
    expect(p.sens).toBe(7475);
    expect(p.tLevel).toBe(8743);
    expect(p.tFx).toBe(0);
    expect(p.sFx).toBe(2);
    expect(p.lookahead).toBe(1);
    expect(d.presets?.length).toBe(34);
    expect(d.presets?.find((q) => q.name === 'Transient only')?.params.sOn).toBe(0);
    expect(d.outputs).toEqual(['TSS Envelope']);
  });

  it('shows FL value texts', () => {
    // read from FL's plugin (flfxhost sweep)
    expect(text('sens', 2450)).toBe('0.25');
    expect(text('sens', 3150)).toBe('0.31');
    expect(text('hold', 1968)).toBe('50.0 ms');
    expect(text('hold', 3500)).toBe('88.1 ms');
    expect(text('tLevel', 0)).toBe('-120.0');
    expect(text('tLevel', 8742)).toBe('0.0');
    expect(text('tLevel', 6400)).toBe('-9.0');
    expect(text('tLevel', 12800)).toBe('12.0');
    expect(text('tTilt', 875)).toBe('-5.0');
    expect(text('tTilt', 4999)).toBe('0.0');
    expect(text('tDiffDepth', 10000)).toBe('0.99');
    expect(text('tDiffDelay', 0)).toBe('0.10 s');
    expect(text('tDiffDelay', 10000)).toBe('10.00 s');
    expect(text('tSatDrive', 3333)).toBe('6.0');
    expect(text('tBncAmp', 1750)).toBe('-0.7');
    expect(text('tDlyTime', 2225)).toBe('0.100 s');
    expect(text('tDlySync', 193)).toBe('4:1');
    expect(text('tDlySync', 768)).toBe('16:0');
    expect(levelFromDb(0)).toBe(8743);
    expect(levelDb(8743)).toBeCloseTo(0, 2);
  });

  it('reconstructs the input exactly when both parts are untouched', () => {
    const fx = make({ tFx: 5, sFx: 5, lookahead: 0 });
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (i % 9000 < 4000 ? 0.5 : 0.05) * Math.sin(i * 0.05) + (i % 3000 === 0 ? 0.8 : 0);
    const [L] = render(fx, x, x, 128);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(L[i] - x[i]));
    expect(err).toBeLessThan(4e-4); // FL: 7.4e-5 at 0.5 peak (level 8743 is +0.0011 dB)
  });

  it('splits a step into a transient that holds, then releases with FL timing', () => {
    // FL, hold = release = 50 ms (raw 1968): T crosses 0.99 / 0.5 / 0.1 at 52.9 / 62.8 / 73.2 ms
    const fx = make({ ...T_ONLY, hold: 1968, release: 1968 });
    const n = Math.round(0.4 * SR), i0 = Math.round(0.1 * SR);
    const x = new Float32Array(n);
    for (let i = i0; i < n; i++) x[i] = 0.5;
    const [L] = render(fx, x, x, 128);
    expect(L[i0] / 0.5).toBeCloseTo(1, 3); // zero latency: the first sample is already transient
    const cross = (th: number) => { for (let i = i0; i < n; i++) if (L[i] / 0.5 < th) return ((i - i0) / SR) * 1000; return Infinity; };
    expect(cross(0.99)).toBeGreaterThan(52.4);
    expect(cross(0.99)).toBeLessThan(53.4);
    expect(cross(0.5)).toBeGreaterThan(62.3);
    expect(cross(0.5)).toBeLessThan(63.3);
    expect(cross(0.1)).toBeGreaterThan(72.7);
    expect(cross(0.1)).toBeLessThan(73.7);
  });

  it('keeps the parts complementary (transient + sustain = input)', () => {
    const a = make({ ...T_ONLY });
    const b = make({ tFx: 5, sFx: 5, tLevel: 0, lookahead: 0 });
    const n = 20000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (i > 3000 ? 0.6 : 0) * Math.sin(i * 0.03) * (i > 9000 && i < 9100 ? 3 : 1);
    const [t] = render(a, x, x, 128);
    const [s] = render(b, x, x, 128);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(t[i] + s[i] - x[i]));
    expect(err).toBeLessThan(2e-3);
  });

  it('reports 2 ms of latency with Lookahead and ramps the transient in before the onset', () => {
    expect(make({ lookahead: 1 }).latency).toBe(88); // FL: 88 samples at 44.1 kHz
    expect(make({ lookahead: 1 }, 48000).latency).toBe(96);
    expect(make({ lookahead: 0 }).latency).toBe(0);
    const fx = make({ ...T_ONLY, lookahead: 1 });
    const n = 9000, i0 = 4000;
    const x = new Float32Array(n).fill(0);
    for (let i = i0; i < n; i++) x[i] = 0.5;
    const [L] = render(fx, x, x, 128);
    // the delayed onset arrives at i0 + 88 with the envelope already fully open (FL: 0.9999)
    expect(L[i0 + 88] / 0.5).toBeGreaterThan(0.999);
    expect(L[i0 + 87]).toBe(0);
  });

  it('matches FL\'s tilt filter', () => {
    // FL impulse response h[0] of the sustain path: tilt -6 dB -> 0.5528, +6 dB -> 1.8085
    for (const [tilt, h0] of [[0, 0.5528], [10000, 1.8085], [5000, 1]] as const) {
      const fx = make({ sens: 0, tLevel: 0, tFx: 5, sFx: 5, sTilt: tilt, lookahead: 0 });
      const x = new Float32Array(4096);
      x[100] = 0.05;
      const [L] = render(fx, x, x, 128);
      expect(L[100] / 0.05).toBeCloseTo(h0, 2);
    }
  });

  it('saturates with tanh up to FL\'s 0.9763 ceiling', () => {
    expect(satCurve(0.5)).toBeCloseTo(Math.tanh(0.5), 6);
    expect(satCurve(2.0)).toBeCloseTo(0.95664, 3);
    expect(satCurve(-10)).toBeCloseTo(-0.9763, 4);
    // drive 18 dB on a loud tone: the output peak sits at FL's ceiling
    const fx = make({ sens: 0, tLevel: 0, tFx: 5, sFx: 0, sSatMix: 10000, sSatDrive: 10000, sSatWarmth: 0, sTilt: 5000, lookahead: 0 });
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.min(1, i / 4410) * Math.sin((2 * Math.PI * 300 * i) / SR);
    const [L] = render(fx, x, x, 128);
    expect(peak(L, SR / 2)).toBeCloseTo(0.9763, 3);
  });

  it('places bounce taps exactly like FL (64 ping-pong taps over 2 s)', () => {
    // FL, delay curve 0.5: first left taps at 6673, 18553, first right taps at 12845, 23832
    expect(Math.floor(bounceTapTime(1, 0.5) * SR)).toBe(6673);
    expect(Math.floor(bounceTapTime(2, 0.5) * SR)).toBe(12845);
    expect(Math.floor(bounceTapTime(3, 0.5) * SR)).toBe(18553);
    expect(bounceTapTime(64, 0.5)).toBeCloseTo(2, 6);
    const fx = make({ sens: 0, tLevel: 0, tFx: 5, sFx: 1, sBncMix: 10000, sBncAmp: 7500, sBncTime: 7500, lookahead: 0 });
    const n = Math.round(2.2 * SR);
    const x = new Float32Array(n);
    x[0] = 0.05;
    const [L, R] = render(fx, x, x, 128);
    expect(L[6673] / 0.05).toBeCloseTo(0.525, 2); // FL: 0.525
    expect(R[12845] / 0.05).toBeCloseTo(0.525, 2);
    expect(Math.abs(R[6673])).toBeLessThan(1e-6);
  });

  it('echoes at the delay time with feedback', () => {
    // FL: delay raw 2225 = 0.100 s, feedback 0.5: echo energies 0.607, 0.257, 0.116 ...
    const fx = make({ sens: 0, tLevel: 0, tFx: 5, sFx: 4, sDlyMix: 10000, sDlyTime: 2225, sDlyFb: 5000, lookahead: 0 });
    const n = Math.round(0.6 * SR);
    const x = new Float32Array(n);
    x[100] = 0.05;
    const [L] = render(fx, x, x, 128);
    const e = (k: number) => { const c = 100 + Math.round(k * 0.09996 * SR); let s = 0; for (let i = c - 200; i < c + 200; i++) s += (L[i] / 0.05) ** 2; return Math.sqrt(s); };
    expect(e(1)).toBeGreaterThan(0.55);
    expect(e(1)).toBeLessThan(0.66);
    expect(e(2) / e(1)).toBeGreaterThan(0.38);
    expect(e(2) / e(1)).toBeLessThan(0.47);
  });

  it('sends a part to another mixer track and uses a sidechain input for detection', () => {
    const fx = make({ ...T_ONLY, tOut: 3 });
    expect(fx.sendTargets?.()).toEqual([3]);
    let sent = 0;
    const ctx: Partial<FxContext> = { sendTo: (t, L, _R, n) => { if (t === 3) for (let i = 0; i < n; i++) sent += Math.abs(L[i]); } };
    const x = new Float32Array(4096);
    for (let i = 1000; i < 4096; i++) x[i] = 0.5;
    render(fx, x, x, 128, ctx);
    expect(sent).toBeGreaterThan(10);
    // detection from sidechain input 1: a step on the sidechain opens the transient part of a steady tone
    const sc = make({ ...T_ONLY, scIn: 1, hold: 0, release: 0 });
    const n = 8192;
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.3;
    const scL = new Float32Array(128), scR = new Float32Array(128);
    const L = Float32Array.from(tone), R = Float32Array.from(tone);
    const c = makeCtx({ sidechain: [{ source: 2, L: scL, R: scR }] });
    let opened = -1;
    for (let b = 0; b < n; b += 128) {
      for (let i = 0; i < 128; i++) { const v = b + i >= 5000 ? 0.8 : 0; scL[i] = v; scR[i] = v; }
      sc.process(L.subarray(b, b + 128), R.subarray(b, b + 128), 128, c);
      if (opened < 0) for (let i = 0; i < 128; i++) if (L[b + i] > 0.2) { opened = b + i; break; }
    }
    expect(opened).toBeGreaterThanOrEqual(5000);
    expect(opened).toBeLessThan(5010);
  });

  it('outputs the TSS envelope as a controller value', () => {
    const fx = make({ ...T_ONLY });
    const x = new Float32Array(256);
    for (let i = 50; i < 256; i++) x[i] = 0.6;
    fx.process(x.subarray(0, 128), Float32Array.from(x.subarray(0, 128)), 128, makeCtx());
    expect(fx.controls?.()[0]).toBeCloseTo(1, 3);
  });

  it('smooths level changes (no zipper steps)', () => {
    const base = { tFx: 5, sFx: 5, lookahead: 0, sens: 0, hold: 0, release: 0 };
    const fx = make(base);
    const n = SR / 4;
    const x = new Float32Array(n).fill(0.25);
    render(fx, x, x, 128);
    fx.setParams({ ...defaultFxParams('transmitter'), ...base, sLevel: 0, tLevel: 0 });
    const L = new Float32Array(128).fill(0.25), R = new Float32Array(128).fill(0.25);
    fx.process(L, R, 128, makeCtx());
    let maxStep = 0;
    for (let i = 1; i < 128; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
    expect(maxStep).toBeLessThan(0.01);
    expect(L[127]).toBeLessThan(0.25);
  });

  it('is silent for silence and finite at extreme settings', () => {
    const quiet = make();
    const z = new Float32Array(SR);
    const [zl] = render(quiet, z, z, 128);
    expect(peak(zl)).toBe(0);
    const extremes: Record<string, unknown>[] = [
      { sens: 10000, mode: 2, hold: 0, release: 0, tLevel: 12800, sLevel: 12800, tTilt: 10000, sTilt: 0, tFx: 4, sFx: 4, tDlyFb: 10000, sDlyFb: 10000, tDlyTime: 0, sDlyTime: 10000 },
      { tFx: 2, sFx: 2, tDiffDepth: 10000, sDiffDepth: 10000, tDiffDelay: 0, sDiffDelay: 10000, tLevel: 12800, sLevel: 12800 },
      { tFx: 1, sFx: 1, tBncAmp: 10000, sBncAmp: 0, tBncTime: 0, sBncTime: 10000, tLevel: 12800, sLevel: 12800 },
      { tFx: 0, sFx: 0, tSatDrive: 10000, sSatDrive: 10000, tSatWarmth: 10000, sSatWarmth: 5000, stereoLink: 0, lookahead: 1 },
      { tFx: 4, sFx: 4, tTempo: 1, sTempo: 1, tDlySync: 1, sDlySync: 768 },
    ];
    for (const over of extremes) {
      const fx = make(over);
      const n = 2 * SR;
      const x = new Float32Array(n);
      let seed = 1;
      for (let i = 0; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; x[i] = ((seed / 2 ** 32) * 2 - 1) * (i < SR ? 0.9 : 0); }
      const [L, R] = render(fx, x, x, 128);
      let finite = true;
      for (let i = 0; i < n; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) { finite = false; break; }
      expect(finite).toBe(true);
      expect(rms(L)).toBeLessThan(1e6);
      expect(fx.tail).toBeGreaterThan(0);
      expect(fx.tail).toBeLessThanOrEqual(31);
    }
  });
});
