import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { makeCtx, render, sine, rms, peak } from './util';

const SR = 48000;
const fmt = (key: string, v: number) => formatParam(fxParamDef('luxeverb', key)!, v);
/** The configuration FL's reference values were measured in: reverb only, flat input, width 1, dry -60 dB. */
const REF = {
  pitchOn: 0, envMode: 0, limiter: 0, peakGain: 0, dry: -600, wet: 746, inGain: 746, inHighCut: 20000, inLowCut: 20,
  width: 100, freeze: 0, predelay: 0, modAmp: 0, brightness: 1000, decay: 10411, size: 20, diffusion: 1000, character: 50, hq: 1, reverbOn: 1,
  predelayT: false,
};

function fx(params: Record<string, unknown>) {
  const f = createEffect('luxeverb', SR, 128);
  f.setParams({ ...defaultFxParams('luxeverb'), ...params });
  f.reset();
  return f;
}

function ir(params: Record<string, unknown>, seconds: number) {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  L[0] = R[0] = 1;
  return render(fx(params), L, R, 128);
}

function energy(x: Float32Array, from = 3): number {
  let e = 0;
  for (let i = from; i < x.length; i++) e += x[i] * x[i];
  return e;
}

/** RT60 from the energy envelope (20 ms windows, -5..-35 dB fit). */
function rt60(x: Float32Array): number {
  const w = Math.round(0.02 * SR), m = Math.floor(x.length / w);
  const e: number[] = [];
  for (let k = 0; k < m; k++) e.push(10 * Math.log10(energy(x.subarray(k * w, (k + 1) * w), 0) / w + 1e-30));
  let i0 = 0;
  for (let k = 1; k < m; k++) if (e[k] > e[i0]) i0 = k;
  const j0 = e.findIndex((v, k) => k > i0 && v <= e[i0] - 5), j1 = e.findIndex((v, k) => k > i0 && v <= e[i0] - 35);
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let k = j0; k < j1; k++) { const t = (k * w) / SR; sx += t; sy += e[k]; sxx += t * t; sxy += t * e[k]; n++; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return -60 / slope;
}

describe('LuxeVerb', () => {
  it('is registered with FL ranges, the Default preset as defaults and FL value texts', () => {
    const d = fxDef('luxeverb')!;
    expect(d.width).toBe(940);
    expect(d.height).toBe(450);
    expect(d.params.length).toBe(49);
    expect(d.params.map((q) => q.index)).toEqual(Array.from({ length: 49 }, (_, i) => i));
    const p = defaultFxParams('luxeverb');
    expect(p).toMatchObject({ inHighCut: 13336, inLowCut: 547, decay: 9273, size: 61, character: 41, pitchOn: 0, pitchType: 1, wet: 701, width: 170 });
    expect(fmt('inGain', 746)).toBe('0.0dB');
    expect(fmt('inGain', 742)).toBe('0.0dB');
    expect(fmt('inGain', 741)).toBe('-0.1dB');
    expect(fmt('inGain', -600)).toBe('-60.0dB');
    expect(fmt('inGain', 1500)).toBe('15.0dB');
    expect(fmt('inHighCut', 12991)).toBe('15000Hz');
    expect(fmt('inLowCut', 518)).toBe('70Hz');
    expect(fmt('decay', 13105)).toBe('7.000s');
    expect(fmt('predelay', 2500)).toBe('125.0ms');
    expect(fmt('predelaySync', 192)).toBe('4:0');
    expect(fmt('predelaySync', 120)).toBe('2:24');
    expect(fmt('brightness', 855)).toBe('86%');
    expect(fmt('brightness', 50)).toBe(' 5%');
    expect(fmt('size', 6)).toBe(' 6m');
    expect(fmt('fbPitch', 120)).toBe('+12.0 semitones');
    expect(fmt('fbPitch', -12)).toBe('-1.2 semitones');
    expect(fmt('envScale', 70)).toBe('+0.07');
    expect(fmt('envOffset', 44)).toBe('-6%');
    expect(fmt('envOffset', 50)).toBe(' 0%');
    expect(fmt('envLowCut', 301)).toBe('60Hz');
    expect(fmt('peakFreq', 7726)).toBe('5971Hz');
    expect(fmt('peakQ', 1859)).toBe('2.00');
    expect(fmt('ffDelay2', 100)).toBe('50.9ms');
    expect(fmt('freeze', 2)).toBe('SUSTAIN');
    expect(d.presets?.length).toBe(174);
    expect(d.presets?.some((x) => x.name === 'Default')).toBe(true);
  });

  it('starts at FL\'s first arrival for the size and decays at the set time', () => {
    const first = (x: Float32Array) => x.findIndex((v, i) => i > 2 && Math.abs(v) > 1e-5);
    // FL at 48 kHz: 831 samples at size 20, 1538 at size 100
    expect(Math.abs(first(ir({ ...REF }, 0.1)[0]) - 831)).toBeLessThanOrEqual(5);
    expect(Math.abs(first(ir({ ...REF, size: 100 }, 0.1)[0]) - 1538)).toBeLessThanOrEqual(5);
    const [L] = ir({ ...REF, decay: 7741 }, 5); // 2.0 s
    const t = rt60(L);
    expect(t).toBeGreaterThan(1.7); // FL: 1.90
    expect(t).toBeLessThan(2.25);
  });

  it('matches FL\'s wet energy at decay 4 s (size 20 and 100)', () => {
    // FL: 0.617 (size 20), 0.974 (size 100); left output, width 1, both inputs
    expect(energy(ir({ ...REF }, 4)[0])).toBeGreaterThan(0.617 * 0.85);
    expect(energy(ir({ ...REF }, 4)[0])).toBeLessThan(0.617 * 1.15);
    const e100 = energy(ir({ ...REF, size: 100 }, 4)[0]);
    expect(e100).toBeGreaterThan(0.974 * 0.85);
    expect(e100).toBeLessThan(0.974 * 1.15);
  });

  it('darkens the tail with lower brightness', () => {
    const hf = (b: number) => {
      const [L] = ir({ ...REF, brightness: b, decay: 7741 }, 2);
      let e = 0;
      for (let i = SR / 2 + 1; i < L.length; i++) { const d = L[i] - L[i - 1]; e += d * d; } // differentiated = HF weighted
      return e / energy(L.subarray(SR / 2));
    };
    expect(hf(200)).toBeLessThan(hf(1000) * 0.7);
  });

  it('uses FL\'s peaking EQ form (+12 dB, Q 1: +10.4 dB half an octave away)', () => {
    const tone = (f: number, eq: boolean) => {
      const x = sine(f, 1, 0.1);
      const [o] = render(fx({ ...REF, reverbOn: 0, peakFreq: 3132, peakGain: eq ? 1200 : 0, peakQ: 811 }), x, x);
      return rms(o, SR / 2, SR);
    };
    expect(20 * Math.log10(tone(1000, true) / tone(1000, false))).toBeCloseTo(12, 0);
    expect(20 * Math.log10(tone(707, true) / tone(707, false))).toBeCloseTo(10.4, 0);
  });

  it('ducks the wet signal with the envelope (scale -1)', () => {
    const x = sine(1000, 1.5, 0.1); // -20 dB peak, 20 dB over a -40 dB threshold
    const base = render(fx({ ...REF, reverbOn: 0 }), x, x)[0];
    const duck = render(fx({ ...REF, reverbOn: 0, envMode: 1, envScale: -500, envThreshold: -4000, envOffset: 50, envSmooth: 10, envLowCut: 20, envAttack: 50, envDecay: 400 }), x, x)[0];
    const d = 20 * Math.log10(rms(duck, SR, Math.round(1.4 * SR)) / rms(base, SR, Math.round(1.4 * SR)));
    expect(d).toBeLessThan(-12); // FL: -17.9 dB at scale -0.5
    expect(d).toBeGreaterThan(-25);
  });

  it('holds the tail in freeze and passes a +12 voice an octave up', () => {
    const f = fx({ ...REF, decay: 3690 });
    const x = new Float32Array(SR * 3);
    x.set(sine(500, 0.5, 0.3));
    const c = makeCtx();
    const L = Float32Array.from(x), R = Float32Array.from(x);
    for (let i = 0; i < L.length; i += 128) {
      if (i === 188 * 128) f.setParams({ ...defaultFxParams('luxeverb'), ...REF, decay: 3690, freeze: 1 });
      f.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, c);
    }
    const a = rms(L, SR, Math.round(1.3 * SR)), b = rms(L, Math.round(2.4 * SR), Math.round(2.9 * SR));
    expect(b / a).toBeGreaterThan(0.5); // a 0.5 s reverb would be ~-100 dB here
    expect(f.tail).toBe(Infinity);
    // feed-forward voice +12 semitones
    const s = sine(440, 1, 0.25);
    const [o] = render(fx({ ...REF, reverbOn: 0, pitchOn: 1, pitchType: 1, ffDirect: 0, ffAmp1: 1000, ffPitch1: 12, ffAmp2: 0, ffDelay1: 10, ff1T: false }), s, s);
    let zc = 0;
    for (let i = SR / 2 + 1; i < SR - 1; i++) if (o[i - 1] <= 0 && o[i] > 0) zc++;
    expect(zc).toBeGreaterThan(400); // ~880 Hz over 0.5 s
    expect(zc).toBeLessThan(480);
  });

  it('ramps the wet gain and is silent for silence', () => {
    const f = fx({ ...REF, reverbOn: 0, wet: 746 });
    f.setParams({ ...defaultFxParams('luxeverb'), ...REF, reverbOn: 0, wet: -600 });
    const L = new Float32Array(128).fill(0.5), R = new Float32Array(128).fill(0.5);
    f.process(L, R, 128, makeCtx());
    expect(Math.abs(L[100])).toBeLessThan(Math.abs(L[4])); // ramping down, not a jump
    const z = new Float32Array(SR);
    const [zl, zr] = render(fx({}), z, z);
    expect(peak(zl)).toBe(0);
    expect(peak(zr)).toBe(0);
  });

  it('stays finite at extreme settings', () => {
    const noise = new Float32Array(SR);
    let s = 3;
    for (let i = 0; i < noise.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; noise[i] = (s / 0x7fffffff - 0.5) * 1.8; }
    const cases: Record<string, unknown>[] = [
      { pitchOn: 1, pitchType: 0, fbGain: 1000, fbPitch: 120, fbMix: 0, fbDelay: 10, decay: 20000, size: 1, character: 100, inGain: 1500, wet: 1500, limiter: 0 },
      { freeze: 2, decay: 20000, size: 100, modAmp: 100, modFreq: 1000, hq: 0, character: 0, diffusion: 0 },
      { envMode: 2, envScale: 1000, envThreshold: -6000, envOffset: 0, decay: 250, brightness: 0, peakGain: 1800, peakQ: 5000, peakFreq: 10000 },
      { pitchOn: 1, pitchType: 1, ffPitch1: -24, ffPitch2: 24, ffAmp1: 1000, ffAmp2: 1000, ffDirect: 1000, ffDelay1: 5000, ffDelay2: 0, width: 200 },
    ];
    for (const c of cases) {
      const [L, R] = render(fx({ ...REF, ...c }), noise, noise);
      for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error(`non-finite ${JSON.stringify(c)} at ${i}`);
    }
  });
});
