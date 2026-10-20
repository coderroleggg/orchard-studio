import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { d3CutoffText, d3SatCurve, d3TimeMs, d3TimeText } from '../../src/model/fx/plugins/delay3';
import { makeCtx, render, sine, rms, peak } from './util';

// Reference numbers below were measured from FL Studio 2026's own Fruity Delay 3
// with flfxhost (see docs/research/fx/delay3.md).

const SR = 44100;
const base = (over: Record<string, number> = {}) => ({ ...defaultFxParams('delay3'), ...over });
/** Linear settings: Limit (transparent below its 1.0 ceiling), filter off, dry off. */
const lin = (over: Record<string, number> = {}) => base({ distType: 0, filterType: 3, dry: 0, ...over });

function run(params: Record<string, unknown>, L: Float32Array, R: Float32Array = L, tempo = 120, sr = SR) {
  const fx = createEffect('delay3', sr, 128);
  fx.setParams(params);
  return { fx, out: render(fx, L, R, 128, { sampleRate: sr, tempo }) };
}

function impulse(n: number, at = 0, amp = 1): Float32Array {
  const b = new Float32Array(n);
  b[at] = amp;
  return b;
}

function taps(b: Float32Array, thr = 1e-4): [number, number][] {
  const t: [number, number][] = [];
  b.forEach((v, i) => { if (Math.abs(v) > thr) t.push([i, v]); });
  return t;
}

describe('Delay 3: definition', () => {
  it('is registered with FL ranges, names and the Default preset values', () => {
    const d = fxDef('delay3')!;
    expect(d.name).toBe('Delay 3');
    expect(d.category).toBe('Delay reverb');
    expect([d.width, d.height]).toEqual([747, 217]);
    expect(d.params.map((p) => p.index)).toEqual([...Array(26).keys()]);
    expect(d.params[14].name).toBe('Feedback level');
    expect(d.params[5].name).toBe('Delay time R/L offset');
    const p = defaultFxParams('delay3');
    expect(p).toMatchObject({ model: 1, sync: 1, time: 192, distType: 1, cutoff: 6000, res: 0, diffSpread: 0, feedback: 3000, rate: 60000, bits: 6000 });
    expect(d.presets?.map((q) => q.name)).toEqual(['Bandpass', 'Chorus', 'Default', 'Diffused', 'Mono', 'Ping pong', 'Resonator', 'Saturated', 'Stereoized', 'Tape']);
    const def = d.presets!.find((q) => q.name === 'Default')!;
    for (const [k, v] of Object.entries(def.params)) expect(p[k]).toBe(v);
  });

  it("formats values exactly like FL's GetName", () => {
    const d = fxDef('delay3')!;
    const f = (key: string, v: number) => formatParam(d.params.find((q) => q.key === key)!, v);
    expect(d3TimeText(192, true)).toBe('4:0');
    expect(d3TimeText(80, true)).toBe('1:32');
    expect(d3TimeText(80, false)).toBe('4.6ms');
    expect(d3TimeText(768, false)).toBe('1000.0ms');
    expect(f('inWet', 9)).toBe('0.2%'); // FL rounds the single-precision value: 0.15000000475 -> 0.2
    expect(f('inWet', 15)).toBe('0.2%'); // 0.2499999944 -> 0.2
    expect(f('feedback', 3000)).toBe('62.5%');
    expect(f('feedback', 6000)).toBe('125.0%');
    expect(f('offset', 1)).toBe('-100.0%');
    expect(f('modRate', 3000)).toBe('1.1Hz');
    expect(f('modRate', 6000)).toBe('20.0Hz');
    expect(f('cutoff', 3000)).toBe('1299.6Hz');
    expect(d3CutoffText(3000, 1)).toBe('399.8Hz');
    expect(d3CutoffText(3000, 2)).toBe('1136.0Hz');
    expect(f('rate', 60000)).toBe('Max Hz');
    expect(f('rate', 0)).toBe('192.3 Hz');
    expect(f('rate', 30000)).toBe('1447.3 Hz');
    expect(f('bits', 6000)).toBe('Max bits');
    expect(f('bits', 3000)).toBe('6.1 bits');
    expect(f('tone', -3000)).toBe('-100.0%');
    expect(d3TimeMs(512)).toBeCloseTo(323.72, 1);
  });
});

describe('Delay 3: delay', () => {
  it('tempo-synced echoes land on whole samples (1 beat at 120 BPM = 22050)', () => {
    const { out } = run(lin({ feedback: 0 }), impulse(30000));
    expect(taps(out[0])).toEqual([[22050, 1]]);
    // 97 BPM, 3 steps: FL echo at 27278 (floor of the exact time)
    const r = run(lin({ feedback: 0 }), impulse(30000), undefined, 97);
    expect(taps(r.out[0])[0][0]).toBe(27278);
  });

  it('free time follows FL (raw 512 -> 14276 samples, 340 -> 4770, 48 kHz scales)', () => {
    expect(taps(run(lin({ sync: 0, time: 512, feedback: 0 }), impulse(15000)).out[0])).toEqual([[14276, 1]]);
    expect(taps(run(lin({ sync: 0, time: 340, feedback: 0 }), impulse(5000)).out[0])[0][0]).toBe(4770);
    expect(taps(run(lin({ sync: 0, time: 512, feedback: 0 }), impulse(16000), undefined, 120, 48000).out[0])[0][0]).toBe(15538);
  });

  it('repeats at the feedback level, with a 10 Hz DC blocker in the loop', () => {
    const { out } = run(lin({ sync: 0, time: 512 }), impulse(30000, 0, 0.1));
    const L = out[0];
    expect(L[14276]).toBeCloseTo(0.1, 6);
    // FL: echo 2 = 0.6245551 followed by -0.0008892 (DC blocker), x 0.1
    expect(L[28552] / 0.1).toBeCloseTo(0.6245551, 5);
    expect(L[28553] / 0.1).toBeCloseTo(-0.0008892, 6);
  });

  it('filters every repeat (echo k = filter^k), LP at 1299.6 Hz', () => {
    const p = lin({ sync: 0, time: 400, filterType: 0, cutoff: 3000, res: 0 });
    const x = new Float32Array(20000);
    x.set(sine(1300, 0.1, 0.5, SR));
    const { out } = run(p, x);
    // a Butterworth LP at fc: -3.01 dB per pass; 62.5 % feedback between passes (D = 7325)
    const e1 = rms(out[0], 7325 + 1000, 7325 + 4000), e2 = rms(out[0], 14650 + 1000, 14650 + 4000);
    expect(20 * Math.log10(e1 / (0.5 / Math.SQRT2))).toBeCloseTo(-3.01, 1);
    expect(20 * Math.log10(e2 / e1)).toBeCloseTo(-3.01 + 20 * Math.log10(0.625), 1);
  });

  it('delay models: mono sums, stereo is independent, ping pong starts on the other side', () => {
    const one = impulse(3000), none = new Float32Array(3000);
    const mono = run(lin({ model: 0, sync: 0, time: 200, feedback: 0 }), one, none).out;
    expect(mono[0][1271]).toBeCloseTo(0.5, 6);
    expect(mono[1][1271]).toBeCloseTo(0.5, 6);
    const st = run(lin({ model: 1, sync: 0, time: 200, feedback: 0 }), one, none).out;
    expect(st[0][1271]).toBeCloseTo(1, 6);
    expect(peak(st[1])).toBe(0);
    const pp = run(lin({ model: 2, sync: 0, time: 200 }), one, none).out;
    expect(pp[1][1271]).toBeCloseTo(1, 6);
    expect(pp[0][2542]).toBeCloseTo(0.62456, 4);
  });

  it('offset: mono post-delay 0.5 f T, stereo pre-delay 0.25 f^2 T - 1 (FL values)', () => {
    const one = impulse(30000);
    const mono = run(lin({ model: 0, sync: 0, time: 512, feedback: 0, offset: 0 }), one).out;
    expect(taps(mono[0])[0][0]).toBe(21414); // L delayed by 7138
    expect(taps(mono[1])[0][0]).toBe(14276);
    const st = run(lin({ model: 1, sync: 0, time: 512, feedback: 0, offset: 300 }), one).out;
    expect(taps(st[0])[0][0]).toBe(14276);
    expect(taps(st[1])[0][0]).toBe(17165); // R pre-delay 2889 at -90 %
  });

  it('ping pong pans the input like FL (pour law)', () => {
    const one = impulse(3000), none = new Float32Array(3000);
    const pp = run(lin({ model: 2, sync: 0, time: 200, feedback: 0, offset: 1500 }), one, none).out;
    expect(pp[1][1271]).toBeCloseTo(0.75, 5);
    expect(pp[0][1271]).toBeCloseTo(0, 6);
  });

  it('stereo spread mixes the wet channels toward mono', () => {
    const one = impulse(3000), none = new Float32Array(3000);
    const r = run(lin({ model: 1, sync: 0, time: 200, feedback: 0, spread: 3000 }), one, none).out;
    expect(r[0][1271]).toBeCloseTo(0.75, 5);
    expect(r[1][1271]).toBeCloseTo(0.25, 5);
  });

  it('diffusion: one allpass around the main tap (FL taps at 50 % spread)', () => {
    const r = run(lin({ sync: 0, time: 512, feedback: 0, diffLevel: 6000, diffSpread: 3000 }), impulse(16000, 0, 0.1)).out[0];
    const t = taps(r, 1e-5).slice(0, 4).map(([i, v]) => [i, Number((v / 0.1).toFixed(5))]);
    expect(t).toEqual([[13916, 0.499], [14276, 0.751], [14636, -0.37475], [14996, 0.187]]);
    // short times shrink the allpass: FL's direct tap at 2 for 136 samples / 100 % spread
    const s = run(lin({ sync: 0, time: 60, feedback: 0, diffLevel: 6000, diffSpread: 6000 }), impulse(600, 0, 0.5)).out[0];
    expect(taps(s, 1e-3)[0][0]).toBe(2);
  });

  it('mono runs the filter after the distortion (FL: BP + Saturate echo samples)', () => {
    const p = base({ model: 0, sync: 0, time: 400, feedback: 0, filterType: 2, cutoff: 3200, res: 1500, distType: 1, dry: 0 });
    const L = impulse(8000, 0, 0.8), Z = new Float32Array(8000);
    const r = run(p, L, Z).out[0];
    const fl = [0.11824, 0.15636, 0.04796, 0.00977, -0.00353, -0.00802, -0.0094, -0.00968];
    fl.forEach((v, k) => expect(r[7325 + k]).toBeCloseTo(v, 4));
  });
});

describe('Delay 3: distortion and lo-fi', () => {
  it('saturation transfer curve matches FL', () => {
    expect(d3SatCurve(1, 0, 0, 0)).toBeCloseTo(0.75, 6);
    expect(d3SatCurve(0.5, 0, 0, 0)).toBeCloseTo(0.4375, 6);
    expect(d3SatCurve(2.5, 0.5, 0, 0)).toBeCloseTo(0.172274, 5);
    expect(d3SatCurve(1, 0, 0.5, 0)).toBeCloseTo(0.875, 6);
    expect(d3SatCurve(-1, 0, 0, 0.5)).toBeCloseTo(-0.5, 6);
    expect(d3SatCurve(2, 0, 0, 1)).toBeCloseTo(1.5, 6);
  });

  it('limit holds its threshold on a steady input (FL: 1.0 at level 0, 0.17228 at 50 %)', () => {
    for (const [lvl, thr] of [[0, 1.0], [3000, 0.17228]]) {
      const x = new Float32Array(SR).fill(4);
      const r = run(base({ model: 3, distType: 0, filterType: 3, distLevel: lvl, dry: 0 }), x).out[0];
      expect(r[SR - 1]).toBeCloseTo(thr, 4);
    }
  });

  it('limiter envelope follows FL (sine x2: peak 1.14173)', () => {
    const x = sine(100, 0.3, 2, SR);
    const r = run(base({ model: 3, distType: 0, filterType: 3, dry: 0 }), x).out[0];
    expect(peak(r, 8000, 12000)).toBeCloseTo(1.14173, 3);
  });

  it('bit reduction truncates to 2^-bits steps', () => {
    const x = new Float32Array(2000);
    for (let i = 0; i < x.length; i++) x[i] = -0.99 + (1.98 * i) / 1999;
    const r = run(base({ model: 3, distType: 0, filterType: 3, bits: 0, dry: 0 }), x).out[0];
    expect([...new Set(Array.from(r, (v) => Number(v.toFixed(4))))].sort((a, b) => a - b)).toEqual([-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75]);
  });

  it('sample-rate reduction holds 229.3 samples at the minimum (192.3 Hz)', () => {
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.37) * 0.5;
    const r = run(base({ model: 3, distType: 0, filterType: 3, rate: 0, dry: 0 }), x).out[0];
    let changes = 0;
    for (let i = 1; i < r.length; i++) if (r[i] !== r[i - 1]) changes++;
    expect(r.length / changes).toBeCloseTo(229.3, 0);
  });
});

describe('Delay 3: smoothing, glide, keep pitch', () => {
  it('smooths output wet like FL (-20 dB in 20 ms, 8-sample steps)', () => {
    const fx = createEffect('delay3', SR, 128);
    const p = base({ model: 3, distType: 0, filterType: 3, dry: 0 });
    fx.setParams(p);
    const ctx = makeCtx();
    const buf = () => new Float32Array(128).fill(0.5);
    const a = buf(), b = buf();
    fx.process(a, b, 128, ctx);
    fx.setParams({ ...p, wet: 0 });
    const out: number[] = [];
    for (let k = 0; k < 10; k++) { const l = buf(), r = buf(); fx.process(l, r, 128, ctx); out.push(...Array.from(l)); }
    // FL: 0.3105 after 441 samples, 0.0985 after 882
    expect(out[441] / 0.5).toBeCloseTo(0.3105, 1);
    expect(out[882] / 0.5).toBeCloseTo(0.0985, 1);
  });

  it('time changes glide with the Time smooth constant (0.1086 s at 50 %)', () => {
    const fx = createEffect('delay3', SR, 128);
    const p = lin({ sync: 0, time: 512, feedback: 0 });
    fx.setParams(p);
    const ctx = makeCtx();
    const N = SR * 2, L = new Float32Array(N);
    for (let i = 0; i < N; i += 441) L[i] = 0.1;
    const R = Float32Array.from(L);
    for (let s = 0; s < N; s += 128) {
      if (s === 22016) fx.setParams({ ...p, time: 520 });
      fx.process(L.subarray(s, s + 128), R.subarray(s, s + 128), 128, ctx);
    }
    // FL: echo of the pulse at 23373 (input 8379 + delay) reads D = 14299.93
    let c = 0, w = 0;
    for (let i = 22200; i < 22280; i++) { c += L[i] * i; w += L[i]; }
    const pos = c / w;
    expect(pos - 7938).toBeGreaterThan(14290);
    expect(pos - 7938).toBeLessThan(14310);
  });

  it('keep pitch crossfades old and new taps over 0.1 s', () => {
    const fx = createEffect('delay3', SR, 128);
    const p = lin({ sync: 0, time: 512, feedback: 0, keepPitch: 1 });
    fx.setParams(p);
    const ctx = makeCtx();
    const N = SR * 2, L = new Float32Array(N);
    for (let i = 0; i < N; i += 441) L[i] = 0.1;
    const R = Float32Array.from(L);
    for (let s = 0; s < N; s += 128) {
      if (s === 22016) fx.setParams({ ...p, time: 520 });
      fx.process(L.subarray(s, s + 128), R.subarray(s, s + 128), 128, ctx);
    }
    // old tap (14276) and new tap (14895) both present mid-fade, then only the new one
    const oldMid = L[24419], newMid = L[24597];
    expect(oldMid + newMid).toBeCloseTo(0.1, 2);
    expect(oldMid).toBeGreaterThan(0.03);
    expect(Math.abs(L[26802] - 0.1)).toBeLessThan(0.002);
  });
});

describe('Delay 3: safety', () => {
  it('silence in gives silence out, and the echo tail dies away', () => {
    const { out, fx } = run(base({ sync: 0, time: 100, feedback: 3000 }), new Float32Array(SR));
    expect(peak(out[0])).toBe(0);
    const burst = sine(440, 0.05, 0.5, SR);
    const x = new Float32Array(SR * 3);
    x.set(burst);
    const r = run(base({ sync: 0, time: 100, feedback: 3000 }), x).out[0];
    expect(peak(r, SR * 2, SR * 3)).toBeLessThan(1e-4);
    expect(fx.tail).toBeGreaterThan(0.1);
    expect(fx.tail).toBeLessThanOrEqual(60);
  });

  it('stays finite and bounded at extreme settings', () => {
    const x = sine(220, 1, 1, SR);
    const cases: Record<string, number>[] = [
      { feedback: 6000, res: 6000, filterType: 0, cutoff: 0, distType: 0 },
      { feedback: 6000, res: 6000, filterType: 2, cutoff: 6000, distType: 1, distLevel: 6000, distKnee: 6000, distSym: 6000 },
      { feedback: 6000, model: 2, diffLevel: 6000, diffSpread: 6000, modTime: 6000, modCutoff: 6000, modRate: 6000, bits: 0, rate: 0 },
      { feedback: 6000, model: 0, offset: 0, time: 1, sync: 0, tone: 3000, keepPitch: 1 },
    ];
    for (const over of cases) {
      const r = run(base(over), x).out;
      for (const ch of r) {
        expect(ch.every(Number.isFinite)).toBe(true);
        expect(peak(ch)).toBeLessThan(8);
      }
    }
  });

  it('recovers from non-finite input', () => {
    const fx = createEffect('delay3', SR, 128);
    fx.setParams(base());
    const ctx = makeCtx();
    const L = new Float32Array(128).fill(NaN), R = new Float32Array(128).fill(NaN);
    fx.process(L, R, 128, ctx);
    const l2 = new Float32Array(128).fill(0.1), r2 = new Float32Array(128).fill(0.1);
    for (let k = 0; k < 400; k++) fx.process(l2.fill(0.1), r2.fill(0.1), 128, ctx);
    expect(Number.isFinite(l2[127])).toBe(true);
  });
});

describe("Delay 3: FL's engine laws", () => {
  /** FL-style render: 3 s of silence after creation (preroll), then the input. */
  function renderFL(params: Record<string, unknown>, input: Float32Array, sr = SR, tempo = 120): Float32Array {
    const fx = createEffect('delay3', sr, 512);
    fx.setParams(params);
    const ctx = makeCtx({ sampleRate: sr, blockSize: 512, tempo });
    const pre = 3 * sr, z = new Float32Array(512), z2 = new Float32Array(512);
    for (let s = 0; s < pre; s += 512) {
      const n = Math.min(512, pre - s);
      z.fill(0); z2.fill(0);
      fx.process(z.subarray(0, n), z2.subarray(0, n), n, ctx);
    }
    const L = Float32Array.from(input), R = Float32Array.from(input);
    for (let s = 0; s < L.length; s += 512) {
      const n = Math.min(512, L.length - s);
      fx.process(L.subarray(s, s + n), R.subarray(s, s + n), n, ctx);
    }
    return L;
  }
  const train = (n: number) => { const b = new Float32Array(n); for (let i = 0; i < n; i += 441) b[i] = 0.5; return b; };

  it('formats rates, cutoffs and the rate reduction exactly (full FL sweeps)', () => {
    const d = fxDef('delay3')!;
    const f = (key: string, v: number) => formatParam(d.params.find((q) => q.key === key)!, v);
    expect(f('modRate', 4024)).toBe('2.6Hz');
    expect(f('modRate', 4904)).toBe('5.7Hz');
    expect(f('rate', 41250)).toBe('2743.2 Hz'); // a float32 tie, rounded half to even like FL
    expect(f('cutoff', 3422)).toBe('2900.3Hz');
  });

  it('modulates the delay with the LFO at 0.99 x the displayed rate (FL echo samples)', () => {
    const L = renderFL(lin({ sync: 0, time: 250, modRate: 4000, modTime: 3000, feedback: 0 }), train(26460));
    const ref: [number, number][] = [[2354, 0.194336], [2355, 0.301636], [2791, 0.232422], [2792, 0.262207],
      [4096, 0.449219], [4097, 0.042236], [20437, 0.063599], [20438, 0.433472], [21312, 0.335205], [21313, 0.15918]];
    for (const [i, v] of ref) expect(L[i]).toBeCloseTo(v, 5);
  });

  it('modulates the feedback cutoff, coefficients every 4 samples (FL samples)', () => {
    const L = renderFL(base({ model: 3, modRate: 4000, modCutoff: 2500, cutoff: 2500, res: 1000, distType: 0, dry: 0 }), train(13300));
    const idx = [0, 1, 2, 3, 10, 441, 442, 443, 4410, 4411, 8820, 8821, 13230, 13231];
    const ref = [0.028361, 0.091887, 0.12905, 0.117116, -0.007772, 0.029779, 0.095845, 0.132966, 0.015975, 0.055098, 0.002646, 0.010031, 0.003137, 0.011832];
    idx.forEach((i, k) => expect(L[i]).toBeCloseTo(ref[k], 5));
  });

  it('holds samples with FL\'s counter (rate 50 %: holds of 9, 9, 9, 10 samples)', () => {
    const N = 4410, x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = (0.5 * i) / N;
    const L = renderFL(base({ model: 3, filterType: 3, distType: 0, rate: 30000, dry: 0 }), x);
    const ch: number[] = [];
    for (let i = 1; i < N; i++) if (L[i] !== L[i - 1]) ch.push(i);
    const holds = ch.slice(1).map((v, i) => v - ch[i]);
    expect(new Set(holds.slice(0, 200))).toEqual(new Set([9, 10]));
    const tens = holds.slice(0, 200).filter((h) => h === 10).length;
    expect(tens / 200).toBeCloseTo(0.25, 1); // FL: 9, 9, 10, 9 repeating
  });

  it('saturates with drive 10^(1.425 level) and FL\'s measured ceiling', () => {
    expect(d3SatCurve(2.5, 0.25, 0, 0)).toBeCloseTo(0.4069985, 6);
    expect(d3SatCurve(3, 1, 0, 0)).toBeCloseTo(0.0827671, 6);
    // small-signal gain = ceiling x drive
    expect(d3SatCurve(1e-4, 0.25, 0, 0) / 1e-4).toBeCloseTo(0.4069985 * Math.pow(10, 1.425 * 0.25), 3);
  });
});
