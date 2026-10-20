// SimSynth (FL: SimSynth Live): registration (FL's parameters, value texts as
// `flfxhost sweep SimSynth`, the 73 factory presets) and the port of FL's engine
// (SimSynth_eng_x64.dylib), pinned to renders of FL's real plugin in the test host
// (docs/research/gen/simsynth.md): exact samples, RMS, the chorus delay, pitch,
// the VCA level, automation, polyphony and finiteness.
import { describe, it, expect } from 'vitest';
import { genDef, genPresetState, defaultGenParams, formatParam, genInCategory } from '../../src/model/gen/registry';
import { TAGS, rowState } from '../../src/model/gen/plugins/simsynth';
import { PRESET_ROWS } from '../../src/model/gen/plugins/simsynth/presets';
import { GenChannel } from '../../src/engine/GenChannel';
import { createGenChannel } from '../../src/model/defaults';
import type { SeqNote } from '../../src/engine/Sequencer';
import { SimSynth, resetSimSynthGlobals } from '../../src/engine/gen/plugins/simsynth';
import { PlugVoice } from '../../src/engine/gen/plugins/simsynth/plug';
import { G } from '../../src/engine/gen/plugins/simsynth/tables';
import { rms, peak, firstNonZero } from './util';

const D = genDef('simsynth')!;

interface N { key: number; start: number; dur: number; vel?: number }

/**
 * Render through the real channel like FL's test host: channel volume 100 %, centred,
 * notes at exact samples, parameter changes at exact samples. Engine globals reset
 * first (FL's engine library freshly loaded).
 */
function render(params: Record<string, unknown>, notes: N[], seconds: number, o: { sr?: number; at?: [number, Record<string, number>][] } = {}): [Float32Array, Float32Array] {
  resetSimSynthGlobals();
  const sr = o.sr ?? 44100, block = 128;
  const frames = Math.round(seconds * sr);
  const ch = createGenChannel('simsynth');
  ch.volume = 1;
  ch.pan = 0;
  ch.plugin!.params = { ...defaultGenParams('simsynth'), ...params };
  const ctx = { sampleRate: sr, blockSize: block, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
  const c = new GenChannel(ch.id, sr, block, 'simsynth', { sample: () => undefined }, ctx as never);
  c.setGlobals({ tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } as never);
  c.apply(ch);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const bL = new Float32Array(block), bR = new Float32Array(block);
  const evs = notes.map((n) => ({ n, f: Math.round(n.start * sr), len: Math.round(n.dur * sr) }));
  const ats = (o.at ?? []).map(([t, p]) => ({ f: Math.round(t * sr), p })).sort((a, b) => a.f - b.f);
  let ai = 0;
  for (let off = 0; off < frames;) {
    while (ai < ats.length && ats[ai].f <= off) { ch.plugin!.params = { ...ch.plugin!.params, ...ats[ai].p }; c.apply(ch); ai++; }
    let m = Math.min(block, frames - off);
    if (ai < ats.length && ats[ai].f < off + m) m = ats[ai].f - off;
    for (const e of evs) {
      if (e.f < off || e.f >= off + m) continue;
      const sn = { pos: 0, len: 0, oneShot: false, key: e.n.key, vel: e.n.vel ?? 100, rel: 64, pan: 64, fine: 120, modX: 128, modY: 128, slide: false, porta: false, color: 0, chId: ch.id } as SeqNote;
      c.scheduleNote(sn, e.f - off, e.len);
    }
    bL.fill(0); bR.fill(0);
    c.render(bL.subarray(0, m), bR.subarray(0, m), m);
    L.set(bL.subarray(0, m), off); R.set(bR.subarray(0, m), off);
    off += m;
  }
  return [L, R];
}

const preset = (name: string) => ({ ...rowState(PRESET_ROWS.find(([n]) => n === name)![1]), __preset: name });

/** Frequency from zero crossings between two sample indices. */
function f0(b: Float32Array, sr: number, a: number, z: number): number {
  let first = -1, last = -1, n = 0;
  for (let i = a + 1; i < z; i++) {
    if (b[i - 1] < 0 && b[i] >= 0) {
      const x = i - 1 + b[i - 1] / (b[i - 1] - b[i]);
      if (first < 0) first = x; else n++;
      last = x;
    }
  }
  return (n * sr) / (last - first);
}

describe('SimSynth: registration', () => {
  it('has FL\'s parameter list, ranges, form defaults and panel size', () => {
    expect(D.name).toBe('SimSynth');
    expect(D.category).toBe('Synth classic');
    expect(genInCategory('Synth classic').map((d) => d.id)).toContain('simsynth');
    expect(D.notes).toBe('voices');
    expect(D.levels).toBe('plugin');
    expect(D.velocity ?? 'levels').toBe('levels');
    expect(D.defPoly).toBe(16);
    expect([D.width, D.height]).toEqual([562, 376]);
    expect(D.params.map((q) => q.name)).toEqual([
      'Osc1 Level', 'Osc1 LFO', 'Osc1 Env', 'Osc2 Level', 'Osc2 LFO', 'Osc2 Env', 'Osc3 Level', 'Osc3 LFO', 'Osc3 Env',
      'LFO Delay', 'LFO Rate', 'SVF Cut', 'SVF Emphasis', 'SVF Env', 'SVF LFO', 'SVF High', 'SVF Band',
      'Env Attack', 'Env Decay', 'Env Sustain', 'Env Release', 'VCA Velo', 'SVF Env Attack', 'SVF Env Decay', 'SVF Env Sustain', 'SVF Env Release',
    ]);
    expect(D.params.map((q) => q.index)).toEqual(Array.from({ length: 26 }, (_, i) => i));
    expect(D.params.every((q) => q.min === 0 && q.max === 65535)).toBe(true);
    // the form's DefaultValue (FL's reset values)
    expect(D.params.map((q) => q.def)).toEqual([
      32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 0, 32767, 32768, 0, 32767, 32767, 0, 0, 0, 32768, 32768, 10000, 65535, 0, 32768, 32768, 10000,
    ]);
    expect(D.params.map((q) => q.key)).toEqual(TAGS.slice(0, 26));
  });

  it('writes FL\'s value texts (test host sweeps)', () => {
    const vals = [0, 1, 327, 328, 13463, 32767, 32768, 49151, 65534, 65535];
    const text = (i: number) => vals.map((v) => formatParam(D.params[i], v));
    expect(text(0)).toEqual(['0%', '0%', '0%', '1%', '21%', '50%', '50%', '75%', '100%', '100%']);
    expect(text(1)).toEqual(['-100%', '-100%', '-99%', '-99%', '-59%', '0%', '0%', '50%', '100%', '100%']);
    expect(text(10)).toEqual(['1', '1', '6', '6', '206', '500', '501', '750', '1000', '1000']);
    expect(text(12)).toEqual(['0%', '0%', '0%', '0%', '19%', '47%', '47%', '70%', '94%', '94%']);
    // FL's constructor values (`flfxhost info SimSynth`)
    expect([formatParam(D.params[6], 41470), formatParam(D.params[11], 13463), formatParam(D.params[13], 44888), formatParam(D.params[21], 37630)])
      .toEqual(['63%', '21%', '37%', '57%']);
  });

  it('has FL\'s 73 factory presets, and a new instance plays the Default patch', () => {
    expect(D.presets!.length).toBe(73);
    expect(D.presets!.slice(0, 3).map((p) => p.name)).toEqual(['BassAcoustic', 'BassDeepSaw', 'BassDeepSq']);
    const def = defaultGenParams('simsynth');
    const dflt = D.presets!.find((p) => p.name === 'Default')!;
    expect(genPresetState('simsynth', dflt, def)).toEqual({ ...def, __preset: 'Default' });
    // Default.fst: osc 3 level 41470, SVF Cut 13463, osc 2 an octave down, osc 3 two octaves down, warm 1 + 2, chorus
    expect(def).toMatchObject({ o3Level: 41470, svfCut: 13463, svfEmph: 12970, vcaVelo: 37630, o2Coarse: 12, o3Coarse: 0, o1Warm: 1, o2Warm: 1, o3Warm: 0, chorus: 1, o3Shape: 0, lfoShape: 2 });
    // test host values after FL loaded TB303ish.fst (a version 0 preset: VCA Velo x 0.75)
    expect(genPresetState('simsynth', D.presets!.find((p) => p.name === 'TB303ish')!)).toMatchObject({ o1Level: 65535, o3Level: 65535, svfCut: 255, vcaVelo: 16127 });
  });
});

describe('SimSynth: FL\'s engine', () => {
  it('reproduces FL\'s Default patch sample for sample (C5, 0.5 s note, 44.1 kHz)', () => {
    const [L, R] = render({}, [{ key: 60, start: 0, dur: 0.5 }], 1);
    // FL (test host): the right channel is dry, the chorus delays the left one by 20 ms
    expect(firstNonZero(R)).toBe(2);
    expect(firstNonZero(L)).toBe(884);
    const at = [1000, 4410, 10000, 22050];
    expect(at.map((i) => L[i])).toEqual([-0.022597989067435265, 0.03500896319746971, 0.012858409434556961, -0.1939435601234436].map(Math.fround));
    expect(at.map((i) => R[i])).toEqual([0.2475515753030777, 0.23197104036808014, 0.15798205137252808, 0.16632719337940216].map(Math.fround));
    expect(R[100]).toBe(Math.fround(0.04925333335995674));
    expect(rms(L)).toBeCloseTo(0.12794670821515236, 9);
    expect(rms(R)).toBeCloseTo(0.12790643171763932, 9);
    expect(peak(R)).toBe(Math.fround(0.5476149916648865));
    // the release ends the voice (FL: last sample above -100 dB at 27678)
    let last = 0;
    for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 1e-5) last = i;
    expect(last).toBe(27678);
    expect(peak(R, 30000)).toBe(0);
  });

  it('is FL\'s at 48 kHz too', () => {
    const [L, R] = render({}, [{ key: 60, start: 0, dur: 0.5 }], 1, { sr: 48000 });
    expect(firstNonZero(L)).toBe(962);
    expect([1000, 4410, 10000, 22050].map((i) => L[i])).toEqual([0.3367740213871002, 0.09153234958648682, -0.3429633677005768, 0.23654183745384216].map(Math.fround));
    expect([1000, 4410, 10000, 22050].map((i) => R[i])).toEqual([-0.34190797805786133, 0.336275577545166, 0.06381691247224808, -0.020329074934124947].map(Math.fround));
    expect(rms(R)).toBeCloseTo(0.12786151813134594, 9);
  });

  it('plays a C5 note at 261.68 Hz (FL\'s table 4.0886817 Hz x 2^((pitch + 7200) / 1200))', () => {
    const tri = { o2On: 0, o3On: 0, svfOn: 0, chorus: 0, o1Warm: 0, o1Shape: 2, o1Fine: 32767, o1Coarse: 24, o1Pw: 32767 };
    const [L] = render(tri, [{ key: 60, start: 0, dur: 2 }], 2.2);
    expect(f0(L, 44100, Math.round(0.2 * 44100), Math.round(1.8 * 44100))).toBeCloseTo(261.6755888098963, 3);
    expect(peak(L, 0, 44100)).toBe(Math.fround(0.09592024236917496));
    const [H] = render(tri, [{ key: 72, start: 0, dur: 1 }], 1);
    expect(f0(H, 44100, 4410, 40000) / 261.6756).toBeCloseTo(2, 3);
  });

  it('VCA Velo is the output level (FL: 65535 gives 0.9537 peak on Default)', () => {
    const [L, R] = render({ vcaVelo: 65535 }, [{ key: 60, start: 0, dur: 0.5 }], 0.8);
    expect([1000, 4410, 10000, 22050].map((i) => R[i])).toEqual([0.43112656474113464, 0.40399208664894104, 0.2751356363296509, 0.2896692156791687].map(Math.fround));
    expect(rms(L)).toBeCloseTo(0.24912838054040165, 9);
    expect(peak(R)).toBe(Math.fround(0.9537057876586914));
    const [S] = render({ vcaVelo: 0 }, [{ key: 60, start: 0, dur: 0.5 }], 0.3);
    expect(peak(S)).toBe(0);
  });

  it('follows automation like FL (SVF Cut at 0.2 s during two notes)', () => {
    const [L, R] = render({}, [{ key: 60, start: 0, dur: 0.6 }, { key: 64, start: 0.05, dur: 0.5 }], 1.2, { at: [[0.2, { svfCut: 40000 }]] });
    expect([4410, 10000, 22050, 30000].map((i) => L[i])).toEqual([-0.43323004245758057, 0.244674414396286, -0.09894821792840958, 0.012882694602012634].map(Math.fround));
    expect([4410, 10000, 22050, 30000].map((i) => R[i])).toEqual([0.37221017479896545, 0.15270206332206726, 0.11465100198984146, 0.0023027686402201653].map(Math.fround));
    expect(rms(R)).toBeCloseTo(0.17764378307320036, 9);
  });

  it('creates its state like FL (12 voices, the shared noise position after loading Default)', () => {
    resetSimSynthGlobals();
    const s = new SimSynth(44100, 128);
    s.setParams(defaultGenParams('simsynth'));
    // FL's engine (lldb at the first TriggerVoice): noise position 696, chorus instance counter 10,
    // voice detunes 0, -8, 8, ...
    expect(G.counter).toBe(696);
    expect(G.modInst).toBe(10);
    expect(s.plug.patches.map((p) => p.detune)).toEqual([0, -8, 8, -6, 6, -5, 5, -4, 4, -2, 2, -1]);
    // twelve engine voices: a thirteenth note steals one
    const vs = Array.from({ length: 13 }, () => new PlugVoice());
    vs.forEach((v, i) => s.plug.trigger(v, i + 1));
    expect(vs.filter((v) => v.dead).length).toBe(1);
    expect(s.plug.slots.filter(Boolean).length).toBe(12);
  });

  it('every preset sounds and stays finite', () => {
    for (const [name] of PRESET_ROWS) {
      const [L, R] = render(preset(name), [{ key: 48, start: 0, dur: 0.15 }, { key: 67, start: 0.02, dur: 0.1 }], 0.25);
      let ok = true;
      for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) ok = false;
      expect(ok, name).toBe(true);
      expect(rms(R), name).toBeGreaterThan(1e-6);
    }
  });

  it('stays finite at extreme settings, keys and parameter changes mid-note', () => {
    const lo: Record<string, number> = {}, hi: Record<string, number> = {};
    for (const q of D.params) { lo[q.key] = 0; hi[q.key] = 65535; }
    const shapes: Record<string, number>[] = [{ o1Shape: 3, o2Shape: 4, o3Shape: 0 }, { o1Shape: 4, o2Shape: 3, o3Shape: 3, lfoShape: 3, lfoOn: 1 }];
    for (const base of [lo, hi]) for (const sh of shapes) {
      const p: Record<string, number> = { ...base, ...sh, o1On: 1, o2On: 1, o3On: 1, ring: 1, o1Oct1: 1, o2Oct2: 1, o3Oct1: 1, o3Oct2: 1, o1Coarse: 48, o2Coarse: 0, svfKb: 65535, lfoOn: 1 };
      const [L, R] = render(p, [{ key: 0, start: 0, dur: 0.1 }, { key: 131, start: 0.01, dur: 0.1 }], 0.2,
        { at: [[0.05, { svfEmph: 65535 - p.svfEmph, lfoRate: 12345, o1Shape: 2, o1Coarse: 0 }]] });
      for (let i = 0; i < L.length; i++) { expect(Number.isFinite(L[i])).toBe(true); expect(Number.isFinite(R[i])).toBe(true); }
    }
    // garbage in the state is clamped
    const s = new SimSynth(44100, 128);
    s.setParams({ ...defaultGenParams('simsynth'), svfCut: Number.NaN, o1Coarse: 999, lfoShape: -4 });
    const v = new PlugVoice();
    s.plug.trigger(v, 1);
    s.plug.callStart(v.slot);
    const m = new Float32Array(256);
    s.plug.patches[v.slot].fill(m, 0, 256);
    for (const x of m) expect(Number.isFinite(x)).toBe(true);
  });
});
