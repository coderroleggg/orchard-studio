// Keyboard Controller DSP, after FL's Fruity Keyboard Controller
// (docs/research/gen/keyboardctrl.md). Measured against the real plugin in the
// test host (every statement below is observed behaviour):
//
// - Notes arrive as voices. A note outside the key range lo..hi is refused at
//   once (FL kills the voice in TriggerVoice); an accepted one joins the list
//   of held keys. The target of the two outputs is the LAST held key: Note =
//   its value from the key table, Velocity = velocity / 128 x 65512 / 65536.
//   Releasing the newest key returns to the one pressed before it (value and
//   velocity); releasing the last key sends the note off value to Note when
//   "Note off value" (auto release) is on, and changes nothing otherwise;
//   Velocity keeps its value.
// - FL runs the controller once per song tick (NewTick, PPQ ticks per beat at
//   the current tempo, also while stopped) and, once a key has been played,
//   moves each output toward its target every tick with the smoothing
//   envelope: a one-pole step of 1 - 0.01^(tick time / T), T = the attack time
//   when the target is above the output and the release time otherwise (0 =
//   no smoothing), i.e. T is the time to settle to 1%. The very first key
//   sets the outputs, at the next tick, without smoothing. Before any key
//   nothing is sent (a linked control keeps its position: controls() reports
//   NaN).
// - A tick sees the notes triggered up to its own sample (the test host runs a
//   tick's notes before its NewTick); the song's note positions are rounded to
//   samples while ticks are floored, so notes up to one sample after a tick
//   belong to it as well.

import type { GenContext, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { KB_KEYS, KB_VEL_SCALE, kbSmoothMs, kbValueOf } from '../../../model/gen/plugins/keyboardctrl';

const MAX_VOICES = 128;
const MAX_EVENTS = 2 * MAX_VOICES + 16;

class KbVoice implements GenVoice {
  held = false;
  free = true;
  serial = 0;
  params: GenVoiceParams | null = null;

  constructor(private readonly kb: KeyboardController) {}

  /** The voice lives while its key is held; the controller makes no sound. */
  render(): boolean {
    return this.held;
  }

  release(): void {
    this.kb.keyUp(this);
  }

  kill(): void {
    this.kb.keyUp(this);
    this.free = true;
    this.params = null;
  }
}

class KeyboardController implements GenInstance {
  /** A controller runs all the time. */
  readonly tail = Infinity;
  private readonly sr: number;
  // state (the plugin's parameters)
  private readonly values = new Float64Array(KB_KEYS);
  private lo = 48;
  private hi = 71;
  private noteOffValue = 0;
  private autoRel = false;
  private attackMs = 0;
  private releaseMs = 0;
  // voices and the held-key stack (oldest first)
  private readonly voices: KbVoice[] = [];
  private serial = 0;
  private readonly stSerial = new Int32Array(MAX_VOICES + 1);
  private readonly stKey = new Int32Array(MAX_VOICES + 1);
  private readonly stVel = new Float64Array(MAX_VOICES + 1);
  private nSt = 0;
  // events of the current block, applied in time order by render()
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evOn = new Uint8Array(MAX_EVENTS);
  private readonly evSerial = new Int32Array(MAX_EVENTS);
  private readonly evKey = new Int32Array(MAX_EVENTS);
  private readonly evVel = new Float64Array(MAX_EVENTS);
  private readonly order = new Int32Array(MAX_EVENTS);
  private nEv = 0;
  // outputs
  private readonly out = new Float64Array(2).fill(NaN);
  private tgtNote = 0;
  private tgtVel = 0;
  /** A key has been played: the outputs follow the targets. */
  private hasValue = false;
  /** The first key's value goes out at the next tick. */
  private firstPending = false;
  // tick clock (free running while the song does not play)
  private tickLeft = 0;

  constructor(sr: number) {
    this.sr = sr;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new KbVoice(this));
    this.setParams({});
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
    };
    this.attackMs = kbSmoothMs(num('attack', 0, 0, 256));
    this.releaseMs = kbSmoothMs(num('release', 0, 0, 256));
    const v = Array.isArray(q.values) ? (q.values as number[]) : [];
    for (let k = 0; k < KB_KEYS; k++) this.values[k] = kbValueOf(v, k);
    this.lo = num('lo', 48, 0, 256);
    this.hi = num('hi', 71, 0, 256);
    this.noteOffValue = num('noteOff', 0, 0, 1);
    this.autoRel = !!q.autoRel;
    // edited key values move the target of a held key at once
    if (this.nSt > 0) this.tgtNote = this.values[this.stKey[this.nSt - 1]];
  }

  triggerVoice(p: GenVoiceParams): GenVoice | null {
    const key = Math.round(p.key);
    if (key < this.lo || key > this.hi || key < 0 || key >= KB_KEYS) return null;
    let v: KbVoice | null = null;
    for (const c of this.voices) if (c.free) { v = c; break; }
    if (!v) return null;
    v.free = false;
    v.held = true;
    v.serial = ++this.serial;
    v.params = p;
    this.push(true, v.serial, key, p.velocity, p.frame);
    return v;
  }

  /** A held key ends (release or kill of its voice). */
  keyUp(v: KbVoice): void {
    if (!v.held) return;
    v.held = false;
    this.push(false, v.serial, 0, 0, (v.params ? v.params.frame : 0));
  }

  private push(on: boolean, serial: number, key: number, vel: number, frame: number): void {
    if (this.nEv >= MAX_EVENTS) { this.apply(on, serial, key, vel); return; }
    const i = this.nEv++;
    this.evFrame[i] = Math.max(0, Math.floor(frame));
    this.evOn[i] = on ? 1 : 0;
    this.evSerial[i] = serial;
    this.evKey[i] = key;
    this.evVel[i] = vel;
  }

  /** A key goes down or up: update the held-key stack and the targets. */
  private apply(on: boolean, serial: number, key: number, vel: number): void {
    if (on) {
      if (this.nSt < this.stSerial.length) {
        this.stSerial[this.nSt] = serial; this.stKey[this.nSt] = key; this.stVel[this.nSt] = vel;
        this.nSt++;
      }
    } else {
      let i = this.nSt - 1;
      while (i >= 0 && this.stSerial[i] !== serial) i--;
      if (i < 0) return;
      for (let k = i; k < this.nSt - 1; k++) {
        this.stSerial[k] = this.stSerial[k + 1]; this.stKey[k] = this.stKey[k + 1]; this.stVel[k] = this.stVel[k + 1];
      }
      this.nSt--;
    }
    if (this.nSt > 0) {
      // the last held key is the target
      const t = this.nSt - 1;
      this.tgtNote = this.values[this.stKey[t]];
      this.tgtVel = (Math.max(0, this.stVel[t]) / 128) * KB_VEL_SCALE;
      if (!this.hasValue) { this.hasValue = true; this.firstPending = true; }
    } else if (!on && this.autoRel) this.tgtNote = this.noteOffValue;
  }

  private tick(dtMs: number): void {
    if (!this.hasValue) return;
    if (this.firstPending) {
      // the first key's value is sent at this tick without smoothing
      this.firstPending = false;
      this.out[0] = this.tgtNote;
      this.out[1] = this.tgtVel;
      return;
    }
    for (let i = 0; i < 2; i++) {
      const tgt = i === 0 ? this.tgtNote : this.tgtVel;
      const cur = this.out[i];
      const T = tgt > cur ? this.attackMs : this.releaseMs;
      this.out[i] = T > 0 ? cur + (tgt - cur) * (1 - Math.pow(0.01, dtMs / T)) : tgt;
    }
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    void L; void R;
    const tempo = ctx.tempo > 0 ? ctx.tempo : 120;
    const ppq = ctx.ppq > 0 ? ctx.ppq : 96;
    const spt = (this.sr * 60) / (tempo * ppq);
    const dtMs = (spt / this.sr) * 1000;
    // tick boundaries of this block: aligned to the song's ticks while it plays
    let t: number;
    if (ctx.playing) {
      const frac = ctx.pos - Math.floor(ctx.pos + 1e-9);
      t = frac > 1e-7 ? (1 - frac) * spt : 0;
    } else t = this.tickLeft;
    // events in time order (stable insertion sort: blocks hold few of them)
    const ne = this.nEv;
    const order = this.order;
    for (let i = 0; i < ne; i++) {
      let j = i;
      while (j > 0 && this.evFrame[order[j - 1]] > this.evFrame[i]) { order[j] = order[j - 1]; j--; }
      order[j] = i;
    }
    let e = 0;
    // a tick sits at floor(position): the epsilon keeps a tick that falls exactly on a block boundary
    // (float error of the position) in the block that starts there
    for (let f = Math.floor(t + 1e-6); f < n; f = Math.floor(t + 1e-6)) {
      while (e < ne && this.evFrame[order[e]] <= f + 1) { const i = order[e++]; this.apply(!!this.evOn[i], this.evSerial[i], this.evKey[i], this.evVel[i]); }
      this.tick(dtMs);
      t += spt;
    }
    while (e < ne) { const i = order[e++]; this.apply(!!this.evOn[i], this.evSerial[i], this.evKey[i], this.evVel[i]); }
    this.nEv = 0;
    this.tickLeft = t - n;
  }

  controls(): ArrayLike<number> {
    return this.out;
  }

  allNotesOff(): void {
    this.nSt = 0;
  }

  reset(): void {
    this.nSt = 0;
    this.nEv = 0;
    for (const v of this.voices) { v.held = false; v.free = true; v.params = null; }
  }
}

export const gen: GenModule = {
  id: 'keyboardctrl',
  create: (sampleRate) => new KeyboardController(sampleRate),
};
