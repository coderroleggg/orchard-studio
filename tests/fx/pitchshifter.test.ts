import { describe, it, expect } from 'vitest';
import { effect } from '../../src/engine/effects/plugins/pitchshifter';
import {
  def, psDelayText, psFcorrText, psLatency, psMixText, psSemiText, psDurationText, PS_PRESETS,
} from '../../src/model/fx/plugins/pitchshifter';
import { makeCtx, rms } from './util';

const SR = 48000;
const DEFAULTS: Record<string, unknown> = { ...Object.fromEntries(def.params.map((p) => [p.key, p.def])), ...def.state!() };
/** FL's built-in (constructor) state, which the measurements started from (Voice, FAST). */
const VOICE = { ...DEFAULTS, engine: 0, detector: 0, dens: 300, jit: 30, rand: 20, fcorr: 0 };
const MUSIC = { ...DEFAULTS, engine: 1, dens: 200, jit: 0, rand: 0 };

function sine(f: number, sec: number, db = -6): Float32Array {
  const n = Math.round(sec * SR), b = new Float32Array(n), a = Math.pow(10, db / 20);
  for (let i = 0; i < n; i++) b[i] = a * Math.sin((2 * Math.PI * f * i) / SR);
  return b;
}

function harm(f0: number, sec: number, nh = 10): Float32Array {
  const n = Math.round(sec * SR), b = new Float32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 1; k <= nh; k++) v += Math.sin((2 * Math.PI * k * f0 * i) / SR) / k;
    b[i] = v;
    m = Math.max(m, Math.abs(v));
  }
  for (let i = 0; i < n; i++) b[i] *= 0.5 / m;
  return b;
}

/** Render with FL's host conventions: 0.25 s of silence first (transport stopped), output from the input's start. */
function render(params: Record<string, unknown>, inL: Float32Array, opts: { inR?: Float32Array; tail?: number; preroll?: number; tempo?: number } = {}): [Float32Array, Float32Array] {
  const fx = effect.create(SR, 512, { sample: () => undefined });
  fx.setParams(params);
  fx.reset();
  const pre = Math.round((opts.preroll ?? 0.25) * SR), tail = Math.round((opts.tail ?? 0.2) * SR);
  const N = pre + inL.length + tail;
  const L = new Float32Array(N), R = new Float32Array(N);
  L.set(inL, pre);
  R.set(opts.inR ?? inL, pre);
  const ctx = makeCtx({ blockSize: 512, tempo: opts.tempo ?? 130 });
  for (let i = 0; i < N; i += 512) {
    const m = Math.min(512, N - i);
    fx.process(L.subarray(i, i + m), R.subarray(i, i + m), m, ctx);
  }
  return [L.slice(pre), R.slice(pre)];
}

/** Level (dBFS of a sine's peak) at frequency f by windowed correlation. */
function level(x: Float32Array, f: number, a = 12000, n = 48000): number {
  let re = 0, im = 0, w = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const t = (2 * Math.PI * f * (a + i)) / SR;
    re += x[a + i] * Math.cos(t) * h;
    im += x[a + i] * Math.sin(t) * h;
    w += h;
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / w + 1e-12);
}

/** Strongest component within f +- tol: [frequency, dB]. */
function peak(x: Float32Array, f: number, tol: number, a = 12000, n = 48000): [number, number] {
  let best: [number, number] = [f, -Infinity];
  for (let ff = f - tol; ff <= f + tol + 1e-9; ff += tol / 25) {
    const l = level(x, ff, a, n);
    if (l > best[1]) best = [ff, l];
  }
  for (let ff = best[0] - tol / 25; ff <= best[0] + tol / 25; ff += tol / 500) {
    const l = level(x, ff, a, n);
    if (l > best[1]) best = [ff, l];
  }
  return best;
}

const db = (v: number) => 20 * Math.log10(Math.abs(v) + 1e-12);

describe('Pitch Shifter', () => {
  it('is registered with FL parameters, Default-preset defaults, value texts and presets', async () => {
    const { fxDef, defaultFxParams, formatParam } = await import('../../src/model/fx/registry');
    const { createEffect } = await import('../../src/engine/effects');
    const d = fxDef('pitchshifter')!;
    expect(d.name).toBe('Pitch Shifter');
    expect([d.width, d.height]).toEqual([747, 280]);
    expect(d.params.map((p) => [p.index, p.name, p.min, p.max])).toEqual([
      [0, 'Pitch', -1200, 1200], [1, 'Formant', -1200, 1200], [2, 'Analysis Channel', 0, 2], [3, 'Mix', 0, 2400],
      [4, 'Duration', 2000, 15000], [5, 'Density', 100, 500], [6, 'Jitter', 0, 100], [7, 'Rand', 0, 100],
      [8, 'Delay', 1, 768], [9, 'Feedback', 0, 100], [10, 'Delay mode', 0, 3], [11, 'Formant correction', 0, 65536], [12, 'Pitch mode', 0, 3],
    ]);
    const p = defaultFxParams('pitchshifter');
    // FL's Default preset: Music engine, density 200%, no jitter / rand, formant correction 100%, ACCURATE detector
    expect([p.pitch, p.formant, p.chan, p.mix, p.dur, p.dens, p.jit, p.rand, p.delay, p.fb, p.dmode, p.fcorr, p.pmode]).toEqual([0, 0, 0, 2400, 8500, 200, 0, 0, 768, 0, 0, 65536, 0]);
    expect([p.engine, p.detector, p.tempo, p.spectrum, p.speed, p.mono]).toEqual([1, 1, false, true, 1000, true]);
    expect(createEffect('pitchshifter', SR, 128)).toBeTruthy();
    // FL's GetName texts (flfxhost sweeps)
    expect(psSemiText(0)).toBe('0.00 semitones');
    expect(psSemiText(200)).toBe('+2.00 semitones');
    expect(psSemiText(-1200)).toBe('-12.00 semitones');
    expect([0, 12, 200, 1000, 1200, 2400].map(psMixText)).toEqual(['0%', '1%', '8%', '42%', '50%', '100%']);
    expect([2000, 3083, 8500, 15000].map(psDurationText)).toEqual(['20.00ms', '30.83ms', '85.00ms', '150.00ms']);
    expect([1, 65, 129, 448, 768].map((v) => psDelayText(v, false))).toEqual(['1.0ms', '84.4ms', '167.7ms', '583.2ms', '1000.0ms']);
    expect([1, 49, 385, 432, 768].map((v) => psDelayText(v, true))).toEqual(['0:1 steps', '1:1 steps', '8:1 steps', '9:0 steps', '16:0 steps']);
    expect([0, 164, 328, 1640, 32768, 65536].map(psFcorrText)).toEqual(['0%', '0%', '1%', '3%', '50%', '100%']);
    expect(formatParam(d.params[5], 300)).toBe('300%');
    expect(formatParam(d.params[2], 2)).toBe('LEFT + RIGHT');
    expect(formatParam(d.params[10], 3)).toBe('NO SHIFT');
    expect(formatParam(d.params[12], 2)).toBe('ABSOLUTE C5');
    // FL's factory presets: Default plus the Music and Voice folders
    expect(PS_PRESETS.length).toBe(26);
    expect(PS_PRESETS.filter((q) => q.name.startsWith('Music/')).length).toBe(18);
    expect(PS_PRESETS.filter((q) => q.name.startsWith('Voice/')).length).toBe(7);
    expect(PS_PRESETS.find((q) => q.name === 'Music/Octave Up')!.params).toEqual({ pitch: 1200, dur: 15000, dens: 300, dmode: 1, fcorr: 0, detector: 0 });
    expect(PS_PRESETS.find((q) => q.name === 'Voice/Octaver 1')!.params).toMatchObject({ pitch: -1200, formant: 1200, chan: 2, engine: 0 });
  });

  it('reports FL\'s latency: Voice 27.85 / 55.71 ms (FAST / ACCURATE), Music 0', () => {
    expect([psLatency(48000, 0, 0), psLatency(48000, 0, 1), psLatency(44100, 0, 0), psLatency(44100, 0, 1), psLatency(48000, 1, 1)]).toEqual([1336, 2674, 1228, 2457, 0]);
    const fx = effect.create(SR, 128, { sample: () => undefined });
    fx.setParams(VOICE);
    expect(fx.latency).toBe(1336);
    fx.setParams({ ...VOICE, detector: 1 });
    expect(fx.latency).toBe(2674);
    fx.setParams(MUSIC);
    expect(fx.latency).toBe(0);
  });

  it('Music: grains start on FL\'s clock and read from max(0, (r - 1) D) + 4 samples back (FL impulse responses)', () => {
    // pitch 0: one copy 4 samples late, tanh(1) (FL 0.7624)
    const imp = new Float32Array(SR / 2); imp[0] = 1;
    const [a] = render(MUSIC, imp);
    expect(a[4]).toBeCloseTo(0.762, 2);
    expect(Math.max(...a.subarray(5, 20000).map(Math.abs))).toBeLessThan(1e-4);
    // +12, grains every 2040 samples from the start: copies at 2042 / 3062 (FL 0.4629 / 0.2461)
    const [b] = render({ ...MUSIC, pitch: 1200 }, imp, { preroll: 0 });
    expect(b[2042]).toBeCloseTo(0.463, 1);
    expect(Math.abs(b[2042] - 0.4629)).toBeLessThan(0.015);
    expect(Math.abs(b[3062] - 0.2461)).toBeLessThan(0.01);
    expect(Math.max(...b.subarray(0, 2040).map(Math.abs))).toBeLessThan(1e-4);
    // after FL's 0.25 s preroll the grain clock is shifted: copies 1020 samples apart from 122 (FL 0.004 / 0.287 / 0.460 / 0.202)
    const [c] = render({ ...MUSIC, pitch: 1200 }, imp);
    const fl: [number, number][] = [[122, 0.0041], [1142, 0.2874], [2162, 0.4596], [3182, 0.2024]];
    for (const [i, v] of fl) expect(Math.abs(c[i] - v)).toBeLessThan(0.012);
    // -12: one copy at 1808, spread by the cubic interpolator (FL 0.071, 0.126, 0.071)
    const [d] = render({ ...MUSIC, pitch: -1200 }, imp);
    expect(Math.abs(d[1808] - 0.126)).toBeLessThan(0.005);
    expect(Math.abs(d[1807] - 0.0714)).toBeLessThan(0.005);
  });

  it('Music: grain spectra of a shifted sine match FL (lines D / Density apart)', () => {
    // +12, 85 ms, 200%: 887.06 / 863.53 / 910.59 Hz at -8.43 / -19.59 / -37.47 dB (FL)
    const [a] = render({ ...MUSIC, pitch: 1200 }, sine(440, 2));
    expect(level(a, 887.0588)).toBeCloseTo(-8.43, 0);
    expect(level(a, 863.5294)).toBeCloseTo(-19.59, 0);
    expect(level(a, 910.5882)).toBeCloseTo(-37.47, 0);
    // density 500%: neighbouring grains nearly cancel (FL -29.57 / -31.92 dB)
    const [b] = render({ ...MUSIC, pitch: 1200, dens: 500 }, sine(440, 2));
    expect(Math.abs(level(b, 851.7647) + 29.57)).toBeLessThan(0.5);
    expect(Math.abs(level(b, 910.5882) + 31.92)).toBeLessThan(0.5);
    // 150 ms grains hop 75 ms = 33 periods: a clean 880 Hz (FL -6.51 dB)
    const [c] = render({ ...MUSIC, pitch: 1200, dur: 15000 }, sine(440, 2));
    expect(level(c, 880)).toBeCloseTo(-6.51, 1);
    // pitch 0 is transparent apart from FL's tanh (third harmonic at -40.6 dB)
    const [e] = render(MUSIC, sine(440, 2));
    expect(level(e, 440)).toBeCloseTo(-6.5, 1);
    expect(level(e, 1320)).toBeCloseTo(-40.6, 0);
  });

  it('Music: density 1 gives FL\'s tremolo, jitter only opens gaps, rand scatters grain starts', () => {
    const clicks = new Float32Array(SR);
    for (let i = 0; i < SR; i += 2400) clicks[i] = 0.5;
    // FL: click gains 0.46 0.07 0.31 0.31 0.06 0.46 0.02 0.38 at 4 samples delay
    const [a] = render({ ...MUSIC, dens: 100 }, clicks, { tail: 0.3 });
    const fl = [0.46, 0.07, 0.31, 0.31, 0.06, 0.46, 0.02, 0.38];
    fl.forEach((v, k) => expect(Math.abs(a[2400 * (k + 1) + 4] - v)).toBeLessThan(0.015));
    const [b] = render({ ...MUSIC, jit: 100 }, clicks, { tail: 0.3 });
    for (let k = 1; k < 18; k++) {
      const seg = b.subarray(2400 * k, 2400 * k + 2400);
      expect(Math.max(...seg.map(Math.abs))).toBeLessThan(0.47); // never more than one full window (FL max 0.463)
      for (let i = 0; i < 2400; i++) if (i !== 4) expect(Math.abs(seg[i])).toBeLessThan(1e-4);
    }
    const [c] = render({ ...MUSIC, rand: 100 }, clicks, { tail: 0.3 });
    let late = 0;
    for (let k = 1; k < 18; k++) {
      const seg = c.subarray(2400 * k, 2400 * k + 2400);
      for (let i = 0; i < 2400; i++) if (Math.abs(seg[i]) > 0.02) late = Math.max(late, i);
    }
    expect(late).toBeGreaterThan(800);
    expect(late).toBeLessThan(2100); // up to D / 2 + 4 (FL max seen 1943)
  });

  it('Voice: PSOLA shifts with formants following the pitch at 0% correction (FL levels)', () => {
    // +12 on 220 Hz: 440.18 Hz at -6.50 dB, 220 Hz residue -70.2 dB (FL)
    const [a] = render({ ...VOICE, pitch: 1200 }, sine(220, 2));
    const [fa, la] = peak(a, 440, 1);
    expect(Math.abs(1200 * Math.log2(fa / 440))).toBeLessThan(3);
    expect(la).toBeCloseTo(-6.5, 1);
    expect(level(a, 220)).toBeLessThan(-60);
    // -12 on 440 Hz: 219.82 Hz at -6.50 dB
    const [b] = render({ ...VOICE, pitch: -1200 }, sine(440, 2));
    const [fb, lb] = peak(b, 220, 1);
    expect(Math.abs(1200 * Math.log2(fb / 220))).toBeLessThan(3);
    expect(lb).toBeCloseTo(-6.5, 1);
    // +7: within 8 cents of a fifth (FL lands 6 cents sharp)
    const [c] = render({ ...VOICE, pitch: 700 }, sine(220, 2));
    const [fc] = peak(c, 330, 2);
    expect(Math.abs(1200 * Math.log2(fc / (220 * Math.pow(2, 7 / 12))))).toBeLessThan(8);
    // pitch 0 passes a voiced signal 4 samples behind the reported latency
    const vib = new Float32Array(SR);
    let ph = 0;
    for (let i = 0; i < SR; i++) {
      ph += (180 * (1 + 0.03 * Math.sin((2 * Math.PI * 5 * i) / SR))) / SR;
      let v = 0;
      for (let k = 1; k < 20; k++) v += Math.sin(2 * Math.PI * k * ph) / k;
      vib[i] = 0.2 * v;
    }
    const [d] = render(VOICE, vib);
    let best = 0, bestD = 0;
    for (let dd = 1320; dd < 1360; dd++) {
      let s = 0, e1 = 0, e2 = 0;
      for (let i = 20000; i < 40000; i++) { s += vib[i] * d[i + dd]; e1 += vib[i] * vib[i]; e2 += d[i + dd] * d[i + dd]; }
      const cc = s / Math.sqrt(e1 * e2);
      if (cc > best) { best = cc; bestD = dd; }
    }
    expect(bestD).toBe(1340);
    expect(best).toBeGreaterThan(0.98);
  });

  it('Voice: formant correction keeps formants, the Formant knob moves them (FL levels)', () => {
    // 100% correction, +12 on a pure 220 Hz sine: nothing at the new harmonics (FL: rms -60.6 dB)
    const [a] = render({ ...VOICE, pitch: 1200, fcorr: 65536 }, sine(220, 2));
    expect(db(rms(a, 12000, 60000))).toBeLessThan(-50);
    // 100% correction, -12 on 440 Hz: 440 at -12.33, 219.8 / 660.2 at -18.5 dB (FL)
    const [b] = render({ ...VOICE, pitch: -1200, fcorr: 65536 }, sine(440, 2));
    expect(level(b, 440)).toBeCloseTo(-12.33, 0);
    expect(peak(b, 220, 1)[1]).toBeCloseTo(-18.5, 0);
    expect(peak(b, 660, 1)[1]).toBeCloseTo(-18.5, 0);
    // Formant +12 at pitch 0: 880.4 at -12.33, 440 / 1320.7 at -18.5 dB (FL); -12: silent (FL -71.8 dB rms)
    const [c] = render({ ...VOICE, formant: 1200 }, sine(440, 2));
    expect(peak(c, 880, 1)[1]).toBeCloseTo(-12.33, 0);
    expect(level(c, 440)).toBeCloseTo(-18.48, 0);
    expect(peak(c, 1320, 1.5)[1]).toBeCloseTo(-18.52, 0);
    const [e] = render({ ...VOICE, formant: -1200 }, sine(440, 2));
    expect(db(rms(e, 12000, 60000))).toBeLessThan(-55);
    // pulses at +12 with 100% correction: re-spaced at half the period, amplitude kept (FL 0.463)
    const pulses = new Float32Array(Math.round(1.5 * SR));
    for (let i = 0; i < pulses.length; i += 320) pulses[i] = 0.5;
    const [f] = render({ ...VOICE, pitch: 1200, fcorr: 65536 }, pulses);
    const big: number[] = [];
    for (let i = 30000; i < 31000; i++) if (Math.abs(f[i]) > 0.3) big.push(i);
    expect(big.length).toBeGreaterThanOrEqual(6);
    for (let k = 1; k < big.length; k++) expect(big[k] - big[k - 1]).toBe(160);
    expect(f[big[0]]).toBeCloseTo(0.462, 2);
  });

  it('Voice: absolute modes flatten to C (FL numbering), detection works from 55 Hz', () => {
    const [a] = render({ ...VOICE, pmode: 2 }, harm(233.08, 2));
    expect(Math.abs(1200 * Math.log2(peak(a, 261.6, 2, 30000)[0] / 261.63))).toBeLessThan(10);
    const [b] = render({ ...VOICE, pmode: 3 }, harm(233.08, 2));
    expect(Math.abs(1200 * Math.log2(peak(b, 523, 3, 30000)[0] / 523.25))).toBeLessThan(10);
    const [c] = render({ ...VOICE, pmode: 2, pitch: 700 }, harm(233.08, 2));
    expect(Math.abs(1200 * Math.log2(peak(c, 392, 2, 30000)[0] / 392.0))).toBeLessThan(10);
    // a melody comes out on one note
    const mel = new Float32Array(Math.round(2.5 * SR));
    [196, 220, 246.94, 261.63, 293.66].forEach((f, k) => mel.set(harm(f, 0.5), Math.round(0.5 * k * SR)));
    const [m] = render({ ...VOICE, pmode: 2 }, mel);
    for (let k = 0; k < 5; k++) {
      const [f0] = peak(m, 261.6, 4, Math.round((0.5 * k + 0.15) * SR) + 1340, Math.round(0.3 * SR));
      expect(Math.abs(1200 * Math.log2(f0 / 261.63))).toBeLessThan(15);
    }
    // FL shifts 55 Hz but leaves 45 Hz alone (both detectors)
    for (const detector of [0, 1]) {
      const [lo] = render({ ...VOICE, pitch: 1200, detector }, harm(45, 1, 6));
      const [hi] = render({ ...VOICE, pitch: 1200, detector }, harm(55, 1, 6));
      expect(level(lo, 45, 12000, 24000)).toBeGreaterThan(level(lo, 90, 12000, 24000));
      expect(level(hi, 110, 12000, 24000)).toBeGreaterThan(level(hi, 55, 12000, 24000) + 6);
    }
  });

  it('Voice: analysis channel picks the channel whose pitch drives both', () => {
    const l = harm(220, 2), r = harm(330, 2);
    const [aL, aR] = render({ ...VOICE, pitch: 1200, chan: 1 }, l, { inR: r });
    expect(peak(aR, 660, 3)[1]).toBeGreaterThan(-14);
    expect(peak(aL, 440, 3)[1]).toBeLessThan(peak(aR, 660, 3)[1] - 3);
  });

  it('mixes linearly and lines the dry path up with the Voice engine (FL: dry 1335 samples)', () => {
    const [a] = render({ ...VOICE, pitch: 1200, mix: 1200 }, sine(220, 2));
    expect(level(a, 220)).toBeCloseTo(-12.02, 1);
    expect(peak(a, 440, 1)[1]).toBeCloseTo(-12.52, 1);
    const [b] = render({ ...VOICE, pitch: 1200, mix: 600 }, sine(220, 2));
    expect(level(b, 220)).toBeCloseTo(-8.5, 1);
    expect(peak(b, 440, 1)[1]).toBeCloseTo(-18.54, 1);
    const noise = new Float32Array(SR);
    let s = 1;
    for (let i = 0; i < SR; i++) { s = (s * 16807) % 2147483647; noise[i] = (s / 2147483647 - 0.5) * 0.8; }
    const [c] = render({ ...VOICE, pitch: 1200, mix: 0 }, noise);
    for (let i = 6000; i < 30000; i++) expect(c[i + 1335]).toBeCloseTo(noise[i], 5);
  });

  it('echo modes: Post re-shifts the echo, Pre delays the first shift, No shift is a plain echo (FL levels)', () => {
    const burst = new Float32Array(Math.round(2.5 * SR));
    for (let i = 0; i < 0.3 * SR; i++) burst[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const seg = (x: Float32Array, t: number) => rms(x, Math.round(t * SR) - 2400, Math.round(t * SR) + 2400);
    // No shift, 50%, 1000 ms: 0.3338 / 0.1670 / 0.0833 (FL)
    const [a] = render({ ...MUSIC, dmode: 3, delay: 768, fb: 50 }, burst, { tail: 0 });
    expect(seg(a, 0.15)).toBeCloseTo(0.3338, 2);
    expect(seg(a, 1.15)).toBeCloseTo(0.1670, 2);
    expect(seg(a, 2.15)).toBeCloseTo(0.0833, 2);
    // Post: the echo goes through the shifter and tanh again (FL 0.1649 / 0.0822)
    const [b] = render({ ...MUSIC, dmode: 1, delay: 768, fb: 50 }, burst, { tail: 0 });
    expect(seg(b, 1.15)).toBeCloseTo(0.1649, 2);
    expect(seg(b, 2.15)).toBeCloseTo(0.0822, 2);
    // Pre: nothing until one delay, then 0.3340 / 0.1649 (FL)
    const [c] = render({ ...MUSIC, dmode: 2, delay: 768, fb: 50 }, burst, { tail: 0 });
    expect(seg(c, 0.15)).toBeLessThan(1e-3);
    expect(seg(c, 1.15)).toBeCloseTo(0.3340, 2);
    expect(seg(c, 2.15)).toBeCloseTo(0.1649, 2);
    // Off ignores the feedback
    const [d] = render({ ...MUSIC, dmode: 0, delay: 768, fb: 50 }, burst, { tail: 0 });
    expect(seg(d, 1.15)).toBeLessThan(1e-4);
    // 100% sustains (FL 0.3338 every 500 ms)
    const [e] = render({ ...MUSIC, dmode: 3, delay: 384, fb: 100 }, burst, { tail: 1 });
    expect(seg(e, 3.15)).toBeCloseTo(0.3338, 2);
    // a shifted burst: each Post echo an octave higher, No shift echoes stay at 880 Hz
    const short = sine(440, 0.3);
    const [f] = render({ ...MUSIC, pitch: 1200, dmode: 1, delay: 768, fb: 50, dur: 15000 }, short, { tail: 2 });
    const [g] = render({ ...MUSIC, pitch: 1200, dmode: 3, delay: 768, fb: 50, dur: 15000 }, short, { tail: 2 });
    const at = (x: Float32Array, fq: number, t: number) => level(x, fq, Math.round(t * SR), 9600);
    expect(at(f, 1760, 1.1)).toBeGreaterThan(at(f, 880, 1.1) + 10);
    expect(at(g, 880, 1.1)).toBeGreaterThan(at(g, 1760, 1.1) + 10);
  });

  it('tempo-synced delay: 192 = "4:0 steps" = one beat, 0.5 s at 120 BPM', () => {
    const imp = new Float32Array(SR); imp[0] = 0.5;
    const [a] = render({ ...MUSIC, dmode: 3, delay: 192, fb: 50, tempo: true }, imp, { tempo: 120, tail: 0.5 });
    let pk = 0, at = 0;
    for (let i = 1000; i < SR; i++) if (Math.abs(a[i]) > pk) { pk = Math.abs(a[i]); at = i; }
    expect(Math.abs(at - (24000 + 4))).toBeLessThan(3);
  });

  it('smooths changes, keeps silence silent, stays finite and has a bounded tail', () => {
    // a mix jump does not click
    const fx = effect.create(SR, 128, { sample: () => undefined });
    fx.setParams({ ...MUSIC, mix: 0 });
    fx.reset();
    const x = sine(300, 0.2, -12);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    fx.process(L.subarray(0, 4096), R.subarray(0, 4096), 4096, makeCtx());
    fx.setParams({ ...MUSIC, mix: 2400, pitch: 700 });
    for (let i = 4096; i < 8192; i += 128) fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, makeCtx());
    let jump = 0;
    for (let i = 4000; i < 8192; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
    expect(jump).toBeLessThan(0.08);
    for (const engine of [0, 1]) {
      const [s] = render({ ...DEFAULTS, engine, dmode: 3, fb: 90, pitch: 500 }, new Float32Array(SR / 2));
      expect(rms(s)).toBe(0);
      const fx2 = effect.create(SR, 512, { sample: () => undefined });
      for (let trial = 0; trial < 6; trial++) {
        const p = { ...DEFAULTS, engine, pitch: Math.round(Math.random() * 2400 - 1200), formant: Math.round(Math.random() * 2400 - 1200), fcorr: Math.round(Math.random() * 65536),
          dens: 100 + Math.round(Math.random() * 400), dur: 2000 + Math.round(Math.random() * 13000), jit: Math.round(Math.random() * 100), rand: Math.round(Math.random() * 100),
          dmode: trial % 4, fb: Math.round(Math.random() * 100), delay: 1 + Math.round(Math.random() * 767), pmode: trial % 4, detector: trial % 2, chan: trial % 3, mix: Math.round(Math.random() * 2400) };
        fx2.setParams(p);
        const n = new Float32Array(SR / 4);
        for (let i = 0; i < n.length; i++) n[i] = (Math.random() * 2 - 1) * (i % 997 === 0 ? 30 : 1);
        const a = Float32Array.from(n), b = Float32Array.from(n);
        for (let i = 0; i < n.length; i += 512) fx2.process(a.subarray(i, i + 512), b.subarray(i, i + 512), Math.min(512, n.length - i), makeCtx());
        expect(a.every((v) => Number.isFinite(v) && Math.abs(v) < 40)).toBe(true);
        expect(fx2.tail!).toBeGreaterThan(0);
        expect(fx2.tail!).toBeLessThanOrEqual(31);
      }
      fx2.setParams({ ...DEFAULTS, engine, dmode: 3, fb: 100 });
      expect(fx2.tail!).toBeLessThanOrEqual(31);
    }
  });
});
