// Web Worker for Newtone / Newtime: pitch analysis, PSOLA and WSOLA renders
// off the UI thread. Sources are cached by sample id so a re-render after an
// edit does not copy the audio again.

import { analyzeToneGen, renderToneGen } from '../../../../engine/effects/plugins/newtools/tonemodel';
import { analyzeTime, renderTime } from '../../../../engine/effects/plugins/newtools/timemodel';
import { execJob, type JobMsg } from './jobcore';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<JobMsg>) => void) | null;
  postMessage: (m: unknown, transfer?: Transferable[]) => void;
};

const cache = new Map<string, Float32Array[]>();

scope.onmessage = (e: MessageEvent<JobMsg>) => {
  const m = e.data;
  if (m.ch) {
    cache.delete(m.src);
    cache.set(m.src, m.ch);
    while (cache.size > 3) cache.delete(cache.keys().next().value as string);
  }
  const ch = cache.get(m.src);
  if (!ch) { scope.postMessage({ id: m.id, ok: false, error: 'nosrc' }); return; }
  try {
    const res = execJob(m, ch, { analyzeToneGen, renderToneGen, analyzeTime, renderTime }, (p) => scope.postMessage({ id: m.id, progress: p }));
    const transfer: Transferable[] = [];
    if (Array.isArray(res)) for (const c of res as Float32Array[]) transfer.push(c.buffer);
    scope.postMessage({ id: m.id, ok: true, result: res }, transfer);
  } catch (err) {
    scope.postMessage({ id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
