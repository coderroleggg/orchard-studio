// Harmless: registration, FL's value texts, the state blob, presets, and the
// engine against values captured from FL 2026's Harmless renders (test host,
// key 60 velocity 100 for 0.5 s after FL's 0.25 s preroll in 512-sample blocks;
// FL's random generator seeded from CACurrentMediaTime() = 1000 s, i.e. MT
// seed 1e9, which the engine core takes as its seed here).
import { describe, it, expect } from 'vitest';
import { GEN_DEFS, formatParam } from '../../src/model/gen/registry';
import { HL_KEYS, HL_PARAMS } from '../../src/model/gen/plugins/harmless/params';
import { HL_BASE_EXTRAS, HL_BASE_PARAMS } from '../../src/model/gen/plugins/harmless/presets';
import { CUSTOM_N, TIMBRE_CUSTOM, hlDecodeBlob, hlFstBlob, hlStateFromDecoded } from '../../src/model/gen/plugins/harmless/state';
import { analyzeCycle, customFrames, decodeHarmlessFile, presetScore } from '../../src/model/gen/plugins/harmless/import';
import { HlCore } from '../../src/engine/gen/plugins/harmless/core';
import { gen } from '../../src/engine/gen/plugins/harmless';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';

const def = () => GEN_DEFS.find((d) => d.id === 'harmless')!;
const EX = (e: ArrayLike<number>) => ({ filterType: e[0], resType: e[1], phaserType: e[2], compType: e[3], timbre: e[4], threaded: e[5], quality: e[6] });

/** The plugin database state (a new Harmless in FL) through FL's test host block pattern. */
function renderCore(sr: number, frames: number): Float32Array {
  const core = new HlCore(sr, 512, 1000000000);
  core.setTempo(130);
  core.setState(HL_BASE_PARAMS, EX(HL_BASE_EXTRAS), null);
  const pre = Math.round(0.25 * sr);
  for (let t = -pre; t < 0;) { const n = Math.min(512, -t); core.render(n); t += n; }
  core.trigger(1, 0, Math.fround(100 / 128), { pan: 0, vol: 1, pitch: 0, fcut: 0, fres: 0 });
  const off = Math.round(0.5 * sr);
  const out = new Float32Array(frames * 2);
  for (let t = 0; t < frames;) {
    if (t === off) core.release(1, Math.fround(64 / 128));
    let n = Math.min(512, frames - t);
    if (t < off && t + n > off) n = off - t;
    out.set(core.render(n).subarray(0, 2 * n), 2 * t);
    t += n;
  }
  return out;
}

describe('Harmless model', () => {
  it('is registered as an events instrument with FL\'s 100 parameters and its factory presets', () => {
    const d = def();
    expect(d).toBeTruthy();
    expect(d.notes).toBe('events');
    expect(d.params.length).toBe(100);
    expect(HL_KEYS.length).toBe(100);
    expect(d.width).toBe(848);
    expect(d.height).toBe(569);
    const names = d.presets!.map((p) => p.name);
    expect(names.length).toBeGreaterThan(400);
    expect(names.some((n) => n.includes('Boulder AG'))).toBe(true);
  });

  it('shows FL\'s value texts', () => {
    const t = (k: string, v: number) => formatParam(HL_PARAMS.find((p) => p.key === k)!, v);
    expect(t('phaseRand', 1000)).toBe('100% running');
    expect(t('lowProtect', 256)).toBe('-21.7dB');
    expect(t('sub1', 0)).toBe('-InfdB');
    expect(t('volD', 1000)).toBe('Infinite');
    expect(t('volR', 250)).toBe('64ms');
    expect(t('mainVol', 1000)).toBe('-2.5dB');
    expect(t('portaTime', 400)).toBe('128ms');
    expect(t('fenvD', 500)).toBe('3677ms');
    expect(t('phOfs', 500)).toBe('180');
    expect(t('phSpeed', 3000)).toBe('32:00');
    expect(t('delTime', 144)).toBe('3:00');
    expect(t('delFb', 300)).toBe('33%');
    expect(t('uniType', 2)).toBe('Blurred');
    expect(t('hzPos', 3)).toBe('Final');
  });

  it('decodes FL\'s state blob (version 12) with extras and a custom timbre colour', () => {
    const n = CUSTOM_N;
    const b = new DataView(new ArrayBuffer(4 + 400 + 28 + 4 + n * 8 + 1));
    b.setInt32(0, 12, true);
    for (let i = 0; i < 100; i++) b.setInt32(4 + i * 4, HL_BASE_PARAMS[i] + (i === 54 ? 7 : 0), true);
    const ex = [9, 2, 3, 1, TIMBRE_CUSTOM, 1, 1];
    ex.forEach((v, i) => b.setInt32(404 + i * 4, v, true));
    b.setInt32(432, n, true);
    for (let i = 0; i < 2 * n; i++) b.setFloat32(436 + i * 4, i < n ? 1 / (i + 1) : 0.25, true);
    b.setUint8(436 + n * 8, 0);
    const d = hlDecodeBlob(new Uint8Array(b.buffer))!;
    expect(d.version).toBe(12);
    expect(d.params[54]).toBe(HL_BASE_PARAMS[54] + 7);
    expect(d.extras).toEqual(ex);
    expect(d.custom!.length).toBe(2 * n);
    expect(d.custom![1]).toBeCloseTo(0.5, 7);
    expect(d.custom![n]).toBe(0.25);
    expect(d.kbShown).toBe(0);
    const st = hlStateFromDecoded(d);
    expect(st.timbre).toBe(TIMBRE_CUSTOM);
    expect(st.kbShown).toBe(0);
    expect(hlFstBlob(new Uint8Array(b.buffer))).toBeTruthy();
    expect(decodeHarmlessFile(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(presetScore(d, st)).toBe(1);
    const f = customFrames(d.custom!);
    expect(f.length).toBe(2 * n);
    expect(f[n]).toBe(0.25);
  });

  it('analyses a single-cycle waveform into a colour (largest harmonic = 1)', () => {
    const N = 2048, x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin((2 * Math.PI * i) / N) + 0.5 * Math.sin((2 * Math.PI * 3 * i) / N + Math.PI / 2);
    const c = analyzeCycle(x);
    expect(c[0]).toBeCloseTo(1, 5);
    expect(c[2]).toBeCloseTo(0.5, 5);
    expect(c[1]).toBeLessThan(1e-6);
    // FL's phase = arg(X_k) / 2 pi + 0.25: sin -> 0, cos -> 0.25
    expect(c[CUSTOM_N]).toBeCloseTo(0, 5);
    expect(c[CUSTOM_N + 2]).toBeCloseTo(0.25, 5);
  });
});

describe('Harmless engine vs FL 2026', () => {
  it('plays the plugin database state sample for sample (44.1 kHz)', () => {
    const out = renderCore(44100, 30000);
    // FL test host render, left channel (both channels equal at the centre)
    const fl: [number, number][] = [[1, -0.00010929450945695862], [2, -0.0003916369751095772], [3, -0.0009273751638829708],
      [100, 0.43591392040252686], [1000, 0.11295272409915924], [10000, -0.5391161441802979], [22050, 0.3125830590724945], [25000, -0.008027196861803532]];
    for (const [i, v] of fl) { expect(out[2 * i]).toBe(Math.fround(v)); expect(out[2 * i + 1]).toBe(out[2 * i]); }
    let last = 0;
    for (let i = 0; i < 30000; i++) if (out[2 * i] !== 0) last = i;
    expect(last).toBe(29729); // FL's last non-zero sample (release + 30 ms kill fade)
  });

  it('keeps FL\'s 48 kHz control grid (80-sample blocks) and output', () => {
    const out = renderCore(48000, 1100);
    const fl: [number, number][] = [[1, -9.362119453726336e-05], [2, -0.00033165651257149875], [3, -0.000772190629504621], [100, 0.4617061913013458], [1000, -0.7275288701057434]];
    for (const [i, v] of fl) expect(out[2 * i]).toBe(Math.fround(v));
  });

  it('runs as a channel instrument: notes at their frame, release, voices ending', () => {
    const inst = gen.create(44100, 512, { sample: () => undefined });
    inst.setParams(def().state!());
    const lv = newLevels(), init = newLevels();
    init.vol = 1;
    const n: GenNote = { id: 7, key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels: lv } as unknown as GenNote;
    const ctx = { sampleRate: 44100, blockSize: 512, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
    const L = new Float32Array(512), R = new Float32Array(512);
    inst.noteOn!(n, 100);
    inst.render!(L, R, 512, ctx);
    expect(L[99]).toBe(0);
    expect(L[101]).not.toBe(0);
    let pk = 0;
    for (let b = 0; b < 40; b++) { L.fill(0); R.fill(0); inst.render!(L, R, 512, ctx); for (const v of L) { expect(Number.isFinite(v)).toBe(true); pk = Math.max(pk, Math.abs(v)); } }
    expect(pk).toBeGreaterThan(0.5);
    inst.noteOff!(n, 0);
    const voices = () => (inst.monitor!() as { voices: number }).voices;
    for (let b = 0; b < 400 && voices() > 0; b++) { L.fill(0); R.fill(0); inst.render!(L, R, 512, ctx); }
    expect(voices()).toBe(0);
    // FL renders a generator every block: the free-running phases keep moving, so the instance stays active
    expect(inst.isActive!()).toBe(true);
    expect(inst.tail).toBe(Infinity);
  });

  it('plays a note off before another note\'s note on at the same sample (FL\'s order)', () => {
    const inst = gen.create(44100, 512, { sample: () => undefined });
    inst.setParams(def().state!());
    const core = (inst as unknown as { core: { trigger(id: number, ...a: unknown[]): void; release(id: number, r: number): void } }).core;
    const order: string[] = [];
    const tr = core.trigger.bind(core), rl = core.release.bind(core);
    core.trigger = (id: number, ...a: unknown[]) => { order.push(`on ${id}`); tr(id, ...a); };
    core.release = (id: number, r: number) => { order.push(`off ${id}`); rl(id, r); };
    const mk = (id: number, key: number): GenNote => {
      const init = newLevels();
      init.vol = 1;
      return { id, key, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels: newLevels() } as unknown as GenNote;
    };
    const a = mk(1, 60), b = mk(2, 62), c = mk(3, 64);
    const ctx = { sampleRate: 44100, blockSize: 512, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
    const L = new Float32Array(512), R = new Float32Array(512);
    inst.noteOn!(a, 0);
    inst.render!(L, R, 512, ctx);
    // the channel may send the new voice first (voice slots are reused); a zero-length note keeps its own order
    inst.noteOn!(b, 5);
    inst.noteOn!(c, 5);
    inst.noteOff!(c, 5);
    inst.noteOff!(a, 5);
    inst.render!(L, R, 512, ctx);
    expect(order).toEqual(['on 1', 'off 1', 'on 2', 'on 3', 'off 3']);
  });

  it('plays every factory preset with finite output', () => {
    const presets = def().presets!;
    const ctx = { sampleRate: 44100, blockSize: 512, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
    const L = new Float32Array(512), R = new Float32Array(512);
    for (let i = 0; i < presets.length; i += 23) {
      const inst = gen.create(44100, 512, { sample: () => undefined });
      inst.setParams({ ...def().state!(), ...presets[i].params });
      const init = newLevels(); init.vol = 1;
      inst.noteOn!({ id: 1, key: 48, velocity: 90, release: 64, color: 0, length: Infinity, frame: 0, init, levels: newLevels() } as unknown as GenNote, 0);
      for (let b = 0; b < 12; b++) {
        L.fill(0); R.fill(0);
        inst.render!(L, R, 512, ctx);
        for (let k = 0; k < 512; k++) { expect(Number.isFinite(L[k])).toBe(true); expect(Number.isFinite(R[k])).toBe(true); }
      }
    }
  });
});
