// Drumpad (FL: Drumpad, by Maxx Claster): a physical-modelling drum synth.
// Reproduces FL 2026's own engine (Drumpad/engine dylib: DrumpadSynth and its
// 99 voices, docs/research/gen/drumpad.md) in its single precision and
// operation order. There are no samples: the preset names ("Acoustic HiTom 05
// p - TomA") only name the sounds.
//
// Each voice synthesizes at a fixed internal rate of 38000 Hz:
// - Mallet: an impulse level (10^(4 amp - 4)) decaying toward 1e-7 by
//   0.05 (1 - decay)^4 + 1e-4 per sample, mixed with FL's noise generator
//   (the voice's own LCG, 0x0bb38435 / 0x3619636b) by Mallet noise.
// - Membrane: up to 512 parallel combs (delay 512 - n samples, n = 0..511, each
//   a one-pole low-pass (cutoff^2) in a feedback loop (-decay^0.3)) excited by
//   the mallet, read out through a weight per comb: a triangle (phase +
//   tension^4 / 2 per comb) raised to 1 + 20 m^4 (or its inverse), m = 2
//   material - 1; Size and Shape select combs size .. size + shape. FL runs
//   them as 128 four-lane vectors (lane j of line i: length 512 - 4 i - j),
//   which is what is emulated here.
// - SOF: a four-pole ladder (soft clip x / (1 + 0.005 |x|) of the input minus
//   10^5 x its output) whose cutoff closes with an envelope (SOF decay); its
//   output, x Level^8 / 2, is added to the signal.
// - LOW (high-pass biquad at 2^(11 v + 2) Hz, Q 8 v + 1), HIGH (shelf, FL's
//   RBJ variant: A = 10^(dB / 20), bandwidth Q) and MID (peaking, frequency and
//   level swept by an attack envelope that re-triggers Retrig times; FL updates
//   it every 6 samples).
// - Hold: the gain approaches 1 by 0.1 per sample for Hold (3 v^3 + 0.001 s),
//   then falls by 0.999 per sample; clip to +-1; Lo-Fi quantizes to
//   65536 (1 - v)^5 + 4 steps.
// Every parameter (with its velocity modulation: base + (value - base) x
// velocity^0.5 for up to four targets) is read when a voice starts. The voice
// is resampled to the host rate (linear, step 38000 / rate x 2^(2 pitch - 1) x
// 2^(semitones / 12), chunks of at most 256 frames) and mixed with gains that
// move 0.001 per sample toward FL's ComputeLRVol of the note's levels.
//
// FL's wrapper and synth, also reproduced: a note's slot is its key; FL's synth
// has 99 voices but polyphony 1, so every note retriggers the first voice (the
// membrane, filters and resampler carry over); note offs and kills do not stop
// it; a voice's first note leaves it counted as free (FL's quirk), so FL
// forgets that note one block after its note off and the voice fades out
// (gains move to 0 by 0.001 per sample). The voice's levels come from FL's
// per-slot arrays, which FL indexes with the voice number (slot v's levels, or
// the nearest lower active slot's). A voice ends 25 ms after its output last
// exceeded 1e-4 (or after 0.5 s of silence).

import type { GenContext, GenInstance, GenModule, GenNote } from '../types';
import type { FxMonitor } from '../../effects/types';
import { DP_KEYS } from '../../../model/gen/plugins/drumpad/keys';
import { exp2f, fma32, fmaD, powf } from './drumpad/libm';
import { DP_ENGINE_DEFAULTS, DpVoice, flLRVol } from './drumpad/voice';

const f32 = Math.fround;
const fma = fma32;
/**
 * FL's synth builds 99 voices but its polyphony is 1 (measured: every note
 * retriggers the first voice), so only that voice is built here.
 */
const DP_POLY = 1;
const NVOICES = DP_POLY;
const MAX_EVENTS = 256;
export const DP_PARAMS = 38;
export { DP_ENGINE_DEFAULTS };

/** A key's note as FL's wrapper keeps it (its TVoiceParams; levels kept once the channel lets the note go). */
interface Slot { note: GenNote | null; pan: number; vol: number; pitch: number }

class Drumpad implements GenInstance {
  private readonly sampleRate: number;
  readonly voices: DpVoice[] = [];
  /** Engine parameter values (FL: control / 256; velocity targets 30..33 as is). */
  readonly p = new Float32Array(DP_PARAMS);
  /** FL's wrapper: the note per slot (key); FL clears a slot once its note is off and no voice plays it. */
  private readonly slots: (Slot | null)[] = new Array(128).fill(null);
  /** FL's synth: voices per note, and the note's velocity (0 once the note is off). */
  private readonly counts = new Int32Array(128);
  private readonly noteVel = new Float32Array(128);
  private readonly eL = new Float32Array(128);
  private readonly eR = new Float32Array(128);
  private readonly eP = new Float32Array(128);
  private stamp = 0;
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private readonly evOn = new Uint8Array(MAX_EVENTS);
  private evCount = 0;
  private readonly lr = { l: 0, r: 0 };
  private curVel = 0;
  private readonly getp = (i: number): number => this.param(i);

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    for (let i = 0; i < NVOICES; i++) {
      const v = new DpVoice(i, this.counts);
      v.reset(f32(sampleRate));
      this.voices.push(v);
    }
    this.p.set(DP_ENGINE_DEFAULTS);
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    for (let i = 0; i < DP_PARAMS; i++) {
      const x = Number(q[DP_KEYS[i]]);
      if (!Number.isFinite(x)) continue;
      if (i >= 30 && i <= 33) this.p[i] = Math.round(Math.max(0, Math.min(28, x)));
      else this.p[i] = f32(Math.max(0, Math.min(1, x / 256)));
    }
  }

  reset(): void {
    for (const v of this.voices) { v.reset(f32(this.sampleRate)); v.pos = 0; v.cnt = 0; }
    this.slots.fill(null);
    this.counts.fill(0);
    this.noteVel.fill(0);
    this.evCount = 0;
    this.evNote.fill(null);
  }

  /** FL's velocity-modulated parameter getter (-1 / -2: Mallet retrig / Retrig, not modulated). */
  private param(i: number): number {
    if (i === -1) return this.p[0];
    if (i === -2) return this.p[1];
    const base = this.p[i];
    let tgt = base;
    for (let k = 0; k < 4; k++) {
      const s = Math.trunc(this.p[30 + k]);
      if (s !== 0 && s + 1 === i) tgt = this.p[34 + k];
    }
    return fma(f32(tgt - base), this.curVel, base);
  }

  private queue(note: GenNote, frame: number, on: boolean): void {
    if (this.evCount >= MAX_EVENTS) return;
    this.evFrame[this.evCount] = frame;
    this.evNote[this.evCount] = note;
    this.evOn[this.evCount++] = on ? 1 : 0;
  }

  noteOn(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, true); }
  /** FL's Voice_Release: the engine's note off (it does not stop the voice). */
  noteOff(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, false); }
  /** FL's Voice_Kill: the same note off, now. */
  killNote(note: GenNote): void {
    for (let i = 0; i < this.evCount; i++) if (this.evNote[i] === note && this.evOn[i]) this.evNote[i] = null;
    this.release(note);
  }

  isActive(): boolean {
    if (this.evCount > 0) return true;
    for (const v of this.voices) if (v.active) return true;
    return false;
  }

  /** FL's TriggerVoice + the synth's note on. */
  private trigger(note: GenNote): void {
    const slot = Math.min(127, Math.max(0, Math.trunc(note.key)));
    const s = this.slots[slot];
    if (s) { s.note = note; } else this.slots[slot] = { note, pan: 0, vol: 0, pitch: 6000 };
    const lv = Math.trunc(f32(f32(Math.log(fma(f32(note.init.vol), 10, 1))) * f32(41.714256)));
    const vel = lv < 0 ? 0 : lv > 127 ? 127 : lv;
    const velF = f32(vel * f32(1 / 127));
    this.noteVel[slot] = velF;
    if (vel === 0) return;
    // the first free voice, else the oldest
    // the first free voice among the first DP_POLY, else the oldest of them
    let pick: DpVoice | null = null;
    for (let k = 0; k < DP_POLY; k++) if (this.voices[k].note < 0) { pick = this.voices[k]; break; }
    if (!pick) { pick = this.voices[0]; for (let k = 0; k < DP_POLY; k++) if (this.voices[k].stamp < pick.stamp) pick = this.voices[k]; }
    pick.stamp = this.stamp++;
    pick.assign(slot);
    pick.vel = powf(velF, 0.5);
    this.curVel = pick.vel;
    pick.noteOn(this.getp);
  }

  /** The engine's note off for the note's slot; the channel lets the note object go: keep its levels. */
  private release(note: GenNote): void {
    const slot = Math.min(127, Math.max(0, Math.trunc(note.key)));
    const s = this.slots[slot];
    if (!s || s.note !== note) return;
    this.noteVel[slot] = 0;
    s.pan = note.levels.pan; s.vol = note.levels.vol; s.pitch = note.levels.pitch;
    s.note = null;
  }

  /** FL's per-slot level arrays (all 128 filled from the nearest active slot; zeros without one). */
  private levels(): void {
    let any = false;
    for (let i = 0; i < 128; i++) {
      const s = this.slots[i];
      if (s) {
        const n = s.note;
        const pan = n ? n.levels.pan : s.pan, vol = n ? n.levels.vol : s.vol, pitch = n ? n.levels.pitch : s.pitch;
        flLRVol(pan, f32(vol), this.lr);
        const pt = f32(fmaD(f32(pitch - 6000), 0.01, 60 - i));
        if (!any) { any = true; for (let j = 0; j < i; j++) { this.eL[j] = this.lr.l; this.eR[j] = this.lr.r; this.eP[j] = pt; } }
        this.eL[i] = this.lr.l; this.eR[i] = this.lr.r; this.eP[i] = pt;
      } else if (any) { this.eL[i] = this.eL[i - 1]; this.eR[i] = this.eR[i - 1]; this.eP[i] = this.eP[i - 1]; }
      else { this.eL[i] = 0; this.eR[i] = 0; this.eP[i] = 0; }
    }
  }

  /** One of FL's Gen_Render calls. */
  private segment(L: Float32Array, R: Float32Array, off: number, n: number): void {
    this.levels();
    for (let i = 0; i < NVOICES; i++) {
      const v = this.voices[i];
      if (v.active) {
        let st = this.eP[i];
        st = st > -12 ? st : -12;
        st = st < 12 ? st : 12;
        v.pitchRatio = exp2f(f32(st * f32(0.083333336)));
        v.tgtL = this.eL[i]; v.tgtR = this.eR[i];
        v.process(L, R, off, n);
      }
    }
    // FL's wrapper forgets (kills) the notes that are off and have no voice left
    for (let i = 0; i < 128; i++) if (this.slots[i] && this.counts[i] === 0 && this.noteVel[i] === 0) this.slots[i] = null;
  }

  private event(e: number): void {
    const note = this.evNote[e];
    if (!note) return;
    if (this.evOn[e]) this.trigger(note); else this.release(note);
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    void ctx;
    let e = 0, i = 0;
    while (i < n) {
      while (e < this.evCount && this.evFrame[e] <= i) this.event(e++);
      let end = n;
      if (e < this.evCount && this.evFrame[e] < n) end = this.evFrame[e];
      if (end > i) this.segment(L, R, i, end - i);
      i = end;
    }
    while (e < this.evCount) this.event(e++);
    this.evCount = 0;
    this.evNote.fill(null);
  }

  monitor(): FxMonitor {
    return { voices: this.voices.reduce((a, v) => a + (v.active ? 1 : 0), 0) };
  }
}

export const gen: GenModule = {
  id: 'drumpad',
  create: (sampleRate: number) => new Drumpad(sampleRate),
};
