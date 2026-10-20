// Project persistence (save / open / autosave), audio import and WAV export.

import { store, host } from '../store';
import * as A from '../store/actions';
import type { Project, SampleInfo, Id } from '../model/types';
import { createDefaultProject, normalizeProject } from '../model/defaults';
import { loadBuiltins, decodeFile, ensureSample, getRaw, loadUserSample, prepareSample, addRaw } from '../audio/samples';
import { Engine } from '../engine/Engine';
import { engineSamplesFor } from '../audio/engineSamples';
import { ticksPerBar } from '../model/timing';
import { patternLength } from '../store/actions';
import { flashHint } from '../ui/hint';
import { encodeWav } from './wav';

const FILE_EXT = '.orchard.json';
let fileHandle: FileSystemFileHandle | null = null;

interface SavedFile {
  format: 'orchard-project';
  version: 1;
  project: Project;
  /** User samples embedded as base64 32-bit float PCM. */
  samples: Record<Id, { name: string; sampleRate: number; channels: string[] }>;
}

function f32ToB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function b64ToF32(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function serialize(p: Project = store.project): SavedFile {
  const samples: SavedFile['samples'] = {};
  for (const info of Object.values(p.samples)) {
    if (info.source.kind !== 'user') continue;
    const r = getRaw(info.id);
    if (r) samples[info.id] = { name: r.name, sampleRate: r.sampleRate, channels: r.channels.map(f32ToB64) };
  }
  return { format: 'orchard-project', version: 1, project: p, samples };
}

export async function deserialize(data: SavedFile): Promise<Project> {
  if (data.format !== 'orchard-project') throw new Error('Not a project file');
  for (const [id, s] of Object.entries(data.samples ?? {})) {
    addRaw({ id, name: s.name, sampleRate: s.sampleRate, channels: s.channels.map(b64ToF32) });
  }
  for (const info of Object.values(data.project.samples) as SampleInfo[]) {
    if (!ensureSample(info) && info.source.kind === 'user') await loadUserSample(info);
  }
  return normalizeProject(data.project);
}

export function newProject(): void {
  if (store.canUndo() && !confirm('Start a new project? Unsaved changes will be lost.')) return;
  const b = loadBuiltins();
  host.stop();
  store.replaceProject(createDefaultProject(b.infos, b.byKey));
  A.setUi((u) => { u.selectedChannels = []; u.pianoRoll.channelId = null; });
  fileHandle = null;
  host.fullSync(store.project);
  flashHint('New project');
}

async function writeFile(handle: FileSystemFileHandle | null, json: string, name: string): Promise<FileSystemFileHandle | null> {
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
  if (!handle && w.showSaveFilePicker) {
    try {
      handle = await w.showSaveFilePicker({ suggestedName: name + FILE_EXT, types: [{ description: 'Orchard project', accept: { 'application/json': [FILE_EXT, '.json'] } }] });
    } catch {
      return null;
    }
  }
  if (handle) {
    const ws = await (handle as unknown as { createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }> }).createWritable();
    await ws.write(json);
    await ws.close();
    return handle;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name + FILE_EXT;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return null;
}

export async function saveProject(): Promise<void> {
  const name = store.project.title || 'untitled';
  const json = JSON.stringify(serialize());
  const h = await writeFile(fileHandle, json, name);
  if (h) fileHandle = h;
  flashHint(`Saved ${h?.name ?? name + FILE_EXT}`);
}

export async function saveProjectAs(): Promise<void> {
  fileHandle = null;
  await saveProject();
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.click();
  });
}

export async function openProjectFile(): Promise<void> {
  const [file] = await pickFiles('.json,application/json', false);
  if (!file) return;
  try {
    const data = JSON.parse(await file.text()) as SavedFile;
    const p = await deserialize(data);
    host.stop();
    store.replaceProject({ ...p, title: p.title || file.name.replace(/\.orchard\.json$|\.json$/i, '') });
    A.setUi((u) => { u.selectedChannels = []; u.pianoRoll.channelId = null; });
    host.fullSync(store.project);
    fileHandle = null;
    flashHint(`Opened ${file.name}`);
  } catch (e) {
    alert('Could not open project: ' + (e as Error).message);
  }
}

/** Import audio files: each becomes a new Sampler channel. */
export async function importSampleFiles(files?: File[]): Promise<void> {
  const list = files ?? (await pickFiles('audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff', true));
  for (const f of list) {
    try {
      const { info } = await decodeFile(f, f.name.replace(/\.[^.]+$/, ''), host.ctx ?? undefined);
      store.update('Import sample', (d) => { d.samples[info.id] = info; });
      A.addChannel(info.name, info.id);
    } catch {
      flashHint(`Could not decode ${f.name}`);
    }
  }
}

/** Load an audio file into an existing channel (drag & drop onto a channel). */
export async function loadSampleIntoChannel(channelId: Id, f: File): Promise<void> {
  try {
    const { info } = await decodeFile(f, f.name.replace(/\.[^.]+$/, ''), host.ctx ?? undefined);
    store.update('Load sample', (d) => {
      d.samples[info.id] = info;
      const c = d.channels.find((x) => x.id === channelId);
      // a sample dropped on a MIDI Out, Layer or instrument channel makes it a Sampler channel
      if (c) { c.sampler.sampleId = info.id; c.name = info.name; c.kind = 'sampler'; delete c.midiOut; delete c.plugin; delete c.layer; }
    });
  } catch {
    flashHint(`Could not decode ${f.name}`);
  }
}

/** Hold Shift while dropping a file on a layer channel: the file becomes a new Sampler channel that is a child of the layer. */
export async function addSampleChild(layerId: Id, f: File): Promise<void> {
  try {
    const { info } = await decodeFile(f, f.name.replace(/\.[^.]+$/, ''), host.ctx ?? undefined);
    store.update('Import sample', (d) => { d.samples[info.id] = info; });
    A.addLayerChild(layerId, info.name, info.id);
  } catch {
    flashHint(`Could not decode ${f.name}`);
  }
}

// ----------------------------------------------------------------- export
/** Render the song (or the current pattern in pattern mode) to a WAV file. */
export async function exportWav(): Promise<void> {
  const p = store.project;
  const sr = 44100;
  // rendering: effects switch to FL's export processing (FPD_ProcessMode PM_IsRendering | PM_HQ_NonRealtime)
  const e = new Engine({ sampleRate: sr, blockSize: 128, rendering: true });
  e.handle({ t: 'globals', g: { tempo: p.tempo, ppq: p.ppq, beatsPerBar: p.beatsPerBar, stepsPerBeat: p.stepsPerBeat, mainVolume: p.mainVolume, mainPitch: p.mainPitch, swing: p.swing } });
  // audio the effects play (Convolver impulses, Edison takes, Newtone / Newtime renders...), before the slots
  for (const s of engineSamplesFor(p, sr)) e.handle({ t: 'sample', id: s.id, data: s.channels, sampleRate: s.sampleRate });
  // the engine writes automation / controller values (and plugin state from MIDI notes) into its models: give it mutable copies
  for (const tr of p.mixer.tracks) e.handle({ t: 'mixerTrack', tr: structuredClone(tr) });
  // renders use a higher-quality interpolator than live playback
  e.handle({ t: 'interp', mode: 'sinc64' });
  const sent = new Set<string>();
  for (const c of p.channels) {
    let key: string | null = null;
    const s = c.sampler;
    // MIDI Out channels make no sound (their notes reach the effects listening on their ports);
    // instrument plugin channels render their own sound (with FL's export flag, GenContext.rendering)
    if (s.sampleId && c.kind === 'sampler') {
      const prep = prepareSample(s.sampleId, s, sr);
      if (prep) {
        key = prep.key;
        if (!sent.has(key)) { e.handle({ t: 'sample', id: key, data: prep.data, sampleRate: prep.sampleRate }); sent.add(key); }
      }
    }
    e.handle({ t: 'channel', c: structuredClone({ ...c, sampler: { ...s, sampleId: key } }) });
  }
  for (const pat of p.patterns) e.handle({ t: 'pattern', p: pat });
  e.handle({ t: 'automation', list: p.automation ?? [], init: p.initControls ?? [] });
  e.handle({ t: 'links', list: structuredClone(p.links ?? []) });
  e.handle({ t: 'playlist', tracks: p.playlist.tracks, clips: p.playlist.clips, repeatClips: !!p.repeatClips });
  const song = p.songMode && p.playlist.clips.length > 0;
  e.handle({ t: 'mode', song, patternId: p.currentPatternId });
  let lenTicks: number;
  if (song) {
    let end = 0;
    for (const c of p.playlist.clips) end = Math.max(end, c.start + c.length);
    lenTicks = Math.ceil(end / ticksPerBar(p)) * ticksPerBar(p);
  } else {
    lenTicks = patternLength(A.currentPattern(p), p);
  }
  const secs = (lenTicks * 60) / (p.tempo * p.ppq);
  const tail = 2; // seconds of release tail
  const bL = new Float32Array(128), bR = new Float32Array(128);
  // FL's effects run all the time, so their start-up glides are over before a render
  // starts: let the fresh engine's effects settle on a second of silence first (discarded)
  for (let off = 0; off < sr; off += 128) e.process(bL, bR, 128);
  e.handle({ t: 'play' });
  flashHint('Rendering...');
  await new Promise((r) => setTimeout(r, 30));
  const total = Math.ceil((secs + tail) * sr);
  const L = new Float32Array(total), R = new Float32Array(total);
  const playFrames = Math.ceil(secs * sr);
  for (let off = 0; off < total; off += 128) {
    if (off >= playFrames && e.playing) e.handle({ t: 'pause' });
    const n = Math.min(128, total - off);
    e.process(bL, bR, n);
    L.set(bL.subarray(0, n), off);
    R.set(bR.subarray(0, n), off);
  }
  const wav = encodeWav([L, R], sr);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  a.download = (p.title || 'untitled') + '.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  flashHint(`Exported ${secs.toFixed(1)} s`);
}

// --------------------------------------------------------------- autosave
const AUTOSAVE_KEY = 'orchard-autosave';

export function startAutosave(): void {
  let timer = 0;
  store.projectListeners.add(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      try {
        const data = serialize();
        // user sample audio lives in IndexedDB already; keep the autosave light
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...data, samples: {} }));
      } catch { /* quota / private mode */ }
    }, 1500);
  });
}

/** FILE > Revert to last backup: load the autosaved copy of the project. */
export async function restoreAutosave(): Promise<boolean> {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) { flashHint('No backup found'); return false; }
    const data = JSON.parse(raw) as SavedFile;
    const p = await deserialize(data);
    host.stop();
    store.replaceProject(p);
    host.fullSync(store.project);
    flashHint('Reverted to the last backup');
    return true;
  } catch {
    flashHint('The backup could not be loaded');
    return false;
  }
}
