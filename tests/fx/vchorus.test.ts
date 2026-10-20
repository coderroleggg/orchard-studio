import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { vchorusSyncText, vchorusSyncTicks } from '../../src/model/fx/plugins/vchorus';
import { render, sine, rms, peak } from './util';

const SR = 44100;
const txt = (key: string, v: number) => formatParam(fxParamDef('vchorus', key)!, v);
/** Custom mode with a frozen LFO, no hiss and the lowest high-pass (FL measurement setup). */
const STATIC = { mode: 2, speed: 1, noise: 0, highPass: 0 };

function make(p: Record<string, number> = {}, settle = 0) {
  const fx = createEffect('vchorus', SR, 128);
  fx.setParams({ ...defaultFxParams('vchorus'), ...p });
  // FL starts from its constructor state and glides to the settings: let it settle
  // (stopped transport) where a measurement needs the steady state
  if (settle > 0) { const z = new Float32Array(Math.round(settle * SR)); render(fx, z, z, 128, { sampleRate: SR, playing: false }); }
  return fx;
}

/** Steady-state gain and phase delay (samples) for a sine at f, near an expected delay. */
function sineResponse(p: Record<string, number>, f: number, expectDelay = 0): { db: number; delay: number } {
  const n = Math.round(SR * 0.6);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SR);
  const [L] = render(make(p), x, x, 128, { sampleRate: SR });
  let s = 0, c = 0;
  const a = Math.round(SR * 0.3);
  for (let i = a; i < n; i++) { const w = (2 * Math.PI * f * i) / SR; s += L[i] * Math.sin(w); c += L[i] * Math.cos(w); }
  const amp = (2 * Math.hypot(s, c)) / (n - a);
  const per = SR / f;
  let d = ((-Math.atan2(c, s) / (2 * Math.PI)) * per) % per;
  while (d < expectDelay - per / 2) d += per;
  while (d > expectDelay + per / 2) d -= per;
  return { db: 20 * Math.log10(amp / 0.5), delay: d };
}

/** Delay trajectory from an impulse train: baseline-free energy centroid around each echo. */
function trajectory(p: Record<string, number>, seconds: number, P = 256, ctx = {}, settle = 0): [number[], number[]] {
  const n = Math.round(SR * seconds);
  const x = new Float32Array(n);
  for (let i = P; i < n; i += P) x[i] = 1;
  const out = render(make(p, settle), x, x, 128, { sampleRate: SR, ...ctx });
  return out.map((Y) => {
    const d: number[] = [];
    for (let t = P; t + P <= n; t += P) {
      const seg = Y.subarray(t + 4, t + P);
      const base = [...seg].sort((u, v) => u - v)[seg.length >> 1];
      let i0 = 0;
      for (let i = 1; i < seg.length; i++) if (Math.abs(seg[i] - base) > Math.abs(seg[i0] - base)) i0 = i;
      let e = 0, m = 0;
      for (let i = Math.max(0, i0 - 14); i <= Math.min(seg.length - 1, i0 + 14); i++) { const q = (seg[i] - base) ** 2; e += q; m += q * i; }
      d.push(m / e + 4);
    }
    return d;
  }) as [number[], number[]];
}

describe('Vintage Chorus', () => {
  it('is registered with FL ranges, Default-preset values, factory presets and value texts', () => {
    const d = fxDef('vchorus')!;
    expect([d.width, d.height]).toEqual([747, 217]);
    expect(defaultFxParams('vchorus')).toEqual({
      mode: 0, link: 0, speed: 80, lfoType: 0, lrPhase: 3000, time1: 60, time2: 3000, mix: 3000, mono: 0, invert: 0,
      feedback: 0, highPass: 3000, gain: 0, noise: 3000, gate: 0, sync: 0, startPhase: 0,
    });
    expect(d.presets?.length).toBe(22);
    // FL's texts (single-precision Speed and High pass, Delphi rounding in Mix)
    expect(txt('mode', 2)).toBe('Custom');
    expect(txt('speed', 49152)).toBe('0.40 Hz');
    expect(txt('speed', 160122)).toBe('4.24 Hz');
    expect(txt('time1', 60)).toBe('10.0 ms');
    expect(txt('mix', 3000)).toBe('50% Dry / 50% Wet');
    expect(txt('mix', 90)).toBe('98% Dry / 2% Wet');
    expect(txt('highPass', 3000)).toBe('50.00 Hz');
    expect(txt('highPass', 6000)).toBe('170.00 Hz');
    expect(txt('noise', 3000)).toBe('-65.0 dB');
    expect(txt('noise', 0)).toBe('-∞');
    expect(txt('lrPhase', 3000)).toBe('180.00°');
    expect(txt('gain', 6000)).toBe('12.00 dB');
    expect(txt('feedback', 3000)).toBe('50.0%');
    // tempo-synced Speed: "steps:ticks" (48 ticks per step), FL's swept texts
    expect([1, 149504, 164762, 189952, 211373, 245760].map(vchorusSyncText)).toEqual(['128:0', '5:36', '4:0', '2:2', '1:0', '0:1']);
    // FL's measured synced periods (ticks) at 130 BPM
    expect([150000, 190000, 200000, 210000, 230000].map(vchorusSyncTicks)).toEqual([273, 98, 72, 50, 18]);
  });

  it('filters the wet signal like FL (static delay, measured response)', () => {
    // FL, Time 600 (52.03 samples of bulk delay), 100 % wet incl. the -45 dB dry floor
    const p = { ...STATIC, time1: 600, time2: 600, mix: 6000 };
    const r1 = sineResponse(p, 1001.294, 55.5);
    expect(r1.db).toBeCloseTo(-0.082, 1);
    expect(r1.delay).toBeCloseTo(55.518, 0);
    expect(Math.abs(r1.delay - 55.518)).toBeLessThan(0.1);
    expect(sineResponse(p, 5001.086).db).toBeCloseTo(-3.425, 1);
    expect(sineResponse(p, 7999.585).db).toBeCloseTo(-12.952, 1);
  });

  it('mixes with sqrt(m) / sqrt(1 - m) and leaks -45 dB of dry at 100 % wet (FL)', () => {
    // at 19 kHz the wet path is silent: the output is the dry share
    const dry = (mix: number) => 10 ** (sineResponse({ ...STATIC, time1: 600, time2: 600, mix }, 19000).db / 20);
    expect(dry(6000)).toBeCloseTo(0.005339, 3);
    expect(dry(1500)).toBeCloseTo(0.866003, 3);
    expect(dry(4500)).toBeCloseTo(0.500011, 3);
    expect(dry(0)).toBeCloseTo(1, 3);
  });

  it('feeds back 0.628 x the wet signal at 100 % (FL echo energy ratios)', () => {
    for (const [fb, ratio] of [[3000, 0.0852], [6000, 0.342]]) {
      const x = new Float32Array(4000); x[0] = 1;
      const [L] = render(make({ ...STATIC, time1: 3000, time2: 3000, mix: 6000, feedback: fb }, 0.5), x, new Float32Array(4000), 128, { sampleRate: SR });
      let e1 = 0, e2 = 0;
      for (let i = 100; i < 343; i++) e1 += L[i] * L[i];
      for (let i = 343; i < 572; i++) e2 += L[i] * L[i];
      expect(Math.abs(e2 / e1 - ratio)).toBeLessThan(0.003);
    }
  });

  it('sweeps the Juno modes like FL (delay trajectories from impulse trains)', () => {
    // FL: echo centroids (samples) min / max; I and II triangle, right channel half a cycle on
    for (const [p, lo, hi] of [[{ mode: 0 }, 53.68, 232.25], [{ mode: 1 }, 54.77, 231.16], [{ mode: 0, link: 1 }, 133.23, 148.74]] as const) {
      const [L, R] = trajectory({ ...p, noise: 0 }, 'link' in p ? 2 : 3);
      const skip = Math.round((0.6 * SR) / 256);
      const l = L.slice(skip), r = R.slice(skip);
      expect(Math.abs(Math.min(...l) - lo)).toBeLessThan(0.2);
      expect(Math.abs(Math.max(...l) - hi)).toBeLessThan(0.2);
      const diff = Math.max(...l.map((v, i) => Math.abs(v - r[i])));
      // I+II: the channels run only 10.3 degrees apart
      if ('link' in p) expect(diff).toBeLessThan(1.6);
      else expect(diff).toBeGreaterThan(100);
    }
  });

  it('ignores the custom controls in the Juno modes (FL)', () => {
    const x = Float32Array.from(sine(700, 0.5, 0.4, SR), (v, i) => v + 0.2 * Math.sin(i * 0.013));
    const base = { mode: 0, noise: 0 };
    const [ref] = render(make(base), x, x, 128, { sampleRate: SR });
    const extras: Record<string, number>[] = [{ feedback: 6000 }, { highPass: 6000 }, { mix: 6000 }, { invert: 1 }, { mono: 1 }, { speed: 245760 }, { time1: 6000 }];
    for (const extra of extras) {
      const [L] = render(make({ ...base, ...extra }), x, x, 128, { sampleRate: SR });
      expect(peak(Float32Array.from(L, (v, i) => v - ref[i]))).toBeLessThan(1e-6);
    }
  });

  it('syncs the LFO to the tempo with FL whole-tick periods, restarting at Start phase', () => {
    // 1/4 note from FL's Set menu (192 ticks) at 120 BPM: the sweep repeats every 0.5 s
    const p = { mode: 2, sync: 1, speed: 164762, lfoType: 1, time1: 600, time2: 2400, noise: 0 };
    const [L] = trajectory(p, 1.5, 256, { tempo: 120 });
    const step = (0.5 * SR) / 256;   // 86.13 impulses per period
    for (let k = 20; k < 60; k += 7) {
      const a = L[k], b = L[k + Math.floor(step)], c = L[k + Math.ceil(step)];
      expect(Math.min(Math.abs(a - b), Math.abs(a - c))).toBeLessThan(1.2);
    }
    // play restarts the sine at its centre (phase 0) or its top (Start phase 90 degrees);
    // the delay then glides there (FL's 21.7 ms smoothing)
    const [L0] = trajectory(p, 0.15, 256, { tempo: 120 }, 0.5);
    const [L90] = trajectory({ ...p, startPhase: 1500 }, 0.15, 256, { tempo: 120 }, 0.5);
    expect(L90[4] - L0[4]).toBeGreaterThan(20);
  });

  it('adds FL-level hiss that follows the LFO, gated on request', () => {
    const z = new Float32Array(SR * 2);
    // FL: -53.55 dB rms with Noise at -40 dB, 100 % wet, LFO at its centre
    const [L] = render(make({ mode: 2, speed: 1, mix: 6000, noise: 6000 }), z, z, 128, { sampleRate: SR });
    expect(20 * Math.log10(rms(L, SR / 2))).toBeCloseTo(-53.55, 0);
    const fx = make({ mode: 2, speed: 1, mix: 6000, noise: 6000, gate: 1 });
    const [G] = render(fx, z, z, 128, { sampleRate: SR });
    expect(peak(G, SR / 2)).toBeLessThan(1e-6);
    expect(fx.tail).toBe(0.5);
    expect(make({ noise: 3000 }).tail).toBe(Infinity);
  });

  it('stays finite, changes settings without clicks and goes silent without hiss', () => {
    const loud = new Float32Array(SR);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i * 0.37) * 4;
    const extremes: Record<string, number>[] = [
      { mode: 2, speed: 245760, time1: 0, time2: 6000, feedback: 6000, highPass: 6000, gain: 6000, mix: 6000, noise: 6000 },
      { mode: 2, speed: 1, time1: 6000, time2: 6000, feedback: 6000, highPass: 0, invert: 1, mono: 1 },
    ];
    for (const p of extremes) {
      const [a, b] = render(make(p), loud, loud, 64, { sampleRate: SR });
      expect(a.every(Number.isFinite) && b.every(Number.isFinite)).toBe(true);
    }
    const fx = make({ mode: 2, noise: 0 });
    const x = sine(300, 1, 0.5, SR);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    for (let i = 0; i < L.length; i += 128) {
      if (i === 128 * 100) fx.setParams({ ...defaultFxParams('vchorus'), mode: 2, noise: 0, time1: 4000, time2: 500, mix: 5000, gain: 3000, speed: 120000 });
      fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, { sampleRate: SR, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: true, track: 1, sidechain: [], sendTo: () => {} });
    }
    let jump = 0;
    for (let i = 128 * 100; i < 128 * 140; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
    expect(jump).toBeLessThan(0.08);
    const quiet = make({ mode: 0, noise: 0 });
    const y = new Float32Array(SR * 2);
    y.set(sine(440, 0.3, 0.8, SR));
    const [Q] = render(quiet, y, y, 128, { sampleRate: SR });
    expect(peak(Q, Math.round((0.3 + quiet.tail!) * SR))).toBeLessThan(1e-3);
  });
});
