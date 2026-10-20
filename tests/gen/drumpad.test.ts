// Drumpad (FL: Drumpad): registration (FL's 38 parameters, value texts, 961
// presets) and the sound, pinned to FL 2026's renders (test host, 44.1 kHz,
// raw channel). The engine renders FL's output bit for bit
// (docs/research/gen/drumpad.md).
import { describe, it, expect } from 'vitest';
import { genDef, genPresetState, defaultGenParams, formatParam, genInCategory } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';
import { DP_KEYS, dpText } from '../../src/model/gen/plugins/drumpad';
import { DP_ENGINE_DEFAULTS } from '../../src/engine/gen/plugins/drumpad';
import { createGenChannel } from '../../src/model/defaults';
import { makeEngine, play, rms } from './util';

const D = genDef('drumpad')!;
const SR = 44100;

let ids = 0;
function note(key: number, vel = 100, chanPitch = 0, pan = 0): GenNote {
  const init = newLevels(), levels = newLevels();
  setInitLevels(init, (key - 60) * 100, vel, 0, 0, 0);
  Object.assign(levels, init);
  levels.pitch += chanPitch;
  levels.pan = pan;
  levels.vol = 1;
  return { id: ++ids, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

type Ev = { at: number; n: GenNote; off?: number };

/** Render notes like FL's test host: blocks of 512 frames, restarted at every note event. */
function render(params: Record<string, unknown>, evs: Ev[], frames: number): [Float32Array, Float32Array] {
  const g = createGen('drumpad', SR, 512, { sample: () => undefined })!;
  g.setParams(params);
  const outL = new Float32Array(frames), outR = new Float32Array(frames);
  const L = new Float32Array(512), R = new Float32Array(512);
  const times = [...new Set(evs.flatMap((e) => (e.off !== undefined ? [e.at, e.off] : [e.at])))].sort((a, b) => a - b);
  for (let b = 0; b < frames;) {
    let n = Math.min(512, frames - b);
    for (const t of times) if (t > b && t < b + n) { n = t - b; break; }
    for (const e of evs) {
      if (e.off === b) g.noteOff!(e.n, 0);
      if (e.at === b) g.noteOn!(e.n, 0);
    }
    L.fill(0); R.fill(0);
    g.render!(L, R, n, { sampleRate: SR, blockSize: 512, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 });
    outL.set(L.subarray(0, n), b); outR.set(R.subarray(0, n), b);
    b += n;
  }
  return [outL, outR];
}

/** The engine's own defaults (what FL's test host plays without a preset). */
const ENGINE = Object.fromEntries(DP_KEYS.map((k, i) => [k, i >= 30 && i <= 33 ? 0 : DP_ENGINE_DEFAULTS[i] * 256]));
const preset = (name: string) => genPresetState('drumpad', D.presets!.find((p) => p.name === name)!) as Record<string, unknown>;
const expectAt = (x: Float32Array, idx: number[], fl: number[]) => idx.forEach((i, j) => expect(x[i]).toBeCloseTo(fl[j], 7));

describe('Drumpad: registration', () => {
  it('has FL\'s 38 parameters, names, ranges and defaults', () => {
    expect(D.name).toBe('Drumpad');
    expect(genInCategory('Drum').map((d) => d.id)).toContain('drumpad');
    expect(D.notes).toBe('events');
    expect([D.width, D.height]).toEqual([794, 225]);
    expect(D.params.length).toBe(38);
    expect(D.params.map((q) => q.key)).toEqual(DP_KEYS);
    expect(D.params[6]).toMatchObject({ name: 'Membrane decay', min: 0, max: 256, def: 128 });
    expect(D.params[30]).toMatchObject({ min: 0, max: 28, def: 0 });
    expect(D.params[37].name).toBe('Velocity mod 4 value');
  });

  it('writes FL\'s value texts (test host sweeps)', () => {
    const t = (i: number, v: number) => formatParam(D.params[i], v);
    expect([t(0, 0), t(0, 1), t(1, 85), t(1, 86), t(1, 176), t(1, 256)]).toEqual(['Off', 'On', '0', 'I', 'II', 'III']);
    expect([t(2, 1), t(2, 8), t(19, 124), t(19, 132), t(19, 0), t(29, 61)]).toEqual(['0.39 %', '3.13 %', '-3.13 %', '3.13 %', '-100.00 %', '-52.34 %']);
    expect([t(30, 0), t(30, 1), t(33, 28), t(6, 230.4)]).toEqual([' ', 'Mallet Amplitude', 'Pitch', '89.84 %']);
    expect(dpText(2, 54.72)).toBe('21.48 %');
  });

  it('has FL\'s 961 factory presets in their folders, with the engine\'s exact values', () => {
    expect(D.presets!.length).toBe(961);
    expect(new Set(D.presets!.map((p) => p.name.split('/')[0]))).toEqual(new Set(['Cymbals', 'Default', 'HiHats', 'Kicks', 'Percussions', 'Snares', 'Sound FX', 'Tom-Toms']));
    const s = preset('Kicks/Bossa Kick 01');
    expect(Math.fround((s.malletAmp as number) / 256)).toBe(0.21375003457069397);
    expect(s.velTarget1).toBe(1);
    expect(s.__dp).toBeUndefined();
    // a fresh instance is FL's plugin database state: the Default Kick preset
    expect(defaultGenParams('drumpad')).toMatchObject(Object.fromEntries(Object.entries(preset('Default/Default Kick')).filter(([k]) => k !== '__preset')));
  });
});

describe('Drumpad: sound (FL\'s renders)', () => {
  it('default note: FL\'s engine defaults (membrane only); a fresh instance plays the Default Kick', () => {
    expectAt(render(defaultGenParams('drumpad'), [{ at: 0, n: note(60), off: 22050 }], 22001)[0], [300, 600, 1000, 2000, 4000, 8000, 15000, 22000],
      [0, -0.0009424975, 0.03371422, 0.2637142, -0.1443584, -0.04714577, 0.0001667386, 0]);
    const [L, R] = render(ENGINE, [{ at: 0, n: note(60), off: 22050 }], 23001);
    expectAt(L, [0, 100, 563, 1000, 3000, 8000, 20000, 23000], [0, 0, -0.3571464, 0.04422872, 0.01280868, 0.00292466, 0.0004302684, -0.0006989192]);
    expect(R[563]).toBeCloseTo(-0.3571464, 7);
  });

  it('a preset with noise, MID, HIGH, pitch and a velocity modulation; velocity 64', () => {
    const idx = [1000, 1500, 2000, 3000, 5000, 8000, 20000, 23000];
    expectAt(render(preset('Kicks/Bossa Kick 01'), [{ at: 0, n: note(60), off: 22050 }], 23001)[0], idx,
      [-0.1254953, 0.09471533, 0.08261642, 0.06699628, 0.08711459, 0.03580599, -0.0006535574, -0.0002916016]);
    expectAt(render(preset('Kicks/Bossa Kick 01'), [{ at: 0, n: note(60, 64), off: 22050 }], 23001)[0], idx,
      [-0.0592843, 0.0447464, 0.03903162, 0.03165079, 0.04115657, 0.01691542, -0.0003090673, -0.0001380113]);
  });

  it('hold and decay; one voice: notes retrigger it, a first note fades out after its note off', () => {
    expectAt(render(preset('Cymbals/Ethnic Cymbal 06'), [{ at: 0, n: note(60), off: 22050 }], 30001)[0], [200, 400, 1000, 3000, 8000, 20000],
      [-0.05881718, 0.182397, -0.00796097, -0.0004297586, 0, 0]);
    const evs = [{ at: 0, n: note(60), off: 13230 }, { at: 13230, n: note(62), off: 26460 }, { at: 26460, n: note(64), off: 39690 }];
    expectAt(render(preset('Cymbals/Ethnic Cymbal 03'), evs, 40001)[0], [13300, 13500, 15000, 26500, 26600, 27103, 30000, 40000],
      [-0.1108102, 0.08085483, 0.0005399645, 0, -0.1821895, 0.02038059, 3.792765e-07, 0]);
  });

  it('follows the channel pitch (not the key) and pan (FL\'s pan law)', () => {
    const [L, R] = render(preset('Cymbals/Acoustic Ride 05'), [{ at: 0, n: note(60, 100, 700, -0.5), off: 22050 }], 30001);
    expectAt(L, [100, 563, 1000, 3000, 8000, 20000, 23000], [-0.0006084925, -0.006161595, 0.0005159787, 0.002664456, -0.0006065357, 0.0001047606, -1.46511e-05]);
    expect(R[563]).toBeCloseTo(-0.002552216, 7);
    const a = render(ENGINE, [{ at: 0, n: note(48), off: 22050 }], 5000)[0];
    const b = render(ENGINE, [{ at: 0, n: note(72), off: 22050 }], 5000)[0];
    expect(a).toEqual(b);
  });

  it('plays every parameter extreme finite and works in a channel', () => {
    const lo: Record<string, unknown> = {}, hi: Record<string, unknown> = {};
    D.params.forEach((q) => { lo[q.key] = q.min; hi[q.key] = q.max; });
    for (const p of [lo, hi]) {
      const [L] = render(p, [{ at: 0, n: note(60, 128), off: 4410 }, { at: 2000, n: note(61, 1) }], 20000);
      for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i])).toBe(true);
    }
    const e = makeEngine();
    const ch = createGenChannel('drumpad');
    ch.volume = 1;
    const [CL] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 4, key: 60 }] }, 12000);
    expect(rms(CL, 0, 6000)).toBeGreaterThan(0.01);
  });
});
