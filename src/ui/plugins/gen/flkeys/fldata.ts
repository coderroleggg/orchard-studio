// FL Keys "Import FL content...": the user picks their own FL Studio's FL Keys wavetable folder (Plugins/Fruity/
// Generators/FL Keys/Wavtables, or any folder above it); each wavetable's descriptor (.wti) and sample files
// (raw 16-bit .dat, PCM wavs, FL's Ogg Vorbis wavs through the browser's decoder) are read as untrusted input,
// turned into a table by the rules of FL's loader (engine/gen/plugins/flkeys/table.ts), packed into one
// pool sample per wavetable and referenced from the plugin state (`samplePiano`, `sampleGrand`, ...).
// Nothing of FL ships with Orchard.
//
// A pack is stored as an exact 16-bit WAV in the user sample storage (the generic loader decodes stored
// samples through an AudioContext, which may resample them); the watcher below re-reads the stored bytes
// whenever a referenced pack is missing or damaged in the pool (as BooBass's).

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { addRaw, getRaw, onSamplesChanged, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { Project, SampleInfo } from '../../../../model/types';
import { allGens } from '../../../../model/gen/ids';
import { KEYS_CATALOG, type KeysCatalogEntry } from '../../../../engine/gen/plugins/flkeys/catalog';
import { Ini, KeysTableError, buildKeysTable, packKeysTable, unpackKeysTable, type KeysFiles, type KeysWave } from '../../../../engine/gen/plugins/flkeys/table';
import { flashHint } from '../../../hint';
import { vorbisWavStream } from '../fpc/flcontent';

const RATE = 44100;
const MAX_FILE = 96 << 20;
const MAX_FRAMES = 40_000_000;
const MAX_WTI = 1 << 20;

export function packName(e: KeysCatalogEntry): string {
  return `FL Keys: ${e.name}`;
}

/** Exact 16-bit mono WAV of a pack (its values are on the 16-bit grid). */
function packWav(pack: Float32Array): ArrayBuffer {
  const n = pack.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + 2 * i, Math.max(-32768, Math.min(32767, Math.round(pack[i] * 32768))), true);
  return buf;
}

/** The pack back from packWav's bytes (null when they are not such a WAV or the pack is invalid). */
function wavPack(buf: ArrayBuffer): Float32Array | null {
  if (buf.byteLength < 44) return null;
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let p = 12;
  let fmtOk = false;
  while (p + 8 <= buf.byteLength) {
    const id = tag(p), len = v.getUint32(p + 4, true);
    if (id === 'fmt ') fmtOk = len >= 16 && v.getUint16(p + 8, true) === 1 && v.getUint16(p + 10, true) === 1 && v.getUint16(p + 22, true) === 16;
    else if (id === 'data' && fmtOk) {
      const n = Math.floor(Math.min(len, buf.byteLength - p - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(p + 8 + 2 * i, true) / 32768;
      return unpackKeysTable(out) ? out : null;
    }
    p += 8 + len + (len & 1);
  }
  return null;
}

// ------------------------------------------------------------------ reading FL's files
interface WavInfo { fmt: number; ch: number; rate: number; bits: number; dataOff: number; dataLen: number; fact: number; loopStart: number; loopEnd: number }

function wavInfo(buf: ArrayBuffer): WavInfo | null {
  if (buf.byteLength < 44 || buf.byteLength > MAX_FILE) return null;
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  const w: WavInfo = { fmt: 0, ch: 0, rate: 0, bits: 0, dataOff: -1, dataLen: 0, fact: -1, loopStart: 0, loopEnd: -1 };
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = tag(o), n = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ' && n >= 16 && body + 16 <= buf.byteLength) {
      w.fmt = dv.getUint16(body, true); w.ch = dv.getUint16(body + 2, true); w.rate = dv.getUint32(body + 4, true); w.bits = dv.getUint16(body + 14, true);
      if (w.fmt === 0xfffe && n >= 26 && body + 26 <= buf.byteLength) w.fmt = dv.getUint16(body + 24, true);
    } else if (id === 'data') { w.dataOff = body; w.dataLen = Math.min(n, buf.byteLength - body); }
    else if (id === 'fact' && n >= 4 && body + 4 <= buf.byteLength) w.fact = dv.getUint32(body, true);
    else if (id === 'smpl' && n >= 60 && body + 60 <= buf.byteLength && dv.getUint32(body + 28, true) > 0) {
      w.loopStart = dv.getUint32(body + 44, true);
      w.loopEnd = dv.getUint32(body + 48, true);
    }
    o = body + n + (n & 1);
  }
  return w.dataOff >= 0 && w.ch >= 1 && w.ch <= 8 ? w : null;
}

const q16 = (x: number) => Math.max(-32768, Math.min(32767, Math.round((Number.isFinite(x) ? x : 0) * 32767)));

/** A wavetable sample file as 16-bit PCM (PCM exactly; FL's Ogg Vorbis wavs through the browser's decoder, x 32767 like FL's decoder). */
async function readWave(buf: ArrayBuffer): Promise<KeysWave | null> {
  const w = wavInfo(buf);
  if (!w) return null;
  const dv = new DataView(buf);
  const ch = Math.min(2, w.ch) as 1 | 2;
  const loop = (frames: number) => ({ loopStart: w.loopEnd >= 0 ? w.loopStart : 0, loopEnd: w.loopEnd >= 0 ? w.loopEnd : frames - 1 });
  if (w.fmt === 1 || w.fmt === 3) {
    const bytes = w.bits / 8;
    if (![8, 16, 24, 32, 64].includes(w.bits) || (w.fmt === 3 && w.bits !== 32 && w.bits !== 64)) return null;
    const frames = Math.floor(w.dataLen / (bytes * w.ch));
    if (frames < 1 || frames > MAX_FRAMES) return null;
    const data = new Int16Array(frames * ch);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < ch; c++) {
        const o = w.dataOff + (f * w.ch + c) * bytes;
        let x: number;
        if (w.fmt === 3) x = w.bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
        else if (w.bits === 16) { data[f * ch + c] = dv.getInt16(o, true); continue; }
        else if (w.bits === 8) x = (dv.getUint8(o) - 128) / 128;
        else if (w.bits === 24) x = (dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608;
        else x = dv.getInt32(o, true) / 2147483648;
        data[f * ch + c] = q16(x);
      }
    }
    return { channels: ch, rate: w.rate, data, ...loop(frames) };
  }
  const ogg = vorbisWavStream(buf);
  if (!ogg) return null;
  try {
    const ctx = new OfflineAudioContext(ch, 1, w.rate || 44100);
    const audio = await ctx.decodeAudioData(ogg.slice().buffer);
    const got = Math.min(2, audio.numberOfChannels);
    // FL's decoder gives every frame its file declares (the `fact` chunk); a short decode is padded with silence
    const frames = Math.min(MAX_FRAMES, w.fact > 0 ? w.fact : audio.length);
    const data = new Int16Array(frames * ch);
    for (let c = 0; c < ch; c++) {
      const src = audio.getChannelData(Math.min(c, got - 1));
      const n = Math.min(frames, src.length);
      for (let i = 0; i < n; i++) data[i * ch + c] = q16(src[i]);
    }
    return { channels: ch, rate: audio.sampleRate, data, ...loop(frames) };
  } catch {
    return null;
  }
}

function relPath(f: File): string {
  return ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, '/');
}

/** Let the user pick a folder (FL's installation, the FL Keys plugin folder or its Wavtables folder). */
function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.multiple = true;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.click();
  });
}

class ImportError extends Error {}

/** Build the pack of one wavetable from the picked files. */
async function importTable(files: File[], e: KeysCatalogEntry): Promise<Float32Array> {
  const byPath = new Map<string, File>();
  for (const f of files) byPath.set(relPath(f).toLowerCase(), f);
  const want = '/' + e.file.toLowerCase();
  const wtiKey = [...byPath.keys()].find((k) => k === e.file.toLowerCase() || k.endsWith(want));
  if (!wtiKey) throw new ImportError(`${e.file} was not found in the picked folder`);
  const wti = byPath.get(wtiKey)!;
  if (wti.size > MAX_WTI) throw new ImportError(`${e.file} is too large`);
  const ini = new Ini(await wti.text());
  const dir = wtiKey.slice(0, wtiKey.length - e.file.length);
  const find = (...parts: string[]): File | undefined => {
    const p = (dir + parts.filter(Boolean).join('/')).replace(/\/+/g, '/').toLowerCase();
    return byPath.get(p);
  };
  const raws = new Map<string, Int16Array>();
  const waves = new Map<string, KeysWave>();
  const sampleFile = ini.str('info', 'samplefile', '');
  const base = ini.str('info', 'path', '').replace(/\\/g, '/');
  const n = Math.min(512, Math.max(0, ini.int('info', 'samples', 0)));
  if (sampleFile) {
    const f = find(sampleFile);
    if (!f || f.size > MAX_FILE) throw new ImportError(`${sampleFile} is missing`);
    const b = await f.arrayBuffer();
    const d = new Int16Array(b.byteLength >> 1);
    const dv = new DataView(b);
    for (let i = 0; i < d.length; i++) d[i] = dv.getInt16(2 * i, true);
    raws.set(sampleFile.toLowerCase(), d);
  } else {
    let frames = 0;
    for (let i = 0; i < n; i++) {
      const name = ini.str('sample' + i, 'name', '');
      if (!name || waves.has(name.toLowerCase())) continue;
      const f = find(base, name);
      if (!f || f.size > MAX_FILE) throw new ImportError(`${name} is missing`);
      const w = await readWave(await f.arrayBuffer());
      if (!w) throw new ImportError(`${name} could not be decoded`);
      frames += w.data.length / w.channels;
      if (frames > MAX_FRAMES) throw new ImportError('the wavetable is too large');
      waves.set(name.toLowerCase(), w);
    }
  }
  const src: KeysFiles = {
    raw: (name) => raws.get(name.toLowerCase()) ?? null,
    wave: (name) => waves.get(name.toLowerCase()) ?? null,
  };
  return packKeysTable(buildKeysTable(ini, src, RATE));
}

// ------------------------------------------------------------------ the project's pool
/** Pool buffers already checked to hold a valid pack. */
const valid = new WeakSet<Float32Array>();
function isPack(d: Float32Array | undefined): boolean {
  if (!d) return false;
  if (valid.has(d)) return true;
  if (!unpackKeysTable(d)) return false;
  valid.add(d);
  return true;
}

function readStored(id: string): Promise<ArrayBuffer | undefined> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('orchard-samples', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onerror = () => resolve(undefined);
      req.onsuccess = () => {
        try {
          const g = req.result.transaction('files', 'readonly').objectStore('files').get(id);
          g.onsuccess = () => resolve(g.result as ArrayBuffer | undefined);
          g.onerror = () => resolve(undefined);
        } catch { resolve(undefined); }
      };
    } catch { resolve(undefined); }
  });
}

/** The pool sample holding a wavetable's FL data already in the project (to reuse without picking the folder again). */
export function projectFlTable(e: KeysCatalogEntry, p: Project = store.project): SampleInfo | null {
  for (const info of Object.values(p.samples) as SampleInfo[]) {
    if (info.name !== packName(e)) continue;
    if (isPack(getRaw(info.id)?.channels[0])) return info;
  }
  return null;
}

/** Import the FL Keys wavetables of a picked folder into the plugin (one undo step): the tables found are used. */
export async function importFlKeys(slotId: string, files: File[]): Promise<boolean> {
  if (!files.length) return false;
  const done: [KeysCatalogEntry, SampleInfo][] = [];
  const errors: string[] = [];
  for (const e of KEYS_CATALOG) {
    try {
      flashHint(`FL Keys: reading ${e.name}...`);
      const pack = await importTable(files, e);
      const id = uid('s');
      addRaw({ id, name: packName(e), channels: [pack], sampleRate: RATE });
      await storeUserSample(id, packWav(pack));
      done.push([e, { id, name: packName(e), frames: pack.length, sampleRate: RATE, channels: 1, source: { kind: 'user', key: id } }]);
    } catch (err) {
      errors.push(`${e.name}: ${err instanceof ImportError || err instanceof KeysTableError ? err.message : 'could not be read'}`);
    }
  }
  if (done.length) {
    store.update('Import FL Keys data', (d) => { for (const [, info] of done) d.samples[info.id] = info; });
    A.editFx(slotId, 'Import FL Keys data', (p) => { for (const [e, info] of done) p[e.key] = info.id; });
  }
  flashHint(done.length ? `FL Keys: ${done.map(([e]) => e.name).join(', ')} loaded` : `FL Keys: ${errors[0] ?? 'nothing found'}`);
  if (errors.length && done.length < KEYS_CATALOG.length && typeof window !== 'undefined') {
    window.alert(`FL Keys could not load every wavetable.\n\n${errors.join('\n')}\n\nPick FL Studio.app/Contents/Resources/FL/Plugins/Fruity/Generators/FL Keys/Wavtables.`);
  }
  return done.length > 0;
}

/** Folder dialog for importFlKeys. */
export function pickFlKeys(slotId: string): void {
  void pickFolder().then((files) => importFlKeys(slotId, files));
}

export function reuseFlKeys(slotId: string): void {
  const found = KEYS_CATALOG.map((e) => [e, projectFlTable(e)] as const).filter((x): x is [KeysCatalogEntry, SampleInfo] => !!x[1]);
  if (found.length) A.editFx(slotId, 'Use FL Keys data', (p) => { for (const [e, info] of found) p[e.key] = info.id; });
}

export function forgetFlKeys(slotId: string): void {
  A.editFx(slotId, 'Use synthesized sound', (p) => { for (const e of KEYS_CATALOG) p[e.key] = ''; });
}

// ------------------------------------------------------------------ keep referenced packs intact
const repairing = new Set<string>();

function scan(p: Project): void {
  for (const g of allGens(p, 'flkeys')) {
    for (const e of KEYS_CATALOG) {
      const id = g.params[e.key];
      if (typeof id !== 'string' || !id || repairing.has(id)) continue;
      const info = p.samples[id] as SampleInfo | undefined;
      if (!info || info.source.kind !== 'user') continue;
      if (isPack(getRaw(id)?.channels[0])) continue;
      repairing.add(id);
      void readStored(id).then((buf) => {
        const pack = buf ? wavPack(buf) : null;
        if (pack) addRaw({ id, name: info.name, channels: [pack], sampleRate: RATE });
      }).finally(() => { repairing.delete(id); });
    }
  }
}

const G = globalThis as unknown as { __orchardFlKeysSync?: (n: Project) => void };
if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
  if (G.__orchardFlKeysSync) store.projectListeners.delete(G.__orchardFlKeysSync);
  G.__orchardFlKeysSync = (n: Project) => scan(n);
  store.projectListeners.add(G.__orchardFlKeysSync);
  onSamplesChanged(() => scan(store.project));
  queueMicrotask(() => scan(store.project));
}
