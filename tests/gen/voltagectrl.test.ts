// Voltage Controller: parameters and value texts of FL's plugin, the source / offset / scale arithmetic, the note
// handling (colours, sample and hold, gate, trigger, clock), the extra outputs and the editor data.
import { describe, expect, it } from 'vitest';
import { createGen } from '../../src/engine/gen';
import type { GenContext, GenInstance, GenVoice } from '../../src/engine/gen/types';
import { defaultGenParams, genDef, genParamDef, normalizeGenParams } from '../../src/model/gen/registry';
import { formatParam } from '../../src/model/fx/registry';
import { vcFullScale, vcOfsKey, vcSclKey, vcVoltText } from '../../src/model/gen/plugins/voltagectrl';
import { voiceParams } from './ctlutil';

const SR = 48000;
const ID = 'voltagectrl';

type State = Record<string, unknown>;
const base = (over: State = {}): State => normalizeGenParams(ID, { ...defaultGenParams(ID), on: true, ...over });

interface Run {
  L: Float32Array;
  R: Float32Array;
  /** Extra outputs: [track, left, right] per call, concatenated over the blocks. */
  outs: Array<{ track: number; L: number[]; R: number[] }>;
  inst: GenInstance;
}

interface Ev { at: number; len?: number; key?: number; vel?: number; color?: number; pan?: number; mx?: number; my?: number }

/** Render `frames` samples in blocks of 128 with timed notes; the song plays from tick 0 at 120 BPM / 96 PPQ unless `playing` is false. */
function run(state: State, evs: Ev[], frames: number, o: { playing?: boolean; track?: number; setup?: (inst: GenInstance) => void } = {}): Run {
  const inst = createGen(ID, SR, 128)!;
  inst.setParams(state);
  o.setup?.(inst);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const outs: Run['outs'] = [];
  const bl = 128, spt = (SR * 60) / (120 * 96);
  const live = evs.map((e) => ({ e, v: null as GenVoice | null, p: voiceParams(e.key ?? 60, e.vel ?? 100, e.color ?? 0, e.len ?? Infinity), started: false, released: false }));
  const bufL = new Float32Array(bl), bufR = new Float32Array(bl);
  for (let t0 = 0; t0 < frames; t0 += bl) {
    const n = Math.min(bl, frames - t0);
    const ctx: GenContext = {
      sampleRate: SR, blockSize: bl, tempo: 120, ppq: 96, playing: o.playing ?? true, pos: (o.playing ?? true) ? t0 / spt : 0, songMode: false, track: o.track ?? 5,
      out: (track, l, r, m) => { outs.push({ track, L: Array.from(l.subarray(0, m)), R: Array.from(r.subarray(0, m)) }); },
    };
    const evts: Array<{ f: number; on: boolean; x: (typeof live)[number] }> = [];
    for (const x of live) {
      if (!x.started && x.e.at >= t0 && x.e.at < t0 + n) evts.push({ f: x.e.at - t0, on: true, x });
      if (x.e.len !== undefined && !x.released && x.e.at + x.e.len >= t0 && x.e.at + x.e.len < t0 + n) evts.push({ f: x.e.at + x.e.len - t0, on: false, x });
    }
    evts.sort((a, b) => a.f - b.f || (a.on === b.on ? 0 : a.on ? 1 : -1));
    for (const ev of evts) {
      const x = ev.x;
      x.p.frame = ev.f;
      if (ev.on) {
        x.p.init.pan = x.e.pan ?? 0; x.p.levels.pan = x.e.pan ?? 0;
        x.p.levels.fcut = x.e.mx ?? 0; x.p.levels.fres = x.e.my ?? 0;
        x.v = inst.triggerVoice?.(x.p) ?? null;
        x.started = true;
      } else if (x.v) { x.v.release(); x.released = true; }
    }
    bufL.fill(0); bufR.fill(0);
    inst.render?.(bufL, bufR, n, ctx);
    L.set(bufL.subarray(0, n), t0); R.set(bufR.subarray(0, n), t0);
  }
  return { L, R, outs, inst };
}

const mean = (a: ArrayLike<number>, i: number, j: number) => { let s = 0; for (let k = i; k < j; k++) s += a[k]; return s / (j - i); };

describe('Voltage Controller: FL\'s parameters', () => {
  const d = genDef(ID)!;
  it('has the 16 parameters of FL\'s plugin with its names, indexes, ranges and defaults', () => {
    expect(d.params).toHaveLength(16);
    expect(d.category).toBe('Misc');
    expect(d.width).toBe(302);
    expect(d.height).toBe(472);
    expect(d.defPoly).toBe(1);
    expect(d.params[0]).toMatchObject({ name: 'Left offset, main out', index: 0, min: 0, max: 65536, def: 32768 });
    expect(d.params[1].name).toBe('Right offset, main out');
    expect(d.params[2].name).toBe('Left offset, out 2');
    expect(d.params[7].name).toBe('Right offset, out 4');
    expect(d.params[8]).toMatchObject({ name: 'Left scale, main out', index: 8, min: 0, max: 65536, def: 65536 });
    expect(d.params[15].name).toBe('Right scale, out 4');
    expect(d.params.map((p) => p.index)).toEqual([...Array(16).keys()]);
  });

  it('reads the texts of FL\'s plugin: volts with six decimals, a scale from -1 to 1', () => {
    const st = defaultGenParams(ID);
    const t = (k: string, v: number) => formatParam(genParamDef(ID, k)!, v, st);
    expect(t(vcOfsKey(0), 32768)).toBe('00.000000 Volt(s)');
    expect(t(vcOfsKey(0), 0)).toBe('-10.000000 Volt(s)');
    expect(t(vcOfsKey(0), 8192)).toBe('-07.500000 Volt(s)');
    expect(t(vcOfsKey(0), 16384)).toBe('-05.000000 Volt(s)');
    expect(t(vcOfsKey(0), 24576)).toBe('-02.500000 Volt(s)');
    expect(t(vcOfsKey(0), 40960)).toBe('02.500000 Volt(s)');
    expect(t(vcOfsKey(0), 49152)).toBe('05.000000 Volt(s)');
    expect(t(vcOfsKey(0), 65536)).toBe('10.000000 Volt(s)');
    expect(t(vcSclKey(0), 65536)).toBe('01.000000');
    expect(t(vcSclKey(0), 0)).toBe('-01.000000');
    expect(t(vcSclKey(0), 32768)).toBe('00.000000');
    expect(t(vcSclKey(0), 8192)).toBe('-00.750000');
    expect(t(vcSclKey(0), 57344)).toBe('00.750000');
    // the +/- 5 V range halves the offset's volts
    expect(formatParam(genParamDef(ID, vcOfsKey(1))!, 65536, { ...st, range: 0 })).toBe('05.000000 Volt(s)');
    expect(vcVoltText(-0.0000001)).toBe('00.000000');
  });

  it('starts as FL\'s plugin database state: Pitch + Gate, Velocity + Panning, Mod X + Mod Y, output off', () => {
    const s = defaultGenParams(ID);
    expect(s.on).toBe(false);
    expect(s.src).toEqual([0, 1, 3, 5, 6, 7, 9, 9]);
    expect(s.range).toBe(1);
    expect(s.pitchScale).toBe(1);
    expect(s.ppq).toBe(24);
    expect(s.color).toEqual(new Array(8).fill(1));
    expect(vcFullScale(0)).toBe(5);
    expect(vcFullScale(1)).toBe(10);
    expect(vcFullScale(2)).toBe(10);
  });

  it('repairs a stored state', () => {
    const n = normalizeGenParams(ID, { src: [99, -1, 'x'], color: [0, 40], target: [500, -500, 1.4], ppq: 7, range: 9, pitchScale: -3, pulse: 'a' });
    expect((n.src as number[]).every((v) => v >= 0 && v <= 9)).toBe(true);
    expect((n.src as number[])).toHaveLength(8);
    expect(n.color).toEqual([1, 16, 1, 1, 1, 1, 1, 1]);
    expect(n.target).toEqual([125, -125, 1]);
    expect(n.ppq).toBe(24);
    expect(n.range).toBe(2);
    expect(n.pitchScale).toBe(0.01);
    expect(n.pulse).toBe(5);
  });
});

describe('Voltage Controller: sources, offset and scale', () => {
  it('sends nothing while ON is off', () => {
    const r = run(base({ on: false }), [{ at: 100, key: 72 }], 2000);
    expect(r.L.every((v) => v === 0)).toBe(true);
    expect(r.R.every((v) => v === 0)).toBe(true);
    expect(r.outs).toHaveLength(0);
  });

  it('Pitch is 1 V per octave of the key (C0 = 0 V), as a level of the voltage range', () => {
    const r = run(base(), [{ at: 100, key: 60, len: 4000 }, { at: 6000, key: 72, len: 2000 }], 12000);
    expect(mean(r.L, 0, 90)).toBe(0); // before any note: 0 V
    expect(mean(r.L, 500, 3500)).toBeCloseTo(5 / 10, 6); // C5 = 5 V of 10
    expect(mean(r.L, 5000, 5900)).toBeCloseTo(0.5, 6); // held after the note off
    expect(mean(r.L, 6500, 7500)).toBeCloseTo(0.6, 6); // C6 = 6 V
    expect(mean(r.L, 10000, 11900)).toBeCloseTo(0.6, 6);
    // the +/- 5 V range reaches full scale at C5, 1.2 V / Oct scales the volts
    const r5 = run(base({ range: 0 }), [{ at: 100, key: 48 }], 2000);
    expect(mean(r5.L, 500, 1900)).toBeCloseTo(4 / 5, 6);
    const r12 = run(base({ pitchScale: 1.2 }), [{ at: 100, key: 60 }], 2000);
    expect(mean(r12.L, 500, 1900)).toBeCloseTo(6 / 10, 6);
  });

  it('Gate is high while the note is held', () => {
    const r = run(base(), [{ at: 1000, len: 3000, key: 60 }], 6000);
    expect(r.R[999]).toBe(0);
    expect(r.R[1000]).toBeCloseTo(1, 6);
    expect(r.R[3999]).toBeCloseTo(1, 6);
    expect(r.R[4000]).toBe(0);
    expect(r.R[5999]).toBe(0);
  });

  it('adds the offset and scales: out = scale x (source + offset)', () => {
    // channel 1 (Right main) on None: a fixed voltage
    const none = (extra: State) => base({ src: [0, 9, 3, 5, 6, 7, 9, 9], ...extra });
    const a = run(none({ [vcOfsKey(1)]: 40960 }), [], 400); // +2.5 V
    expect(a.R[300]).toBeCloseTo(0.25, 6);
    const b = run(none({ [vcOfsKey(1)]: 40960, [vcSclKey(1)]: 49152 }), [], 400); // scale 0.5
    expect(b.R[300]).toBeCloseTo(0.125, 6);
    const c = run(none({ [vcOfsKey(1)]: 40960, [vcSclKey(1)]: 0 }), [], 400); // scale -1
    expect(c.R[300]).toBeCloseTo(-0.25, 6);
    const d = run(none({ [vcOfsKey(1)]: 8192 }), [], 400); // -7.5 V, bipolar
    expect(d.R[300]).toBeCloseTo(-0.75, 6);
    const e = run(none({ [vcOfsKey(1)]: 8192, bipolar: [true, false, true, true, true, true, true, true] }), [], 400); // unipolar: only adds
    expect(e.R[300]).toBe(0);
    // the offset of a pitch channel adds to its volts, the level clips at the range
    const f = run(base({ [vcOfsKey(0)]: 65536 }), [{ at: 10, key: 60 }], 400); // 5 V + 10 V
    expect(f.L[300]).toBe(1);
    const g = run(base({ [vcOfsKey(0)]: 0 }), [{ at: 10, key: 60 }], 400); // 5 V - 10 V
    expect(g.L[300]).toBeCloseTo(-0.5, 6);
  });

  it('maps velocity, panning and Mod X / Y to voltages (full scale each way, or 0..10 V)', () => {
    // channels 2.. are the extra outputs: route Out 2..3 to tracks and read them from the capture
    const st = base({ target: [1, 2, 3], src: [9, 9, 3, 5, 6, 7, 9, 9] });
    const r = run(st, [{ at: 10, key: 60, vel: 127, pan: -0.5, mx: 0.25, my: -1 }], 600);
    const out2 = r.outs.filter((o) => o.track === 6);
    const out3 = r.outs.filter((o) => o.track === 7);
    const last = (o: typeof out2) => o.filter((x) => x.L.length === 128).pop()!;
    expect(last(out2).L[100]).toBeCloseTo(1, 6); // velocity 127 = full scale
    expect(last(out2).R[100]).toBeCloseTo(-0.5, 6); // panning -0.5
    expect(last(out3).L[100]).toBeCloseTo(0.25, 6); // Mod X
    expect(last(out3).R[100]).toBeCloseTo(-1, 6); // Mod Y
    // velocity 64 and the 0 to 10 V range
    const v = run(base({ target: [1, 2, 3], src: [9, 9, 3, 5, 6, 7, 9, 9], range: 2 }), [{ at: 10, key: 60, vel: 64, pan: -1, mx: 1, my: 0 }], 600);
    const o2 = v.outs.filter((o) => o.track === 6 && o.L.length === 128).pop()!, o3 = v.outs.filter((o) => o.track === 7 && o.L.length === 128).pop()!;
    expect(o2.L[100]).toBeCloseTo(64 / 127, 6);
    expect(o2.R[100]).toBeCloseTo(0, 6);
    expect(o3.L[100]).toBeCloseTo(1, 6);
    expect(o3.R[100]).toBeCloseTo(0.5, 6);
  });

  it('Volume follows the voice\'s volume level, held after the note', () => {
    const st = base({ src: [4, 4, 9, 9, 9, 9, 9, 9] });
    const r = run(st, [{ at: 100, len: 500, key: 60, vel: 100 }], 3000);
    const v = mean(r.L, 300, 500);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(mean(r.L, 2000, 2900)).toBeCloseTo(v, 6);
  });

  it('Trigger is a pulse of the set length at the note on', () => {
    const st = base({ src: [0, 2, 3, 5, 6, 7, 9, 9], pulse: 5 });
    const r = run(st, [{ at: 1000, len: 8000, key: 60 }], 4000);
    const len = Math.round((5 * SR) / 1000);
    expect(r.R[999]).toBe(0);
    expect(r.R[1000]).toBeCloseTo(1, 6);
    expect(r.R[1000 + len - 1]).toBeCloseTo(1, 6);
    expect(r.R[1000 + len]).toBe(0);
    expect(r.R[3999]).toBe(0);
    // a second note retriggers
    const r2 = run(st, [{ at: 1000, len: 200, key: 60 }, { at: 2000, len: 200, key: 62 }], 4000);
    expect(r2.R[2000]).toBeCloseTo(1, 6);
    expect(r2.R[2000 + len]).toBe(0);
  });

  it('Clock pulses on the song ticks at its resolution while the song plays', () => {
    const st = base({ src: [8, 9, 9, 9, 9, 9, 9, 9], ppq: 24 });
    const frames = 24000 * 2; // two beats at 120 BPM
    const r = run(st, [], frames);
    let pulses = 0;
    for (let i = 1; i < frames; i++) if (r.L[i] > 0.5 && r.L[i - 1] <= 0.5) pulses++;
    expect(r.L[0]).toBeCloseTo(1, 6); // a pulse at the song start
    expect(pulses + 1).toBe(48); // 24 per quarter note
    // the pulses sit every 1000 samples (4 ticks of 250)
    const starts: number[] = [];
    for (let i = 0; i < frames; i++) if (r.L[i] > 0.5 && (i === 0 || r.L[i - 1] <= 0.5)) starts.push(i);
    expect(starts.slice(0, 4)).toEqual([0, 1000, 2000, 3000]);
    // stopped: no clock
    const stopped = run(st, [], 8000, { playing: false });
    expect(stopped.L.every((v) => v === 0)).toBe(true);
    // 2 PPQ: one pulse every 12000 samples
    const slow = run({ ...st, ppq: 2 }, [], 30000);
    const s2: number[] = [];
    for (let i = 0; i < slow.L.length; i++) if (slow.L[i] > 0.5 && (i === 0 || slow.L[i - 1] <= 0.5)) s2.push(i);
    expect(s2).toEqual([0, 12000, 24000]);
  });
});

describe('Voltage Controller: notes and colours', () => {
  it('a channel follows the notes of its colour; other colours are ignored', () => {
    const st = base({ color: [1, 2, 1, 1, 1, 1, 1, 1] });
    const r = run(st, [{ at: 100, key: 60, color: 0 }, { at: 3000, key: 72, color: 1, len: 1000 }, { at: 5000, key: 48, color: 5 }], 8000);
    // Left main (colour 1) plays the colour 1 note only; Right main (Gate, colour 2) the colour 2 note
    expect(mean(r.L, 1000, 2000)).toBeCloseTo(0.5, 6);
    expect(mean(r.L, 6000, 7900)).toBeCloseTo(0.5, 6);
    expect(r.R[2000]).toBe(0);
    expect(r.R[3500]).toBeCloseTo(1, 6);
    expect(r.R[4500]).toBe(0);
  });

  it('a note of a colour no channel follows gets no voice', () => {
    const inst = createGen(ID, SR, 128)!;
    inst.setParams(base());
    expect(inst.triggerVoice!(voiceParams(60, 100, 7))).toBeNull();
    expect(inst.triggerVoice!(voiceParams(60, 100, 0))).not.toBeNull();
  });

  it('keeps the gate high when a new note takes over at the instant the old one ends (legato)', () => {
    const r = run(base(), [{ at: 1000, len: 1000, key: 60 }, { at: 2000, len: 1000, key: 64 }], 5000);
    for (let i = 1100; i < 2900; i += 97) expect(r.R[i]).toBeCloseTo(1, 6);
    expect(r.R[1999]).toBeCloseTo(1, 6);
    expect(r.R[2000]).toBeCloseTo(1, 6);
    expect(mean(r.L, 2100, 2900)).toBeCloseTo(5.333333 / 10, 5);
  });

  it('follows the note\'s pitch slides (the voice\'s pitch level)', () => {
    const inst = createGen(ID, SR, 128)!;
    inst.setParams(base());
    const p = voiceParams(60, 100, 0);
    const v = inst.triggerVoice!(p)!;
    const L = new Float32Array(128), R = new Float32Array(128);
    const ctx: GenContext = { sampleRate: SR, blockSize: 128, tempo: 120, ppq: 96, playing: false, pos: 0, songMode: false, track: 1 };
    inst.render!(L, R, 128, ctx);
    expect(L[127]).toBeCloseTo(0.5, 6);
    p.levels.pitch += 200; // two semitones up
    L.fill(0); R.fill(0);
    inst.render!(L, R, 128, ctx);
    expect(L[127]).toBeCloseTo(0.5 + 2 / 12 / 10, 6);
    v.release();
    v.kill();
    L.fill(0); R.fill(0);
    inst.render!(L, R, 128, ctx);
    expect(L[127]).toBeCloseTo(0.5 + 2 / 12 / 10, 6);
    expect(R[127]).toBe(0);
  });
});

describe('Voltage Controller: extra outputs', () => {
  it('Out 2..4 feed the mixer tracks of their target offsets, Main stays with the channel', () => {
    const st = base({ target: [1, -2, 0], src: [9, 9, 9, 9, 9, 9, 9, 9], [vcOfsKey(2)]: 40960, [vcOfsKey(3)]: 49152, [vcOfsKey(4)]: 24576, [vcOfsKey(5)]: 16384, [vcOfsKey(6)]: 65536 });
    const r = run(st, [], 256, { track: 10 });
    const tracks = [...new Set(r.outs.map((o) => o.track))].sort((a, b) => a - b);
    expect(tracks).toEqual([8, 11]); // Out 4 (target 0) is not routed
    const o2 = r.outs.find((o) => o.track === 11)!;
    expect(o2.L[50]).toBeCloseTo(0.25, 6);
    expect(o2.R[50]).toBeCloseTo(0.5, 6);
    const o3 = r.outs.find((o) => o.track === 8)!;
    expect(o3.L[50]).toBeCloseTo(-0.25, 6);
    expect(o3.R[50]).toBeCloseTo(-0.5, 6);
    expect(r.L[50]).toBe(0);
  });

  it('Automap sends Out 2..4 to the three tracks behind the plugin\'s', () => {
    const r = run(base({ automap: true, target: [9, 9, 9] }), [], 128, { track: 20 });
    expect([...new Set(r.outs.map((o) => o.track))].sort((a, b) => a - b)).toEqual([21, 22, 23]);
  });

  it('is silent on the extra outputs while ON is off', () => {
    const r = run(base({ on: false, automap: true }), [], 128, { track: 3 });
    expect(r.outs).toHaveLength(0);
  });
});

describe('Voltage Controller: editor data and safety', () => {
  it('reports the voltage of every channel', () => {
    const r = run(base({ [vcOfsKey(1)]: 40960 }), [{ at: 10, key: 72, len: 100000 }], 1000);
    const m = r.inst.monitor!()!;
    const volts = m.volts as number[];
    expect(volts).toHaveLength(8);
    expect(volts[0]).toBeCloseTo(6, 6); // C6
    expect(volts[1]).toBeCloseTo(12.5, 6); // gate 10 V + 2.5 V offset (the level clips)
    const off = run(base({ on: false }), [{ at: 10, key: 72 }], 500).inst.monitor!()!;
    expect((off.volts as number[]).every((v) => v === 0)).toBe(true);
  });

  it('stays finite at extreme settings', () => {
    const st = base({ range: 2, pitchScale: 100, pulse: 1000, ppq: 96, [vcOfsKey(0)]: 65536, [vcSclKey(0)]: 65536, src: [0, 8, 2, 4, 5, 6, 7, 3] });
    const r = run(st, [{ at: 5, key: 131, vel: 128, pan: 1, mx: 1, my: -1 }, { at: 700, key: 0 }], 4000);
    for (const b of [r.L, r.R]) for (const v of b) expect(Number.isFinite(v) && Math.abs(v) <= 1).toBe(true);
    r.inst.allNotesOff?.();
    r.inst.reset?.();
  });
});
