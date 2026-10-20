// Toxic Biohazard "Import FL waveforms...": the user picks Toxic Biohazard_x64.dylib from
// their own FL Studio install; its 27 built-in harmonic tables (waveforms 6..32: amplitudes
// and phases of 128 partials each) are located by a defensive scan (engine findToxicTables),
// packed into one pool sample (engine txPackTables) and referenced from the plugin state
// (`sample`), so the live engine and WAV export receive them exactly. Without them the engine
// uses synthesized substitutes. Nothing of FL ships with Orchard.
//
// The pack is stored as an exact 32-bit float WAV in the user sample storage. The generic
// loader decodes stored samples through an AudioContext, which may resample them; the watcher
// below re-reads the stored bytes itself whenever a referenced pack is missing or damaged.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { addRaw, getRaw, onSamplesChanged, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { Project, SampleInfo } from '../../../../model/types';
import { allGens } from '../../../../model/gen/ids';
import { findToxicTables, txPackTables, txUnpackTables } from '../../../../engine/gen/plugins/toxicbiohazard/wave';
import { flashHint } from '../../../hint';

export const FL_TABLES_NAME = 'Toxic Biohazard FL waveforms';
const RATE = 44100;
const MAX_FILE = 64 << 20;

/** Exact 32-bit float mono WAV of a pack. */
function packWav(pack: Float32Array): ArrayBuffer {
  const n = pack.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 32, true); str(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) v.setFloat32(44 + 4 * i, pack[i], true);
  return buf;
}

/** The pack back from packWav's bytes (null when they are not such a WAV). */
function wavPack(buf: ArrayBuffer): Float32Array | null {
  if (buf.byteLength < 44) return null;
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let p = 12, fmtOk = false;
  while (p + 8 <= buf.byteLength) {
    const id = tag(p), len = v.getUint32(p + 4, true);
    if (id === 'fmt ') fmtOk = len >= 16 && v.getUint16(p + 8, true) === 3 && v.getUint16(p + 10, true) === 1 && v.getUint16(p + 22, true) === 32;
    else if (id === 'data' && fmtOk) {
      const n = Math.floor(Math.min(len, buf.byteLength - p - 8) / 4);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getFloat32(p + 8 + 4 * i, true);
      return txUnpackTables(out) ? out : null;
    }
    p += 8 + len + (len & 1);
  }
  return null;
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

/** The pool sample holding FL's tables already in the project. */
export function projectTables(p: Project = store.project): SampleInfo | null {
  for (const info of Object.values(p.samples) as SampleInfo[]) {
    if (info.name === FL_TABLES_NAME && txUnpackTables(getRaw(info.id)?.channels[0])) return info;
  }
  return null;
}

function useTables(slotId: string, id: string, label: string): void {
  A.editFx(slotId, label, (p) => { p.sample = id; });
}

/** Extract the tables from the user's plugin binary and load them into the plugin (undoable). */
export async function importTables(slotId: string, file: File): Promise<boolean> {
  try {
    if (file.size > MAX_FILE) throw new Error('This file is too large to be Toxic Biohazard\'s plugin library.');
    const t = findToxicTables(await file.arrayBuffer());
    if (!t) throw new Error('No Toxic Biohazard waveform tables were found in this file.');
    const pack = txPackTables(t);
    const id = uid('s');
    addRaw({ id, name: FL_TABLES_NAME, channels: [pack], sampleRate: RATE });
    await storeUserSample(id, packWav(pack));
    const info: SampleInfo = { id, name: FL_TABLES_NAME, frames: pack.length, sampleRate: RATE, channels: 1, source: { kind: 'user', key: id } };
    store.update('Import Toxic Biohazard waveforms', (d) => { d.samples[id] = info; });
    useTables(slotId, id, 'Import FL waveforms');
    flashHint('Toxic Biohazard: FL Studio\'s waveforms loaded');
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'The file could not be read.';
    flashHint(`Toxic Biohazard: ${msg}`);
    if (typeof window !== 'undefined') window.alert(`Toxic Biohazard could not import FL Studio's waveforms.\n\n${msg}\n\nPick FL Studio.app/Contents/Resources/FL/Plugins/Fruity/Generators/Toxic Biohazard/Toxic Biohazard_x64.dylib.`);
    return false;
  }
}

export function pickTables(slotId: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.dylib,.dll';
  input.onchange = () => { const f = input.files?.[0]; if (f) void importTables(slotId, f); };
  input.click();
}

export function reuseTables(slotId: string): void {
  const info = projectTables();
  if (info) useTables(slotId, info.id, 'Use FL waveforms');
}

export function forgetTables(slotId: string): void {
  useTables(slotId, '', 'Use synthesized waveforms');
}

// ------------------------------------------------------------------ keep referenced packs intact
const repairing = new Set<string>();

function scan(p: Project): void {
  for (const g of allGens(p, 'toxicbiohazard')) {
    const id = g.params.sample;
    if (typeof id !== 'string' || !id || repairing.has(id)) continue;
    const info = p.samples[id] as SampleInfo | undefined;
    if (!info || info.source.kind !== 'user') continue;
    if (txUnpackTables(getRaw(id)?.channels[0])) continue;
    repairing.add(id);
    void readStored(id).then((buf) => {
      const pack = buf ? wavPack(buf) : null;
      if (pack) addRaw({ id, name: info.name, channels: [pack], sampleRate: RATE });
    }).finally(() => { repairing.delete(id); });
  }
}

const G = globalThis as unknown as { __orchardToxicSync?: (n: Project) => void };
if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
  if (G.__orchardToxicSync) store.projectListeners.delete(G.__orchardToxicSync);
  G.__orchardToxicSync = (n: Project) => scan(n);
  store.projectListeners.add(G.__orchardToxicSync);
  onSamplesChanged(() => scan(store.project));
  queueMicrotask(() => scan(store.project));
}
