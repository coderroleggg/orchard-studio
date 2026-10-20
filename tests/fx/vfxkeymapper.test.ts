import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, normalizeFxParams } from '../../src/model/fx/registry';
import { mappedKeys, processNotes } from '../../src/engine/effects/plugins/vfxkeymapper';
import { identityMap } from '../../src/model/fx/plugins/vfxkeymapper';
import { note, seeded, vfxContext } from '../../src/model/fx/plugins/vfx/notes';
import { makeCtx } from './util';

const base = () => defaultFxParams('vfxkeymapper');
const preset = (name: string) => {
  const p = fxDef('vfxkeymapper')!.presets!.find((q) => q.name === name)!;
  return { ...base(), ...structuredClone(p.params) };
};
const keys = (ns: { key: number }[]) => ns.map((n) => n.key);

describe('VFX Key Mapper', () => {
  it('is registered with FL parameters, the identity map and the decoded factory presets', () => {
    const d = fxDef('vfxkeymapper')!;
    expect(d.width).toBe(775);
    expect(d.height).toBe(373);
    expect(d.params.map((p) => [p.name, p.index, p.min, p.max, p.def])).toEqual([
      ['Enable', 0, 0, 1, 1], ['Base key', 1, 0, 11, 0], ['Offset (transpose)', 2, -12, 12, 0],
      ['How multiple notes are played', 3, 0, 4, 0], ['Pitch sliding time', 4, 0, 192, 0],
    ]);
    expect(formatParam(d.params[3], 1)).toBe('All (gain-compensated)');
    expect(base().map).toEqual(identityMap());
    expect(d.presets).toHaveLength(34);
    expect(preset('Scales\\Blues').map).toEqual([[0], [0], [3], [3], [5], [5], [6], [7], [7], [10], [10], [10]]);
    expect(preset('Special\\Random minor').mode).toBe(2);
    expect(preset('Special\\Slide down').slide).toBe(144);
    // stored maps are repaired
    expect((normalizeFxParams('vfxkeymapper', { map: [[0, 0, 99], 'x'] }).map as number[][])[0]).toEqual([0]);
  });

  it('passes notes unchanged with the default map, and through when disabled', () => {
    const ns = [note({ key: 60 }), note({ key: 73, pos: 96 })];
    expect(processNotes(ns, base())).toEqual(ns);
    const off = { ...preset('Harmony\\Octave up'), enable: 0 };
    expect(keys(processNotes(ns, off))).toEqual([60, 73]);
  });

  it('snaps to a scale (Blues) and stacks chords (Minor, Fifth up)', () => {
    const blues = preset('Scales\\Blues');
    expect(keys(processNotes([60, 61, 62, 64, 68, 71, 73].map((k, i) => note({ key: k, pos: i * 96 })), blues))).toEqual([60, 60, 63, 65, 67, 70, 72]);
    const minor = preset('Chords\\Minor');
    expect(keys(processNotes([note({ key: 62 })], minor))).toEqual([62, 65, 68]);
    expect(keys(processNotes([note({ key: 48 })], preset('Harmony\\Fifth up')))).toEqual([48, 55]);
    expect(keys(processNotes([note({ key: 48 })], preset('Harmony\\Octave down')))).toEqual([48, 36]);
  });

  it('moves the matrix with the Offset (a C major preset becomes D major)', () => {
    const dMajor = { ...preset('Scales\\Major'), offset: 2 };
    // D# snaps to D, F to E, G# to G, C to B below
    expect(keys(processNotes([63, 65, 68, 72].map((k, i) => note({ key: k, pos: i })), dMajor))).toEqual([62, 64, 67, 71]);
    expect(mappedKeys(62, identityMap(), 5)).toEqual([62]);
  });

  it('plays several mapped notes per mode: all, gain-compensated, random, cycle up / down', () => {
    const chord = { ...base(), map: [[0, 4, 7], ...identityMap().slice(1)] };
    expect(keys(processNotes([note({ key: 60 })], chord))).toEqual([60, 64, 67]);
    const comp = processNotes([note({ key: 60, vel: 100 })], { ...chord, mode: 1 });
    expect(comp.map((n) => n.vel)).toEqual([58, 58, 58]);
    expect(comp[0].gain).toBeCloseTo(1 / 3, 9);
    const rnd = processNotes(Array.from({ length: 60 }, (_, i) => note({ key: 60, pos: i * 24 })), { ...chord, mode: 2 }, vfxContext({ random: seeded(3) }));
    expect(rnd).toHaveLength(60);
    expect(new Set(keys(rnd))).toEqual(new Set([60, 64, 67]));
    const up = processNotes(Array.from({ length: 5 }, (_, i) => note({ key: 72, pos: i * 96 })), { ...chord, mode: 3 });
    expect(keys(up)).toEqual([72, 76, 79, 72, 76]);
    const down = processNotes(Array.from({ length: 4 }, (_, i) => note({ key: 60, pos: i * 96 })), { ...chord, mode: 4 });
    expect(keys(down)).toEqual([67, 64, 60, 67]);
  });

  it('slides mapped notes from the input pitch over the sliding time', () => {
    const [n] = processNotes([note({ key: 60 })], preset('Special\\Slide down'), vfxContext({ ppq: 96 }));
    expect(n.key).toBe(48);
    expect(n.mod?.pitch).toEqual([[0, 12], [144, 0]]);
    const [m] = processNotes([note({ key: 60 })], { ...preset('Special\\Slide down') }, vfxContext({ ppq: 192 }));
    expect(m.mod?.pitch?.[1][0]).toBe(288);
    expect(processNotes([note({ key: 60 })], { ...base(), slide: 96 })[0].mod).toBeUndefined(); // unchanged notes do not slide
  });

  it('drops notes whose row has no output and does nothing to audio', () => {
    const p = { ...base(), map: [[], ...identityMap().slice(1)] };
    expect(processNotes([note({ key: 60 }), note({ key: 62 })], p).map((n) => n.key)).toEqual([62]);
    const fx = createEffect('vfxkeymapper', 48000, 128);
    fx.setParams(base());
    const L = new Float32Array(128).fill(0.5), R = new Float32Array(128).fill(0.5);
    fx.process(L, R, 128, makeCtx());
    expect(L[64]).toBe(0.5);
  });
});
