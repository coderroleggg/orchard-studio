// Runtime import of sound content from the user's own FL Studio installation
// (FL's files are never shipped with Orchard Studio): the user picks the files,
// they are parsed defensively here (RIFF / WAVE, PCM 8-32 bit or float), and
// stored in the project's sample pool with their exact data and rate; plugin
// states refer to them by pool id under keys containing "sample", which the
// engine receives automatically. Used by BassDrum (its "sounddata" waveform and
// noise samples) and the other drum instruments of this folder.

import { store } from '../../../../store';
import { addRaw, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { SampleInfo } from '../../../../model/types';

/** Largest file accepted (bytes). */
const MAX_BYTES = 64 << 20;

export interface ParsedWav { channels: Float32Array[]; sampleRate: number }

/** Parse a RIFF / WAVE file (PCM 8 / 16 / 24 / 32 bit, IEEE float 32 / 64); null if it is not one. */
export function parseWav(buf: ArrayBuffer): ParsedWav | null {
  if (buf.byteLength < 44 || buf.byteLength > MAX_BYTES) return null;
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = 0, ch = 0, rate = 0, bits = 0, dataOff = -1, dataLen = 0;
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = tag(o), n = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ' && n >= 16 && body + 16 <= buf.byteLength) {
      fmt = dv.getUint16(body, true); ch = dv.getUint16(body + 2, true);
      rate = dv.getUint32(body + 4, true); bits = dv.getUint16(body + 14, true);
      if (fmt === 0xfffe && n >= 26) fmt = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE sub format
    } else if (id === 'data') {
      dataOff = body; dataLen = Math.min(n, buf.byteLength - body);
      break;
    }
    o = body + n + (n & 1);
  }
  const bytes = bits / 8;
  if (dataOff < 0 || ch < 1 || ch > 8 || rate < 1000 || rate > 768000 || ![8, 16, 24, 32, 64].includes(bits)) return null;
  if (!(fmt === 1 || (fmt === 3 && (bits === 32 || bits === 64)))) return null;
  const frames = Math.floor(dataLen / (bytes * ch));
  if (frames < 1) return null;
  const channels = Array.from({ length: Math.min(2, ch) }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels.length; c++) {
      const o = dataOff + (f * ch + c) * bytes;
      let v: number;
      if (fmt === 3) v = bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
      else if (bits === 8) v = (dv.getUint8(o) - 128) / 128;
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 24) v = ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16))) / 8388608;
      else v = dv.getInt32(o, true) / 2147483648;
      channels[c][f] = Number.isFinite(v) ? v : 0;
    }
  }
  return { channels, sampleRate: rate };
}

/** Let the user pick files (several at once). */
export function pickFiles(accept = ''): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.click();
  });
}

/** A file's name without its extension. */
export function baseName(f: File): string {
  return f.name.replace(/\.[^.]*$/, '');
}

/** Store parsed audio in the project's sample pool (undoable with `label`); returns the pool entry. */
export async function addPoolSample(name: string, wav: ParsedWav, bytes: ArrayBuffer, label: string): Promise<SampleInfo> {
  const id = uid('s');
  addRaw({ id, name, channels: wav.channels, sampleRate: wav.sampleRate });
  await storeUserSample(id, bytes);
  const info: SampleInfo = {
    id, name, frames: wav.channels[0].length, sampleRate: wav.sampleRate,
    channels: wav.channels.length, source: { kind: 'user', key: id },
  };
  store.update(label, (d) => { d.samples[id] = info; });
  return info;
}

/** Import WAV files into the pool; returns [file base name, pool entry] for each file that parsed. */
export async function importWavFiles(files: File[], label: string): Promise<[string, SampleInfo][]> {
  const out: [string, SampleInfo][] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) continue;
    const bytes = await f.arrayBuffer();
    const wav = parseWav(bytes);
    if (!wav) continue;
    out.push([baseName(f), await addPoolSample(baseName(f), wav, bytes, label)]);
  }
  return out;
}

/** A pool sample by name (FL's factory sample names), the newest first. */
export function poolSampleNamed(name: string): SampleInfo | undefined {
  const all = Object.values(store.project.samples).filter((s) => s.name.toLowerCase() === name.toLowerCase());
  return all[all.length - 1];
}
