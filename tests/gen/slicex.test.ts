// Slicex: registration (FL's 352 parameters, ranges, defaults, value texts), state and presets,
// FL's load (tempo guess, auto-slicing) and Regions tools, score dumps and macros, the engine
// against FL 2026's own renders (bit-exact hashes, see slicex-golden.ts), parameter changes,
// voice lifetime and finiteness. No FL dependency: the audio is synthesized (slicex-audio.ts).
import { describe, expect, it } from 'vitest';
import { def } from '../../src/model/gen/plugins/slicex';
import { gen } from '../../src/engine/gen/plugins/slicex';
import { genPresetState } from '../../src/model/gen/registry';
import { DEFAULT_SETTINGS_RAW, settingsFromRaw } from '../../src/model/gen/plugins/slicex/defaults';
import { sxBaseNote, sxKeyLists, sxKeyNames, sxRegionEnd, sxRegionKey } from '../../src/model/gen/plugins/slicex/state';
import { parseSxWav } from '../../src/model/gen/plugins/slicex/wav';
import {
  sxAddMarker, sxAddRegion, sxAssignAll, sxAutoSlice, sxCloneRegion, sxDeleteRegion, sxGridSlice, sxGuessTempo, sxLoadDeck,
  sxMacro, sxMoveStart, sxSetAllCutGroups, sxSetOption, sxToMarker, sxToRegion, sxZeroCrossAll, type SxMacro,
} from '../../src/model/gen/plugins/slicex/ops';
import { SX_DUMP_MODES, sxDumpScore } from '../../src/model/gen/plugins/slicex/dump';
import type { SxArt, SxDeck } from '../../src/model/gen/plugins/slicex/types';
import type { GenNote } from '../../src/engine/gen/types';
import { SX_RAMP_CUES, SX_RAMP_LABELS, SX_RAMP_NOTES, SX_SR, sxLoop, sxLoop48, sxRamp, sxWav } from './slicex-audio';
import { caseState, fnv, renderCase, type SxAudioSet, type SxCase } from './slicex-render';
import { FL_DUMPS, FL_KEY_NAMES, FL_LAYER_SELECTIONS, FL_LOAD, FL_MACROS, FL_RENDERS, FL_TEXTS } from './slicex-golden';

const f32 = Math.fround;

const audio: Record<string, SxAudioSet> = (() => {
  const loop = sxLoop(false), loop48 = sxLoop48(), ramp = sxRamp();
  return {
    loop: { channels: loop, sampleRate: SX_SR, wav: sxWav(loop, SX_SR), file: 't_loop.wav' },
    loop48: { channels: loop48, sampleRate: 48000, wav: sxWav(loop48, 48000, { float: true }), file: 't_loop48.wav' },
    ramp: {
      channels: ramp, sampleRate: SX_SR, file: 't_ramp.wav',
      wav: sxWav(ramp, SX_SR, { cues: SX_RAMP_CUES, labels: SX_RAMP_LABELS, notes: SX_RAMP_NOTES }),
    },
  };
})();
const deckOf = (k: keyof typeof audio): SxDeck => {
  const a = audio[k];
  return sxLoadDeck({ channels: a.channels, sampleRate: a.sampleRate }, a.wav, a.file, 130);
};
const rms = (x: Float32Array, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

// ------------------------------------------------------------------ registration
describe('Slicex registration', () => {
  it("has FL's 352 parameters with FL's indices, names, ranges and defaults", () => {
    expect(def.params.length).toBe(352);
    const idx = def.params.map((p) => p.index).sort((a, b) => a! - b!);
    expect(idx).toEqual(Array.from({ length: 352 }, (_, i) => i));
    const by = (i: number) => def.params.find((p) => p.index === i)!;
    expect([by(2).name, by(2).min, by(2).max, by(2).def]).toEqual(['Master level', 0, 16000, 12800]);
    expect([by(3).name, by(3).max, by(3).def]).toEqual(['Master randomness level', 256, 256]);
    expect([by(4).name, by(4).min, by(4).max]).toEqual(['Master LFO level', -128, 128]);
    expect([by(5).name, by(5).min, by(5).max, by(5).def]).toEqual(['Master pitch', -1200, 1200, 0]);
    expect([by(6).name, by(6).max, by(6).def]).toEqual(['Modulation X', 512, 256]);
    expect(by(8).name).toBe('Art group 1 - Filter cutoff envelope / LFO amount');
    expect(by(15).name).toBe('Art group 1 - Panning - LFO speed (phase)');
    expect([by(15).min, by(15).max, by(15).def]).toEqual([512, 65536, 31102]);
    expect(by(8 + 43 * 7 + 3 + 8 * 4 + 7).name).toBe('Art group 8 - Speed - LFO pulse width');
  });

  it("formats values exactly like FL (sampled from FL's GetParamText)", () => {
    for (const [i, v, text] of FL_TEXTS) {
      const p = def.params.find((q) => q.index === i)!;
      expect(p.format!(v), `param ${i} = ${v}`).toBe(text);
    }
  });
});

// ------------------------------------------------------------------ state, presets
describe('Slicex state and presets', () => {
  it('starts empty like FL, with the plugin database defaults', () => {
    const s = def.state!();
    expect(s.sampleA).toBeNull();
    expect((s.deckA as SxDeck).regions).toEqual([]);
    expect((s.opt as { raw: number[] }).raw).toEqual(DEFAULT_SETTINGS_RAW);
    expect((s.arts as unknown[]).length).toBe(8);
  });

  it('normalises stably and survives JSON', () => {
    const st = caseState({ name: 'x', audio: 'ramp', notes: '', secs: 0 }, audio.ramp);
    const n1 = def.normalize!(JSON.parse(JSON.stringify(st)));
    expect(def.normalize!(JSON.parse(JSON.stringify(n1)))).toEqual(n1);
  });

  it("applies FL's factory presets and keeps the loaded audio (Lock audio data)", () => {
    const names = def.presets!.map((p) => p.name);
    expect(names).toEqual(['Default', 'Minimal', 'Sustaining']);
    const cur = caseState({ name: 'x', audio: 'loop', notes: '', secs: 0 }, audio.loop);
    const min = genPresetState('slicex', def.presets![1], cur);
    expect((min.opt as { dispMode: number }).dispMode).toBe(3);
    expect((min.deckA as SxDeck).regions.length).toBe((cur.deckA as SxDeck).regions.length);
    const sus = genPresetState('slicex', def.presets![2], cur);
    expect(((sus.arts as { t: { env: { m: number[] } }[] }[])[0].t[1].env.m[1])).toBe(-1);
  });

  it('keeps the option block and the named options in step', () => {
    let o = settingsFromRaw(DEFAULT_SETTINGS_RAW);
    expect(o.autoDump).toBe(true);
    o = sxSetOption(o, 'autoDump', false);
    expect(o.autoDump).toBe(false);
    expect(o.raw[0x132a - 0x1304]).toBe(0);
    o = sxSetOption(o, 'lmode', 6);
    expect(o.lmode).toBe(6);
    expect(o.raw[0]).toBe(6);
    o = sxSetOption(o, 'dispMode', 2);
    expect(o.dispMode).toBe(2);
  });
});

// ------------------------------------------------------------------ loading, slicing
describe("Slicex loading and FL's slicing", () => {
  for (const k of ['loop', 'loop48', 'ramp'] as const) {
    it(`loads "${k}" with FL's regions and tempo`, () => {
      const d = deckOf(k);
      expect(f32(d.tempo)).toBe(f32(FL_LOAD[k].tempo));
      expect(d.regions.map((r) => [r.s, r.e, r.name, r.note, r.pur])).toEqual(FL_LOAD[k].regions);
    });
  }

  it("guesses tempo like FL (whole bars of the project tempo, 30..240 BPM)", () => {
    expect(sxGuessTempo(44100, 44100, 130)).toEqual({ tempo: 120, beats: 2 });
    expect(sxGuessTempo(66150, 44100, 130)).toEqual({ tempo: 160, beats: 4 });
    expect(sxGuessTempo(882000, 44100, 170)).toEqual({ tempo: 168, beats: 56 });
    expect(sxGuessTempo(220500, 44100, 90)).toEqual({ tempo: 96, beats: 8 });
  });

  it('reads the regions FL keeps in WAVs (cue, labels, trigger notes)', () => {
    const w = parseSxWav(audio.ramp.wav)!;
    expect(w.regions.map((r) => r.s)).toEqual(SX_RAMP_CUES);
    expect(w.regions.map((r) => r.name)).toEqual(SX_RAMP_LABELS);
    expect(w.regions.map((r) => r.note)).toEqual(SX_RAMP_NOTES.map((n) => n ?? -1));
  });

  it('auto-slices dull / medium / sharp and grid-slices, replacing slice regions only', () => {
    const a = { channels: audio.loop.channels, sampleRate: SX_SR };
    const d0 = deckOf('loop');
    const med = sxAutoSlice(d0, a, 1, null);
    expect(med.regions.map((r) => r.s)).toEqual(d0.regions.map((r) => r.s));
    const dull = sxAutoSlice(d0, a, 0, null).regions.length, sharp = sxAutoSlice(d0, a, 2, null).regions.length;
    expect(dull).toBeLessThanOrEqual(med.regions.length);
    expect(sharp).toBeGreaterThanOrEqual(med.regions.length);
    // a loop region (purpose 0) survives slicing
    const withLoop = { ...d0, regions: [...d0.regions, { ...d0.regions[1], pur: 0, s: 5000, e: 9000 }] };
    expect(sxAutoSlice(withLoop, a, 1, null).regions.some((r) => r.pur === 0)).toBe(true);
    // beats at the deck's tempo (160 BPM: a beat = 16537.5 frames)
    const g = sxGridSlice(d0, a, 1, null, 130);
    expect(g.regions.slice(0, 3).map((r) => r.s)).toEqual([0, 16538, 33075]);
    expect(sxGridSlice(d0, a, 1, [0, 20000], 130).regions.filter((r) => r.s <= 20000).map((r) => r.s)).toEqual([0, 16538]);
  });

  it('moves region starts to zero crossings', () => {
    const a = { channels: audio.ramp.channels, sampleRate: SX_SR };
    const d = sxZeroCrossAll({ ...deckOf('ramp'), regions: deckOf('ramp').regions.map((r) => ({ ...r, s: r.s + 300 })) }, a);
    for (const r of d.regions) if (r.s > 0) expect(Math.abs(audio.ramp.channels[0][r.s])).toBeLessThan(0.01);
  });

  it('edits regions keeping them sorted and their settings attached', () => {
    const d0 = { ...deckOf('loop'), regions: deckOf('loop').regions.map((r, i) => ({ ...r, cut: i })) };
    const n = audio.loop.channels[0].length;
    const m = sxAddMarker(d0, 5000, n);
    expect(m.index).toBe(1);
    expect(m.deck.regions[2].cut).toBe(1);
    const r = sxAddRegion(m.deck, 40000, 30000, n);
    expect([r.deck.regions[r.index].s, r.deck.regions[r.index].e]).toEqual([30000, 40000]);
    const mv = sxMoveStart(d0, 0, 25000, n);
    expect(mv.deck.regions[mv.index].cut).toBe(0);
    expect(sxDeleteRegion(d0, 0).regions.length).toBe(d0.regions.length - 1);
    const reg = sxToRegion(d0, 2, n);
    expect(reg.regions[2].e).toBe(d0.regions[3].s - 1);
    expect(sxToMarker(reg, 2).regions[2].e).toBe(-1);
    expect(sxCloneRegion(d0, 3, 100, 200, n).deck.regions[1].cut).toBe(3);
    expect(sxSetAllCutGroups(d0, 150).regions.every((x) => x.cut === 99)).toBe(true);
  });

  it("assigns keys like FL's Regions > Assign menu", () => {
    const d = deckOf('loop');
    expect(sxAssignAll(d, 1).regions.slice(0, 5).map((r) => r.note)).toEqual([60, 62, 64, 65, 67]);
    expect(sxAssignAll(d, 2).regions.slice(0, 4).map((r) => r.note)).toEqual([61, 63, 66, 68]);
    expect(sxAssignAll(d, 4).regions.every((r) => r.note === 60)).toBe(true);
    const mpc = sxAssignAll(d, 5);
    expect(mpc.regions.slice(0, 4).map((r) => r.note)).toEqual([37, 36, 42, 82]);
    expect(mpc.regions[0].name).toBe('Pad #1');
    const tf = sxAssignAll({ ...d, regions: [...d.regions, ...d.regions] }, 6).regions.map((r) => r.note);
    expect(tf.slice(15, 18)).toEqual([53, 59, 60]);
    expect(sxBaseNote(80)).toBe(36);
    expect(sxRegionKey(d, 3)).toBe(63);
  });
});

// ------------------------------------------------------------------ dumps, macros
describe("Slicex score dumps and macros (FL's results)", () => {
  const ctx = (k: keyof typeof audio) => ({ ppq: 96, stepsPerBeat: 4, tempo: 130, frames: audio[k].channels[0].length, sampleRate: audio[k].sampleRate });
  it('lists the dump menu with its tags', () => {
    expect(SX_DUMP_MODES.filter((m) => m.mode >= 0).map((m) => m.mode)).toEqual([0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 13, 14, 16, 17, 19]);
  });
  for (const [key, notes] of Object.entries(FL_DUMPS)) {
    it(`dumps "${key}" like FL`, () => {
      const [src, m] = key.split(':');
      const deckB = src === 'rampB';
      const d = deckOf(deckB ? 'ramp' : (src as 'loop' | 'ramp'));
      const deck = deckB ? { ...d, regions: d.regions.map((r, i) => ({ ...r, vol: 5000 + i * 700 })) } : d;
      const got = sxDumpScore(deck, Number(m), ctx(deckB ? 'ramp' : (src as 'loop' | 'ramp')), deckB ? 1 : 0, () => 0);
      expect(got.map((x) => [x.pos, x.len, x.pan, x.key, f32(x.vol), x.color, x.pitch])).toEqual(notes.map((x) => [x[0], x[1], x[2], x[3], f32(x[4]), x[5], x[6]]));
    });
  }
  for (const [kinds, want] of Object.entries(FL_MACROS)) {
    it(`runs the "${kinds}" macro like FL`, () => {
      const a = deckOf('ramp');
      const b = { ...a, regions: a.regions.map((r, i) => ({ ...r, vol: 5000 + i * 700 })) };
      const au = { channels: audio.ramp.channels, sampleRate: SX_SR };
      let decks: SxDeck[] = [a, b];
      let arts = def.state!().arts as SxArt[];
      for (const k of kinds.split('+')) ({ decks, arts } = sxMacro(decks, arts, k as SxMacro, { audio: [au, au], sameDeck: false }));
      expect(decks.map((d) => d.regions.map((r) => [r.note, r.vol, r.aArt]))).toEqual(want);
    });
  }
  it('layers the selections of both decks like FL', () => {
    const a = deckOf('ramp'), au = { channels: audio.ramp.channels, sampleRate: SX_SR };
    for (const c of FL_LAYER_SELECTIONS) {
      const r = sxMacro([a, a], [], 'layerSelections', { sels: c.sels, audio: [au, au] });
      expect(r.decks.map((d) => d.regions.map((x) => x.note))).toEqual(c.notes);
    }
  });
});

// ------------------------------------------------------------------ renders vs FL
describe("Slicex renders bit for bit like FL", () => {
  for (const c of FL_RENDERS) {
    it(c.name, () => {
      const { L, R } = renderCase(c, audio[c.audio]);
      for (const [i, l, r] of c.at) { expect(L[i], `L[${i}]`).toBe(f32(l)); expect(R[i], `R[${i}]`).toBe(f32(r)); }
      expect(fnv(L, R)).toBe(c.hash);
    });
  }
});

// ------------------------------------------------------------------ behaviour
describe('Slicex behaviour', () => {
  const base: SxCase = { name: 'b', audio: 'loop', notes: '60:100:0:0.3', secs: 0.6 };

  it('follows the master level and pitch', () => {
    const a = renderCase(base, audio.loop).L;
    const b = renderCase({ ...base, params: { 2: 6400 } }, audio.loop).L;
    expect(rms(b) / rms(a)).toBeLessThan(0.4);
    const end = (x: Float32Array) => { let k = 0; for (let i = 0; i < x.length; i++) if (x[i] !== 0) k = i; return k; };
    const hi = renderCase({ ...base, notes: '60:100:0:0.5', params: { 5: 1200 } }, audio.loop).L;
    const lo = renderCase({ ...base, notes: '60:100:0:0.5' }, audio.loop).L;
    expect(Math.abs(end(hi) - end(lo) / 2)).toBeLessThan(1500);
  });

  it('plays a region to its end and frees the voice', () => {
    const st = caseState(base, audio.loop);
    const g = gen.create(44100, 512, { sample: () => ({ channels: audio.loop.channels, sampleRate: SX_SR }) });
    g.setParams({ ...st, sampleA: 'A' });
    const note = { id: 1, key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 }, levels: { pan: 0, vol: 1, pitch: 0, fcut: 0, fres: 0 } } as GenNote;
    g.noteOn!(note, 0);
    const L = new Float32Array(512), R = new Float32Array(512);
    const ctx = { sampleRate: 44100, blockSize: 512, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
    let blocks = 0;
    while (g.isActive?.() && blocks < 200) { L.fill(0); R.fill(0); g.render!(L, R, 512, ctx); blocks++; }
    const len = sxRegionEnd(st.deckA as SxDeck, 0, audio.loop.channels[0].length) + 1;
    expect(blocks * 512).toBeGreaterThanOrEqual(len);
    expect(blocks * 512).toBeLessThan(len + 2048);
    expect(g.isActive?.()).toBe(false);
  });

  it('renders finite audio for random settings and extreme values', () => {
    let s = 7;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
    for (let k = 0; k < 6; k++) {
      const params: Record<number, number> = {};
      for (const p of def.params) if (p.index! >= 2 && rnd() < 0.3) params[p.index!] = rnd() < 0.5 ? p.min : p.max;
      const c: SxCase = {
        name: 'r', audio: k % 2 ? 'ramp' : 'loop', secs: 0.8, notes: '60:127:0:0.4,61:1:0.1:0.3,64:100:0.2:0.4:color=15,72:60:0.3:0.3',
        params, patch: { hdr: [[0, k % 4, (k % 3) + 1]], rg: { fAmt: 12800, sAmt: 12800, oAmt: 12800, delay: 300 }, opt: { 4868: k + 1, 4872: k % 5 } },
      };
      const { L, R } = renderCase(c, audio[c.audio]);
      for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error(`non-finite at ${i} (case ${k})`);
    }
  });

  it('maps keys to both decks like FL (trigger notes, base note, same deck)', () => {
    const a = deckOf('ramp'), b = deckOf('loop');
    const lists = sxKeyLists([a, b], false);
    expect(lists[0][60].length).toBe(3);
    expect(lists[1][60].map((e) => e >> 16)).toEqual([0, 0, 0]);
    expect(sxKeyLists([a, b], true)[1][60].map((e) => e >> 16)).toEqual([1]);
  });

  it("names keys like FL's piano roll (GetName FPN_Semitone)", () => {
    const st = caseState({ name: 'k', audio: 'ramp', notes: '', secs: 0, patch: { deckB: true } }, audio.ramp);
    expect(sxKeyNames(st)).toEqual(FL_KEY_NAMES);
  });

  it('reports playing regions, the last key and velocity', () => {
    const st = caseState(base, audio.loop);
    const g = gen.create(44100, 512, { sample: () => ({ channels: audio.loop.channels, sampleRate: SX_SR }) });
    g.setParams({ ...st, sampleA: 'A' });
    const note = { id: 1, key: 62, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: { pan: 0, vol: 1, pitch: 6200, fcut: 0, fres: 0 }, levels: { pan: 0, vol: 1, pitch: 0, fcut: 0, fres: 0 } } as GenNote;
    g.noteOn!(note, 0);
    const L = new Float32Array(512), R = new Float32Array(512);
    g.render!(L, R, 512, { sampleRate: 44100, blockSize: 512, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 });
    const m = g.monitor?.() as { play: number[]; key: number; vel: number };
    expect(m.key).toBe(62);
    expect(m.play.slice(0, 2)).toEqual([0, 2]);
    expect(m.vel).toBeGreaterThan(0);
    g.killNote?.(note);
    expect(g.isActive?.()).toBe(false);
  });
});
