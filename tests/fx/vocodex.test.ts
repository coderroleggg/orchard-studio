import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { vcxEnvAt, vcxScaleHz, vcxDefaultEnvelopes, type VcxPoint } from '../../src/model/fx/plugins/vocodex';
import type { FxContext } from '../../src/engine/effects/types';
import { makeCtx, peak, rms } from './util';

const SR = 44100;

function make(over: Record<string, unknown> = {}) {
  const fx = createEffect('vocodex', SR, 128);
  fx.setParams({ ...defaultFxParams('vocodex'), ...over });
  fx.reset();
  return fx;
}

/** L = modulator, R = carrier (L-R encoding unless overridden); returns [L, R] outputs aligned by the latency. */
function run(fx: ReturnType<typeof make>, inL: Float32Array, inR: Float32Array, ctx: Partial<FxContext> = {}): [Float32Array, Float32Array] {
  const lat = fx.latency ?? 0;
  const n = inL.length + lat;
  const L = new Float32Array(n), R = new Float32Array(n);
  L.set(inL); R.set(inR);
  const c = makeCtx({ sampleRate: SR, ...ctx });
  for (let i = 0; i < n; i += 128) {
    const m = Math.min(128, n - i);
    fx.process(L.subarray(i, i + m), R.subarray(i, i + m), m, c);
  }
  return [L.subarray(lat), R.subarray(lat)];
}

function sine(f: number, n: number, amp: number, gate?: (i: number) => number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * f * i) / SR) * (gate ? gate(i) : 1);
  return b;
}

function noise(n: number, amp: number, seed = 1): Float32Array {
  let s = seed >>> 0;
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; b[i] = (s / 4294967296 - 0.5) * 2 * amp; }
  return b;
}

/** Band k of n on the default distribution and a gain envelope that mutes every other band. */
function isolate(n: number, k: number): { f: number; envs: VcxPoint[][] } {
  const envs = vcxDefaultEnvelopes();
  const u = vcxEnvAt(envs[8], k / (n - 1));
  envs[0] = [[0, 0, 0], [u - 0.002, 0, 0], [u, 0.5, 0], [u + 0.002, 0, 0], [1, 0, 0]];
  return { f: vcxScaleHz(u), envs };
}

const DRY = { lr: true, sg: 0, modLvl: 0 };

describe('Vocodex', () => {
  it('is registered with FL ranges, defaults (factory Default preset) and value texts', () => {
    const d = fxDef('vocodex')!;
    expect([d.width, d.height]).toEqual([593, 603]);
    expect(d.params.map((p) => p.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(d.params[2].name).toBe('Modulator pass-through level');
    const p = defaultFxParams('vocodex');
    expect(p).toMatchObject({ wet: 1000, sg: 150, modLvl: 12800, modHp: 55000, carLvl: 0, carLp: 28000, noise: 0, noiseHp: 55000, hold: 1666, att: 1115, rel: 3500, bw: 349, flat: 100, modBw: 2000, pitch: 0, uniShift: 250, uniPan: 128 });
    expect(p).toMatchObject({ bands: 47, order: 2, unison: 0, holdMode: 0, minTimes: true, modIn: 1, carIn: 0, contToMod: true, contFromCons: true, contFromCar: false });
    const t = (k: string, v: number) => formatParam(d.params.find((q) => q.key === k)!, v);
    // FL texts (sweeps through the FL test host)
    expect([t('wet', 0), t('wet', 500), t('wet', 1000), t('wet', 2000)]).toEqual(['-InfdB', '-11.2dB', '0.0dB', '18.1dB']);
    expect([t('sg', 150), t('modLvl', 6400), t('modLvl', 16000)]).toEqual(['15%', '-12.7dB', '5.6dB']);
    expect([t('modHp', 0), t('modHp', 32768), t('modHp', 55000), t('carLp', 28000), t('carLp', 65536)]).toEqual(['Off', '775Hz', '5785Hz', '503Hz', 'Off']);
    expect([t('noise', 6400), t('hold', 1666), t('hold', 10000), t('att', 1115), t('rel', 3500)]).toEqual(['50%', '0.91ms', '250.00ms', '2.00ms', '31.24ms']);
    expect([t('attCurve', 1000), t('bw', 349), t('bw', 1000), t('modBw', 0), t('modBw', 2000)]).toEqual(['2.00', '75%', '400%', 'x0.250', 'x1.000']);
    expect([t('pitch', 0), t('pitch', -1200), t('uniShift', 250), t('uniPan', 128), t('uniPan', -256)]).toEqual(['+0.00 cent', '-1200.00 cents', '25%', '50%', '-100%']);
    expect(d.presets?.map((q) => q.name)).toContain('Robot');
    expect(d.presets?.length).toBe(21);
  });

  it('places the bands on FL\'s frequency scale', () => {
    // centres of the default 47-band distribution measured in FL
    const env = vcxDefaultEnvelopes()[8];
    const fl: [number, number][] = [[0, 82.67], [10, 271.78], [23, 1282.4], [36, 6057.8], [46, 19999]];
    for (const [k, f] of fl) expect(vcxScaleHz(vcxEnvAt(env, k / 46)) / f).toBeCloseTo(1, 2);
    expect(vcxScaleHz(0)).toBe(20);
    expect(vcxScaleHz(0.5)).toBeCloseTo(829.4, -1);
  });

  it('imposes the modulator spectrum on the carrier (L-R encoding)', () => {
    const n = SR;
    for (const fm of [400, 3000]) {
      const [out] = run(make(DRY), sine(fm, n, 0.3), noise(n, 0.2, 5));
      // energy around the modulator frequency dominates
      const seg = out.subarray(SR / 2);
      const e = (f0: number, f1: number) => {
        let s = 0;
        for (let f = f0; f <= f1; f += 25) {
          let re = 0, im = 0;
          for (let i = 0; i < 8192; i++) { re += seg[i] * Math.cos((2 * Math.PI * f * i) / SR); im += seg[i] * Math.sin((2 * Math.PI * f * i) / SR); }
          s += re * re + im * im;
        }
        return s;
      };
      const near = e(fm * 0.85, fm * 1.15), far = e(fm === 400 ? 2700 : 340, fm === 400 ? 3300 : 460);
      expect(near).toBeGreaterThan(far * 30);
    }
    expect(peak(run(make(DRY), new Float32Array(8192), noise(8192, 0.3))[0])).toBe(0);
  });

  it('matches FL\'s band gain 69.65 / (width * sqrt(bands)) (isolated band, steady sines)', () => {
    // FL: band 2 of 5, bandwidth 100 (17.46%), flatness 0: output amplitude 0.9004 for 0.1 / 0.1 sines
    const { f, envs } = isolate(5, 2);
    const x = sine(f, SR, 0.1);
    const [out] = run(make({ ...DRY, bands: 5, bw: 100, flat: 0, envs }), x, x);
    expect(rms(out, SR / 2, SR) * Math.SQRT2).toBeCloseTo(0.9004, 1);
  });

  it('follows FL\'s envelope timing: hold >= 25 ms (MIN TIMES), release to 1% in the set time', () => {
    const { f, envs } = isolate(5, 2);
    const on = Math.round(0.3 * SR), off = Math.round(0.9 * SR), n = Math.round(1.4 * SR);
    const gate = (i: number) => (i >= on && i < off ? 1 : 0);
    const env = (fx: ReturnType<typeof make>) => {
      const [out] = run(fx, sine(f, n, 0.1, gate), sine(f, n, 0.1));
      const w = 64, e: number[] = [];
      for (let i = 0; i + w < n; i += w) e.push(peak(out, i, i + w));
      return e;
    };
    // release 162.7 ms: FL reaches 90% / 10% at 28.9 / 106.6 ms after the gate closes
    const e = env(make({ ...DRY, bands: 5, bw: 1000, flat: 0, envs, rel: 6000 }));
    const steady = e[Math.floor((off - 4000) / 64)];
    const cross = (lev: number) => { for (let j = Math.floor(off / 64); j < e.length; j++) if (e[j] <= lev * steady) return ((j * 64 - off) / SR) * 1000; return Infinity; };
    expect(cross(0.9)).toBeGreaterThan(24);
    expect(cross(0.9)).toBeLessThan(34);
    expect(cross(0.1)).toBeGreaterThan(95);
    expect(cross(0.1)).toBeLessThan(118);
  });

  it('passes the modulator through high-passed and gated by the consonant contour', () => {
    const n = SR;
    // contour off: unity pass-through (FL: identical to the input)
    const nz = noise(n, 0.1, 3);
    const [a] = run(make({ lr: true, sg: 0, wet: 0, modHp: 0, contToMod: false }), nz, new Float32Array(n));
    expect(Math.abs(a[30000] - nz[30000])).toBeLessThan(1e-4);
    // default contour (consonants -> MOD): a 1 kHz tone is held back (FL: x0.011), noise passes
    const s = sine(1000, n, 0.1);
    const [b] = run(make({ lr: true, sg: 0, wet: 0, modHp: 0 }), s, new Float32Array(n));
    expect(rms(b, SR / 2, n) / rms(s, SR / 2, n)).toBeLessThan(0.05);
    const [c] = run(make({ lr: true, sg: 0, wet: 0, modHp: 0 }), nz, new Float32Array(n));
    expect(rms(c, SR / 2, n) / rms(nz, SR / 2, n)).toBeGreaterThan(0.5);
  });

  it('low-passes the carrier pass-through like FL (4th order, 503 Hz)', () => {
    const lvl = (f: number) => {
      const x = sine(f, SR / 2, 0.1);
      const [o] = run(make({ lr: true, sg: 0, wet: 0, modLvl: 0, carLvl: 12800, carLp: 28000 }), new Float32Array(x.length), x);
      return 20 * Math.log10(rms(o, SR / 4, SR / 2) / rms(x, SR / 4, SR / 2));
    };
    expect(lvl(200)).toBeGreaterThan(-0.5);
    expect(lvl(500)).toBeCloseTo(-2.47, 0);
    expect(lvl(1000)).toBeCloseTo(-23.9, 0);
  });

  it('routes modulator and carrier from sidechain inputs', () => {
    const n = SR / 2;
    const scMod = sine(800, n, 0.3);
    const own = noise(n, 0.2, 9);
    const fx = make({ sg: 0, modLvl: 0, modIn: 1, carIn: 0 });
    const L = Float32Array.from(own), R = Float32Array.from(own);
    const lat = fx.latency ?? 0;
    for (let i = 0; i < n; i += 128) {
      const m = Math.min(128, n - i);
      const ctx = makeCtx({ sampleRate: SR, sidechain: [{ source: 2, L: scMod.subarray(i, i + m), R: scMod.subarray(i, i + m) }] });
      fx.process(L.subarray(i, i + m), R.subarray(i, i + m), m, ctx);
    }
    expect(rms(L, SR / 4 + lat, n)).toBeGreaterThan(0.005);
    // no modulator on the sidechain: silence
    const fx2 = make({ sg: 0, modLvl: 0, modIn: 1, carIn: 0 });
    const L2 = Float32Array.from(own), R2 = Float32Array.from(own);
    const z = new Float32Array(128);
    for (let i = 0; i < n; i += 128) fx2.process(L2.subarray(i, i + 128), R2.subarray(i, i + 128), 128, makeCtx({ sampleRate: SR, sidechain: [{ source: 2, L: z, R: z }] }));
    expect(peak(L2)).toBe(0);
  });

  it('plays the internal carrier from the latched notes', () => {
    const n = SR / 2;
    const fx = make({ sg: 0, modLvl: 0, modIn: 0, carIn: -1, tone: 21, notes: [60, 64, 67] });
    expect(fx.tail).toBe(Infinity);
    const [o] = run(fx, noise(n, 0.2, 4), noise(n, 0.2, 4));
    expect(rms(o, SR / 4, n)).toBeGreaterThan(0.005);
    const [s] = run(make({ sg: 0, modLvl: 0, modIn: 0, carIn: -1, tone: 21, notes: [] }), noise(n, 0.2, 4), noise(n, 0.2, 4));
    expect(peak(s, Math.round(SR / 8))).toBeLessThan(1e-3);
  });

  it('plays the internal carrier from MIDI notes, latching like FL, and mirrors them into the keyboard', () => {
    const fx = make({ sg: 0, modLvl: 0, modIn: 0, carIn: -1, tone: 21, notes: [] });
    const n = SR, lat = fx.latency ?? 0;
    const mod = noise(n, 0.2, 4);
    const L = Float32Array.from(mod), R = Float32Array.from(mod);
    const c = makeCtx({ sampleRate: SR });
    const on = Math.round(0.25 * SR) + 50; // inside a block
    // [sample, key, on]: C pressed, E joins while C is held, both released (the chord stays latched)
    const evs: [number, number, boolean][] = [[on, 60, true], [on + 2000, 64, true], [on + 8000, 60, false], [on + 8100, 64, false]];
    let changes: [string, unknown][] | null = null;
    for (let i = 0; i < n; i += 128) {
      const m = Math.min(128, n - i);
      for (const [at, k, down] of evs) if (at >= i && at < i + m) { if (down) fx.noteOn?.(k, 100, at - i, 0, 1); else fx.noteOff?.(k, at - i, 0, 1); }
      fx.process(L.subarray(i, i + m), R.subarray(i, i + m), m, c);
      changes = fx.takeStateChanges?.() ?? changes;
    }
    // silent before the first note, sounding after it (and after the release: latched)
    expect(peak(L, 0, on + lat)).toBeLessThan(1e-4);
    expect(rms(L, on + lat + Math.round(0.1 * SR), on + lat + Math.round(0.2 * SR))).toBeGreaterThan(0.003);
    expect(rms(L, n - Math.round(0.2 * SR), n)).toBeGreaterThan(0.003);
    expect(fx.tail).toBe(Infinity);
    expect(changes).toEqual([['notes', [60, 64]]]);
    // a note pressed when none is held starts a new chord
    fx.noteOn?.(67, 100, 0, 0, 1);
    fx.process(new Float32Array(128), new Float32Array(128), 128, c);
    expect(fx.takeStateChanges?.()).toEqual([['notes', [67]]]);
    expect(fx.takeStateChanges?.()).toBeNull();
    // the mirrored state coming back does not change anything; a keyboard edit replaces the notes
    fx.setParams({ ...defaultFxParams('vocodex'), sg: 0, modLvl: 0, modIn: 0, carIn: -1, tone: 21, notes: [67] });
    expect(fx.takeStateChanges?.()).toBeNull();
    fx.setParams({ ...defaultFxParams('vocodex'), sg: 0, modLvl: 0, modIn: 0, carIn: -1, tone: 21, notes: [] });
    expect(fx.tail).not.toBe(Infinity);
  });

  it('reports FL\'s soundgoodizer look-ahead latency and keeps silence silent', () => {
    expect(make().latency).toBe(153);
    expect(createEffect('vocodex', 48000, 128).latency).toBe(167);
    const z = new Float32Array(SR / 4);
    expect(peak(run(make(), z, z)[0])).toBe(0);
  });

  it('applies the soundgoodizer like FL at low level (15% / 100%: +1.1 / +6.3 dB at 1 kHz)', () => {
    const lvl = (sg: number) => {
      const x = sine(1000, SR / 2, 0.001);
      const [o] = run(make({ lr: true, sg, wet: 0, modLvl: 0, carLvl: 12800, carLp: 65536 }), new Float32Array(x.length), x);
      return 20 * Math.log10(rms(o, SR / 4, SR / 2) / rms(x, SR / 4, SR / 2));
    };
    expect(lvl(150)).toBeCloseTo(1.11, 0);
    expect(lvl(1000)).toBeCloseTo(6.25, 0);
  });

  it('ramps level changes and stays finite at extreme settings', () => {
    const fx = make({ lr: true, sg: 0, modLvl: 0, wet: 0, carLvl: 12800, carLp: 65536 });
    const ones = new Float32Array(1024).fill(0.5);
    run(fx, new Float32Array(1024), ones);
    fx.setParams({ ...defaultFxParams('vocodex'), lr: true, sg: 0, modLvl: 0, wet: 0, carLvl: 0, carLp: 65536 });
    const [o] = run(fx, new Float32Array(128), new Float32Array(128).fill(0.5));
    expect(o[0]).toBeGreaterThan(0.3);
    const extremes: Record<string, unknown>[] = [
      { bands: 100, order: 4, unison: 4, bw: 5, flat: 100, pitch: 1200, uniShift: 1000, sg: 1000, noise: 12800 },
      { bands: 5, order: 1, bw: 1000, flat: 0, pitch: -1200, modBw: 0, holdMode: 1, hold: 10000, minTimes: false, att: 0, rel: 0 },
      { envs: vcxDefaultEnvelopes().map((e, i) => (i === 8 ? [[0, 0, 0], [1, 0, 0]] : [[0, 1, 0], [1, 1, 0]])) },
      { envs: vcxDefaultEnvelopes().map((e, i) => (i === 8 ? [[0, 1, 0], [1, 1, 0]] : [[0, 0, 1], [1, 1, -1]])), attCurve: 2000, relCurve: 2000 },
      { tone: 23, notes: [24, 100, 127], carIn: -1, modIn: 0, wet: 2000, carLvl: 16000, modLvl: 16000 },
    ];
    for (const ex of extremes) {
      const [a, b] = run(make(ex), noise(SR / 4, 0.8, 7), noise(SR / 4, 0.8, 8));
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error(`non-finite output for ${JSON.stringify(ex).slice(0, 80)}`);
    }
  });
});
