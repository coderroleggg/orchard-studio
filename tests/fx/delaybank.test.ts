import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, normalizeFxParams } from '../../src/model/fx/registry';
import { dbCutoffHz, dbDefaultUnit, dbFilterAmp, dbGrainEnv, dbOffsetMs, dbSep, dbUnits, dbVol, type DbUnit } from '../../src/model/fx/plugins/delaybank';
import { makeCtx, render, peak } from './util';

// Reference numbers were measured from FL Studio 2026's Fruity Delay Bank
// with flfxhost (docs/research/fx/delaybank.md).

const SR = 44100;

function params(over: Record<string, unknown> = {}, units: Record<number, Partial<DbUnit>> = {}): Record<string, unknown> {
  const p = defaultFxParams('delaybank');
  const us = dbUnits(p.units);
  for (const [u, s] of Object.entries(units)) Object.assign(us[Number(u)], s);
  return { ...p, dry: 0, ...over, units: us };
}

function run(p: Record<string, unknown>, L: Float32Array, R: Float32Array = new Float32Array(L.length), tempo = 120, sr = SR) {
  const fx = createEffect('delaybank', sr, 128);
  fx.setParams(p);
  return { fx, out: render(fx, L, R, 128, { sampleRate: sr, tempo }) };
}

function impulse(n: number, at = 0, amp = 0.5): Float32Array {
  const b = new Float32Array(n);
  b[at] = amp;
  return b;
}

const taps = (b: Float32Array, thr = 1e-5) => Array.from(b).flatMap((v, i) => (Math.abs(v) > thr ? [[i, Number(v.toFixed(5))]] : []));

/** First-echo matrix of unit 1 (time 480 = 5512 samples) for L and R impulses. */
function matrix(over: Record<string, unknown>, units: Record<number, Partial<DbUnit>> = {}): number[] {
  const p = params({ u1Time: 480, ...over }, units);
  const l = run(p, impulse(6000)).out, r = run(p, new Float32Array(6000), impulse(6000)).out;
  return [l[0][5512] / 0.25, r[0][5512] / 0.25, l[1][5512] / 0.25, r[1][5512] / 0.25];
}

describe('Delay Bank', () => {
  it('is registered with FL ranges, the Default preset values, presets and texts', () => {
    const d = fxDef('delaybank')!;
    expect([d.width, d.height, d.params.length]).toEqual([580, 280, 131]);
    const p = defaultFxParams('delaybank');
    expect(p).toMatchObject({ dry: 128, wet: 128, input: 128, feedback: 128, u1Time: 1440, u1FbVol: 64, u1InCut: 33145, u1InRes: 17500, u1InGain: 0, u8OutVol: 128 });
    expect(p.u8Next).toBeUndefined();
    expect(dbUnits(p.units).map((u) => u.enable)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(dbUnits(p.units)[0]).toEqual(dbDefaultUnit(1));
    expect(d.presets?.length).toBe(21);
    expect(d.presets?.map((q) => q.name)).toContain('Ringy modder');
    const f = (k: string, v: number) => formatParam(d.params.find((q) => q.key === k)!, v);
    expect(f('dry', 16)).toBe('13%');
    expect(f('u1InPan', -80)).toBe('62% left'); // pans round half to even
    expect(f('u1InPan', 0)).toBe('Centered');
    expect(f('u1InVol', -144)).toBe('-113%');
    expect(f('u1InCut', 8192)).toBe('13%');
    expect(f('u1InGain', 0)).toBe('10%');
    expect(f('u1InGain', 256)).toBe('200%');
    expect(f('u1Time', 1445)).toBe('3:00');
    expect(f('u1Time', 12)).toBe('0:01');
    expect(f('u1Time', 9)).toBe('0:00');
    expect(f('u1Ofs', -256)).toBe('15.3ms left');
    expect(f('u1Ofs', 0)).toBe('0.0ms right');
    expect(f('u2Next', 160)).toBe('125%');
  });

  it('repairs stored states and keeps preset units', () => {
    const n = normalizeFxParams('delaybank', { units: [{ enable: 0, mode: 9 }] });
    expect(dbUnits(n.units)[0]).toMatchObject({ enable: 0, mode: 3, tempo: 1 });
    expect(n.solo).toBe(-1);
    const big = fxDef('delaybank')!.presets!.find((q) => q.name === 'Big res')!;
    expect(dbUnits(big.params.units)[3]).toMatchObject({ enable: 1, mode: 3, div: 13, shape: -14, leave: 1, fbType: 1 });
    expect(big.params.u4Time).toBe(2880);
  });

  it('maps volumes, separation, filters and offsets like FL', () => {
    expect(dbVol(128)).toBeCloseTo(1, 9);
    expect(dbVol(64)).toBeCloseTo(0.23166, 5);
    expect(dbVol(-160)).toBeCloseTo(-1.90328, 4);
    expect(dbSep(64)[1]).toBeCloseTo(0.154508, 6);
    expect(dbSep(-64)).toEqual([0.9375, -0.1875]);
    expect(dbCutoffHz(1, 65536)).toBe(20000);
    expect(dbCutoffHz(1, 0)).toBeCloseTo(132.3, 6);
    expect(dbCutoffHz(2, 0)).toBeCloseTo(4.4079, 6);
    expect(dbFilterAmp(0)).toBeCloseTo(0.1, 9);
    expect(dbFilterAmp(256)).toBeCloseTo(2, 9);
    expect(dbOffsetMs(-256)).toBeCloseTo(15.32, 2); // 676 samples at 44.1 kHz
    expect(dbGrainEnv(0.25, 0)).toBeCloseTo(0.5, 9);
    expect(dbGrainEnv(0.25, -128)).toBeCloseTo(0.00990, 4); // measured 0.00993
    expect(dbGrainEnv(0.25, 128)).toBeCloseTo(0.99010, 4); // measured 0.99013
  });

  it('echoes at round-half-even samples, first echo through the feedback section', () => {
    expect(taps(run(params(), impulse(40000)).out[0]).slice(0, 2)).toEqual([[16538, 0.25], [33076, 0.125]]);
    expect(taps(run(params({}, { 0: { leave: 1 } }), impulse(40000)).out[0]).slice(0, 2)).toEqual([[16538, 0.5], [33076, 0.25]]);
    expect(taps(run(params({ u1Time: 1 }), impulse(100)).out[0]).slice(0, 2)).toEqual([[11, 0.25], [22, 0.125]]);
    expect(taps(run(params({ u1Time: 0 }), impulse(100)).out[0]).slice(0, 2)).toEqual([[1, 0.25], [2, 0.125]]);
    expect(taps(run(params({ u1Time: 1445 }), impulse(22000), undefined, 97).out[0])[0][0]).toBe(20530);
    // tempo-based time off: FL's fixed 120 BPM
    expect(taps(run(params({}, { 0: { tempo: 0 } }), impulse(20000), undefined, 97).out[0])[0][0]).toBe(16538);
    // global feedback and feedback volume are linear
    const fb = taps(run(params({ feedback: 86, u1FbVol: 128, u1Time: 480 }, { 0: { leave: 1 } }), impulse(12000)).out[0]);
    expect(fb[1][1] / fb[0][1]).toBeCloseTo(86 / 128, 4);
  });

  it('offsets one input side; inverted and ping-pong routing match FL', () => {
    const o = run(params({ u1Time: 480, u1Ofs: -256 }), impulse(7000), impulse(7000)).out;
    expect(taps(o[0])[0]).toEqual([6188, 0.25]);
    expect(taps(o[1])[0]).toEqual([5512, 0.25]);
    const inv = run(params({ u1Time: 480 }, { 0: { mode: 2 } }), impulse(12000)).out;
    expect(peak(inv[0])).toBe(0);
    expect(taps(inv[1]).slice(0, 2)).toEqual([[5512, 0.25], [11024, 0.125]]);
    const pp = run(params({ u1Time: 480 }, { 0: { mode: 3 } }), impulse(12000)).out;
    expect(taps(pp[1])[0]).toEqual([5512, 0.25]);
    expect(taps(pp[0])[0]).toEqual([11024, 0.125]);
    const ppl = run(params({ u1Time: 480 }, { 0: { mode: 3, leave: 1 } }), impulse(12000)).out;
    expect(taps(ppl[0])[0]).toEqual([5512, 0.5]);
    expect(taps(ppl[1])[0]).toEqual([11024, 0.25]);
  });

  it('feedback pan + separation give FL\'s matrices (pour limited by the separation)', () => {
    const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));
    near(matrix({ u1FbPan: 64, u1Sep: 64 }), [0.457577, 0.083619, 0.501603, 0.80496]);
    near(matrix({ u1FbPan: 64, u1Sep: -64 }), [0.507371, -0.101474, -0.020184, 1.000107]);
    near(matrix({ u1FbPan: 64, u1Sep: 128 }), [0.270598, 0.270598, 0.653281, 0.653281]);
    near(matrix({ u1FbPan: 64, u1Sep: 112 }), [0.332238, 0.208958, 0.653281, 0.653281]);
    near(matrix({ u1FbPan: -64, u1Sep: 112 }), [0.653281, 0.653281, 0.208958, 0.332238]);
    near(matrix({ u1FbPan: 96, u1Sep: 96 }), [0.195071, 0.080828, 0.69352, 0.69352]);
    near(matrix({ u1InPan: 64 }, { 0: { leave: 1 } }).map((v) => v / 2), [0.541196, 0, 0.299728, 1.006835]);
  });

  it('feedback mode off passes the input (no offset, no feedback section)', () => {
    const o = run(params({ u1Ofs: -256, u1FbVol: 0, u1FbPan: 64 }, { 0: { mode: 0 } }), impulse(2000), impulse(2000, 441)).out;
    expect(taps(o[0])).toEqual([[0, 0.5]]);
    expect(taps(o[1])).toEqual([[441, 0.5]]);
  });

  it('chains units through "to next" (before the output pan / volume) and solos outputs', () => {
    const u = { 0: { leave: 1 }, 1: { enable: 1, leave: 1 } };
    const base = { u1Time: 480, u1FbVol: 0, u1Next: 128, u2Time: 960, u2FbVol: 0 };
    expect(taps(run(params(base, u), impulse(20000)).out[0])).toEqual([[5512, 0.5], [11025, 0.5], [16537, 0.5]]);
    expect(taps(run(params({ ...base, u1Next: 64, u1OutVol: 0 }, u), impulse(20000)).out[0])).toEqual([[11025, 0.5], [16537, 0.11583]]);
    // unit 2's input volume does not scale what unit 1 sends
    expect(taps(run(params({ ...base, u2InVol: 64 }, u), impulse(20000)).out[0])).toEqual([[5512, 0.5], [11025, 0.11583], [16537, 0.5]]);
    expect(taps(run(params({ ...base, solo: 1 }, u), impulse(20000)).out[0])).toEqual([[11025, 0.5], [16537, 0.5]]);
    expect(taps(run(params(base, { ...u, 0: { leave: 1, enable: 0 } }), impulse(20000)).out[0])).toEqual([[11025, 0.5]]);
  });

  it('filters match FL (RBJ, direct form I, FL\'s dual / triple slopes, gain only for shelves / peak)', () => {
    const ir = (t: number, m: number, cut: number, res: number, gain: number) =>
      run(params({ u1InCut: cut, u1InRes: res, u1InGain: gain }, { 0: { mode: 0, inType: t, inMode: m } }), impulse(400)).out[0].map((v) => v / 0.5);
    const at = (h: Float32Array, idx: number[]) => idx.map((i) => h[i]);
    const near = (a: number[], b: number[], d = 5) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));
    near(at(ir(1, 1, 32768, 30000, 0), [0, 1, 2, 3, 10, 50, 100]), [5e-5, 0.000383, 0.001437, 0.003647, 0.050118, -0.002385, 0.000147]);
    near(at(ir(2, 2, 30000, 20000, 0), [0, 1, 2, 3, 10, 50, 100]), [0.000708, 0.003862, 0.010165, 0.018235, 0.043226, -0.013751, 0.005345]);
    near(at(ir(6, 1, 30000, 30000, 200), [0, 1, 2, 3, 10, 50, 100]), [1.009744, 0.019315, 0.018926, 0.018451, 0.013032, -0.012922, 0.007392]);
    near(at(ir(5, 0, 20000, 30000, 0), [0, 1, 2, 3, 10]), [0.898842, -0.181426, -0.143965, -0.114247, -0.022742]);
    near(at(ir(7, 2, 40000, 20000, 220), [0, 1, 2, 3, 10]), [2.646181, -0.477527, -0.36094, -0.268321, -0.013657], 4);
    const lp = ir(1, 0, 30000, 20000, 0), lpg = ir(1, 0, 30000, 20000, 256);
    expect(peak(lp.map((v, i) => v - lpg[i]))).toBe(0);
  });

  it('chops echoes with the grain envelope (period = exact echo time / division)', () => {
    const N = 44100, x = new Float32Array(N).fill(0.5);
    const e = run(params({ u1Time: 480 }, { 0: { mode: 0, div: 1 } }), x).out[0].map((v) => v / 0.5);
    // grain starts at round(k x 5512.5) from the plugin start; quarter / half values like FL
    expect(e[0]).toBe(0);
    expect(e[5512]).toBe(0);
    expect(e[11025]).toBe(0);
    expect(e[2756]).toBeCloseTo(1, 3);
    expect(e[1378]).toBeCloseTo(0.5, 2); // FL 0.50029
  });

  it('runs at 2x through FL\'s half-band filters when oversampling', () => {
    const h = run(params({ oversample: 1 }, { 0: { mode: 0 } }), impulse(64)).out[0].map((v) => v / 0.5);
    [0.000502, 0.018966, 0.1788, 0.576671, 0.49788, -0.314831, -0.063418, 0.247953].forEach((v, i) => expect(h[i]).toBeCloseTo(v, 5));
    // a 735-sample 2x delay (time 32) shows the other polyphase branch (FL: starts at 367)
    const d = run(params({ oversample: 1, u1Time: 32, u1FbVol: 0 }, { 0: { leave: 1 } }), impulse(500)).out[0].map((v) => v / 0.5);
    [3.2e-5, 0.003844, 0.067075, 0.366743, 0.668446, 0.083191].forEach((v, i) => expect(d[367 + i]).toBeCloseTo(v, 5));
  });

  it('ramps volumes per block (0.001 per sample), switches dry and "to next" at once', () => {
    const fx = createEffect('delaybank', SR, 512);
    const p = params({}, { 0: { mode: 0 } });
    fx.setParams(p);
    const ctx = makeCtx({ sampleRate: SR, blockSize: 512 });
    const L = new Float32Array(2048).fill(0.5), R = new Float32Array(2048);
    fx.process(L.subarray(0, 512), R.subarray(0, 512), 512, ctx);
    fx.setParams({ ...p, u1InVol: 64, dry: 0 });
    for (let s = 512; s < 2048; s += 512) fx.process(L.subarray(s, s + 512), R.subarray(s, s + 512), 512, ctx);
    expect(L[512] / 0.5).toBeCloseTo(1, 6);
    expect(L[513] / 0.5).toBeCloseTo(0.999, 6);
    expect(L[512 + 511] / 0.5).toBeCloseTo(0.489, 5);
    expect(L[1024 + 1] / 0.5).toBeCloseTo(0.4875, 4);
    expect(L[2047] / 0.5).toBeCloseTo(0.23166, 5);
  });

  it('re-creates its lines when the delay time changes (FL)', () => {
    const fx = createEffect('delaybank', SR, 128);
    const p = params({ u1Time: 960, u1FbVol: 100 }, { 0: { leave: 1 } });
    fx.setParams(p);
    const ctx = makeCtx({ sampleRate: SR });
    const N = SR, L = new Float32Array(N), R = new Float32Array(N);
    for (let i = 0; i < N; i += 441) L[i] = 0.1;
    for (let s = 0; s < N; s += 128) {
      if (s === 22016) fx.setParams({ ...p, u1Time: 700 });
      fx.process(L.subarray(s, s + 128), R.subarray(s, s + 128), 128, ctx);
    }
    expect(peak(L, 22020, 22016 + 8030)).toBe(0); // new length 8039
    expect(peak(L, 22016 + 8039, 22016 + 8600)).toBeGreaterThan(0.05);
  });

  it('is finite at extremes and quiet after its tail', () => {
    const x = new Float32Array(SR * 2);
    for (let i = 0; i < 4410; i++) x[i] = Math.sin(i * 0.1);
    const units = Array.from({ length: 8 }, () => ({ enable: 1, mode: 3, inType: 6, inMode: 2, fbType: 7, fbMode: 2, div: 7, shape: 90 }));
    const hot: Record<string, unknown> = { feedback: 128, oversample: 1 };
    for (let u = 1; u <= 8; u++) Object.assign(hot, { [`u${u}FbVol`]: 128, [`u${u}FbGain`]: 256, [`u${u}InGain`]: 256, [`u${u}Time`]: u * 3, [`u${u}InVol`]: 160, [`u${u}Next`]: 160 });
    const { out, fx } = run(params(hot, Object.fromEntries(units.map((s, i) => [i, s]))), x);
    expect(out[0].every(Number.isFinite) && out[1].every(Number.isFinite)).toBe(true);
    expect(fx.tail).toBeLessThanOrEqual(60);
    const q = run(params({ u1Time: 120 }), x).out[0];
    expect(peak(q, SR + 30000, SR * 2)).toBeLessThan(1e-4);
  });
});
