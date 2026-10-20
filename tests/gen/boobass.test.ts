// BooBass (FL: BooBass): registration, the engine port's FL behaviour (pitch
// three octaves below FL's C5, mono re-strike, 18 ms release, FL's EQ gain
// law, per-block parameter ramps), the FL data import (Mach-O parsing of the
// user's BooBass_Eng_x64.dylib, the pool pack) and finiteness. With FL Studio
// installed, FL's own recordings are read from the install and the render is
// compared with FL's (test host numbers pinned below; nothing of FL is stored here).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { genDef, defaultGenParams, formatParam, genInCategory } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { GenChannel } from '../../src/engine/GenChannel';
import { createGenChannel } from '../../src/model/defaults';
import type { SeqNote } from '../../src/engine/Sequencer';
import type { GenEnv, GenVoiceParams } from '../../src/engine/gen/types';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';
import { BooCore, booRate, knob } from '../../src/engine/gen/plugins/boobass/core';
import { buildTables, packFlData, unpackFlData } from '../../src/engine/gen/plugins/boobass/tables';
import { exp10f, sincosf, sincos } from '../../src/engine/gen/plugins/boobass/libm';
import { fma32 } from '../../src/engine/gen/plugins/boobass/f32';
import { synthPcm } from '../../src/engine/gen/plugins/boobass/synth';
import { readBooBassData, FlDataError, STRIKE_SYMS, WAVE_SYMS } from '../../src/ui/plugins/gen/boobass/macho';

const D = genDef('boobass')!;
const FL_DYLIB = '/Applications/FL Studio 2026.app/Contents/Resources/FL/Plugins/Fruity/Generators/BooBass/BooBass_Eng_x64.dylib';
const NO_ENV: GenEnv = { sample: () => undefined };

interface N { key: number; vel?: number; start: number; len: number; pan?: number }

/** Render notes (sample positions) through a real channel at volume 100 %, centred, like FL's test host. */
function render(notes: N[], frames: number, o: { sr?: number; params?: Record<string, unknown>; env?: GenEnv; at?: [number, Record<string, unknown>][] } = {}): [Float32Array, Float32Array] {
  const sr = o.sr ?? 44100, block = 128;
  const ch = createGenChannel('boobass');
  ch.volume = 1;
  ch.plugin!.params = { ...defaultGenParams('boobass'), ...(o.params ?? {}) };
  const ctx = { sampleRate: sr, blockSize: block, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
  const c = new GenChannel(ch.id, sr, block, 'boobass', o.env ?? NO_ENV, ctx as never);
  c.setGlobals({ tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } as never);
  c.apply(ch);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const bL = new Float32Array(block), bR = new Float32Array(block);
  const at = [...(o.at ?? [])].sort((a, b) => a[0] - b[0]);
  for (let off = 0; off < frames; off += block) {
    while (at.length && at[0][0] <= off) { ch.plugin!.params = { ...ch.plugin!.params, ...at.shift()![1] }; c.apply(ch); }
    const n = Math.min(block, frames - off);
    for (const e of notes) {
      if (e.start < off || e.start >= off + n) continue;
      c.scheduleNote({ pos: 0, len: 0, oneShot: false, key: e.key, vel: e.vel ?? 100, rel: 64, pan: Math.round(64 + 64 * (e.pan ?? 0)), fine: 120, modX: 128, modY: 128, slide: false, porta: false, color: 0, chId: ch.id } as SeqNote, e.start - off, e.len);
    }
    bL.fill(0); bR.fill(0);
    c.render(bL.subarray(0, n), bR.subarray(0, n), n);
    L.set(bL.subarray(0, n), off); R.set(bR.subarray(0, n), off);
  }
  return [L, R];
}

function rms(b: Float32Array, a = 0, z = b.length): number {
  let s = 0;
  for (let i = a; i < z; i++) s += b[i] * b[i];
  return Math.sqrt(s / Math.max(1, z - a));
}

/** f0 by autocorrelation (lag search between fmin and fmax), parabolic refinement. */
function f0(b: Float32Array, a: number, z: number, sr: number, fmin = 20, fmax = 500): number {
  const x = b.subarray(a, z);
  let best = 0, bl = 0;
  const lo = Math.floor(sr / fmax), hi = Math.ceil(sr / fmin);
  const ac = (l: number) => { let s = 0; for (let i = 0; i + l < x.length; i++) s += x[i] * x[i + l]; return s; };
  const vals: number[] = [];
  for (let l = lo; l <= hi; l++) { const v = ac(l); vals.push(v); if (v > best) { best = v; bl = l; } }
  for (let l = lo + 1; l < hi; l++) { const v = vals[l - lo]; if (v > 0.9 * best && v >= vals[l - lo - 1] && v >= vals[l - lo + 1]) { bl = l; break; } }
  const y0 = vals[bl - lo - 1], y1 = vals[bl - lo], y2 = vals[bl - lo + 1];
  return sr / (bl + (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2));
}

function voiceParams(key: number, vel = 100): GenVoiceParams {
  const init = newLevels(), levels = newLevels();
  setInitLevels(init, (key - 60) * 100, vel, 0, 0, 0);
  Object.assign(levels, init);
  return { key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

const flData = existsSync(FL_DYLIB) ? (() => { const b = readFileSync(FL_DYLIB); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })() : null;

describe('BooBass: registration', () => {
  it('has FL\'s parameters, ranges, defaults, value texts and panel size', () => {
    expect(D.name).toBe('BooBass');
    expect(D.category).toBe('Misc');
    expect(genInCategory('Misc').map((d) => d.id)).toContain('boobass');
    expect(D.notes).toBe('voices');
    expect(D.levels).toBe('plugin');
    expect(D.velocity ?? 'levels').toBe('levels');
    expect(D.defPoly ?? 0).toBe(0);
    expect([D.width, D.height]).toEqual([340, 150]);
    expect(D.params.map((q) => [q.index, q.key, q.name, q.min, q.max, q.def])).toEqual([
      [0, 'bass', 'Bass', 0, 65535, 32767],
      [1, 'mid', 'Mid', 0, 65535, 32767],
      [2, 'treble', 'Treble', 0, 65535, 32767],
    ]);
    // FL's texts (test host sweep of all 65536 values): round(v / 65535 x 100) %
    const q = D.params[0];
    expect([0, 327, 328, 32767, 65207, 65208, 65535].map((v) => formatParam(q, v))).toEqual(['0%', '0%', '1%', '50%', '99%', '100%', '100%']);
    expect(D.presets ?? []).toEqual([]);
    expect(defaultGenParams('boobass')).toMatchObject({ bass: 32767, mid: 32767, treble: 32767, dataSample: '' });
  });
});

describe('BooBass: FL\'s engine behaviour', () => {
  it('plays three octaves below FL\'s C5 (key 60 = 65.42 Hz), following the key and the sample rate', () => {
    const [a] = render([{ key: 60, start: 0, len: 44100 }], 44100);
    expect(f0(a, 22050, 44100, 44100)).toBeCloseTo(65.42, 0);
    const [b] = render([{ key: 72, start: 0, len: 44100 }], 44100);
    expect(f0(b, 22050, 44100, 44100)).toBeCloseTo(130.84, 0);
    const [c] = render([{ key: 60, start: 0, len: 48000 }], 48000, { sr: 48000 });
    expect(f0(c, 24000, 48000, 48000)).toBeCloseTo(65.42, 0);
  });

  it('applies FL\'s velocity curve and pan law (levels: plugin)', () => {
    const [a] = render([{ key: 55, start: 0, len: 22016 }], 22016);
    const [b, bR] = render([{ key: 55, vel: 64, start: 0, len: 22016 }], 22016);
    expect(20 * Math.log10(rms(b) / rms(a))).toBeCloseTo(-8.779, 2);
    const [p, pR] = render([{ key: 55, start: 0, len: 22016, pan: 0.5 }], 22016);
    sincosf(Math.fround(1.5 * 0.7853981633974483));
    expect(rms(pR) / rms(p)).toBeCloseTo(sincos.s / sincos.c, 5);
    expect(rms(bR)).toBeCloseTo(rms(b), 9);
  });

  it('is monophonic: a new note cuts the sounding one at its first sample', () => {
    const inst = createGen('boobass', 44100, 128)!;
    inst.setParams(defaultGenParams('boobass'));
    const ctx = { sampleRate: 44100, blockSize: 128, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
    const L = new Float32Array(128), R = new Float32Array(128), s = new Float32Array(16);
    const p1 = voiceParams(48), p2 = voiceParams(55);
    const v1 = inst.triggerVoice!(p1)!;
    for (let o = 0; o < 128; o += 16) { p1.frame = o; expect(v1.render(s, s, 16)).toBe(true); }
    inst.render!(L, R, 128, ctx);
    const v2 = inst.triggerVoice!(p2)!;
    p1.frame = 0; v1.render(s, s, 16);
    p2.frame = 0; v2.render(s, s, 16);
    inst.render!(L, R, 16, ctx);
    // FL killed the first voice: it reports its end, the second plays on
    expect(v1.render(s, s, 16)).toBe(false);
    expect(v2.render(s, s, 16)).toBe(true);
  });

  it('releases over FL\'s 18.2 ms (801 samples at 44.1 kHz) and then ends', () => {
    // note-off at 22000 (a control-step boundary): the voice ends at the end of the step that
    // reaches the envelope's last stage, 22000 + 802 -> step [22800, 22816): last sample 22815 (FL: 22815)
    const [a] = render([{ key: 60, start: 0, len: 22000 }], 26460);
    let last = -1;
    for (let i = 0; i < a.length; i++) if (a[i] !== 0) last = i;
    expect(last).toBe(22815);
    expect(rms(a, 22000 + 700, 22000 + 800)).toBeLessThan(rms(a, 21800, 22000) / 8);
  });

  it('uses FL\'s EQ gain law (exp10f of the knob) and steps EQ changes per block', () => {
    const core = new BooCore(booRate(44100), buildTables(synthPcm()));
    core.setBass(knob(32767)); core.setMid(knob(32767)); core.setTreble(knob(32767));
    // values read from FL's engine with lldb at the defaults
    expect([core.tB, core.tM, core.tT]).toEqual([0.501181901, 0.562336385, 0.707938313].map(Math.fround));
    core.setBass(knob(6553));
    expect([core.tB, core.drive]).toEqual([0, 0]); // below 10 %: off
    core.setBass(knob(65535));
    expect(core.tB).toBe(1);
    // a change during a note reaches its target within one 16-sample block (FL: d / n x 16 after the block's first sample)
    core.trigger(0, 1, 0);
    const buf = new Float32Array(16), L = new Float32Array(16), R = new Float32Array(16);
    core.setBass(knob(0));
    core.render(L, R, 0, 16, 0, 1, 0, buf);
    expect(core.cB).toBe(0);
  });

  it('reproduces macOS libm where FL depends on it (exp10f, __sincosf_stret)', () => {
    // the B0 strike level: Apple's exp10f(-0.0333) is 0.92618978, Math.pow rounds to 0.92618984
    expect(exp10f(Math.fround(Math.fround(0.666) * Math.fround(-0.05)))).toBe(Math.fround(0.9261897802352905));
    sincosf(Math.fround(0.7853981633974483));
    expect([sincos.s, sincos.c]).toEqual([Math.fround(0.7071067690849304), Math.fround(0.7071067690849304)]);
    expect(fma32(Math.fround(0.1), Math.fround(3), Math.fround(-0.3))).toBe(Math.fround(Math.fround(0.1) * 3 - Math.fround(0.3)));
  });
});

describe('BooBass: FL data', () => {
  it('packs the 12 tables into a pool sample that survives 24-bit dithered storage', () => {
    const pcm = synthPcm();
    const pack = packFlData(pcm);
    const back = unpackFlData(pack)!;
    expect(back.strikes.map((t) => t.length)).toEqual(pcm.strikes.map((t) => t.length));
    expect(Array.from(back.waves[3])).toEqual(Array.from(pcm.waves[3]));
    const noisy = pack.map((v, i) => v + ((i * 7919) % 5 - 2) / 8388608);
    expect(Array.from(unpackFlData(noisy)!.strikes[2]).slice(0, 64)).toEqual(Array.from(pcm.strikes[2]).slice(0, 64));
    expect(unpackFlData(new Float32Array(100))).toBeNull();
    expect(unpackFlData(pack.subarray(0, 50))).toBeNull();
  });

  it('reads tables from a Mach-O library by symbol and rejects anything else', () => {
    const pcm = synthPcm();
    const lib = fakeMachO([...pcm.strikes, ...pcm.waves]);
    const { pcm: got, arch } = readBooBassData(lib);
    expect(arch).toBe('arm64');
    expect(Array.from(got.waves[5])).toEqual(Array.from(pcm.waves[5]));
    expect(got.strikes[0].length).toBe(pcm.strikes[0].length);
    expect(() => readBooBassData(new ArrayBuffer(10))).toThrow(FlDataError);
    expect(() => readBooBassData(lib.slice(0, 200))).toThrow(FlDataError);
    const bad = lib.slice(0);
    new DataView(bad).setUint32(0, 0x12345678, true);
    expect(() => readBooBassData(bad)).toThrow(FlDataError);
    expect(() => readBooBassData(fakeMachO([...pcm.strikes, ...pcm.waves], 11))).toThrow(FlDataError);
  });

  it.skipIf(!flData)('with FL\'s recordings (read from the FL install) renders FL\'s samples', () => {
    const { pcm } = readBooBassData(flData!);
    const pack = packFlData(pcm);
    const env: GenEnv = { sample: (id) => (id === 'fl' ? { channels: [pack], sampleRate: 44100 } : undefined) };
    const [L] = render([{ key: 60, start: 0, len: 22000 }], 26460, { env, params: { dataSample: 'fl' } });
    // FL test host: flfxhost render BooBass --block 16 --notes 60:100:0:0.49886621 (bit-exact port)
    const fl = [0, -3.5911255054088542e-06, -2.7009216864826158e-05, -9.904882608680055e-05, -0.0002431429165881127, -0.00046267927973531187];
    expect(Array.from(L.subarray(0, 6))).toEqual(fl.map(Math.fround));
    expect(L[100]).toBe(Math.fround(-0.045591916888952255));
    expect(L[1000]).toBe(Math.fround(-0.12071360647678375));
    expect(L[10000]).toBe(Math.fround(0.05354329198598862));
    expect(L[20000]).toBe(Math.fround(-0.027251962572336197));
    expect(L[208]).toBe(Math.fround(0.34369632601737976));
    expect(rms(L, 0, 22000)).toBeCloseTo(0.09875569610664424, 9);
  });
});

describe('BooBass: robustness', () => {
  it('stays finite at extreme keys, velocities, settings and with damaged data', () => {
    const env: GenEnv = { sample: () => ({ channels: [new Float32Array(500).fill(0.3)], sampleRate: 44100 }) };
    for (const params of [{ bass: 0, mid: 0, treble: 0 }, { bass: 65535, mid: 65535, treble: 65535 }, { bass: Number.NaN, mid: -5, treble: 1e9, dataSample: 'x' }]) {
      const [L, R] = render([{ key: 0, vel: 128, start: 0, len: 4000 }, { key: 131, vel: 1, start: 4096, len: 4000 }, { key: 24, start: 8192, len: 2000 }], 12000, { params, env });
      for (let i = 0; i < L.length; i++) { expect(Number.isFinite(L[i])).toBe(true); expect(Number.isFinite(R[i])).toBe(true); }
    }
  });
});

/** A minimal thin arm64 Mach-O with the 24 BooBass symbols (tables in one segment). */
function fakeMachO(tables: ArrayLike<number>[], drop = -1): ArrayBuffer {
  const names = [...STRIKE_SYMS, ...WAVE_SYMS];
  const dataOff = 4096;
  let size = 0;
  const offs: number[] = [];
  for (const t of tables) { offs.push(size); size += 4 + t.length * 2 + (t.length & 1 ? 2 : 0); }
  const syms: [string, number][] = [];
  names.forEach((n, i) => { if (i !== drop) { syms.push([n, 0x8000 + offs[i] + 4]); syms.push([n + 'Length', 0x8000 + offs[i]]); } });
  let strtab = '\0';
  const strx = syms.map(([n]) => { const x = strtab.length; strtab += n + '\0'; return x; });
  const symOff = dataOff + size, strOff = symOff + syms.length * 16;
  const total = strOff + strtab.length;
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  v.setUint32(0, 0xfeedfacf, true); v.setUint32(4, 0x0100000c, true);
  v.setUint32(16, 2, true); v.setUint32(20, 72 + 24, true);
  let p = 32;
  v.setUint32(p, 0x19, true); v.setUint32(p + 4, 72, true);
  v.setUint32(p + 24, 0x8000, true); v.setUint32(p + 32, size, true); v.setUint32(p + 40, dataOff, true); v.setUint32(p + 48, size, true);
  p += 72;
  v.setUint32(p, 0x2, true); v.setUint32(p + 4, 24, true); v.setUint32(p + 8, symOff, true); v.setUint32(p + 12, syms.length, true); v.setUint32(p + 16, strOff, true); v.setUint32(p + 20, strtab.length, true);
  tables.forEach((t, i) => {
    v.setInt32(dataOff + offs[i], t.length * 2, true);
    for (let k = 0; k < t.length; k++) v.setInt16(dataOff + offs[i] + 4 + 2 * k, t[k], true);
  });
  syms.forEach(([, a], i) => { v.setUint32(symOff + i * 16, strx[i], true); v.setUint8(symOff + i * 16 + 4, 0x0f); v.setUint32(symOff + i * 16 + 8, a, true); });
  for (let i = 0; i < strtab.length; i++) v.setUint8(strOff + i, strtab.charCodeAt(i));
  return buf;
}
