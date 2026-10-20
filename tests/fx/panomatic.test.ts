import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import {
  panomaticAmtText, panomaticPanText, panomaticSpeedText, panomaticVolText, panoVolFromGain, panoVolGain,
} from '../../src/model/fx/plugins/panomatic';
import { panomaticLfoHz, panomaticLfoPeriod } from '../../src/engine/effects/plugins/panomatic';
import { makeCtx, peak, render } from './util';

const SR = 48000;

function settled(params: Record<string, number>) {
  const fx = createEffect('panomatic', SR, 128);
  fx.setParams({ ...defaultFxParams('panomatic'), pan: 128, vol: 256, ...params });
  fx.reset();
  return fx;
}

/** Output of one block for constant L/R input. */
function dcOut(fx: ReturnType<typeof createEffect>, l: number, r: number): [number, number] {
  const L = new Float32Array(128).fill(l), R = new Float32Array(128).fill(r);
  fx.process(L, R, 128, makeCtx());
  return [L[127], R[127]];
}

describe('PanOMatic', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('panomatic')!;
    expect(d.name).toBe('PanOMatic');
    expect(d.category).toBe('Gain');
    expect([d.width, d.height]).toEqual([300, 160]);
    expect(d.params.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
    // insert state = FL's factory Default preset; wheel reset values = form defaults
    expect(defaultFxParams('panomatic')).toEqual({ pan: 127, vol: 239, shape: 0, target: 0, amount: 64, speed: 27500 });
    expect(d.params.find((p) => p.key === 'pan')!.def).toBe(128);
    expect(d.params.find((p) => p.key === 'vol')!.def).toBe(256);
    expect(d.presets?.map((p) => p.name)).toEqual(['Default']);
    // FL rounds the pan to its -64..64 scale first
    expect(panomaticPanText(128)).toBe('Centered');
    expect(panomaticPanText(127)).toBe('Centered');
    expect(panomaticPanText(126)).toBe('2% left');
    expect(panomaticPanText(123)).toBe('3% left');
    expect(panomaticPanText(1)).toBe('100% left');
    expect(panomaticPanText(112)).toBe('12% left');
    expect(panomaticPanText(208)).toBe('62% right');
    expect(panomaticVolText(256)).toBe('0.0dB');
    expect(panomaticVolText(0)).toBe('-InfdB');
    expect(panomaticVolText(16)).toBe('-35.8dB');
    expect(panomaticVolText(192)).toBe('-6.0dB');
    expect(panomaticVolText(320)).toBe('5.6dB');
    expect(panomaticAmtText(16)).toBe('13%');
    expect(panomaticAmtText(64)).toBe('50%');
    expect(panomaticSpeedText(275)).toBe('1%');
    expect(panomaticSpeedText(27500)).toBe('50%');
  });

  it('uses FL volume law (11^(v/256) - 1) / 10', () => {
    expect(panoVolGain(256)).toBe(1);
    expect(panoVolGain(320)).toBeCloseTo(1.9032767, 6);
    expect(panoVolGain(128)).toBeCloseTo(0.2316625, 6);
    expect(panoVolFromGain(panoVolGain(200))).toBeCloseTo(200, 6);
    const fx = settled({ vol: 192 });
    expect(dcOut(fx, 1, 1)[0]).toBeCloseTo(0.5040106, 5);
  });

  it('merge-pans: hard left puts (L+R)/2 on the left, half right is a cross-fade', () => {
    let fx = settled({ pan: 0 });
    let [l, r] = dcOut(fx, 0.8, 0.2);
    expect(l).toBeCloseTo(0.5, 6);
    expect(r).toBeCloseTo(0, 6);
    fx = settled({ pan: 192 }); // 50% right
    [l, r] = dcOut(fx, 1, 0);
    expect(l).toBeCloseTo(0.5, 6);
    expect(r).toBeCloseTo(0.25, 6);
    [l, r] = dcOut(fx, 0, 1);
    expect(l).toBeCloseTo(0, 6);
    expect(r).toBeCloseTo(0.75, 6);
  });

  it('fades in from silence and ramps at 44.1/sr per sample (FL smoother)', () => {
    const fx = createEffect('panomatic', SR, 128);
    fx.setParams({ ...defaultFxParams('panomatic'), pan: 128, vol: 256 });
    const [L] = render(fx, new Float32Array(2048).fill(1));
    const rate = 44.1 / SR;
    expect(L[0]).toBe(0);
    expect(L[1]).toBeCloseTo(rate, 7);
    expect(L[127]).toBeCloseTo(127 * rate, 6);
    // a full-scale move takes ~22.7 ms, completed at the end of a block
    expect(L[1152]).toBeCloseTo(1, 6);
    expect(L[1100]).toBeLessThan(0.9999);
    // parameter changes ramp the same way (no zipper)
    fx.setParams({ ...defaultFxParams('panomatic'), pan: 128, vol: 0 });
    const B = new Float32Array(128).fill(1), C = new Float32Array(128).fill(1);
    fx.process(B, C, 128, makeCtx());
    expect(B[0]).toBeCloseTo(1, 6);
    expect(B[127]).toBeCloseTo(1 - 127 * rate, 5);
  });

  it('computes FL LFO periods (integer samples, 2048/sr scaling)', () => {
    expect(panomaticLfoPeriod(55000, 44100)).toBe(2297);
    expect(panomaticLfoPeriod(41250, 44100)).toBe(61041);
    expect(panomaticLfoPeriod(0, 44100)).toBe(152174288);
    expect(panomaticLfoPeriod(55000, 48000)).toBe(2110);
    expect(panomaticLfoHz(41250, 44100)).toBeCloseTo(0.72247, 4);
    // FL's frequency grows with the square of the sample rate
    expect(panomaticLfoHz(41250, 48000) / panomaticLfoHz(41250, 44100)).toBeCloseTo((48000 / 44100) ** 2, 3);
  });

  it('LFO sweeps the pan across the stereo field at the set rate', () => {
    const fx = settled({ target: 1, amount: 128, speed: 50000 });
    const hz = panomaticLfoHz(50000, SR);
    const n = Math.round((SR / hz) * 1.5);
    const [L, R] = render(fx, new Float32Array(n).fill(1), new Float32Array(n).fill(1));
    // mono input: the far side drops to silence at both extremes of the sweep
    let minL = 1, minR = 1;
    for (let i = 2000; i < n; i++) { minL = Math.min(minL, L[i]); minR = Math.min(minR, R[i]); }
    expect(minL).toBeLessThan(0.05);
    expect(minR).toBeLessThan(0.05);
    expect(peak(L)).toBeLessThanOrEqual(1.0001);
  });

  it('LFO on volume: tremolo around the volume, never negative', () => {
    const fx = settled({ target: 2, amount: 128, speed: 52000, shape: 2, vol: 100 });
    const [L] = render(fx, new Float32Array(SR).fill(1));
    let lo = Infinity, hi = -Infinity;
    for (let i = 4000; i < L.length; i++) { lo = Math.min(lo, L[i]); hi = Math.max(hi, L[i]); }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeCloseTo(panoVolGain(100) + 0.5, 2);
  });

  it('keeps the LFO phase still while the target is OFF', () => {
    const a = settled({ target: 0, amount: 128, speed: 54000 });
    render(a, new Float32Array(4096).fill(1));
    a.setParams({ ...defaultFxParams('panomatic'), pan: 128, vol: 256, target: 1, amount: 128, speed: 54000 });
    const b = settled({ target: 1, amount: 128, speed: 54000 });
    const [La] = render(a, new Float32Array(4096).fill(1));
    const [Lb] = render(b, new Float32Array(4096).fill(1));
    expect(La[4095]).toBeCloseTo(Lb[4095], 4);
  });

  it('silence in, silence out; finite at extreme settings', () => {
    const fx = settled({ vol: 320, target: 2, amount: 128, speed: 55000, pan: 0 });
    const [L, R] = render(fx, new Float32Array(4096));
    expect(peak(L) + peak(R)).toBe(0);
    const big = new Float32Array(4096).map((_, i) => (i % 2 ? 1e30 : -1e30));
    const [L2, R2] = render(fx, big);
    expect(L2.every(Number.isFinite) && R2.every(Number.isFinite)).toBe(true);
    fx.setParams({ pan: 'x', vol: NaN, speed: Infinity });
    const [L3] = render(fx, new Float32Array(512).fill(0.5));
    expect(L3.every(Number.isFinite)).toBe(true);
  });
});
