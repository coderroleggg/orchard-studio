// Plucked! (FL: Plucked!): FL's Karplus-Strong string, ported line by line
// from Plucked!_x64.dylib (./plucked/core.ts; docs/research/gen/plucked.md).
//
// FL renders all voices in one Gen_Render call per audio block, newest voice
// first, each adding into the block with FL's AddWave ramp; levels are read
// per block; a voice ends at the end of the block in which its peak window
// fell below 0.004 (or its release ramp reached 0). To reproduce that order
// and block structure exactly, the channel's voices only log their trigger,
// release, kill and per-step levels, and render() replays the log in FL's
// block grid: blocks of 16 samples (the channel's control step), restarted at
// every note event and parameter change, all voices in FL's order.
//
// The excitation noise comes from FPC's Random, one stream per engine seeded
// from the clock like FL's (./plucked/fpcrandom.ts). With a channel sample
// (state `sample`, a pool id), its 16384-point shape replaces the square wave
// (FL's FPF_GetChanCustomShape).

import type { GenContext, GenEnv, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { PITCH_C5 } from '../levels';
import { PluckVoice, type PluckParams } from './plucked/core';

export { resetFpcRandom as pluckedSeed } from './plucked/fpcrandom';

const MAX_VOICES = 128;
const BLOCK = 16;
const LOG = 4096;
const E_TRIGGER = 0, E_RELEASE = 1, E_KILL = 2, E_CHUNK = 3;
const SHAPE = 16384;
const f = Math.fround;

/** The channel sample as FL's 16384-point custom shape (mono mix, linear resampling of the whole sample; as 3x Osc). */
const shapes = new WeakMap<Float32Array, Float32Array | null>();
function customShape(chs: Float32Array[]): Float32Array | null {
  const len = chs[0]?.length ?? 0;
  if (len < 1) return null;
  const out = new Float32Array(SHAPE);
  const nc = chs.length;
  const at = (i: number) => { let s = 0; for (let c = 0; c < nc; c++) s += chs[c][i]; return s / nc; };
  for (let i = 0; i < SHAPE; i++) {
    const x = (i * len) / SHAPE;
    const i0 = Math.floor(x), fr = x - i0;
    const a = at(Math.min(len - 1, i0)), b = at(Math.min(len - 1, i0 + 1));
    out[i] = a + (b - a) * fr;
  }
  return out;
}

class Slot implements GenVoice {
  params: GenVoiceParams | null = null;
  held = false;
  /** FL removed the voice (ended or killed): render() reports the end. */
  dead = false;
  /** In FL's voice list. */
  live = false;
  readonly v: PluckVoice;
  /** Levels of the step being replayed (pitch and Mod Y only mark level changes: FL reads them at the trigger). */
  pan = 0; vol = 1; fcut = 0; pitch = 0; fres = 0;
  /** Trigger order (FL's host voice order). */
  order = 0;
  constructor(readonly inst: Plucked, readonly index: number, maxLen: number) {
    this.v = new PluckVoice(maxLen);
  }

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

class Plucked implements GenInstance {
  readonly tail = 0;
  private readonly sr: number;
  private readonly env: GenEnv;
  private readonly slots: Slot[] = [];
  private next = 0;
  /** FL's voice list (TList at +0x150): slot indices, oldest first. */
  private readonly list = new Int16Array(MAX_VOICES);
  private live = 0;
  private readonly p: PluckParams = { decay: 128, color: 64, norm: 1, gate: 0, widen: 1 };
  /** Decay changed since the last block (+0x158); a parameter changed since the last render() (restarts FL's block). */
  private decayChanged = false;
  private decayPending = false;
  private triggers = 0;
  private paramCut = false;
  /** FL's block in progress (it may continue into the next engine block): planned length, samples done. */
  private inBlock = false;
  private blockLen = BLOCK;
  private blockDone = 0;
  private sampleId = '';
  private sampleBuf: Float32Array | null = null;
  private shape: Float32Array | null = null;
  private readonly tmp = new Float32Array(2 * BLOCK);
  // event log of the current channel block
  private count = 0;
  private seq = 0;
  private readonly eKind = new Int8Array(LOG);
  private readonly eFrame = new Int32Array(LOG);
  private readonly eLen = new Int32Array(LOG);
  private readonly eSlot = new Int16Array(LOG);
  private readonly ePan = new Float64Array(LOG);
  private readonly eVol = new Float64Array(LOG);
  private readonly ePitch = new Float64Array(LOG);
  private readonly eCut = new Float64Array(LOG);
  private readonly eRes = new Float64Array(LOG);
  private readonly eSeq = new Int32Array(LOG);
  private readonly order = new Int32Array(LOG);
  /** Steps whose levels differ from the voice's previous ones (a new FL block starts there). */
  private readonly eNew = new Uint8Array(LOG);
  private readonly tPan = new Float64Array(MAX_VOICES);
  private readonly tVol = new Float64Array(MAX_VOICES);
  private readonly tCut = new Float64Array(MAX_VOICES);
  private readonly tPitch = new Float64Array(MAX_VOICES);
  private readonly tRes = new Float64Array(MAX_VOICES);

  constructor(sampleRate: number, env: GenEnv) {
    this.sr = sampleRate;
    this.env = env;
    // the longest line: the lowest folded pitch, about 30.9 Hz
    const maxLen = Math.ceil(sampleRate / 30) + 2;
    for (let i = 0; i < MAX_VOICES; i++) this.slots.push(new Slot(this, i, maxLen));
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(0, Math.min(hi, Math.round(v))) : d;
    };
    const p = this.p;
    const decay = num('decay', 128, 256), color = num('color', 64, 128);
    const norm = num('norm', 1, 1), gate = num('gate', 0, 1), widen = num('widen', 1, 1);
    if (decay !== p.decay) this.decayPending = true;
    if (decay !== p.decay || color !== p.color || norm !== p.norm || gate !== p.gate || widen !== p.widen) this.paramCut = true;
    p.decay = decay; p.color = color; p.norm = norm; p.gate = gate; p.widen = widen;
    this.sampleId = typeof q.sample === 'string' ? q.sample : '';
    this.syncShape();
  }

  private syncShape(): void {
    const s = this.sampleId ? this.env.sample(this.sampleId) : undefined;
    const buf = s?.channels[0] ?? null;
    if (buf === this.sampleBuf) return;
    this.sampleBuf = buf;
    if (!buf || !s) { this.shape = null; return; }
    let sh = shapes.get(buf);
    if (sh === undefined) { sh = customShape(s.channels); shapes.set(buf, sh); }
    this.shape = sh;
  }

  log(kind: number, v: Slot, n: number): void {
    const p = v.params!;
    if (this.count >= LOG) {
      if (kind === E_CHUNK) return;
      this.count = LOG - 1;
    }
    const i = this.count++;
    this.eKind[i] = kind;
    this.eFrame[i] = p.frame | 0;
    this.eLen[i] = n | 0;
    this.eSlot[i] = v.index;
    this.ePan[i] = f(p.levels.pan);
    this.eVol[i] = f(p.levels.vol);
    this.ePitch[i] = f(p.levels.pitch - PITCH_C5);
    this.eCut[i] = f(p.levels.fcut);
    this.eRes[i] = f(p.levels.fres);
    this.eSeq[i] = this.seq++;
  }

  triggerVoice(params: GenVoiceParams): GenVoice | null {
    for (let k = 0; k < MAX_VOICES; k++) {
      const s = this.slots[(this.next + k) % MAX_VOICES];
      if (s.held || s.live) continue;
      this.next = (s.index + 1) % MAX_VOICES;
      s.params = params;
      s.held = true;
      s.dead = false;
      this.log(E_TRIGGER, s, 0);
      return s;
    }
    return null;
  }

  private before(a: number, b: number): boolean {
    const fa = this.eFrame[a], fb = this.eFrame[b];
    if (fa !== fb) return fa < fb;
    const ca = this.eKind[a] === E_CHUNK ? 1 : 0, cb = this.eKind[b] === E_CHUNK ? 1 : 0;
    if (ca !== cb) return ca < cb;
    return this.eSeq[a] < this.eSeq[b];
  }

  /** Voice_Kill: FL's list removes an item by moving the last one into its place (unordered delete, 0x13d020). */
  private remove(s: Slot): void {
    const l = this.list;
    for (let i = 0; i < this.live; i++) {
      if (l[i] !== s.index) continue;
      this.live--;
      if (this.live > i) l[i] = l[this.live];
      break;
    }
    s.live = false;
    s.dead = true;
  }

  /** End the FL block in progress after `done` samples: the voices' end checks, ended voices leave FL's list. */
  private endBlock(): void {
    if (!this.inBlock) return;
    const done = this.blockDone;
    for (let i = this.live - 1; i >= 0; i--) this.slots[this.list[i]].v.end(done);
    // FL's host kills the ended voices after Gen_Render in its note order (oldest first); each kill reorders FL's list
    for (;;) {
      let pick: Slot | null = null;
      for (let i = 0; i < this.live; i++) {
        const s = this.slots[this.list[i]];
        if (!s.v.alive && (!pick || s.order < pick.order)) pick = s;
      }
      if (!pick) break;
      this.remove(pick);
    }
    this.decayChanged = false;
    this.inBlock = false;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    void ctx;
    if (this.sampleId && !this.sampleBuf) this.syncShape();
    const cnt = this.count, ord = this.order;
    for (let i = 0; i < cnt; i++) {
      let j = i;
      while (j > 0 && this.before(i, ord[j - 1])) { ord[j] = ord[j - 1]; j--; }
      ord[j] = i;
    }
    // level changes of sounding voices (the test host sets channel levels between blocks)
    for (let i = 0; i < MAX_VOICES; i++) {
      const s = this.slots[i];
      this.tPan[i] = s.pan; this.tVol[i] = s.vol; this.tCut[i] = s.fcut; this.tPitch[i] = s.pitch; this.tRes[i] = s.fres;
    }
    for (let i = 0; i < cnt; i++) {
      const e = ord[i], v = this.eSlot[e];
      this.eNew[e] = 0;
      const kind = this.eKind[e];
      if (kind !== E_TRIGGER && kind !== E_CHUNK) continue;
      if (kind === E_CHUNK && this.slots[v].live && (this.ePan[e] !== this.tPan[v] || this.eVol[e] !== this.tVol[v] || this.eCut[e] !== this.tCut[v]
        || this.ePitch[e] !== this.tPitch[v] || this.eRes[e] !== this.tRes[v])) this.eNew[e] = 1;
      this.tPan[v] = this.ePan[e]; this.tVol[v] = this.eVol[e]; this.tCut[v] = this.eCut[e]; this.tPitch[v] = this.ePitch[e]; this.tRes[v] = this.eRes[e];
    }
    // a parameter change between engine blocks ends FL's block (FL: ProcessParam between Gen_Render calls),
    // and a Decay change makes the voices recompute their decay in the next one
    if (this.paramCut) { this.endBlock(); this.paramCut = false; }
    if (this.decayPending) { this.decayChanged = true; this.decayPending = false; }
    let k = 0, t = 0;
    while (t < n) {
      while (k < cnt && this.eFrame[ord[k]] <= t) {
        const e = ord[k++];
        const s = this.slots[this.eSlot[e]];
        const kind = this.eKind[e];
        if (kind === E_CHUNK) {
          if (this.eNew[e]) this.endBlock();
          s.pan = this.ePan[e]; s.vol = this.eVol[e]; s.fcut = this.eCut[e]; s.pitch = this.ePitch[e]; s.fres = this.eRes[e];
          continue;
        }
        // a note event ends FL's block: the next one starts here
        this.endBlock();
        if (kind === E_TRIGGER) {
          if (s.v.start(this.ePitch[e], this.eCut[e], this.eRes[e], this.p, this.sr, this.shape)) {
            s.live = true;
            s.order = ++this.triggers;
            s.pan = this.ePan[e]; s.vol = this.eVol[e]; s.fcut = this.eCut[e]; s.pitch = this.ePitch[e]; s.fres = this.eRes[e];
            this.list[this.live++] = s.index;
          } else s.dead = true;
        } else if (kind === E_RELEASE) {
          if (s.live && this.p.gate > 0) s.v.released = true;
        } else if (s.live) this.remove(s);
      }
      if (!this.inBlock) {
        // FL's next Gen_Render block: BLOCK samples or up to the next note event
        let len = BLOCK;
        for (let q = k; q < cnt; q++) {
          const e = ord[q];
          if (this.eKind[e] !== E_CHUNK || this.eNew[e]) { if (this.eFrame[e] - t < len) len = this.eFrame[e] - t; break; }
        }
        if (len < 1) len = 1;
        this.blockLen = len;
        this.blockDone = 0;
        this.inBlock = true;
        for (let i = this.live - 1; i >= 0; i--) {
          const s = this.slots[this.list[i]];
          s.v.begin(len, s.pan, s.vol, s.fcut, this.decayChanged, this.p, this.sr);
        }
      }
      // the block's part inside this engine block (newest voice first, as FL)
      let m = this.blockLen - this.blockDone;
      if (m > n - t) m = n - t;
      for (let q = k; q < cnt; q++) {
        const e = ord[q];
        if (this.eKind[e] !== E_CHUNK || this.eNew[e]) { if (this.eFrame[e] - t < m) m = this.eFrame[e] - t; break; }
      }
      if (m < 1) m = 1;
      for (let i = this.live - 1; i >= 0; i--) this.slots[this.list[i]].v.part(L, R, t, m, this.tmp);
      this.blockDone += m;
      t += m;
      if (this.blockDone >= this.blockLen) this.endBlock();
    }
    this.count = 0;
  }

  isActive(): boolean {
    return this.live > 0 || this.count > 0;
  }

  allNotesOff(): void {
    for (let i = 0; i < this.live; i++) { const s = this.slots[this.list[i]]; s.live = false; s.dead = true; }
    this.live = 0;
    this.count = 0;
    this.inBlock = false;
  }

  reset(): void {
    this.allNotesOff();
    for (const s of this.slots) { s.held = false; s.dead = false; s.params = null; }
    this.inBlock = false;
  }

  monitor() {
    return { voices: this.live };
  }
}

export const gen: GenModule = {
  id: 'plucked',
  create: (sampleRate, _blockSize, env) => new Plucked(sampleRate, env),
};
