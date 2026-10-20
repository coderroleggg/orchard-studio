// Runs Newtone / Newtime analysis and render jobs in a Web Worker (module
// worker created from this file's folder). Each source is sent to the worker
// once and then referenced by its sample id. Without workers (or if the
// worker fails to start) the job runs on the UI thread after a short yield.

import { analyzeToneGen, renderToneGen } from '../../../../engine/effects/plugins/newtools/tonemodel';
import { analyzeTime, renderTime } from '../../../../engine/effects/plugins/newtools/timemodel';
import { execJob, type JobMsg, type JobReq } from './jobcore';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  progress?: (p: number) => void;
  msg: JobMsg;
  retried: boolean;
}

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const pending = new Map<number, Pending>();
/** Sources the worker holds (it keeps the last three). */
const held: string[] = [];

function getWorker(): Worker | null {
  if (worker || broken) return worker;
  if (typeof Worker === 'undefined') { broken = true; return null; }
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    broken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ id: number; ok?: boolean; result?: unknown; error?: string; progress?: number }>) => {
    const d = e.data;
    const p = pending.get(d.id);
    if (!p) return;
    if (d.progress !== undefined && d.ok === undefined) { p.progress?.(d.progress); return; }
    if (d.ok) { pending.delete(d.id); p.resolve(d.result); return; }
    if (d.error === 'nosrc' && !p.retried) {
      // the worker dropped the source: send it again
      const i = held.indexOf(p.msg.src);
      if (i >= 0) held.splice(i, 1);
      p.retried = true;
      p.msg.ch = srcChannels.get(p.msg.src);
      if (p.msg.ch) { markHeld(p.msg.src); worker?.postMessage(p.msg); return; }
    }
    pending.delete(d.id);
    p.reject(new Error(d.error ?? 'job failed'));
  };
  worker.onerror = () => {
    // module workers unsupported or crashed: fall back to inline jobs
    broken = true;
    worker?.terminate();
    worker = null;
    held.length = 0;
    const list = [...pending.values()];
    pending.clear();
    for (const p of list) runInline(p.msg, p.msg.ch ?? srcChannels.get(p.msg.src) ?? [], p.progress).then(p.resolve, p.reject);
  };
  return worker;
}

/** Channels by source id (weakly: the latest reference handed to runJob). */
const srcChannels = new Map<string, Float32Array[]>();

function markHeld(src: string): void {
  const i = held.indexOf(src);
  if (i >= 0) held.splice(i, 1);
  held.push(src);
  while (held.length > 3) held.shift();
}

function runInline(msg: JobMsg, ch: Float32Array[], progress?: (p: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(execJob(msg, ch, { analyzeToneGen, renderToneGen, analyzeTime, renderTime }, (p) => progress?.(p)));
      } catch (e) {
        reject(e as Error);
      }
    }, 15);
  });
}

/** Run a job on a source (`src` = its pool sample id). */
export function runJob<T>(req: JobReq, src: string, ch: Float32Array[], sr: number, progress?: (p: number) => void): Promise<T> {
  srcChannels.set(src, ch);
  if (srcChannels.size > 6) srcChannels.delete(srcChannels.keys().next().value as string);
  const id = nextId++;
  const msg = { ...req, id, src, sr } as JobMsg;
  const w = getWorker();
  if (!w) return runInline(msg, ch, progress) as Promise<T>;
  // postMessage copies the channels (the pool keeps its buffers)
  if (!held.includes(src)) msg.ch = ch;
  markHeld(src);
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress, msg, retried: false });
    w.postMessage(msg);
    msg.ch = undefined;
  });
}
