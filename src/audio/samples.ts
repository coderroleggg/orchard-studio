// Sample pool (main thread): raw decoded audio, user file storage, and the
// Sampler's precomputed effects (normalize, reverse, fades...). The engine only
// ever receives processed buffers, keyed by sample id + effect settings.

import type { SampleInfo, Id } from '../model/types';
import type { SamplerSettings } from '../model/sampler';
import { generateBuiltin, BUILTIN_SAMPLES } from './drumkit';
import { uid } from '../model/defaults';
import { resampleBuffer } from '../engine/dsp/sinc';
import { SvfCoefs, SvfMode, SvfState } from '../engine/dsp/svf';

export interface RawSample {
  id: Id;
  name: string;
  channels: Float32Array[];
  sampleRate: number;
}

// kept on globalThis so a dev-server hot reload does not drop loaded audio
const pool = ((globalThis as unknown as { __orchardSamples?: { raw: Map<Id, RawSample>; processed: Map<string, Float32Array[]> } }).__orchardSamples ??= {
  raw: new Map<Id, RawSample>(),
  processed: new Map<string, Float32Array[]>(),
});
const raw = pool.raw;
const processed = pool.processed;
const listeners = new Set<() => void>();
let version = 0;

export function onSamplesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  version++;
  listeners.forEach((l) => l());
}

export function samplesVersion(): number { return version; }

export function getRaw(id: Id): RawSample | undefined {
  return raw.get(id);
}

export function allRaw(): RawSample[] {
  return [...raw.values()];
}

export function addRaw(s: RawSample): void {
  raw.set(s.id, s);
  emit();
}

/** Drop a sample's audio from the pool (renders and edit history no project data refers to any more). */
export function removeRaw(id: Id): void {
  if (raw.delete(id)) emit();
}

/** Generate all built-in samples; returns SampleInfo records and a key->id map. */
export function loadBuiltins(): { infos: Record<Id, SampleInfo>; byKey: Record<string, Id> } {
  const infos: Record<Id, SampleInfo> = {};
  const byKey: Record<string, Id> = {};
  for (const b of BUILTIN_SAMPLES) {
    const g = generateBuiltin(b.key);
    if (!g) continue;
    const id = 'builtin:' + b.key;
    raw.set(id, { id, name: g.name, channels: g.channels, sampleRate: g.sampleRate });
    infos[id] = {
      id, name: g.name, frames: g.channels[0].length, sampleRate: g.sampleRate,
      channels: g.channels.length, source: { kind: 'builtin', key: b.key },
    };
    byKey[b.key] = id;
  }
  emit();
  return { infos, byKey };
}

/** Make sure a sample referenced by a project is present in the pool. */
export function ensureSample(info: SampleInfo): boolean {
  if (raw.has(info.id)) return true;
  if (info.source.kind === 'builtin') {
    const g = generateBuiltin(info.source.key);
    if (!g) return false;
    raw.set(info.id, { id: info.id, name: g.name, channels: g.channels, sampleRate: g.sampleRate });
    emit();
    return true;
  }
  return false;
}

let decodeCtx: BaseAudioContext | null = null;

export async function decodeFile(file: File | Blob, name: string, ctx?: BaseAudioContext): Promise<{ raw: RawSample; info: SampleInfo }> {
  const buf = await file.arrayBuffer();
  if (!decodeCtx) decodeCtx = ctx ?? new OfflineAudioContext(2, 1, 44100);
  const audio = await (ctx ?? decodeCtx).decodeAudioData(buf.slice(0));
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(new Float32Array(audio.getChannelData(c)));
  const id = uid('s');
  const r: RawSample = { id, name, channels, sampleRate: audio.sampleRate };
  raw.set(id, r);
  await storeUserSample(id, buf);
  emit();
  const info: SampleInfo = {
    id, name, frames: channels[0].length, sampleRate: audio.sampleRate,
    channels: channels.length, source: { kind: 'user', key: id },
  };
  return { raw: r, info };
}

// ------------------------------------------------------------ precomputing
// The Sampler's precomputed processes are destructive re-renders of the
// sample data (like FL), applied in this order: trim -> DC -> normalize ->
// polarity -> reverse -> swap -> fade stereo -> boost/clip -> tilt EQ ->
// ring mod -> low pass -> stereo delay -> reverb -> in/out fades -> loop
// crossfade, then (optionally) resampled to the engine rate.

const PRE_FIELDS: (keyof SamplerSettings)[] = [
  'removeDC', 'reversePolarity', 'normalize', 'fadeStereo', 'reverse', 'swapStereo', 'smpStart', 'length',
  'fadeIn', 'fadeOut', 'crossfade', 'trim', 'boost', 'clip', 'eq', 'rmMix', 'rmFreq', 'cut', 'res',
  'reverbMix', 'reverbType', 'stereoDelay', 'pogo', 'resample', 'useLoopPoints', 'loopStart', 'loopEnd',
];

export function precomputeKey(sampleId: Id, s: SamplerSettings, targetRate = 0): string {
  return sampleId + '|' + PRE_FIELDS.map((k) => String(s[k])).join('|') + '|' + (s.resample ? targetRate : 0);
}

export interface PreparedSample { key: string; data: Float32Array[]; sampleRate: number }

/** Processed buffers for a channel's settings (cached). */
export function prepareSample(sampleId: Id, s: SamplerSettings, targetRate: number): PreparedSample | null {
  const key = precomputeKey(sampleId, s, targetRate);
  const r = raw.get(sampleId);
  if (!r) return null;
  let data = processed.get(key);
  let rate = r.sampleRate;
  if (!data) {
    data = applyPrecomputed(r, s);
    if (s.resample && targetRate > 0 && targetRate !== r.sampleRate) {
      data = data.map((c) => resampleBuffer(c, r.sampleRate, targetRate, 64));
    }
    processed.set(key, data);
  }
  if (s.resample && targetRate > 0) rate = targetRate;
  return { key, data, sampleRate: rate };
}

/** A buffer another module derived from prepared samples (Audio Clips' stretched samples), cached under its own key. */
export function getCachedBuffer(key: string): Float32Array[] | undefined {
  return processed.get(key);
}

export function putCachedBuffer(key: string, data: Float32Array[]): void {
  processed.set(key, data);
}

/** Back-compat helpers used by older call sites. */
export function getProcessed(key: string, sampleId: Id, s: SamplerSettings): Float32Array[] | null {
  void key;
  return prepareSample(sampleId, { ...s, resample: false }, 0)?.data ?? null;
}

function applyPrecomputed(r: RawSample, s: SamplerSettings): Float32Array[] {
  const sr = r.sampleRate;
  let ch: Float32Array[] = r.channels.map((c) => new Float32Array(c));
  // trim start / length
  const total = ch[0].length;
  const a = Math.floor(Math.min(0.999, Math.max(0, s.smpStart)) * total);
  const b = Math.max(a + 1, Math.floor(Math.min(1, Math.max(0, s.length)) * total));
  if (a > 0 || b < total) ch = ch.map((c) => c.slice(a, b));
  // trailing silence trim (always removes exact digital silence)
  {
    const thr = s.trim > 0 ? Math.pow(10, (-90 + s.trim * 60) / 20) : 0;
    let last = 0;
    for (const c of ch) for (let i = c.length - 1; i >= 0; i--) if (Math.abs(c[i]) > thr) { last = Math.max(last, i); break; }
    if (last + 1 < ch[0].length) ch = ch.map((c) => c.slice(0, Math.max(1, last + 1)));
  }
  if (s.removeDC) for (const c of ch) { let m = 0; for (let i = 0; i < c.length; i++) m += c[i]; m /= c.length || 1; for (let i = 0; i < c.length; i++) c[i] -= m; }
  if (s.normalize) {
    let m = 0;
    for (const c of ch) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
    if (m > 0) for (const c of ch) for (let i = 0; i < c.length; i++) c[i] /= m;
  }
  if (s.reversePolarity) for (const c of ch) for (let i = 0; i < c.length; i++) c[i] = -c[i];
  if (s.reverse) for (const c of ch) c.reverse();
  if (s.swapStereo && ch.length > 1) ch = [ch[1], ch[0]];
  if (s.fadeStereo) {
    if (ch.length === 1) ch = [ch[0], new Float32Array(ch[0])];
    const n = ch[0].length;
    for (let i = 0; i < n; i++) { const t = i / n; ch[0][i] *= Math.cos(t * Math.PI / 2); ch[1][i] *= Math.sin(t * Math.PI / 2); }
  }
  const len = ch[0].length;
  if (s.boost > 0) { const g = Math.pow(10, (s.boost * 24) / 20); for (const c of ch) for (let i = 0; i < len; i++) c[i] *= g; }
  if (s.clip) for (const c of ch) for (let i = 0; i < len; i++) c[i] = c[i] > 1 ? 1 : c[i] < -1 ? -1 : c[i];
  if (Math.abs(s.eq - 0.5) > 0.004) {
    // tilt EQ around 1 kHz: +-12 dB shelves in opposite directions
    const g = (s.eq - 0.5) * 24;
    const lo = new SvfCoefs(), hi = new SvfCoefs();
    lo.set(SvfMode.LowShelf, 1000, 0.5, -g / 2, sr);
    hi.set(SvfMode.HighShelf, 1000, 0.5, g / 2, sr);
    for (const c of ch) { const a1 = new SvfState(), a2 = new SvfState(); a1.process(lo, c, 0, len); a2.process(hi, c, 0, len); }
  }
  if (s.rmMix > 0) {
    const f = 20 * Math.pow(1000, s.rmFreq);
    for (const c of ch) for (let i = 0; i < len; i++) { const m = Math.sin((2 * Math.PI * f * i) / sr); c[i] = c[i] * (1 - s.rmMix) + c[i] * m * s.rmMix; }
  }
  if (s.cut < 0.999 || s.res > 0.001) {
    const lp = new SvfCoefs();
    lp.set(SvfMode.LowPass, 20 * Math.pow(1000, s.cut), 0.707 * Math.pow(30, s.res), 0, sr);
    for (const c of ch) new SvfState().process(lp, c, 0, len);
  }
  if (Math.abs(s.stereoDelay) > 0.002) {
    if (ch.length === 1) ch = [ch[0], new Float32Array(ch[0])];
    const d = Math.round(Math.abs(s.stereoDelay) * 0.02 * sr);
    const target = s.stereoDelay > 0 ? 1 : 0; // right: left channel earlier = delay the right
    const src = ch[target];
    const out = new Float32Array(src.length);
    for (let i = d; i < src.length; i++) out[i] = src[i - d];
    ch[target] = out;
  }
  if (s.reverbMix > 0) ch = simpleReverb(ch, sr, s.reverbMix, s.reverbType === 'B' ? 1 : 0.55);
  const n2 = ch[0].length;
  if (s.fadeIn > 0) { const n = Math.max(1, Math.floor(n2 * 0.5 * s.fadeIn)); for (const c of ch) for (let i = 0; i < n && i < n2; i++) c[i] *= i / n; }
  if (s.fadeOut > 0) { const n = Math.max(1, Math.floor(n2 * 0.5 * s.fadeOut)); for (const c of ch) for (let i = 0; i < n && i < n2; i++) c[n2 - 1 - i] *= i / n; }
  if (s.crossfade > 0 && s.useLoopPoints) {
    const ls = Math.floor(Math.min(s.loopStart, s.loopEnd) * n2), le = Math.floor(Math.max(s.loopStart, s.loopEnd) * n2);
    const x = Math.min(ls, Math.floor((le - ls) * s.crossfade * 0.5));
    for (const c of ch) for (let i = 0; i < x; i++) {
      const t = i / x;
      c[le - x + i] = c[le - x + i] * (1 - t) + c[ls - x + i] * t;
    }
  }
  return ch;
}

/** Small Schroeder/Freeverb-style reverb for the precomputed REVERB process. */
function simpleReverb(ch: Float32Array[], sr: number, mix: number, size: number): Float32Array[] {
  // eslint-disable-next-line
  const tail = Math.floor(sr * (1.2 + 1.8 * size));
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round((d * sr) / 44100 * (0.7 + 0.3 * size)));
  const aps = [556, 441, 341, 225].map((d) => Math.round((d * sr) / 44100));
  const fb = 0.78 + 0.06 * size, damp = 0.25;
  return ch.map((c, ci) => {
    const n = c.length + tail;
    const out = new Float32Array(n);
    const wet = new Float32Array(n);
    for (const d0 of combs) {
      const d = d0 + ci * 23;
      const buf = new Float32Array(d);
      let idx = 0, lp = 0;
      for (let i = 0; i < n; i++) {
        const y = buf[idx];
        lp = y * (1 - damp) + lp * damp;
        buf[idx] = (i < c.length ? c[i] : 0) + lp * fb;
        wet[i] += y;
        idx = idx + 1 === d ? 0 : idx + 1;
      }
    }
    for (const d of aps) {
      const buf = new Float32Array(d);
      let idx = 0;
      for (let i = 0; i < n; i++) {
        const bo = buf[idx];
        const x = wet[i];
        buf[idx] = x + bo * 0.5;
        wet[i] = bo - x;
        idx = idx + 1 === d ? 0 : idx + 1;
      }
    }
    for (let i = 0; i < n; i++) out[i] = (i < c.length ? c[i] : 0) * (1 - mix * 0.5) + wet[i] * 0.03 * mix;
    return out;
  });
}

/** Drop one processed buffer from the cache (and the prepared sample an Audio Clip's stretched buffer was made from). */
export function forgetProcessedKey(key: string): void {
  processed.delete(key);
  const st = key.indexOf('|st:');
  if (st > 0) processed.delete(key.slice(0, st));
}

/** Is this processed buffer already cached (no work needed)? */
export function isPrepared(sampleId: Id, s: SamplerSettings, targetRate: number): boolean {
  return processed.has(precomputeKey(sampleId, s, targetRate));
}

export function forgetProcessed(prefix: string): void {
  for (const k of processed.keys()) if (k.startsWith(prefix + '|')) processed.delete(k);
}

// ---------------------------------------------------------------- storage
const DB_NAME = 'orchard-samples';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function storeUserSample(id: Id, data: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(data, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage unavailable: sample lives for this session only */
  }
}

export async function loadUserSample(info: SampleInfo, ctx?: BaseAudioContext): Promise<boolean> {
  if (raw.has(info.id)) return true;
  try {
    const db = await openDb();
    const data = await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const req = tx.objectStore('files').get(info.id);
      req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!data) return false;
    if (!decodeCtx) decodeCtx = ctx ?? new OfflineAudioContext(2, 1, 44100);
    const audio = await (ctx ?? decodeCtx).decodeAudioData(data.slice(0));
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(new Float32Array(audio.getChannelData(c)));
    raw.set(info.id, { id: info.id, name: info.name, channels, sampleRate: audio.sampleRate });
    emit();
    return true;
  } catch {
    return false;
  }
}
