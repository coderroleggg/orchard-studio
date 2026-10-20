// Transistor Bass plugin core: FL's plugin layer around the TB-303 engines,
// decoded from FL 2026's engine library (FL wrapper + "MyPlugin"):
// - notes: every note is a voice of FL's wrapper; a note on the same key and
//   colour first releases the old one; colour 12 (MIDI channel 13) only sets
//   the sequence transpose (key - 60); velocity = 127 ln(10 InitVol + 1) /
//   ln 21; notes reach a mono note counter: a note while another is held
//   slides, the gate closes when the last note is released; accent at
//   velocity >= 110 (110/127) or on accented sequencer steps;
// - per block, the voices' FinalLevels feed the engine: Mod X -> cutoff, Mod Y
//   -> resonance (V1 only), pitch offset (cents beyond the key) -> pitch, pan
//   -> sqrt pan gains;
// - parameters: switches apply at once, the others through FL's 16-sample
//   smoother (TbSmoother);
// - signal: engine x pan gains -> delay (when on) x channel volume (FL's
//   FPE_MIDI_Vol, an integer CC 7 / 127) -> reverb (when on);
// - the step sequencer (FL's arpeggiator class in "sequencer" mode): a note
//   selects the program (= key) and starts its sequence from step 0 at FL's
//   tempo (or the sequence's own BPM), 16th steps with shuffle, gate length
//   in steps, slides hold the gate into the next step, releasing the note
//   stops it;
// - the plugin keeps processing one second after its output falls below
//   1e-6 (FL's tail counter).

import type { GenContext, GenInstance, GenNote } from '../../types';
import { flFinalPitch } from '../../levels';
import { TbEngine, TbEngineV1, TbSmoother, type TbVoiceEngine } from './engine';
import { TbDelay } from './delay';
import { FxReverb } from './reverb';
import {
  TB_PARAM_KEYS, TB_PARAM_MAX, TB_SYNC_TABLE, tbDefaultSeq, tbDefaultPatch, tbProgramPatch, tbProgramSeq, tbSeqOf,
  type TbSeqData, type TbStateLike,
} from '../../../../model/gen/plugins/transistorbass/data';

const f32 = Math.fround;
const MAX_HELD = 20;
const ACCENT_VEL = f32(0.8661417365074158);
/** FL's MyPlugin: Transistor Bass parameter -> fxReverb parameter id (-1 = none). */
const TB_REVERB_ID = [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 3, 4, 5, 6, 9, 10, 14, 11, 12, 13];
while (TB_REVERB_ID.length < 64) TB_REVERB_ID.push(-1);

interface Voice { note: number; color: number; ref: GenNote | null; key: number }

/** FL's arpeggiator in sequencer mode (mode 4). */
class TbSequencer {
  enabled = false;
  pattern: TbSeqData = tbDefaultSeq();
  held: number[] = [];
  heldVel: number[] = [];
  heldIdx = 0;
  octave = 0;
  velBlend = 0;
  rate = 1;
  shuffle = 0;
  pos = 0;
  step = -1;
  gateLeft = 0;
  sent: number[] = [];
  gateLen = 0.66;
  private readonly plug: TbPlugin;
  constructor(plug: TbPlugin) { this.plug = plug; }

  releaseSent(): void {
    for (const n of this.sent) this.plug.sinkOff(n);
    this.sent.length = 0;
    this.gateLeft = 0;
  }

  noteOn(key: number, vel: number): void {
    if (!this.enabled) { this.plug.sinkOn(key, false, vel); return; }
    if (this.held.indexOf(key) >= 0) return;
    if (this.held.length >= MAX_HELD) return;
    if (this.held.length === 0) {
      this.octave = 0;
      this.heldIdx = 0;
      this.pos = 0;
      this.step = -1;
    }
    this.held.push(key);
    this.heldVel.push(vel);
  }

  noteOff(key: number): void {
    if (!this.enabled) { this.plug.sinkOff(key); return; }
    const i = this.held.indexOf(key);
    if (i >= 0) { this.held.splice(i, 1); this.heldVel.splice(i, 1); }
    if (this.held.length === 0) this.releaseSent();
  }

  private trigger(idx: number): void {
    const p = this.pattern;
    const flags = p.f[idx] | 0;
    if (!(flags & 1)) return; // gate off: the previous note goes on
    if (this.gateLeft < 10000) this.releaseSent();
    if (this.held.length >= 1) {
      if (this.heldIdx >= this.held.length) this.heldIdx = 0;
      let note = this.held[this.heldIdx] + this.octave * 12 + (p.p[idx] | 0);
      note = note < 0 ? 0 : note > 127 ? 127 : note;
      const vel = f32(f32(this.heldVel[this.heldIdx] * this.velBlend) + f32(0.5 * f32(1 - this.velBlend)));
      this.plug.sinkOn(note, !!(flags & 4), vel);
      this.releaseSent();
      this.sent.push(note);
      this.gateLeft = flags & 2 ? 20000 : this.gateLen;
      this.heldIdx++;
    }
  }

  /** Advance by `inc` steps (one sample). */
  tick(inc: number): void {
    if (!this.enabled || this.held.length === 0) return;
    const s = this.shuffle * 0.5 + 1;
    const pos = this.pos;
    const even = Math.trunc(pos) & ~1;
    const fr = pos - even;
    const x = fr > 1 ? even + s + (fr - 1) * (2 - s) : even + fr * s;
    const idx = Math.trunc(x);
    if (idx !== this.step) { this.step = idx; this.trigger(idx); }
    const d = this.rate * inc;
    if (this.sent.length) {
      this.gateLeft -= d;
      if (this.gateLeft < 0) this.releaseSent();
    }
    let np = d + this.pos;
    if (np >= Math.max(1, this.pattern.len)) { np -= Math.trunc(np); this.step = -1; }
    this.pos = np;
  }

  reset(): void {
    this.held.length = 0; this.heldVel.length = 0; this.sent.length = 0;
    this.pos = 0; this.step = -1; this.gateLeft = 0;
  }
}

export class TbPlugin implements GenInstance {
  readonly sr: number;
  engineType = 0;
  engine: TbVoiceEngine;
  readonly smoother = new TbSmoother();
  readonly seq: TbSequencer;
  readonly delay = new TbDelay();
  readonly reverb: FxReverb;
  /** Applied parameter values 0..1 (FL's P[] at +0x238). */
  readonly P = new Float32Array(64);
  /** Last state received. */
  state: TbStateLike | null = null;
  // plugin-level values
  heldCount = 0;
  panL = Math.SQRT1_2;
  panR = Math.SQRT1_2;
  chanVol = 100 / 127;
  seqTranspose = 0;
  prog = 0;
  progTranspose = 0;
  lastNote = 60;
  playing = false;
  tailLeft = 0;
  voices: Voice[] = [];
  // delay crossfade (FL's MyPlugin +0x3c330..)
  dlCur = 0; dlTgt = 1; dlXf = false; dlCount = 0; dlLen = 0; dlInv = 0;
  dlGainA = 1; dlGainB = 0; dlTime = 0; dlTap = 0; dlTapParam = 0; dlFirst = true;
  delayOn = false; delaySync = true; delaySyncBeats = 1; delayFree = 0.255;
  reverbOn = false;
  private readonly io = new Float32Array(2);
  private readonly rvL: Float32Array;
  private readonly rvR: Float32Array;
  private changes: [string, unknown][] = [];

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    this.seq = new TbSequencer(this);
    this.engine = new TbEngine(sampleRate, true);
    this.engineType = 1;
    this.smoother.setSampleRate(sampleRate);
    this.delay.setSampleRate(sampleRate);
    this.dlLen = Math.trunc(sampleRate * 0.3);
    this.dlInv = f32(1 / this.dlLen);
    this.reverb = new FxReverb(sampleRate);
    this.rvL = new Float32Array(Math.max(128, blockSize));
    this.rvR = new Float32Array(Math.max(128, blockSize));
    this.tailLeft = sampleRate;
  }

  // ---------------------------------------------------------------- state
  setParams(raw: unknown): void {
    const st = (raw ?? {}) as TbStateLike;
    const first = this.state === null;
    const prev = this.state;
    this.state = st;
    const et = typeof st.engine === 'number' ? Math.max(0, Math.min(2, Math.round(st.engine))) : 0;
    if (first || et !== this.engineType) this.setEngine(et);
    const prog = typeof st.prog === 'number' ? Math.max(0, Math.min(127, Math.round(st.prog))) : 0;
    const progChanged = first || prog !== this.prog;
    this.prog = prog;
    this.updateProgram();
    const seqOn = !!st.seqOn;
    if (seqOn !== this.seq.enabled) { this.seq.releaseSent(); this.seq.reset(); this.seq.enabled = seqOn; }
    for (let i = 0; i < TB_PARAM_KEYS.length; i++) {
      const k = TB_PARAM_KEYS[i];
      const v = f32(num(st[k], tbDefaultPatch(st.base)[i]) / TB_PARAM_MAX[i]);
      if (first || progChanged || prev === null) { this.apply(i, v); continue; }
      if (v === this.targetOf(i)) continue;
      if (this.smoother.isSwitch(i) || !this.smoother.add(i, v)) this.apply(i, v);
    }
    if (typeof st.playing === 'boolean' && st.playing !== this.playing) this.setPlaying(st.playing);
  }

  private targetOf(i: number): number {
    const sm = this.smoother;
    for (let k = 0; k < sm.count; k++) if (sm.idx[k] === i) return sm.target[k];
    return this.P[i];
  }

  private setEngine(t: number): void {
    const old = this.engine;
    const e: TbVoiceEngine = t === 0 ? new TbEngineV1(this.sr) : new TbEngine(this.sr, t === 1);
    if (this.state && old) {
      for (let i = 0; i < 42; i++) e.setParam(i, old.P[i]);
      e.bend = old.bend;
    }
    this.engine = e;
    this.engineType = t;
  }

  /** Current program's sequence, transpose and gate length. */
  private updateProgram(): void {
    const st = this.state;
    if (!st) { this.seq.pattern = tbDefaultSeq(); return; }
    const pr = st.progs?.[String(this.prog)];
    this.progTranspose = pr && typeof pr.transpose === 'number' ? pr.transpose : 0;
    this.seq.pattern = tbSeqOf(st, tbProgramSeq(st, this.prog));
    this.seq.gateLen = typeof this.seq.pattern.gate === 'number' ? this.seq.pattern.gate : 0.66;
  }

  /** FL's MyPlugin applyParam (0xf1dc): engine, delay and reverb. */
  apply(i: number, v: number): void {
    v = v < 0 ? 0 : v > 1 ? 1 : f32(v);
    this.P[i] = v;
    this.engine.setParam(i, v);
    const d = this.delay;
    switch (i) {
      case 14: this.reverbOn = v >= 0.5; break;
      case 32: this.delayOn = v >= 0.5; break;
      case 33: this.delaySync = v >= 0.5; break;
      case 34: d.input = v; break;
      case 35: {
        const idx = Math.floor(v * 17 + 0.5);
        this.delaySyncBeats = f32(TB_SYNC_TABLE[Math.max(0, Math.min(17, idx))] * 4);
        this.delayFree = f32(v * 0.49 + 0.01);
        break;
      }
      case 36: this.dlTapParam = v; break;
      case 37: d.feedback = v; break;
      case 38: d.cutoff = v; break;
      case 39: d.setStereo(v); break;
      default: break;
    }
    const rid = TB_REVERB_ID[i];
    if (rid >= 0) this.reverb.setParam(rid, i === 21 ? f32(v * v) : v);
  }

  // ---------------------------------------------------------------- notes
  /** The arpeggiator's sink (MyPlugin +0x210): program transpose, slide, accent. */
  sinkOn(note: number, accentFlag: boolean, vel: number): void {
    const n = note + this.progTranspose;
    const slide = this.heldCount > 0;
    const accent = vel >= ACCENT_VEL || accentFlag;
    this.engine.noteOn(n, slide, accent);
    this.heldCount++;
  }

  sinkOff(_note: number): void {
    this.heldCount = Math.max(this.heldCount, 1) - 1;
    if (this.heldCount === 0) this.engine.noteOff();
  }

  private midiVel(note: GenNote): number {
    const v = Math.fround(Math.log(Math.fround(note.init.vol * 10 + 1)) / Math.fround(3.044522523880005) * 127);
    const m = Math.trunc(v < 0 ? 0 : Math.min(v, 127));
    return m;
  }

  private pluginNoteOn(color: number, key: number, vel: number): void {
    if (color === 12) { this.seqTranspose = f32(key - 60); return; }
    this.tailLeft = this.sr;
    this.lastNote = key;
    if (this.seq.enabled) {
      this.selectProgram(key);
      this.seq.noteOn(0, 1);
      this.playing = true;
    } else {
      this.seq.reset();
      this.seq.noteOn(key, f32(vel / 127));
    }
  }

  private pluginNoteOff(color: number, key: number): void {
    if (color === 12) return;
    if (this.seq.enabled) {
      if (key !== this.lastNote) return;
      this.seq.noteOff(0);
      this.playing = false;
    } else {
      this.seq.noteOff(key);
    }
  }

  /** FL's 0xf46c: a note selects the program (sequencer mode) and loads its patch. */
  private selectProgram(p: number): void {
    const st = this.state;
    if (!st) return;
    if (p !== this.prog) {
      this.prog = p;
      this.smoother.count = 0;
      this.updateProgram();
      const vals = tbProgramPatch(st, p);
      for (let i = 0; i < 42; i++) this.apply(i, f32(vals[i] / TB_PARAM_MAX[i]));
      this.changes.push(['prog', p]);
      for (let i = 0; i < 42; i++) this.changes.push([TB_PARAM_KEYS[i], vals[i]]);
    }
  }

  private setPlaying(on: boolean): void {
    this.playing = on;
    if (!this.seq.enabled) return;
    if (on) { this.tailLeft = this.sr; this.seq.noteOn(0, 1); } else this.seq.noteOff(0);
  }

  /** Note events of the next render() call: [frame, on, key, color, velocity] and the note. */
  private readonly evFrame = new Int32Array(64);
  private readonly evOn = new Uint8Array(64);
  private readonly evKey = new Int32Array(64);
  private readonly evColor = new Int32Array(64);
  private readonly evVel = new Int32Array(64);
  private readonly evNote: (GenNote | null)[] = new Array(64).fill(null);
  private evCount = 0;

  private queue(on: boolean, note: GenNote, frame: number): void {
    const key = Math.max(0, Math.min(127, Math.trunc(note.init.pitch / 100)));
    if (this.evCount >= 64) this.flushEvents(Infinity);
    const k = this.evCount++;
    this.evFrame[k] = Math.max(0, frame | 0);
    this.evOn[k] = on ? 1 : 0;
    this.evKey[k] = key;
    this.evColor[k] = note.color | 0;
    this.evVel[k] = on ? this.midiVel(note) : 0;
    this.evNote[k] = note;
  }

  /** Apply queued events up to (and including) frame `upTo`, in order. */
  private flushEvents(upTo: number): void {
    let w = 0;
    for (let k = 0; k < this.evCount; k++) {
      if (this.evFrame[k] > upTo) {
        this.evFrame[w] = this.evFrame[k]; this.evOn[w] = this.evOn[k]; this.evKey[w] = this.evKey[k];
        this.evColor[w] = this.evColor[k]; this.evVel[w] = this.evVel[k]; this.evNote[w] = this.evNote[k];
        w++;
        continue;
      }
      const key = this.evKey[k], color = this.evColor[k], note = this.evNote[k];
      if (this.evOn[k]) {
        for (let i = 0; i < this.voices.length; i++) {
          const v = this.voices[i];
          if (v.note === key && v.color === color) { this.pluginNoteOff(color, key); this.voices.splice(i, 1); break; }
        }
        this.pluginNoteOn(color, key, this.evVel[k]);
        this.voices.push({ note: key, color, ref: note, key });
      } else {
        const i = this.voices.findIndex((v) => v.ref === note);
        if (i >= 0) { this.voices.splice(i, 1); this.pluginNoteOff(color, key); }
      }
      this.evNote[k] = null;
    }
    this.evCount = w;
  }

  noteOn(note: GenNote, frameOffset: number): void {
    this.queue(true, note, frameOffset);
    this.tailLeft = this.sr;
  }

  noteOff(note: GenNote, frameOffset: number): void {
    this.queue(false, note, frameOffset);
  }

  killNote(note: GenNote): void { this.queue(false, note, 0); }

  allNotesOff(): void {
    this.evCount = 0;
    for (const v of this.voices) this.pluginNoteOff(v.color, v.note);
    this.voices.length = 0;
    this.seq.reset();
    this.heldCount = 0;
    this.engine.noteOff();
  }

  /** The voices' FinalLevels (FL's wrapper, every block). */
  private expressions(): void {
    for (const v of this.voices) {
      const l = v.ref?.levels;
      if (!l) continue;
      const cents = flFinalPitch(l) - (v.note - 60) * 100;
      if (v.color === 0) {
        this.engine.cutMod = f32(l.fcut);
        this.engine.resMod = f32(l.fres);
        this.engine.noteOffset = f32(f32(cents) * f32(0.009999999776482582));
        let x = f32(f32(f32(l.pan) + 1) * 0.5);
        x = x < 0 ? 0 : x > 1 ? 1 : x;
        this.panR = f32(Math.sqrt(x));
        this.panL = f32(Math.sqrt(f32(1 - x)));
        // FL's channel volume as the CC 7 FPE_MIDI_Vol event (integer knob / 100)
        const vol = l.vol > 0 ? Math.floor(128 * (Math.log(10 * l.vol + 1) / Math.log(11)) + 1e-6) : 0;
        this.chanVol = f32(Math.min(127, Math.max(0, vol)) / 127);
      } else if (v.color === 1) {
        this.seqTranspose = f32(v.note + cents * 0.01 - 60);
      }
    }
  }

  // ---------------------------------------------------------------- render
  isActive(): boolean {
    return this.tailLeft > 0 || this.voices.length > 0 || this.playing || this.evCount > 0;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (this.tailLeft <= 0 && !this.playing && this.voices.length === 0 && this.evCount === 0) {
      for (let i = 0; i < n; i++) this.counterTick();
      return;
    }
    this.expressions();
    const e = this.engine;
    const pat = this.seq.pattern;
    const bpm = pat.ibpm ? (pat.bpm || 125) : (ctx.tempo || 120);
    const inc = (bpm / 15) * (1 / this.sr);
    this.seq.shuffle = -(pat.sh || 0);
    // delay time / tap changes are checked at the block start (FL)
    if (this.delayOn) this.delayBlockStart(bpm);
    const io = this.io;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      this.counterTick();
      if (this.evCount) { this.flushEvents(i); if (i === 0 || this.voices.length) this.expressions(); }
      if (this.seq.enabled) {
        e.seqTranspose = this.seqTranspose;
        this.seq.tick(inc);
      } else e.seqTranspose = 0;
      const s = e.tick();
      io[0] = f32(s * this.panL);
      io[1] = f32(s * this.panR);
      if (this.delayOn) {
        this.delay.process(io, this.dlGainA, this.dlGainB);
        if (this.dlXf) this.delayXfStep();
      }
      const a = f32(io[0] * this.chanVol), b = f32(io[1] * this.chanVol);
      this.rvL[i] = a; this.rvR[i] = b;
    }
    if (this.reverbOn) this.reverb.process(this.rvL, this.rvR, n);
    for (let i = 0; i < n; i++) {
      L[i] += this.rvL[i]; R[i] += this.rvR[i];
      const m = Math.max(Math.abs(this.rvL[i]), Math.abs(this.rvR[i]));
      if (m > peak) peak = m;
    }
    if (peak < f32(9.999999974752427e-07)) this.tailLeft = Math.max(0, this.tailLeft - n);
    else this.tailLeft = this.sr;
  }

  private counterTick(): void {
    if (++this.smoother.counter === 16) {
      this.smoother.counter = 0;
      if (this.smoother.count) this.smoother.step((i) => this.P[i], (i, v) => this.apply(i, v));
    }
  }

  private delayBlockStart(bpm: number): void {
    const s8 = this.delaySync ? f32((1 / (bpm / 60)) * this.delaySyncBeats) : this.delayFree;
    const d = this.delay;
    if (this.dlFirst) {
      this.dlFirst = false;
      this.dlTime = s8;
      d.setTime(0, s8); d.setTime(1, s8);
      d.setTap(0, this.dlTap); d.setTap(1, this.dlTap);
    }
    if (this.dlXf) return;
    if (this.dlTime === s8 && this.dlTap === this.dlTapParam) return;
    this.dlXf = true;
    this.dlCount = 0;
    this.dlTgt = this.dlCur ^ 1;
    this.dlTime = s8;
    this.dlTap = this.dlTapParam;
    d.setTime(this.dlTgt, s8);
    d.setTap(this.dlTgt, this.dlTap);
  }

  private delayXfStep(): void {
    const t = f32(this.dlCount * this.dlInv);
    if (this.dlCur !== 0) { this.dlGainA = t; this.dlGainB = f32(1 - t); } else { this.dlGainA = f32(1 - t); this.dlGainB = t; }
    this.dlCount++;
    if (this.dlCount === this.dlLen) {
      this.dlXf = false;
      this.dlGainA = this.dlGainA < 0.5 ? 0 : 1;
      this.dlGainB = this.dlGainB < 0.5 ? 0 : 1;
      this.dlCur = this.dlTgt;
    }
  }

  takeStateChanges(): [string, unknown][] | null {
    if (!this.changes.length) return null;
    const c = this.changes;
    this.changes = [];
    return c;
  }

  monitor() {
    return { step: this.seq.enabled && this.seq.held.length ? this.seq.step : -1, prog: this.prog, playing: this.playing };
  }

  reset(): void {
    this.engine.reset();
    this.delay.clear();
    this.reverb.reset();
    this.seq.reset();
    this.voices.length = 0;
    this.heldCount = 0;
  }

  tail = 0;
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
