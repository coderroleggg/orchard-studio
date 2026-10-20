// Morphine (FL's additive morphing synthesizer): registration, FL's parameter
// names and value texts, the program structure, FL's .mrp / FL state formats
// (write -> read round trip), the content import helpers, the factory preset
// bank (parameter-level data with synthesized spectra) and the engine
// (finite non-silent audio; a single synthesized partial plays at the expected
// frequency, level and pan). Bit-exactness against FL itself is checked with
// FL's host outside the repository (.flref/morphine/port/harness).
import { describe, it, expect } from 'vitest';
import { GEN_DEFS, defaultGenParams, genPresetState, normalizeGenParams } from '../../src/model/gen/registry';
import { hasGen } from '../../src/engine/gen';
import { MOR_PARAMS, MOR_KEYS, fOf, vOf, cFixed } from '../../src/model/gen/plugins/morphine/params';
import { defaultProgram, normalizeMorphine, selectZone, substituteSpectrum, type MGen, type MZone } from '../../src/model/gen/plugins/morphine/state';
import { fstBlob, parseMorphineFile, parseMrp, rawToState, stateToRaw, writeFlState, writeMrp } from '../../src/model/gen/plugins/morphine/mrp';
import { applyUpdates, floatWav, importProgram, noiseFileFor, parseNoiseWav, presetFileFor } from '../../src/model/gen/plugins/morphine/import';
import { exp10, exp2, fmaD } from '../../src/model/gen/plugins/morphine/libm';
import { factoryProgram, factoryPresetIndex } from '../../src/model/gen/plugins/morphine';
import { MorphineInstance } from '../../src/engine/gen/plugins/morphine';
import type { GenEnv, GenNote } from '../../src/engine/gen/types';

const def = GEN_DEFS.find((d) => d.id === 'morphine')!;
const key = (i: number) => MOR_KEYS[i];
const text = (i: number, raw: number) => MOR_PARAMS[i].format!(raw);

describe('Morphine: definition and parameters', () => {
  it('is registered as an events instrument with FL levels and velocity', () => {
    expect(def).toBeTruthy();
    expect(def.name).toBe('Morphine');
    expect(def.category).toBe('Synth special');
    expect(def.notes).toBe('events');
    expect(def.levels).toBe('plugin');
    expect(def.velocity).toBe('plugin');
    expect(hasGen('morphine')).toBe(true);
  });

  it("has FL's 252 parameters with FL's names", () => {
    expect(MOR_PARAMS.length).toBe(252);
    MOR_PARAMS.forEach((p, i) => { expect(p.index).toBe(i); expect(p.min).toBe(0); expect(p.max).toBe(256); });
    expect(MOR_PARAMS[0].name).toBe('Master Level');
    expect(MOR_PARAMS[11].name).toBe('Delay Time');
    expect(MOR_PARAMS[43].name).toBe('Gen A: Release Loop');
    expect(MOR_PARAMS[82].name).toBe('Gen D: Panning Range');
    expect(MOR_PARAMS[86].name).toBe('Morph: Rate VelTrk');
    expect(MOR_PARAMS[122].name).toBe('Eg4: Velocity');
    expect(MOR_PARAMS[123].name).toBe('MIDI CC 0');
    expect(MOR_PARAMS[250].name).toBe('MIDI CC 127');
    expect(MOR_PARAMS[251].name).toBe('Chn. Aftertouch');
    expect(new Set(MOR_KEYS).size).toBe(252);
  });

  it("prints FL's value texts (checked against FL's own GetName for every raw value)", () => {
    expect(text(0, 0)).toBe('-24.0 dB');
    expect(text(0, vOf(0.495))).toBe('-0.2 dB'); // FL's constructor program
    expect(text(0, 128)).toBe('0.0 dB');
    expect(text(0, 2)).toBe('-23.6 dB');
    expect(text(1, 41)).toBe('16 %');
    expect(text(3, 29)).toBe('1 '); // empty unit: trailing space, as FL
    expect(text(4, 0)).toBe('-24 ');
    expect(text(5, 128)).toBe('0 ');
    expect(text(9, 0)).toBe('0.1 Hz');
    expect(text(11, 0)).toBe('2 ms');
    expect(text(11, 154)).toBe(`${Math.trunc(fmaD(154 / 256, 0.95, 0.05) ** 2 * 1000)} ms`);
    expect(text(12, 0)).toBe('-100 %');
    expect(text(22, 149)).toBe('2.0 dB');
    expect(text(39, 128)).toBe('1.00 ');
    expect(text(40, 0)).toBe('35 Hz');
    expect(text(40, 256)).toBe('17920 Hz');
    expect(text(123, 256)).toBe('127');
    expect(text(251, 128)).toBe('63');
  });

  it('formats like C printf (ties to even on the exact binary value)', () => {
    expect(cFixed(0.25, 1)).toBe('0.2');
    expect(cFixed(0.75, 1)).toBe('0.8');
    expect(cFixed(-0.04, 1)).toBe('-0.0');
    expect(cFixed(2.675, 2)).toBe('2.67'); // 2.67499999... in binary
  });

  it("matches macOS libm's exp2 / exp10 on sample arguments", () => {
    expect(exp2(0)).toBe(1);
    expect(exp2(1)).toBe(2);
    expect(exp2(-4.75 + 69 / 12) * 220).toBeCloseTo(440, 9);
    expect(exp10(2)).toBe(100);
    expect(Math.abs(exp10(-0.3) - Math.pow(10, -0.3))).toBeLessThan(1e-16);
  });
});

describe('Morphine: state, formats, presets', () => {
  it('has a synthesized default program that normalises stably', () => {
    const st = normalizeGenParams('morphine', defaultGenParams('morphine'));
    expect(st.progName).toBe('Init');
    expect((st.gens as MGen[]).length).toBe(4);
    expect(st.spectraMissing).toBeUndefined();
    expect(normalizeMorphine(JSON.parse(JSON.stringify(st)))).toEqual(st);
    const a = (st.gens as MGen[])[0].zones[0].bp[0].a!;
    expect(a[0]).toBeCloseTo(Math.cbrt(0.5), 6); // saw, stored as cube roots
  });

  it('round-trips a program through the .mrp writer and reader', () => {
    const st = normalizeMorphine(defaultProgram());
    // a richer structure: two zones, two breakpoints with pan / detune, a morph path, envelopes, matrix
    const gens = st.gens as MGen[];
    const z0 = gens[1].zones[0];
    const z1: MZone = { ...z0, w: 70, l: 0.5, bp: [
      { t: 12, l: 0.75, a: [1, 0.5, 0, 0.25], p: [0, -0.5, 0, 0.25], d: [0, 0.01] },
      { t: 5, l: 1, a: [0.2], p: [0.1], d: [0] },
    ], ca: Array.from({ length: 128 }, (_, k) => 1 - k / 256), cb: 0.75, lm: 1, ls: 3, le: 15, rl: 1, rate: 0.25 };
    gens[1] = { pwm: 2, cz: 0, zones: [{ ...z0, w: 58 }, z1] };
    st.gens = gens;
    st.morph = { pts: [[0, 1, 10], [1, 0, 20], [0.5, 0.5, 5]], ls: 0, le: 30, lm: 3, solo: 0 };
    st.envs = [{ pts: [[0, 10], [1, 20], [0.5, 100]], ls: 10, le: 30, lm: 1, bip: 1 }, ...(st.envs as unknown[]).slice(1)];
    st.mod = { src: [5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], dst: [3, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], amt: [0.75, 0.25, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] };
    st.noise = 'Breath_01.wav';
    st.poly = 7; st.glideMode = 3; st.nzLoop = 1; st.nzFlt = 2;
    st[key(0)] = vOf(0.495); st[key(45)] = 100; st[key(104)] = 256;
    const n = normalizeMorphine(st);
    const bytes = writeMrp(stateToRaw(n));
    expect(String.fromCharCode(bytes[3], bytes[2], bytes[1], bytes[0])).toBe('Mor0');
    const back = normalizeMorphine(rawToState(parseMrp(bytes)));
    for (let i = 0; i < 123; i++) expect(back[key(i)], key(i)).toBe(n[key(i)]);
    for (const k of ['progName', 'poly', 'glideMode', 'nzLoop', 'nzFlt', 'morph', 'envs', 'mod', 'noise']) expect(back[k], k).toEqual(n[k]);
    const bz = (back.gens as MGen[])[1].zones[1];
    expect(bz.w).toBe(70);
    expect(bz.l).toBe(0.5);
    expect(bz.bp.map((b) => [b.t, b.l])).toEqual([[12, 0.75], [5, 1]]);
    expect(bz.bp[0].a!.slice(0, 4)).toEqual([1, 0.5, 0, 0.25]);
    expect(bz.bp[0].p!.slice(0, 4)).toEqual([0, -0.5, 0, 0.25]);
    expect(bz.bp[0].d![1]).toBe(Math.fround(0.01));
    expect((bz.ca as number[])[100]).toBe(Math.fround(1 - 100 / 256));
    expect(bz.cb).toBe(0.75);
    expect((back.gens as MGen[])[1].pwm).toBe(2);
    // writing the read program again gives the same bytes
    expect(writeMrp(stateToRaw(back))).toEqual(bytes);
    // FL state blob and .fst container
    const flss = writeFlState(stateToRaw(n));
    expect(String.fromCharCode(...flss.slice(0, 4))).toBe('SSLF');
    expect(normalizeMorphine(rawToState(parseMorphineFile(flss)!))).toEqual(back);
    const fst = fakeFst(flss);
    expect(fstBlob(fst)).toEqual(flss);
    expect(normalizeMorphine(rawToState(parseMorphineFile(fst)!))).toEqual(back);
    expect(parseMorphineFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
    expect(parseMorphineFile(bytes.slice(0, bytes.length - 10))).toBeNull();
  });

  it('selects a zone: the generator parameters follow the current zone', () => {
    const st = normalizeMorphine(defaultProgram());
    const gens = st.gens as MGen[];
    gens[0] = { ...gens[0], zones: [gens[0].zones[0], { ...gens[0].zones[0], rate: 0.75, kt: 0.25 }] };
    const u = selectZone({ ...st, gens }, 0, 1);
    expect(fOf(u[key(45)] as number)).toBe(0.75);
    expect(fOf(u[key(47)] as number)).toBe(0.25);
    expect((u.gens as MGen[])[0].cz).toBe(1);
  });

  it('has the 300 factory programs as parameter-level data with synthesized spectra', () => {
    expect(def.presets!.length).toBe(300);
    expect(def.presets![0].name).toBe('Bass/BAS Acoustic 1 FG');
    const fp = factoryProgram(0)!;
    expect(fp.spectraMissing).toBe(1);
    expect(fOf(fp[key(0)] as number)).toBe(Math.fround(0.495));
    const gens = fp.gens as MGen[];
    expect(gens.reduce((n, g) => n + g.zones.length, 0)).toBe(5);
    expect(gens[0].zones.every((z) => z.bp.every((b) => !b.a && b.s === undefined))).toBe(true);
    expect(factoryPresetIndex('BAS Acoustic 1 FG')).toBe(0);
    expect(factoryPresetIndex('Bass/BAS Acoustic 1 FG.mrp')).toBe(0);
    // a preset state replaces the whole program and drops content references of the previous one
    const cur = { ...normalizeGenParams('morphine', defaultGenParams('morphine')), spectraSample: 'x', noiseSample: 'y' };
    const st = genPresetState('morphine', def.presets![0], cur);
    expect(st.spectraSample).toBeUndefined();
    expect(st.noiseSample).toBeUndefined();
    expect(st.progName).toBe('BAS Acoustic 1 FG');
  });
});

describe('Morphine: FL content import helpers', () => {
  it('reads noise WAVs with FL\'s conversions and the smpl loop', () => {
    const w = wav16([0, 16384, -32768, 32767], 48000, [1, 3]);
    const n = parseNoiseWav(w)!;
    expect(n.sampleRate).toBe(48000);
    expect(Array.from(n.channels[0])).toEqual([0, 0.5, -1, Math.fround(32767 / 32768)]);
    expect(n.loop).toEqual([1, 3]);
    const f = parseNoiseWav(floatWav([n.channels[0]], 44100))!;
    expect(Array.from(f.channels[0])).toEqual(Array.from(n.channels[0]));
    expect(parseNoiseWav(new Uint8Array(100))).toBeNull();
  });

  it('imports the spectra of a picked program file into pool rows', () => {
    // the "FL file": a program with real spectra; the state: the same program without them
    const real = normalizeMorphine(defaultProgram());
    (real.gens as MGen[])[2].zones[0].bp[0].p = [0.5, -0.5];
    const file = writeMrp(stateToRaw(real));
    const stub = normalizeMorphine({ ...real, gens: (real.gens as MGen[]).map((g) => ({ ...g, zones: g.zones.map((z) => ({ ...z, bp: z.bp.map((b) => ({ t: b.t, l: b.l })) })) })), spectraMissing: 1 });
    const r = importProgram(file, stub)!;
    expect(r.matched).toBe(true);
    expect(r.spectra!.length).toBe(4 * 3 * 128);
    const st = applyUpdates({ ...stub, spectraSample: 'pool-id' }, r.updates);
    expect(st.spectraMissing).toBeUndefined();
    const bp = (st.gens as MGen[])[2].zones[0].bp[0];
    expect(bp.s).toBe(6);
    expect(r.spectra![(bp.s! + 1) * 128]).toBe(0.5);
    expect(presetFileFor({ __preset: 'Bass/BAS Acoustic 1 FG' }, ['Morphine/Leads/x.mrp', 'Morphine/Bass/BAS Acoustic 1 FG.mrp'])).toBe(1);
    expect(noiseFileFor({ noise: 'Breath_01.wav' }, ['a/Noise Samples/breath_01.wav'])).toBe(0);
  });
});

// ------------------------------------------------------------------ engine

const env: GenEnv = { sample: () => undefined };
const ctx = { sampleRate: 44100, blockSize: 128, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };

function note(id: number, key: number, vel = 100, pan = 0): GenNote {
  const lv = () => ({ pan, vol: 1, pitch: key * 100, fcut: 0, fres: 0 });
  return { id, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init: { ...lv(), vol: vel === 100 ? 1 : (11 ** (vel / 100) - 1) / 10 }, levels: lv() } as GenNote;
}

function play(st: Record<string, unknown>, notes: GenNote[], frames: number, offAt = Infinity): [Float32Array, Float32Array] {
  const inst = new MorphineInstance(44100, 128, env);
  inst.setParams(st);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const bl = new Float32Array(128), br = new Float32Array(128);
  notes.forEach((n) => inst.noteOn(n, 0));
  for (let p = 0; p < frames; p += 128) {
    if (p <= offAt && offAt < p + 128) notes.forEach((n) => inst.noteOff(n, offAt - p));
    bl.fill(0); br.fill(0);
    inst.render(bl, br, 128, ctx);
    L.set(bl.subarray(0, Math.min(128, frames - p)), p);
    R.set(br.subarray(0, Math.min(128, frames - p)), p);
  }
  return [L, R];
}

function stats(x: Float32Array, a: number, b: number) {
  let peak = 0, sq = 0, finite = true;
  for (let i = a; i < b; i++) { if (!Number.isFinite(x[i])) finite = false; peak = Math.max(peak, Math.abs(x[i])); sq += x[i] * x[i]; }
  return { peak, rms: Math.sqrt(sq / (b - a)), finite };
}

/** One partial (index k, amplitude a) in generator A, no velocity sensitivity, FL's reset values elsewhere. */
function onePartial(k: number, pan = 0): Record<string, unknown> {
  const st = normalizeMorphine(defaultProgram());
  const amp = new Array(128).fill(0);
  amp[k] = 1;
  const pn = new Array(128).fill(0);
  pn[k] = pan;
  const gens = st.gens as MGen[];
  gens[0] = { pwm: 0, cz: 0, zones: [{ ...gens[0].zones[0], ca: 0, bp: [{ t: 100, l: 1, a: amp, p: pn }] }] };
  for (let g = 1; g < 4; g++) gens[g] = { ...gens[g], zones: [{ ...gens[g].zones[0], bp: [{ t: 100, l: 1 }] }] };
  return normalizeMorphine({ ...st, gens });
}

describe('Morphine: engine', () => {
  it('renders the default program and factory presets (stand-in spectra): finite and not silent', () => {
    const def0 = normalizeGenParams('morphine', defaultGenParams('morphine'));
    const [L] = play(def0, [note(1, 60), note(2, 64, 80)], 22050);
    const s = stats(L, 0, 22050);
    expect(s.finite).toBe(true);
    expect(s.rms).toBeGreaterThan(0.01);
    for (const i of [0, 40, 120, 200, 299]) {
      const st = genPresetState('morphine', def.presets![i]);
      const [l, r] = play(st, [note(1, 60), note(2, 67, 110)], 22050, 11025);
      const a = stats(l, 0, 22050), b = stats(r, 0, 22050);
      expect(a.finite && b.finite, def.presets![i].name).toBe(true);
      expect(a.rms + b.rms, def.presets![i].name).toBeGreaterThan(1e-4);
    }
  });

  it('plays a single partial at the key frequency and FL\'s level (master 0.5, centre pan 0.7071 x 0.5)', () => {
    const [L, R] = play(onePartial(0), [note(1, 69)], 44100);
    // frequency from zero crossings after the attack
    const zc: number[] = [];
    for (let i = 4411; i < 44100; i++) if (L[i - 1] < 0 && L[i] >= 0) zc.push(i - L[i] / (L[i] - L[i - 1]));
    const hz = (44100 * (zc.length - 1)) / (zc[zc.length - 1] - zc[0]);
    expect(hz).toBeCloseTo(440, 1);
    const s = stats(L, 22050, 44100);
    const tilt = 1 - (1.323042998897464 * 440) / 44100;
    const circle = 1 / Math.cos((Math.PI * 440) / 44100);
    expect(s.peak).toBeGreaterThan(0.5 * 0.70710677 * 0.5 * tilt * 0.999);
    expect(s.peak).toBeLessThan(0.5 * 0.70710677 * 0.5 * tilt * circle * 1.001);
    expect(stats(R, 22050, 44100).peak).toBeCloseTo(s.peak, 6);
  });

  it('pans a partial with its pan value and plays partial k at (k + 1) x the key frequency', () => {
    const [L, R] = play(onePartial(2, 1), [note(1, 57)], 22050);
    expect(stats(L, 11025, 22050).peak).toBeLessThan(1e-6);
    const zc: number[] = [];
    for (let i = 11026; i < 22050; i++) if (R[i - 1] < 0 && R[i] >= 0) zc.push(i - R[i] / (R[i] - R[i - 1]));
    expect((44100 * (zc.length - 1)) / (zc[zc.length - 1] - zc[0])).toBeCloseTo(660, 0);
  });

  it('releases and frees its voices; the stand-in spectra are the synthesized ones', () => {
    const inst = new MorphineInstance(44100, 128, env);
    inst.setParams(onePartial(0));
    const n = note(1, 60);
    inst.noteOn(n, 0);
    const b = new Float32Array(128);
    for (let i = 0; i < 40; i++) inst.render(b.fill(0), b, 128, ctx);
    expect(inst.isActive()).toBe(true);
    inst.noteOff(n, 0);
    for (let i = 0; i < 400; i++) inst.render(b.fill(0), new Float32Array(128), 128, ctx);
    expect(inst.isActive()).toBe(false);
    expect(substituteSpectrum(0)[0]).toBeCloseTo(Math.cbrt(0.5), 6);
  });

  it('plays a note off before another note\'s note on at the same sample (FL\'s order)', () => {
    const inst = new MorphineInstance(44100, 128, env);
    inst.setParams(onePartial(0));
    const order: string[] = [];
    const s = inst.synth as unknown as { noteOn(k: number, v: number): void; noteOff(k: number): void };
    const on = s.noteOn.bind(s), off = s.noteOff.bind(s);
    s.noteOn = (k, v) => { order.push(`on ${k}`); on(k, v); };
    s.noteOff = (k) => { order.push(`off ${k}`); off(k); };
    const a = note(1, 60), b = note(2, 62), c = note(3, 64);
    const L = new Float32Array(128), R = new Float32Array(128);
    inst.noteOn(a, 0);
    inst.render(L, R, 128, ctx);
    // the channel may send the new voice first (voice slots are reused); a zero-length note keeps its own order
    inst.noteOn(b, 5);
    inst.noteOn(c, 5);
    inst.noteOff(c, 5);
    inst.noteOff(a, 5);
    inst.render(L, R, 128, ctx);
    expect(order).toEqual(['on 60', 'off 60', 'on 62', 'on 64', 'off 64']);
  });

  it('starts a new instance\'s master gain at FL\'s constructor program (the loaded state glides from there)', () => {
    const fresh = new MorphineInstance(44100, 128, env);
    const ctor = new MorphineInstance(44100, 128, env, factoryProgram(0)!);
    const init = new MorphineInstance(44100, 128, env, defaultProgram());
    expect(fresh.synth.gL).toBe(ctor.synth.gL);
    expect(fresh.synth.gR).toBe(ctor.synth.gR);
    expect(init.synth.gL).not.toBe(ctor.synth.gL);
    // the same state set on both: identical output from the first sample
    const st = onePartial(0);
    fresh.setParams(st);
    ctor.setParams(st);
    const a = new Float32Array(128), b = new Float32Array(128);
    const n1 = note(1, 69), n2 = note(1, 69);
    fresh.noteOn(n1, 0);
    ctor.noteOn(n2, 0);
    for (let i = 0; i < 20; i++) {
      fresh.render(a.fill(0), new Float32Array(128), 128, ctx);
      ctor.render(b.fill(0), new Float32Array(128), 128, ctx);
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });

  it('keeps rendering like FL while an effect is on or the master gain glides', () => {
    const inst = new MorphineInstance(44100, 128, env);
    const st = onePartial(0);
    inst.setParams(st);
    const b = new Float32Array(128);
    for (let i = 0; i < 400; i++) inst.render(b.fill(0), new Float32Array(128), 128, ctx);
    expect(inst.isActive()).toBe(false);
    // the reverb on: its tail (and FL's always-running effects) keep the plugin rendering
    inst.setParams({ ...st, [key(20)]: vOf(1) });
    expect(inst.isActive()).toBe(true);
    // a master level change glides at 0.005 per sample until a step holds
    inst.setParams({ ...st, [key(0)]: vOf(0.25) });
    expect(inst.isActive()).toBe(true);
    for (let i = 0; i < 400; i++) inst.render(b.fill(0), new Float32Array(128), 128, ctx);
    expect(inst.isActive()).toBe(false);
  });
});

// ------------------------------------------------------------------ helpers

function wav16(samples: number[], rate: number, loop?: [number, number]): Uint8Array {
  const smpl = loop ? 60 + 8 : 0;
  const out = new Uint8Array(44 + samples.length * 2 + smpl);
  const dv = new DataView(out.buffer);
  const w4 = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  w4(0, 'RIFF'); dv.setUint32(4, out.length - 8, true); w4(8, 'WAVE');
  w4(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  let o = 36;
  if (loop) {
    w4(o, 'smpl'); dv.setUint32(o + 4, 60, true);
    dv.setUint32(o + 8 + 28, 1, true); dv.setUint32(o + 8 + 44, loop[0], true); dv.setUint32(o + 8 + 48, loop[1], true);
    o += 68;
  }
  w4(o, 'data'); dv.setUint32(o + 4, samples.length * 2, true);
  samples.forEach((s, i) => dv.setInt16(o + 8 + 2 * i, s, true));
  return out;
}

/** A minimal FL .fst (FLhd / FLdt with event 0xD5 = the plugin state). */
function fakeFst(blob: Uint8Array): Uint8Array {
  const len: number[] = [];
  let n = blob.length;
  do { let c = n & 0x7f; n >>>= 7; if (n) c |= 0x80; len.push(c); } while (n);
  const ev = new Uint8Array([0xd5, ...len, ...blob]);
  const out = new Uint8Array(14 + 8 + ev.length);
  const dv = new DataView(out.buffer);
  out.set([0x46, 0x4c, 0x68, 0x64]); dv.setUint32(4, 6, true);
  out.set([0x46, 0x4c, 0x64, 0x74], 14); dv.setUint32(18, ev.length, true);
  out.set(ev, 22);
  return out;
}
