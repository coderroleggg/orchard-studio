// Wave Traveller editor operations: state edits (one undo step each), sample loading (drop, file picker,
// Browser), spline presets, FL content import. The state is the plugin's JSON state (model/.../state.ts).

import { useEffect, useMemo, useState } from 'react';
import type { Draft } from 'immer';
import { host, store } from '../../../../store';
import * as A from '../../../../store/actions';
import { decodeFile, getRaw, onSamplesChanged } from '../../../../audio/samples';
import { useFxEditor } from '../../kit';
import { channelOfSlot } from '../../../../model/gen/ids';
import { flashHint } from '../../../hint';
import { addPoolSample, baseName, parseWav, poolSampleNamed } from '../bassdrum/flimport';
import {
  clonePatch, defaultPatch, normalizePatch, patchOf, wtState, type WtPatch, type WtState,
} from '../../../../model/gen/plugins/wavetraveller/state';
import { readSpln, writeSpln } from '../../../../model/gen/plugins/wavetraveller/spln';

/** FL's note names for patch labels (the plugin's NoteName table, sharps). */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** FL's patch label (CWWarper 0x6a420): the patch name or "Patch <note><octave>" (key 60 = "Patch C5"). */
export function patchLabel(key: number, name: string): string {
  return name !== '' ? name : `Patch ${NOTE_NAMES[key % 12]}${Math.floor(key / 12)}`;
}

/** The note name of a key (keyboard labels). */
export const keyNote = (key: number): string => `${NOTE_NAMES[key % 12]}${Math.floor(key / 12)}`;

type Edit = (label: string, fn: (d: Record<string, unknown>) => void, merge?: string) => void;

export interface WtEditor {
  s: WtState;
  slotId: string;
  /** The channel the plugin belongs to (preview notes). */
  chId: string | null;
  /** The selected key's patch. */
  patch: WtPatch;
  edit: Edit;
  /** Edit the selected key's patch (created from the default patch when it has no entry yet). */
  editPatch: (label: string, fn: (p: WtPatch) => void, merge?: string) => void;
}

/** True when two patches are the same (JSON). */
const samePatch = (a: WtPatch, b: WtPatch): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Apply `fn` to the patch of `key` inside a state draft; a patch equal to the default patch is dropped (the map is sparse). */
export function editPatchIn(d: Record<string, unknown>, key: number, fn: (p: WtPatch) => void): void {
  const patches = ((d.patches as Record<string, WtPatch> | undefined) ?? (d.patches = {})) as Record<string, WtPatch>;
  const k = String(key);
  const cur: WtPatch = patches[k] ? clonePatch(patches[k]) : defaultPatch();
  fn(cur);
  const next = normalizePatch(cur);
  if (samePatch(next, defaultPatch())) delete patches[k];
  else patches[k] = next;
}

export function useWt(): WtEditor {
  const { params, slotId } = useFxEditor();
  const s = useMemo(() => wtState(params), [params]);
  const chId = channelOfSlot(slotId);
  const edit: Edit = (label, fn, merge) => A.editFx(slotId, label, (d) => fn(d as Record<string, unknown>), merge);
  const editPatch = (label: string, fn: (p: WtPatch) => void, merge?: string) =>
    edit(label, (d) => editPatchIn(d, s.key, fn), merge);
  return { s, slotId, chId, patch: patchOf(s, s.key), edit, editPatch };
}

/** The audio of the state's pool sample, if available (re-render when pool samples change). */
export function useWtAudio(s: WtState): { channels: Float32Array[]; sampleRate: number } | null {
  const [v, setV] = useState(0);
  useEffect(() => onSamplesChanged(() => setV((x) => x + 1)), []);
  return useMemo(() => {
    if (!s.sample) return null;
    const r = getRaw(s.sample);
    return r && r.channels.length ? { channels: r.channels, sampleRate: r.sampleRate } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.sample, v]);
}

// ------------------------------------------------------------------------------------------------ samples

/** Use a pool sample (state `sample` + the file name FL shows). */
export function setSample(slotId: string, id: string, name: string, label = 'Load sample'): void {
  A.editFx(slotId, label, (d) => { (d as Record<string, unknown>).sample = id; (d as Record<string, unknown>).file = name; });
}

/**
 * FL's pack samples (Data/Patches/Packs) are Ogg Vorbis streams inside a RIFF / WAVE container (format tag 0x674F ...):
 * the 'data' chunk is a plain Ogg stream the browser's decoder reads. null for anything else.
 */
export function oggInWav(buf: ArrayBuffer): Blob | null {
  if (buf.byteLength < 44 || buf.byteLength > (64 << 20)) return null;
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = 0;
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = tag(o);
    const n = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ' && n >= 2) fmt = dv.getUint16(body, true);
    else if (id === 'data') {
      const len = Math.min(n, buf.byteLength - body);
      if (![0x674f, 0x6750, 0x6751, 0x676f, 0x6770, 0x6771].includes(fmt) || len < 4 || tag(body) !== 'OggS') return null;
      return new Blob([buf.slice(body, body + len)], { type: 'audio/ogg' });
    }
    o = body + n + (n & 1);
  }
  return null;
}

/** Put an audio file into the project's pool (PCM WAV parsed here, FL's Ogg-in-WAV and other formats through the browser's decoder). */
async function poolFile(f: File, label: string): Promise<{ id: string; name: string } | null> {
  const bytes = await f.arrayBuffer();
  const wav = parseWav(bytes);
  if (wav) return addPoolSample(baseName(f), wav, bytes, label);
  const ogg = oggInWav(bytes);
  const r = await decodeFile(ogg ?? f, baseName(f), host.ctx ?? undefined);
  store.update(label, (d) => { d.samples[r.info.id] = r.info; });
  return r.info;
}

/** Load an audio file (WAV directly, other formats through the browser's decoder) into the pool and the plugin. */
export async function loadFile(slotId: string, f: File): Promise<void> {
  try {
    store.beginGesture('Load sample');
    try {
      const info = await poolFile(f, 'Load sample');
      if (info) setSample(slotId, info.id, f.name);
    } finally {
      store.endGesture();
    }
  } catch {
    flashHint('Wave Traveller: error loading sample...');
  }
}

/** Use a sample that is already in the project's pool (Browser drag). */
export function loadPool(slotId: string, id: string): void {
  const info = store.project.samples[id];
  if (!info) return;
  setSample(slotId, id, info.name);
}

/**
 * The state names a pool sample by its file name (FL factory presets name FL pack samples): use the one
 * imported by "Import FL content..." when there is one.
 */
export function useNamedSample(slotId: string, s: WtState): void {
  useEffect(() => {
    if (s.sample || !s.file) return;
    const found = poolSampleNamed(s.file.replace(/\.[^.]*$/, '')) ?? poolSampleNamed(s.file);
    if (found && getRaw(found.id)) A.setFxStateNoHistory(slotId, 'Use imported sample', (d) => { (d as Record<string, unknown>).sample = found.id; });
  });
}

/** Folder / file picker for "Import FL content...". */
function pick(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !folder;
    if (folder) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    else input.accept = 'audio/*,.wav';
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.click();
  });
}

/**
 * "Import FL content...": the user picks their FL install's pack samples (a folder, e.g. Data/Patches/Packs, or
 * files); the WAV files go into the pool under their names and the state's named sample is used.
 */
export async function importFlContent(slotId: string, folder: boolean): Promise<void> {
  const files = (await pick(folder)).filter((f) => /\.wav$/i.test(f.name)).slice(0, 4000);
  if (!files.length) return;
  flashHint('Wave Traveller: importing FL content...');
  // only the samples FL's factory presets use matter: keep every picked WAV that a preset names, else the first few
  const names = new Set(['hip_kick_3', 'voc_go', 'voc_icantfeelnobetter', 'voc_scratchinsurf', 'hip_snare_8']);
  const wanted = files.filter((f) => names.has(baseName(f).toLowerCase()));
  const use = wanted.length ? wanted : files.slice(0, 8);
  try {
    const done: [string, { id: string; name: string }][] = [];
    store.beginGesture('Import FL content');
    try {
      for (const f of use) {
        if (f.size > (64 << 20)) continue;
        try {
          const info = await poolFile(f, 'Import FL content');
          if (info) done.push([baseName(f), info]);
        } catch { /* not decodable here: skip the file */ }
      }
      const cur = wtState(A.findFx(store.project, slotId)?.fx.params);
      const want = cur.file.replace(/\.[^.]*$/, '').toLowerCase();
      const hit = done.find(([n]) => n.toLowerCase() === want) ?? (done.length === 1 ? done[0] : undefined);
      if (hit) setSample(slotId, hit[1].id, hit[1].name + '.wav', 'Import FL content');
    } finally {
      store.endGesture();
    }
    flashHint(`Wave Traveller: ${done.length} sample${done.length === 1 ? '' : 's'} imported`);
  } catch {
    flashHint('Wave Traveller: the FL content could not be imported');
  }
}

// ------------------------------------------------------------------------------------------------ patches

/** Clipboard of the patch menu's Copy / Paste. */
let clip: WtPatch | null = null;
export const clipboardPatch = (): WtPatch | null => clip;
export function copyPatch(p: WtPatch): void { clip = clonePatch(p); }

/** Replace a patch's content (Paste, a spline preset): the name stays unless `name` is given. */
export function replacePatch(d: Record<string, unknown>, key: number, from: WtPatch, keepName = true): void {
  editPatchIn(d, key, (p) => {
    const name = p.name;
    Object.assign(p, clonePatch(from));
    if (keepName) p.name = name;
  });
}

/** Save the patch as a .spln file (FL's "Save presets..."). */
export function saveSpln(p: WtPatch, name: string): void {
  const bytes = writeSpln(p);
  const blob = new Blob([bytes.slice().buffer], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_') || 'preset'}.spln`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Load a .spln file into the selected key's patch. */
export async function loadSpln(slotId: string, key: number, f: File): Promise<boolean> {
  if (f.size > (1 << 24)) return false;
  const p = readSpln(await f.arrayBuffer());
  if (!p) return false;
  A.editFx(slotId, 'Load spline preset', (d) => replacePatch(d as Record<string, unknown>, key, p));
  return true;
}

export type DraftState = Draft<Record<string, unknown>>;
