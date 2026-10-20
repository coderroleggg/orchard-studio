import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import type { FxEnv } from '../../src/engine/effects/types';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import { NTM_SAMPLE_PREFIX, knobText } from '../../src/model/fx/plugins/newtime';
import { beatPositions, detectTransients, estimateTempo, onsetEnvelope } from '../../src/engine/effects/plugins/newtools/onsets';
import { warpAudio } from '../../src/engine/effects/plugins/newtools/wsola';
import {
  GROOVES, MK_DOWNBEAT, MK_GROOVE, MK_SHIFT, MK_WARP, analyzeTime, applyGroove, beatLen, markerPos, quantize, renderTime, timeAnchors, timeOutLen,
  type NtmMarker,
} from '../../src/engine/effects/plugins/newtools/timemodel';
import { addMarker, applyPatternToAll, moveMarker, moveMarkers, removeMarkers, setMarkerType, snapDownbeat } from '../../src/engine/effects/plugins/newtools/timeops';
import { estimatePitch } from '../../src/engine/effects/plugins/newtools/pitch';
import { render, rms } from './util';

const SR = 44100;
const cents = (a: number, b: number) => 1200 * Math.log2(a / b);
const K0 = { groove: 0, shift: 0 };

function noise(n: number, amp: number, seed = 1): Float32Array {
  const x = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = (s / 0x7fffffff - 0.5) * amp; }
  return x;
}

/** Clicks (short decaying bursts) at the given sample positions on a quiet noise floor. */
function clicks(pos: number[], len: number): Float32Array {
  const x = noise(len, 0.002);
  for (const p of pos) for (let i = 0; i < 300 && p + i < len; i++) x[p + i] += Math.exp(-i / 50) * (i % 2 ? -0.8 : 0.8);
  return x;
}

function tone(f: number, sec: number, harm = 4, amp = 0.4): Float32Array {
  const n = Math.round(sec * SR), b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let h = 1; h <= harm; h++) s += Math.sin(ph * h) / h; ph += (2 * Math.PI * f) / SR; b[i] = amp * s; }
  return b;
}

function freqOf(x: Float32Array, srOrGuess: number, guessOrA?: number, aOrZ?: number, zArg?: number): number {
  // (x, sr, guess, a, z) or (x, guess, a, z) with the default rate
  const hasSr = guessOrA !== undefined && srOrGuess > 4000;
  const sr = hasSr ? srOrGuess : SR;
  const guess = hasSr ? guessOrA! : srOrGuess;
  let a = (hasSr ? aOrZ : guessOrA) ?? 0;
  let z = (hasSr ? zArg : aOrZ) ?? x.length;
  if (z - a > 16384) { const c = (a + z) >> 1; a = c - 8192; z = c + 8192; }
  const N = z - a;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)) * x[a + i];
  const mag = (f: number) => {
    // recursive oscillator (Goertzel-style rotation)
    const d = (2 * Math.PI * f) / sr;
    const cd = Math.cos(d), sd = Math.sin(d);
    let c = 1, s = 0, re = 0, im = 0;
    for (let i = 0; i < N; i++) {
      re += w[i] * c; im -= w[i] * s;
      const nc = c * cd - s * sd; s = s * cd + c * sd; c = nc;
    }
    return re * re + im * im;
  };
  let lo = guess * 0.95, hi = guess * 1.05, bf = guess, bm = -1;
  for (let k = 0; k <= 60; k++) { const f = lo + ((hi - lo) * k) / 60; const m = mag(f); if (m > bm) { bm = m; bf = f; } }
  const st = (hi - lo) / 60;
  lo = bf - st; hi = bf + st;
  for (let it = 0; it < 34; it++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (mag(m1) < mag(m2)) lo = m1; else hi = m2; }
  return (lo + hi) / 2;
}

const beatTrack = (bpm: number, beats: number, offset = 0) => {
  const per = (60 / bpm) * SR;
  const pos = Array.from({ length: beats }, (_, i) => Math.round(offset + i * per));
  return { pos, x: clicks(pos, Math.round(offset + beats * per)) };
};

describe('Newtime', () => {
  it('is registered as FL defines it (Misc, 727 x 582, one Play / pause parameter)', () => {
    const d = fxDef('newtime')!;
    expect(d.name).toBe('Newtime');
    expect(d.category).toBe('Misc');
    expect([d.width, d.height]).toEqual([727, 582]);
    expect(d.params.map((p) => [p.key, p.name, p.index, p.min, p.max, p.def])).toEqual([['play', 'Play / pause', 0, 0, 1, 0]]);
    const p = defaultFxParams('newtime');
    expect([p.groove, p.shift, p.bpm, p.snap, p.detect, p.sync]).toEqual([0, 0, 120, 4, 0, false]);
    expect(p.markers).toEqual([]);
    expect(knobText(16384)).toBe('+100%');
    expect(knobText(-8192)).toBe('-50%');
    const n = normalizeFxParams('newtime', { groove: 1e9, bpm: -3, markers: 'x' });
    expect([n.groove, n.bpm]).toEqual([16384, 120]);
    expect(n.markers).toEqual([]);
  });

  it('transient detection finds clicks to the millisecond, and nothing else', () => {
    const pos = [5000, 21000, 30100, 51234, 70000, 74500, 99999, 120321];
    const x = clicks(pos, 140000);
    const d = detectTransients(x, SR);
    expect(d.length).toBe(pos.length);
    for (let i = 0; i < pos.length; i++) expect(Math.abs(d[i] - pos[i])).toBeLessThan(0.001 * SR);
    // steady tone and silence: no transients after the start
    expect(detectTransients(new Float32Array(SR), SR)).toEqual([]);
    expect(detectTransients(tone(220, 1), SR).filter((p) => p > 0.05 * SR).length).toBe(0);
  });

  it('tempo detection: click tracks at several tempi and whole-bar loops', () => {
    for (const bpm of [90, 120, 140, 100]) {
      const { x } = beatTrack(bpm, 16, 1000);
      const env = onsetEnvelope(x, SR);
      expect(Math.abs(estimateTempo(env, SR) - bpm)).toBeLessThan(1.5);
    }
    // a two-bar loop at 100 BPM snaps to exactly 100
    const { x, pos } = beatTrack(100, 8, 0);
    const env = onsetEnvelope(x, SR);
    expect(estimateTempo(env, SR, x.length / SR)).toBe(100);
    // beats land on the clicks
    const beats = beatPositions(env, SR, 100, x.length);
    expect(beats.length).toBe(8);
    for (let i = 0; i < 8; i++) expect(Math.abs(beats[i] - pos[i])).toBeLessThan(0.012 * SR);
  });

  it('time stretch (WSOLA) changes the length and keeps the pitch', () => {
    const x = tone(330, 1.5);
    for (const r of [0.6, 0.8, 1.25, 1.5, 2]) {
      const outLen = Math.round(x.length * r);
      const [y] = warpAudio([x], SR, [{ src: 0, dst: 0 }, { src: x.length, dst: outLen }], outLen);
      expect(y.length).toBe(outLen);
      const f = freqOf(y, 330, 4000, y.length - 4000);
      expect(Math.abs(cents(f, 330))).toBeLessThan(2);
      expect(Math.abs(cents(estimatePitch(y, SR), 330))).toBeLessThan(2);
      expect(Math.abs(20 * Math.log10(rms(y, 4000, y.length - 4000) / rms(x, 4000, x.length - 4000)))).toBeLessThan(1.5);
    }
  });

  it('a moved warp marker moves its transient there; the rest stays and the length is kept', () => {
    const pos = [11025, 33075, 55125, 77175];
    const x = clicks(pos, 88200);
    const markers: NtmMarker[] = pos.map((p, i) => ({ id: i + 1, src: p, dst: p, type: MK_WARP }));
    const moved = moveMarker(markers, 2, pos[1] + 2205, K0, x.length, 120, SR); // +50 ms
    expect(moved[1].dst).toBe(pos[1] + 2205);
    const [y] = renderTime([x], SR, moved, K0, 120, false, 120);
    expect(y.length).toBe(x.length);
    const d = detectTransients(y, SR);
    expect(d.length).toBe(4);
    expect(Math.abs(d[0] - pos[0])).toBeLessThan(45);
    expect(Math.abs(d[1] - (pos[1] + 2205))).toBeLessThan(45);
    expect(Math.abs(d[2] - pos[2])).toBeLessThan(45);
    // an unedited warp is the source itself
    const [z] = renderTime([x], SR, markers, K0, 120, false, 120);
    expect(z).toEqual(x);
  });

  it('tempo-sync stretches to the project tempo without changing the pitch', () => {
    const x = tone(262, 2);
    expect(timeOutLen(x.length, 100, true, 120)).toBe(Math.round((x.length * 100) / 120));
    const [y] = renderTime([x], SR, [], K0, 100, true, 120);
    expect(y.length).toBe(Math.round((x.length * 100) / 120));
    expect(Math.abs(cents(freqOf(y, 262, 4000, y.length - 4000), 262))).toBeLessThan(2);
    // sync off: untouched
    expect(renderTime([x], SR, [], K0, 100, false, 120)[0].length).toBe(x.length);
  });

  it('marker detection modes, quantize and the downbeat', () => {
    const { x, pos } = beatTrack(120, 8, 300);
    const tr = analyzeTime([x], SR, 0);
    expect(tr.markers.length).toBe(8);
    expect(Math.abs(tr.bpm - 120)).toBeLessThan(1.5);
    const tb = analyzeTime([x], SR, 1, 120);
    expect(tb.markers.length).toBeGreaterThanOrEqual(7);
    for (const m of tb.markers) expect(pos.some((p) => Math.abs(p - m.src) < 0.002 * SR)).toBe(true);
    expect(analyzeTime([x], SR, 2).markers).toEqual([]);
    // quantise: off-grid markers snap to 1/4 beat
    const bl = beatLen(120, SR);
    const ms: NtmMarker[] = [{ id: 1, src: 20000, dst: Math.round(bl * 1.07), type: MK_WARP }, { id: 2, src: 40000, dst: Math.round(bl * 2.2), type: MK_WARP }];
    const q = quantize(ms, 4, 120, SR);
    expect(q[0].dst).toBeCloseTo(bl, 0);
    expect(q[1].dst).toBeCloseTo(bl * 2.25, 0);
    // downbeat: unique, snaps to a bar, sets the grid origin
    let d = setMarkerType(ms, 1, MK_DOWNBEAT);
    d = setMarkerType(d, 2, MK_DOWNBEAT);
    expect(d.filter((m) => m.type === MK_DOWNBEAT).map((m) => m.id)).toEqual([2]);
    const sd = snapDownbeat(d, K0, 200000, 120, SR);
    expect(sd.find((m) => m.id === 2)!.dst % Math.round(bl * 4)).toBeLessThan(2);
  });

  it('groove and shift markers follow their knobs', () => {
    const bl = beatLen(120, SR);
    const ms: NtmMarker[] = [0.25, 0.5, 0.75, 1.25].map((b, i) => ({ id: i + 1, src: Math.round(b * bl), dst: Math.round(b * bl), type: MK_WARP }));
    const swing = GROOVES.find((g) => g.name === 'Swing 1/16 66%')!;
    const gm = applyGroove(ms, swing, 120, SR);
    expect(gm.every((m) => m.type === MK_GROOVE)).toBe(true);
    // off-sixteenths move later at +100 %, stay at 0 %, move the other way at -100 %
    const m1 = gm[0];
    expect(markerPos(m1, K0, 120, SR)).toBe(m1.dst);
    const near = (v: number, w: number) => expect(Math.abs(v - w)).toBeLessThan(2);
    near(markerPos(m1, { groove: 16384, shift: 0 }, 120, SR), (0.25 + 1 / 12) * bl);
    near(markerPos(m1, { groove: -16384, shift: 0 }, 120, SR), (0.25 - 1 / 12) * bl);
    near(markerPos(gm[1], { groove: 16384, shift: 0 }, 120, SR), 0.5 * bl); // on-beat eighth stays
    // shift markers move together by up to half a beat
    const sm = setMarkerType(ms, 3, MK_SHIFT);
    near(markerPos(sm[2], { groove: 0, shift: 16384 }, 120, SR), 0.75 * bl + 0.5 * bl);
    near(markerPos(sm[2], { groove: 0, shift: -8192 }, 120, SR), 0.75 * bl - 0.25 * bl);
    // the warp stays monotonic whatever the knobs do
    const a = timeAnchors(sm, { groove: 0, shift: 16384 }, 4 * Math.round(bl), 120, SR);
    for (let i = 1; i < a.length; i++) { expect(a[i].dst).toBeGreaterThan(a[i - 1].dst); expect(a[i].src).toBeGreaterThan(a[i - 1].src); }
  });

  it('marker edits: add through the warp, move with clamping, remove, region move, pattern to all', () => {
    const len = 4 * SR;
    let ms: NtmMarker[] = [{ id: 1, src: SR, dst: SR, type: MK_WARP }, { id: 2, src: 2 * SR, dst: 2 * SR, type: MK_WARP }];
    // stretch: marker 2 to 2.5 s, then add a marker at output 2.25 s -> source 1.5 s
    ms = moveMarker(ms, 2, 2.5 * SR, K0, len, 120, SR);
    const added = addMarker(ms, 1.75 * SR, K0, len, 120, SR, 3)!;
    expect(added.length).toBe(3);
    expect(Math.abs(added[1].src - 1.5 * SR)).toBeLessThan(2);
    // cannot cross a neighbour
    const c = moveMarker(added, 3, 3.5 * SR, K0, len, 120, SR);
    expect(c.find((m) => m.id === 3)!.dst).toBeLessThan(2.5 * SR);
    // region: markers 1 and 3 together by +0.1 s
    const r = moveMarkers(added, new Set([1, 3]), 0.1 * SR, K0, len, 120, SR);
    expect(r.find((m) => m.id === 1)!.dst).toBe(SR + 0.1 * SR);
    expect(r.find((m) => m.id === 3)!.dst).toBe(Math.round(1.75 * SR + 0.1 * SR));
    expect(removeMarkers(added, new Set([3])).map((m) => m.id)).toEqual([1, 2]);
    // copy the pattern of bar 1 (a pushed third beat) to bar 2
    const bl = beatLen(120, SR);
    const pm: NtmMarker[] = [2.1, 6.1].map((b, i) => ({ id: i + 1, src: Math.round(b * bl), dst: Math.round(b * bl), type: MK_WARP }));
    pm[0] = { ...pm[0], dst: Math.round(1.9 * bl) };
    const ap = applyPatternToAll(pm, 0, 4 * bl, K0, 8 * Math.round(bl), 120, SR);
    expect(ap[1].dst).toBeCloseTo(5.9 * bl, -1);
  });

  // ------------------------------------------------------------- DSP
  it('passes the input through and plays the render while Play is on', () => {
    const L = tone(500, 0.5, 1, 0.3);
    const env: FxEnv = { sample: (id) => (id === NTM_SAMPLE_PREFIX + 'w1' ? { channels: [L, L], sampleRate: SR } : undefined) };
    const fx = createEffect('newtime', SR, 128, env);
    const out = { id: 'w1', hash: 'a', frames: L.length, sr: SR };
    fx.setParams({ ...defaultFxParams('newtime'), out });
    const inp = tone(1000, 0.1, 1, 0.1);
    const [a] = render(fx, inp, inp, 128, { sampleRate: SR });
    expect(Array.from(a)).toEqual(Array.from(inp));
    fx.setParams({ ...defaultFxParams('newtime'), out, play: 1, seek: 1 });
    expect(fx.tail).toBe(Infinity);
    const z = new Float32Array(SR / 4);
    const [b] = render(fx, z, z, 128, { sampleRate: SR });
    for (let i = 300; i < 3000; i++) expect(b[i]).toBeCloseTo(L[i], 5);
    // stop
    fx.setParams({ ...defaultFxParams('newtime'), out, play: 0, seek: 2 });
    const [c] = render(fx, z, z, 128, { sampleRate: SR });
    expect(rms(c, 400)).toBe(0);
  });
});
