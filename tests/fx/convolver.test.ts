import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { convWetGain, eqTOfFreq, eqFreqOfT } from '../../src/model/fx/plugins/convolver';
import { defaultImpulse, impulseKey, renderImpulse } from '../../src/engine/effects/plugins/convolver';
import type { FxEnv } from '../../src/engine/effects/types';
import { makeCtx, render, peak } from './util';

const SR = 48000;
const fmt = (k: string, v: number) => formatParam(fxParamDef('convolver', k)!, v);

function rnd(seed: number) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
}

/** An effect whose env delivers `ir` for its current settings (as the editor module does). */
function withImpulse(params: Record<string, unknown>, ir: Float32Array[]) {
  const p = { ...defaultFxParams('convolver'), ...params };
  const key = impulseKey(p, SR);
  const env: FxEnv = { sample: (id) => (id === key ? { channels: ir, sampleRate: SR } : undefined) };
  const fx = createEffect('convolver', SR, 128, env);
  fx.setParams(p);
  fx.reset();
  return fx;
}

describe('Convolver', () => {
  it('is registered with FL parameters, curves and texts', () => {
    const d = fxDef('convolver')!;
    expect(d.width).toBe(714);
    expect(d.height).toBe(346);
    expect(d.params.filter((q) => !q.noAuto).map((q) => [q.key, q.index])).toEqual([['dry', 0], ['wet', 1], ['inSep', 2], ['wetSep', 3]]);
    expect(defaultFxParams('convolver')).toMatchObject({ dry: 1000, wet: 500, inSep: 0, wetSep: 0, normalize: true, impulse: null });
    // FL value texts (flfxhost sweep)
    expect(fmt('wet', 500)).toBe('-30.3dB');
    expect(fmt('wet', 100)).toBe('-60.0dB');
    expect(fmt('wet', 0)).toBe('-InfdB');
    expect(fmt('dry', 500)).toBe('-12.7dB');
    expect(fmt('dry', 1000)).toBe('0.0dB');
    expect(fmt('inSep', -500)).toBe('50% separated');
    expect(fmt('inSep', 0)).toBe('Original');
    expect(fmt('wetSep', 1000)).toBe('100% merged');
    // FL's equalizer axis: 1 kHz at x 341 of 714
    expect(eqTOfFreq(1000) * 714).toBeCloseTo(341, 0);
    expect(eqFreqOfT(eqTOfFreq(5000))).toBeCloseTo(5000, 0);
  });

  it('convolves exactly with zero latency (head + three FFT levels, any block size)', () => {
    const r = rnd(5);
    const n = Math.round(1.2 * SR);
    const irL = new Float32Array(n), irR = new Float32Array(n);
    for (let i = 0; i < n; i++) { const e = Math.exp(-i / (0.3 * SR)); irL[i] = r() * e; irR[i] = r() * e; }
    const fx = withImpulse({ dry: 0, wet: 1000, normalize: false }, [irL, irR]);
    expect(fx.latency).toBe(0);
    const total = n + 4000;
    const xL = new Float32Array(total), xR = new Float32Array(total);
    for (let i = 0; i < 2000; i++) { xL[i] = r(); xR[i] = r(); }
    const L = Float32Array.from(xL), R = Float32Array.from(xR);
    const c = makeCtx();
    const sizes = [128, 64, 128, 37, 128, 91];
    for (let pos = 0, b = 0; pos < total; b++) { const m = Math.min(sizes[b % sizes.length], total - pos); fx.process(L.subarray(pos, pos + m), R.subarray(pos, pos + m), m, c); pos += m; }
    let err = 0;
    for (const t of [0, 127, 128, 2047, 2048, 16383, 16384, 30000, n - 5, n + 1500]) {
      let yl = 0, yr = 0;
      for (let k = Math.max(0, t - 1999); k <= t && k < n; k++) { yl += irL[k] * xL[t - k]; yr += irR[k] * xR[t - k]; }
      err = Math.max(err, Math.abs(yl - L[t]), Math.abs(yr - R[t]));
    }
    expect(err).toBeLessThan(1e-4);
  });

  it('plays the built-in room at FL\'s default level and honours the pre-delay', () => {
    const imp = (params: Record<string, unknown>) => {
      const fx = createEffect('convolver', SR, 128);
      fx.setParams({ ...defaultFxParams('convolver'), dry: 0, ...params });
      fx.reset();
      const x = new Float32Array(Math.round(3.6 * SR));
      x[0] = 1;
      return render(fx, x, Float32Array.from(x))[0];
    };
    const y = imp({});
    let e = 0;
    for (let i = 0; i < y.length; i++) e += y[i] * y[i];
    // normalised impulse energy 240 (per channel at 44.1 kHz) x wet -30.3 dB
    expect(e).toBeGreaterThan(0.7 * 240 * (SR / 44100) * convWetGain(500) ** 2);
    expect(e).toBeLessThan(1.3 * 240 * (SR / 44100) * convWetGain(500) ** 2);
    const first = (x: Float32Array) => x.findIndex((v) => Math.abs(v) > 1e-6);
    expect(first(imp({ delay: 100 })) - first(y)).toBe(Math.round(0.1 * SR));
  });

  it('renders impulse edits: equalizer cut, reverse, envelopes, stretch', () => {
    const base = renderImpulse(null, { normalize: false }, SR);
    const hfEnergy = (x: Float32Array) => { let e = 0; for (let i = 1; i < x.length; i++) { const d = x[i] - x[i - 1]; e += d * d; } return e; };
    const cut = renderImpulse(null, { normalize: false, eq: [{ t: 0, v: 0.5 }, { t: 0.45, v: 0.5 }, { t: 0.6, v: 0 }, { t: 1, v: 0 }] }, SR);
    expect(hfEnergy(cut[0])).toBeLessThan(hfEnergy(base[0]) * 0.2);
    const rev = renderImpulse(null, { normalize: false, reverse: true }, SR);
    expect(rev[0][rev[0].length - 1 - 1000]).toBeCloseTo(base[0][1000], 6);
    const faded = renderImpulse(null, { normalize: false, env: { vol: [{ t: 0, v: 1 }, { t: 0.1, v: 0 }, { t: 1, v: 0 }] } }, SR);
    expect(peak(faded[0], Math.round(0.5 * SR))).toBe(0);
    const longer = renderImpulse(null, { normalize: false, stretch: 1000 }, SR);
    expect(longer[0].length / base[0].length).toBeCloseTo(2, 2);
    expect(defaultImpulse(SR)[0].length).toBe(Math.round(3.4 * SR));
    // the key follows every impulse setting
    expect(impulseKey({ delay: 10 }, SR)).not.toBe(impulseKey({ delay: 11 }, SR));
    expect(impulseKey({}, 44100)).not.toBe(impulseKey({}, SR));
  });

  it('applies input / wet stereo separation, ramps levels, triggers a click and records', () => {
    const n = 2000;
    const ir = [new Float32Array(n), new Float32Array(n)];
    ir[0][0] = 1; ir[1][0] = 1; // identity impulse
    const fx = withImpulse({ dry: 0, wet: 1000, normalize: false, inSep: 1000 }, ir); // inputs merged to mono
    const L = new Float32Array(256).fill(1), R = new Float32Array(256).fill(0);
    fx.process(L, R, 256, makeCtx());
    expect(L[200]).toBeCloseTo(0.5, 3);
    expect(R[200]).toBeCloseTo(0.5, 3);
    // wet change ramps over the block
    fx.setParams({ ...defaultFxParams('convolver'), dry: 0, wet: 0, normalize: false, inSep: 1000 });
    const L2 = new Float32Array(128).fill(1), R2 = new Float32Array(128).fill(1);
    fx.process(L2, R2, 128, makeCtx());
    expect(L2[0]).toBeGreaterThan(0.9);
    expect(L2[127]).toBeLessThan(0.05);
    // trigger: a click on the output
    const t = createEffect('convolver', SR, 128);
    const p = { ...defaultFxParams('convolver'), dry: 0, wet: 0 };
    t.setParams(p); t.reset();
    t.setParams({ ...p, trigger: 1 });
    const z1 = new Float32Array(128), z2 = new Float32Array(128);
    t.process(z1, z2, 128, makeCtx());
    expect(z1[0]).toBeCloseTo(1, 6);
    // record: armed, starts at the first sound, stops after silence, delivered through monitor()
    t.setParams({ ...p, trigger: 1, record: 1 });
    const sig = new Float32Array(SR);
    for (let i = 100; i < 600; i++) sig[i] = Math.sin(i / 10) * 0.5;
    render(t, sig, Float32Array.from(sig));
    const m = t.monitor!()!;
    expect(m.recL instanceof Float32Array).toBe(true);
    expect((m.recL as Float32Array).length).toBeGreaterThan(400);
    expect((m.recL as Float32Array).length).toBeLessThan(800);
  });

  it('is silent for silence, has a bounded tail and stays finite', () => {
    const fx = createEffect('convolver', SR, 128);
    fx.setParams(defaultFxParams('convolver'));
    fx.reset();
    const z = new Float32Array(SR / 2);
    const [L, R] = render(fx, z, z);
    expect(peak(L)).toBe(0);
    expect(peak(R)).toBe(0);
    expect(fx.tail).toBeGreaterThan(3);
    expect(fx.tail).toBeLessThan(25);
    const r = rnd(9);
    const noise = new Float32Array(SR / 2);
    for (let i = 0; i < noise.length; i++) noise[i] = r() * 1.9;
    fx.setParams({ ...defaultFxParams('convolver'), wet: 1000, dry: 1000, inSep: -1000, wetSep: -1000, selfConv: 1000, delay: 1000, stretch: -1000 });
    fx.reset();
    const [a, b] = render(fx, noise, noise);
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error('non-finite');
  });
});
