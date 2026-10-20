// Kepler (FL: Kepler, Synth classic > the Juno-6 emulation): the engine against FL Studio 2026's own renders (the test host
// flfxhost: 44.1 kHz, 130 BPM, 512-sample blocks split at the notes, a 0.25 s preroll) and the pieces of the DSP that numbers
// pin down. The engine is a float32 port of FL's engine library (8 DCO voices with band-limited steps, the 4-pole ladder
// filter, envelopes, LFO, Juno chorus, arpeggiator); with FL's own LFO and noise tables it reproduces the host's samples bit
// for bit (see docs/research/gen/kepler.md). Registration, parameter list, value texts and presets are in kepler-model.test.ts,
// the editor in kepler-ui.test.ts.
//
// The two tables (an LFO sine of 2170 points and a noise loop of 682245 points) are FL's content and are not in the project; a
// synthesised stand-in is used unless the user imports them. So there are two kinds of checks against FL's renders:
//   - with the stand-in tables the render agrees with FL's to a few percent (the noise floor of the voices differs: the hiss
//     level is -40 dB, the LFO shape differs slightly), checked at the recorded samples;
//   - where a local FL Studio install is present, its tables are read from it (never copied) and the render must equal FL's
//     bit for bit (a hash of the whole render).
import { describe, it, expect, vi } from 'vitest';
import { createGen } from '../../src/engine/gen';
import { genDef, defaultGenParams } from '../../src/model/gen/registry';
import { GenChannel } from '../../src/engine/GenChannel';
import type { SeqNote } from '../../src/engine/Sequencer';
import { createGenChannel } from '../../src/model/defaults';
import { KeplerPlugin } from '../../src/engine/gen/plugins/kepler/plugin';
import { kpFindTables, kpPackTables, kpUnpackTables, KP_LFO_N, KP_NOISE_N, type KeplerTables } from '../../src/engine/gen/plugins/kepler/fltables';
import { SCENARIOS, renderScenario, scenarioFrames, fnvStereo, localFlTables, type KScenario } from './kepler-render';
import { KEPLER_RENDER_GOLDEN } from './kepler-render.golden';

// DSP renders: generous time when the whole suite runs concurrently
vi.setConfig({ testTimeout: 180_000 });

const KEP = SCENARIOS.filter((s) => s.kind === 'kepler');
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const flTables = localFlTables();

/** The scenario with other parameter values / notes. */
function variant(id: string, change: Partial<KScenario> & { over?: Record<string, unknown> }): KScenario {
  const s = KEP.find((x) => x.id === id)!;
  return { ...s, ...change, over: { ...(s.over ?? {}), ...(change.over ?? {}) } };
}

/** Fundamental frequency from the autocorrelation of a window (Hz): the shortest lag whose peak is within 10 % of the best. */
function f0(x: Float32Array, from: number, n: number, sr = 44100): number {
  const c: number[] = [];
  for (let l = 20; l < 1200; l++) {
    let a = 0;
    for (let k = from; k < from + n - l; k++) a += x[k] * x[k + l];
    c.push(a);
  }
  const best = Math.max(...c);
  for (let i = 1; i < c.length - 1; i++) if (c[i] >= 0.9 * best && c[i] >= c[i - 1] && c[i] >= c[i + 1]) return sr / (20 + i);
  return 0;
}

describe('Kepler: registration of the engine', () => {
  it('is an instrument of the registry with a DSP module', () => {
    expect(genDef('kepler')).toBeDefined();
    const g = createGen('kepler', 44100, 128);
    expect(g).toBeInstanceOf(KeplerPlugin);
  });
});

describe("Kepler: FL's renders (test host) with the stand-in tables", () => {
  for (const s of KEP.filter((x) => x.standin !== undefined)) {
    it(`${s.id}: ${s.about}`, () => {
      const gold = KEPLER_RENDER_GOLDEN[s.id];
      expect(gold, 'golden data').toBeDefined();
      expect(gold.n).toBe(scenarioFrames(s));
      const [L, R] = renderScenario(s, null);
      let se = 0, sg = 0;
      for (const [i, l, r] of gold.frames) { se += (L[i] - l) ** 2 + (R[i] - r) ** 2; sg += l * l + r * r; }
      expect(sg).toBeGreaterThan(0);
      expect(db(Math.sqrt(se / sg))).toBeLessThan(s.standin!);
    });
  }
});

describe.skipIf(!flTables)("Kepler: FL's renders with FL's own tables (read from the local FL install)", () => {
  for (const s of KEP) {
    it(`${s.id} is bit-exact`, () => {
      const gold = KEPLER_RENDER_GOLDEN[s.id];
      const [L, R] = renderScenario(s, flTables);
      for (const [i, l, r] of gold.frames) {
        expect([i, L[i], R[i]]).toEqual([i, l, r]);
      }
      expect(fnvStereo(L, R)).toBe(gold.hash);
    });
  }
});

describe('Kepler: the sound', () => {
  it('plays the pitch of the key and moves it by the octave switch', () => {
    const s = variant('kep-default', { notes: [[60, 100, 0, 0.5]], tail: 0.1, over: { dcoPulse: 0 } });
    const [L] = renderScenario(s, null);
    // C5 (FL's middle C, MIDI 60) = 261.63 Hz (FL's octave switch at 8')
    expect(f0(L, 8000, 4000)).toBeCloseTo(261.63, -1);
    const ratio = (octave: number) => f0(renderScenario(variant('kep-default', { notes: [[60, 100, 0, 0.5]], tail: 0.1, over: { octave } }), null)[0], 8000, 4000) / 261.63;
    expect(ratio(0)).toBeCloseTo(0.5, 1);
    expect(ratio(2)).toBeCloseTo(2, 1);
    // the same key an octave higher
    const hi = f0(renderScenario(variant('kep-default', { notes: [[72, 100, 0, 0.5]], tail: 0.1 }), null)[0], 8000, 3000);
    expect(hi / 261.63).toBeCloseTo(2, 1);
  });

  it('keeps left and right equal without the chorus and splits them with it', () => {
    const [L0, R0] = renderScenario(variant('kep-chorus1', { over: { chorusMode: 0 } }), null);
    for (let i = 0; i < L0.length; i++) if (L0[i] !== R0[i]) throw new Error(`channels differ at ${i}`);
    const [L1, R1] = renderScenario(variant('kep-chorus1', { over: { chorusMode: 1 } }), null);
    let diff = 0;
    for (let i = 0; i < L1.length; i++) diff = Math.max(diff, Math.abs(L1[i] - R1[i]));
    expect(diff).toBeGreaterThan(0.01);
  });

  it('plays an arpeggio up through the chord, one note per sixteenth, two octaves', () => {
    const s = KEP.find((x) => x.id === 'kep-arp')!;
    const [L] = renderScenario({ ...s, over: { ...s.over, dcoPulse: 0 } }, null);
    const step = Math.round((44100 * 60) / (130 * 4)); // a sixteenth at 130 BPM
    // C E G of the triad, then the same an octave up
    [0, 4, 7, 12, 16, 19].forEach((semi, k) => {
      expect(f0(L, k * step + 1200, 2600) / (261.63 * 2 ** (semi / 12))).toBeCloseTo(1, 1);
    });
  });

  it('decays to silence after the last release and stays inside a sane level', () => {
    const [L, R] = renderScenario(KEP.find((x) => x.id === 'kep-acebass')!, null);
    const n = L.length;
    let tail = 0;
    for (let i = n - 2000; i < n; i++) tail = Math.max(tail, Math.abs(L[i]), Math.abs(R[i]));
    expect(tail).toBeLessThan(1e-3);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(2);
  });

  it('stays finite at other sample rates (FL does the same up to the Nyquist limits of its filters)', () => {
    for (const sr of [22050, 32000, 48000, 96000]) {
      const [L, R] = renderScenario(variant('kep-chorus3-noise', { sr, tail: 0.1 }), null);
      let peak = 0;
      for (let i = 0; i < L.length; i++) {
        expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
        peak = Math.max(peak, Math.abs(L[i]));
      }
      expect(peak).toBeGreaterThan(0.02);
    }
  });
});

describe("Kepler: FL's LFO and noise tables", () => {
  const rng = (() => { let s = 7; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 16) - 32768; }; })();
  const fake = (): KeplerTables => ({
    lfo: Int16Array.from({ length: KP_LFO_N }, () => rng()),
    noise: Int16Array.from({ length: KP_NOISE_N }, () => rng()),
  });

  it('packs into a pool sample and comes back; any other data is refused', () => {
    const t = fake();
    const pack = kpPackTables(t);
    const back = kpUnpackTables(pack)!;
    expect(back.lfo).toEqual(t.lfo);
    expect(back.noise).toEqual(t.noise);
    expect(kpUnpackTables(null)).toBeNull();
    expect(kpUnpackTables(pack.subarray(0, 100))).toBeNull();
    const bent = Float32Array.from(pack);
    bent[5000] += 1;
    expect(kpUnpackTables(bent)).toBeNull();
    const wrong = Float32Array.from(pack);
    wrong[1] = 2171;
    expect(kpUnpackTables(wrong)).toBeNull();
    // a decoder that resampled the data does not pass either
    expect(kpUnpackTables(Float32Array.from(pack, (v) => v * 0.999))).toBeNull();
  });

  it('finds nothing in a file that is not an FL engine library', () => {
    expect(kpFindTables(new Uint8Array(2 * KP_NOISE_N + 4096))).toBeNull();
    const junk = new Uint8Array(3_000_000);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 2654435761) >>> 24;
    expect(kpFindTables(junk)).toBeNull();
  });

  it('are taken from the pool sample named by the state, and ignored when it is not a pack', () => {
    const n = 6000;
    const render = (env: { sample(id: string): { channels: Float32Array[]; sampleRate: number } | undefined }, extra: Record<string, unknown>): Float32Array => {
      const p = new KeplerPlugin(44100, 512, false, env);
      p.setParams({ ...defaultGenParams('kepler'), ...extra });
      const init = { pitch: 6000, vol: 0.5, pan: 0, fcut: 0, fres: 0 };
      const note = { id: 1, key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels: { ...init, vol: 1 } } as never;
      p.noteOn(note, 0);
      const L = new Float32Array(n), R = new Float32Array(n);
      p.render(L, R, n, { sampleRate: 44100, blockSize: 512, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 } as never);
      return L;
    };
    const none = render({ sample: () => undefined }, {});
    const t = fake();
    const pack = kpPackTables(t);
    const withTables = render({ sample: (id) => (id === 'tbl' ? { channels: [pack], sampleRate: 44100 } : undefined) }, { flTablesSample: 'tbl' });
    const notAPack = render({ sample: () => ({ channels: [new Float32Array(1000)], sampleRate: 44100 }) }, { flTablesSample: 'tbl' });
    let d1 = 0, d2 = 0;
    for (let i = 0; i < n; i++) { d1 = Math.max(d1, Math.abs(withTables[i] - none[i])); d2 = Math.max(d2, Math.abs(notAPack[i] - none[i])); }
    expect(d1).toBeGreaterThan(1e-4); // the voice noise now comes from the imported table
    expect(d2).toBe(0); // data that is not a pack leaves the stand-ins in place
  });

  it.skipIf(!flTables)('read from a local FL install have FL\'s sizes and the asymmetric LFO shape', () => {
    expect(flTables!.lfo.length).toBe(KP_LFO_N);
    expect(flTables!.noise.length).toBe(KP_NOISE_N);
    expect(Math.min(...flTables!.lfo)).toBe(-32768);
    expect(Math.max(...flTables!.lfo)).toBe(30425);
  });
});

describe('Kepler: through an instrument channel', () => {
  /** Notes (s) through a channel: the real path of a pattern note (volume, pan and pitch of the channel reach the engine as FL's MIDI events). */
  function chanRender(notes: { key: number; vel?: number; start: number; dur: number }[], seconds: number, vol = 1): [Float32Array, Float32Array] {
    const sr = 44100, block = 128, frames = Math.round(seconds * sr);
    const ch = createGenChannel('kepler');
    ch.volume = vol;
    ch.plugin!.params = { ...defaultGenParams('kepler') };
    const ctx = { sampleRate: sr, blockSize: block, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
    const c = new GenChannel(ch.id, sr, block, 'kepler', { sample: () => undefined }, ctx);
    c.setGlobals({ tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } as never);
    c.apply(ch);
    const L = new Float32Array(frames), R = new Float32Array(frames);
    const bL = new Float32Array(block), bR = new Float32Array(block);
    for (let s0 = 0; s0 < frames; s0 += block) {
      const m = Math.min(block, frames - s0);
      for (const n of notes) {
        const nf = Math.round(n.start * sr);
        if (nf < s0 || nf >= s0 + m) continue;
        const sn = { pos: 0, len: 0, oneShot: false, key: n.key, vel: n.vel ?? 100, rel: 64, pan: 64, fine: 120, modX: 128, modY: 128, slide: false, porta: false, color: 0, chId: ch.id } as SeqNote;
        c.scheduleNote(sn, nf - s0, Math.round(n.dur * sr));
      }
      bL.fill(0); bR.fill(0);
      c.render(bL.subarray(0, m), bR.subarray(0, m), m);
      L.set(bL.subarray(0, m), s0); R.set(bR.subarray(0, m), s0);
    }
    return [L, R];
  }
  const rms = (x: Float32Array, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

  it('renders the Default preset at the level of the host render, and the channel volume scales it', () => {
    const [L, R] = chanRender([{ key: 60, vel: 100, start: 0, dur: 0.5 }], 0.9);
    const [dl] = renderScenario(KEP.find((x) => x.id === 'kep-default')!, null);
    // the host's blocks differ from the channel's (128 samples), the sound is the same
    expect(Math.abs(db(rms(L, 0, 20000)) - db(rms(dl, 0, 20000)))).toBeLessThan(0.5);
    expect(L[5000]).toBe(R[5000]);
    const quiet = chanRender([{ key: 60, vel: 100, start: 0, dur: 0.5 }], 0.9, 0.5)[0];
    expect(rms(quiet, 0, 20000)).toBeGreaterThan(0);
    expect(rms(quiet, 0, 20000)).toBeLessThan(rms(L, 0, 20000));
  });
});
