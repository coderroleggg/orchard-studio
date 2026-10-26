// Audio Clips: FL's Audio Clip channel and the audio clips in the Playlist
// (docs/audio-clips.md). The model helpers shared by the engine, the store,
// the Playlist UI and the tests: defaults, the clip gain and fade laws, and the
// time mapping between the Playlist (ticks) and the sample (seconds), which
// follows the Sampler channel's time stretching settings.

import type { Channel, Clip, Id, SampleInfo } from './types';
import { defaultSampler, stretchMultiplier, tensionShape, type DeclickMode, type SamplerSettings, type StretchMode } from './sampler';

/**
 * The declick modes marked "(bleeding)": at the end of a clip that cuts its
 * sample the fade out does not happen inside the clip but after its end, so
 * the sound bleeds into what follows. The other modes fade inside the clip.
 */
export function declickBleeds(mode: DeclickMode): boolean {
  return mode === 'transientBleed' || mode === 'generic' || mode === 'smooth' || mode === 'crossfade';
}

/** The SMP tab's stretch mode names (the Channel Rack's "Switch audio clip channels to" menus use them too). */
export const STRETCH_MODE_LABELS: Record<StretchMode, string> = {
  resample: 'Resample', stretch: 'Stretch', e3generic: 'E3 Generic', e3mono: 'E3 Mono', slicestretch: 'Slice stretch', slicemap: 'Slice map', auto: 'Auto',
};

/** Audio Clip channels play the sample at its original level by default (the Sampler's default is 78%). */
export const AUDIO_CLIP_VOLUME_DEFAULT = 1;
/** Default colour of an audio clip channel (and its clips). */
export const AUDIO_CLIP_COLOR = '#4f7a86';

/** Clip gain range in dB: the bottom of the gain handle is silence. */
export const CLIP_GAIN_MIN_DB = -60;
export const CLIP_GAIN_MAX_DB = 12;

export type AudioClip = Clip & { kind: 'audio'; channelId: Id };

export function isAudioClip(c: Clip): c is AudioClip {
  return c.kind === 'audio' && typeof c.channelId === 'string';
}

/** The Sampler settings of a new Audio Clip channel: the Sampler's defaults (stretch Resample, no time, declick Out only). */
export function audioClipSampler(sampleId: Id | null): SamplerSettings {
  return defaultSampler(sampleId);
}

// ------------------------------------------------------------- gain and fades
/** Clip gain (dB) -> linear gain; the bottom of the range is silence. */
export function clipGainLinear(db: number | undefined): number {
  if (db === undefined || db === 0) return 1;
  if (db <= CLIP_GAIN_MIN_DB) return 0;
  return Math.pow(10, Math.min(CLIP_GAIN_MAX_DB, db) / 20);
}

export function clampClipGain(db: number): number {
  return Math.max(CLIP_GAIN_MIN_DB, Math.min(CLIP_GAIN_MAX_DB, db));
}

export function formatClipGain(db: number | undefined): string {
  const v = db ?? 0;
  if (v <= CLIP_GAIN_MIN_DB) return '-inf dB';
  return `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)} dB`;
}

/**
 * A fade curve: gain 0..1 for the fraction `u` (0..1) of a fade in, tension
 * -1..1 (0 = linear; positive: slow start and fast end; negative: the other
 * way round). A fade out is the same curve played backwards, with `u` the
 * fraction of the fade that is left.
 */
export function fadeShape(u: number, tension = 0): number {
  return tensionShape(u, tension);
}

/**
 * Automatic crossfades: the clips of a track (sorted by start) that overlap
 * crossfade over the overlap, the earlier one fading out and the later one in.
 * A fade the clip has already stays if it is longer. Works on any objects with
 * start / end / track and fadeIn / fadeOut lengths in ticks (the engine's
 * compiled clips and the Playlist's drawing).
 */
export function crossfadeOverlaps<T extends { track: number; start: number; end: number; fadeIn: number; fadeOut: number }>(sorted: T[]): void {
  const lastOnTrack = new Map<number, T>();
  for (const b of sorted) {
    const a = lastOnTrack.get(b.track);
    if (a && b.start < a.end && b.end > a.end) {
      const overlap = a.end - b.start;
      a.fadeOut = Math.max(a.fadeOut, overlap);
      b.fadeIn = Math.max(b.fadeIn, overlap);
    }
    // the clip that reaches furthest is the one a later clip overlaps
    if (!a || b.end >= a.end) lastOnTrack.set(b.track, b);
  }
}

// -------------------------------------------------------------- time mapping
/** Frames the channel plays of a sample of `frames` frames: SMP START .. LENGTH of the Sampler's precomputed tools. */
export function trimmedFrames(frames: number, s: SamplerSettings): number {
  const a = Math.floor(Math.min(0.999, Math.max(0, s.smpStart)) * frames);
  const b = Math.max(a + 1, Math.floor(Math.min(1, Math.max(0, s.length)) * frames));
  return Math.max(1, b - a);
}

/** Seconds of sample the channel plays at its original speed. */
export function sourceSeconds(info: Pick<SampleInfo, 'frames' | 'sampleRate'>, s: SamplerSettings): number {
  return info.sampleRate > 0 ? trimmedFrames(info.frames, s) / info.sampleRate : 0;
}

/** A non-Resample stretch mode: the sample is re-rendered offline by the time stretcher (src/audio/stretch.ts). */
export function usesStretcher(s: SamplerSettings): boolean {
  return s.stretchMode !== 'resample';
}

/** The stretcher has something to do: a time change (TIME, MUL) or a pitch shift. */
export function stretcherActive(s: SamplerSettings): boolean {
  return usesStretcher(s) && (s.stretchTimeBeats > 0 || Math.abs(stretchMultiplier(s.stretchMul) - 1) > 1e-9 || s.stretchPitch !== 0);
}

/** The stretched sample follows the project tempo (TIME set), so tempo changes re-render it. */
export function followsTempo(s: SamplerSettings): boolean {
  return s.stretchTimeBeats > 0;
}

/**
 * Seconds one pass of the sample lasts in the Playlist at `tempo` (the
 * header's PITCH aside): TIME beats x MUL, else the sample's length x MUL.
 * Resample mode gets there by changing the speed, the other modes by
 * stretching the sample without changing its pitch.
 */
export function clipSeconds(srcSeconds: number, s: SamplerSettings, tempo: number): number {
  const mul = stretchMultiplier(s.stretchMul);
  if (s.stretchTimeBeats > 0) return ((s.stretchTimeBeats * 60) / tempo) * mul;
  return srcSeconds * mul;
}

/**
 * Resample mode: source seconds played per second of Playlist time (the
 * Sampler's `stretch`). 1 in the other modes (their stretched sample already
 * has the Playlist's duration).
 */
export function resampleSpeed(srcSeconds: number, s: SamplerSettings, tempo: number): number {
  if (s.stretchMode !== 'resample') return 1;
  const mul = stretchMultiplier(s.stretchMul);
  if (s.stretchTimeBeats > 0) return srcSeconds / (((s.stretchTimeBeats * 60) / tempo) * mul);
  return 1 / mul;
}

/** Playlist length in ticks of one pass of the sample at `tempo`, with the channel's pitch in cents (resample speed). */
export function audioClipTicks(
  info: Pick<SampleInfo, 'frames' | 'sampleRate'>, s: SamplerSettings, tempo: number, ppq: number, pitchCents = 0,
): number {
  const src = sourceSeconds(info, s);
  const secs = clipSeconds(src, s, tempo) / Math.pow(2, pitchCents / 1200);
  return Math.max(1, Math.ceil((secs * tempo * ppq) / 60 - 1e-6));
}

/** The header PITCH and the main pitch (when the channel follows it) in cents. */
export function channelPitchCents(c: Pick<Channel, 'pitch' | 'sampler'>, mainPitch = 0): number {
  return c.pitch * c.sampler.pitchRange * 100 + (c.sampler.mainPitch ? mainPitch * 1200 : 0);
}

// ------------------------------------------------------------- normalisation
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Sanitise the audio fields of a stored clip: fade lengths within the clip,
 * tensions -1..1, gain within range. Defaults are left out so a plain clip
 * serialises as before.
 */
export function normalizeAudioClip(c: Clip): Clip {
  const out: Clip = { ...c };
  const len = Math.max(0, num(c.length, 0));
  const fi = Math.min(len, Math.max(0, num(c.fadeIn, 0)));
  const fo = Math.min(len, Math.max(0, num(c.fadeOut, 0)));
  const ti = Math.max(-1, Math.min(1, num(c.fadeInTension, 0)));
  const to = Math.max(-1, Math.min(1, num(c.fadeOutTension, 0)));
  const g = clampClipGain(num(c.gain, 0));
  if (fi > 0) out.fadeIn = fi; else delete out.fadeIn;
  if (fo > 0) out.fadeOut = fo; else delete out.fadeOut;
  if (ti !== 0) out.fadeInTension = ti; else delete out.fadeInTension;
  if (to !== 0) out.fadeOutTension = to; else delete out.fadeOutTension;
  if (g !== 0) out.gain = g; else delete out.gain;
  if (c.kind !== 'audio') {
    delete out.channelId;
    delete out.fadeIn; delete out.fadeOut; delete out.fadeInTension; delete out.fadeOutTension; delete out.gain;
  }
  return out;
}
