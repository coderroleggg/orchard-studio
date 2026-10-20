import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { predelayTempoText } from '../../src/model/fx/plugins/reeverb2';
import { dryGain, wetGain, sepWidth } from '../../src/engine/effects/plugins/reeverb2';
import { makeCtx, render, sine, rms, peak } from './util';

const SR = 48000;
/** Late reverb only, damping / cuts off: the configuration the FL reference values were measured in. */
const LATE = { dry: 0, er: 0, wet: 128, lowCut: 19, highCut: 221, damping: 221, room: 50 };

function ir(params: Record<string, unknown>, seconds: number, opts: { left?: number; right?: number } = {}) {
  const fx = createEffect('reeverb2', SR, 128);
  fx.setParams({ ...defaultFxParams('reeverb2'), ...params });
  fx.reset();
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  L[0] = opts.left ?? 1; R[0] = opts.right ?? 1;
  return render(fx, L, R, 128);
}

const fmt = (key: string, v: number) => formatParam(fxParamDef('reeverb2', key)!, v);

describe('Reeverb 2', () => {
  it('is registered with FL ranges, defaults (factory Default preset) and value texts', () => {
    const d = fxDef('reeverb2')!;
    expect(d.width).toBe(530);
    expect(d.height).toBe(160);
    expect(d.category).toBe('Delay reverb');
    const p = defaultFxParams('reeverb2');
    expect(p).toMatchObject({ lowCut: 75, highCut: 40, predelay: 0, room: 50, diffusion: 100, decay: 15, damping: 40,
      bass: 100, cross: 500, sep: 0, dry: 128, er: 128, wet: 87, modSpeed: 684, modDepth: 0, side: false, tempo: false });
    expect(d.params.map((q) => q.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    // texts read from FL (flfxhost sweep)
    expect(fmt('lowCut', 19)).toBe('Off');
    expect(fmt('lowCut', 176)).toBe('176Hz');
    expect(fmt('highCut', 40)).toBe('4.0kHz');
    expect(fmt('highCut', 221)).toBe('Off');
    expect(fmt('predelay', 32)).toBe('83ms');
    expect(fmt('predelay', 160)).toBe('416ms');
    expect(fmt('decay', 15)).toBe('1.5sec');
    expect(fmt('bass', 113)).toBe('113%');
    expect(fmt('sep', -53)).toBe('83% separated');
    expect(fmt('sep', 0)).toBe('Original');
    expect(fmt('sep', 11)).toBe('17% merged');
    expect(fmt('dry', 80)).toBe('63%');
    expect(fmt('wet', 87)).toBe('68%');
    expect(fmt('modSpeed', 684)).toBe('33%');
    expect(predelayTempoText(96)).toBe('2:00');
    expect(predelayTempoText(16)).toBe('0:16');
    expect(d.presets?.map((x) => x.name)).toEqual(['Cathedral', 'Default', 'Drum Room', 'Large Hall', 'Small Studio', 'The Venue']);
  });

  it('uses FL level curves for dry, ER / wet and separation', () => {
    // measured on FL: dry 64 -> 0.231662, dry 160 -> 1.903277; wet 64 -> 0.354464, wet 160 -> 1.500371
    expect(dryGain(64)).toBeCloseTo(0.231662, 5);
    expect(dryGain(160)).toBeCloseTo(1.903277, 5);
    expect(wetGain(64)).toBeCloseTo(0.354464, 5);
    expect(wetGain(160)).toBeCloseTo(1.500371, 5);
    expect(sepWidth(-64)).toBeCloseTo(2, 6);
    expect(sepWidth(32)).toBeCloseTo(0.69098, 4); // FL: L' = 0.8455 L + 0.1545 R
    expect(sepWidth(64)).toBeCloseTo(0, 6);
  });

  it('matches FL\'s tank echoes at zero diffusion (times and amplitudes)', () => {
    const [L, R] = ir({ ...LATE, diffusion: 0, decay: 30 }, 0.75);
    // FL Reeverb 2, room 50, decay 3.0 s, 48 kHz: first-pass echoes of the left and right outputs
    const fl: [number, number][] = [[2817, 0.46332], [4429, 0.4219], [6491, -0.38565], [8430, 0.35976], [10771, -0.33563]];
    for (const [i, a] of fl) expect(L[i]).toBeCloseTo(a, 4);
    for (const [i, a] of [[2615, 0.46332], [4913, -0.4219], [7057, 0.38565]] as [number, number][]) expect(R[i]).toBeCloseTo(a, 4);
    // the loop is 29280 samples: FL's echo one period later is 0.3635 x (RT60 = 1.388 x decay)
    expect(L[2817 + 29280] / L[2817]).toBeCloseTo(0.3635, 3);
    // nothing before the first tap
    expect(peak(L, 0, 2816)).toBe(0);
  });

  it('gives each tap FL\'s staged decay at short decay times', () => {
    // FL, decay 0.5 s: taps get the linear blend of two decay stages per tank half
    const [L] = ir({ ...LATE, diffusion: 0, decay: 5 }, 0.4);
    const fl: [number, number][] = [[2817, 0.463325], [4429, 0.31861], [6491, -0.19199], [8430, 0.10154], [10771, -0.07776], [12742, 0.0619], [15164, -0.03811]];
    for (const [i, a] of fl) expect(L[i]).toBeCloseTo(a, 4);
  });

  it('shapes the bass decay with FL\'s bilinear crossover', () => {
    // FL, decay 1.5 s, crossover 500 Hz: the second-pass echo after the bass shelf
    const [a] = ir({ ...LATE, diffusion: 0, decay: 15, bass: 20 }, 0.4);
    expect(a[17254]).toBeCloseTo(0.13939, 4);
    expect(a[17255]).toBeCloseTo(-0.04652, 4);
    expect(a[17256]).toBeCloseTo(-0.02805, 4);
    expect(a[4429]).toBeCloseTo(0.38973, 4); // first-pass taps are not shelved
    const [b] = ir({ ...LATE, diffusion: 0, decay: 15, bass: 300 }, 0.4);
    expect(b[17254]).toBeCloseTo(0.17056, 4);
    expect(b[17255]).toBeCloseTo(0.00415, 4);
  });

  it('matches FL\'s diffusers at full diffusion and the early reflections', () => {
    const [L] = ir({ ...LATE, decay: 30 }, 0.05);
    expect(L[360]).toBeCloseTo(-0.07462, 4); // all allpass direct paths
    expect(L[505]).toBeCloseTo(0.05274, 4); // via diffuser 2's delay
    const [eL, eR] = ir({ ...LATE, er: 128, wet: 0, diffusion: 0 }, 0.05);
    expect(eL[1118]).toBeCloseTo(0.17587, 4);
    expect(eR[895]).toBeCloseTo(0.1668, 4);
  });

  it('damps highs once per tank half with FL\'s one-pole', () => {
    const [L] = ir({ ...LATE, diffusion: 0, decay: 200, damping: 40 }, 0.1);
    // FL: 0.18566, 0.11126, 0.06668 (pole 0.5993 at 4.0 kHz)
    expect(L[2817]).toBeCloseTo(0.18566, 4);
    expect(L[2818]).toBeCloseTo(0.11126, 4);
    expect(L[2819]).toBeCloseTo(0.06668, 4);
  });

  it('delays the late reverb by the predelay (ms and tempo-based)', () => {
    const first = (x: Float32Array) => x.findIndex((v) => Math.abs(v) > 1e-6);
    expect(first(ir({ ...LATE, diffusion: 0, decay: 50, predelay: 96 }, 0.4)[0])).toBe(2817 + 11999);
    const fx = createEffect('reeverb2', SR, 128);
    fx.setParams({ ...defaultFxParams('reeverb2'), ...LATE, diffusion: 0, decay: 50, predelay: 96, tempo: true });
    fx.reset();
    const n = SR / 2;
    const L = new Float32Array(n), R = new Float32Array(n);
    L[0] = R[0] = 1;
    const [o] = render(fx, L, R, 128, { tempo: 90 });
    expect(first(o)).toBe(2817 + 15999); // FL at 90 BPM: 96 ticks = 0.5 beat
  });

  it('returns the reverb as side signal in SIDE mode', () => {
    const [L, R] = ir({ ...LATE, diffusion: 0, decay: 50, side: true }, 0.1, { left: 1, right: 0 });
    expect(L[2817]).toBeCloseTo(0.23166, 4); // FL: +0.23166 / -0.23166
    expect(R[2615]).toBeCloseTo(-0.23166, 4);
    const [mL] = ir({ ...LATE, diffusion: 0, decay: 50, side: true }, 0.1);
    expect(peak(mL)).toBeLessThan(1e-9); // mono input has no side
  });

  it('decays at the set time and stretches the bass decay with the multiplier', () => {
    const decayRate = (bass: number) => {
      const fx = createEffect('reeverb2', SR, 128);
      fx.setParams({ ...defaultFxParams('reeverb2'), ...LATE, decay: 20, bass, cross: 2000, diffusion: 100 });
      fx.reset();
      const n = SR * 3;
      const x = new Float32Array(n);
      x.set(sine(100, 0.5, 0.5), 0);
      const [o] = render(fx, x, x);
      return rms(o, Math.round(1.0 * SR), Math.round(1.2 * SR)) / rms(o, Math.round(2.0 * SR), Math.round(2.2 * SR));
    };
    const flat = decayRate(100), boosted = decayRate(300);
    expect(boosted).toBeLessThan(flat); // slower bass decay
    // 1 s of decay at RT60 = 2.78 s is about 21.6 dB
    expect(20 * Math.log10(flat)).toBeGreaterThan(15);
    expect(20 * Math.log10(flat)).toBeLessThan(28);
  });

  it('slews level changes like FL: at most 0.001 x 44100 / sr per sample (dry), 0.01 / (sqrt 11 - 1) x 44100 / sr (ER, wet)', () => {
    const fx = createEffect('reeverb2', SR, 128);
    fx.setParams({ ...defaultFxParams('reeverb2'), dry: 128, wet: 0, er: 0 });
    fx.reset();
    fx.setParams({ ...defaultFxParams('reeverb2'), dry: 0, wet: 0, er: 0 });
    const L = new Float32Array(128).fill(1), R = new Float32Array(128).fill(1);
    fx.process(L, R, 128, makeCtx({ sampleRate: SR }));
    const step = 0.001 * (44100 / SR); // FL (flfxhost, dry 100 % -> 30 %: 1, 0.999, 0.998 ... at 44.1 kHz)
    expect(L[0]).toBeCloseTo(1, 6);
    expect(L[64]).toBeCloseTo(1 - 64 * step, 6);
    expect(L[127]).toBeCloseTo(1 - 127 * step, 6);
  });

  it('is silent for silence and has a bounded tail', () => {
    const fx = createEffect('reeverb2', SR, 128);
    fx.setParams(defaultFxParams('reeverb2'));
    fx.reset();
    const z = new Float32Array(SR);
    const [L, R] = render(fx, z, z);
    expect(peak(L)).toBe(0);
    expect(peak(R)).toBe(0);
    expect(fx.tail).toBeGreaterThan(1.388 * 1.5);
    expect(fx.tail).toBeLessThan(5);
    fx.setParams({ ...defaultFxParams('reeverb2'), decay: 200, bass: 300, predelay: 384 });
    expect(fx.tail).toBeLessThan(65);
    expect(fx.tail).toBeGreaterThan(40);
  });

  it('stays finite at extreme settings and under parameter sweeps', () => {
    const fx = createEffect('reeverb2', 44100, 128);
    const base = defaultFxParams('reeverb2');
    const extremes = [
      { room: 1, decay: 200, bass: 300, diffusion: 100, modDepth: 2048, modSpeed: 2048, damping: 221, highCut: 221, lowCut: 19, wet: 160, er: 160, dry: 160, sep: -64 },
      { room: 100, decay: 200, bass: 20, cross: 25, diffusion: 0, modDepth: 2048, modSpeed: 0, damping: 5, highCut: 5, lowCut: 3000, sep: 64 },
      { room: 37, decay: 1, bass: 300, cross: 2000, diffusion: 63, predelay: 384, side: true, tempo: true },
    ];
    const noise = new Float32Array(44100);
    let seed = 7;
    for (let i = 0; i < noise.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = (seed / 0x7fffffff - 0.5) * 1.8; }
    for (const e of extremes) {
      fx.setParams({ ...base, ...e });
      fx.reset();
      const [L, R] = render(fx, noise, noise);
      for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error(`non-finite at ${i}`);
      expect(peak(L)).toBeLessThan(60);
    }
    // automate room size / predelay / diffusion every block (glides)
    fx.setParams(base);
    fx.reset();
    const c = makeCtx({ sampleRate: 44100 });
    const L = Float32Array.from(noise), R = Float32Array.from(noise);
    for (let i = 0, b = 0; i < L.length; i += 128, b++) {
      fx.setParams({ ...base, room: 1 + ((b * 7) % 100), predelay: (b * 13) % 385, diffusion: (b * 3) % 101, decay: 1 + ((b * 11) % 200) });
      fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i), c);
    }
    for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i])).toBe(true);
  });
});
