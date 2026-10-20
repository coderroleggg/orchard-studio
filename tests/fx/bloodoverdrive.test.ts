import { describe, it, expect } from 'vitest';
// The plugin's def and effect are imported directly (not through the registries) so this
// suite does not depend on the other plugins' modules.
import { effect } from '../../src/engine/effects/plugins/bloodoverdrive';
import { def, fracText, postGainText } from '../../src/model/fx/plugins/bloodoverdrive';
import { bloodShape } from '../../src/engine/effects/plugins/distructor/blood';
import { Downsampler, Upsampler } from '../../src/engine/effects/plugins/distructor/oversample';
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

function make(p: Record<string, number> = {}) {
  const fx = createEffect('bloodoverdrive', SR, 128);
  fx.setParams({ ...defaultFxParams('bloodoverdrive'), ...p });
  fx.reset();
  return fx;
}

/** Amplitude of frequency f in x (single-bin DFT over the given range). */
function amp(x: Float32Array, f: number, a: number, z: number): number {
  let re = 0, im = 0;
  for (let i = a; i < z; i++) {
    const w = (2 * Math.PI * f * i) / SR;
    re += x[i] * Math.cos(w);
    im += x[i] * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / (z - a);
}

describe('Blood Overdrive', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('bloodoverdrive')!;
    expect(d.name).toBe('Blood Overdrive');
    expect(d.category).toBe('Distortion');
    expect([d.width, d.height]).toEqual([420, 180]);
    expect(d.params.map((p) => [p.name, p.index, p.min, p.max, p.def])).toEqual([
      ['Pre band', 0, 0, 10000, 0], ['Color', 1, 0, 10000, 5000], ['Pre amp', 2, 0, 10000, 0],
      ['x100', 3, 0, 1, 0], ['Post filter', 4, 0, 10000, 0], ['Post gain', 5, 0, 10000, 10000],
    ]);
    expect(defaultFxParams('bloodoverdrive')).toMatchObject({ preBand: 0, color: 5000, preAmp: 0, x100: 0, postFilter: 0, postGain: 10000, theme: 0 });
    expect(fracText(5000)).toBe('0.5000');
    expect(postGainText(0)).toBe('-1.0000');
    expect(postGainText(10000)).toBe('0.0000');
    expect(formatParam(d.params[3], 1)).toBe('On');
    expect(d.presets?.map((p) => p.name)).toEqual(['Boost', 'Drive', 'Reset']);
    expect(d.presets?.[1].params).toMatchObject({ preBand: 8500, preAmp: 10000, postGain: 5000 });
  });

  it('matches harmonic levels measured from FL\'s plugin (100 Hz sine, 0.5 peak, 44.1 kHz)', () => {
    // flfxhost render "Fruity Blood Overdrive": harmonic amplitudes in dB (H1, H3, H5, H7, H9)
    const ref: [Record<string, number>, number[]][] = [
      [{}, [-2.8, -34.3, -76.4]],
      [{ preAmp: 5000 }, [1.5, -10.3, -16.7, -25.0, -34.5]],
      [{ preAmp: 10000, x100: 1, postGain: 3000 }, [-18.8, -28.4, -32.7, -35.4, -37.5]],
      [{ preBand: 8000, color: 3000, preAmp: 6000, postFilter: 5000 }, [1.5, -10.4, -17.4, -26.7, -38.1]],
    ];
    const f0 = SR / 441;
    for (const [p, levels] of ref) {
      const fx = make(p);
      const [L] = render(fx, sine(f0, 1, 0.5, SR));
      levels.forEach((lv, i) => {
        const h = 2 * i + 1;
        expect(20 * Math.log10(amp(L, f0 * h, 22050, 22050 + 441 * 40))).toBeCloseTo(lv, 0);
      });
    }
  });

  it('uses FL\'s 65536-entry sine table with its truncation, clamp and integer wrap', () => {
    // T[32768 + i] = f32(sin(i pi / 65536)), index trunc(f32(u * 32767)) + 32768
    expect(bloodShape(0.5)).toBe(Math.fround(Math.sin((16383 * Math.PI) / 65536)));
    // the negative side is offset by one entry (T[32767 - i] = -T[32768 + i]): FL's one-step asymmetry
    expect(bloodShape(-0.5)).toBe(-Math.fround(Math.sin((16382 * Math.PI) / 65536)));
    expect(bloodShape(2)).toBe(Math.fround(Math.sin((32767 * Math.PI) / 65536)));
    expect(bloodShape(-3)).toBe(-Math.fround(Math.sin((32767 * Math.PI) / 65536)));
    // u >= 65537: the int32 index wraps negative and FL reads entry 0 (about -1)
    expect(bloodShape(70000)).toBe(-Math.fround(Math.sin((32767 * Math.PI) / 65536)));
    // FL (flfxhost, 1 s preroll): DC 0.5 settles at 0.707072913646698
    const fx = make();
    const [L] = render(fx, new Float32Array(20000).fill(0.5));
    expect(L[19999]).toBe(Math.fround(0.707072913646698));
  });

  it('pre amp gain is 1 + 25 p^3 (x2500 with x100)', () => {
    const fx = make({ preAmp: 10000 });
    const [L] = render(fx, new Float32Array(20000).fill(0.01));
    expect(L[19999]).toBeCloseTo(Math.sin((Math.PI / 2) * 0.26), 3);
    const fx2 = make({ preAmp: 5000 });
    const [L2] = render(fx2, new Float32Array(20000).fill(0.01));
    expect(L2[19999]).toBeCloseTo(Math.sin((Math.PI / 2) * 0.04125), 3);
    const fx3 = make({ preAmp: 2000, x100: 1 });
    const [L3] = render(fx3, new Float32Array(20000).fill(0.01));
    expect(L3[19999]).toBeCloseTo(Math.sin((Math.PI / 2) * 0.21), 3); // 1 + 2500 * 0.008 = 21
  });

  it('post gain scales by gain^2 and the output never exceeds the final clip', () => {
    const fx = make({ postGain: 5000 });
    const [L] = render(fx, new Float32Array(20000).fill(0.5));
    expect(L[19999]).toBeCloseTo(0.25 * Math.SQRT1_2, 3);
    const hot = make({ preAmp: 10000, x100: 1 });
    const [H] = render(hot, sine(220, 0.5, 1));
    expect(peak(H)).toBeLessThanOrEqual(1.15); // clipped at 0.99995 before decimation (band-limited overshoot)
    expect(peak(H, 4410)).toBeGreaterThan(0.95);
  });

  it('splits into three bands that saturate independently', () => {
    // a loud 100 Hz tone hardly compresses a quiet 7.35 kHz tone (separate band) but does compress 1 kHz
    const quiet = (f: number, loud: number) => {
      const fx = make();
      const x = sine(100, 0.6, loud, SR);
      const y = sine(f, 0.6, 0.02, SR);
      for (let i = 0; i < x.length; i++) x[i] += y[i];
      const [L] = render(fx, x);
      return amp(L, f, 8820, 26460);
    };
    const hf = quiet(7350, 1) / quiet(7350, 0);
    const mf = quiet(1002, 1) / quiet(1002, 0);
    expect(20 * Math.log10(hf)).toBeGreaterThan(-2);
    expect(20 * Math.log10(mf)).toBeLessThan(-4);
  });

  it('post filter is a 2-pole low-pass (pole 0.2 .. 0.9)', () => {
    const lo = make({ postFilter: 10000 });
    const [a] = render(lo, sine(5000, 0.3, 0.05));
    const lo2 = make({ postFilter: 10000 });
    const [b] = render(lo2, sine(100, 0.3, 0.05));
    expect(20 * Math.log10(rms(a, 4000) / rms(b, 4000))).toBeLessThan(-25);
  });

  it('pre band (color) keeps the band around the colour frequency', () => {
    // pre band 1, color 0.5 -> SVF centre ~0.125 * fs / (2 pi) * 2 ... about 880 Hz
    const at = (f: number) => {
      const fx = make({ preBand: 10000, color: 5000 });
      const [L] = render(fx, sine(f, 0.4, 0.02));
      return rms(L, 8000);
    };
    expect(at(880) / at(60)).toBeGreaterThan(4);
    expect(at(880) / at(12000)).toBeGreaterThan(3);
  });

  it('smooths gain changes (no zipper)', () => {
    const fx = make();
    const x = new Float32Array(4096).fill(0.3);
    render(fx, x);
    fx.setParams({ ...defaultFxParams('bloodoverdrive'), postGain: 0 });
    const [L] = render(fx, new Float32Array(256).fill(0.3));
    const before = Math.sin((Math.PI / 2) * 0.3);
    expect(Math.abs(L[0] - before)).toBeLessThan(0.01);
    expect(L[255]).toBeLessThan(before);
    expect(L[255]).toBeGreaterThan(0.5 * before);
  });

  it('silence in gives silence out; stays finite at extreme settings and after NaN input', () => {
    const fx = make({ preAmp: 10000, x100: 1, preBand: 10000, color: 10000, postFilter: 10000 });
    const [L] = render(fx, new Float32Array(4096));
    expect(peak(L)).toBe(0);
    const bad = sine(3000, 0.1, 1);
    bad[100] = NaN; bad[200] = Infinity;
    const [B, R] = render(fx, bad);
    expect(B.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
    const [C] = render(fx, sine(500, 0.1, 0.5));
    expect(C.every(Number.isFinite)).toBe(true);
    expect(peak(C, 2000)).toBeGreaterThan(0.1);
  });

  it('runs at the base rate like FL (no oversampling): x100 on a 7 kHz sine is FL\'s output sample for sample', () => {
    // flfxhost render, pre amp 100 %, x100 on, 1 s preroll (our new instance is pre-settled like FL after 1 s)
    const fl = [0.2932582199573517, 0.7951227426528931, 0.9462867975234985, -0.2932581901550293,
      -0.7951227426528931, -0.9462867975234985, 0.2932581901550293, 0.7951227426528931];
    const fx = make({ preAmp: 10000, x100: 1 });
    const [L] = render(fx, sine(7000, 4096 / SR, 0.5, SR));
    fl.forEach((v, i) => expect(L[3000 + i]).toBe(Math.fround(v)));
  });

  it('half-band oversampler round trip is transparent at low frequencies', () => {
    for (const F of [2, 4, 8]) {
      const up = new Upsampler(F), down = new Downsampler(F);
      const buf = new Float64Array(F);
      let e = 0, s = 0;
      const out: number[] = [];
      for (let i = 0; i < 8192; i++) {
        up.process(Math.sin(2 * Math.PI * 0.01 * i), buf);
        out.push(down.process(buf));
      }
      // compare with the input delayed by the measured group delay (~2.4 .. 3.6 samples): amplitude ~1
      for (let i = 4096; i < 8192; i++) { e += out[i] * out[i]; s += 0.5; }
      expect(Math.sqrt(e / s)).toBeCloseTo(1, 2);
    }
  });
});
