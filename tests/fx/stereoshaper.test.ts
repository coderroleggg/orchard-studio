import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import { shaperDelayText, shaperGain, shaperPhaseText, shaperVolText, shaperAllpassHz } from '../../src/model/fx/plugins/stereoshaper';
import { shaperDelaySamples, shaperSliderGain } from '../../src/engine/effects/plugins/stereoshaper';
import { makeCtx, peak, render, rms, sine } from './util';

const SR = 44100;

function settled(params: Record<string, unknown>, sr = SR) {
  const fx = createEffect('stereoshaper', sr, 128);
  fx.setParams({ ...defaultFxParams('stereoshaper'), ...params });
  fx.reset();
  return fx;
}

function dc(fx: ReturnType<typeof createEffect>, l: number, r: number): [number, number] {
  const L = new Float32Array(128).fill(l), R = new Float32Array(128).fill(r);
  fx.process(L, R, 128, makeCtx());
  return [L[127], R[127]];
}

describe('Stereo Shaper', () => {
  it('is registered with FL ranges, defaults, texts and factory presets', () => {
    const d = fxDef('stereoshaper')!;
    expect(d.name).toBe('Stereo Shaper');
    expect([d.width, d.height]).toEqual([271, 313]);
    expect(d.params.map((p) => p.name)).toEqual([
      'Right into left channel volume', 'Left channel volume', 'Right channel volume', 'Left into right channel volume',
      'Left / right delay', 'Left / right dephasing',
    ]);
    expect(defaultFxParams('stereoshaper')).toEqual({ rl: 0, lvol: 12800, rvol: 12800, lr: 0, delay: 0, dephase: 0, fxpos: 1, diff: -1 });
    expect(normalizeFxParams('stereoshaper', { fxpos: 7, diff: 'a' })).toMatchObject({ fxpos: 1, diff: -1 });
    expect(d.presets?.length).toBe(25);
    expect(d.presets?.find((p) => p.name === 'Mixing/Mid - aSide splitter')?.params).toMatchObject({ rl: 8076, diffIdx: 2, fxpos: 1 });
    expect(d.presets?.find((p) => p.name === 'Effects/Phaser')?.params).toMatchObject({ dephase: 1744, fxpos: 0 });
    // texts read from FL (all 20325 swept values match; a few here)
    expect(shaperVolText(12800)).toBe('0.0dB normal');
    expect(shaperVolText(0)).toBe('-InfdB inverted');
    expect(shaperVolText(6400)).toBe('-8.7dB normal');
    expect(shaperVolText(-25600)).toBe('12.0dB inverted');
    expect(shaperVolText(1)).toBe('-87.3dB normal');
    expect(shaperDelayText(-4096)).toBe('500.0ms left');
    expect(shaperDelayText(2048)).toBe('15.3ms right');
    expect(shaperPhaseText(512)).toBe('13% right');
    expect(shaperPhaseText(0)).toBe('0% right');
  });

  it('uses FL slider law sign(v)(3^(|v|/12800) - 1)/2', () => {
    expect(shaperGain(12800)).toBe(1);
    expect(shaperGain(25600)).toBeCloseTo(4, 6);
    expect(shaperSliderGain(8076)).toBeCloseTo(0.5, 3); // FL's -6 dB preset value
    expect(shaperSliderGain(-12800)).toBe(-1);
    expect(shaperSliderGain(0)).toBe(0);
  });

  it('mixes the matrix: L\' = L·gL + R·gRL, R\' = R·gR + L·gLR (mid/side presets)', () => {
    // LR to MS: L' = (L+R)/2 (mid), R' = (L-R)/2 (side) with R vol inverted
    let [l, r] = dc(settled({ rl: 8076, lvol: 8076, rvol: -8076, lr: 8076 }), 0.8, 0.2);
    expect(l).toBeCloseTo(0.5, 3);
    expect(r).toBeCloseTo(0.3, 3);
    // swap (LR to RL)
    [l, r] = dc(settled({ rl: 12800, lvol: 0, rvol: 0, lr: 12800 }), 0.8, 0.2);
    expect(l).toBeCloseTo(0.2, 6);
    expect(r).toBeCloseTo(0.8, 6);
    // invert left
    [l, r] = dc(settled({ lvol: -12800 }), 0.8, 0.2);
    expect(l).toBeCloseTo(-0.8, 6);
    expect(r).toBeCloseTo(0.2, 6);
  });

  it('delays one channel by FL sample counts and clears the line on change', () => {
    expect(shaperDelaySamples(2416, 44100)).toBe(1276); // measured in FL
    expect(shaperDelaySamples(4096, 44100)).toBe(22050);
    expect(shaperDelaySamples(4096, 48000)).toBe(24000);
    const fx = settled({ delay: 2416 });
    const imp = new Float32Array(4096);
    imp[10] = 1;
    const [L, R] = render(fx, imp, imp);
    expect(L[10]).toBeCloseTo(1, 6);
    expect(R[10 + 1276]).toBeCloseTo(1, 6);
    expect(peak(R, 0, 1286)).toBe(0);
    // negative values delay the left channel
    const [L2] = render(settled({ delay: -2416 }), imp, imp);
    expect(L2[10 + 1276]).toBeCloseTo(1, 6);
  });

  it('dephases one channel with FL all-pass (flat magnitude, frequency 10 Hz .. 22 kHz)', () => {
    expect(shaperAllpassHz(4096)).toBeCloseTo(10, 4);
    expect(shaperAllpassHz(2048)).toBeCloseTo(316.62, 1);
    expect(shaperAllpassHz(1)).toBeCloseTo(21954.3, 0);
    // FL impulse response of dephasing 2048 on the right channel (first samples, measured)
    const fx = settled({ dephase: 2048 });
    const imp = new Float32Array(1024);
    imp[0] = 1;
    const [L, R] = render(fx, imp, imp);
    expect(L[0]).toBeCloseTo(1, 6);
    expect(R[0]).toBeCloseTo(0.91370124, 6);
    expect(R[1]).toBeCloseTo(-0.16498205, 6);
    expect(R[2]).toBeCloseTo(-0.15025511, 6);
    // all-pass: the magnitude of a steady sine is unchanged
    const s = sine(1000, 0.5, 0.5, SR);
    const [, R2] = render(settled({ dephase: 1500 }), s, s);
    expect(rms(R2, 10000)).toBeCloseTo(rms(s, 10000), 3);
  });

  it('places the effects before or after the matrix', () => {
    // right input only, swapped by the matrix; the right-channel delay acts on the input (PRE) or on the output (POST)
    const imp = new Float32Array(2048);
    imp[10] = 1;
    const zero = new Float32Array(2048);
    const swap = { rl: 12800, lvol: 0, rvol: 0, lr: 12800, delay: 1000 };
    const d = shaperDelaySamples(1000, SR);
    const [Lpre] = render(settled({ ...swap, fxpos: 0 }), zero, imp);
    const [Lpost] = render(settled({ ...swap, fxpos: 1 }), zero, imp);
    expect(Lpre[10 + d]).toBeCloseTo(1, 6); // delayed R, then swapped to L
    expect(Lpost[10]).toBeCloseTo(1, 6); // swapped to L first; only R is delayed
  });

  it('sends input minus output to the difference track', () => {
    const fx = settled({ rl: 8076, lvol: 8076, rvol: 8076, lr: 8076, diff: 3 });
    expect(fx.sendTargets!()).toEqual([3]);
    const got: number[][] = [];
    const ctx = makeCtx({ track: 1, sendTo: (t, a, b, n) => { got.push([t, a[n - 1], b[n - 1]]); } });
    const L = new Float32Array(128).fill(0.8), R = new Float32Array(128).fill(0.2);
    fx.process(L, R, 128, ctx);
    // mid on the track, side as the difference: 0.8 - 0.5 = 0.3, 0.2 - 0.5 = -0.3
    expect(got[0][0]).toBe(3);
    expect(got[0][1]).toBeCloseTo(0.3, 3);
    expect(got[0][2]).toBeCloseTo(-0.3, 3);
    expect(L[127] + got[0][1]).toBeCloseTo(0.8, 6);
  });

  it('fades in at creation, ramps parameter changes; silence in, silence out; finite', () => {
    const fx = createEffect('stereoshaper', SR, 128);
    fx.setParams(defaultFxParams('stereoshaper'));
    const [L] = render(fx, new Float32Array(1280).fill(1));
    expect(L[0]).toBe(0);
    expect(L[1]).toBeCloseTo(0.001, 7);
    expect(L[1100]).toBeCloseTo(1, 6);
    const loud = settled({ rl: 25600, lvol: 25600, rvol: -25600, lr: -25600, delay: 4096, dephase: 4096 });
    expect(loud.tail).toBeGreaterThan(0.5);
    const [S1, S2] = render(loud, new Float32Array(4096));
    expect(peak(S1) + peak(S2)).toBe(0);
    const big = new Float32Array(4096).map((_, i) => (i % 2 ? 1e30 : -1e30));
    const [B1, B2] = render(loud, big, big);
    expect(B1.every(Number.isFinite) && B2.every(Number.isFinite)).toBe(true);
    loud.setParams({ rl: NaN, delay: 'x', dephase: Infinity });
    const [C1] = render(loud, new Float32Array(512).fill(0.25));
    expect(C1.every(Number.isFinite)).toBe(true);
  });
});
