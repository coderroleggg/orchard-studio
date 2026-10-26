// Message protocol between the main thread (AudioHost) and the engine running
// inside the AudioWorklet.

import type { Channel, Clip, Id, MixerTrack, Pattern, PlaylistTrack } from '../model/types';

export interface EngineGlobals {
  tempo: number;
  ppq: number;
  beatsPerBar: number;
  stepsPerBeat: number;
  mainVolume: number;
  mainPitch: number;
  swing: number;
}

export type ToEngine =
  | { t: 'globals'; g: EngineGlobals }
  | { t: 'channel'; c: Channel }
  | { t: 'channelRemove'; id: Id }
  | { t: 'pattern'; p: Pattern }
  | { t: 'patternRemove'; id: Id }
  | { t: 'playlist'; tracks: PlaylistTrack[]; clips: Clip[]; repeatClips?: boolean; autoCrossfades?: boolean }
  | { t: 'mixerTrack'; tr: MixerTrack }
  | { t: 'sample'; id: Id; data: Float32Array[]; sampleRate: number }
  | { t: 'sampleRemove'; id: Id }
  | { t: 'play' }
  | { t: 'pause' }
  | { t: 'stop' }
  | { t: 'mode'; song: boolean; patternId: Id }
  | { t: 'seek'; tick: number }
  | { t: 'noteOn'; ch: Id; key: number; vel: number; tag: number }
  | { t: 'noteOff'; ch: Id; key: number; tag: number }
  | { t: 'allNotesOff' }
  | { t: 'metronome'; on: boolean }
  | { t: 'interp'; mode: import('../model/sampler').InterpMode }
  | { t: 'watchSpectrum'; slotId: Id | null }
  /** Effect slots whose editors are open: their display data is posted as 'fxMonitor'. */
  | { t: 'watchFx'; ids: Id[] }
  | { t: 'mixerSelect'; index: number }
  | { t: 'automation'; list: import('../model/automation').AutomationChannel[]; init?: import('../model/automation').InitControl[] }
  /** Automated controls moved by hand during song playback (target keys): their clips let go of them until the next play. */
  | { t: 'autoRelease'; keys: string[] }
  | { t: 'loop'; start: number; end: number } // song-mode loop region in ticks (end <= start disables)
  /** Remote control links: parameters that follow controller plugin outputs (model/links.ts). */
  | { t: 'links'; list: import('../model/links').ControllerLink[] }
  /** Mouse position (0..1, Y up) for the formula language's MouseX / MouseY. */
  | { t: 'mouse'; x: number; y: number }
  /**
   * Audio recording (engine/Recording.ts, docs/recording.md). The audio device latency in frames
   * (the input and the output side), used by the automatic latency compensation.
   */
  | { t: 'recLatency'; input: number; output: number }
  /** Start a recording session: record the armed mixer tracks, starting the transport as the options say. */
  | { t: 'recStart'; o: import('../model/recording').RecStartOptions }
  /** End the recording (the transport keeps playing). The takes are completed, including the latency compensation tail. */
  | { t: 'recStop' }
  /** Drop the recording: nothing is posted. */
  | { t: 'recCancel' }
  /** "Always show external input levels": mixer meters show an unmonitored input too. */
  | { t: 'inputLevels'; on: boolean }
  | { t: 'ping'; id: number };

export interface EngineStatus {
  t: 'status';
  playing: boolean;
  tick: number; // song / pattern position at the start of the last rendered block
  frame: number; // engine frame counter at that block
  songMode: boolean;
  patternId: Id;
  /** Peak per mixer track since the last status message: [L0, R0, L1, R1, ...]. */
  mixerPeaks: Float32Array;
  /** Peak per channel (in channel order of the last 'channel' messages), for the channel activity LEDs. */
  channelPeaks: Float32Array;
  channelIds: Id[];
  voices: number;
  cpu: number; // fraction of the render budget used (0..1+)
  /** Automated or controller-linked parameter values that changed: [targetKey, model value]. */
  auto?: [string, number][];
}

export type FromEngine =
  | EngineStatus
  | { t: 'spectrum'; slotId: Id; data: Float32Array; sampleRate: number }
  | { t: 'fxMonitor'; items: [Id, import('./effects/types').FxMonitor][] }
  /**
   * Plugin state the plugins changed by themselves (EffectInstance.takeStateChanges):
   * [slot id, path in the slot params (dots for nested keys), value]. The host
   * mirrors them into the project without an undo step.
   */
  | { t: 'fxState'; items: [Id, string, unknown][] }
  | { t: 'pong'; id: number }
  /** A recording session changed state (countdown, waiting for input, recording, idle). */
  | { t: 'recState'; state: import('../model/recording').RecState; take: number; tick0: number; frame: number }
  /**
   * Recorded audio of one armed track: `L` / `R` hold the frames `off` ... `off + L.length` of
   * take `take` (the takes of all tracks have the same length and timeline start).
   */
  | { t: 'recData'; take: number; track: number; off: number; L: Float32Array; R: Float32Array }
  /**
   * A take of a track is complete: `frames` long, its first frame at transport position `tick0`
   * (ticks, the latency compensation already applied to the audio).
   */
  | { t: 'recTake'; take: number; track: number; frames: number; tick0: number }
  /** The recording session ended (after the last 'recTake'). */
  | { t: 'recDone'; cancelled: boolean }
  | { t: 'log'; msg: string };
