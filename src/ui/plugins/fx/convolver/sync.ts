// Convolver impulses on the main thread: renders each Convolver slot's
// processed impulse (renderImpulse: trim, stretch, envelopes, self-convolution,
// equalizer, normalize, pre-delay) and delivers it to the engine as sample
// 'convolver:<hash>', which the plugin looks up through env.sample(). Like the
// Sampler's precomputed effects, the expensive rendering stays off the audio
// thread. The engine only receives channel samples on its own, so this module
// watches the project itself (suggested shared change: an AudioHost hook for
// samples used by effects). Also: loading / recording impulses into the
// project's sample pool, and the rendered impulse for the editor display.

import { host, store } from '../../../../store';
import { addRaw, decodeFile, ensureSample, getRaw, loadUserSample, onSamplesChanged, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { Project, SampleInfo } from '../../../../model/types';
import { encodeWav } from '../../../../project/wav';
import { impulseKey, irSpec, renderImpulse } from '../../../../engine/effects/plugins/convolver';
import * as A from '../../../../store/actions';
import { allFx } from '../../../../model/fx/hosted';
import { registerEngineSamples } from '../../../../audio/engineSamples';

const sent = new Set<string>();
const rendering = new Set<string>();
/** Last rendered impulses (for the editor display), by key. */
const cache = new Map<string, Float32Array[]>();
const listeners = new Set<() => void>();
let lastCtx: unknown = null;
let lastMixer: unknown = null;

export function engineRate(): number {
  return host.ctx?.sampleRate ?? 48000;
}

export function onImpulseRendered(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function sourceOf(spec: ReturnType<typeof irSpec>): { channels: Float32Array[]; sampleRate: number } | null | undefined {
  if (!spec.impulse) return null;
  const raw = getRaw(spec.impulse);
  if (raw) return raw;
  const info = store.project.samples[spec.impulse] as SampleInfo | undefined;
  if (info && !ensureSample(info) && info.source.kind === 'user') void loadUserSample(info, host.ctx ?? undefined);
  return undefined; // not loaded yet
}

/** The processed impulse for a slot's state at `rate` (cached; rendered synchronously when missing). */
export function impulseFor(params: Record<string, unknown>, rate = engineRate()): Float32Array[] | null {
  const key = impulseKey(params, rate);
  const c = cache.get(key);
  if (c) return c;
  const src = sourceOf(irSpec(params));
  if (src === undefined) return null;
  const ir = renderImpulse(src, params, rate);
  remember(key, ir);
  return ir;
}

function remember(key: string, ir: Float32Array[]): void {
  cache.set(key, ir);
  if (cache.size > 12) cache.delete(cache.keys().next().value as string);
  for (const l of listeners) l();
}

function deliver(key: string, params: Record<string, unknown>, rate: number): void {
  if (sent.has(key) || rendering.has(key)) return;
  rendering.add(key);
  setTimeout(() => {
    rendering.delete(key);
    if (sent.has(key) || host.ctx?.sampleRate !== rate) return;
    const ir = impulseFor(params, rate);
    if (!ir) return; // the pool sample is still loading; onSamplesChanged retries
    const data = ir.map((c) => Float32Array.from(c));
    host.send({ t: 'sample', id: key, data, sampleRate: rate }, data.map((d) => d.buffer));
    sent.add(key);
  }, 40);
}

function scan(p: Project, force = false): void {
  const ctx = host.ctx;
  if (!ctx) return;
  if (ctx !== lastCtx) { lastCtx = ctx; sent.clear(); force = true; }
  if (!force && p.mixer === lastMixer) return;
  lastMixer = p.mixer;
  const rate = ctx.sampleRate;
  const want = new Set<string>();
  for (const s of allFx(p, 'convolver')) {
    const key = impulseKey(s.params, rate);
    want.add(key);
    deliver(key, s.params, rate);
  }
  for (const k of [...sent]) {
    if (!want.has(k)) { host.send({ t: 'sampleRemove', id: k }); sent.delete(k); }
  }
}

// ------------------------------------------------------------------ pool helpers

/** Decode an impulse file into the project's sample pool and load it into the slot (undoable). */
export async function loadImpulseFile(slotId: string, f: File): Promise<boolean> {
  try {
    const { info } = await decodeFile(f, f.name.replace(/\.[^.]+$/, ''), host.ctx ?? undefined);
    store.update('Import sample', (d) => { d.samples[info.id] = info; });
    A.editFx(slotId, 'Load impulse', (p) => { p.impulse = info.id; p.impulseName = info.name; p.trimStart = 0; p.trimEnd = 1; });
    return true;
  } catch {
    return false;
  }
}

/** Use a sample already in the pool as the impulse. */
export function useSample(slotId: string, info: SampleInfo): void {
  A.editFx(slotId, 'Load impulse', (p) => { p.impulse = info.id; p.impulseName = info.name; p.trimStart = 0; p.trimEnd = 1; });
}

/** Store recorded / generated audio as a new pool sample and load it as the impulse. */
export async function useAudio(slotId: string, name: string, channels: Float32Array[], sampleRate: number, extra?: (p: Record<string, unknown>) => void): Promise<void> {
  const id = uid('s');
  addRaw({ id, name, channels, sampleRate });
  await storeUserSample(id, encodeWav(channels, sampleRate, 24));
  const info: SampleInfo = { id, name, frames: channels[0].length, sampleRate, channels: channels.length, source: { kind: 'user', key: id } };
  store.update('Add sample', (d) => { d.samples[id] = info; });
  A.editFx(slotId, name, (p) => { p.impulse = id; p.impulseName = name; p.trimStart = 0; p.trimEnd = 1; extra?.(p); });
}

/** Pick an impulse file with the system dialog. */
export function pickImpulseFile(slotId: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.wav,.aif,.aiff,.flac,.mp3,.ogg';
  input.onchange = () => { const f = input.files?.[0]; if (f) void loadImpulseFile(slotId, f); };
  input.click();
}

// ------------------------------------------------------------------ watch the project (also without an open editor)

const G = globalThis as unknown as { __orchardConvolverSync?: (n: Project) => void; __orchardConvolverTimer?: number };
if (G.__orchardConvolverSync) store.projectListeners.delete(G.__orchardConvolverSync);
G.__orchardConvolverSync = (n: Project) => scan(n);
store.projectListeners.add(G.__orchardConvolverSync);
if (typeof window !== 'undefined') {
  if (G.__orchardConvolverTimer) window.clearInterval(G.__orchardConvolverTimer);
  // the audio context starts later (user gesture) and may restart: re-check periodically
  G.__orchardConvolverTimer = window.setInterval(() => scan(store.project), 1000);
  onSamplesChanged(() => scan(store.project, true));
  queueMicrotask(() => scan(store.project, true));
}

// ------------------------------------------------------------------ project export (fresh engine at the export rate)
registerEngineSamples('convolver', (p, rate) => {
  const out: { id: string; channels: Float32Array[]; sampleRate: number }[] = [];
  for (const s of allFx(p, 'convolver')) {
    const ir = impulseFor(s.params, rate);
    if (ir) out.push({ id: impulseKey(s.params, rate), channels: ir, sampleRate: rate });
  }
  return out;
});
