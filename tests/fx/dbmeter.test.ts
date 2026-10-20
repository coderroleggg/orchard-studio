import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import {
  DBM_ORANGE_Y, DBM_PX_PER_DB, DBM_ZERO_FROM_BOTTOM, dbmHoverText, dbmLevelPx,
} from '../../src/model/fx/plugins/dbmeter';
import { render, sine } from './util';

describe('dB Meter', () => {
  it('is registered as a parameterless Visual plugin at FL size', () => {
    const d = fxDef('dbmeter')!;
    expect(d.name).toBe('dB Meter');
    expect(d.category).toBe('Visual');
    expect([d.width, d.height]).toEqual([100, 270]);
    expect(defaultFxParams('dbmeter')).toEqual({});
  });

  it('passes audio through bit-exactly', () => {
    const fx = createEffect('dbmeter', 48000, 128);
    fx.setParams(defaultFxParams('dbmeter'));
    const inL = sine(440, 0.05, 0.7), inR = sine(660, 0.05, 0.3);
    const [L, R] = render(fx, inL, inR);
    expect(L).toEqual(inL);
    expect(R).toEqual(inR);
  });

  it('reports per-channel sample peaks and resets them when read', () => {
    const fx = createEffect('dbmeter', 48000, 128);
    render(fx, sine(1000, 0.1, 0.5), sine(1000, 0.1, 0.25));
    const m = fx.monitor!()!;
    expect(m.l as number).toBeCloseTo(0.5, 3);
    expect(m.r as number).toBeCloseTo(0.25, 3);
    // -6.02 dB and -12.04 dB on FL's scale
    expect(20 * Math.log10(m.l as number)).toBeCloseTo(-6.02, 1);
    expect(fx.monitor!()).toBeNull(); // nothing processed since
    render(fx, new Float32Array(256));
    expect(fx.monitor!()).toEqual({ l: 0, r: 0 }); // silence is sent once
    render(fx, new Float32Array(256));
    expect(fx.monitor!()).toBeNull();
  });

  it('maps dB to FL meter pixels (6.05 px/dB, 0 dB at y = 44, orange from -6 dB)', () => {
    expect(DBM_PX_PER_DB).toBeCloseTo(254 / 42, 6);
    expect(270 - DBM_ZERO_FROM_BOTTOM).toBe(44);
    expect(DBM_ORANGE_Y).toBe(81);
    expect(dbmLevelPx(1)).toBeCloseTo(226, 6);
    expect(270 - dbmLevelPx(Math.pow(10, -6 / 20))).toBeCloseTo(44 + 6 * DBM_PX_PER_DB, 6);
    expect(dbmLevelPx(0)).toBe(0);
  });

  it('shows the dB value under the mouse like FL ("-6.0dB")', () => {
    expect(dbmHoverText(44)).toBe('0.0dB');
    expect(dbmHoverText(44 + 6 * DBM_PX_PER_DB)).toBe('-6.0dB'); // floor(80.3) = 80 -> -5.95
    expect(dbmHoverText(0)).toBe('7.3dB');
    expect(dbmHoverText(9999)).toBe('-37.2dB');
  });

  it('keeps peaks finite with NaN input', () => {
    const fx = createEffect('dbmeter', 48000, 128);
    const b = new Float32Array(128).fill(NaN);
    b[3] = 0.9;
    render(fx, b);
    const m = fx.monitor!()!;
    expect(m.l).toBeCloseTo(0.9, 5);
  });
});
