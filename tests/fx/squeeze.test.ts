import { describe, it, expect } from 'vitest';
// The plugin's def and effect are imported directly (not through the registries) so this
// suite does not depend on the other plugins' modules.
import { def } from '../../src/model/fx/plugins/squeeze';
import { effect, relatedImpact, squeezeSamples, squeezeSteps, squeezeSvf } from '../../src/engine/effects/plugins/squeeze';
import { render, sine, rms, peak } from './util';
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
/** A "clean" state: no squarize steps, no puncher, filter off, fully wet, unity gain. */
const CLEAN = { gain: 127, mix: 128, steps: 1, filter: 0, ftype: 0, res: 32768, cutoff: 32768, fpos: 0, relation: 0, impact: 0, preserve: 7500, amount: 0 };

function make(p: Record<string, number> = {}, sr = SR) {
  const fx = createEffect('squeeze', sr, 128);
  fx.setParams({ ...defaultFxParams('squeeze'), ...p });
  fx.reset();
  return fx;
}

function amp(x: Float32Array, f: number, a: number, z: number, sr = SR): number {
  let re = 0, im = 0;
  for (let i = a; i < z; i++) {
    const w = (2 * Math.PI * f * i) / sr;
    re += x[i] * Math.cos(w);
    im += x[i] * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / (z - a);
}

describe('Squeeze', () => {
  it('is registered with FL ranges, value texts, and the Default preset as defaults', () => {
    const d = fxDef('squeeze')!;
    expect([d.width, d.height]).toEqual([279, 220]);
    expect(d.params.map((p) => [p.name, p.index, p.min, p.max])).toEqual([
      ['Gain', 0, 0, 160], ['Mix', 1, 0, 128], ['Steps', 2, 1, 32768], ['Filter', 3, 0, 1], ['Filter type', 4, 0, 4],
      ['Filter Resonance', 5, 0, 65536], ['Filter Cutoff', 6, 0, 65536], ['Filter Position', 7, 0, 1], ['Relation', 8, 0, 3],
      ['Impact', 9, 0, 44100], ['Preserve', 10, 0, 44100], ['Amount', 11, 0, 65536],
    ]);
    expect(defaultFxParams('squeeze')).toMatchObject({ gain: 93, mix: 108, steps: 28417, filter: 1, ftype: 4, res: 46592, cutoff: 23552, fpos: 1, relation: 0, impact: 2892, preserve: 4684, amount: 0 });
    const t = (k: number, v: number) => formatParam(d.params[k], v);
    expect([t(0, 20), t(0, 127), t(0, 160)]).toEqual(['16%', '100%', '126%']);
    expect(t(1, 64)).toBe('50.0% dry / 50.0% wet');
    expect(t(1, 16)).toBe('87.5% dry / 12.5% wet');
    expect([t(2, 1), t(2, 16385), t(2, 28417), t(2, 32768)]).toEqual(['32757.6 steps', '181.0 steps', '4.0 steps', '1.0 steps']);
    expect([t(4, 0), t(4, 4), t(7, 1), t(8, 2)]).toEqual(['low pass', 'peak', 'pos', 'impact = preserve x 2']);
    expect([t(9, 0), t(9, 5513), t(9, 11025), t(9, 22050), t(10, 7500), t(10, 44100)]).toEqual(['0 samples', '3 samples', '13 samples', '209 samples', '5 samples', '44100 samples']);
    expect(d.presets?.map((p) => p.name)).toEqual(['Default', 'Grit', 'Low Squeek', 'Off', 'Punch', 'Squeek']);
  });

  it('uses FL\'s knob laws', () => {
    expect(squeezeSteps(16385)).toBeCloseTo(181.0, 0);
    expect(squeezeSamples(22050)).toBeCloseTo(209.0, 0);
    expect(relatedImpact(1, 7000, 5)).toBe(7000);
    expect(relatedImpact(2, 7000, 5)).toBe(14000);
    expect(relatedImpact(3, 7001, 5)).toBe(3500);
    expect(relatedImpact(0, 7000, 5)).toBe(5);
  });

  it('squarize rounds to 1/steps (round half to even)', () => {
    const fx = make({ ...CLEAN, steps: 32768 }); // 1 step: values round to -1, 0, 1
    const x = new Float32Array([0.3, 0.6, -0.6, 0.5, 1.5, -0.2, 0.49, 2.5]);
    const [L] = render(fx, x);
    expect(Array.from(L).map((v) => v + 0)).toEqual([0, 1, -1, 0, 2, 0, 0, 2]);
  });

  it('matches FL\'s filter responses (measured, cutoff 50 %, resonance 50 %)', () => {
    const ref: [number, number[]][] = [
      [0, [1.0231, 3.136, 0.0702]], [1, [0.0247, 3.136, 1.0821]], [2, [0.1592, 3.1361, 0.2716]],
      [3, [0.9984, 0.0021, 1.0119]], [4, [1.0478, 6.272, 1.1524]],
    ];
    for (const [ftype, levels] of ref) {
      [200, 1286, 5000].forEach((f, i) => {
        const fx = make({ ...CLEAN, filter: 1, ftype });
        const [L] = render(fx, sine(f, 0.5, 0.1, SR));
        expect(amp(L, f, 11025, 22050) / 0.1).toBeCloseTo(levels[i], 2);
      });
    }
  });

  it('keeps FL\'s 44.1 kHz filter coefficients at other rates (peak moves to 1400 Hz at 48 kHz)', () => {
    const at = (f: number) => {
      const fx = make({ ...CLEAN, filter: 1 }, 48000);
      const [L] = render(fx, sine(f, 0.5, 0.1, 48000), undefined, 128, { sampleRate: 48000 });
      return amp(L, f, 12000, 24000, 48000) / 0.1;
    };
    expect(at(1400)).toBeCloseTo(3.1356, 2);
    expect(at(1286)).toBeCloseTo(2.9619, 2);
    expect(squeezeSvf(0.5, 0.5).f).toBeCloseTo(2 * Math.sin((Math.PI * Math.sqrt(50 * 33075)) / 88200), 6);
  });

  it('puncher alternates preserve and impact (amount 0 silences the impact phase)', () => {
    // preserve 22050 -> 209 samples kept, impact 22050 -> 209 samples muted
    const fx = make({ ...CLEAN, impact: 22050, preserve: 22050, amount: 0 });
    const x = new Float32Array(SR).fill(0.5);
    const [L] = render(fx, x);
    let zeros = 0;
    for (let i = 0; i < L.length; i++) if (L[i] === 0) zeros++;
    expect(zeros / L.length).toBeCloseTo(0.5, 1);
    // first run: ~210 preserved samples, then ~209 muted
    let k = 0;
    while (L[k] !== 0) k++;
    expect(k).toBeGreaterThan(205);
    expect(k).toBeLessThan(215);
    const amt = make({ ...CLEAN, impact: 22050, preserve: 22050, amount: 32768 });
    const [A] = render(amt, x);
    expect(Math.min(...Array.from(A.subarray(1000, 3000)))).toBeCloseTo(0.25, 2);
  });

  it('passes silent blocks through untouched, and stays finite at maximum resonance', () => {
    const fx = make();
    const tiny = new Float32Array(256).fill(5e-7);
    const [T] = render(fx, tiny);
    expect(T[100]).toBeCloseTo(5e-7, 12);
    const hot = make({ ...CLEAN, filter: 1, ftype: 4, res: 65536, cutoff: 65536 });
    const [H, R] = render(hot, sine(3000, 0.5, 1, SR));
    expect(H.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
    const bad = sine(500, 0.05, 0.5, SR);
    bad[30] = NaN;
    const [B] = render(make(), bad);
    expect(B.every(Number.isFinite)).toBe(true);
  });

  it('applies gain and mix changes at the next block without smoothing (FL)', () => {
    const fx = make({ ...CLEAN });
    render(fx, new Float32Array(2048).fill(0.4));
    fx.setParams({ ...defaultFxParams('squeeze'), ...CLEAN, gain: 0 });
    const [L] = render(fx, new Float32Array(512).fill(0.4));
    expect(L[0]).toBe(0);
    expect(peak(L)).toBe(0);
  });

  it('full resonance gives q = 0 and stays bounded through FL\'s single-precision rounding (noise, 10 s)', () => {
    expect(squeezeSvf(0.5, 1).q).toBe(0);
    const fx = make({ ...CLEAN, filter: 1, ftype: 0, res: 65536, cutoff: 32768, fpos: 0, mix: 128 });
    let s = 7;
    const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296 - 0.5; };
    const x = new Float32Array(441000);
    for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.3;
    const [L] = render(fx, x);
    expect(L.every(Number.isFinite)).toBe(true);
    expect(peak(L)).toBeLessThan(100); // FL: 30 s of 0.1-rms noise peaks at 13.5 (low pass)
  });
});
