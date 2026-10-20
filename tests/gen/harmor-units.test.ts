// Harmor's partial units and shaping-map tables (src/engine/gen/plugins/harmor/
// partials.ts, partials-vec.ts) against FL 2026's Harmor: reference values pinned
// from the FL test host (scratchpad harmor/host: `render --block 88 --preroll 0
// --dump` of key 60 velocity 100, the Default state with parameter changes or
// crafted part settings / curves; hashes are FNV-1a over FL's float bits; sums
// are sequential float64 sums over the active partials).

import { describe, it, expect } from 'vitest';
import { gen } from '../../src/engine/gen/plugins/harmor';
import { normalizeHarmor, expandDiff, harmorPart } from '../../src/model/gen/plugins/harmor/state';
import { HARMOR_KEYS } from '../../src/model/gen/plugins/harmor/params';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';
import { PlugDsp, type PartDsp } from '../../src/engine/gen/plugins/harmor/core';
import { mapTables, prismAmount, frac, unitChain } from '../../src/engine/gen/plugins/harmor/partials';
import { conv32f } from '../../src/engine/gen/plugins/harmor/partials-vec';

const f = Math.fround;

function fnv(a: Float32Array | Float64Array, from = 0, to = a.length): number {
  const b = new Uint8Array(a.buffer, a.byteOffset + from * a.BYTES_PER_ELEMENT, (to - from) * a.BYTES_PER_ELEMENT);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const bits = (x: number): number => new Uint32Array(new Float32Array([x]).buffer)[0];

// curves of the crafted states (FL model format: [dx, y, tension, segment, arp break, b2, kind])
const RAMP = { t: 3, p: [[0, 0.2, 0, 0, 0, 0, 0], [1, 0.9, 0, 0, 0, 0, 2]], m: [0, -1, -1, -1, -1] };
const WAVE = {
  t: 3, m: [0, -1, -1, -1, -1],
  p: [[0, 0.9, 0, 0, 0, 0, 0], [0.3, 0.1, 0.3, 0, 0, 0, 2], [0.4, 1, -0.4, 0, 0, 0, 2], [0.3, 0.4, 0, 0, 0, 0, 2]],
};
type Part = Record<string, unknown> & { maps: unknown[] };
const withMap = (a: Part, i: number, c: unknown): unknown[] => a.maps.map((m, k) => (k === i ? c : m));
const CRAFT: Record<string, (a: Part) => Part> = {
  clip1: (a) => ({ ...a, clipMode: 1, maps: withMap(a, 6, RAMP) }),
  clip3: (a) => ({ ...a, clipMode: 3, maps: withMap(a, 6, WAVE) }),
  prmul: (a) => ({ ...a, prismMode: 1, maps: withMap(a, 7, WAVE) }),
  prvol2: (a) => ({ ...a, prismMode: 1, prismVol: 2, maps: withMap(a, 7, WAVE) }),
  hzmask: (a) => ({ ...a, maps: withMap({ ...a, maps: withMap(a, 23, WAVE) }, 16, WAVE) }),
  hzb69: (a) => ({ ...a, maps: withMap(a, 16, WAVE), order: [1, 2, 3, 0, 4, 5, 6, 7, 8, 9, 10, 11] }),
  rand: (a) => ({ ...a, maps: withMap(a, 4, WAVE) }),
  bmask: (a) => ({ ...a, maps: withMap(a, 24, WAVE) }),
  prot: (a) => ({ ...a, maps: withMap(a, 5, RAMP) }),
};

function makeState(params: string, craft: string | null): Record<string, unknown> {
  const st = normalizeHarmor({ ...expandDiff({}) }) as Record<string, unknown>;
  for (const kv of params.split(',').filter(Boolean)) {
    const [i, v] = kv.split('=').map(Number);
    st[HARMOR_KEYS[i]] = v;
  }
  if (craft) st.hA = CRAFT[craft](st.hA as Part);
  return st;
}

describe('harmor units: ippsConv_32f (vDSP_conv order)', () => {
  // [kernel taps, signal length, FNV of vDSP_conv's output bits] (LCG inputs, FL's padded layout)
  const CASES: [number, number, number][] = [
    [5, 30, 0x9b11b7a0], [13, 47, 0xa35e9fb8], [21, 12, 0x1a2f699f], [3, 40, 0x6b01bb17], [66, 70, 0xbaf2842f], [257, 516, 0x6aee1e78],
  ];
  it('matches Accelerate bit for bit', () => {
    CASES.forEach(([K, M, h], c) => {
      let st = (1234567 + c) >>> 0;
      const rnd = (): number => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return f(((st >>> 12) & 4095) / 4096 - 0.25); };
      const sig = new Float32Array(M), ker = new Float32Array(K), out = new Float32Array(M + K - 1);
      for (let i = 0; i < M; i++) sig[i] = rnd();
      for (let i = 0; i < K; i++) ker[i] = f(rnd() + f(0.3));
      conv32f(sig, 0, M, ker, 0, K, out, 0);
      expect(fnv(out), `K ${K} M ${M}`).toBe(h);
    });
  });
});

describe('harmor units: map tables (FL part fields)', () => {
  // protect / rand / clip: [offset, count, FNV of the range]; flats as float bits; masks [count, FNV of 516]
  const T: Record<string, { protect: number[]; rand: number[]; clip: number[]; clipFlat: number; prismFlat: number; prism: number; pluck: number; hzMask: number[]; hzDist: number; blurMask: number[]; b69: number }> = {
    def: { protect: [0, 16, 0x967847ab], rand: [520, 0, 0], clip: [0, 520, 0x1d75468e], clipFlat: 0x40800000, prismFlat: 0xbf800000, prism: 0xed034bad, pluck: 0x7c135e62, hzMask: [0, 0], hzDist: 0xfa662fd8, blurMask: [0, 0], b69: 0 },
    clip1: { protect: [0, 16, 0x967847ab], rand: [520, 0, 0], clip: [0, 520, 0x7da1ea19], clipFlat: 0xbf800000, prismFlat: 0xbf800000, prism: 0xed034bad, pluck: 0x7c135e62, hzMask: [0, 0], hzDist: 0xfa662fd8, blurMask: [0, 0], b69: 0 },
    clip3: { protect: [0, 16, 0x967847ab], rand: [520, 0, 0], clip: [0, 520, 0x97fc7ff8], clipFlat: 0xbf800000, prismFlat: 0xbf800000, prism: 0xed034bad, pluck: 0x7c135e62, hzMask: [0, 0], hzDist: 0xfa662fd8, blurMask: [0, 0], b69: 0 },
    prmul: { protect: [0, 16, 0x967847ab], rand: [520, 0, 0], clip: [0, 520, 0x1d75468e], clipFlat: 0x40800000, prismFlat: 0xbf800000, prism: 0xab848965, pluck: 0x7c135e62, hzMask: [0, 0], hzDist: 0xfa662fd8, blurMask: [0, 0], b69: 0 },
    prvol2: { protect: [0, 16, 0x967847ab], rand: [520, 0, 0], clip: [0, 520, 0x1d75468e], clipFlat: 0x40800000, prismFlat: 0xbf800000, prism: 0x913b15b4, pluck: 0x7c135e62, hzMask: [0, 0], hzDist: 0xfa662fd8, blurMask: [0, 0], b69: 0 },
    hzmask: { protect: [0, 16, 0x967847ab], rand: [520, 0, 0], clip: [0, 520, 0x1d75468e], clipFlat: 0x40800000, prismFlat: 0xbf800000, prism: 0xed034bad, pluck: 0x7c135e62, hzMask: [516, 0x31f933f8], hzDist: 0x6f9ad85e, blurMask: [0, 0], b69: 0 },
    rand: { protect: [0, 16, 0x967847ab], rand: [0, 520, 0x61c7f78d], clip: [0, 520, 0x1d75468e], clipFlat: 0x40800000, prismFlat: 0xbf800000, prism: 0xed034bad, pluck: 0x7c135e62, hzMask: [0, 0], hzDist: 0xfa662fd8, blurMask: [0, 0], b69: 0 },
    bmask: { protect: [0, 16, 0x967847ab], rand: [520, 0, 0], clip: [0, 520, 0x1d75468e], clipFlat: 0x40800000, prismFlat: 0xbf800000, prism: 0xed034bad, pluck: 0x7c135e62, hzMask: [0, 0], hzDist: 0xfa662fd8, blurMask: [516, 0x31f933f8], b69: 0 },
    prot: { protect: [0, 520, 0xdf9a406b], rand: [520, 0, 0], clip: [0, 520, 0x1d75468e], clipFlat: 0x40800000, prismFlat: 0xbf800000, prism: 0xed034bad, pluck: 0x7c135e62, hzMask: [0, 0], hzDist: 0xfa662fd8, blurMask: [0, 0], b69: 0 },
  };
  for (const [name, e] of Object.entries(T)) {
    it(name, () => {
      const st = makeState('', name === 'def' ? null : name);
      const plug = new PlugDsp(44100);
      const pt: PartDsp = plug.parts[0];
      for (let i = 0; i < 386; i++) plug.p[i] = (st[HARMOR_KEYS[i]] as number) | 0;
      plug.setPart(pt, harmorPart(normalizeHarmor(st), 'a'));
      for (let li = 0; li < 95; li++) plug.param(li, plug.p[li]);
      mapTables(plug, pt);
      expect([pt.protectOfs, pt.protectCount, fnv(pt.protectTab, 0, pt.protectOfs + pt.protectCount)]).toEqual(e.protect);
      expect([pt.randOfs, pt.randCount, pt.randCount ? fnv(pt.randTab, pt.randOfs, pt.randOfs + pt.randCount) : 0]).toEqual(e.rand);
      expect([pt.clipOfs, pt.clipCount, fnv(pt.clipTab, pt.clipOfs, pt.clipOfs + pt.clipCount)]).toEqual(e.clip);
      expect(bits(pt.clipFlat)).toBe(e.clipFlat);
      expect(bits(pt.prismFlat)).toBe(e.prismFlat);
      expect(fnv(pt.prismTab)).toBe(e.prism);
      expect(fnv(pt.pluckTab)).toBe(e.pluck);
      expect([pt.hzMaskCount, pt.hzMaskCount ? fnv(pt.hzMask, 0, 516) : 0]).toEqual(e.hzMask);
      expect(fnv(pt.hzDist, 0, 9)).toBe(e.hzDist);
      expect([pt.blurMaskCount, pt.blurMaskCount ? fnv(pt.blurMask, 0, 516) : 0]).toEqual(e.blurMask);
      expect(pt.b69 ? 1 : 0).toBe(e.b69);
    });
  }
});

describe('harmor units: partial levels after 8 control blocks (key 60, 88-sample blocks)', () => {
  // [case, parameters, crafted part, partial count, sum of FL's levels, [slot, level bits], sum of FL's frequencies]
  const R: [string, string, string | null, number, number, [number, number][], number][] = [
    ['default', '', null, 80, 4.754249509926922, [[1, 0x00000000], [4, 0x3f800000], [5, 0x3f000000], [8, 0x3e4ccccd], [13, 0x3dcccccd], [21, 0x3d638e39], [34, 0x3d042108], [55, 0x3c9d89d9], [79, 0x00000000]], 17.954226552625578],
    ['clipping high threshold', '9=200', null, 80, 0.3764574415563402, [[1, 0x00000000], [4, 0x3bbebc20], [5, 0x3bbebc20], [8, 0x3bbebc20], [13, 0x3bbebc20], [21, 0x3bbebc20], [34, 0x3bbebc20], [55, 0x3bbebc20], [79, 0x00000000]], 17.954226552625578],
    ['harmonizer', '27=1000', null, 80, 4.071874368144563, [[1, 0x00000000], [4, 0x3eb90f99], [5, 0x3f0acbb3], [8, 0x3d940c7b], [13, 0x3dde12b8], [21, 0x3d76bf77], [34, 0x3c3f07d7], [55, 0x3d16e51c], [79, 0x00000000]], 17.954226552625578],
    ['pluck', '75=300', null, 80, 2.7546109534430556, [[1, 0x00000000], [4, 0x3f7d03a7], [5, 0x3ef5e804], [8, 0x3e26d2c8], [13, 0x3d4abc72], [21, 0x3bf677d2], [34, 0x39306e38], [55, 0x331b70eb], [79, 0x00000000]], 17.954226552625578],
    ['time blur', '21=900,22=900', null, 80, 0.6370529504159776, [[1, 0x00000000], [4, 0x3e093664], [5, 0x3d893664], [8, 0x3cdb8a38], [13, 0x3c5b8a38], [21, 0x3bf3eee8], [34, 0x3b8da37c], [55, 0x3b28e080], [79, 0x00000000]], 17.954226552625578],
    ['harmonic blur, tensions', '23=3000,24=700,25=300', null, 88, 6.11850578999838, [[1, 0x00000000], [4, 0x3f6126bf], [5, 0x3f3baf1d], [8, 0x3ec29e44], [13, 0x3e0f47b3], [21, 0x3d7c8768], [34, 0x3d0b01c6], [55, 0x3ca1fa90], [87, 0x00000000]], 21.774790217285435],
    ['harmonic blur, equal tensions', '23=2000,24=600,25=600', null, 88, 4.8233964360233585, [[1, 0x00000000], [4, 0x3f5bada1], [5, 0x3f1323e2], [8, 0x3e5eac97], [13, 0x3dd01fb7], [21, 0x3d649cea], [34, 0x3d045508], [55, 0x3c9d9fc0], [87, 0x00000000]], 21.774790217285435],
    ['prism add', '26=500', null, 80, 4.752012796117924, [[1, 0x00000000], [4, 0x3f800000], [5, 0x3f000000], [8, 0x3e4ccccd], [13, 0x3dcccccd], [21, 0x3d638e39], [34, 0x3d042108], [55, 0x3c9d89d9], [79, 0x00000000]], 17.95426967790991],
    ['clipping soft low, table', '9=500', 'clip1', 80, 2.4141387828873775, [[1, 0x00000000], [4, 0x3f800000], [5, 0x3efb72f9], [8, 0x3ddd6553], [13, 0x3cbdf6a0], [21, 0x3bc00b00], [34, 0x3ad5a090], [55, 0x39fe7500], [79, 0x00000000]], 17.954226552625578],
    ['clipping hard low, table', '9=500', 'clip3', 80, 4.146781470626593, [[1, 0x00000000], [4, 0x3f800000], [5, 0x3f000000], [8, 0x3e4ccccd], [13, 0x3dcccccd], [21, 0x3d638e39], [34, 0x3d042108], [55, 0x00000000], [79, 0x00000000]], 17.954226552625578],
    ['prism multiply', '26=600', 'prmul', 184, 4.663407371088397, [[1, 0x00000000], [4, 0x3f800000], [5, 0x3f000000], [8, 0x3e4ccccd], [13, 0x3dcccccd], [21, 0x3d638e39], [34, 0x3d042108], [55, 0x3c9d89d9], [183, 0x00000000]], 128.77369966163863],
    ['prism from inverted level', '26=600', 'prvol2', 184, 4.663828657648992, [[1, 0x00000000], [4, 0x3f800000], [5, 0x3f000000], [8, 0x3e4ccccd], [13, 0x3dcccccd], [21, 0x3d638e39], [34, 0x3d042108], [55, 0x3c9d89d9], [183, 0x00000000]], 128.57805572521517],
    ['harmonizer mask + distribution', '27=1000', 'hzmask', 80, 4.150200357657923, [[1, 0x00000000], [4, 0x3ec10f6a], [5, 0x3f05e29f], [8, 0x3e4ae3ba], [13, 0x3dce54c4], [21, 0x3d66280c], [34, 0x3cff3822], [55, 0x3cb9421e], [79, 0x00000000]], 17.954226552625578],
    ['harmonizer, local EQ after it', '27=1000', 'hzb69', 80, 5.354665316725914, [[1, 0x00000000], [4, 0x3ef13e70], [5, 0x3f7804e1], [8, 0x3dc0fec0], [13, 0x3e466a4e], [21, 0x3ddc761d], [34, 0x3c7906a5], [55, 0x3d246e09], [79, 0x00000000]], 17.954226552625578],
    ['randomness', '', 'rand', 80, 11.299212461534353, [[1, 0x00000000], [4, 0x408146cb], [5, 0x3ffb3ce1], [8, 0x3f22840d], [13, 0x3e4335bf], [21, 0x3dbbf93e], [34, 0x3ce46900], [55, 0x3c5b7bbe], [79, 0x00000000]], 17.954226552625578],
    ['blur mask', '21=900,22=900', 'bmask', 80, 4.559162965410451, [[1, 0x00000000], [4, 0x3f7d4f95], [5, 0x3efdabdc], [8, 0x3e4ae393], [13, 0x3dca68e4], [21, 0x3d5f1f89], [34, 0x3cfa6306], [55, 0x3c7121dd], [79, 0x00000000]], 17.954226552625578],
    ['protection', '8=900,27=1000', 'prot', 80, 4.09203877508844, [[1, 0x00000000], [4, 0x3ec28361], [5, 0x3f0a3191], [8, 0x3daf6eb0], [13, 0x3ddb7334], [21, 0x3d72ef2a], [34, 0x3c894d21], [55, 0x3d01510f], [79, 0x00000000]], 17.954226552625578],
  ];
  for (const [name, params, craft, count, sum, slots, fsum] of R) {
    it(name, () => {
      const sr = 44100, block = 88;
      const inst = gen.create(sr, block, { sample: () => undefined }) as unknown as {
        setParams(p: unknown): void; noteOn(n: GenNote, o: number): void;
        render(l: Float32Array, r: Float32Array, n: number, c: unknown): void;
        live: { sb: { count: number; amps: Float32Array; freq: Float64Array } }[];
      };
      inst.setParams(makeState(params, craft));
      const lv = newLevels(); lv.pitch = 6000; lv.vol = 1;
      const init = newLevels(); init.pitch = 6000; init.vol = 1;
      inst.noteOn({ id: 1, key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels: lv } as GenNote, 0);
      const ctx = { sampleRate: sr, blockSize: block, tempo: 140, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
      const L = new Float32Array(block), Rr = new Float32Array(block);
      for (let b = 0; b < 8; b++) { L.fill(0); Rr.fill(0); inst.render(L, Rr, block, ctx); }
      const sb = inst.live[0].sb;
      expect(sb.count).toBe(count);
      let s = 0, fs = 0;
      for (let i = 0; i < count; i++) { s += sb.amps[i]; fs += sb.freq[i]; }
      for (const [slot, b] of slots) expect(bits(sb.amps[slot]), `slot ${slot}`).toBe(b);
      expect(s).toBe(sum);
      expect(fs).toBe(fsum);
    });
  }
});

describe('harmor units: helpers', () => {
  it('prism amount (0xe30b8): 4 c |c| in add mode, clamped in multiply mode', () => {
    const pt = { prismMode: 0 } as PartDsp;
    expect(prismAmount(pt, 0)).toBe(0);
    expect(prismAmount(pt, f(0.5))).toBe(1);
    expect(prismAmount(pt, f(-0.25))).toBe(-0.25);
    pt.prismMode = 1;
    expect(prismAmount(pt, 3)).toBe(1);
    expect(prismAmount(pt, -3)).toBe(-1);
    expect(prismAmount(pt, f(0.3))).toBe(f(0.3));
  });
  it('frac (0xcf60)', () => {
    expect(frac(2.75)).toBe(0.75);
    expect(frac(-2.75)).toBe(-0.75);
  });
  it('unit chain (0xca920): skipped units and the envelope volume unit', () => {
    const out = new Int32Array(12);
    const pt = {
      order: Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), b68: true, randCount: 0, pluckBlur: false,
      protectCount: 16, clipCount: 0,
    } as unknown as PartDsp;
    let n = unitChain(pt, out);
    expect(Array.from(out.subarray(0, n))).toEqual([1, 3, 4, 5, 6, 7, 8, 9]);
    pt.order.set([1, 2, 3, 4, 11, 5, 6, 7, 8, 9, 10, 0]);
    (pt as { b68: boolean }).b68 = false;
    n = unitChain(pt, out);
    expect(Array.from(out.subarray(0, n))).toEqual([1, 3, 4, 11, 5, 6, 7, 8, 9, 0]);
  });
});
