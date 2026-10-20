import { describe, it, expect } from 'vitest';
// The plugin's def and effect are imported directly (not through the registries) so this
// suite does not depend on the other plugins' modules.
import { effect } from '../../src/engine/effects/plugins/distructor';
import { def, DX_KEYS, DX_MODULE_DEFAULTS, dxKey, dxModules, dxNewModule, type DxModule } from '../../src/model/fx/plugins/distructor';
import type { FxParamDef } from '../../src/model/fx/types';
import { render, sine, peak } from './util';

const SR = 44100;
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

/** A module descriptor (FL's module state) with test defaults: no Center, 1x. */
function mod(m: Partial<DxModule>): DxModule {
  return { type: 0, dist: 0, filter: 2, chorus: 0, cab: 1, os: 0, center: 0, smooth: 0, bypass: 0, color: 0, ...m };
}

/** Params for a chain of modules with raw per-module values {control index: raw}. */
function chain(mods: [Partial<DxModule>, Record<number, number>?][], softClip = 0): Record<string, unknown> {
  const p: Record<string, unknown> = { ...defaultFxParams('distructor'), softClip, modules: mods.map(([m], i) => mod({ color: i, ...m })) };
  mods.forEach(([, raw], s) => {
    DX_KEYS.forEach((_, k) => { p[dxKey(s, k)] = raw?.[k] ?? DX_MODULE_DEFAULTS[k]; });
  });
  return p;
}

function make(p: Record<string, unknown>, block = 128) {
  const fx = createEffect('distructor', SR, block);
  fx.setParams(p);
  fx.reset();
  return fx;
}

/** Steady-state output for a constant input. */
function dc(p: Record<string, unknown>, x: number): number {
  const [L] = render(make(p), new Float32Array(2048).fill(x));
  return L[2047];
}

describe('Distructor', () => {
  it('is registered with FL\'s 196 parameters, module state and the 47 factory presets', () => {
    const d = fxDef('distructor')!;
    expect([d.width, d.height, d.params.length]).toEqual([924, 385, 196]);
    expect(d.params.slice(0, 3).map((q) => [q.name, q.index, q.min, q.max, q.def])).toEqual([
      ['Module 1: Blood overdrive - Pre band', 0, 0, 10000, 0],
      ['Module 1: Blood overdrive - Color', 1, 0, 10000, 5000],
      ['Module 1: Blood overdrive - Pre amp', 2, 0, 10000, 0],
    ]);
    const q = (name: string) => d.params.find((x) => x.name === name)!;
    expect([q('Module 4: Chorus color').index, q('Module 2: Filter Resonance').index, q('Module 3: Fast dist - Pre amp').min]).toEqual([195, 89, 64]);
    // FL's Default preset (loaded on insert): Harmor Classic, Low pass 12, Stereo chorus, Combo 05
    expect([q('Module 1: Harmor classic - Filter cut').def, q('Module 2: Filter Resonance').def, q('Module 3: Chorus delay').def]).toEqual([1100, 2616, 1]);
    const p = defaultFxParams('distructor');
    expect(p.softClip).toBe(1);
    expect((p.modules as DxModule[]).map((m) => [m.type, m.dist, m.filter, m.chorus, m.cab, m.os])).toEqual([[0, 3, 2, 0, 1, 0], [1, 0, 2, 0, 1, 0], [2, 0, 2, 0, 1, 0], [3, 0, 2, 0, 10, 0]]);
    expect(d.presets?.length).toBe(47);
    expect(d.presets?.[1]).toMatchObject({ name: 'Empty', params: { softClip: 0, modules: [] } });
    // stored module lists are repaired (at most 4, every field clamped)
    const fixed = dxModules([{ type: 7, dist: 99, filter: -3, os: 9, cab: 77 }, {}, {}, {}, {}]);
    expect(fixed.length).toBe(4);
    expect(fixed[0]).toMatchObject({ type: 3, dist: 17, filter: 0, os: 4, cab: 58 });
    expect(dxNewModule(1, 2)).toMatchObject({ type: 1, filter: 2, os: 1, smooth: 1, color: 2 });
  });

  it('formats values like FL (texts read through FL\'s plugin)', () => {
    const d = fxDef('distructor')!;
    const t = (key: string, v: number) => formatParam(d.params.find((x) => x.key === key)!, v);
    const cases: [string, number, string][] = [
      ['m1_boPreBand', 2500, '25%'], ['m1_wfPreAmp', 2500, '15.6dB'], ['m1_wfThres', 2500, '-9.8dB'], ['m1_wfCross', 0, '-100%'],
      ['m1_wfCross', 7500, '50%'], ['m1_apThres', 5000, '-2.5dB'], ['m1_fdPreAmp', 90, '14%'], ['m1_fdPreAmp', 186, '64%'],
      ['m1_fdThres', 6, '50%'], ['m1_scThres', 32, '24%'], ['m1_scThres', 121, '94%'], ['m1_scPost', 128, '80%'],
      ['m1_hmAsym', -250, '50% stereo'], ['m1_hmAsym', 450, '90% mono'], ['m1_hmAsym', 0, '0%'], ['m1_hmWet', 1500, '75%'],
      ['m1_hmDry', -500, '-50%'], ['m1_hmCut', 500, '523.25Hz C5'], ['m1_hmCut', 950, '11839.82Hz F#9'], ['m1_hmCut', 1100, '33256.75Hz C11'],
      ['m1_abPreAmp', 2500, '3.5dB'], ['m1_abGate', 500, '-26.0dB'], ['m1_abGate', 0, '-InfdB'], ['m1_crRate', 0, 'Max Hz'],
      ['m1_crRate', 5000, '1447.31 Hz'], ['m1_crRate', 10000, '192.33 Hz'], ['m1_crBits', 2500, '9.00 bits'], ['m1_crBits', 10000, '2.00 bits'],
      ['m1_input', 0, '-InfdB'], ['m1_input', 2500, '-6.0dB'], ['m1_output', 7500, '3.5dB'], ['m1_mix', 2500, '25%'],
      ['m1_sepIn', -500, '50% separated'], ['m1_sepIn', 0, 'Original'], ['m1_sepOut', 1000, '100% merged'],
      ['m1_chDelay', 1, '1.0ms'], ['m1_chDelay', 109, '8.0ms'], ['m1_chDelay', 216, '34.9ms'], ['m1_chFeedback', 2880, '60.0%'],
      ['m1_chSpeed', 1500, '0.4Hz'], ['m1_chSpeed', 3000, '1.1Hz'], ['m1_chSpeed', 5700, '12.5Hz'], ['m1_chDepth', 585, '9.7%'],
      ['m1_chDepth', 1995, '33.3%'], ['m1_chDepth', 303, '5.1%'], ['m1_chColor', -1500, '-50.0%'], ['m1_chBlur', 3000, '50.0%'],
    ];
    for (const [k, v, s] of cases) expect([k, v, t(k, v)]).toEqual([k, v, s]);
  });

  it('is an exact passthrough without modules; "Soft clip output" is FL\'s Soft Clipper at 100/128', () => {
    expect(dc(chain([]), 0.73)).toBeCloseTo(0.73, 6);
    // FL: 0.5 -> 0.5, 0.8 -> 0.799219, 1 -> 0.919526, 1.5 -> 0.991816, 3 -> 0.999991, -1.2 -> -0.967746
    const fl: [number, number][] = [[0.5, 0.5], [0.8, 0.799219], [1, 0.919526], [1.5, 0.991816], [3, 0.999991], [-1.2, -0.967746]];
    for (const [x, y] of fl) expect(dc(chain([], 1), x)).toBeCloseTo(y, 5);
  });

  it('matches FL\'s static curves: Soft clipper, Wave folder, Fast dist, In / Mix / Out (DC through FL\'s plugin)', () => {
    const sc = chain([[{ dist: 2 }, { 21: 64, 22: 160 }]]);
    [[0.3, 0.570983], [0.6, 1.124141], [1, 1.553189], [2, 1.855897]].forEach(([x, y]) => expect(dc(sc, x)).toBeCloseTo(y, 5));
    const wf = chain([[{ dist: 14 }, { 6: 2500, 9: 6000 }]]);
    [[0.05, 0.3], [0.1, 0.6], [0.2, 0.08], [0.33, -0.58], [-0.27, 0.34]].forEach(([x, y]) => expect(dc(wf, x)).toBeCloseTo(y, 5));
    const fd = chain([[{ dist: 1 }, { 16: 170, 17: 6 }]]);
    [[0.05, 0.202637], [0.2, 0.405396], [0.5, 0.595642], [0.9, 0.595642]].forEach(([x, y]) => expect(dc(fd, x)).toBeCloseTo(y, 5));
    const io = chain([[{ dist: 2 }, { 21: 32, 36: 7500, 37: 6000, 38: 3000 }]]);
    [[0.1, 0.09], [0.4, 0.334686], [0.8, 0.571922]].forEach(([x, y]) => expect(dc(io, x)).toBeCloseTo(y, 5));
    // power off: untouched (gains bypassed too)
    expect(dc(chain([[{ dist: 2, bypass: 1 }, { 21: 1, 38: 1000 }]]), 0.7)).toBeCloseTo(0.7, 6);
  });

  it('evaluates the 11 Harmor shapers like FL (closed forms; DC through FL\'s plugin, pre amp 600)', () => {
    const X = [0.05, 0.2, 0.5, 0.9, -0.3];
    const fl: number[][] = [
      [0.177384, 0.314371, 0.318521, 0.318524, -0.318185], [0.237377, 0.536098, 0.547307, 0.547313, -0.201221],
      [0.224123, 0.318524, 0.318524, 0.318524, -0.239447], [0.306022, 0.31831, 0.31831, 0.31831, -0.31831],
      [0.356573, 0.480251, 0.562597, 0.615511, -0.51666], [0.065652, 0.260843, 0.417832, 0.417952, -0.368307],
      [0.380158, 0.525919, 0.292797, -0.146467, -0.483658], [0.055012, 0.306227, 0.318517, 0.318524, -0.317509],
      [0.090607, 0.156858, 0.454366, 0.93409, -0.312658], [0.035897, 0.215381, 0.502555, 0.897421, -0.287175],
      [0.051372, 0.204765, 0.490594, 0.914768, -0.297861],
    ];
    fl.forEach((ys, i) => {
      const p = chain([[{ dist: 3 + i }, { 23: 600, 27: 1100 }]]);
      X.forEach((x, j) => expect([3 + i, x, dc(p, x)]).toEqual([3 + i, x, expect.closeTo(ys[j], 5)]));
    });
  });

  it('reproduces FL\'s 22 filter models (magnitude responses measured through FL\'s plugin)', () => {
    const F = [100, 300, 1000, 3000, 10000];
    const N = 16384;
    const magDb = (model: number, cut: number, res: number) => {
      const x = new Float32Array(N);
      x[0] = 0.1;
      const [L] = render(make(chain([[{ type: 1, filter: model }, { 39: cut, 40: res }]])), x);
      return F.map((f) => {
        const k = Math.round((f * N) / SR);
        let re = 0, im = 0;
        for (let i = 0; i < N; i++) { const w = (2 * Math.PI * k * i) / N; re += L[i] * Math.cos(w); im -= L[i] * Math.sin(w); }
        return 20 * Math.log10(Math.hypot(re, im) / 0.1);
      });
    };
    const fl: [number, number, number, number[]][] = [
      [2, 5000, 5000, [0.18, 1.76, -4.37, -26.76, -51.06]], [6, 6000, 3000, [-88.85, -51.04, -14.0, -1.4, -0.08]],
      [4, 5000, 8000, [-15.96, -4.56, 0.44, -13.17, -25.52]], [7, 5000, 5000, [-0.04, -0.53, -1.54, -0.08, 0]],
      [12, 5000, 7000, [0.41, 3.7, 7.07, 0.75, 0.05]], [19, 4000, 8000, [12.53, 7.18, -0.55, -0.07, 0]],
      [21, 5000, 5000, [0, 0, 0, 0, 0]], [0, 3000, 0, [-1.42, -6.52, -16.05, -25.61, -37.59]],
    ];
    for (const [m, c, r, ref] of fl) magDb(m, c, r).forEach((d, i) => expect([m, F[i], d]).toEqual([m, F[i], expect.closeTo(ref[i], 1)]));
  });

  it('runs FL\'s chorus (Delay 3\'s engine) with its routing and start-up (samples rendered by FL from state load)', () => {
    const x = sine(220, 8192 / SR, 0.4, SR);
    const fl: [number, number[], number[]][] = [
      [0, [0.260333, 0.289701, 0.280914, 0.232395, 0.148461, 0.040761], [0.21352, 0.121724, 0.011467, -0.09598, -0.18806, -0.254799]],
      [1, [0.213778, 0.121944, 0.011588, -0.095957, -0.18812, -0.254943], [0.213759, 0.121919, 0.011563, -0.095979, -0.188137, -0.254952]],
      [2, [0.21352, 0.121724, 0.011467, -0.09598, -0.18806, -0.254799], [0.21352, 0.121724, 0.011467, -0.09598, -0.18806, -0.254799]],
    ];
    for (const [c, l, r] of fl) {
      const [L, R] = render(make(chain([[{ type: 2, chorus: c }, { 44: 1500, 47: 2000 }]])), x);
      l.forEach((v, i) => expect(L[6000 + 12 * i]).toBeCloseTo(v, 4));
      r.forEach((v, i) => expect(R[6000 + 12 * i]).toBeCloseTo(v, 4));
    }
    // Wide swaps: an L-only input comes out on R (feedback 0)
    const [L, R] = render(make(chain([[{ type: 2, chorus: 2 }, { 44: 0 }]])), x, new Float32Array(x.length));
    expect(peak(L, 4000)).toBeLessThan(1e-3);
    expect(peak(R, 4000)).toBeGreaterThan(0.3);
  });

  it('approximates FL\'s cabinets with fitted filters (no impulse responses); headers pass through', () => {
    const F = [100, 300, 1000, 3000, 10000];
    const N = 16384;
    const magDb = (cab: number) => {
      const x = new Float32Array(N);
      x[0] = 0.1;
      const out = render(make(chain([[{ type: 3, cab }]])), x);
      return out.map((Y) => F.map((f) => {
        const k = Math.round((f * N) / SR);
        let re = 0, im = 0;
        for (let i = 0; i < N; i++) { const w = (2 * Math.PI * k * i) / N; re += Y[i] * Math.cos(w); im -= Y[i] * Math.sin(w); }
        return 20 * Math.log10(Math.hypot(re, im) / 0.1);
      }));
    };
    // FL (impulse through the cabinet, single DFT bins): Closest, Model A, Combo 05 L / R, Blues L / R
    const fl: [number, number, number[], number][] = [
      [21, 0, [0.78, -6.01, -15.79, -11.48, -14.57], 0.6], [39, 0, [1.05, -8.85, -15.11, -11.07, -23.07], 0.6],
      [10, 0, [2.57, -6.9, -8.85, -6.87, -18.95], 0.6], [10, 1, [0.68, -8.79, -10.74, -8.76, -20.84], 0.6],
      [1, 0, [-4.87, -12.42, -19.06, -21.79, -64.23], 2], [1, 1, [-2.99, -14.41, -8.36, -10.69, -59.03], 3],
    ];
    for (const [cab, ch, ref, tol] of fl) magDb(cab)[ch].forEach((d, i) => expect(Math.abs(d - ref[i])).toBeLessThan(tol));
    expect(dc(chain([[{ type: 3, cab: 20 }, { 41: -1000 }]]), 0.37)).toBeCloseTo(0.37, 6);
  });

  it('matches FL sample for sample: Aperture A / B, Wave folder crossover, Crusher, Abrasive (FL\'s noise generator)', () => {
    const X = [0.1, 0.3, 0.45, 0.7, -0.6];
    const curve = (p: Record<string, unknown>, fl: number[]) => X.forEach((x, i) => expect(dc(p, x)).toBeCloseTo(fl[i], 5));
    curve(chain([[{ dist: 15 }, { 10: 1500 }]]), [0.4, -0.2, 0.4, 0.4, -0.8]);
    curve(chain([[{ dist: 15 }, { 10: 1500, 15: 1 }]]), [0.4, 0.8, 1.0, 0.8, -0.8]);
    curve(chain([[{ dist: 14 }, { 6: 1500, 7: 7500 }]]), [-0.4, -0.8, -0.2, 0.8, -0.4]);
    curve(chain([[{ dist: 17 }, { 35: 5000 }]]), [0.087441, 0.291471, 0.437206, 0.69953, -0.597515]);
    const x = sine(200, 2048 / SR, 0.6, SR);
    const [A] = render(make(chain([[{ dist: 16 }, { 30: 8000, 32: 6000, 33: 1 }]])), x);
    [-0.0736, -0.179269, -0.264181, -0.047589, -0.393925, -0.113198].forEach((v, i) => expect(A[1000 + 12 * i]).toBeCloseTo(v, 5));
    const [C] = render(make(chain([[{ dist: 17 }, { 34: 7000, 35: 2000 }]])), x);
    [0.491491, 0.491491, 0.275001, -0.003511, -0.003511, -0.297235].forEach((v, i) => expect(C[300 + 12 * i]).toBeCloseTo(v, 5));
  });

  it('oversamples modules with FL\'s half-band filters (impulse response) and runs Blood at the internal rate', () => {
    const ir = (os: number) => {
      const x = new Float32Array(256);
      x[16] = 0.5;
      const [L] = render(make(chain([[{ dist: 2, os }, { 21: 127 }]])), x);
      return Array.from(L.subarray(16, 28), (v) => v / 0.5);
    };
    const fl1 = [0.0005, 0.01897, 0.1788, 0.57667, 0.49788, -0.31483, -0.06342, 0.24795, -0.26126, 0.19346, -0.10637, 0.02909];
    const fl2 = [0.0, 0.00019, 0.00721, 0.0861, 0.39505, 0.64859, 0.04069, -0.36806, 0.27675, -0.07392, -0.085, 0.16838];
    ir(1).forEach((v, i) => expect(v).toBeCloseTo(fl1[i], 4));
    ir(2).forEach((v, i) => expect(v).toBeCloseTo(fl2[i], 4));
    const x = sine(220, 4096 / SR, 0.5, SR);
    // FL's module glides its Blood smoothers from 1, 1, 1, 0 after loading: 0.3 s of silence first, as in the FL render
    const bfx = make(chain([[{ dist: 0, os: 1 }, { 2: 6000, 0: 3000 }]]));
    render(bfx, new Float32Array(Math.round(0.3 * SR)));
    const [L] = render(bfx, x);
    const fl = [-0.54491, 0.44991, 1.00033, 1.00017, 1.00001, 0.99997]; // FL, after 0.3 s of silence (settled smoothing)
    fl.forEach((v, i) => expect(L[2000 + 10 * i]).toBeCloseTo(v, 3));
  });

  it('Center removes DC at the base rate after the mix (FL\'s step response)', () => {
    const x = new Float32Array(6000);
    x.fill(0.25, 100);
    const [L] = render(make(chain([[{ dist: 2, center: 1 }, { 21: 127 }]])), x);
    [[0, 0.99998], [100, 0.95644], [1000, 0.5681], [4410, 0.07885]].forEach(([k, v]) => expect(L[100 + k] / 0.25).toBeCloseTo(v, 4));
  });

  it('stays finite and silent for silence with every module type and model', () => {
    const mods: [Partial<DxModule>, Record<number, number>?][] = [];
    for (let d = 0; d < 18; d++) mods.push([{ type: 0, dist: d, os: d % 3 }, { 2: 8000, 23: 900, 6: 9000, 10: 9000, 28: 8000, 34: 7000, 35: 8000 }]);
    for (let f = 0; f < 22; f++) mods.push([{ type: 1, filter: f, os: f % 2 }, { 39: 3000 + 300 * f, 40: 9500 }]);
    for (let c = 0; c < 3; c++) mods.push([{ type: 2, chorus: c }, { 44: 3840, 47: 6000 }]);
    for (const cab of [0, 1, 19, 20, 21, 30, 58]) mods.push([{ type: 3, cab }, { 41: -1000, 42: 1000 }]);
    for (let i = 0; i < mods.length; i += 4) {
      const p = chain(mods.slice(i, i + 4), 1);
      // (FL's Low pass 24 Alt has a bias and a DC blocker: a short start-up transient, as in FL)
      const silent = render(make(p), new Float32Array(16384))[0];
      expect(peak(silent, 12288)).toBeLessThan(1e-3);
      const bad = sine(330, 0.1, 0.9, SR);
      bad[11] = NaN; bad[40] = Infinity; bad[90] = -Infinity;
      const [L, R] = render(make(p), bad);
      expect(L.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
    }
  });

  it('steps in / mix / out at the block start (FL) and kicks Harmor asymmetry the wrong way for one block', () => {
    const lin = (over: Record<number, number> = {}) => chain([[{ dist: 2 }, { 21: 127, ...over }]]);
    const fx = make(lin());
    render(fx, new Float32Array(256).fill(0.1));
    fx.setParams(lin({ 36: 8000 }));
    const [L] = render(fx, new Float32Array(128).fill(0.1));
    expect(L[0]).toBeCloseTo(0.16, 6); // input gain 8000 / 5000, no glide
    fx.setParams(lin({ 36: 8000, 38: 2500 }));
    const [M] = render(fx, new Float32Array(128).fill(0.1));
    expect(M[0]).toBeCloseTo(0.08, 6);
    // Harmor Classic, filter bypassed (cut 1100), dry 0: memoryless, so only FL's one-block kick differs
    const harm = (asym: number) => chain([[{ dist: 3 }, { 24: asym, 27: 1100 }]]);
    const a = make(harm(0)), b = make(harm(400));
    const x = sine(300, 1024 / SR, 0.3, SR);
    render(a, x.subarray(0, 512)); render(b, x.subarray(0, 512));
    a.setParams(harm(400));
    const [A1] = render(a, x.subarray(512, 640)), [B1] = render(b, x.subarray(512, 640));
    const [A2] = render(a, x.subarray(640, 768)), [B2] = render(b, x.subarray(640, 768));
    expect(Math.max(...A1.map((v, i) => Math.abs(v - B1[i])))).toBeGreaterThan(1e-3);
    expect(Math.max(...A2.map((v, i) => Math.abs(v - B2[i])))).toBeLessThan(1e-6);
  });
});
