// Plucked! (FL: Plucked!): registration, and the port's renders against FL's
// (test host numbers pinned below, rendered with --fixed-time 1700000000 so
// FL's clock-seeded noise is repeatable; the port seeds FPC's Random the same
// way): tuning (integer delay, key 60 = 260.18 Hz), decay / normalize /
// colour / gate / widen behaviour, Mod X / Mod Y, the channel sample shape,
// FL's voice order, and finiteness.
import { describe, it, expect } from 'vitest';
import { genDef, defaultGenParams, formatParam, genInCategory, genPresetState } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { GenChannel } from '../../src/engine/GenChannel';
import { createGenChannel } from '../../src/model/defaults';
import type { SeqNote } from '../../src/engine/Sequencer';
import type { GenEnv } from '../../src/engine/gen/types';
import { pluckedSeed } from '../../src/engine/gen/plugins/plucked';
import { pluckTuning, fpcPowerS } from '../../src/engine/gen/plugins/plucked/core';
import { fpcRandom, resetFpcRandom } from '../../src/engine/gen/plugins/plucked/fpcrandom';

const D = genDef('plucked')!;
const FIXED_TIME = 1700000000;
const NO_ENV: GenEnv = { sample: () => undefined };

interface N { key: number; vel?: number; start: number; len: number; modX?: number; modY?: number }

/** Render notes (sample positions) through a real channel at volume 100 %, centred, like FL's test host. */
function render(notes: N[], frames: number, o: { sr?: number; params?: Record<string, unknown>; env?: GenEnv; poly?: number } = {}): [Float32Array, Float32Array] {
  const sr = o.sr ?? 44100, block = 128;
  pluckedSeed(FIXED_TIME);
  const ch = createGenChannel('plucked');
  ch.volume = 1;
  if (o.poly !== undefined) ch.sampler.polyMax = o.poly;
  ch.plugin!.params = { ...defaultGenParams('plucked'), ...(o.params ?? {}) };
  const ctx = { sampleRate: sr, blockSize: block, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
  const c = new GenChannel(ch.id, sr, block, 'plucked', o.env ?? NO_ENV, ctx as never);
  c.setGlobals({ tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } as never);
  c.apply(ch);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const bL = new Float32Array(block), bR = new Float32Array(block);
  for (let off = 0; off < frames; off += block) {
    const n = Math.min(block, frames - off);
    for (const e of notes) {
      if (e.start < off || e.start >= off + n) continue;
      c.scheduleNote({ pos: 0, len: 0, oneShot: false, key: e.key, vel: e.vel ?? 100, rel: 64, pan: 64, fine: 120,
        modX: Math.round(128 + 128 * (e.modX ?? 0)), modY: Math.round(128 + 128 * (e.modY ?? 0)), slide: false, porta: false, color: 0, chId: ch.id } as SeqNote, e.start - off, e.len);
    }
    bL.fill(0); bR.fill(0);
    c.render(bL.subarray(0, n), bR.subarray(0, n), n);
    L.set(bL.subarray(0, n), off); R.set(bR.subarray(0, n), off);
  }
  return [L, R];
}

function rms(b: Float32Array, a = 0, z = b.length): number {
  let s = 0;
  for (let i = a; i < z; i++) s += b[i] * b[i];
  return Math.sqrt(s / Math.max(1, z - a));
}
function lastNonZero(L: Float32Array, R: Float32Array): number {
  let last = -1;
  for (let i = 0; i < L.length; i++) if (L[i] !== 0 || R[i] !== 0) last = i;
  return last;
}
const at = (b: Float32Array, idx: number[]) => idx.map((i) => b[i]);
const f32 = (xs: number[]) => xs.map(Math.fround);
const IDX = [0, 1, 2, 3, 1000, 5000];

describe('Plucked!: registration', () => {
  it('has FL\'s parameters, ranges, defaults, value texts, preset and panel size', () => {
    expect(D.name).toBe('Plucked!');
    expect(D.category).toBe('Synth special');
    expect(genInCategory('Synth special').map((d) => d.id)).toContain('plucked');
    expect(D.notes).toBe('voices');
    expect(D.levels).toBe('plugin');
    expect(D.defPoly).toBe(16);
    expect([D.width, D.height]).toEqual([360, 156]);
    expect(D.params.map((q) => [q.index, q.key, q.name, q.min, q.max, q.def])).toEqual([
      [0, 'decay', 'Decay', 0, 256, 128],
      [1, 'color', 'Color', 0, 128, 64],
      [2, 'norm', 'Normalize decay', 0, 1, 1],
      [3, 'gate', 'Short release', 0, 1, 0],
      [4, 'widen', 'Widen (stereo)', 0, 1, 1],
    ]);
    // FL's texts (test host sweeps): halves round up
    const [dec, col, norm] = D.params;
    expect([0, 1, 2, 32, 126, 128, 130, 256].map((v) => formatParam(dec, v))).toEqual(['0%', '0%', '1%', '13%', '49%', '50%', '51%', '100%']);
    expect([0, 16, 59, 61, 64, 67, 128].map((v) => formatParam(col, v))).toEqual(['0%', '13%', '46%', '48%', '50%', '52%', '100%']);
    expect([formatParam(norm, 0), formatParam(norm, 1)]).toEqual(['', '']);
    expect(D.presets!.map((p) => p.name)).toEqual(['Default']);
    const def = defaultGenParams('plucked');
    expect(def).toMatchObject({ decay: 128, color: 64, norm: 1, gate: 0, widen: 1, sample: '' });
    expect(genPresetState('plucked', D.presets![0], def)).toEqual({ ...def, __preset: 'Default' });
  });
});

describe('Plucked!: FL\'s engine', () => {
  it('reproduces FPC\'s Random (MT19937, reseeded from RandSeed on change)', () => {
    resetFpcRandom(FIXED_TIME);
    const a = [fpcRandom(), fpcRandom(), fpcRandom()];
    resetFpcRandom(FIXED_TIME);
    expect([fpcRandom(), fpcRandom(), fpcRandom()]).toEqual(a);
    for (const x of a) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
    // FPC's Power: integral exponents by repeated squaring, else exp(e ln b)
    expect(fpcPowerS(2, -1)).toBe(0.5);
    expect(fpcPowerS(2, 3)).toBe(8);
  });

  it('renders FL\'s samples at the defaults (key 60, 0.3 s note)', () => {
    const [L, R] = render([{ key: 60, start: 0, len: 13230 }], 26460);
    // flfxhost render Plucked! --block 16 --fixed-time 1700000000 --notes 60:100:0:0.3
    expect(at(L, IDX)).toEqual(f32([0.0354524627327919, -0.11013459414243698, -0.1731572300195694, 0.06314919143915176, -0.24204596877098083, -0.006071092560887337]));
    expect(at(R, IDX)).toEqual(f32([-0.01196871604770422, 0.45051369071006775, 0.07908624410629272, 0.43503642082214355, -0.1487942337989807, -0.1068011149764061]));
    expect(rms(L, 0, 13230)).toBeCloseTo(0.13386632225364567, 9);
    expect(rms(R, 0, 13230)).toBeCloseTo(0.13401415373084435, 9);
  });

  it('tunes by an integer delay (key 60 = C4 - 6 cents: 260.18 Hz) and folds extreme keys', () => {
    expect(pluckTuning(0, 44100).n).toBe(169);
    expect(pluckTuning(1200, 44100).n).toBe(84);
    expect(pluckTuning(0, 48000).n).toBe(183);
    // below -36 semitones and from +36 up FL folds the pitch by octaves
    expect(pluckTuning(-4800, 44100).n).toBe(pluckTuning(-3600, 44100).n);
    expect(pluckTuning(3600, 44100).n).toBe(pluckTuning(2400, 44100).n);
    const [L] = render([{ key: 60, start: 0, len: 13230 }], 13230);
    let best = 0, lag = 0;
    for (let l = 150; l < 190; l++) { let s = 0; for (let i = 2205; i + l < 11025; i++) s += L[i] * L[i + l]; if (s > best) { best = s; lag = l; } }
    expect(lag === 169 || lag === 170).toBe(true);
  });

  it('decays by Decay (0: FL\'s voice ends at sample 8159) and Normalize decay; Short release ends a note in ~16 ms', () => {
    const [d0L, d0R] = render([{ key: 60, start: 0, len: 13230 }], 26460, { params: { decay: 0 } });
    expect(lastNonZero(d0L, d0R)).toBe(8159);
    expect(at(d0L, [1000, 5000])).toEqual(f32([-0.15437360107898712, -0.0004470769199542701]));
    // Normalize off: FL's key 72 render
    const [nL, nR] = render([{ key: 72, start: 0, len: 13230 }], 26460, { params: { norm: 0 } });
    expect(at(nL, IDX)).toEqual(f32([-0.12428116053342819, 0.0989571139216423, -0.0791117250919342, 0.22194164991378784, -0.2699936330318451, 0.05987178534269333]));
    expect(at(nR, [1000, 5000])).toEqual(f32([-0.2683325707912445, 0.06842323392629623]));
    // GATE: note off at 8192, the level ramps to 0 (FL's AddWave ramp, 0.001 per sample) and FL ends the voice at 8911
    const [gL, gR] = render([{ key: 60, start: 0, len: 8192 }], 26460, { params: { gate: 1 } });
    expect(lastNonZero(gL, gR)).toBe(8911);
    // without GATE a note off changes nothing
    const [a] = render([{ key: 60, start: 0, len: 8192 }], 13230);
    const [b] = render([{ key: 60, start: 0, len: 13230 }], 13230);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('Color 0 excites with a pure square wave (no noise), Widen off is mono, Mod X / Mod Y offset Decay / Color', () => {
    const [cL, cR] = render([{ key: 60, start: 0, len: 4410 }], 4410, { params: { color: 0 } });
    expect(Array.from(cL)).toEqual(Array.from(cR));
    expect(cL[0]).toBe(Math.fround(Math.fround(0.5) * Math.fround(0.7071067690849304)));
    const [wL, wR] = render([{ key: 60, start: 0, len: 4410 }], 4410, { params: { widen: 0 } });
    expect(Array.from(wL)).toEqual(Array.from(wR));
    // Mod X lowers / raises the decay (here: Decay 128 - 102 -> the voice ends early), Mod Y the colour
    const [xL, xR] = render([{ key: 60, start: 0, len: 13230, modX: -0.4 }], 26460);
    expect(lastNonZero(xL, xR)).toBeLessThan(20000);
    const [yL, yR] = render([{ key: 60, start: 0, len: 4410, modY: -0.5 }], 4410);
    const [y0L] = render([{ key: 60, start: 0, len: 4410 }], 4410, { params: { color: 0 } });
    expect(Array.from(yL)).toEqual(Array.from(yR)); // colour 64 - 64 = 0: no noise
    expect(Array.from(yL)).toEqual(Array.from(y0L));
  });

  it('excites with the channel sample\'s shape and keeps FL\'s voice order (chords, voices ending)', () => {
    const n = 16384, sh = new Float32Array(n);
    for (let i = 0; i < n; i++) sh[i] = Math.sin((2 * Math.PI * 3 * i) / n) * 0.5;
    const env: GenEnv = { sample: (id) => (id === 's' ? { channels: [sh], sampleRate: 44100 } : undefined) };
    const [sL] = render([{ key: 60, start: 0, len: 4410 }], 4410, { env, params: { sample: 's', color: 0 } });
    // N = 169: the line starts with the shape resampled to 169 points
    expect(sL[0]).toBe(Math.fround(Math.fround(sh[0]) * Math.fround(0.7071067690849304)));
    const step = Math.floor(4294967296 / 169), i0 = Math.floor(step / 262144), fr = Math.fround((step % 262144) * 3.814697265625e-6);
    const line1 = Math.fround(sh[i0] + Math.fround(Math.fround(sh[i0 + 1] - sh[i0]) * fr));
    expect(sL[1]).toBe(Math.fround(line1 * Math.fround(0.7071067690849304)));
    // four voices, two of them ending while the others sound (FL's list drops a voice by moving the last one into its place)
    const notes = [0, 1, 2, 3].map((i) => ({ key: 40 + i * 3, start: i * 1000 + 3, len: 35280 }));
    const [pL, pR] = render(notes, 61740, { poly: 0 });
    for (let i = 0; i < pL.length; i += 997) { expect(Number.isFinite(pL[i])).toBe(true); expect(Number.isFinite(pR[i])).toBe(true); }
    expect(rms(pL, 0, 30000)).toBeGreaterThan(rms(pL, 50000, 61740));
  });

  it('stays finite at extreme keys, settings, sample rates and with odd parameter values', () => {
    for (const params of [{ decay: 0, color: 0, norm: 0, gate: 1, widen: 0 }, { decay: 256, color: 128, norm: 1, gate: 0, widen: 1 }, { decay: Number.NaN, color: -9, norm: 7, gate: 0.5, widen: 2 }]) {
      for (const sr of [22050, 96000]) {
        const [L, R] = render([{ key: 0, vel: 128, start: 0, len: 3000 }, { key: 131, vel: 1, start: 100, len: 3000 }, { key: 60, start: 200, len: 50, modX: 1, modY: -1 }], 6000, { sr, params });
        for (let i = 0; i < L.length; i++) { expect(Number.isFinite(L[i])).toBe(true); expect(Number.isFinite(R[i])).toBe(true); }
      }
    }
    const inst = createGen('plucked', 44100, 128)!;
    inst.setParams({});
    expect(inst.isActive!()).toBe(false);
  });
});
