// Instrument (generator) plugin interface for the audio engine, shaped after
// FL's SDK (TFruityPlug: TriggerVoice, Voice_Release, Voice_Kill, Voice_Render,
// Gen_Render, TVoiceParams). Instruments run in the AudioWorklet and in Node
// tests: the effect worklet restrictions apply (docs/fx-framework.md: no DOM,
// timers, fetch, performance or storage; no allocation in render paths).

import type { FxMonitor } from '../effects/types';
import type { GenLevels } from './levels';

export type { GenLevels } from './levels';

/** Per-block information (tempo sync, transport). */
export interface GenContext {
  sampleRate: number;
  blockSize: number;
  tempo: number;
  ppq: number;
  /** Transport state and position (ticks) at the start of the block. */
  playing: boolean;
  pos: number;
  songMode: boolean;
  /** Mixer track the channel plays into. */
  track: number;
  /**
   * True while the engine renders offline (project WAV export), false or
   * absent live: FL's FPD_ProcessMode (PM_IsRendering | PM_HQ_NonRealtime).
   * Use it only where FL's plugin renders differently on export.
   */
  rendering?: boolean;
  /**
   * Add `n` frames of L / R to the mixer track `track` (absolute index, 0 = master) as that
   * track's channel input: FL's GetMixBuffer / GetOutBuffer for generators that feed
   * several tracks (Voltage Controller's outputs 2..4). Call it from render() only.
   */
  out?(track: number, L: Float32Array, R: Float32Array, n: number): void;
}

/** Sample pool lookup (sample-based instruments). */
export interface GenEnv {
  sample(id: string): { channels: Float32Array[]; sampleRate: number } | undefined;
}

/**
 * A note the channel plays (FL's TVoiceParams plus the values FL's
 * Voice_ProcessEvent queries return). The objects are owned by the channel
 * and reused: keep a reference while the voice / note lives, never after.
 */
export interface GenVoiceParams {
  /**
   * Note number 0..131 (60 = C5) the plugin should play: the played key, moved
   * by the channel's root key when MISC "Add to key" is on (multi-sample
   * instruments pick their sample by it). For pitch use levels.pitch.
   */
  key: number;
  /** FL note velocity 0..128 (100 = default). FL's FPV_GetVelocity is velocity / 128. */
  velocity: number;
  /** Release velocity 0..128 (FL's FPV_GetRelVelocity), meaningful once released. */
  release: number;
  /** Note colour group 0..15 (FL's FPV_GetColor; the MIDI channel when mapped). */
  color: number;
  /** Note length in samples after the gate (FL's FPV_GetLength); Infinity for live notes. */
  length: number;
  /**
   * Frame inside the block being rendered (0 <= frame < block length) at which the
   * voice's current control step begins: where its first sample falls when triggerVoice
   * is called, and where its release / kill happens when release() / kill() is called.
   * Plugins that timestamp note events (controllers' tick logic) read it; set by the channel.
   */
  frame: number;
  /** FL's InitLevels: the note's own levels as triggered. */
  readonly init: GenLevels;
  /**
   * FL's FinalLevels: init plus the channel (volume, panning, pitch knob,
   * MISC, glides, INS envelopes / LFOs). The channel updates them every
   * control step (16 samples) before calling render.
   */
  readonly levels: GenLevels;
}

/** A voice of a 'voices' instrument (FL's voice handle). */
export interface GenVoice {
  /**
   * Add `n` frames of the voice into L / R (they arrive zeroed; n <= 16), at
   * the pitch in params.levels.pitch. With def.levels 'channel' (default) render
   * at unity gain and centred: the channel applies volume and panning. Return
   * false once the voice has finished; it is dropped (kill() follows).
   */
  render(L: Float32Array, R: Float32Array, n: number): boolean;
  /** Note off (FL's Voice_Release): start the voice's release. */
  release(): void;
  /** The channel drops the voice (FL's Voice_Kill): no further calls. */
  kill(): void;
}

/** A note of an 'events' instrument: the voice parameters plus a unique id. */
export interface GenNote extends GenVoiceParams {
  readonly id: number;
}

export interface GenInstance {
  /** New plugin state (the channel's plugin.params). Called on every edit and automation step. */
  setParams(p: unknown): void;
  /** Clear voices, delay lines and filters. */
  reset(): void;

  // ------------------------------------------------- 'voices' instruments
  /**
   * Start a voice for a note (FL's TriggerVoice). The channel calls it at the
   * voice's first sample and renders the voice from there. null = no sound.
   * `ctx` is the current block's context (tempo, transport), for plugins that
   * read the tempo when a voice starts (FL sends it as FPE_Tempo events).
   */
  triggerVoice?(params: GenVoiceParams, ctx?: GenContext): GenVoice | null;

  // ------------------------------------------------- 'events' instruments
  /** A note starts `frameOffset` samples into the next render() call. */
  noteOn?(note: GenNote, frameOffset: number): void;
  /** A note's release starts `frameOffset` samples into the next render() call. */
  noteOff?(note: GenNote, frameOffset: number): void;
  /** A note must stop now (polyphony limit, panic): quick fade, then free it. */
  killNote?(note: GenNote): void;
  /** 'events' instruments: whether any voice still sounds (the channel stops rendering once false). */
  isActive?(): boolean;

  /**
   * Whole-plugin processing once per block, after the channel has rendered
   * this block's voices into L / R: 'events' instruments add all their voices
   * here (L / R arrive zeroed); 'voices' instruments may post-process the summed
   * voices in place (a synth's global effects).
   */
  render?(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void;

  /**
   * Panic: forget every note (no note offs follow). 'events' instruments stop
   * all their voices at once; 'voices' instruments only reset note-dependent
   * plugin state: the channel fades out and kills the voices it holds itself.
   */
  allNotesOff?(): void;
  /**
   * FL's FPE_MaxPoly: the channel's max polyphony (MISC, 0 = unlimited), sent when the
   * channel gets the plugin and whenever the setting changes. For plugins that limit
   * their own voices with it (DX10's quietest-voice stealing, MiniSynth's POLY voices).
   */
  setMaxPoly?(n: number): void;
  /**
   * The project's resampling quality (FL's interpolation setting, sent to plugins in FPD_ProcessMode bits 8..23),
   * for plugins that resample their samples with FL's own resampler (FPC). Sent when the channel gets the plugin
   * and on every change.
   */
  setInterpolation?(mode: import('../../model/sampler').InterpMode): void;
  /** Seconds the plugin keeps sounding after its last voice ended (global effects); Infinity = always render (controllers). */
  tail?: number;
  /** Latency in samples (reported; not compensated yet). */
  latency?: number;
  /** Editor display data, polled about 30 times a second while the editor is open. */
  monitor?(): FxMonitor | null;
  /** Hosts (Patcher): display data of a hosted module, watched as "ch:<channel id>#<module id>". */
  monitorHosted?(moduleId: string): FxMonitor | null;
  /**
   * MIDI Out ports the instrument listens on by itself (Patcher's From FL Studio "Port p"
   * outputs), re-read after setParams. The engine hands the notes of those ports to portNote().
   */
  midiPorts?(): readonly number[];
  /**
   * A note of a MIDI Out channel on one of midiPorts(), `frame` samples into the next render()
   * call (raw: the channel's note handling does not apply; velocity 0..128, channel 1..16).
   */
  portNote?(on: boolean, key: number, velocity: number, frame: number, port: number, channel: number): void;
  /**
   * Controller instruments (Envelope / Keyboard / Voltage Controller): current
   * values 0..1 of the internal controller outputs (def.outputs order), read
   * after every block for Link to controller. Return a buffer the instance keeps.
   */
  controls?(): ArrayLike<number>;
  /** Plugin state the plugin changed by itself: [path in params, value] pairs since the last call. */
  takeStateChanges?(): [string, unknown][] | null;
}

export interface GenModule {
  id: string;
  create(sampleRate: number, blockSize: number, env: GenEnv): GenInstance;
}
