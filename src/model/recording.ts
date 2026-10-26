// Audio input and recording: the model side. FL's mixer track Input selector,
// recording pickup point, input monitoring, input delay compensation and arm
// switch, plus the recording filter and options of the transport (docs/recording.md).
//
// Pure data and helpers shared by the engine (Mixer, Recording), the UI and the tests.

// ------------------------------------------------------------ mixer track
/**
 * The point of the mixer track a recording is taken from (FL 20.9+, the
 * selector in front of the track's Input menu):
 *  ext  - "External input only": the audio input, untouched (recommended for takes)
 *  mix  - "External and mixer input": the input plus everything routed into the track, before the FX slots
 *  fx   - "Post effects": after the last FX slot
 *  eq   - "Post EQ": after the track's built-in EQ
 *  lvl  - "Post level and panning": after volume and panning (the mute switch is not applied yet)
 *  post - "Post track": after the entire track, mute included
 */
export type RecPickup = 'ext' | 'mix' | 'fx' | 'eq' | 'lvl' | 'post';
export const REC_PICKUPS: readonly RecPickup[] = ['ext', 'mix', 'fx', 'eq', 'lvl', 'post'];

/** The short names on the selector. */
export const PICKUP_CODE: Record<RecPickup, string> = { ext: 'EXT', mix: 'MIX', fx: 'FX', eq: 'EQ', lvl: 'LVL', post: 'POST' };
/** FL's menu captions. */
export const PICKUP_NAME: Record<RecPickup, string> = {
  ext: 'External input only',
  mix: 'External and mixer input',
  fx: 'Post effects',
  eq: 'Post EQ',
  lvl: 'Post level and panning',
  post: 'Post track',
};
/** FL's menu hints. */
export const PICKUP_HINT: Record<RecPickup, string> = {
  ext: 'Only record audio from the selected external input',
  mix: 'Record audio from the selected external input as well as any other audio coming into the track',
  fx: 'Record audio after effects have been processed',
  eq: 'Record audio after EQ has been processed',
  lvl: 'Record audio after volume and panning have been processed',
  post: 'Record audio after the entire track has been processed',
};
export const DEFAULT_PICKUP: RecPickup = 'ext';

/** "Monitor external input": Off, When armed (the default since FL 20.9), On. */
export type MonitorMode = 'off' | 'armed' | 'on';
export const MONITOR_MODES: readonly MonitorMode[] = ['off', 'armed', 'on'];
export const MONITOR_NAME: Record<MonitorMode, string> = { off: 'Off', armed: 'When armed', on: 'On' };
export const DEFAULT_MONITOR: MonitorMode = 'armed';

/** The most device channels the engine takes (Web Audio's channel limit). */
export const MAX_INPUT_CHANNELS = 32;

/**
 * A mixer track's audio input: device channel `ch` (0-based) as a stereo pair
 * (`ch`, `ch + 1`), or, with `mono`, that single channel on both sides of the
 * track. No input at all is `undefined`.
 */
export interface TrackInput {
  ch: number;
  mono?: boolean;
}

export function sameInput(a: TrackInput | null | undefined, b: TrackInput | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.ch === b.ch && !!a.mono === !!b.mono;
}

/** Tolerant reader for saved projects. */
export function normalizeTrackInput(v: unknown): TrackInput | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.ch !== 'number' || !Number.isFinite(o.ch)) return undefined;
  const ch = Math.min(MAX_INPUT_CHANNELS - 1, Math.max(0, Math.round(o.ch)));
  return o.mono ? { ch, mono: true } : { ch };
}

export function normalizePickup(v: unknown): RecPickup {
  return REC_PICKUPS.includes(v as RecPickup) ? (v as RecPickup) : DEFAULT_PICKUP;
}

export function normalizeMonitor(v: unknown): MonitorMode {
  return MONITOR_MODES.includes(v as MonitorMode) ? (v as MonitorMode) : DEFAULT_MONITOR;
}

/** Device channels a track input reads (a mono input reads one, a pair two). */
export function inputChannels(sel: TrackInput): number[] {
  return sel.mono ? [sel.ch] : [sel.ch, sel.ch + 1];
}

/** The stereo pairs of a device with `channels` input channels: 1+2, 3+4 ... (a last odd channel has no partner). */
export function stereoPairs(channels: number): TrackInput[] {
  const out: TrackInput[] = [];
  for (let c = 0; c + 1 < channels; c += 2) out.push({ ch: c });
  return out;
}

export function monoInputs(channels: number): TrackInput[] {
  const out: TrackInput[] = [];
  for (let c = 0; c < channels; c++) out.push({ ch: c, mono: true });
  return out;
}

/** Menu label of an input ("Input 1 - Input 2" for a pair, "Input 1" for a mono input). */
export function inputName(sel: TrackInput | null | undefined, names?: readonly string[]): string {
  if (!sel) return '(none)';
  const n = (c: number) => names?.[c] || `Input ${c + 1}`;
  return sel.mono ? n(sel.ch) : `${n(sel.ch)} - ${n(sel.ch + 1)}`;
}

/** Short label for the narrow selector ("In 1+2", "In 3"). */
export function inputShort(sel: TrackInput | null | undefined): string {
  if (!sel) return '(none)';
  return sel.mono ? `In ${sel.ch + 1}` : `In ${sel.ch + 1}+${sel.ch + 2}`;
}

/**
 * FL's "Auto map" on a track's Input menu: starting at `first` with `sel`, the
 * following device inputs (pairs or mono channels, as `sel` is) go to the
 * following tracks. Returns the input per track index.
 */
export function autoMapInputs(first: number, sel: TrackInput, channels: number, lastTrack: number): Record<number, TrackInput> {
  const out: Record<number, TrackInput> = {};
  const step = sel.mono ? 1 : 2;
  let ch = sel.ch;
  for (let t = first; t <= lastTrack; t++, ch += step) {
    if (sel.mono ? ch >= channels : ch + 1 >= channels) break;
    out[t] = sel.mono ? { ch, mono: true } : { ch };
  }
  return out;
}

// --------------------------------------------------- input delay compensation
/** The units of FL's "Input latency" menu (Set in ms / samples / beats). */
export type DelayUnit = 'ms' | 'smp' | 'beats';

export function delayMsToFrames(ms: number, sampleRate: number): number {
  return Math.round((ms * sampleRate) / 1000);
}

/** A manual input delay (ms) in `unit`. */
export function delayFromMs(ms: number, unit: DelayUnit, sampleRate: number, tempo: number): number {
  switch (unit) {
    case 'ms': return ms;
    case 'smp': return Math.round((ms * sampleRate) / 1000);
    case 'beats': return (ms / 1000) * (tempo / 60);
  }
}

/** The delay (ms) a value in `unit` stands for. */
export function delayToMs(v: number, unit: DelayUnit, sampleRate: number, tempo: number): number {
  switch (unit) {
    case 'ms': return v;
    case 'smp': return (v * 1000) / sampleRate;
    case 'beats': return (v * 60000) / tempo;
  }
}

export function formatDelay(ms: number): string {
  const r = Math.round(ms * 100) / 100;
  return `${r > 0 ? '+' : ''}${r} ms`;
}

/** Longest manual input delay either way (ms). */
export const MAX_INPUT_DELAY_MS = 5000;

// ------------------------------------------------------ transport options
/** What stopping a recording keeps and where audio goes (right-click the Record button, Mixer > Options > Disk recording). */
export interface RecSettings {
  // ---- recording filter
  /** "Audio" in the recording filter. */
  filterAudio: boolean;
  /** Where recorded audio goes: "Into playlist as an audio clip" or "Into Edison audio editor/recorder". */
  audioTo: 'playlist' | 'edison';
  /** "Recording starts playback": pressing Record also plays. */
  startsPlayback: boolean;
  /** "Disarm on stop". */
  disarmOnStop: boolean;
  /** "Enable recording markers": the Start recording / Stop recording markers of the Playlist punch in and out. */
  markers: boolean;
  // ---- toolbar switches
  /** "Countdown before recording" (Ctrl+P). */
  countdown: boolean;
  /** Countdown length in bars (the menu offers 1 and 2). */
  countdownBars: number;
  /** "Loop recording". */
  loop: boolean;
  /** "Wait for input to start playing" (Ctrl+I). */
  waitForInput: boolean;
  /** Its menu: "Only when recording" and "Respect recording filter". */
  waitOnlyRecording: boolean;
  waitRespectFilter: boolean;
  // ---- Mixer > Options > Disk recording
  autoUnarm: boolean;
  autoClip: boolean;
  latencyComp: boolean;
  ignoreSilent: boolean;
  autoName: boolean;
  /** Format of the recorded audio files: 16 / 24 bit integer or 32 bit float. */
  bits: 16 | 24 | 32;
  // ---- Mixer > View
  showInputLevels: boolean;
}

/** FL's defaults (Countdown before recording is off by default since FL 12.9.5). */
export function defaultRecSettings(): RecSettings {
  return {
    filterAudio: true,
    audioTo: 'playlist',
    startsPlayback: false,
    disarmOnStop: true,
    markers: false,
    countdown: false,
    countdownBars: 1,
    loop: false,
    waitForInput: false,
    waitOnlyRecording: true,
    waitRespectFilter: true,
    autoUnarm: true,
    autoClip: true,
    latencyComp: true,
    ignoreSilent: false,
    autoName: false,
    bits: 32,
    showInputLevels: false,
  };
}

export function normalizeRecSettings(v: unknown): RecSettings {
  const d = defaultRecSettings();
  if (!v || typeof v !== 'object') return d;
  const o = v as Record<string, unknown>;
  const b = (k: keyof RecSettings): boolean => (typeof o[k] === 'boolean' ? (o[k] as boolean) : (d[k] as boolean));
  return {
    filterAudio: b('filterAudio'),
    audioTo: o.audioTo === 'edison' ? 'edison' : 'playlist',
    startsPlayback: b('startsPlayback'),
    disarmOnStop: b('disarmOnStop'),
    markers: b('markers'),
    countdown: b('countdown'),
    countdownBars: o.countdownBars === 2 ? 2 : 1,
    loop: b('loop'),
    waitForInput: b('waitForInput'),
    waitOnlyRecording: b('waitOnlyRecording'),
    waitRespectFilter: b('waitRespectFilter'),
    autoUnarm: b('autoUnarm'),
    autoClip: b('autoClip'),
    latencyComp: b('latencyComp'),
    ignoreSilent: b('ignoreSilent'),
    autoName: b('autoName'),
    bits: o.bits === 16 || o.bits === 24 ? o.bits : 32,
    showInputLevels: b('showInputLevels'),
  };
}

// ----------------------------------------------------------- engine session
/** The transport state of a recording session (engine side, see engine/Recording.ts). */
export type RecState = 'idle' | 'countdown' | 'waiting' | 'recording';

/** What the engine needs to run a recording session. */
export interface RecStartOptions {
  /** Count-in before the transport starts, in bars (0: none). Only applies when the transport is stopped. */
  countdownBars: number;
  /** Wait for sound on an armed input before the transport starts (applies when it is stopped). */
  waitForInput: boolean;
  /** Cut a new take every time the transport loops. */
  loop: boolean;
  /** Automatic latency compensation (the input and output latency of the audio device). */
  latencyComp: boolean;
  /** Punch in / out: the transport position (ticks) where recording starts / stops (undefined: none). */
  punchIn?: number;
  punchOut?: number;
  /** false: run the session's transport side only (count-in, wait for input, punch) and capture nothing (recording into Edison). */
  capture?: boolean;
}

/** Threshold of "Wait for input" (linear peak, about -40 dB). */
export const WAIT_THRESHOLD = 0.01;
/** A take whose peak stays below this is silent (Mixer > Disk recording > Ignore silent takes, about -60 dB). */
export const SILENT_PEAK = 0.001;
