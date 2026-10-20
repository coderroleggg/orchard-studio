import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { def as tpDef, levelGain, ratioBeats } from '../../src/model/fx/plugins/transporter';
import { makeCtx, peak, rms } from './util';

const SR = 44100;
const D = 220; // FL's reported latency at 44.1 kHz (5 ms lookahead)
const text = (key: string, v: number) => formatParam(tpDef.params.find((p) => p.key === key)!, v);

function make(over: Record<string, unknown> = {}) {
  const fx = createEffect('transporter', SR, 128);
  fx.setParams({ ...defaultFxParams('transporter'), ...over });
  fx.reset();
  return { fx, p: { ...defaultFxParams('transporter'), ...over } };
}

/**
 * Feed a slow ramp (the read position can be read back from the output:
 * value = time / 2) into loop A only (dry and B off, A panned centre = 0.5),
 * pulsing "Update loop A" at the given times. Returns the decoded input time
 * played at each output sample (NaN where the loop is silent).
 */
function playback(over: Record<string, unknown>, triggers: number[], seconds: number): Float64Array {
  const { fx, p } = make({ dry: 0, levelB: 0, sens: 0, ...over });
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  const L = new Float32Array(128), R = new Float32Array(128);
  const ctx = makeCtx();
  const trig = triggers.map((t) => Math.round(t * SR));
  for (let b = 0; b < n; b += 128) {
    const m = Math.min(128, n - b);
    for (const t of trig) {
      if (t >= b && t < b + m) {
        fx.setParams({ ...p, updA: 1 });
        fx.setParams({ ...p, updA: 0 });
      }
    }
    for (let i = 0; i < m; i++) { L[i] = (b + i) / SR / 2; R[i] = 0; }
    fx.process(L.subarray(0, m), R.subarray(0, m), m, ctx);
    for (let i = 0; i < m; i++) out[b + i] = L[i] === 0 ? NaN : (L[i] / 0.5) * 2;
  }
  return out;
}

describe('Transporter', () => {
  it('is registered with FL parameters, defaults and presets', () => {
    const d = fxDef('transporter')!;
    expect(d.name).toBe('Transporter');
    expect([d.width, d.height]).toEqual([740, 366]);
    expect(d.params.length).toBe(22);
    d.params.forEach((p, i) => expect(p.index).toBe(i));
    const p = defaultFxParams('transporter');
    expect(p.minLen).toBe(500);
    expect(p.ratio).toBe(8);
    expect(p.tempoTrig).toBe(21);
    expect(d.presets?.map((q) => q.name)).toEqual(['Basic reverser', 'Beatdrifter', 'Default', 'Flashbacker', 'Octavary', 'Radpad']);
  });

  it('shows FL value texts', () => {
    expect(text('dry', 12800)).toBe('0.0dB');
    expect(text('dry', 0)).toBe('-InfdB');
    expect(text('dry', 6400)).toBe('-12.7dB');
    expect(text('dry', 1)).toBe('-94.5dB');
    expect(text('reverse', 4600)).toBe('0.46');
    expect(text('spread', 520)).toBe('0.02');
    expect(text('minLen', 500)).toBe('0.50');
    expect(text('minLen', 25)).toBe('0.02');
    expect(text('minLen', 35)).toBe('0.04');
    expect(text('ratio', 8)).toBe('3.00');
    expect(text('sens', 1000)).toBe('0.98');
    expect(text('mode', 2)).toBe('ADAPTIVE');
    expect(text('tempoLen', 20)).toBe('1/16 quint.');
    expect(text('tempoTrig', 21)).toBe('Off');
    expect(levelGain(6400)).toBeCloseTo(0.2317, 4); // (11^0.5 - 1) / 10
    expect(ratioBeats(0)).toBe(4);
    expect(ratioBeats(6)).toBe(6);
  });

  it('reports 5 ms of latency and passes the dry signal aligned', () => {
    const { fx } = make({ levelA: 0, levelB: 0 });
    expect(fx.latency).toBe(D);
    const L = new Float32Array(1024), R = new Float32Array(1024);
    L[10] = 0.7; R[10] = -0.3;
    fx.process(L.subarray(0, 512), R.subarray(0, 512), 512, makeCtx());
    expect(L[10 + D]).toBeCloseTo(0.7, 5);
    expect(R[10 + D]).toBeCloseTo(-0.3, 5);
  });

  it('loops the audio between the last two triggers (FL: [tPrev, t] repeated)', () => {
    // trigger at 0.5 s (previous = start): loop [0, 0.5) plays from 0.5 s + latency
    const pos = playback({ minLen: 20 }, [0.5], 2.0);
    const at = (t: number) => pos[Math.round(t * SR) + D];
    expect(at(0.3)).toBeNaN(); // silent before the first loop
    expect(at(0.6)).toBeCloseTo(0.1, 2);
    expect(at(0.9)).toBeCloseTo(0.4, 2);
    expect(at(1.1)).toBeCloseTo(0.1, 2); // second cycle
    expect(at(1.7)).toBeCloseTo(0.2, 2);
    // a second trigger at 1.2 s: loop [0.5, 1.2)
    const p2 = playback({ minLen: 20 }, [0.5, 1.2], 2.5);
    expect(p2[Math.round(1.3 * SR) + D]).toBeCloseTo(0.6, 2);
    expect(p2[Math.round(2.0 * SR) + D]).toBeCloseTo(0.6, 2); // 1.3 + 0.7
  });

  it('honours the minimum length for transient triggers', () => {
    // clicks every 0.3 s on a sweep: loop A (min 0.5 s) only takes every other one
    const { fx } = make({ dry: 0, levelB: 0, minLen: 500 });
    const n = Math.round(2.0 * SR);
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      L[i] = R[i] = 0.25 * Math.sin(2 * Math.PI * 200 * (Math.pow(2, t) - 1) / Math.LN2);
    }
    for (const c of [0.2, 0.5, 0.8, 1.1, 1.4]) for (let k = 0; k < 40; k++) { const v = 0.9 * 0.5 * (1 - Math.cos((2 * Math.PI * k) / 39)); L[Math.floor(c * SR) + k] += v; R[Math.floor(c * SR) + k] += v; }
    const ctx = makeCtx();
    for (let b = 0; b < n; b += 128) fx.process(L.subarray(b, b + 128), R.subarray(b, b + 128), Math.min(128, n - b), ctx);
    // FL: silent until 0.5 s, then loop [0, 0.5); at 1.1 s loop [0.5, 1.1)
    expect(rms(L, Math.round(0.1 * SR), Math.round(0.45 * SR))).toBeLessThan(1e-4);
    expect(rms(L, Math.round(0.6 * SR), Math.round(0.9 * SR))).toBeGreaterThan(0.03);
  });

  it('shrinks Bouncing cycles by exp(-rate/2) each cycle', () => {
    // FL, rate 0.5: 0.5, 0.39, 0.30, 0.24 s ...
    const pos = playback({ mode: 1, bounce: 768, minLen: 500 }, [1.0], 3.2);
    // each wrap is softened by FL's lookahead dip: a short silent gap
    const wraps: number[] = [];
    let inGap = false;
    for (let i = Math.round(1.0 * SR) + D + 400; i < pos.length; i++) {
      const silent = Number.isNaN(pos[i]);
      if (silent && !inGap) wraps.push(i);
      inGap = silent;
    }
    const cyc = wraps.slice(0, 3).map((w, k, a) => (k === 0 ? (w - (Math.round(1.0 * SR) + D)) / SR : (w - a[k - 1]) / SR));
    expect(cyc[0]).toBeCloseTo(0.5, 1);
    expect(cyc[1] / cyc[0]).toBeCloseTo(Math.exp(-0.25), 1);
    expect(cyc[2] / cyc[1]).toBeCloseTo(Math.exp(-0.25), 1);
  });

  it('plays reversed segments backwards and octave-up segments at double speed', () => {
    const rev = playback({ minLen: 20, reverse: 10000 }, [0.5], 1.2);
    const i0 = Math.round(0.6 * SR) + D;
    expect(rev[i0 + 4410] - rev[i0]).toBeLessThan(-0.09); // backwards at speed 1
    const up = playback({ minLen: 20, shift: 10000, downUp: 10000 }, [1.0], 1.6);
    const j0 = Math.round(1.1 * SR) + D;
    expect(up[j0 + 4410] - up[j0]).toBeCloseTo(0.2, 2); // 0.1 s of output = 0.2 s of input
  });

  it('pans loop A left with positive spread and auto-pans at 20*|spread| Hz', () => {
    const run = (spread: number) => {
      const { fx } = make({ dry: 0, levelB: 0, minLen: 20, spread });
      const n = Math.round(1.5 * SR);
      const L = new Float32Array(n), R = new Float32Array(n);
      for (let i = 0; i < n; i++) L[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / SR);
      const ctx = makeCtx();
      for (let b = 0; b < n; b += 128) {
        if (b === Math.round(0.5 * SR / 128) * 128) { fx.setParams({ ...defaultFxParams('transporter'), dry: 0, levelB: 0, minLen: 20, spread, updA: 1 }); }
        fx.process(L.subarray(b, b + 128), R.subarray(b, b + 128), Math.min(128, n - b), ctx);
      }
      return [rms(L, Math.round(0.7 * SR), Math.round(1.4 * SR)), rms(R, Math.round(0.7 * SR), Math.round(1.4 * SR))];
    };
    const [l1, r1] = run(1024);
    expect(r1).toBeLessThan(l1 * 0.01); // FL: hard left at +1
    const [l2, r2] = run(768);
    expect(l2 / r2).toBeCloseTo(3, 1); // FL: 0.1334 / 0.0445
  });

  it('bypasses, flushes, and stays finite and quiet for silence', () => {
    const { fx } = make({ bypass: 1 });
    const L = new Float32Array(512).fill(0.4), R = new Float32Array(512).fill(-0.2);
    fx.process(L, R, 512, makeCtx());
    expect(L[300]).toBeCloseTo(0.4, 5);
    // silence in -> silence out
    const q = make();
    const z = new Float32Array(SR), zr = new Float32Array(SR);
    for (let b = 0; b < SR; b += 128) q.fx.process(z.subarray(b, b + 128), zr.subarray(b, b + 128), 128, makeCtx());
    expect(peak(z)).toBe(0);
    // extremes with noise, flush mid-way
    const ex = make({ sens: 1024, minLen: 20, ratio: 36, reverse: 10000, shift: 10000, downUp: 5000, spread: 0, mode: 1, bounce: 0, tempoTrig: 5, ignoreBias: 3000, prob: 1 });
    const n = 2 * SR;
    const a = new Float32Array(n), b2 = new Float32Array(n);
    let s = 7;
    for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = ((s / 2 ** 32) * 2 - 1) * 0.9; b2[i] = -a[i]; }
    const ctx = makeCtx();
    for (let i = 0; i < n; i += 128) {
      if (i === SR) { ex.fx.setParams({ ...ex.p, flush: 1 }); ex.fx.setParams({ ...ex.p, flush: 0 }); }
      ex.fx.process(a.subarray(i, i + 128), b2.subarray(i, i + 128), Math.min(128, n - i), ctx);
    }
    let finite = true;
    for (let i = 0; i < n; i++) if (!Number.isFinite(a[i]) || !Number.isFinite(b2[i])) finite = false;
    expect(finite).toBe(true);
    expect(peak(a)).toBeLessThan(10);
    expect(ex.fx.tail).toBeGreaterThan(0);
    expect(ex.fx.tail).toBeLessThanOrEqual(30);
  });
});
