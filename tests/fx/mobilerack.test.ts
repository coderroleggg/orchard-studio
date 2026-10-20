// FL Studio Mobile Rack FX tests. Reference numbers marked "FL" were measured
// on FL Studio's own plugin with flfxhost (48 kHz, 130 BPM); see
// docs/research/fx/mobilerack.md.
import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import { getPath, setPath } from '../../src/model/automation';
import {
  MR_MODULES, mrDefaults, mrModules, mrParamPath, mrRack, type MrMod,
} from '../../src/model/fx/plugins/mobilerack';
import { mrFormat, mrIndex, mrModuleDef } from '../../src/model/fx/plugins/mobilerack/modules';
import { render, sine } from './util';

const SR = 48000;

type Spec = { type: number; p?: Record<number, number>; mx?: number[] };

/** A rack state from module specs (ids 1, 2, ...). */
function rackState(specs: Spec[]): Record<string, unknown> {
  const mods: Record<string, MrMod> = {};
  const order: number[] = [];
  specs.forEach((s, i) => {
    const p = mrDefaults(s.type);
    for (const [k, v] of Object.entries(s.p ?? {})) p[Number(k)] = v;
    mods[String(i + 1)] = { id: i + 1, type: s.type, p, mx: s.mx ?? [0.5, 1, 0.5] };
    order.push(i + 1);
  });
  return { mods, order, next: specs.length + 1 };
}

function fx(specs: Spec[], bs = 128) {
  const f = createEffect('mobilerack', SR, bs);
  f.setParams(rackState(specs));
  f.reset();
  return f;
}

const CTX = { tempo: 130, playing: true };

function impulse(f: ReturnType<typeof fx>, n = 24000, a = 0.1, ch: 'both' | 'l' | 'r' = 'both'): [Float32Array, Float32Array] {
  const L = new Float32Array(n), R = new Float32Array(n);
  if (ch !== 'r') L[0] = a;
  if (ch !== 'l') R[0] = a;
  const [yl, yr] = render(f, L, R, 128, CTX);
  for (let i = 0; i < n; i++) { yl[i] /= a; yr[i] /= a; }
  return [yl, yr];
}

/** Magnitude (dB) of an impulse response at f. */
function irDb(h: Float32Array, freq: number): number {
  let re = 0, im = 0;
  for (let i = 0; i < h.length; i++) { const ph = (2 * Math.PI * freq * i) / SR; re += h[i] * Math.cos(ph); im -= h[i] * Math.sin(ph); }
  return 20 * Math.log10(Math.hypot(re, im));
}

/** Amplitude of frequency f (single-bin DFT). */
function amp(x: Float32Array, f: number, a = 0, z = x.length): number {
  let re = 0, im = 0;
  for (let i = a; i < z; i++) { const ph = (2 * Math.PI * f * i) / SR; re += x[i] * Math.cos(ph); im += x[i] * Math.sin(ph); }
  return (2 * Math.hypot(re, im)) / (z - a);
}

const db = (x: number) => 20 * Math.log10(Math.max(1e-12, x));

function finite(x: Float32Array): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

function firstAbove(h: Float32Array, t = 1e-6): number {
  for (let i = 0; i < h.length; i++) if (Math.abs(h[i]) > t) return i;
  return -1;
}

/** Sum of tap energy around sample i (fractional delays spread over two taps). */
function tapGain(h: Float32Array, i: number, w = 3): number {
  let s = 0;
  for (let k = i - w; k <= i + w; k++) if (k >= 0 && k < h.length) s += h[k];
  return s;
}

describe('FL Studio Mobile Rack FX', () => {
  it('is registered with FL\'s name, category, size and factory presets', () => {
    const d = fxDef('mobilerack');
    expect(d?.name).toBe('FL Studio Mobile Rack FX');
    expect(d?.category).toBe('Misc');
    expect(d?.params).toHaveLength(0); // FL exposes module controls only when activated
    expect([d?.width, d?.height]).toEqual([575, 605]);
    const names = (d?.presets ?? []).map((p) => p.name);
    expect(names).toHaveLength(31);
    expect(names.slice(0, 2)).toEqual(['Default', 'Empty']);
    expect(names).toContain('Reeverb 2');
    expect(names).toContain('Wow & Flutter');
    // the default rack (FL's Default.fst) holds one Reverb 2 module with FL's values
    const mods = mrModules(defaultFxParams('mobilerack'));
    expect(mods.map((m) => m.type)).toEqual([35]);
    expect(mods[0].p.slice(0, 5)).toEqual([1, 0.2256, 0.2306, 0.999, 0.04581]);
  });

  it('defines all 29 FL Studio Mobile effect modules with FL\'s defaults', () => {
    expect(MR_MODULES).toHaveLength(29);
    // FL type ids and parameter counts (Enable included)
    const counts: Record<number, number> = { 3: 21, 4: 7, 6: 7, 7: 9, 8: 10, 9: 5, 11: 5, 13: 12, 14: 10, 15: 7, 16: 7, 18: 5, 20: 3, 24: 1, 26: 1, 27: 9, 28: 5, 29: 8, 30: 11, 34: 8, 35: 19, 36: 31, 40: 12, 41: 21, 42: 8, 43: 11, 44: 5, 45: 27, 46: 12 };
    for (const [t, n] of Object.entries(counts)) expect(mrModuleDef(Number(t))?.params.length).toBe(n);
    // FL value texts at the factory defaults
    const txt = (t: number, k: number) => { const d = mrModuleDef(t)!; return mrFormat(d.params[k], d.params[k].def); };
    expect(txt(11, 1)).toBe('0.84 Hz');
    expect(txt(8, 1)).toBe('-20.0 dB');
    expect(txt(8, 4)).toBe('186.4 ms');
    expect(txt(9, 1)).toBe('2368.9 Hz');
    expect(txt(35, 2)).toBe('706Hz');
    expect(txt(35, 1)).toBe('5.4kHz');
    expect(txt(35, 9)).toBe('70%');
    expect(txt(18, 1)).toBe('360 ms');
    expect(txt(43, 1)).toBe('1.00 Hz');
    expect(txt(42, 1)).toBe('1.00 s');
    expect(txt(20, 1)).toBe('0 dB');
    expect(txt(20, 2)).toBe('mid');
  });

  it('formats values the way FL prints them (single precision, ties to even, FL quirks)', () => {
    const f = (t: number, k: number, v: number) => mrFormat(mrModuleDef(t)!.params[k], v);
    expect(f(8, 2, 22938 / 65536)).toBe('3.3:1'); // ratio 1 + 19 v^2
    expect(f(8, 2, 1)).toBe('+inf');
    expect(f(8, 1, 1)).toBe('-0.0 dB');
    expect(f(35, 4, 0.5)).toBe('10.1s');
    expect(f(35, 7, 0.5)).toBe('62%');
    expect(f(34, 5, 22938 / 65536)).toBe('243 us');
    expect(f(34, 1, 22938 / 65536)).toBe('8.1 ms');
    expect(f(40, 2, 36045 / 65536)).toBe('23 Hz'); // FL strips the zero of "230"
    expect(f(20, 2, 3277 / 65536)).toBe('89.9% L');
    expect(f(6, 4, 3277 / 65536)).toBe('-89');
    expect(f(13, 6, 0.5)).toBe('0.62 ms');
    expect(f(36, 2, 19660 / 65536)).toBe('130.0 Hz');
    expect(f(3, 2, 0.25)).toBe('159.0 Hz');
    // choice indices: trunc v (n - 1) by default, FL's own rounding where measured
    expect(mrIndex(mrModuleDef(14)!.params[1], 23211 / 65536)).toBe(4); // "1/1"
    expect(mrIndex(mrModuleDef(46)!.params[2], 0.5)).toBe(4); // "2 beats"
    expect(mrIndex(mrModuleDef(34)!.params[4], 0.2)).toBe(1); // "left"
    expect(mrIndex(mrModuleDef(16)!.params[1], 0.775)).toBe(3); // 3/4 beat
  });

  it('repairs stored racks and keeps automation paths on module ids', () => {
    const p = normalizeFxParams('mobilerack', {
      mods: { 5: { type: 11, p: [1, 2, 'x'] }, 7: { type: 999, p: [] }, 2: { type: 20 } },
      order: [5, 5, 42],
      next: 3,
    });
    const mods = mrModules(p);
    expect(mods.map((m) => m.id)).toEqual([5, 2]);
    expect(mods[0].p).toEqual([1, 1, 0.6, 1, 0.6]); // clamped, filled from defaults
    expect(mods[1].p).toEqual(mrDefaults(20));
    expect(p.next).toBe(6);
    const path = mrParamPath(5, 1);
    expect(setPath(p, path, 0.25)).toBe(true);
    expect(getPath(p, path)).toBe(0.25);
  });

  it('passes audio untouched when empty and runs modules in rack order', () => {
    const x = sine(1000, 0.2, 0.25);
    const [y] = render(fx([]), x, x, 128, CTX);
    expect(Array.from(y.subarray(0, 64))).toEqual(Array.from(x.subarray(0, 64)));
    // +12 dB then a 0 dB limiter clips the peaks; the reverse order does not
    const lev = { type: 20, p: { 1: 1 } }, lim = { type: 28, p: {} };
    const [a] = render(fx([lev, lim]), x, x, 128, CTX);
    const [b] = render(fx([lim, lev]), x, x, 128, CTX);
    expect(db(amp(a, 1000, 4800))).toBeLessThan(0.3);
    expect(db(amp(b, 1000, 4800))).toBeCloseTo(db(0.25) + 12, 0);
  });

  it('bypasses a disabled module (true bypass with a short crossfade)', () => {
    const x = sine(1000, 0.3, 0.1);
    const f = fx([{ type: 20, p: { 1: 1 } }]);
    const [on] = render(f, x, x, 128, CTX);
    expect(db(amp(on, 1000, 4800))).toBeCloseTo(-20 + 12, 1);
    f.setParams(rackState([{ type: 20, p: { 0: 0, 1: 1 } }]));
    const [off] = render(f, x, x, 128, CTX);
    expect(db(amp(off, 1000, 4800))).toBeCloseTo(-20, 1);
    // the switch is not instant (10 ms crossfade) and leaves no click
    let maxStep = 0;
    for (let i = 1; i < 2000; i++) maxStep = Math.max(maxStep, Math.abs(off[i] - off[i - 1]));
    expect(maxStep).toBeLessThan(0.1);
  });

  it('keeps module state when modules are reordered and drops removed ones', () => {
    const f = createEffect('mobilerack', SR, 128);
    const st = rackState([{ type: 18, p: { 4: 1 } }, { type: 20 }]);
    f.setParams(st);
    const x = new Float32Array(6000); x[0] = 1;
    render(f, x, x, 128, CTX);
    // swap the order: the tape delay keeps its line (the echo still comes out)
    f.setParams({ ...st, order: [2, 1] });
    const [y] = render(f, new Float32Array(17000), new Float32Array(17000), 128, CTX);
    expect(Math.max(...Array.from(y.subarray(11000, 11600)).map(Math.abs))).toBeGreaterThan(0.2);
    // removing the module removes its tail
    f.setParams({ mods: { 2: (st.mods as Record<string, MrMod>)['2'] }, order: [2], next: 3 });
    const [z] = render(f, new Float32Array(20000), new Float32Array(20000), 128, CTX);
    expect(Math.max(...Array.from(z).map(Math.abs))).toBe(0);
  });

  it('applies the module mixer like FL (wet level, dry / wet mix, wet balance)', () => {
    // FL: Distortion at gain -24 dB on a -12 dB sine; mixer mix 0.5 -> -16.05 dB, level +20 dB -> -6.91 dB
    const x = sine(1000, 0.4, Math.pow(10, -12 / 20));
    const out = (mx: number[]) => { const [l, r] = render(fx([{ type: 6, p: { 3: 0 }, mx }]), x, x, 128, CTX); return [db(amp(l, 1000, 9600)), db(amp(r, 1000, 9600))]; };
    expect(out([0.5, 1, 0.5])[0]).toBeCloseTo(-23.66, 0);
    expect(out([0.5, 0.5, 0.5])[0]).toBeCloseTo(-16.05, 0);
    expect(out([1, 0.5, 0.5])[0]).toBeCloseTo(-6.91, 0);
    expect(out([0.5, 1, 0])[1]).toBeCloseTo(-12, 1); // pan hard left: the right channel stays dry
    expect(out([0.5, 1, 0])[0]).toBeCloseTo(-23.66, 0);
  });

  it('processes silence to silence and stays finite and bounded for every module', () => {
    const noise = new Float32Array(SR / 2);
    let seed = 7;
    for (let i = 0; i < noise.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; noise[i] = (seed / 4294967296 - 0.5) * 1.6; }
    for (const d of MR_MODULES) {
      const f = fx([{ type: d.type }]);
      const [sl] = render(f, new Float32Array(8000), new Float32Array(8000), 128, CTX);
      expect(Math.max(...Array.from(sl).map(Math.abs)), d.name).toBeLessThan(1e-6);
      // extreme settings: every parameter at 1, then at 0
      for (const v of [1, 0]) {
        const p: Record<number, number> = {};
        d.params.forEach((_, k) => { if (k > 0) p[k] = v; });
        const g = fx([{ type: d.type, p }]);
        const [yl, yr] = render(g, noise, noise, 128, CTX);
        expect(finite(yl) && finite(yr), `${d.name} @${v}`).toBe(true);
        expect(Math.max(...Array.from(yl).map(Math.abs)), `${d.name} @${v}`).toBeLessThan(64);
        expect(g.tail ?? 0).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('reproduces FL\'s Equalizer, Graphic EQ, Tuned EQ and Filter responses', () => {
    const F = [50, 100, 300, 700, 1000, 2000, 5000, 10000, 15000];
    const check = (spec: Spec, ref: number[], tol: number, n = F.length) => {
      const [h] = impulse(fx([spec]));
      F.slice(0, n).forEach((f, i) => expect(irDb(h, f), `${spec.type} @${f}`).toBeCloseTo(ref[i], tol));
    };
    // FL: band 3 at 789.6 Hz, +24 dB (the "+12 dB" end), bandwidth 3.75 octaves
    check({ type: 3, p: { 9: 1, 10: 0.5, 11: 0.5, 12: 0.51 } }, [2.4, 6.02, 15.12, 23.67, 22.81, 15.37, 6.83, 1.12, -1.68], 1);
    // FL: Graphic EQ 1.5 kHz band at max
    check({ type: 7, p: { 5: 1 } }, [0.04, 0.15, 1.29, 5.79, 10.76, 13.45, 2.55, 0.55, 0.15], 1);
    // FL: Tuned EQ C6 band at max, bandwidth 0.3
    check({ type: 30, p: { 5: 1, 10: 0.3 } }, [0.01, 0.04, 0.42, 4.02, 19.29, 1.86, 0.2, 0.04, 0.01], 1);
    // FL: Filter LP 24 dB at "1 kHz", resonance 0.5
    check({ type: 9, p: { 1: Math.log(1000 / 16) / Math.log(2) / 10.3, 2: 0.5, 3: 0, 4: 0 } }, [-1.14, -1.16, -1.48, -4.17, -8.61, -26.59, -58.4], 1, 7);
    // FL latencies: Equalizer and Filter 1 sample, Graphic / Tuned EQ 8
    expect(firstAbove(impulse(fx([{ type: 3 }]))[0])).toBe(1);
    expect(firstAbove(impulse(fx([{ type: 7 }]))[0])).toBe(8);
    expect(firstAbove(impulse(fx([{ type: 30 }]))[0])).toBe(8);
  });

  it('matches FL\'s dynamics laws (compressor makeup, limiter, gate, leveller)', () => {
    const gainAt = (spec: Spec, level: number) => {
      const x = sine(1000, 0.8, Math.pow(10, level / 20));
      const [y] = render(fx([spec]), x, x, 128, CTX);
      return db(amp(y, 1000, 28800)) - level;
    };
    // FL: Level is 40 v dB; Auto gain adds -20 dB - thresh (1 - 1/ratio)
    expect(gainAt({ type: 8, p: { 2: 0.5, 7: 0 } }, -40)).toBeCloseTo(20, 1);
    expect(gainAt({ type: 8, p: { 2: 0.5, 7: 1 } }, -40)).toBeCloseTo(20 * (1 - 1 / 5.75), 0);
    expect(gainAt({ type: 8, p: {} }, -6)).toBeCloseTo(0, 1); // ratio 1:1 + auto gain = unity
    // FL limiter: in +12 dB, threshold -12 dB
    expect(gainAt({ type: 28, p: { 1: 0.75, 4: 0.5 } }, -30)).toBeCloseTo(12, 1);
    expect(gainAt({ type: 28, p: { 1: 0.75, 4: 0.5 } }, 0)).toBeCloseTo(-12, 0);
    // FL latencies: 2 ms limiter look-ahead, 5.3 ms gate look-ahead
    expect(firstAbove(impulse(fx([{ type: 28 }]))[0], 1e-3)).toBe(96);
    expect(firstAbove(impulse(fx([{ type: 27, p: { 3: 0 } }]), 4000, 0.5)[0], 1e-3)).toBe(254);
    // Leveller: -60 + 72 v^0.6 dB and a linear balance
    expect(gainAt({ type: 20, p: { 1: 0.5 } }, -20)).toBeCloseTo(-12.5, 1);
    const [l, r] = impulse(fx([{ type: 20, p: { 2: 0.75 } }]), 100);
    expect(l[0]).toBeCloseTo(0.5, 3);
    expect(r[0]).toBeCloseTo(1, 3);
  });

  it('matches FL\'s distortion curves', () => {
    // slow sine through the curve; FL values at x = 0.5 / 0.1
    const at = (spec: Spec, xv: number) => {
      const f = fx([spec]);
      const n = 2000, L = new Float32Array(n).fill(xv);
      const [y] = render(f, L, L, 128, CTX);
      return y[n - 1];
    };
    expect(at({ type: 6, p: { 5: 0, 1: 0.25 } }, 0.5)).toBeCloseTo(0.9468, 3); // Hard
    expect(at({ type: 6, p: { 5: 0.4, 1: 0.25 } }, 0.1)).toBeCloseTo(0.7167, 3); // Tube
    expect(at({ type: 6, p: { 5: 1, 1: 0.5 } }, 0.1)).toBeCloseTo(0.5623, 3); // Clip
    expect(at({ type: 6, p: { 5: 0.7, 1: 0.25 } }, 0.1)).toBeCloseTo(0.3251, 1); // Soft (approximated curve)
    // Gain is the output level, Stereo moves the drive between channels (FL: L -9.57 / R -2.44 dB)
    const x = sine(1000, 0.3, 0.1);
    const [yl, yr] = render(fx([{ type: 6, p: { 1: 0.25, 4: 0.25 } }]), x, x, 128, CTX);
    expect(db(Math.sqrt(2) * rmsOf(yl, 4800))).toBeCloseTo(-9.57, 0);
    expect(db(Math.sqrt(2) * rmsOf(yr, 4800))).toBeCloseTo(-2.44, 0);
  });

  it('matches FL\'s tape and trance delay echoes', () => {
    // Tape Delay: 360 ms (+3 samples), first echo mix x fb, none without feedback
    const [h] = impulse(fx([{ type: 18 }]), 40000);
    expect(tapGain(h, 17282)).toBeCloseTo(0.4 * 0.6, 2);
    expect(tapGain(h, 34565)).toBeCloseTo(0.4 * 0.36, 2);
    const [h0] = impulse(fx([{ type: 18, p: { 2: 0 } }]), 40000);
    expect(Math.max(...Array.from(h0.subarray(100)).map(Math.abs))).toBe(0);
    // Async: the right channel at half the time (FL 8642.6)
    const [, hr] = impulse(fx([{ type: 18, p: { 3: 1 } }]), 20000);
    expect(tapGain(hr, 8643)).toBeCloseTo(0.24, 2);
    // Trance Delay at 130 BPM: 3/4 beat = 16615 samples (whole samples), gains (0.99 fb)^n
    const [t] = impulse(fx([{ type: 16 }]), 52000);
    expect(t[16615]).toBeCloseTo(0.396, 3);
    expect(t[33230]).toBeCloseTo(0.157, 3);
    // Ping-pong (default mode): a left input echoes right first
    const [pl, pr] = impulse(fx([{ type: 16 }]), 40000, 0.1, 'l');
    expect([pl[16615], pr[16615]].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0.396]);
    expect(pl[33230]).toBeCloseTo(0.157, 3);
    // Offset mode: left output one division late (FL 16614), echoes every two
    const [ol] = impulse(fx([{ type: 16, p: { 5: 1 } }]), 52000, 0.1, 'l');
    expect(ol[0]).toBe(0);
    expect(ol[16614]).toBeCloseTo(1, 3);
    expect(ol[49844]).toBeCloseTo(0.396, 3);
  });

  it('matches FL\'s comb, chorus and flanger structures', () => {
    // Comb Filter: E3 (snap) -> 48000 / 164.81 + 3 samples, wet = mix, feedback = v
    const [c] = impulse(fx([{ type: 40 }]), 1200);
    expect(tapGain(c, 294)).toBeCloseTo(0.75, 2);
    expect(tapGain(c, 588)).toBeCloseTo(0.6, 2);
    // Chorus: voice gain 2 mix^2 over an untouched dry signal; left voice near 470 samples
    const [ch] = impulse(fx([{ type: 11, p: { 4: 1 } }]), 600);
    expect(ch[0]).toBeCloseTo(1, 5);
    let peakAt = 0;
    for (let i = 300; i < 480; i++) if (Math.abs(ch[i]) > Math.abs(ch[peakAt])) peakAt = i;
    expect(peakAt).toBeGreaterThan(400);
    expect(tapGain(ch, peakAt, 1)).toBeCloseTo(2, 1);
    // Flanger: LFO amount 0, feedback 0 -> one inverted tap at 3 + 7.5 x 119/120 samples
    const [fl] = impulse(fx([{ type: 13, p: { 5: 0, 7: 0 } }]), 100);
    expect(tapGain(fl, 10, 1)).toBeCloseTo(-1, 2);
  });

  it('matches FL\'s Reverb 2 timing, decay and levels', () => {
    const [h] = impulse(fx([{ type: 35, p: { 8: 0 } }]), SR * 4);
    // late part starts at 19.9 ms x size (FL: sample 955)
    expect(Math.abs(firstAbove(h.subarray(3), 1e-3) + 3 - 955)).toBeLessThanOrEqual(2);
    let e = 0;
    for (let i = 3; i < h.length; i++) e += h[i] * h[i];
    expect(10 * Math.log10(e / 0.043)).toBeLessThan(1.5); // FL late energy 0.043
    expect(10 * Math.log10(e / 0.043)).toBeGreaterThan(-1.5);
    // decay: energy 1.3 s after the onset is ~60 dB down at DECAY 1.0 s (FL RT ~1.3 s)
    const seg = (a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += h[i] * h[i]; return s / (b - a); };
    const drop = 10 * Math.log10(seg(Math.round(0.3 * SR), Math.round(0.35 * SR)) / seg(Math.round(1.3 * SR), Math.round(1.35 * SR)));
    expect(drop).toBeGreaterThan(35);
    expect(drop).toBeLessThan(60);
    // early reflections (late off): left starts at 37.5 ms, right at 28.5 ms (FL 1799 / 1366)
    const [el, er] = impulse(fx([{ type: 35, p: { 9: 0 } }]), 6000);
    expect(Math.abs(firstAbove(el.subarray(3), 1e-3) + 3 - 1799)).toBeLessThanOrEqual(2);
    expect(Math.abs(firstAbove(er.subarray(3), 1e-3) + 3 - 1366)).toBeLessThanOrEqual(2);
  });

  it('matches FL\'s stereo modules', () => {
    // Spacer output M/S: L = mid, R = side
    const [ll, lr] = impulse(fx([{ type: 34, p: { 7: 0.5 } }]), 10, 0.1, 'l');
    expect([ll[0], lr[0]]).toEqual([0.5, 0.5]);
    // Spacer L/R delay +100 %: left 300 ms late
    const [sd] = impulse(fx([{ type: 34, p: { 1: 1 } }]), 15000, 0.1, 'l');
    expect(firstAbove(sd)).toBe(14400);
    // Stereoizer: s = strength^2 x high-passed delayed (L + R), added to L and subtracted from R
    const [zl, zr] = impulse(fx([{ type: 15 }]), 600, 0.1, 'l');
    expect(zl[0]).toBeCloseTo(1, 5);
    // FL taps 357..359: 0.024, 0.404, -0.052
    expect(tapGain(zl, 358, 1)).toBeCloseTo(0.376, 2);
    expect(tapGain(zr, 358, 1)).toBeCloseTo(-0.376, 2);
  });

  it('follows the beat: Autoduck and synced LFOs lock to the song position', () => {
    // FL: floor 0.235 at Ducking 58 %, one cycle per beat (130 BPM = 22154 samples)
    const n = 60000, x = new Float32Array(n).fill(0.5);
    const [y] = render(fx([{ type: 29 }]), x, x, 128, { tempo: 130, playing: true, pos: 0 });
    const g = (i: number) => y[i] / 0.5;
    expect(g(Math.round(0.05 * 22154))).toBeCloseTo(0.235, 1);
    expect(g(Math.round(0.95 * 22154))).toBeGreaterThan(0.95);
    expect(g(22154 + Math.round(0.05 * 22154))).toBeCloseTo(0.235, 1);
  });

  it('loads every factory preset as a valid rack', () => {
    for (const pr of fxDef('mobilerack')?.presets ?? []) {
      const st = normalizeFxParams('mobilerack', { ...defaultFxParams('mobilerack'), ...structuredClone(pr.params) });
      const f = createEffect('mobilerack', SR, 128);
      f.setParams(st);
      const x = sine(220, 0.1, 0.3);
      const [yl] = render(f, x, x, 128, CTX);
      expect(finite(yl), pr.name).toBe(true);
      expect(mrModules(st).length).toBe(pr.name === 'Empty' ? 0 : 1);
    }
    expect(mrRack([35, 18]).order).toEqual([1, 2]);
  });
});

function rmsOf(x: Float32Array, a = 0): number {
  let s = 0;
  for (let i = a; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length - a));
}
