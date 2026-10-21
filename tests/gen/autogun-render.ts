// Renders Autogun the way FL Studio's test host (flfxhost render Autogun --state ...) does, for the golden cases of
// tests/gen/autogun.test.ts and the checks against FL: Gen_Render blocks of at most `block` frames split at the note on / off and
// automation times, TriggerVoice / Voice_Release between them, FL's levels (InitLevels.Vol = FL's velocity curve in single
// precision, Pitch = 100 key + fine, Pan, Mod X / Y) and a tempo event at the start (see tests/gen/ogun-render.ts, whose loop this is).
import { gen, type AutogunInstance } from '../../src/engine/gen/plugins/autogun';
import { ogunStateOf } from '../../src/model/gen/plugins/autogun/state';
import { noteVolume } from '../../src/engine/gen/levels';
import type { GenVoice, GenVoiceParams, GenContext } from '../../src/engine/gen/types';
import type { FxParams } from '../../src/model/fx/types';

export interface Note { key: number; vel: number; start: number; dur: number; pan?: number; fine?: number; modx?: number; mody?: number; rel?: number; color?: number }
export interface Case {
  name: string;
  /** The Autogun state: preset counter `n`, `level`, `dust`, `quality`. */
  state: { n: number; level?: number; dust?: number; quality?: number };
  sr: number;
  block: number;
  bpm: number;
  notes: Note[];
  /** [seconds, state key, value]: state changes during the render (the master level, the magic dust). */
  at?: [number, 'level' | 'dust' | 'quality', number][];
  maxPoly?: number;
  counter?: number;
  mode?: string;
  /** Checks: the Ogun state the engine plays instead of the generated patch (e.g. a state parsed from FL's own). */
  ogun?: FxParams;
  /** The velocity law of the host that made the reference: FL's (single precision, the default) or the double precision one of the tools' host3. */
  law?: 'fl' | 'double';
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

/** The plugin state of a case (a project's stored form). */
export function stateOf(c: Case): FxParams {
  return { level: c.state.level ?? 256, dust: c.state.dust ?? 430, n: c.state.n, quality: c.state.quality ?? 1 };
}

export function renderCase(c: Case): [Float32Array, Float32Array] {
  const st = stateOf(c);
  const inst = gen.create(c.sr, c.block, { sample: () => undefined }) as AutogunInstance;
  inst.setParams(structuredClone(st));
  if (c.ogun) inst.og.setParams(c.ogun);
  if (c.counter !== undefined) inst.setRandomCounter(c.counter);
  if (c.maxPoly) inst.setMaxPoly(c.maxPoly);
  const total = c.frames;
  const L = new Float32Array(total), R = new Float32Array(total);
  const ctx: GenContext = { sampleRate: c.sr, blockSize: c.block, tempo: c.bpm, ppq: 96, playing: false, pos: 0, songMode: false, track: 0, rendering: c.mode === 'export' };
  const unlinked = (((ogunStateOf(st).xi as number[])[6] >> 16) & 255) === 0;
  const mk = (n: Note): GenVoiceParams => {
    const vol = unlinked || c.law === 'double' ? noteVolume(n.vel) : flVol(n.vel);
    const pitch = 6000 + 100 * (n.key - 60) + (n.fine ?? 0);
    return {
      key: n.key, velocity: n.vel, release: (n.rel ?? 0.5) * 128, color: n.color ?? 0, length: Infinity, frame: 0,
      init: { pan: n.pan ?? 0, vol, pitch, fcut: n.modx ?? 0, fres: n.mody ?? 0 },
      levels: { pan: n.pan ?? 0, vol, pitch, fcut: n.modx ?? 0, fres: n.mody ?? 0 },
    };
  };
  type Ev = Note & { on: number; off: number; v: GenVoice | null; released: boolean; done: boolean; p: GenVoiceParams | null };
  const ev: Ev[] = c.notes.map((n) => ({ ...n, on: Math.round(n.start * c.sr), off: Math.round((n.start + n.dur) * c.sr), v: null, released: false, done: false, p: null }));
  const at = (c.at ?? []).map(([t, k, v]) => ({ f: Math.round(t * c.sr), k, v, done: false }));
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
    for (const a of at) if (!a.done && a.f <= pos) { a.done = true; st[a.k] = a.v; inst.setParams(structuredClone(st)); }
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
