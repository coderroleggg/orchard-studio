// Audio Clips in the engine (docs/audio-clips.md): the Audio Clip channels and
// the audio clips of the Playlist. A clip is a window over its channel's
// sample: it starts at its Playlist tick (sample accurate), plays the sample
// from `offset` ticks in, and ends at its end tick. The channel's settings
// shape the sound the way they do for the Sampler: PITCH and time stretching
// in Resample mode change the play speed, the other stretch modes arrive as a
// ready-stretched sample (src/audio/audioClipSample.ts), the precomputed tools
// are already in the buffer, the declick mode fades the clip's cut edges, and
// VOL / PAN / the mixer track route the sound. Each clip adds its own fade
// handles and gain. Clips play in song mode only.
//
// Playlist time maps to the sample through the voice's tick clock (`tick` is
// the song tick of the voice's next frame), so a clip follows tempo changes,
// starts in the middle when the song is started or relocated inside it, and
// ends exactly at its end tick.

import type { Channel, Clip, Id, PlaylistTrack } from '../model/types';
import { declickTimes, type InterpMode, type SamplerSettings } from '../model/sampler';
import { clipGainLinear, crossfadeOverlaps, declickBleeds, fadeShape, resampleSpeed } from '../model/audioclip';
import { channelVolumeToGain } from '../model/scales';
import { getSincKernel, type SincKernel } from './dsp/sinc';
import { hermite6 } from './dsp/interp';
import type { EngineGlobals } from './protocol';
import type { SampleData } from './InstrumentChannel';

const MAX_VOICES = 64;
const EPS = 1e-6;

/** A playlist audio clip as the engine plays it. */
export interface CompiledAudioClip {
  id: Id;
  channelId: Id;
  track: number;
  start: number;
  end: number;
  /** Ticks into the sample (as the channel plays it) at the clip start. */
  offset: number;
  fadeIn: number;
  fadeOut: number;
  fadeInT: number;
  fadeOutT: number;
  /** Clip gain, linear. */
  gain: number;
  /**
   * The clip carries straight on into the next clip of its channel (that one starts where this one ends, at the matching place
   * in the sample, as after a slice): no declick at the seam, the sound just goes on.
   */
  seamEnd: boolean;
  seamStart: boolean;
}

/**
 * The audio clips that can sound: not muted, on an unmuted track. Sorted by
 * start. With `autoCrossfades` the clips of a track that overlap crossfade
 * over the overlap (the earlier one fades out, the later one in; a fade the
 * clip already has stays if it is longer).
 */
export function compileAudioClips(clips: Clip[], tracks: PlaylistTrack[], autoCrossfades = false): CompiledAudioClip[] {
  const out: CompiledAudioClip[] = [];
  for (const c of clips) {
    if (c.kind !== 'audio' || !c.channelId || c.muted) continue;
    const tr = tracks[c.track];
    if (tr && !tr.enabled) continue;
    const length = Math.max(0, c.length);
    if (length <= 0) continue;
    out.push({
      id: c.id, channelId: c.channelId, track: c.track, start: c.start, end: c.start + length, offset: Math.max(0, c.offset),
      fadeIn: Math.min(length, Math.max(0, c.fadeIn ?? 0)), fadeOut: Math.min(length, Math.max(0, c.fadeOut ?? 0)),
      fadeInT: c.fadeInTension ?? 0, fadeOutT: c.fadeOutTension ?? 0, gain: clipGainLinear(c.gain), seamEnd: false, seamStart: false,
    });
  }
  out.sort((a, b) => a.start - b.start);
  // seams: a clip that starts where another of the same channel and track ends, at the sample position that one reaches
  const endingAt = new Map<string, CompiledAudioClip[]>();
  for (const c of out) {
    const k = `${c.channelId}|${c.track}|${Math.round(c.end * 1000)}`;
    const l = endingAt.get(k);
    if (l) l.push(c); else endingAt.set(k, [c]);
  }
  for (const b of out) {
    const l = endingAt.get(`${b.channelId}|${b.track}|${Math.round(b.start * 1000)}`);
    const a = l?.find((x) => x !== b && Math.abs(x.offset + (x.end - x.start) - b.offset) < 1e-3);
    if (a) { a.seamEnd = true; b.seamStart = true; }
  }
  if (autoCrossfades) crossfadeOverlaps(out);
  return out;
}

class ClipVoice {
  active = false;
  /** The clip being played ('' / null: an audition of the whole sample). */
  clipId: Id = '';
  clip: CompiledAudioClip | null = null;
  tag = -1;
  /** Read position in the channel's buffer (frames). */
  pos = 0;
  /** Frames until the voice starts, counted from the start of the next block. */
  delay = 0;
  /** Song tick of the voice's first frame still to render. */
  tick = 0;
  /** Frames to add to the clip's remaining time so that it ends on a whole frame (the nearest to its end tick, as the start). */
  endAdj = 0;
  /** Declick fade-in of a clip that starts inside its sample. */
  fadeIn = 0;
  fadeInLen = 0;
  stopping = false;
  stopAt = 0;
  stopGain = 1;
  stopStep = 0;
  /** Levels of the previous block (the ramp start); NaN: none yet. */
  gain = NaN;
  panL = NaN;
  panR = NaN;
  age = 0;
}

function at(d: Float32Array, i: number, frames: number): number {
  return i >= 0 && i < frames ? d[i] : 0;
}

/** One Audio Clip channel: its sample and settings, and the voices of its clips that are sounding. */
export class AudioClipChannel {
  readonly id: Id;
  enabled = true;
  mixerTrack = 0;
  s: SamplerSettings | null = null;
  sample: SampleData | null = null;
  private sampleId: Id | null = null;
  /** Channel volume as a gain, pan -1..1, header PITCH in cents. */
  private vol = 1;
  private pan = 0;
  private pitchCents = 0;
  readonly voices: ClipVoice[] = [];
  readonly bufL: Float32Array;
  readonly bufR: Float32Array;
  private peak = 0;
  private age = 0;
  private interp: InterpMode = 'sinc24';
  private kernel: SincKernel | null = getSincKernel(24);

  constructor(id: Id, private readonly sampleRate: number, blockSize: number) {
    this.id = id;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new ClipVoice());
    this.bufL = new Float32Array(blockSize);
    this.bufR = new Float32Array(blockSize);
  }

  setInterpolation(m: InterpMode): void {
    this.interp = m;
    this.kernel = m.startsWith('sinc') ? getSincKernel(parseInt(m.slice(4), 10)) : null;
  }

  apply(c: Channel, samples: Map<Id, SampleData>, g: EngineGlobals): void {
    const s = c.sampler;
    this.enabled = c.enabled;
    this.mixerTrack = c.mixerTrack;
    this.s = s;
    this.vol = channelVolumeToGain(c.volume);
    this.pan = c.pan;
    this.pitchCents = c.pitch * s.pitchRange * 100;
    if (!c.enabled) this.stopAll(0, 10);
    this.sampleId = s.sampleId;
    this.refreshSample(samples, g);
  }

  /** The sample pool changed (or the channel got a new buffer): voices keep their place in the song. */
  refreshSample(samples: Map<Id, SampleData>, g: EngineGlobals): void {
    const next = this.sampleId ? samples.get(this.sampleId) ?? null : null;
    const changed = next !== this.sample;
    this.sample = next;
    if (!changed) return;
    for (const v of this.voices) {
      if (!v.active) continue;
      if (!next) { v.active = false; continue; }
      // a re-rendered sample (reverse, stretch...): carry on at the same place in the song; an audition has no place
      if (v.clip) v.pos = this.posAt(v.clip, v.tick, g);
      else v.active = false;
    }
  }

  isActive(): boolean {
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

  /** Source frames the sample advances per engine frame (pitch, Resample-mode speed, sample rate). */
  rate(g: EngineGlobals): number {
    const smp = this.sample, s = this.s;
    if (!smp || !s || smp.frames === 0) return 1;
    const cents = this.pitchCents + (s.mainPitch ? g.mainPitch * 1200 : 0);
    const speed = resampleSpeed(smp.frames / smp.sampleRate, s, g.tempo);
    return (smp.sampleRate / this.sampleRate) * Math.pow(2, cents / 1200) * speed;
  }

  /** Read position of the sample at song tick `tick` of a clip. */
  private posAt(clip: CompiledAudioClip, tick: number, g: EngineGlobals): number {
    const smp = this.sample;
    if (!smp) return 0;
    const secPerTick = 60 / (g.tempo * g.ppq);
    const seconds = Math.max(0, clip.offset + (tick - clip.start)) * secPerTick;
    return seconds * this.sampleRate * this.rate(g);
  }

  private alloc(): ClipVoice {
    for (const v of this.voices) if (!v.active) return v;
    let oldest = this.voices[0];
    for (const v of this.voices) if (v.age < oldest.age) oldest = v;
    return oldest;
  }

  /**
   * Start a clip at the (fractional) frame `exactFrame` of the block that is about to render, where the song is at tick
   * `tick` (>= the clip start); `fpt` is the number of frames in a tick. The voice starts on the nearest whole frame and
   * ends on the whole frame nearest to its clip's end tick, so clips that follow each other tile without overlap or gap.
   */
  startClip(clip: CompiledAudioClip, exactFrame: number, tick: number, fpt: number, g: EngineGlobals): void {
    const smp = this.sample, s = this.s;
    if (!this.enabled || !smp || !s || smp.frames === 0) return;
    for (const v of this.voices) if (v.active && v.clipId === clip.id && !v.stopping) return; // already sounding
    const v = this.alloc();
    v.active = true;
    v.clipId = clip.id;
    v.clip = clip;
    v.tag = -1;
    v.age = ++this.age;
    v.stopping = false;
    v.stopAt = 0;
    v.stopGain = 1;
    v.gain = NaN; v.panL = NaN; v.panR = NaN;
    const frame = Math.max(0, Math.round(exactFrame));
    v.delay = frame;
    // the tick of the frame the voice really starts on, and the whole frame its clip ends on
    v.tick = tick + (frame - exactFrame) / fpt;
    const endExact = exactFrame + (clip.end - tick) * fpt;
    v.endAdj = Math.round(endExact) - endExact;
    let pos = this.posAt(clip, tick, g);
    // at the original speed a fractional start is rounded to a whole frame: the clip plays the sample's own values
    if (Math.abs(this.rate(g) - 1) < 1e-9) pos = Math.round(pos);
    v.pos = pos;
    // a clip that starts inside its sample fades in over the channel's declick-in time (none in the default mode, Out only)
    const inMs = declickTimes(s.declick)[0];
    if (pos > 0.5 && inMs > 0 && !clip.seamStart) {
      v.fadeInLen = Math.max(1, Math.round((inMs / 1000) * this.sampleRate));
      v.fadeIn = v.fadeInLen;
    } else {
      v.fadeInLen = 0;
      v.fadeIn = 0;
    }
  }

  /** Audition the whole sample (Channel Rack click, previews). */
  startPreview(tag: number): void {
    const smp = this.sample;
    if (!this.enabled || !smp || smp.frames === 0) return;
    for (const v of this.voices) if (v.active && !v.clip && !v.stopping) this.stopVoice(v, 0, 4);
    const v = this.alloc();
    v.active = true;
    v.clipId = '';
    v.clip = null;
    v.tag = tag;
    v.age = ++this.age;
    v.stopping = false;
    v.stopAt = 0;
    v.stopGain = 1;
    v.gain = NaN; v.panL = NaN; v.panR = NaN;
    v.delay = 0;
    v.tick = 0;
    v.pos = 0;
    v.fadeIn = 0;
    v.fadeInLen = 0;
  }

  /** Fade a voice out starting `atFrame` frames into the block that is about to render. */
  private stopVoice(v: ClipVoice, atFrame: number, ms: number): void {
    if (!v.active || v.stopping) return;
    if (v.delay > atFrame) { v.active = false; return; } // it never started
    v.stopping = true;
    v.stopAt = Math.max(0, atFrame); // a frame of the block that is about to render (a voice that starts later in it fades from there)
    v.stopGain = 1;
    v.stopStep = 1 / Math.max(1, (ms / 1000) * this.sampleRate);
  }

  stopAll(atFrame: number, ms: number): void {
    for (const v of this.voices) this.stopVoice(v, atFrame, ms);
  }

  /** A clip that is not there any more (deleted, muted, on a muted track): its voice fades out. */
  stopClip(id: Id): void {
    for (const v of this.voices) if (v.active && v.clipId === id) this.stopVoice(v, 0, 10);
  }

  // ------------------------------------------------------------------ render
  private readSample(data: Float32Array, pos: number, frames: number, inc: number): number {
    const ip = Math.floor(pos);
    const fr = pos - ip;
    switch (this.interp) {
      case 'linear': {
        const a = at(data, ip, frames), b = at(data, ip + 1, frames);
        return a + (b - a) * fr;
      }
      case 'hermite6':
        return hermite6(at(data, ip - 2, frames), at(data, ip - 1, frames), at(data, ip, frames), at(data, ip + 1, frames), at(data, ip + 2, frames), at(data, ip + 3, frames), fr);
      default:
        if (fr === 0 && inc <= 1) return at(data, ip, frames);
        return this.kernel ? this.kernel.read(data, pos, inc) : at(data, ip, frames);
    }
  }

  /**
   * Render the voices into bufL / bufR (n frames, overwritten). `fpt` is the
   * number of frames in a tick.
   */
  render(n: number, fpt: number, g: EngineGlobals): void {
    const bl = this.bufL, br = this.bufR;
    bl.fill(0, 0, n);
    br.fill(0, 0, n);
    const smp = this.sample, s = this.s;
    if (smp && s && smp.frames > 0) {
      const rate = Math.max(1e-9, this.rate(g));
      const outLen = Math.max(1, Math.round((declickTimes(s.declick)[1] / 1000) * this.sampleRate));
      const bleed = declickBleeds(s.declick);
      for (const v of this.voices) if (v.active) this.renderVoice(v, smp, n, fpt, rate, outLen, bleed, bl, br);
    } else {
      for (const v of this.voices) v.active = false;
    }
    let pk = this.peak;
    for (let i = 0; i < n; i++) {
      const a = Math.max(bl[i] < 0 ? -bl[i] : bl[i], br[i] < 0 ? -br[i] : br[i]);
      if (a > pk) pk = a;
    }
    this.peak = pk;
  }

  private renderVoice(
    v: ClipVoice, smp: SampleData, n: number, fpt: number, rate: number, outLen: number, bleeds: boolean, bl: Float32Array, br: Float32Array,
  ): void {
    let i0 = 0;
    if (v.delay > 0) {
      if (v.delay >= n) { v.delay -= n; return; }
      i0 = v.delay;
      v.delay = 0;
    }
    const clip = v.clip;
    const frames = smp.frames;
    const dataL = smp.channels[0];
    const stereo = smp.channels.length > 1;
    const dataR = stereo ? smp.channels[1] : dataL;
    // frames from the voice's first frame to its clip's end tick (negative once past it); the clip may have been resized meanwhile
    let framesLeft = Infinity;
    // the clip cuts the sample before its end (a trimmed clip): the declick fades the cut out (a clip with a fade out of its own
    // is silent at its end anyway), else the sample just ends
    let cut = false;
    if (clip) {
      framesLeft = (clip.end - v.tick) * fpt + v.endAdj;
      cut = clip.fadeOut <= 0 && !clip.seamEnd && framesLeft < (frames - v.pos) / rate - 1;
    }
    // bleeding declick modes carry the sound on past the clip end while it fades out
    const bleed = cut && bleeds;
    let iEnd = n;
    if (clip) {
      const total = framesLeft + (bleed ? outLen : 0);
      if (total <= EPS) { v.active = false; return; }
      iEnd = Math.min(n, i0 + Math.max(1, Math.ceil(total - EPS)));
    }
    const a1 = this.vol * (clip ? clip.gain : 1);
    const a0 = Number.isNaN(v.gain) ? a1 : v.gain;
    const pan = this.pan;
    // Audio Clips are not attenuated at the centre (the Sampler's circular law takes 3 dB off there): a balance
    const pL = pan > 0 ? 1 - pan : 1, pR = pan < 0 ? 1 + pan : 1;
    const pl0 = Number.isNaN(v.panL) ? pL : v.panL, pr0 = Number.isNaN(v.panR) ? pR : v.panR;
    const len = Math.max(1, iEnd - i0);
    const da = (a1 - a0) / len, dpl = (pL - pl0) / len, dpr = (pR - pr0) / len;
    let pos = v.pos;
    let ended = false;
    const tick0 = v.tick;
    const invFpt = 1 / fpt;
    for (let i = i0; i < iEnd; i++) {
      if (pos >= frames) { ended = true; break; }
      const k = i - i0;
      let gain = a0 + da * k;
      if (v.fadeIn > 0) {
        gain *= 0.5 - 0.5 * Math.cos(Math.PI * (1 - v.fadeIn / v.fadeInLen));
        v.fadeIn--;
      }
      if (clip) {
        const tk = tick0 + k * invFpt;
        const tin = tk - clip.start;
        if (clip.fadeIn > 0 && tin < clip.fadeIn) gain *= fadeShape(tin / clip.fadeIn, clip.fadeInT);
        const rem = clip.end - tk;
        if (clip.fadeOut > 0 && rem < clip.fadeOut) gain *= fadeShape(rem / clip.fadeOut, clip.fadeOutT);
        if (cut) {
          const left = framesLeft - k;
          if (bleed) { if (left < 0) gain *= 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, -left / outLen)); }
          else if (left < outLen) gain *= 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, left / outLen));
        }
      }
      if (v.stopping && i >= v.stopAt) {
        gain *= 0.5 + 0.5 * Math.cos(Math.PI * (1 - v.stopGain));
        v.stopGain -= v.stopStep;
        if (v.stopGain <= 0) { ended = true; break; }
      }
      const xl = this.readSample(dataL, pos, frames, rate);
      const xr = stereo ? this.readSample(dataR, pos, frames, rate) : xl;
      bl[i] += xl * gain * (pl0 + dpl * k);
      br[i] += xr * gain * (pr0 + dpr * k);
      pos += rate;
    }
    v.pos = pos;
    v.gain = a1;
    v.panL = pL;
    v.panR = pR;
    v.tick = tick0 + (n - i0) * invFpt;
    if (v.stopping) v.stopAt = Math.max(0, v.stopAt - n);
    if (ended || (clip && iEnd < n)) v.active = false;
  }
}

/** The Audio Clip channels and the Playlist's audio clips: scheduling and rendering. */
export class AudioClipPlayer {
  readonly channels = new Map<Id, AudioClipChannel>();
  /** Removed channels that fade their voices out before they go. */
  private retired: { ch: AudioClipChannel; left: number }[] = [];
  clips: CompiledAudioClip[] = [];
  private byId = new Map<Id, CompiledAudioClip>();
  private g: EngineGlobals = { tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 };
  private interp: InterpMode = 'sinc24';

  constructor(private readonly sampleRate: number, private readonly blockSize: number) {}

  setGlobals(g: EngineGlobals): void { this.g = g; }

  setInterpolation(m: InterpMode): void {
    this.interp = m;
    for (const ch of this.channels.values()) ch.setInterpolation(m);
  }

  has(id: Id): boolean { return this.channels.has(id); }

  setChannel(c: Channel, samples: Map<Id, SampleData>): void {
    let ch = this.channels.get(c.id);
    if (!ch) {
      ch = new AudioClipChannel(c.id, this.sampleRate, this.blockSize);
      ch.setInterpolation(this.interp);
      this.channels.set(c.id, ch);
    }
    ch.apply(c, samples, this.g);
  }

  /** Automation moved a channel control: same as setChannel for an existing channel. */
  apply(c: Channel, samples: Map<Id, SampleData>): void {
    this.channels.get(c.id)?.apply(c, samples, this.g);
  }

  removeChannel(id: Id): void {
    const ch = this.channels.get(id);
    if (!ch) return;
    this.channels.delete(id);
    ch.stopAll(0, 10);
    this.retired.push({ ch, left: Math.round(this.sampleRate * 0.05) });
  }

  refreshSamples(samples: Map<Id, SampleData>): void {
    for (const ch of this.channels.values()) ch.refreshSample(samples, this.g);
  }

  /** The Playlist changed: compile its audio clips; sounding clips follow their edits, and the ones that are gone fade out. */
  setClips(clips: Clip[], tracks: PlaylistTrack[], autoCrossfades = false): void {
    this.clips = compileAudioClips(clips, tracks, autoCrossfades);
    this.byId = new Map(this.clips.map((c) => [c.id, c]));
    for (const ch of this.channels.values()) {
      for (const v of ch.voices) {
        if (!v.active || !v.clipId) continue;
        const k = this.byId.get(v.clipId);
        if (k && k.channelId === ch.id) v.clip = k;
        else ch.stopClip(v.clipId);
      }
    }
  }

  isActive(): boolean {
    for (const ch of this.channels.values()) if (ch.isActive()) return true;
    return this.retired.length > 0;
  }

  voiceCount(): number {
    let n = 0;
    for (const ch of this.channels.values()) n += ch.voiceCount();
    return n;
  }

  takePeak(id: Id): number {
    return this.channels.get(id)?.takePeak() ?? 0;
  }

  // -------------------------------------------------------------- scheduling
  /** Start the clips whose start lies in the song-tick window [t0, t1); `frameAtT0` is the block frame of t0. */
  startWindow(t0: number, t1: number, frameAtT0: number, fpt: number): void {
    const a = t0 - EPS, b = t1 - EPS;
    for (const c of this.clips) {
      if (c.start >= b) break;
      if (c.start < a) continue;
      const ch = this.channels.get(c.channelId);
      if (ch) ch.startClip(c, frameAtT0 + (c.start - t0) * fpt, c.start, fpt, this.g);
    }
  }

  /** The clips that are already under way at song tick `t` (song start or relocation inside a clip) start there. */
  startSounding(t: number, frame: number, fpt: number): void {
    for (const c of this.clips) {
      if (c.start >= t - EPS) break;
      if (c.end <= t + EPS) continue;
      const ch = this.channels.get(c.channelId);
      if (ch) ch.startClip(c, frame, t, fpt, this.g);
    }
  }

  /** Playback jumped (loop wrap) or stopped: the voices fade out from `frame`. */
  stopAll(frame = 0, ms = 10): void {
    for (const ch of this.channels.values()) ch.stopAll(frame, ms);
  }

  // ------------------------------------------------------------------ preview
  previewOn(id: Id, tag: number): boolean {
    const ch = this.channels.get(id);
    if (!ch) return false;
    ch.startPreview(tag);
    return true;
  }

  // ------------------------------------------------------------------ render
  /** Render every sounding channel; `sink` adds a channel's block to its mixer track. */
  render(n: number, fpt: number, sink: (track: number, l: Float32Array, r: Float32Array, n: number) => void): void {
    for (const ch of this.channels.values()) {
      if (!ch.isActive()) continue;
      ch.render(n, fpt, this.g);
      sink(ch.mixerTrack, ch.bufL, ch.bufR, n);
    }
    if (this.retired.length) {
      for (const r of this.retired) {
        if (r.ch.isActive()) { r.ch.render(n, fpt, this.g); sink(r.ch.mixerTrack, r.ch.bufL, r.ch.bufR, n); }
        r.left -= n;
      }
      this.retired = this.retired.filter((r) => r.left > 0 && r.ch.isActive());
    }
  }
}
