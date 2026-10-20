// Loading a video file into a Video Player: the file's bytes go to the file
// store (files.ts), its audio is decoded into a pool sample the engine plugin
// plays (the state's `sampleId`, saved with the project like any imported
// sample), and the plugin's state gets the file's reference, name, length and
// frame rate, all in one undo step. FL asks for a file with its open dialog
// and takes dropped files; here the browser's file chooser and drag & drop do.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { addRaw, getRaw, removeRaw } from '../../../../audio/samples';
import { slotSampleRefs } from '../../../../audio/engineSamples';
import { uid } from '../../../../model/defaults';
import type { SampleInfo } from '../../../../model/types';
import { vpState } from '../../../../model/gen/plugins/videoplayer';
import { flashHint } from '../../../hint';
import { controllerOf } from './controller';
import { getVideo, putVideo, videoKeyOf } from './files';
import { decodeAudio, probeVideo } from './media';

/** FL's open dialog filter, as the browser's file chooser takes it. */
export const VIDEO_ACCEPT = 'video/*,.wmv,.avi,.qt,.mpg,.mpeg,.m1v,.mov,.mkv,.mp4,.gif,.webm,.ogv,.m4v';

/** FL's message when a file cannot be loaded. */
const loadError = (name: string): string => `There was an error loading the file: "${name}".`;

function sampleInfoOf(id: string, name: string, frames: number, sampleRate: number, channels: number): SampleInfo {
  return { id, name, frames, sampleRate, channels, source: { kind: 'user', key: id } };
}

/** Whether anything in the project still refers to a pool sample. */
function sampleUsed(id: string): boolean {
  const p = store.project;
  return p.channels.some((c) => c.sampler.sampleId === id) || slotSampleRefs(p).has(id);
}

/** Load a video file into the player of `slotId` ("ch:<channel id>"). Resolves false when the browser cannot open it. */
export async function loadVideoFile(slotId: string, file: File): Promise<boolean> {
  flashHint(`Loading ${file.name}...`);
  try {
    // open it first: a file the browser cannot play is not kept
    const info = await probeVideo(file);
    const key = await videoKeyOf(file);
    await putVideo(key, file);
    const audio = await decodeAudio(file, info.duration);
    const loc = A.findFx(store.project, slotId);
    if (!loc) return false;
    const old = vpState(loc.fx.params).sampleId;
    let sampleId = '';
    if (audio) {
      sampleId = uid('s');
      const name = file.name.replace(/\.[^.]+$/, '');
      addRaw({ id: sampleId, name, channels: audio.channels, sampleRate: audio.sampleRate });
    }
    controllerOf(slotId)?.adopt(key, file);
    // the pool sample and the plugin's state change together: one undo step
    store.beginGesture('Load video');
    try {
      if (audio && sampleId) {
        const info2 = sampleInfoOf(sampleId, file.name.replace(/\.[^.]+$/, ''), audio.channels[0].length, audio.sampleRate, audio.channels.length);
        store.update('Import sample', (d) => { d.samples[sampleId] = info2; });
      }
      A.editFx(slotId, 'Load video', (p) => {
        p.file = file.name;
        p.videoKey = key;
        p.videoType = file.type || '';
        p.sampleId = sampleId;
        p.duration = info.duration;
        p.fps = info.fps;
        p.start = 0;
        p.end = 0;
        p.pos = 0;
        p.seek = (Number(p.seek) || 0) + 1;
        p.play = 0;
      });
    } finally {
      store.endGesture();
    }
    // the previous clip's audio is no longer needed (undo brings it back from the file store)
    if (old && old !== sampleId && !sampleUsed(old)) removeRaw(old);
    flashHint(audio ? `Loaded ${file.name}` : `Loaded ${file.name} (no audio track could be decoded)`);
    return true;
  } catch {
    flashHint(loadError(file.name));
    return false;
  }
}

/** The file chooser (FL: the folder button's open dialog). */
export function pickVideoFile(slotId: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = VIDEO_ACCEPT;
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void loadVideoFile(slotId, f);
  };
  input.click();
}

const healing = new Set<string>();

/**
 * Make sure the pool holds the clip's audio: after a project reload the
 * sample may be missing (the autosave has no sample data; the audio is
 * decoded again from the stored file under the same id, so the project keeps
 * working and the engine gets it like any pool sample).
 */
export async function ensureAudio(slotId: string): Promise<void> {
  const loc = A.findFx(store.project, slotId);
  if (!loc) return;
  const s = vpState(loc.fx.params);
  const id = s.sampleId;
  if (!id || !s.videoKey || getRaw(id) || healing.has(id)) return;
  healing.add(id);
  try {
    const blob = controllerOf(slotId)?.blob ?? (await getVideo(s.videoKey));
    if (!blob) return;
    const audio = await decodeAudio(blob, s.duration);
    if (!audio || getRaw(id)) return;
    const name = s.file.replace(/\.[^.]+$/, '') || 'Video';
    addRaw({ id, name, channels: audio.channels, sampleRate: audio.sampleRate });
    if (!store.project.samples[id]) {
      const info = sampleInfoOf(id, name, audio.channels[0].length, audio.sampleRate, audio.channels.length);
      store.update('Add sample', (d) => { d.samples[id] = info; }, { noHistory: true });
    }
  } finally {
    healing.delete(id);
  }
}
