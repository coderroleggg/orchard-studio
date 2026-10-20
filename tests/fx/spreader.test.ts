import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import { spreaderBypassHz, spreaderBypassText, spreaderSepText, spreaderSpreadText } from '../../src/model/fx/plugins/spreader';
import { peak, render, rms } from './util';

const SR = 44100;

function noise(n: number, seed = 1, amp = 0.3): Float32Array {
  let s = seed >>> 0;
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; b[i] = ((s / 4294967296) * 2 - 1) * amp; }
  return b;
}

/** A Spreader whose smoothed parameters have settled (0.1 s of silence). */
function settled(params: Record<string, number>) {
  const fx = createEffect('spreader', SR, 128);
  fx.setParams({ ...defaultFxParams('spreader'), ...params });
  render(fx, new Float32Array(4410));
  return fx;
}

function energy(b: Float32Array): number {
  let e = 0;
  for (const v of b) e += v * v;
  return e;
}

describe('Spreader', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('spreader')!;
    expect(d.name).toBe('Spreader');
    expect([d.width, d.height]).toEqual([540, 255]);
    expect(d.params.map((p) => [p.name, p.min, p.max, p.def])).toEqual([
      ['Spread', 0, 10000, 5000], ['Stereo separation', -10000, 10000, 0], ['Low-Frequency Bypass', 1000, 1000000, 10990],
      ['Mono', 0, 1, 0], ['Enabled', 0, 1, 1],
    ]);
    // texts read from FL (5290 swept values match)
    expect(spreaderSpreadText(5000)).toBe('50.0%');
    expect(spreaderSpreadText(315)).toBe('3.2%');
    expect(spreaderSepText(0)).toBe('Original');
    expect(spreaderSepText(50)).toBe('Original');
    expect(spreaderSepText(250)).toBe('2% separated');
    expect(spreaderSepText(-5450)).toBe('55% merged');
    expect(spreaderBypassText(10990)).toBe('10.00 Hz');
    expect(spreaderBypassText(496509)).toBe('496.00 Hz');
    expect(spreaderBypassText(1000000)).toBe('10000.00 Hz');
    expect(spreaderBypassHz(500500)).toBeCloseTo(500, 3);
  });

  it('matches FL impulse-response energies (default settings, measured in FL)', () => {
    // FL: L impulse -> L energy 1.1748, sum 1.0000; L -> R ~0 (spread 50%, separation original)
    const fx = settled({});
    const imp = new Float32Array(16384);
    imp[0] = 1;
    const [L, R] = render(fx, imp, new Float32Array(16384));
    expect(energy(L)).toBeCloseTo(1.1748, 3);
    expect(L.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(peak(R)).toBeLessThan(1e-4);
    // spread 0: a Linkwitz-Riley all-pass (energy 1)
    const [L0] = render(settled({ spread: 0 }), imp, new Float32Array(16384));
    expect(energy(L0)).toBeCloseTo(1, 3);
  });

  it('is mono compatible: the mid of a mono input keeps its level', () => {
    const x = noise(44100, 7);
    const [L, R] = render(settled({ spread: 10000 }), x, x);
    const mid = L.map((l, i) => (l + R[i]) / 2);
    expect(20 * Math.log10(rms(mid, 4410) / rms(x, 4410))).toBeCloseTo(0, 1);
    // while the channels decorrelate
    let c = 0, a = 0, b = 0;
    for (let i = 4410; i < L.length; i++) { c += L[i] * R[i]; a += L[i] * L[i]; b += R[i] * R[i]; }
    expect(c / Math.sqrt(a * b)).toBeLessThan(0.8);
  });

  it('separation: fully merged gives L = R above the bypass; fully separated widens the side', () => {
    const l = noise(22050, 3), r = noise(22050, 9);
    const [Lm, Rm] = render(settled({ sep: -10000, spread: 0, lowbypass: 1000 }), l, r);
    // only the band below the (10 Hz) bypass keeps any side signal
    const sideM = rms(Lm.map((v, i) => v - Rm[i]), 2205);
    expect(sideM).toBeLessThan(0.03 * rms(l.map((v, i) => v - r[i]), 2205));
    const [Ls, Rs] = render(settled({ sep: 10000, spread: 0 }), l, r);
    const sideIn = rms(l.map((v, i) => v - r[i]), 2205), sideOut = rms(Ls.map((v, i) => v - Rs[i]), 2205);
    expect(sideOut / sideIn).toBeCloseTo(2, 1);
  });

  it('mono bass collapses the band below the bypass; disabled passes the input', () => {
    const l = new Float32Array(22050).map((_, i) => 0.4 * Math.sin((2 * Math.PI * 200 * i) / SR));
    const r = new Float32Array(22050).map((_, i) => 0.4 * Math.cos((2 * Math.PI * 200 * i) / SR));
    const [Lm, Rm] = render(settled({ mono: 1, lowbypass: 1000000, spread: 0 }), l, r);
    // bypass at 10 kHz: the 200 Hz tones are in the low band, which is now mono
    const side = rms(Lm.map((v, i) => v - Rm[i]), 4410);
    expect(side).toBeLessThan(0.01 * rms(l.map((v, i) => v - r[i]), 4410));
    const off = settled({ enabled: 0 });
    const nl = noise(22050, 5), nr = noise(22050, 11);
    const [Lo, Ro] = render(off, nl, nr);
    for (let i = 2205; i < 22050; i += 997) { expect(Lo[i]).toBeCloseTo(nl[i], 6); expect(Ro[i]).toBeCloseTo(nr[i], 6); }
  });

  it('fades in from dry at creation and crossfades delay taps without clicks', () => {
    const fx = createEffect('spreader', SR, 128);
    fx.setParams(defaultFxParams('spreader'));
    const x = new Float32Array(256).fill(0.5);
    const [L] = render(fx, x, x);
    expect(L[0]).toBeCloseTo(0.5, 3); // smoothed enable starts at 0: dry
    // sweep the spread while a sine plays: the delay tap changes are crossfaded
    const s = new Float32Array(44100).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 3000 * i) / SR));
    const fx2 = settled({});
    const out = new Float32Array(s.length);
    for (let o = 0; o < s.length; o += 128) {
      fx2.setParams({ ...defaultFxParams('spreader'), spread: Math.round(10000 * (o / s.length)) });
      const a = s.slice(o, o + 128), b = s.slice(o, o + 128);
      fx2.process(a, b, a.length, { sampleRate: SR, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: true, track: 1, sidechain: [], sendTo: () => {} });
      out.set(a, o);
    }
    let jump = 0;
    for (let i = 1; i < out.length; i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]));
    expect(jump).toBeLessThan(0.75); // a 3 kHz sine at 0.5 moves at most ~0.21 per sample; no step discontinuities
  });

  it('silence in, silence out; finite at extremes and with bad parameters', () => {
    const fx = settled({ spread: 10000, sep: 10000, lowbypass: 1000000, mono: 1 });
    const [L, R] = render(fx, new Float32Array(4096));
    expect(peak(L) + peak(R)).toBe(0);
    const big = new Float32Array(4096).map((_, i) => (i % 2 ? 1e30 : -1e30));
    const [B1, B2] = render(fx, big, big);
    expect(B1.every(Number.isFinite) && B2.every(Number.isFinite)).toBe(true);
    fx.setParams({ spread: NaN, sep: 'x', lowbypass: Infinity });
    const [C1] = render(fx, new Float32Array(1024).fill(0.2));
    expect(C1.every(Number.isFinite)).toBe(true);
  });
});
