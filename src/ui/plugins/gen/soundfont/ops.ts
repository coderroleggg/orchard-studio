// SoundFont Player's editor operations (main thread): loading .sf2 files (the Open button, a drop, the window
// menu, "Import FL content...") into the project's sample pool and the plugin state, and the option edits.
// The sample data (smpl / sm24) becomes a mono WAV in the pool; the pdta tables stay in the state as base64 (see
// src/model/gen/plugins/soundfont/state.ts); nothing of FL's is shipped, the user picks the files.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { addPoolSample, baseName } from '../bassdrum/flimport';
import { POOL_WAV_RATE, importSf2 } from '../../../../model/gen/plugins/soundfont/import';
import { sfState, type SfFont, type SfState } from '../../../../model/gen/plugins/soundfont/state';

/** The typed state of a slot's plugin. */
export function current(slotId: string): SfState {
  return sfState(A.findFx(store.project, slotId)?.fx.params ?? {});
}

/** Display name of a font: the file's name (INAM), or the file name it came from. */
export function fontLabel(f: SfFont | undefined): string {
  return f ? f.name : '';
}

/** Largest file a user may pick: FL's player handles very large banks, but the browser has to hold the PCM twice. */
const MAX_FILE = 768 * 1024 * 1024;

/** The WAV bytes the pool keeps for a font's sample data. */
function wavBuffer(wav: Uint8Array): ArrayBuffer {
  return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
}

/**
 * Load one soundfont file: parse it defensively, store its sample data in the sample pool and append it to the
 * state's soundfont list, where it becomes the active one. Resolves to a message for the hint bar.
 */
export async function loadSoundFont(slotId: string, f: File): Promise<string> {
  if (f.size > MAX_FILE) return 'The SoundFont file is too large.';
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await f.arrayBuffer()); } catch { return `Could not read ${f.name}.`; }
  const r = importSf2(bytes, baseName(f));
  if ('error' in r) return `${f.name}: ${r.error}`;
  const info = await addPoolSample(`${r.font.name} (soundfont)`, { channels: [r.pcm], sampleRate: POOL_WAV_RATE }, wavBuffer(r.wav), 'Load SoundFont');
  const font: SfFont = { ...r.font, sample: info.id };
  A.editFx(slotId, 'Load SoundFont', (d) => {
    const q = d as Record<string, unknown>;
    const fonts = Array.isArray(q.fonts) ? [...(q.fonts as SfFont[]), font] : [font];
    q.fonts = fonts;
    q.active = fonts.length - 1;
  });
  return `SoundFont loaded: ${font.name}`;
}

/** Load several files in order (the last one stays active); the messages are joined for the hint bar. */
export async function loadSoundFonts(slotId: string, files: File[]): Promise<string> {
  const out: string[] = [];
  for (const f of files) out.push(await loadSoundFont(slotId, f));
  return out.join('  ');
}

/** Make loaded soundfont `i` the one that plays. */
export function selectFont(slotId: string, i: number): void {
  A.editFx(slotId, 'Select SoundFont', (d) => { (d as Record<string, unknown>).active = i; });
}

/** Set one of the non-parameter state fields (options, send routing). */
export function setState(slotId: string, label: string, key: string, value: number | boolean, mergeKey?: string): void {
  A.editFx(slotId, label, (d) => { (d as Record<string, unknown>)[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value; }, mergeKey);
}

/** Select a preset: FL's parameters 0 / 1 (patch, bank) in one undo step. */
export function setPatch(slotId: string, patch: number, bank: number): void {
  A.editFx(slotId, 'Select patch', (d) => {
    const q = d as Record<string, unknown>;
    q.patch = patch;
    q.bank = bank;
  });
}
