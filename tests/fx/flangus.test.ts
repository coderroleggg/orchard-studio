import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { flangusRate, flangusNorm } from '../../src/engine/effects/plugins/flangus';
import { makeCtx, render, sine, peak } from './util';

const SR = 44100;
const txt = (key: string, v: number) => formatParam(fxParamDef('flangus', key)!, v);

function make(p: Record<string, number> = {}) {
  const fx = createEffect('flangus', SR, 128);
  fx.setParams({ ...defaultFxParams('flangus'), ...p });
  return fx;
}

/** Voices read with FL's 2-tap kernel: [delay, gain] per voice in a segment. */
function voices(seg: Float32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < seg.length - 1; i++) {
    if (Math.abs(seg[i]) < 1e-5) continue;
    const w1 = seg[i], w2 = seg[i + 1], s = w1 + w2;
    out.push([i + w2 / s, s]);
    i++;
  }
  return out;
}

/** Impulse train through the effect; returns the processed left/right channels. */
function train(p: Record<string, number>, period: number, seconds: number, both = true) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += period) x[i] = 1;
  return render(make(p), x, both ? x : new Float32Array(n), 512, { sampleRate: SR });
}

describe('Flangus', () => {
  it('is registered with FL ranges, defaults, texts and presets', () => {
    const d = fxDef('flangus')!;
    expect([d.width, d.height]).toEqual([361, 177]);
    expect(defaultFxParams('flangus')).toEqual({ order: 4, depth: 512, speed: 768, delay: 8, spread: 128, cross: -32, dry: 96, wet: 96 });
    expect(txt('order', 4)).toBe('4');
    expect(txt('depth', 512)).toBe('50%');
    expect(txt('delay', 8)).toBe('6%');
    expect(txt('cross', -32)).toBe('-25%');
    expect(txt('cross', -112)).toBe('-88%');
    expect(txt('wet', 96)).toBe('75%');
    expect(d.presets?.length).toBe(12);
    expect(d.presets?.find((p) => p.name === 'Flanger 2')?.params).toMatchObject({ order: 1, depth: 136, wet: -128 });
  });

  it('follows the measured rate and normalisation curves', () => {
    // FL: speed 0 / 512 / 1024 give 0.1366 / 1.4147 / 20.62 Hz on the first voice at spread 128 (factor 0.935)
    expect(flangusRate(0) * 0.935088).toBeCloseTo(0.13655, 4);
    expect(flangusRate(512) * 0.935088).toBeCloseTo(1.41468, 4);
    expect(flangusRate(1024) * 0.935088).toBeCloseTo(20.6188, 3);
    expect(flangusRate(600)).toBeCloseTo(2.2875, 2);
    // per-voice wet gain: 0.969 for one voice, 0.319 per voice for nine
    expect(flangusNorm(1)).toBeCloseTo(0.96918, 4);
    expect(flangusNorm(9)).toBeCloseTo(0.31907, 4);
    expect(flangusNorm(3.5)).toBeCloseTo(0.62786, 3);
  });

  it('sweeps a single voice like FL (depth 0, delay 64, spread 128)', () => {
    // FL: the left voice sweeps 955.316 .. 975.316 samples at 0.436 Hz with gain 0.9692
    const [L] = train({ order: 1, depth: 0, speed: 256, delay: 64, spread: 128, cross: 0, dry: 0, wet: 128 }, 2048, 5, false);
    let lo = Infinity, hi = -Infinity, g = 0;
    for (let i = 2048 * 2; i < L.length - 2048; i += 2048) {
      const v = voices(L.subarray(i, i + 2040));
      expect(v.length).toBe(1);
      lo = Math.min(lo, v[0][0]); hi = Math.max(hi, v[0][0]); g = v[0][1];
    }
    expect(lo).toBeCloseTo(955.32, 1);
    expect(hi).toBeCloseTo(975.32, 1);
    expect(g).toBeCloseTo(0.9692, 3);
  });

  it('spreads the voices over Delay x p x r with FL voice factors', () => {
    // FL (order 3, delay 128, spread 128, depth 0): left voice minima 1532.4 / 3173.8 / 4123.7 samples
    const [L] = train({ order: 3, depth: 0, speed: 256, delay: 128, spread: 128, cross: 0, dry: 0, wet: 128 }, 8192, 12, false);
    const mins = [Infinity, Infinity, Infinity];
    for (let i = 8192; i < L.length - 8192; i += 8192) {
      const v = voices(L.subarray(i, i + 8190)).map((q) => q[0]).sort((a, b) => a - b);
      if (v.length !== 3) continue;
      v.forEach((d, j) => { mins[j] = Math.min(mins[j], d); });
    }
    expect(mins[0]).toBeCloseTo(1532.4, 0);
    expect(mins[1]).toBeCloseTo(3173.8, 0);
    expect(mins[2]).toBeCloseTo(4123.7, 0);
  });

  it('cross-feeds voice p with cross x p, normalised by the effective voice count', () => {
    // FL: order 3, cross 128, left input -> left voices 0.499 each, right copies 0.166 / 0.333 / 0.499
    const [L, R] = train({ order: 3, depth: 0, speed: 256, delay: 128, spread: 128, cross: 128, dry: 0, wet: 128 }, 8192, 2, false);
    const t = 8192 * 6;
    const l = voices(L.subarray(t, t + 8190)).map((q) => q[1]);
    const r = voices(R.subarray(t, t + 8190)).sort((a, b) => a[0] - b[0]).map((q) => q[1]);
    l.forEach((g) => expect(g).toBeCloseTo(0.4993, 3));
    expect(r[0]).toBeCloseTo(0.1664, 3);
    expect(r[1]).toBeCloseTo(0.3329, 3);
    expect(r[2]).toBeCloseTo(0.4993, 3);
  });

  it('slews Dry and Wet by 0.001 per sample from zero, like FL', () => {
    const fx = make({ order: 1, depth: 0, speed: 0, delay: 0, spread: 0, cross: 0, dry: 128, wet: 0 });
    const x = new Float32Array(2048).fill(0.5);
    const [L] = render(fx, x, x, 512, { sampleRate: SR });
    expect(L[0]).toBeCloseTo(0, 6);
    expect(L[256] / 0.5).toBeCloseTo(0.256, 3);
    expect(L[1500] / 0.5).toBeCloseTo(1, 6);
    // signed levels: -100 % inverts
    const neg = make({ order: 1, dry: -128, wet: 0 });
    const [N] = render(neg, new Float32Array(4096).fill(0.5), undefined, 512, { sampleRate: SR });
    expect(N[3000] / 0.5).toBeCloseTo(-1, 6);
  });

  it('restarts the voices with empty delay lines on Delay changes, like FL', () => {
    // FL (flfxhost --at): the LFOs restart, the delays jump and the lines are cleared,
    // so right after the change the wet output is silent until the input refills them
    const fx = make({ order: 4, dry: 0, wet: 128 });
    const x = sine(220, 1.5, 0.5, SR);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const ctx = makeCtx({ sampleRate: SR });
    for (let i = 0; i < L.length; i += 128) {
      if (i === 128 * 200) fx.setParams({ ...defaultFxParams('flangus'), dry: 0, wet: 128, delay: 64 });
      fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, ctx);
    }
    // no voice is shorter than FL's 8-sample floor: silence for the first samples
    let quiet = 0, before = 0;
    for (let i = 128 * 200; i < 128 * 200 + 7; i++) quiet = Math.max(quiet, Math.abs(L[i]));
    for (let i = 128 * 199; i < 128 * 200; i++) before = Math.max(before, Math.abs(L[i]));
    expect(before).toBeGreaterThan(0.1);
    expect(quiet).toBeLessThan(1e-6);
  });

  it('is silent after its tail and finite at extreme settings', () => {
    const fx = make();
    const x = new Float32Array(SR);
    x.set(sine(330, 0.3, 0.8, SR));
    const [L] = render(fx, x, x, 128, { sampleRate: SR });
    expect(peak(L, Math.round((0.3 + fx.tail!) * SR) + 10)).toBeLessThan(1e-6);
    const loud = new Float32Array(SR);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i * 0.37) * 4;
    for (const p of [
      { order: 9, depth: 1024, speed: 1024, delay: 128, spread: 128, cross: -128, dry: -128, wet: 128 },
      { order: 1, depth: 0, speed: 0, delay: 0, spread: 0, cross: 128, dry: 128, wet: -128 },
      { order: 7, depth: 1024, speed: 0, delay: 0, spread: 64, cross: 0, dry: 0, wet: 128 },
    ]) {
      const f = make(p);
      const [a, b] = render(f, loud, loud, 64, { sampleRate: SR });
      expect(a.every(Number.isFinite) && b.every(Number.isFinite)).toBe(true);
    }
    // order changes switch the voice count through a short dip
    const f = make({ order: 2 });
    const [a] = render(f, loud, loud, 128, { sampleRate: SR });
    f.setParams({ ...defaultFxParams('flangus'), order: 9 });
    const [b] = render(f, loud, loud, 128, { sampleRate: SR });
    expect(a.every(Number.isFinite) && b.every(Number.isFinite)).toBe(true);
  });
});
