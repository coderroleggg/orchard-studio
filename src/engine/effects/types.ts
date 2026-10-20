// Effect plugin interface for the audio engine.

/** Per-block information an effect may need (tempo sync, transport, routing). */
export interface FxContext {
  sampleRate: number;
  blockSize: number;
  /** Current tempo (BPM) and timebase. */
  tempo: number;
  ppq: number;
  /** Transport state and position (ticks) at the start of the block. */
  playing: boolean;
  pos: number;
  /** True when the song (playlist) plays, false in pattern mode. */
  songMode: boolean;
  /** Mixer track index the effect runs on. */
  track: number;
  /**
   * True while the engine renders offline (project WAV export), false or
   * absent in the live AudioWorklet. FL tells its plugins the same through
   * FPD_ProcessMode (PM_IsRendering | PM_HQ_NonRealtime when exporting with
   * "HQ for all plugins"), and some switch kernels on it: Fast Dist's DistWave
   * table lookup truncates live and interpolates when rendering.
   */
  rendering?: boolean;
  /**
   * Sidechain inputs: every track routed into this one, in source track
   * order (FL's sidechain input 1 is sidechain[0]), carrying the source's
   * full output whatever the send level ("Sidechain to this track" routes
   * have the level at zero). Each buffer holds `n` frames of this block.
   */
  sidechain: { source: number; L: Float32Array; R: Float32Array }[];
  /**
   * Mix audio into another mixer track's input (routing plugins such as
   * Send). The target is processed after this track when the effect lists it
   * in sendTargets().
   */
  sendTo(track: number, L: Float32Array, R: Float32Array, n: number, gainL: number, gainR: number): void;
}

/** Sample data lookup (Convolver impulses, etc.). */
export interface FxEnv {
  sample(id: string): { channels: Float32Array[]; sampleRate: number } | undefined;
}

/**
 * Display data an effect returns for its editor (meters, envelopes, spectra...).
 * The mixer adds `__active`: false once the track has gone idle and is no
 * longer processed, so displays can fall instead of freezing.
 */
export type FxMonitor = Record<string, number | boolean | string | number[] | Float32Array>;

export interface EffectInstance {
  /** New plugin state (the slot's params object). Called on every edit and automation step. */
  setParams(p: unknown): void;
  /** In-place stereo processing of `n` frames. */
  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void;
  reset(): void;
  /** Processing latency in samples (reported for delay compensation). */
  latency?: number;
  /**
   * Seconds the effect keeps producing output after its input goes silent
   * (reverb and delay tails). Infinity: always process (generating effects).
   */
  tail?: number;
  /** Optional analyser tap (post-processing mono sum), filled when watched. */
  analyser?: { buffer: Float32Array; write: number; watched: boolean };
  /** Editor display data, polled about 30 times a second while the editor is open. */
  monitor?(): FxMonitor | null;
  /** Hosts (Patcher): display data of a hosted module, watched as "<slot id>#<module id>". */
  monitorHosted?(moduleId: string): FxMonitor | null;
  /** Mixer tracks this effect sends audio to (processing order). */
  sendTargets?(): number[];
  /**
   * Controller plugins: the current value (0..1) of each internal controller
   * output (FxPluginDef.outputs order), read by the engine after every block
   * to drive linked parameters ("Link to controller"). Return a buffer the
   * instance keeps (no allocation per call).
   */
  controls?(): ArrayLike<number>;

  // ------------------------------------------------------------ MIDI input
  // Notes reach an effect from MIDI Out channels (FL: MIDI Out) whose port is
  // one of the slot's ports: the slot's MIDI input port (FxSlot.midiPort, the
  // wrapper's "Input port") and the ports the plugin listens on by itself
  // (midiPorts()). The mixer calls noteOn / noteOff right before process() of
  // the block they belong to; frameOffset (0 <= offset < n) is the sample of
  // that block where the event happens, so apply it at that sample in the
  // process() call that follows. Events of one block arrive in time order.
  // A bypassed slot gets no calls; when it runs again the mixer first brings
  // it up to date (note offs / ons at offset 0). `velocity` is FL's note
  // velocity 0..128 (100 = default), `channel` the MIDI channel 1..16.

  noteOn?(key: number, velocity: number, frameOffset: number, port: number, channel: number): void;
  noteOff?(key: number, frameOffset: number, port: number, channel: number): void;
  /** Panic: forget every held note (no note offs follow for them). */
  allNotesOff?(): void;
  /** MIDI ports the plugin listens on by itself (Pitcher's own port, Patcher's From FL Studio port outputs); re-read after setParams. */
  midiPorts?(): readonly number[];
  /** The slot's MIDI input port (-1 = none); called when the slot is created and when the port changes. */
  setMidiPort?(port: number): void;
  /**
   * Plugin state the plugin changed by itself (Gross Beat's slot selected by a
   * MIDI note, Vocodex's latched carrier notes): [path in the slot params
   * (dots for nested keys), value] pairs since the last call, or null. The
   * engine keeps them in its copy of the slot and mirrors them into the
   * project without an undo step, as FL's plugins update their own
   * parameters. Polled after every block (keep it cheap).
   */
  takeStateChanges?(): [string, unknown][] | null;
}

export interface EffectModule {
  id: string;
  create(sampleRate: number, blockSize: number, env: FxEnv): EffectInstance;
}
