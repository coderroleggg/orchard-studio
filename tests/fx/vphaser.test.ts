import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { vphaserSyncText, vphaserDelaySyncText } from '../../src/model/fx/plugins/vphaser';
import { render, rms, peak } from './util';

const SR = 44100;
const txt = (key: string, v: number) => formatParam(fxParamDef('vphaser', key)!, v);
/** Static V1 phaser, wet only, no noise: FL measurement setup. */
const MANUAL = { manual: 1, feedback: 0, mix: 100, noise: 0, engine: 0 };

function make(p: Record<string, number> = {}) {
  const fx = createEffect('vphaser', SR, 128);
  fx.setParams({ ...defaultFxParams('vphaser'), ...p });
  return fx;
}

/** Steady-state gain (dB) and phase (degrees, after removing the 44-sample latency) for a sine at f. */
function sineResponse(p: Record<string, number>, f: number, amp = 0.25): { db: number; deg: number } {
  const n = Math.round(SR * 0.5);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / SR);
  const [L] = render(make(p), x, x, 128, { sampleRate: SR });
  let s = 0, c = 0;
  const a = Math.round(SR * 0.25);
  for (let i = a; i < n; i++) { const w = (2 * Math.PI * f * (i - 44)) / SR; s += L[i] * Math.sin(w); c += L[i] * Math.cos(w); }
  return { db: 20 * Math.log10((2 * Math.hypot(s, c)) / (n - a) / amp), deg: (Math.atan2(c, s) * 180) / Math.PI };
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

describe('Vintage Phaser', () => {
  it('is registered with FL ranges, Default-preset values, factory presets and value texts', () => {
    const d = fxDef('vphaser')!;
    expect([d.width, d.height]).toEqual([747, 277]);
    const def = defaultFxParams('vphaser');
    expect(def).toMatchObject({ minFreq: 896070, maxFreq: 1588996, feedback: 3000, speed: 1, mix: 50, engine: 1, lfoScale: 6000, delayLp: 3200, rate2: 150000 });
    expect(d.presets?.length).toBe(16);
    expect(createEffect('vphaser', SR, 128).latency).toBe(44);
    // FL's texts (single precision, decimal halves rounded up)
    expect(txt('minFreq', 896070)).toBe('87.24 Hz');
    expect(txt('maxFreq', 1024063)).toBe('160.00 Hz');
    expect(txt('feedback', 3000)).toBe('49.5%');
    expect(txt('feedback', 300)).toBe('5.0%');
    expect(txt('speed', 1)).toBe('0.025 Hz');
    expect(txt('speed', 122881)).toBe('1.937 Hz');
    expect(txt('tension', 6000)).toBe('99.0%');
    expect(txt('delayTime', 385)).toBe('500.7 ms');
    expect(txt('delayStereo', 1500)).toBe('50.0 left');
    expect(txt('delayStereo', 3000)).toBe('center');
    expect(txt('delayLp', 104000)).toBe('2560.0 Hz');
    expect(txt('delayHp', 103400)).toBe('640.0 Hz');
    expect(txt('mix', 25)).toBe('75% Dry / 25% Wet');
    expect(txt('noise', 0)).toBe('-∞');
    expect(txt('colorGain', 3)).toBe('0.02 dB');
    expect(txt('colorFreq', 85623)).toBe('125.00 Hz');
    expect(txt('inputHp', 41000)).toBe('29.38 Hz');
    expect(txt('rate1', 75013)).toBe('9.399 Hz');
    expect(txt('lfoScale', 9)).toBe('0.2%');
    expect(txt('drive', 327492)).toBe('15.00 dB');
    expect(txt('engine', 1)).toBe('V2');
    expect(vphaserSyncText(164762)).toBe('4:0');
    expect(vphaserDelaySyncText(385)).toBe('8:1');
  });

  it('delays the dry signal by 44 samples behind the 5 Hz input high-pass (FL)', () => {
    const x = new Float32Array(2000); x[100] = 1;
    const [L] = render(make({ ...MANUAL, mix: 0 }), x, x, 128, { sampleRate: SR });
    expect(L[144]).toBeCloseTo(0.999644, 4);
    expect(L[145]).toBeCloseTo(-0.000712, 5);
    expect(peak(L, 0, 144)).toBeLessThan(1e-9);
  });

  it('runs four allpasses at 4x with the displayed frequency (V1, FL phase response)', () => {
    // FL, Manual 1810.2 Hz: phase after the latency, minus two 5 Hz high-passes
    const p = { ...MANUAL, engine: 0, manualFreq: 1536032 };
    const hp = (f: number) => (2 * Math.atan(5 / f) * 180) / Math.PI;
    for (const [f, fl] of [[1000, -231.3], [2000, -382.8], [5000, -561.1], [10000, -638.7]] as const) {
      const r = sineResponse(p, f);
      expect(Math.abs(r.db)).toBeLessThan(0.02);
      expect(Math.abs(wrap(r.deg - hp(f) - fl))).toBeLessThan(0.5);
    }
  });

  it('feeds back 0.9 x Feedback one oversampled sample late (V1) and linear mixing (FL)', () => {
    // FL, Manual 160 Hz, Feedback 3000: wet gain at 50 / 100 / 1000 Hz
    const p = { ...MANUAL, engine: 0, manualFreq: 1024063, feedback: 3000 };
    expect(sineResponse(p, 50).db).toBeCloseTo(-2.658, 1);
    expect(sineResponse(p, 100).db).toBeCloseTo(-1.701, 1);
    expect(sineResponse(p, 1000).db).toBeCloseTo(0.414, 1);
    // inverted feedback (FL: -1.750 dB at 1 kHz)
    expect(sineResponse({ ...p, invertFb: 1 }, 1000).db).toBeCloseTo(-1.75, 1);
    // mix is linear: at 300 Hz a 724 Hz phaser inverts (4 x -45 degrees), so 25 % wet leaves 0.75 - 0.25
    const m = sineResponse({ ...MANUAL, engine: 0, manualFreq: 1337780, mix: 25 }, 300);
    expect(10 ** (m.db / 20)).toBeCloseTo(0.5, 1);
  });

  it('models the V2 OTA engine: output filter and saturation (FL)', () => {
    // FL's V2 output filter on the dry path: flat, then -5.9 dB at 20 kHz
    const dry = { ...MANUAL, mix: 0, engine: 1 };
    expect(sineResponse(dry, 1000).db).toBeCloseTo(0, 1);
    expect(sineResponse(dry, 20000, 0.1).db).toBeCloseTo(-5.91, 0);
    // saturation: Drive 15 dB, 441 Hz at 0 dBFS through 968 Hz stages: FL gain -0.30 dB, 3rd harmonic -35.3 dB
    const n = SR, f = 441;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * f * i) / SR);
    const [L] = render(make({ ...MANUAL, engine: 1, manualFreq: 1404000, drive: 327500 }), x, x, 128, { sampleRate: SR });
    const h = (k: number) => {
      let s = 0, c = 0;
      for (let i = 22050; i < 44100; i++) { const w = (2 * Math.PI * f * k * i) / SR; s += L[i] * Math.sin(w); c += L[i] * Math.cos(w); }
      return Math.hypot(s, c) / 11025;
    };
    expect(20 * Math.log10(h(1))).toBeCloseTo(-0.3, 0);
    expect(Math.abs(20 * Math.log10(h(3) / h(1)) + 35.3)).toBeLessThan(2.5);
  });

  it('shapes the LFO with Tension like FL', () => {
    // 1 Hz triangle over 87.24..2326.61 Hz: Tension 3000 lifts the zero crossing from 450 Hz to ~1010 Hz.
    // Probe at 60 Hz: the wet phase -8 atan(tan(60 pi / 4sr) / tan(fc pi / 4sr)) gives fc back.
    const fcAt = (p: Record<string, number>, t: number) => {
      const n = Math.round(SR * (t + 0.05));
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = 0.25 * Math.sin((2 * Math.PI * 60 * i) / SR);
      const [L] = render(make({ engine: 0, feedback: 0, mix: 100, noise: 0, speed: 104211, ...p }), x, x, 128, { sampleRate: SR });
      let s = 0, c = 0;
      const c0 = Math.round(t * SR) + 44, wnd = Math.round(SR / 60);
      for (let i = c0 - wnd; i < c0 + wnd; i++) { const w = (2 * Math.PI * 60 * (i - 44)) / SR; s += L[i] * Math.sin(w); c += L[i] * Math.cos(w); }
      let ph = Math.atan2(c, s) - 2 * Math.atan(5 / 60);
      if (ph > 0) ph -= 2 * Math.PI;
      const osr = 4 * SR;
      return (Math.atan(Math.tan((Math.PI * 60) / osr) / Math.tan(-ph / 8)) * osr) / Math.PI;
    };
    expect(fcAt({}, 0.5) / 450.5).toBeCloseTo(1, 1);
    expect(fcAt({ tension: 3000 }, 0.5) / 1011).toBeCloseTo(1, 1);
  });

  it('delays the output with FL timing, stereo law and feedback filtering', () => {
    const x = new Float32Array(SR); x[1000] = 1;
    const base = { ...MANUAL, mix: 0, delayOn: 1, delayTime: 97, delayMix: 6000, delayFeedback: 0, delayLp: 204800, delayHp: 2000 };
    // FL: the echo lands 5519.219 samples after the direct sound (the single-precision glide stalls 0.47 short)
    const [L] = render(make(base), x, x, 128, { sampleRate: SR });
    const i0 = 1044 + 5519;
    const pos = i0 + L[i0 + 1] / (L[i0] + L[i0 + 1]);
    expect(pos - 1044).toBeCloseTo(5519.219, 1);
    // stereo 25 % left: left direct 0.8049, left echo 1.1586 (FL's quadratic laws)
    const [S] = render(make({ ...base, delayStereo: 2250 }), x, x, 128, { sampleRate: SR });
    expect(S[1044] / 0.99964).toBeCloseTo(0.8049, 2);
    expect((S[i0] + S[i0 + 1]) / 0.99964).toBeCloseTo(1.1586, 2);
    // feedback: a repeat per loop with the loop filters (FL: LP 2560 Hz, 50 % -> -6.19 dB low, -9.1 dB at 2.56 kHz per repeat)
    const fbx = { ...base, delayTime: 36, delayFeedback: 3000, delayLp: 104000 };
    const [F] = render(make(fbx), x, x, 128, { sampleRate: SR });
    const d = (35 / 767) * SR;
    const e1 = F.slice(1044 + Math.round(d) - 1000, 1044 + Math.round(d) + 1000);
    const e2 = F.slice(1044 + Math.round(2 * d) + 1 - 1000, 1044 + Math.round(2 * d) + 1 + 1000);
    const band = (seg: Float32Array, f: number) => { let s = 0, c = 0; for (let i = 0; i < seg.length; i++) { const w = (2 * Math.PI * f * i) / SR; s += seg[i] * Math.sin(w); c += seg[i] * Math.cos(w); } return Math.hypot(s, c); };
    expect(20 * Math.log10(band(e2, 200) / band(e1, 200))).toBeCloseTo(-6.2, 0);
    expect(20 * Math.log10(band(e2, 2560) / band(e1, 2560))).toBeCloseTo(-9.1, 0);
  });

  it('adds the colour shelf, gated noise and stays finite and click-free', () => {
    // colour low shelf 15 dB at 50 Hz: FL +7.53 dB at 50 Hz, +3.19 dB at 100 Hz
    const sh = { ...MANUAL, mix: 0, colorGain: 3000, colorFreq: 5000 };
    expect(sineResponse(sh, 50).db).toBeCloseTo(7.53 - 0.04, 0);
    expect(sineResponse(sh, 100).db).toBeCloseTo(3.19 - 0.01, 0);
    // noise: FL -52.27 dB rms in Manual mode at -40 dB, gate closes on silence
    const z = new Float32Array(SR * 2);
    const [N] = render(make({ ...MANUAL, noise: 6000, manualFreq: 1024063 }), z, z, 128, { sampleRate: SR });
    expect(20 * Math.log10(rms(N, SR / 2))).toBeCloseTo(-52.3, 0);
    const g = make({ ...MANUAL, noise: 6000, gate: 1 });
    const [G] = render(g, z, z, 128, { sampleRate: SR });
    expect(peak(G, SR / 2)).toBeLessThan(1e-6);
    expect(make({ noise: 3000 }).tail).toBe(Infinity);
    // extremes
    const loud = new Float32Array(SR / 2);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i * 0.37) * 4;
    for (const p of [
      { feedback: 6000, speed: 245760, drive: 650000, hq: 1, delayOn: 1, delayFeedback: 6000, delayMix: 6000, delayTime: 2, colorGain: 6000 },
      { engine: 0, feedback: 6000, invertFb: 1, manual: 1, manualFreq: 2048000, inputHp: 80000, feedbackHp: 80000, mono: 1 },
    ] as Record<string, number>[]) {
      const [a, b] = render(make(p), loud, loud, 64, { sampleRate: SR });
      expect(a.every(Number.isFinite) && b.every(Number.isFinite)).toBe(true);
    }
    // like FL, Mix applies at once: with the phaser frozen (Manual) the next samples
    // already carry the new dry / wet balance
    const run = (change: boolean) => {
      const fx = make({ manual: 1, manualFreq: 1000000, engine: 0, mix: change ? 20 : 80 });
      const n = SR / 2;
      const L = new Float32Array(n), R = new Float32Array(n);
      for (let i = 0; i < n; i++) { L[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / SR); R[i] = L[i]; }
      const ctx = { sampleRate: SR, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: true, track: 1, sidechain: [], sendTo: () => {} };
      for (let i = 0; i < n; i += 128) {
        if (change && i === 128 * 100) fx.setParams({ ...defaultFxParams('vphaser'), manual: 1, manualFreq: 1000000, engine: 0, mix: 80 });
        fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, ctx);
      }
      return L;
    };
    const a = run(true), b = run(false);
    let after = 0;
    // the 44-sample latency: the dry part of the output switches 44 samples later
    for (let i = 128 * 100 + 64; i < a.length; i++) after = Math.max(after, Math.abs(a[i] - b[i]));
    expect(after).toBeLessThan(1e-6);
  });
});
