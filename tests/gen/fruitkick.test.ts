// Fruit Kick (FL: Fruit Kick): registration (FL's form / parameter list /
// value texts / presets) and the sound, pinned to FL 2026's own renders (test
// host, 44.1 kHz, raw channel: FL's output / 0.70710677 pan law = the voice).
import { describe, it, expect } from 'vitest';
import { genDef, genPresetState, defaultGenParams, formatParam, genInCategory, normalizeGenParams } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';
import type { GenVoiceParams } from '../../src/engine/gen/types';
import { RELEASE_LEN } from '../../src/engine/gen/plugins/fruitkick';
import { createGenChannel } from '../../src/model/defaults';
import { makeEngine, play, rms, peak, SR } from './util';

const D = genDef('fruitkick')!;
const FL_SR = 44100;

function voiceParams(key = 60): GenVoiceParams {
  const init = newLevels(), levels = newLevels();
  setInitLevels(init, (key - 60) * 100, 100, 0, 0, 0);
  Object.assign(levels, init);
  return { key, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/** Render one Fruit Kick voice directly (16-sample steps in 128-frame blocks, as a channel does). */
function kick(params: Record<string, number>, frames: number, key = 60, releaseAt = -1, sr = FL_SR): { L: Float32Array; ended: number } {
  const k = createGen('fruitkick', sr, 128)!;
  k.setParams({ ...defaultGenParams('fruitkick'), ...params });
  const p = voiceParams(key);
  const v = k.triggerVoice!(p)!;
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const bl = new Float32Array(16), br = new Float32Array(16);
  let ended = -1;
  for (let o = 0; o < frames; o += 16) {
    if (releaseAt >= 0 && o === releaseAt) v.release();
    bl.fill(0); br.fill(0);
    p.frame = o % 128;
    const alive = v.render(bl, br, 16);
    L.set(bl.subarray(0, Math.min(16, frames - o)), o);
    R.set(br.subarray(0, Math.min(16, frames - o)), o);
    if (!alive) { ended = o + 16; break; }
  }
  return { L, ended };
}

/** Frequency from zero crossings between two times (s). */
function freq(b: Float32Array, t0: number, t1: number, sr = FL_SR): number {
  const a = Math.round(t0 * sr), z = Math.round(t1 * sr);
  let first = -1, lastX = -1, n = 0;
  for (let i = a + 1; i < z; i++) {
    if (b[i - 1] < 0 && b[i] >= 0) {
      const x = i - 1 + b[i - 1] / (b[i - 1] - b[i]);
      if (first < 0) first = x; else n++;
      lastX = x;
    }
  }
  return n > 0 ? (n * sr) / (lastX - first) : 0;
}

function expectSamples(L: Float32Array, at: number[], fl: number[]): void {
  at.forEach((i, j) => expect(L[i]).toBeCloseTo(fl[j], 5));
}

describe('Fruit Kick: registration', () => {
  it('has FL\'s parameters, ranges, defaults and form size', () => {
    expect(D.name).toBe('Fruit Kick');
    expect(D.category).toBe('Drum');
    expect(genInCategory('Drum').map((d) => d.id)).toContain('fruitkick');
    expect(D.notes).toBe('voices');
    expect(D.ins).toBe(true);
    expect([D.width, D.height]).toEqual([380, 80]);
    expect(D.params.map((q) => [q.index, q.key, q.name, q.min, q.max, q.def])).toEqual([
      [0, 'max', 'Max freq', -2400, 3600, 0],
      [1, 'min', 'Min freq', -1200, 1200, -600],
      [2, 'freqDecay', 'Freq decay', 0, 256, 64],
      [3, 'ampDecay', 'Amp decay', 0, 256, 128],
      [4, 'click', 'Click', 0, 64, 32],
      [5, 'dist', 'Distortion', 0, 128, 0],
    ]);
  });

  it('writes FL\'s value texts (test host sweep: v x 100 / max, half away from zero)', () => {
    expect(D.params.map((q) => formatParam(q, q.def))).toEqual(['0%', '-50%', '25%', '50%', '50%', '0%']);
    const [max, min] = D.params;
    expect(formatParam(max, 3600)).toBe('100%');
    expect(formatParam(max, -2400)).toBe('-67%');
    expect(formatParam(max, -18)).toBe('-1%');
    expect(formatParam(max, -17)).toBe('0%');
    expect(formatParam(max, 522)).toBe('15%');
    expect(formatParam(min, -690)).toBe('-58%');
    expect(max.parse!(50)).toBe(1800);
  });

  it('has FL\'s eight factory presets; the obsolete `seed` key is dropped', () => {
    expect(D.presets!.map((p) => p.name)).toEqual(['Classic', 'Clicky', 'Default', 'High', 'Low', 'Punchy', 'Pure click', 'SciFi']);
    const def = defaultGenParams('fruitkick');
    expect(genPresetState('fruitkick', D.presets![2], def)).toEqual({ ...def, __preset: 'Default' });
    expect(genPresetState('fruitkick', D.presets![7], def)).toMatchObject({ max: 3600, min: -1200, freqDecay: 158, ampDecay: 256, click: 0, dist: 0 });
    expect(normalizeGenParams('fruitkick', { ...def, seed: 4504291 })).toEqual(def);
  });
});

describe('Fruit Kick: sound (FL\'s renders)', () => {
  it('plays FL\'s default kick sample for sample', () => {
    const { L } = kick({}, 22050);
    expectSamples(L, [0, 1, 2, 3, 100, 1000, 5000, 20000], [1.06066, 1.20597, 1.32459, 1.41389, 1.45471, 1.10814, -0.0167463, -0.0470501]);
  });

  it('starts an octave above the key\'s pitch at half key tracking and ends at Min freq - 3600 cents for every key', () => {
    const fast = { freqDecay: 0, ampDecay: 256, click: 0 };
    // end: 523.25 Hz x 2^(-4200/1200) = 46.25 Hz at any key
    for (const key of [30, 60, 90]) expect(freq(kick(fast, FL_SR / 2, key).L, 0.05, 0.45)).toBeCloseTo(46.25, 1);
    const slow = { freqDecay: 256, ampDecay: 256, click: 0 };
    // 1046.5 Hz at the start (the sweep has fallen ~3 % after 4 ms); 24 keys up = one octave up
    const f60 = freq(kick(slow, 4410, 60).L, 0, 0.004), f84 = freq(kick(slow, 4410, 84).L, 0, 0.004);
    expect(f60).toBeGreaterThan(1046.5 * 0.95);
    expect(f60).toBeLessThan(1046.5);
    expect(f84 / f60).toBeCloseTo(2, 1);
    expectSamples(kick({}, 6000, 72).L, [0, 100, 1000, 5000], [1.06066, 1.27832, -0.437067, -0.588671]);
    expectSamples(kick({}, 6000, 30).L, [100, 1000, 5000], [0.270418, 0.639767, -0.45012]);
  });

  it('Click is the start phase (Click << 24 of a 32-bit cycle): full click starts at the top', () => {
    expect(kick({ click: 0 }, 16).L[0]).toBe(0);
    expectSamples(kick({ click: 64 }, 2000).L, [0, 1, 1000], [1.5, 1.48317, 0.356207]);
    const pure = genPresetState('fruitkick', D.presets!.find((p) => p.name === 'Pure click')!) as Record<string, number>;
    const p = kick(pure, 4096);
    expect(p.L[0]).toBe(1.5);
    expect(p.ended).toBeGreaterThan(0);
  });

  it('Distortion goes through FL\'s DistWave table (dry 1 - d, wet 3.3 d, mul 0.1)', () => {
    expectSamples(kick({ dist: 128 }, 6000).L, [0, 1, 2, 100, 1000, 5000], [1.03759, 1.05099, 1.06086, 1.07093, 1.04213, -0.0274933]);
    const punchy = genPresetState('fruitkick', D.presets!.find((p) => p.name === 'Punchy')!) as Record<string, number>;
    expectSamples(kick(punchy, 4000).L, [0, 10, 500, 3000], [1.43348, -0.798383, 0.673595, -0.291441]);
  });

  it('a note off fades the voice out over 441 samples (raised cosine), at any sample rate', () => {
    const p = { ampDecay: 256, freqDecay: 0, click: 0 };
    const r = kick(p, 6000, 60, 4416);
    const ref = kick(p, 6000);
    expect(r.L[4415]).toBe(ref.L[4415]);
    expect(r.L[4416] / ref.L[4416]).toBeCloseTo(0.5 + 0.5 * Math.cos(Math.PI / (RELEASE_LEN + 1)), 6);
    expect(r.L[4416 + 220] / ref.L[4416 + 220]).toBeCloseTo(0.5 + 0.5 * Math.cos((Math.PI * 221) / 442), 6);
    expect(peak(r.L, 4416 + RELEASE_LEN)).toBe(0);
    expect(r.ended).toBeGreaterThan(0);
    const r48 = kick(p, 9600, 60, 4800, 48000);
    expect(peak(r48.L, 4800 + RELEASE_LEN)).toBe(0);
    expect(Math.abs(r48.L[4800 + RELEASE_LEN - 2])).toBeGreaterThan(0);
  });

  it('ends once the amplitude is below 0.0002 (at the end of that engine block)', () => {
    const k = kick({ ampDecay: 0, freqDecay: 0 }, 4000);
    // 1.5 x 0.995^n < 0.0002 from n = 1782: the block ends at 1792
    expect(k.ended).toBe(1792);
  });

  it('plays through the channel with FL\'s pan law and fades after the note', () => {
    const e = makeEngine();
    const ch = createGenChannel('fruitkick');
    ch.volume = 1;
    const [L] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 4 }] }, SR / 2);
    // 4 ticks = 1000 samples at 48 kHz: the release fade (441 samples) follows
    expect(rms(L, 200, 900)).toBeGreaterThan(0.1);
    expect(peak(L, 1000 + RELEASE_LEN + 16)).toBe(0);
    expect(peak(L, 0, 200)).toBeLessThanOrEqual(1.5 * Math.SQRT1_2 + 1e-6);
  });

  it('stays finite at extreme settings and keys, and with parameter changes mid-voice', () => {
    for (const p of [
      { max: 3600, min: 1200, freqDecay: 256, ampDecay: 256, click: 64, dist: 128 },
      { max: -2400, min: -1200, freqDecay: 0, ampDecay: 0, click: 0, dist: 128 },
      { max: 3600, min: -1200, freqDecay: 1, ampDecay: 1, click: 64, dist: 0 },
    ]) {
      for (const key of [0, 131]) {
        const { L } = kick(p, 8000, key);
        for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i])).toBe(true);
      }
    }
    const k = createGen('fruitkick', SR, 128)!;
    k.setParams(defaultGenParams('fruitkick'));
    const v = k.triggerVoice!(voiceParams())!;
    const b = new Float32Array(16), r = new Float32Array(16);
    v.render(b, r, 16);
    k.setParams({ ...defaultGenParams('fruitkick'), min: 1200, dist: 128, max: Number.NaN });
    b.fill(0);
    v.render(b, r, 16);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(b[i])).toBe(true);
  });
});
