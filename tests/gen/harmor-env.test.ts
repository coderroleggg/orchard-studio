// Harmor articulators (src/engine/gen/plugins/harmor/art.ts + env.ts) against
// FL Studio 2026's Harmor, bit for bit. The vectors below were captured with
// the FL test host (.flref/harmor/host, dumps of every voice object after every
// render call; .flref/harmor/envwork/README.md): per render call an FNV-1a hash
// of FL's articulator states (output, chain result, envelope stage / point /
// level, LFO phase / output of every evaluated articulator of every rendered
// voice) plus the inputs FL used. The driver replays FL's voice flow (TriggerVoice
// random tables / unison positions / shared global envelopes, poly release
// scale, arpeggio positions, predelay, the per-block sequence of the voice
// render 0xe1b60, Voice_Release, global LFO sync and advance) on our ArtVoice.
// Cases: five synthetic states (Default + curves: all 13 segment types, loops,
// tempo sync, global envelopes, arpeggio points, LFO shapes / flags, all 9
// mapping inputs incl. unison and X speed under Mod X automation, global
// envelope modifiers, velocity / release velocity links, smoothing) and the
// factory presets Arp/Cubist, Bell/Bonze and FX/Haunted place (chords, both
// parts, unison, releases).
import { describe, it, expect } from 'vitest';
import { expandDiff, harmorBank } from '../../src/model/gen/plugins/harmor/state';
import { base64ToBytes, inflateRaw } from '../../src/model/gen/plugins/harmor/inflate';
import type { HArt, HEnv, HPart } from '../../src/model/gen/plugins/harmor/types';
import { ArtInputs, ArtPart, ArtVoice, harmorBlockLen, smoothCoef } from '../../src/engine/gen/plugins/harmor/art';
import { compileCurve, mapAt, mapFill32, mapIterInit, mapIterNext, mapValue, CurveState, lfoIncrement } from '../../src/engine/gen/plugins/harmor/env';

const fb = new Float32Array(1), ub = new Uint32Array(fb.buffer);
const f32b = (x: number): number => { fb[0] = x; return ub[0]; };
const bf32 = (u: number): number => { ub[0] = u >>> 0; return fb[0]; };
const fnv = (h: number, w: number): number => {
  for (let k = 0; k < 4; k++) h = Math.imul(h ^ ((w >>> (8 * k)) & 0xff), 0x01000193) >>> 0;
  return h;
};

// ------------------------------------------------------------ synthetic states (Default + curves)

type Pt = number[];
const P = (...pts: Pt[]): number[][] => pts.map((p) => [...p, 0, 0, 0, 0, 0, 0, 0].slice(0, 7));
const mapc = (...pts: Pt[]): number[][] => { const tot = pts.reduce((s, p) => s + p[0], 0); return P(...pts.map((p) => [p[0] / tot, ...p.slice(1)])); };
interface Patch { pts: number[][]; m?: number[]; extra?: number[] }
const ALLSEG: Pt[] = [[0.05, 1, 0.5, 0], [0.04, 0.3, -0.6, 1], [0.05, 0.8, 0.3, 3], [0.04, 0.2, -0.4, 3], [0.06, 0.9, 0.5, 4], [0.05, 0.3, -0.5, 4],
  [0.04, 0.7, 0.6, 5], [0.05, 0.1, -0.3, 6], [0.06, 0.6, 0.2, 6], [0.05, 0.95, 0.7, 7], [0.04, 0.5, -0.7, 8], [0.05, 0.65, 0.4, 9],
  [0.04, 0.35, -0.5, 9], [0.05, 0.8, 0.5, 10], [0.06, 0.55, 0.0, 10], [0.04, 0.75, 0.6, 11], [0.05, 0.25, -0.6, 12], [0.06, 0.6, 0.8, 12],
  [0.05, 0.45, 0.0, 2], [0.04, 0.5, 0.3, 0]];
/** [art, k (0 env, 1 LFO, 2 + j mapping j), patch] for part A. */
const SYN: Record<string, [number, number, Patch][]> = {
  syn1: [[1, 0, { pts: P([0, 0], [0.3, 1, 0.5, 0], [0.25, 0.4, -0.6, 1], [0.2, 0.8, 0.3, 3], [0.2, 0.2, -0.4, 3], [0.25, 0.9, 0.5, 4], [0.3, 0.3, -0.5, 4], [0.2, 0.7, 0.6, 5],
    [0.2, 0.1, -0.3, 6], [0.3, 0.6, 0.2, 6], [0.25, 0.95, 0.7, 7], [0.2, 0.5, -0.7, 8], [0.3, 0.65, 0.4, 9], [0.2, 0.35, -0.5, 9], [0.25, 0.8, 0.5, 10], [0.3, 0.55, 0.0, 10],
    [0.2, 0.75, 0.6, 11], [0.25, 0.25, -0.6, 12], [0.3, 0.6, 0.8, 12], [0.2, 0.45, 0.0, 2], [0.4, 0.5, 0.3, 0], [0.5, 0, -0.4, 1]), m: [0, -1, 1, 14, 18], extra: [128, 128, 0, 128] }]],
  syn2: [
    [1, 0, { pts: P([0, 0], ...ALLSEG), m: [0, -1, 2, 4, 16] }],
    [0, 0, { pts: P([0, 0.5], [0.25, 1, 0.3, 0], [0.5, 0.2, -0.5, 1], [0.25, 0.7, 0.2, 9], [0.5, 0.5, 0.4, 0]), m: [1, -1, 1, 3, 3] }],
    [2, 0, { pts: P([0.02, 0.1], [0.1, 1, 0.6, 0], [0.2, 0.6, -0.4, 0], [0.15, 0.3, 0.2, 7], [0.3, 0.0, -0.3, 0]), m: [2, -1, 1, -1, 3] }],
    [3, 0, { pts: P([0, 0, 0, 0, 2], [0.05, 1, 0.3, 0, 0], [0.1, 0.4, 0, 0, 3], [0.1, 0.8, -0.3, 1, 0], [0.1, 0.2, 0, 0, 4], [0.2, 0.5, 0.2, 0, 0]), m: [0, -1, -1, 0, 5] }],
  ],
  syn3: [
    [1, 1, { pts: P([0.2, 0.5], [0.3, 1.0, 0.5, 0], [0.5, 0.7, -0.3, 0], [0.4, 0.5, 0.2, 0]), m: [0, -1, -1, -1, 2], extra: [50000, 60, -70, 40, 123456789] }],
    [0, 1, { pts: P([0, 1.0], [0.3, 0.8, 0.4, 0]), m: [4, -1, -1, -1, -1], extra: [30000, -90, 100, -60, 0] }],
    [24, 1, { pts: P([0, 0.9]), m: [8, -1, -1, -1, -1], extra: [45000, 20, 0, 0, 7] }],
    [4, 1, { pts: P([0, 0.6], [1.0, 1.0, 0.3, 1]), m: [3, -1, -1, -1, 1], extra: [25000, 0, 30, 0, 0] }],
    [2, 1, { pts: P([0.1, 0.5], [0.5, 1.0, 0, 0]), m: [1, -1, -1, -1, 1], extra: [20000, 128, 128, 112, 2147483648] }],
    [17, 1, { pts: P([0, 1.0]), m: [5, -1, -1, -1, -1], extra: [65536, -128, -128, -112, 0] }],
    [38, 2, { pts: mapc([0, 0.2], [0.5, 0.9, 0.3, 0], [0.5, 0.6, -0.4, 0]) }],
    [39, 3, { pts: mapc([0, 0.3], [1.0, 0.8, 0.5, 1]) }],
    [40, 2, { pts: mapc([0, 0.5], [1.0, 0.9, 0, 0]) }],
  ],
  syn4: [
    [1, 2, { pts: mapc([0, 0.6], [0.2, 0.9, 0.5, 3], [0.15, 0.2, -0.4, 11], [0.2, 0.7, 0.3, 9], [0.25, 0.4, -0.6, 10], [0.2, 0.8, 0.4, 12]) }],
    [1, 3, { pts: mapc([0, 0.2], [0.3, 1.0, 0.6, 12], [0.4, 0.5, -0.5, 9], [0.3, 0.9, 0.2, 10]) }],
    [1, 4, { pts: mapc([0, 0.3], [0.5, 0.9, 0.4, 0], [0.5, 0.5, -0.6, 1]) }],
    [1, 5, { pts: mapc([0, 0.9], [0.3, 0.2, 0.5, 6], [0.7, 0.8, -0.3, 0]) }],
    [1, 6, { pts: mapc([0, 0.4], [1.0, 1.0, 0.7, 0]) }],
    [1, 7, { pts: mapc([0, 0.1], [0.5, 1.0, -0.5, 0], [0.5, 0.6, 0.3, 4]) }],
    [1, 8, { pts: mapc([0, 0.5], [0.5, 1.0, 0, 0], [0.5, 0.2, 0, 0]) }],
    [1, 9, { pts: mapc([0, 1.0], [0.3, 0.4, 0.3, 3], [0.7, 0.9, -0.2, 0]) }],
    [1, 10, { pts: mapc([0, 0.8], [1.0, 0.2, 0.5, 0]) }],
    [0, 2, { pts: mapc([0, 0.5], [0.3, 0.9, 0.6, 6], [0.4, 0.1, -0.5, 5], [0.3, 0.7, 0.2, 7]) }],
    [0, 3, { pts: mapc([0, 0.2], [0.6, 0.8, 0.4, 8], [0.4, 0.4, -0.3, 2]) }],
    [2, 2, { pts: mapc([0, 0.0], [0.4, 1.0, 0.3, 4], [0.3, 0.3, -0.5, 7], [0.3, 0.8, 0.6, 8]) }],
    [2, 7, { pts: mapc([0, 0.3], [1.0, 0.9, 0.5, 9]) }],
    [24, 4, { pts: mapc([0, 0.5], [0.5, 0.8, 0, 0], [0.5, 0.4, 0, 0]) }],
  ],
  syn5: [
    [1, 0, { pts: P([0, 0], [0.3, 1, 0.4, 0], [0.4, 0.6, -0.3, 0], [0.5, 0.0, 0.2, 0]), m: [0, -1, 1, -1, 2] }],
    [0, 0, { pts: P([0, 0.5], [0.2, 1.0, 0.2, 0], [0.3, 0.3, 0, 0], [0.3, 0.5, 0, 0]), m: [0, -1, 1, -1, 2] }],
    [0, 1, { pts: P([0, 1.0]), m: [0, -1, -1, -1, -1], extra: [40000, 0, 0, 0, 0] }],
    [33, 2, { pts: mapc([0, 0.5], [1.0, 0.8, 0.3, 0]) }],
    [34, 3, { pts: mapc([0, 1.0], [1.0, 0.3, -0.4, 0]) }],
    [35, 2, { pts: mapc([0, 0.4], [1.0, 1.0, 0.5, 0]) }],
    [36, 3, { pts: mapc([0, 0.3], [1.0, 0.7, 0, 0]) }],
    [37, 2, { pts: mapc([0, 1.0], [1.0, 0.5, 0.3, 0]) }],
    [40, 3, { pts: mapc([0, 0.5], [1.0, 0.8, 0, 0]) }],
  ],
};

function synthState(name: string): Record<string, unknown> {
  const st = expandDiff({}) as Record<string, unknown>;
  const part = { ...(st.hA as HPart), arts: (st.hA as HPart).arts.slice() };
  for (const [t, k, pa] of SYN[name]) {
    const a: HArt = { ...part.arts[t], k: part.arts[t].k.slice() };
    const old: HEnv = k === 0 ? a.e : k === 1 ? a.l : a.k[k - 2];
    const e: HEnv = { ...old, p: pa.pts, m: pa.m ?? old.m };
    if (pa.extra && k === 0) e.a = pa.extra.slice(0, 4);
    if (pa.extra && k === 1) { e.l = pa.extra.slice(0, 4); e.ph = pa.extra[4]; }
    if (k === 0) a.e = e; else if (k === 1) a.l = e; else a.k[k - 2] = e;
    part.arts[t] = a;
  }
  st.hA = part;
  return st;
}

const VEC =
  '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' +
  'Ag==';

// ------------------------------------------------------------------ FL voice flow replay

interface Note { on: number; off: number; vel: number; rel?: number }
interface VecCase {
  pidx: number; notes: Note[]; N: number; tempo: number; mainLfo: number; d98: number; voiceRand: number; params: number[];
  parts: { on: number; f1a4: number; f1a0: number; uni: number; f1d0: number }[];
  calls: number[]; vl: [number, number[]][]; voices: { part: number; rnd: number[] | null; f64: number; first: number }[];
  inputs: number[][]; hashes: number[]; live: number[][][];
}
const ADSR = ['att', 'dec', 'sus', 'rel', 'lfoSpd', 'lfoTns', 'lfoSkw', 'lfoPw'];

function replay(name: string, c: VecCase): { calls: number; first: number; voiceBlocks: number } {
  const st = c.pidx >= 0 ? (expandDiff(harmorBank()[c.pidx]) as Record<string, unknown>) : synthState(name);
  const params: Record<string, unknown> = { ...st };
  (['a', 'b'] as const).forEach((pk, pi) => {
    for (let t = 0; t < 31; t++) ADSR.forEach((f, k) => { params[`${pk}_art${t}_${f}`] = c.live[pi][t][k]; });
    for (let t = 0; t < 43; t++) params[`${pk}_art${t}_smooth`] = c.params[pi * 386 + 343 + t];
  });
  const tempo = bf32(c.tempo), mainLfo = bf32(c.mainLfo), N = c.N, Pm = c.params;
  const parts = (['a', 'b'] as const).map((pk) => {
    const p = new ArtPart();
    p.setup((st[pk === 'a' ? 'hA' : 'hB'] as HPart).arts, params, pk, tempo, 44100, N);
    p.syncGlobalLfo(0); // the host starts playing at song position 0
    return p;
  });
  const randCount = Math.max(parts[0].randMax, parts[1].randMax);
  interface Rec { v: ArtVoice; pi: number; inp: ArtInputs; rem: number; v4c: number; delay: number; s224: number; released: boolean; scaled: boolean; note: number; f64: number; live: boolean }
  const recs: Rec[] = [];
  const notes = c.notes.map((n) => ({ ...n, state: 0, made: [0, 0], table: null as Float32Array | null, drawPart: -1 }));
  const byVoice = new Map<number, number[][]>();
  for (const e of c.inputs) { const l = byVoice.get(e[1]) ?? []; l.push(e); byVoice.set(e[1], l); }
  const ptr = new Map<number, number>();
  let list: number[] = [], vlNext = 0, pos = 0, first = -1, voiceBlocks = 0;
  const has = (l: Int32Array, i: number) => { for (let k = 0; l[k] >= 0; k++) if (l[k] === i) return true; return false; };
  for (let ci = 0; ci < c.calls.length; ci++) {
    const len = c.calls[ci];
    while (vlNext < c.vl.length && c.vl[vlNext][0] === ci) list = c.vl[vlNext++][1];
    let event = false;
    for (const n of notes) if (n.state === 1 && n.off <= pos) {
      n.state = 2;
      for (const r of recs) if (r && r.note === notes.indexOf(n) && !r.released) {
        r.released = true;
        if (r.s224 < 6) r.s224 = 6;
        r.v.release(parts[r.pi], Pm[16 + 386 * r.pi] ? Math.fround((n.rel ?? 0.5) * 2) : 1);
      }
      event = true;
    }
    const fresh = c.voices.map((v, vid) => ({ v, vid })).filter((x) => x.v.first === ci);
    for (const r of recs) if (r) r.live = list.includes(recs.indexOf(r));
    if (fresh.length) {
      for (let pi = 0; pi < 2; pi++) {
        const f = bf32(c.parts[pi].f1a4);
        if (!c.parts[pi].on || f === 1) continue;
        for (const r of recs) if (r && r.released && r.s224 === 6 && !r.scaled) { r.v.scalePolyRelease(parts[pi], f); r.scaled = true; }
      }
      for (const { v: fv, vid } of fresh) {
        const pi = fv.part, cp = c.parts[pi];
        const k = notes.findIndex((n) => n.state === 0 && n.on <= pos && n.made[pi] < Math.max(1, cp.uni));
        const n = notes[k];
        const u = n.made[pi]++;
        // FL TriggerVoice: the note's first voice draws a table; then per unison voice (voiceRand 3) / per part (>= 2)
        const draw = !n.table || c.voiceRand === 3 || (c.voiceRand >= 2 && n.drawPart !== pi);
        if (draw) { n.table = Float32Array.from((fv.rnd ?? []).map(bf32)); n.drawPart = pi; }
        let shared: Rec | null = null;
        for (const r of recs) if (r && r.live && r.pi === pi && !r.released) { shared = r; break; }
        const v = new ArtVoice();
        const vel = Math.fround(Math.min(n.vel / 128, 1));
        const vas = Pm[15 + 386 * pi] ? Math.fround(2 - Math.fround(vel * 2)) : NaN;
        v.trigger(parts[pi], n.table!, randCount, cp.uni === 1 ? 0.5 : Math.fround(u * bf32(cp.f1d0)), vas, shared ? shared.v : null);
        recs[vid] = { v, pi, inp: new ArtInputs(), rem: v.sharedEnv && shared ? -Math.abs(shared.rem) : -N, v4c: 1, delay: 0, s224: 1,
          released: false, scaled: false, note: k, f64: bf32(fv.f64), live: true };
        event = true;
      }
      for (const n of notes) if (n.state === 0 && n.on <= pos) n.state = 1;
    }
    if (event && (parts[0].hasArp || parts[1].hasArp)) {
      const live = list.map((vid) => recs[vid]).filter((r) => r && !r.released);
      const vals = [...new Set(live.map((r) => r.f64))].sort((a, b) => (c.d98 ? b - a : a - b));
      for (const r of live) r.v.setArp(parts[r.pi], vals.indexOf(r.f64), vals.length);
    }
    let h = 0x811c9dc5;
    for (const vid of list) {
      const r = recs[vid], p = parts[r.pi], v = r.v, inp = r.inp;
      const ev = byVoice.get(vid) ?? [];
      let q = ptr.get(vid) ?? -1;
      while (q + 1 < ev.length && ev[q + 1][0] <= ci) q++;
      ptr.set(vid, q);
      const e = ev[q];
      for (let j = 0; j < 5; j++) inp.map[j] = bf32(e[2 + j]);
      inp.map[7] = bf32(e[7]);
      inp.map[8] = bf32(e[8]);
      let left = r.s224 === 10 ? 0 : len;
      r.s224 = e[9];
      while (left > 0) {
        if (r.delay > 0) { const k = Math.min(r.delay, left); r.delay -= k; left -= k; continue; }
        if (r.rem <= 0) {
          const firstBlock = r.v4c > 0;
          v.process(p, p.listA, inp);
          if (firstBlock) {
            v.snap(p, p.listA);
            const pd = Math.fround(v.out[42] * bf32(c.parts[r.pi].f1a0));
            if (pd !== 0 && r.v4c === 1) { r.v4c = 2; r.delay = Math.round(pd); continue; }
            v.applyGlobal(p, Pm[14 + 386 * r.pi] ? inp.map[1] : 0);
          }
          if (r.rem < 0) { r.rem = -r.rem; inp.first = 0; } else { r.rem = N; inp.first = 1; }
          inp.lfoAmt = Math.fround(v.out[38] * mainLfo);
          inp.lfoSpeed = v.out[39];
          v.process(p, p.listB, inp);
          if (firstBlock) v.snap(p, p.listB);
          r.v4c = 0;
        }
        const k = Math.min(r.rem, left);
        r.rem -= k;
        left -= k;
      }
      voiceBlocks++;
      for (let i = 0; i < 43; i++) {
        if (!has(p.listA, i) && !has(p.listB, i)) continue;
        h = fnv(fnv(h, f32b(v.out[i])), f32b(v.target[i]));
        if (p.arts[i].env.enabled !== 0) h = fnv(fnv(fnv(h, v.env[i].stage >>> 0), v.env[i].cur >>> 0), f32b(v.env[i].out));
        if (p.arts[i].lfo.enabled !== 0) h = fnv(fnv(h, v.lfo[i].phase >>> 0), f32b(v.lfo[i].lfoOut));
      }
    }
    parts[0].advanceGlobalLfo(len);
    parts[1].advanceGlobalLfo(len);
    if (h !== c.hashes[ci] && first < 0) first = ci;
    pos += len;
  }
  return { calls: c.calls.length, first, voiceBlocks };
}

const CASES = JSON.parse(new TextDecoder().decode(inflateRaw(base64ToBytes(VEC)))) as Record<string, VecCase>;

describe('Harmor articulators vs FL (captured per render call)', () => {
  for (const name of Object.keys(CASES)) {
    it(`${name}: every render call's articulator states hash like FL's`, () => {
      const r = replay(name, CASES[name]);
      expect(r.voiceBlocks).toBeGreaterThan(200);
      expect(r.first, `first differing render call of ${r.calls}`).toBe(-1);
    });
  }
});

describe('Harmor curve helpers', () => {
  it('control block length and smoothing coefficient follow FL', () => {
    expect(harmorBlockLen(44100, 200)).toBe(88); // FL's default granularity (dumps: plug+0xe40 = 88)
    expect(harmorBlockLen(44100, 150)).toBe(68); // Arp/Chip (grain 150)
    expect(harmorBlockLen(48000, 50)).toBe(24);
    expect(smoothCoef(0, 44100, 88)).toBe(0);
    expect(smoothCoef(1001, 44100, 88)).toBe(1);
    expect(f32b(smoothCoef(500, 44100, 88))).toBe(f32b(Math.fround(Math.exp(Math.log(0.01) / ((44100 * (Math.exp(500 * 0.0089999999999999993 * 0.6931471805599453) - 1)) / (51.100000000000001 * 88))))));
    // LFO phase increment per tick at the default speed, Arp/Chip (68-sample blocks, synced LFO off):
    // FL's TMLFO speed +0x10 = 0x3f69436853c7108e, increment +0x98 = 0x4159437cc0000000
    const d = new Float64Array(2), u = new Uint32Array(d.buffer);
    u[1] = 0x3f694368; u[0] = 0x53c7108e; u[3] = 0x4159437c; u[2] = 0xc0000000;
    expect(d[0]).toBe(68 * (1 / 44100) * 2);
    expect(lfoIncrement(40898, d[0])).toBe(d[1]);
  });

  it('map readers agree: fill, value at x, sequential reader and lookup', () => {
    const e: HEnv = { t: 3, p: mapc([0, 0.2], [0.3, 0.9, 0.5, 3], [0.4, 0.4, -0.6, 10], [0.3, 0.8, 0.4, 12]), m: [0, -1, -1, -1, -1] };
    const m = compileCurve(e, 'map');
    const dst = new Float32Array(17);
    mapFill32(m, dst, 0, 17, 0);
    const st = new CurveState();
    mapIterInit(m, st);
    let x = 0;
    for (let i = 0; i < 17; i++) {
      if (i > 0) { mapIterNext(m, st, 1 / 16); x += 1 / 16; } else x = 0;
      expect(st.out).toBe(dst[i]);
      expect(mapAt(m, i / 16)).toBe(mapValue(m, i / 16));
    }
    expect(Number.isFinite(dst[16])).toBe(true);
  });
});
