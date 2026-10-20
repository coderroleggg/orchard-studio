import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import { CLOCK_SCHEMES, clockTime } from '../../src/model/fx/plugins/bigclock';
import { render, sine } from './util';

const P = { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4 };

describe('Big Clock', () => {
  it('is registered without parameters, B:S:T on and the Default scheme (FL built-in state)', () => {
    const d = fxDef('bigclock')!;
    expect([d.width, d.height, d.category, d.params.length]).toEqual([200, 146, 'Visual', 0]);
    expect(defaultFxParams('bigclock')).toEqual({ steps: true, scheme: 0 });
    expect(normalizeFxParams('bigclock', { scheme: 9 })).toEqual({ steps: true, scheme: 6 });
    expect(CLOCK_SCHEMES.map((s) => s.name)).toEqual(['Default', 'Orange', 'Blue', 'Black', 'Green', 'Red', 'Yellow']);
    expect(CLOCK_SCHEMES[0]).toEqual({ name: 'Default', digits: '#dbedee', bg: '#536566' });
  });

  it('passes audio through untouched', () => {
    const fx = createEffect('bigclock', 48000, 128);
    const x = sine(440, 0.05);
    const [L] = render(fx, x);
    expect(L).toEqual(x);
  });

  it('shows 1:01:00 and 0:00:00 at the song start', () => {
    expect(clockTime(0, P, true)).toEqual({ a: 1, b: 1, c: 0, min: 0, sec: 0, cs: 0 });
  });

  it('counts bars, steps or beats and ticks, and the clock time at the project tempo', () => {
    const tick = 384 + 2 * 24 + 5; // bar 2, step 3, tick 5
    expect(clockTime(tick, P, true)).toMatchObject({ a: 2, b: 3, c: 5 });
    expect(clockTime(tick, P, false)).toMatchObject({ a: 2, b: 1, c: 53 });
    // 120 BPM: one bar = 2 s; 437 ticks = 2.276 s
    expect(clockTime(tick, P, true)).toMatchObject({ min: 0, sec: 2, cs: 27 });
    expect(clockTime(96 * 2 * 61, P, true)).toMatchObject({ min: 1, sec: 1, cs: 0 });
  });
});
