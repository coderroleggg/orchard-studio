// Fruity Granulizer's editor operations (main thread): loading the channel's sample (drop, file
// picker, Browser) into the project's sample pool and the plugin state, the file's regions and
// FL's transient detection for the editor's display (the engine reads the same state).
// See docs/research/gen/granulizer.md.

import { store, host } from '../../../../store';
import * as A from '../../../../store/actions';
import { decodeFile, getRaw, onSamplesChanged } from '../../../../audio/samples';
import { addPoolSample, baseName, parseWav } from '../bassdrum/flimport';
import { wavInfo } from '../slicer/ops';
import { detectTransients } from '../../../../model/gen/plugins/granulizer/detect';
import { granulizerState, type GranulizerState } from '../../../../model/gen/plugins/granulizer/state';

export { onSamplesChanged };

export interface Audio { channels: Float32Array[]; sampleRate: number }

/** The loaded audio of a state (pool sample), if available. */
export function audioOf(s: GranulizerState): Audio | null {
  if (!s.sample) return null;
  const r = getRaw(s.sample);
  return r && r.channels.length ? { channels: r.channels, sampleRate: r.sampleRate } : null;
}

/** What a detection result belongs to (the engine checks the same key). */
export function detectKey(id: string, a: Audio): string {
  return `${id}|${a.channels[0].length}|${a.sampleRate}`;
}

function current(slotId: string): GranulizerState {
  return granulizerState(A.findFx(store.project, slotId)?.fx.params);
}

/** Make a pool sample the plugin's sample (FL: the channel's sample), with the file's regions. */
export function setSample(slotId: string, sampleId: string, file: string, regions: number[] = []): void {
  A.editFx(slotId, 'Load sample', (d) => {
    const q = d as Record<string, unknown>;
    q.sample = sampleId;
    q.file = file;
    q.regions = regions;
    q.detected = [];
    q.detectedFor = '';
  });
  ensureDetected(slotId);
}

/** Load an audio file (WAV read natively, other formats decoded by the browser) into the pool and the plugin. */
export async function loadFile(slotId: string, f: File): Promise<void> {
  const bytes = await f.arrayBuffer();
  const wav = parseWav(bytes);
  if (wav) {
    const info = await addPoolSample(baseName(f), wav, bytes, 'Load sample');
    setSample(slotId, info.id, f.name, wavInfo(bytes).regions);
    return;
  }
  const r = await decodeFile(f, baseName(f), host.ctx ?? undefined);
  store.update('Load sample', (d) => { d.samples[r.info.id] = r.info; });
  setSample(slotId, r.info.id, f.name);
}

/** A sample from the Browser / the project's pool. */
export function loadPool(slotId: string, id: string): void {
  const info = store.project.samples[id];
  if (!getRaw(id) || !info) return;
  setSample(slotId, id, info.name);
}

/** Detect the transients for the DETECT source and keep them in the state (no undo step); the engine uses them. */
export function ensureDetected(slotId: string): void {
  const s = current(slotId);
  if (s.trans !== 2) return;
  const a = audioOf(s);
  if (!a) return;
  const key = detectKey(s.sample, a);
  if (s.detectedFor === key && s.detected.length) return;
  const list = detectTransients(a.channels.slice(0, 2), a.sampleRate);
  A.setFxStateNoHistory(slotId, 'Detect transients', (d) => {
    (d as Record<string, unknown>).detected = list;
    (d as Record<string, unknown>).detectedFor = key;
  });
}

/** The transients to show for the state's TRANSIENTS source. */
export function transientsOf(s: GranulizerState): number[] {
  if (s.trans === 1) return [...s.regions].sort((x, y) => x - y);
  if (s.trans === 2) return s.detected;
  return [];
}
