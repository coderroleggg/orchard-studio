import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { makeCtx, render, sine, peak, rms } from './util';

const SR = 44100;
const txt = (key: string, v: number) => formatParam(fxParamDef('chorus', key)!, v);

function make(p: Record<string, number> = {}) {
  const fx = createEffect('chorus', SR, 128);
  fx.setParams({ ...defaultFxParams('chorus'), ...p });
  return fx;
}

/** Linear-interpolated impulses in a segment: [position, gain] (baseline removed). */
function taps(seg: Float32Array, thr = 0.02): [number, number][] {
  const s = Array.from(seg).sort((a, b) => a - b);
  const base = s[s.length >> 1];
  const out: [number, number][] = [];
  for (let i = 0; i < seg.length; i++) {
    if (Math.abs(seg[i] - base) <= thr) continue;
    let j = i, sum = 0, mom = 0;
    while (j < seg.length && Math.abs(seg[j] - base) > thr) { const a = seg[j] - base; sum += a; mom += (j - i) * Math.abs(a); j++; }
    let abs = 0;
    for (let q = i; q < j; q++) abs += Math.abs(seg[q] - base);
    out.push([i + mom / abs, sum]);
    i = j;
  }
  return out;
}

describe('Chorus', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('chorus')!;
    expect(d.name).toBe('Chorus');
    expect(d.category).toBe('Flanger');
    expect([d.width, d.height]).toEqual([500, 205]);
    expect(d.params.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(defaultFxParams('chorus')).toEqual({
      delay: 512, depth: 2250, stereo: 341, lfo1Freq: 1500, lfo2Freq: 2500, lfo3Freq: 3500,
      lfo1Wave: 0, lfo2Wave: 0, lfo3Wave: 0, crossType: 0, crossCutoff: 2500, wetOnly: 0,
    });
    // FL's factory presets, applied over the defaults ("Default" equals them)
    expect(d.presets?.map((p) => p.name)).toEqual(['50 Detune', 'CE Chorus', 'Default', 'Fat Clean', 'Filtro', 'Light HF', 'Low Enhance', 'Poly Chorus']);
    expect(d.presets?.find((p) => p.name === 'Default')?.params).toEqual({});
    expect(d.presets?.find((p) => p.name === 'CE Chorus')?.params).toMatchObject({ delay: 115, depth: 3669, lfo1Freq: 1458, crossCutoff: 1719 });
    // texts read from FL's binary
    expect(txt('delay', 512)).toBe('15.02500 ms');
    expect(txt('delay', 192)).toBe('5.66563 ms');
    expect(txt('delay', 0)).toBe('0.05000 ms');
    expect(txt('depth', 2250)).toBe('2.25000 ms');
    expect(txt('stereo', 341)).toBe('59 degrees');
    expect(txt('stereo', 1024)).toBe('180 degrees');
    expect(txt('lfo1Freq', 1500)).toBe('0.45000 Hz');
    expect(txt('lfo1Freq', 15)).toBe('0.00005 Hz');
    expect(txt('lfo2Freq', 5000)).toBe('5.00000 Hz');
    expect(txt('lfo1Wave', 341)).toBe('sin');
    expect(txt('lfo1Wave', 342)).toBe('sin^3');
    expect(txt('lfo1Wave', 683)).toBe('multi-sin');
    expect(txt('lfo1Wave', 1023)).toBe('multi-sin');
    expect(txt('lfo1Wave', 1024)).toBe('multi-sin^3');
    expect(txt('crossType', 25)).toBe('Process HF');
    expect(txt('crossType', 26)).toBe('Process LF');
    expect(txt('crossCutoff', 2500)).toBe('320.24371 Hz');
    expect(txt('crossCutoff', 0)).toBe('8.17580 Hz');
    expect(txt('wetOnly', 256)).toBe('no');
    expect(txt('wetOnly', 257)).toBe('yes');
  });

  it('mixes 0.7 dry with three 0.42 voices at the set delay (depth 0, FL measurement)', () => {
    // Process LF with the cut-off at its top: an impulse comes back as 0.7 now and 1.26 at 15.025 ms
    const fx = make({ depth: 0, crossType: 100, crossCutoff: 5000 });
    const x = new Float32Array(4096); x[100] = 1;
    const [L] = render(fx, x, x, 128, { sampleRate: SR });
    expect(L[100]).toBeCloseTo(0.7, 6);
    let wet = 0;
    for (let i = 101; i < 4096; i++) wet += L[i];
    expect(wet).toBeCloseTo(1.26, 2);
    // HF band (default): the wet impulse sits at 662.6 samples, linearly interpolated
    const hf = make({ depth: 0, crossCutoff: 0, wetOnly: 1024 });
    const [H] = render(hf, x, x, 128, { sampleRate: SR });
    const t = taps(H.subarray(100, 1000));
    expect(t.length).toBe(1);
    expect(t[0][0]).toBeCloseTo(662.6, 1);
    expect(t[0][1]).toBeCloseTo(1.26, 2);
    expect(Math.abs(H[50])).toBeLessThan(1e-9); // wet only: no dry
    // low band at the default 320 Hz cut-off: FL's samples 662..666 after the impulse
    const lf = make({ depth: 0, crossType: 100, wetOnly: 1024 });
    const [F] = render(lf, x, x, 128, { sampleRate: SR });
    const ref = [0.01118, 0.03879, 0.05399, 0.05158, 0.04928];
    ref.forEach((r, i) => expect(F[100 + 662 + i]).toBeCloseTo(r, 4));
  });

  it('sweeps each voice between Delay and Delay + Depth', () => {
    const fx = make({ delay: 0, depth: 5000, stereo: 0, lfo1Freq: 3000, lfo2Freq: 2000, lfo3Freq: 1000, crossCutoff: 0, wetOnly: 1024 });
    const P = 256, n = P * 400;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i += P) x[i] = 1;
    const [L] = render(fx, x, x, 128, { sampleRate: SR });
    let lo = Infinity, hi = -Infinity, count = 0;
    for (let i = P; i < n - P; i += P) {
      for (const [pos, g] of taps(L.subarray(i, i + 240))) {
        if (g < 0.3 || g > 0.5) continue; // single voices only
        lo = Math.min(lo, pos); hi = Math.max(hi, pos); count++;
      }
    }
    expect(count).toBeGreaterThan(500);
    expect(lo).toBeGreaterThan(2.1); // 0.05 ms
    expect(lo).toBeLessThan(3);
    expect(hi).toBeGreaterThan(221.5); // 5.05 ms
    expect(hi).toBeLessThan(222.8);
  });

  it('leads the right channel by the Stereo phase', () => {
    // LFOs stopped at phase 0: left voices sit mid-sweep, right ones a quarter cycle on (top)
    const fx = make({ delay: 0, depth: 5000, stereo: 512, lfo1Freq: 0, lfo2Freq: 0, lfo3Freq: 0, crossCutoff: 0, wetOnly: 1024 });
    const x = new Float32Array(2048); x[0] = 1;
    const [L, R] = render(fx, x, x, 128, { sampleRate: SR });
    const tl = taps(L.subarray(0, 400)), tr = taps(R.subarray(0, 400));
    expect(tl[0][0]).toBeCloseTo(2.205 + 110.25, 0);
    expect(tr[0][0]).toBeCloseTo(2.205 + 220.5, 0);
  });

  it('uses the parabolic sine and true multi-sine waves', () => {
    // a static LFO a sixth of a cycle into its stereo offset exposes each wave's value
    const value = (wave: number) => {
      const fx = make({ delay: 0, depth: 5000, stereo: 1024 / 3, lfo1Freq: 0, lfo2Freq: 0, lfo3Freq: 0, lfo1Wave: wave, lfo2Wave: wave, lfo3Wave: wave, crossCutoff: 0, wetOnly: 1024 });
      const x = new Float32Array(2048); x[0] = 1;
      const [, R] = render(fx, x, x, 128, { sampleRate: SR });
      return (taps(R.subarray(0, 400))[0][0] - 2.205) / 110.25 - 1;
    };
    const x = 1 / 6;
    const ps = 16 * x * (0.5 - x);
    const ms = (Math.sin(2 * Math.PI * x) + (Math.sin(4 * Math.PI * x) + Math.sin(6 * Math.PI * x)) / 3) / 1.2761423749153966;
    expect(value(0)).toBeCloseTo(ps, 2);
    expect(value(400)).toBeCloseTo(ps ** 3, 2);
    expect(value(700)).toBeCloseTo(ms, 2);
    expect(value(1024)).toBeCloseTo(ms ** 3, 2);
  });

  it('glides delay changes without clicks', () => {
    const fx = make({ depth: 0, delay: 0, crossType: 100, crossCutoff: 5000 });
    const x = sine(200, 1, 0.5, SR);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const ctx = makeCtx({ sampleRate: SR });
    let maxStep = 0;
    for (let i = 0; i < L.length; i += 128) {
      if (i === 128 * 100) fx.setParams({ ...defaultFxParams('chorus'), depth: 0, delay: 1024, crossType: 100, crossCutoff: 5000 });
      fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, ctx);
    }
    for (let i = 128 * 100; i < L.length; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
    // a 200 Hz sine at this level changes by at most ~0.03 per sample; a delay jump would step by ~1
    expect(maxStep).toBeLessThan(0.08);
  });

  it('is silent after its tail and stays finite at extreme settings', () => {
    const fx = make();
    const n = SR;
    const x = new Float32Array(n);
    x.set(sine(330, 0.3, 0.8, SR));
    const [L, R] = render(fx, x, x, 128, { sampleRate: SR });
    const after = Math.round((0.3 + (fx.tail ?? 0)) * SR) + 10;
    expect(peak(L, after)).toBeLessThan(1e-6);
    expect(peak(R, after)).toBeLessThan(1e-6);

    const loud = new Float32Array(SR);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i * 0.37) * 4 + ((i * 7919) % 13) / 13;
    for (const p of [
      { delay: 1024, depth: 5000, stereo: 1024, lfo1Freq: 5000, lfo2Freq: 5000, lfo3Freq: 5000, lfo1Wave: 1024, lfo2Wave: 1024, lfo3Wave: 1024, crossType: 100, crossCutoff: 5000, wetOnly: 1024 },
      { delay: 0, depth: 0, stereo: 0, lfo1Freq: 0, lfo2Freq: 0, lfo3Freq: 0, lfo1Wave: 0, lfo2Wave: 0, lfo3Wave: 0, crossType: 0, crossCutoff: 0, wetOnly: 0 },
    ]) {
      const f = make(p);
      const [a, b] = render(f, loud, loud, 64, { sampleRate: SR });
      expect(a.every(Number.isFinite) && b.every(Number.isFinite)).toBe(true);
      expect(rms(a)).toBeGreaterThan(0.1);
    }
    // recovers from a non-finite input sample
    const f = make();
    const bad = new Float32Array(1024).fill(0.1); bad[5] = NaN;
    render(f, bad, bad, 128, { sampleRate: SR });
    const [c] = render(f, new Float32Array(SR).fill(0.1), undefined, 128, { sampleRate: SR });
    expect(Number.isFinite(c[c.length - 1])).toBe(true);
  });
});
