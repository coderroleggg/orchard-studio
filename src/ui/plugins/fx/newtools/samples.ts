// Samples for Newtone / Newtime: loading a source (audio file, or a sample
// dragged from the app's browser) into the project's sample pool, and
// storing renders: the rendered audio becomes a pool sample (one per slot,
// replaced on every render), registered in the project (saved with it),
// persisted in IndexedDB (WAV, debounced) and delivered to the engine under
// '<plugin>:<id>', where the plugin's DSP finds it with env.sample().
// The engine only receives channel samples by itself (see the report), so
// renders are sent here directly.

import { host, store } from '../../../../store';
import { addRaw, decodeFile, ensureSample, getRaw, loadUserSample, storeUserSample, type RawSample } from '../../../../audio/samples';
import { encodeWav } from '../../../../project/wav';
import type { SampleInfo } from '../../../../model/types';

export const SAMPLE_DRAG_TYPE = 'text/x-orchard-sample';
export const AUDIO_RE = /\.(wav|mp3|ogg|flac|aiff?|m4a|aac|opus|wv)$/i;

/** Decode an audio file into the pool and the project (not an undo step of its own). */
export async function importSourceFile(f: File): Promise<SampleInfo | null> {
  try {
    const { info } = await decodeFile(f, f.name.replace(/\.[^.]+$/, ''), host.ctx ?? undefined);
    store.update('Import sample', (d) => { d.samples[info.id] = info; }, { noHistory: true });
    return info;
  } catch {
    return null;
  }
}

/** A pool sample (browser drag) as a project sample. */
export function poolSource(id: string): SampleInfo | null {
  const known = store.project.samples[id];
  if (known) return known;
  const r = getRaw(id);
  if (!r) return null;
  const info: SampleInfo = {
    id, name: r.name, frames: r.channels[0]?.length ?? 0, sampleRate: r.sampleRate, channels: r.channels.length,
    source: id.startsWith('builtin:') ? { kind: 'builtin', key: id.slice(8) } : { kind: 'user', key: id },
  };
  store.update('Add sample', (d) => { d.samples[id] = info; }, { noHistory: true });
  return info;
}

/** The audio of a project sample (loads it from storage when needed). */
export async function sourceAudio(info: SampleInfo | null | undefined): Promise<RawSample | null> {
  if (!info) return null;
  let r = getRaw(info.id);
  if (r) return r;
  if (!ensureSample(info) && info.source.kind === 'user') await loadUserSample(info, host.ctx ?? undefined);
  r = getRaw(info.id);
  return r ?? null;
}

/** Engine samples already sent: key -> hash. */
const delivered = new Map<string, string>();

export function deliverToEngine(key: string, hash: string, ch: Float32Array[], sr: number): void {
  if (delivered.get(key) === hash) return;
  const data = ch.map((c) => new Float32Array(c));
  host.send({ t: 'sample', id: key, data, sampleRate: sr }, data.map((d) => d.buffer));
  delivered.set(key, hash);
}

export function isDelivered(key: string, hash: string): boolean {
  return delivered.get(key) === hash;
}

const persistTimers = new Map<string, number>();

/** Store a render as pool sample `id` (replacing the previous render of the slot). */
export function storeRender(id: string, name: string, ch: Float32Array[], sr: number): SampleInfo {
  addRaw({ id, name, channels: ch, sampleRate: sr });
  const info: SampleInfo = { id, name, frames: ch[0]?.length ?? 0, sampleRate: sr, channels: ch.length, source: { kind: 'user', key: id } };
  store.update('Render', (d) => { d.samples[id] = info; }, { noHistory: true });
  // persist for the next session once the edits settle
  const g = globalThis as unknown as { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  const old = persistTimers.get(id);
  if (old) g.clearTimeout(old);
  persistTimers.set(id, g.setTimeout(() => {
    persistTimers.delete(id);
    const r = getRaw(id);
    if (!r) return;
    try { void storeUserSample(id, encodeWav(r.channels, r.sampleRate, 24)); } catch { /* storage unavailable */ }
  }, 2500) as unknown as number);
  return info;
}

/** Pool id of a slot's render. */
export function renderId(plugin: string, slotId: string): string {
  return `${plugin === 'newtone' ? 'ntr' : 'nmr'}-${slotId}`;
}

/** Save audio as a WAV download. */
export function downloadWav(ch: Float32Array[], sr: number, name: string): void {
  const wav = encodeWav(ch, sr, 24);
  downloadBlob(new Blob([wav], { type: 'audio/wav' }), name.replace(/\.wav$/i, '') + '.wav');
}

export function downloadBlob(b: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Open the file picker for one audio file. */
export function pickAudioFile(accept = 'audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** A source from a drop: an app browser sample or an audio file. */
export async function sourceFromDrop(dt: DataTransfer): Promise<SampleInfo | null> {
  const sid = dt.getData(SAMPLE_DRAG_TYPE);
  if (sid) return poolSource(sid);
  const f = [...dt.files].find((x) => x.type.startsWith('audio') || AUDIO_RE.test(x.name));
  return f ? importSourceFile(f) : null;
}
