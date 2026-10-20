import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { freeFreqHz, freeType } from '../../src/model/fx/plugins/freefilter';
import { makeCtx, render, rms, sine, peak } from './util';

const DEF = { type: 100, freq: 512, q: 169, gain: 676, center: 1 };

function impulse(p: Record<string, number>, n = 8, sr = 48000): Float32Array {
  const fx = createEffect('freefilter', sr, 128);
  fx.setParams({ ...DEF, ...p });
  fx.reset();
  const x = new Float32Array(1024); x[0] = 1;
  return render(fx, x)[0].slice(0, n);
}

describe('Free Filter', () => {
  it('is registered as a hidden legacy plugin with FL ranges, texts and presets', () => {
    const d = fxDef('freefilter')!;
    expect(d.name).toBe('Free Filter');
    expect(d.hidden).toBe(true);
    expect([d.width, d.height]).toEqual([419, 105]);
    expect(defaultFxParams('freefilter')).toEqual(DEF);
    const t = (k: string, v: number) => formatParam(fxParamDef('freefilter', k)!, v);
    // FL's value texts (test host sweeps)
    expect(t('type', 185)).toBe('Low pass');
    expect(t('type', 186)).toBe('Band pass');
    expect(t('type', 442)).toBe('Notch');
    expect(t('type', 443)).toBe('Low shelf');
    expect(t('type', 615)).toBe('High shelf');
    expect(t('freq', 512)).toBe('1457 Hz');
    expect(t('freq', 1)).toBe('11 Hz');
    expect(t('freq', 700)).toBe('3600 Hz');
    expect(t('freq', 1023)).toBe('15927 Hz');
    expect(t('q', 169)).toBe('|||');
    expect(t('q', 512)).toBe('||||||||||');
    expect(t('q', 1000)).toBe('|||||||||||||||||||');
    expect(t('gain', 676)).toBe('5.8 dB');
    expect(t('gain', 100)).toBe('14.5 dB'); // FL shows the magnitude only
    expect(d.presets!.map((p) => p.name)).toEqual(['Default', 'LowPass 16000', 'LowPass ~11025', 'LowPass ~5512', 'Noise remover', 'Sub-Woofer cut', 'Sub-Woofer pass', 'Telephone BandPass', 'Tweak the Freq.!']);
    expect(d.presets![0].params).toEqual(DEF);
    expect(freeType(250)).toBe(1);
    expect(freeFreqHz(1024)).toBeCloseTo(16000, 6);
  });

  it('matches FL impulse responses (48 kHz, CENTER on)', () => {
    [0.010402, 0.040531, 0.077505, 0.108957, 0.133921, 0.15176, 0.162173, 0.165186].forEach((v, i) => expect(impulse({})[i]).toBeCloseTo(v, 5));
    [1.266873, 0.432464, 0.204439, -0.040575, -0.241572, -0.356626, -0.370254, -0.293414].forEach((v, i) => expect(impulse({ type: 600, freq: 700, q: 400, gain: 900 })[i]).toBeCloseTo(v, 3));
    [0.961511, -0.075518, -0.072454, -0.069093, -0.065505, -0.061755, -0.057899, -0.053989].forEach((v, i) => expect(impulse({ type: 500, freq: 300, q: 512, gain: 100 })[i]).toBeCloseTo(v, 5));
  });

  it('designs at 44.1 kHz whatever the sample rate (as FL)', () => {
    // the response at 48 kHz is the 44.1 kHz response scaled in frequency by 48 / 44.1
    const lvl = (f: number, sr: number) => {
      const fx = createEffect('freefilter', sr, 128);
      fx.setParams({ ...DEF, type: 600, q: 700, gain: 1000, center: 0 });
      fx.reset();
      return rms(render(fx, sine(f, 0.5, 0.5, sr))[0], sr / 4);
    };
    expect(lvl(1457 * 48 / 44.1, 48000)).toBeCloseTo(lvl(1457, 44100), 3);
    expect(lvl(1457, 44100)).toBeGreaterThan(2); // the peak sits at the text frequency at 44.1 kHz
  });

  it('applies parameter changes at once and clears the memory on a type change (measured)', () => {
    const fx = createEffect('freefilter', 48000, 128);
    fx.setParams({ ...DEF, type: 100, freq: 500, q: 300, center: 0 });
    fx.reset();
    render(fx, sine(300, 0.2));
    fx.setParams({ ...DEF, type: 300, freq: 500, q: 300, center: 0 });
    const L = new Float32Array(4), R = new Float32Array(4);
    fx.process(L, R, 4, makeCtx());
    expect(Array.from(L)).toEqual([0, 0, 0, 0]);
  });

  it('stays finite and silent', () => {
    for (const type of [100, 200, 300, 400, 500, 600, 700]) {
      const fx = createEffect('freefilter', 48000, 128);
      fx.setParams({ ...DEF, type, freq: 300, q: 1024, gain: 1024 });
      fx.reset();
      expect(Number.isFinite(rms(render(fx, sine(40, 0.5, 1))[0]))).toBe(true);
      expect(peak(render(fx, new Float32Array(48000 * 3))[0], 48000 * 3 - 1000)).toBeLessThan(1e-4);
    }
  });
});
