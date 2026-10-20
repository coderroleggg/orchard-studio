import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import {
  tunerCentText, tunerHzText, tunerNote, tunerRefHz, tunerRefText, tunerReactText,
} from '../../src/model/fx/plugins/tuner';
import { render, sine } from './util';

function tone(f: number, s: number, sr: number, kind: 'sine' | 'saw' | 'square' = 'sine', amp = 0.5): Float32Array {
  const n = Math.round(s * sr), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = (f * i / sr) % 1;
    b[i] = amp * (kind === 'sine' ? Math.sin(2 * Math.PI * ph) : kind === 'saw' ? 2 * ph - 1 : ph < 0.5 ? 1 : -1);
  }
  return b;
}

/** Feed a tone and return the tracked frequency (0 when nothing is detected). */
function detect(input: Float32Array, p: Record<string, unknown> = {}, sr = 48000): number {
  const fx = createEffect('tuner', sr, 128);
  fx.setParams({ ...defaultFxParams('tuner'), ...p });
  render(fx, input, input, 128, { sampleRate: sr });
  const m = fx.monitor!();
  return m && m.on ? (m.hz as number) : 0;
}

describe('Tuner', () => {
  it('is registered with FL parameters, value texts and presets', () => {
    const d = fxDef('tuner')!;
    expect([d.width, d.height, d.category]).toEqual([300, 360, 'Visual']);
    expect(d.params.map((q) => [q.name, q.index, q.min, q.max, q.def])).toEqual([
      ['Reference', 0, 0, 6000, 3000], ['Reactivity', 1, 0, 6000, 3000], ['Bass mode', 2, 0, 1, 0],
    ]);
    expect(defaultFxParams('tuner')).toEqual({ ref: 3000, react: 3000, bass: 0, display: 2 });
    // texts read from FL (flfxhost sweep)
    expect([0, 2996, 2997, 3000, 3004, 6000].map(tunerRefText)).toEqual(['400.0 Hz', '439.9 Hz', '440.0 Hz', '440.0 Hz', '440.1 Hz', '480.0 Hz']);
    expect([0, 9, 27, 51, 3000, 6000].map(tunerReactText)).toEqual(['0.0 %', '0.2 %', '0.4 %', '0.9 %', '50.0 %', '100.0 %']);
    expect(d.params[2].options).toEqual(['Off', 'On']);
    expect(d.presets!.map((p) => p.name)).toContain('Horizontal/Bass');
    expect(d.presets!.find((p) => p.name === 'Circular/Default')!.params).toEqual({ ref: 3000, react: 1, bass: 0, display: 2 });
  });

  it('names notes like FL (key 60 = C5) and formats like FL', () => {
    expect(tunerNote(65.41)!).toMatchObject({ name: 'C', octave: 3, cents: 0 }); // FL's manual screenshot: "C3", 65.4 Hz
    expect(tunerNote(440)!).toMatchObject({ name: 'A', octave: 5, cents: 0 }); // A4 in scientific notation
    expect(tunerNote(466.16)!).toMatchObject({ name: 'A#', octave: 5 });
    expect(tunerHzText(65.4)).toBe('65.4 Hz');
    expect(tunerHzText(0)).toBe('0 Hz');
    expect(tunerCentText(1)).toBe('+1 cent');
    expect(tunerCentText(0)).toBe('+0 cent');
    expect(tunerCentText(-12.4)).toBe('-12 cent');
  });

  it('passes audio through untouched', () => {
    const fx = createEffect('tuner', 48000, 128);
    const inL = sine(440, 0.2, 0.6), inR = sine(330, 0.2, 0.2);
    const [L, R] = render(fx, inL, inR);
    expect(L).toEqual(inL);
    expect(R).toEqual(inR);
  });

  it('reads a 440 Hz sine as A (FL "A5", scientific A4) within 0.5 cent at 44.1 and 48 kHz', () => {
    for (const sr of [44100, 48000]) {
      const hz = detect(tone(440, 0.5, sr), {}, sr);
      const n = tunerNote(hz, 440)!;
      expect(`${n.name}${n.octave}`).toBe('A5');
      expect(Math.abs(n.exact)).toBeLessThan(0.5);
    }
  });

  it('finds the fundamental of harmonic-rich tones and low notes', () => {
    const cases: [number, 'sine' | 'saw' | 'square'][] = [[65.41, 'sine'], [82.41, 'saw'], [110, 'saw'], [1000, 'square'], [1318.5, 'square']];
    for (const [f, kind] of cases) {
      const hz = detect(tone(f, 0.5, 48000, kind));
      expect(Math.abs(1200 * Math.log2(hz / f))).toBeLessThan(1);
    }
  });

  it('follows the Reference control (A = 432 Hz reads +0 cent)', () => {
    const v = Math.round((432 - 400) * 6000 / 80);
    expect(tunerRefHz(v)).toBeCloseTo(432, 6);
    const hz = detect(tone(432, 0.5, 48000), { ref: v });
    const n = tunerNote(hz, tunerRefHz(v))!;
    expect(n.name).toBe('A');
    expect(n.cents).toBe(0);
  });

  it('detects nothing in silence or noise-free DC, and rejects pitches above the range', () => {
    expect(detect(new Float32Array(24000))).toBe(0);
    expect(detect(new Float32Array(24000).fill(0.3))).toBe(0);
    // default reactivity reaches about 3.3 kHz: a 6 kHz tone is not reported as a sub-harmonic
    expect(detect(tone(6000, 0.5, 48000))).toBe(0);
    // fast reactivity reaches C10 (8372 Hz, FL names)
    const hz = detect(tone(6000, 0.5, 48000), { react: 6000 });
    expect(Math.abs(1200 * Math.log2(hz / 6000))).toBeLessThan(1);
  });

  it('reaches lower in Bass mode (window ~100 ms)', () => {
    const hz = detect(tone(25, 0.8, 48000, 'saw'), { bass: 1 });
    expect(Math.abs(1200 * Math.log2(hz / 25))).toBeLessThan(2);
  });

  it('stays finite with NaN input', () => {
    const b = tone(220, 0.4, 48000);
    b[500] = NaN; b[700] = Infinity;
    const hz = detect(b);
    expect(Number.isFinite(hz)).toBe(true);
  });
});
