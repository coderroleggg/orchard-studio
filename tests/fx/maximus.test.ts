import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { MX_PARAMS, mxSideGain } from '../../src/model/fx/plugins/maximus';
import { curveAt, levelOf, posOf, type CurvePoint } from '../../src/model/fx/plugins/maximus/curve';
import { makeCtx } from './util';

// Reference numbers below were measured on FL Studio 2026's own Maximus with
// the flfxhost test host (docs/research/fx/maximus.md).

const SR = 44100;
const LIMIT: CurvePoint[] = [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.5, 0, 0]];
const LIN: CurvePoint[] = [[0, 0, 0, 0], [1, 0.5, 0, 0]];

function state(over: Record<string, unknown> = {}, preset?: string): Record<string, unknown> {
  const d = fxDef('maximus')!;
  const pr = preset ? d.presets!.find((p) => p.name === preset)! : undefined;
  return { ...defaultFxParams('maximus'), ...(pr ? structuredClone(pr.params) : {}), ...over };
}

function fx(st: Record<string, unknown>, sr = SR) {
  const e = createEffect('maximus', sr, 128);
  e.setParams(st);
  e.reset();
  return e;
}

function run(e: ReturnType<typeof fx>, L: Float32Array, R: Float32Array = Float32Array.from(L)): [Float32Array, Float32Array] {
  const ctx = makeCtx({ sampleRate: SR });
  for (let i = 0; i < L.length; i += 128) {
    const n = Math.min(128, L.length - i);
    e.process(L.subarray(i, i + n), R.subarray(i, i + n), n, ctx);
  }
  return [L, R];
}

const sine = (f: number, amp: number, n: number, ph = 0) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR + ph));
const peak = (b: Float32Array, a = 0) => { let m = 0; for (let i = a; i < b.length; i++) m = Math.max(m, Math.abs(b[i])); return m; };
const rms = (b: Float32Array, a = 0) => { let s = 0; for (let i = a; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / (b.length - a)); };
const db = (x: number) => 20 * Math.log10(x);
/** Magnitude of the response at f from an impulse response. */
function mag(h: Float32Array, f: number, from = 0): number {
  let re = 0, im = 0;
  for (let k = from; k < h.length; k++) { const w = (2 * Math.PI * f * (k - from)) / SR; re += h[k] * Math.cos(w); im -= h[k] * Math.sin(w); }
  return Math.hypot(re, im);
}

describe('Maximus: definition', () => {
  it('has FL parameters, ranges, Default-preset defaults and value texts', () => {
    const d = fxDef('maximus')!;
    expect(d.width).toBe(626);
    expect(d.height).toBe(385);
    expect(d.category).toBe('Dynamics');
    expect(d.params.length).toBe(59);
    expect(d.params.map((p) => p.index)).toEqual([...Array(59).keys()]);
    const by = (k: string) => d.params.find((p) => p.key === k)!;
    expect(by('lowFreq').name).toBe('Low band frequency');
    expect(by('lmhDelay').name).toBe('LMH lookahead delay');
    expect(by('masterAttCurve').name).toBe('Master attack / release 2 curve');
    expect(by('highSatThres').name).toBe('High band soft saturation threshold');
    // FL inserts Maximus with its Default preset: 24 dB slopes
    expect(by('lowSlope').def).toBe(1);
    expect(by('highSlope').def).toBe(1);
    expect(by('lowCut').min).toBe(-1);
    const t = (k: string, v: number) => formatParam(by(k), v);
    expect(t('lowFreq', 19800)).toBe('200Hz');
    expect(t('lowFreq', 0)).toBe('30Hz');
    expect(t('highFreq', 48065)).toBe('3000Hz');
    expect(t('highFreq', 65536)).toBe('16000Hz');
    expect(t('lowCut', -1)).toBe('Off');
    expect(t('lowCut', 32768)).toBe('20Hz');
    expect(t('lmhDelay', 1115)).toBe('2.00ms');
    expect(t('masterAtt', 0)).toBe('Default');
    expect(t('masterAtt', 10000)).toBe('1000.00ms');
    expect(t('masterRel', 5000)).toBe('85.53ms');
    expect(t('masterRel2', 0)).toBe('Default');
    expect(t('masterRel2', 10000)).toBe('2000.00ms');
    expect(t('masterSustain', 2882)).toBe('10.00ms');
    expect(t('masterPre', 0)).toBe('-InfdB');
    expect(t('masterPre', 500)).toBe('-11.2dB');
    expect(t('masterPre', 1000)).toBe('0.0dB');
    expect(t('masterPre', 2000)).toBe('18.1dB');
    expect(t('masterStereo', 0)).toBe('Original');
    expect(t('masterStereo', 3)).toBe('Original');
    expect(t('masterStereo', 5)).toBe('1% merged');
    expect(t('masterStereo', 125)).toBe('12% merged');
    expect(t('masterStereo', -500)).toBe('50% separated');
    expect(t('masterSatThres', 0)).toBe('No saturation');
    expect(t('masterSatThres', 3)).toBe('0% mode B');
    expect(t('masterSatThres', -1000)).toBe('100% mode A');
    expect(t('masterSatThres', 505)).toBe('50% mode B');
    expect(t('lmhMix', 5)).toBe('1%');
    expect(t('masterMode', 1)).toBe('compression off');
    expect(t('masterSusMode', 1)).toBe('RMS');
    expect(t('lowSlope', 0)).toBe('12dB');
  });

  it('ships FL factory presets, Soundgoodizer A-D among them', () => {
    const names = fxDef('maximus')!.presets!.map((p) => p.name);
    expect(names.length).toBe(41);
    expect(names[0]).toBe('Default');
    for (const n of ['a', 'b', 'c', 'd']) expect(names).toContain(`Soundgoodizer presets/${n}`);
    expect(names).toContain('Fancy/Mid-triggered gate');
  });
});

describe('Maximus: level scale and curves', () => {
  it('maps levels like FL (0 dB in the middle, +12 dB at the top)', () => {
    expect(posOf(1)).toBeCloseTo(0.5, 12);
    expect(posOf(4)).toBeCloseTo(1, 12);
    expect(levelOf(0.25)).toBeCloseTo((3 - 1) / 2 * 0.366025 / 1, 2);
    // FL editor ticks (measured on the screenshot): -18 dB at 0.10, +9 dB at 0.865
    expect(posOf(Math.pow(10, -18 / 20))).toBeCloseTo(0.1022, 3);
    expect(posOf(Math.pow(10, 9 / 20))).toBeCloseTo(0.8614, 3);
  });

  it('evaluates FL single-curve tension', () => {
    const c: CurvePoint[] = [[0, 0, 0, 0], [1, 0.5, 0.3, 0]];
    const k = Math.pow(10, 1.8) - 1;
    expect(curveAt(c, 0.25)).toBeCloseTo(0.5 * (1 - (Math.pow(1 + k, 0.75) - 1) / k), 9);
  });

  it('static curve: out = 0.975 x levelOf(curve(posOf(in))) (FL measured with DC)', () => {
    // master compressor alone, LIN curve (0,0)-(1,0.5); FL: 1.0 -> 0.35687, 2.0 -> 0.60258, 4.0 -> 0.975
    for (const [v, want] of [[0.25, 0.10956], [1, 0.35687], [2, 0.60258], [4, 0.975]]) {
      const e = fx(state({ lowMode: 1, midMode: 1, highMode: 1, lowCut: -1, masterAtt: 0, masterRel: 0, masterSustain: 0, curves: [LIMIT, LIMIT, LIMIT, LIN] }));
      const [L] = run(e, new Float32Array(SR / 4).fill(v));
      expect(Math.abs(L[L.length - 1])).toBeCloseTo(want, 4);
    }
  });
});

describe('Maximus: FL reference renders', () => {
  it('Default preset limits a hot master to -0.22 dBFS and reports 176 samples', () => {
    const e = fx(state({ masterPre: 1500 }));
    expect(e.latency).toBe(176);
    const [L] = run(e, sine(1000, Math.pow(10, -6 / 20), SR / 2));
    expect(db(peak(L, SR / 4))).toBeCloseTo(-0.22, 2);
  });

  it('matches FL on a 3-tone test signal for several presets', () => {
    // input: 0.8 sin 100 Hz + 0.8 sin 1 kHz + 0.5 sin 5 kHz, R = 0.7 L; FL: RMS of the last half second, samples at 30000..30004
    const refs: [string, number, number, number[]][] = [
      ['Default', 0.43194, 0.30235, [0.157563, 0.173252, 0.288267, 0.441255, 0.548714]],
      ['Soundgoodizer presets/a', 0.55705, 0.51202, [-0.281645, -0.4292, -0.737901, -0.886857, -0.896647]],
      ['Soundgoodizer presets/c', 0.4166, 0.29779, [-0.779105, -0.829774, -0.748415, -0.569742, -0.371863]],
      ['Mastering/Transparent', 0.40575, 0.28402, [0.639435, 0.774714, 0.756841, 0.591595, 0.353701]],
      ['Insert/NY compression', 0.40675, 0.28472, [0.113706, -0.062493, -0.230062, -0.318957, -0.300339]],
    ];
    for (const [name, rl, rr, smp] of refs) {
      const x = Float32Array.from({ length: SR }, (_, i) => 0.8 * Math.sin((2 * Math.PI * 100 * i) / SR) + 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SR) + 0.5 * Math.sin((2 * Math.PI * 5000 * i) / SR));
      const [L, R] = run(fx(state({}, name)), x, x.map((v) => v * 0.7));
      expect(rms(L, SR / 2)).toBeCloseTo(rl, 3);
      expect(rms(R, SR / 2)).toBeCloseTo(rr, 3);
      smp.forEach((v, k) => expect(Math.abs(L[30000 + k] - v)).toBeLessThan(3e-3));
    }
  });
});

describe('Maximus: crossover and lookahead', () => {
  const ir = (over: Record<string, unknown>) => {
    const x = new Float32Array(8192); x[0] = 1;
    return run(fx(state({ masterMode: 1, lowCut: -1, ...over })), x)[0];
  };

  it('12 dB split = Linkwitz-Riley 2 (FL: low -6.02 dB at 200 Hz, mid -1.23 dB at 1 kHz, high -6.06 dB at 3 kHz)', () => {
    const base = { lowSlope: 0, highSlope: 0, lowMode: 1, midMode: 1, highMode: 1 };
    expect(db(mag(ir({ ...base, midMode: 2, highMode: 2 }), 200))).toBeCloseTo(-6.02, 1);
    expect(db(mag(ir({ ...base, lowMode: 2, highMode: 2 }), 1000))).toBeCloseTo(-1.23, 1);
    expect(db(mag(ir({ ...base, lowMode: 2, midMode: 2 }), 3000))).toBeCloseTo(-6.06, 1);
    // the sum is FL's near-allpass (-0.06 dB at 1 kHz)
    expect(db(mag(ir(base), 1000))).toBeCloseTo(-0.06, 1);
  });

  it('24 dB split sums flat; OFF bands fold into MID; MID with LOW and HIGH off is a wire', () => {
    const base = { lowMode: 1, midMode: 1, highMode: 1 };
    for (const f of [60, 200, 1000, 3000, 10000]) expect(Math.abs(db(mag(ir(base), f)))).toBeLessThan(0.05);
    const wire = ir({ lowMode: 3, midMode: 1, highMode: 3 });
    expect(wire[0]).toBeCloseTo(1, 6);
    expect(Math.abs(wire[1])).toBeLessThan(1e-7);
  });

  it('latency follows FL: LMH delay while an LMH band compresses, master attack while MASTER compresses', () => {
    expect(fx(state()).latency).toBe(176);
    expect(fx(state({ lowMode: 1, midMode: 1, highMode: 1 })).latency).toBe(88);
    expect(fx(state({ masterMode: 1 })).latency).toBe(88);
    expect(fx(state({ lowMode: 1, midMode: 1, highMode: 1, masterMode: 1 })).latency).toBe(0);
    expect(fx(state({ masterAtt: 0, lmhDelay: 1903 })).latency).toBe(200);
    expect(fx(state({ masterAtt: 2882, lmhDelay: 1903 })).latency).toBe(641);
    // FL does not report its 2x resampler pair (Pow preset: LMH bands off -> 88, lmhDelay 891 -> 153)
    expect(fx(state({ lowMode: 1, midMode: 1, highMode: 1, oversample: 1 })).latency).toBe(88);
  });
});

describe('Maximus: dynamics laws (measured on FL)', () => {
  const mid = { lowMode: 3, highMode: 3, masterMode: 1, lowCut: -1, lmhDelay: 0, midAtt: 0, midSustain: 0, midRel: 0, midRel2: 0, curves: [LIMIT, LIN, LIMIT, LIMIT] };
  const G = (lv: number) => (0.975 * levelOf(0.5 * posOf(lv))) / lv;

  it('attack smooths the gain: N stages with c = 1 - exp(-ln(316.2) sqrt(N) / T)', () => {
    const att = Math.round((1e4 * Math.log(20 / 2 + 1)) / Math.log(501)); // 20 ms
    for (const N of [1, 2]) {
      const e = fx(state({ ...mid, midAtt: att, midAttCurve: N }));
      const x = new Float32Array(4000).fill(0.1); x.fill(2, 1000);
      const [L] = run(e, x);
      const T = (2 * (Math.pow(501, att / 1e4) - 1) * SR) / 1000;
      const c = 1 - Math.exp((-2.5 * Math.LN10 * Math.sqrt(N)) / T);
      let s = new Array(N).fill(G(0.1));
      for (let i = 1000; i < 1600; i++) { let g = G(2); for (let k = 0; k < N; k++) { s[k] += c * (g - s[k]); g = s[k]; } s = [...s]; }
      expect(L[1599] / 2).toBeCloseTo(s[N - 1], 4);
    }
  });

  it('REL works on the level, REL 2 on the gain (both reach -40 dB at their time)', () => {
    const rel = Math.round((1e4 * Math.log(20 / 4 + 1)) / Math.log(501));
    const x = new Float32Array(6000).fill(0.1); x.fill(2, 1000, 3000);
    const [L] = run(fx(state({ ...mid, midRel: rel, midRelCurve: 1 })), Float32Array.from(x));
    const T = (4 * (Math.pow(501, rel / 1e4) - 1) * SR) / 1000;
    const c = 1 - Math.exp((-2 * Math.LN10) / T);
    const lvl = 0.1 + 1.9 * Math.pow(1 - c, 400);
    expect(L[3399] / 0.1).toBeCloseTo(G(lvl), 3);
  });

  it('PEAK sustain holds the level for the window; RMS uses (L^2 + R^2) / 2', () => {
    const sus = 2882; // 10 ms = 441 samples
    const x = new Float32Array(3000).fill(0.1); x.fill(2, 1000, 1100);
    const [L] = run(fx(state({ ...mid, midSustain: sus })), x);
    expect(L[1500] / 0.1).toBeCloseTo(G(2), 4);
    expect(L[1560] / 0.1).toBeCloseTo(G(0.1), 4);
    const [l2] = run(fx(state({ ...mid, midSustain: sus, midSusMode: 1 })), new Float32Array(4000).fill(1), new Float32Array(4000));
    expect(l2[3999]).toBeCloseTo(G(Math.SQRT1_2), 4);
  });

  it('Master mid mode: the mid band detects, its gain applies to the full signal (FL: -7.70 dB)', () => {
    const st = state({ masterMid: true, lowCut: -1, masterMode: 1, midAtt: 0, midRel: 0, midRel2: 0, midSustain: 2882, lowSlope: 0, highSlope: 0, curves: [LIMIT, LIN, LIMIT, LIMIT] });
    const [L] = run(fx(st), sine(1000, 0.5, SR / 2));
    expect(db(peak(L, SR / 4) / 0.5)).toBeCloseTo(-7.70, 1);
  });
});

describe('Maximus: saturation, stereo, mix', () => {
  const wire = { lowMode: 3, highMode: 3, midMode: 1, masterMode: 1, lowCut: -1, lmhDelay: 0 };
  const xfer = (over: Record<string, unknown>, v: number) => run(fx(state({ ...wire, ...over })), new Float32Array(256).fill(v))[0][200];

  it('soft saturation B = 1 - exp(-x) at 100 %, A = atan(x) / atan(4) at 100 % (FL)', () => {
    expect(xfer({ midSatThres: 1000 }, 1)).toBeCloseTo(1 - Math.exp(-1), 4);
    expect(xfer({ midSatThres: 1000 }, 2)).toBeCloseTo(1 - Math.exp(-2), 4);
    expect(xfer({ midSatThres: -1000 }, 1)).toBeCloseTo(Math.atan(1) / Math.atan(4), 4);
    expect(xfer({ midSatThres: -1000 }, 6)).toBeCloseTo(1, 4);
    // 50 % B: linear to 0.5, then exponential (FL 0.8161 at 1.0)
    expect(xfer({ midSatThres: 500 }, 1)).toBeCloseTo(0.8161, 3);
    // A after post gain behaves as A at ceiling / post (FL: post +9.3 dB, 0.25 -> 0.4245)
    expect(xfer({ midSatThres: -1000, midPost: 1500 }, 0.25)).toBeCloseTo(0.4245, 3);
  });

  it('stereo separation scales the side signal (FL: 50 % merged -> 0.691, 100 % separated -> 2)', () => {
    expect(mxSideGain(500)).toBeCloseTo(0.69098, 4);
    expect(mxSideGain(-1000)).toBeCloseTo(2, 9);
    const [L, R] = run(fx(state({ ...wire, midStereo: -1000 })), new Float32Array(256).fill(1), new Float32Array(256));
    expect(L[200]).toBeCloseTo(1.5, 5);
    expect(R[200]).toBeCloseTo(-0.5, 5);
  });

  it('LMH mix blends each band with its own dry signal', () => {
    const [a] = run(fx(state({ ...wire, midPost: 0, lmhMix: 250 })), new Float32Array(512).fill(0.5));
    expect(a[400]).toBeCloseTo(0.375, 5);
    // a muted band contributes nothing, not even dry
    const [b] = run(fx(state({ ...wire, midMode: 2, lmhMix: 0 })), new Float32Array(512).fill(0.5));
    expect(Math.abs(b[400])).toBeLessThan(1e-9);
  });
});

describe('Maximus: robustness', () => {
  it('silence in gives silence out', () => {
    const [L, R] = run(fx(state({}, 'Mastering/Max loudness')), new Float32Array(SR / 2));
    expect(peak(L)).toBe(0);
    expect(peak(R)).toBe(0);
  });

  it('stays finite at extreme settings', () => {
    const ext: Record<string, unknown> = {};
    for (const q of MX_PARAMS) ext[q.key] = q.key.endsWith('Mode') && !q.key.endsWith('SusMode') ? 0 : q.max;
    ext.curves = [0, 1, 2, 3].map(() => [[0, 1, 0, 0], [0.3, 0, -1, 3], [0.6, 1, 1, 4], [1, 0.2, 0.5, 1]]);
    ext.oversample = 1;
    const x = Float32Array.from({ length: SR / 2 }, (_, i) => (i % 2000 < 10 ? 8 : 1e-8 * Math.sin(i)));
    const [L, R] = run(fx(state(ext)), x);
    for (let i = 0; i < L.length; i++) { expect(Number.isFinite(L[i])).toBe(true); expect(Number.isFinite(R[i])).toBe(true); }
    const ext2: Record<string, unknown> = { linPhase: true, masterMid: true };
    for (const q of MX_PARAMS) ext2[q.key] = q.min;
    const [L2] = run(fx(state(ext2)), sine(440, 1, SR / 4));
    for (let i = 0; i < L2.length; i++) expect(Number.isFinite(L2[i])).toBe(true);
  });

  it('steps band post gain changes at the next block (FL, measured exact)', () => {
    const e = fx(state({ lowMode: 3, highMode: 3, midMode: 1, masterMode: 1, lowCut: -1, lmhDelay: 0 }));
    run(e, new Float32Array(512).fill(0.5));
    e.setParams(state({ lowMode: 3, highMode: 3, midMode: 1, masterMode: 1, lowCut: -1, lmhDelay: 0, midPost: 0 }));
    const [L] = run(e, new Float32Array(128).fill(0.5));
    expect(L[0]).toBe(0);
    expect(L[127]).toBe(0);
  });

  it('LOW + MID OFF sums the HIGH band twice (FL quirk, measured: 2 x HP2 with compression off)', () => {
    const base = { lowCut: -1, masterMode: 1, highMode: 1, midMode: 1, lowMode: 1 };
    const x = sine(8000, 0.2, 44100 * 0.2);
    const [ref] = run(fx(state({ ...base, lowMode: 3, midMode: 1 })), Float32Array.from(x)); // low OFF: mid = LP2, high = HP2
    const [q] = run(fx(state({ ...base, lowMode: 3, midMode: 3 })), Float32Array.from(x));
    const [hiOnly] = run(fx(state({ ...base, lowMode: 3, midMode: 2 })), Float32Array.from(x)); // mid muted: HIGH alone
    expect(rms(q, 4000)).toBeCloseTo(2 * rms(hiOnly, 4000), 4);
    expect(rms(ref, 4000)).toBeGreaterThan(0);
  });

  it('switches crossover frequencies at the next block (FL, direct form I keeps the states)', () => {
    const base = { lowMode: 1, midMode: 1, highMode: 1, masterMode: 1, lowCut: -1 };
    const e = fx(state(base));
    run(e, sine(300, 0.3, 4096));
    e.setParams(state({ ...base, lowFreq: 40000 }));
    const [L] = run(e, sine(300, 0.3, 256));
    expect(L.every(Number.isFinite)).toBe(true);
  });

  it('reports monitor data for the editor', () => {
    const e = fx(state());
    run(e, sine(200, 0.9, 4096));
    const m = e.monitor!()!;
    expect((m.chunks as Float32Array).length).toBe((4096 / 64) * 17);
    expect((m.gains as number[]).length).toBe(4);
  });
});
