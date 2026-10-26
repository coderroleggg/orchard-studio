// Project data model. Everything here is plain, serialisable data shared by the
// UI (main thread) and the audio engine (AudioWorklet thread).
//
// Value conventions follow FL Studio's internal ranges where they exist:
//  - note velocity / release 0..128 (default 100 / 64), note pan 0..128 (64 = centre),
//    fine pitch 0..240 (120 = centre), mod X / Y 0..255 (128 = centre)
//  - knobs are stored as normalised positions; model/scales.ts maps them to units.

import type { SamplerSettings } from './sampler';
import type { MidiOutSettings } from './midiout';
import type { LayerSettings } from './layer';
import type { FxParams } from './fx/types';
import type { AutomationChannel, InitControl } from './automation';
import type { ControllerLink } from './links';
import type { ChannelPlugin } from './gen/types';
import type { MonitorMode, RecPickup, TrackInput } from './recording';

export type Id = string;

export interface Note {
  id: Id;
  key: number; // MIDI key, 60 = C5
  pos: number; // ticks from pattern start
  len: number; // ticks
  vel: number; // 0..128
  rel: number; // release velocity 0..128
  pan: number; // 0..128, 64 = centre
  fine: number; // 0..240, 120 = centre
  modX: number; // 0..255, 128 = centre
  modY: number; // 0..255, 128 = centre
  color: number; // 0..15 colour group
  slide: boolean;
  porta: boolean;
  muted: boolean;
  shift?: number; // step delay in ticks (graph editor "Shift" lane), 0..ticksPerStep
}

export interface Pattern {
  id: Id;
  name: string;
  color: string | null; // null = default pattern colour
  /** Notes per channel id (steps are notes too). */
  notes: Record<Id, Note[]>;
  /** Channel rack "Pattern length": 0 = Auto (end of the last bar with data), else steps 1..512. */
  lengthSteps?: number;
}

/**
 * Channel generator: 'sampler' (the Sampler), 'midiout' (FL's MIDI Out: no
 * sound, its notes go out on a MIDI port to the effects listening on it),
 * 'plugin' (an instrument plugin, Channel.plugin; see docs/gen-framework.md)
 * 'layer' (FL's Layer: no sound, its notes play its child channels;
 * Channel.layer, see docs/research/layer.md) or 'audioclip' (FL's Audio Clip
 * channel: a Sampler-like channel that holds one pool sample in
 * `sampler.sampleId` and sounds only through the 'audio' clips that refer to
 * it in the Playlist; it has no notes. See docs/audio-clips.md).
 */
export type ChannelKind = 'sampler' | 'midiout' | 'plugin' | 'layer' | 'audioclip';

export interface Channel {
  id: Id;
  name: string;
  color: string;
  kind: ChannelKind;
  enabled: boolean; // the channel "mute" switch (lit = enabled)
  volume: number; // knob 0..1, default 0.78125 (100/128)
  pan: number; // -1 (left) .. 1 (right)
  pitch: number; // knob -1..1, scaled by sampler.pitchRange
  mixerTrack: number; // 0 = master, 1..N inserts
  filterGroup: string;
  /**
   * Sampler settings (every channel keeps them; a MIDI Out channel ignores
   * them). Instrument channels use their INS (for plugins FL shows the INS
   * tab for) and MISC settings and the header's pitch range.
   */
  sampler: SamplerSettings;
  /** MIDI Out settings (kind 'midiout'). */
  midiOut?: MidiOutSettings;
  /** The instrument plugin and its state (kind 'plugin'). */
  plugin?: ChannelPlugin;
  /** Layer settings: children, Random / Sequential / Crossfade, FADE (kind 'layer'). */
  layer?: LayerSettings;
}

export interface PlaylistTrack {
  id: Id;
  name: string;
  color: string;
  height: number; // relative height multiplier
  enabled: boolean; // track mute switch (lit = enabled)
  locked: boolean;
}

export interface Clip {
  id: Id;
  track: number; // playlist track index
  kind: 'pattern' | 'automation' | 'audio';
  patternId: Id; // pattern clips ('' for automation and audio clips)
  autoId?: Id; // automation clips: the automation channel
  /** Audio clips: the Audio Clip channel (Channel.kind 'audioclip') whose sample the clip plays. */
  channelId?: Id;
  start: number; // ticks
  length: number; // ticks
  offset: number; // ticks into the pattern; audio clips: ticks into the sample as the channel plays it (slip)
  muted: boolean;
  // ---- audio clips only (FL 21+: fade handles and gain on each clip; model/audioclip.ts)
  /** Fade in / out length in ticks (0 / undefined: none apart from the channel's declick). */
  fadeIn?: number;
  fadeOut?: number;
  /** Fade curve tension -1..1 (0 / undefined: linear). */
  fadeInTension?: number;
  fadeOutTension?: number;
  /** Clip gain in dB (0 / undefined: unity). */
  gain?: number;
}

export interface Marker {
  id: Id;
  pos: number;
  name: string;
  /** FL's "Start recording" / "Stop recording" time markers (Punch in / out before FL 21): recording starts / stops when the playhead reaches them. */
  kind?: 'recStart' | 'recStop';
}

export interface Playlist {
  tracks: PlaylistTrack[];
  clips: Clip[];
  markers: Marker[];
  /** Overlapping audio clips on a track crossfade over the overlap (FL: "Automatic crossfades (current project)"; absent = off). */
  autoCrossfades?: boolean;
}

/** Effect plugin id (see src/model/fx/plugins). */
export type PluginKind = string;

export interface FxSlot {
  id: Id;
  plugin: PluginKind;
  name: string;
  enabled: boolean;
  mix: number; // 0..1 wet
  /**
   * MIDI input port 0..255 (the plugin wrapper's "Input port"; undefined or -1 =
   * none): notes from MIDI Out channels on this port reach the effect.
   */
  midiPort?: number;
  /** Plugin state: parameter values by key plus plugin-specific fields (PEQ2: PEQ2Params). */
  params: FxParams;
}

export interface MixerTrack {
  index: number; // 0 = master
  name: string; // empty = default ("Insert N" / "Master")
  color: string | null;
  enabled: boolean; // mute switch (lit = enabled)
  volume: number; // fader position 0..1, 0.8 = 0 dB
  pan: number; // -1..1
  stereoSep: number; // FL knob: +1 = 100% merged (mono) .. -1 = 100% separated, 0 = off
  polarity: boolean; // invert polarity
  swapLR: boolean;
  /** Output routes: target track index -> send level (fader position style, 0.8 = 0 dB). */
  sends: Record<number, number>;
  slots: (FxSlot | null)[];
  fxEnabled: boolean; // FX master switch (bypasses all slots when off)
  /** Built-in 3-band EQ: low shelf, peaking, high shelf. */
  eq: MixerEqBand[];
  // ---- audio input and recording (model/recording.ts, docs/recording.md); all optional, absent = FL's default
  /** Input selector: the audio device channels feeding the track (absent: none). */
  input?: TrackInput;
  /** "Arm disk recording". */
  armed?: boolean;
  /** Recording pickup point (default EXT). */
  pickup?: RecPickup;
  /** "Monitor external input" (default When armed). */
  monitor?: MonitorMode;
  /** Manual input delay compensation in ms (positive: the recording moves earlier). */
  inputDelay?: number;
  /** "Adjust position of recorded audio": also compensate the plugin delay compensation of the playback chain (default on). */
  inputAdjust?: boolean;
  /** Name of the recorded audio (the arm button's right-click; absent: the track name). */
  recordName?: string;
}

export interface MixerEqBand {
  gain: number; // dB, -18..18
  freq: number; // normalised 0..1 (10 Hz .. 16 kHz, see scales.eqFreqHz)
  width: number; // normalised 0..1
}

export interface Mixer {
  tracks: MixerTrack[];
}

export interface SampleInfo {
  id: Id;
  name: string;
  frames: number;
  sampleRate: number;
  channels: number;
  /** Where the audio comes from: built-in generator or user file (stored in IndexedDB). */
  source: { kind: 'builtin'; key: string } | { kind: 'user'; key: string };
  loopStart?: number;
  loopEnd?: number;
}

export interface Project {
  version: number;
  title: string;
  tempo: number; // BPM
  ppq: number;
  beatsPerBar: number;
  stepsPerBeat: number;
  mainVolume: number; // transport main volume knob 0..1
  mainPitch: number; // transport main pitch knob -1..1 (+/- 1200 cents)
  swing: number; // channel rack swing 0..1
  channels: Channel[];
  /** Automation clip channels (shown in the channel rack, played from the playlist). */
  automation: AutomationChannel[];
  /** Initialized controls: values applied when the song starts. */
  initControls?: InitControl[];
  /** Remote control links: parameters that follow controller plugin outputs / MIDI controllers (model/links.ts). */
  links?: ControllerLink[];
  patterns: Pattern[];
  currentPatternId: Id;
  songMode: boolean;
  /** Pattern clips longer than their pattern repeat the pattern (FL default: silent past the end). */
  repeatClips?: boolean;
  playlist: Playlist;
  mixer: Mixer;
  samples: Record<Id, SampleInfo>;
}
