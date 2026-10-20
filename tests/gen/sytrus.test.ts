// Sytrus: registration, the state model (compact articulators, preset bank),
// FL's numbers for factory presets (sample values from FL 2026's Sytrus in the
// test host: 44.1 kHz, C5 velocity 100 held 1 s, 0.25 s preroll, the host's
// 512-frame blocks cut at note events), and finiteness at extremes.
import { describe, it, expect } from 'vitest';
import { genDef, defaultGenParams, genPresetState, normalizeGenParams } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import type { GenNote } from '../../src/engine/gen/types';
import { SYTRUS_PARAMS, sytrusBank } from '../../src/model/gen/plugins/sytrus';
import { artEnv, defaultArt, defaultSyState, resolveArt } from '../../src/model/gen/plugins/sytrus/defaults';
import { normalizeSy } from '../../src/model/gen/plugins/sytrus/normalize';
import { paramKeys, type SyState } from '../../src/model/gen/plugins/sytrus/types';
import { FpcRandom } from '../../src/engine/gen/plugins/sytrus/random';

const def = genDef('sytrus')!;
const base = normalizeGenParams('sytrus', defaultGenParams('sytrus'));

function preset(name: string): Record<string, unknown> {
  const pr = def.presets!.find((p) => p.name === name);
  if (!pr) throw new Error('no preset ' + name);
  return genPresetState('sytrus', pr, base);
}

/** Render like FL's test host: preroll in 512-frame blocks, then blocks from t=0 cut at note events. */
function render(params: Record<string, unknown>, notes: [number, number, number, number][], seconds: number, sr = 44100): [Float32Array, Float32Array] {
  const g = createGen('sytrus', sr, 512)!;
  g.setParams(params);
  const total = Math.round(seconds * sr);
  const L = new Float32Array(total), R = new Float32Array(total);
  const bl = new Float32Array(512), br = new Float32Array(512);
  const ctx = { sampleRate: sr, blockSize: 512, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0, rendering: false };
  const pre = Math.round(0.25 * sr);
  for (let o = 0; o < pre; o += 512) { bl.fill(0); br.fill(0); g.render!(bl, br, Math.min(512, pre - o), ctx); }
  const evs: [number, number, GenNote][] = [];
  notes.forEach(([key, vel, start, dur], id) => {
    const vol = vel === 100 ? 1 : (Math.pow(11, vel / 100) - 1) / 10;
    const lv = { pan: 0, vol, pitch: key * 100, fcut: 0, fres: 0 };
    const n: GenNote = { id: id + 1, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init: { ...lv }, levels: { ...lv } };
    evs.push([Math.round(start * sr), 0, n], [Math.round((start + dur) * sr), 1, n]);
  });
  evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let ei = 0;
  for (let o = 0; o < total;) {
    while (ei < evs.length && evs[ei][0] <= o) {
      const [, kind, n] = evs[ei++];
      if (kind === 0) g.noteOn!(n, 0); else g.noteOff!(n, 0);
    }
    let len = Math.min(512, total - o);
    if (ei < evs.length && evs[ei][0] < o + len) len = evs[ei][0] - o;
    bl.fill(0); br.fill(0);
    g.render!(bl, br, len, ctx);
    L.set(bl.subarray(0, len), o); R.set(br.subarray(0, len), o);
    o += len;
  }
  return [L, R];
}

describe('Sytrus: registration and state', () => {
  it('has FL\'s 597 parameters, the 984 factory presets and FL\'s Default patch', () => {
    expect(def.name).toBe('Sytrus');
    expect(def.notes).toBe('events');
    expect([def.width, def.height]).toEqual([845, 450]);
    expect(SYTRUS_PARAMS.length).toBe(597);
    expect(SYTRUS_PARAMS.map((q) => q.key)).toEqual(paramKeys());
    expect(def.presets!.length).toBe(984);
    expect(def.presets![0].name).toBe('Default');
    expect(def.presets![1].name).toBe('Default subtractive');
    const d = defaultSyState();
    expect(d.fm[8]).toBe(256); // operator 1 -> output
    expect(d.arts.every((u) => u.every((a) => a === null))).toBe(true);
  });

  it('stores articulators compactly and resolves FL\'s defaults', () => {
    const st = preset('Plucked/Classic');
    const sy = st.sy as SyState;
    const curves = sy.arts.flat().filter((a) => a !== null).flatMap((a) => a!.e).filter((e) => e !== null).length;
    expect(curves).toBeGreaterThan(0);
    expect(curves).toBeLessThan(40);
    // a default curve read back is FL's default for its slot
    expect(artEnv(defaultSyState(), 0, 1, 0)).toEqual(defaultArt(0, 1).e[0]);
    const full = resolveArt(sy, 0, 1);
    expect(full.e.every((e) => e && e.p.length > 0)).toBe(true);
    // a full articulator equal to the defaults normalises to null, an edited one keeps only its edit
    const raw = JSON.parse(JSON.stringify(sy)) as SyState;
    raw.arts[2][1] = defaultArt(2, 1);
    const ed = defaultArt(3, 2);
    ed.e[3] = { p: [[0, 0.2, 0], [1, 0.9, 0]], m: [0, -1, -1, -1, -1] };
    raw.arts[3][2] = ed;
    const n = normalizeSy(raw);
    expect(n.arts[2][1]).toBe(null);
    expect(n.arts[3][2]!.e.filter((e) => e !== null).length).toBe(1);
    expect(normalizeSy(JSON.parse(JSON.stringify(n)))).toEqual(n);
  });

  it('decodes every preset into a valid state', () => {
    const bank = sytrusBank();
    expect(bank.length).toBe(984);
    for (const p of [bank[0], bank[500], bank[983]]) {
      expect(Object.keys(p.params).length).toBeGreaterThan(500);
      expect(p.sy.ops.length).toBe(6);
      expect(p.sy.arts.length).toBe(10);
    }
  });

  it('draws random mappings from FL\'s Pascal Mersenne Twister', () => {
    // Free Pascal's genrand_MT19937 seeded from RandSeed 0 (the reference MT19937 sequence for seed 0)
    const r = new FpcRandom(0);
    expect([r.next(), r.next(), r.next()]).toEqual([2357136044, 2546248239, 3071714933]);
  });
});

// FL's samples (test host) at these frames; ours match to float precision of the parts that differ in rounding
const IDX = [100, 1000, 3333, 9000, 20000, 30000, 44200, 45000];
const REF: Record<string, { L: number[]; R: number[] }> = {
  // sine at the note's pitch, operator 1 to the output (FL's Default patch)
  'Default': { L: [0.6515872, -0.5300942, -0.2032214, -0.6891509, 0.6695685, -0.2052016, 0.2548169, 0], R: [0.6515872, -0.5300942, -0.2032214, -0.6891509, 0.6695685, -0.2052016, 0.2548169, 0] },
  // plucked string filled from FL's IPP uniform noise
  'Plucked/Classic': { L: [-0.3353933, -0.140219, -0.2093359, 0.1124814, -0.1395665, 0.05097717, 0.1081409, 0.1549509], R: [-0.2299682, 0.0547239, 0.003604472, 0.4180858, 0.07827824, 0.03034397, 0.17122, -0.02422168] },
  'Piano/E-grand': { L: [-0.1369752, -0.2110482, -0.1834493, 0.1672947, -0.1529145, -0.003219193, 0.01773862, 0], R: [-0.05949423, -0.2427925, -0.1985942, 0.1142472, -0.1302772, -0.002742626, 0.01511261, 0] },
  // unison 3 with an operator of noise: FL renders voice after voice, newest first
  'FX/Reactor': { L: [0.06245906, 0.236225, -0.1898379, 0.04310558, -0.0984157, -0.2839899, 0.3153662, 0], R: [0.03472479, -0.02954184, -0.3150377, 0.2469213, 0.1463654, -0.05793157, 0.1354921, 0] },
  // OSC unison: operators summed into the note's first voice, filters and effects once
  'Arp/Acid 4': { L: [-0.2175696, 0.006935676, 0.2391777, 0.01153466, -0.008917067, 0.1152498, -0.3867961, -0.03747849], R: [-0.2475857, -0.155489, 0.3369167, -0.02976497, 0.05905217, 0.01706397, -0.4283031, -0.02165834] },
  // a key mapping made of hold segments
  'Bass/Synth 7': { L: [0.2345582, 0.4314256, 0.1108722, -0.1904906, -0.3335764, 0.2781881, 0.1680755, -0.1263997], R: [0.2354563, 0.3541699, 0.05060128, -0.09808371, -0.306541, 0.2536552, 0.196662, -0.1765075] },
  // a three-operator FM chain on a stairs mapping, the voice ending with an inactive operator's release
  'X Saif Sameer/Basses/Rocker Bass 1': { L: [-0.6189233, 0.1590527, 0.2583117, -0.2686109, -0.01418931, -0.3393291, -0.03337129, -0.006640787], R: [-0.6146423, 0.0318509, 0.3483614, -0.3514718, -0.02466223, -0.2697138, -0.02403306, 0.009204452] },
};

describe('Sytrus: FL\'s output', () => {
  for (const [name, ref] of Object.entries(REF)) {
    it(`${name} matches FL`, () => {
      const [L, R] = render(preset(name), [[60, 100, 0, 1]], 1.05);
      for (let k = 0; k < IDX.length; k++) {
        expect(Math.abs(L[IDX[k]] - ref.L[k]), `${name} L[${IDX[k]}]`).toBeLessThan(2e-4);
        expect(Math.abs(R[IDX[k]] - ref.R[k]), `${name} R[${IDX[k]}]`).toBeLessThan(2e-4);
      }
    });
  }

  it('glides from the previous note with PORTA (Short synth/Celestial 3)', () => {
    const [L, R] = render(preset('Short synth/Celestial 3'), [[60, 100, 0, 0.5], [67, 100, 0.5, 0.5]], 1.1);
    const idx = [22100, 23000, 26000, 30000, 40000, 48000];
    const fl = [[0.1037888, 0.08651859, 0.05946469, -0.05188107, 0.2261623, 0.1256689], [0.1177263, 0.08267659, 0.05956544, -0.0452227, 0.1907967, 0.03370027]];
    for (let k = 0; k < idx.length; k++) {
      expect(Math.abs(L[idx[k]] - fl[0][k])).toBeLessThan(5e-4);
      expect(Math.abs(R[idx[k]] - fl[1][k])).toBeLessThan(5e-4);
    }
  });

  it('stays finite at extreme keys, velocities and settings', () => {
    const p = preset('Default') as Record<string, unknown>;
    const ext = { ...p, uOrder: 9, uPitch: 256, o1pe: 4800, f1mode: 3, f1res: 256, f1cut: 256 };
    for (const params of [p, ext, preset('Plucked/Classic'), preset('X Nucleon/Bass/Talkbass')]) {
      const [L, R] = render(params, [[0, 1, 0, 0.1], [127, 127, 0.02, 0.1], [60, 128, 0.05, 0.1]], 0.3, 48000);
      for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error('not finite at ' + i);
    }
  });
});
