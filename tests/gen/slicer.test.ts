// Slicer (FL: Fruity Slicer): registration, state, keys, FL's slicing / dump / processing /
// playback against pinned FL 2026 results (tests/gen/slicer-golden.ts), the editor
// operations' pure parts, engine integration, finiteness at extreme settings and the editor.

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { genDef, defaultGenParams, normalizeGenParams, genInCategory } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import type { GenInstance, GenVoice, GenVoiceParams } from '../../src/engine/gen/types';
import { newLevels } from '../../src/engine/gen/levels';
import {
  baseKeyFor, beatsOf, defaultSlicerState, loopTiming, newSlice, sliceKey, sliceKeyMap, sliceName, slicerState, tempoOf,
} from '../../src/model/gen/plugins/slicer/state';
import { AUTO_PRESETS, autoSlice, beatSlices, thresholdFactor, zeroCross } from '../../src/model/gen/plugins/slicer/slicing';
import { dumpNotes } from '../../src/model/gen/plugins/slicer/dump';
import { processSlices, sliceLayout, stretchFactor, tsForRatio } from '../../src/engine/gen/plugins/slicer/process';
import { fillGapsI16, floatToI16, i16ToFloat } from '../../src/engine/gen/plugins/slicer/fillgaps';
import { RELEASE_LEN } from '../../src/engine/gen/plugins/slicer/voice';
import { setSlicerInterpolation } from '../../src/engine/gen/plugins/slicer';
import { frecpe } from '../../src/engine/gen/plugins/slicer/interp';
import { FL_AUTO_48K, FL_AUTO_SLICES, FL_BEAT_SLICES, FL_DUMPS, FL_RENDERS, FL_ZERO_CROSS, GOLDEN_RATE, goldenLoop } from './slicer-golden';
import { genChannel, makeEngine, play, rms } from './util';

const LOOP = goldenLoop();
const MEDIUM = FL_AUTO_SLICES[0][2];

function slicesOf(pos: number[]) {
  return pos.map((p) => newSlice(p));
}

function engineFor(state: Record<string, unknown>, sr = GOLDEN_RATE): GenInstance {
  const g = createGen('slicer', sr, 512, { sample: (id) => (id === 'S' ? { channels: LOOP, sampleRate: GOLDEN_RATE } : undefined) })!;
  g.setParams(normalizeGenParams('slicer', { sample: 'S', ...state }));
  return g;
}

function voiceParams(key: number, cents = 0): GenVoiceParams {
  const init = newLevels(), levels = newLevels();
  init.pitch = 6000 + (key - 60) * 100; init.vol = 1;
  levels.pitch = init.pitch + cents; levels.vol = 1;
  return { key, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/** Render notes [key, start s, dur s] like FL's test host (512-sample blocks split at notes and ticks at 130 BPM). */
function renderLikeHost(g: GenInstance, notes: [number, number, number][], cents = 0, sr = GOLDEN_RATE): Float32Array {
  const ev = notes.map(([k, a, d]) => ({ k, on: Math.round(a * sr), off: Math.round((a + d) * sr) }));
  const dur = Math.max(...ev.map((x) => x.off)) + sr;
  const L = new Float32Array(dur);
  const voices: { v: GenVoice; e: (typeof ev)[number]; p: GenVoiceParams }[] = [];
  const spt = (sr * 60) / (130 * 96);
  let tick = 0;
  for (let b0 = 0; b0 < dur;) {
    let n = Math.min(512, dur - b0);
    for (const x of ev) for (const t of [x.on, x.off]) if (t > b0 && t < b0 + n) n = t - b0;
    while (Math.floor(tick * spt) <= b0) tick++;
    if (Math.floor(tick * spt) < b0 + n) n = Math.floor(tick * spt) - b0;
    for (const x of ev) {
      if (x.on === b0) { const p = voiceParams(x.k, cents); const v = g.triggerVoice!(p); if (v) voices.push({ v, e: x, p }); }
      if (x.off === b0) for (const o of voices) if (o.e === x) o.v.release();
    }
    for (let o = 0; o < n; o += 16) {
      const m = Math.min(16, n - o);
      const bl = new Float32Array(m), br = new Float32Array(m);
      for (const x of voices) x.p.frame = o;
      for (let i = voices.length - 1; i >= 0; i--) if (!voices[i].v.render(bl, br, m)) { voices[i].v.kill(); voices.splice(i, 1); }
      L.set(bl, b0 + o);
    }
    b0 += n;
  }
  return L;
}

describe('Slicer: registration and state', () => {
  it('is FL\'s Fruity Slicer: a Drum generator with the INS tab and no automatable parameters', () => {
    const d = genDef('slicer')!;
    expect(d).toBeTruthy();
    expect(d.name).toBe('Slicer');
    expect(d.category).toBe('Drum');
    expect(d.notes).toBe('voices');
    expect(d.ins).toBe(true);
    expect(d.levels).toBe('plugin');
    expect(d.defPoly).toBe(0);
    expect([d.width, d.height]).toEqual([377, 330]);
    expect(d.params).toEqual([]);
    expect(genInCategory('Drum').some((x) => x.id === 'slicer')).toBe(true);
  });

  it('starts with FL\'s plugin database state (Transient, AUTO-DUMP, DECLICK, AUTO-FIT, base key 60, no sample)', () => {
    const p = defaultGenParams('slicer');
    const s = slicerState(p);
    expect(s.method).toBe(4);
    expect(s.autoDump && s.declick && s.autoFit).toBe(true);
    expect(s.animate || s.playToEnd).toBe(false);
    expect(s.baseKey).toBe(60);
    expect(s.sample).toBe('');
    expect(s.slices).toEqual([]);
    expect([s.ts, s.ps, s.fadeIn, s.fadeOut, s.beats, s.tempo]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(defaultSlicerState().autoLow).toBe(100);
  });

  it('normalizes stored states (ranges, types, slices)', () => {
    const s = slicerState(normalizeGenParams('slicer', {
      ts: 99999, ps: -5000, method: 12, fadeIn: -3, fadeOut: 250, declick: 0, baseKey: 300, beats: -2, tempo: NaN,
      slices: [{ pos: -5, key: 999, name: 7, rev: 1 }, 'junk', { pos: 10.6 }],
    }));
    expect([s.ts, s.ps, s.method, s.fadeIn, s.fadeOut]).toEqual([20000, -1200, 7, 0, 100]);
    expect(s.declick).toBe(false);
    expect(s.baseKey).toBe(124);
    expect([s.beats, s.tempo]).toEqual([0, 0]);
    expect(s.slices).toEqual([{ pos: 0, key: 124, name: '', time: -1, rev: true }, { pos: 11, key: -1, name: '', time: -1, rev: false }]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('maps keys to slices like FL (base key, own keys, octave shift for many slices) and names them', () => {
    const sl = slicesOf([0, 10, 20]);
    sl[2].key = 61;
    const map = sliceKeyMap(sl, 60);
    expect(map[60]).toBe(0);
    expect(map[61]).toBe(2); // later slices win
    expect(map[62]).toBe(-1);
    expect(sliceKey(sl, 60, 1)).toBe(61);
    expect(baseKeyFor(16)).toBe(60);
    expect(baseKeyFor(70)).toBe(48);
    expect(baseKeyFor(124)).toBe(0);
    expect(sliceName(sl, 1)).toBe('Slice #2');
    const names = genDef('slicer')!.keyNames!({ slices: [{ pos: 0, key: -1, name: 'Kick', time: -1, rev: false }], baseKey: 60 });
    expect(names).toEqual({ 60: 'Kick' });
  });

  it('computes FL\'s loop timing (tempo from the file, beats from the tempo)', () => {
    const t = loopTiming(110250, 44100, 96);
    expect(t.beats).toBe(4);
    expect(t.tempo).toBe(96);
    expect(loopTiming(110250, 44100, 0)).toEqual({ beats: 0, tempo: 0 });
    expect(tempoOf(4, 110250, 44100)).toBe(96);
    expect(beatsOf(96, 110250, 44100)).toBe(4);
    expect(stretchFactor(10000)).toBe(2);
    expect(stretchFactor(-20000)).toBe(0.25);
    expect(Math.round(tsForRatio(1.2))).toBe(2630);
  });
});

describe('Slicer: slicing (FL results pinned)', () => {
  it('auto-slices the test loop exactly like FL for the presets and other LOW / HIGH values', () => {
    for (const [lo, hi, pos] of FL_AUTO_SLICES) expect(autoSlice(LOOP, GOLDEN_RATE, lo, hi)).toEqual(pos);
    expect(AUTO_PRESETS).toEqual([[33, 33], [100, 100], [167, 167]]);
    expect(thresholdFactor(100)).toBe(1);
  });

  it('auto-slices a 48 kHz sample like FL (analysis copy resampled with FL\'s 6-point kernel)', () => {
    expect(autoSlice(goldenLoop(48000), 48000, 100, 100)).toEqual(FL_AUTO_48K);
  });

  it('slices in beat divisions like FL, with FL\'s names', () => {
    for (const [div, pos] of FL_BEAT_SLICES) expect(beatSlices(LOOP[0].length, 4, div).map((b) => b.pos)).toEqual(pos);
    const b = beatSlices(LOOP[0].length, 4, 2);
    expect(b[0].name).toBe('1 - Beat 1');
    expect(b[1].name).toBe('2');
    expect(b[2].name).toBe('3 - Beat 2');
  });

  it('moves slices to the nearest zero crossing like FL', () => {
    expect(MEDIUM.map((p) => zeroCross(LOOP, GOLDEN_RATE, p))).toEqual(FL_ZERO_CROSS);
  });

  it('checks the slice list like FL (past the end dropped, one slice when none)', () => {
    expect(sliceLayout(100, [0, 40, 90, 120, 50])).toEqual([{ pos: 0, len: 40 }, { pos: 40, len: 50 }, { pos: 90, len: 10 }]);
    expect(sliceLayout(100, [])).toEqual([{ pos: 0, len: 100 }]);
    expect(sliceLayout(100, [0, 0])).toEqual([{ pos: 0, len: 1 }, { pos: 0, len: 100 }]);
  });
});

describe('Slicer: dump beat to piano roll (FL results pinned)', () => {
  it('writes FL\'s notes for every deterministic dump mode', () => {
    const input = { slices: slicesOf(MEDIUM), baseKey: 60, beats: 4, frames: LOOP[0].length, rate: GOLDEN_RATE, ppq: 96, stepsPerBeat: 4, tempo: 130 };
    for (const [mode, fl] of FL_DUMPS) {
      const mine = dumpNotes(input, mode).map((n) => [n.pos, n.len, n.note, n.pan, n.vol, n.pitch]);
      expect(mine, `mode ${mode}`).toEqual(fl);
    }
  });

  it('randomizes within FL\'s ranges (Random, Crazy)', () => {
    const input = { slices: slicesOf(MEDIUM), baseKey: 60, beats: 4, frames: LOOP[0].length, rate: GOLDEN_RATE, ppq: 96, stepsPerBeat: 4, tempo: 130 };
    let seed = 1;
    const rnd = (n: number) => { seed = (seed * 16807) % 2147483647; return seed % n; };
    for (const n of dumpNotes(input, 4, rnd)) expect(n.note >= 60 && n.note <= 72).toBe(true);
    for (const n of dumpNotes(input, 12, rnd)) {
      expect(Math.abs(n.pan)).toBeLessThanOrEqual(8);
      expect(n.vol >= 90 / 128 && n.vol <= 109 / 128).toBe(true);
      expect(n.pitch >= -200 && n.pitch <= 600).toBe(true);
    }
  });

  it('dumps all notes at 0 with length 1 when the loop length in beats is unknown (FL)', () => {
    const n = dumpNotes({ slices: slicesOf([0, 100]), baseKey: 60, beats: 0, frames: 1000, rate: 44100, ppq: 96, stepsPerBeat: 4, tempo: 130 }, 0);
    expect(n.map((x) => [x.pos, x.len])).toEqual([[0, 1], [0, 1]]);
  });
});

describe('Slicer: sound (FL renders pinned)', () => {
  for (const c of FL_RENDERS) {
    it(`plays like FL: ${c.name}`, () => {
      // the FL renders use the test host's process mode 0 (linear interpolation) unless noted
      setSlicerInterpolation(c.interp ?? 0);
      const g = engineFor(c.state);
      const out = renderLikeHost(g, c.notes, c.chanPitch ?? 0);
      setSlicerInterpolation(24);
      // FL's release declick and sinc phases use IPP's sine / cosine (1-ulp differences)
      for (let i = 0; i < c.at.length; i++) expect(Math.abs(out[c.at[i]] - c.left[i]), `${c.name} @${c.at[i]}`).toBeLessThan(1e-7);
    });
  }

  it('emulates the ARM reciprocal estimate (FRECPE) of FL\'s sinc kernel', () => {
    expect(frecpe(1)).toBe(0.998046875);
    expect(frecpe(3)).toBe(0.3330078125);
    expect(frecpe(-0.5)).toBe(-1.99609375);
    expect(frecpe(0)).toBe(Infinity);
  });

  it('plays each slice at its own pitch on its key, the raw slice times FL\'s centre pan gain', () => {
    const g = engineFor({ slices: slicesOf(MEDIUM), declick: false });
    const out = renderLikeHost(g, [[61, 0, 0.5]]);
    const gain = Math.fround(Math.cos(Math.fround(Math.PI / 4)));
    for (let i = 0; i < 2000; i += 37) expect(out[i]).toBe(Math.fround(LOOP[0][MEDIUM[1] + i] * gain));
  });

  it('fades a released slice over 441 samples (FL\'s INS release declick) and stops', () => {
    const g = engineFor({ slices: slicesOf(MEDIUM), declick: false });
    const out = renderLikeHost(g, [[60, 0, 0.05]]);
    const off = Math.round(0.05 * GOLDEN_RATE);
    expect(Math.abs(out[off + RELEASE_LEN + 5])).toBe(0);
    expect(Math.abs(out[off + 10])).toBeGreaterThan(0);
  });

  it('plays no voice for keys without a slice and nothing without a sample', () => {
    const g = engineFor({ slices: slicesOf(MEDIUM) });
    expect(g.triggerVoice!(voiceParams(59))).toBeNull();
    expect(g.triggerVoice!(voiceParams(125))).toBeNull();
    const empty = createGen('slicer', 44100, 512, { sample: () => undefined })!;
    empty.setParams(defaultGenParams('slicer'));
    expect(empty.triggerVoice!(voiceParams(60))).toBeNull();
  });

  it('PLAY TO END plays from the slice to the end of the sample', () => {
    const a = renderLikeHost(engineFor({ slices: slicesOf(MEDIUM), declick: false }), [[60, 0, 1]]);
    const b = renderLikeHost(engineFor({ slices: slicesOf(MEDIUM), declick: false, playToEnd: true }), [[60, 0, 1]]);
    const end0 = MEDIUM[1];
    expect(rms(a, end0 + 600, end0 + 4000)).toBe(0);
    expect(rms(b, end0 + 600, end0 + 4000)).toBeGreaterThan(0.01);
  });
});

describe('Slicer: processing', () => {
  it('reverses, declicks and fades slices (REV, DECLICK, ATT / DEC)', () => {
    const sl = slicesOf(MEDIUM);
    sl[1].rev = true;
    const p = processSlices({ channels: LOOP, sampleRate: GOLDEN_RATE }, sl, { ts: 0, ps: 0, method: 4, declick: false, fadeIn: 0, fadeOut: 0 });
    const len1 = MEDIUM[2] - MEDIUM[1];
    expect(p.channels[0][MEDIUM[1]]).toBe(LOOP[0][MEDIUM[1] + len1 - 1]);
    const d = processSlices({ channels: LOOP, sampleRate: GOLDEN_RATE }, slicesOf(MEDIUM), { ts: 0, ps: 0, method: 4, declick: true, fadeIn: 0, fadeOut: 0 });
    expect(Math.abs(d.channels[0][MEDIUM[1] - 1])).toBeLessThan(1e-6); // the end of slice 0 converges to 0
    const f = processSlices({ channels: LOOP, sampleRate: GOLDEN_RATE }, slicesOf(MEDIUM), { ts: 0, ps: 0, method: 4, declick: false, fadeIn: 100, fadeOut: 100 });
    expect(f.channels[0][MEDIUM[1]]).toBeCloseTo(0, 3);
  });

  it('stretches with TS: FL\'s slice layout, 16-bit fill gaps', () => {
    const p = processSlices({ channels: LOOP, sampleRate: GOLDEN_RATE }, slicesOf(MEDIUM), { ts: 10000, ps: 0, method: 0, declick: false, fadeIn: 0, fadeOut: 0 });
    expect(p.channels[0].length).toBe(LOOP[0].length * 2);
    expect(p.slices[1].pos).toBe(MEDIUM[1] * 2);
    expect(p.slices[1].srcLen).toBe(MEDIUM[2] - MEDIUM[1]);
    expect(floatToI16(1.5)).toBe(32767);
    expect(i16ToFloat(-32768)).toBe(-1);
    const src = new Int16Array(400).map((_, i) => Math.round(8000 * Math.sin(i / 7)));
    const dst = new Int16Array(800);
    fillGapsI16(src, dst, 400, 800, 1, 44100, 1);
    expect(dst.slice(0, 200)).toEqual(src.slice(0, 200));
    expect(Math.abs(dst[799])).toBeLessThan(80); // the gap fades out (method 1)
  });

  it('stays finite at extreme settings for every stretching method', () => {
    for (const method of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const [ts, ps] of [[20000, 0], [-20000, 0], [0, 1200], [0, -1200], [20000, 1200]]) {
        const p = processSlices({ channels: [LOOP[0].subarray(0, 30000)], sampleRate: GOLDEN_RATE }, slicesOf([0, 9000, 21000]), { ts, ps, method, declick: true, fadeIn: 100, fadeOut: 100 });
        for (const ch of p.channels) for (let i = 0; i < ch.length; i += 7) expect(Number.isFinite(ch[i])).toBe(true);
        expect(p.channels[0].length).toBe(Math.round(30000 * stretchFactor(ts)));
      }
    }
  }, 60000);
});

describe('Slicer: engine integration', () => {
  it('plays slices from pattern notes through the channel (INS, levels), finite at extreme pitches', () => {
    const e = makeEngine();
    e.handle({ t: 'sample', id: 'S', data: LOOP, sampleRate: GOLDEN_RATE });
    const c = genChannel('slicer');
    c.plugin!.params = normalizeGenParams('slicer', { sample: 'S', slices: slicesOf(MEDIUM) });
    const [L, R] = play(e, [c], { [c.id]: [{ key: 60, pos: 0, len: 24 }, { key: 63, pos: 24, len: 24, fine: 240 }, { key: 66, pos: 48, len: 24, fine: 0 }] }, 48000);
    expect(rms(L)).toBeGreaterThan(0.005);
    expect(rms(R)).toBeGreaterThan(0.005);
    for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
  }, 60000);
});

describe('Slicer: editor', () => {
  it('renders FL\'s layout, empty and with a sliced sample', async () => {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
    g.document ??= { body: {}, getElementById: () => null };
    const { FxEditorContext } = await import('../../src/ui/plugins/kit');
    const { editor } = await import('../../src/ui/plugins/gen/slicer');
    const render = (params: Record<string, unknown>) => renderToStaticMarkup(createElement(FxEditorContext.Provider,
      { value: { slotId: 'ch:x', plugin: 'slicer', params, trackName: 'Slicer', pluginName: 'Slicer' } }, createElement(editor.Editor)));
    const empty = render(normalizeGenParams('slicer', defaultGenParams('slicer')));
    for (const t of ['AUTO-DUMP', 'AUTO-FIT', 'DECLICK', 'REV', 'PS', 'TS', 'ATT', 'DEC', 'ANIMATE', 'PLAY TO END', 'AUTO', 'LOW', 'HIGH', 'FRUITY', 'SLICER']) {
      expect(empty).toContain(t);
    }
    const loaded = render(normalizeGenParams('slicer', { sample: 'S', file: 'loop.wav', beats: 4, tempo: 96, slices: slicesOf(MEDIUM), sel: 1 }));
    expect(loaded).toContain('loop.wav');
    expect(loaded).toContain('Slice #2');
    expect(editor.menu!('ch:x').map((m) => m.label)).toContain('Dump beat to piano roll');
  }, 60000);
});
