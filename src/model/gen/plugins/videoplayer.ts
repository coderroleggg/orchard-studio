// Video Player (FL: Fruity Video Player, Plugin database > Generators > Visual):
// plays a video file next to the project. The picture is shown in the plugin's
// own window (editor / detached window, src/ui/plugins/gen/videoplayer); the
// file's audio is decoded into a pool sample and played by the engine plugin
// (src/engine/gen/plugins/videoplayer.ts) through the channel's mixer track,
// in sync with the song while "Link transport" is on. See
// docs/research/gen/videoplayer.md.
//
// From FL 2026's binary and test host: three parameters ("Volume" 0..127,
// "Mute audio", "P lay / pause" with FL's spelling; the host reports no value
// texts for them), flags Generator | GetNoteInput | MIDIOut | NewVoiceParams |
// CantSmartDisable, Gen_Render style with notes that do nothing (TriggerVoice
// returns no voice), one factory preset ("Default": volume 100) and the form's
// player layout (SynthPanel 410 x 453: the picture and a 100 px control panel).
// The plugin's saved state is 9 integers and a file name (see the research
// note); the clone keeps the non-parameter state under the keys below.
//
// This file also holds the pure helpers the engine and the editor share: the
// state reader, the time displays (milliseconds / SMPTE) and the mapping of
// the song position to the video's time.

import type { GenPluginDef } from '../types';

// ------------------------------------------------------------------ state

/** The player's state (the channel's plugin params): FL's three parameters plus the plugin's own state. */
export interface VpState {
  /** Volume 0..127 (FL parameter 0). */
  volume: number;
  /** Mute audio (parameter 1). */
  mute: boolean;
  /** Play / pause (parameter 2): the player's own playback while "Link transport" is off. */
  play: boolean;
  /** Name of the loaded video file ('' = none). */
  file: string;
  /** Key of the video's bytes in the browser's file store ('' = none). */
  videoKey: string;
  /** MIME type of the video file. */
  videoType: string;
  /** Pool sample id of the video's decoded audio ('' = none / not decodable). Its key contains "sample": the engine receives it. */
  sampleId: string;
  /** Length of the clip in seconds (0 = unknown / no video). */
  duration: number;
  /** Frame rate measured when the file was loaded (0 = unknown). */
  fps: number;
  /** Options menu: Enable audio, Dock control panel, Keep aspect ratio. */
  audio: boolean;
  dock: boolean;
  aspect: boolean;
  /** Link transport (H): the song position drives the video. */
  link: boolean;
  /** Loop (L) the play range. */
  loop: boolean;
  /** Time display: 0 = H:M:S:Ms, 1..14 = FL's SMPTE menu entries (VP_TIME_MODES). */
  timeMode: number;
  /** Play range start in seconds of the video; negative: the video starts later than the project ("Delay playback by"). */
  start: number;
  /** Play range end in seconds (0 = the end of the clip). */
  end: number;
  /** The video's position while the player is not following the song (seconds). */
  pos: number;
  /** Counts position changes made by the user: the engine jumps to `pos` when it changes. */
  seek: number;
  /** The player's detached window is open. */
  detached: boolean;
  /** The detached window's rectangle [x, y, w, h]. */
  rect: number[];
}

/** Default detached window rectangle (FL's DetachedForm 563 x 447 client + the window chrome). */
export const VP_RECT: number[] = [180, 90, 565, 473];

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Longest position / range the player takes (a day). */
const MAX_SEC = 86400;

/** Read the player's state from a params object (missing or invalid fields take their defaults). */
export function vpState(p: Record<string, unknown>): VpState {
  const rect = Array.isArray(p.rect) && p.rect.length === 4 && p.rect.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (p.rect as number[]) : VP_RECT;
  const mode = typeof p.timeMode === 'number' && Number.isFinite(p.timeMode) ? Math.round(p.timeMode) : 0;
  return {
    volume: Math.round(num(p.volume, 127, 0, 127)),
    mute: num(p.mute, 0) >= 0.5,
    play: num(p.play, 0) >= 0.5,
    file: str(p.file),
    videoKey: str(p.videoKey),
    videoType: str(p.videoType),
    sampleId: str(p.sampleId),
    duration: num(p.duration, 0, 0, MAX_SEC),
    fps: num(p.fps, 0, 0, 1000),
    audio: bool(p.audio, true),
    dock: bool(p.dock, true),
    aspect: bool(p.aspect, true),
    link: bool(p.link, true),
    loop: bool(p.loop, false),
    timeMode: VP_TIME_MODES.some((m) => m.tag === mode) ? mode : 0,
    start: num(p.start, 0, -MAX_SEC, MAX_SEC),
    end: num(p.end, 0, 0, MAX_SEC),
    pos: num(p.pos, 0, 0, MAX_SEC),
    seek: Math.round(num(p.seek, 0, 0, 1e9)),
    detached: bool(p.detached, false),
    rect: rect.slice(),
  };
}

// ------------------------------------------------------------------ time

/** One entry of FL's Time display menu (the menu items' Tag). */
export interface VpTimeMode {
  tag: number;
  /** FL's menu caption. */
  label: string;
  /** Frames per second (0: milliseconds / the clip's own rate for Auto). */
  fps: number;
  drop: boolean;
  auto?: boolean;
}

/** FL's Time display menu in the form's order. */
export const VP_TIME_MODES: VpTimeMode[] = [
  { tag: 0, label: 'Hours:Minutes:Seconds:Ms', fps: 0, drop: false },
  { tag: 1, label: 'SMPTE (23.976 fps NONDROP)', fps: 24000 / 1001, drop: false },
  { tag: 2, label: 'SMPTE (24 fps NONDROP)', fps: 24, drop: false },
  { tag: 3, label: 'SMPTE (25 fps NONDROP)', fps: 25, drop: false },
  { tag: 4, label: 'SMPTE (29.97 fps DROP)', fps: 30000 / 1001, drop: true },
  { tag: 7, label: 'SMPTE (29.97 fps NONDROP)', fps: 30000 / 1001, drop: false },
  { tag: 5, label: 'SMPTE (30 fps NONDROP)', fps: 30, drop: false },
  { tag: 8, label: 'SMPTE (48fps NONDROP)', fps: 48, drop: false },
  { tag: 9, label: 'SMPTE (50fps NONDROP)', fps: 50, drop: false },
  { tag: 10, label: 'SMPTE (59.94 fps DROP)', fps: 60000 / 1001, drop: true },
  { tag: 11, label: 'SMPTE (59.94 fps NONDROP)', fps: 60000 / 1001, drop: false },
  { tag: 13, label: 'SMPTE (72 fps NONDROP)', fps: 72, drop: false },
  { tag: 12, label: 'SMPTE (60 fps NONDROP)', fps: 60, drop: false },
  { tag: 14, label: 'SMPTE (120 fps NONDROP)', fps: 120, drop: false },
  { tag: 6, label: 'SMPTE (Auto)', fps: 0, drop: false, auto: true },
];

/** Frame rate the SMPTE display counts with: the mode's own, the clip's for Auto (25 when unknown), 0 for milliseconds. */
export function timeModeFps(mode: number, clipFps: number): number {
  const m = VP_TIME_MODES.find((x) => x.tag === mode);
  if (!m || (m.fps === 0 && !m.auto)) return 0;
  if (m.auto) return clipFps > 0 ? clipFps : 25;
  return m.fps;
}

/** FL's caption of an entry of the Time display menu (Auto shows the clip's rate: "SMPTE (Auto : 25 fps)"). */
export function timeModeLabel(m: VpTimeMode, clipFps: number): string {
  if (!m.auto) return m.label;
  const f = clipFps > 0 ? clipFps : 25;
  return `SMPTE (Auto : ${Math.round(f * 100) / 100} fps)`;
}

/** Frame rates files commonly have: measured rates snap to them. */
const COMMON_FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 72, 120];

/** Snap a measured frame rate to the nearest common one (within 1.5%), else round it to two decimals; 0 for nonsense. */
export function snapFps(f: number): number {
  if (!Number.isFinite(f) || f < 1 || f > 1000) return 0;
  let best = 0, bd = Infinity;
  for (const c of COMMON_FPS) {
    const d = Math.abs(c - f) / c;
    if (d < bd) { bd = d; best = c; }
  }
  return bd <= 0.015 ? best : Math.round(f * 100) / 100;
}

const pad = (v: number, n: number): string => String(v).padStart(n, '0');

/** Nominal frame count per second of a SMPTE rate (23.976 -> 24, 29.97 -> 30). */
function nominalFps(fps: number): number {
  return Math.max(1, Math.round(fps));
}

/** Frames dropped at the start of each minute (except every tenth) by drop-frame timecode. */
function dropFrames(fps: number): number {
  return nominalFps(fps) >= 60 ? 4 : 2;
}

/** Frame number (counted from 0) -> timecode fields [h, m, s, f] (SMPTE; drop-frame skips frame numbers like SMPTE does). */
export function frameToTimecode(frame: number, fps: number, drop: boolean): [number, number, number, number] {
  const base = nominalFps(fps);
  let n = Math.max(0, Math.floor(frame));
  if (drop) {
    const d = dropFrames(fps);
    const perMin = base * 60 - d;
    const per10 = base * 600 - d * 9;
    const tens = Math.floor(n / per10);
    const rest = n % per10;
    n += d * 9 * tens + (rest > d ? d * Math.floor((rest - d) / perMin) : 0);
  }
  const f = n % base;
  const secs = Math.floor(n / base);
  return [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60, f];
}

/** Timecode fields -> frame number (the inverse of frameToTimecode). */
export function timecodeToFrame(h: number, m: number, s: number, f: number, fps: number, drop: boolean): number {
  const base = nominalFps(fps);
  let n = ((h * 60 + m) * 60 + s) * base + f;
  if (drop) {
    const d = dropFrames(fps);
    const totalMin = h * 60 + m;
    n -= d * (totalMin - Math.floor(totalMin / 10));
  }
  return Math.max(0, n);
}

/** The fields the Set time dialog edits [hours, minutes, seconds, ms or frames] for a time in seconds (the sign is separate). */
export function timeFields(sec: number, mode: number, clipFps: number): [number, number, number, number] {
  const t = Math.abs(sec);
  const fps = timeModeFps(mode, clipFps);
  if (fps <= 0) {
    const ms = Math.round(t * 1000);
    return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60, ms % 1000];
  }
  const drop = VP_TIME_MODES.find((x) => x.tag === mode)?.drop ?? false;
  return frameToTimecode(Math.floor(t * fps + 1e-6), fps, drop);
}

/** Seconds of the Set time dialog's fields. */
export function fieldsToTime(h: number, m: number, s: number, x: number, mode: number, clipFps: number): number {
  const fps = timeModeFps(mode, clipFps);
  if (fps <= 0) return h * 3600 + m * 60 + s + x / 1000;
  const drop = VP_TIME_MODES.find((q) => q.tag === mode)?.drop ?? false;
  return timecodeToFrame(h, m, s, x, fps, drop) / fps;
}

/** Largest value of the dialog's last field (999 ms, or the frames per second - 1). */
export function lastFieldMax(mode: number, clipFps: number): number {
  const fps = timeModeFps(mode, clipFps);
  return fps <= 0 ? 999 : nominalFps(fps) - 1;
}

/**
 * FL's time readout: "0:00:06:262" (hours, minutes, seconds, milliseconds), or
 * "0:00:06:06" in a SMPTE mode (the last digits are the frame number; drop
 * frame counts show ";" before it). Negative times (a delayed start) get a minus sign.
 */
export function formatVideoTime(sec: number, mode: number, clipFps: number): string {
  const neg = sec < 0 && Math.abs(sec) >= 0.0005;
  const [h, m, s, x] = timeFields(sec, mode, clipFps);
  const fps = timeModeFps(mode, clipFps);
  const drop = VP_TIME_MODES.find((q) => q.tag === mode)?.drop ?? false;
  const last = fps <= 0 ? pad(x, 3) : pad(x, nominalFps(fps) >= 100 ? 3 : 2);
  return `${neg ? '-' : ''}${h}:${pad(m, 2)}:${pad(s, 2)}${drop ? ';' : ':'}${last}`;
}

/** FL's titles of the Set time dialog: "Start time (H:M:S:MS)", "End time (H:M:S:Frame)". */
export function timeDialogTitle(what: 'Start' | 'End' | 'Current', mode: number): string {
  return `${what} time (${mode === 0 ? 'H:M:S:MS' : 'H:M:S:Frame'})`;
}

// ------------------------------------------------------------------ position mapping

/** The play range [lo, hi] in seconds of the video for a state and the clip's length. */
export function playRange(start: number, end: number, duration: number): { lo: number; hi: number } {
  return { lo: rangeStart(start), hi: rangeEnd(end, duration) };
}

/** The start of the play range: the start time, never before the clip (a negative start delays the video instead). */
export function rangeStart(start: number): number {
  return Math.max(0, start);
}

/** The end of the play range: the end time inside the clip, the clip's end when it is 0. */
export function rangeEnd(end: number, duration: number): number {
  return end > 0 ? (duration > 0 ? Math.min(end, duration) : end) : duration;
}

/**
 * The video's time at a song time while the player follows the song (Link
 * transport): the song's start shows the video at `start` (a negative start
 * delays the video: it begins `-start` seconds into the song), the video plays
 * to the end of the range, where it stops (or wraps with Loop). `on` is false
 * before the delayed start and after the end (the picture holds its first /
 * last frame, no sound).
 */
export function videoMap(start: number, lo: number, hi: number, loop: boolean, songSec: number): { t: number; on: boolean } {
  return { t: videoMapTime(start, lo, hi, loop, songSec), on: videoMapOn(start, lo, hi, loop, songSec) };
}

/** videoMap's time, without an object (the audio thread). */
export function videoMapTime(start: number, lo: number, hi: number, loop: boolean, songSec: number): number {
  if (!(hi > lo)) return lo;
  const x = start + songSec;
  if (x < lo) return lo;
  if (x >= hi) return loop ? lo + ((x - lo) % (hi - lo)) : hi;
  return x;
}

/** videoMap's `on` flag: the video plays at this song time. */
export function videoMapOn(start: number, lo: number, hi: number, loop: boolean, songSec: number): boolean {
  if (!(hi > lo)) return false;
  const x = start + songSec;
  return x >= lo && (x < hi || loop);
}

/** Song position in ticks -> seconds at a tempo. */
export function ticksToSeconds(ticks: number, tempo: number, ppq: number): number {
  return (ticks * 60) / (tempo * ppq);
}

// ------------------------------------------------------------------ audio level

/**
 * Gain of the Volume parameter (0..127): linear, 127 plays the video's audio
 * at its own level. TODO(test host): the law is assumed; the host cannot load
 * a video, so FL's curve is unmeasured (docs/research/gen/videoplayer.md).
 */
export function volumeGain(volume: number): number {
  return Math.min(127, Math.max(0, volume)) / 127;
}

// ------------------------------------------------------------------ definition

/** FL's value text of Volume: no text of its own, so the control's percentage of its range. */
const percent = (v: number): string => `${Math.round((v / 127) * 100)}%`;
const onOff = (v: number): string => (v >= 0.5 ? 'On' : 'Off');

/** The video file's reference and the window state survive a preset load. */
const KEEP = ['file', 'videoKey', 'videoType', 'sampleId', 'duration', 'fps', 'start', 'end', 'pos', 'seek', 'detached', 'rect'];

const defaults = (): Record<string, unknown> => ({
  file: '', videoKey: '', videoType: '', sampleId: '', duration: 0, fps: 0,
  audio: true, dock: true, aspect: true, link: true, loop: false, timeMode: 0,
  start: 0, end: 0, pos: 0, seek: 0, detached: false, rect: VP_RECT.slice(),
});

export const def: GenPluginDef = {
  id: 'videoplayer',
  name: 'Video Player',
  category: 'Visual',
  // Gen_Render: the plugin mixes its own audio; notes do nothing (TriggerVoice returns no voice)
  notes: 'events',
  width: 410,
  height: 453,
  description: 'A video file player',
  params: [
    { key: 'volume', name: 'Volume', index: 0, min: 0, max: 127, def: 127, format: percent, parse: (t) => Math.round((t / 100) * 127) },
    { key: 'mute', name: 'Mute audio', index: 1, min: 0, max: 1, def: 0, format: onOff },
    { key: 'play', name: 'P lay / pause', index: 2, min: 0, max: 1, def: 0, format: onOff },
  ],
  state: defaults,
  viewState: KEEP,
  normalize: (p) => {
    const s = vpState(p);
    return {
      ...p,
      volume: s.volume, mute: s.mute ? 1 : 0,
      // a saved project never starts playing by itself
      play: 0,
      file: s.file, videoKey: s.videoKey, videoType: s.videoType, sampleId: s.sampleId, duration: s.duration, fps: s.fps,
      audio: s.audio, dock: s.dock, aspect: s.aspect, link: s.link, loop: s.loop, timeMode: s.timeMode,
      start: s.start, end: s.end, pos: s.pos, seek: s.seek, detached: s.detached, rect: s.rect,
    };
  },
  presets: [
    // FL's only factory preset: the player's defaults with Volume 100 (state: 3, 146, 0, 3, 100, 0, 0, 96000, 0)
    { name: 'Default', params: { volume: 100 } },
  ],
};
