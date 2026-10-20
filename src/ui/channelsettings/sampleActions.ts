// Loading / replacing / removing a channel's sample (file picker, sample pool,
// drag & drop). Shared by the SMP tab and the window's options menu.

import { store } from '../../store';
import type { Id } from '../../model/types';
import { loadSampleIntoChannel } from '../../project/io';
import type { MenuItem } from '../widgets/ContextMenu';
import { flashHint } from '../hint';

const AUDIO_RE = /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i;
export const SAMPLE_DRAG_TYPE = 'text/x-orchard-sample';

function pickAudioFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Open the file dialog and load the chosen file into the channel. */
export async function loadSampleFile(channelId: Id): Promise<void> {
  const f = await pickAudioFile();
  if (f) await loadSampleIntoChannel(channelId, f);
}

/** Use a sample that is already in the project's pool (auto-names the channel like a drop does). */
export function assignPoolSample(channelId: Id, sampleId: Id): void {
  const info = store.project.samples[sampleId];
  store.update('Load sample', (d) => {
    const c = d.channels.find((x) => x.id === channelId);
    if (!c) return;
    c.sampler.sampleId = sampleId;
    if (info) c.name = info.name;
  });
}

export function removeSample(channelId: Id): void {
  store.update('Remove sample', (d) => {
    const c = d.channels.find((x) => x.id === channelId);
    if (c) c.sampler.sampleId = null;
  });
  flashHint('Sample removed (the file is kept)');
}

export function sampleMenuItems(channelId: Id): MenuItem[] {
  const p = store.project;
  const cur = p.channels.find((c) => c.id === channelId)?.sampler.sampleId ?? null;
  const pool = Object.values(p.samples).sort((a, b) => a.name.localeCompare(b.name));
  return [
    { label: 'Load sample...', onClick: () => { void loadSampleFile(channelId); } },
    pool.length
      ? {
        label: 'Sample pool',
        submenu: pool.map((info) => ({
          label: info.name, checked: info.id === cur, radio: true, onClick: () => assignPoolSample(channelId, info.id),
        })),
      }
      : { label: 'Sample pool', disabled: true },
    { label: 'Remove sample', disabled: !cur, onClick: () => removeSample(channelId) },
  ];
}

export function acceptsSampleDrag(dt: DataTransfer): boolean {
  return dt.types.includes('Files') || dt.types.includes(SAMPLE_DRAG_TYPE);
}

/** Handle a drop of a browser sample or an audio file. Returns true if it was used. */
export function dropSample(channelId: Id, dt: DataTransfer): boolean {
  const sid = dt.getData(SAMPLE_DRAG_TYPE);
  if (sid) {
    assignPoolSample(channelId, sid);
    return true;
  }
  const f = [...dt.files].find((x) => x.type.startsWith('audio') || AUDIO_RE.test(x.name));
  if (f) {
    void loadSampleIntoChannel(channelId, f);
    return true;
  }
  return false;
}
