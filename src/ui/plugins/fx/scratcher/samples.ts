// Scratcher samples: loading a file into the project's sample pool and
// delivering the audio to the engine, where the plugin finds it with
// env.sample('scratcher:' + id). The engine only receives channel samples
// on its own, so this module watches the project for Scratcher slots and sends
// their samples once per session (see the report: a shared "samples used by
// effects" hook in AudioHost would replace this).

import { host, store } from '../../../../store';
import { decodeFile, ensureSample, getRaw, loadUserSample } from '../../../../audio/samples';
import { SC_SAMPLE_PREFIX } from '../../../../model/fx/plugins/scratcher';
import type { Project, SampleInfo } from '../../../../model/types';
import { registerEngineSamples } from '../../../../audio/engineSamples';
import { allFx } from '../../../../model/fx/hosted';

const sent = new Set<string>();
const pending = new Set<string>();

/** Make sure a sample is in the pool and in the engine. */
export async function deliverSample(info: SampleInfo): Promise<boolean> {
  const key = SC_SAMPLE_PREFIX + info.id;
  if (sent.has(key)) return true;
  if (pending.has(key)) return false;
  pending.add(key);
  try {
    let raw = getRaw(info.id);
    if (!raw) {
      if (!ensureSample(info) && info.source.kind === 'user') await loadUserSample(info, host.ctx ?? undefined);
      raw = getRaw(info.id);
    }
    if (!raw) return false;
    const data = raw.channels.map((c) => new Float32Array(c));
    host.send({ t: 'sample', id: key, data, sampleRate: raw.sampleRate }, data.map((d) => d.buffer));
    sent.add(key);
    return true;
  } finally {
    pending.delete(key);
  }
}

/** Decode an audio file into the project's sample pool (undoable, saved with the project). */
export async function importSampleFile(f: File): Promise<SampleInfo | null> {
  try {
    const { info } = await decodeFile(f, f.name.replace(/\.[^.]+$/, ''), host.ctx ?? undefined);
    store.update('Import sample', (d) => { d.samples[info.id] = info; });
    await deliverSample(info);
    return info;
  } catch {
    return null;
  }
}

let lastMixer: unknown = null;

function scan(p: Project): void {
  if (p.mixer === lastMixer) return;
  lastMixer = p.mixer;
  for (const s of allFx(p, 'scratcher')) {
    const info = s.params.sample as SampleInfo | null | undefined;
    if (info && typeof info.id === 'string' && !sent.has(SC_SAMPLE_PREFIX + info.id)) void deliverSample(info);
  }
}

// watch the project (also when no Scratcher editor is open)
const g = globalThis as unknown as { __scratcherSampleWatch?: boolean };
if (!g.__scratcherSampleWatch) {
  g.__scratcherSampleWatch = true;
  store.projectListeners.add((next) => scan(next));
  queueMicrotask(() => scan(store.project));
}

// project export: a fresh engine gets each Scratcher slot's loaded sample
registerEngineSamples('scratcher', (p) => {
  const out: { id: string; channels: Float32Array[]; sampleRate: number }[] = [];
  for (const s of allFx(p, 'scratcher')) {
    const info = s.params.sample as SampleInfo | null | undefined;
    const r = info && typeof info.id === 'string' ? getRaw(info.id) : undefined;
    if (info && r) out.push({ id: SC_SAMPLE_PREFIX + info.id, channels: r.channels, sampleRate: r.sampleRate });
  }
  return out;
});
