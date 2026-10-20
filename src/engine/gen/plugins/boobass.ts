// BooBass (FL: BooBass): FL's monophonic bass guitar engine, ported line by
// line from BooBass_Eng_x64.dylib (./boobass/core.ts; docs/research/gen/boobass.md).
//
// FL's plugin plays one string: a new note kills the sounding voice and
// re-strikes the string at that sample (filters and slew limiter carry on),
// Voice_Release starts an 18 ms fade, and FL calls Gen_Render once per audio
// block (pitch, panning and level ramps step per block, the voice ends at the
// end of the block in which its envelope finished). Here each channel control
// step (<= 16 samples) is one FL block. Because a later note can cut a voice
// inside a step the channel has already rendered, the voices only log their
// trigger / steps / release / kill with the levels of each step, and render()
// replays that log in time order once per channel block (output added there).
//
// Tables: FL's recordings when the user imported them (state `dataSample`, a
// sample pool id delivered through env.sample), else synthesized stand-ins.

import type { GenContext, GenEnv, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { PITCH_C5 } from '../levels';
import { BooCore, booRate, knob } from './boobass/core';
import { buildTables, unpackFlData, type BooTables } from './boobass/tables';
import { synthPcm } from './boobass/synth';

const MAX_VOICES = 128;
/** FL's Gen_Render block here: the channel's control step. */
const BLOCK = 16;
const LOG = 4096;
const E_TRIGGER = 0, E_RELEASE = 1, E_KILL = 2, E_CHUNK = 3;
const f = Math.fround;

let synthTables: BooTables | null = null;
function defaultTables(): BooTables {
  if (!synthTables) synthTables = buildTables(synthPcm());
  return synthTables;
}
/** Tables built from imported FL data, per pool buffer (shared by every BooBass of the engine). */
const imported = new WeakMap<Float32Array, BooTables | null>();

class BooVoice implements GenVoice {
  params: GenVoiceParams | null = null;
  /** Held by the channel (between triggerVoice and kill). */
  held = false;
  /** FL ended or replaced this voice: render() returns false from now on. */
  dead = false;
  constructor(readonly inst: BooBass, readonly index: number) {}

  render(L: Float32Array, R: Float32Array, n: number): boolean {
    void L; void R;
    if (this.dead || !this.params) return false;
    this.inst.log(E_CHUNK, this, n);
    return true;
  }

  /** Note off (FL's Voice_Release; FL's host also starts a new block at a note off whose voice already ended). */
  release(): void {
    if (this.params) this.inst.log(E_RELEASE, this, 0);
  }

  kill(): void {
    if (!this.held) return;
    if (!this.dead && this.params) this.inst.log(E_KILL, this, 0);
    this.held = false;
  }
}

class BooBass implements GenInstance {
  readonly tail = 0;
  private readonly sr: number;
  private readonly env: GenEnv;
  private readonly core: BooCore;
  private readonly voices: BooVoice[] = [];
  private next = 0;
  /** FL's current voice (BooBassPlug+0x388), null = none, and its levels of the step being replayed. */
  private cur: BooVoice | null = null;
  private pan = 0; private vol = 1; private pitch = 0;
  /** FL's block in progress (it may continue into the next engine block): planned length, samples done. */
  private inBlock = false;
  private blockLen = BLOCK;
  private blockDone = 0;
  /** A parameter changed since the last render(): FL's block ends there. */
  private paramCut = false;
  // the event log of the current channel block
  private count = 0;
  private seq = 0;
  private readonly eKind = new Int8Array(LOG);
  private readonly eFrame = new Int32Array(LOG);
  private readonly eLen = new Int32Array(LOG);
  private readonly eVoice = new Int16Array(LOG);
  private readonly ePan = new Float64Array(LOG);
  private readonly eVol = new Float64Array(LOG);
  private readonly ePitch = new Float64Array(LOG);
  private readonly eSeq = new Int32Array(LOG);
  private readonly order = new Int32Array(LOG);
  /** Steps whose levels differ from the voice's previous ones (FL: levels change between blocks: a new block starts). */
  private readonly eNew = new Uint8Array(LOG);
  private readonly mono: Float32Array;
  // parameters
  private bass = -1; private mid = -1; private treble = -1;
  /** Wanted FL data sample id ('' = synthesized) and the pool buffer the current tables come from. */
  private dataId = '';
  private dataBuf: Float32Array | null = null;

  constructor(sampleRate: number, env: GenEnv) {
    this.sr = sampleRate;
    this.env = env;
    this.core = new BooCore(booRate(sampleRate), defaultTables());
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new BooVoice(this, i));
    this.mono = new Float32Array(BLOCK);
    this.setParams({});
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const num = (k: string) => {
      const v = Number(q[k] ?? 32767);
      return Number.isFinite(v) ? Math.max(0, Math.min(65535, Math.round(v))) : 32767;
    };
    const b = num('bass'), m = num('mid'), t = num('treble');
    if (b !== this.bass) { this.bass = b; this.core.setBass(knob(b)); this.paramCut = true; }
    if (m !== this.mid) { this.mid = m; this.core.setMid(knob(m)); this.paramCut = true; }
    if (t !== this.treble) { this.treble = t; this.core.setTreble(knob(t)); this.paramCut = true; }
    this.dataId = typeof q.dataSample === 'string' ? q.dataSample : '';
    this.syncTables();
  }

  /** Use FL's imported recordings once the pool sample has arrived (else the synthesized tables). */
  private syncTables(): void {
    const s = this.dataId ? this.env.sample(this.dataId) : undefined;
    const buf = s?.channels[0] ?? null;
    if (buf === this.dataBuf) return;
    this.dataBuf = buf;
    let t: BooTables | null | undefined = null;
    if (buf) {
      t = imported.get(buf);
      if (t === undefined) {
        const pcm = unpackFlData(buf);
        t = pcm ? buildTables(pcm) : null;
        imported.set(buf, t);
      }
    }
    this.core.retable(booRate(this.sr), t ?? defaultTables());
  }

  /** Append an event of the current channel block (voices call it). */
  log(kind: number, v: BooVoice, n: number): void {
    const p = v.params!;
    if (this.count >= LOG) {
      if (kind === E_CHUNK) return;
      this.count = LOG - 1;
    }
    const i = this.count++;
    this.eKind[i] = kind;
    this.eFrame[i] = p.frame | 0;
    this.eLen[i] = n | 0;
    this.eVoice[i] = v.index;
    this.ePan[i] = f(p.levels.pan);
    this.eVol[i] = f(p.levels.vol);
    this.ePitch[i] = f(p.levels.pitch - PITCH_C5);
    this.eSeq[i] = this.seq++;
  }

  triggerVoice(params: GenVoiceParams): GenVoice | null {
    for (let k = 0; k < MAX_VOICES; k++) {
      const v = this.voices[(this.next + k) % MAX_VOICES];
      if (v.held) continue;
      this.next = (v.index + 1) % MAX_VOICES;
      v.params = params;
      v.held = true;
      v.dead = false;
      this.log(E_TRIGGER, v, 0);
      return v;
    }
    return null;
  }

  /** Sort key: frame, then voice events before steps, then arrival. */
  private before(a: number, b: number): boolean {
    const fa = this.eFrame[a], fb = this.eFrame[b];
    if (fa !== fb) return fa < fb;
    const ca = this.eKind[a] === E_CHUNK ? 1 : 0, cb = this.eKind[b] === E_CHUNK ? 1 : 0;
    if (ca !== cb) return ca < cb;
    return this.eSeq[a] < this.eSeq[b];
  }

  /** End the FL block in progress (FL kills the voice when its envelope ended in it). */
  private endBlock(): void {
    if (!this.inBlock) return;
    this.inBlock = false;
    if (!this.core.active) return;
    this.core.blockEnd();
    if (!this.core.active && this.cur) { this.cur.dead = true; this.cur = null; }
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (this.dataId && !this.dataBuf) this.syncTables();
    const core = this.core;
    core.hq = !!ctx.rendering;
    const cnt = this.count, ord = this.order;
    for (let i = 0; i < cnt; i++) {
      // insertion sort (the log is short and mostly ordered)
      let j = i;
      while (j > 0 && this.before(i, ord[j - 1])) { ord[j] = ord[j - 1]; j--; }
      ord[j] = i;
    }
    // level changes of the current voice (the test host sets channel levels between blocks)
    {
      let cur = this.cur ? this.cur.index : -1, pan = this.pan, vol = this.vol, pitch = this.pitch;
      for (let i = 0; i < cnt; i++) {
        const e = ord[i];
        this.eNew[e] = 0;
        if (this.eKind[e] === E_TRIGGER) { cur = this.eVoice[e]; pan = this.ePan[e]; vol = this.eVol[e]; pitch = this.ePitch[e]; }
        else if (this.eKind[e] === E_CHUNK && this.eVoice[e] === cur) {
          if (this.ePan[e] !== pan || this.eVol[e] !== vol || this.ePitch[e] !== pitch) this.eNew[e] = 1;
          pan = this.ePan[e]; vol = this.eVol[e]; pitch = this.ePitch[e];
        }
      }
    }
    // a parameter change between engine blocks ends FL's block (ProcessParam between Gen_Render calls)
    if (this.paramCut) { this.endBlock(); this.paramCut = false; }
    let k = 0, t = 0;
    while (t < n) {
      while (k < cnt && this.eFrame[ord[k]] <= t) {
        const e = ord[k++];
        const v = this.voices[this.eVoice[e]];
        const kind = this.eKind[e];
        if (kind === E_CHUNK) {
          if (v === this.cur) {
            if (this.eNew[e]) this.endBlock();
            this.pan = this.ePan[e]; this.vol = this.eVol[e]; this.pitch = this.ePitch[e];
          }
          continue;
        }
        // a note event ends FL's block: the next one starts here
        this.endBlock();
        if (kind === E_TRIGGER) {
          // TriggerVoice: FL kills the sounding voice and re-strikes the string
          if (this.cur && this.cur !== v) this.cur.dead = true;
          this.cur = v;
          this.pan = this.ePan[e]; this.vol = this.eVol[e]; this.pitch = this.ePitch[e];
          core.trigger(this.pan, this.vol, this.pitch);
        } else if (v === this.cur) {
          core.mute();
          if (kind === E_KILL) { core.active = false; v.dead = true; this.cur = null; }
        }
      }
      // the next note event in this engine block (none: FL's block may continue into the next engine block)
      let next = Infinity;
      for (let q = k; q < cnt; q++) { const e = ord[q]; if (this.eKind[e] !== E_CHUNK || this.eNew[e]) { next = this.eFrame[e]; break; } }
      if (!core.active) { t = next < n && next > t ? next : next <= t ? t + 1 : n; continue; }
      if (!this.inBlock) {
        // FL's next Gen_Render block: BLOCK samples or up to the next note event
        let len = BLOCK;
        if (next - t < len) len = next - t;
        if (len < 1) len = 1;
        this.blockLen = len;
        this.blockDone = 0;
        this.inBlock = true;
        core.blockBegin(len, this.pan, this.vol, this.pitch);
      }
      let m = this.blockLen - this.blockDone;
      if (m > n - t) m = n - t;
      if (m > next - t) m = next - t;
      if (m < 1) m = 1;
      core.blockPart(L, R, t, m, this.mono);
      this.blockDone += m;
      t += m;
      if (this.blockDone >= this.blockLen) this.endBlock();
    }
    this.count = 0;
  }

  isActive(): boolean {
    return this.core.active || this.count > 0;
  }

  allNotesOff(): void {
    if (this.cur) { this.cur.dead = true; this.cur = null; }
    this.core.active = false;
    this.count = 0;
    this.inBlock = false;
  }

  reset(): void {
    this.allNotesOff();
    for (const v of this.voices) { v.held = false; v.dead = false; v.params = null; }
  }

  monitor() {
    return { active: this.core.active, data: this.dataBuf ? 1 : 0 };
  }
}

export const gen: GenModule = {
  id: 'boobass',
  create: (sampleRate, _blockSize, env) => new BooBass(sampleRate, env),
};
