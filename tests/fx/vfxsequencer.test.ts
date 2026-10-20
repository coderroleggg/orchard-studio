import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { detectChord, processNotes, scaleShift, snapToScale } from '../../src/engine/effects/plugins/vfxsequencer';
import { laneKey, programParams } from '../../src/model/fx/plugins/vfxsequencer';
import { note, seeded, vfxContext } from '../../src/model/fx/plugins/vfx/notes';
import { makeCtx } from './util';

const PPQ = 96, STEP = PPQ / 4; // 1/16 steps
const base = () => defaultFxParams('vfxsequencer');
const ctx = () => vfxContext({ ppq: PPQ, random: seeded(9) });
/** A C major triad held for `bars` bars from tick 0. */
const chord = (keys = [60, 64, 67], bars = 1) => keys.map((k) => note({ key: k, pos: 0, len: bars * 4 * PPQ, vel: 100 }));
const keysAt = (ns: { key: number; pos: number }[], step: number) => ns.filter((n) => n.pos === step * STEP).map((n) => n.key);
const withLane = (p: Record<string, unknown>, lane: 'key' | 'type' | 'oct' | 'vel' | 'gate' | 'scale', vals: number[]) => {
  const q = { ...p };
  vals.forEach((v, i) => { q[laneKey(lane, i)] = v; });
  return q;
};

describe('VFX Sequencer', () => {
  it('has FL\'s parameters (indices, names, value texts) and the 128 built-in programs', () => {
    const d = fxDef('vfxsequencer')!;
    expect(d.width).toBe(984);
    expect(d.height).toBe(560);
    const byKey = Object.fromEntries(d.params.map((p) => [p.key, p]));
    expect(byKey.arpMode).toMatchObject({ index: 5, name: 'Arp Mode', def: 1 });
    expect(byKey.steps).toMatchObject({ index: 40, def: 16, max: 64 });
    expect(formatParam(byKey.gate, 90)).toBe('72%');
    expect(formatParam(byKey.sync, 4)).toBe('1/16');
    expect(formatParam(byKey.fixedKey, 57)).toBe('A4');
    expect(formatParam(byKey.inHigh, 127)).toBe('G10');
    expect(formatParam(byKey.swing, 25)).toBe('50%');
    expect(byKey.key1).toMatchObject({ index: 320, name: 'KeySelect_01', def: 1 });
    expect(byKey.vel64).toMatchObject({ index: 447, name: 'Velocity_64', def: 96 });
    expect(formatParam(byKey.key1, -1)).toBe('Fix');
    expect(formatParam(byKey.type1, 4)).toBe('Chr');
    expect(formatParam(byKey.gate1, -1)).toBe('1/2');
    expect(d.presets).toHaveLength(128);
    expect(d.presets![3].name).toBe('003. Simple 4k Up 4 bars');
    expect(programParams(3)[laneKey('key', 1)]).toBe(2);
  });

  it('plays N1 on every 1/16 step by default (the lowest held note), gate 72% of a step', () => {
    const out = processNotes(chord(), base(), ctx());
    expect(out).toHaveLength(16);
    expect(out.every((n) => n.key === 60)).toBe(true);
    expect(out.map((n) => n.pos)).toEqual(Array.from({ length: 16 }, (_, i) => i * STEP));
    expect(out[0].len).toBe(Math.round(STEP * 0.72));
    expect(out[0].vel).toBe(97); // lane velocity 96 (MIDI) on FL's 0..128 scale
  });

  it('runs an up pattern from a built-in program and orders by pitch, down or as played', () => {
    const up = { ...base(), ...programParams(3) }; // N1 N2 N3 N4 ... last note substitutes
    const out = processNotes(chord([60, 64, 67, 71]), up, ctx());
    expect([0, 1, 2, 3].map((s) => keysAt(out, s)[0])).toEqual([60, 64, 67, 71]);
    const down = { ...withLane(base(), 'key', [1, 2, 3]), steps: 3, order: 1 };
    expect([0, 1, 2].map((s) => keysAt(processNotes(chord(), down, ctx()), s)[0])).toEqual([67, 64, 60]);
    const played = [note({ key: 67, pos: 0, len: 384 }), note({ key: 60, pos: 1, len: 383 })];
    const asPlayed = { ...withLane(base(), 'key', [1, 2]), steps: 2, order: 2, inQuant: 0 };
    const o = processNotes(played, asPlayed, ctx());
    expect([keysAt(o, 1)[0], keysAt(o, 2)[0]]).toEqual([60, 67]); // step 0: only G held at tick 0
  });

  it('replaces missing notes as set (Don\'t play, Cyclic, First, Last, Fixed) with the octave option', () => {
    const p = { ...withLane(base(), 'key', [1, 2, 3, 4]), steps: 4 };
    const two = chord([60, 64]);
    const run = (missKey: number, missOct = 0) => [0, 1, 2, 3].map((s) => keysAt(processNotes(two, { ...p, missKey, missOct }, ctx()), s)[0] ?? null);
    expect(run(0)).toEqual([60, 64, null, null]);
    expect(run(1)).toEqual([60, 64, 60, 64]);
    expect(run(2)).toEqual([60, 64, 60, 60]);
    expect(run(3)).toEqual([60, 64, 64, 64]);
    expect(run(4)).toEqual([60, 64, 57, 57]); // fixed key A4
    expect(run(3, 2)).toEqual([60, 64, 76, 76]);
  });

  it('handles step types: Off, Rest (longer), Tie (slide), Chord, Random; Root and Fix notes', () => {
    const p = { ...withLane(withLane(base(), 'type', [1, 2, 0, 4, 5, 3]), 'key', [1, 1, 1, 1, 1, 2]), steps: 6 };
    const out = processNotes(chord(), p, ctx());
    const s0 = out.find((n) => n.pos === 0)!;
    expect(s0.len).toBe(Math.round(STEP * 0.72) + STEP); // the rest step extends it
    expect(keysAt(out, 2)).toEqual([]); // off
    expect(keysAt(out, 3).sort()).toEqual([60, 64, 67]); // chord
    expect([60, 64, 67]).toContain(keysAt(out, 4)[0]); // random
    const tie = out.find((n) => n.pos === 5 * STEP)!;
    expect(tie.slide).toBe(true);
    const rootFix = { ...withLane(base(), 'key', [0, -1]), steps: 2 };
    const o = processNotes(chord([64, 67, 72]), rootFix, ctx()); // C major, first inversion
    expect(keysAt(o, 0)[0]).toBe(60); // root C below the lowest key
    expect(keysAt(o, 1)[0]).toBe(57); // fixed A4
  });

  it('applies octave, scale step (semitones or in scale), transpose, force-to-scale and output wrap', () => {
    const p = { ...withLane(withLane(base(), 'oct', [1, -1, 0]), 'scale', [0, 0, 2]), steps: 3 };
    const out = processNotes(chord([60]), p, ctx());
    expect([0, 1, 2].map((s) => keysAt(out, s)[0])).toEqual([72, 48, 62]);
    const major = { ...p, scale: 2, scaleKey: 2 }; // C major, fixed C: +2 scale steps from C = E
    expect(keysAt(processNotes(chord([60]), major, ctx()), 2)[0]).toBe(64);
    const tr = { ...base(), transOct: 1, transSemi: -2 };
    expect(processNotes(chord([60]), tr, ctx())[0].key).toBe(70);
    const wrap = { ...base(), transOct: 3, outLow: 60, outHigh: 72 };
    expect(processNotes(chord([62]), wrap, ctx())[0].key).toBe(62);
    expect(snapToScale(61, 0, [0, 2, 4, 5, 7, 9, 11])).toBe(60);
    expect(scaleShift(64, -2, 0, [0, 2, 4, 5, 7, 9, 11])).toBe(60);
  });

  it('polyphonic octave lanes play several octaves (bit masks from the chord programs)', () => {
    const p = { ...withLane(withLane(base(), 'type', [4]), 'oct', [12]), steps: 1, polyOct: 1 };
    const out = processNotes(chord([60]), p, ctx());
    expect(out.filter((n) => n.pos === 0).map((n) => n.key).sort()).toEqual([48, 60]); // octaves -1 and 0
  });

  it('follows sync and swing, restarts on keys, latches, and honours the Arp modes', () => {
    const eighth = { ...base(), sync: 6 }; // 1/8
    expect(processNotes(chord(), eighth, ctx())).toHaveLength(8);
    const swung = { ...base(), swing: 25 }; // 50% of a step on even steps
    const sw = processNotes(chord(), swung, ctx());
    expect(sw[1].pos - sw[0].pos).toBe(STEP * 1.5);
    const restart = { ...withLane(base(), 'key', [1, 2, 3, 3]), steps: 4, restart: 1, inQuant: 0 };
    const ns = [...chord([60, 64, 67], 0.25), ...chord([60, 64, 67], 1).map((n) => ({ ...n, pos: 6 * STEP, len: 4 * STEP }))];
    const r = processNotes(ns, restart, ctx());
    expect(keysAt(r, 6)[0]).toBe(60); // new chord at step 6 restarts the pattern
    const latched = { ...base(), latch: 1, steps: 4 };
    const l = processNotes(chord([60], 0.25), latched, ctx());
    expect(l.length).toBeGreaterThan(4); // keeps playing after the release
    expect(processNotes(chord(), { ...base(), arpMode: 0 }, ctx())).toEqual([]);
    expect(processNotes(chord(), { ...base(), arpMode: 2 }, ctx()).map((n) => n.key)).toEqual([60, 64, 67]); // thru
    const auto = { ...base(), arpMode: 4 }; // 2 note on/thru
    expect(processNotes([note({ key: 60, len: 384 })], auto, ctx()).map((n) => [n.key, n.pos])).toEqual([[60, 0]]);
    expect(processNotes([note({ key: 60, len: 384 })], { ...base(), arpMode: 3 }, ctx())).toEqual([]);
  });

  it('detects chords for Root and chord orders', () => {
    expect(detectChord([60, 64, 67])).toMatchObject({ root: 0, minor: false });
    expect(detectChord([57, 60, 64])).toMatchObject({ root: 9, minor: true });
    expect(detectChord([55, 60, 64])).toMatchObject({ root: 0 });
    const norm = { ...withLane(base(), 'key', [1, 2, 3]), steps: 3, order: 6 };
    expect([0, 1, 2].map((s) => keysAt(processNotes(chord([55, 60, 64]), norm, ctx()), s)[0])).toEqual([60, 64, 67]);
  });

  it('randomizes velocity within range, and does nothing to audio', () => {
    const p = { ...base(), randVel: 50 };
    const out = processNotes(chord([60], 4), p, ctx());
    const vs = out.map((n) => n.vel);
    expect(Math.max(...vs) - Math.min(...vs)).toBeGreaterThan(10);
    expect(vs.every((x) => x >= 1 && x <= 128)).toBe(true);
    const fx = createEffect('vfxsequencer', 48000, 128);
    fx.setParams(base());
    const L = new Float32Array(128).fill(0.6), R = new Float32Array(128).fill(0.6);
    fx.process(L, R, 128, makeCtx());
    expect(L[127]).toBeCloseTo(0.6, 7);
  });
});
