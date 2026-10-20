// Morphine's "Import FL content..." (plugin menu): FL's factory programs hold
// analysed spectra and name Noise Samples WAVs that Orchard Studio does not
// ship. The user picks FL's "Plugin presets/Generators/Morphine" folder (or
// single .mrp / .fst files) and / or Morphine's "Noise Samples" folder from
// their own FL installation; the program the state came from is found by its
// name, its spectra land in the pool (spectraSample, rows of 128 floats) and
// the named noise sample too (noiseSample), in one undo step. Also "Load
// Program" / "Save Program" (FL's .mrp format). Parsing: model/gen/plugins/
// morphine/import.ts and mrp.ts (defensive).

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { addRaw, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { SampleInfo } from '../../../../model/types';
import { applyUpdates, floatWav, importProgram, noiseFileFor, noiseUpdates, parseNoiseWav, presetFileFor, MAX_WAV_BYTES } from '../../../../model/gen/plugins/morphine/import';
import { stateToRaw, writeMrp, MAX_FILE_BYTES } from '../../../../model/gen/plugins/morphine/mrp';
import { flashHint } from '../../../hint';
import { rowsOf } from './data';

const MAX_FILES = 20000;

function pick(folder: boolean, accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !folder;
    if (folder) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    else input.accept = accept;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.click();
  });
}

const relPath = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

function paramsOf(slotId: string): Record<string, unknown> {
  return (A.findFx(store.project, slotId)?.fx.params ?? {}) as Record<string, unknown>;
}

async function poolSample(name: string, channels: Float32Array[], bytes: Uint8Array): Promise<SampleInfo> {
  const id = uid('s');
  addRaw({ id, name, channels, sampleRate: 44100 });
  await storeUserSample(id, bytes.slice().buffer);
  return { id, name, frames: channels[0].length, sampleRate: 44100, channels: channels.length, source: { kind: 'user', key: id } };
}

/** Put a picked program's spectra (and its noise sample, when picked too) into the state. */
async function importFiles(slotId: string, files: File[], replace: boolean, label: string): Promise<string> {
  const st = paramsOf(slotId);
  const paths = files.map(relPath);
  const notes: string[] = [];
  const added: SampleInfo[] = [];
  let updates: Record<string, unknown> = {};
  const progIdx = replace ? (files.length === 1 ? 0 : -1) : presetFileFor(st, paths);
  if (progIdx >= 0 && files[progIdx].size <= MAX_FILE_BYTES) {
    const imp = importProgram(new Uint8Array(await files[progIdx].arrayBuffer()), st, replace);
    if (!imp) notes.push(`"${files[progIdx].name}" is not a Morphine program`);
    else {
      updates = { ...imp.updates };
      if (imp.spectra) {
        const info = await poolSample(`Morphine spectra (${imp.name || files[progIdx].name})`, [imp.spectra], floatWav([imp.spectra]));
        added.push(info);
        updates.spectraSample = info.id;
      }
      if (replace) updates.progName = imp.name || files[progIdx].name.replace(/\.(mrp|fst)$/i, '');
    }
  } else if (!replace && files.some((f) => /\.(mrp|fst)$/i.test(f.name))) notes.push('no picked program matches this state');
  // the noise sample the (updated) program names
  const after = applyUpdates(st, updates);
  const ni = noiseFileFor(after, paths);
  if (ni >= 0 && files[ni].size <= MAX_WAV_BYTES) {
    const w = parseNoiseWav(new Uint8Array(await files[ni].arrayBuffer()));
    if (!w) notes.push(`"${files[ni].name}" could not be read`);
    else {
      const info = await poolSample(files[ni].name.replace(/\.wav$/i, ''), w.channels, floatWav(w.channels));
      added.push(info);
      updates = { ...updates, ...noiseUpdates(w), noiseSample: info.id };
    }
  }
  if (!Object.keys(updates).length) return notes.join('; ') || 'nothing to import';
  store.update(label, (d) => {
    for (const info of added) d.samples[info.id] = info;
    const ps = A.fxParamsDraft(d, slotId);
    if (!ps) return;
    const next = applyUpdates({ ...(ps as Record<string, unknown>) }, updates);
    for (const k of Object.keys(ps)) if (!(k in next)) delete ps[k];
    Object.assign(ps, next);
  });
  return [`${added.length} item${added.length === 1 ? '' : 's'} imported`, ...notes].join('; ');
}

/** "Import FL content...": FL's Morphine presets folder and / or Noise Samples folder (or files). */
export async function runMorphineImport(slotId: string, folder: boolean): Promise<void> {
  const files = (await pick(folder, '.mrp,.fst,.wav')).filter((f) => /\.(mrp|fst|wav)$/i.test(f.name)).slice(0, MAX_FILES);
  if (!files.length) return;
  flashHint('Morphine: importing FL content...');
  try {
    flashHint('Morphine: ' + await importFiles(slotId, files, false, 'Import FL content'));
  } catch {
    flashHint('Morphine: the FL content could not be imported');
  }
}

/** "Load Program": a .mrp / .fst file replaces the program. */
export async function runLoadProgram(slotId: string): Promise<void> {
  const [file] = await pick(false, '.mrp,.fst');
  if (!file) return;
  try {
    flashHint('Morphine: ' + await importFiles(slotId, [file], true, 'Load Program'));
  } catch {
    flashHint('Morphine: the program could not be loaded');
  }
}

/** "Save Program": the program as FL's .mrp file. */
export function runSaveProgram(slotId: string): void {
  const st = paramsOf(slotId);
  try {
    const bytes = writeMrp(stateToRaw(st, rowsOf(st)));
    const blob = new Blob([bytes.slice().buffer], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(typeof st.progName === 'string' && st.progName) || 'Morphine'}.mrp`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    flashHint('Morphine: the program could not be saved');
  }
}

