// SoundFont Player (FL: Soundfont Player, Misc): registration (FL's parameter list, value texts, state), the model helpers,
// the defensive SF2 parser (valid and hostile files), the engine (silent default, presets, program mode, options), FL's behaviours
// pinned from the test host (tests/gen/soundfont-golden.ts, scenarios in tests/gen/soundfont-scenarios.ts) and finiteness at
// extreme fonts / settings. The editor is tested in tests/gen/soundfont-editor.test.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGen, hasGen } from '../../src/engine/gen';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';
import { DEFAULT_MODS, defaultControls, modValue } from '../../src/engine/gen/plugins/soundfont/mod';
import { SfEnv } from '../../src/engine/gen/plugins/soundfont/env';
import { defaultGenParams, formatParam, genDef, genInCategory, normalizeGenParams } from '../../src/model/gen/registry';
import { G as GEN } from '../../src/model/gen/plugins/soundfont/gens';
import { importSf2, POOL_WAV_RATE } from '../../src/model/gen/plugins/soundfont/import';
import {
  base64ToBytes, bytesToBase64, hydraFromState, isSf2Error, parseHydra, parseSf2, sf2Pcm, sf2Wav, SF2_MAX_BYTES,
} from '../../src/model/gen/plugins/soundfont/sf2';
import {
  bankProgram, currentPreset, fontHydra, patchOf, presetList, sendLevel, sfInitialState, sfNormalize, sfState, SF_DEFAULTS,
} from '../../src/model/gen/plugins/soundfont/state';
import { GOLDEN, GOLDEN_WINDOW } from './soundfont-golden';
import { SCENARIOS } from './soundfont-scenarios';
import {
  G, MOD_KEY, MOD_VEL, Sf2Writer, allFinite, dB, driver, hostPreroll, modSrc, noiseData, peak, renderFont, rms, simpleFont, sineData,
  type RenderNote, type SfZoneDef,
} from './soundfont-util';

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (const c of new TextEncoder().encode(s)) { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};
const n = (key: number, vel: number, start: number, dur: number): RenderNote => ({ key, vel, start, dur });
const LOOP = { [G.sampleModes]: 1 };

/** A font with a melodic preset (a sine, 441 Hz at key 60), a drum kit preset (bank 128, a sine an octave up) and a second program. */
function presetFont(): Uint8Array {
  const w = new Sf2Writer();
  const a = w.addSample({ name: 'a', data: sineData(100, 4), root: 60, loop: [0, 400] });
  const b = w.addSample({ name: 'b', data: sineData(50, 8, 20000), root: 60, loop: [0, 400] });
  const ia = w.addInstrument('ia', [{ gens: { [G.sampleID]: a, ...LOOP } }]);
  const ib = w.addInstrument('ib', [{ gens: { [G.sampleID]: b, ...LOOP } }]);
  w.addPreset('Zeta', 5, 1, [{ gens: { [G.instrument]: ib } }]);
  w.addPreset('Piano', 0, 0, [{ gens: { [G.instrument]: ia } }]);
  w.addPreset('Kit', 0, 128, [{ gens: { [G.instrument]: ib } }]);
  w.addPreset('Organ', 16, 0, [{ gens: { [G.instrument]: ib } }]);
  return w.build();
}

/** Estimated frequency (Hz) of a mono signal from its rising zero crossings. */
function freq(x: Float32Array, sr = 44100, a = 1000, b = 20000): number {
  const idx: number[] = [];
  for (let i = a; i < Math.min(b, x.length - 1); i++) if (x[i] <= 0 && x[i + 1] > 0) idx.push(i + -x[i] / (x[i + 1] - x[i]));
  return idx.length > 2 ? (sr * (idx.length - 1)) / (idx[idx.length - 1] - idx[0]) : 0;
}

// ===================================================================================================== registration
describe('SoundFont Player: registration', () => {
  const def = genDef('soundfont')!;

  it('is a Misc instrument with FL\'s form size, polyphony and note model', () => {
    expect(def.name).toBe('SoundFont Player');
    expect(def.category).toBe('Misc');
    expect(def.notes).toBe('events');
    expect(def.velocity).toBe('plugin');
    expect(def.defPoly).toBe(8192);
    expect([def.width, def.height]).toEqual([370, 385]);
    expect(genInCategory('Misc').map((d) => d.id)).toContain('soundfont');
    expect(hasGen('soundfont')).toBe(true);
    expect(def.presets ?? []).toEqual([]);
  });

  it('has FL\'s 13 parameters (names, indices, ranges, defaults)', () => {
    const want: [string, string, number, number, number, number][] = [
      ['patch', 'Patch', 0, 1, 256, 1], ['bank', 'Bank number', 1, 0, 127, 0],
      ['revSend', 'Reverb send level (multiplier)', 2, 0, 256, 128], ['chorSend', 'Chorus send level (multiplier)', 3, 0, 256, 128],
      ['mod', 'Modulation', 4, 0, 127, 0],
      ['envAtk', 'Env 2 attack time', 5, -1, 5940, -1], ['envDec', 'Env 2 decay time', 6, -1, 5940, -1],
      ['envSus', 'Env 2 sustain level', 7, -1, 127, -1], ['envRel', 'Env 2 release time', 8, -1, 5940, -1],
      ['lfoDelay', 'LFO 2 predelay', 9, -1, 5900, -1], ['lfoAmt', 'LFO 2 amount', 10, -128, 127, -128],
      ['lfoSpeed', 'LFO 2 speed', 11, -1, 127, -1], ['cutoff', 'Initial filter cutoff', 12, -1, 127, -1],
    ];
    expect(def.params.map((p) => [p.key, p.name, p.index, p.min, p.max, p.def])).toEqual(want);
  });

  it('formats every value like FL (the host\'s sweeps, fingerprinted)', () => {
    const want: Record<string, [number, number, string]> = {
      patch: [1, 256, 'cd3242a7'], bank: [0, 127, '2a2bf1ab'], revSend: [0, 256, 'a98316a0'], chorSend: [0, 256, 'a98316a0'],
      mod: [0, 127, '2a2bf1ab'], envAtk: [-1, 5940, '0b425261'], envDec: [-1, 5940, '0b425261'], envSus: [-1, 127, '515d4c96'],
      envRel: [-1, 5940, '0b425261'], lfoDelay: [-1, 5900, '30ea8751'], lfoAmt: [-128, 127, '809edb67'], lfoSpeed: [-1, 127, '515d4c96'],
      cutoff: [-1, 127, '515d4c96'],
    };
    for (const p of def.params) {
      const [lo, hi, h] = want[p.key];
      let body = '';
      for (let v = lo; v <= hi; v++) body += `${v}\t${formatParam(p, v)}\n`;
      expect(fnv(body), p.key).toBe(h);
    }
    const send = def.params[2];
    expect([0, 20, 60, 100, 128, 160, 200, 240, 256].map((v) => formatParam(send, v))).toEqual(['0%', '3%', '17%', '50%', '100%', '215%', '548%', '1382%', '2000%']);
    expect(formatParam(def.params[5], -1)).toBe('Disabled');
    expect(formatParam(def.params[10], -128)).toBe('Disabled');
    expect(formatParam(def.params[10], -127)).toBe('-127');
  });

  it('starts a new instance from FL\'s plugin database state: empty, patch 1, bank 0, effects off, Standard resampling', () => {
    expect(defaultGenParams('soundfont')).toMatchObject({
      patch: 1, bank: 0, revSend: 128, chorSend: 128, mod: 0, envAtk: -1, envDec: -1, envSus: -1, envRel: -1, lfoDelay: -1, lfoAmt: -128,
      lfoSpeed: -1, cutoff: -1, fonts: [], active: 0, resampling: 4, programMode: 0, velFc: 1, emu: 1, ignoreLinks: 1, revOn: 0, chorOn: 0,
      revTo: 0, chorTo: 0, useRevLevel: 1, useChorLevel: 1,
    });
    expect(sfInitialState()).toMatchObject({ fonts: [], resampling: 4 });
  });

  it('repairs stored states (types, ranges, damaged fonts)', () => {
    const s = sfState({
      fonts: [null, 3, { sample: 'a', hydra: 'xx', name: 5, rate: -4, frames: 'many', has24: 'yes' }, { sample: 'b' }, { sample: 'c', hydra: 'h', rate: 1e12, frames: 1e15 }],
      active: 99, resampling: 5, programMode: 9, revTo: 999, chorTo: -999, velFc: 0, emu: 'x', revOn: 2,
    });
    expect(s.fonts.length).toBe(2);
    expect(s.fonts[0]).toMatchObject({ name: 'SoundFont', sample: 'a', rate: 1000, frames: 0, has24: false });
    expect(s.fonts[1].rate).toBe(768000);
    expect(s).toMatchObject({ active: 1, resampling: 4, programMode: 2, revTo: 125, chorTo: -125, velFc: false, emu: true, revOn: true, chorOn: false });
    expect(sfState({}).fonts).toEqual([]);
    expect(sfState({ fonts: 'nope', active: 3 }).active).toBe(0);
    // the framework's repair path
    const bad = normalizeGenParams('soundfont', { resampling: 'x', fonts: {}, active: -4, programMode: -1, patch: 7 });
    expect(bad).toMatchObject({ resampling: 4, fonts: [], active: 0, programMode: 0, patch: 7 });
    const roundtrip = sfNormalize({ ...defaultGenParams('soundfont'), velFc: true, revOn: false });
    expect(roundtrip).toMatchObject({ velFc: 1, revOn: 0 });
    expect(JSON.parse(JSON.stringify(roundtrip))).toEqual(roundtrip);
  });
});

// ===================================================================================================== model helpers
describe('SoundFont Player: model helpers', () => {
  it('maps FL\'s patch / bank parameters to MIDI bank / program (0x5eec0)', () => {
    expect(bankProgram(1, 0)).toEqual({ bank: 0, program: 0 });
    expect(bankProgram(128, 0)).toEqual({ bank: 0, program: 127 });
    expect(bankProgram(129, 0)).toEqual({ bank: 128, program: 0 });
    expect(bankProgram(256, 127)).toEqual({ bank: 255, program: 127 });
    expect(bankProgram(0, -4)).toEqual({ bank: 0, program: 0 });
    for (const [bank, program] of [[0, 0], [0, 127], [5, 9], [127, 3], [128, 0], [128, 127], [200, 4]]) {
      const p = patchOf(bank, program);
      expect(bankProgram(p.patch, p.bank)).toEqual({ bank, program });
    }
  });

  it('computes FL\'s send level multiplier (19^(v / 128) - 1) / 18', () => {
    expect(sendLevel(0)).toBe(0);
    expect(sendLevel(128)).toBeCloseTo(1, 12);
    expect(sendLevel(256)).toBeCloseTo(20, 12);
    expect(sendLevel(64)).toBeCloseTo((Math.sqrt(19) - 1) / 18, 12);
  });

  it('lists the presets in FL\'s order (bank, program) and plays the first when the patch is unknown', () => {
    const imp = importSf2(presetFont());
    if ('error' in imp) throw new Error(imp.error);
    const font = { ...imp.font, sample: 's' };
    const list = presetList(fontHydra(font));
    expect(list.map((e) => [e.name, e.bank, e.program])).toEqual([['Piano', 0, 0], ['Organ', 0, 16], ['Zeta', 1, 5], ['Kit', 128, 0]]);
    expect(currentPreset(list, 1, 0)!.name).toBe('Piano');
    expect(currentPreset(list, 17, 0)!.name).toBe('Organ');
    expect(currentPreset(list, 6, 1)!.name).toBe('Zeta');
    expect(currentPreset(list, 129, 0)!.name).toBe('Kit');
    expect(currentPreset(list, 100, 100)!.name).toBe('Piano');
    expect(currentPreset([], 1, 0)).toBeUndefined();
    expect(presetList(null)).toEqual([]);
    expect(fontHydra(undefined)).toBeNull();
  });
});

// ===================================================================================================== SF2 parser
describe('SoundFont Player: SF2 parser', () => {
  it('reads a valid font: names, tables, sample headers and the pool data', () => {
    const w = new Sf2Writer();
    w.name = 'My font';
    const s = w.addSample({ name: 'tone', data: sineData(100, 4), rate: 22050, root: 62, corr: -7, loop: [10, 390] });
    const i = w.addInstrument('inst', [{ gens: { [G.keyRange]: [0, 90], [G.sampleID]: s, [G.pan]: -100 }, mods: [[modSrc(MOD_VEL), G.pan, 100, 0, 0]] }]);
    w.addPreset('p1', 3, 2, [{ gens: { [G.instrument]: i } }]);
    const bytes = w.build();
    const info = parseSf2(bytes);
    if (isSf2Error(info)) throw new Error(info.error);
    expect(info).toMatchObject({ name: 'My font', version: [2, 1], frames: 400 + 46, has24: false });
    const h = info.hydra;
    expect(h.presets.map((p) => [p.name, p.program, p.bank])).toEqual([['p1', 3, 2], ['EOP', 0, 0]]);
    expect(h.insts.map((x) => x.name)).toEqual(['inst', 'EOI']);
    expect(h.samples).toEqual([expect.objectContaining({ name: 'tone', start: 0, end: 400, loopStart: 10, loopEnd: 390, rate: 22050, pitch: 62, correction: -7, type: 1 })]);
    expect(h.imod).toEqual([{ src: modSrc(MOD_VEL), dest: G.pan, amount: 100, amtSrc: 0, trans: 0 }, { src: 0, dest: 0, amount: 0, amtSrc: 0, trans: 0 }]);
    const pcm = sf2Pcm(bytes, info);
    expect(pcm.length).toBe(446);
    expect(pcm[25]).toBeCloseTo(Math.round(30000 * Math.sin((2 * Math.PI * 25) / 100)) / 32768, 7);
    const wav = sf2Wav(bytes, info);
    expect(String.fromCharCode(...wav.subarray(0, 4)) + String.fromCharCode(...wav.subarray(8, 12))).toBe('RIFFWAVE');
    expect(new DataView(wav.buffer).getUint16(34, true)).toBe(16);
    expect(wav.length).toBe(44 + 446 * 2);
    const imp = importSf2(bytes);
    if ('error' in imp) throw new Error(imp.error);
    expect(imp.font).toMatchObject({ name: 'My font', rate: POOL_WAV_RATE, frames: 446, has24: false });
    expect(parseHydra(base64ToBytes(imp.font.hydra)!)!.presets[0].name).toBe('p1');
    expect(hydraFromState(imp.font.hydra)!.samples.length).toBe(1);
    expect(hydraFromState('')).toBeNull();
    expect(hydraFromState(5)).toBeNull();
  });

  it('plays the 16 bit part of a 24 bit font: FL ignores the sm24 chunk', () => {
    const w = new Sf2Writer();
    w.sm24 = true;
    const s = w.addSample({ data: [8388607, -8388608, 1234567, 0], loop: [0, 4] });
    const i = w.addInstrument('i', [{ gens: { [G.sampleID]: s } }]);
    w.addPreset('p', 0, 0, [{ gens: { [G.instrument]: i } }]);
    const bytes = w.build();
    const info = parseSf2(bytes);
    if (isSf2Error(info)) throw new Error(info.error);
    expect(info.has24).toBe(false);
    expect(info.sm24).toBeNull();
    const pcm = sf2Pcm(bytes, info);
    expect(Array.from(pcm.subarray(0, 4)).map((v) => Math.round(v * 32768))).toEqual([32767, -32768, 4822, 0]);
    const wav = sf2Wav(bytes, info);
    expect(new DataView(wav.buffer).getUint16(34, true)).toBe(16);
    expect(wav.length).toBe(44 + info.frames * 2);
  });

  it('encodes base64 without atob / btoa and tolerates damaged text', () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37 + 11) & 255);
    expect(base64ToBytes(bytesToBase64(data))).toEqual(data);
    for (const len of [0, 1, 2, 3, 4, 5]) {
      const d = data.subarray(0, len);
      const back = base64ToBytes(bytesToBase64(d));
      expect(back === null ? new Uint8Array(0) : back).toEqual(d);
    }
    expect(base64ToBytes('???')).toBeNull();
    expect(base64ToBytes('QUJDé中REVG')).toEqual(Uint8Array.from([65, 66, 67, 68, 69, 70]));
  });

  const base = presetFont();
  const w32 = (b: Uint8Array, o: number, v: number): void => { new DataView(b.buffer, b.byteOffset).setUint32(o, v >>> 0, true); };
  /** Offsets of the chunks in a font (first match). */
  function find(b: Uint8Array, id: string): number {
    for (let i = 12; i + 8 <= b.length; i++) if (String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]) === id) return i;
    return -1;
  }
  const mutate = (f: (b: Uint8Array) => void): Uint8Array => { const b = Uint8Array.from(base); f(b); return b; };

  /** What every input must satisfy: no throw; an error text or a font that plays (finite output) for all of its presets. */
  function survives(bytes: Uint8Array): 'error' | 'ok' {
    const imp = importSf2(bytes);
    if ('error' in imp) { expect(typeof imp.error).toBe('string'); expect(imp.error.length).toBeGreaterThan(5); return 'error'; }
    const font = { ...imp.font, sample: 's' };
    for (const e of presetList(fontHydra(font)).slice(0, 6)) {
      const pb = patchOf(e.bank, e.program);
      const { L, R } = renderFont(bytes, [n(40, 90, 0, 0.06), n(72, 110, 0.02, 0.06)], { secs: 0.2, params: { patch: pb.patch, bank: pb.bank, ignoreLinks: 0 } });
      expect(allFinite(L) && allFinite(R)).toBe(true);
      expect(peak(L)).toBeLessThan(100);
    }
    return 'ok';
  }

  it('rejects what is not a SoundFont without throwing', () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0), new Uint8Array(3), new Uint8Array(11), new Uint8Array(12), new Uint8Array(4096),
      Uint8Array.from('RIFF\0\0\0\0WAVEfmt '.split('').map((c) => c.charCodeAt(0))),
      mutate((b) => { b[0] = 0x58; }), mutate((b) => { b[8] = 0x58; }),
    ];
    for (const c of cases) expect(survives(c)).toBe('error');
    // a wrong RIFF size is repaired (the file's length counts)
    expect(survives(mutate((b) => w32(b, 4, 0)))).toBe('ok');
    expect(survives(mutate((b) => w32(b, 4, 0xffffffff)))).toBe('ok');
    expect(parseSf2(new Uint8Array(5))).toEqual({ error: expect.any(String) });
  });

  it('rejects SF3 / compressed fonts and fonts without sample or preset data', () => {
    const ifil = find(base, 'ifil');
    const sf3 = mutate((b) => { b[ifil + 8] = 3; });
    expect(parseSf2(sf3)).toEqual({ error: expect.stringContaining('SoundFont 3') });
    const vorbis = (() => { const w = new Sf2Writer(); const s = w.addSample({ data: [1, 2, 3], type: 0x10 | 1 }); const i = w.addInstrument('i', [{ gens: { [G.sampleID]: s } }]); w.addPreset('p', 0, 0, [{ gens: { [G.instrument]: i } }]); return w.build(); })();
    expect(parseSf2(vorbis)).toEqual({ error: expect.stringContaining('Vorbis') });
    const noSmpl = mutate((b) => { const o = find(b, 'smpl'); b[o] = 0x58; });
    expect(isSf2Error(parseSf2(noSmpl))).toBe(true);
    const noPdta = mutate((b) => { const o = find(b, 'phdr'); b[o] = 0x58; });
    expect(isSf2Error(parseSf2(noPdta))).toBe(true);
    const emptyHydra = mutate((b) => { for (const id of ['phdr', 'inst', 'shdr']) { const o = find(b, id); b[o] = 0x58; } });
    expect(isSf2Error(parseSf2(emptyHydra))).toBe(true);
    expect(importSf2(new Uint8Array(SF2_MAX_BYTES + 1))).toEqual({ error: expect.stringContaining('too large') });
  });

  it('survives truncation at every position', () => {
    let ok = 0;
    for (let cut = 0; cut < base.length; cut += 17) if (survives(base.subarray(0, cut)) === 'ok') ok++;
    expect(ok).toBeGreaterThan(0);
    expect(survives(base.subarray(0, base.length - 1))).toBeDefined();
  });

  it('survives chunk sizes and counts that lie', () => {
    const cases: Uint8Array[] = [];
    for (const id of ['LIST', 'ifil', 'INAM', 'smpl', 'phdr', 'pbag', 'pmod', 'pgen', 'inst', 'ibag', 'imod', 'igen', 'shdr']) {
      const o = find(base, id);
      if (o < 0) continue;
      for (const size of [0, 1, 3, 0x7fffffff, 0xffffffff]) cases.push(mutate((b) => w32(b, o + 4, size)));
    }
    for (const c of cases) survives(c);
    expect(cases.length).toBeGreaterThan(40);
  });

  it('survives damaged zone tables and sample headers', () => {
    const cases: Uint8Array[] = [];
    // the sample headers: positions, loops, rates, types, links
    const shdr = find(base, 'shdr') + 8;
    for (const [off, val] of [[20, 0xffffffff], [20, 5e8], [24, 0], [24, 0xfffffff0], [28, 0xffffffff], [32, 3], [36, 0], [36, 0xffffffff], [40, 255], [40, 128], [42, 0x0000ff01]] as [number, number][]) {
      cases.push(mutate((b) => { if (off === 40) b[shdr + off] = val; else if (off === 42) { b[shdr + 42] = 0xff; b[shdr + 43] = 0xff; } else w32(b, shdr + off, val); }));
    }
    for (const type of [0, 2, 4, 8, 0x8001, 0x8004, 0xffff]) cases.push(mutate((b) => { b[shdr + 44] = type & 255; b[shdr + 45] = type >> 8; }));
    // the tables: bag indices, generator operators and instrument references
    for (const id of ['pbag', 'ibag', 'phdr', 'inst']) {
      const o = find(base, id) + 8;
      for (let k = 0; k < 8; k++) cases.push(mutate((b) => { for (let j = 0; j < 4; j++) b[o + k * 6 + j] = 0xff; }));
    }
    for (const id of ['pgen', 'igen']) {
      const o = find(base, id) + 8;
      for (let k = 0; k < 6; k++) for (const v of [0xffff, 0x7fff, 0x8000, 0x00ff]) cases.push(mutate((b) => { b[o + k * 4 + 2] = v & 255; b[o + k * 4 + 3] = v >> 8; }));
    }
    for (const c of cases) survives(c);
    expect(cases.length).toBeGreaterThan(60);
  });

  it('survives random byte damage (deterministic fuzz)', () => {
    let x = 0x2545f491;
    const rnd = (): number => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
    let imported = 0;
    for (let t = 0; t < 120; t++) {
      const b = Uint8Array.from(base);
      const k = 1 + Math.floor(rnd() * 12);
      for (let j = 0; j < k; j++) b[Math.floor(rnd() * b.length)] = rnd() < 0.3 ? [0, 255, 128, 127][Math.floor(rnd() * 4)] : Math.floor(rnd() * 256);
      if (survives(b) === 'ok') imported++;
    }
    expect(imported).toBeGreaterThan(20);
  });
});

// ===================================================================================================== engine
describe('SoundFont Player: engine', () => {
  const font = presetFont();

  it('is silent without a soundfont, for presets without zones and outside the zones\' ranges', () => {
    const none = renderFont(null, [n(60, 100, 0, 0.2)], { secs: 0.4 });
    expect(peak(none.L)).toBe(0);
    expect(peak(none.R)).toBe(0);
    const w = new Sf2Writer();
    const s = w.addSample({ data: sineData(), loop: [0, 400] });
    const i = w.addInstrument('i', [{ gens: { [G.sampleID]: s, [G.keyRange]: [60, 72], [G.velRange]: [50, 100], ...LOOP } }]);
    w.addPreset('has zone', 0, 0, [{ gens: { [G.instrument]: i } }]);
    w.addPreset('no zone', 1, 0, []);
    const bytes = w.build();
    const play = (key: number, vel: number, patch = 1): number => peak(renderFont(bytes, [n(key, vel, 0, 0.2)], { secs: 0.4, params: { patch } }).L);
    expect(play(66, 80)).toBeGreaterThan(0.01);
    expect(play(59, 80)).toBe(0);
    expect(play(73, 80)).toBe(0);
    expect(play(66, 49)).toBe(0);
    expect(play(66, 101)).toBe(0);
    // an unknown patch plays the first preset of FL's list, a preset without zones nothing
    expect(play(66, 80, 100)).toBeGreaterThan(0.01);
    expect(play(66, 80, 2)).toBe(0);
  });

  it('plays the sample at the key\'s pitch, with the sample\'s root key, fine tune and scale tuning', () => {
    const f = (key: number, gens = {}, o = {}): number => freq(renderFont(simpleFont({ gens: { ...LOOP, ...gens }, ...o }), [n(key, 100, 0, 0.5)], { secs: 0.6 }).L);
    expect(f(60)).toBeCloseTo(441, 1);
    expect(f(72)).toBeCloseTo(882, 1);
    expect(f(48)).toBeCloseTo(220.5, 1);
    expect(f(60, { [G.coarseTune]: 12 })).toBeCloseTo(882, 1);
    expect(f(60, { [G.fineTune]: 50 })).toBeCloseTo(441 * Math.pow(2, 50 / 1200), 0);
    expect(f(60, { [G.overridingRootKey]: 72 })).toBeCloseTo(220.5, 1);
    expect(f(72, { [G.scaleTuning]: 0 })).toBeCloseTo(441, 1);
    expect(f(60, {}, { root: 255 })).toBeCloseTo(441, 1);
    expect(f(60, {}, { rate: 22050 })).toBeCloseTo(441 * 0.5, 1);
    expect(f(60, {}, { corr: -50 })).toBeCloseTo(441 * Math.pow(2, -50 / 1200), 0); // the correction is subtracted from the root key's cents
  });

  it('waits for the sample pool and plays notes started afterwards', () => {
    const d = driver(font, {}, { delayPool: true });
    d.on(1, 60, 100);
    expect(peak(d.block().L)).toBe(0);
    expect(d.inst.isActive!()).toBe(false);
    const imp = importSf2(font);
    if ('error' in imp) throw new Error(imp.error);
    d.pool.set('s1', { channels: [imp.pcm], sampleRate: imp.font.rate });
    d.on(2, 60, 100);
    expect(peak(d.block(256).L)).toBeGreaterThan(0.05);
    expect(d.inst.isActive!()).toBe(true);
  });

  it('selects the preset by patch and bank; the program mode chooses the melodic or the percussion channel', () => {
    const at = (params: Record<string, unknown>): { f: number; p: number } => {
      const { L } = renderFont(font, [n(60, 100, 0, 0.3)], { secs: 0.5, params });
      return { f: freq(L), p: peak(L) };
    };
    expect(at({ patch: 1, bank: 0 }).f).toBeCloseTo(441, 1); // Piano
    expect(at({ patch: 17, bank: 0 }).f).toBeCloseTo(882, 1); // Organ (program 16)
    expect(at({ patch: 6, bank: 1 }).f).toBeCloseTo(882, 1); // Zeta (bank 1, program 5)
    expect(at({ patch: 129, bank: 0 }).f).toBeCloseTo(882, 1); // Kit (bank 128): automatic mode = percussion for bank 127 / 128
    expect(at({ patch: 129, bank: 0, programMode: 0 }).p).toBeGreaterThan(0.1);
    expect(at({ patch: 129, bank: 0, programMode: 1 }).p).toBe(0); // Instrument mode: melodic channel, no percussion preset
    expect(at({ patch: 1, bank: 0, programMode: 2 }).p).toBe(0); // Drum mode: percussion channel, no melodic preset
    expect(at({ patch: 129, bank: 0, programMode: 2 }).p).toBeGreaterThan(0.1);
    expect(at({ patch: 1, bank: 0, programMode: 1 }).p).toBeGreaterThan(0.1);
  });

  it('applies the channel volume, pan and pitch of the note (FinalLevels) like FL', () => {
    const f = simpleFont({ gens: LOOP });
    const base = renderFont(f, [n(60, 100, 0, 0.4)], { secs: 0.6 });
    const half = renderFont(f, [n(60, 100, 0, 0.4)], { secs: 0.6, chanVol: 0.5 });
    expect(rms(half.L) / rms(base.L)).toBeCloseTo(0.5, 6);
    const left = renderFont(f, [n(60, 100, 0, 0.4)], { secs: 0.6, chanPan: -1 });
    expect(peak(left.R)).toBe(0);
    expect(rms(left.L) / rms(base.L)).toBeCloseTo(Math.SQRT2, 5);
    const right = renderFont(f, [n(60, 100, 0, 0.4)], { secs: 0.6, chanPan: 1 });
    expect(peak(right.L)).toBeLessThan(1e-9);
    expect(rms(right.R) / rms(base.R)).toBeCloseTo(Math.SQRT2, 5);
    const up = renderFont(f, [n(60, 100, 0, 0.4)], { secs: 0.6, pitchOffset: 1200 });
    expect(freq(up.L)).toBeCloseTo(882, 1);
  });

  it('ends released notes (the voice end decays) and keeps the effect tails of the built-in reverb', () => {
    const f = simpleFont({ gens: { ...LOOP, [G.releaseVolEnv]: -1200 } });
    const d = driver(f);
    d.on(1, 60, 100);
    expect(peak(d.block(2048).L)).toBeGreaterThan(0.1);
    expect(d.inst.isActive!()).toBe(true);
    d.off(1);
    let guard = 0;
    while (d.inst.isActive!() && guard++ < 400) d.block();
    expect(d.inst.isActive!()).toBe(false);
    for (let b = 0; b < 8; b++) d.block(4096); // the voice end's decay (-60 dB in 19.5 ms) dies out
    expect(peak(d.block(4096).L)).toBe(0);
    expect(d.inst.tail).toBeCloseTo(0.25, 6);
    d.setParams({ revOn: 1 });
    expect(d.inst.tail).toBe(10);
    d.setParams({ revOn: 0, chorOn: 1 });
    expect(d.inst.tail).toBe(10);
    d.setParams({ chorOn: 0 });
    // all notes off silences everything at once
    d.on(2, 60, 100);
    d.block(512);
    d.inst.allNotesOff?.();
    expect(d.inst.isActive!()).toBe(false);
    expect(peak(d.block(512).L)).toBeLessThan(1e-3);
  });

  it('changes of FL\'s parameters 5..12 reach running notes only through modulator destinations (cutoff, LFO amount)', () => {
    const f = simpleFont({ gens: LOOP });
    const d = driver(f);
    d.on(1, 60, 100);
    d.block(2048);
    d.setParams({ envRel: 4000 }); // a 16 s release
    d.off(1);
    for (let b = 0; b < 4; b++) d.block(4096);
    expect(peak(d.block(4096).L)).toBe(0); // the running note kept its own (instant) release
    d.on(2, 60, 100);
    d.block(2048);
    d.off(2);
    for (let b = 0; b < 4; b++) d.block(4096);
    expect(peak(d.block(4096).L)).toBeGreaterThan(0.05); // a note started after the change has it
    // the cutoff has default modulators (velocity -> cutoff): a running note follows it at once
    const nz = driver(simpleFont({ data: noiseData(), gens: LOOP }));
    nz.on(1, 60, 127);
    const open = rms(nz.block(4096).L);
    nz.setParams({ cutoff: 10 });
    nz.block(8192); // the coefficient ramp from the bypassed filter rings (as in FL)
    const closed = rms(nz.block(4096).L);
    expect(closed).toBeLessThan(open * 0.6);
  });

  it('sends the reverb and chorus buses to mixer tracks relative to its own (SEND TO)', () => {
    const f = simpleFont({ gens: LOOP });
    const got: { track: number; l: Float32Array }[] = [];
    const out = (track: number, l: Float32Array, _r: Float32Array, nn: number): void => { got.push({ track, l: l.slice(0, nn) }); };
    const d = driver(f, { revTo: 3, chorTo: -5, revSend: 128, chorSend: 64 }, { track: 2 });
    d.on(1, 60, 100);
    d.block(128);
    got.length = 0;
    const dry = d.block(128, out);
    expect(got.map((g) => g.track)).toEqual([5, 0]);
    const rev = got[0].l, chor = got[1].l;
    for (let i = 0; i < 128; i++) {
      expect(rev[i]).toBeCloseTo(dry.L[i], 6); // level 128 = 100 %: the bus is the voice
      expect(chor[i]).toBeCloseTo(dry.L[i] * sendLevel(64), 6);
    }
    // not routed: no buses
    const d2 = driver(f, {}, { track: 2 });
    d2.on(1, 60, 100);
    got.length = 0;
    d2.block(128, out);
    expect(got.length).toBe(0);
  });

  it('survives state changes while notes play (fonts, presets, options, resampling)', () => {
    const d = driver(font);
    d.on(1, 60, 100); d.on(2, 67, 90);
    const seq: Record<string, unknown>[] = [
      { resampling: 8 }, { resampling: 1 }, { resampling: 6 }, { programMode: 2 }, { programMode: 0, patch: 17 }, { revOn: 1, chorOn: 1 },
      { emu: 0, velFc: 0, ignoreLinks: 0 }, { mod: 127, envAtk: 5000, envDec: 100, envSus: 3, envRel: 100, lfoDelay: 1, lfoAmt: 127, lfoSpeed: 127, cutoff: 0 },
      { fonts: [] }, { fonts: d.params.fonts, active: 7 }, { patch: 1000, bank: -5 }, {},
    ];
    for (const p of seq) {
      d.setParams(p);
      d.on(10 + seq.indexOf(p), 50 + seq.indexOf(p), 100);
      const { L, R } = d.block();
      expect(allFinite(L) && allFinite(R)).toBe(true);
    }
  });

  it('resamples in all four modes (Crunchy is linear, Standard / HQ / Extreme HQ are windowed sincs)', () => {
    const f = simpleFont({ gens: LOOP });
    const mode = (m: number): Float32Array => renderFont(f, [n(66, 100, 0, 0.3)], { secs: 0.4, params: { resampling: m } }).L;
    const [m1, m4, m6, m8] = [1, 4, 6, 8].map(mode);
    for (const m of [m1, m4, m6, m8]) expect(allFinite(m)).toBe(true);
    const level = (a: Float32Array): number => dB(rms(a, 2000, 12000));
    // a tone far below the cutoff keeps its level in every mode (the linear interpolation of Crunchy loses a little more)
    for (const m of [m1, m4, m6, m8]) expect(Math.abs(level(m) - level(m8))).toBeLessThan(0.3);
    const res = (a: Float32Array, b: Float32Array): number => {
      let d = 0, r = 0;
      for (let i = 2000; i < 12000; i++) { d += (a[i] - b[i]) ** 2; r += b[i] ** 2; }
      return dB(Math.sqrt(d / r));
    };
    expect(res(m6, m8)).toBeLessThan(res(m4, m8));
  });

  it('applies the OPTIONS menu: EMU volume envelope scale, velocity filter cutoff, ignore sample links', () => {
    const att = (emu: number): number => {
      const hi = renderFont(simpleFont({ gens: { ...LOOP, [G.initialAttenuation]: 200 } }), [n(60, 100, 0, 0.4)], { secs: 0.6, params: { emu } });
      const lo = renderFont(simpleFont({ gens: LOOP }), [n(60, 100, 0, 0.4)], { secs: 0.6, params: { emu } });
      return dB(rms(hi.L) / rms(lo.L));
    };
    expect(att(1)).toBeCloseTo(-8.0, 2); // 200 cB x 0.4
    expect(att(0)).toBeCloseTo(-20 * 200 * 0.0018814356859432296, 2); // 200 cB at the non-EMU scale
    const noise = simpleFont({ data: noiseData(), gens: LOOP });
    const vel30 = (velFc: number): number => rms(renderFont(noise, [n(60, 30, 0, 0.5)], { secs: 0.7, params: { velFc } }).L);
    expect(vel30(1)).toBeLessThan(vel30(0) * 0.9);
    // left / right samples play on their side only when the links are honoured
    const w = new Sf2Writer();
    const a = w.addSample({ name: 'L', data: sineData(100, 4), root: 60, loop: [0, 400], type: 4, link: 1 });
    const b = w.addSample({ name: 'R', data: sineData(50, 8, 20000), root: 60, loop: [0, 400], type: 2, link: 0 });
    const i = w.addInstrument('i', [{ gens: { [G.sampleID]: a, ...LOOP } }]);
    w.addPreset('p', 0, 0, [{ gens: { [G.instrument]: i } }]);
    void b;
    const st = w.build();
    const honoured = renderFont(st, [n(60, 100, 0, 0.4)], { secs: 0.6, params: { ignoreLinks: 0 } });
    const ignored = renderFont(st, [n(60, 100, 0, 0.4)], { secs: 0.6, params: { ignoreLinks: 1 } });
    expect(freq(honoured.L)).toBeCloseTo(441, 1); // the left sample on the left,
    expect(freq(honoured.R)).toBeCloseTo(882, 0); // its linked right sample plays along on the right
    expect(freq(ignored.L)).toBeCloseTo(441, 1); // links ignored: the left sample on both sides, nothing else
    expect(freq(ignored.R)).toBeCloseTo(441, 1);
  });
});

// ===================================================================================================== FL behaviours (read from the binary, measured)
describe('SoundFont Player: FL behaviours', () => {
  const mod = (src: number, dest: number, amount: number, amtSrc = 0, trans = 0) => ({ src, dest, amount, amtSrc, trans });
  const ctl = (o: Partial<ReturnType<typeof defaultControls>> = {}) => ({ ...defaultControls(), ...o });

  it('has the SF2 default modulators with FL\'s measured pan amount and its velocity -> cutoff special case', () => {
    expect(DEFAULT_MODS.map((m) => [m.src, m.dest, m.amount, m.amtSrc])).toEqual([
      [0x0502, 48, 960, 0], [0x0102, 8, -2400, 0x0d02], [0x000d, 6, 50, 0], [0x0081, 6, 50, 0], [0x0587, 48, 960, 0],
      [0x028a, 17, 500, 0], [0x058b, 48, 960, 0], [0x00db, 16, 200, 0], [0x00dd, 15, 200, 0], [0x020e, 52, 12700, 0x0010],
    ]);
    const fc = (vel: number, velFc = true): number => modValue(DEFAULT_MODS[1], ctl({ velocity: vel, velFc }));
    expect(fc(1)).toBe(-1200);
    expect(fc(63)).toBe(-1200); // half the amount below velocity 64 (not the spec's linear ramp)
    expect(fc(64)).toBeCloseTo((-2400 * 63) / 127, 3);
    expect(fc(100)).toBeCloseTo((-2400 * 27) / 127, 3);
    expect(fc(127)).toBe(-0);
    expect(fc(30, false)).toBe(0);
    expect(fc(100, false)).toBe(0);
    // velocity -> attenuation: the concave curve 960 x -(20 / 96) log10((v / 127)^2) = -400 log10(v / 127) cB
    const att = (vel: number): number => modValue(DEFAULT_MODS[0], ctl({ velocity: vel }));
    for (const v of [1, 2, 30, 64, 100, 126]) expect(att(v)).toBeCloseTo(-400 * Math.log10(v / 127), 3);
    expect(att(127)).toBe(0);
    // CC7 / CC11 default to 127 (no attenuation), CC10 to 64 (centre pan), the pitch wheel to its centre
    expect(modValue(DEFAULT_MODS[4], ctl())).toBe(0);
    expect(modValue(DEFAULT_MODS[6], ctl())).toBe(0);
    expect(modValue(DEFAULT_MODS[5], ctl())).toBeCloseTo((500 * (-1 + 128 / 127)) / 1, 9);
    expect(modValue(DEFAULT_MODS[9], ctl())).toBe(0);
    expect(modValue(DEFAULT_MODS[3], ctl())).toBe(0);
    expect(modValue(DEFAULT_MODS[3], (() => { const c = ctl(); c.cc[1] = 100; return c; })())).toBeCloseTo((50 * 100) / 127, 9);
  });

  it('evaluates sources like FL (0x1d7070): linear, concave, convex and switch curves, bipolar around 64', () => {
    const v = (src: number, d: number, amount = 1000): number => {
      const c = ctl(); c.cc[20] = d;
      return modValue(mod(src | 0x80, 63, amount), c);
    };
    const S = (o: { neg?: boolean; bipolar?: boolean; type?: number }) => modSrc(20, o);
    expect(v(S({}), 0)).toBe(0);
    expect(v(S({}), 127)).toBe(1000);
    expect(v(S({}), 64)).toBeCloseTo((1000 * 64) / 127, 9);
    expect(v(S({ neg: true }), 100)).toBeCloseTo(1000 * (1 - 100 / 127), 9);
    expect(v(S({ bipolar: true }), 0)).toBeCloseTo(-1000, 9);
    expect(v(S({ bipolar: true }), 127)).toBeCloseTo(1000, 9);
    expect(v(S({ bipolar: true }), 64)).toBeCloseTo(1000 * (-1 + 128 / 127), 9); // the centre of the 0..127 range is 63.5
    expect(v(S({ type: 1 }), 127)).toBe(1000);
    expect(v(S({ type: 1 }), 0)).toBe(0);
    expect(v(S({ type: 1 }), 64)).toBeCloseTo(1000 * (-(20 / 96) * Math.log10((63 * 63) / 16129)), 3); // concave[64] = 1 - ... table value
    expect(v(S({ type: 2 }), 64)).toBeCloseTo(1000 * (1 + (20 / 96) * Math.log10((64 * 64) / 16129)), 3);
    expect(v(S({ type: 1, neg: true }), 100)).toBeCloseTo(1000 * (-(20 / 96) * Math.log10((100 * 100) / 16129)), 3);
    expect(v(S({ type: 1, bipolar: true }), 64)).toBeCloseTo(0, 12);
    expect(v(S({ type: 1, bipolar: true }), 127)).toBeCloseTo(1000 * (20 / 96) * Math.log10(16129), 3); // table entry 2 (127 - 64) = 126
    expect(v(S({ type: 1, bipolar: true }), 0)).toBeCloseTo(-1000, 9); // d <= 64: minus the table at 2 (64 - d) = 128 -> 1
    // the switch curves flip at 64
    expect([63, 64].map((d) => v(S({ type: 3 }), d))).toEqual([0, 1000]);
    expect([63, 64].map((d) => v(S({ type: 3, neg: true }), d))).toEqual([1000, 0]);
    expect([63, 64].map((d) => v(S({ type: 3, bipolar: true }), d))).toEqual([-1000, 1000]);
    expect([63, 64].map((d) => v(S({ type: 3, bipolar: true, neg: true }), d))).toEqual([1000, -1000]);
  });

  it('treats sources FL cannot decode like FL: a missing primary source is zero, a missing amount source one, a transform zero', () => {
    const c = ctl(); c.cc[20] = 100;
    expect(modValue(mod(0, 63, 100), c)).toBe(0);
    expect(modValue(mod(modSrc(20, {}) | 0x80, 63, 100, 0), c)).toBeCloseTo((100 * 100) / 127, 9);
    expect(modValue(mod(modSrc(20, {}) | 0x80, 63, 100, 0, 2), c)).toBe(0);
    expect(modValue(mod(modSrc(20, { type: 5 }) | 0x80, 63, 100), c)).toBe(0); // curve types above 3: amount 0
    expect(modValue(mod(modSrc(20, {}) | 0x80, 63, 100, modSrc(20, { type: 4 }) | 0x80), c)).toBe(0);
    expect(modValue(mod(modSrc(20, {}) | 0x80, 63, 100, 40 | 0x80), c)).toBe(0); // amount source CC 40 = 0
    expect(modValue(mod(modSrc(20, {}) | 0x80, 63, 100, 12), c)).toBeCloseTo((100 * 100) / 127, 9); // unsupported amount source: 1
    expect(modValue(mod(12, 63, 100), c)).toBe(0); // unsupported primary source: 0
    expect(modValue(mod(modSrc(MOD_KEY), 63, 127), ctl({ key: 64 }))).toBeCloseTo(64, 9);
    expect(modValue(mod(modSrc(MOD_VEL), 63, 127), ctl({ velocity: 100 }))).toBeCloseTo(100, 9);
  });

  it('runs the volume envelope\'s stage machine per control block (delay, attack, hold, decay, sustain, release)', () => {
    const e = new SfEnv();
    e.setup(2, 4, 1, 5, 0.5, 3);
    const seq: number[] = [];
    for (let i = 0; i < 16; i++) { e.tick(); seq.push(e.stage); }
    expect(seq.slice(0, 2)).toEqual([0, 0]);
    expect(seq.includes(1) && seq.includes(2) && seq.includes(3) && seq.includes(4)).toBe(true);
    expect(e.stage).toBe(4);
    expect(e.out).toBeCloseTo(0.5, 6);
    e.release();
    for (let i = 0; i < 6; i++) e.tick();
    expect(e.done).toBe(true);
    expect(e.out).toBe(0);
  });

  it('matches FL on the unclamped generators (pan, attenuation, tuning) and the odd values, see the golden scenarios', () => {
    const rmsOf = (gens: Record<number, number>, key = 60): [number, number] => {
      const { L, R } = renderFont(simpleFont({ gens: { ...LOOP, ...gens } }), [n(key, 100, 0, 0.4)], { secs: 0.6 });
      return [rms(L), rms(R)];
    };
    const [l0, r0] = rmsOf({});
    // pan 700: the circular law continues past +-500 (the left gain turns negative), nothing is clamped; the default modulator
    // for CC10 (64 = just right of the centre) adds 500 (-1 + 128 / 127) to the pan
    const dp = 500 * (-1 + 128 / 127);
    const th = (pan: number): number => ((500 + pan + dp) * Math.PI) / 2000;
    const [l7, r7] = rmsOf({ [G.pan]: 700 });
    expect(l7 / l0).toBeCloseTo(Math.abs(Math.cos(th(700))) / Math.abs(Math.cos(th(0))), 3);
    expect(r7 / r0).toBeCloseTo(Math.sin(th(700)) / Math.sin(th(0)), 3);
    // attenuation 1500 is 600 cB at the EMU scale, negative values boost until the sum reaches zero
    expect(dB(rmsOf({ [G.initialAttenuation]: 1500 })[0] / l0)).toBeCloseTo(-60, 0);
    expect(rmsOf({ [G.initialAttenuation]: -1000 })[0]).toBeGreaterThan(l0);
    // keynum / velocity override the played key / velocity for the tuning and the modulators
    expect(freq(renderFont(simpleFont({ gens: { ...LOOP, [G.keynum]: 72 } }), [n(60, 100, 0, 0.4)], { secs: 0.6 }).L)).toBeCloseTo(882, 1);
    const vel = (g: number, v: number, block = 512): number => rms(renderFont(simpleFont({ gens: { ...LOOP, [G.velocity]: g } }), [n(60, v, 0, 0.4)], { secs: 0.6, block }).L, 4000, 20000);
    expect(vel(40, 127)).toBeCloseTo(vel(-1, 40), 6);
  });
});

// ===================================================================================================== FL renders
describe('SoundFont Player: renders of FL 2026 (the test host) for the scenarios of tests/gen/soundfont-scenarios.ts', () => {
  it('has a golden entry for every scenario and no stale ones', () => {
    const names = new Set(SCENARIOS.map((s) => s.name));
    expect(names.size).toBe(SCENARIOS.length);
    expect(Object.keys(GOLDEN).sort()).toEqual(Array.from(names).sort());
  });

  for (const s of SCENARIOS) {
    it(`${s.name}: ${s.pins}`, () => {
      const g = GOLDEN[s.name];
      const { L, R } = renderFont(s.font(), s.notes, { sr: s.sr, secs: s.secs, params: s.params, preroll: hostPreroll(s.sr ?? 44100), kills: s.kills, block: 512 });
      expect(L.length).toBe(g.frames);
      const pk = Math.max(peak(L), peak(R));
      const tol = (s.tol ?? 3e-6) * g.peak;
      expect(Math.abs(pk - g.peak)).toBeLessThanOrEqual(2 * tol + 1e-7 * g.peak);
      for (const e of g.ex) {
        for (let k = 0; k < e.l.length; k++) {
          expect(Math.abs(L[e.at + k] - e.l[k]), `left ${e.at + k}`).toBeLessThanOrEqual(tol + 1e-9);
          expect(Math.abs(R[e.at + k] - e.r[k]), `right ${e.at + k}`).toBeLessThanOrEqual(tol + 1e-9);
        }
      }
      const winTol = s.winTol ?? 0.02;
      for (const [c, x] of [[0, L], [1, R]] as [number, Float32Array][]) {
        const wins = g.win[c];
        for (let w = 0; w < wins.length; w++) {
          const level = dB(rms(x, w * GOLDEN_WINDOW, (w + 1) * GOLDEN_WINDOW));
          if (wins[w] > -90) expect(Math.abs(level - wins[w]), `window ${w} of channel ${c}`).toBeLessThanOrEqual(winTol);
          else expect(level, `window ${w} of channel ${c}`).toBeLessThan(-80);
        }
      }
    });
  }
});

// ===================================================================================================== robustness
describe('SoundFont Player: finiteness at extreme fonts and settings', () => {
  let seed = 12345;
  const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const EXTREME = [-32768, -32767, -12001, -12000, -1200, -100, -1, 0, 1, 100, 1200, 1440, 4500, 5000, 8000, 12000, 13500, 32766, 32767];

  /** A font with random samples (damaged headers included), zones, generators at their extremes and modulators. */
  function randomFont(): Uint8Array {
    const w = new Sf2Writer();
    const nS = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < nS; i++) {
      const len = pick([0, 1, 2, 3, 9, 64, 400, 3000]);
      const data = rnd() < 0.5 ? sineData(Math.max(2, 50 + Math.floor(rnd() * 100)), Math.max(1, Math.floor(len / 100))) : noiseData(len, 1 + i);
      const a = Math.floor(rnd() * (len + 1)), b = Math.floor(rnd() * (len + 1));
      w.addSample({
        name: 's' + i, data, rate: pick([0, 1, 8000, 22050, 44100, 48000, 96000, 4294967295]), root: pick([0, 24, 60, 127, 128, 200, 255]),
        corr: pick([-128, -50, 0, 50, 127]), loop: [Math.min(a, b), Math.max(a, b)], type: pick([1, 1, 1, 2, 4, 8, 0x8001, 0, 0xffff]),
        link: pick([0, 1, 2, 65535]), endcut: pick([0, 0, 5, len + 10]),
      });
    }
    const gens = (): Record<number, number | [number, number]> => {
      const g: Record<number, number | [number, number]> = {};
      for (let k = 0; k < 60; k++) {
        if (k === GEN.instrument || k === GEN.sampleID || k === GEN.keyRange || k === GEN.velRange) continue;
        if (rnd() < 0.25) g[k] = pick(EXTREME);
      }
      if (rnd() < 0.3) g[GEN.keyRange] = [Math.floor(rnd() * 128), Math.floor(rnd() * 128)];
      if (rnd() < 0.3) g[GEN.velRange] = [Math.floor(rnd() * 128), Math.floor(rnd() * 128)];
      return g;
    };
    const mods = (): [number, number, number, number, number][] => {
      const out: [number, number, number, number, number][] = [];
      for (let i = Math.floor(rnd() * 4); i > 0; i--) out.push([Math.floor(rnd() * 65536), pick([0, 6, 8, 15, 16, 17, 48, 52, 63, 64, 100, 0x8000, 0x8001]), pick(EXTREME), Math.floor(rnd() * 65536), pick([0, 0, 2])]);
      return out;
    };
    const zones: SfZoneDef[] = [];
    if (rnd() < 0.3) zones.push({ gens: gens(), mods: mods() });
    for (let i = 1 + Math.floor(rnd() * 3); i > 0; i--) zones.push({ gens: { ...gens(), [GEN.sampleID]: pick([0, 0, 1, 2, nS - 1, nS + 3, 65535]) }, mods: mods() });
    const inst = w.addInstrument('inst', zones);
    w.addPreset('p', 0, 0, [{ gens: { ...gens(), [GEN.instrument]: pick([inst, inst, inst + 1, 65535]) }, mods: mods() }]);
    return w.build();
  }

  it('renders random fonts with extreme generators, damaged sample headers and wild modulators without NaN', () => {
    let played = 0;
    for (let t = 0; t < 150; t++) {
      const bytes = randomFont();
      if ('error' in importSf2(bytes)) continue; // a Vorbis flag etc.: rejected up front
      const params = { resampling: pick([1, 4, 6, 8]), revOn: pick([0, 1]), chorOn: pick([0, 1]), ignoreLinks: pick([0, 1]), emu: pick([0, 1]), velFc: pick([0, 1]), mod: Math.floor(rnd() * 128) };
      const { L, R } = renderFont(bytes, [n(pick([0, 12, 36, 60, 96, 127]), pick([1, 64, 127]), 0, 0.12), n(pick([30, 60, 100]), 100, 0.04, 0.08)], { secs: 0.4, params });
      expect(allFinite(L) && allFinite(R), `font ${t}`).toBe(true);
      expect(peak(L)).toBeLessThan(1000);
      played++;
    }
    expect(played).toBeGreaterThan(80);
  });

  it('survives extreme and damaged state values', () => {
    const f = presetFont();
    const bad: Record<string, unknown>[] = [
      { patch: NaN, bank: Infinity }, { patch: -5, bank: 1e9 }, { patch: 'x', bank: {} }, { mod: -1e9 }, { mod: NaN }, { revSend: 1e9, chorSend: -1e9 },
      { envAtk: 1e9, envDec: -1e9, envSus: 1e9, envRel: NaN, lfoDelay: 1e9, lfoAmt: -1e9, lfoSpeed: 1e9, cutoff: 1e9 },
      { envAtk: 0, envDec: 0, envSus: 0, envRel: 0, lfoDelay: 0, lfoAmt: 0, lfoSpeed: 0, cutoff: 0 },
      { envAtk: 5940, envDec: 5940, envSus: 127, envRel: 5940, lfoDelay: 5900, lfoAmt: 127, lfoSpeed: 127, cutoff: 127 },
      { resampling: 99, programMode: 99, revTo: 1e9, chorTo: -1e9, revOn: 'x', chorOn: [] }, { active: 1e9 }, { active: -1 }, { fonts: [{ sample: 's1', hydra: 'AAAA' }] },
      { fonts: [{ sample: 'missing', hydra: '' }] }, { fonts: [null, undefined, 4, 'x'] },
    ];
    for (const p of bad) {
      const { L, R } = renderFont(f, [n(60, 100, 0, 0.1), n(90, 127, 0.02, 0.1)], { secs: 0.3, params: p });
      expect(allFinite(L) && allFinite(R), JSON.stringify(p)).toBe(true);
      expect(peak(L)).toBeLessThan(100);
    }
  });

  it('plays far more notes than it has voices (512): the oldest are stolen, nothing breaks', () => {
    const d = driver(simpleFont({ gens: LOOP }));
    for (let i = 0; i < 700; i++) d.on(i + 1, 24 + (i % 90), 20 + (i % 100), 0);
    for (let b = 0; b < 8; b++) {
      const { L, R } = d.block();
      expect(allFinite(L) && allFinite(R)).toBe(true);
    }
    expect(d.inst.isActive!()).toBe(true);
    for (let i = 0; i < 700; i++) d.off(i + 1);
    for (let b = 0; b < 200; b++) d.block();
    expect(d.inst.isActive!()).toBe(false);
  });

  it('plays at every sample rate and keeps notes sample accurate inside a block', () => {
    for (const sr of [8000, 22050, 44100, 48000, 96000, 192000]) {
      const { L, R } = renderFont(simpleFont({ gens: LOOP }), [n(60, 100, 0.1, 0.1), n(72, 100, 0.15, 0.1)], { sr, secs: 0.5 });
      expect(allFinite(L) && allFinite(R)).toBe(true);
      expect(peak(L, 0, Math.floor(0.0999 * sr))).toBe(0);
      expect(peak(L, Math.floor(0.1 * sr), Math.floor(0.12 * sr))).toBeGreaterThan(0.01);
    }
    // a pool that decodes at another rate than the soundfont's: positions are rescaled
    const base = renderFont(simpleFont({ gens: LOOP }), [n(60, 100, 0, 0.3)], { secs: 0.5 });
    expect(freq(base.L)).toBeCloseTo(441, 1);
  });
});

// ===================================================================================================== golden scenario dump
// Regenerating the golden numbers (docs/research/gen/soundfont.md): SF_GOLDEN_DUMP=<dir> vitest run tests/gen/soundfont.test.ts writes
// every scenario's font (<name>.sf2) and a manifest.json for .flref/samplers/soundfont/mkgolden.py, which renders them with FL's host.
describe('golden scenario dump', () => {
  it.skipIf(!process.env.SF_GOLDEN_DUMP)('writes the fonts', () => {
    const dir = process.env.SF_GOLDEN_DUMP!;
    mkdirSync(dir, { recursive: true });
    const manifest = SCENARIOS.map((s) => {
      writeFileSync(`${dir}/${s.name}.sf2`, s.font());
      return { name: s.name, sr: s.sr ?? 44100, notes: s.notes, secs: s.secs, params: s.params ?? {}, kills: s.kills ?? [] };
    });
    writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 1));
    expect(manifest.length).toBeGreaterThan(80);
  });
});
