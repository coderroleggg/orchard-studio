// FPC's sample loading: the user's own files (drag & drop from the Browser or the OS, file picker) and the
// optional import of FL's drum library from the user's own FL Studio installation (the layers' file
// references '%FLStudioFactoryData%\Data\Patches\Packs\...'). FL's library WAVs hold Ogg Vorbis streams
// (WAVE format 0x674F / 0x6750; the data chunk is a complete Ogg stream), decoded here by the browser's
// Vorbis decoder; PCM / float WAVs are parsed exactly. Nothing of FL's is shipped: files are read only when
// the user picks them, parsed defensively, and stored in the project's sample pool (float WAV copies).

import { addRaw, storeUserSample } from '../../../../audio/samples';
import { store } from '../../../../store';
import { uid } from '../../../../model/defaults';
import type { SampleInfo } from '../../../../model/types';
import { parseWav, type ParsedWav } from '../bassdrum/flimport';

const MAX_BYTES = 64 << 20;

/** The Ogg stream of an FL Vorbis-in-WAV file (null when the file is not one). */
export function vorbisWavStream(buf: ArrayBuffer): Uint8Array | null {
  if (buf.byteLength < 44 || buf.byteLength > MAX_BYTES) return null;
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = 0, data: Uint8Array | null = null, frames = -1;
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = tag(o), n = dv.getUint32(o + 4, true), body = o + 8;
    if (body + Math.min(n, 4) > buf.byteLength) break;
    if (id === 'fmt ' && n >= 2) fmt = dv.getUint16(body, true);
    else if (id === 'data') data = new Uint8Array(buf, body, Math.min(n, buf.byteLength - body));
    else if (id === 'fact' && n >= 4) frames = dv.getUint32(body, true);
    o = body + n + (n & 1);
  }
  void frames;
  if ((fmt !== 0x674f && fmt !== 0x6750) || !data || data.length < 4) return null;
  if (data[0] !== 0x4f || data[1] !== 0x67 || data[2] !== 0x67 || data[3] !== 0x53) return null; // 'OggS'
  return data;
}

/** The frame count FL's Vorbis WAVs declare (fact chunk), -1 when absent. */
function factFrames(buf: ArrayBuffer): number {
  const dv = new DataView(buf);
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    const n = dv.getUint32(o + 4, true);
    if (id === 'fact' && n >= 4 && o + 12 <= buf.byteLength) return dv.getUint32(o + 8, true);
    o += 8 + n + (n & 1);
  }
  return -1;
}

/** Parse a WAV (PCM / float exactly, FL's Vorbis WAVs through the browser's decoder); null if unsupported. */
export async function decodeSampleFile(buf: ArrayBuffer): Promise<ParsedWav | null> {
  const pcm = parseWav(buf);
  if (pcm) return pcm;
  const ogg = vorbisWavStream(buf);
  if (!ogg) return null;
  try {
    const dv = new DataView(buf);
    let rate = 44100, ch = 1;
    for (let o = 12; o + 8 <= buf.byteLength;) {
      const n = dv.getUint32(o + 4, true);
      if (dv.getUint32(o, false) === 0x666d7420 && n >= 8) { ch = Math.max(1, Math.min(2, dv.getUint16(o + 10, true))); rate = dv.getUint32(o + 12, true) || 44100; break; }
      o += 8 + n + (n & 1);
    }
    const ctx = new OfflineAudioContext(ch, 1, rate);
    const audio = await ctx.decodeAudioData(ogg.slice().buffer);
    const fr = factFrames(buf);
    const len = fr > 0 ? Math.min(fr, audio.length) : audio.length;
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(audio.getChannelData(c).slice(0, len));
    return channels.length && len > 0 ? { channels, sampleRate: audio.sampleRate } : null;
  } catch {
    return null;
  }
}

/** A float WAV of decoded audio (the pool keeps it so the sample reloads exactly). */
export function floatWav(w: ParsedWav): ArrayBuffer {
  const ch = w.channels.length, n = w.channels[0].length;
  const out = new ArrayBuffer(44 + n * ch * 4);
  const dv = new DataView(out);
  const s = (o: number, t: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 4, true); s(8, 'WAVE'); s(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, ch, true); dv.setUint32(24, w.sampleRate, true);
  dv.setUint32(28, w.sampleRate * ch * 4, true); dv.setUint16(32, ch * 4, true); dv.setUint16(34, 32, true);
  s(36, 'data'); dv.setUint32(40, n * ch * 4, true);
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 4) dv.setFloat32(o, w.channels[c][i], true);
  return out;
}

/** Put decoded audio into the project's sample pool; the entry is added to the project with `label` (null: by the caller). */
export async function poolSample(name: string, w: ParsedWav, label: string | null, original?: ArrayBuffer): Promise<SampleInfo> {
  const id = uid('s');
  addRaw({ id, name, channels: w.channels, sampleRate: w.sampleRate });
  await storeUserSample(id, original && parseWav(original) ? original : floatWav(w));
  const info: SampleInfo = { id, name, frames: w.channels[0].length, sampleRate: w.sampleRate, channels: w.channels.length, source: { kind: 'user', key: id } };
  if (label) store.update(label, (d) => { d.samples[id] = info; });
  return info;
}

/** Load audio files picked or dropped by the user: [file name, pool entry] for each one that decodes. */
export async function importFiles(files: File[], label: string): Promise<[string, SampleInfo][]> {
  const out: [string, SampleInfo][] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) continue;
    const buf = await f.arrayBuffer();
    const w = await decodeSampleFile(buf);
    if (!w) continue;
    out.push([f.name, await poolSample(f.name.replace(/\.[^.]*$/, ''), w, label, buf)]);
  }
  return out;
}

// --------------------------------------------------------- FL's library

/** Session cache: FL reference (lower case) -> pool id. */
const refCache = new Map<string, string>();

/** A layer reference's path below FL's factory data folder, lower case with '/' separators. */
export function refPath(ref: string): string {
  return ref.replace(/^%FLStudioFactoryData%[\\/]?/i, '').replace(/^%FLPath%[\\/]?/i, '').replace(/\\/g, '/').toLowerCase();
}

/** The pool id already resolved for a reference this session, if its sample is still in the pool. */
export function resolvedRef(ref: string): string {
  const id = refCache.get(refPath(ref));
  return id && store.project.samples[id] ? id : '';
}

/** Let the user pick a folder (FL's installation, its Data folder or Data/Patches/Packs). */
export function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.multiple = true;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.click();
  });
}

/**
 * Import the files the references point to from a picked folder: matched case-insensitively by the
 * longest suffix of the reference path that a picked file ends with. Returns reference -> pool id.
 */
export async function importRefs(files: File[], refs: string[], onProgress?: (done: number, total: number) => void): Promise<Map<string, string>> {
  const byPath = new Map<string, File>();
  for (const f of files) {
    const rel = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, '/').toLowerCase();
    if (rel.endsWith('.wav')) byPath.set(rel, f);
  }
  const keys = [...byPath.keys()];
  const out = new Map<string, string>();
  const want = [...new Set(refs.filter(Boolean).map(refPath))];
  const added: SampleInfo[] = [];
  let done = 0;
  for (const p of want) {
    done++;
    const have = refCache.get(p);
    if (have && store.project.samples[have]) { out.set(p, have); continue; }
    // the longest suffix of the reference path that ends a picked file's path
    const parts = p.split('/');
    let file: File | undefined;
    for (let i = 0; i < parts.length && !file; i++) {
      const suf = parts.slice(i).join('/');
      const k = keys.find((x) => x === suf || x.endsWith('/' + suf));
      if (k) file = byPath.get(k);
    }
    if (!file || file.size > MAX_BYTES) continue;
    const buf = await file.arrayBuffer();
    const w = await decodeSampleFile(buf);
    if (!w) continue;
    const info = await poolSample(file.name.replace(/\.[^.]*$/, ''), w, null);
    added.push(info);
    refCache.set(p, info.id);
    out.set(p, info.id);
    onProgress?.(done, want.length);
  }
  if (added.length) store.update('Import FL content', (d) => { for (const info of added) d.samples[info.id] = info; });
  return out;
}
