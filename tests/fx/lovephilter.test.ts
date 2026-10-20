import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import {
  LP_PARAMS, lpDefaultState, lpEnvValue, lpExpandPreset, lpKey, lpSegment, lpStepCount, lpLfoTicks, type LpEnv, type LpState,
} from '../../src/model/fx/plugins/lovephilter';
import { LP_PRESET_DATA } from '../../src/model/fx/plugins/lovephilter.presets';
import { lpControlPeriod } from '../../src/engine/effects/plugins/lovephilter';
import { makeCtx, render, rms, sine, peak } from './util';

const base = () => ({ ...defaultFxParams('lovephilter') }) as Record<string, unknown>;

/** Impulse response of a state (amp scales the impulse; the result is divided back). */
function impulse(lp: LpState, params: Record<string, number> = {}, n = 16, amp = 1): Float32Array {
  const fx = createEffect('lovephilter', 48000, 128);
  fx.setParams({ ...base(), ...params, lp });
  fx.reset();
  const x = new Float32Array(2048); x[0] = amp;
  return render(fx, x)[0].slice(0, n).map((v) => v / amp);
}

function unitState(f: (lp: LpState) => void): LpState {
  const lp = lpDefaultState();
  f(lp);
  return lp;
}

describe('Love Philter', () => {
  it('is registered with FL parameters, defaults and factory presets', () => {
    const d = fxDef('lovephilter')!;
    expect(d.name).toBe('Love Philter');
    expect([d.width, d.height]).toEqual([670, 400]);
    expect(LP_PARAMS.length).toBe(359);
    expect(d.params.length).toBe(359);
    expect(d.params.map((p) => p.index)).toEqual(LP_PARAMS.map((_, i) => i));
    expect(fxParamDef('lovephilter', 'u1cutSpd')!.name).toBe('Filter 1 - Filter cutoff - LFO speed (phase)');
    expect(fxParamDef('lovephilter', 'u8next')).toBeUndefined(); // unit 8 has no "to next filter"
    expect(formatParam(fxParamDef('lovephilter', 'u1pan')!, -64)).toBe('50% left');
    expect(formatParam(fxParamDef('lovephilter', 'efAtt')!, 4096)).toBe('25ms');
    expect(d.presets!.length).toBe(47);
    expect(d.presets![0].name).toBe('Default');
    expect(d.presets!.map((p) => p.name)).toContain('Filter/Dist lowpass');
    // the Default preset equals the initial state
    const def0 = d.presets![0].params;
    for (const p of LP_PARAMS) expect(def0[p.key]).toBe(p.def);
    expect((def0.lp as LpState).os).toBe(1);
    expect(d.viewState).toEqual(['lpUi']);
  });

  it('expands compact presets with switched-off patterns', () => {
    const tri = LP_PRESET_DATA.find((p) => p.n === 'Filter/Simple triangle lowpass LFO')!;
    const lp = lpExpandPreset(tri).lp as LpState;
    const T = lp.units[0].t[2];
    expect(T.pats[0]?.off).toBe(1); // FL keeps the pattern but its switch is off
    expect(T.lfo).toEqual([0.25, 1]);
    expect(lp.units[0].mode).toBe(3);
    expect(lp.units[0].type).toBe(1);
  });

  it('control period and envelope accuracy follow the sample rate (measured)', () => {
    expect(lpControlPeriod(44100, false)).toBe(64);
    expect(lpControlPeriod(48000, false)).toBe(68);
    expect(lpControlPeriod(96000, false)).toBe(140);
    expect(lpControlPeriod(48000, true)).toBe(8);
    expect(lpControlPeriod(96000, true)).toBe(16);
  });

  it('evaluates FL envelope curves (measured shapes)', () => {
    // single curve (B = 2^(20 |T|)), stairs, pulse, hold, smooth stairs, half sine, smooth
    expect(lpSegment(0.5, -0.5, 0)).toBeCloseTo(31 / 1023, 6);
    expect(lpStepCount(0.5)).toBe(17);
    expect(lpStepCount(0.25)).toBe(127);
    expect(lpStepCount(0.75)).toBe(3);
    expect(lpSegment(0.5, 0.5, 3)).toBeCloseTo(9 / 17, 6);
    expect(lpSegment(0.0047, -0.5, 3)).toBeCloseTo(1 / 18, 6);
    expect(lpSegment(0.3, 1, 5)).toBe(0);
    expect(lpSegment(0.7, 1, 5)).toBe(1);
    expect(lpSegment(0.7, -1, 5)).toBe(0);
    expect(lpSegment(0.99, 0, 2)).toBe(0);
    [[0.0672, 0.001], [0.3172, 0.128], [0.4422, 0.346], [0.5047, 0.514], [0.7547, 0.941]].forEach(([u, v]) => expect(lpSegment(u, 1, 4)).toBeCloseTo(v, 3));
    expect(lpSegment(0.0672, 1, 9)).toBeCloseTo(Math.sin(0.0672 * Math.PI / 2), 6);
    expect(lpSegment(0.0672, 0, 10)).toBeCloseTo(0.0129, 3);
    // loops: time past the loop end wraps; the segment out of the loop start starts at the loop end value
    const e: LpEnv = { p: [[0, 0, 0, 0], [1, 1, 0, 0], [1, 0.5, 0, 0], [1, 0.25, 0, 0]], ls: 1, le: 3 };
    expect(lpEnvValue(e, 3.5)).toBeCloseTo(0.375, 6);
    expect(lpEnvValue(e, 4)).toBeCloseTo(0.5, 6);
    // a two-point loop keeps the end value (FL)
    expect(lpEnvValue({ p: [[0, 0, 0, 0], [1, 1, 0, 0]], ls: 0, le: 1 }, 1.5)).toBe(1);
    expect(lpLfoTicks(65536)).toBeCloseTo(6.0006, 3);
  });

  it('matches FL impulse responses', () => {
    // Default preset (SVF single, 2x oversampling): FL values
    const d = impulse(lpDefaultState());
    [0, 4.4e-5, 0.001036, 0.0088, 0.034445, 0.071262, 0.093833, 0.109026, 0.124813, 0.128884, 0.132178, 0.128435]
      .forEach((v, i) => expect(d[i]).toBeCloseTo(v, 5));
    // Lime low pass at cut 240 / res 0 without oversampling: f > 1, FL raises R to keep (1 - f) + f R = 0.1
    const lime = impulse(unitState((lp) => { lp.os = 0; lp.units[0].type = 1; }), { u1cut: 240, u1res: 0 });
    [1.09069, 0.010154, -0.108974, -0.00203, 0.010879, 0.000304].forEach((v, i) => expect(lime[i]).toBeCloseTo(v, 4));
    // Vanilla peaking, gain from the low knob
    const pk = impulse(unitState((lp) => { lp.os = 0; lp.units[0].type = 9; }), { u1low: 96 });
    [1.047132, 0.09327, 0.090942, 0.08795, 0.084327].forEach((v, i) => expect(pk[i]).toBeCloseTo(v, 4));
    // Mango ladder, small signal (measured linear model)
    const mg = impulse(unitState((lp) => { lp.os = 0; lp.units[0].type = 11; }), { u1res: 64 }, 10, 0.001);
    [0.02344, 0.09413, 0.20371, 0.33277, 0.46125, 0.57286, 0.65647, 0.70599, 0.71963, 0.69899].forEach((v, i) => expect(mg[i]).toBeCloseTo(v, 2));
  });

  it('pans with FL stereo matrix (measured)', () => {
    const fx = createEffect('lovephilter', 48000, 128);
    fx.setParams({ ...base(), u1pan: 64, lp: unitState((lp) => { lp.os = 0; lp.units[0].mode = 0; }) });
    fx.reset();
    const one = new Float32Array(4096).fill(0.5), zero = new Float32Array(4096);
    let [L, R] = render(fx, one, zero);
    expect(L[4000] / 0.5).toBeCloseTo(0.5412, 3); // left input stays left with sqrt2 cos
    expect(R[4000] / 0.5).toBeCloseTo(0.29973, 3); // and leaks into the near side
    fx.reset();
    [L, R] = render(fx, zero, one);
    expect(L[4000]).toBeCloseTo(0, 6);
    expect(R[4000] / 0.5).toBeCloseTo(1.00683, 3);
  });

  it('switched-off patterns are neutral and patterns slew at 441 / s', () => {
    const gate = (off: boolean) => unitState((lp) => {
      lp.os = 0; lp.units[0].mode = 0;
      const e: LpEnv = { p: [[0, 1, 0, 0], [0.5, 1, 0, 0], [0, 0, 0, 0], [1, 0, 0, 0]], ls: -1, le: -1 };
      if (off) e.off = 1;
      lp.units[0].t[1].pats[0] = e;
    });
    const dc = new Float32Array(48000).fill(0.5);
    let fx = createEffect('lovephilter', 48000, 544);
    fx.setParams({ ...base(), lp: gate(true) }); fx.reset();
    expect(render(fx, dc, dc, 544)[0][30000]).toBeCloseTo(0.5, 6);
    fx = createEffect('lovephilter', 48000, 544);
    fx.setParams({ ...base(), lp: gate(false) }); fx.reset();
    const out = render(fx, dc, dc, 544)[0];
    expect(out[11000]).toBeCloseTo(0.5, 6);
    expect(out[20000]).toBeCloseTo(0, 6);
    // the step (at 12000) falls at most 0.0091875 per sample (full scale in 100 samples at 44.1 kHz)
    let maxStep = 0;
    for (let i = 11900; i < 12400; i++) maxStep = Math.max(maxStep, Math.abs(out[i + 1] - out[i]) / 0.5);
    expect(maxStep).toBeLessThan(0.0092);
    expect(maxStep).toBeGreaterThan(0.009);
  });

  it('LFO modulates the cutoff locked to the song position', () => {
    const lp = unitState((L) => { L.units[0].t[2].lfo = [1, 1]; });
    const fx = createEffect('lovephilter', 48000, 128);
    fx.setParams({ ...base(), lp, u1cutSpd: 30000 });
    fx.reset();
    const out = render(fx, sine(3000, 2, 0.3))[0];
    const seg = (a: number) => rms(out, a, a + 1200);
    const levels = [0, 6000, 12000, 18000, 24000, 30000, 36000, 42000].map(seg);
    expect(Math.max(...levels) / Math.min(...levels)).toBeGreaterThan(2);
  });

  it('stays finite and silent on silence for every filter type and mode', () => {
    for (let type = 0; type < 12; type++) {
      for (const mode of [1, 3, 5]) {
        const lp = unitState((L) => { L.units[0].type = type; L.units[0].mode = mode; L.units[0].ws = 1; L.center = 1; });
        const fx = createEffect('lovephilter', 48000, 128);
        fx.setParams({ ...base(), lp, u1res: 256, u1cut: 256, u1low: 128 });
        fx.reset();
        const loud = render(fx, sine(110, 0.3, 1))[0];
        expect(Number.isFinite(rms(loud))).toBe(true);
        expect(peak(loud)).toBeLessThan(200);
        // (full resonance may self-oscillate, as in FL); at half resonance silence decays to silence
        fx.setParams({ ...base(), lp, u1res: 128, u1cut: 256, u1low: 128 });
        const z = render(fx, new Float32Array(48000))[0];
        expect(peak(z, 47000)).toBeLessThan(1e-3);
      }
    }
  });

  it('ramps knob changes without steps', () => {
    const fx = createEffect('lovephilter', 48000, 128);
    fx.setParams({ ...base(), lp: unitState((L) => { L.os = 0; L.units[0].mode = 0; }) });
    fx.reset();
    const dc = new Float32Array(1024).fill(0.5);
    render(fx, dc);
    fx.setParams({ ...base(), [lpKey(0, 'vol')]: 0, lp: unitState((L) => { L.os = 0; L.units[0].mode = 0; }) });
    const [L] = render(fx, dc);
    let maxStep = 0;
    for (let i = 1; i < 1024; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
    expect(L[1000]).toBeCloseTo(0, 6);
    expect(maxStep).toBeLessThan(0.02);
  });

  it('follows the song position when playing and free-runs when stopped', () => {
    const lp = unitState((L) => { L.os = 0; L.units[0].mode = 0; L.units[0].t[1].pats[0] = { p: [[0, 0, 0, 0], [1, 1, 0, 0]], ls: -1, le: -1 }; });
    const fx = createEffect('lovephilter', 48000, 128);
    fx.setParams({ ...base(), lp });
    fx.reset();
    const dc = new Float32Array(48000).fill(0.5);
    // playing from bar 0: the ramp reaches 1 after one beat (0.5 s at 120 BPM)
    const a = render(fx, dc, dc, 128, { playing: true })[0];
    expect(a[6000] / 0.5).toBeCloseTo(0.25, 1);
    expect(a[30000] / 0.5).toBeCloseTo(1, 3);
    fx.reset();
    const ctx = makeCtx({ playing: false, pos: 0 });
    const L = dc.slice(0, 12000), R = dc.slice(0, 12000);
    for (let i = 0; i < 12000; i += 128) fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, 12000 - i), ctx);
    expect(L[11900] / 0.5).toBeGreaterThan(0.4); // the stopped clock still advances
  });
});
