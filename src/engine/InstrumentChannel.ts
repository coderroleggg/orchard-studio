// FL's channel note handling, shared by every instrument channel (the Sampler
// and instrument plugins): MISC time shift and key range, arpeggiator, echo
// delay voices, gate, polyphony / mono / porta / slide notes, cut groups, live
// notes, and the per-voice levels a channel gives its voices at the control
// rate (16 samples): velocity / key tracking, MISC levels adjustment, channel
// volume / pan / pitch, porta / slide glides and the INS DAHDSR envelopes with
// tension and LFOs. A subclass supplies the voice source: SamplerChannel reads
// sample data (src/engine/Sampler.ts); GenChannel runs an instrument plugin's
// voices (src/engine/GenChannel.ts).

import type { Channel, Id } from '../model/types';
import type { EngineGlobals } from './protocol';
import {
  type SamplerSettings, type EnvSettings, type LfoSettings,
  envSeconds, envTempoSeconds, tensionShape, lfoHz, lfoTempoSteps, filterCutoffHz, filterQ,
  slideSteps, gateSteps, velocityGain, adjVolGain,
} from '../model/sampler';
import { channelVolumeToGain } from '../model/scales';
import { SvfCoefs, SvfMode, SvfState } from './dsp/svf';
import type { SeqNote } from './Sequencer';

export interface SampleData {
  channels: Float32Array[];
  sampleRate: number;
  frames: number;
}

/**
 * The live levels of the Layer channel a child's voice follows (FL: the final
 * levels of a voice are its own levels plus its parent channel's; a layer is a
 * parent of the voices it triggers on its children). The Layer owns one tap
 * per child and updates it whenever its controls or the crossfade move, so
 * sounding voices follow. A child's own notes carry no tap.
 */
export class LayerTap {
  /** Added to the voice's panning (-1..1 units). */
  pan = 0;
  /** Multiplies the voice's volume: layer volume x levels adjustment x crossfade gain. */
  gain = 1;
  /** Added to the voice's pitch (cents): layer PITCH x RANGE and fine tune. */
  cents = 0;
  /** Added to the voice's Mod X / Mod Y levels. */
  modX = 0;
  modY = 0;
}

/** Control rate: voices' levels, envelopes and LFOs advance in steps of this many samples. */
export const CTRL = 16;
export const MAX_VOICES = 128;
// envelope / lfo slots
export const PAN = 0, VOL = 1, MODX = 2, MODY = 3, PITCH = 4;
export const TARGETS = ['pan', 'vol', 'modX', 'modY', 'pitch'] as const;

// ------------------------------------------------------------------ envelope
const enum Stage { Idle, Delay, Attack, Hold, Decay, Sustain, Release, Done }

export class Env {
  stage = Stage.Idle;
  pos = 0;
  value = 0;
  private relStart = 0;
  private dly = 0; private att = 0; private hld = 0; private dec = 0; private rel = 0;
  private sus = 1; private aT = 0; private dT = 0; private rT = 0;

  setup(e: EnvSettings, sr: number, bpm: number): void {
    const sec = (x: number) => (e.tempo ? envTempoSeconds(x, bpm) : envSeconds(x));
    this.dly = Math.round(sec(e.delay) * sr);
    this.att = Math.round(sec(e.attack) * sr);
    this.hld = Math.round(sec(e.hold) * sr);
    this.dec = Math.round(sec(e.decay) * sr);
    this.rel = Math.round(sec(e.release) * sr);
    this.sus = e.sustain;
    this.aT = e.attackTension;
    this.dT = e.decayTension;
    this.rT = e.releaseTension;
  }

  trigger(): void {
    this.stage = this.dly > 0 ? Stage.Delay : Stage.Attack;
    this.pos = 0;
    this.value = 0;
  }

  release(): void {
    if (this.stage >= Stage.Release) return;
    this.relStart = this.value;
    this.stage = Stage.Release;
    this.pos = 0;
  }

  get done(): boolean { return this.stage === Stage.Done; }

  advance(n: number): number {
    while (n > 0) {
      switch (this.stage) {
        case Stage.Idle: case Stage.Done: this.value = 0; return 0;
        case Stage.Delay: {
          const step = Math.min(n, this.dly - this.pos);
          this.pos += step; n -= step; this.value = 0;
          if (this.pos >= this.dly) { this.stage = Stage.Attack; this.pos = 0; }
          break;
        }
        case Stage.Attack: {
          if (this.att <= 0) { this.stage = Stage.Hold; this.pos = 0; this.value = 1; break; }
          const step = Math.min(n, this.att - this.pos);
          this.pos += step; n -= step;
          this.value = tensionShape(this.pos / this.att, this.aT);
          if (this.pos >= this.att) { this.stage = Stage.Hold; this.pos = 0; this.value = 1; }
          break;
        }
        case Stage.Hold: {
          const step = Math.min(n, this.hld - this.pos);
          this.pos += step; n -= step; this.value = 1;
          if (this.pos >= this.hld) { this.stage = Stage.Decay; this.pos = 0; }
          break;
        }
        case Stage.Decay: {
          if (this.dec <= 0) { this.stage = Stage.Sustain; this.value = this.sus; break; }
          const step = Math.min(n, this.dec - this.pos);
          this.pos += step; n -= step;
          this.value = 1 - (1 - this.sus) * tensionShape(this.pos / this.dec, this.dT);
          if (this.pos >= this.dec) { this.stage = Stage.Sustain; this.value = this.sus; }
          break;
        }
        case Stage.Sustain: this.value = this.sus; return this.value;
        case Stage.Release: {
          if (this.rel <= 0) { this.stage = Stage.Done; this.value = 0; return 0; }
          const step = Math.min(n, this.rel - this.pos);
          this.pos += step; n -= step;
          this.value = this.relStart * (1 - tensionShape(this.pos / this.rel, this.rT));
          if (this.pos >= this.rel) { this.stage = Stage.Done; this.value = 0; return 0; }
          break;
        }
      }
    }
    return this.value;
  }
}

// ----------------------------------------------------------------------- LFO
export class Lfo {
  phase = 0;
  inc = 0;
  private t = 0;
  private delay = 0;
  private attack = 0;
  amount = 0;
  shape: LfoSettings['shape'] = 'sine';

  setup(l: LfoSettings, sr: number, g: EngineGlobals): void {
    this.amount = l.amount;
    this.shape = l.shape;
    if (l.tempo) {
      const steps = lfoTempoSteps(l.speed);
      const secPerStep = 60 / g.tempo / g.stepsPerBeat;
      this.inc = 1 / (steps * secPerStep * sr);
      this.delay = Math.round(envTempoSeconds(l.delay, g.tempo) * sr);
      this.attack = Math.round(envTempoSeconds(l.attack, g.tempo) * sr);
    } else {
      this.inc = lfoHz(l.speed) / sr;
      this.delay = Math.round(envSeconds(l.delay) * sr);
      this.attack = Math.round(envSeconds(l.attack) * sr);
    }
  }

  trigger(): void { this.phase = 0; this.t = 0; }

  /** Advance n samples, return -1..1 (shape x fade-in, without amount). */
  advance(n: number, sharedPhase?: number): number {
    this.t += n;
    if (this.t < this.delay) return 0;
    let p: number;
    if (sharedPhase !== undefined) p = sharedPhase;
    else {
      this.phase += this.inc * n;
      this.phase -= Math.floor(this.phase);
      p = this.phase;
    }
    let v: number;
    switch (this.shape) {
      case 'sine': v = Math.sin(2 * Math.PI * p); break;
      case 'triangle': v = p < 0.25 ? p * 4 : p < 0.75 ? 2 - p * 4 : p * 4 - 4; break;
      default: v = p < 0.5 ? 1 : -1;
    }
    const fade = this.attack > 0 ? Math.min(1, (this.t - this.delay) / this.attack) : 1;
    return v * fade;
  }
}

// --------------------------------------------------------------------- voice
/** A channel voice: the note-level state FL's channel keeps for every voice it plays. */
export class ChannelVoice {
  active = false;
  started = false;
  delay = 0;
  key = 60;
  color = 0;
  tag = -1;
  /** The Layer levels the voice follows (null: a note played on this channel itself). */
  tap: LayerTap | null = null;
  age = 0;
  untilRelease = Infinity;
  released = false;
  // forced stop with declick fade
  stopping = false;
  stopAt = 0; // frames until the fade starts
  stopGain = 1;
  stopStep = 0;
  // per note static values
  velGain = 1;
  vel = 100;
  rel = 64;
  notePan = 0;
  noteModX = 0;
  noteModY = 0;
  echoIndex = 0;
  echoGain = 1;
  echoPan = 0;
  echoCut = 0;
  echoRes = 0;
  /** Note length in samples (after the gate), Infinity for live notes. */
  length = Infinity;
  pitch = 0; // cents relative to root (note + fine + echo)
  glideTarget = 0;
  glideRate = 0; // cents per sample
  env: Env[] = TARGETS.map(() => new Env());
  lfo: Lfo[] = TARGETS.map(() => new Lfo());
  // INS filter
  fL = new SvfState(); fR = new SvfState(); fL2 = new SvfState(); fR2 = new SvfState();
  coefs = new SvfCoefs();
  gain = NaN;
  panL = NaN;
  panR = NaN;
}

interface HeldArpNote { key: number; vel: number; remaining: number; tag: number; tap: LayerTap | null }

/** Per-voice values that stay the same over one renderVoice call (see voiceBase). */
export interface VoiceBase {
  basePan: number;
  baseGain: number;
  baseModX: number;
  baseModY: number;
  mainPitchCents: number;
  /** Pitch the Layer adds to voices it triggered (cents). */
  tapCents: number;
}

/** A voice's levels for one control step (see controlStep). */
export interface ControlLevels {
  /** Pitch in cents relative to the root key, with glide, channel pitch, main pitch and INS pitch envelope / LFO. */
  cents: number;
  /** Gain: velocity x channel volume x MISC volume x echo x INS volume envelope / LFO. */
  amp: number;
  /** Clamped panning -1..1 and its circular-law gains. */
  pan: number;
  pL: number;
  pR: number;
  /** INS filter Mod X / Mod Y before clamping (the Sampler's cutoff / resonance positions). */
  mx: number;
  my: number;
}

export abstract class InstrumentChannel<V extends ChannelVoice = ChannelVoice> {
  readonly id: Id;
  readonly sampleRate: number;
  enabled = true;
  mixerTrack = 0;
  swingMix = 1;
  cutGroup = 0;
  cutBy = 0;
  s: SamplerSettings | null = null;
  protected voices: V[] = [];
  protected g!: EngineGlobals;
  protected chanVol = 1;
  protected chanPan = 0;
  protected chanPitchCents = 0;
  protected peak = 0;
  protected ageCounter = 0;
  protected lastPitch: number | null = null; // cents of the last played note (porta source)
  protected bufL: Float32Array;
  protected bufR: Float32Array;
  /** The INS tab applies (the Sampler; plugins FL shows the INS tab for). */
  protected insOn = true;
  protected filterOn = false;
  protected envOn = [false, false, false, false, false];
  protected lfoOn = [false, false, false, false, false];
  protected globalLfoPhase = [0, 0, 0, 0, 0];
  // arpeggiator
  private arpHeld: HeldArpNote[] = [];
  private arpCountdown = 0;
  private arpIndex = 0;
  private arpRepeat = 0;
  private arpDirUp = true;
  /** Scratch results of voiceBase / controlStep (no allocation per voice). */
  protected readonly vb: VoiceBase = { basePan: 0, baseGain: 1, baseModX: 0, baseModY: 0, mainPitchCents: 0, tapCents: 0 };
  protected readonly cl: ControlLevels = { cents: 0, amp: 1, pan: 0, pL: 1, pR: 0, mx: 0, my: 0 };

  constructor(id: Id, sampleRate: number, blockSize: number, makeVoice: () => V) {
    this.id = id;
    this.sampleRate = sampleRate;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(makeVoice());
    this.bufL = new Float32Array(blockSize);
    this.bufR = new Float32Array(blockSize);
  }

  setGlobals(g: EngineGlobals): void {
    this.g = g;
  }

  /** Sample interpolation for sample-playing channels (the Sampler); others ignore it. */
  setInterpolation(m: import('../model/sampler').InterpMode): void { void m; }

  /** New channel settings (the project model's channel). */
  abstract apply(c: Channel, samples: Map<Id, SampleData>): void;

  /** The sample pool changed (sample-playing channels re-resolve their sample). */
  refreshSample(samples: Map<Id, SampleData>): void { void samples; }

  /** The voice source can play (a Sampler with a sample, a plugin channel with its plugin). */
  protected abstract canPlay(): boolean;

  /** Source-specific start of a voice triggered by `trigger` (sample position, plugin voice parameters...). */
  protected abstract initVoice(v: V): void;

  /** Render one voice into the channel's buffers (n frames). */
  protected abstract renderVoice(v: V, s: SamplerSettings, outL: Float32Array, outR: Float32Array, n: number): void;

  /** After the voices of a block are rendered into the channel buffers (instrument plugins' own processing). */
  protected afterVoices(bl: Float32Array, br: Float32Array, n: number): void { void bl; void br; void n; }

  /**
   * Whether voices take note offs, mono hand-overs and cuts as a release (the
   * Sampler: with its volume envelope; else they stop with the declick fade).
   */
  protected releasable(): boolean {
    return this.envOn[VOL];
  }

  /** Fade-out time in ms of a forced stop (polyphony limit, mono without release, panic). */
  protected stopFadeMs(): number {
    return 10;
  }

  /** The voice ends now (its slot is free again). */
  protected endVoice(v: V): void {
    v.active = false;
  }

  /**
   * Channel settings every instrument shares (header, INS, MISC). The INS
   * envelopes, LFOs and filter count only when the INS tab applies.
   */
  protected applyChannel(c: Channel): void {
    this.enabled = c.enabled;
    if (!c.enabled) this.allNotesOff(false);
    this.mixerTrack = c.mixerTrack;
    const s = c.sampler;
    this.s = s;
    this.swingMix = s.swingMix;
    this.cutGroup = s.cutGroup;
    this.cutBy = s.cutBy;
    this.chanVol = channelVolumeToGain(c.volume);
    this.chanPan = c.pan;
    this.chanPitchCents = c.pitch * s.pitchRange * 100;
    const ev = s.envlfo;
    if (this.insOn) {
      this.envOn = [false, ev.vol.env.enabled, ev.modX.env.enabled && ev.modX.env.amount !== 0, ev.modY.env.enabled && ev.modY.env.amount !== 0, ev.pitch.env.enabled && ev.pitch.env.amount !== 0];
      this.lfoOn = TARGETS.map((t) => ev[t].lfo.amount !== 0);
      this.filterOn = !(s.filterType === 'fastlp' && s.modX >= 0.9999 && s.modY <= 0.0001) ||
        this.envOn[MODX] || this.envOn[MODY] || this.lfoOn[MODX] || this.lfoOn[MODY] ||
        s.adjModX !== 0 || s.adjModY !== 0 || s.velTrack.modX !== 0 || s.velTrack.modY !== 0 ||
        s.keyTrack.modX !== 0 || s.keyTrack.modY !== 0 || s.echo.cut !== 0 || s.echo.res !== 0;
    } else {
      this.envOn = [false, false, false, false, false];
      this.lfoOn = [false, false, false, false, false];
      this.filterOn = false;
    }
    if (s.arp.direction === 'off') this.arpHeld.length = 0;
  }

  isActive(): boolean {
    if (this.arpHeld.length) return true;
    for (const v of this.voices) if (v.active) return true;
    return false;
  }

  voiceCount(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  takePeak(): number {
    const p = this.peak;
    this.peak = 0;
    return p;
  }

  protected stepSamples(): number {
    return (60 / this.g.tempo / this.g.stepsPerBeat) * this.sampleRate;
  }

  // ------------------------------------------------------------- note control
  protected allocVoice(): V {
    for (const v of this.voices) if (!v.active) return v;
    let oldest = this.voices[0];
    for (const v of this.voices) if (v.age < oldest.age) oldest = v;
    this.endVoice(oldest);
    return oldest;
  }

  /** Force a voice to stop with the declick fade, `atFrame` frames from now. */
  protected forceStop(v: V, atFrame: number, fast = false): void {
    if (!v.active || v.stopping) return;
    if (v.delay > atFrame) { this.endVoice(v); return; } // never started
    const ms = fast ? 4 : this.stopFadeMs();
    v.stopping = true;
    v.stopAt = Math.max(0, atFrame - v.delay);
    v.stopGain = 1;
    v.stopStep = 1 / Math.max(1, (ms / 1000) * this.sampleRate);
  }

  /** Note-level release (cut groups): releasable voices release, others stop with declick. */
  cutVoices(atFrame: number): void {
    for (const v of this.voices) {
      if (!v.active) continue;
      if (this.releasable()) {
        if (!v.released) v.untilRelease = Math.min(v.untilRelease, atFrame);
      } else this.forceStop(v, atFrame, true);
    }
    this.arpHeld.length = 0;
  }

  allNotesOff(hard: boolean): void {
    for (const v of this.voices) {
      if (!v.active) continue;
      if (hard) this.forceStop(v, 0, true);
      else if (!v.released) v.untilRelease = 0;
    }
    this.arpHeld.length = 0;
  }

  /**
   * A pattern / song note. `tap` (a Layer's note) is the parent layer whose
   * live levels the voices follow; the note is otherwise played as if it were
   * this channel's own (key range, time shift, arpeggiator, echo...).
   */
  scheduleNote(n: SeqNote, frame: number, lenSamples: number, tap: LayerTap | null = null): void {
    const s = this.s;
    if (!s) return;
    if (n.key < s.keyLo || n.key > s.keyHi) return;
    // MISC > Time > SHIFT delays every note by up to one step
    const shift = s.shift > 0 ? Math.round(s.shift * this.stepSamples()) : 0;
    this.note(n.key, n.vel, n.pan, n.fine, n.modX, n.modY, n.color, frame + shift, lenSamples, -1, n.slide, n.porta, n.oneShot, n.rel, tap);
  }

  liveNoteOn(key: number, vel: number, tag: number, tap: LayerTap | null = null): void {
    this.note(key, vel, 64, 120, 128, 128, 0, 0, Infinity, tag, false, false, false, 64, tap);
  }

  liveNoteOff(key: number, tag: number): void {
    this.noteOffAt(key, tag, 0);
  }

  /**
   * A note on at `frame` of the current block that lasts until its note off
   * (notes from MIDI Out channels on the plugin's input port).
   */
  portNoteOn(key: number, vel: number, frame: number, tag: number): void {
    const s = this.s;
    if (!s || key < s.keyLo || key > s.keyHi) return;
    this.note(key, vel, 64, 120, 128, 128, 0, frame, Infinity, tag, false, false, false);
  }

  /** The note off of a portNoteOn / live note, `frame` samples into the current block. */
  noteOffAt(key: number, tag: number, frame: number): void {
    for (const v of this.voices) if (v.active && v.tag === tag && v.key === key && !v.released) v.untilRelease = Math.min(v.untilRelease, frame);
    const h = this.arpHeld.findIndex((a) => a.tag === tag && a.key === key);
    if (h >= 0) this.arpHeld.splice(h, 1);
  }

  private note(
    key: number, vel: number, pan: number, fine: number, modX: number, modY: number, color: number,
    frame: number, lenSamples: number, tag: number, slide: boolean, portaFlag: boolean, oneShot: boolean, rel = 64, tap: LayerTap | null = null,
  ): void {
    const s = this.s;
    if (!s || !this.canPlay()) return;
    // arpeggiator: collect held notes instead of playing them
    if (s.arp.direction !== 'off' && !slide) {
      this.arpHeld.push({ key, vel, remaining: frame + (lenSamples === Infinity ? Infinity : lenSamples), tag, tap });
      this.arpHeld.sort((a, b) => a.key - b.key);
      if (this.arpHeld.length === 1) { this.arpCountdown = frame; this.arpIndex = 0; this.arpRepeat = 0; this.arpDirUp = true; }
      return;
    }
    this.trigger(key, vel, pan, fine, modX, modY, color, frame, lenSamples, tag, slide, portaFlag, oneShot, 0, 0, rel, tap);
    // echo delay: extra voices, cumulative per echo
    const e = s.echo;
    if (e.feed > 0 && !slide) {
      const stepS = this.stepSamples();
      const dt = e.fat ? 0.0045 * this.sampleRate : e.time * stepS;
      for (let i = 1; i <= e.count; i++) {
        let p = e.pan * i;
        if (e.pingPong || e.fat) { p = e.fat ? (i % 2 ? 1 : -1) * Math.abs(e.pan || 0.3) * 0.5 : bounce(p); }
        this.trigger(key, vel, pan, fine, modX, modY, color, frame + Math.round(dt * i), lenSamples, tag, false, portaFlag, oneShot, i, p, rel, tap);
      }
    }
  }

  private trigger(
    key: number, vel: number, pan: number, fine: number, modX: number, modY: number, color: number,
    frame: number, lenSamples: number, tag: number, slide: boolean, portaFlag: boolean, oneShot: boolean,
    echoIndex: number, echoPan = 0, rel = 64, tap: LayerTap | null = null,
  ): void {
    const s = this.s!;
    const sr = this.sampleRate;
    const stepS = this.stepSamples();
    const cents = 100 * (key - s.rootKey) + (fine - 120) * 10 + s.fineTune + (echoIndex ? s.echo.pitch * echoIndex : 0);
    const slideTime = Math.max(1, slideSteps(s.slide) * stepS);

    // slide notes bend the sounding voices of the same colour group
    if (slide) {
      let top: V | null = null;
      for (const v of this.voices) if (v.active && !v.released && !v.stopping && v.color === color && (!top || v.key > top.key)) top = v;
      if (!top) return;
      const interval = cents - top.glideTarget;
      const dur = Math.max(1, lenSamples === Infinity ? slideTime : lenSamples);
      for (const v of this.voices) {
        if (!v.active || v.released || v.stopping || v.color !== color) continue;
        v.glideTarget += interval;
        v.glideRate = (v.glideTarget - v.pitch) / dur;
        if (v.delay > frame) v.glideRate = 0;
      }
      return;
    }

    // gate caps note length (porta notes ignore it with full porta)
    const usePorta = s.porta !== portaFlag;
    let len = lenSamples;
    const gate = gateSteps(s.gate);
    if (gate !== Infinity && !(usePorta && s.fullPorta)) len = Math.min(len, Math.max(1, gate * stepS));

    let glideFrom: number | null = null;
    if (s.mono) {
      // mono: release the sounding voice; overlapping notes glide into each other
      let cur: V | null = null;
      for (const v of this.voices) if (v.active && !v.stopping && !v.released && v.delay <= frame && (!cur || v.age > cur.age)) cur = v;
      for (const v of this.voices) {
        if (!v.active || v.stopping) continue;
        if (this.releasable()) v.untilRelease = Math.min(v.untilRelease, frame);
        else this.forceStop(v, frame);
      }
      if (cur) glideFrom = cur.pitch;
      else if (usePorta && this.lastPitch !== null) glideFrom = this.lastPitch;
    } else {
      if (usePorta && this.lastPitch !== null) glideFrom = this.lastPitch;
      if (s.polyMax > 0) {
        let count = 0;
        for (const v of this.voices) if (v.active && !v.stopping && !v.released) count++;
        while (count >= s.polyMax) {
          let oldest: V | null = null;
          for (const v of this.voices) if (v.active && !v.stopping && !v.released && (!oldest || v.age < oldest.age)) oldest = v;
          if (!oldest) break;
          this.forceStop(oldest, frame);
          count--;
        }
      }
    }

    const v = this.allocVoice();
    v.active = true;
    v.started = false;
    v.delay = Math.max(0, frame);
    v.key = key;
    v.color = color;
    v.tag = tag;
    v.tap = tap;
    v.age = ++this.ageCounter;
    // note-off matters only with the volume envelope or a loop; one-shot otherwise
    v.untilRelease = len === Infinity ? Infinity : frame + Math.max(1, len);
    v.length = len === Infinity ? Infinity : Math.max(1, len);
    v.released = false;
    v.stopping = false;
    v.stopGain = 1;
    v.vel = vel;
    v.rel = rel;
    v.velGain = velocityGain(vel);
    v.notePan = (pan - 64) / 64;
    v.noteModX = (modX - 128) / 128;
    v.noteModY = (modY - 128) / 128;
    v.echoIndex = echoIndex;
    v.echoGain = echoIndex ? Math.pow(2 * s.echo.feed, echoIndex) : 1;
    v.echoPan = echoPan;
    v.echoCut = echoIndex ? s.echo.cut * echoIndex : 0;
    v.echoRes = echoIndex ? s.echo.res * echoIndex : 0;
    v.pitch = glideFrom ?? cents;
    v.glideTarget = cents;
    v.glideRate = glideFrom !== null && glideFrom !== cents ? (cents - glideFrom) / slideTime : 0;
    v.gain = NaN;
    v.panL = NaN;
    v.panR = NaN;
    v.fL.reset(); v.fR.reset(); v.fL2.reset(); v.fR2.reset();
    for (let k = 0; k < 5; k++) {
      const el = s.envlfo[TARGETS[k]];
      v.env[k].setup(el.env, sr, this.g.tempo);
      v.env[k].trigger();
      v.lfo[k].setup(el.lfo, sr, this.g);
      if (!el.lfo.global) v.lfo[k].trigger();
    }
    this.initVoice(v);
    void oneShot;
    if (!echoIndex) this.lastPitch = cents;
  }

  // ------------------------------------------------------------ arpeggiator
  private runArp(n: number): void {
    const s = this.s!;
    const a = s.arp;
    // expire held notes
    for (const h of this.arpHeld) h.remaining -= n;
    while (this.arpCountdown < n && this.arpHeld.length) {
      const at = Math.max(0, this.arpCountdown);
      const live = this.arpHeld.filter((h) => h.remaining > at);
      if (!live.length) { this.arpHeld = this.arpHeld.filter((h) => h.remaining > 0); break; }
      // expand over octaves
      const keys: { key: number; vel: number; tap: LayerTap | null }[] = [];
      const range = Math.max(1, a.range);
      for (let o = 0; o < range; o++) for (const h of live) keys.push({ key: h.key + 12 * o, vel: h.vel, tap: h.tap });
      if (a.chord === 'autoSustain' && live.length === 1 && range === 1) {
        // monophonic lines pass through untouched
        const h = live[0];
        this.trigger(h.key, h.vel, 64, 120, 128, 128, 0, at, h.remaining - at, -1, false, false, false, 0, 0, 64, h.tap);
        h.remaining = 0;
        break;
      }
      const m = keys.length;
      let idx: number;
      switch (a.direction) {
        case 'down': idx = m - 1 - (this.arpIndex % m); break;
        case 'random': idx = Math.floor(Math.random() * m); break;
        case 'updown': case 'updownSticky': {
          const period = a.direction === 'updown' ? Math.max(1, 2 * m - 2) : 2 * m;
          const p = this.arpIndex % period;
          idx = a.direction === 'updown' ? (p < m ? p : period - p) : (p < m ? p : 2 * m - 1 - p);
          break;
        }
        default: idx = this.arpIndex % m;
      }
      const k = keys[Math.min(m - 1, Math.max(0, idx))];
      const stepLen = Math.max(1, a.time * this.stepSamples());
      const noteLen = Math.max(1, stepLen * Math.max(0.05, a.gate));
      this.trigger(k.key, k.vel, 64, 120, 128, 128, 0, at, noteLen, -1, false, a.slide, false, 0, 0, 64, k.tap);
      if (++this.arpRepeat >= Math.max(1, a.repeat)) { this.arpRepeat = 0; this.arpIndex++; }
      this.arpCountdown += stepLen;
    }
    this.arpCountdown -= n;
    this.arpHeld = this.arpHeld.filter((h) => h.remaining > 0);
    if (!this.arpHeld.length) this.arpCountdown = 0;
    void this.arpDirUp;
  }

  // ------------------------------------------------------------- voice levels
  /**
   * The per-voice values that stay the same over one render call: panning
   * (note, channel, MISC levels and tracking, echo), gain (channel volume,
   * MISC volume, velocity, echo), Mod X / Y (INS filter knobs, note, MISC,
   * tracking, echo) and the main pitch. Written to this.vb.
   */
  protected voiceBase(v: V, s: SamplerSettings): VoiceBase {
    const velOff = (x: number) => (x * (v.vel - s.velTrack.mid)) / 127;
    const keyOff = (x: number) => (x * (v.key - s.keyTrack.mid)) / 127;
    const b = this.vb;
    const tp = v.tap;
    b.basePan = v.notePan + this.chanPan + s.adjPan + velOff(s.velTrack.pan) + keyOff(s.keyTrack.pan) + v.echoPan + (tp ? tp.pan : 0);
    b.baseGain = this.chanVol * adjVolGain(s.adjVol) * v.velGain * v.echoGain * (tp ? tp.gain : 1);
    b.baseModX = s.modX + v.noteModX + s.adjModX + velOff(s.velTrack.modX) + keyOff(s.keyTrack.modX) + v.echoCut + (tp ? tp.modX : 0);
    b.baseModY = s.modY + v.noteModY + s.adjModY + velOff(s.velTrack.modY) + keyOff(s.keyTrack.modY) + v.echoRes + (tp ? tp.modY : 0);
    b.mainPitchCents = s.mainPitch ? this.g.mainPitch * 1200 : 0;
    b.tapCents = tp ? tp.cents : 0;
    return b;
  }

  /**
   * Advance a voice's INS envelopes, LFOs and glide by one control step of
   * `chunk` samples and compute its levels for that step (this.cl).
   */
  protected controlStep(v: V, s: SamplerSettings, b: VoiceBase, chunk: number): ControlLevels {
    const el = s.envlfo;
    const envVol = this.envOn[VOL] ? v.env[VOL].advance(chunk) : 1;
    const envX = this.envOn[MODX] ? v.env[MODX].advance(chunk) * el.modX.env.amount : 0;
    const envY = this.envOn[MODY] ? v.env[MODY].advance(chunk) * el.modY.env.amount : 0;
    const envP = this.envOn[PITCH] ? v.env[PITCH].advance(chunk) * el.pitch.env.amount : 0;
    const lfo = (k: number) => {
      if (!this.lfoOn[k]) return 0;
      const l = el[TARGETS[k]].lfo;
      return v.lfo[k].advance(chunk, l.global ? this.globalLfoPhase[k] : undefined) * l.amount;
    };
    const lP = lfo(PAN), lV = lfo(VOL), lX = lfo(MODX), lY = lfo(MODY), lPi = lfo(PITCH);

    if (v.glideRate !== 0) {
      v.pitch += v.glideRate * chunk;
      if ((v.glideRate > 0 && v.pitch >= v.glideTarget) || (v.glideRate < 0 && v.pitch <= v.glideTarget)) { v.pitch = v.glideTarget; v.glideRate = 0; }
    }
    const c = this.cl;
    c.cents = v.pitch + this.chanPitchCents + b.mainPitchCents + b.tapCents + (envP + lPi) * 2400;

    let amp = b.baseGain * envVol;
    // tremolo never exceeds unity: gain *= 1 - |amt| (1 - lfo') / 2, lfo' = lfo * sign(amt)
    if (lV !== 0 || this.lfoOn[VOL]) amp *= 1 - (Math.abs(el.vol.lfo.amount) - lV) / 2;
    c.amp = amp;
    let pan = b.basePan + lP;
    pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    c.pan = pan;
    const th = (pan + 1) * Math.PI / 4;
    c.pL = Math.cos(th);
    c.pR = Math.sin(th);
    c.mx = b.baseModX + envX + lX;
    c.my = b.baseModY + envY + lY;
    return c;
  }

  /** Set a voice's INS filter coefficients for clamped Mod X / Mod Y positions (filterOn). */
  protected setFilter(v: V, s: SamplerSettings, mx: number, my: number): void {
    mx = mx < 0 ? 0 : mx > 1 ? 1 : mx;
    my = my < 0 ? 0 : my > 1 ? 1 : my;
    let mode = SvfMode.LowPass;
    if (s.filterType === 'bp') mode = SvfMode.BandPass;
    else if (s.filterType === 'hp') mode = SvfMode.HighPass;
    else if (s.filterType === 'bs') mode = SvfMode.Notch;
    v.coefs.set(mode, filterCutoffHz(mx), filterQ(my), 0, this.sampleRate);
  }

  // ------------------------------------------------------------------ render
  render(outL: Float32Array, outR: Float32Array, n: number): void {
    const s = this.s;
    const bl = this.bufL, br = this.bufR;
    bl.fill(0, 0, n);
    br.fill(0, 0, n);
    if (s && this.canPlay()) {
      if (this.arpHeld.length) this.runArp(n);
      // shared (global) LFO phases
      for (let k = 0; k < 5; k++) {
        const l = s.envlfo[TARGETS[k]].lfo;
        if (l.global && l.amount !== 0) {
          const inc = l.tempo ? 1 / (lfoTempoSteps(l.speed) * (60 / this.g.tempo / this.g.stepsPerBeat) * this.sampleRate) : lfoHz(l.speed) / this.sampleRate;
          this.globalLfoPhase[k] = (this.globalLfoPhase[k] + inc * n) % 1;
        }
      }
      for (const v of this.voices) if (v.active) this.renderVoice(v, s, bl, br, n);
    }
    this.afterVoices(bl, br, n);
    let pk = this.peak;
    for (let i = 0; i < n; i++) {
      const L = bl[i], R = br[i];
      outL[i] += L;
      outR[i] += R;
      const a = Math.max(L < 0 ? -L : L, R < 0 ? -R : R);
      if (a > pk) pk = a;
    }
    this.peak = pk;
  }
}

function bounce(p: number): number {
  // reflect into -1..1 (ping pong pan)
  let x = p;
  for (let k = 0; k < 8 && (x > 1 || x < -1); k++) x = x > 1 ? 2 - x : -2 - x;
  return x;
}
