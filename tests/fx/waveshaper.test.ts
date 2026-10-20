import { describe, it, expect } from 'vitest';
// The plugin's def and effect are imported directly (not through the registries) so this
// suite does not depend on the other plugins' modules.
import { def, wsAutoPoints, wsCurve, wsCurveValue, wsPostGain, wsPreGain, type WsPoint } from '../../src/model/fx/plugins/waveshaper';
import { effect, wsTable } from '../../src/engine/effects/plugins/waveshaper';
import { render, sine, peak } from './util';
import type { FxParamDef } from '../../src/model/fx/types';

const fxDef = (_id: string) => def;
/** As the registry's formatParam. */
const formatParam = (q: FxParamDef, v: number): string =>
  q.format ? q.format(v) : q.options ? (q.options[Math.round(v - q.min)] ?? String(v)) : String(Math.round(v * 1000) / 1000);
function defaultFxParams(_id: string): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const q of def.params) p[q.key] = q.def;
  return { ...p, ...(def.state?.() ?? {}) };
}
const createEffect = (_id: string, sr: number, block: number) => effect.create(sr, block, { sample: () => undefined });

const SR = 44100;

function make(p: Record<string, unknown> = {}) {
  const fx = createEffect('waveshaper', SR, 128);
  fx.setParams({ ...defaultFxParams('waveshaper'), ...p });
  fx.reset();
  return fx;
}

function preset(name: string): Record<string, unknown> {
  const pr = fxDef('waveshaper')!.presets!.find((p) => p.name === name)!;
  return structuredClone(pr.params);
}

function dc(fx: ReturnType<typeof make>, x: number): number {
  const [L] = render(fx, new Float32Array(256).fill(x));
  return L[255];
}

function amp(x: Float32Array, f: number, a: number, z: number): number {
  let re = 0, im = 0;
  for (let i = a; i < z; i++) {
    const w = (2 * Math.PI * f * i) / SR;
    re += x[i] * Math.cos(w);
    im += x[i] * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / (z - a);
}

describe('WaveShaper', () => {
  it('is registered with FL ranges, value texts, state and the 34 factory presets', () => {
    const d = fxDef('waveshaper')!;
    expect([d.width, d.height]).toEqual([270, 353]);
    expect(d.params.map((p) => [p.name, p.index, p.min, p.max, p.def])).toEqual([
      ['Pre amp', 0, 64, 192, 128], ['Mix level', 1, 0, 128, 128], ['Post gain', 2, 0, 128, 128],
    ]);
    const t = (k: number, v: number) => formatParam(d.params[k], v);
    expect([t(0, 64), t(0, 65), t(0, 72), t(0, 128), t(0, 192)]).toEqual(['0%', '2%', '13%', '100%', '200%']);
    expect([t(1, 16), t(2, 112)]).toEqual(['13%', '88%']);
    expect(defaultFxParams('waveshaper')).toMatchObject({ curve: [[0, 0, 0, 0], [1, 1, 0, 0]], bipolar: 0, center: 0, oversample: 0, hq: 0, smooth: 0, snap: 1 });
    expect(d.presets?.length).toBe(34);
    expect(preset('Half wave rectify')).toMatchObject({ pre: 134, bipolar: 1, center: 1, oversample: 1, curve: [[0, 0.5, 0, 0], [0.5, 0.5, 0, 0], [1, 1, 0, 0]] });
    expect(wsCurve([[0.5, 2], 'x', [0, -1]])).toEqual([[0, 0, 0, 0], [0.5, 1, 0, 0]]);
  });

  it('uses FL\'s gain laws (measured through FL\'s plugin)', () => {
    expect(wsPreGain(192)).toBeCloseTo(2.33333, 4);
    expect(wsPreGain(64)).toBeCloseTo(0.33333, 4);
    expect(wsPostGain(64)).toBeCloseTo(0.23166, 4);
    // zero curve: only the dry path is left; FL: pre 160 mix 100 post 110 -> 0.159396, pre 192 mix 64 -> 1.166667
    const zero: WsPoint[] = [[0, 0, 0, 0], [1, 0, 0, 0]];
    expect(dc(make({ curve: zero, pre: 160, mix: 100, post: 110, hq: 1 }), 0.05) / 0.05).toBeCloseTo(0.159396, 4);
    expect(dc(make({ curve: zero, pre: 192, mix: 64, hq: 1 }), 0.05) / 0.05).toBeCloseTo(1.166667, 4);
    // identity curve, mix 128, HQ: out = x * mul (FL: 0.333313 at pre 64, 2.333191 at pre 192)
    expect(dc(make({ pre: 64, hq: 1 }), 0.05) / 0.05).toBeCloseTo(0.333313, 4);
    expect(dc(make({ pre: 192, hq: 1 }), 0.05) / 0.05).toBeCloseTo(2.333191, 4);
  });

  it('evaluates curves like FL\'s envelopes (single curve tension, measured)', () => {
    const at = (t: number, x: number) => wsCurveValue(wsAutoPoints([[0, 0, 0, 0], [1, 1, t, 0]]), x);
    const xs = [0.05, 0.25, 0.5, 0.75, 0.95];
    const fl: [number, number[]][] = [
      [-0.5, [0.0004, 0.0046, 0.0307, 0.177, 0.7077]],
      [0.1, [0.0891, 0.39, 0.6661, 0.8616, 0.976]],
      [1, [0.4988, 0.9683, 0.999, 0.9999, 1]],
    ];
    for (const [t, vals] of fl) xs.forEach((x, i) => expect(at(t, x)).toBeCloseTo(vals[i], 3));
    // half sine (mode 9), tension 1: sin(pi/2 x)
    expect(wsCurveValue(wsAutoPoints([[0, 0, 0, 0], [1, 1, 1, 9]]), 0.5)).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('builds FL\'s int16 tables (16384 points unipolar, 32768 bipolar)', () => {
    const u = wsTable([[0, 0, 0, 0], [1, 1, 0, 0]], false);
    expect(u.size).toBe(16383);
    expect(u.tab[1]).toBe(0);
    expect(u.tab[16384]).toBe(32767);
    const b = wsTable([[0, 0, 0, 0], [1, 1, 0, 0]], true);
    expect(b.size).toBe(32767);
    expect(b.tab[1]).toBe(-32768);
    expect(b.tab[32768]).toBe(32767);
  });

  it('matches FL\'s output for factory presets (1 kHz sine, 0.8 peak; samples rendered by FL)', () => {
    const ref: [string, number[]][] = [
      ['Soft clip 1', [-0.10565, 0.45104, 0.10821, -0.45093, -0.11209, 0.44949]],
      ['Half wave rectify', [-0.22803, 0.61951, -0.02455, -0.22992, -0.22939, 0.61573]],
      ['Crossover', [-0.42554, 0.62802, 0.43776, -0.62846, -0.45015, 0.6285]],
      ['Kinda tanh', [-0.19539, 0.61133, 0.19974, -0.61163, -0.20605, 0.60999]],
    ];
    for (const [name, vals] of ref) {
      const fx = make(preset(name));
      const [L] = render(fx, sine(1000, 0.2, 0.8, SR));
      [3000, 3011, 3022, 3033, 3044, 3055].forEach((i, k) => expect(L[i]).toBeCloseTo(vals[k], 3));
    }
  });

  it('HQ off truncates (FL\'s dead zone below 1/16383), HQ on interpolates', () => {
    expect(dc(make(), 4e-5)).toBe(0);
    expect(dc(make({ hq: 1 }), 4e-5)).toBeCloseTo(4e-5, 6);
  });

  it('half-wave rectify (bipolar) mutes the negative half; Center removes the DC it creates', () => {
    const p = { ...preset('Half wave rectify'), center: 0, oversample: 0, pre: 128 };
    expect(dc(make(p), -0.5)).toBeCloseTo(0, 4);
    expect(dc(make(p), 0.5)).toBeCloseTo(0.5, 3);
    const c = make({ ...p, center: 1 });
    const [L] = render(c, sine(200, 3, 0.5, SR));
    let mean = 0;
    for (let i = L.length - 44100; i < L.length; i++) mean += L[i];
    expect(Math.abs(mean / 44100)).toBeLessThan(0.002);
  });

  it('oversampling (FL\'s half-bands) lowers the aliasing of a hard clip curve', () => {
    const clip: WsPoint[] = [[0, 0, 0, 0], [0.25, 0.5, 0, 0], [1, 0.5, 0, 0]];
    const run = (os: number) => {
      const fx = make({ curve: clip, pre: 192, oversample: os, hq: 1 });
      const [L] = render(fx, sine(5000, 0.75, 0.8, SR));
      const fund = amp(L, 5000, 8192, 32768);
      // aliases of 5f / 7f / 9f at 44.1 kHz: 19.1, 9.1 and 900 Hz... (3f = 15 kHz is real)
      return Math.max(amp(L, 19100, 8192, 32768), amp(L, 9100, 8192, 32768), amp(L, 900, 8192, 32768)) / fund;
    };
    expect(20 * Math.log10(run(4))).toBeLessThan(20 * Math.log10(run(0)) - 15);
  });

  it('smooths gain changes, stays finite and silent for silence', () => {
    const fx = make({ smooth: 1 });
    render(fx, new Float32Array(2048).fill(0.5));
    fx.setParams({ ...defaultFxParams('waveshaper'), smooth: 1, post: 0 });
    const [L] = render(fx, new Float32Array(512).fill(0.5));
    expect(L[0]).toBeGreaterThan(0.4);
    expect(L[511]).toBeLessThan(0.01);
    const s = make(preset('Fuzzy'));
    const [S] = render(s, new Float32Array(2048));
    expect(peak(S)).toBeLessThan(1e-3);
    const bad = sine(300, 0.05, 1, SR);
    bad[7] = NaN; bad[9] = Infinity;
    const [B, R] = render(make({ ...preset('Megataver'), hq: 1 }), bad);
    expect(B.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
  });

  it('without Smooth, gain changes take effect at the next block (FL steps them, no de-zipper)', () => {
    const fx = make({ post: 128 });
    render(fx, new Float32Array(1024).fill(0.5));
    fx.setParams({ ...defaultFxParams('waveshaper'), post: 0 });
    const [L] = render(fx, new Float32Array(128).fill(0.5));
    expect(L[0]).toBe(0);
  });

  it('with Smooth, a new instance fades in from silence (FL starts its smoothed gains at 0)', () => {
    const [L] = render(make({ smooth: 1 }), new Float32Array(4096).fill(0.5));
    expect(Math.abs(L[0])).toBeLessThan(0.01);
    expect(L[4095]).toBeCloseTo(0.5, 2);
  });

  it('exporting switches to interpolation and forces 16x oversampling like FL ("HQ for all plugins")', () => {
    const x = sine(3000, 0.05, 0.8, SR);
    for (const os of [0, 1, 2]) {
      const p = { ...preset('Soft clip 1'), oversample: os, hq: 0 };
      const [E] = render(make(p), x, undefined, 128, { rendering: true });
      const [H] = render(make({ ...p, hq: 1, oversample: os > 0 ? 4 : 0 }), x);
      for (let i = 0; i < E.length; i += 37) expect(E[i]).toBe(H[i]);
    }
  });
});
