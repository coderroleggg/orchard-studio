// Render manager for Newtone / Newtime: watches the project (also while no
// editor is open) and keeps every slot's render in step with its edits.
// A slot's edit fingerprint (source, analysis, notes / markers, wheels,
// tempo-sync) is compared with the fingerprint stored with its render
// (`out.hash`); a stale or missing render is re-made in the worker after a
// short debounce, stored in the pool (replacing the previous one) and sent
// to the engine before the state points to it. Undo / redo simply changes
// the fingerprint again. Renders of a loaded project come back from the
// pool / IndexedDB, or are re-rendered from the source.

import { useSyncExternalStore } from 'react';
import { store } from '../../../../store';
import { findFx, setFxStateNoHistory } from '../../../../store/actions';
import { allFx } from '../../../../model/fx/hosted';
import { getRaw, loadUserSample } from '../../../../audio/samples';
import { hashString } from '../../../../engine/effects/plugins/newtools/util';
import { toneEditKey, type NtAnalysis, type NtNote, type ToneKnobs } from '../../../../engine/effects/plugins/newtools/tonemodel';
import { timeEditKey, type NtmMarker } from '../../../../engine/effects/plugins/newtools/timemodel';
import { NT_SAMPLE_PREFIX } from '../../../../model/fx/plugins/newtone';
import { NTM_SAMPLE_PREFIX } from '../../../../model/fx/plugins/newtime';
import type { Project, SampleInfo } from '../../../../model/types';
import { runJob } from './jobs';
import { registerEngineSamples } from '../../../../audio/engineSamples';
import { deliverToEngine, isDelivered, renderId, sourceAudio, storeRender } from './samples';

type P = Record<string, unknown>;

interface RenderRef { id: string; hash: string; frames: number; sr: number }

interface Adapter {
  prefix: string;
  suffix: string;
  /** Edit fingerprint, or null when there is nothing to render. */
  key(p: P, project: Project): string | null;
  render(p: P, ch: Float32Array[], sr: number, src: string, project: Project, progress: (v: number) => void): Promise<Float32Array[]>;
}

export const toneKnobs = (p: P): ToneKnobs => ({
  center: Number(p.center) || 0,
  vari: typeof p.vari === 'number' ? p.vari : 8192,
  trans: typeof p.trans === 'number' ? p.trans : 16384,
  scale: p.snapScale ? Number(p.scale) || 0 : -1,
});

/** Tempo-sync time ratio (sample tempo / project tempo). */
export function syncRatio(p: P, project: Project): number {
  const bpm = Number(p.bpm) || 0;
  return p.sync && bpm > 0 && project.tempo > 0 ? bpm / project.tempo : 1;
}

const ADAPTERS: Record<string, Adapter> = {
  newtone: {
    prefix: NT_SAMPLE_PREFIX,
    suffix: 'Newtone',
    key: (p, project) => {
      const sm = p.sample as SampleInfo | null;
      const an = p.an as NtAnalysis | null;
      if (!sm || !an) return null;
      return toneEditKey(an, (p.notes as NtNote[]) ?? [], toneKnobs(p), sm.id) + '|' + syncRatio(p, project);
    },
    render: (p, ch, sr, src, project, progress) => runJob<Float32Array[]>({
      kind: 'renderTone', an: p.an as NtAnalysis, notes: (p.notes as NtNote[]) ?? [], knobs: toneKnobs(p), ratio: syncRatio(p, project),
    }, src, ch, sr, progress),
  },
  newtime: {
    prefix: NTM_SAMPLE_PREFIX,
    suffix: 'Newtime',
    key: (p, project) => {
      const sm = p.sample as SampleInfo | null;
      if (!sm || !p.analyzed) return null;
      return timeEditKey(sm.id, (p.markers as NtmMarker[]) ?? [], { groove: Number(p.groove) || 0, shift: Number(p.shift) || 0 }, Number(p.bpm) || 120, !!p.sync, project.tempo);
    },
    render: (p, ch, sr, src, project, progress) => {
      void progress;
      return runJob<Float32Array[]>({
        kind: 'renderTime', markers: (p.markers as NtmMarker[]) ?? [], knobs: { groove: Number(p.groove) || 0, shift: Number(p.shift) || 0 },
        bpm: Number(p.bpm) || 120, sync: !!p.sync, tempo: project.tempo,
      }, src, ch, sr);
    },
  },
};

// ------------------------------------------------------------ status
export interface RenderStatus { busy: boolean; progress: number; error: string }
const IDLE: RenderStatus = { busy: false, progress: 0, error: '' };
const status = new Map<string, RenderStatus>();
const statusListeners = new Set<() => void>();

function setStatus(slotId: string, s: RenderStatus): void {
  status.set(slotId, s);
  statusListeners.forEach((l) => l());
}

export function getRenderStatus(slotId: string): RenderStatus {
  return status.get(slotId) ?? IDLE;
}

export function useRenderStatus(slotId: string): RenderStatus {
  return useSyncExternalStore(
    (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    () => getRenderStatus(slotId),
  );
}

// ------------------------------------------------------------ hashing
const hashCache = new WeakMap<object, { tempo: number; h: string | null }>();

function hashOf(ad: Adapter, p: P, project: Project): string | null {
  const c = hashCache.get(p);
  if (c && c.tempo === project.tempo) return c.h;
  const k = ad.key(p, project);
  const h = k === null ? null : hashString(k) + hashString(k.length + ':' + k);
  hashCache.set(p, { tempo: project.tempo, h });
  return h;
}

/** The current edit fingerprint of a slot (null = nothing to render). */
export function slotHash(slotId: string): string | null {
  const loc = findFx(store.project, slotId);
  if (!loc) return null;
  const ad = ADAPTERS[loc.fx.plugin];
  return ad ? hashOf(ad, loc.fx.params as P, store.project) : null;
}

// ------------------------------------------------------------ scheduling
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const wanted = new Map<string, string>();
const running = new Set<string>();
const rerun = new Set<string>();
const restoring = new Set<string>();

function schedule(slotId: string, delay: number): void {
  const old = timers.get(slotId);
  if (old) clearTimeout(old);
  timers.set(slotId, setTimeout(() => { timers.delete(slotId); void run(slotId); }, delay));
}

/** Render a slot now (e.g. before exporting). */
export function renderNow(slotId: string): void {
  wanted.delete(slotId);
  schedule(slotId, 0);
}

async function run(slotId: string): Promise<void> {
  if (running.has(slotId)) { rerun.add(slotId); return; }
  const loc = findFx(store.project, slotId);
  if (!loc) { wanted.delete(slotId); return; }
  const ad = ADAPTERS[loc.fx.plugin];
  if (!ad) return;
  const p = loc.fx.params as P;
  const h = hashOf(ad, p, store.project);
  if (h === null) return;
  running.add(slotId);
  setStatus(slotId, { busy: true, progress: 0, error: '' });
  try {
    const raw = await sourceAudio(p.sample as SampleInfo);
    if (!raw) throw new Error('The sample is not available');
    const res = await ad.render(p, raw.channels, raw.sampleRate, raw.id, store.project, (v) => setStatus(slotId, { busy: true, progress: v, error: '' }));
    const now = findFx(store.project, slotId);
    if (!now) return;
    const h2 = hashOf(ad, now.fx.params as P, store.project);
    if (h2 !== h) { rerun.add(slotId); return; }
    const id = renderId(loc.fx.plugin, slotId);
    const sm = p.sample as SampleInfo;
    storeRender(id, `${sm.name} (${ad.suffix})`, res, raw.sampleRate);
    deliverToEngine(ad.prefix + id, h, res, raw.sampleRate);
    setFxStateNoHistory(slotId, 'Render', (d) => { d.out = { id, hash: h, frames: res[0]?.length ?? 0, sr: raw.sampleRate }; });
    setStatus(slotId, IDLE);
  } catch (e) {
    setStatus(slotId, { busy: false, progress: 0, error: (e as Error).message || 'Render failed' });
  } finally {
    running.delete(slotId);
    if (rerun.has(slotId)) { rerun.delete(slotId); wanted.delete(slotId); schedule(slotId, 30); }
    else if (getRenderStatus(slotId).busy) setStatus(slotId, IDLE);
  }
}

/** Make sure an existing render is in the pool and the engine (loaded projects). */
function ensureDelivered(slotId: string, ad: Adapter, out: RenderRef): void {
  const key = ad.prefix + out.id;
  if (isDelivered(key, out.hash)) return;
  const r = getRaw(out.id);
  if (r) { deliverToEngine(key, out.hash, r.channels, r.sampleRate); return; }
  if (restoring.has(slotId)) return;
  restoring.add(slotId);
  const info = store.project.samples[out.id];
  void (async () => {
    let ok = false;
    if (info) ok = await loadUserSample(info);
    restoring.delete(slotId);
    const r2 = getRaw(out.id);
    if (ok && r2) deliverToEngine(key, out.hash, r2.channels, r2.sampleRate);
    else { wanted.delete(slotId); schedule(slotId, 0); }
  })();
}

let lastMixer: unknown = null;
let lastTempo = 0;

function scan(project: Project): void {
  if (project.mixer === lastMixer && project.tempo === lastTempo) return;
  lastMixer = project.mixer;
  lastTempo = project.tempo;
  const live = new Set<string>();
  for (const s of allFx(project)) {
    const ad = ADAPTERS[s.plugin];
    if (!ad) continue;
    const p = s.params as P;
    const h = hashOf(ad, p, project);
    const out = p.out as RenderRef | null;
    if (out) live.add(out.id);
    if (h === null) {
      wanted.delete(s.id);
      if (out) setFxStateNoHistory(s.id, 'Render', (d) => { d.out = null; d.play = 0; });
      continue;
    }
    if (out && out.hash === h) { wanted.set(s.id, h); ensureDelivered(s.id, ad, out); continue; }
    if (wanted.get(s.id) === h) continue;
    wanted.set(s.id, h);
    schedule(s.id, out ? 220 : 0);
  }
  // renders of removed slots are not project data any more (not saved with it)
  const orphans = Object.keys(project.samples).filter((id) => /^(ntr|nmr)-/.test(id) && !live.has(id));
  if (orphans.length) queueMicrotask(() => store.update('Render', (d) => { for (const id of orphans) delete d.samples[id]; }, { noHistory: true }));
}

const g = globalThis as unknown as { __newtoolsWatch?: boolean };
if (!g.__newtoolsWatch) {
  g.__newtoolsWatch = true;
  store.projectListeners.add((next) => scan(next));
  queueMicrotask(() => scan(store.project));
}

// project export: a fresh engine gets each slot's current render
registerEngineSamples('newtools', (project) => {
  const out: { id: string; channels: Float32Array[]; sampleRate: number }[] = [];
  for (const s of allFx(project)) {
    const ad = ADAPTERS[s.plugin];
    const ref = ad ? ((s.params as P).out as RenderRef | null) : null;
    if (!ad || !ref) continue;
    const r = getRaw(ref.id);
    if (r) out.push({ id: ad.prefix + ref.id, channels: r.channels, sampleRate: r.sampleRate });
  }
  return out;
});
