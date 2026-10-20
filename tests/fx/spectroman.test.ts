import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, formatParam, fxDef, fxParamDef } from '../../src/model/fx/registry';
import { SPM_COLS, spmAmpText, spmBin, spmCurve, spmScaleText, spmTable } from '../../src/model/fx/plugins/spectroman';
import { SpectromanDsp } from '../../src/engine/effects/plugins/spectroman';
import { render, sine } from './util';

// FL's value texts (flfxhost sweep of the real plugin), values 0..128
const SCALE_44 = '9539 9539 9539 9539 9539 9539 9539 8463 8463 8463 8463 8463 8463 8463 8463 8463 7730 7730 7730 7730 7730 7730 7171 7171 7171 7171 6740 6740 6740 6395 6395 6395 6094 6094 5835 5835 5835 5620 5426 5426 5254 5254 5103 4974 4845 4845 4716 4608 4500 4414 4328 4156 4091 4005 3898 3833 3725 3618 3575 3488 3402 3316 3208 3144 3058 3015 2929 2864 2778 2713 2649 2584 2519 2455 2390 2347 2283 2218 2153 2110 2046 2003 1960 1895 1852 1787 1744 1701 1658 1615 1572 1529 1486 1443 1400 1378 1335 1292 1270 1227 1206 1163 1141 1098 1077 1055 1012 991 969 947 926 883 861 840 818 797 775 754 732 711 689 668 646 646 624 603 581 560 560';
const SCALE_48 = '10383 10383 10383 10383 10383 10383 10383 9211 9211 9211 9211 9211 9211 9211 9211 9211 8414 8414 8414 8414 8414 8414 7805 7805 7805 7805 7336 7336 7336 6961 6961 6961 6633 6633 6352 6352 6352 6117 5906 5906 5719 5719 5555 5414 5273 5273 5133 5016 4898 4805 4711 4523 4453 4359 4242 4172 4055 3938 3891 3797 3703 3609 3492 3422 3328 3281 3188 3117 3023 2953 2883 2812 2742 2672 2602 2555 2484 2414 2344 2297 2227 2180 2133 2062 2016 1945 1898 1852 1805 1758 1711 1664 1617 1570 1523 1500 1453 1406 1383 1336 1312 1266 1242 1195 1172 1148 1102 1078 1055 1031 1008 961 938 914 891 867 844 820 797 773 750 727 703 703 680 656 633 609 609';
const AMP = '0 1 2 2 3 4 5 5 6 7 8 9 9 10 11 12 13 13 14 15 16 16 17 18 19 20 20 21 22 23 23 24 25 26 27 27 28 29 30 30 31 32 33 34 34 35 36 37 38 38 39 40 41 41 42 43 44 45 45 46 47 48 48 49 50 51 52 52 53 54 55 55 56 57 58 59 59 60 61 62 63 63 64 65 66 66 67 68 69 70 70 71 72 73 73 74 75 76 77 77 78 79 80 80 81 82 83 84 84 85 86 87 88 88 89 90 91 91 92 93 94 95 95 96 97 98 98 99 100';

const SR = 48000;
const LOG = 4096 / Math.log(11);

function dsp(p: Record<string, unknown> = {}): SpectromanDsp {
  const fx = createEffect('spectroman', SR, 128) as SpectromanDsp;
  fx.setParams({ ...defaultFxParams('spectroman'), ...p });
  return fx;
}

/** Column whose bin range [table[x], table[x+1]) contains `bin`. */
function columnOf(table: Int32Array, bin: number): number {
  for (let x = 0; x < SPM_COLS; x++) if (bin >= table[x] && bin < Math.max(table[x + 1], table[x] + 1)) return x;
  return -1;
}

describe('Spectroman', () => {
  it('is registered with FL parameters, defaults and state', () => {
    const d = fxDef('spectroman')!;
    expect([d.width, d.height, d.category]).toEqual([285, 159, 'Visual']);
    expect(d.params.map((q) => [q.name, q.index, q.min, q.max, q.def])).toEqual([
      ['Output mode', 0, 0, 1, 1],
      ['Amplification', 1, 0, 128, 64],
      ['Frequency scale (Center frequency)', 2, 0, 128, 64],
    ]);
    expect(defaultFxParams('spectroman')).toEqual({ mode: 1, amp: 64, scale: 64, stereo: false, peaks: true, windowing: true });
    expect(formatParam(fxParamDef('spectroman', 'mode')!, 0)).toBe('spectrograph');
    expect(formatParam(fxParamDef('spectroman', 'mode')!, 1)).toBe('sonograph');
  });

  it('matches every FL value text of Amplification and Frequency scale', () => {
    const s44 = SCALE_44.split(' '), s48 = SCALE_48.split(' '), amp = AMP.split(' ');
    for (let v = 0; v <= 128; v++) {
      expect(spmScaleText(v, 44100)).toBe(`${s44[v]}Hz`);
      expect(spmScaleText(v, 48000)).toBe(`${s48[v]}Hz`);
      expect(spmAmpText(v)).toBe(`${amp[v]}%`);
    }
  });

  it('builds FL frequency tables: column 128 reaches Nyquist, low columns get single bins', () => {
    expect(spmCurve(0)).toBe(1);
    expect(spmCurve(64)).toBe(45);
    expect(spmCurve(128)).toBe(2000);
    for (const v of [0, 64, 128]) {
      const t = spmTable(v);
      expect(t[0]).toBe(0);
      expect(t[SPM_COLS]).toBe(1024);
      for (let i = 1; i <= SPM_COLS; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
    }
    expect(spmBin(64, 45)).toBe(140);
    expect(spmBin(65, 45)).toBe(145);
  });

  it('passes audio through untouched', () => {
    const fx = dsp();
    const inL = sine(440, 0.2, 0.6), inR = sine(550, 0.2, 0.3);
    const [L, R] = render(fx, inL, inR);
    expect(L).toEqual(inL);
    expect(R).toEqual(inR);
  });

  it('peaks at the right column with FL level for a bin-centred sine (windowed, mono)', () => {
    const fx = dsp({ mode: 0 });
    const f = (SR / 2048) * 64; // 1500 Hz, exactly bin 64
    render(fx, sine(f, 0.3, 0.5), sine(f, 0.3, 0.5)); // mono sum = full-scale sine
    const m = fx.monitor!()!;
    expect(m.mode).toBe(0);
    expect(m.ch).toBe(1);
    const n = m.n as number;
    const bars = (m.bars as Float32Array).subarray((n - 1) * SPM_COLS, n * SPM_COLS);
    let best = 0;
    for (let x = 1; x < SPM_COLS; x++) if (bars[x] > bars[best]) best = x;
    const table = spmTable(64);
    expect(best).toBe(columnOf(table, 64));
    // |X| = N/2 * coherent gain (0.35875) for a unit sine; level = 4096 * log11(1 + |X| * 15/1024)
    const expected = Math.round(LOG * Math.log(1 + 1024 * 0.35875 * 0.0146484375));
    expect(Math.abs(bars[best] - expected)).toBeLessThanOrEqual(3);
    // band peak of the column's band holds the same level
    expect((m.pk as Float32Array)[best >> 2]).toBe(bars[best]);
  });

  it('reads 2x per channel in stereo and keeps channels apart in the sonograph', () => {
    const fx = dsp({ mode: 1, stereo: true });
    const f = (SR / 2048) * 64;
    render(fx, sine(f, 0.3, 1), new Float32Array(Math.round(0.3 * SR)));
    const m = fx.monitor!()!;
    expect(m.ch).toBe(2);
    const n = m.n as number, b = m.bars as Float32Array;
    const left = b.subarray((n - 1) * 2 * SPM_COLS, (n - 1) * 2 * SPM_COLS + SPM_COLS);
    const right = b.subarray((n - 1) * 2 * SPM_COLS + SPM_COLS, n * 2 * SPM_COLS);
    const col = columnOf(spmTable(64), 64);
    const expected = Math.round(LOG * Math.log(1 + 1024 * 0.35875 * 0.0146484375 * 2));
    expect(Math.abs(left[col] - expected)).toBeLessThanOrEqual(3);
    expect(Math.max(...right)).toBe(0);
  });

  it('runs one frame per 1536 samples and lets bars fall 341 per frame', () => {
    const fx = dsp({ mode: 0, windowing: false });
    fx.monitor!();
    render(fx, sine(1500, 2048 / SR, 0.5)); // exactly one frame
    let m = fx.monitor!()!;
    expect(m.n).toBe(1);
    const col = columnOf(spmTable(64), 64);
    const level = (m.bars as Float32Array)[col];
    expect(level).toBeGreaterThan(3000);
    render(fx, new Float32Array(1536 * 3));
    m = fx.monitor!()!;
    expect(m.n).toBe(3);
    const bars = m.bars as Float32Array;
    // the old samples still in the 512-sample overlap read lower, then the bar decays
    expect(bars[2 * SPM_COLS + col]).toBe(Math.max(0, level - 3 * 341));
    // the band peak holds (75 frames)
    expect((m.pk as Float32Array)[col >> 2]).toBe(level);
  });

  it('stops analysing when the editor is closed (no polls) and restarts on the next poll', () => {
    const fx = dsp({ mode: 0 });
    render(fx, sine(1000, 1.5, 0.5));
    fx.monitor!(); // first poll after > 1 s: only frames from the first second
    render(fx, sine(1000, 2.0, 0.5)); // > 1 s without polls
    const m = fx.monitor!()!;
    expect(m.n as number).toBeLessThanOrEqual(16);
    render(fx, sine(1000, 1.2, 0.5)); // not polled for 1.2 s: analysis stops after 1 s
    const m2 = fx.monitor!()!;
    expect(m2.n as number).toBeLessThanOrEqual(Math.ceil(SR / 1536) + 1);
  });

  it('stays finite with NaN / infinite input', () => {
    const fx = dsp({ mode: 0 });
    const b = sine(1000, 0.2, 0.5);
    b[100] = NaN; b[200] = Infinity;
    render(fx, b);
    const m = fx.monitor!()!;
    for (const v of m.bars as Float32Array) expect(Number.isFinite(v)).toBe(true);
  });
});
