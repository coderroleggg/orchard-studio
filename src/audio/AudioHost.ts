// Main-thread side of the audio engine: owns the AudioContext + worklet node,
// mirrors project changes into the engine, and receives status / meters.

import workletUrl from '../engine/worklet.ts?worker&url';
import type { Channel, Project, Id, MixerTrack } from '../model/types';
import type { EngineGlobals, FromEngine, ToEngine } from '../engine/protocol';
import { prepareSample, onSamplesChanged, isPrepared, forgetProcessedKey, getRaw } from './samples';
import { isAudioClipPrepared, prepareAudioClipSample } from './audioClipSample';
import { followsTempo, usesStretcher } from '../model/audioclip';
import { slotSampleRefs } from './engineSamples';
import { allFx } from '../model/fx/hosted';
import { allGens, channelOfSlot } from '../model/gen/ids';
import { live, emitLive } from './live';
import { AudioInput } from './AudioInput';
import { getPath, setPath, targetKey, type AutomationTarget } from '../model/automation';
import type { FxMonitor } from '../engine/effects/types';
import { store } from '../store';

export class AudioHost {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  /** Master output tap for the toolbar's output monitor (oscilloscope / spectrum / peak). */
  analyser: AnalyserNode | null = null;
  private queue: ToEngine[] = [];
  private sentSamples = new Set<string>();
  private lastProject: Project | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private liveTag = 1;
  private getProject: () => Project;
  spectrumListeners = new Map<Id, (data: Float32Array, sr: number) => void>();
  /** Effect editor display listeners per slot id (see watchFx). */
  private fxListeners = new Map<Id, Set<(data: FxMonitor) => void>>();
  /** Set while writing automation values into the store (the engine already has them). */
  private suppressSync = false;
  /** Plugin state changes reported by the engine (fxState), waiting to be written: key slotId + '\n' + path. */
  private fxStatePending = new Map<string, [string, string, unknown]>();
  private fxStateTimer = 0;
  private autoPending = new Map<string, number>();
  /** Automated controls the user took over during this playback: values still in flight for them are stale. */
  private autoReleased = new Set<string>();
  private autoTimer = 0;
  private lastStatus = performance.now();
  onStatus: (() => void) | null = null;
  /** The audio input device (Options > Audio settings): its stream plays into the engine's worklet node. */
  readonly input = new AudioInput();
  private inputSrc: MediaStreamAudioSourceNode | null = null;
  /** Set by the recording controller (audio/recording.ts): asked before Play; true when it started the transport itself (a recording). */
  beforePlay: (() => Promise<boolean>) | null = null;
  /** The engine's recording messages (audio/Recorder.ts). */
  onRecMessage: ((m: FromEngine) => void) | null = null;

  constructor(getProject: () => Project) {
    this.getProject = getProject;
    this.input.onStream = (stream, channels) => this.connectInput(stream, channels);
    onSamplesChanged(() => {
      // a sample arrived (e.g. user file decoded): re-push channels and effects that use it
      const p = this.getProject();
      if (p && this.ready) {
        for (const c of p.channels) this.pushChannel(c);
        this.pushFxSamples(p);
      }
    });
    // the formula language's MouseX / MouseY (0..1 over the window, Y up), ~30 updates a second
    let lastMouse = 0;
    window.addEventListener('pointermove', (e) => {
      if (!this.wantMouse || !this.node) return;
      const now = performance.now();
      if (now - lastMouse < 33) return;
      lastMouse = now;
      this.send({ t: 'mouse', x: e.clientX / Math.max(1, window.innerWidth), y: 1 - e.clientY / Math.max(1, window.innerHeight) });
    }, { passive: true });
  }

  /** Some formula (link mapping or Formula Controller) reads MouseX / MouseY. */
  private wantMouse = false;

  private updateWantMouse(p: Project): void {
    const re = /mouse[xy]/i;
    let want = (p.links ?? []).some((l) => re.test(l.formula));
    if (!want) {
      for (const s of allFx(p)) if (typeof s.params.formula === 'string' && re.test(s.params.formula)) { want = true; break; }
    }
    if (!want) {
      for (const s of allGens(p)) if (typeof s.params.formula === 'string' && re.test(s.params.formula)) { want = true; break; }
    }
    this.wantMouse = want;
  }

  /** Create the context (must follow a user gesture to actually start audio). */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'orchard-engine', {
        // the audio input device (when one is open) arrives as it is: every channel, none mixed into another
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      });
      node.port.onmessage = (e) => this.onMessage(e.data as FromEngine);
      node.connect(ctx.destination);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.6;
      node.connect(an);
      this.analyser = an;
      this.node = node;
      this.ready = true;
      live.latencySec = (ctx.baseLatency || 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency || 0);
      this.fullSync(this.getProject());
      if (this.queue.length) { node.port.postMessage(this.queue); this.queue = []; }
      ctx.addEventListener('statechange', () => this.updateLatency());
      // the audio input: a device chosen earlier opens by itself when the browser already allows it
      const stream = this.input.currentStream;
      if (stream) this.connectInput(stream, this.input.state.channels);
      else this.updateLatency();
      void this.input.init();
    })();
    return this.starting;
  }

  /** Connect the audio input device's stream to the engine (null: disconnect). */
  private connectInput(stream: MediaStream | null, channels: number): void {
    if (this.inputSrc) {
      try { this.inputSrc.disconnect(); } catch { /* already gone */ }
      this.inputSrc = null;
    }
    const ctx = this.ctx, node = this.node;
    if (!ctx || !node) return; // connected when the context starts
    if (stream) {
      node.channelCount = Math.max(1, channels);
      const src = ctx.createMediaStreamSource(stream);
      src.connect(node);
      this.inputSrc = src;
    }
    this.updateLatency();
  }

  /**
   * Tell the engine the latency of the audio device in frames: the output side is the context's base
   * latency plus the output latency the browser reports, the input side what the input stream reports.
   */
  updateLatency(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    live.latencySec = (ctx.baseLatency || 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency || 0);
    this.send({ t: 'recLatency', input: this.inputLatencyFrames(), output: this.outputLatencyFrames() });
  }

  /** Latency of the audio output in frames: the context's base latency plus what the browser reports for the device. */
  outputLatencyFrames(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    return Math.round(((ctx.baseLatency || 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency || 0)) * ctx.sampleRate);
  }

  /** Latency of the audio input in frames, as the browser reports it (0: unknown). */
  inputLatencyFrames(): number {
    return Math.round(this.input.state.latencySec * this.sampleRate);
  }

  async resume(): Promise<void> {
    await this.start();
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  send(msg: ToEngine, transfer?: Transferable[]): void {
    if (!this.node) { this.queue.push(msg); return; }
    this.node.port.postMessage(msg, transfer ?? []);
  }

  // ------------------------------------------------------------------ sync
  private globalsOf(p: Project): EngineGlobals {
    return {
      tempo: p.tempo, ppq: p.ppq, beatsPerBar: p.beatsPerBar, stepsPerBeat: p.stepsPerBeat,
      mainVolume: p.mainVolume, mainPitch: p.mainPitch, swing: p.swing,
    };
  }

  /** Processed-buffer key currently used by each channel (for freeing unused buffers). */
  private channelKeys = new Map<Id, string | null>();
  private pending = new Map<Id, number>();

  /**
   * Send a channel, replacing its sample id by the processed-buffer key.
   * Re-rendering precomputed effects is debounced while a control is being
   * dragged; the channel keeps its previous buffer until the drag settles.
   */
  private pushChannel(c: Channel, immediate = false): void {
    const s = c.sampler;
    const rate = this.ctx?.sampleRate ?? 0;
    const prevKey = this.channelKeys.get(c.id) ?? null;
    if (c.kind === 'midiout' || c.kind === 'plugin' || c.kind === 'layer') {
      // MIDI Out and Layer make no sound and instrument plugins make their own: no sample to prepare
      window.clearTimeout(this.pending.get(c.id));
      this.pending.delete(c.id);
      this.channelKeys.set(c.id, null);
      this.send({ t: 'channel', c: { ...c, sampler: { ...s, sampleId: null } } });
      if (prevKey) this.releaseKey(prevKey);
      return;
    }
    let key: string | null = null;
    // an Audio Clip channel also plays its stretched sample (stretch modes other than Resample: src/audio/audioClipSample.ts)
    const audioClip = c.kind === 'audioclip';
    const tempo = this.getProject().tempo;
    if (s.sampleId) {
      if (!immediate && prevKey && !(audioClip ? isAudioClipPrepared(c, tempo, rate) : isPrepared(s.sampleId, s, rate))) {
        // defer the expensive re-render; keep playing the previous buffer meanwhile
        window.clearTimeout(this.pending.get(c.id));
        this.pending.set(c.id, window.setTimeout(() => {
          this.pending.delete(c.id);
          const latest = this.getProject().channels.find((x) => x.id === c.id);
          if (latest) this.pushChannel(latest, true);
        }, 120));
        this.send({ t: 'channel', c: { ...c, sampler: { ...s, sampleId: prevKey } } });
        return;
      }
      const prep = audioClip ? prepareAudioClipSample(c, tempo, rate) : prepareSample(s.sampleId, s, rate);
      if (prep) {
        key = prep.key;
        if (!this.sentSamples.has(key)) {
          const copy = prep.data.map((d) => d.slice());
          this.send({ t: 'sample', id: key, data: copy, sampleRate: prep.sampleRate }, copy.map((d) => d.buffer));
          this.sentSamples.add(key);
        }
      }
    }
    this.channelKeys.set(c.id, key);
    this.send({ t: 'channel', c: { ...c, sampler: { ...s, sampleId: key } } });
    if (prevKey && prevKey !== key) this.releaseKey(prevKey);
  }

  /** Pool samples sent unprocessed for effects (Scratcher...), with the buffer sent (resent when replaced). */
  private fxSamples = new Map<string, Float32Array>();

  /**
   * Send every pool sample an effect slot refers to (see slotSampleRefs):
   * effects read them with env.sample(id). A sample replaced in the pool
   * under the same id is sent again.
   */
  private pushFxSamples(p: Project): void {
    for (const id of slotSampleRefs(p)) {
      const raw = getRaw(id);
      if (!raw || !raw.channels.length) continue; // arrives later: onSamplesChanged pushes again
      if (this.fxSamples.get(id) === raw.channels[0]) continue;
      const copy = raw.channels.map((d) => d.slice());
      this.send({ t: 'sample', id, data: copy, sampleRate: raw.sampleRate }, copy.map((d) => d.buffer));
      this.fxSamples.set(id, raw.channels[0]);
    }
  }

  /** Free a processed buffer in the engine and the cache when no channel uses it. */
  private releaseKey(key: string): void {
    for (const k of this.channelKeys.values()) if (k === key) return;
    this.send({ t: 'sampleRemove', id: key });
    this.sentSamples.delete(key);
    forgetProcessedKey(key);
  }

  fullSync(p: Project): void {
    if (this.fxListeners.size) this.send({ t: 'watchFx', ids: [...this.fxListeners.keys()] });
    this.send({ t: 'globals', g: this.globalsOf(p) });
    this.send({ t: 'inputLevels', on: store.ui.rec.showInputLevels });
    this.fxSamples.clear();
    this.pushFxSamples(p);
    for (const tr of p.mixer.tracks) this.send({ t: 'mixerTrack', tr });
    for (const c of p.channels) this.pushChannel(c, true);
    for (const pat of p.patterns) this.send({ t: 'pattern', p: pat });
    this.send({ t: 'automation', list: p.automation ?? [], init: p.initControls ?? [] });
    this.send({ t: 'links', list: p.links ?? [] });
    this.send({ t: 'playlist', tracks: p.playlist.tracks, clips: p.playlist.clips, repeatClips: !!p.repeatClips, autoCrossfades: !!p.playlist.autoCrossfades });
    this.send({ t: 'mode', song: p.songMode, patternId: p.currentPatternId });
    this.updateWantMouse(p);
    this.lastProject = p;
  }

  /** Diff two project states by reference and send what changed. */
  sync(next: Project): void {
    const prev = this.lastProject;
    this.lastProject = next;
    if (!this.ready) return;
    if (!prev) { this.fullSync(next); return; }
    if (this.suppressSync) return;
    // before the changed objects go out, so the engine stops re-applying clip values over the tweak
    this.releaseTweaked(prev, next);
    if (prev.automation !== next.automation || prev.initControls !== next.initControls) {
      this.send({ t: 'automation', list: next.automation ?? [], init: next.initControls ?? [] });
    }
    if (prev.links !== next.links) this.send({ t: 'links', list: next.links ?? [] });
    if (prev.links !== next.links || prev.mixer !== next.mixer || prev.channels !== next.channels) this.updateWantMouse(next);
    if (prev.tempo !== next.tempo || prev.ppq !== next.ppq || prev.beatsPerBar !== next.beatsPerBar ||
      prev.stepsPerBeat !== next.stepsPerBeat || prev.mainVolume !== next.mainVolume ||
      prev.mainPitch !== next.mainPitch || prev.swing !== next.swing) {
      this.send({ t: 'globals', g: this.globalsOf(next) });
    }
    if (prev.channels !== next.channels) {
      const prevById = new Map(prev.channels.map((c) => [c.id, c]));
      for (const c of next.channels) {
        if (prevById.get(c.id) !== c) this.pushChannel(c);
        prevById.delete(c.id);
      }
      for (const id of prevById.keys()) {
        this.send({ t: 'channelRemove', id });
        const k = this.channelKeys.get(id);
        this.channelKeys.delete(id);
        if (k) this.releaseKey(k);
      }
    }
    // a stretched Audio Clip sample that follows the tempo (TIME set) is rendered again for the new tempo
    if (prev.tempo !== next.tempo) {
      for (const c of next.channels) {
        if (c.kind === 'audioclip' && usesStretcher(c.sampler) && followsTempo(c.sampler) && prev.channels.find((x) => x.id === c.id) === c) this.pushChannel(c);
      }
    }
    if (prev.patterns !== next.patterns) {
      const prevById = new Map(prev.patterns.map((p) => [p.id, p]));
      for (const p of next.patterns) {
        if (prevById.get(p.id) !== p) this.send({ t: 'pattern', p });
        prevById.delete(p.id);
      }
      for (const id of prevById.keys()) this.send({ t: 'patternRemove', id });
    }
    if (prev.playlist.clips !== next.playlist.clips || prev.playlist.tracks !== next.playlist.tracks || prev.repeatClips !== next.repeatClips || prev.playlist.autoCrossfades !== next.playlist.autoCrossfades) {
      this.send({ t: 'playlist', tracks: next.playlist.tracks, clips: next.playlist.clips, repeatClips: !!next.repeatClips, autoCrossfades: !!next.playlist.autoCrossfades });
    }
    if (prev.mixer !== next.mixer || prev.samples !== next.samples || prev.channels !== next.channels) this.pushFxSamples(next);
    if (prev.mixer !== next.mixer) {
      next.mixer.tracks.forEach((tr: MixerTrack, i: number) => {
        if (prev.mixer.tracks[i] !== tr) this.send({ t: 'mixerTrack', tr });
      });
    }
    if (prev.songMode !== next.songMode || prev.currentPatternId !== next.currentPatternId) {
      this.send({ t: 'mode', song: next.songMode, patternId: next.currentPatternId });
    }
  }

  // ------------------------------------------------------------- transport
  /** Position playback last started from ("Remember seek time" is on by default). */
  playStartTick = 0;
  rememberSeekTime = true;

  async play(): Promise<void> {
    await this.resume();
    this.playStartTick = live.playing ? this.playStartTick : Math.max(0, live.anchorTick);
    if (!live.playing) this.autoReleased.clear(); // the engine hands taken-over controls back to their clips
    // Record is on: the recording controller starts the transport (count-in, wait for input...)
    if (this.beforePlay && !live.playing && (await this.beforePlay())) return;
    this.send({ t: 'play' });
    live.playing = true;
    live.anchorTime = performance.now();
    emitLive();
  }

  /** Stop: return to where playback started; when already stopped, go to the song start. */
  stop(): void {
    // a count-in or a wait for input is stopped like playback
    const target = (live.playing || live.rec.state !== 'idle') && this.rememberSeekTime ? this.playStartTick : 0;
    this.send({ t: 'pause' });
    this.send({ t: 'seek', tick: target });
    live.playing = false;
    live.anchorTick = target;
    live.tick = target;
    live.anchorTime = performance.now();
    emitLive();
  }

  /** Pause keeps the position. */
  pause(): void {
    this.send({ t: 'pause' });
    live.playing = false;
    emitLive();
  }

  async togglePause(): Promise<void> {
    if (live.playing || live.rec.state !== 'idle') this.pause();
    else await this.play();
  }

  panic(): void {
    this.send({ t: 'allNotesOff' });
  }

  seek(tick: number): void {
    this.send({ t: 'seek', tick });
    if (!live.playing) this.playStartTick = tick;
    live.anchorTick = tick;
    live.anchorTime = performance.now();
    live.tick = tick;
    emitLive();
  }

  noteOn(ch: Id, key: number, vel = 100): number {
    void this.resume();
    const tag = this.liveTag++;
    this.send({ t: 'noteOn', ch, key, vel, tag });
    return tag;
  }

  noteOff(ch: Id, key: number, tag: number): void {
    this.send({ t: 'noteOff', ch, key, tag });
  }

  /** Short audition (e.g. clicking a note in the piano roll). */
  preview(ch: Id, key: number, vel = 100, ms = 250): void {
    const tag = this.noteOn(ch, key, vel);
    setTimeout(() => this.noteOff(ch, key, tag), ms);
  }

  setMetronome(on: boolean): void {
    this.send({ t: 'metronome', on });
  }

  watchSpectrum(slotId: Id | null): void {
    this.send({ t: 'watchSpectrum', slotId });
  }

  /** Receive an effect's display data (~30/s) while `fn` is subscribed; returns the unsubscribe. */
  watchFx(slotId: Id, fn: (data: FxMonitor) => void): () => void {
    let set = this.fxListeners.get(slotId);
    if (!set) { set = new Set(); this.fxListeners.set(slotId, set); }
    set.add(fn);
    this.send({ t: 'watchFx', ids: [...this.fxListeners.keys()] });
    return () => {
      const s2 = this.fxListeners.get(slotId);
      if (!s2) return;
      s2.delete(fn);
      if (s2.size === 0) {
        this.fxListeners.delete(slotId);
        this.send({ t: 'watchFx', ids: [...this.fxListeners.keys()] });
      }
    };
  }

  // ------------------------------------------------------------- automation
  /**
   * A user edit (sync never sees the mirrored automation values) that moves a
   * control with automation clips while the song plays takes the control
   * over: the engine stops driving it until playback restarts (FL 21 / 2024).
   */
  private releaseTweaked(prev: Project, next: Project): void {
    if (!live.playing || !next.songMode) return;
    const keys = new Set<string>();
    for (const a of next.automation ?? []) {
      const t = a.target;
      const k = targetKey(t);
      if (keys.has(k)) continue;
      const r0 = targetRoot(prev, t), r1 = targetRoot(next, t);
      if (!r0 || !r1 || r0 === r1) continue; // unchanged object: unchanged value
      if (getPath(r0, t.path) !== getPath(r1, t.path)) keys.add(k);
    }
    if (!keys.size) return;
    for (const k of keys) { this.autoReleased.add(k); this.autoPending.delete(k); }
    this.send({ t: 'autoRelease', keys: [...keys] });
  }

  /**
   * The engine reports automated values; mirror them into the project (no undo
   * history) so knobs follow and the value persists after stopping, like FL.
   */
  private queueAutomation(values: [string, number][]): void {
    const linked = this.linkedKeys();
    // controller-linked values always follow the controller; clip values of controls taken over by hand are stale
    for (const [k, v] of values) if (!this.autoReleased.has(k) || linked.has(k)) this.autoPending.set(k, v);
    if (this.autoTimer) return;
    this.autoTimer = window.setTimeout(() => {
      this.autoTimer = 0;
      const pending = [...this.autoPending];
      this.autoPending.clear();
      const p = this.getProject();
      const targets = new Map<string, AutomationTarget>();
      for (const a of p.automation ?? []) targets.set(targetKey(a.target), a.target);
      for (const i of p.initControls ?? []) targets.set(targetKey(i.target), i.target);
      for (const l of p.links ?? []) targets.set(targetKey(l.target), l.target);
      this.suppressSync = true;
      try {
        store.update('Automation', (d) => {
          for (const [k, v] of pending) {
            const t = targets.get(k);
            if (!t) continue;
            const obj = targetRoot(d as unknown as Project, t);
            if (obj) setPath(obj, t.path, v);
          }
        }, { noHistory: true });
      } finally {
        this.suppressSync = false;
      }
    }, 33);
  }

  /**
   * Plugin state the plugins changed by themselves (Gross Beat's slot from a
   * MIDI note, Vocodex's latched notes): mirrored into the project without an
   * undo step (the engine already has it), so editors follow and saves keep it.
   */
  private queueFxState(items: [string, string, unknown][]): void {
    for (const it of items) this.fxStatePending.set(it[0] + '\n' + it[1], it);
    if (this.fxStateTimer) return;
    this.fxStateTimer = window.setTimeout(() => {
      this.fxStateTimer = 0;
      const list = [...this.fxStatePending.values()];
      this.fxStatePending.clear();
      this.suppressSync = true;
      try {
        store.update('Plugin state', (d) => {
          const write = (params: Record<string, unknown>, path: string, v: unknown) => {
            const keys = path.split('.');
            let o = params;
            for (let i = 0; i < keys.length - 1 && o; i++) {
              const next = o[keys[i]];
              o = (next && typeof next === 'object' ? next : null) as Record<string, unknown>;
            }
            if (o) o[keys[keys.length - 1]] = structuredClone(v);
          };
          for (const [slotId, path, v] of list) {
            // an instrument plugin ("ch:<channel id>")
            const chId = channelOfSlot(slotId);
            if (chId !== null) {
              const c = d.channels.find((x) => x.id === chId);
              if (c?.plugin) write(c.plugin.params as Record<string, unknown>, path, v);
              continue;
            }
            for (const tr of d.mixer.tracks) {
              const sl = tr.slots.find((x) => x?.id === slotId);
              if (!sl) continue;
              write(sl.params as Record<string, unknown>, path, v);
              break;
            }
          }
        }, { noHistory: true });
      } finally {
        this.suppressSync = false;
      }
    }, 33);
  }

  private linkedCache: { links: Project['links']; keys: Set<string> } | null = null;

  /** Target keys of the project's controller links (cached per links array). */
  private linkedKeys(): Set<string> {
    const links = this.getProject().links;
    let c = this.linkedCache;
    if (!c || c.links !== links) c = this.linkedCache = { links, keys: new Set((links ?? []).map((l) => targetKey(l.target))) };
    return c.keys;
  }

  // ----------------------------------------------------------------- status
  private onMessage(m: FromEngine): void {
    switch (m.t) {
      case 'status': {
        const p = this.getProject();
        live.playing = m.playing;
        live.songMode = m.songMode;
        live.patternId = m.patternId;
        live.anchorTick = m.tick;
        live.anchorTime = performance.now();
        live.ticksPerSecond = (p.tempo * p.ppq) / 60;
        live.voices = m.voices;
        live.cpu = m.cpu;
        // meter ballistics: instant attack, ~24 dB/s release, 1.2 s peak hold
        const now = performance.now();
        const dt = Math.min(0.25, (now - this.lastStatus) / 1000);
        this.lastStatus = now;
        const fall = Math.pow(10, (-24 * dt) / 20);
        const peaks = m.mixerPeaks;
        for (let i = 0; i < peaks.length && i < live.mixerPeaks.length; i++) {
          const v = peaks[i];
          live.mixerPeaks[i] = Math.max(v, live.mixerPeaks[i] * fall);
          live.mixerHoldAge[i] += dt;
          if (v >= live.mixerHold[i]) { live.mixerHold[i] = v; live.mixerHoldAge[i] = 0; }
          else if (live.mixerHoldAge[i] > 1.2) live.mixerHold[i] *= fall;
        }
        m.channelIds.forEach((id, i) => {
          const prev = live.channelPeaks.get(id) ?? 0;
          live.channelPeaks.set(id, Math.max(m.channelPeaks[i], prev * 0.75));
        });
        if (m.auto) this.queueAutomation(m.auto);
        emitLive();
        this.onStatus?.();
        break;
      }
      case 'fxMonitor': {
        for (const [id, data] of m.items) this.fxListeners.get(id)?.forEach((fn) => fn(data));
        break;
      }
      case 'fxState':
        this.queueFxState(m.items);
        break;
      case 'spectrum': {
        this.spectrumListeners.get(m.slotId)?.(m.data, m.sampleRate);
        break;
      }
      case 'recState':
      case 'recData':
      case 'recTake':
      case 'recDone':
        this.onRecMessage?.(m);
        break;
      case 'log':
        console.log('[engine]', m.msg);
        break;
    }
  }
}

function targetRoot(p: Project, t: AutomationTarget): unknown {
  switch (t.scope) {
    case 'channel': return p.channels.find((c) => c.id === t.id);
    case 'mixer': return p.mixer.tracks[Number(t.id)];
    case 'fx': {
      for (const tr of p.mixer.tracks) for (const s of tr.slots) if (s && s.id === t.id) return s;
      return undefined;
    }
    case 'global': return p;
  }
}
