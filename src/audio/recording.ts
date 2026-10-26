// Audio recording in the application: wires the Recorder (audio/Recorder.ts) to
// the store, the audio host, the sample pool and the Playlist, and holds the
// actions the Record button, the toolbar switches, the mixer and the menus call.
// docs/recording.md describes the behaviour against FL's.

import type { Draft } from 'immer';
import { store, host } from '../store';
import * as A from '../store/actions';
import { live, emitLive } from './live';
import { addRaw, storeUserSample } from './samples';
import { Recorder, type FinishedTake, type RecEnv, type SessionInfo } from './Recorder';
import { saveRecSettings } from './recSettings';
import { encodeWav } from '../project/wav';
import { createAudioClipChannel, mixerTrackName, uid } from '../model/defaults';
import type { Channel, Id, Project, SampleInfo } from '../model/types';
import type { RecSettings, TrackInput } from '../model/recording';
import { flashHint } from '../ui/hint';

// ---------------------------------------------------------------- settings
/** Change recording options (kept across sessions). */
export function setRec(patch: Partial<RecSettings>): void {
  store.updateUi((u) => { Object.assign(u.rec, patch); });
  saveRecSettings(store.ui.rec);
  if ('showInputLevels' in patch) host.send({ t: 'inputLevels', on: store.ui.rec.showInputLevels });
}

/** The Record button on / off. */
export function setRecordArmed(on: boolean): void {
  if (store.ui.recording !== on) store.updateUi((u) => { u.recording = on; });
}

// ------------------------------------------------------------ mixer tracks
/** "Arm disk recording" on a mixer track (the browser asks for the microphone the first time). */
export function armTrack(index: number, on: boolean): void {
  const t = store.project.mixer.tracks[index];
  if (!t || index < 1 || index > 125 || !!t.armed === on) return;
  A.setMixer(index, 'armed', on, on ? 'Arm disk recording' : 'Disarm recording');
  if (on && t.input) {
    void host.input.ensureOpen();
    // an armed track plays its input through the mixer (Monitor external input: When armed): a microphone next to the speakers howls
    if (!warnedFeedback && (t.monitor ?? 'armed') !== 'off') {
      warnedFeedback = true;
      flashHint('The armed input is monitored through the mixer: use headphones to avoid feedback (Monitor external input: Off)');
    }
  }
}
let warnedFeedback = false;

/** Choose the audio input of a mixer track (undefined: none). */
export function setTrackInput(index: number, input: TrackInput | undefined): void {
  if (index < 1 || index > 125) return;
  if (inputLocked([index])) return;
  A.setMixer(index, 'input', input, 'Mixer track input');
  if (input) void host.input.ensureOpen();
}

/** FL: "The input of a mixer track can't be changed while recording." (true: it is being recorded, nothing was changed) */
export function inputLocked(tracks: number[]): boolean {
  if (!tracks.some((t) => recorder.records(t))) return false;
  flashHint("The input of a mixer track can't be changed while recording");
  return true;
}

// --------------------------------------------------------------- the store
/** Store the takes of a recording: pool samples (kept like user files), Audio Clip channels and Playlist clips, one undo step. */
export function commitRecording(takes: FinishedTake[], session: SessionInfo): void {
  const s = session.settings;
  const tickFrames = (takes[0]?.sampleRate ?? host.sampleRate) * 60 / (store.project.tempo * store.project.ppq);
  store.beginGesture('Record audio');
  try {
    const clipsOfTrack = new Map<number, { take: number; clip: Id }[]>();
    for (const t of takes) {
      const id = uid('s');
      addRaw({ id, name: t.name, channels: [t.L, t.R], sampleRate: t.sampleRate });
      // the file behind the pool sample, so that the recording survives a reload like any user sample
      // (encoded a moment later: a long take takes a while and the Playlist should show the clip first)
      setTimeout(() => {
        try { void storeUserSample(id, encodeWav([t.L, t.R], t.sampleRate, s.bits)).catch(() => {}); } catch { /* storage unavailable */ }
      }, 0);
      if (session.songMode && s.autoClip) {
        const { clipId } = A.addAudioClip(id, t.startTick, { mixerTrack: t.track, name: t.name });
        trimToWholeTicks(clipId, t.L.length / tickFrames, tickFrames);
        const list = clipsOfTrack.get(t.track) ?? [];
        list.push({ take: t.take, clip: clipId });
        clipsOfTrack.set(t.track, list);
        if (s.autoName) nameTrackOfClip(clipId, t);
      } else {
        // pattern mode, or "Auto-create audio clip" off: the recording becomes an Audio Clip channel only
        addChannelOnly(id, t);
      }
    }
    // loop recording: the takes before the last one are muted, the last one plays
    const mute = new Set<Id>();
    for (const list of clipsOfTrack.values()) {
      const last = Math.max(...list.map((x) => x.take));
      for (const x of list) if (x.take !== last) mute.add(x.clip);
    }
    if (mute.size) A.updateClips('Mute earlier takes', (clips) => { for (const c of clips) if (mute.has(c.id)) c.muted = true; });
    if (s.autoUnarm) for (const tr of session.tracks) if (store.project.mixer.tracks[tr]?.armed) A.setMixer(tr, 'armed', false, 'Disarm recording');
  } finally {
    store.endGesture();
  }
  if (session.edison) return;
  const n = takes.length;
  const what = n === 0 ? 'Nothing was recorded' : n === 1 ? `Recorded ${takes[0].name}` : `Recorded ${n} takes`;
  // Pattern mode and "Auto-create audio clip" off make only the Audio Clip channel: say where the audio went
  flashHint(n > 0 && !(session.songMode && s.autoClip) ? `${what}: an Audio Clip channel (a clip in the Playlist needs Song mode and Auto-create audio clip)` : what);
}

/**
 * A take that is a whole number of ticks long to within a frame or two (a loop recording of whole bars at
 * a tempo whose bar is not a whole number of frames) gets a clip of exactly those ticks, not one tick more.
 */
function trimToWholeTicks(clipId: Id, ticks: number, tickFrames: number): void {
  const whole = Math.round(ticks);
  if (whole < 1 || Math.abs(ticks - whole) * tickFrames > 2) return;
  const clip = store.project.playlist.clips.find((c) => c.id === clipId);
  if (clip && clip.length !== whole) A.updateClips('Clip length', (clips) => { const c = clips.find((x) => x.id === clipId); if (c) c.length = whole; });
}

function nameTrackOfClip(clipId: Id, t: FinishedTake): void {
  const clip = store.project.playlist.clips.find((c) => c.id === clipId);
  const pt = clip ? store.project.playlist.tracks[clip.track] : undefined;
  if (clip && pt && /^Track \d+$/.test(pt.name)) {
    const tr = store.project.mixer.tracks[t.track];
    A.setPlaylistTrack(clip.track, 'name', tr?.recordName?.trim() || (tr ? mixerTrackName(tr) : t.name), 'Name track');
  }
}

/** A recording that does not go to the Playlist: an Audio Clip channel holding it (FL creates the channel anyway). */
function addChannelOnly(sampleId: Id, t: FinishedTake): void {
  const info: SampleInfo = {
    id: sampleId, name: t.name, frames: t.L.length, sampleRate: t.sampleRate, channels: 2, source: { kind: 'user', key: sampleId },
  };
  const ch = createAudioClipChannel(t.name, sampleId, t.track);
  store.update('Add audio clip', (d: Draft<Project>) => {
    d.samples[sampleId] = info as Draft<SampleInfo>;
    d.channels.push(ch as Draft<Channel>);
  });
}

// ------------------------------------------------------------------ Edison
const savedEdisonModes = new Map<string, number>();

function edisonSlotOf(p: Project, track: number): { id: Id } | null {
  const sl = p.mixer.tracks[track]?.slots.find((s) => s && s.plugin === 'edison' && s.enabled);
  return sl ? { id: sl.id } : null;
}

/** Recording into Edison: an Edison on each recorded track (added in the first free slot where missing), armed to record while the song plays. */
function edisonStart(tracks: number[]): void {
  for (const tr of tracks) {
    let slot = edisonSlotOf(store.project, tr);
    if (!slot) {
      const free = store.project.mixer.tracks[tr].slots.findIndex((x) => !x);
      if (free < 0) { flashHint(`${mixerTrackName(store.project.mixer.tracks[tr])} has no free effect slot for Edison`); continue; }
      slot = { id: A.loadFx(tr, free, 'edison') };
    }
    // Edison shows the take as it grows (and stores it in the pool when the recording ends)
    A.openFxWindow(slot.id, `Edison (${mixerTrackName(store.project.mixer.tracks[tr])})`);
    const found = A.findFx(store.project, slot.id);
    const prev = Number((found?.fx.params as Record<string, unknown> | undefined)?.recMode ?? 1);
    savedEdisonModes.set(slot.id, prev);
    // "Record when host is playing": Edison starts and ends with the transport, like the audio logger presets
    A.setFxStateNoHistory(slot.id, 'Record', (p) => { p.recMode = 3; p.rec = 1; });
  }
}

/**
 * Mixer track > Open audio editor (Ctrl+E): Edison on the track (added in the first free slot when there is none), open.
 * `record`: Open audio editor and record: Edison starts recording whatever flows through the track (its input, when it has one).
 */
export function openAudioEditor(track: number, record = false): void {
  if (track < 1 || track > 125) return;
  const tr = store.project.mixer.tracks[track];
  let slot = edisonSlotOf(store.project, track);
  if (!slot) {
    const free = tr.slots.findIndex((x) => !x);
    if (free < 0) { flashHint(`${mixerTrackName(tr)} has no free effect slot for Edison`); return; }
    slot = { id: A.loadFx(track, free, 'edison') };
  }
  A.openFxWindow(slot.id, `Edison (${mixerTrackName(tr)})`);
  if (record) {
    if (!tr.input && (tr.pickup ?? 'ext') === 'ext') flashHint(`${mixerTrackName(tr)} has no audio input: choose one in its Input menu to record from`);
    else if (tr.input) void host.input.ensureOpen();
    A.setFxStateNoHistory(slot.id, 'Record', (p) => { p.rec = 1; });
  }
}

function edisonStop(tracks: number[]): void {
  for (const tr of tracks) {
    const slot = edisonSlotOf(store.project, tr);
    if (!slot) continue;
    const prev = savedEdisonModes.get(slot.id);
    savedEdisonModes.delete(slot.id);
    A.setFxStateNoHistory(slot.id, 'Record', (p) => {
      p.rec = 0;
      if (prev !== undefined && p.recMode === 3) p.recMode = prev;
    });
  }
}

// ---------------------------------------------------------------- recorder
const env: RecEnv = {
  send: (m) => host.send(m),
  project: () => store.project,
  settings: () => store.ui.rec,
  sampleRate: () => host.sampleRate,
  resume: () => host.resume(),
  input: host.input,
  updateLatency: () => host.updateLatency(),
  startTick: () => Math.max(0, live.anchorTick),
  hint: flashHint,
  commit: commitRecording,
  setArmed: setRecordArmed,
  edisonStart,
  edisonStop,
  onState: (st) => {
    if (st.state !== live.rec.state) {
      if (st.state === 'countdown') flashHint('Precounting...');
      else if (st.state === 'waiting') flashHint('Waiting for input to start recording...');
      else if (st.state === 'recording') flashHint('Recording...');
    }
    live.rec.state = st.state;
    live.rec.tick0 = st.tick0;
    live.rec.frames = st.frames;
    live.rec.tracks = st.tracks;
    live.rec.sampleRate = host.sampleRate;
    emitLive();
  },
};

const g = globalThis as unknown as { __orchardRecorder?: Recorder };
export const recorder: Recorder = (g.__orchardRecorder ??= new Recorder(env));

host.onRecMessage = (m) => recorder.onEngine(m);
host.input.onNotice = flashHint; // a device unplugged or plugged in again

/** Play while Record is on starts a recording session (with the count-in, wait for input...) instead of plain playback. */
host.beforePlay = async () => {
  if (!store.ui.recording) return false;
  if (recorder.active) return true;
  const ok = await recorder.start();
  if (!ok) setRecordArmed(false);
  return ok;
};

/** The Record button (R): arms Record; while the transport plays (or "Recording starts playback" is on) recording starts at once. */
export async function toggleRecord(): Promise<void> {
  if (recorder.active) { recorder.stop(); setRecordArmed(false); return; }
  if (store.ui.recording) { setRecordArmed(false); return; }
  setRecordArmed(true);
  if (live.playing || store.ui.rec.startsPlayback) {
    if (!live.playing) host.playStartTick = Math.max(0, live.anchorTick);
    const ok = await recorder.start();
    if (!ok) setRecordArmed(false);
  }
}

/** Tools > One-click audio recording: arm the selected mixer track (giving it the first input if it has none) and record. */
export async function oneClickRecording(to: 'playlist' | 'edison'): Promise<void> {
  const p = store.project;
  let track = store.ui.mixerSelected;
  if (track < 1 || track > 125) track = p.mixer.tracks.findIndex((t) => t.index >= 1 && t.index <= 125 && t.armed);
  if (track < 1) track = 1;
  if (!(await host.input.ensureOpen(true))) {
    flashHint(host.input.describe());
    return;
  }
  const t = store.project.mixer.tracks[track];
  if (!t.input) {
    const ch = host.input.state.channels;
    A.setMixer(track, 'input', ch >= 2 ? { ch: 0 } : { ch: 0, mono: true }, 'Mixer track input');
  }
  A.selectMixerTrack(track);
  if (!t.armed) A.setMixer(track, 'armed', true, 'Arm disk recording');
  setRec({ audioTo: to, filterAudio: true });
  // recording into the Playlist: FL opens it (and the wizard adds an audio track); here it is Song mode with the Playlist open
  if (to === 'playlist') {
    if (!store.project.songMode) A.setSongMode(true);
    A.openWindow('playlist');
  }
  if (live.playing) host.stop();
  setRecordArmed(true);
  const ok = await recorder.start();
  if (!ok) setRecordArmed(false);
}

/** Stop a recording without stopping the transport (the Record button while it records). */
export function stopRecording(): void {
  recorder.stop();
}

export function isRecording(): boolean {
  return recorder.active;
}
