import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import { enhPanText, enhPhaseText, enhSepText, enhVolGain, enhVolText } from '../../src/model/fx/plugins/stereoenhancer';
import { enhancerDelaySamples } from '../../src/engine/effects/plugins/stereoenhancer';
import { makeCtx, peak, render } from './util';

const SR = 44100;

function settled(params: Record<string, number>, sr = SR) {
  const fx = createEffect('stereoenhancer', sr, 128);
  fx.setParams({ ...defaultFxParams('stereoenhancer'), ...params });
  fx.reset();
  return fx;
}

/** Steady-state output for constant input. */
function dc(fx: ReturnType<typeof createEffect>, l: number, r: number): [number, number] {
  const L = new Float32Array(128).fill(l), R = new Float32Array(128).fill(r);
  fx.process(L, R, 128, makeCtx());
  return [L[127], R[127]];
}

describe('Stereo Enhancer', () => {
  it('is registered with FL ranges, defaults, texts and factory presets', () => {
    const d = fxDef('stereoenhancer')!;
    expect(d.name).toBe('Stereo Enhancer');
    expect([d.width, d.height]).toEqual([400, 110]);
    expect(defaultFxParams('stereoenhancer')).toEqual({ pan: 0, vol: 256, sep: 0, phase: 0, pos: 1, inv: 0 });
    expect(d.presets?.map((p) => p.name)).toEqual(['Default', 'For strings', 'Subtle']);
    // texts read from FL
    expect(enhPanText(0)).toBe('Centered');
    expect(enhPanText(-127)).toBe('99% left');
    expect(enhPanText(-16)).toBe('12% left');
    expect(enhPanText(1)).toBe('1% right');
    expect(enhVolText(256)).toBe('80%');
    expect(enhVolText(8)).toBe('3%');
    expect(enhSepText(0)).toBe('Original');
    expect(enhSepText(12)).toBe('13% merged');
    expect(enhSepText(-96)).toBe('100% separated');
    expect(enhPhaseText(0)).toBe('0.0ms right');
    expect(enhPhaseText(256)).toBe('15.3ms right');
    expect(enhPhaseText(-480)).toBe('324.5ms left');
    expect(enhPhaseText(-511)).toBe('493.3ms left');
    expect(enhVolGain(256)).toBe(1);
  });

  it('matches FL separation matrix (measured: s = sep/128)', () => {
    // FL renders: L->L, L->R for sep -96 / -48 / 48 / 96
    const ref: [number, number, number][] = [[-96, 1.375, -1.03125], [-48, 1.1875, -0.4453125], [48, 0.8125, 0.3046875], [96, 0.625, 0.46875]];
    for (const [sep, ll, lr] of ref) {
      const fx = settled({ sep });
      const [l, r] = dc(fx, 1, 0);
      expect(l).toBeCloseTo(ll, 6);
      expect(r).toBeCloseTo(lr, 6);
    }
    // mono input stays mono, gain v(1 - s/2)(1 + s)
    const [l, r] = dc(settled({ sep: 96 }), 0.5, 0.5);
    expect(l).toBeCloseTo(r, 7);
    expect(l).toBeCloseTo(0.5 * 0.625 * 1.75, 6);
  });

  it('pans as a balance control and inverts one channel', () => {
    let [l, r] = dc(settled({ pan: -64 }), 1, 1);
    expect(l).toBeCloseTo(1, 6);
    expect(r).toBeCloseTo(0.5, 6);
    [l, r] = dc(settled({ pan: 128 }), 1, 1);
    expect(l).toBeCloseTo(0, 6);
    expect(r).toBeCloseTo(1, 6);
    [l, r] = dc(settled({ inv: 1 }), 0.5, 0.25);
    expect(l).toBeCloseTo(-0.5, 6);
    expect(r).toBeCloseTo(0.25, 6);
    [l, r] = dc(settled({ inv: 2 }), 0.5, 0.25);
    expect(l).toBeCloseTo(0.5, 6);
    expect(r).toBeCloseTo(-0.25, 6);
  });

  it('delays one channel by FL phase offset (measured sample counts)', () => {
    expect(enhancerDelaySamples(256, 44100)).toBe(676);
    expect(enhancerDelaySamples(-100, 44100)).toBe(63);
    expect(enhancerDelaySamples(512, 44100)).toBe(22050);
    expect(enhancerDelaySamples(1, 44100)).toBe(0);
    expect(enhancerDelaySamples(256, 48000)).toBe(735);
    expect(enhancerDelaySamples(-100, 48000)).toBe(69);
    for (const [ph, ch] of [[256, 1], [-100, 0]] as const) {
      const fx = settled({ phase: ph });
      const imp = new Float32Array(4096);
      imp[100] = 1;
      const [L, R] = render(fx, imp, imp);
      const d = enhancerDelaySamples(ph, SR);
      const delayed = ch ? R : L, direct = ch ? L : R;
      expect(direct[100]).toBeCloseTo(1, 6);
      expect(delayed[100 + d]).toBeCloseTo(1, 6);
      expect(peak(delayed, 0, 100 + d)).toBe(0);
    }
  });

  it('applies the offset before (PRE) or after (POST) the matrix', () => {
    // right channel delayed, then L+R cross-mixed by separation: PRE moves the delayed copy into both channels
    const imp = new Float32Array(2048);
    imp[10] = 1;
    const zero = new Float32Array(2048);
    const pre = settled({ phase: 128, pos: 0, sep: 96 });
    const post = settled({ phase: 128, pos: 1, sep: 96 });
    const d = enhancerDelaySamples(128, SR);
    const [Lp] = render(pre, zero, imp); // impulse on the right input
    const [Lq] = render(post, zero, imp);
    expect(Lp[10 + d]).toBeCloseTo(0.625 * 0.75, 5); // delayed R mixed into L
    expect(Lq[10]).toBeCloseTo(0.625 * 0.75, 5); // R mixed into L before the delay of R
  });

  it('fades in at creation and ramps parameter changes at 44.1/sr per sample', () => {
    const fx = createEffect('stereoenhancer', SR, 128);
    fx.setParams(defaultFxParams('stereoenhancer'));
    const [L] = render(fx, new Float32Array(1280).fill(1));
    expect(L[0]).toBe(0);
    expect(L[1]).toBeCloseTo(0.001, 7);
    expect(L[1000]).toBeLessThan(0.999);
    expect(L[1100]).toBeCloseTo(1, 6);
    fx.setParams({ ...defaultFxParams('stereoenhancer'), vol: 0 });
    const B = new Float32Array(128).fill(1);
    fx.process(B, new Float32Array(128).fill(1), 128, makeCtx());
    expect(B[127]).toBeCloseTo(1 - 0.127, 5);
  });

  it('reports the delay as its tail; silence in, silence out; finite at extremes', () => {
    const fx = settled({ phase: 512, pos: 1, sep: -96, vol: 320 });
    expect(fx.tail).toBeCloseTo(0.5, 3);
    const [L, R] = render(fx, new Float32Array(4096));
    expect(peak(L) + peak(R)).toBe(0);
    const loud = new Float32Array(4096).map((_, i) => (i % 3 ? 1e30 : -1e30));
    const [L2, R2] = render(fx, loud, loud);
    expect(L2.every(Number.isFinite) && R2.every(Number.isFinite)).toBe(true);
    fx.setParams({ phase: NaN, sep: 'x', vol: Infinity });
    const [L3] = render(fx, new Float32Array(512).fill(0.5));
    expect(L3.every(Number.isFinite)).toBe(true);
  });
});
