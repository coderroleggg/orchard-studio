import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { vocEdges, vocKnobHz, vocLevelGain, vocResampleLevels } from '../../src/model/fx/plugins/vocoder';
import { makeCtx, peak, rms, sine } from './util';

const SR = 44100;

function make(over: Record<string, unknown> = {}) {
  const fx = createEffect('vocoder', SR, 128);
  fx.setParams({ ...defaultFxParams('vocoder'), ...over });
  fx.reset();
  return fx;
}

/** Run with separate modulator (left) and carrier (right) inputs; returns the left output. */
function run(fx: ReturnType<typeof make>, mod: Float32Array, car: Float32Array, block = 128): Float32Array {
  const L = Float32Array.from(mod), R = Float32Array.from(car);
  const ctx = makeCtx({ sampleRate: SR });
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    fx.process(L.subarray(i, i + n), R.subarray(i, i + n), n, ctx);
  }
  return L;
}

function noise(n: number, amp = 0.1, seed = 1): Float32Array {
  let s = seed >>> 0;
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // sum of uniforms ~ gaussian
    let a = 0;
    for (let k = 0; k < 4; k++) { s = (s * 1664525 + 1013904223) >>> 0; a += s / 4294967296 - 0.5; }
    b[i] = a * amp * 1.7;
  }
  return b;
}

/** Energy of x in [f0, f1] Hz (Goertzel over a set of bins). */
function bandEnergy(x: Float32Array, f0: number, f1: number, from = 0): number {
  const N = 4096;
  let e = 0;
  for (let f = f0; f <= f1; f += SR / N) {
    const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < N; i++) {
      const v = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)) + c * s1 - s2;
      s2 = s1; s1 = v;
    }
    e += s1 * s1 + s2 * s2 - c * s1 * s2;
  }
  return e;
}

describe('Vocoder', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('vocoder')!;
    expect(d.name).toBe('Vocoder');
    expect([d.width, d.height]).toEqual([406, 300]);
    expect(d.params.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(d.params.map((p) => p.name)).toEqual([
      'Starting freq', 'Ending freq', 'Freq scale', 'Invert modulator freqs', 'Formant', 'Bandwidth',
      'Attack', 'Release', 'Hold modulator', 'Modulator level', 'Carrier level', 'Wet level',
    ]);
    const p = defaultFxParams('vocoder');
    expect(p).toMatchObject({ fmin: 0, fmax: 65536, scale: 64, invert: 0, formant: 0, bw: 50, att: 20, rel: 100, hold: 0, modLvl: 0, carLvl: 0, wetLvl: 128, bands: 2, order: 2, listen: 2, swap: false });
    expect((p.levels as number[]).length).toBe(16);
    const t = (k: string, v: number) => formatParam(d.params.find((q) => q.key === k)!, v);
    expect(t('fmin', 0)).toBe('10Hz');
    expect(t('fmin', 2048)).toBe('35Hz');
    expect(t('fmin', 32768)).toBe('1457Hz');
    expect(t('fmax', 65536)).toBe('16000Hz');
    expect(t('scale', 64)).toBe('50%');
    expect(t('formant', 0)).toBe('+0.00 cent');
    expect(t('formant', -1)).toBe('-1.00 cent');
    expect(t('formant', 300)).toBe('+300.00 cents');
    expect(t('bw', 5)).toBe('3%');
    expect(t('bw', 50)).toBe('25%');
    expect(t('att', 20)).toBe('20ms');
    expect(t('modLvl', 16)).toBe('13%');
    expect(t('wetLvl', 160)).toBe('125%');
    expect(t('invert', 1)).toBe('ON');
  });

  it('lays out the bands and level curve like FL', () => {
    expect(vocKnobHz(0)).toBeCloseTo(10, 6);
    expect(vocKnobHz(65536)).toBeCloseTo(16000, 6);
    // band centres measured from FL (16 bands, 10 Hz .. 16 kHz, scale 50%)
    const fl = [25.19, 92.49, 176.1, 286.55, 433.55, 629.49, 890.84, 1239.5, 1704.7, 2325.4, 3153.6, 4258.6, 5733.2, 7700.8, 10326, 13829];
    const e = vocEdges(16, 10, 16000, 0.5);
    for (let i = 0; i < 16; i++) expect(Math.sqrt(e[i] * e[i + 1]) / fl[i]).toBeCloseTo(1, 3);
    // scale 0%: B = 2; top band at 15307 Hz in FL
    const e0 = vocEdges(16, 10, 16000, 0);
    expect(Math.sqrt(e0[15] * e0[16])).toBeCloseTo(15307, -1);
    expect(vocLevelGain(64)).toBeCloseTo(0.23166, 4);
    expect(vocLevelGain(128)).toBeCloseTo(1, 9);
    expect(vocLevelGain(160)).toBeCloseTo(1.90328, 4);
    expect(vocResampleLevels([1, 2], 4)).toEqual([1, 1, 2, 2]);
  });

  it('imposes the modulator spectrum on the carrier', () => {
    const n = SR;
    const car = noise(n, 0.1, 3);
    for (const fm of [300, 3000]) {
      const fx = make();
      const out = run(fx, sine(fm, 1, 0.3, SR), car);
      const near = bandEnergy(out, fm * 0.85, fm * 1.15, SR / 2);
      const far = bandEnergy(out, fm === 300 ? 2500 : 250, fm === 300 ? 3500 : 350, SR / 2);
      expect(near).toBeGreaterThan(far * 100);
    }
    // no modulator: nothing passes; no carrier: nothing passes
    expect(peak(run(make(), new Float32Array(8192), noise(8192)))).toBe(0);
    expect(peak(run(make(), noise(8192), new Float32Array(8192)))).toBe(0);
  });

  it('matches FL\'s band gain: 1500/bw x mean |modulator band| x carrier', () => {
    // band 8 alone (other band levels at 0), modulator = carrier = sine at its centre
    const e = vocEdges(16, 10, 16000, 0.5);
    const fc = Math.sqrt(e[8] * e[9]);
    const levels = new Array(16).fill(0); levels[8] = 1;
    for (const bw of [20, 50, 200]) {
      const fx = make({ levels, bw, att: 100, rel: 100 });
      const x = sine(fc, 1.5, 0.1, SR);
      const out = run(fx, x, x);
      const amp = rms(out, SR, SR + 22050) * Math.SQRT2;
      expect(amp).toBeCloseTo((1500 / bw) * (0.2 / Math.PI) * 0.1, 2);
    }
  });

  it('solos, swaps and holds', () => {
    const mod = noise(4096, 0.2, 5), car = noise(4096, 0.1, 9);
    const solo0 = run(make({ listen: 0 }), mod, car);
    expect(Math.abs(solo0[3000] - mod[3000])).toBeLessThan(1e-6);
    const solo1 = run(make({ listen: 1 }), mod, car);
    expect(Math.abs(solo1[3000] - car[3000])).toBeLessThan(1e-6);
    const a = run(make({ swap: true }), car, mod);
    const b = run(make(), mod, car);
    expect(Math.abs(a[3000] - b[3000])).toBeLessThan(1e-6);
    // hold from the start: envelopes stay at zero
    expect(peak(run(make({ hold: 1 }), mod, car))).toBe(0);
    // hold after a sound: the frozen envelopes keep vocoding the carrier with the modulator silent
    const fx = make();
    const x = sine(1000, 0.5, 0.3, SR);
    run(fx, x, noise(x.length));
    fx.setParams({ ...defaultFxParams('vocoder'), hold: 1 });
    const held = run(fx, new Float32Array(SR / 2), noise(SR / 2, 0.1, 11));
    expect(rms(held, SR / 4, SR / 2)).toBeGreaterThan(0.01);
  });

  it('mixes the dry modulator and carrier with FL\'s level curve', () => {
    const mod = noise(2048, 0.2, 2), car = noise(2048, 0.1, 4);
    const out = run(make({ wetLvl: 0, modLvl: 64, carLvl: 160 }), mod, car);
    const i = 1500;
    expect(out[i]).toBeCloseTo(vocLevelGain(64) * mod[i] + vocLevelGain(160) * car[i], 5);
  });

  it('ramps level changes and glides frequency changes without jumps', () => {
    const fx = make({ wetLvl: 0, carLvl: 128 });
    const one = new Float32Array(128).fill(0.5);
    run(fx, one, one);
    fx.setParams({ ...defaultFxParams('vocoder'), wetLvl: 0, carLvl: 0 });
    const out = run(fx, one, one);
    expect(out[0]).toBeCloseTo(0.5, 2);
    expect(out[64]).toBeCloseTo(0.25, 2);
    expect(out[127]).toBeLessThan(0.01);
    // sweep the band range and formant while vocoding: output stays bounded and continuous
    const fx2 = make();
    const mod = sine(800, 1, 0.3, SR), car = noise(SR, 0.1, 6);
    const L = Float32Array.from(mod), R = Float32Array.from(car);
    let maxJump = 0, prev = 0;
    for (let i = 0, k = 0; i < L.length; i += 128, k++) {
      if (k % 20 === 0) fx2.setParams({ ...defaultFxParams('vocoder'), fmin: (k * 997) % 40000, formant: ((k * 37) % 2400) - 1200, bw: 5 + (k % 195) });
      const n = Math.min(128, L.length - i);
      fx2.process(L.subarray(i, i + n), R.subarray(i, i + n), n, makeCtx({ sampleRate: SR }));
      for (let j = i; j < i + n; j++) { maxJump = Math.max(maxJump, Math.abs(L[j] - prev)); prev = L[j]; }
    }
    expect(Number.isFinite(maxJump)).toBe(true);
    expect(peak(L)).toBeLessThan(20);
  });

  it('stays silent on silence and finite at extreme settings', () => {
    const z = new Float32Array(SR / 4);
    expect(peak(run(make(), z, z))).toBe(0);
    const extremes: Record<string, unknown>[] = [
      { bands: 5, order: 3, bw: 5 },
      { bands: 5, order: 1, bw: 200, scale: 0 },
      { fmin: 65536, fmax: 0 },
      { fmin: 40000, fmax: 40001 },
      { formant: 1200, bands: 4 },
      { formant: -1200, fmin: 0, fmax: 1000 },
      { levels: new Array(16).fill(1e6), wetLvl: 160 },
      { att: 10, rel: 10, bw: 5, bands: 0 },
    ];
    for (const ex of extremes) {
      const fx = make(ex);
      const out = run(fx, noise(SR / 2, 0.5, 7), noise(SR / 2, 0.5, 8));
      for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) throw new Error(`non-finite output for ${JSON.stringify(ex).slice(0, 80)}`);
    }
    // a min > max range silences the vocoded signal (FL: ~1e-8)
    expect(peak(run(make({ fmin: 50000, fmax: 10000 }), noise(8192), noise(8192)))).toBe(0);
  });

  it('reports zero latency and a release-dependent tail', () => {
    const fx = make({ rel: 1000 });
    expect(fx.latency ?? 0).toBe(0);
    expect(fx.tail).toBeGreaterThanOrEqual(1.5);
    expect(fx.tail).toBeLessThanOrEqual(30);
    const m = fx.monitor!()!;
    expect(m.n).toBe(16);
  });

  it('switches the band count with a short fade', () => {
    const fx = make();
    const mod = noise(SR, 0.2, 12), car = noise(SR, 0.1, 13);
    const L = Float32Array.from(mod), R = Float32Array.from(car);
    const ctx = makeCtx({ sampleRate: SR });
    for (let i = 0, k = 0; i < L.length; i += 128, k++) {
      if (k === 100) fx.setParams({ ...defaultFxParams('vocoder'), bands: 5, levels: new Array(128).fill(1) });
      const n = Math.min(128, L.length - i);
      fx.process(L.subarray(i, i + n), R.subarray(i, i + n), n, ctx);
    }
    expect(fx.monitor!()!.n).toBe(128);
    expect(rms(L, SR / 2, SR)).toBeGreaterThan(0.001);
  });
});
