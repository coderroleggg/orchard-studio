// BooBass "Load FL Studio data...": the user picks BooBass_Eng_x64.dylib from
// their own FL Studio (macOS) install; its 12 recordings are extracted
// (./macho.ts, validated as untrusted input), packed into one pool sample
// (engine/gen/plugins/boobass/tables.ts packFlData) and referenced from the
// plugin state (`dataSample`), so the live engine and WAV export receive it
// like Convolver's impulses. Nothing of FL ships with Orchard.
//
// The pack is stored as an exact 16-bit WAV in the user sample storage. The
// generic loader decodes stored samples through an AudioContext, which may
// resample them; the watcher below re-reads the stored bytes itself whenever
// a referenced pack is missing or damaged in the pool.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { addRaw, getRaw, onSamplesChanged, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { Project, SampleInfo } from '../../../../model/types';
import { allGens } from '../../../../model/gen/ids';
import { packFlData, unpackFlData } from '../../../../engine/gen/plugins/boobass/tables';
import { flashHint } from '../../../hint';
import { FlDataError, readBooBassData } from './macho';

export const FL_DATA_NAME = 'BooBass FL data';
const RATE = 44100;
/** Largest file accepted (FL's engine library is about 0.8 MB). */
const MAX_FILE = 64 << 20;

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

/** The pack back from packWav's bytes (null when they are not such a WAV). */
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
      return unpackFlData(out) ? out : null;
    }
    p += 8 + len + (len & 1);
  }
  return null;
}

/** Pool buffers already checked to hold a valid pack. */
const valid = new WeakSet<Float32Array>();
function isPack(d: Float32Array | undefined): boolean {
  if (!d) return false;
  if (valid.has(d)) return true;
  if (!unpackFlData(d)) return false;
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

/** The pool sample holding FL data already in the project (to reuse without picking the file again). */
export function projectFlData(p: Project = store.project): SampleInfo | null {
  for (const info of Object.values(p.samples) as SampleInfo[]) {
    if (info.name !== FL_DATA_NAME) continue;
    if (isPack(getRaw(info.id)?.channels[0])) return info;
  }
  return null;
}

function useData(slotId: string, info: SampleInfo, label: string): void {
  A.editFx(slotId, label, (p) => { p.dataSample = info.id; });
}

/** Extract the tables from an FL library file and load them into the plugin (undoable). */
export async function importFlData(slotId: string, file: File): Promise<boolean> {
  try {
    if (file.size > MAX_FILE) throw new FlDataError('This file is too large to be FL\'s BooBass engine library.');
    const { pcm } = readBooBassData(await file.arrayBuffer());
    const pack = packFlData(pcm);
    const id = uid('s');
    addRaw({ id, name: FL_DATA_NAME, channels: [pack], sampleRate: RATE });
    await storeUserSample(id, packWav(pack));
    const info: SampleInfo = { id, name: FL_DATA_NAME, frames: pack.length, sampleRate: RATE, channels: 1, source: { kind: 'user', key: id } };
    store.update('Import BooBass data', (d) => { d.samples[id] = info; });
    useData(slotId, info, 'Load FL Studio data');
    flashHint('BooBass: FL Studio\'s recordings loaded');
    return true;
  } catch (e) {
    const msg = e instanceof FlDataError ? e.message : 'The file could not be read.';
    flashHint(`BooBass: ${msg}`);
    if (typeof window !== 'undefined') window.alert(`BooBass could not load FL Studio data.\n\n${msg}\n\nPick FL Studio.app/Contents/Resources/FL/Plugins/Fruity/Generators/BooBass/BooBass_Eng_x64.dylib.`);
    return false;
  }
}

/** File dialog for importFlData. */
export function pickFlData(slotId: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.dylib';
  input.onchange = () => { const f = input.files?.[0]; if (f) void importFlData(slotId, f); };
  input.click();
}

export function reuseFlData(slotId: string): void {
  const info = projectFlData();
  if (info) useData(slotId, info, 'Use FL Studio data');
}

export function forgetFlData(slotId: string): void {
  A.editFx(slotId, 'Use synthesized sound', (p) => { p.dataSample = ''; });
}

// ------------------------------------------------------------------ keep referenced packs intact
const repairing = new Set<string>();

function scan(p: Project): void {
  for (const g of allGens(p, 'boobass')) {
    const id = g.params.dataSample;
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

const G = globalThis as unknown as { __orchardBooBassSync?: (n: Project) => void };
if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
  if (G.__orchardBooBassSync) store.projectListeners.delete(G.__orchardBooBassSync);
  G.__orchardBooBassSync = (n: Project) => scan(n);
  store.projectListeners.add(G.__orchardBooBassSync);
  onSamplesChanged(() => scan(store.project));
  queueMicrotask(() => scan(store.project));
}
