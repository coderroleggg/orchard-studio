// BassDrum (FL: BassDrum): registration (FL's form, parameter list, value texts,
// presets) and the sound, pinned to FL 2026's renders (test host, 44.1 kHz, raw
// channel). With FL's own waveform imported the engine matches FL to -100 dB and
// better (docs/research/gen/bassdrum.md); these tests run the built-in
// substitute waveform (32 harmonics), so the pins allow 5e-4.
import { describe, it, expect } from 'vitest';
import { genDef, genPresetState, defaultGenParams, formatParam, genInCategory } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';
import type { GenInstance, GenNote } from '../../src/engine/gen/types';
import { BD_WAVE } from '../../src/engine/gen/plugins/bassdrum';
import { createGenChannel } from '../../src/model/defaults';
import { makeEngine, play, rms, peak, SR } from './util';

const D = genDef('bassdrum')!;
const FL_SR = 44100;

let ids = 0;
function note(key = 60, vel = 100, chanPitch = 0, pan = 0): GenNote {
  const init = newLevels(), levels = newLevels();
  setInitLevels(init, (key - 60) * 100, vel, 0, 0, 0);
  Object.assign(levels, init);
  levels.vol = 1; // velocity 'plugin': FL leaves the velocity out of the voice volume
  levels.pitch += chanPitch;
  levels.pan = pan;
  return { id: ++ids, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/** Play notes [frame, note] through the plugin in 128-frame blocks; returns the left channel. */
function render(params: Record<string, unknown>, notes: [number, GenNote][], frames: number, sr = FL_SR, inst?: GenInstance): Float32Array {
  const g = inst ?? createGen('bassdrum', sr, 128, { sample: () => undefined })!;
  g.setParams({ ...defaultGenParams('bassdrum'), ...params });
  const out = new Float32Array(frames);
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let b = 0; b < frames; b += 128) {
    const n = Math.min(128, frames - b);
    for (const [f, nt] of notes) if (f >= b && f < b + n) g.noteOn!(nt, f - b);
    L.fill(0); R.fill(0);
    g.render!(L, R, n, { sampleRate: sr, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 });
    out.set(L.subarray(0, n), b);
  }
  return out;
}

const at = (x: Float32Array, idx: number[]) => idx.map((i) => x[i]);
const IDX = [1, 2, 50, 500, 2000, 2206, 2300, 5000];

function expectFl(x: Float32Array, fl: number[], idx = IDX): void {
  at(x, idx).forEach((v, j) => expect(v).toBeCloseTo(fl[j], 3));
}

describe('BassDrum: registration', () => {
  it('has FL\'s parameters, ranges, defaults, form size and note handling', () => {
    expect(D.name).toBe('BassDrum');
    expect(genInCategory('Drum').map((d) => d.id)).toContain('bassdrum');
    expect([D.width, D.height]).toEqual([389, 420]);
    expect(D.notes).toBe('events');
    expect(D.velocity).toBe('plugin');
    expect(D.params.map((q) => q.name)).toEqual(['Output level', 'Sampling ratio', 'Duration', 'Sub bass', 'Drive', 'Attack', 'Base', 'Peak',
      'Slide time', 'Variation base', 'Variation peak', 'Variation slide', 'Variation phase', 'Click cut', 'Click frequency', 'Click amount',
      'Noise A', 'Noise D', 'Noise S', 'Noise start', 'Noise pitch', 'Noise mix', 'Noise filter']);
    expect(D.params.map((q) => q.index)).toEqual(D.params.map((_, i) => i));
    expect(D.params.every((q) => q.min === 0 && q.max === 256)).toBe(true);
    // FL's engine defaults (a fresh FL instance plays Base 0.1, Peak / Slide 0.4)
    expect(D.params.map((q) => q.def)).toEqual([128, 128, 128, 0, 0, 0, 25.6, 102.4, 102.4, 128, 128, 128, 0, 128, 128, 0, 0, 256, 256, 128, 128, 0, 256]);
  });

  it('writes FL\'s value texts (test host sweep)', () => {
    const t = (k: string, v: number) => formatParam(D.params.find((q) => q.key === k)!, v);
    expect([t('level', 0), t('level', 4), t('level', 255), t('level', 128)]).toEqual(['-20.00dB', '-19.38dB', '19.84dB', '0.00dB']);
    expect([t('ratio', 0), t('ratio', 129), t('ratio', 255)]).toEqual(['0.25', '1.01', '3.96']);
    expect([t('duration', 16), t('duration', 255)]).toEqual(['6.3%', '99.6%']);
    expect([t('base', 0), t('base', 129), t('base', 255), t('base', 25)]).toEqual(['16.00Hz', '64.70Hz', '253.24Hz', '20.98Hz']);
    expect([t('varBase', 24), t('varBase', 129), t('noiseStart', 0)]).toEqual(['-81.3%', '0.8%', '-100.0%']);
    expect([t('noisePitch', 4), t('noisePitch', 129), t('noisePitch', 256)]).toEqual(['-23.3', '0.2', '24.0']);
  });

  it('has FL\'s 52 factory presets with the engine\'s exact values', () => {
    expect(D.presets!.length).toBe(52);
    expect(D.presets![0].name).toBe('Bassdrum 01');
    const p = genPresetState('bassdrum', D.presets![0]) as Record<string, unknown>;
    expect(p).toMatchObject({ level: 131.52008, ratio: 140.16006, clickAmt: 256, noiseName: 'Hard Clap', noiseSample: '' });
    // FL's .fst holds the float 0x3f038524 (its knob shows 131)
    expect(Math.fround((p.level as number) / 256)).toBe(0.5137503147125244);
  });
});

describe('BassDrum: sound (FL\'s renders)', () => {
  it('plays FL\'s default kick, independent of the key', () => {
    const fl = [0.398981, 0.323675, -0.0681482, -0.0256907, -0.0425989, 0.109701, 0.0770374, -0.0246736];
    expectFl(render({}, [[0, note(60)]], 6000), fl);
    expectFl(render({}, [[0, note(72)]], 6000), fl);
    expect(render({}, [[0, note()]], 4)[0]).toBe(0); // the attack starts at 0
  });

  it('scales by MIDI velocity / 127 (FL 128 -> 127)', () => {
    expectFl(render({}, [[0, note(60, 64)]], 6000), [0.255348, 0.207152, -0.0436148, -0.0164421, -0.0272633, 0.0702088, 0.0493039, -0.0157911]);
    const v128 = render({}, [[0, note(60, 128)]], 8), v100 = render({}, [[0, note(60, 100)]], 8);
    expect(v128[1] / v100[1]).toBeCloseTo(127 / 100, 5);
  });

  it('is monophonic: a new note retriggers the voice, keeping its filter and resampler states', () => {
    expectFl(render({}, [[0, note(60)], [2205, note(72)]], 6000), [0.398981, 0.323675, -0.0681482, -0.0256907, -0.0425989, -0.0549743, -0.227532, -0.0498568]);
  });

  it('transposes by resampling: Sampling ratio and the channel pitch (not the key)', () => {
    expectFl(render({ ratio: 0 }, [[0, note()]], 6000), [0.0997451, 0.181015, 0.0767196, -0.0204564, 0.0343354, 0.0624054, 0.0581887, -0.0342538]);
    expectFl(render({}, [[0, note(60, 100, 1200)]], 6000), [0.397577, 0.32053, -0.28849, 0.213411, -0.0600166, 0.0887107, 0.0655011, -5.93133e-05]);
  });

  it('applies FL\'s pan law and the voice volume', () => {
    const c = render({}, [[0, note(60, 100, 0, 0)]], 8), r = render({}, [[0, note(60, 100, 0, 1)]], 8);
    expect(c[1]).toBeCloseTo(0.398981, 4);
    expect(Math.abs(r[1])).toBeLessThan(1e-6);
  });

  it('has no release, ends by itself after 1024 silent samples, and stays finite at extremes', () => {
    const g = createGen('bassdrum', FL_SR, 128, { sample: () => undefined })!;
    const x = render({ duration: 0 }, [[0, note()]], 20000, FL_SR, g);
    expect(peak(x, 6000)).toBeLessThan(1e-4);
    expect(g.isActive!()).toBe(false);
    const all256 = Object.fromEntries(D.params.map((q) => [q.key, 256]));
    const all0 = Object.fromEntries(D.params.map((q) => [q.key, 0]));
    for (const p of [all256, all0]) {
      const y = render(p, [[0, note(0, 128)], [300, note(131, 1)]], 20000);
      for (let i = 0; i < y.length; i++) expect(Number.isFinite(y[i])).toBe(true);
    }
  });

  it('builds the substitute waveform from FL\'s measured harmonics', () => {
    expect(BD_WAVE.length).toBe(1025);
    let mn = 1, mx = -1;
    for (let i = 0; i < 1024; i++) { mn = Math.min(mn, BD_WAVE[i]); mx = Math.max(mx, BD_WAVE[i]); }
    expect(mn).toBeCloseTo(-1, 2);
    expect(mx).toBeCloseTo(0.699, 2);
  });

  it('plays through a channel (events plugin) at the channel volume', () => {
    const e = makeEngine();
    const ch = createGenChannel('bassdrum');
    ch.volume = 1;
    const [L] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 4 }] }, SR / 2);
    expect(rms(L, 0, 4000)).toBeGreaterThan(0.01);
  });
});
