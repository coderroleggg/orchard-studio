// DrumSynth Live (FL: Fruity DrumSynth Live): registration (FL's 4560
// parameters, names, value texts, kits) and the sound, pinned to FL 2026's
// renders (test host, 44.1 kHz, raw channel, Default kit). The engine renders
// FL's output bit for bit (docs/research/gen/drumsynth.md); the patches pinned
// here use no waveform samples, so the substitute waves do not enter.
import { describe, it, expect } from 'vitest';
import { genDef, genPresetState, defaultGenParams, formatParam, genInCategory } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';
import { dsKey, dsKitState, DS_PATCHES } from '../../src/model/gen/plugins/drumsynth';
import { createGenChannel } from '../../src/model/defaults';
import { makeEngine, play, rms } from './util';

const D = genDef('drumsynth')!;
const SR = 44100;

let ids = 0;
function note(key: number, vel = 100, chanPitch = 0): GenNote {
  const init = newLevels(), levels = newLevels();
  setInitLevels(init, (key - 60) * 100, vel, 0, 0, 0);
  Object.assign(levels, init);
  levels.pitch += chanPitch;
  return { id: ++ids, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

type Ev = { at: number; n: GenNote; off?: number };

/** Render notes like FL's test host: blocks of 512 frames, restarted at every note event. */
function render(params: Record<string, unknown>, evs: Ev[], frames: number): [Float32Array, Float32Array] {
  const g = createGen('drumsynth', SR, 512, { sample: () => undefined })!;
  g.setParams({ ...defaultGenParams('drumsynth'), ...params });
  const outL = new Float32Array(frames), outR = new Float32Array(frames);
  const L = new Float32Array(512), R = new Float32Array(512);
  const times = [...new Set(evs.flatMap((e) => (e.off !== undefined ? [e.at, e.off] : [e.at])))].sort((a, b) => a - b);
  for (let b = 0; b < frames;) {
    let n = Math.min(512, frames - b);
    for (const t of times) if (t > b && t < b + n) { n = t - b; break; }
    for (const e of evs) {
      if (e.at === b) g.noteOn!(e.n, 0);
      if (e.off === b) g.noteOff!(e.n, 0);
    }
    L.fill(0); R.fill(0);
    g.render!(L, R, n, { sampleRate: SR, blockSize: 512, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 });
    outL.set(L.subarray(0, n), b); outR.set(R.subarray(0, n), b);
    b += n;
  }
  return [outL, outR];
}

const IDX = [0, 1, 10, 100, 1000, 3000, 4500, 6000];
function expectFl(x: Float32Array, fl: number[]): void {
  IDX.forEach((i, j) => expect(x[i]).toBeCloseTo(fl[j], 6));
}

describe('DrumSynth Live: registration', () => {
  it('has FL\'s 4560 parameters in FL\'s order, names and ranges', () => {
    expect(D.name).toBe('DrumSynth Live');
    expect(genInCategory('Drum').map((d) => d.id)).toContain('drumsynth');
    expect(D.notes).toBe('events');
    expect([D.width, D.height]).toEqual([580, 358]);
    expect(D.params.length).toBe(4560);
    expect(D.params.every((q, i) => q.index === i)).toBe(true);
    expect(D.params[0]).toMatchObject({ key: dsKey(48, 0), name: 'C4 - Patch Level', min: 0, max: 128, def: 91 });
    expect(D.params[38].name).toBe('C#4 - Patch Level');
    expect(D.params[24 * 38].name).toBe('C0 - Patch Level');
    expect(D.params[72 * 38 + 36]).toMatchObject({ name: 'C6 - Send track number', min: -125, max: 125, def: 0 });
    expect(D.params[4559].name).toBe('B9 - Morph To Modulation');
  });

  it('writes FL\'s value texts (test host sweeps)', () => {
    const t = (local: number, v: number) => formatParam(D.params[local], v);
    expect([t(0, 116), t(1, -40), t(1, -62), t(1, 0), t(2, -38)]).toEqual(['91%', '62% left', '97% left', 'Centered', '-76%']);
    expect([t(4, 460), t(5, 77), t(6, 127), t(6, 59), t(7, 127), t(12, 83), t(12, 127)]).toEqual(['460', '61%', 'Off', '72.2', '10000.0', '26.2', '500.0']);
    expect([t(8, 0), t(15, -1), t(15, 11), t(16, -38), t(21, 121), t(23, 91), t(24, 2), t(31, 0), t(25, 0), t(36, 0), t(34, 48)])
      .toEqual(['Off', 'NO WAVE', 'Linn Tamb', '-9.12', 'Off', 'Random', 'Group 1', 'Off', '0%', 'None', '48%']);
  });

  it('has FL\'s Default and Extra kits (24 patches repeated over the five 2-octave blocks)', () => {
    expect(D.presets!.map((p) => p.name)).toEqual(['Default', 'Extra']);
    const ex = genPresetState('drumsynth', D.presets![1]) as Record<string, unknown>;
    expect((ex.names as string[])[48]).toBe('Bright Snare');
    expect((ex.names as string[])[0]).toBe('Bright Snare');
    expect(ex[dsKey(48, 0)]).toBe(117);
    expect(ex[dsKey(96, 0)]).toBe(117);
    const def = dsKitState('Default');
    expect((def.names as string[])[55]).toBe('808 Kick');
    expect(defaultGenParams('drumsynth')[dsKey(119, 37)]).toBe(64);
    expect(DS_PATCHES).toBe(120);
  });
});

describe('DrumSynth Live: sound (FL\'s renders, Default kit)', () => {
  it('808 Bongo H (C4): swept tone, panned right', () => {
    const [L, R] = render({}, [{ at: 0, n: note(48), off: 22050 }], 6100);
    expectFl(L, [0.04938307, 0.09810128, 0.3991381, -0.2281418, -0.2333043, 0.02096351, 0.005258081, 0.001262922]);
    expect(R[0]).toBeCloseTo(0.06832197, 7);
  });

  it('808 Clap: noise band with re-triggers (FL\'s noise generator)', () => {
    const [L] = render({}, [{ at: 0, n: note(51), off: 22050 }], 6100);
    expectFl(L, [-0.1145827, -0.04796836, -0.2387879, -0.003554925, -0.1246883, -0.02041942, 0.01346889, 0.01807006]);
  });

  it('velocity reaches the engine (Vel. > ...) and the level (volume squared)', () => {
    expectFl(render({}, [{ at: 0, n: note(55, 64), off: 22050 }], 6100)[0],
      [0.0003036954, 0.0008815877, 0.01430032, 0.002736289, -0.03512393, 0.03515196, 0.03477904, 0.008045061]);
    expectFl(render({}, [{ at: 0, n: note(71, 127), off: 22050 }], 6100)[0],
      [-0.6081963, -0.4893062, -2.914544, 1.602628, -0.6845949, -0.1249006, -0.02142611, -0.009289093]);
  });

  it('Mono patches cut their previous voice (FL\'s ramp), groups cut each other', () => {
    expectFl(render({}, [{ at: 0, n: note(55), off: 22050 }, { at: 4410, n: note(55, 90), off: 26460 }], 6100)[0],
      [0.002292468, 0.006654736, 0.1079471, 0.02065509, -0.2651358, 0.2653474, 0.3360226, -0.2587847]);
    // C4 and C#4 in Group 1
    const [L, R] = render({ [dsKey(48, 24)]: 2, [dsKey(49, 24)]: 2 }, [{ at: 0, n: note(48), off: 22050 }, { at: 2205, n: note(49), off: 24255 }], 6100);
    expectFl(L, [0.04938307, 0.09810128, 0.3991381, -0.2281418, -0.2333043, -0.4202785, -0.2332344, -0.1290429]);
    expect(R[1]).toBeCloseTo(0.1357241, 6);
  });

  it('morphs toward the Morph To patch by the modulation curve', () => {
    const [L, R] = render({ [dsKey(48, 34)]: 51, [dsKey(48, 37)]: 64 }, [{ at: 0, n: note(48), off: 22050 }], 6100);
    expectFl(L, [-0.09746838, -0.183418, 0.02519467, 0.02464237, 0.1157702, -0.007183678, -0.001863788, -0.0004488697]);
    expect(R[1]).toBeCloseTo(-0.2537606, 6);
  });

  it('follows the channel pitch, not the key; a note off starts the release', () => {
    expectFl(render({}, [{ at: 0, n: note(61, 100, 700), off: 22050 }], 6100)[0],
      [0.0191579, 0.05027337, 0.3795668, 0.283271, 0.2527859, -0.09749812, 0.1048032, -0.04924939]);
    expectFl(render({}, [{ at: 0, n: note(67), off: 2205 }], 6100)[0],
      [0.3357829, 0.3934524, 0.6583331, -0.2117372, 0.3209412, 0.3203748, 0.001474637, -0.0205698]);
  });

  it('sends to "Send track number" relative to the channel track', () => {
    const g = createGen('drumsynth', SR, 128, { sample: () => undefined })!;
    g.setParams({ ...defaultGenParams('drumsynth'), [dsKey(48, 36)]: 2, [dsKey(48, 35)]: 128 });
    const sent: number[] = [];
    let energy = 0;
    const L = new Float32Array(128), R = new Float32Array(128);
    g.noteOn!(note(48), 0);
    for (let b = 0; b < 20; b++) {
      L.fill(0); R.fill(0);
      g.render!(L, R, 128, { sampleRate: SR, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: false, track: 4,
        out: (t, a) => { sent.push(t); for (let i = 0; i < 128; i++) energy += a[i] * a[i]; } });
    }
    expect(new Set(sent)).toEqual(new Set([6]));
    expect(energy).toBeGreaterThan(1);
  });

  it('plays every patch at extreme velocities and stays finite; works in a channel', () => {
    const all = Array.from({ length: 24 }, (_, j) => ({ at: j * 64, n: note(48 + j, j % 2 ? 128 : 1), off: j * 64 + 3000 }));
    const [L] = render({}, all, 8000);
    for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i])).toBe(true);
    const e = makeEngine();
    const ch = createGenChannel('drumsynth');
    ch.volume = 1;
    const [CL] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 4, key: 51 }] }, 12000);
    expect(rms(CL, 0, 6000)).toBeGreaterThan(0.01);
  });
});
