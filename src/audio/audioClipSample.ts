// The buffer an Audio Clip channel plays: the channel's sample with the
// Sampler's precomputed tools applied (src/audio/samples.ts prepareSample) and,
// in the stretch modes other than Resample, rendered offline to the duration
// and pitch the SMP tab's TIME / MUL / PITCH ask for (src/audio/stretch.ts).
// Shared by the live host (AudioHost) and the project export, so both play the
// same sample. Resample mode needs no render: the engine changes the speed.

import type { Channel } from '../model/types';
import { clipSeconds, stretcherActive } from '../model/audioclip';
import { getCachedBuffer, isPrepared, prepareSample, putCachedBuffer, type PreparedSample } from './samples';
import { stretchSample } from './stretch';

/** Frames of the stretched sample: its duration in the Playlist at `tempo`. */
function stretchedFrames(base: PreparedSample, c: Channel, tempo: number): number {
  const rate = base.sampleRate;
  const secs = clipSeconds(base.data[0].length / rate, c.sampler, tempo);
  return Math.max(1, Math.round(secs * rate));
}

function stretchedKey(base: PreparedSample, c: Channel, frames: number): string {
  return `${base.key}|st:${c.sampler.stretchMode}:${c.sampler.stretchPitch}:${frames}`;
}

/** The sample an Audio Clip channel plays at `tempo` for an engine running at `targetRate` (null: no sample). */
export function prepareAudioClipSample(c: Channel, tempo: number, targetRate: number): PreparedSample | null {
  const s = c.sampler;
  if (!s.sampleId) return null;
  const base = prepareSample(s.sampleId, s, targetRate);
  if (!base || !base.data.length || !base.data[0].length || !stretcherActive(s)) return base;
  const frames = stretchedFrames(base, c, tempo);
  const key = stretchedKey(base, c, frames);
  let data = getCachedBuffer(key);
  if (!data) {
    data = stretchSample({ channels: base.data, sampleRate: base.sampleRate, outFrames: frames, pitchCents: s.stretchPitch, mode: s.stretchMode });
    putCachedBuffer(key, data);
  }
  return { key, data, sampleRate: base.sampleRate };
}

/** Is the sample of `prepareAudioClipSample` ready (no rendering needed)? */
export function isAudioClipPrepared(c: Channel, tempo: number, targetRate: number): boolean {
  const s = c.sampler;
  if (!s.sampleId) return true;
  if (!isPrepared(s.sampleId, s, targetRate)) return false;
  if (!stretcherActive(s)) return true;
  const base = prepareSample(s.sampleId, s, targetRate);
  if (!base || !base.data.length || !base.data[0].length) return true;
  return getCachedBuffer(stretchedKey(base, c, stretchedFrames(base, c, tempo))) !== undefined;
}
