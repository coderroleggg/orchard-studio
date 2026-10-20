// Fruity Slicer 2: registration (FL's 1029 used parameters, ranges, defaults, value texts), state and
// presets, FL's slicing and score dumps on a synthesized loop, the engine against FL 2026's own
// renders (bit-exact hashes, see slicer2-golden.ts), parameter changes, finiteness, the editor.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { genChannel, makeEngine, play, rms as rmsU } from './util';
import { def } from '../../src/model/gen/plugins/slicer2';
import { gen } from '../../src/engine/gen/plugins/slicer2';
import { midiVelocity } from '../../src/engine/gen/plugins/slicer2';
import {
  SL2_BLOCKS, SL2_BLOCK_RANGE, baseKeyFor, defaultSlice, defaultSlicer2State, flDefaultState, normalizeSlicer2State, sl2Index, sl2Key, sliceKey,
  type Slicer2Slice,
} from '../../src/model/gen/plugins/slicer2/state';
import { autoStarts, beatStarts, beatsOf, loadSlices, menuSlices, slicesFrom } from '../../src/model/gen/plugins/slicer2/slicing';
import { parseWavMeta } from '../../src/model/gen/plugins/slicer2/wavmeta';
import { dumpNotes } from '../../src/model/gen/plugins/slicer/dump';
import { expf, tanf } from '../../src/engine/gen/plugins/slicer2/libm';
import { LOOP_SR, testLoop } from './slicer2-audio';
import { FL_DUMPS, FL_RENDERS, FL_SLICES_MONO, FL_SLICES_STEREO, FL_TEXTS, type GoldenCase } from './slicer2-golden';
import type { GenNote } from '../../src/engine/gen/types';

const f32 = Math.fround;
const SR = 44100;

// ------------------------------------------------------------------ host-like renderer
/** FL's LogVol (InitLevels.Vol of a velocity; channel volume knob). */
function flLogVol(x: number): number {
  const v = f32(x);
  if (v === 1) return 1;
  const t = f32(v * f32(2.397895336151123));
  return f32((Math.exp(t) - 1) * f32(0.1));
}
const flPan = (v: number) => f32(f32(v * 6400) * f32(0.00015625));

interface RenderOpts { notes: string; params: Record<string, unknown>; slices?: Slicer2Slice[]; chanVol?: number; chanPan?: number; secs?: number; sr?: number; stereo?: boolean; tempo?: number }

/** Render like FL's test host: 0.25 s preroll, 512-sample blocks split at the notes. */
function render(o: RenderOpts): { L: Float32Array; R: Float32Array } {
  const sr = o.sr ?? SR;
  const ch = testLoop(!!o.stereo);
  const len = ch[0].length;
  const g = gen.create(sr, 512, { sample: (id) => (id === 'S' ? { channels: ch, sampleRate: LOOP_SR } : undefined) });
  const base: Record<string, unknown> = { ...Object.fromEntries(def.params.map((p) => [p.key, p.def])), ...defaultSlicer2State(), sample: 'S' };
  base.slices = o.slices ?? slicesFrom(autoStarts(ch, LOOP_SR, 100, 100).map((pos) => ({ pos })), len, 0);
  g.setParams(normalizeSlicer2State({ ...base, ...o.params }));
  const chanVol = o.chanVol !== undefined ? flLogVol(f32(f32(Math.round(o.chanVol * 128)) * 7.8125e-5)) : 1;
  const chanPan = flPan(o.chanPan ?? 0);
  let nid = 0;
  const notes = o.notes.split(',').filter(Boolean).map((s) => {
    const parts = s.split(':');
    const [k, v, st, d] = parts.slice(0, 4).map(Number);
    const opt: Record<string, number> = {};
    for (const q of parts.slice(4)) { const [a, b] = q.split('='); opt[a] = Number(b); }
    const pn = opt.pan ?? 0, fine = opt.fine ?? 0, mx = opt.modx ?? 0, my = opt.mody ?? 0;
    const init = { pan: pn, vol: flLogVol(f32(v * f32(0.01))), pitch: 6000 + (k - 60) * 100, fcut: mx, fres: my };
    const levels = { pan: f32(pn + chanPan), vol: chanVol, pitch: 6000 + (k - 60) * 100 + fine, fcut: mx, fres: my };
    const note = { id: ++nid, key: k, velocity: v, release: 64, color: 0, length: Infinity, frame: 0, init, levels } as GenNote;
    return { on: Math.round(st * sr), off: Math.round((st + d) * sr), note };
  });
  const N = Math.round((o.secs ?? 2) * sr);
  const L = new Float32Array(N), R = new Float32Array(N);
  const bl = new Float32Array(512), br = new Float32Array(512);
  const ctx = { sampleRate: sr, blockSize: 512, tempo: o.tempo ?? 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 1 };
  for (let t = 0; t < 11025;) { const n = Math.min(512, 11025 - t); bl.fill(0); br.fill(0); g.render!(bl, br, n, ctx); t += n; }
  const times = [...new Set(notes.flatMap((x) => [x.on, x.off]))].sort((a, b) => a - b);
  for (let b0 = 0; b0 < N;) {
    let n = Math.min(512, N - b0);
    for (const t of times) if (t > b0 && t < b0 + n) { n = t - b0; break; }
    for (const x of notes) { if (x.off === b0) g.noteOff!(x.note, 0); if (x.on === b0) g.noteOn!(x.note, 0); }
    bl.fill(0); br.fill(0);
    g.render!(bl, br, n, ctx);
    L.set(bl.subarray(0, n), b0); R.set(br.subarray(0, n), b0);
    b0 += n;
  }
  return { L, R };
}

function fnv(L: Float32Array, R: Float32Array): number {
  const x = new Float32Array(2 * L.length);
  for (let i = 0; i < L.length; i++) { x[2 * i] = L[i]; x[2 * i + 1] = R[i]; }
  const b = new Uint8Array(x.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
  return h;
}

function sliceStates(c: GoldenCase): Slicer2Slice[] {
  const sl = (c.stereo ? FL_SLICES_STEREO : FL_SLICES_MONO).map(([a, b]) => defaultSlice(a, b));
  for (const [k, v] of Object.entries(c.slices)) Object.assign(sl[Number(k)], v);
  return sl;
}

// ------------------------------------------------------------------ tests
describe('Fruity Slicer 2 registration', () => {
  it('has FL parameters, indices, ranges and defaults', () => {
    expect(def.id).toBe('slicer2');
    expect(def.notes).toBe('events');
    expect(def.defPoly).toBe(16);
    expect(def.width).toBe(1000);
    expect(def.height).toBe(300);
    expect(def.params).toHaveLength(5 + 8 * 128);
    const byIndex = new Map(def.params.map((p) => [p.index, p]));
    expect(byIndex.size).toBe(def.params.length);
    expect(byIndex.get(0)).toMatchObject({ name: 'Monophonic', min: 0, max: 1, def: 0 });
    expect(byIndex.get(1)).toMatchObject({ name: 'Cutoff', min: 0, max: 100000, def: 100000 });
    expect(byIndex.get(2)).toMatchObject({ name: 'Res', min: 0, max: 100000, def: 0 });
    expect(byIndex.get(3)).toMatchObject({ name: 'Transpose', min: -24, max: 24, def: 0 });
    expect(byIndex.get(4)).toMatchObject({ name: 'Detune', min: 0, max: 200, def: 100 });
    // FL's block order: Transpose, Detune, Gain, Pan, Attack, Release, Cutoff, Res (16 + 128 block + slice)
    expect(byIndex.get(16)!.name).toBe('Slice 1 Transpose');
    expect(byIndex.get(143)!.name).toBe('Slice 128 Transpose');
    expect(byIndex.get(144)).toMatchObject({ name: 'Slice 1 Detune', min: 0, max: 200, def: 100 });
    expect(byIndex.get(272)).toMatchObject({ name: 'Slice 1 Gain', min: 0, max: 200000, def: 153880 });
    expect(byIndex.get(400)).toMatchObject({ name: 'Slice 1 Pan', min: 0, max: 200000, def: 100000 });
    expect(byIndex.get(528)).toMatchObject({ name: 'Slice 1 Attack', min: 0, max: 100000, def: 0 });
    expect(byIndex.get(656)).toMatchObject({ name: 'Slice 1 Release', min: 0, max: 100000, def: 10000 });
    expect(byIndex.get(784)).toMatchObject({ name: 'Slice 1 Cutoff', min: 0, max: 100000, def: 100000 });
    expect(byIndex.get(1039)).toMatchObject({ name: 'Slice 128 Res', min: 0, max: 100000, def: 0 });
    for (const b of SL2_BLOCKS) for (const i of [0, 77, 127]) {
      const p = def.params.find((q) => q.key === sl2Key(b, i))!;
      expect(p.index).toBe(sl2Index(b, i));
      expect([p.min, p.max, p.def]).toEqual(SL2_BLOCK_RANGE[b]);
    }
  });

  it('shows FL value texts', () => {
    for (const [idx, v, text] of FL_TEXTS) {
      const p = def.params.find((q) => q.index === idx)!;
      expect(p.format ? p.format(v) : p.options![v - p.min], `parameter ${idx} = ${v}`).toBe(text);
    }
  });

  it("starts as FL's plugin database state and keeps its preset", () => {
    const s = def.state!();
    expect(s).toEqual(flDefaultState());
    expect((s.slices as Slicer2Slice[])).toHaveLength(1);
    expect((s.slices as Slicer2Slice[])[0].name).toBe('1');
    expect(s.g1).toBe(154000);
    expect(def.presets!.map((p) => p.name)).toEqual(['Default']);
    const round = JSON.parse(JSON.stringify(def.normalize!(s)));
    expect(def.normalize!(round)).toEqual(def.normalize!(s));
  });

  it('normalises stored states', () => {
    const q = normalizeSlicer2State({ slices: [{ start: 5, end: 2, key: 300, mode: 9, ftype: -1, name: 7 }, null], stretch: 7, gftype: 'x', chromatic: 4, sel: [99, -1, 'a'], tempo: NaN });
    const sl = q.slices as Slicer2Slice[];
    expect(sl).toHaveLength(2);
    expect(sl[0]).toMatchObject({ start: 5, key: 127, mode: 7, ftype: 0, name: '' });
    expect(q.stretch).toBe(2);
    expect(q.gftype).toBe(0);
    expect(q.chromatic).toBe(1);
    expect(q.sel).toEqual([99]);
    expect(q.tempo).toBe(120);
  });

  it('names the slice keys as FL (marker name or "Slice #n")', () => {
    const slices = [defaultSlice(0, 10), { ...defaultSlice(10, 20), name: 'Snare' }, { ...defaultSlice(20, 30), key: 40 }];
    const names = def.keyNames!({ ...defaultSlicer2State(), slices, baseKey: 60 });
    expect(names).toEqual({ 60: 'Slice #1', 61: 'Snare', 40: 'Slice #3' });
    expect(baseKeyFor(16)).toBe(60);
    expect(baseKeyFor(70)).toBe(48);
    expect(baseKeyFor(128)).toBe(-12 + 12);
    expect(sliceKey(slices, 60, 2)).toBe(40);
  });
});

describe('Fruity Slicer 2 slicing (FL beat detector)', () => {
  it("slices the loop like FL's load (medium auto-slicing, ends at the next start)", () => {
    for (const [stereo, ref] of [[false, FL_SLICES_MONO], [true, FL_SLICES_STEREO]] as const) {
      const ch = testLoop(stereo);
      const sl = loadSlices(ch, LOOP_SR, []);
      expect(sl.map((s) => [s.start, s.end])).toEqual(ref);
    }
  });

  it("uses a file's markers (each slice ends one frame before the next marker)", () => {
    const ch = testLoop(false);
    const sl = loadSlices(ch, LOOP_SR, [{ pos: 20000, name: 'b' }, { pos: 5000, name: 'a' }, { pos: 999999, name: 'x' }]);
    expect(sl.map((s) => [s.start, s.end, s.name])).toEqual([[5000, 19999, 'a'], [20000, 88199, 'b']]);
  });

  it('slices in beat divisions and "No slicing" like the Slicing menu', () => {
    const ch = testLoop(false);
    const beats = beatsOf(88200, LOOP_SR, 120);
    expect(beats).toBe(4);
    const b2 = menuSlices(ch, LOOP_SR, 102, beats, 'loop');
    expect(b2).toHaveLength(8);
    expect(b2.slice(0, 3).map((s) => [s.start, s.end, s.name])).toEqual([[0, 11024, '1 - Beat 1'], [11025, 22049, '2'], [22050, 33074, '3 - Beat 2']]);
    expect(b2[7].end).toBe(88199);
    expect(beatStarts(88200, 4, 3).slice(0, 4).map((m) => m.pos)).toEqual([0, 7350, 14700, 22050]);
    const none = menuSlices(ch, LOOP_SR, 0, beats, 'loop');
    expect(none.map((s) => [s.start, s.end, s.name])).toEqual([[0, 88199, 'loop']]);
    const sharp = menuSlices(ch, LOOP_SR, 22, beats, 'loop');
    expect(sharp.length).toBeGreaterThanOrEqual(FL_SLICES_MONO.length);
  });

  it("reads WAV markers and the ACID tempo", () => {
    const pts = [[1, 300], [2, 100]];
    const cue = new Uint8Array(4 + 24 * pts.length);
    const cv = new DataView(cue.buffer);
    cv.setUint32(0, pts.length, true);
    pts.forEach(([id, pos], i) => { cv.setUint32(4 + 24 * i, id, true); cv.setUint32(4 + 24 * i + 20, pos, true); });
    const labl = new Uint8Array(4 + 4 + 8 + 4);
    const lv = new DataView(labl.buffer);
    'adtl'.split('').forEach((c, i) => lv.setUint8(i, c.charCodeAt(0)));
    'labl'.split('').forEach((c, i) => lv.setUint8(4 + i, c.charCodeAt(0)));
    lv.setUint32(8, 8, true); lv.setUint32(12, 2, true); 'hat\0'.split('').forEach((c, i) => lv.setUint8(16 + i, c.charCodeAt(0)));
    const acid = new Uint8Array(24);
    new DataView(acid.buffer).setFloat32(20, 98.5, true);
    const chunk = (id: string, d: Uint8Array) => { const b = new Uint8Array(8 + d.length + (d.length & 1)); const v = new DataView(b.buffer); id.split('').forEach((c, i) => v.setUint8(i, c.charCodeAt(0))); v.setUint32(4, d.length, true); b.set(d, 8); return b; };
    const parts = [chunk('cue ', cue), chunk('LIST', labl), chunk('acid', acid), chunk('data', new Uint8Array(4))];
    const body = parts.reduce((n, p) => n + p.length, 4);
    const file = new Uint8Array(8 + body);
    const fv = new DataView(file.buffer);
    'RIFF'.split('').forEach((c, i) => fv.setUint8(i, c.charCodeAt(0))); fv.setUint32(4, body, true); 'WAVE'.split('').forEach((c, i) => fv.setUint8(8 + i, c.charCodeAt(0)));
    let o = 12; for (const p of parts) { file.set(p, o); o += p.length; }
    const m = parseWavMeta(file.buffer);
    expect(m.markers).toEqual([{ pos: 100, name: 'hat' }, { pos: 300, name: '' }]);
    expect(m.tempo).toBeCloseTo(98.5, 5);
    expect(parseWavMeta(new ArrayBuffer(3))).toEqual({ markers: [], tempo: 0 });
  });

  it("dumps the score like FL (Normal, Reverse, Swing, Accentuate, Pitch up, Widen, Original length, Shift up)", () => {
    const slices = FL_SLICES_MONO.map(([pos]) => ({ pos, key: -1, name: '', time: -1, rev: false }));
    for (const [mode, ref] of Object.entries(FL_DUMPS)) {
      const notes = dumpNotes({ slices, baseKey: 60, beats: 4, frames: 88200, rate: LOOP_SR, ppq: 96, stepsPerBeat: 4, tempo: 130 }, Number(mode), () => 0);
      expect(notes.map((n) => [n.pos, n.len, n.pan, n.vol, n.note, n.pitch]), `mode ${mode}`).toEqual(ref);
    }
  });
});

describe('Fruity Slicer 2 engine (FL 2026 renders)', () => {
  it("matches Apple's expf / tanf on spot values", () => {
    expect(expf(1)).toBe(f32(Math.E));
    expect(tanf(f32(0.5))).toBe(f32(0.5463024898437905));
    expect(midiVelocity(flLogVol(1))).toBe(100);
    expect(midiVelocity(flLogVol(1.28))).toBe(127);
    expect(midiVelocity(0)).toBe(0);
  });

  for (const c of FL_RENDERS) {
    it(`renders "${c.name}" bit for bit like FL`, () => {
      const { L, R } = render({ notes: c.notes, params: c.params, slices: sliceStates(c), stereo: c.stereo, chanVol: c.chanVol, chanPan: c.chanPan });
      for (const [i, l, r] of c.at) { expect(L[i], `L[${i}]`).toBe(f32(l)); expect(R[i], `R[${i}]`).toBe(f32(r)); }
      expect(fnv(L, R)).toBe(c.hash);
    });
  }
});

describe('Fruity Slicer 2 behaviour', () => {
  const rms = (x: Float32Array, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

  it('plays each slice from its key and stops at its end', () => {
    const { L } = render({ notes: '61:100:0:1.5', params: {}, secs: 1 });
    const len = FL_SLICES_MONO[1][1] - FL_SLICES_MONO[1][0];
    expect(rms(L, 0, len)).toBeGreaterThan(0.01);
    expect(rms(L, len + 200, 44100)).toBe(0);
  });

  it('transposes by resampling (+12 semitones halves the slice)', () => {
    const a = render({ notes: '60:100:0:1', params: {}, secs: 0.5 }).L;
    const b = render({ notes: '60:100:0:1', params: { t1: 12 }, secs: 0.5 }).L;
    const end = (x: Float32Array) => { let k = 0; for (let i = 0; i < x.length; i++) if (x[i] !== 0) k = i; return k; };
    expect(Math.abs(end(b) - end(a) / 2)).toBeLessThan(150);
  });

  it('follows gain, pan and the monophonic switch', () => {
    const a = render({ notes: '60:100:0:0.2', params: {}, secs: 0.2 });
    const g = render({ notes: '60:100:0:0.2', params: { g1: 0 }, secs: 0.2 });
    expect(rms(g.L)).toBe(0);
    const p = render({ notes: '60:100:0:0.2', params: { p1: 0 }, secs: 0.2 });
    expect(rms(p.R)).toBe(0);
    expect(rms(p.L)).toBeGreaterThan(rms(a.L));
    const poly = render({ notes: '60:100:0:0.5,64:100:0.1:0.5', params: {}, secs: 0.4 });
    const mono = render({ notes: '60:100:0:0.5,64:100:0.1:0.5', params: { mono: 1 }, secs: 0.4 });
    expect(rms(mono.L, 4500, 8000)).toBeLessThan(rms(poly.L, 4500, 8000));
  });

  it('stays finite at extreme settings, keys, velocities and levels', () => {
    const p: Record<string, unknown> = { mono: 1, cutoff: 0, res: 100000, transpose: 24, detune: 200, gftype: 2, stretch: 1 };
    for (const b of SL2_BLOCKS) for (let i = 0; i < 9; i++) p[sl2Key(b, i)] = i % 2 ? SL2_BLOCK_RANGE[b][1] : SL2_BLOCK_RANGE[b][0];
    const slices = FL_SLICES_MONO.map(([a, b], i) => ({ ...defaultSlice(a, b), mode: i % 8, ftype: i % 4 }));
    const notes = Array.from({ length: 30 }, (_, i) => `${(i * 37) % 128}:${(i * 13) % 129}:${(i * 0.03).toFixed(2)}:0.3:pan=${((i % 3) - 1)}:modx=${((i % 5) - 2) / 2}:fine=${(i % 7) * 300 - 900}`).join(',');
    for (const sr of [22050, 44100, 96000]) {
      for (const stretch of [0, 1, 2]) {
        const { L, R } = render({ notes, params: { ...p, stretch }, slices, secs: 1.2, sr, chanVol: 100, chanPan: -1 });
        for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error(`non-finite at ${i} (sr ${sr}, stretch ${stretch})`);
      }
    }
  });

  it('is silent without a sample and survives unknown samples', () => {
    const g = gen.create(SR, 512, { sample: () => undefined });
    g.setParams({ ...def.state!(), sample: 'missing' });
    const n = { id: 1, key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 }, levels: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 } } as GenNote;
    g.noteOn!(n, 0);
    const L = new Float32Array(512), R = new Float32Array(512);
    g.render!(L, R, 512, { sampleRate: SR, blockSize: 512, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 1 });
    expect(rms(L)).toBe(0);
    g.allNotesOff!();
    g.reset();
  });
});

describe('Fruity Slicer 2 in a channel', () => {
  it('plays its slices from pattern notes once the pool sample arrives', () => {
    const e = makeEngine();
    const ch = genChannel('slicer2');
    const loop = testLoop(false);
    ch.plugin!.params = normalizeSlicer2State({ ...ch.plugin!.params, sample: 'S', slices: FL_SLICES_MONO.map(([a, b]) => defaultSlice(a, b)) });
    e.handle({ t: 'channel', c: ch });
    e.handle({ t: 'sample', id: 'S', data: loop, sampleRate: LOOP_SR });
    // key 60 = slice 1 (a kick), key 63 = slice 4; the test engine runs at 48 kHz, 120 BPM (a step = 6000 frames)
    const [L, R] = play(e, [], { [ch.id]: [{ key: 60, pos: 0, len: 24 }, { key: 63, pos: 96, len: 24 }] }, 96000);
    expect(rmsU(L, 0, 6000)).toBeGreaterThan(0.01);
    expect(rmsU(R, 24000, 30000)).toBeGreaterThan(0.001);
    expect(rmsU(L, 13000, 23000)).toBe(0);
  });
});

describe('Fruity Slicer 2 editor operations (store)', async () => {
  const gl = globalThis as Record<string, unknown>;
  gl.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { addRaw } = await import('../../src/audio/samples');
  const ops = await import('../../src/ui/plugins/gen/slicer2/ops');

  it('loads audio, slices, sets BPM / BEATS and dumps the score into the piano roll', () => {
    const id = A.addGenChannel('slicer2');
    const slot = 'ch:' + id;
    const loop = testLoop(false);
    addRaw({ id: 'sl2-test', name: 'loop', channels: loop, sampleRate: LOOP_SR });
    ops.loadAudio(slot, 'sl2-test', 'loop.wav', { channels: loop, sampleRate: LOOP_SR }, { markers: [], tempo: 0 });
    const st = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    expect((st().slices as Slicer2Slice[]).map((x) => [x.start, x.end])).toEqual(FL_SLICES_MONO);
    expect(st().tempo).toBe(120);
    expect(st().beats).toBe(4);
    expect(st().baseKey).toBe(60);
    // auto-dump: FL's Normal dump at the project's PPQ (here the project's own grid)
    const pat = store.project.patterns.find((p) => p.id === store.project.currentPatternId)!;
    const notes = pat.notes[id];
    expect(notes.map((n) => n.key)).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68]);
    // Slicing menu: 1/2 beat
    ops.reslice(slot, 102);
    expect((st().slices as Slicer2Slice[]).length).toBe(8);
    expect((st().slices as Slicer2Slice[])[1]).toMatchObject({ start: 11025, end: 22049, name: '2' });
    // BPM 100 -> beats from the tempo
    ops.setTiming(slot, 'tempo', 100, true);
    expect(st().tempo).toBe(100);
    expect(st().beats).toBe(f32(f32(88200 * 100) / (LOOP_SR * 60)));
    // marker edits keep 128 slices at most and move per-slice settings with their slices
    A.setFxParam(slot, sl2Key('g', 2), 12345);
    ops.addMarker(slot, 5000);
    expect((st().slices as Slicer2Slice[])[1].start).toBe(5000);
    expect(st()[sl2Key('g', 3)]).toBe(12345);
    ops.deleteSlice(slot, 1);
    expect(st()[sl2Key('g', 2)]).toBe(12345);
    store.undo();
    expect((st().slices as Slicer2Slice[])[1].start).toBe(5000);
  });
});

describe('Fruity Slicer 2 editor', () => {
  const gl = globalThis as Record<string, unknown>;
  gl.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
  gl.document ??= { body: {}, getElementById: () => null };

  it('renders empty and loaded states', async () => {
    const { FxEditorContext } = await import('../../src/ui/plugins/kit');
    const mod = await import('../../src/ui/plugins/gen/slicer2');
    const html = (params: Record<string, unknown>) => renderToStaticMarkup(
      createElement(FxEditorContext.Provider, { value: { slotId: 'ch:test', plugin: 'slicer2', params, trackName: 'Slicer 2', pluginName: 'Slicer 2' } }, createElement(mod.editor.Editor)),
    );
    const base = { ...Object.fromEntries(def.params.map((p) => [p.key, p.def])), ...def.state!() };
    expect(html(base)).toContain('FRUITY SLICER 2');
    const many = normalizeSlicer2State({ ...base, slices: FL_SLICES_MONO.map(([a, b]) => defaultSlice(a, b)), sel: [2, 3], bank: 1, filterSlice: false, chromatic: 2 });
    const out = html(many);
    expect(out).toContain('2 SLICES');
    expect(out).toContain('FILTER MODE');
  });
});
