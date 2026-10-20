// Transistor Bass (FL: Transistor Bass): registration (FL's parameter list,
// value texts from full test-host sweeps, factory presets, insertion state) and
// the DSP against FL's own renders (flfxhost, 44.1 kHz): the V2 engine, the
// V1 engine, the whole plugin with sequencer, distortion, delay and reverb.
import { describe, it, expect, vi } from 'vitest';
import { genDef, genPresetState, defaultGenParams, formatParam } from '../../src/model/gen/registry';
import { TbEngine } from '../../src/engine/gen/plugins/transistorbass/engine';
import { TbPlugin } from '../../src/engine/gen/plugins/transistorbass/plugin';
import { TB_FORM_DEFAULTS, TB_PARAM_KEYS, flFix } from '../../src/model/gen/plugins/transistorbass/data';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';
import { createGenChannel } from '../../src/model/defaults';
import { makeEngine, play, rms, peak } from './util';

// DSP renders: generous time when the whole suite runs concurrently
vi.setConfig({ testTimeout: 120_000 });

const D = genDef('transistorbass')!;
const SR = 44100;

function note(key: number, vel: number, id = 1): GenNote {
  const init = newLevels(), levels = newLevels();
  init.pitch = key * 100; init.vol = (Math.pow(11, vel / 100) - 1) / 10;
  levels.pitch = key * 100; levels.vol = 1; levels.pan = 0;
  return { id, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/** The whole plugin as FL's test host drives it: 512-frame blocks, 0.25 s preroll, notes [key, vel, start, dur]. */
function renderPlugin(preset: string, notes: [number, number, number, number][], seconds: number, tempo = 130): Float32Array[] {
  const tb = new TbPlugin(SR, 512);
  tb.setParams(structuredClone(D.presets!.find((p) => p.name === preset)!.params));
  const ctx = { sampleRate: SR, blockSize: 512, tempo, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
  const bl = new Float32Array(512), br = new Float32Array(512);
  for (let t = 0; t < 11025; t += 512) { bl.fill(0); br.fill(0); tb.render(bl, br, Math.min(512, 11025 - t), ctx); }
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const evs: { t: number; on: boolean; n: GenNote }[] = [];
  notes.forEach(([k, v, s, d], i) => { const nn = note(k, v, i + 1); evs.push({ t: Math.round(s * SR), on: true, n: nn }, { t: Math.round((s + d) * SR), on: false, n: nn }); });
  evs.sort((a, b) => a.t - b.t);
  let e = 0;
  for (let t = 0; t < n; t += 512) {
    const m = Math.min(512, n - t);
    while (e < evs.length && evs[e].t < t + m) { const ev = evs[e++]; if (ev.on) tb.noteOn(ev.n, ev.t - t); else tb.noteOff(ev.n, ev.t - t); }
    bl.fill(0); br.fill(0);
    tb.render(bl, br, m, ctx);
    L.set(bl.subarray(0, m), t); R.set(br.subarray(0, m), t);
  }
  return [L, R];
}

const dB = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

describe('Transistor Bass: registration', () => {
  it("has FL's 42 parameters with FL's names, ranges and indices", () => {
    expect(D.name).toBe('Transistor Bass');
    expect(D.category).toBe('Synth classic');
    expect(D.notes).toBe('events');
    expect([D.width, D.height]).toEqual([700, 600]);
    expect(D.params.length).toBe(42);
    expect(D.params.map((q) => q.key)).toEqual([...TB_PARAM_KEYS]);
    expect(D.params[0]).toMatchObject({ name: 'Tuning', min: 0, max: 24576, index: 0 });
    expect(D.params[12].name).toBe('LFO -> Pulse width rate');
    expect(D.params[25].name).toBe('Reverb early reflection amount');
    expect(D.params[41]).toMatchObject({ name: '303 Pulse', min: 0, max: 1 });
    expect(D.params.filter((q) => q.max === 1).map((q) => q.index)).toEqual([14, 27, 32, 33, 41]);
  });

  it("writes FL's value texts (test-host sweeps: round half away from zero, no -0)", () => {
    const f = (i: number, v: number, st?: Record<string, unknown>) => formatParam(D.params[i], v, st as never);
    expect(f(0, 12288)).toBe('0.00 Semitones');
    expect(f(0, 384)).toBe('-11.63 Semitones');
    expect(f(0, 24576)).toBe('12.00 Semitones');
    expect(f(1, 0)).toBe('100% Pulse');
    expect(f(1, 24576)).toBe('63% Pulse');
    expect(f(1, 32768)).toBe('50% Saw');
    expect(f(1, 65536)).toBe('100% Saw');
    expect(f(2, 4096)).toBe('6.3%');
    expect(f(3, 0)).toBe('-100.0%');
    expect(f(3, 32760)).toBe('0.0%');
    expect(f(11, 6554)).toBe('54.5%');
    expect(f(24, 0)).toBe('-inf');
    expect(f(24, 49152)).toBe('-4.5 dB');
    expect(f(26, 56100)).toBe('0.0 dB');
    expect(f(35, 28913, { delaySync: 1 })).toBe('1/8');
    expect(f(35, 25058, { delaySync: 1 })).toBe('1/3');
    expect(f(35, 32768, { delaySync: 0 })).toBe('255.0ms');
    expect(f(14, 1)).toBe('On');
    expect(flFix(-0.04, 1)).toBe('0.0');
  });

  it("has FL's three factory presets; the insertion state is FL's plugin database entry (Factory programs)", () => {
    expect(D.presets!.map((p) => p.name)).toEqual(['Empty', 'Factory programs', 'Sequencer off']);
    const def = defaultGenParams('transistorbass');
    expect(def).toMatchObject({ engine: 0, seqOn: true, af: true, prog: 65 });
    expect(def.cutoff).toBe(10424);
    expect(def.revOn).toBe(1);
    const so = genPresetState('transistorbass', D.presets![2], def);
    expect(so).toMatchObject({ seqOn: false, prog: 60, cutoff: 32768, panels: 2 });
    expect(TB_FORM_DEFAULTS[11]).toBe(6554);
  });
});

describe('Transistor Bass: DSP against FL renders', () => {
  it('V2 engine (FL constructor state: decay coefficient from Minimum decay) matches FL sample for sample', () => {
    const e = new TbEngine(SR, true);
    TB_FORM_DEFAULTS.forEach((v, i) => e.setParam(i, v / (i === 0 ? 24576 : D.params[i].max)));
    e.setSampleRate(SR);
    for (let i = 0; i < 11025; i++) e.tick();
    e.noteOn(60, false, false);
    const out = new Float32Array(44100);
    for (let i = 0; i < out.length; i++) out[i] = e.tick() * Math.SQRT1_2;
    // FL (flfxhost render "Transistor Bass" --notes 60:100:0:1 --param 6=0): samples at 100, 1000, 5000, 10000, 30000
    const fl = [-0.01682997, 0.1191293, -0.02913336, 0.02516315, -0.01503626];
    // the first ~10 ms differ by ~1e-4 (onset; -78 dB), then FL's samples to float precision
    [100, 1000, 5000, 10000, 30000].forEach((i, k) => expect(out[i]).toBeCloseTo(fl[k], i < 500 ? 3 : 4));
    expect(dB(rms(out, 0, 22050))).toBeCloseTo(-30.3938, 2);
    expect(dB(rms(out, 22050, 44100))).toBeCloseTo(-37.9534, 2);
  });

  it('V1 engine through the plugin (FL\'s "Sequencer off" preset) matches FL', () => {
    const [L, R] = renderPlugin('Sequencer off', [[60, 100, 0, 1]], 1.5);
    const fl = [-0.01750632, -0.06170591, 0.03467364, -0.02223028, 0.01643015];
    [100, 1000, 5000, 10000, 30000].forEach((i, k) => expect(L[i]).toBeCloseTo(fl[k], 4));
    expect(R[1000]).toBeCloseTo(-0.06170591, 4);
    expect(dB(rms(L, 0, 22050))).toBeCloseTo(-29.8813, 2);
    expect(dB(rms(L, 22050, 44100))).toBeCloseTo(-37.6104, 2);
  });

  it('the factory bank (program 65 "Nucleon": sequencer, distortion, delay, reverb) matches FL', () => {
    const [L, R] = renderPlugin('Factory programs', [[65, 100, 0, 3]], 2, 125);
    const fl = [0.09770113, -0.07665601, 7.605572e-05, -0.1043184, -0.07528137, -0.02728994];
    [100, 1000, 5000, 10000, 30000, 60000].forEach((i, k) => expect(L[i]).toBeCloseTo(fl[k], 4));
    expect(R[1000]).toBeCloseTo(-0.07533161, 4);
    expect(dB(rms(L, 0, 22050))).toBeCloseTo(-21.6923, 2);
    expect(dB(rms(L, 22050, 44100))).toBeCloseTo(-21.0170, 2);
  });

  it('accents notes at velocity 110 and up (+ louder, brighter), slides overlapping notes', () => {
    const plain = renderPlugin('Sequencer off', [[48, 100, 0, 0.5]], 0.6)[0];
    const acc = renderPlugin('Sequencer off', [[48, 110, 0, 0.5]], 0.6)[0];
    const below = renderPlugin('Sequencer off', [[48, 109, 0, 0.5]], 0.6)[0];
    expect(rms(acc, 0, 8000)).toBeGreaterThan(rms(plain, 0, 8000) * 1.2);
    expect(rms(below, 0, 8000)).toBeCloseTo(rms(plain, 0, 8000), 6);
    // overlapping notes glide (no new attack): no envelope restart at the second note
    const legato = renderPlugin('Sequencer off', [[48, 100, 0, 0.6], [60, 100, 0.5, 0.5]], 1.2)[0];
    const separate = renderPlugin('Sequencer off', [[48, 100, 0, 0.45], [60, 100, 0.5, 0.5]], 1.2)[0];
    const a = Math.round(0.5 * SR);
    expect(peak(separate, a, a + 2000)).toBeGreaterThan(peak(legato, a, a + 2000) * 1.3);
  });
});

describe('Transistor Bass: in an instrument channel', () => {
  it('plays the insertion state (sequencer) and stays finite at extremes', () => {
    const e = makeEngine();
    const ch = createGenChannel('transistorbass');
    const [L] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 48, key: 65 }] }, 48000);
    expect(rms(L)).toBeGreaterThan(0.01);
    for (const v of L) expect(Number.isFinite(v)).toBe(true);
    const e2 = makeEngine();
    const ch2 = createGenChannel('transistorbass');
    const p = ch2.plugin!.params;
    Object.assign(p, { reso: 65536, envMod: 65536, accent: 65536, distOn: 1, distDrive: 65536, delayFeedback: 65536, revDecay: 65536, seqOn: false });
    const [L2] = play(e2, [ch2], { [ch2.id]: [{ pos: 0, len: 12, key: 0, vel: 128 }, { pos: 6, len: 12, key: 127, vel: 128 }] }, 24000);
    for (const v of L2) expect(Number.isFinite(v)).toBe(true);
    expect(rms(L2)).toBeGreaterThan(0);
  });
});
