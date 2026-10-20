import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { getFFT } from '../../src/engine/dsp/fft';
import { pitScaleNotes, pitSpeedTau } from '../../src/model/fx/plugins/pitcher';
import { makeCtx, peak, rms } from './util';

const SR = 44100;

/** MIDI notes for run(): [sample, key, velocity] (velocity 0 = note off). */
type NoteEv = [number, number, number];

function run(params: Record<string, unknown>, inL: Float32Array, inR: Float32Array = inL, notes: NoteEv[] = []): [Float32Array, Float32Array] {
  const fx = createEffect('pitcher', SR, 128);
  fx.setParams({ ...defaultFxParams('pitcher'), ...params });
  fx.reset();
  const L = Float32Array.from(inL), R = Float32Array.from(inR);
  const ctx = makeCtx({ sampleRate: SR });
  for (let i = 0; i < L.length; i += 128) {
    const n = Math.min(128, L.length - i);
    // the mixer delivers a block's notes right before it processes, at their offsets
    for (const [at, key, vel] of notes) {
      if (at < i || at >= i + n) continue;
      if (vel > 0) fx.noteOn?.(key, vel, at - i, 0, 1); else fx.noteOff?.(key, at - i, 0, 1);
    }
    fx.process(L.subarray(i, i + n), R.subarray(i, i + n), n, ctx);
  }
  return [L, R];
}

function tone(f: number, seconds: number, harmonics = 1, amp = 0.15, start = 0): Float32Array {
  const n = Math.round(seconds * SR), b = new Float32Array(n);
  for (let i = Math.round(start * SR); i < n; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * f * h * i) / SR) / h;
    b[i] = v * amp;
  }
  return b;
}

/** Strongest spectral peak (Hz) of x[start .. start+N) with parabolic interpolation. */
function peakHz(x: Float32Array, start: number, N = 8192, lo = 40, hi = 4000): number {
  const M = N * 4, f = getFFT(M), re = new Float64Array(M), im = new Float64Array(M);
  for (let i = 0; i < N; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  f.transform(re, im);
  const mag = (k: number) => Math.hypot(re[k], im[k]);
  let k0 = 2, m = 0;
  for (let k = Math.ceil((lo * M) / SR); k < (hi * M) / SR; k++) if (mag(k) > m) { m = mag(k); k0 = k; }
  const a = Math.log(mag(k0 - 1) + 1e-12), b = Math.log(mag(k0) + 1e-12), c = Math.log(mag(k0 + 1) + 1e-12);
  return ((k0 + (0.5 * (a - c)) / (a - 2 * b + c)) * SR) / M;
}

const centsRe = (f: number, ref: number) => 1200 * Math.log2(f / ref);

describe('Pitcher', () => {
  it('is registered with FL parameters, ranges, defaults and value texts', () => {
    const d = fxDef('pitcher')!;
    expect([d.width, d.height]).toEqual([415, 280]);
    expect(d.params.map((p) => p.index)).toEqual(Array.from({ length: 21 }, (_, i) => i));
    expect(d.params.map((p) => p.name).slice(0, 6)).toEqual(['Correction Speed', 'Stereo', 'Gender', 'Fine Tune', 'Bypass All', 'Key C Bypass']);
    expect(d.params[20].name).toBe('Voice 4 Pan');
    const p = defaultFxParams('pitcher');
    expect(p).toMatchObject({ speed: 256, stereo: 256, gender: 128, fine: 128, bypass: 0, byp0: 0, pan1: 128, scale: 0, key: 0, a3: 440, minHz: 3, ref: 0, formant: false, midi: false });
    expect((p.notes as boolean[]).every(Boolean)).toBe(true);
    const t = (k: string, v: number) => formatParam(d.params.find((q) => q.key === k)!, v);
    // FL texts (set + readback through the FL test host)
    expect([t('speed', 256), t('speed', 3), t('speed', 11), t('gender', 120), t('gender', 129), t('gender', 1), t('fine', 0)]).toEqual(['100 ', '1 ', '4 ', '-7 ', '0 ', '-100 ', '-100 ']);
    expect([t('byp0', 0), t('byp0', 256)]).toEqual(['Enabled ', 'Bypassed ']);
    expect(pitScaleNotes(1, 0)).toEqual([true, false, true, false, true, true, false, true, false, true, false, true]);
    expect(pitSpeedTau(0)).toBeCloseTo(348, 0);
    expect(pitSpeedTau(128)).toBeCloseTo(43.5, 0);
  });

  it('corrects a detuned tone to the nearest note with FL\'s whole-sample period detection', () => {
    // FL output (cents re A440) for sine inputs A+30, A+40, A+60 and A+80: +8.7, +1.1, +103.2, +105.3
    const fl: [number, number][] = [[30, 8.7], [40, 1.1], [60, 103.2], [80, 105.3]];
    for (const [c, out] of fl) {
      const [y] = run({}, tone(440 * Math.pow(2, c / 1200), 1.2));
      expect(centsRe(peakHz(y, Math.round(0.7 * SR)), 440)).toBeCloseTo(out, 0);
    }
    // a harmonic tone 39 cents sharp of A ends exactly on A440 (FL: 440.00 Hz)
    const [h] = run({}, tone(450, 1.2, 10));
    expect(peakHz(h, Math.round(0.7 * SR), 8192, 300, 600)).toBeCloseTo(440, 0);
  });

  it('follows the scale, the note bypass switches and the fine tune', () => {
    // C major: 470 Hz (A# + 14 cents) goes to B
    const [s] = run({ notes: pitScaleNotes(1, 0) }, tone(470, 1.2));
    expect(peakHz(s, Math.round(0.7 * SR))).toBeCloseTo(493.88 * (470 / (SR / Math.round(SR / 470))), 0);
    // key A bypassed: A+30 passes (FL: +30.0 cents)
    const [b] = run({ byp9: 256 }, tone(440 * Math.pow(2, 0.025), 1.2));
    expect(centsRe(peakHz(b, Math.round(0.7 * SR)), 440)).toBeCloseTo(30, 0);
    // fine tune raw 64 / 192: -50 / +50 cents (FL exactly)
    for (const [ft, c] of [[64, -50], [192, 50]]) {
      const [f] = run({ fine: ft }, tone(450, 1.2));
      expect(centsRe(peakHz(f, Math.round(0.7 * SR)), 440)).toBeCloseTo(c, 0);
    }
  });

  it('glides at FL\'s correction speed', () => {
    // FL, 450 Hz from 0.3 s, speed 50%: 17.0 / 5.7 / 1.9 cents left at 48 / 95 / 141 ms
    const x = tone(450, 1, 11, 0.15, 0.3);
    const [y] = run({ speed: 128 }, x);
    const at = (ms: number) => centsRe(peakHz(y, Math.round((0.3 + ms / 1000) * SR) - 1024, 2048, 300, 700), 440);
    expect(at(95)).toBeGreaterThan(3.5);
    expect(at(95)).toBeLessThan(8);
    expect(at(141)).toBeLessThan(3.5);
    expect(Math.abs(at(400))).toBeLessThan(0.5);
  });

  it('detects between the Min frequency and about sr/45, like FL', () => {
    const out = (f: number, p: Record<string, unknown> = {}) => peakHz(run(p, tone(f, 1.2))[0], Math.round(0.7 * SR), 8192, 30, 3000);
    expect(out(1000)).toBeCloseTo(1000, 0); // period 44.1 samples: not detected (FL)
    expect(out(980)).toBeCloseTo(987.77, 0); // period 45: corrected to B (FL 987.77)
    expect(out(105)).toBeCloseTo(105, 0); // below Min 110 Hz
    expect(Math.abs(out(105, { minHz: 1 }) - 105)).toBeGreaterThan(1); // Min 55 Hz
  });

  it('keeps the formants with FORMANT on and moves them with GENDER', () => {
    const n = Math.round(1.6 * SR);
    const f0 = 196 * Math.pow(2, 30 / 1200);
    const x = new Float32Array(n);
    for (let h = 1; h < 60; h++) {
      const fh = f0 * h;
      if (fh > 15000) break;
      const env = Math.exp(-(((fh - 700) / 150) ** 2)) + 0.6 * Math.exp(-(((fh - 1220) / 180) ** 2)) + 0.02;
      for (let i = 0; i < n; i++) x[i] += ((env / h) * Math.sin((2 * Math.PI * fh * i) / SR)) * 0.3;
    }
    const centroid = (y: Float32Array) => {
      const N = 1 << 15, f = getFFT(N), re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = y[Math.round(0.5 * SR) + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      f.transform(re, im);
      let c = 0, w = 0;
      for (let k = 1; k < N / 2; k++) { const fr = (k * SR) / N; if (fr > 200 && fr < 4000) { const e = re[k] ** 2 + im[k] ** 2; c += fr * e; w += e; } }
      return c / w;
    };
    const base = centroid(run({ formant: true }, x)[0]);
    expect(centroid(run({ formant: true, gender: 256 }, x)[0])).toBeGreaterThan(base * 1.3);
    expect(centroid(run({ formant: true, gender: 0 }, x)[0])).toBeLessThan(base * 0.8);
    // formant off: a -30 cent correction lowers the spectrum with the pitch (FL: centroid 768.9 -> 755.3 Hz)
    expect(centroid(run({}, x)[0]) / centroid(x)).toBeCloseTo(755.3 / 768.85, 2);
  });

  it('corrects to a MIDI note in MIDI mode from the note on, and to the note and octave with OCTAVES', () => {
    const x = tone(220, 2, 6);
    const half = Math.round(0.5 * SR) + 37; // a note inside a block
    // MIDI: D (62) in the octave nearest the 220 Hz input: D4 293.7 Hz
    const [m] = run({ midi: true }, x, x, [[half, 62, 100]]);
    expect(peakHz(m, Math.round(0.05 * SR), 8192, 120, 700)).toBeCloseTo(220, 0); // before the note: automatic (A stays A)
    expect(peakHz(m, Math.round(1.0 * SR), 8192, 120, 700)).toBeCloseTo(293.66, -1);
    // OCTAVES: the note as played (74 = D5, 587.3 Hz)
    const [o] = run({ midi: true, octaves: true }, x, x, [[half, 74, 100]]);
    expect(peakHz(o, Math.round(1.0 * SR), 8192, 120, 1000)).toBeCloseTo(587.33, -1);
    // the last note pressed wins; after the note off the automatic correction returns
    const [l] = run({ midi: true }, x, x, [[half, 62, 100], [Math.round(0.9 * SR), 64, 100], [Math.round(1.3 * SR), 64, 0], [Math.round(1.3 * SR), 62, 0]]);
    expect(peakHz(l, Math.round(0.95 * SR), 4096, 120, 700)).toBeCloseTo(164.81, -1); // E nearest the input: E3
    expect(peakHz(l, Math.round(1.5 * SR), 8192, 120, 700)).toBeCloseTo(220, 0);
    // the correction starts at the note's sample (speed 100%: instant): the output changes right there
    const ref = run({ midi: true }, x)[0];
    let first = -1;
    for (let i = 0; i < m.length; i++) if (Math.abs(m[i] - ref[i]) > 1e-4) { first = i; break; }
    expect(first).toBeGreaterThanOrEqual(half);
    expect(first).toBeLessThan(half + 64);
  });

  it('harmonizes MIDI notes (voices in the input octave, panned, velocity with VEL)', () => {
    const x = tone(220, 1.5, 6);
    const notes: NoteEv[] = [[0, 61, 100], [0, 64, 100]];
    const [l, r] = run({ midi: true, harmonize: true, pan1: 0, pan2: 256 }, x, x, notes);
    // voice 1 = the highest held note (E, 64) placed nearest the input: E3 164.8 Hz, panned left;
    // voice 2 = C# (61): C#4 277.2 Hz, panned right
    expect(peakHz(l, Math.round(0.8 * SR), 8192, 120, 400)).toBeCloseTo(164.81, -1);
    expect(peakHz(r, Math.round(0.8 * SR), 8192, 120, 400)).toBeCloseTo(277.18, -1);
    // VEL: a softer note gives a quieter voice
    const [, rv] = run({ midi: true, harmonize: true, pan1: 0, pan2: 256, vel: true }, x, x, [[0, 61, 32], [0, 64, 128]]);
    expect(rms(rv, Math.round(0.8 * SR)) / rms(r, Math.round(0.8 * SR))).toBeLessThan(0.4);
    // no notes held: no harmony voices, the automatic correction
    const [l0] = run({ midi: true, harmonize: true }, x);
    expect(peakHz(l0, Math.round(0.8 * SR), 8192, 120, 400)).toBeCloseTo(220, 0);
  });

  it('listens on its own MIDI port', () => {
    const fx = createEffect('pitcher', SR, 128);
    fx.setParams(defaultFxParams('pitcher'));
    expect(fx.midiPorts?.()).toEqual([]);
    fx.setParams({ ...defaultFxParams('pitcher'), port: 5 });
    expect(fx.midiPorts?.()).toEqual([5]);
  });

  it('corrects the channels from the reference: right follows left by default, both = independent', () => {
    const l = tone(440 * Math.pow(2, 30 / 1200), 1.2), r = tone(440 * Math.pow(2, -30 / 1200), 1.2);
    const [, r0] = run({}, l, r);
    expect(centsRe(peakHz(r0, Math.round(0.7 * SR)), 440)).toBeCloseTo(-51.3, 0); // FL
    const [, r1] = run({ ref: 1 }, l, r);
    expect(Math.abs(centsRe(peakHz(r1, Math.round(0.7 * SR)), 440))).toBeLessThan(10);
  });

  it('bypasses, stays silent on silence, finite everywhere, and reports no latency', () => {
    const x = tone(452, 0.6);
    const [b] = run({ bypass: 256 }, x);
    expect(Math.abs(b[20000] - x[20000])).toBeLessThan(1e-6);
    const z = new Float32Array(SR / 2);
    expect(peak(run({}, z)[0])).toBe(0);
    expect(createEffect('pitcher', SR, 128).latency ?? 0).toBe(0);
    // onset passes within a few samples (FL: 9)
    const on = tone(220, 0.5, 8, 0.15, 0.2);
    const [o] = run({}, on);
    const first = (a: Float32Array) => a.findIndex((v) => Math.abs(v) > 0.003);
    expect(first(o) - first(on)).toBeLessThan(20);
    let s = 1;
    const noise = new Float32Array(SR);
    for (let i = 0; i < noise.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; noise[i] = (s / 4294967296 - 0.5) * 1.6; }
    for (const p of [{}, { formant: true, gender: 0 }, { minHz: 0, speed: 0 }, { notes: new Array(12).fill(false) }, { midi: true, harmonize: true, formant: true, replace: false }, { ref: 1, fine: 0 }]) {
      const [a, c] = run(p, noise, tone(150, 1, 5));
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]) || !Number.isFinite(c[i])) throw new Error(`non-finite for ${JSON.stringify(p)}`);
      expect(rms(a)).toBeLessThan(3);
    }
  });
});
