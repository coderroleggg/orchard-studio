import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import {
  MB_PARAMS, MB_PRESETS, mbAttackHz, mbFreqHz, mbFreqValue, mbKneeW, mbMasterGain, mbOutGain,
} from '../../src/model/fx/plugins/mbcompressor';
import { mbFirKernel, mbGain, mbPole, MB_FIR_HALF } from '../../src/engine/effects/plugins/mbcompressor';
import { makeCtx } from './util';

// Reference numbers measured on FL Studio 2026's Fruity Multiband Compressor with
// flfxhost (docs/research/fx/mbcompressor.md).

const SR = 44100;
const KEY = (idx: number) => MB_PARAMS.find((p) => p.index === idx)!.key;

function render(over: Record<number, number>, L: Float32Array, R: Float32Array = Float32Array.from(L), extra: Record<string, unknown> = {}) {
  const st: Record<string, unknown> = { ...defaultFxParams('mbcompressor'), ...extra };
  for (const [k, v] of Object.entries(over)) st[KEY(Number(k))] = v;
  const fx = createEffect('mbcompressor', SR, 128);
  fx.setParams(st);
  fx.reset();
  const ctx = makeCtx({ sampleRate: SR });
  for (let i = 0; i < L.length; i += 128) fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i), ctx);
  return { fx, L, R };
}

const sine = (f: number, amp: number, n = SR) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));
const db = (d: number) => Math.pow(10, d / 20);
const rms = (b: Float32Array, a = SR / 2) => { let s = 0; for (let i = a; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / (b.length - a)); };
const peak = (b: Float32Array, a = SR / 2) => { let m = 0; for (let i = a; i < b.length; i++) m = Math.max(m, Math.abs(b[i])); return m; };

describe('Multiband Compressor', () => {
  it('has FL parameters, defaults and value texts', () => {
    const d = fxDef('mbcompressor')!;
    expect(d.name).toBe('Multiband Compressor');
    expect(d.width).toBe(800);
    expect(d.height).toBe(155);
    expect(d.params.map((p) => p.index)).toEqual(Array.from({ length: 28 }, (_, i) => i));
    expect(d.params[0].name).toBe('Master volume');
    expect(d.params[20].name).toBe('Low band state');
    const txt = (idx: number, v: number) => formatParam(d.params[idx], v);
    // FL value texts (flfxhost sweeps)
    expect(txt(0, 32768)).toBe('0.0dB');
    expect(txt(0, 0)).toBe('-oo');
    expect(txt(0, 3)).toBe('-84.0dB');
    expect(txt(0, 65536)).toBe('9.5dB');
    expect(txt(5, 21845)).toBe('0.0dB');
    expect(txt(5, 871)).toBe('-31.1dB');
    expect(txt(5, 65536)).toBe('16.9dB');
    expect(txt(6, 45875)).toBe('-18.0dB');
    expect(txt(6, 61440)).toBe('-3.7dB');
    expect(txt(6, 65536)).toBe('0.0dB');
    expect(txt(15, 48875)).toBe('-15.3dB');
    expect(txt(7, 32768)).toBe('2.0:1');
    expect(txt(7, 54613)).toBe('6.0:1');
    expect(txt(7, 65535)).toBe('65536.0:1');
    expect(txt(7, 65536)).toBe('oo:1');
    expect(txt(8, 1)).toBe('0.1ms');
    expect(txt(9, 10000)).toBe('1000.0ms');
    expect(txt(10, 8192)).toBe('13%');
    expect(txt(10, 52429)).toBe('80%');
    expect(txt(4, 17000)).toBe('9237Hz');
    expect(txt(13, 6500)).toBe('300Hz');
    expect(txt(21, 20000)).toBe('20000Hz');
    expect(txt(3, 2)).toBe('bypassed');
    expect(txt(2, 1)).toBe('LP FIR');
  });

  it('carries FL factory presets', () => {
    expect(MB_PRESETS.length).toBe(31);
    expect(MB_PRESETS[0].name).toBe('Default');
    const def = defaultFxParams('mbcompressor');
    for (const p of MB_PARAMS) expect(MB_PRESETS[0].params[p.key]).toBe(def[p.key]);
    const m6 = MB_PRESETS.find((p) => p.name === 'Mastering 6dB')!.params;
    expect(m6.master).toBe(51773);
    expect(m6.limiter).toBe(1);
    expect(m6.filterType).toBe(1);
  });

  it('control laws (measured)', () => {
    expect(mbMasterGain(32768)).toBeCloseTo(1, 12);
    expect(mbOutGain(65536)).toBeCloseTo(7, 12);
    // cut-offs fitted to FL's impulse responses (Butterworth at the displayed frequency)
    expect(mbFreqHz(6500)).toBeCloseTo(300.296, 1);
    expect(mbFreqHz(12000)).toBeCloseTo(2157.594, 0);
    expect(mbFreqHz(17000)).toBeCloseTo(9236.65, -1);
    expect(mbFreqHz(20000)).toBeCloseTo(20000, -1);
    expect(mbFreqValue(300.3)).toBe(6500);
    // attack: prewarped one-pole poles measured with step responses
    expect(mbPole(mbAttackHz(1), SR)).toBeCloseTo(-0.45327, 3);
    expect(mbPole(mbAttackHz(10), SR)).toBeCloseTo(0.86157, 4);
    expect(mbPole(mbAttackHz(100), SR)).toBeCloseTo(0.98581, 4);
    // knee: threshold +- (0.005 + r t); at -54 dB, ratio oo, knee 100 %, a DC level at t/4 gets s = 0.3075
    const t = db(-54);
    const g = mbGain(0.25 * t, t, 1, mbKneeW(65536, t));
    expect(1 / g - 1).toBeCloseTo(0.3075, 2);
    // FIR: unnormalised windowed trapezoid low-pass (FL's IR at 300 Hz sums to 0.672)
    const k = mbFirKernel(300.296, SR);
    let s = k[0];
    for (let i = 1; i <= MB_FIR_HALF; i++) s += 2 * k[i];
    expect(s).toBeCloseTo(0.672, 2);
    expect(k[0]).toBeCloseTo(0.013619, 5);
  });

  it('matches FL levels', () => {
    // default settings (FL: rms / peak from 0.5 s)
    const a = render({}, sine(1000, db(-6)));
    expect(rms(a.L)).toBeCloseTo(0.18485, 3);
    expect(peak(a.L)).toBeCloseTo(0.26138, 3);
    const b = render({}, sine(100, db(-3)));
    expect(rms(b.L)).toBeCloseTo(0.16040, 3);
    expect(peak(b.L)).toBeCloseTo(0.22746, 3);
    const c = render({}, sine(8000, db(-10)));
    expect(rms(c.L)).toBeCloseTo(0.24186, 3);
    // FIR split
    const d = render({ 2: 1 }, sine(1000, db(-6)));
    expect(d.fx.latency).toBe(52);
    expect(rms(d.L)).toBeCloseTo(0.18270, 3);
    expect(peak(d.L)).toBeCloseTo(0.25835, 3);
    // soft knee, ratio oo
    const e = render({ 19: 0, 16: 65536 }, sine(1000, db(-6)));
    expect(rms(e.L)).toBeCloseTo(0.12530, 3);
    // low threshold widens the knee: -54 dB, oo:1, hard knee, 50 Hz at -40 dB
    const f = render({ 11: 1, 3: 1, 23: 6554, 24: 65536, 27: 65536 }, sine(50, db(-40)));
    expect(rms(f.L)).toBeCloseTo(0.00147, 4);
    // limiter on the bypassed bands
    const l = render({ 1: 1, 3: 2, 11: 2, 20: 2 }, sine(100, 1.5));
    expect(rms(l.L)).toBeCloseTo(0.73885, 2);
    expect(peak(l.L)).toBeCloseTo(0.97545, 2);
    expect(peak(l.L, 0)).toBeLessThanOrEqual(0.99999);
    // FL output samples (default, 1 kHz at -6 dB)
    const ref = [0.20070602, 0.17491435, 0.14557895, 0.11329415, 0.0787142];
    for (let i = 0; i < 5; i++) expect(a.L[30000 + i]).toBeCloseTo(ref[i], 3);
  });

  it('band states, output gains and master volume', () => {
    const dc = () => new Float32Array(SR / 2).fill(0.5);
    // DC passes the low band only: bypass keeps the output gain, mute silences
    expect(render({ 3: 1, 11: 1, 20: 2 }, dc()).L[SR / 2 - 1]).toBeCloseTo(0.5, 4);
    expect(render({ 3: 1, 11: 1, 20: 2, 22: 65536 }, dc()).L[SR / 2 - 1]).toBeCloseTo(3.5, 3);
    expect(render({ 3: 1, 11: 1, 20: 1 }, dc()).L[SR / 2 - 1]).toBe(0);
    expect(render({ 3: 1, 11: 1, 20: 2, 0: 65536 }, dc()).L[SR / 2 - 1]).toBeCloseTo(1.5, 3);
    // master volume comes before the limiter (FL: 0.5 * 3 -> 0.97277)
    expect(render({ 3: 1, 11: 1, 20: 2, 0: 65536, 1: 1 }, dc()).L[SR / 2 - 1]).toBeCloseTo(0.97277, 3);
    // the band detector is stereo linked, the limiter is not
    const L = new Float32Array(20000).fill(0.6), R = new Float32Array(20000).fill(-0.3);
    const lk = render({ 11: 1, 3: 1, 24: 65536, 27: 65536 }, L, R);
    expect(lk.R[19999] / lk.L[19999]).toBeCloseTo(-0.5, 3);
  });

  it('is robust and click-free', () => {
    const s = render({}, new Float32Array(SR / 4));
    expect(peak(s.L, 0)).toBe(0);
    const hot = Float32Array.from({ length: SR / 4 }, (_, i) => (i % 100 < 3 ? 30 : -0.7));
    for (const ft of [0, 1]) for (const lim of [0, 1]) {
      const r = render({ 2: ft, 1: lim }, Float32Array.from(hot));
      for (let i = 0; i < r.L.length; i++) expect(Number.isFinite(r.L[i])).toBe(true);
      if (lim) expect(peak(r.L, 0)).toBeLessThanOrEqual(0.99999);
    }
    // NaN input does not poison the state
    const fx = createEffect('mbcompressor', SR, 128);
    fx.setParams(defaultFxParams('mbcompressor'));
    const ctx = makeCtx({ sampleRate: SR });
    const bad = new Float32Array(128).fill(NaN);
    fx.process(bad, Float32Array.from(bad), 128, ctx);
    const x = sine(440, 0.3, 4096), y = Float32Array.from(x);
    for (let i = 0; i < 4096; i += 128) fx.process(x.subarray(i, i + 128), y.subarray(i, i + 128), 128, ctx);
    expect(Number.isFinite(x[4000]) && Math.abs(x[4000]) < 1).toBe(true);
    // gain changes ramp over a block
    const fx2 = createEffect('mbcompressor', SR, 128);
    const st = defaultFxParams('mbcompressor');
    fx2.setParams(st);
    fx2.reset();
    const z = sine(200, 0.2, 8192), w = Float32Array.from(z);
    for (let i = 0; i < 4096; i += 128) fx2.process(z.subarray(i, i + 128), w.subarray(i, i + 128), 128, ctx);
    fx2.setParams({ ...st, master: 65536 });
    for (let i = 4096; i < 8192; i += 128) fx2.process(z.subarray(i, i + 128), w.subarray(i, i + 128), 128, ctx);
    let maxStep = 0;
    for (let i = 4097; i < 4300; i++) maxStep = Math.max(maxStep, Math.abs(z[i] - z[i - 1]));
    expect(maxStep).toBeLessThan(0.05);
  });

  it('reports monitor data for the editor', () => {
    const r = render({}, sine(1000, 0.5, 8192));
    const m = (r.fx as { monitor(): Record<string, unknown> }).monitor();
    expect((m.chunks as number[]).length).toBe(2 * Math.floor(8192 / 256));
    expect((m.bIn as number[]).length).toBe(6);
    expect((m.gain as number[])[1]).toBeLessThan(1);
  });

  it('applies changes at the next block and restarts a band detector when the band turns ON again (FL)', () => {
    const fx = createEffect('mbcompressor', SR, 128);
    const st = (over: Record<string, number>) => ({ ...defaultFxParams('mbcompressor'), lState: 2, mState: 2, hState: 2, ...over });
    fx.setParams(st({}));
    const ctx = makeCtx({ sampleRate: SR });
    const blk = (x: number) => { const L = new Float32Array(128).fill(x), R = new Float32Array(128).fill(x); fx.process(L, R, 128, ctx); return L; };
    for (let i = 0; i < 20; i++) blk(0.2);
    const before = blk(0.2)[127];
    fx.setParams(st({ master: 50000 }));
    const after = blk(0.2)[0];
    expect(after / before).toBeCloseTo((Math.pow(2, 50000 / 32768) - 1) / (Math.pow(2, 1) - 1), 5);
    // high band ON compressing a sine, muted, then ON again: it comes back with its detector at rest (louder)
    const fx2 = createEffect('mbcompressor', SR, 128);
    const sq = (over: Record<string, number>) => ({ ...defaultFxParams('mbcompressor'), lState: 1, mState: 1, hThres: 20000, ...over });
    fx2.setParams(sq({}));
    const s = sine(12000, 0.5, SR);
    const run2 = (a: number, b: number) => { const L = s.slice(a, b), R = s.slice(a, b); for (let i = 0; i < L.length; i += 128) fx2.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i), ctx); return L; };
    run2(0, 8192);
    const steady = run2(8192, 8192 + 1024);
    fx2.setParams(sq({ hState: 1 }));
    run2(9216, 9216 + 1024);
    fx2.setParams(sq({}));
    const back = run2(10240, 10240 + 1024);
    const pk = (b: Float32Array, a: number, z: number) => { let m = 0; for (let i = a; i < z; i++) m = Math.max(m, Math.abs(b[i])); return m; };
    expect(pk(back, 0, 64)).toBeGreaterThan(1.2 * pk(steady, 512, 1024));
  });
});
