// Edison's audio bookkeeping on the main thread:
// - every edit stores the new audio as a pool sample (addRaw + the project's
//   sample list, so it is saved with the project and restored on load),
//   delivers it to the engine under ED_PREFIX + id, pushes Edison's undo
//   history (`hist` / `hpos` in the slot state) and frees what fell out of it;
// - the recorder: a watcher on every Edison slot (also while its editor is
//   closed) collects the recorded chunks the DSP hands out through monitor(),
//   assembles each take (wrapping at the "For" duration) and commits it when
//   the take ends;
// - the current audio is also written to IndexedDB (as a 32-bit WAV) so the
//   autosave backup can restore it, like user samples.

import { host, store } from '../../../../store';
import { allFx, findFx, fxParamsDraft, setFxStateNoHistory } from '../../../../store/actions';
import { addRaw, getRaw, removeRaw, storeUserSample, onSamplesChanged, type RawSample } from '../../../../audio/samples';
import { mixerTrackName, uid } from '../../../../model/defaults';
import {
  ED_LARGE_UNDO_BYTES, ED_PREFIX, ED_UNDO_LEVELS, edRecLimit, edState,
  type EdHist, type EdMarker, type EdState,
} from '../../../../model/fx/plugins/edison';
import type { Project, SampleInfo } from '../../../../model/types';
import type { FxMonitor } from '../../../../engine/effects/types';
import { encodeEdisonWav } from './wav';
import { registerEngineSamples } from '../../../../audio/engineSamples';
import { concatChans, frames, markersClip, resampleChans, type Chans } from './ops';

// ------------------------------------------------------------------ peaks
/** Frames per block of the cached min / max overview. */
export const PEAK_BLOCK = 256;

export interface BlockPeaks {
  /** Per channel: interleaved [min, max] per block. */
  mm: Float32Array[];
  blocks: number;
}

export function computePeaks(ch: Chans, len = frames(ch)): BlockPeaks {
  const blocks = Math.ceil(len / PEAK_BLOCK);
  const mm = ch.map((c) => {
    const o = new Float32Array(blocks * 2);
    for (let b = 0; b < blocks; b++) {
      let lo = Infinity, hi = -Infinity;
      const e = Math.min(len, (b + 1) * PEAK_BLOCK);
      for (let i = b * PEAK_BLOCK; i < e; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      o[b * 2] = lo === Infinity ? 0 : lo;
      o[b * 2 + 1] = hi === -Infinity ? 0 : hi;
    }
    return o;
  });
  return { mm, blocks };
}

const peakCache = new Map<string, BlockPeaks>();

/** Cached block peaks of a pool sample (audio of an id never changes). */
export function peaksOf(id: string, raw: RawSample): BlockPeaks {
  let p = peakCache.get(id);
  if (!p) {
    p = computePeaks(raw.channels);
    peakCache.set(id, p);
    if (peakCache.size > 24) peakCache.delete(peakCache.keys().next().value as string);
  }
  return p;
}

// ------------------------------------------------------------------ engine
type G = { __edisonAudio?: { sent: Set<string>; persisted: Set<string>; sessions: Map<string, Session>; clip: { ch: Chans; sr: number } | null; noise: Float32Array | null } };
const shared = ((globalThis as unknown as G).__edisonAudio ??= {
  sent: new Set<string>(),
  persisted: new Set<string>(),
  sessions: new Map<string, Session>(),
  clip: null,
  noise: null,
});

/** Audio of a pool sample (undefined when missing or released). */
export function audioOf(id: string | null | undefined): RawSample | undefined {
  if (!id) return undefined;
  const r = getRaw(id);
  return r && r.channels.length && r.channels[0].length ? r : undefined;
}

/** Make sure the engine has a pool sample under Edison's prefix. */
export function deliver(id: string | null | undefined): boolean {
  if (!id) return false;
  if (shared.sent.has(id)) return true;
  const r = audioOf(id);
  if (!r) return false;
  const data = r.channels.map((c) => new Float32Array(c));
  host.send({ t: 'sample', id: ED_PREFIX + id, data, sampleRate: r.sampleRate }, data.map((d) => d.buffer));
  shared.sent.add(id);
  return true;
}

function undeliver(id: string): void {
  if (!shared.sent.delete(id)) return;
  host.send({ t: 'sampleRemove', id: ED_PREFIX + id });
}

/** Ids that are the current audio of some Edison slot. */
function currentIds(p: Project): Set<string> {
  const s = new Set<string>();
  for (const sl of allFx(p, 'edison')) if (typeof sl.params.sample === 'string') s.add(sl.params.sample);
  return s;
}

/** Ids still referenced by some Edison slot's undo history. */
function historyIds(p: Project): Set<string> {
  const s = new Set<string>();
  for (const sl of allFx(p, 'edison')) {
    const h = sl.params.hist;
    if (Array.isArray(h)) for (const e of h) if (e && typeof (e as EdHist).id === 'string') s.add((e as EdHist).id as string);
    if (typeof sl.params.sample === 'string') s.add(sl.params.sample);
  }
  return s;
}

/** Engine copies of audio no slot plays any more are dropped (undo delivers them again). */
function releaseEngineCopies(p: Project): void {
  const cur = currentIds(p);
  for (const id of [...shared.sent]) if (!cur.has(id)) undeliver(id);
}

/** Audio that fell out of every undo history is freed from the pool. */
function freeDropped(p: Project, dropped: string[]): void {
  if (!dropped.length) return;
  const keep = historyIds(p);
  for (const ch of p.channels) if (ch.sampler.sampleId) keep.add(ch.sampler.sampleId);
  for (const id of dropped) {
    if (keep.has(id) || p.samples[id]) continue;
    if (getRaw(id)) removeRaw(id);
    peakCache.delete(id);
  }
}

// --------------------------------------------------------------- persistence
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Write the current audio of every Edison slot to IndexedDB (debounced). */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    for (const id of currentIds(store.project)) {
      if (shared.persisted.has(id)) continue;
      const r = audioOf(id);
      if (!r) continue;
      shared.persisted.add(id);
      void storeUserSample(id, encodeEdisonWav(r.channels, r.sampleRate, 32));
    }
  }, 1500);
}

// ------------------------------------------------------------------ commits
function slotOf(d: Project, slotId: string): Record<string, unknown> | null {
  return (fxParamsDraft(d, slotId) as Record<string, unknown> | undefined) ?? null;
}

function referencedElsewhere(d: Project, id: string, slotId: string): boolean {
  for (const c of d.channels) if (c.sampler.sampleId === id) return true;
  // every effect state but this one's, modules hosted in Patcher included
  const own = fxParamsDraft(d, slotId);
  let found = false;
  const scan = (o: unknown, depth: number) => {
    if (found || !o || typeof o !== 'object' || o === own || depth > 5) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (/sample/i.test(k) && (v === id || (v && typeof v === 'object' && (v as { id?: unknown }).id === id))) { found = true; return; }
      if (v && typeof v === 'object') scan(v, depth + 1);
    }
  };
  for (const t of d.mixer.tracks) for (const sl of t.slots) if (sl) scan(sl.params, 0);
  return found;
}

function infoOf(id: string, r: RawSample): SampleInfo {
  return { id, name: r.name, frames: r.channels[0]?.length ?? 0, sampleRate: r.sampleRate, channels: r.channels.length, source: { kind: 'user', key: id } };
}

/** Switch the slot's current audio inside a store recipe (sample list kept in step). */
function setCurrent(d: Project, slotId: string, s: Record<string, unknown>, id: string | null): void {
  const prev = typeof s.sample === 'string' ? s.sample : null;
  if (id) {
    const r = audioOf(id);
    if (r && !d.samples[id]) d.samples[id] = infoOf(id, r);
  }
  if (prev && prev !== id && d.samples[prev] && !referencedElsewhere(d, prev, slotId)) delete d.samples[prev];
  s.sample = id;
}

function sampleName(slotId: string, st: EdState): string {
  if (st.title) return st.title;
  const loc = findFx(store.project, slotId);
  const tr = loc ? store.project.mixer.tracks[loc.track] : null;
  return `Edison${tr ? ' - ' + mixerTrackName(tr) : ''}`;
}

export interface CommitOpts {
  markers?: EdMarker[];
  loopPts?: [number, number] | null;
  /** New selection (undefined: keep, clipped to the new length). */
  sel?: [number, number] | null;
  /** Further slot state changes in the same step. */
  extra?: (s: Record<string, unknown>) => void;
}

/**
 * Store new audio for a slot: a new pool sample, delivered to the engine,
 * made current, with an undo step. Returns the new sample id.
 */
export function commitAudio(slotId: string, ch: Chans, sampleRate: number, label: string, o: CommitOpts = {}): string | null {
  const p0 = store.project;
  const s0 = slotOf(p0, slotId);
  if (!s0) return null;
  const st = edState(s0);
  const len = frames(ch);
  let id: string | null = null;
  if (len > 0) {
    id = uid('ed');
    addRaw({ id, name: sampleName(slotId, st), channels: ch, sampleRate });
    deliver(id);
  }
  const markers = markersClip(o.markers ?? st.markers, len);
  const loopPts = o.loopPts !== undefined ? o.loopPts : st.loopPts;
  const lp = loopPts && loopPts[0] < len ? [loopPts[0], Math.min(len, loopPts[1])] as [number, number] : null;
  const large = len * ch.length * 4 > ED_LARGE_UNDO_BYTES && !st.undoLarge;
  let hist: EdHist[] = large ? [] : st.hist.slice(0, st.hpos + 1);
  const before = new Set(st.hist.map((h) => h.id).filter((x): x is string => !!x));
  hist = [...hist, { id, label, markers, loopPts: lp }];
  if (hist.length > ED_UNDO_LEVELS + 1) hist = hist.slice(hist.length - ED_UNDO_LEVELS - 1);
  const after = new Set(hist.map((h) => h.id).filter((x): x is string => !!x));
  const dropped = [...before].filter((x) => !after.has(x));
  let sel = o.sel !== undefined ? o.sel : st.sel;
  if (sel) sel = sel[0] < len ? [sel[0], Math.min(len, sel[1])] : null;
  if (sel && sel[1] <= sel[0]) sel = null;
  store.update(label, (d) => {
    const s = slotOf(d, slotId);
    if (!s) return;
    setCurrent(d, slotId, s, id);
    s.hist = hist;
    s.hpos = hist.length - 1;
    s.markers = markers;
    s.loopPts = lp;
    s.sel = sel;
    o.extra?.(s);
  });
  releaseEngineCopies(store.project);
  freeDropped(store.project, dropped);
  schedulePersist();
  return id;
}

/** Region / loop-point edits without new audio: an undo step with the same sample. */
export function commitRegions(slotId: string, label: string, markers: EdMarker[], loopPts: [number, number] | null, extra?: (s: Record<string, unknown>) => void): void {
  const s0 = slotOf(store.project, slotId);
  if (!s0) return;
  const st = edState(s0);
  const ms = [...markers].sort((a, b) => a.pos - b.pos);
  let hist: EdHist[] = [...st.hist.slice(0, st.hpos + 1), { id: st.sample, label, markers: ms, loopPts }];
  if (hist.length > ED_UNDO_LEVELS + 1) hist = hist.slice(hist.length - ED_UNDO_LEVELS - 1);
  store.update(label, (d) => {
    const s = slotOf(d, slotId);
    if (!s) return;
    s.hist = hist;
    s.hpos = hist.length - 1;
    s.markers = ms;
    s.loopPts = loopPts;
    extra?.(s);
  });
}

/** Move in Edison's undo history (undo: -1, redo: +1, or an absolute index). */
export function gotoHistory(slotId: string, target: number): boolean {
  const s0 = slotOf(store.project, slotId);
  if (!s0) return false;
  const st = edState(s0);
  const i = Math.round(target);
  if (i < 0 || i >= st.hist.length || i === st.hpos) return false;
  const h = st.hist[i];
  if (h.id && !audioOf(h.id)) return false; // freed
  deliver(h.id);
  const label = i < st.hpos ? `Undo ${st.hist[st.hpos].label}` : `Redo ${h.label}`;
  setFxStateNoHistoryWithSamples(slotId, label, (d, s) => {
    setCurrent(d, slotId, s, h.id);
    s.hpos = i;
    s.markers = h.markers;
    s.loopPts = h.loopPts;
    const len = audioOf(h.id)?.channels[0].length ?? 0;
    const sel = edState(s).sel;
    s.sel = sel && sel[0] < len ? [sel[0], Math.min(len, sel[1])] : null;
  });
  releaseEngineCopies(store.project);
  schedulePersist();
  return true;
}

function setFxStateNoHistoryWithSamples(slotId: string, label: string, recipe: (d: Project, s: Record<string, unknown>) => void): void {
  store.update(label, (d) => {
    const s = slotOf(d as Project, slotId);
    if (s) recipe(d as Project, s);
  }, { noHistory: true });
}

/** Slot state changes that are not Edison edits (transport, view, selection): no undo entry. */
export function setTransient(slotId: string, label: string, recipe: (s: Record<string, unknown>) => void): void {
  setFxStateNoHistory(slotId, label, (p) => recipe(p as Record<string, unknown>));
}

// ------------------------------------------------------------------ clipboard
/** Edison's clipboard (shared by every Edison, like FL's). */
export function getClip(): { ch: Chans; sr: number } | null { return shared.clip; }
export function setClip(ch: Chans, sr: number): void { shared.clip = { ch: ch.map((c) => new Float32Array(c)), sr }; }

/** Acquired noise profile (Tools > Spectral > Acquire noise profile). */
export function getNoiseProfile(): Float32Array | null { return shared.noise; }
export function setNoiseProfile(p: Float32Array | null): void { shared.noise = p; }

// ------------------------------------------------------------------ recorder
interface Take {
  key: string;
  id: number;
  L: Float32Array;
  R: Float32Array;
  /** Frames written (when wrapping: total, the buffer holds the last `cap`). */
  total: number;
  cap: number;
  wrap: boolean;
  limit: number;
  marks: number[];
  sr: number;
  peaks: BlockPeaks;
}

export interface Live {
  pkL: number;
  pkR: number;
  pos: number;
  play: boolean;
  scrub: boolean;
  host: boolean;
  armed: boolean;
  rec: number;
  loaded: boolean;
  len: number;
  sr: number;
}

export interface Session {
  slotId: string;
  inst: number;
  takes: Map<number, Take>;
  committed: Set<string>;
  live: Live;
  listeners: Set<() => void>;
  unwatch: (() => void) | null;
}

function newSession(slotId: string): Session {
  return {
    slotId, inst: -1, takes: new Map(), committed: new Set(), listeners: new Set(), unwatch: null,
    live: { pkL: 0, pkR: 0, pos: 0, play: false, scrub: false, host: false, armed: false, rec: 0, loaded: false, len: 0, sr: host.sampleRate },
  };
}

export function session(slotId: string): Session {
  let s = shared.sessions.get(slotId);
  if (!s) { s = newSession(slotId); shared.sessions.set(slotId, s); }
  return s;
}

/** Subscribe to a slot's live data (meters, playhead, recording). */
export function subscribe(slotId: string, fn: () => void): () => void {
  const s = session(slotId);
  s.listeners.add(fn);
  return () => { s.listeners.delete(fn); };
}

function growTake(t: Take, need: number): void {
  if (need <= t.L.length) return;
  const n = Math.min(t.limit, Math.max(need, t.L.length * 2, 1 << 16));
  const L = new Float32Array(n), R = new Float32Array(n);
  L.set(t.L.subarray(0, Math.min(t.total, t.L.length)));
  R.set(t.R.subarray(0, Math.min(t.total, t.R.length)));
  t.L = L; t.R = R;
  const blocks = Math.ceil(n / PEAK_BLOCK);
  const mm = t.peaks.mm.map((o) => { const x = new Float32Array(blocks * 2); x.set(o); return x; });
  t.peaks = { mm, blocks };
}

function writeTake(t: Take, off: number, L: Float32Array, R: Float32Array): void {
  const n = L.length;
  if (!t.wrap) {
    const end = Math.min(off + n, t.limit);
    if (end <= off) return;
    growTake(t, end);
    t.L.set(L.subarray(0, end - off), off);
    t.R.set(R.subarray(0, end - off), off);
    if (end > t.total) t.total = end;
    updatePeaks(t, off, end);
  } else {
    const cap = t.cap;
    if (t.L.length < cap) growTake(t, Math.min(cap, off + n));
    for (let i = 0; i < n; i++) {
      const j = (off + i) % cap;
      if (j >= t.L.length) growTake(t, Math.min(cap, j + 1));
      t.L[j] = L[i];
      t.R[j] = R[i];
    }
    if (off + n > t.total) t.total = off + n;
    const a = off % cap, b = a + n;
    if (b <= cap) updatePeaks(t, a, b); else { updatePeaks(t, a, cap); updatePeaks(t, 0, b - cap); }
  }
}

function updatePeaks(t: Take, a: number, b: number): void {
  const b0 = Math.floor(a / PEAK_BLOCK), b1 = Math.ceil(b / PEAK_BLOCK);
  const chs = [t.L, t.R];
  for (let k = 0; k < 2; k++) {
    const c = chs[k], o = t.peaks.mm[k];
    for (let blk = b0; blk < b1; blk++) {
      let lo = Infinity, hi = -Infinity;
      const e = Math.min(c.length, (blk + 1) * PEAK_BLOCK);
      for (let i = blk * PEAK_BLOCK; i < e; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      o[blk * 2] = lo === Infinity ? 0 : lo;
      o[blk * 2 + 1] = hi === -Infinity ? 0 : hi;
    }
  }
}

function newTake(s: Session, id: number, sr: number): Take {
  const st = edState(slotOf(store.project, s.slotId));
  const lim = edRecLimit(st.recMax, sr);
  return {
    key: `${s.inst}:${id}`, id, L: new Float32Array(0), R: new Float32Array(0), total: 0,
    cap: lim.frames, wrap: lim.wrap, limit: lim.frames, marks: [], sr,
    peaks: { mm: [new Float32Array(0), new Float32Array(0)], blocks: 0 },
  };
}

/** The take being recorded, for the live display (`cursor` = recording position in the buffer). */
export function liveTake(slotId: string): { ch: Chans; len: number; cursor: number; peaks: BlockPeaks; wrapped: boolean } | null {
  const s = shared.sessions.get(slotId);
  if (!s) return null;
  let t: Take | null = null;
  for (const x of s.takes.values()) if (!s.committed.has(x.key) && (!t || x.id > t.id)) t = x;
  if (!t || t.total <= 0) return null;
  const len = Math.min(t.total, t.wrap ? t.cap : t.limit, t.L.length);
  return {
    ch: [t.L.subarray(0, len), t.R.subarray(0, len)], len,
    cursor: t.wrap ? t.total % t.cap : t.total, peaks: t.peaks, wrapped: t.wrap && t.total > t.cap,
  };
}

function commitTake(s: Session, t: Take): void {
  s.committed.add(t.key);
  s.takes.delete(t.id);
  if (t.total <= 0) return;
  // chronological order (a wrapped take keeps its last `cap` frames)
  let L: Float32Array, R: Float32Array, shift = 0;
  if (t.wrap && t.total > t.cap) {
    const start = t.total % t.cap;
    L = new Float32Array(t.cap); R = new Float32Array(t.cap);
    L.set(t.L.subarray(start, t.cap)); L.set(t.L.subarray(0, start), t.cap - start);
    R.set(t.R.subarray(start, t.cap)); R.set(t.R.subarray(0, start), t.cap - start);
    shift = t.total - t.cap;
  } else {
    const n = Math.min(t.total, t.L.length);
    L = t.L.slice(0, n); R = t.R.slice(0, n);
  }
  const p = slotOf(store.project, s.slotId);
  if (!p) return;
  const st = edState(p);
  const base = st.append ? audioOf(st.sample) : undefined;
  const baseLen = base ? base.channels[0].length : 0;
  let ch: Chans = [L, R];
  let sr = t.sr;
  let scale = 1;
  if (base) {
    // appended to the existing audio (resampled to its rate if they differ)
    if (base.sampleRate !== t.sr) {
      scale = base.sampleRate / t.sr;
      ch = resampleChans(ch, t.sr / base.sampleRate);
      sr = base.sampleRate;
    }
    ch = concatChans(base.channels, ch);
  }
  const marks: EdMarker[] = t.marks.map((m) => m - shift).filter((m) => m >= 0 && m < L.length)
    .map((m) => ({ pos: Math.round(m * scale + baseLen), name: 'Song jump' }));
  const markers = base ? [...st.markers, ...marks] : marks;
  commitAudio(s.slotId, ch, sr, 'Record', { markers, loopPts: base ? st.loopPts : null, sel: null });
}

function onMonitor(s: Session, d: FxMonitor): void {
  const inst = Number(d.inst) || 0;
  if (inst !== s.inst) {
    // a new DSP instance (project load, slot moved): its takes are new
    s.inst = inst;
    s.takes.clear();
  }
  const L = s.live;
  L.pkL = Number(d.pkL) || 0;
  L.pkR = Number(d.pkR) || 0;
  L.pos = Number(d.pos) || 0;
  L.play = !!d.play;
  L.scrub = !!d.scrub;
  L.host = !!d.host;
  L.armed = !!d.armed;
  L.rec = Number(d.rec) || 0;
  L.loaded = !!d.loaded;
  L.len = Number(d.len) || 0;
  L.sr = Number(d.sr) || L.sr;
  const sr = L.sr;
  // recorded audio
  if (d.recL instanceof Float32Array && d.recR instanceof Float32Array && typeof d.ctake === 'number') {
    const key = `${inst}:${d.ctake}`;
    if (!s.committed.has(key)) {
      let t = s.takes.get(d.ctake);
      if (!t) { t = newTake(s, d.ctake, sr); s.takes.set(d.ctake, t); }
      writeTake(t, Number(d.off) || 0, d.recL, d.recR);
    }
  }
  if (typeof d.take === 'number' && !s.takes.has(d.take) && !s.committed.has(`${inst}:${d.take}`)) {
    s.takes.set(d.take, newTake(s, d.take, sr));
  }
  if (Array.isArray(d.marks) && typeof d.mtake === 'number') {
    const t = s.takes.get(d.mtake);
    if (t) t.marks.push(...(d.marks as number[]));
  }
  const fin = Number(d.fin) || 0;
  if (fin > 0) for (const t of [...s.takes.values()].sort((a, b) => a.id - b.id)) if (t.id <= fin && !s.committed.has(t.key)) commitTake(s, t);
  // the DSP stopped at the recording cap: the Record switch follows
  if (d.auto && !d.armed) {
    const p = slotOf(store.project, s.slotId);
    if (p && Number(p.rec) >= 0.5) setTransient(s.slotId, 'Record', (q) => { q.rec = 0; });
  }
  // wrap / stop handling for durations is done by the take buffer itself
  s.listeners.forEach((fn) => fn());
}

// ------------------------------------------------------------- slot watcher
let lastMixer: unknown = null;
let lastSamples: unknown = null;

function scan(p: Project): void {
  if (p.mixer === lastMixer && p.samples === lastSamples) return;
  lastMixer = p.mixer;
  lastSamples = p.samples;
  const ids = new Set<string>();
  for (const sl of allFx(p, 'edison')) {
    ids.add(sl.id);
    const s = session(sl.id);
    if (!s.unwatch) s.unwatch = host.watchFx(sl.id, (d) => onMonitor(s, d));
    if (typeof sl.params.sample === 'string') deliver(sl.params.sample);
  }
  for (const [id, s] of shared.sessions) {
    if (ids.has(id) || id.startsWith('gallery:')) continue;
    s.unwatch?.();
    s.unwatch = null;
    shared.sessions.delete(id);
  }
  releaseEngineCopies(p);
}

const g = globalThis as unknown as { __edisonWatch?: boolean };
if (!g.__edisonWatch) {
  g.__edisonWatch = true;
  store.projectListeners.add((next) => scan(next));
  onSamplesChanged(() => { lastSamples = null; scan(store.project); });
  queueMicrotask(() => scan(store.project));
}

// project export: a fresh engine gets each Edison slot's current audio
registerEngineSamples('edison', (p) => {
  const out: { id: string; channels: Float32Array[]; sampleRate: number }[] = [];
  for (const s of allFx(p, 'edison')) {
    const st = edState(s.params);
    const r = st.sample ? getRaw(st.sample) : undefined;
    if (st.sample && r) out.push({ id: ED_PREFIX + st.sample, channels: r.channels, sampleRate: r.sampleRate });
  }
  return out;
});
