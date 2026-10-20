// FPC (FL: FPC): registration (FL's 416 named parameters, value texts, the 40 factory kits and the plugin
// database kit), the sound pinned to FL 2026's renders (test host, 44.1 kHz, raw channel: the engine renders
// FL's output bit for bit for PCM samples, docs/research/gen/fpc.md), layers, cut groups, envelopes, outputs,
// interpolation settings, extremes, the Piano roll key names and the editor.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { genDef, genPresetState, defaultGenParams, formatParam, normalizeGenParams } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import type { GenContext, GenInstance, GenNote } from '../../src/engine/gen/types';
import { fpcEmptyLayer, fpcKeyNames, fpcKitState, FPC_PRESET_NAMES, type FpcLayer, type FpcPad } from '../../src/model/gen/plugins/fpc';
import { fpcVolGain } from '../../src/engine/gen/plugins/fpc';
import { frecpe } from '../../src/engine/gen/plugins/fpc/sinc';
import { FPC_LAYOUTS } from '../../src/model/gen/plugins/fpc/layouts';
import { FPC_GOLDEN } from './fpc.golden';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
g.document ??= { body: {}, getElementById: () => null };

const D = genDef('fpc')!;
const SR = 44100;
const f = Math.fround;
const P = (key: string) => D.params.find((q) => q.key === key)!;

// ------------------------------------------------------------------ samples (as the FL renders used them)

/** The LCG test signals (16-bit WAVs written by the same formula for FL's renders). */
function lcg(n: number, seed: number): number[] {
  let x = seed;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (Math.imul(1103515245, x) + 12345) & 0x7fffffff;
    out.push(((x >>> 8) & 0xffff) - 32768);
  }
  return out;
}
const M = lcg(8820, 1).map((v) => Math.floor(v / 2) / 32768);
const S = lcg(17640, 7);
const SAMPLES: Record<string, { channels: Float32Array[]; sampleRate: number }> = {
  lcg16: { channels: [Float32Array.from(M)], sampleRate: 44100 },
  lcg16s: { channels: [Float32Array.from(S.filter((_, i) => !(i & 1)).map((v) => Math.floor(v / 2) / 32768)), Float32Array.from(S.filter((_, i) => i & 1).map((v) => Math.floor(v / 3) / 32768))], sampleRate: 44100 },
  short: { channels: [Float32Array.from({ length: 300 }, (_, i) => Math.sin(i * 0.3) * 0.5)], sampleRate: 22050 },
};

// ------------------------------------------------------------------ the test host's channel

/** The test host's LogVol (single-precision argument, double exp). */
function logVol(x: number): number {
  if (x === 1) return 1;
  const s = f(x * f(2.397895336151123));
  return f((Math.exp(s) - 1) * f(0.1));
}
let ids = 0;
interface N { key: number; vel: number; at: number; dur: number; pan?: number }
function note(n: N, chanPitch: number): GenNote {
  const vol = n.vel === 100 ? 1 : logVol(f(n.vel * f(0.009999999776482582)));
  const init = { pan: n.pan ?? 0, vol, pitch: 6000 + (n.key - 60) * 100, fcut: 0, fres: 0 };
  const levels = { ...init, pitch: init.pitch + chanPitch };
  return { id: ++ids, key: n.key, velocity: n.vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

type PadCase = Partial<Omit<FpcPad, 'layers'>> & { layers?: Partial<FpcLayer>[] };
interface Case { pads?: Record<number, PadCase>; params?: Record<string, number>; quality?: number; kit?: number }

/** The plugin state for a case: FL's plugin database kit with the case's pads. */
function stateOf(c: Case): Record<string, unknown> {
  const st = normalizeGenParams('fpc', { ...defaultGenParams('fpc'), ...(c.kit !== undefined ? fpcKitState(c.kit) : {}) });
  const pads = st.pads as FpcPad[];
  for (const [k, p] of Object.entries(c.pads ?? {})) {
    const cur = pads[Number(k)];
    pads[Number(k)] = { ...cur, ...p, layers: p.layers ? p.layers.map((l) => ({ ...fpcEmptyLayer(), ...l })) : cur.layers };
  }
  Object.assign(st, c.params ?? {});
  return normalizeGenParams('fpc', st);
}

/** Render like FL's test host: blocks of 512 frames, restarted at every note event. */
function render(c: Case, notes: N[], frames: number, opts: { chanPitch?: number; out?: GenContext['out'] } = {}): { L: Float32Array; R: Float32Array; gen: GenInstance } {
  const gen = createGen('fpc', SR, 512, { sample: (id) => SAMPLES[id] })!;
  gen.setInterpolation?.(c.quality === 12 ? 'sinc24' : c.quality === 3 ? 'hermite6' : 'linear');
  gen.setParams(stateOf(c));
  const evs = notes.map((n) => ({ n: note(n, opts.chanPitch ?? 0), at: Math.round(n.at * SR), off: Math.round((n.at + n.dur) * SR) }));
  const outL = new Float32Array(frames), outR = new Float32Array(frames);
  const L = new Float32Array(512), R = new Float32Array(512);
  const times = [...new Set(evs.flatMap((e) => [e.at, e.off]))].sort((a, b) => a - b);
  for (let b = 0; b < frames;) {
    let n = Math.min(512, frames - b);
    for (const t of times) if (t > b && t < b + n) { n = t - b; break; }
    for (const e of evs) if (e.off === b) gen.noteOff!(e.n, 0);
    for (const e of evs) if (e.at === b) gen.noteOn!(e.n, 0);
    L.fill(0); R.fill(0);
    gen.render!(L, R, n, { sampleRate: SR, blockSize: 512, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 5, out: opts.out ?? (() => {}) });
    outL.set(L.subarray(0, n), b); outR.set(R.subarray(0, n), b);
    b += n;
  }
  return { L: outL, R: outR, gen };
}

function expectGolden(name: string, L: Float32Array, R: Float32Array): void {
  for (const [i, l, r] of FPC_GOLDEN[name]) {
    expect(L[i], `${name} L[${i}]`).toBe(l);
    expect(R[i], `${name} R[${i}]`).toBe(r);
  }
}

const LAYER: Partial<FpcLayer> = { sample: 'lcg16', vol: 100 };
const FRAMES = Math.round(0.25 * SR);

// ------------------------------------------------------------------ registration

describe('FPC: registration', () => {
  it('is FL\'s Drum plugin with its own voice handling', () => {
    expect(D.name).toBe('FPC');
    expect(D.category).toBe('Drum');
    expect(D.notes).toBe('events');
    expect([D.width, D.height]).toEqual([790, 367]);
  });

  it('lists FL\'s 416 named parameters at FL\'s indices', () => {
    expect(D.params.length).toBe(416);
    expect(P('vol1')).toMatchObject({ index: 0, name: 'Pad 1 volume', min: 0, def: 127 });
    expect(P('pan16')).toMatchObject({ index: 31, name: 'Pad 16 pan', min: -128, max: 128, def: 0 });
    expect(P('mute1')).toMatchObject({ index: 32, name: 'Pad 1 mute', min: 0, max: 1 });
    expect(P('solo3')).toMatchObject({ index: 50, name: 'Pad 3 solo' });
    expect(P('vol17')).toMatchObject({ index: 64, name: 'Pad 17 volume' });
    expect(P('solo32')).toMatchObject({ index: 127, name: 'Pad 32 solo' });
    expect(P('tune1')).toMatchObject({ index: 256, name: 'Pad 1 tune', min: -128, max: 128 });
    expect(P('tune17')).toMatchObject({ index: 320, name: 'Pad 17 tune' });
    expect(P('va1')).toMatchObject({ index: 512, name: 'Pad 1 volume attack', min: 0, max: 256, def: 128 });
    expect(P('vs1')).toMatchObject({ index: 514, name: 'Pad 1 volume sustain', min: -128, max: 128, def: 0 });
    expect(P('pr32')).toMatchObject({ index: 767, name: 'Pad 32 pan release' });
  });

  it('has FL\'s value texts (test host sweeps)', () => {
    const t = (k: string, v: number) => formatParam(P(k), v);
    expect([t('vol1', 127), t('vol1', 64), t('vol1', 63), t('vol1', 5), t('vol1', 0)]).toEqual(['100%', '50%', '50%', '4%', '0%']);
    expect([t('pan1', -128), t('pan1', -16), t('pan1', 16), t('pan1', 80), t('pan1', 0)]).toEqual(['-100%', '-13%', '13%', '63%', '0%']);
    expect([t('mute1', 0), t('mute1', 1)]).toEqual(['off', 'on']);
    expect([t('tune1', -128), t('tune1', -127), t('tune1', -1), t('tune1', 3), t('tune1', 128)]).toEqual(['-1200 cents', '-1190 cents', '-9 cents', '28 cents', '1200 cents']);
    expect([t('va1', 128), t('va1', 144), t('va1', 256), t('vs1', -80)]).toEqual(['100%', '113%', '200%', '-63%']);
  });

  it('starts with FL\'s plugin database kit and has FL\'s 40 kits', () => {
    const st = normalizeGenParams('fpc', defaultGenParams('fpc'));
    const pads = st.pads as FpcPad[];
    expect(pads.length).toBe(32);
    expect(pads.slice(0, 4).map((p) => [p.name, p.key])).toEqual([['SideStick', 37], ['Kick Drum', 36], ['Closed Hat', 42], ['Tambourine', 54]]);
    expect([pads[2].cut, pads[2].cutBy, pads[6].cut, pads[6].cutBy]).toEqual([0, 0, 0, 0]);
    expect(pads[1].layers.map((l) => [l.lo, l.hi, l.vol])).toEqual([[0, 70, 99], [70, 94, 99], [94, 114, 99], [114, 123, 99], [123, 127, 99]]);
    expect(pads[1].layers[0].file).toBe('%FLStudioFactoryData%\\Data\\Patches\\Packs\\Legacy\\Drums\\FPC\\Kick Drums\\FPC_Kick_Gretc_001.wav');
    expect(pads[1].layers[0].sample).toBe('');
    expect([st.vol1, st.pan1, st.pan3]).toEqual([128, 4, 12]);
    expect(D.presets!.length).toBe(40);
    expect(FPC_PRESET_NAMES).toContain('Electronic/808');
    expect(FPC_PRESET_NAMES).toContain('Multi audio output/Acoustic/HQ Rock Kit multi out');
    const multi = genPresetState('fpc', D.presets!.find((p) => p.name === 'Multi audio output/Electronic/808 multi out')!, st);
    expect((multi.pads as FpcPad[]).some((p) => p.out !== 0)).toBe(true);
    const e808 = genPresetState('fpc', D.presets!.find((p) => p.name === 'Electronic/808')!, st);
    expect((e808.pads as FpcPad[]).some((p) => p.venv.on)).toBe(true);
  });

  it('has FL\'s six note layouts', () => {
    expect(FPC_LAYOUTS.map((l) => l.name)).toEqual(['default', 'starts at C5', 'FIRE', 'Launchkey', 'padKontrol', 'trigger finger']);
    for (const l of FPC_LAYOUTS) expect(l.pads.length).toBe(32);
    expect(FPC_LAYOUTS[0].pads.slice(0, 3)).toEqual([[37, -1, -1], [36, -1, -1], [42, 0, 0]]);
    expect(FPC_LAYOUTS[1].pads[0][0]).toBe(60);
  });

  it('names Piano roll keys by their pads (FL\'s first pad on a key)', () => {
    const names = fpcKeyNames(normalizeGenParams('fpc', defaultGenParams('fpc')));
    expect(names[36]).toBe('Kick Drum');
    expect(names[38]).toBe('Snare 2');
    expect(names[60]).toBeUndefined();
  });
});

// ------------------------------------------------------------------ sound

describe('FPC: FL\'s sound (bit for bit against FL 2026\'s renders)', () => {
  it('plays a layer at its pitch: copy mode and FL\'s gain chain', () => {
    const { L, R } = render({ pads: { 1: { layers: [LAYER] } } }, [{ key: 36, vel: 100, at: 0, dur: 0.15 }], FRAMES);
    expectGolden('unity', L, R);
    // pad 128 / layer 100 / note at centre: three FL pan laws (0.7071 each) and the volume curve
    expect(L[0] / M[0]).toBeCloseTo(0.7599621, 6);
    expect(fpcVolGain(127)).toBe(f(2.0526957511901855));
  });

  it('resamples like FL: linear (FL\'s live ProcessMode 0), 24-point sinc, 6-point hermite', () => {
    let r = render({ pads: { 1: { layers: [LAYER] } } }, [{ key: 36, vel: 100, at: 0, dur: 0.15 }], FRAMES, { chanPitch: 100 });
    expectGolden('linear', r.L, r.R);
    r = render({ pads: { 1: { layers: [LAYER] } }, quality: 12 }, [{ key: 36, vel: 100, at: 0, dur: 0.15 }], FRAMES, { chanPitch: 100 });
    expectGolden('sinc24', r.L, r.R);
    r = render({ pads: { 1: { layers: [LAYER] } }, quality: 3 }, [{ key: 36, vel: 100, at: 0, dur: 0.15 }], FRAMES, { chanPitch: -350 });
    expectGolden('hermite', r.L, r.R);
  });

  it('pans with FL\'s pad, layer and note pan laws (stereo sample, layer tune, velocity 80)', () => {
    const { L, R } = render({ pads: { 1: { layers: [{ sample: 'lcg16s', vol: 90, pan: 40, tune: -13 }] } }, params: { pan2: -50, vol2: 90 } },
      [{ key: 36, vel: 80, at: 0, dur: 0.15, pan: 0.4 }], FRAMES);
    expectGolden('pan', L, R);
  });

  it('runs FL\'s volume envelope (ATT / DEC / SUS / REL knobs, sustain, release)', () => {
    const venv = { on: true, flags: 0, d: 1, l: -1, s: 2, pts: [[0, 0, 0, 0, 0, 0, 0], [0.03, 1, 0.2, 0, 0, 0, 1], [0.05, 0.5, 0.2, 0, 0, 0, 1], [0.06, 0, 0.2, 0, 0, 0, 1]] };
    const { L, R } = render({ pads: { 1: { layers: [LAYER], venv } }, params: { va2: 100, vd2: 150, vs2: 30, vr2: 90 } }, [{ key: 36, vel: 100, at: 0, dur: 0.08 }], FRAMES);
    expectGolden('env', L, R);
  });

  it('cuts by groups (the Default kit\'s hi-hats)', () => {
    const { L, R } = render({ pads: { 2: { layers: [LAYER] }, 6: { layers: [{ sample: 'lcg16s', vol: 100 }] } } },
      [{ key: 46, vel: 100, at: 0, dur: 0.2 }, { key: 42, vel: 100, at: 0.05, dur: 0.2 }], FRAMES);
    expectGolden('cut', L, R);
  });
});

// ------------------------------------------------------------------ behaviour

describe('FPC: behaviour', () => {
  const sum = (a: Float32Array, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += Math.abs(a[i]); return s; };

  it('chooses layers by velocity, with FL\'s half-open ranges', () => {
    const layers = [{ sample: 'lcg16', vol: 100, lo: 0, hi: 64 }, { sample: 'lcg16s', vol: 100, lo: 64, hi: 127 }];
    const a = render({ pads: { 1: { layers } } }, [{ key: 36, vel: 63, at: 0, dur: 0.1 }], 2000).L;
    const b = render({ pads: { 1: { layers: [layers[0]] } } }, [{ key: 36, vel: 63, at: 0, dur: 0.1 }], 2000).L;
    expect([...a]).toEqual([...b]);
    const c = render({ pads: { 1: { layers } } }, [{ key: 36, vel: 128, at: 0, dur: 0.1 }], 2000).L;
    const d = render({ pads: { 1: { layers: [layers[1]] } } }, [{ key: 36, vel: 128, at: 0, dur: 0.1 }], 2000).L;
    expect([...c]).toEqual([...d]);
  });

  it('plays one overlapping layer in Cycle mode, in turn', () => {
    const layers = [{ sample: 'short', vol: 127 }, { sample: 'short', vol: 50, pan: 60 }];
    const notes = [{ key: 36, vel: 100, at: 0, dur: 0.02 }, { key: 36, vel: 100, at: 0.05, dur: 0.02 }];
    const r = render({ pads: { 1: { layers, random: true, rmode: 3 } } }, notes, 4000).R;
    // FL resets a pad's last layer to -1: Cycle starts at the first layer
    const one = render({ pads: { 1: { layers: [layers[0]] } } }, [notes[0]], 1000).R;
    const two = render({ pads: { 1: { layers: [layers[1]] } } }, [notes[0]], 1000).R;
    expect([...r.subarray(0, 1000)]).toEqual([...one]);
    expect([...r.subarray(2205, 3205)]).toEqual([...two]);
  });

  it('mutes, solos and ignores note offs without envelopes (one shot)', () => {
    const base = { pads: { 1: { layers: [LAYER] } } };
    expect(sum(render({ ...base, params: { mute2: 1 } }, [{ key: 36, vel: 100, at: 0, dur: 0.1 }], 4000).L)).toBe(0);
    expect(sum(render({ ...base, params: { solo1: 1 } }, [{ key: 36, vel: 100, at: 0, dur: 0.1 }], 4000).L)).toBe(0);
    const short = render(base, [{ key: 36, vel: 100, at: 0, dur: 0.01 }], 6000).L;
    const long = render(base, [{ key: 36, vel: 100, at: 0, dur: 0.2 }], 6000).L;
    expect([...short]).toEqual([...long]);
  });

  it('routes pads with an output offset to mixer track (channel track + offset)', () => {
    const got: number[] = [];
    let routed = 0;
    const r = render({ pads: { 1: { layers: [LAYER], out: 3 } } }, [{ key: 36, vel: 100, at: 0, dur: 0.1 }], 4000,
      { out: (t, l, _r, n) => { got.push(t); for (let i = 0; i < n; i++) routed += Math.abs(l[i]); } });
    expect(sum(r.L)).toBe(0);
    expect(got.every((t) => t === 8)).toBe(true);
    expect(routed).toBeGreaterThan(10);
  });

  it('follows the channel\'s pitch and stops at the sample end', () => {
    const { L, gen } = render({ pads: { 1: { layers: [{ sample: 'short', vol: 127 }] } } }, [{ key: 36, vel: 100, at: 0, dur: 1 }], 4000);
    expect(sum(L, 0, 590)).toBeGreaterThan(1);
    expect(sum(L, 610)).toBe(0);
    expect(gen.isActive!()).toBe(false);
  });

  it('stays finite at extreme settings and keys', () => {
    const layers = [{ sample: 'lcg16s', vol: 127, pan: 128, tune: 128 }, { sample: 'short', vol: 127, pan: -128, tune: -128, rev: true }];
    const venv = { on: true, flags: 0, d: 0, l: 0, s: 1, pts: [[0, 1, 1, 0, 0, 0, 0], [0, 0, -1, 1, 0, 0, 1], [0.001, 1, 1, 2, 0, 0, 1]] };
    for (const q of [1, 3, 12]) {
      const { L, R } = render({ pads: { 1: { layers, venv, penv: venv } }, quality: q, params: { vol2: 128, tune2: 128, va2: 0, vd2: 256, vs2: 128, vr2: 0 } },
        [{ key: 36, vel: 128, at: 0, dur: 0.05 }, { key: 36, vel: 0, at: 0.01, dur: 0.05 }], 6000, { chanPitch: 4800 });
      for (let i = 0; i < 6000; i++) { expect(Number.isFinite(L[i])).toBe(true); expect(Number.isFinite(R[i])).toBe(true); }
    }
  });

  it('emulates ARM\'s FRECPE (8-bit reciprocal estimate)', () => {
    expect(frecpe(1)).toBe(f(0.998046875));
    expect(frecpe(3)).toBe(f(0.3330078125));
    expect(frecpe(-0.5)).toBe(f(-1.99609375));
    expect(frecpe(0)).toBe(Infinity);
  });
});

// ------------------------------------------------------------------ editor

describe('FPC: editor', () => {
  it('renders FL\'s layout for the default kit', async () => {
    const { FxEditorContext } = await import('../../src/ui/plugins/kit');
    const { editor } = await import('../../src/ui/plugins/gen/fpc');
    const params = normalizeGenParams('fpc', defaultGenParams('fpc'));
    const html = renderToStaticMarkup(createElement(FxEditorContext.Provider, { value: { slotId: 'ch:x', plugin: 'fpc', params, trackName: 'FPC', pluginName: 'FPC' } }, createElement(editor.Editor)));
    expect(html).toContain('SideStick');
    expect(html).toContain('BANK B');
    expect(html).toContain('SPREAD EVEN');
    expect(html).toContain('VOLUME');
    expect(editor.menu!('ch:x').map((m) => m.label)).toContain('Import FL content...');
  });
});
