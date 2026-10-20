// Ogun's "Generate random preset": the generator (src/model/gen/plugins/ogun/random.ts) against FL Studio 2026's own (digests of the states
// the real plugin made for 33 preset numbers, tests/gen/ogun-random.golden.ts), its Mersenne twister, and the states it makes being valid
// ones that the engine plays. No FL files are used.
import { describe, it, expect } from 'vitest';
import { FlMt, generateOgun, presetType } from '../../src/model/gen/plugins/ogun/random';
import { normalizeOgun } from '../../src/model/gen/plugins/ogun/state';
import { gen, type OgunInstance } from '../../src/engine/gen/plugins/ogun';
import type { GenContext, GenVoiceParams } from '../../src/engine/gen/types';
import { digest, fromModel } from './ogun-random-util';
import { RANDOM_GOLDEN } from './ogun-random.golden';

/** The standard MT19937 (init_genrand + genrand_int32), for the one place FL's differs. */
function standardMt(seed: number): () => number {
  const mt = new Uint32Array(624);
  mt[0] = seed >>> 0;
  for (let i = 1; i < 624; i++) mt[i] = (Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1812433253) + i) >>> 0;
  let idx = 624;
  return () => {
    if (idx >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      idx = 0;
    }
    let y = mt[idx++];
    y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
    return y >>> 0;
  };
}

describe('Ogun: random preset generator (pinned to FL Studio 2026)', () => {
  it('reproduces the presets FL makes for 37 numbers (sound parameters, envelopes, dense maps and info text)', () => {
    const bad: string[] = [];
    for (const [k, g] of Object.entries(RANDOM_GOLDEN)) {
      const st = generateOgun(+k) as Record<string, unknown>;
      expect(presetType(+k), `type of ${k}`).toBe(g.type);
      const d = digest(fromModel(st), false);
      if (d.ints !== g.ints) bad.push(`${k}: ints`);
      if (d.info !== g.info) bad.push(`${k}: info`);
      if (d.arts !== g.arts) bad.push(`${k}: articulators`);
      d.maps.forEach((m, j) => { if (m !== g.maps[j]) bad.push(`${k}: map ${j}`); });
    }
    expect(bad).toEqual([]);
  });

  it('uses FL\'s Mersenne twister: the standard generator but for the second twist loop, which starts at 226 and reads the index field', () => {
    const fl = new FlMt(1234567), std = standardMt(1234567);
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < 700; i++) { a.push(fl.next()); b.push(std()); }
    // the first 226 numbers of a block come from the first loop and agree; the twist of 226 reads the index field (624) instead
    expect(a.slice(0, 226)).toEqual(b.slice(0, 226));
    expect(a[226]).not.toBe(b[226]);
    expect(new FlMt(5489).next()).toBe(3499211612);
  });

  it('makes the same preset for the same number and a different one for another', () => {
    expect(generateOgun(31337)).toEqual(generateOgun(31337));
    expect(JSON.stringify(generateOgun(31337))).not.toBe(JSON.stringify(generateOgun(31338)));
  });

  it('draws the three template types in FL\'s proportions (21 of 30 plain pads, 7 plateau pads, 2 resynthesis)', () => {
    const n = [0, 0, 0];
    for (let s = 1; s <= 3000; s++) n[presetType(s)]++;
    expect(n[2]).toBeGreaterThan(130);
    expect(n[2]).toBeLessThan(270);
    expect(n[1]).toBeGreaterThan(600);
    expect(n[1]).toBeLessThan(800);
    expect(n[0]).toBeGreaterThan(1950);
  });

  it('makes valid states: nothing for the state normalisation to repair, FL\'s master level, no FL content needed (the pad tool rebuilds the impulse EQ map)', () => {
    for (const s of [1, 2, 3, 4, 8, 11, 17, 24, 25]) {
      const st = generateOgun(s) as Record<string, unknown>;
      const n = normalizeOgun({ ...st }) as Record<string, unknown>;
      expect(n.arts).toEqual(st.arts);
      expect(n.maps).toEqual(st.maps);
      expect(n.xi).toEqual(st.xi);
      expect(n.level).toBe(128);
      expect(typeof st.info).toBe('string');
      expect((st.info as string).length).toBeGreaterThan(3);
      expect(st.missing).toEqual([]);
    }
  });

  it('plays: a generated preset of each type renders finite, audible sound through the engine', () => {
    const ctx: GenContext = { sampleRate: 44100, blockSize: 128, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0 };
    for (const s of [1, 2, 4, 5, 11, 22, 24, 45]) {
      const st = generateOgun(s);
      const inst = gen.create(44100, 128, { sample: () => undefined }) as OgunInstance;
      inst.setParams(structuredClone(st));
      const p: GenVoiceParams = {
        key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0,
        init: { pan: 0, vol: 0.8, pitch: 6000, fcut: 0, fres: 0 }, levels: { pan: 0, vol: 0.8, pitch: 6000, fcut: 0, fres: 0 },
      };
      const v = inst.triggerVoice(p, ctx)!;
      const L = new Float32Array(128), R = new Float32Array(128);
      let peak = 0;
      for (let b = 0; b < 40; b++) {
        L.fill(0); R.fill(0);
        v.render(L, R, 128);
        inst.render(L, R, 128, ctx);
        for (let i = 0; i < 128; i++) {
          expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
          peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
        }
      }
      expect(peak, `number ${s}`).toBeGreaterThan(1e-4);
    }
  });
});
