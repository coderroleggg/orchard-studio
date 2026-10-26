// Edits of audio clips and Audio Clip channels for the Playlist and the Channel Rack (docs/audio-clips.md):
// fades and gain, slicing and chopping, trimming, making a clip unique, the clip menu's actions. Creating an audio
// clip (addAudioClip) lives in actions.ts.

import type { Draft } from 'immer';
import { store } from './index';
import type { Channel, Clip, Id, Project, SampleInfo } from '../model/types';
import { createClone, uid } from '../model/defaults';
import {
  audioClipTicks, clampClipGain, channelPitchCents, clipSeconds, resampleSpeed, sourceSeconds, CLIP_GAIN_MAX_DB, CLIP_GAIN_MIN_DB,
} from '../model/audioclip';
import { ticksPerBar } from '../model/timing';
import { flashHint } from '../ui/hint';
import { currentTick } from '../audio/live';
import { addAudioClip, deleteChannels } from './actions';
import { addRaw, storeUserSample } from '../audio/samples';
import { prepareAudioClipSample } from '../audio/audioClipSample';
import { encodeWav } from '../project/wav';
import { resampleBuffer } from '../engine/dsp/sinc';
import { defaultSampler, type StretchMode } from '../model/sampler';

type P = Draft<Project>;

export type ClipPatch = Partial<Pick<Clip, 'fadeIn' | 'fadeOut' | 'fadeInTension' | 'fadeOutTension' | 'gain'>>;

/** Set fades / gain on audio clips (consecutive edits of the same fields merge into one undo step). */
export function setAudioClipFields(ids: readonly Id[], label: string, patch: ClipPatch, mergeKey?: string): void {
  store.update(label, (d) => {
    for (const c of d.playlist.clips) {
      if (!ids.includes(c.id) || c.kind !== 'audio') continue;
      const len = c.length;
      if (patch.fadeIn !== undefined) setOrDelete(c, 'fadeIn', Math.min(len, Math.max(0, patch.fadeIn)));
      if (patch.fadeOut !== undefined) setOrDelete(c, 'fadeOut', Math.min(len, Math.max(0, patch.fadeOut)));
      if (patch.fadeInTension !== undefined) setOrDelete(c, 'fadeInTension', Math.max(-1, Math.min(1, patch.fadeInTension)));
      if (patch.fadeOutTension !== undefined) setOrDelete(c, 'fadeOutTension', Math.max(-1, Math.min(1, patch.fadeOutTension)));
      if (patch.gain !== undefined) setOrDelete(c, 'gain', clampClipGain(patch.gain));
    }
  }, { mergeKey });
}

function setOrDelete(c: Draft<Clip>, key: 'fadeIn' | 'fadeOut' | 'fadeInTension' | 'fadeOutTension' | 'gain', v: number): void {
  if (v === 0 || !Number.isFinite(v)) delete c[key];
  else c[key] = v;
}

/** Reset the fades of audio clips (FL: "Reset fades"). */
export function resetFades(ids: readonly Id[]): void {
  store.update('Reset fades', (d) => {
    for (const c of d.playlist.clips) {
      if (!ids.includes(c.id) || c.kind !== 'audio') continue;
      delete c.fadeIn; delete c.fadeOut; delete c.fadeInTension; delete c.fadeOutTension;
    }
  });
}

export const GAIN_RANGE_DB = [CLIP_GAIN_MIN_DB, CLIP_GAIN_MAX_DB] as const;

// ------------------------------------------------------------------ slicing
/**
 * Cut an audio clip in two at song tick `at`: both halves play the same
 * sample window as before, the first keeps the fade in, the second the fade
 * out. Returns the id of the second clip (null: `at` is not inside the clip).
 */
export function sliceAudioClip(clipId: Id, at: number): Id | null {
  let id: Id | null = null;
  store.update('Slice clip', (d) => { id = sliceDraft(d, clipId, at); });
  return id;
}

function sliceDraft(d: P, clipId: Id, at: number): Id | null {
  const k = d.playlist.clips.find((q) => q.id === clipId);
  if (!k || at <= k.start || at >= k.start + k.length) return null;
  const rest: Clip = { ...(k as Clip), id: uid('k'), start: at, length: k.start + k.length - at, offset: k.offset + (at - k.start) };
  if (k.kind === 'audio') {
    delete rest.fadeIn; delete rest.fadeInTension;
    delete k.fadeOut; delete k.fadeOutTension;
    // a fade that is longer than its half is cut with it
    if (k.fadeIn !== undefined && k.fadeIn > at - k.start) k.fadeIn = at - k.start;
    if (rest.fadeOut !== undefined && rest.fadeOut > rest.length) rest.fadeOut = rest.length;
  }
  k.length = at - k.start;
  d.playlist.clips.push(rest as Draft<Clip>);
  return rest.id;
}

/** FL's Chop submenu: cut the clips at every multiple of `unit` ticks that falls inside them. */
export function chopClips(ids: readonly Id[], unit: number): void {
  if (unit <= 0) return;
  store.update('Chop clips', (d) => {
    for (const id of ids) {
      const c = d.playlist.clips.find((q) => q.id === id);
      if (!c) continue;
      const start = c.start, end = c.start + c.length;
      let cur: Id = id;
      for (let t = (Math.floor(start / unit) + 1) * unit; t < end; t += unit) {
        const next = sliceDraft(d, cur, t);
        if (next) cur = next;
      }
    }
  });
}

// ------------------------------------------------------- channel level edits
export function audioChannelOf(p: Project, c: Clip): Channel | undefined {
  return c.kind === 'audio' && c.channelId ? p.channels.find((x) => x.id === c.channelId && x.kind === 'audioclip') : undefined;
}

/** Clone the clip's Audio Clip channel and point the clip at the copy (FL: Make unique). */
export function makeAudioClipUnique(clipId: Id): Id | null {
  const p = store.project;
  const clip = p.playlist.clips.find((c) => c.id === clipId);
  const src = clip ? audioChannelOf(p, clip) : undefined;
  if (!clip || !src) return null;
  const copy = createClone(src);
  copy.name = src.name.replace(/ #\d+$/, '') + ' #' + nextCopyNumber(p, src.name);
  store.update('Make unique', (d) => {
    const i = d.channels.findIndex((c) => c.id === src.id);
    d.channels.splice(i + 1, 0, copy as Draft<Channel>);
    const c = d.playlist.clips.find((x) => x.id === clipId);
    if (c) c.channelId = copy.id;
  });
  return copy.id;
}

function nextCopyNumber(p: Project, name: string): number {
  const base = name.replace(/ #\d+$/, '');
  const names = new Set(p.channels.map((c) => c.name));
  for (let i = 2; ; i++) if (!names.has(`${base} #${i}`)) return i;
}

/** Point audio clips at another Audio Clip channel (FL: Select source channel). */
export function setAudioClipSource(clipIds: readonly Id[], channelId: Id): void {
  store.update('Select source channel', (d) => {
    if (!d.channels.some((c) => c.id === channelId && c.kind === 'audioclip')) return;
    for (const c of d.playlist.clips) if (clipIds.includes(c.id) && c.kind === 'audio') c.channelId = channelId;
  });
}

/** Audio Clip channels no clip of the Playlist plays (FL: the picker panel's "Select unused" / "Delete unused audio clips"). */
export function unusedAudioClipChannels(p: Project = store.project): Id[] {
  const used = new Set<Id>();
  for (const c of p.playlist.clips) if (c.kind === 'audio' && c.channelId) used.add(c.channelId);
  return p.channels.filter((c) => c.kind === 'audioclip' && !used.has(c.id)).map((c) => c.id);
}

export function deleteUnusedAudioClips(): number {
  const ids = unusedAudioClipChannels();
  if (ids.length) deleteChannels(ids);
  return ids.length;
}

/** The Audio Clip channels of the clips (each once). */
function channelsOf(p: Project, clipIds: readonly Id[]): Id[] {
  const out = new Set<Id>();
  for (const c of p.playlist.clips) if (clipIds.includes(c.id) && c.kind === 'audio' && c.channelId) out.add(c.channelId);
  return [...out];
}

/** Reverse the sample of the clips' channels (Playlist > Edit > Reverse selected audio clips). */
export function reverseAudioClips(clipIds: readonly Id[]): void {
  const chans = channelsOf(store.project, clipIds);
  if (!chans.length) return;
  store.update('Reverse audio clips', (d) => {
    for (const c of d.channels) if (chans.includes(c.id)) c.sampler.reverse = !c.sampler.reverse;
  });
}

/**
 * Pitch the clips' channels by `cents` with the stretcher (the SMP tab's
 * PITCH: the duration is kept; FL switches Resample to Auto when PITCH moves).
 */
export function pitchAudioClips(clipIds: readonly Id[], cents: number): void {
  const chans = channelsOf(store.project, clipIds);
  if (!chans.length) return;
  store.update(cents > 0 ? 'Pitch audio clips up' : 'Pitch audio clips down', (d) => {
    for (const c of d.channels) {
      if (!chans.includes(c.id)) continue;
      const v = Math.max(-1200, Math.min(1200, c.sampler.stretchPitch + cents));
      c.sampler.stretchPitch = v;
      if (c.sampler.stretchMode === 'resample' && v !== 0) c.sampler.stretchMode = 'auto';
    }
  });
}

/**
 * Sample > Make unique as sample: the clip's channel as it sounds (the
 * precomputed tools, the stretch, the pitch, reverse) is rendered into a new
 * pool sample, and the clip gets an Audio Clip channel of its own for it with
 * the Sampler settings back at their defaults (volume, pan and routing stay).
 */
export function makeUniqueAsSample(clipId: Id): Id | null {
  const p = store.project;
  const clip = p.playlist.clips.find((c) => c.id === clipId);
  const src = clip ? audioChannelOf(p, clip) : undefined;
  if (!clip || !src) return null;
  const prep = prepareAudioClipSample(src, p.tempo, 0);
  if (!prep || !prep.data.length || !prep.data[0].length) return null;
  let data: Float32Array[] = prep.data.map((d) => d.slice());
  // Resample mode plays faster or slower (TIME, MUL, the header PITCH): bake that speed in
  const speed = resampleSpeed(data[0].length / prep.sampleRate, src.sampler, p.tempo) * Math.pow(2, (src.pitch * src.sampler.pitchRange) / 12);
  if (Math.abs(speed - 1) > 1e-6) data = data.map((c) => resampleBuffer(c, prep.sampleRate * speed, prep.sampleRate, 64));
  const id = uid('s');
  const name = src.name.replace(/ \(unique\)$/, '') + ' (unique)';
  addRaw({ id, name, channels: data, sampleRate: prep.sampleRate });
  void storeUserSample(id, encodeWav(data, prep.sampleRate, 32));
  const info: SampleInfo = { id, name, frames: data[0].length, sampleRate: prep.sampleRate, channels: data.length, source: { kind: 'user', key: id } };
  const copy = createClone(src);
  copy.name = name;
  copy.pitch = 0;
  copy.sampler = { ...defaultSampler(id), declick: src.sampler.declick, pitchRange: src.sampler.pitchRange, mainPitch: src.sampler.mainPitch, resample: src.sampler.resample };
  store.update('Make unique as sample', (d) => {
    d.samples[id] = info as Draft<SampleInfo>;
    const i = d.channels.findIndex((c) => c.id === src.id);
    d.channels.splice(i + 1, 0, copy as Draft<Channel>);
    const k = d.playlist.clips.find((x) => x.id === clipId);
    if (k) k.channelId = copy.id;
  });
  return copy.id;
}

/** Channel Rack options: switch Audio Clip channels (all of them, or those in `ids`) to a stretch mode. */
export function setStretchMode(ids: readonly Id[] | 'all', mode: StretchMode): void {
  store.update('Switch audio clip channels to a stretch mode', (d) => {
    for (const c of d.channels) if (c.kind === 'audioclip' && (ids === 'all' || ids.includes(c.id))) c.sampler.stretchMode = mode;
  });
}

/** Rename and recolour the Audio Clip channel of a clip. */
export function renameAudioClipChannel(channelId: Id, name: string, color?: string): void {
  store.update('Rename and color', (d) => {
    const c = d.channels.find((x) => x.id === channelId);
    if (!c) return;
    if (name.trim()) c.name = name.trim();
    if (color) c.color = color;
  });
}

/**
 * Sample > Fit to tempo: stretch the clip's channel so its sample spans a
 * whole number of beats at the project tempo (the power of two nearest to its
 * length, as the SMP tab's TIME > Autodetect), and give the clip that length.
 */
export function fitClipToTempo(clipId: Id): void {
  const p = store.project;
  const clip = p.playlist.clips.find((c) => c.id === clipId);
  const ch = clip ? audioChannelOf(p, clip) : undefined;
  const info = ch?.sampler.sampleId ? p.samples[ch.sampler.sampleId] : undefined;
  if (!clip || !ch || !info) return;
  const beats = detectedBeats(sourceSeconds(info, ch.sampler), p.tempo);
  store.update('Fit to tempo', (d) => {
    const c = d.channels.find((x) => x.id === ch.id);
    if (c) {
      c.sampler.stretchTimeBeats = beats;
      c.sampler.stretchMul = 0.5;
      if (c.sampler.stretchMode === 'resample') c.sampler.stretchMode = 'stretch';
    }
    const k = d.playlist.clips.find((x) => x.id === clipId);
    if (k) { k.offset = 0; k.length = Math.round(beats * p.ppq); }
  });
  flashHint(`${ch.name}: fitted to ${beats} beats at ${p.tempo} BPM`);
}

/** Beats a loop of `seconds` is most likely to span at `tempo`: the nearest power of two. */
export function detectedBeats(seconds: number, tempo: number): number {
  return Math.pow(2, Math.round(Math.log2(Math.max(1e-3, (seconds * tempo) / 60))));
}

/** Sample > Detect tempo: the tempo at which the clip's sample spans a whole number of beats (the project tempo's neighbour). */
export function detectClipTempo(clipId: Id): void {
  const p = store.project;
  const clip = p.playlist.clips.find((c) => c.id === clipId);
  const ch = clip ? audioChannelOf(p, clip) : undefined;
  const info = ch?.sampler.sampleId ? p.samples[ch.sampler.sampleId] : undefined;
  if (!ch || !info) return;
  const secs = sourceSeconds(info, ch.sampler);
  if (secs <= 0) return;
  const beats = detectedBeats(secs, p.tempo);
  flashHint(`${ch.name}: ${((beats * 60) / secs).toFixed(2)} BPM (${beats} beats)`);
}

// ---------------------------------------------------------------- positions
/** Where a new audio clip from a send / drop without a position goes: the time selection, else the playhead (song mode), else the start. */
export function audioClipInsertPosition(p: Project = store.project, playhead = 0): number {
  const sel = store.ui.playlist.timeSel;
  if (sel && sel.end > sel.start) return sel.start;
  return p.songMode ? Math.max(0, Math.round(playhead)) : 0;
}

/**
 * "Send to playlist as audio clip" (Edison, Newtone, Newtime...): a pool sample
 * becomes an Audio Clip at the insert position (the time selection, else the
 * playhead in song mode, else the start), one undo step. The pool sample may
 * be given as its SampleInfo when the project does not know it yet.
 */
export function sendToPlaylist(sample: SampleInfo | Id, name?: string): { channelId: Id; clipId: Id } {
  const info = typeof sample === 'string' ? undefined : sample;
  const id = typeof sample === 'string' ? sample : sample.id;
  store.beginGesture('Send to playlist as audio clip');
  try {
    if (info && !store.project.samples[id]) store.update('Import sample', (d) => { d.samples[id] = info as Draft<SampleInfo>; });
    const r = addAudioClip(id, audioClipInsertPosition(store.project, currentTick()), { name: name ?? info?.name });
    store.updateUi((u) => { u.playlist.selected = [r.clipId]; u.playlist.audioSource = r.channelId; u.playlist.autoSource = null; });
    flashHint(`Sent to the playlist as an audio clip: ${name ?? info?.name ?? 'audio clip'}`);
    return r;
  } finally {
    store.endGesture();
  }
}

/** Length in ticks of one pass of the clip's sample as its channel plays it now (the clip resets to this with "Reset length"). */
export function naturalClipTicks(p: Project, ch: Channel): number {
  const info = ch.sampler.sampleId ? p.samples[ch.sampler.sampleId] : undefined;
  if (!info) return ticksPerBar(p);
  return audioClipTicks(info, ch.sampler, p.tempo, p.ppq, channelPitchCents(ch));
}

/** Beats one pass of the channel's sample lasts in the Playlist now (TIME x MUL, else its length x MUL). */
export function channelDurationBeats(p: Project, ch: Channel): number {
  const info = ch.sampler.sampleId ? p.samples[ch.sampler.sampleId] : undefined;
  if (!info) return 0;
  return (clipSeconds(sourceSeconds(info, ch.sampler), ch.sampler, p.tempo) * p.tempo) / 60;
}

/**
 * Stretch on resize (Shift+M): re-time the clip's channel so one pass of its
 * sample lasts `beats` beats (TIME, with the channel's MUL). Not compounding:
 * the caller computes `beats` from the duration at the start of the drag.
 */
export function setStretchDuration(channelId: Id, beats: number): void {
  if (!(beats > 0) || !Number.isFinite(beats)) return;
  store.update('Stretch audio clip', (d) => {
    const c = d.channels.find((x) => x.id === channelId);
    if (!c) return;
    const mul = Math.pow(16, c.sampler.stretchMul) / 4;
    c.sampler.stretchTimeBeats = Math.max(0.001, Math.min(512, Math.round((beats / mul) * 1000) / 1000));
  });
}

