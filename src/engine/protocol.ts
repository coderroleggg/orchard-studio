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
  | { t: 'playlist'; tracks: PlaylistTrack[]; clips: Clip[]; repeatClips?: boolean }
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
  | { t: 'log'; msg: string };
