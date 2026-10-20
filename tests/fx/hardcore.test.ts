// Hardcore tests. Reference numbers marked "FL" were measured on FL Studio's
// own Hardcore binary with flfxhost (48 kHz); see docs/research/fx/hardcore.md.
import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import {
  HC_CABINETS, HC_TYPES, HcType, hcFromStored, hcKnobKey, hcOnKey, hcPct, hcSwapSlots, hcTypeKey,
} from '../../src/model/fx/plugins/hardcore';
import { makeCtx, peak, render, rms, sine } from './util';

const SR = 48000;
const raw = (v: number) => v * 256;

function fx(over: Record<string, unknown> = {}) {
  const f = createEffect('hardcore', SR, 128);
  f.setParams({ ...defaultFxParams('hardcore'), ...over });
  f.reset();
  return f;
}

/** Board with one pedal in slot 1 (knobs as 0..1). */
function pedal(type: number, knobs: number[], over: Record<string, unknown> = {}) {
  const p: Record<string, unknown> = { [hcTypeKey(0)]: type };
  knobs.forEach((v, k) => { p[hcKnobKey(0, k)] = raw(v); });
  return fx({ ...p, ...over });
}

/** Amplitude of frequency f in x (single-bin DFT). */
function amp(x: Float32Array, f: number, a = 0, z = x.length): number {
  let re = 0, im = 0;
  for (let i = a; i < z; i++) { const ph = (2 * Math.PI * f * i) / SR; re += x[i] * Math.cos(ph); im += x[i] * Math.sin(ph); }
  return (2 * Math.hypot(re, im)) / (z - a);
}

/** Small-signal gain (dB) at f: steady sine through the effect. */
function gainDb(f: ReturnType<typeof fx>, freq: number, level = 0.001): number {
  const [y] = render(f, sine(freq, 0.4, level));
  return 20 * Math.log10(amp(y, freq, 9600) / level);
}

/** Magnitude (dB) of an impulse response at f. */
function irDb(h: Float32Array, freq: number): number {
  let re = 0, im = 0;
  for (let i = 0; i < h.length; i++) { const ph = (2 * Math.PI * freq * i) / SR; re += h[i] * Math.cos(ph); im -= h[i] * Math.sin(ph); }
  return 20 * Math.log10(Math.hypot(re, im));
}

function impulse(f: ReturnType<typeof fx>, n = SR / 2, a = 1): Float32Array {
  const x = new Float32Array(n); x[0] = a;
  const [y] = render(f, x);
  for (let i = 0; i < y.length; i++) y[i] /= a;
  return y;
}

function finite(x: Float32Array): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

describe('Hardcore', () => {
  it('exposes FL\'s parameter interface: names, indices, 0..256 values and "50 % " texts', () => {
    const d = fxDef('hardcore')!;
    expect(d.category).toBe('Distortion');
    expect([d.width, d.height]).toEqual([767, 485]);
    const p = (k: string) => d.params.find((q) => q.key === k)!;
    expect([p('in').index, p('in').name]).toEqual([0, 'Master IN Lvl']);
    expect([p('out').index, p('out').name]).toEqual([1, 'Master OUT Lvl']);
    expect([p('eqOn').index, p('eqOn').name, p('eqOn').def]).toEqual([2, 'EQ Enable', 0]);
    expect([p('eq8').index, p('eq8').name]).toEqual([10, 'EQ Band 8']);
    expect(p('cab').index).toBe(11);
    expect([p(hcKnobKey(0, 0)).index, p(hcKnobKey(0, 0)).name]).toEqual([13, 'Box1 - Param 1']);
    expect([p(hcKnobKey(4, 4)).index, p(hcKnobKey(4, 4)).name]).toEqual([37, 'Box5 - Param 5']);
    expect([p(hcOnKey(0)).index, p(hcOnKey(0)).name, p(hcOnKey(0)).def]).toEqual([39, 'Box 1 Enable', 256]);
    expect(p(hcTypeKey(4)).index).toBe(49);
    expect(p('in').max).toBe(256);
    expect(hcPct(128)).toBe('50 % ');
    expect(hcPct(32)).toBe('12 % '); // FL truncates
    expect(hcPct(256)).toBe('100 % ');
    const s = defaultFxParams('hardcore');
    expect(s[hcTypeKey(0)]).toBe(0);
    expect(s.cab).toBe(0);
    expect(HC_TYPES.length).toBe(12);
    expect(HC_CABINETS[20]).toBe('Model T');
  });

  it('ships FL\'s 98 factory presets with their stored values', () => {
    const presets = fxDef('hardcore')!.presets!;
    expect(presets.length).toBe(98);
    const acdc = presets.find((q) => q.name === 'AC-DC Rhythm FG')!;
    expect(acdc.params.cab).toBe(1);
    expect([acdc.params[hcTypeKey(0)], acdc.params[hcTypeKey(1)], acdc.params[hcTypeKey(2)], acdc.params[hcTypeKey(3)]]).toEqual([HcType.Distortion, HcType.Compressor, HcType.Reverb, 0]);
    expect(acdc.params.out as number).toBeCloseTo(0.63 * 256, 1);
    expect(hcFromStored([0.5, 0.5, 0.5])).toMatchObject({ in: 128, out: 128, eqOn: 128 });
  });

  it('truncates stored values like the plugin (0.5 = no pedal / cabinet off)', () => {
    const p = normalizeFxParams('hardcore', { [hcTypeKey(0)]: 0.5, cab: 3.9, [hcTypeKey(1)]: 9 });
    expect([p[hcTypeKey(0)], p[hcTypeKey(1)], p.cab]).toEqual([0, 9, 3]);
  });

  it('has FL\'s fixed input high pass and +-24 dB levels (FL)', () => {
    const h = impulse(fx());
    expect(h[0]).toBeCloseTo(0.998037, 4); // FL 0.998037, -0.0078232, -0.0077773 ...
    expect(h[1]).toBeCloseTo(-0.0078232, 4);
    expect(h[1000]).toBeCloseTo(1.475e-4, 5); // FL: the response crosses zero (two poles)
    expect(irDb(h, 20)).toBeCloseTo(-10.12, 0); // FL -10.12
    expect(irDb(h, 50)).toBeCloseTo(-2.64, 1); // FL -2.64
    expect(irDb(h, 100)).toBeCloseTo(-0.73, 1); // FL -0.73
    expect(irDb(impulse(fx({ in: 256 })), 1000)).toBeCloseTo(24.01, 1); // FL 24.01
    expect(irDb(impulse(fx({ out: 64 })), 1000)).toBeCloseTo(-11.99, 1); // FL -11.99
    expect(irDb(impulse(fx({ in: 0 })), 1000)).toBeCloseTo(-23.99, 1);
  });

  it('graphic EQ matches FL: RBJ shelves and bells of one octave, +-36 dB square law (FL)', () => {
    const base = impulse(fx());
    const eq = (band: number, v: number, f: number) => irDb(impulse(fx({ eqOn: 256, [`eq${band}`]: raw(v) })), f) - irDb(base, f);
    expect(eq(4, 0.75, 1000)).toBeCloseTo(9.0, 1); // FL +9.00
    expect(eq(4, 1, 1000)).toBeCloseTo(36.0, 1); // FL +36.00
    expect(eq(4, 1, 5000)).toBeCloseTo(3.57, 1); // FL +3.57
    expect(eq(4, 1, 500)).toBeCloseTo(11.76, 1); // FL +11.76
    expect(eq(1, 0.75, 70)).toBeCloseTo(10.9, 1); // FL low shelf +10.90
    expect(eq(1, 0.75, 200)).toBeCloseTo(-1.99, 1); // FL -1.99
    expect(eq(8, 1, 16000)).toBeCloseTo(18.0, 1); // FL high shelf +18.00
    expect(eq(8, 1, 20000)).toBeCloseTo(28.02, 1); // FL +28.02
    // enable: any value above 0 (FL)
    expect(irDb(impulse(fx({ eqOn: 64, eq4: 256 })), 1000) - irDb(base, 1000)).toBeCloseTo(36, 0);
    expect(irDb(impulse(fx({ eqOn: 0, eq4: 256 })), 1000) - irDb(base, 1000)).toBeCloseTo(0, 1);
  });

  it('cabinet models follow FL\'s measured responses (FL, 1/3-octave levels)', () => {
    const ref: [number, number[]][] = [
      [1, [6.2, -11.7, -9.0, -4.2, -14.5]], [6, [4.4, -5.9, -1.3, -2.7, -0.4]], [9, [7.4, -7.3, -8.4, -1.5, 0.0]],
      [13, [8.9, 0.1, -3.9, 0.1, -5.0]], [17, [11.6, -0.3, -1.6, -3.6, -6.9]], [20, [11.8, 1.7, 2.0, 0.2, -7.0]],
    ];
    const base = impulse(fx(), SR / 2);
    for (const [c, levels] of ref) {
      const h = impulse(fx({ cab: c }), SR / 2);
      [125, 500, 1000, 2000, 4000].forEach((f, i) => {
        // average over a third of an octave like the reference
        let s = 0, nb = 0;
        for (let k = -2; k <= 2; k++) { const ff = f * Math.pow(2, k / 18); s += Math.pow(10, (irDb(h, ff) - irDb(base, ff)) / 10); nb++; }
        expect(10 * Math.log10(s / nb), `${HC_CABINETS[c]} ${f} Hz`).toBeCloseTo(levels[i], -0.6); // within ~2 dB
      });
    }
  });

  it('delay: echo at 995 x TIME ms, wet -(0.1 + 0.9 MIX^2), feedback -0.96 DECAY^2 (FL)', () => {
    const f = pedal(HcType.Delay, [0.5, 0.5, 0.5]);
    const h = impulse(f, SR * 2);
    let at = 0, best = 0;
    for (let i = 2000; i < 36000; i++) if (Math.abs(h[i]) > best) { best = Math.abs(h[i]); at = i; }
    expect(Math.abs(at - 23808)).toBeLessThan(80); // FL 23808 samples (496.0 ms), wow +-75 samples
    let e1 = 0, e2 = 0, j2 = 2 * at - 200;
    for (let i = at - 3; i <= at + 3; i++) e1 += h[i];
    for (let i = 2 * at - 200; i <= 2 * at + 200; i++) if (Math.abs(h[i]) > Math.abs(h[j2])) j2 = i;
    for (let i = j2 - 3; i <= j2 + 3; i++) e2 += h[i];
    expect(e1).toBeCloseTo(-0.325, 1); // FL -0.3246 (MIX 0.5)
    expect(e2 / e1).toBeLessThan(0);
    expect(Math.abs(e2 / e1)).toBeCloseTo(0.2377, 1); // FL 0.2377 (DECAY 0.5)
    expect(f.tail!).toBeGreaterThan(1);
    // TIME 0 clamps to FL's 99.4 ms
    const h0 = impulse(pedal(HcType.Delay, [0, 0, 0.5]), 12000);
    let at0 = 0; best = 0;
    for (let i = 1000; i < 12000; i++) if (Math.abs(h0[i]) > best) { best = Math.abs(h0[i]); at0 = i; }
    expect(Math.abs(at0 - 4772)).toBeLessThan(30); // FL 4772
  });

  it('reverb: RT60 and wet level follow FL (FL)', () => {
    const f = pedal(HcType.Reverb, [0.5, 0, 1]);
    const h = impulse(f, SR * 4);
    // RT60 from the energy decay between -5 and -25 dB
    const e = new Float64Array(h.length);
    let acc = 0;
    for (let i = h.length - 1; i >= 0; i--) { acc += h[i] * h[i]; e[i] = acc; }
    let i5 = 0, i25 = 0;
    for (let i = 8; i < h.length; i++) { if (!i5 && e[i] < e[8] * Math.pow(10, -0.5)) i5 = i; if (!i25 && e[i] < e[8] * Math.pow(10, -2.5)) { i25 = i; break; } }
    const rt = ((i25 - i5) / SR) * 3;
    expect(rt).toBeGreaterThan(2.32 * 0.8); // FL 2.32 s at DECAY 50%
    expect(rt).toBeLessThan(2.32 * 1.2);
    let en = 0;
    for (let i = 48; i < SR; i++) en += h[i] * h[i];
    expect(20 * Math.log10(Math.sqrt(en) / 2.455)).toBeCloseTo(0, -0.6); // FL 2.455 (MIX 100%), within 2 dB
    expect(f.tail!).toBeGreaterThan(2.3);
  });

  it('noise gate opens at -64 + 64 x TRESHOLD dB with a 100 ms hold (FL)', () => {
    const k = [0, 0, 0.5]; // FL: opens at -31.5 dB, closes at -32 dB
    const [lo] = render(pedal(HcType.NoiseGate, k), sine(1000, 0.3, Math.pow(10, -33 / 20)));
    const [hi] = render(pedal(HcType.NoiseGate, k), sine(1000, 0.3, Math.pow(10, -30 / 20)));
    expect(rms(lo, 9600)).toBeLessThan(1e-6);
    expect(rms(hi, 9600)).toBeGreaterThan(0.02);
    // closes after the hold: still open 50 ms after the signal drops, shut after 300 ms (RELEASE 0)
    const x = new Float32Array(SR);
    x.set(sine(1000, 0.5, 0.1));
    const quiet = sine(1000, 0.5, 0.001);
    x.set(quiet, SR / 2);
    const [y] = render(pedal(HcType.NoiseGate, k), x);
    expect(rms(y, SR / 2 + 1000, SR / 2 + 2400)).toBeGreaterThan(5e-4);
    expect(rms(y, SR / 2 + 14400)).toBeLessThan(1e-5);
  });

  it('equalizer pedal: RBJ bands at 300 / 700 / 1800 / 7000 Hz, +-20 dB (FL)', () => {
    const base = impulse(fx());
    const d = (k: number[], f: number) => irDb(impulse(pedal(HcType.Equalizer, k)), f) - irDb(base, f);
    expect(d([0.5, 0.75, 0.5, 0.5], 700)).toBeCloseTo(5.0, 1); // FL +5.00
    expect(d([0.5, 1, 0.5, 0.5], 700)).toBeCloseTo(20.0, 1); // FL +20.00
    expect(d([0.5, 0.5, 0, 0.5], 1800)).toBeCloseTo(-20.0, 1); // FL -20.00
    expect(d([1, 0.5, 0.5, 0.5], 143)).toBeCloseTo(23.2, 0); // FL +23.21 (resonant shelf)
    expect(d([0.5, 0.5, 0.5, 1], 12666)).toBeCloseTo(22.2, 0); // FL +22.24
  });

  it('compressor follows FL\'s static curves (FL, ATTACK 5% / RELEASE 20%)', () => {
    // [TRESHOLD, RATIO, input dB, FL output dB]
    const pts: [number, number, number, number][] = [[0.5, 0, -6, -8.6], [0.5, 1, -18, -26.9], [0.25, 0.5, -24, -27.7], [0.25, 1, -30, -42.1], [0, 0, -36, -39.1], [0.75, 0.5, 0, -1.5]];
    for (const [t, r, lvl, out] of pts) {
      const [y] = render(pedal(HcType.Compressor, [t, r, 0.05, 0.2]), sine(1000, 0.6, Math.pow(10, lvl / 20)));
      const o = 20 * Math.log10(Math.SQRT2 * rms(y, 19200));
      expect(Math.abs(o - out), `T${t} R${r} ${lvl} dB -> ${o.toFixed(1)} (FL ${out})`).toBeLessThan(2.5);
    }
  });

  it('chorus: dry plus two voices at -2 x INTENSITY^2 (FL)', () => {
    const h = impulse(pedal(HcType.Chorus, [0, 0, 1]), 2000);
    expect(h[0]).toBeCloseTo(0.998, 2);
    const tap = (ms: number) => { const i = Math.round((ms * SR) / 1000); return h[i - 1] + h[i] + h[i + 1]; };
    expect(tap(8.573)).toBeCloseTo(-2, 0); // FL voice A -1.99 at 8.573 ms
    expect(tap(11.042)).toBeCloseTo(-2, 0); // FL voice B (left) at 11.042 ms
    const hh = impulse(pedal(HcType.Chorus, [0, 0, 0.5]), 2000);
    expect(hh[Math.round(0.008573 * SR) - 1] + hh[Math.round(0.008573 * SR)] + hh[Math.round(0.008573 * SR) + 1]).toBeCloseTo(-0.5, 1); // FL -0.497
  });

  it('flanger: one voice at -(0.11 + 0.894 x INTENSITY), 0.125 ms at WIDTH 0 (FL)', () => {
    const h = impulse(pedal(HcType.Flanger, [0, 0, 1]), 400);
    let s = 0;
    for (let i = 3; i < 10; i++) s += h[i];
    expect(s).toBeCloseTo(-1.004, 1); // FL -1.004
    const h2 = impulse(pedal(HcType.Flanger, [0, 0, 0]), 400);
    s = 0;
    for (let i = 3; i < 10; i++) s += h2[i];
    expect(s).toBeCloseTo(-0.11, 1); // FL -0.110
  });

  it('phaser: six stages around TUNE with notches like FL (FL)', () => {
    const base = impulse(fx(), 8192);
    const h = impulse(pedal(HcType.Phaser, [0, 0.5, 0, 1]), 8192);
    const d = (f: number) => irDb(h, f) - irDb(base, f);
    expect(d(434)).toBeLessThan(-6); // FL notch -10.1 dB at 434 Hz
    expect(d(1625)).toBeLessThan(-6); // FL notch at 1625 Hz
    expect(d(900)).toBeGreaterThan(5); // FL peak +9 dB at 904 Hz
  });

  it('modulator: twice the level through a 0.125 ms vibrato line; RATE 30 x v^2 Hz (FL)', () => {
    const h = impulse(pedal(HcType.Modulator, [0, 0, 0, 0.5]), 200);
    let j = 0;
    for (let i = 1; i < 20; i++) if (Math.abs(h[i]) > Math.abs(h[j])) j = i;
    const s = h[j] + (Math.abs(h[j - 1]) > Math.abs(h[j + 1]) ? h[j - 1] : h[j + 1]);
    expect(s).toBeCloseTo(2.0, 1); // FL 1.996 at 0.125 ms
    expect(Math.abs(j - 6)).toBeLessThan(3);
    const [y] = render(pedal(HcType.Modulator, [0, 1, 0, 0.5]), sine(1000, 2, 0.25));
    // tremolo at 7.5 Hz: envelope minimum near zero, maximum near 4x (FL 0..4.0)
    let mx = 0, mn = 9;
    for (let b = 0; b < 100; b++) { const r = rms(y, 9600 + b * 160, 9600 + b * 160 + 160) * Math.SQRT2 / 0.25; mx = Math.max(mx, r); mn = Math.min(mn, r); }
    expect(mx).toBeGreaterThan(3.5);
    expect(mn).toBeLessThan(0.5);
  });

  it('tube stage: gain staging and x/(1+|x|) saturation like FL (FL)', () => {
    expect(gainDb(pedal(HcType.TubeStage, [0.5, 1, 0.5]), 800)).toBeCloseTo(26.3, -0.5); // FL a1 small signal
    const [y] = render(pedal(HcType.TubeStage, [0.5, 1, 1]), sine(800, 0.3, 1));
    expect(20 * Math.log10(amp(y, 800, 4800))).toBeCloseTo(-4.0, -0.5); // FL plateau -4.0 dB
    const h3 = 20 * Math.log10(amp(y, 2400, 4800) / amp(y, 800, 4800));
    expect(h3).toBeGreaterThan(-12); // FL -9 dB (squaring)
    expect(amp(y, 1600, 4800) / amp(y, 800, 4800)).toBeLessThan(0.01); // symmetric: no even harmonics (FL -120 dB)
  });

  it('distortion: saturated levels, GLASS presence and DIST staging like FL (FL)', () => {
    // total output (dB, sine peak equivalent) on a 400 Hz sine at -12 dB (FL: DIST 0 +1.3, 50% -8.5, 100% -11.4)
    const tot = (d: number) => {
      const [y] = render(pedal(HcType.Distortion, [d, 0, 0.5, 0.5]), sine(400, 0.3, Math.pow(10, -12 / 20)));
      return 20 * Math.log10(Math.SQRT2 * rms(y, 4800));
    };
    expect(tot(0)).toBeCloseTo(1.3, -0.6);
    expect(tot(0.5)).toBeCloseTo(-8.5, -0.6);
    expect(tot(1)).toBeCloseTo(-11.4, -0.6);
    const glassUp = gainDb(pedal(HcType.Distortion, [0, 0.5, 0.5, 1]), 2430, 1e-5) - gainDb(pedal(HcType.Distortion, [0, 0.5, 0.5, 0.5]), 2430, 1e-5);
    expect(glassUp).toBeCloseTo(20.2, -0.5); // FL presence bell +20.2 dB at 2.43 kHz
    // symmetric: odd harmonics only (FL)
    const [y] = render(pedal(HcType.Distortion, [0.5, 0, 0.5, 0.5]), sine(400, 0.3, 0.25));
    expect(amp(y, 800, 4800) / amp(y, 400, 4800)).toBeLessThan(0.01);
    expect(amp(y, 1200, 4800) / amp(y, 400, 4800)).toBeGreaterThan(0.05);
  });

  it('pedals with an enable at 0 are bypassed after a short fade; any value above 0 is on (FL)', () => {
    const p = { [hcTypeKey(0)]: HcType.TubeStage, [hcKnobKey(0, 2)]: 256 };
    const f = fx(p);
    const x = sine(220, 0.2, 0.25);
    render(f, x);
    f.setParams({ ...defaultFxParams('hardcore'), ...p, [hcOnKey(0)]: 0 });
    const [y] = render(f, x);
    const ref = render(fx(), x)[0];
    let err = 0;
    for (let i = 2400; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - ref[i]));
    expect(err).toBeLessThan(0.01);
    const [z] = render(fx({ ...p, [hcOnKey(0)]: 1 }), x);
    expect(peak(z, 2400)).not.toBeCloseTo(peak(ref, 2400), 2);
  });

  it('changing a slot\'s pedal crossfades without clicks', () => {
    const base = { ...defaultFxParams('hardcore'), [hcTypeKey(0)]: HcType.Chorus, [hcKnobKey(0, 2)]: 64 };
    const f = createEffect('hardcore', SR, 128);
    f.setParams(base); f.reset();
    const x = sine(200, 0.4, 0.2);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const ctx = makeCtx();
    for (let o = 0; o < x.length; o += 128) {
      if (o === 128 * 40) f.setParams({ ...base, [hcTypeKey(0)]: HcType.Phaser });
      f.process(L.subarray(o, o + 128), R.subarray(o, o + 128), 128, ctx);
    }
    let jump = 0;
    for (let i = 1; i < L.length; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
    expect(jump).toBeLessThan(0.06);
  });

  it('every pedal is silent for silence and finite at extreme settings', () => {
    for (let t = 1; t < HC_TYPES.length; t++) {
      for (const k of [[0, 0, 0, 0], [1, 1, 1, 1], [0, 1, 0, 1], [1, 0, 1, 0]]) {
        const f = pedal(t, k);
        const [s] = render(f, new Float32Array(9600));
        expect(peak(s), `${HC_TYPES[t]} ${k}`).toBeLessThan(1e-6);
        const noise = new Float32Array(SR / 2);
        let seed = 1;
        for (let i = 0; i < noise.length; i++) { seed = (seed * 16807) % 2147483647; noise[i] = (seed / 2147483647 - 0.5) * 2; }
        const [y, r] = render(f, noise);
        expect(finite(y) && finite(r), `${HC_TYPES[t]} ${k}`).toBe(true);
        expect(peak(y), `${HC_TYPES[t]} ${k}`).toBeLessThan(64);
      }
    }
  });

  it('plays every factory preset with finite output', () => {
    for (const pr of fxDef('hardcore')!.presets!) {
      const f = fx(pr.params);
      const [y] = render(f, sine(196, 0.3, 0.3));
      expect(finite(y), pr.name).toBe(true);
      expect(peak(y), pr.name).toBeLessThan(64);
    }
  });

  it('moves a pedal with its knobs and enable', () => {
    const p = { ...defaultFxParams('hardcore'), [hcTypeKey(0)]: HcType.Delay, [hcKnobKey(0, 0)]: 230, [hcOnKey(0)]: 0, [hcTypeKey(1)]: HcType.Reverb };
    const q = { ...p, ...hcSwapSlots(p, 0, 1) };
    expect([q[hcTypeKey(0)], q[hcTypeKey(1)], q[hcKnobKey(1, 0)], q[hcOnKey(1)], q[hcOnKey(0)]]).toEqual([HcType.Reverb, HcType.Delay, 230, 0, 256]);
  });
});
