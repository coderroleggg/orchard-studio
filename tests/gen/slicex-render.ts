// Host-like renderer and state patches for tests/gen/slicex.test.ts: renders Slicex the way FL's
// test host does (0.25 s preroll with the transport stopped, 512-frame blocks split at note and
// automation events, 130 BPM, playing from the first output frame), from a state built like FL's
// after loading a WAV (def.state() + sxLoadDeck) with the case's patch applied.

import { def } from '../../src/model/gen/plugins/slicex';
import { gen } from '../../src/engine/gen/plugins/slicex';
import { settingsFromRaw } from '../../src/model/gen/plugins/slicex/defaults';
import { sxLoadDeck } from '../../src/model/gen/plugins/slicex/ops';
import type { SxArt, SxDeck, SxRegion, SxSettings } from '../../src/model/gen/plugins/slicex/types';
import type { GenNote } from '../../src/engine/gen/types';
import type { InterpMode } from '../../src/model/sampler';

const f32 = Math.fround;

/** A state patch, applied the same way to FL's saved state when the reference renders were made. */
export interface SxPatch {
  /** Option block bytes by offset (0x1304 / 0x1308: 32-bit ints). */
  opt?: Record<string, number>;
  /** Articulator headers: [group, filter type, stages]. */
  hdr?: [number, number, number][];
  /** Articulator curves: [group, target, 'env' | 'lfo' | 'map0'..'map3', 'm' | 'p' | 'l', value]. */
  arts?: [number, number, string, 'm' | 'p' | 'l', number[] | number[][]][];
  /** Record fields of every region of deck A. */
  rg?: Partial<Record<keyof SxRegion, number>>;
  /** Deck B = a copy of deck A. */
  deckB?: boolean;
}

export interface SxCase {
  name: string;
  /** Test audio (see slicex-audio.ts). */
  audio: 'loop' | 'loop48' | 'ramp';
  /** KEY:VEL:START:DUR[:color=N][:modx=X][:mody=Y] in seconds. */
  notes: string;
  secs: number;
  patch?: SxPatch;
  /** Host parameter values by index, and automation [seconds, index, value]. */
  params?: Record<number, number>;
  auto?: [number, number, number][];
  interp?: InterpMode;
  rendering?: boolean;
  /** Output rate (default 44.1 kHz). */
  sr?: number;
}

export interface SxAudioSet {
  channels: Float32Array[];
  sampleRate: number;
  wav: Uint8Array;
  file: string;
}

/** FL's LogVol of a velocity (InitLevels.Vol). */
function flLogVol(x: number): number {
  const v = f32(x);
  if (v === 1) return 1;
  return f32((Math.exp(f32(v * f32(2.397895336151123))) - 1) * f32(0.1));
}

/** Apply a patch to a Slicex state (params by key, deckA / deckB, arts, opt). */
export function applyPatch(st: Record<string, unknown>, p: SxPatch | undefined): void {
  if (!p) return;
  if (p.opt) {
    const opt = st.opt as SxSettings;
    const raw = [...opt.raw];
    for (const [k, v] of Object.entries(p.opt)) {
      const o = Number(k) - 0x1304;
      if (o === 0 || o === 4) for (let i = 0; i < 4; i++) raw[o + i] = (v >>> (8 * i)) & 255;
      else raw[o] = v & 255;
    }
    st.opt = { ...settingsFromRaw(raw), lockAudio: opt.lockAudio };
  }
  const arts = structuredClone(st.arts) as SxArt[];
  for (const [g, ft, fo] of p.hdr ?? []) { arts[g].ft = ft; arts[g].fo = fo; }
  for (const [g, t, part, field, value] of p.arts ?? []) {
    const tg = arts[g].t[t];
    const c = part === 'env' ? tg.env : part === 'lfo' ? tg.lfo : tg.maps[Number(part.slice(3))];
    (c as unknown as Record<string, unknown>)[field] = structuredClone(value);
  }
  st.arts = arts;
  const a = st.deckA as SxDeck;
  if (p.rg) st.deckA = { ...a, regions: a.regions.map((r) => ({ ...r, ...p.rg })) };
  if (p.deckB) { st.deckB = structuredClone(st.deckA); st.sampleB = st.sampleA; }
}

/** The state FL has after loading the audio, with the case's patch and parameters. */
export function caseState(c: SxCase, au: SxAudioSet): Record<string, unknown> {
  const st: Record<string, unknown> = { ...Object.fromEntries(def.params.map((p) => [p.key, p.def])), ...def.state!() };
  st.deckA = sxLoadDeck({ channels: au.channels, sampleRate: au.sampleRate }, au.wav, au.file, 130);
  st.sampleA = 'A';
  applyPatch(st, c.patch);
  for (const [i, v] of Object.entries(c.params ?? {})) {
    const pd = def.params.find((q) => q.index === Number(i));
    if (pd) st[pd.key] = v;
  }
  return def.normalize!(st);
}

/** Render a case like FL's test host (44.1 kHz unless the case says, 130 BPM). */
export function renderCase(c: SxCase, au: SxAudioSet): { L: Float32Array; R: Float32Array } {
  const sr = c.sr ?? 44100, block = 512, tempo = 130;
  const g = gen.create(sr, block, { sample: (id) => (id === 'A' ? { channels: au.channels, sampleRate: au.sampleRate } : undefined) });
  if (c.interp) g.setInterpolation?.(c.interp);
  let params = caseState(c, au);
  g.setParams(params);
  const pre = Math.round(0.25 * sr), N = Math.round(c.secs * sr);
  const L = new Float32Array(N), R = new Float32Array(N);
  let nid = 0;
  const notes = c.notes.split(',').filter(Boolean).map((s) => {
    const parts = s.split(':');
    const [k, v, t0, d] = parts.slice(0, 4).map(Number);
    const opt: Record<string, number> = {};
    for (const q of parts.slice(4)) { const [x, y] = q.split('='); opt[x] = Number(y); }
    const lv = { pan: 0, vol: flLogVol(f32(v * f32(0.01))), pitch: (k - 60) * 100, fcut: f32(opt.modx ?? 0), fres: f32(opt.mody ?? 0) };
    const note = {
      id: ++nid, key: k, velocity: v, release: 64, color: opt.color ?? 0, length: Infinity, frame: 0,
      init: { ...lv, pitch: 6000 + (k - 60) * 100 }, levels: { ...lv },
    } as GenNote;
    return { on: pre + Math.round(t0 * sr), off: pre + Math.round((t0 + d) * sr), note };
  });
  const autos = (c.auto ?? []).map(([t, i, v]) => ({ at: pre + Math.round(t * sr), key: def.params.find((q) => q.index === i)?.key, v }));
  const times = [...new Set([...notes.flatMap((x) => [x.on, x.off]), ...autos.map((a) => a.at)])].sort((a, b) => a - b);
  const bl = new Float32Array(block), br = new Float32Array(block);
  for (let b0 = 0; b0 < pre + N;) {
    let n = Math.min(block, pre + N - b0);
    if (b0 < pre && b0 + n > pre) n = pre - b0;
    for (const t of times) if (t > b0 && t < b0 + n) { n = t - b0; break; }
    for (const a of autos) if (a.at === b0 && a.key) { params = { ...params, [a.key]: a.v }; g.setParams(params); }
    for (const x of notes) { if (x.off === b0) g.noteOff?.(x.note, 0); if (x.on === b0) g.noteOn!(x.note, 0); }
    bl.fill(0); br.fill(0);
    g.render!(bl, br, n, {
      sampleRate: sr, blockSize: block, tempo, ppq: 96, playing: b0 >= pre, pos: b0 >= pre ? ((b0 - pre) * 96 * tempo) / (60 * sr) : 0,
      songMode: false, track: 5, rendering: !!c.rendering,
    });
    if (b0 >= pre) { L.set(bl.subarray(0, n), b0 - pre); R.set(br.subarray(0, n), b0 - pre); }
    b0 += n;
  }
  return { L, R };
}

/** FNV-1a over the float32 bits of L / R interleaved. */
export function fnv(L: Float32Array, R: Float32Array): string {
  const u = new Uint32Array(1), fv = new Float32Array(u.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < L.length; i++) {
    for (const x of [L[i], R[i]]) {
      fv[0] = x;
      let w = u[0];
      for (let k = 0; k < 4; k++) { h ^= w & 255; h = Math.imul(h, 0x01000193) >>> 0; w >>>= 8; }
    }
  }
  return h.toString(16).padStart(8, '0');
}
