import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { driveK, satCurve } from '../../src/engine/effects/plugins/transient';
import { makeCtx, render, peak, rms } from './util';

const SR = 48000;

function make(p: Record<string, unknown> = {}) {
  const fx = createEffect('transient', SR, 128);
  fx.setParams({ ...defaultFxParams('transient'), ...p });
  fx.reset();
  return fx;
}

function text(key: string, v: number): string {
  const d = fxDef('transient')!;
  return formatParam(d.params.find((q) => q.key === key)!, v);
}

/** Tone with piecewise-constant amplitude plus a tiny Nyquist probe (keeps the detectors "awake" like FL's tests). */
function tone(segs: [number, number][], f = 1000, probe = 1e-5): Float32Array {
  const n = segs.reduce((a, [, d]) => a + Math.round(d * SR), 0);
  const b = new Float32Array(n);
  let i = 0;
  for (const [amp, dur] of segs) {
    const m = Math.round(dur * SR);
    for (let k = 0; k < m; k++, i++) b[i] = amp * Math.sin((2 * Math.PI * f * i) / SR) + (i % 2 ? -probe : probe);
  }
  return b;
}

/** Per-sample gain read from a channel that carries only the probe. */
function probeGain(out: Float32Array, probe = 1e-5): Float32Array {
  const g = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) g[i] = out[i] / (i % 2 ? -probe : probe);
  return g;
}

describe('Transient Processor', () => {
  it('is registered with FL ranges, defaults, value texts and presets', () => {
    const d = fxDef('transient')!;
    expect(d.width).toBe(547);
    expect(d.height).toBe(318);
    expect(d.params.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const p = defaultFxParams('transient');
    expect(p).toMatchObject({ attack: 80, drive: 0, release: 80, gain: 80, attackShape: 1, releaseShape: 1, splitFreq: 80, splitBal: 80, effect: 1 });
    // texts read from FL's plugin (flfxhost sweep)
    expect(text('attack', 0)).toBe('-100%');
    expect(text('attack', 38)).toBe('-53%');
    expect(text('attack', 80)).toBe('0%');
    expect(text('drive', 92)).toBe('58%');
    expect(text('gain', 0)).toBe('-9.0 dB');
    expect(text('gain', 52)).toBe('-3.2 dB');
    expect(text('gain', 124)).toBe('4.9 dB');
    expect(text('splitFreq', 80)).toBe('253.8 Hz');
    expect(text('splitFreq', 144)).toBe('810.9 Hz');
    expect(text('splitBal', 80)).toBe('100% Wet');
    expect(text('splitBal', 2)).toBe('2% Wet');
    expect(text('splitBal', 86)).toBe('92% Dry');
    expect(text('attackShape', 2)).toBe('Slow');
    expect(d.presets?.map((q) => q.name)).toContain('Max transients');
    expect(d.presets?.find((q) => q.name === 'Overdiven')?.params).toMatchObject({ attack: 120, drive: 110, release: 160, gain: 53 });
  });

  it('is transparent at the default settings', () => {
    const fx = make();
    const x = tone([[0, 0.05], [0.3, 0.3]], 440, 0);
    const [L] = render(fx, x);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(L[i] - x[i]));
    // only the drive-0 soft clipper (k = 0.1) bends a 0.3 peak: x - 0.003 x^3
    expect(err).toBeLessThan(1e-4);
    expect(fx.latency ?? 0).toBe(0);
  });

  it('splits with a first-order highpass / complementary lowpass at the split frequency', () => {
    for (const [f, wetDb] of [[253.8, -3.01], [100, -8.75], [1000, -0.27]] as const) {
      const fx = make({ splitBal: 160 });
      const x = tone([[0.1, 1]], f, 0);
      const [L] = render(fx, x);
      expect(20 * Math.log10(rms(L, SR / 2) / rms(x, SR / 2))).toBeCloseTo(wetDb, 1);
    }
    const fx = make({ splitBal: 0 });
    const x = tone([[0.1, 1]], 253.8, 0);
    const [L] = render(fx, x);
    expect(20 * Math.log10(rms(L, SR / 2) / rms(x, SR / 2))).toBeCloseTo(-3.01, 1);
  });

  it('boosts onsets with positive attack up to FL\'s 3.24x ceiling and cuts them with negative attack', () => {
    const x = tone([[0, 1], [0.1, 0.5]], 1500);
    const up = make({ attack: 160, splitFreq: 0, splitBal: 160 });
    const [, Ru] = render(up, x, x.map((_, i) => (i % 2 ? -1e-5 : 1e-5)));
    const gu = probeGain(Ru);
    const on = SR;
    let mx = 0;
    for (let i = on; i < on + 2000; i++) mx = Math.max(mx, gu[i]);
    expect(mx).toBeGreaterThan(3.0);
    expect(mx).toBeLessThan(3.25);
    expect(20 * Math.log10(gu[on + Math.round(0.3 * SR)])).toBeLessThan(0.5); // settles near 0 dB
    const dn = make({ attack: 0, splitFreq: 0, splitBal: 160 });
    const [, Rd] = render(dn, x, x.map((_, i) => (i % 2 ? -1e-5 : 1e-5)));
    const gd = probeGain(Rd);
    expect(20 * Math.log10(gd[on + 24])).toBeLessThan(-12);
    expect(20 * Math.log10(gd[on + Math.round(0.3 * SR)])).toBeGreaterThan(-1);
  });

  it('cuts decays with negative release exactly like FL (two-envelope ratio)', () => {
    // FL, Mid shape: 1 / gain - 1 = 0.0790 / 0.3505 / 0.8218 / 2.3151 at 160 / 640 / 1280 / 2560 samples after a drop to silence
    const x = tone([[0, 0.2], [0.1, 0.5], [0, 0.2]], 1500);
    const fx = make({ release: 0, splitFreq: 0, splitBal: 160 });
    const pr = x.map((_, i) => (i % 2 ? -1e-5 : 1e-5));
    const [, R] = render(fx, x, pr);
    const g = probeGain(R);
    const off = Math.round(0.7 * SR);
    const ref: [number, number][] = [[160, 0.079], [640, 0.3505], [1280, 0.8218], [2560, 2.3151]];
    for (const [k, d] of ref) expect(1 / g[off + k] - 1).toBeCloseTo(d, 1);
  });

  it('adds attack and release contributions (FL: s = a^2 Da + r^2 Dr, gain = 1 + s or 1 / (1 - s))', () => {
    const x = tone([[0, 0.5], [0.1, 0.4], [0, 0.4]], 1500);
    const pr = x.map((_, i) => (i % 2 ? -1e-5 : 1e-5));
    const g = (p: Record<string, number>) => probeGain(render(make({ splitFreq: 0, splitBal: 160, ...p }), x, pr)[1]);
    const ga = g({ attack: 40 }), gr = g({ release: 0 }), gb = g({ attack: 40, release: 0 });
    const inv = (v: number) => (v >= 1 ? v - 1 : 1 - 1 / v);
    for (const i of [Math.round(0.52 * SR), Math.round(0.95 * SR), Math.round(1.0 * SR)]) {
      const s = inv(ga[i]) + inv(gr[i]);
      const want = s >= 0 ? 1 + s : 1 / (1 - s);
      expect(gb[i]).toBeCloseTo(want, 4);
    }
  });

  it('saturates with FL\'s drive curve: ceiling 1/k (k = 0.1 .. 15)', () => {
    expect(driveK(0)).toBeCloseTo(0.1, 6);
    expect(driveK(16)).toBeCloseTo(1, 6);
    expect(driveK(40)).toBeCloseTo(1.5704, 3); // FL fit 1.570391
    expect(driveK(160)).toBeCloseTo(15, 6);
    expect(satCurve(3)).toBe(1);
    expect(satCurve(0.75)).toBeCloseTo(0.6447, 3); // FL: 0.6446
    // FL measured output ceilings: drive 40 -> 0.6368, 80 -> 0.3001, 160 -> 0.0668
    for (const [drive, ceil] of [[40, 0.6368], [80, 0.3001], [160, 0.0668]] as const) {
      const fx = make({ drive, splitFreq: 0, splitBal: 160 });
      const [L] = render(fx, tone([[2, 0.3]], 997, 0));
      expect(peak(L, SR * 0.1)).toBeCloseTo(ceil, 3);
    }
  });

  it('applies the output gain (+-9 dB) and the split balance linearly', () => {
    const x = tone([[0.1, 0.4]], 3000, 0);
    const lo = render(make({ gain: 0 }), x)[0], hi = render(make({ gain: 160 }), x)[0];
    expect(20 * Math.log10(rms(lo, SR / 5) / rms(x, SR / 5))).toBeCloseTo(-9, 1);
    expect(20 * Math.log10(rms(hi, SR / 5) / rms(x, SR / 5))).toBeCloseTo(9, 1);
    const half = render(make({ splitBal: 40, splitFreq: 0 }), x)[0];
    expect(rms(half, SR / 5) / rms(x, SR / 5)).toBeCloseTo(0.5, 2);
  });

  it('smooths parameter changes like FL (one-pole, about 17 ms)', () => {
    const fx = make();
    const x = tone([[0.25, 0.5]], 3000, 0);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const ctx = makeCtx();
    for (let i = 0; i < 4800; i += 128) fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, ctx);
    fx.setParams({ ...defaultFxParams('transient'), gain: 0 });
    for (let i = 4800; i < L.length; i += 128) fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i), ctx);
    const db = (a: number) => 20 * Math.log10(rms(L, a, a + 96) / rms(x, a, a + 96));
    // FL: -3.97 dB 10 ms after the change, -8.5 dB at 50 ms, -9.0 dB at 200 ms
    expect(db(4800 + 480)).toBeGreaterThan(-5.2);
    expect(db(4800 + 480)).toBeLessThan(-2.8);
    expect(db(4800 + 2400)).toBeCloseTo(-8.5, 0);
    expect(db(4800 + 9600)).toBeCloseTo(-9, 1);
    // no step at the change itself
    expect(Math.abs(db(4800) - db(4800 - 96))).toBeLessThan(0.6);
  });

  it('bypasses with Effect off', () => {
    const x = tone([[0.5, 0.3]], 500, 0);
    const [L] = render(make({ effect: 0, attack: 160, drive: 160, gain: 0 }), x);
    for (let i = 0; i < x.length; i += 97) expect(L[i]).toBeCloseTo(x[i], 6);
  });

  it('stays silent on silence and finite at extreme settings', () => {
    const z = new Float32Array(SR / 2);
    const [L] = render(make({ attack: 160, release: 160, gain: 160, drive: 160 }), z);
    expect(peak(L)).toBe(0);
    const n = SR;
    const noise = new Float32Array(n);
    let s = 1;
    for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; noise[i] = (s / 2147483647 - 0.5) * (i < n / 2 ? 8 : 1e-12); }
    for (const p of [{ attack: 160, release: 160, attackShape: 0, releaseShape: 0 }, { attack: 0, release: 0, attackShape: 2, releaseShape: 2 }, { attack: 160, release: 0, gain: 160, drive: 0, splitFreq: 160 }]) {
      const fx = make(p);
      const [A, B] = render(fx, noise);
      for (let i = 0; i < n; i++) if (!Number.isFinite(A[i]) || !Number.isFinite(B[i])) throw new Error('non-finite output');
      expect(peak(A)).toBeLessThan(1000);
      const m = fx.monitor!();
      expect(Array.isArray(m!.gIn)).toBe(true);
    }
    expect(make().tail).toBe(2);
  });
});
