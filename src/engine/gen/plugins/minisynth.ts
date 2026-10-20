// MiniSynth (FL: MiniSynth, Plugin database > Generators > Synth classic): the
// FL Studio Mobile synth in FL's C++ plugin wrapper. Ported from FL's
// MiniSynth_x64.dylib (arm64); see docs/research/gen/minisynth.md.
//
// The synth manages its own voices (POLY / MONO / LEAD with slide), so it is
// an 'events' plugin here, as FL's wrapper turns FL's voices into MIDI notes:
// - TriggerVoice (0x2e688): key = InitLevels.Pitch / 100 (one FL voice per key;
//   a second note on the same key releases the first and drops its FL voice),
//   velocity = FL's InitLevels.Vol mapped back to MIDI 0..127; the synth gets
//   a note on (velocity / 127). Voice_Release = note off; Voice_Kill (FL's
//   polyphony limit) = note off too, the synth plays the release.
// - Gen_Render (0x2e584): first FL's levels of every key's FL voice become the
//   synth's per-key gains (FL's pan law on FinalLevels.Pan / Vol: the channel
//   volume and panning are applied inside the plugin, before the effects),
//   pitch offsets (FinalLevels.Pitch: channel pitch, fine, slides) and filter
//   offsets (Mod X / Y); keys without an FL voice take the values of the last
//   voiced key below them (the first voiced key's for the keys below it). Then
//   the synth renders; then FL voices whose key no synth voice rendered and
//   that are released are dropped.
// - Each render call between note events is one Gen_Render call (FL at the
//   engine's block size, notes splitting blocks at their sample).
// - Parameters 0..42: FL's int value / 256 (0..1 float); 43..171: MIDI CC
//   0..127 and channel aftertouch, of which the synth only uses CC 1 (mod wheel).

import type { GenContext, GenInstance, GenModule, GenNote } from '../types';
import { noteVolume } from '../levels';
import { MsCore, miniSynthSeed } from './minisynth/core';
import { MS_PARAM_KEYS } from '../../../model/gen/plugins/minisynth';

export { miniSynthSeed };

const f32 = Math.fround;
const MAX_EVENTS = 512;
const EV_ON = 0, EV_OFF = 1, EV_KILL = 2;
/** Frames of silence after which the plugin stops (effects tail); with the delay on, its buffer must empty. */
const QUIET_S = 0.05;
const QUIET_DELAY_S = 1.6;

/** FL's ComputeLRVol (host 0x3a8420), single precision: circular law. */
function flPanLaw(pan: number, vol: number, out: Float32Array, k: number): void {
  let p = f32(pan);
  if (!(p >= -1)) p = -1;
  else if (p > 1) p = 1;
  const a = f32(f32(p + 1) * 0.7853981633974483);
  out[k] = f32(f32(Math.cos(a)) * vol);
  out[k + 128] = f32(f32(Math.sin(a)) * vol);
}

/** FL's wrapper velocity (0x34f28): InitLevels.Vol -> MIDI velocity 0..127. */
export function miniSynthVelocity(flVelocity: number): number {
  const vol = f32(noteVolume(flVelocity));
  const v = Math.trunc(f32(f32(Math.log(f32(vol * 10 + 1))) * 41.71426010131836));
  return v > 0 ? (v < 127 ? v : 127) : 0;
}

class MiniSynth implements GenInstance {
  readonly core: MsCore;
  private readonly sr: number;
  /** FL voice per key (the wrapper's slots) and the note id it had. */
  private readonly slot: (GenNote | null)[] = new Array(128).fill(null);
  private readonly slotId = new Float64Array(128);
  /** Last levels read from each slot's note (pan, vol, pitch, fcut, fres). */
  private readonly snap = new Float64Array(128 * 5);
  /** Per-key L / R gains (L at k, R at k + 128). */
  private readonly lr = new Float32Array(256);
  private lastL = 0;
  private lastR = 0;
  // queued events of the next render call
  private readonly evType = new Uint8Array(MAX_EVENTS);
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private evCount = 0;
  private readonly raw = new Float64Array(172).fill(Number.NaN);
  private quiet = 0;
  tail = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.core = new MsCore(sampleRate);
    // FL's start-up resets every voice (each reset draws 2048 numbers from the global noise generator):
    // the voices' constructor (above), the synth's preset library load (setSampleRate(0), 0x3131c), the
    // wrapper's setSampleRate(44100) (0x2c29c), and FPD_SetSampleRate when the host rate differs (0x2c9fc).
    this.core.resetAll();
    this.core.resetAll();
    if (sampleRate !== 44100) this.core.resetAll();
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const keys = MS_PARAM_KEYS;
    for (let i = 0; i < 172; i++) {
      const raw = q[keys[i]];
      let v = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
      v = v > 0 ? (v < 256 ? v : 256) : 0;
      if (v === this.raw[i]) continue;
      this.raw[i] = v;
      // FL's ProcessParam: value / 256 to the synth (setParam 0x36290)
      if (i < 43) this.core.setParam(i, f32(v / 256));
      else if (i === 44) {
        // MIDI CC 1 -> the synth's mod wheel (FL: trunc(value x 127) / 127)
        const f = f32(v / 256);
        this.core.modWheel = f32(Math.trunc(f * 127) * 0.007874015718698502);
      }
    }
  }

  /**
   * FL's FPE_MaxPoly (the channel's max polyphony, 0 = unlimited): the synth's POLY voice count (0 = 99).
   * The channel sends it when it gets the plugin and on every MISC polyphony change (8 = DefPoly).
   */
  setMaxPoly(n: number): void {
    this.core.maxPoly = n > 0 ? Math.min(99, Math.round(n)) : 99;
  }

  reset(): void {
    this.core.resetAll();
    this.slot.fill(null);
    this.core.velIn.fill(0);
    this.evCount = 0;
  }

  noteOn(note: GenNote, frameOffset: number): void { this.queue(EV_ON, note, frameOffset); }
  noteOff(note: GenNote, frameOffset: number): void { this.queue(EV_OFF, note, frameOffset); }
  killNote(note: GenNote): void { this.queue(EV_KILL, note, 0); }

  /** Queue an event in frame order; at the same frame note offs come before note ons (as FL's host orders them). */
  private queue(type: number, note: GenNote, frame: number): void {
    if (this.evCount >= MAX_EVENTS) return;
    const f = Math.max(0, Math.floor(frame));
    const rank = type === EV_ON ? 1 : 0;
    let i = this.evCount++;
    while (i > 0) {
      const pf = this.evFrame[i - 1], pr = this.evType[i - 1] === EV_ON ? 1 : 0;
      if (pf < f || (pf === f && pr <= rank)) break;
      this.evType[i] = this.evType[i - 1];
      this.evFrame[i] = pf;
      this.evNote[i] = this.evNote[i - 1];
      i--;
    }
    this.evType[i] = type;
    this.evFrame[i] = f;
    this.evNote[i] = note;
  }

  isActive(): boolean {
    if (this.core.voicesActive()) return true;
    const lim = (this.core.delayOn ? QUIET_DELAY_S : QUIET_S) * this.sr;
    return this.quiet < lim;
  }

  allNotesOff(): void {
    const c = this.core;
    for (const v of c.voices) if (v.key >= 0) v.reset(0);
    c.keyVel.fill(0);
    c.velIn.fill(0);
    this.slot.fill(null);
    this.evCount = 0;
  }

  /** FL's note on through the wrapper (TriggerVoice). */
  private trigger(note: GenNote): void {
    const c = this.core;
    const key = Math.max(0, Math.min(127, Math.trunc(note.key)));
    const old = this.slot[key];
    if (old && (old !== note || this.slotId[key] !== note.id)) {
      // the key's previous FL voice: note off, FL drops it
      c.velIn[key] = 0;
      c.note(key, 0);
    }
    this.slot[key] = note;
    this.slotId[key] = note.id;
    this.read(key, note);
    const vel = miniSynthVelocity(note.velocity);
    c.velIn[key] = f32(vel * 0.007874015718698502);
    c.note(key, vel === 0 ? 0 : c.velIn[key]);
  }

  /** FL's Voice_Release / Voice_Kill: the synth's note off (the key's FL voice stays until its sound ends). */
  private release(note: GenNote): void {
    const c = this.core;
    const key = Math.max(0, Math.min(127, Math.trunc(note.key)));
    if (this.slot[key] !== note || this.slotId[key] !== note.id) return;
    this.read(key, note);
    c.velIn[key] = 0;
    c.note(key, 0);
  }

  /** Snapshot a slot's note levels while the note object still belongs to it. */
  private read(k: number, note: GenNote): void {
    if (note.id !== this.slotId[k]) return;
    const l = note.levels, s = this.snap, o = k * 5;
    s[o] = l.pan; s[o + 1] = l.vol; s[o + 2] = l.pitch; s[o + 3] = l.fcut; s[o + 4] = l.fres;
  }

  /** FL's per-call levels (wrapper 0x2d8c4). */
  private levels(): void {
    const c = this.core, s = this.snap, lr = this.lr;
    let pitch = 0, fcut = 0, fres = 0;
    let L = this.lastL, R = this.lastR;
    let first = true;
    for (let k = 0; k < 128; k++) {
      const note = this.slot[k];
      if (note) {
        this.read(k, note);
        const o = k * 5;
        flPanLaw(s[o], f32(s[o + 1]), lr, k);
        L = lr[k]; R = lr[k + 128];
        pitch = f32(f32(s[o + 2] - 6000) * 0.01 + (60 - k));
        fcut = f32(s[o + 3]);
        fres = f32(s[o + 4]);
        if (first) {
          first = false;
          for (let j = 0; j < k; j++) { c.keyL[j] = L; c.keyR[j] = R; c.keyPitch[j] = pitch; c.keyFcut[j] = fcut; c.keyFres[j] = fres; }
        }
      }
      c.keyL[k] = L; c.keyR[k] = R; c.keyPitch[k] = pitch; c.keyFcut[k] = fcut; c.keyFres[k] = fres;
    }
    this.lastL = L; this.lastR = R;
  }

  /** FL's Gen_Render for n frames at offset o. */
  private genRender(L: Float32Array, R: Float32Array, o: number, n: number, ctx: GenContext): void {
    const c = this.core;
    this.levels();
    c.tempo = ctx.tempo;
    c.sync = !!ctx.playing;
    c.pos = ctx.playing ? ctx.pos / (ctx.ppq || 96) + (o * ctx.tempo) / (60 * this.sr) : 0;
    c.process(L, R, o, n);
    // FL drops released FL voices whose key no synth voice rendered
    for (let k = 0; k < 128; k++) if (this.slot[k] && c.active[k] === 0 && c.velIn[k] === 0) this.slot[k] = null;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    let seg = 0;
    let ei = 0;
    const cnt = this.evCount;
    while (seg < n) {
      while (ei < cnt && this.evFrame[ei] <= seg) {
        const note = this.evNote[ei]!;
        const t = this.evType[ei];
        if (t === EV_ON) this.trigger(note); else this.release(note);
        this.evNote[ei] = null;
        ei++;
      }
      const end = ei < cnt ? Math.min(n, this.evFrame[ei]) : n;
      this.genRender(L, R, seg, end - seg, ctx);
      seg = end;
    }
    for (; ei < cnt; ei++) {
      const note = this.evNote[ei]!;
      if (this.evType[ei] === EV_ON) this.trigger(note); else this.release(note);
      this.evNote[ei] = null;
    }
    this.evCount = 0;
    // effects tail: silence counter
    let pk = 0;
    for (let i = 0; i < n; i++) { const a = Math.abs(L[i]) + Math.abs(R[i]); if (a > pk) pk = a; }
    if (pk > 1e-7 || this.core.voicesActive()) this.quiet = 0; else this.quiet += n;
  }
}

export const gen: GenModule = {
  id: 'minisynth',
  create: (sampleRate) => new MiniSynth(sampleRate),
};
