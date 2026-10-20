// Harmless's custom timbre colour (timbre "Custom"): FL's factory presets carry
// an analysed colour that Orchard Studio does not ship. The plugin menu's
// "Import FL content..." reads the user's own FL presets (the folder
// "Plugin presets/Generators/Harmless" or single .fst files), finds the preset
// the state came from (every parameter and extra control equal) and stores its
// colour in the project's sample pool under `customSample`. The timbre menu's
// "Analyze single-cycle waveform..." builds a colour from an audio file (one
// period) and "Reset custom timbre color" drops it (Custom falls back to Saw). Nothing of FL's is
// stored anywhere but in the user's own project / browser storage.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { addRaw, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { SampleInfo } from '../../../../model/types';
import { TIMBRE_CUSTOM } from '../../../../model/gen/plugins/harmless/state';
import { analyzeCycle, customFrames, decodeHarmlessFile, floatWav, presetScore } from '../../../../model/gen/plugins/harmless/import';
import { flashHint } from '../../../hint';

const MAX_FILES = 20000;
const MAX_FST_BYTES = 1 << 20;
const MAX_AUDIO_BYTES = 64 << 20;

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

function paramsOf(slotId: string): Record<string, unknown> {
  return (A.findFx(store.project, slotId)?.fx.params ?? {}) as Record<string, unknown>;
}

async function poolSample(name: string, frames: Float32Array): Promise<SampleInfo> {
  const id = uid('s');
  addRaw({ id, name, channels: [frames], sampleRate: 44100 });
  await storeUserSample(id, floatWav(frames));
  return { id, name, frames: frames.length, sampleRate: 44100, channels: 1, source: { kind: 'user', key: id } };
}

async function setColour(slotId: string, label: string, name: string, frames: Float32Array, selectCustom: boolean): Promise<void> {
  const info = await poolSample(name, frames);
  store.update(label, (d) => {
    d.samples[info.id] = info;
    const ps = A.fxParamsDraft(d, slotId);
    if (!ps) return;
    ps.customSample = info.id;
    delete ps.customMissing;
    if (selectCustom) ps.timbre = TIMBRE_CUSTOM;
  });
}

/** "Import FL content...": the custom colour of the FL preset this state came from. */
export async function runHarmlessImport(slotId: string, folder: boolean): Promise<void> {
  const files = (await pick(folder, '.fst')).filter((f) => /\.fst$/i.test(f.name) && f.size <= MAX_FST_BYTES).slice(0, MAX_FILES);
  if (!files.length) return;
  flashHint('Harmless: importing FL content...');
  try {
    const state = paramsOf(slotId);
    let best: { score: number; custom: Float32Array; name: string } | null = null;
    for (const f of files) {
      const d = decodeHarmlessFile(new Uint8Array(await f.arrayBuffer()));
      if (!d || !d.custom) continue;
      const score = presetScore(d, state);
      if (!best || score > best.score) best = { score, custom: d.custom, name: f.name.replace(/\.fst$/i, '') };
      if (score >= 1) break;
    }
    if (!best || best.score < 1) {
      flashHint(best ? 'Harmless: no picked preset matches this state (closest: ' + best.name + ')' : 'Harmless: the picked files hold no custom timbre colour');
      return;
    }
    await setColour(slotId, 'Import FL content', `Harmless colour (${best.name})`, customFrames(best.custom), false);
    flashHint(`Harmless: custom timbre colour imported from "${best.name}"`);
  } catch {
    flashHint('Harmless: the FL content could not be imported');
  }
}

/** "Analyze single-cycle waveform...": one period of an audio file as the custom colour. */
export async function runAnalyzeCycle(slotId: string): Promise<void> {
  const [file] = await pick(false, '.wav,.aif,.aiff,.ogg,.mp3,.flac');
  if (!file || file.size > MAX_AUDIO_BYTES || typeof OfflineAudioContext === 'undefined') return;
  try {
    const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
    const n = audio.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
    await setColour(slotId, 'Analyze single-cycle waveform', `Harmless colour (${file.name.replace(/\.[^.]*$/, '')})`, analyzeCycle(mono), true);
    flashHint(`Harmless: "${file.name}" analysed`);
  } catch {
    flashHint('Harmless: the file could not be analysed');
  }
}

/** "Reset custom timbre color" (FL 0x74720): the colour goes; a "Custom" timbre selection falls back to Saw. */
export function resetCustomColour(slotId: string): void {
  A.editFx(slotId, 'Reset custom timbre color', (p) => {
    delete p.customSample;
    delete p.customMissing;
    if (Number(p.timbre) === TIMBRE_CUSTOM) p.timbre = 0;
  });
}
