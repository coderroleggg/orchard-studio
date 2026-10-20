import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef, normalizeFxParams } from '../../src/model/fx/registry';
import { limCompGain, limRatio, limCompThres } from '../../src/model/fx/plugins/limiter';
import { makeCtx, render, sine, peak } from './util';

const SR = 44100;
const fmt = (key: string, v: number) => formatParam(fxParamDef('limiter', key)!, v);

function make(p: Record<string, unknown> = {}, sr = SR) {
  const fx = createEffect('limiter', sr, 128);
  fx.setParams({ ...defaultFxParams('limiter'), ...p });
  return fx;
}

/** Run mono `x` (both channels) through the limiter at 44.1 kHz; returns the left output. */
function run(x: Float32Array, p: Record<string, unknown> = {}, extra = 0): Float32Array {
  const fx = make(p);
  const pad = new Float32Array(x.length + extra);
  pad.set(x);
  const [L] = render(fx, pad, pad, 128, { sampleRate: SR });
  return L;
}

function dc(segs: [number, number][]): Float32Array {
  const n = segs.reduce((a, [, len]) => a + len, 0);
  const b = new Float32Array(n);
  let o = 0;
  for (const [v, len] of segs) { b.fill(v, o, o + len); o += len; }
  return b;
}

describe('Limiter', () => {
  it('is registered with FL parameter names, ranges, defaults and value texts', () => {
    const d = fxDef('limiter')!;
    expect(d.name).toBe('Limiter');
    expect(d.category).toBe('Dynamics');
    expect([d.width, d.height]).toEqual([626, 300]);
    expect(d.params.map((p) => p.name)).toEqual([
      'Gain', 'Soft saturation threshold', 'Limiter ceiling', 'Limiter attack time', 'Limiter attack curve',
      'Limiter release time', 'Limiter release curve', 'Limiter peak window', 'Comp threshold', 'Comp ratio',
      'Comp knee', 'Comp attack time', 'Comp release time', 'Comp curve', 'Comp RMS window', 'Noise gain',
      'Noise threshold', 'Noise release time',
    ]);
    expect(d.params.map((p) => p.index)).toEqual([...Array(18).keys()]);
    const def = defaultFxParams('limiter');
    expect(def).toMatchObject({ gain: 1000, sat: 1000, ceil: 1000, att: 1115, attCurve: 3, rel: 5000, relCurve: 3, sustain: 2882,
      cThres: 1000, cRatio: 0, cKnee: 0, cAtt: 0, cRel: 6666, cCurve: 1, cSustain: 650, nGain: 1000, nThres: 0, nRel: 4187,
      tab: 0, sidechain: 0, safety: true, speed: 50 });
    // value texts read from FL's plugin (GetName)
    expect([0, 1, 500, 1000, 1001, 1010, 2000].map((v) => fmt('gain', v))).toEqual(['-InfdB', '-69.8dB', '-11.2dB', '0.0dB', '0.0dB', '0.2dB', '18.1dB']);
    expect([0, 250, 500, 750, 1000, 1250, 1500, 2000].map((v) => fmt('ceil', v))).toEqual(['-InfdB', '-16.0dB', '-8.7dB', '-3.9dB', '0.0dB', '3.4dB', '6.4dB', '12.0dB']);
    expect([998, 997, 995].map((v) => fmt('sat', v))).toEqual(['0.0dB', '0.0dB', '-0.1dB']);
    expect([0, 3, 4, 500].map((v) => fmt('cThres', v))).toEqual(['-60.0dB', '-60.0dB', '-57.7dB', '-11.2dB']);
    expect([0, 100, 650, 1000, 1115, 2882, 5000, 10000].map((v) => fmt('att', v))).toEqual(['0.00ms', '0.13ms', '1.00ms', '1.72ms', '2.00ms', '10.00ms', '42.77ms', '1000.00ms']);
    expect([5000, 6666, 4187, 10000].map((v) => fmt('rel', v))).toEqual(['85.53ms', '248.22ms', '50.01ms', '2000.00ms']);
    expect([-1000, -500, -1, 0, 1, 500, 750, 1000].map((v) => fmt('cRatio', v))).toEqual(['1:4.0', '1:1.4', '1:1.0', '1:1.0', '1.0:1', '3.3:1', '7.9:1', '20.0:1']);
    expect([-1000, -985, -5, -4, 0, 5, 985, 1000].map((v) => fmt('cKnee', v))).toEqual(['-100%', '-99%', '-1%', '0%', '0%', '1%', '99%', '100%']);
    expect(d.presets?.map((p) => p.name)).toEqual(['Default', 'Drum compression', 'Drum compression 2', 'Drum compression 3', 'Drum expanding',
      'Ducking music behind voice', 'For drums', 'For drums (slight saturation)', 'Max loudness', 'Max loudness (slight saturation)',
      'Max loudness except noise', 'Noise gate', 'Transient shaping']);
    expect(d.presets?.[1].params).toMatchObject({ gain: 1764, cThres: 200, cRatio: 1000, cKnee: 644, cAtt: 3936, cRel: 7178, cCurve: 2, tab: 1 });
  });

  it('reports the attack time as look-ahead latency (FL: 88 samples at 44.1 kHz, 96 at 48 kHz)', () => {
    expect(make().latency).toBe(88);
    expect(make({}, 48000).latency).toBe(96);
    expect(make({ att: 0 }).latency).toBe(0);
    expect(make({ att: 650 }).latency).toBe(44);
    expect(make({ att: 5000 }).latency).toBe(1886);
    expect(make({ att: 10000 }).latency).toBe(44100);
  });

  it('holds a +6 dB sine at the ceiling minus the 0.2 dB safety (FL: -0.220 dBFS)', () => {
    const y = run(sine(1000, 1, 2, SR));
    const pk = peak(y, SR / 2);
    expect(20 * Math.log10(pk)).toBeCloseTo(-0.22, 2);
    expect(pk).toBeCloseTo(0.975, 4);
    // ceiling -8.7 dB (500): 0.36603 * 0.975
    expect(peak(run(sine(1000, 1, 1.5, SR), { ceil: 500 }), SR / 2)).toBeCloseTo(0.366025 * 0.975, 4);
    // option off: the limiter sits on the ceiling
    expect(peak(run(sine(1000, 1, 2, SR), { safety: false }), SR / 2)).toBeCloseTo(1, 4);
  });

  it('matches FL\'s gain envelope on a DC step (look-ahead attack, 10 ms hold, curve-3 release)', () => {
    const i0 = 22050, i1 = i0 + 8820;
    const x = dc([[0.1, i0], [2, 8820], [0.1, 44100]]);
    const y = run(x, {}, 200);
    const g = (i: number) => y[i + 88] / x[i];
    const fl: [number, number][] = [[-88, 0.99937], [-80, 0.946025], [-60, 0.661943], [-40, 0.527883], [-20, 0.494947], [0, 0.488709], [100, 0.4875]];
    for (const [k, v] of fl) expect(Math.abs(g(i0 + k) - v)).toBeLessThan(2e-5);
    const rel: [number, number][] = [[300, 0.4875], [441, 0.487714], [500, 0.488715], [882, 0.535393], [1000, 0.567272], [1500, 0.817452], [2000, 1]];
    for (const [k, v] of rel) expect(Math.abs(g(i1 + k) - v)).toBeLessThan(2e-5);
  });

  it('matches FL\'s compressor curve: threshold, ratio, knee (+10 dB over -20 dB)', () => {
    const lv = Math.pow(10, -9.98 / 20);
    const fl: [number, number, number][] = [[0, 556, 0.421667], [0, 0, 1], [1000, 556, 0.340677], [1000, 0, 0.425884], [500, 556, 0.392894], [500, 0, 0.753623], [-500, 556, 0.430913], [-500, 0, 1.090685]];
    for (const [knee, ratio, gain] of fl) {
      const y = run(new Float32Array(2000).fill(lv), { ceil: 2000, att: 0, sustain: 0, cAtt: 0, cRel: 0, cSustain: 0, cThres: 242, cRatio: ratio, cKnee: knee });
      expect(Math.abs(y[1500] / lv - gain)).toBeLessThan(3e-5);
      expect(limCompGain(lv, limCompThres(242), 1 / limRatio(ratio), knee)).toBeCloseTo(gain, 4);
    }
  });

  it('matches FL\'s saturation curve and noise gate', () => {
    const n = 3001;
    const ramp = new Float32Array(n);
    for (let i = 0; i < n; i++) ramp[i] = -1.5 + (3 * i) / (n - 1);
    const s = run(ramp, { sat: 631, ceil: 2000, att: 0, sustain: 0 });
    expect(s[2200]).toBeCloseTo(0.664861, 5);
    expect(s[2500]).toBeCloseTo(0.816089, 5);
    expect(s[3000]).toBeCloseTo(0.932353, 5);
    expect(s[500]).toBeCloseTo(-0.816089, 5);
    const gate = run(new Float32Array(8000).fill(0.01), { nThres: 135, nGain: 631, att: 0, sustain: 0 });
    expect(gate[100] / 0.01).toBeCloseTo(0.886359, 4);
    expect(gate[1000] / 0.01).toBeCloseTo(0.47624, 4);
    expect(gate[4000] / 0.01).toBeCloseTo(0.402465, 4);
  });

  it('clips at the ceiling with SAT at 0 dB and clamps at a threshold above the ceiling (FL)', () => {
    // a 9.0 step after silence with +18 dB gain overshoots the look-ahead; FL clips at the ceiling (no safety)
    const x = dc([[0, 2205], [9, 6000]]);
    const y1 = run(x, { ceil: 1200, att: 1115, gain: 2000 });
    expect(peak(y1)).toBeCloseTo(1.368599, 5);
    const y2 = run(x, { ceil: 100, att: 1115, gain: 2000 });
    expect(peak(y2)).toBeCloseTo(0.058062, 5);
    // SAT threshold above min(1, ceiling): the curve degenerates to a clamp at the threshold
    const y3 = run(x, { ceil: 100, att: 1115, gain: 2000, sat: 200 });
    expect(peak(y3)).toBeCloseTo(0.12288, 4);
    // the ceiling still caps the gain while the gate is closed (gate at 0 dB, noise gain -11.2 dB)
    const n = new Float32Array(8000);
    for (let i = 0; i < n.length; i++) n[i] = Math.sin(i * 0.37) * 0.9;
    expect(peak(run(n, { ceil: 300, nThres: 1000, nGain: 500 }), 1000)).toBeCloseTo(0.195195 * 0.975, 3);
  });

  it('keys the compressor from the selected sidechain input (FL: DC sidechain 0.5 -> -13.26 dB)', () => {
    const p = { ceil: 2000, att: 0, sustain: 0, cAtt: 0, cRel: 0, cSustain: 0, cThres: 242, cRatio: 1000, sidechain: 1 };
    const fx = make(p);
    const n = 1024;
    const L = new Float32Array(n).fill(0.25), R = new Float32Array(n).fill(0.25);
    const scL = new Float32Array(n).fill(0.5), scR = new Float32Array(n).fill(0.5);
    for (let i = 0; i < n; i += 128) {
      fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, makeCtx({ sampleRate: SR, sidechain: [{ source: 2, L: scL.subarray(i, i + 128), R: scR.subarray(i, i + 128) }] }));
    }
    expect(L[900] / 0.25).toBeCloseTo(0.2173, 3);
    // no sidechain signal routed: the selected input is silent, nothing is compressed
    const fx2 = make(p);
    const L2 = new Float32Array(128).fill(0.25), R2 = new Float32Array(128).fill(0.25);
    fx2.process(L2, R2, 128, makeCtx({ sampleRate: SR }));
    expect(L2[100]).toBeCloseTo(0.25, 6);
  });

  it('ramps gain changes instead of stepping (no zipper with zero attack)', () => {
    const fx = make({ att: 0, ceil: 2000 });
    const a = new Float32Array(128).fill(0.1), b = new Float32Array(128).fill(0.1);
    fx.process(a, b, 128, makeCtx({ sampleRate: SR }));
    fx.setParams({ ...defaultFxParams('limiter'), att: 0, ceil: 2000, gain: 1500 });
    const L = new Float32Array(512).fill(0.1), R = new Float32Array(512).fill(0.1);
    fx.process(L, R, 512, makeCtx({ sampleRate: SR }));
    expect(L[0]).toBeLessThan(0.11);
    for (let i = 1; i < 512; i++) expect(Math.abs(L[i] - L[i - 1])).toBeLessThan(0.002);
    expect(L[400]).toBeCloseTo(0.292, 3);
  });

  it('stays silent on silence and finite at extreme settings', () => {
    const silent = run(new Float32Array(4096));
    expect(peak(silent)).toBe(0);
    const extremes: Record<string, number>[] = [
      { gain: 2000, sat: 0, ceil: 0, att: 0, rel: 0, sustain: 0, cThres: 0, cRatio: -1000, cKnee: -1000, cAtt: 0, cRel: 0, cSustain: 0, nGain: 0, nThres: 1000, nRel: 0 },
      { gain: 2000, sat: 1000, ceil: 2000, att: 10000, attCurve: 8, rel: 10000, relCurve: 8, sustain: 10000, cThres: 0, cRatio: 1000, cKnee: 1000, cAtt: 10000, cRel: 10000, cCurve: 8, cSustain: 10000 },
      { gain: 0, ceil: 0, nThres: 1000 },
    ];
    const noise = new Float32Array(SR);
    let seed = 1;
    for (let i = 0; i < noise.length; i++) { seed = (seed * 16807) % 2147483647; noise[i] = (seed / 2147483647 - 0.5) * (i % 9000 < 4500 ? 40 : 0.001); }
    noise[1000] = NaN;
    noise[2000] = Infinity;
    for (const p of extremes) {
      const fx = make(p);
      const [L, R] = render(fx, noise, noise, 128, { sampleRate: SR });
      for (let i = 0; i < L.length; i++) { expect(Number.isFinite(L[i])).toBe(true); expect(Number.isFinite(R[i])).toBe(true); }
      expect(peak(L)).toBeLessThan(10);
    }
  });

  it('feeds the display: slices of input/output peaks and gain envelopes', () => {
    const fx = make();
    render(fx, sine(1000, 0.1, 2, SR), undefined, 128, { sampleRate: SR });
    const m = fx.monitor!()!;
    expect(m.n).toBe(Math.floor((0.1 * SR) / 64));
    const s = m.slices as Float32Array;
    expect(s.length).toBe((m.n as number) * 6);
    const last = ((m.n as number) - 1) * 6;
    expect(s[last]).toBeCloseTo(2, 2); // input peak
    expect(s[last + 1]).toBeGreaterThan(0.95); // output peak (sampled sine)
    expect(s[last + 1]).toBeLessThanOrEqual(0.9751);
    expect(s[last + 2]).toBeCloseTo(0.4875, 3); // total gain
    expect(fx.monitor!()!.n).toBe(0);
  });

  it('repairs stored states (spare state, display options)', () => {
    const p = normalizeFxParams('limiter', { gain: 1500, spare: { gain: 99999 }, speed: 400, tab: 7 });
    expect(p.gain).toBe(1500);
    expect((p.spare as Record<string, number>).gain).toBe(2000);
    expect((p.spare as Record<string, number>).ceil).toBe(1000);
    expect(p.speed).toBe(100);
    expect(p.tab).toBe(0);
    expect(p.safety).toBe(true);
  });
});
