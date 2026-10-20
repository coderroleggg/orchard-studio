import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { mbdKey, mbdVolGain, MBD_ONE } from '../../src/model/fx/plugins/mbdelay';
import { render, peak } from './util';

const SR = 48000;
const ONE = MBD_ONE;

/** Only band `band` (1-based) audible in bank 1, optionally with its delay value. */
function solo(band: number, delay?: number): Record<string, number> {
  const p: Record<string, number> = {};
  for (let k = 1; k <= 16; k++) p[mbdKey(1, 1, k)] = k === band ? ONE : 0;
  if (delay !== undefined) p[mbdKey(1, 0, band)] = delay;
  return p;
}

function make(p: Record<string, unknown> = {}) {
  const fx = createEffect('mbdelay', SR, 128);
  fx.setParams({ ...defaultFxParams('mbdelay'), ...p });
  fx.reset();
  return fx;
}

function text(key: string, v: number): string {
  return formatParam(fxDef('mbdelay')!.params.find((q) => q.key === key)!, v);
}

function impulse(n: number, at = 0, a = 1): Float32Array { const b = new Float32Array(n); b[at] = a; return b; }

function tone(freq: number, amp: number, secs: number): Float32Array {
  const n = Math.round(secs * SR), b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}

/** Magnitude of `freq` in y over [from, from + dur] seconds. */
function amp(y: Float32Array, freq: number, from: number, dur = 0.4): number {
  const a = Math.round(from * SR), n = Math.round(Math.floor(dur * freq) * (SR / freq));
  let s = 0, c = 0;
  for (let i = a; i < a + n; i++) { const ph = (2 * Math.PI * freq * i) / SR; s += y[i] * Math.sin(ph); c += y[i] * Math.cos(ph); }
  return (2 * Math.hypot(s, c)) / n;
}

function argmaxAbs(y: Float32Array, from = 0): number {
  let m = -1, k = -1;
  for (let i = from; i < y.length; i++) { const a = Math.abs(y[i]); if (a > m) { m = a; k = i; } }
  return k;
}

describe('Multiband Delay', () => {
  it('is registered with FL ranges, defaults, value texts and presets', () => {
    const d = fxDef('mbdelay')!;
    expect(d.width).toBe(560);
    expect(d.height).toBe(290);
    expect(d.params.length).toBe(396);
    const def = defaultFxParams('mbdelay');
    // FL's Default preset: bank 1 without delays, bank 8 a 0..1000 ms ramp, smoothing 0
    expect(def[mbdKey(1, 0, 16)]).toBe(0);
    expect(def[mbdKey(8, 0, 16)]).toBe(ONE);
    expect(def[mbdKey(2, 0, 2)]).toBe(10226113);
    expect(def).toMatchObject({ scale: 0, x01: 0, feedback: 0, smoothing: 0, filterMode: 0, keepPitch: 0, morph: 0, mix: 128, harmonic: 0, weighting: 0, hp: 1000, sat: 0 });
    // texts read from FL (all 130576 swept values match)
    expect(text(mbdKey(1, 0, 2), 71582792)).toBe('66.67ms');
    expect(text(mbdKey(1, 1, 1), 10737419)).toBe('1.0%');
    expect(text(mbdKey(1, 2, 1), ONE / 2)).toBe('Centered');
    expect(text(mbdKey(1, 2, 1), 10737419)).toBe('98.0% left');
    expect(text('scale', -5880)).toBe('-98.00%');
    expect(text('smoothing', 1500)).toBe('250.00ms');
    expect(text('morph', 70)).toBe('1.00%');
    expect(text('mix', -125)).toBe('1.17%');
    expect(text('hp', 1990)).toBe('10.47 Hz');
    expect(text('hp', 29583)).toBe('37.80 Hz');
    expect(text('filterMode', 2)).toBe('LINEAR PHASE');
    expect(text('sat', 1)).toBe('SAT');
    expect(d.presets?.length).toBe(17);
    expect(d.presets?.find((q) => q.name === 'Wavetablizer (morph)')?.params).toMatchObject({ scale: 3648, x01: 1, feedback: 4392, smoothing: 1380, filterMode: 1, keepPitch: 1 });
    // latency: only the linear-phase split (1536 samples at every rate)
    expect(make().latency).toBe(0);
    expect(make({ filterMode: 2 }).latency).toBe(1536);
  });

  it('splits like FL: Gentle Q 0.5 band-passes at -12 dB, Steep LR8 bands, linear-phase FIRs', () => {
    // Gentle band 9: 0.25 x band-pass at 1.0886 x 958 Hz = 1042.9 Hz (FL: 1042.7 Hz, -12.04 dB)
    const [g9] = render(make({ filterMode: 0, ...solo(9) }), tone(1043, 0.5, 1));
    expect(20 * Math.log10(amp(g9, 1043, 0.5) / 0.5)).toBeCloseTo(-12.04, 1);
    const [g9b] = render(make({ filterMode: 0, ...solo(9) }), tone(4172, 0.5, 1));
    expect(20 * Math.log10(amp(g9b, 4172, 0.5) / 0.5)).toBeCloseTo(-12.04 - 6.53, 0); // 2 octaves above: Q 0.5 skirt
    // Steep band 8 (624..958 Hz in FL's table is band 9; band 8 = 413..624): ~0 dB inside, -3 dB at the crossovers
    const [s8] = render(make({ filterMode: 1, ...solo(8) }), tone(500, 0.5, 1));
    expect(20 * Math.log10(amp(s8, 500, 0.5) / 0.5)).toBeCloseTo(0, 0);
    const [s8x] = render(make({ filterMode: 1, ...solo(8) }), tone(624, 0.5, 1));
    expect(20 * Math.log10(amp(s8x, 624, 0.5) / 0.5)).toBeCloseTo(-3.0, 0);
    const [s8f] = render(make({ filterMode: 1, ...solo(8) }), tone(2000, 0.5, 1));
    expect(20 * Math.log10(amp(s8f, 2000, 0.5) / 0.5)).toBeLessThan(-70); // FL: -78.5 dB
    // linear phase: all bands sum to a delayed impulse at 1536 + 1 (FL)
    const [lp] = render(make({ filterMode: 2 }), impulse(8000, 100));
    expect(argmaxAbs(lp) - 100).toBe(1537);
    expect(lp[1637]).toBeCloseTo(1, 2);
    // band sums: Gentle within -1.4..+1.2 dB, Steep +0.5..+3 dB (FL)
    for (const [mode, lo, hi] of [[0, -1.5, 1.3], [1, 0.3, 3.2]] as const) {
      for (const f of [100, 1000, 10000]) {
        const [y] = render(make({ filterMode: mode }), tone(f, 0.1, 1));
        const db = 20 * Math.log10(amp(y, f, 0.5) / 0.1);
        expect(db).toBeGreaterThan(lo); expect(db).toBeLessThan(hi);
      }
    }
  });

  it('delays each band like FL (integer samples, mirrored by a negative scale, x0.1 range)', () => {
    const lin = (p: Record<string, unknown>) => { const [y] = render(make({ filterMode: 2, ...p }), impulse(SR * 2, 0)); return argmaxAbs(y) - 1536; };
    // FL measurements (linear phase, band 16 alone)
    expect(lin({ scale: 6000, ...solo(16, 107374182) })).toBe(4800); // 100 ms
    expect(lin({ scale: 6000, ...solo(16, 13250052) })).toBe(592); // 12.34 ms
    expect(lin({ scale: 1800, ...solo(16, Math.trunc(ONE / 15)) })).toBe(959); // 30 % of 66.67 ms
    expect(lin({ scale: 6000, x01: 1, ...solo(16, Math.trunc(ONE * 3 / 15)) })).toBe(960); // 100 ms range
    expect(lin({ scale: -1800, ...solo(16, Math.trunc(ONE * 7 / 15)) })).toBe(7679); // mirrored
    expect(lin({ scale: -1800, ...solo(16, ONE) })).toBe(1); // minimum one sample
  });

  it('feeds back 0.95 x feedback per repeat; Weighting keeps the decay time per FL table', () => {
    const echoes = (p: Record<string, unknown>, d: number) => {
      const [y] = render(make({ filterMode: 0, scale: 6000, ...solo(9, Math.round(d * ONE)), ...p }), impulse(SR * 2, 100));
      const D = Math.floor(d * SR);
      const e = (r: number) => { let s = 0; for (let i = 100 + r * D - 200; i < 100 + r * D + 800; i++) s += y[i] * y[i]; return Math.sqrt(s); };
      return [e(1), e(2), e(3)];
    };
    const [a1, a2, a3] = echoes({ feedback: 3000 }, 0.1);
    expect(a2 / a1).toBeCloseTo(0.475, 3); // FL: 0.475
    expect(a3 / a2).toBeCloseTo(0.475, 3);
    const [b1, b2] = echoes({ feedback: 3000, weighting: 1 }, 0.1);
    expect(b2 / b1).toBeCloseTo(0.3981, 2); // FL: 0.3981 (T60 0.75 s)
    const [c1, c2] = echoes({ feedback: 3000, weighting: 1 }, 0.2);
    expect(c2 / c1).toBeCloseTo(0.1585, 2); // FL: 0.1585
  });

  it('turns the delays into C3-based loops in Harmonic scale (whole semitones of the scale)', () => {
    const loop = (scale: number, d: number) => { const [y] = render(make({ filterMode: 2, harmonic: 1, scale, ...solo(16, d) }), impulse(SR, 0)); return argmaxAbs(y) - 1536; };
    // FL measurements
    expect(loop(0, 0)).toBe(366);
    expect(loop(6000, 0)).toBe(22);
    expect(loop(-6000, 0)).toBe(5870);
    expect(loop(600, 0)).toBe(291); // 10 % = 4.8 semitones, truncated to 4
    expect(loop(3000, Math.trunc((ONE * 4) / 15))).toBe(43);
  });

  it('applies FL volume and pan laws and morphs the band values between banks', () => {
    expect(mbdVolGain(0.5)).toBeCloseTo(0.1888, 3);
    expect(mbdVolGain(0.9)).toBeCloseTo(0.7526, 3);
    const x = tone(1000, 0.25, 1);
    const all = (key: (k: number) => string, v: number) => { const p: Record<string, number> = {}; for (let k = 1; k <= 16; k++) p[key(k)] = v; return p; };
    const [ref] = render(make({ filterMode: 1 }), x);
    const [half] = render(make({ filterMode: 1, ...all((k) => mbdKey(1, 1, k), ONE / 2) }), x);
    expect(amp(half, 1000, 0.5) / amp(ref, 1000, 0.5)).toBeCloseTo(0.1888, 2);
    const [pl, pr] = render(make({ filterMode: 1, ...all((k) => mbdKey(1, 2, k), ONE / 4) }), x);
    expect(amp(pl, 1000, 0.5) / amp(ref, 1000, 0.5)).toBeCloseTo(Math.sqrt(1.5), 2); // FL: 1.2248
    expect(amp(pr, 1000, 0.5) / amp(ref, 1000, 0.5)).toBeCloseTo(Math.sqrt(0.5), 2);
    // morph halfway between bank 1 (vol 100 %) and bank 2 (vol 0): the parameter is interpolated
    const m: Record<string, number> = { filterMode: 1, morph: 500 };
    for (let k = 1; k <= 16; k++) { m[mbdKey(1, 1, k)] = ONE; m[mbdKey(2, 1, k)] = 0; }
    const [mo] = render(make(m), x);
    expect(amp(mo, 1000, 0.5) / amp(ref, 1000, 0.5)).toBeCloseTo(0.1888, 2);
  });

  it('smooths delay changes (90 % within the smoothing time) or crossfades taps with Keep pitch', () => {
    // scale 0 -> 100 % at t0 (band 16 at 100 ms, linear phase); an impulse enters `after` samples later
    const arrival = (p: Record<string, unknown>, after: number) => {
      const base = { ...defaultFxParams('mbdelay'), filterMode: 2, ...solo(16, Math.round(0.1 * ONE)), ...p };
      const fx = createEffect('mbdelay', SR, 128);
      fx.setParams({ ...base, scale: 0 }); fx.reset();
      const n = SR, t0 = 9600, L = new Float32Array(n);
      L[t0 + after] = 1;
      const R = Float32Array.from(L);
      const ctx = { sampleRate: SR, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: true, track: 1, sidechain: [], sendTo: () => {} };
      for (let i = 0; i < n; i += 128) {
        if (i === t0) fx.setParams({ ...base, scale: 6000 });
        fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, ctx);
      }
      return { y: L, t: t0 + after + 1536 };
    };
    // no smoothing: the new delay at once
    const a = arrival({ smoothing: 0 }, 1200);
    expect(argmaxAbs(a.y) - a.t).toBe(4800);
    // 250 ms smoothing: 250 ms after the change the delay is within ~10 % of 100 ms (FL's one-pole)
    const b = arrival({ smoothing: 1500 }, 12000);
    const db = argmaxAbs(b.y) - b.t;
    expect(db).toBeGreaterThan(4800 * 0.86); expect(db).toBeLessThan(4800);
    // keep pitch: a 100 ms linear crossfade between the old (1 sample) and the new tap; the band
    // signal reaches the delay line 1536 samples after the input (linear phase), so the impulse
    // meets the crossfade (1200 + 1536) / 4800 of the way through
    const c = arrival({ keepPitch: 1 }, 1200);
    const full = Math.abs(a.y[a.t + 4800]); // band 16 kernel peak (0.473)
    expect(Math.abs(c.y[c.t + 1]) / full).toBeCloseTo(1 - (1200 + 1536) / 4800, 2); // old tap fading
    expect(Math.abs(c.y[c.t + 4800]) / full).toBeCloseTo(1, 3); // new tap, crossfade complete
  });

  it('saturates the wet signal like FL (tanh, hard clip, comp) and mixes dry/wet linearly', () => {
    const x = tone(1000, 1, 1.2);
    const [sat] = render(make({ filterMode: 2, sat: 1 }), x);
    expect(20 * Math.log10(amp(sat, 1000, 0.6))).toBeCloseTo(-1.81, 1); // FL: -1.81 dB at 0 dBFS
    const [clip] = render(make({ filterMode: 2, sat: 2 }), tone(1000, 4, 1.2));
    expect(peak(clip, SR / 2)).toBeLessThanOrEqual(1.0000001);
    const [comp] = render(make({ filterMode: 2, sat: 0 }), tone(1000, 2, 1.2));
    expect(peak(comp, Math.round(0.8 * SR))).toBeCloseTo(1.14, 1); // FL: 1.142
    // dry/wet: linear crossfade, the dry delayed by the latency in linear-phase mode
    const n = 6000;
    const [dry] = render(make({ filterMode: 2, mix: -128 }), impulse(n, 10));
    expect(argmaxAbs(dry) - 10).toBe(1536);
    const p = { filterMode: 1, scale: 1800, ...solo(9, ONE / 2) };
    const nz = new Float32Array(SR); let s = 7; for (let i = 0; i < SR; i++) { s = (s * 16807) % 2147483647; nz[i] = (s / 2147483647 - 0.5) * 0.2; }
    const [d0] = render(make({ ...p, mix: -128 }), nz), [d1] = render(make({ ...p, mix: 128 }), nz), [dm] = render(make({ ...p, mix: -64 }), nz);
    let e = 0; for (let i = 0; i < SR; i++) e = Math.max(e, Math.abs(dm[i] - (0.75 * d0[i] + 0.25 * d1[i])));
    expect(e).toBeLessThan(1e-4);
  });

  it('is silent for silence, passes switched-off bands unaffected and stays finite', () => {
    const [z] = render(make({ scale: 6000, feedback: 6000 }), new Float32Array(SR));
    expect(peak(z)).toBe(0);
    // band 9 switched off: passes without its 500 ms delay
    const modes = new Array(16).fill(0); modes[8] = 1;
    const [o] = render(make({ filterMode: 1, scale: 6000, ...solo(9, ONE / 2), bandModes: modes }), impulse(SR, 100));
    expect(argmaxAbs(o)).toBeLessThan(100 + 2000);
    const x = new Float32Array(SR * 2);
    for (let i = 0; i < x.length; i++) x[i] = (i % 333 < 5 ? 6 : -1) * Math.sin(i * 0.013);
    for (const p of [
      { filterMode: 1, scale: 6000, feedback: 6000, weighting: 1, harmonic: 1, sat: 0 },
      { filterMode: 2, scale: -6000, feedback: 6000, keepPitch: 1, morph: 7000, sat: 1 },
      { filterMode: 0, scale: 6000, x01: 1, feedback: 6000, smoothing: 6000, sat: 2, hp: 100000 },
    ]) {
      const fx = make(p);
      const [y] = render(fx, x);
      expect(y.every(Number.isFinite)).toBe(true);
      expect(peak(y)).toBeLessThan(50);
      expect(fx.tail).toBeGreaterThan(0);
      expect(fx.tail).toBeLessThanOrEqual(120);
    }
  });
});
