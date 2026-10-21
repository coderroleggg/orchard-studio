// FL Keys (FL: FL Keys): FL's wavetable piano / e-piano / organ, an mda Piano / ePiano derived engine
// (./flkeys/core.ts, docs/research/gen/flkeys.md). FL's Gen_Render mixes all voices (one record per note: wave
// position, decay envelope, muffling filter, pan gains) and then runs the summed block through a treble
// boost, tremolo / autopan and the stereo comb. Here every voice renders its own control step into the
// channel's voice mix (`levels: 'plugin'`: the voice applies FinalLevels.Vol^velocity sensitivity and the pan
// law itself), and `render()` runs FL's closing stage on the steps in which at least one voice sounded (FL
// skips Gen_Render when its voice list is empty, so the filters, the LFO and the comb freeze while silent).
//
// Wavetables: the user's imported FL data (a pool sample per wavetable, state keys `sample...`) or a
// synthesized stand-in of the same layout (./flkeys/synth.ts).

import type { GenContext, GenEnv, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { KeysEngine, KeysVoice } from './flkeys/core';
import { keysEntry, KEYS_PARAM_KEYS } from './flkeys/catalog';
import { resampleKeysTable, unpackKeysTable, type KeysTable } from './flkeys/table';
import { synthTable } from './flkeys/synth';

const MAX_VOICES = 128;

/** Tables unpacked from pool buffers (shared by every FL Keys of the engine; null = not a valid pack). */
const imported = new WeakMap<Float32Array, KeysTable | null>();
/** Tables converted to an engine's sample rate (FL's `resample`), per source table. */
const converted = new WeakMap<KeysTable, Map<number, KeysTable>>();

class Handle implements GenVoice {
  constructor(private readonly inst: FlKeys, readonly v: KeysVoice) {}
  render(L: Float32Array, R: Float32Array, n: number): boolean {
    const v = this.v;
    if (!v.held || !v.params) return false;
    this.inst.mark(v.params.frame | 0, n);
    return this.inst.engine.renderVoice(v, L, R, n);
  }
  release(): void {
    if (this.v.held) this.inst.engine.release(this.v);
  }
  kill(): void {
    this.inst.drop(this.v);
  }
}

class FlKeys implements GenInstance {
  readonly tail = 0;
  readonly engine: KeysEngine;
  private readonly env: GenEnv;
  private readonly voices: KeysVoice[] = [];
  private readonly handles: Handle[] = [];
  private next = 0;
  /** Frames of the channel block in which a voice rendered (FL ran Gen_Render there). */
  private mk: Uint8Array;
  private marked = false;
  private tableName = '';
  private sampleId = '';
  private sampleBuf: Float32Array | null = null;
  private table: KeysTable | null = null;

  constructor(sampleRate: number, blockSize: number, env: GenEnv) {
    this.env = env;
    this.engine = new KeysEngine(sampleRate);
    this.mk = new Uint8Array(Math.max(blockSize, 512));
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = new KeysVoice(i);
      this.voices.push(v);
      this.handles.push(new Handle(this, v));
    }
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const vals = new Array<number>(15);
    for (let i = 0; i < 15; i++) vals[i] = Number(q[KEYS_PARAM_KEYS[i]] ?? 0);
    this.engine.setParams(vals);
    const e = keysEntry(q.wavetable);
    const id = typeof q[e.key] === 'string' ? (q[e.key] as string) : '';
    this.select(e.name, id);
  }

  /** The wavetable named in the state: the imported pool pack when it has arrived, else the synthesized stand-in. */
  private select(name: string, id: string): void {
    const s = id ? this.env.sample(id) : undefined;
    const buf = s?.channels[0] ?? null;
    if (name === this.tableName && id === this.sampleId && buf === this.sampleBuf && this.table) return;
    let t: KeysTable | null = null;
    if (buf) {
      t = imported.get(buf) ?? null;
      if (t === null && !imported.has(buf)) { t = unpackKeysTable(buf); imported.set(buf, t); }
    }
    if (!t) t = synthTable(name);
    if (t.resample && Math.abs(this.engine.sr - t.fileRate) > 0.5) {
      let m = converted.get(t);
      if (!m) converted.set(t, (m = new Map()));
      let c = m.get(this.engine.sr);
      if (!c) m.set(this.engine.sr, (c = resampleKeysTable(t, this.engine.sr)));
      t = c;
    }
    const changed = t !== this.table;
    this.tableName = name; this.sampleId = id; this.sampleBuf = buf;
    this.table = t;
    this.engine.setTable(t);
    if (changed) for (const v of this.engine.list) v.done = true;
  }

  /** A voice rendered frames [from, from + n) of the channel block. */
  mark(from: number, n: number): void {
    const end = from + n;
    if (end > this.mk.length) { const m = new Uint8Array(end + 256); m.set(this.mk); this.mk = m; }
    this.mk.fill(1, from, end);
    this.marked = true;
  }

  triggerVoice(params: GenVoiceParams): GenVoice | null {
    // a pool sample may have arrived since the last parameter change
    if (this.sampleId && !this.sampleBuf) this.select(this.tableName, this.sampleId);
    for (let k = 0; k < MAX_VOICES; k++) {
      const v = this.voices[(this.next + k) % MAX_VOICES];
      if (v.held) continue;
      if (!this.engine.trigger(v, params)) return null;
      this.next = (v.index + 1) % MAX_VOICES;
      v.held = true;
      return this.handles[v.index];
    }
    return null;
  }

  /** The channel dropped a voice (FL's Voice_Kill: the voice leaves FL's list). */
  drop(v: KeysVoice): void {
    if (!v.held) return;
    const i = this.engine.list.indexOf(v);
    if (i >= 0) this.engine.list.splice(i, 1);
    v.held = false;
    v.done = true;
    v.params = null;
  }

  render(L: Float32Array, R: Float32Array, n: number, _ctx: GenContext): void {
    if (!this.marked) return;
    const mk = this.mk;
    let i = 0;
    while (i < n) {
      if (!mk[i]) { i++; continue; }
      let j = i;
      while (j < n && mk[j]) j++;
      this.engine.post(L, R, i, j);
      i = j;
    }
    mk.fill(0, 0, n);
    this.marked = false;
  }

  isActive(): boolean {
    return this.engine.list.length > 0;
  }

  allNotesOff(): void {
    this.mk.fill(0);
    this.marked = false;
  }

  setMaxPoly(n: number): void {
    this.engine.poly = n | 0;
  }

  reset(): void {
    for (const v of this.voices) { v.held = false; v.done = true; v.params = null; }
    this.engine.reset();
    this.mk.fill(0);
    this.marked = false;
  }

  monitor() {
    const keys: number[] = [];
    for (const v of this.engine.list) if (!v.done) keys.push(v.key);
    return { keys, table: this.tableName, data: this.sampleBuf ? 1 : 0 };
  }
}

export const gen: GenModule = {
  id: 'flkeys',
  create: (sampleRate, blockSize, env) => new FlKeys(sampleRate, blockSize, env),
};
