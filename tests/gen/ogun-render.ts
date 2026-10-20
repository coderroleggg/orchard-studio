// Renders Ogun the way FL Studio's test host (flfxhost render Ogun ...) does, for the golden cases of tests/gen/ogun.test.ts and the
// checks against FL: Gen_Render blocks of at most `block` frames split at the note on / off and automation times, TriggerVoice /
// Voice_Release between them, FL's levels (InitLevels.Vol = FL's velocity curve in single precision, Pitch = 100 key + fine, Pan, Mod X / Y)
// and a tempo event at the start. A velocity that the plugin applies itself (its "link velocity to volume" off) arrives as the
// channel's part of the volume only.
import { gen, type OgunInstance } from '../../src/engine/gen/plugins/ogun';
import { entryToState, ogunBank, OG_PRESET_NAMES } from '../../src/model/gen/plugins/ogun/state';
import { OGUN_PARAMS } from '../../src/model/gen/plugins/ogun/params';
import { noteVolume } from '../../src/engine/gen/levels';
import type { GenVoice, GenVoiceParams, GenContext } from '../../src/engine/gen/types';

export interface Note { key: number; vel: number; start: number; dur: number; pan?: number; fine?: number; modx?: number; mody?: number; rel?: number; color?: number }
export interface Case {
  name: string;
  /** Factory preset name (the bank is sorted by name; FL's file order differs). */
  preset: string;
  sr: number;
  block: number;
  bpm: number;
  notes: Note[];
  /** FL parameter index -> raw value, applied to the preset before the first note. */
  params: Record<string, number>;
  /** [seconds, FL parameter index, value]: parameter changes during the render. */
  at: [number, number, number][];
  maxPoly?: number;
  counter?: number;
  mode?: string;
  /** Rendered length in frames (the test host's length: last note off + tail). */
  frames: number;
}

const f32 = Math.fround;
const LN11F = f32(2.397895336151123);
/** FL's volume curve (FLEngine 0x3a68e0) of the host's InitLevels.Vol for a velocity. */
function flVol(vel: number): number {
  const x = f32(vel * f32(0.009999999776482582));
  return x === 1 ? 1 : f32((Math.exp(f32(x * LN11F)) - 1) * f32(0.1));
}

export function presetState(name: string): Record<string, unknown> {
  const i = OG_PRESET_NAMES.indexOf(name);
  if (i < 0) throw new Error('no preset ' + name);
  return entryToState(ogunBank()[i]) as Record<string, unknown>;
}

export function renderCase(c: Case): [Float32Array, Float32Array] {
  const st = presetState(c.preset);
  const setP = (s: Record<string, unknown>, i: number, v: number): void => { s[OGUN_PARAMS[i].key] = v; };
  for (const [i, v] of Object.entries(c.params)) setP(st, Number(i), v);
  const inst = gen.create(c.sr, c.block, { sample: () => undefined }) as OgunInstance;
  inst.setParams(structuredClone(st));
  if (c.counter !== undefined) inst.setRandomCounter(c.counter);
  if (c.maxPoly) inst.setMaxPoly(c.maxPoly);
  const total = c.frames;
  const L = new Float32Array(total), R = new Float32Array(total);
  const ctx: GenContext = { sampleRate: c.sr, blockSize: c.block, tempo: c.bpm, ppq: 96, playing: false, pos: 0, songMode: false, track: 0, rendering: c.mode === 'export' };
  const unlinked = (((st.xi as number[])[6] >> 16) & 255) === 0;
  const mk = (n: Note): GenVoiceParams => {
    const vol = unlinked ? noteVolume(n.vel) : flVol(n.vel);
    const pitch = 6000 + 100 * (n.key - 60) + (n.fine ?? 0);
    return {
      key: n.key, velocity: n.vel, release: (n.rel ?? 0.5) * 128, color: n.color ?? 0, length: Infinity, frame: 0,
      init: { pan: n.pan ?? 0, vol, pitch, fcut: n.modx ?? 0, fres: n.mody ?? 0 },
      levels: { pan: n.pan ?? 0, vol, pitch, fcut: n.modx ?? 0, fres: n.mody ?? 0 },
    };
  };
  type Ev = Note & { on: number; off: number; v: GenVoice | null; released: boolean; done: boolean; p: GenVoiceParams | null };
  const ev: Ev[] = c.notes.map((n) => ({ ...n, on: Math.round(n.start * c.sr), off: Math.round((n.start + n.dur) * c.sr), v: null, released: false, done: false, p: null }));
  const at = c.at.map(([t, i, v]) => ({ f: Math.round(t * c.sr), i, v, done: false }));
  const bl = new Float32Array(c.block), br = new Float32Array(c.block);
  let pos = 0;
  while (pos < total) {
    let n = Math.min(c.block, total - pos);
    for (const e of ev) {
      if (!e.v && e.on > pos && e.on < pos + n) n = e.on - pos;
      if (e.v && !e.released && e.off > pos && e.off < pos + n) n = e.off - pos;
    }
    for (const a of at) if (!a.done && a.f > pos && a.f < pos + n) n = a.f - pos;
    bl.fill(0); br.fill(0);
    for (const a of at) if (!a.done && a.f <= pos) { a.done = true; setP(st, a.i, a.v); inst.setParams(structuredClone(st)); }
    for (const e of ev) {
      if (!e.v && e.on <= pos) { e.p = mk(e); e.v = inst.triggerVoice(e.p, ctx); }
      if (e.v && !e.released && e.off <= pos) { e.v.release(); e.released = true; }
    }
    for (const e of ev) if (e.v && !e.done && e.p) { e.p.frame = 0; if (!e.v.render(bl, br, n)) e.done = true; }
    inst.render(bl, br, n, ctx);
    L.set(bl.subarray(0, n), pos); R.set(br.subarray(0, n), pos);
    pos += n;
  }
  return [L, R];
}

/** FNV-1a over the bytes of the interleaved float32 frames (the golden hash). */
export function hashFrames(L: Float32Array, R: Float32Array): number {
  const buf = new Float32Array(2 * L.length);
  for (let i = 0; i < L.length; i++) { buf[2 * i] = L[i]; buf[2 * i + 1] = R[i]; }
  const b = new Uint8Array(buf.buffer);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619) >>> 0;
  return h >>> 0;
}
