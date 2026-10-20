// GMS waves: "Import FL Synth Waves..." reads the user's own FL install (the folder FL Studio.app/
// Contents/Resources/FL/Plugins/Fruity/Generators/GMS/Synth Waves, or any of its .wav files),
// and the oscillator menu's "Load Waveform..." any wave file of the user's, as GMS does. Each
// wave is decoded here (PCM 16 / 24 / 32-bit or float WAV, channel 0), packed (engine
// gmsPackWave: exact samples) into a pool sample stored as an exact 32-bit float WAV and
// referenced from the state (`wavePool`: wave file name -> sample), so the live engine and
// WAV export receive it exactly. Without them the engine uses its stand-ins. Nothing of FL
// ships with Orchard. The watcher re-reads a stored pack whenever a decoder resampled it.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { addRaw, getRaw, onSamplesChanged, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { Project, SampleInfo } from '../../../../model/types';
import { allGens } from '../../../../model/gen/ids';
import { gmsPackWave, gmsUnpackWave } from '../../../../engine/gen/plugins/gms/plugin';
import { GMS_SYNTH_WAVES } from '../../../../engine/gen/plugins/gms/waves';
import { gmsMirror, type GmsStateLike } from '../../../../model/gen/plugins/gms/data';
import { flashHint } from '../../../hint';

const PREFIX = 'GMS wave: ';
const RATE = 44100;
const MAX_FILE = 16 << 20;

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
      return gmsUnpackWave(out) ? out : null;
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

/** WAV bytes -> channel 0 as floats (PCM 8 / 16 / 24 / 32-bit, IEEE float 32 / 64); null otherwise. */
export function gmsParseWav(buf: ArrayBuffer): Float32Array | null {
  if (buf.byteLength < 44) return null;
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let p = 12, fmt = 0, ch = 0, bits = 0;
  while (p + 8 <= buf.byteLength) {
    const id = tag(p), len = v.getUint32(p + 4, true);
    if (id === 'fmt ' && len >= 16) {
      fmt = v.getUint16(p + 8, true); ch = v.getUint16(p + 10, true); bits = v.getUint16(p + 22, true);
      if (fmt === 0xfffe && len >= 40) fmt = v.getUint16(p + 32, true);
    } else if (id === 'data' && ch > 0) {
      const bps = bits >> 3, n = Math.floor(Math.min(len, buf.byteLength - p - 8) / (bps * ch));
      if (n < 2 || n > 1 << 20) return null;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = p + 8 + i * bps * ch;
        let x: number;
        if (fmt === 3) x = bits === 64 ? v.getFloat64(o, true) : v.getFloat32(o, true);
        else if (bits === 8) x = (v.getUint8(o) - 128) / 128;
        else if (bits === 16) x = v.getInt16(o, true) / 32768;
        else if (bits === 24) x = ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16))) / 8388608;
        else if (bits === 32) x = v.getInt32(o, true) / 2147483648;
        else return null;
        if (!Number.isFinite(x)) return null;
        out[i] = Math.max(-8, Math.min(8, x));
      }
      return out;
    }
    p += 8 + len + (len & 1);
  }
  return null;
}

/** The pool samples holding GMS waves already in the project, by wave name. */
export function projectWaves(p: Project = store.project): Record<string, string> {
  const out: Record<string, string> = {};
  for (const info of Object.values(p.samples) as SampleInfo[]) {
    if (info.name.startsWith(PREFIX) && gmsUnpackWave(getRaw(info.id)?.channels[0])) out[info.name.slice(PREFIX.length)] = info.id;
  }
  return out;
}

async function addWave(name: string, wave: Float32Array): Promise<string> {
  const pack = gmsPackWave(wave);
  const id = uid('s');
  addRaw({ id, name: PREFIX + name, channels: [pack], sampleRate: RATE });
  await storeUserSample(id, packWav(pack));
  const info: SampleInfo = { id, name: PREFIX + name, frames: pack.length, sampleRate: RATE, channels: 1, source: { kind: 'user', key: id } };
  store.update(`Import GMS wave ${name}`, (d) => { d.samples[id] = info; });
  return id;
}

function setPool(slotId: string, label: string, fn: (p: GmsStateLike) => void): void {
  A.editFx(slotId, label, (d) => {
    const p = d as unknown as GmsStateLike;
    fn(p);
    gmsMirror(p);
  });
}

/** Import FL's Synth Waves (the files the user picks; names must match FL's). */
export async function importFlWaves(slotId: string, files: File[]): Promise<number> {
  const pool: Record<string, string> = {};
  for (const f of files) {
    const name = f.name;
    if (!GMS_SYNTH_WAVES.includes(name) || f.size > MAX_FILE) continue;
    const w = gmsParseWav(await f.arrayBuffer());
    if (w) pool[name] = await addWave(name, w);
  }
  const n = Object.keys(pool).length;
  if (n) {
    setPool(slotId, 'Import FL Synth Waves', (p) => { p.wavePool = { ...(p.wavePool ?? {}), ...pool }; });
    flashHint(`GMS: ${n} of FL Studio's Synth Waves loaded`);
  } else if (typeof window !== 'undefined') {
    window.alert('GMS could not find FL Studio\'s Synth Waves in these files.\n\nPick the folder FL Studio.app/Contents/Resources/FL/Plugins/Fruity/Generators/GMS/Synth Waves (or its .wav files).');
  }
  return n;
}

export function pickFlWaves(slotId: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.wav';
  (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
  input.onchange = () => { const fs = Array.from(input.files ?? []); if (fs.length) void importFlWaves(slotId, fs); };
  input.click();
}

/** GMS's "Load Waveform...": any wave file of the user's into oscillator k. */
export function loadUserWave(slotId: string, k: number): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f || f.size > MAX_FILE) return;
    const w = gmsParseWav(await f.arrayBuffer());
    if (!w) { window.alert('GMS could not read this wave file (WAV, PCM or float).'); return; }
    const id = await addWave(f.name, w);
    setPool(slotId, `Load Waveform ${k + 1}`, (p) => {
      const ws = (p.waves ?? ['', '', '']).slice(); ws[k] = f.name; p.waves = ws;
      p.wavePool = { ...(p.wavePool ?? {}), [f.name]: id };
    });
  };
  input.click();
}

export function forgetWaves(slotId: string): void {
  setPool(slotId, 'Use the stand-in waves', (p) => { p.wavePool = {}; });
}

// ------------------------------------------------------------------ keep referenced packs intact
const repairing = new Set<string>();

function scan(p: Project): void {
  const ids = new Set<string>();
  for (const g of allGens(p, 'gms')) {
    const pool = g.params.wavePool;
    if (pool && typeof pool === 'object') for (const v of Object.values(pool as Record<string, unknown>)) if (typeof v === 'string') ids.add(v);
  }
  for (const id of ids) {
    if (!id || repairing.has(id)) continue;
    const info = p.samples[id] as SampleInfo | undefined;
    if (!info || info.source.kind !== 'user') continue;
    if (gmsUnpackWave(getRaw(id)?.channels[0])) continue;
    repairing.add(id);
    void readStored(id).then((buf) => {
      const pack = buf ? wavPack(buf) : null;
      if (pack) addRaw({ id, name: info.name, channels: [pack], sampleRate: RATE });
    }).finally(() => { repairing.delete(id); });
  }
}

const G = globalThis as unknown as { __orchardGmsSync?: (n: Project) => void };
if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
  if (G.__orchardGmsSync) store.projectListeners.delete(G.__orchardGmsSync);
  G.__orchardGmsSync = (n: Project) => scan(n);
  store.projectListeners.add(G.__orchardGmsSync);
  onSamplesChanged(() => scan(store.project));
  queueMicrotask(() => scan(store.project));
}
