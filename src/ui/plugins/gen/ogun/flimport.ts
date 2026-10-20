// Ogun's "Import FL content..." (options / plugin window menu): FL's factory presets hold content Orchard Studio does not ship (the
// dense resynthesis maps, state.missing). The user picks FL's "Plugin presets/Generators/Ogun" folder (or single .fst files) from their
// own FL installation; the preset the state came from is found by its name (`__preset`) or, failing that, by comparing every picked
// preset with the state, and its dense curves land in the state in one undo step (the keys leave `missing`). Every file is parsed
// defensively (model/gen/plugins/ogun/flstate.ts); nothing of FL's is stored anywhere but in the user's own project.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { flashHint } from '../../../hint';
import { OG_MAX_FILE_BYTES, parseOgunFile, type OgFlState } from '../../../../model/gen/plugins/ogun/flstate';
import { NAMED_SCORE, SCAN_SCORE, fillMissing, matchScore, presetFileMatches } from '../../../../model/gen/plugins/ogun/flimport';
import type { FxParams } from '../../../../model/fx/types';

const MAX_FILES = 5000;

const relPath = (f: File): string => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

function pick(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    else input.accept = '.fst';
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** The menu action: pick FL's Ogun preset folder (or files) and import. */
export async function runOgunImport(slotId: string, mode: 'folder' | 'files'): Promise<void> {
  const files = await pick(mode === 'folder');
  if (!files.length) return;
  flashHint('Ogun: importing FL content...');
  try {
    flashHint(await importFlContent(slotId, files));
  } catch {
    flashHint('Ogun: the FL content could not be imported');
  }
}

async function load(f: File): Promise<OgFlState | null> {
  if (f.size > OG_MAX_FILE_BYTES) return null;
  return parseOgunFile(new Uint8Array(await f.arrayBuffer()));
}

/**
 * Import the dense curves the state of `slotId` lacks from the picked files; returns the message for the user. The preset file is the
 * one named like the state's preset (`__preset`, also accepted with a state that has been edited since), else the picked preset that
 * agrees best with the state; a single picked file is taken when it agrees with the state at all.
 */
export async function importFlContent(slotId: string, files: File[], onProgress?: (done: number, total: number) => void): Promise<string> {
  const loc = A.findFx(store.project, slotId);
  if (!loc || loc.fx.plugin !== 'ogun') return 'Ogun: no Ogun instrument here';
  const params = loc.fx.params as FxParams;
  const miss = Array.isArray(params.missing) ? (params.missing as string[]) : [];
  if (!miss.length) return 'Ogun: this preset has no FL content to import';
  const list = files.slice(0, MAX_FILES).filter((f) => /\.fst$/i.test(f.name));
  if (!list.length) return 'Ogun: no FL preset (.fst) among the picked files';

  const name = typeof params.__preset === 'string' ? params.__preset : '';
  let found: OgFlState | null = null, from = '', best = -1;
  const consider = async (f: File, min: number): Promise<void> => {
    const st = await load(f);
    if (!st) return;
    const s = matchScore(params, st);
    // the file must hold at least one of the missing curves as FL content
    const probe = fillMissing(structuredClone(params), st);
    if (!probe.filled.length) return;
    if (s >= min && s > best) { best = s; found = st; from = relPath(f); }
  };
  const named = name ? list.find((f) => presetFileMatches(relPath(f), name)) : undefined;
  if (named) await consider(named, NAMED_SCORE);
  if (!found && list.length === 1) await consider(list[0], NAMED_SCORE);
  if (!found) {
    // compare every picked preset with the state (FL's whole folder: 229 files)
    let done = 0;
    for (const f of list) {
      if (f !== named) await consider(f, SCAN_SCORE);
      onProgress?.(++done, list.length);
      if (best >= 1) break;
    }
  }
  if (!found) return name ? `Ogun: no FL preset like "${name}" among the picked files` : 'Ogun: no FL preset like this state among the picked files';

  const st: OgFlState = found;
  let filled: string[] = [], absent: string[] = [];
  store.update('Import FL content', (d) => {
    const ps = A.fxParamsDraft(d, slotId);
    if (!ps) return;
    const r = fillMissing(ps as FxParams, st);
    filled = r.filled; absent = r.absent;
  });
  const base = from.replace(/\\/g, '/').split('/').pop()?.replace(/\.fst$/i, '') ?? from;
  if (!filled.length) return `Ogun: "${base}" holds none of the missing curves`;
  return `Ogun: imported ${filled.length} curve${filled.length > 1 ? 's' : ''} from ${base}${absent.length ? ` (${absent.length} not in the file)` : ''}`;
}
