// The audio engine. Pure TypeScript with no DOM dependencies so it can run in
// an AudioWorklet, in a Worker for offline rendering, or in Node for tests.

import type { Channel, Id, MixerTrack, Pattern } from '../model/types';
import type { EngineGlobals, FromEngine, ToEngine } from './protocol';
import { MixerEngine } from './Mixer';
import { SamplerChannel, type SampleData } from './Sampler';
import { GenChannel } from './GenChannel';
import type { InstrumentChannel, LayerTap } from './InstrumentChannel';
import { LayerChannel } from './LayerChannel';
import type { GenContext, GenEnv } from './gen/types';
import { MidiOutChannel, type PortNote } from './MidiOut';
import { channelOfSlot, channelSlotId } from '../model/gen/ids';
import {
  collectPatternWindow, collectSongWindow, collectSongSounding, collectSounding, compileClips, compilePattern, songLength,
  type CompiledClip, type CompiledPattern, type SeqNote,
} from './Sequencer';
import { ticksPerBar, ticksPerStep } from '../model/timing';
import { AutomationRuntime, type AutoUpdate } from './Automation';
import { denormalize, setPath, targetKey, type AutomationTarget } from '../model/automation';
import { faderToGain } from '../model/scales';
import { compileFormula, FORMULA_GLOBALS, type FormulaEnv, type FormulaFn } from '../model/formula';
import { smoothTimeMs, type ControllerLink } from '../model/links';

export const MIXER_TRACKS = 127; // master + 125 inserts + "current"

/** A compiled remote control link (model/links.ts). */
interface LinkRuntime {
  link: ControllerLink;
  key: string;
  /** Mapping formula (null: 1:1, or an invalid formula). */
  fn: FormulaFn | null;
  /** The formula reads time or random values: re-evaluate every block. */
  dynamic: boolean;
  /** Last controller value read (NaN: none yet). */
  lastIn: number;
  /** Mapped (and smoothed) normalised value. */
  value: number;
  /** Smoothing time constant in seconds (0 = off). */
  smoothSec: number;
  /** Smoothing still moving toward the mapped value. */
  moving: boolean;
  /** Mapped value before smoothing. */
  goal: number;
}

export interface EngineOptions {
  sampleRate: number;
  blockSize?: number;
  post?: (msg: FromEngine, transfer?: Transferable[]) => void;
  /** How often (frames) to post status / meters. */
  statusInterval?: number;
  /** Offline render (project WAV export): effects see FxContext.rendering = true. */
  rendering?: boolean;
  /** Random numbers 0 <= x < 1 for Layer channels' Random mode (default Math.random; tests inject a seeded one). */
  random?: () => number;
}

export class Engine {
  readonly sampleRate: number;
  readonly blockSize: number;
  private post: (msg: FromEngine, transfer?: Transferable[]) => void;

  globals: EngineGlobals = { tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 };
  samples = new Map<Id, SampleData>();
  /** Instrument channels: Sampler channels and instrument plugin channels (GenChannel). */
  channels = new Map<Id, InstrumentChannel>();
  /** Channels whose generator was replaced: they fade their voices out, then go (see retireChannel). */
  private retiredChannels: { ch: InstrumentChannel; left: number }[] = [];
  /** Per-block context for instrument plugins (tempo, transport, export flag). */
  private genCtx: GenContext;
  /** Sample pool lookup for instrument plugins. */
  private genEnv: GenEnv;
  /** MIDI Out channels: their notes go to the effects listening on their ports. */
  midiOuts = new Map<Id, MidiOutChannel>();
  /** Removed MIDI Out channels that still owe note offs (flushed in the next block). */
  private retiredMidiOuts: MidiOutChannel[] = [];
  /** Layer channels: their notes are handed to their children (instrument channels, MIDI Out) at once. */
  layers = new Map<Id, LayerChannel>();
  private random: () => number;
  /** This block's note events from the MIDI Out channels (pooled objects, `noteCount` used). */
  private noteBus: PortNote[] = [];
  private noteCount = 0;
  /** Plugin state changes waiting to be posted to the host ([slot id, path, value]). */
  private fxStatePending: [string, string, unknown][] = [];
  /** Every channel id in rack order (samplers and MIDI Out). */
  channelOrder: Id[] = [];
  private rawPatterns = new Map<Id, Pattern>();
  patterns = new Map<Id, CompiledPattern>();
  private rawClips: { tracks: import('../model/types').PlaylistTrack[]; clips: import('../model/types').Clip[] } = { tracks: [], clips: [] };
  clips: CompiledClip[] = [];
  songLen = 384 * 4;
  mixer: MixerEngine;
  /** Playlist automation clips. */
  automation = new AutomationRuntime();
  /** Song position of the last block's automation update (a step back without a seek is a loop wrap). */
  private autoTick = 0;
  /** Working copies of the last received models (automation writes into these). */
  private chModels = new Map<Id, Channel>();
  private mxModels: (MixerTrack | undefined)[] = [];
  private dirtyCh = new Set<Id>();
  private dirtyMx = new Set<number>();
  private dirtyFx = new Map<string, { track: number; slot: number }>();
  private dirtyGlobals = false;
  /** Remote control links (controller plugin outputs driving parameters). */
  private links: LinkRuntime[] = [];
  /** Last model value a link applied, per target key (change detection; reported to the UI). */
  readonly linkCurrent = new Map<string, number>();
  private linkChanged = new Set<string>();
  /** Mixer slot locations by slot id (rebuilt when mixer tracks change). */
  private slotLoc: Map<string, { track: number; slot: number }> | null = null;
  private linkEnv: FormulaEnv = {};

  // transport
  playing = false;
  songMode = false;
  patternId: Id = '';
  pos = 0; // ticks
  loopStart = 0;
  loopEnd = 0; // song mode selection loop; <= loopStart disables
  metronome = false;
  repeatClips = false;
  /** "Play truncated notes": on the next block, start notes already sounding at the position. */
  private pendingTruncated = false;
  interp: import('../model/sampler').InterpMode = 'sinc24';
  private metroPhase = 0;
  private metroEnv = 0;
  private metroFreq = 0;

  frame = 0;
  private statusCountdown = 0;
  private statusInterval: number;
  private mixerPeaks: Float32Array;
  private tmpL: Float32Array;
  private tmpR: Float32Array;
  private watchedSlot: Id | null = null;
  private spectrumCountdown = 0;
  private fxMonitorCountdown = 0;
  private cpuAcc = 0;
  private cpuFrames = 0;
  private lastCpu = 0;
  private dirtyPatterns = true;

  constructor(opts: EngineOptions) {
    this.sampleRate = opts.sampleRate;
    this.blockSize = opts.blockSize ?? 128;
    this.random = opts.random ?? Math.random;
    this.post = opts.post ?? (() => {});
    this.statusInterval = opts.statusInterval ?? Math.round(this.sampleRate / 60);
    this.mixer = new MixerEngine(MIXER_TRACKS, this.sampleRate, this.blockSize, !!opts.rendering);
    this.mixer.env = {
      sample: (id) => {
        const s = this.samples.get(id);
        return s ? { channels: s.channels, sampleRate: s.sampleRate } : undefined;
      },
    };
    this.mixerPeaks = new Float32Array(MIXER_TRACKS * 2);
    this.tmpL = new Float32Array(this.blockSize);
    this.tmpR = new Float32Array(this.blockSize);
    this.genCtx = {
      sampleRate: this.sampleRate, blockSize: this.blockSize, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0,
      rendering: !!opts.rendering,
    };
    this.genEnv = this.mixer.env;
    this.genCtx.out = (track, L, R, n) => {
      const tr = this.mixer.tracks[track];
      if (!tr) return;
      const dl = tr.chL, dr = tr.chR;
      for (let i = 0; i < n; i++) { dl[i] += L[i]; dr[i] += R[i]; }
      tr.hasChannelInput = true;
    };
  }

  // ------------------------------------------------------------------ messages
  handle(msg: ToEngine): void {
    switch (msg.t) {
      case 'globals': {
        const prev = this.globals;
        this.globals = msg.g;
        this.automation.ppq = msg.g.ppq;
        // automation keeps control of automated globals while the song plays
        if (this.autoActive()) for (const [t, v] of this.automation.targetsOn('global', '')) setPath(this.globals, t.path, v);
        if (prev.swing !== msg.g.swing || prev.ppq !== msg.g.ppq || prev.beatsPerBar !== msg.g.beatsPerBar || prev.stepsPerBeat !== msg.g.stepsPerBeat) {
          this.dirtyPatterns = true;
        }
        for (const ch of this.channels.values()) ch.setGlobals(this.globals);
        break;
      }
      case 'channel': this.setChannel(msg.c); break;
      case 'channelRemove': {
        this.channels.delete(msg.id);
        this.retireMidiOut(msg.id);
        this.retireLayer(msg.id);
        this.chModels.delete(msg.id);
        this.channelOrder = this.channelOrder.filter((id) => id !== msg.id);
        this.dirtyPatterns = true;
        break;
      }
      case 'pattern': this.rawPatterns.set(msg.p.id, msg.p); this.dirtyPatterns = true; break;
      case 'patternRemove': this.rawPatterns.delete(msg.id); this.patterns.delete(msg.id); this.dirtyPatterns = true; break;
      case 'playlist':
        this.rawClips = { tracks: msg.tracks, clips: msg.clips };
        this.repeatClips = !!msg.repeatClips;
        this.recompileClips();
        this.automation.setPlaylist(msg.clips, msg.tracks);
        if (this.songMode) this.chaseAutomation('edit');
        break;
      case 'automation':
        this.automation.setSources(msg.list);
        this.automation.setInit(msg.init ?? []);
        if (this.songMode) this.chaseAutomation('edit');
        break;
      case 'autoRelease':
        // controls moved by hand while the song plays: their clips let go of them until the next play
        if (this.playing && this.songMode) this.automation.release(msg.keys);
        break;
      case 'mixerTrack': {
        const tr = msg.tr;
        this.mxModels[tr.index] = tr;
        if (this.autoActive()) {
          for (const [t, v] of this.automation.targetsOn('mixer', String(tr.index))) setPath(tr, t.path, v);
          for (const sl of tr.slots) if (sl) for (const [t, v] of this.automation.targetsOn('fx', sl.id)) setPath(sl, t.path, v);
        }
        this.mixer.setTrack(tr);
        this.slotLoc = null;
        break;
      }
      case 'sample': {
        this.samples.set(msg.id, { channels: msg.data, sampleRate: msg.sampleRate, frames: msg.data[0]?.length ?? 0 });
        for (const ch of this.channels.values()) ch.refreshSample(this.samples);
        break;
      }
      case 'sampleRemove': {
        this.samples.delete(msg.id);
        for (const ch of this.channels.values()) ch.refreshSample(this.samples);
        break;
      }
      case 'play': this.play(); break;
      case 'pause': this.pause(); break;
      case 'stop': this.stop(); break;
      case 'mode': {
        if (this.songMode !== msg.song) {
          this.releaseAll();
          this.pos = msg.song ? this.loopStartTick() : 0;
        }
        this.songMode = msg.song;
        this.patternId = msg.patternId;
        if (this.songMode) this.chaseAutomation('seek');
        if (!this.songMode && this.playing) {
          const len = this.currentPatternLength();
          if (this.pos >= len) this.pos = this.pos % len;
        }
        break;
      }
      case 'seek': {
        this.releaseAll();
        this.pos = Math.max(0, msg.tick);
        this.pendingTruncated = this.playing;
        // automated controls jump to the automation value at the new position
        if (this.songMode) this.chaseAutomation('seek');
        break;
      }
      case 'noteOn': {
        // live notes (typing keyboard, preview keyboards, MIDI input): Layer, MIDI Out, Sampler and instrument channels
        const mo = this.midiOuts.get(msg.ch);
        if (mo) mo.liveNoteOn(msg.key, msg.vel, msg.tag);
        else {
          const ly = this.layers.get(msg.ch);
          if (ly) ly.liveNoteOn(msg.key, msg.vel, msg.tag);
          else this.channels.get(msg.ch)?.liveNoteOn(msg.key, msg.vel, msg.tag);
        }
        break;
      }
      case 'noteOff': {
        const mo = this.midiOuts.get(msg.ch);
        if (mo) mo.liveNoteOff(msg.key, msg.tag);
        else {
          const ly = this.layers.get(msg.ch);
          if (ly) ly.liveNoteOff(msg.key, msg.tag);
          else this.channels.get(msg.ch)?.liveNoteOff(msg.key, msg.tag);
        }
        break;
      }
      case 'allNotesOff':
        // layers release the live notes they handed on, then the children stop
        for (const ly of this.layers.values()) ly.allNotesOff();
        for (const ch of this.channels.values()) {
          if (ch instanceof GenChannel) ch.panic();
          else ch.allNotesOff(true);
        }
        // panic: MIDI Out channels send their note offs, every effect forgets its notes
        for (const mo of this.midiOuts.values()) mo.allNotesOff();
        this.mixer.allNotesOff();
        break;
      case 'metronome': this.metronome = msg.on; break;
      case 'interp': {
        this.interp = msg.mode;
        for (const ch of this.channels.values()) ch.setInterpolation(msg.mode);
        break;
      }
      case 'watchSpectrum': this.watchedSlot = msg.slotId; break;
      case 'watchFx': this.mixer.watched = new Set(msg.ids); break;
      case 'mixerSelect': this.mixer.currentSource = msg.index; break;
      case 'loop': this.loopStart = msg.start; this.loopEnd = msg.end; break;
      case 'links': this.setLinks(msg.list); break;
      case 'mouse': FORMULA_GLOBALS.mouseX = msg.x; FORMULA_GLOBALS.mouseY = msg.y; break;
      case 'ping': this.post({ t: 'pong', id: msg.id }); break;
    }
  }

  private setChannel(c: Channel): void {
    this.chModels.set(c.id, c);
    if (this.autoActive()) for (const [t, v] of this.automation.targetsOn('channel', c.id)) setPath(c, t.path, v);
    // a channel that is no longer a layer releases the live notes it handed on
    if (c.kind !== 'layer' && this.layers.has(c.id)) { this.retireLayer(c.id); this.dirtyPatterns = true; }
    if (c.kind === 'layer') {
      // a channel that changed kind drops its old engine (its voices fade out)
      const old = this.channels.get(c.id);
      if (old) { this.channels.delete(c.id); this.retireChannel(old); this.dirtyPatterns = true; }
      if (this.midiOuts.has(c.id)) { this.retireMidiOut(c.id); this.dirtyPatterns = true; }
      let ly = this.layers.get(c.id);
      const enabledChanged = !ly || ly.enabled !== c.enabled;
      if (!ly) {
        ly = new LayerChannel(c.id, {
          channels: this.channels,
          midiOuts: this.midiOuts,
          play: (ch, n, frame, len, tap) => this.playOn(ch, n, frame, len, tap),
        }, this.random);
        this.layers.set(c.id, ly);
      }
      ly.apply(c);
      if (!this.channelOrder.includes(c.id)) this.channelOrder.push(c.id);
      if (enabledChanged) this.dirtyPatterns = true;
      return;
    }
    if (c.kind === 'midiout') {
      // a channel that changed kind drops its old engine (its voices fade out)
      const old = this.channels.get(c.id);
      if (old) { this.channels.delete(c.id); this.retireChannel(old); this.dirtyPatterns = true; }
      let mo = this.midiOuts.get(c.id);
      const enabledChanged = !mo || mo.enabled !== c.enabled;
      if (!mo) { mo = new MidiOutChannel(c.id); this.midiOuts.set(c.id, mo); }
      mo.apply(c);
      if (!this.channelOrder.includes(c.id)) this.channelOrder.push(c.id);
      if (enabledChanged) this.dirtyPatterns = true;
      return;
    }
    if (this.midiOuts.has(c.id)) { this.retireMidiOut(c.id); this.dirtyPatterns = true; }
    let ch = this.channels.get(c.id);
    // an instrument channel plays its plugin; anything else is a Sampler
    const plugin = c.kind === 'plugin' && c.plugin ? c.plugin.id : null;
    if (ch && (plugin ? !(ch instanceof GenChannel) || ch.plugin !== plugin : ch instanceof GenChannel)) {
      // the channel's generator changed (kind or plugin): the old engine fades its voices out and goes
      this.channels.delete(c.id);
      this.retireChannel(ch);
      ch = undefined;
      this.dirtyPatterns = true;
    }
    const enabledChanged = !ch || ch.enabled !== c.enabled;
    if (!ch) {
      ch = plugin
        ? new GenChannel(c.id, this.sampleRate, this.blockSize, plugin, this.genEnv, this.genCtx)
        : new SamplerChannel(c.id, this.sampleRate, this.blockSize);
      ch.setGlobals(this.globals);
      ch.setInterpolation(this.interp);
      this.channels.set(c.id, ch);
    }
    const swingChanged = ch.swingMix !== c.sampler.swingMix;
    ch.apply(c, this.samples);
    if (!this.channelOrder.includes(c.id)) this.channelOrder.push(c.id);
    if (enabledChanged || swingChanged) this.dirtyPatterns = true;
  }

  /** A channel engine replaced by another generator: its voices stop with the fast declick, then it is dropped. */
  private retireChannel(ch: InstrumentChannel): void {
    if (ch instanceof GenChannel) ch.panic();
    else ch.allNotesOff(true);
    // at most 50 ms (controllers and other always-on plugins never go idle by themselves)
    this.retiredChannels.push({ ch, left: Math.round(this.sampleRate * 0.05) });
  }

  /** A removed (or no longer MIDI Out) channel releases its notes in the next block. */
  private retireMidiOut(id: Id): void {
    const mo = this.midiOuts.get(id);
    if (!mo) return;
    this.midiOuts.delete(id);
    mo.allNotesOff();
    this.retiredMidiOuts.push(mo);
  }

  /** A removed (or no longer Layer) channel releases the live notes it handed on to its children. */
  private retireLayer(id: Id): void {
    const ly = this.layers.get(id);
    if (!ly) return;
    this.layers.delete(id);
    ly.allNotesOff();
  }

  private compileAll(): void {
    const g = this.globals;
    const barT = ticksPerBar(g);
    const swing = {
      global: g.swing,
      ticksPerStep: ticksPerStep(g),
      channelMix: (id: Id) => this.channels.get(id)?.swingMix ?? this.chModels.get(id)?.sampler?.swingMix ?? 1,
    };
    const enabled = (id: Id) => this.channels.get(id)?.enabled ?? this.midiOuts.get(id)?.enabled ?? this.layers.get(id)?.enabled ?? false;
    this.patterns.clear();
    for (const p of this.rawPatterns.values()) this.patterns.set(p.id, compilePattern(p, barT, swing, enabled));
    this.recompileClips();
    this.dirtyPatterns = false;
  }

  private recompileClips(): void {
    this.clips = compileClips(this.rawClips.clips, this.rawClips.tracks);
    this.songLen = songLength(this.rawClips.clips, ticksPerBar(this.globals));
  }

  // ----------------------------------------------------------------- transport
  private loopStartTick(): number {
    return this.loopEnd > this.loopStart ? this.loopStart : 0;
  }

  currentPatternLength(): number {
    if (this.dirtyPatterns) this.compileAll();
    return this.patterns.get(this.patternId)?.length ?? ticksPerBar(this.globals);
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.pendingTruncated = true;
    this.automation.reclaim(); // controls taken over by hand follow their clips again
    if (this.songMode) this.chaseAutomation('play');
  }

  /** Automation overrides automated controls while the song plays. */
  private autoActive(): boolean {
    return this.songMode && this.playing && this.automation.size > 0;
  }

  /** Apply automation values for the current position. */
  private chaseAutomation(mode: AutoUpdate): void {
    if (this.automation.size === 0) return;
    this.automation.update(this.pos, this.applyAuto, mode);
    this.flushAuto();
  }

  private applyAuto = (t: AutomationTarget, raw: number): void => {
    switch (t.scope) {
      case 'channel': {
        const m = this.chModels.get(t.id);
        if (m && setPath(m, t.path, raw)) this.dirtyCh.add(t.id);
        break;
      }
      case 'mixer': {
        const i = Number(t.id);
        const m = this.mxModels[i];
        if (m && setPath(m, t.path, raw)) this.dirtyMx.add(i);
        break;
      }
      case 'fx': {
        for (const m of this.mxModels) {
          if (!m) continue;
          const k = m.slots.findIndex((sl) => sl?.id === t.id);
          if (k < 0) continue;
          if (setPath(m.slots[k], t.path, raw)) this.dirtyFx.set(t.id, { track: m.index, slot: k });
          break;
        }
        break;
      }
      case 'global':
        if (setPath(this.globals, t.path, raw)) this.dirtyGlobals = true;
        break;
    }
  };

  private flushAuto(): void {
    for (const id of this.dirtyCh) {
      // channel scope: channel controls, Sampler / MISC / INS settings and instrument parameters (plugin.params.<key>)
      const m = this.chModels.get(id);
      const ch = this.channels.get(id);
      if (m && ch) ch.apply(m, this.samples);
      else if (m) { this.midiOuts.get(id)?.apply(m); this.layers.get(id)?.apply(m); }
    }
    for (const i of this.dirtyMx) {
      const m = this.mxModels[i];
      if (m) this.mixer.applyLevels(m);
    }
    for (const loc of this.dirtyFx.values()) {
      const sl = this.mxModels[loc.track]?.slots[loc.slot];
      if (sl) this.mixer.applySlot(loc.track, loc.slot, sl);
    }
    if (this.dirtyGlobals) {
      for (const ch of this.channels.values()) ch.setGlobals(this.globals);
      this.dirtyPatterns = true; // swing may have changed
    }
    this.dirtyCh.clear();
    this.dirtyMx.clear();
    this.dirtyFx.clear();
    this.dirtyGlobals = false;
  }

  pause(): void {
    this.playing = false;
    this.releaseAll();
  }

  stop(): void {
    this.playing = false;
    this.releaseAll();
    this.pos = this.songMode ? this.loopStartTick() : 0;
  }

  private releaseAll(): void {
    for (const ly of this.layers.values()) ly.allNotesOff();
    for (const ch of this.channels.values()) ch.allNotesOff(false);
    for (const mo of this.midiOuts.values()) mo.allNotesOff();
  }

  // ------------------------------------------------------------------- render
  private dispatch = (n: SeqNote, frame: number, len: number): void => {
    const ch = this.channels.get(n.chId);
    if (!ch) {
      const lenSamples = Math.max(1, Math.round(len * this.samplesPerTick()));
      // a Layer hands the note on to its children (a muted layer plays nothing)
      const ly = this.layers.get(n.chId);
      if (ly) { if (ly.enabled) ly.scheduleNote(n, frame, lenSamples); return; }
      const mo = this.midiOuts.get(n.chId);
      if (mo && mo.enabled) mo.scheduleNote(n, frame, lenSamples);
      return;
    }
    if (!ch.enabled) return;
    this.playOn(ch, n, frame, Math.max(1, Math.round(len * this.samplesPerTick())), null);
  };

  /**
   * Play a pattern / song note on an instrument channel: its cut group first
   * (this channel's Cut releases every channel whose Cut by matches; "Cut
   * itself" (same channel) only applies to step-sequencer notes), then the
   * channel's own note handling. `tap` is the Layer whose notes these are (its
   * children play them whatever their own ON switch says: the switch applies
   * to a channel's own steps and piano roll only).
   */
  private playOn(ch: InstrumentChannel, n: SeqNote, frame: number, lenSamples: number, tap: LayerTap | null): void {
    if (ch.cutGroup > 0 && !n.slide) {
      for (const other of this.channels.values()) {
        if (other.cutBy !== ch.cutGroup) continue;
        if (other === ch && !n.oneShot) continue;
        other.cutVoices(frame);
      }
    }
    ch.scheduleNote(n, frame, lenSamples, tap);
  }

  samplesPerTick(): number {
    const g = this.globals;
    return (this.sampleRate * 60) / (g.tempo * g.ppq);
  }

  private scheduleBlock(n: number): void {
    if (this.songMode && this.automation.size > 0) {
      // the position stepped back without a seek: a song / selection loop wrap, i.e. a relocation
      // (initialized values apply again, then the clips are chased)
      this.automation.update(this.pos, this.applyAuto, this.pos < this.autoTick ? 'seek' : 'block');
      this.flushAuto();
    }
    this.autoTick = this.pos;
    if (this.dirtyPatterns) this.compileAll();
    const spt = this.samplesPerTick();
    const fpt = spt; // frames per tick
    let frame = 0;
    let guard = 0;
    if (this.pendingTruncated) {
      this.pendingTruncated = false;
      if (this.songMode) collectSongSounding(this.clips, this.patterns, this.pos, 0, this.dispatch);
      else {
        const cp = this.patterns.get(this.patternId);
        if (cp && this.pos > 0) collectSounding(cp, this.pos, 0, this.dispatch);
      }
    }
    while (frame < n && guard++ < 64) {
      let loopStart: number, loopEnd: number;
      if (this.songMode) {
        if (this.loopEnd > this.loopStart) { loopStart = this.loopStart; loopEnd = this.loopEnd; }
        else { loopStart = 0; loopEnd = this.songLen; }
      } else {
        loopStart = 0;
        loopEnd = this.currentPatternLength();
      }
      if (this.pos >= loopEnd || this.pos < loopStart && this.songMode && this.loopEnd > this.loopStart) {
        this.pos = loopStart;
      }
      const framesLeft = n - frame;
      const framesToLoop = (loopEnd - this.pos) * fpt;
      const seg = Math.min(framesLeft, Math.max(1, Math.ceil(framesToLoop)));
      const t0 = this.pos;
      const t1 = Math.min(loopEnd, t0 + seg / fpt);
      if (this.songMode) {
        collectSongWindow(this.clips, this.patterns, t0, t1, frame, fpt, this.dispatch, this.repeatClips);
      } else {
        const cp = this.patterns.get(this.patternId);
        if (cp) collectPatternWindow(cp, t0, t1, frame, fpt, this.dispatch);
      }
      if (this.metronome) this.scheduleMetronome(t0, t1, frame, fpt);
      this.pos = t0 + seg / fpt;
      if (this.pos >= loopEnd - 1e-7) {
        const over = this.pos - loopEnd;
        this.pos = over > 1e-7 ? loopStart + over : loopStart;
        if (this.songMode && loopStart > 0) collectSongSounding(this.clips, this.patterns, loopStart, frame + seg, this.dispatch);
        if (over > 1e-7) {
          // The loop end fell between two frames, so this segment ran past it by a fraction of a
          // frame (kept, so loops do not drift): events in [loopStart, loopStart + over), such as
          // a step on the loop's first tick, belong to this segment, at the loop point's frame.
          const f0 = frame + (loopEnd - t0) * fpt;
          if (this.songMode) {
            collectSongWindow(this.clips, this.patterns, loopStart, loopStart + over, f0, fpt, this.dispatch, this.repeatClips);
          } else {
            const cp = this.patterns.get(this.patternId);
            if (cp) collectPatternWindow(cp, loopStart, loopStart + over, f0, fpt, this.dispatch);
          }
          if (this.metronome) this.scheduleMetronome(loopStart, loopStart + over, f0, fpt);
        }
      }
      frame += seg;
    }
  }

  private metroQueue: { frame: number; accent: boolean }[] = [];

  private scheduleMetronome(t0: number, t1: number, frameAtT0: number, fpt: number): void {
    const ppq = this.globals.ppq;
    let beat = Math.ceil(t0 / ppq - 1e-9);
    for (let t = beat * ppq; t < t1; t += ppq, beat++) {
      this.metroQueue.push({ frame: Math.round(frameAtT0 + (t - t0) * fpt), accent: beat % this.globals.beatsPerBar === 0 });
    }
  }

  private renderMetronome(L: Float32Array, R: Float32Array, n: number): void {
    let qi = 0;
    const sr = this.sampleRate;
    for (let i = 0; i < n; i++) {
      while (qi < this.metroQueue.length && this.metroQueue[qi].frame <= i) {
        const ev = this.metroQueue[qi++];
        this.metroEnv = 1;
        this.metroPhase = 0;
        this.metroFreq = ev.accent ? 1760 : 1320;
      }
      if (this.metroEnv > 1e-4) {
        const s = Math.sin(this.metroPhase) * this.metroEnv * 0.35;
        this.metroPhase += (2 * Math.PI * this.metroFreq) / sr;
        this.metroEnv *= Math.exp(-1 / (0.012 * sr));
        L[i] += s; R[i] += s;
      }
    }
    // events that fall exactly on the block end carry over
    const rest = this.metroQueue.slice(qi).map((e) => ({ frame: e.frame - n, accent: e.accent }));
    this.metroQueue = rest;
  }

  /** Render `n` frames (n <= blockSize) into outL / outR. */
  process(outL: Float32Array, outR: Float32Array, n: number): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const statusTick = this.pos;
    if (this.playing) this.scheduleBlock(n);
    this.collectNotes(n);
    if (this.noteCount) this.deliverPortNotes();
    this.mixer.beginBlock(n);
    const gc = this.genCtx;
    gc.tempo = this.globals.tempo; gc.ppq = this.globals.ppq; gc.playing = this.playing; gc.pos = statusTick; gc.songMode = this.songMode;
    for (const id of this.channelOrder) {
      const ch = this.channels.get(id);
      if (!ch) continue;
      if (!ch.isActive()) continue;
      this.renderChannel(ch, n);
    }
    if (this.retiredChannels.length) {
      for (const r of this.retiredChannels) { if (r.ch.isActive()) this.renderChannel(r.ch, n); r.left -= n; }
      this.retiredChannels = this.retiredChannels.filter((r) => r.left > 0 && r.ch.isActive());
    }
    this.mixer.setTransport(this.globals.tempo, this.globals.ppq, this.playing, statusTick, this.songMode);
    // MIDI Out notes reach the effects listening on their ports, sample-accurately
    this.mixer.deliverNotes(this.noteBus, this.noteCount, n);
    this.mixer.process(outL, outR, n);
    this.collectFxState();
    // controller plugins have produced this block's outputs: linked parameters follow (from the next block)
    if (this.links.length) this.applyLinks(n);
    if (this.metroQueue.length || this.metroEnv > 1e-4) this.renderMetronome(outL, outR, n);
    // main volume (transport knob): same law as the mixer faders
    const mv = mainVolumeGain(this.globals.mainVolume);
    if (mv !== 1) for (let i = 0; i < n; i++) { outL[i] *= mv; outR[i] *= mv; }

    this.frame += n;
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.cpuAcc += t1 - t0;
    this.cpuFrames += n;
    if (this.cpuFrames >= this.sampleRate / 4) {
      this.lastCpu = this.cpuAcc / ((this.cpuFrames / this.sampleRate) * 1000);
      this.cpuAcc = 0;
      this.cpuFrames = 0;
    }
    this.statusCountdown -= n;
    if (this.statusCountdown <= 0) {
      this.statusCountdown = this.statusInterval;
      this.postStatus(statusTick);
    }
    if (this.mixer.watched.size) {
      this.fxMonitorCountdown -= n;
      if (this.fxMonitorCountdown <= 0) {
        this.fxMonitorCountdown = Math.round(this.sampleRate / 30);
        const items = this.mixer.monitor();
        // instrument editors watch "ch:<channel id>"
        for (const id of this.mixer.watched) {
          const chId = channelOfSlot(id);
          const g = chId !== null ? this.channels.get(chId) : undefined;
          if (!(g instanceof GenChannel)) continue;
          const d = g.monitor();
          if (d) items.push([id, d]);
        }
        if (items.length) this.post({ t: 'fxMonitor', items });
      }
    }
    if (this.watchedSlot) {
      this.spectrumCountdown -= n;
      if (this.spectrumCountdown <= 0) {
        this.spectrumCountdown = Math.round(this.sampleRate / 30);
        this.postSpectrum();
      }
    }
  }

  /** Render an instrument channel into its mixer track's channel input. */
  private renderChannel(ch: InstrumentChannel, n: number): void {
    this.tmpL.fill(0, 0, n);
    this.tmpR.fill(0, 0, n);
    ch.render(this.tmpL, this.tmpR, n);
    const tr = this.mixer.tracks[ch.mixerTrack] ?? this.mixer.tracks[0];
    const dl = tr.chL, dr = tr.chR, sl = this.tmpL, sr = this.tmpR;
    for (let i = 0; i < n; i++) { dl[i] += sl[i]; dr[i] += sr[i]; }
    tr.hasChannelInput = true;
  }

  /**
   * MIDI Out notes on an instrument channel's MIDI input port play it, at
   * their sample (a note off releases the note of the same key and MIDI channel).
   */
  private deliverPortNotes(): void {
    let gens: GenChannel[] | null = null;
    for (const ch of this.channels.values()) if (ch instanceof GenChannel && ch.midiPort >= 0) (gens ??= []).push(ch);
    if (!gens) return;
    const bus = this.noteBus;
    for (let i = 0; i < this.noteCount; i++) {
      const e = bus[i];
      for (const g of gens) {
        if (g.midiPort !== e.port) continue;
        const tag = -1000 - e.chan;
        if (e.on) g.portNoteOn(e.key, e.vel, e.frame, tag);
        else g.noteOffAt(e.key, tag, e.frame);
      }
    }
  }

  // ------------------------------------------------------------- MIDI notes
  private emitNote = (port: number, frame: number, on: boolean, key: number, vel: number, chan: number): void => {
    let e = this.noteBus[this.noteCount];
    if (!e) { e = { port: 0, frame: 0, on: false, key: 0, vel: 0, chan: 1 }; this.noteBus.push(e); }
    e.port = port; e.frame = frame; e.on = on; e.key = key; e.vel = vel; e.chan = chan;
    this.noteCount++;
  };

  /** This block's note events of the MIDI Out channels, in time order (note offs first at a frame). */
  private collectNotes(n: number): void {
    this.noteCount = 0;
    if (this.retiredMidiOuts.length) {
      for (const mo of this.retiredMidiOuts) mo.collect(n, this.emitNote);
      this.retiredMidiOuts = this.retiredMidiOuts.filter((mo) => mo.isActive());
    }
    for (const mo of this.midiOuts.values()) mo.collect(n, this.emitNote);
    if (this.noteCount > 1) {
      // channels emit in order; merge them by frame (stable, note offs before note ons)
      const bus = this.noteBus;
      for (let i = 1; i < this.noteCount; i++) {
        const e = bus[i];
        let j = i - 1;
        while (j >= 0 && (bus[j].frame > e.frame || (bus[j].frame === e.frame && bus[j].on && !e.on))) { bus[j + 1] = bus[j]; j--; }
        bus[j + 1] = e;
      }
    }
  }

  /** Plugin state the plugins changed by themselves: kept in the engine's slot / channel copies, posted to the host. */
  private collectFxState(): void {
    const out = this.fxStatePending;
    const n0 = out.length;
    this.mixer.takeStateChanges(out);
    for (let i = n0; i < out.length; i++) {
      const [slotId, path, v] = out[i];
      for (const m of this.mxModels) {
        const sl = m?.slots.find((x) => x?.id === slotId);
        if (sl) { writeParam(sl.params as Record<string, unknown>, path, v); break; }
      }
    }
    // instrument plugins: "ch:<channel id>"
    for (const ch of this.channels.values()) {
      if (!(ch instanceof GenChannel)) continue;
      const list = ch.takeStateChanges();
      if (!list) continue;
      const params = this.chModels.get(ch.id)?.plugin?.params;
      for (const [path, v] of list) {
        if (params) writeParam(params as Record<string, unknown>, path, v);
        out.push([channelSlotId(ch.id), path, v]);
      }
    }
  }

  private postStatus(tick: number): void {
    this.mixer.takePeaks(this.mixerPeaks);
    const chPeaks = new Float32Array(this.channelOrder.length);
    let voices = 0;
    this.channelOrder.forEach((id, i) => {
      const ch = this.channels.get(id);
      if (!ch) {
        const mo = this.midiOuts.get(id);
        if (mo) chPeaks[i] = mo.takePeak();
        else chPeaks[i] = this.layers.get(id)?.takePeak() ?? 0;
        return;
      }
      chPeaks[i] = ch.takePeak();
      voices += ch.voiceCount();
    });
    if (this.fxStatePending.length) {
      this.post({ t: 'fxState', items: this.fxStatePending });
      this.fxStatePending = [];
    }
    this.post({
      t: 'status',
      playing: this.playing,
      tick,
      frame: this.frame,
      songMode: this.songMode,
      patternId: this.patternId,
      mixerPeaks: this.mixerPeaks.slice(),
      channelPeaks: chPeaks,
      channelIds: this.channelOrder.slice(),
      voices,
      cpu: this.lastCpu,
      auto: this.takeAutoChanges(),
    });
  }

  private takeAutoChanges(): [string, number][] | undefined {
    const ch = this.automation.changed;
    const lc = this.linkChanged;
    if (ch.size === 0 && lc.size === 0) return undefined;
    const out: [string, number][] = [];
    for (const key of ch) {
      if (lc.has(key)) continue; // a linked target reports its link value
      const v = this.automation.current.get(key);
      if (v !== undefined) out.push([key, v]);
    }
    for (const key of lc) {
      const v = this.linkCurrent.get(key);
      if (v !== undefined) out.push([key, v]);
    }
    ch.clear();
    lc.clear();
    return out;
  }

  // ------------------------------------------------------------------- links
  /**
   * Remote control links. A linked parameter follows its controller: every
   * block, after the mixer has run the controller plugins, each link reads its
   * controller output (EffectInstance.controls()), maps it through its formula
   * and, when the result changed, applies it through the automation path
   * (applyAuto / flushAuto). Links work in song and pattern mode, playing or
   * stopped. Automation clips of a linked parameter are ignored while it is
   * linked (AutomationRuntime.setLinked). As in FL a value is sent only when
   * the controller output changes, so a control moved by hand keeps its new
   * position until the controller moves again.
   */
  private setLinks(list: ControllerLink[]): void {
    const prev = new Map(this.links.map((l) => [l.link.id, l]));
    this.links = [];
    for (const link of list) {
      if (!link.source) continue; // MIDI links are applied by the UI thread
      const c = compileFormula(link.formula || 'Input');
      const old = prev.get(link.id);
      const sameMapping = !!old && old.link.formula === link.formula && old.link.source?.slotId === link.source.slotId &&
        old.link.source?.output === link.source.output;
      this.links.push({
        link,
        key: targetKey(link.target),
        fn: c.ok ? c.fn : null,
        dynamic: c.ok && c.dynamic,
        // a changed mapping is re-applied at once
        lastIn: sameMapping ? old!.lastIn : NaN,
        value: old ? old.value : NaN,
        goal: old ? old.goal : NaN,
        // one pole settling to 95% within FL's smoothing time
        smoothSec: link.smooth ? smoothTimeMs(link.smoothTime ?? 469) / 3000 : 0,
        moving: false,
      });
    }
    const keys = new Set(this.links.map((l) => l.key));
    // forget values of targets that are no longer linked
    for (const k of [...this.linkCurrent.keys()]) if (!keys.has(k)) this.linkCurrent.delete(k);
    this.automation.setLinked(keys);
  }

  private slotRuntime(slotId: string) {
    if (!this.slotLoc) {
      this.slotLoc = new Map();
      this.mixer.tracks.forEach((t, ti) => t.slots.forEach((sl, si) => { if (sl) this.slotLoc!.set(sl.id, { track: ti, slot: si }); }));
    }
    const loc = this.slotLoc.get(slotId);
    if (!loc) return undefined;
    const sl = this.mixer.tracks[loc.track]?.slots[loc.slot];
    if (!sl || sl.id !== slotId) { this.slotLoc = null; return undefined; }
    return sl;
  }

  /** Controller outputs of an effect slot, or of an instrument channel ("ch:<channel id>"). */
  private controlsOf(slotId: string): ArrayLike<number> | undefined {
    const chId = channelOfSlot(slotId);
    if (chId !== null) {
      const g = this.channels.get(chId);
      return g instanceof GenChannel ? g.controls() : undefined;
    }
    return this.slotRuntime(slotId)?.fx.controls?.();
  }

  private applyLinks(n: number): void {
    const env = this.linkEnv;
    env.songTime = this.pos / this.globals.ppq;
    env.tempo = this.globals.tempo;
    env.time = Date.now(); // the formula language's Time: system time in ms
    let any = false;
    for (const lr of this.links) {
      const src = lr.link.source!;
      const outs = this.controlsOf(src.slotId);
      if (!outs) continue;
      const v = outs[src.output];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (v !== lr.lastIn || lr.dynamic) {
        lr.lastIn = v;
        let m = v;
        if (lr.fn) { env.input = v; m = lr.fn(env); }
        lr.goal = m > 1 ? 1 : m >= 0 ? m : 0; // FL cuts the formula output off at 0..1 (NaN -> 0)
        if (lr.smoothSec > 0 && Number.isFinite(lr.value)) lr.moving = true;
        else lr.value = lr.goal;
      } else if (!lr.moving) continue;
      if (lr.moving) {
        const k = 1 - Math.exp(-n / (this.sampleRate * lr.smoothSec));
        lr.value += (lr.goal - lr.value) * k;
        if (Math.abs(lr.goal - lr.value) < 1e-5) { lr.value = lr.goal; lr.moving = false; }
      }
      const model = denormalize(lr.link.target, lr.value);
      const prev = this.linkCurrent.get(lr.key);
      if (prev !== undefined && Math.abs(prev - model) <= 1e-9 * Math.max(1, Math.abs(model))) continue;
      this.linkCurrent.set(lr.key, model);
      this.linkChanged.add(lr.key);
      this.applyAuto(lr.link.target, model);
      any = true;
    }
    if (any) this.flushAuto();
  }


  private postSpectrum(): void {
    const id = this.watchedSlot;
    if (!id) return;
    for (const t of this.mixer.tracks) {
      for (const s of t.slots) {
        if (s && s.id === id && s.fx.analyser) {
          const a = s.fx.analyser;
          a.watched = true;
          const N = a.buffer.length;
          const data = new Float32Array(N);
          // unroll the ring buffer, oldest first
          for (let i = 0; i < N; i++) data[i] = a.buffer[(a.write + i) % N];
          this.post({ t: 'spectrum', slotId: id, data, sampleRate: this.sampleRate }, [data.buffer]);
          return;
        }
      }
    }
  }

  /** Convenience for offline rendering / tests. */
  renderOffline(frames: number): [Float32Array, Float32Array] {
    const L = new Float32Array(frames), R = new Float32Array(frames);
    const bL = new Float32Array(this.blockSize), bR = new Float32Array(this.blockSize);
    for (let off = 0; off < frames; off += this.blockSize) {
      const n = Math.min(this.blockSize, frames - off);
      this.process(bL, bR, n);
      L.set(bL.subarray(0, n), off);
      R.set(bR.subarray(0, n), off);
    }
    return [L, R];
  }

  getMixerTrack(i: number): MixerTrack | undefined { void i; return undefined; }
}

/** Write a value at a dotted path inside a plugin state (creating the last key). */
function writeParam(params: Record<string, unknown>, path: string, v: unknown): void {
  const keys = path.split('.');
  let o: Record<string, unknown> = params;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = o[keys[i]];
    if (!next || typeof next !== 'object') return;
    o = next as Record<string, unknown>;
  }
  o[keys[keys.length - 1]] = v;
}

export function mainVolumeGain(v: number): number {
  // Transport main volume knob: 0.8 = 0 dB, same curve as mixer faders.
  return faderToGain(v);
}
