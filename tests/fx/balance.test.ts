import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import { balanceGain, balanceText, volumeText } from '../../src/model/fx/plugins/balance';
import { render } from './util';

const SR = 44100;

/** L = 0.5, R = 0.25 DC through a Balance; returns the last frame. */
function dc(pan: number, vol: number, n = 2048, block = 512): [number, number] {
  const fx = createEffect('balance', SR, block);
  fx.setParams({ ...defaultFxParams('balance'), pan, vol });
  const [L, R] = render(fx, new Float32Array(n).fill(0.5), new Float32Array(n).fill(0.25), block, { sampleRate: SR });
  return [L[n - 1], R[n - 1]];
}

describe('Balance', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('balance')!;
    expect(d.width).toBe(227);
    expect(defaultFxParams('balance')).toEqual({ pan: 0, vol: 256 });
    // flfxhost sweeps (all 257 / 321 values match)
    expect(balanceText(0)).toBe('Centered');
    expect(balanceText(-64)).toBe('50% left');
    expect(balanceText(80)).toBe('62% right'); // 62.5 rounds half to even
    expect(balanceText(-112)).toBe('88% left');
    expect(balanceText(128)).toBe('100% right');
    expect(volumeText(256)).toBe('0.0dB  1.00');
    expect(volumeText(0)).toBe('-InfdB  0.00');
    expect(volumeText(20)).toBe('-33.7dB  0.02');
    expect(volumeText(260)).toBe('0.4dB  1.04');
    expect(volumeText(320)).toBe('5.6dB  1.90');
    expect(balanceGain(256)).toBe(1);
    expect(d.params[1].parse!(0)).toBe(256);
  });

  it('matches FL\'s outputs exactly (L = 0.5, R = 0.25 DC)', () => {
    const ref: [number, number, number, number][] = [
      [-128, 256, 0.5303300619125366, 0], [-64, 256, 0.5460038185119629, 0.08746359497308731],
      [-1, 256, 0.5030210018157959, 0.2469368278980255], [0, 256, 0.5, 0.25],
      [37, 300, 0.4565577208995819, 0.6397424936294556], [128, 100, 3.358807409121584e-18, 0.082280233502388],
      [0, 0, 0, 0], [-100, 320, 0.9917557239532471, 0.060883402824401855],
    ];
    for (const [pan, vol, l, r] of ref) {
      const [L, R] = dc(pan, vol);
      expect(L).toBe(Math.fround(l));
      expect(R).toBe(Math.fround(r));
    }
  });

  it('fades in from zero and ramps at most 0.01 per sample at 44.1 kHz, like FL', () => {
    const fx = createEffect('balance', SR, 64);
    fx.setParams({ pan: 0, vol: 256 });
    const [L] = render(fx, new Float32Array(256).fill(0.5), new Float32Array(256).fill(0.25), 64, { sampleRate: SR });
    const fl = [[0, 0], [1, 0.005000000353902578], [2, 0.010000000707805157], [63, 0.31499984860420227], [64, 0.320000022649765], [65, 0.3228125274181366], [127, 0.4971878230571747], [128, 0.5]];
    for (const [i, v] of fl) expect(L[i]).toBe(Math.fround(v));
    // 512-frame blocks: the whole change fits in one block (FL)
    const fx2 = createEffect('balance', SR, 512);
    fx2.setParams({ pan: -64, vol: 200 });
    const [L2, R2] = render(fx2, new Float32Array(1024).fill(0.5), new Float32Array(1024).fill(0.25), 512, { sampleRate: SR });
    expect(L2[1]).toBe(Math.fround(0.0005876052309758961));
    expect(L2[300]).toBe(Math.fround(0.17628096044063568));
    expect(R2[511]).toBe(Math.fround(0.04809899628162384));
    expect(L2[512]).toBe(Math.fround(0.3008538782596588));
  });
});
