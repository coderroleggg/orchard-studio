import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import {
  WC_PRESETS, WC_SPEC_ROWS, hlsToRgb, rgbToHls, wcColor, wcEffectiveMode, wcFracFreq, wcFreqFrac, wcGain, wcMeterAmp,
  wcMeterFrac, wcRowFreq, wcState,
} from '../../src/model/fx/plugins/wavecandy';
import { render, sine } from './util';

const SR = 48000;

function dsp(p: Record<string, unknown> = {}) {
  const fx = createEffect('wavecandy', SR, 128);
  fx.setParams({ ...defaultFxParams('wavecandy'), auto: false, ...p });
  return fx;
}

describe('Wave Candy', () => {
  it('is registered with FL panel size, its one parameter and FL Default preset state', () => {
    const d = fxDef('wavecandy')!;
    expect([d.width, d.height, d.category]).toEqual([592, 315, 'Visual']);
    expect(d.params.map((q) => [q.name, q.index, q.min, q.max, q.def])).toEqual([['Hold visualization', 0, 0, 1, 0]]);
    const p = defaultFxParams('wavecandy');
    expect(p).toMatchObject({ hold: 0, mode: 0, auto: true, title: 'Wave Candy', font: 'Trebuchet MS', fade: 5001, reflect: 64, corners: 256 });
    expect(p).toMatchObject({ oscUpdate: 1000, oscWindow: 2000, specUpdate: 1500, specRes: 5, specRange: 96, meterScale: 128, meterHold: 2500, meterSpeed: 750, vecThickness: 350 });
    expect((p.colors as number[][]).length).toBe(28);
  });

  it('carries all 38 FL factory presets', () => {
    expect(WC_PRESETS.length).toBe(38);
    expect(WC_PRESETS[0].name).toBe('Default');
    const meter = WC_PRESETS.find((x) => x.name === 'Function/Peak meter')!.params;
    expect(meter).toMatchObject({ mode: 2, title: 'Meter' });
    const desk = WC_PRESETS.find((x) => x.name === 'Theme/Scope over desktop')!.params;
    expect(desk.background).toBe(false);
    for (const pr of WC_PRESETS) expect(normalizeFxParams('wavecandy', pr.params).colors).toHaveLength(28);
  });

  it('reproduces FL stored colours from the HLS wheels (hue 0..256)', () => {
    // Meter gradient color -INFdB (256,256,60,90,200) is stored as #67a014 by FL
    expect(hlsToRgb(60, 90, 200)).toEqual([0x67, 0xa0, 0x14]);
    expect(hlsToRgb(80, 110, 256)).toEqual([0x1b, 0xdb, 0x00]);
    expect(rgbToHls(0x1b, 0xdb, 0x00)).toEqual([80, 110, 256]);
    expect(wcColor([256, 100, 0, 0, 0])).toMatchObject({ r: 0, g: 0, b: 0, a: 100 / 256, oa: 1 });
  });

  it('picks the display mode by window shape in auto mode (FL Function preset sizes)', () => {
    const s = (w: number, h: number) => wcEffectiveMode({ mode: 0, auto: true, mini: false, rect: [0, 0, w, h] });
    expect(s(311, 157)).toBe(0);
    expect(s(217, 381)).toBe(1);
    expect(s(119, 391)).toBe(2);
    expect(s(241, 241)).toBe(3);
    expect(wcEffectiveMode({ mode: 1, auto: true, mini: true, rect: [0, 0, 300, 100] })).toBe(2);
  });

  it('maps scales consistently', () => {
    expect(wcGain(120)).toBeCloseTo(Math.pow(10, 0.6), 6); // +12 dB
    for (const sc of [0, 64, 128, 200, 256]) {
      expect(wcFracFreq(wcFreqFrac(1000, sc), sc)).toBeCloseTo(1000, 3);
      expect(wcMeterAmp(wcMeterFrac(0.5, sc), sc)).toBeCloseTo(0.5, 6);
    }
    // FL's default spectrum axis: 1 kHz at about 35 % of the height
    expect(wcFreqFrac(1000, 0)).toBeCloseTo(0.348, 2);
    // FL's default meter: linear in amplitude, 0 dB at 80 % of the height
    expect(wcMeterFrac(1, 128)).toBeCloseTo(0.8, 6);
  });

  it('passes audio through untouched in every mode', () => {
    for (const mode of [0, 1, 2, 3]) {
      const fx = dsp({ mode });
      const inL = sine(440, 0.1, 0.6), inR = sine(660, 0.1, 0.3);
      const [L, R] = render(fx, inL, inR);
      expect(L).toEqual(inL);
      expect(R).toEqual(inR);
    }
  });

  it('spectrum: a 1 kHz sine peaks in the 1 kHz row at about 0 dBFS (full scale)', () => {
    for (const specEnhanced of [false, true]) {
      const fx = dsp({ mode: 1, specEnhanced });
      render(fx, sine(1000, 0.3, 1));
      const m = fx.monitor!()!;
      const cols = m.cols as number, spec = m.spec as Float32Array;
      expect(cols).toBeGreaterThan(0);
      const col = spec.subarray((cols - 1) * WC_SPEC_ROWS, cols * WC_SPEC_ROWS);
      let best = 0;
      for (let r = 1; r < WC_SPEC_ROWS; r++) if (col[r] > col[best]) best = r;
      expect(Math.abs(Math.log2(wcRowFreq(best) / 1000) * 12)).toBeLessThan(0.6); // within half a semitone
      expect(col[best]).toBeGreaterThan(-3);
      expect(col[best]).toBeLessThan(1.5);
    }
  });

  it('meter: reads the right level for each mode', () => {
    const sig = sine(1000, 1.2, 0.5); // -6.02 dBFS peak, RMS -9.03 dBFS
    const read = (meterMode: number) => {
      const fx = dsp({ mode: 2, meterMode });
      render(fx, sig, sig);
      return fx.monitor!()!;
    };
    const db = (x: number) => 20 * Math.log10(x);
    expect(db(read(0).l as number)).toBeCloseTo(-6.02, 1); // peak
    expect(db(read(1).l as number)).toBeGreaterThan(-6.5); // PPM follows the peak
    expect(db(read(2).l as number)).toBeCloseTo(-9.03, 1); // RMS (300 ms)
    expect(db(read(3).l as number)).toBeCloseTo(-9.03, 0); // VU calibrated to RMS for a sine
    expect(db(read(4).l as number)).toBeCloseTo(-9.03, 0); // A-weighting is 0 dB at 1 kHz
    const lufs = db(read(5).l as number); // BS.1770: -0.691 + 10 log10(ms), K-weighting ~ +0.7 dB at 1 kHz
    expect(lufs).toBeGreaterThan(-10.5);
    expect(lufs).toBeLessThan(-8.5);
  });

  it('oscilloscope: sends the window starting on a rising zero crossing', () => {
    const fx = dsp({ mode: 0, oscWindow: 2000 }); // 20 ms
    render(fx, sine(100, 0.25, 0.8, SR).map((v, i) => (i % 1 === 0 ? v : v)));
    const m = fx.monitor!()!;
    const osc = m.osc as Float32Array, n = osc.length / 2;
    expect(n).toBe(960);
    expect(osc[0]).toBeGreaterThanOrEqual(0);
    expect(osc[0]).toBeLessThan(0.02);
    expect(osc[1]).toBeGreaterThan(osc[0]); // rising
  });

  it('vectorscope: sends the latest block of L/R pairs', () => {
    const fx = dsp({ mode: 3, vecUpdate: 1000 }); // 10 ms
    render(fx, sine(300, 0.1, 0.5), sine(300, 0.1, 0.25));
    const m = fx.monitor!()!;
    const v = m.vec as Float32Array, n = v.length / 2;
    expect(n).toBe(480);
    for (let i = 0; i < n; i += 37) expect(v[n + i]).toBeCloseTo(v[i] * 0.5, 5);
  });

  it('holds the display (no new data) while Hold visualization is on, and stays finite', () => {
    const fx = dsp({ mode: 2, hold: 1 });
    render(fx, sine(1000, 0.1));
    expect(fx.monitor!()).toBeNull();
    const fx2 = dsp({ mode: 1 });
    const b = sine(1000, 0.2);
    b[10] = NaN; b[99] = Infinity;
    render(fx2, b);
    const m = fx2.monitor!()!;
    for (const x of m.spec as Float32Array) expect(Number.isFinite(x)).toBe(true);
    expect(wcState({ corners: 9999, colors: [[1, 2, 3]] }).corners).toBe(512);
  });
});
