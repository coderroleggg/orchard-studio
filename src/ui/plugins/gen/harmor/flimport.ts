// Harmor's "Import FL content..." (plugin menu): FL's factory presets hold
// content that Orchard Studio does not ship (HPart.missing dense curves, image
// planes, resynthesis source samples). The user picks FL's "Plugin presets/
// Generators/Harmor" folder (or single .fst / sample files) from their own FL
// installation; the preset the state came from is found by its name
// (`__preset`) or, failing that, by comparing every picked preset with the
// state's parts, and its content lands in the state in one undo step:
// - the dense curves into hA / hB (their keys leave HPart.missing);
// - the image planes as a float sample in the pool under `a_imgSample` /
//   `b_imgSample` (layout: model/gen/plugins/harmor/import.ts imagePlanesSample);
// - the resynthesis source audio (HPart.src, image mode 1) as a pool sample
//   under `a_srcSample` / `b_srcSample`.
// Every file is parsed defensively (import.ts); nothing of FL's is stored
// anywhere but in the user's own project / browser storage.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { addRaw, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { SampleInfo } from '../../../../model/types';
import { HARMOR_KEYS, PART_PARAMS } from '../../../../model/gen/plugins/harmor/params';
import type { HPart } from '../../../../model/gen/plugins/harmor/types';
import * as I from '../../../../model/gen/plugins/harmor/import';
import { flashHint } from '../../../hint';

/** The state keys of the imported pool samples, per part. */
export const IMG_SAMPLE_KEYS = ['a_imgSample', 'b_imgSample'] as const;
export const SRC_SAMPLE_KEYS = ['a_srcSample', 'b_srcSample'] as const;

/** Largest audio file accepted (bytes); most files of a folder pick looked at. */
const MAX_AUDIO_BYTES = 64 << 20;
const MAX_FILES = 50000;
const AUDIO_EXT = /\.(ogg|wav|wv|mp3|flac|aiff?)$/i;
/** Lowest part score accepted for the preset named in the state / for the best preset of a scan. */
const NAMED_SCORE = 0.6;
const SCAN_SCORE = 0.8;

export interface ImportReport {
  /** Preset file(s) the content came from (relative paths). */
  from: string[];
  curves: number;
  images: number;
  sources: number;
  /** What could not be imported (user messages). */
  notes: string[];
}

type Entry = [string[], File];

const relPath = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

function pick(folder: boolean, accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    else input.accept = accept;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.click();
  });
}

/** The menu action: pick FL's Harmor preset folder (or files) and import. */
export async function runHarmorImport(slotId: string, mode: 'folder' | 'files'): Promise<void> {
  const files = await pick(mode === 'folder', '.fst,.ogg,.wav,.wv,.mp3,.flac,.aif,.aiff');
  if (!files.length) return;
  flashHint('Harmor: importing FL content...');
  try {
    const r = await importFlContent(slotId, files);
    flashHint(r ? reportText(r) : 'Harmor: nothing to import');
  } catch {
    flashHint('Harmor: the FL content could not be imported');
  }
}

export function reportText(r: ImportReport): string {
  const got: string[] = [];
  if (r.curves) got.push(`${r.curves} curve${r.curves > 1 ? 's' : ''}`);
  if (r.images) got.push(`${r.images} image${r.images > 1 ? 's' : ''}`);
  if (r.sources) got.push(`${r.sources} sample${r.sources > 1 ? 's' : ''}`);
  const head = got.length ? `Harmor: imported ${got.join(', ')}${r.from.length ? ' from ' + r.from.join(', ') : ''}` : 'Harmor: nothing imported';
  return [head, ...r.notes].join(' - ');
}

const hasSample = (v: unknown) => typeof v === 'string' && !!store.project.samples[v];

/** A pool sample (undo with the state edit: the caller adds `info` to the project). */
async function poolSample(name: string, channels: Float32Array[], rate: number, bytes: ArrayBuffer): Promise<SampleInfo> {
  const id = uid('s');
  addRaw({ id, name, channels, sampleRate: rate });
  await storeUserSample(id, bytes);
  return { id, name, frames: channels[0].length, sampleRate: rate, channels: channels.length, source: { kind: 'user', key: id } };
}

/** The Ogg stream of a Vorbis-in-WAV file (FL's sample packs), null when the file is not one. */
function vorbisWav(b: Uint8Array): Uint8Array | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 20 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = 0;
  for (let o = 12; o + 8 <= b.length;) {
    const n = dv.getUint32(o + 4, true), body = o + 8;
    if (tag(o) === 'fmt ' && n >= 2 && body + 2 <= b.length) fmt = dv.getUint16(body, true);
    else if (tag(o) === 'data') {
      const d = b.subarray(body, Math.min(b.length, body + n));
      return (fmt === 0x674f || fmt === 0x6750) && d.length > 4 && tag(body) === 'OggS' ? d : null;
    }
    o = body + n + (n & 1);
  }
  return null;
}

/** Decode an audio file the way the pool reloads it (the browser's decoder at 44.1 kHz); null if it cannot. */
async function decodeAudio(file: File): Promise<{ channels: Float32Array[]; rate: number; bytes: ArrayBuffer } | null> {
  if (file.size > MAX_AUDIO_BYTES || typeof OfflineAudioContext === 'undefined') return null;
  const buf = new Uint8Array(await file.arrayBuffer());
  const ogg = vorbisWav(buf);
  const bytes = (ogg ?? buf).slice().buffer;
  try {
    const audio = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes.slice(0));
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(new Float32Array(audio.getChannelData(c)));
    return channels.length && channels[0].length ? { channels, rate: audio.sampleRate, bytes } : null;
  } catch {
    return null;
  }
}

/** A part's parameter i of the state (FL index order). */
const paramOf = (params: Record<string, unknown>, part: number) => (i: number) => params[HARMOR_KEYS[part * PART_PARAMS + i]];

/** Can this parsed part supply what the model part lacks? (the dense curves are dense, the image has the size) */
function supplies(hp: HPart, need: I.PartNeeds, raw: I.HRawPart): boolean {
  if (need.curves.some((k) => (I.rawCurveFor(raw, k)?.p.length ?? 0) <= 64)) return false;
  return !need.image || !!I.imageFor(hp, raw);
}

/**
 * Import the FL content the Harmor state of `slotId` lacks from the picked
 * files; returns what was imported (null: not a Harmor slot / nothing needed).
 */
export async function importFlContent(slotId: string, files: File[], onProgress?: (done: number, total: number) => void): Promise<ImportReport | null> {
  const loc = A.findFx(store.project, slotId);
  if (!loc || loc.fx.plugin !== 'harmor') return null;
  const params = loc.fx.params as Record<string, unknown>;
  const parts = [params.hA as HPart | undefined, params.hB as HPart | undefined];
  const needs = parts.map((hp, p) => I.partNeeds(hp, hasSample(params[IMG_SAMPLE_KEYS[p]]), hasSample(params[SRC_SAMPLE_KEYS[p]])));
  if (!needs.some(I.needsAny)) return null;
  const entries: Entry[] = files.slice(0, MAX_FILES).map((f) => [I.pathParts(relPath(f)), f]);
  const report: ImportReport = { from: [], curves: 0, images: 0, sources: 0, notes: [] };

  // 1. the FL preset of the parts lacking curves / images
  const want = [0, 1].filter((p) => needs[p].curves.length || needs[p].image);
  const found: (I.HRawPart | null)[] = [null, null];
  const fromOf: string[] = ['', ''];
  if (want.length) {
    const presets = entries.filter(([pp, f]) => /\.fst$/i.test(pp[pp.length - 1] ?? '') && f.size <= I.MAX_STATE_BYTES);
    const parsed = new Map<File, I.HRawState | null>();
    const load = async (f: File) => {
      if (!parsed.has(f)) parsed.set(f, I.parseHarmorFile(new Uint8Array(await f.arrayBuffer())));
      return parsed.get(f)!;
    };
    const candidates = (st: I.HRawState, p: number) => {
      const own = st.parts[p];
      if (own) return [own];
      // a single-part state loads into either part
      const one = st.parts[0] ?? st.parts[1];
      return one && !(st.parts[0] && st.parts[1]) ? [one] : [];
    };
    const tryFile = async (f: File, min: number, best: number[]) => {
      const st = await load(f);
      if (!st) return;
      for (const p of want) {
        const hp = parts[p]!;
        for (const raw of candidates(st, p)) {
          if (!supplies(hp, needs[p], raw)) continue;
          const s = I.partScore(hp, paramOf(params, p), raw);
          if (s >= min && s > best[p]) { best[p] = s; found[p] = raw; fromOf[p] = relPath(f); }
        }
      }
    };
    const best = [-1, -1];
    const name = typeof params.__preset === 'string' ? params.__preset : '';
    const named = name ? I.matchPath(name + '.fst', presets) : null;
    if (named) await tryFile(named, NAMED_SCORE, best);
    if (want.some((p) => !found[p])) {
      // compare every picked preset (FL's whole folder: 325 files)
      let done = 0;
      for (const [, f] of presets) {
        if (f !== named) await tryFile(f, SCAN_SCORE, best);
        onProgress?.(++done, presets.length);
        if (want.every((p) => best[p] >= 1)) break;
      }
    }
    for (const p of want) if (!found[p]) report.notes.push(`no FL preset with part ${'AB'[p]}'s content among the picked files`);
  }

  // 2. the image planes and the resynthesis sources as pool samples
  const added: SampleInfo[] = [];
  const imgIds: (string | null)[] = [null, null], srcIds: (string | null)[] = [null, null];
  for (const p of [0, 1]) {
    const raw = found[p], hp = parts[p];
    if (!hp) continue;
    const im = raw && needs[p].image ? I.imageFor(hp, raw) : null;
    if (im) {
      const data = I.imagePlanesSample(im);
      const info = await poolSample(`Harmor image ${'AB'[p]}`, [data], 44100, I.floatWav(data));
      added.push(info);
      imgIds[p] = info.id;
    }
    if (needs[p].source) {
      const audio = entries.filter(([pp]) => AUDIO_EXT.test(pp[pp.length - 1] ?? ''));
      // the saved path's longest suffix, else the same name with another audio extension (a converted file)
      let file = I.matchPath(hp.src, audio);
      if (!file) {
        const base = (I.pathParts(hp.src).pop() ?? '').replace(/\.[^.]*$/, '');
        file = audio.find(([pp]) => (pp[pp.length - 1] ?? '').replace(/\.[^.]*$/, '') === base)?.[1] ?? null;
      }
      const name = hp.src.replace(/\\/g, '/').split('/').pop() ?? hp.src;
      if (!file) { report.notes.push(`resynthesis sample "${name}" not among the picked files`); continue; }
      const dec = await decodeAudio(file);
      if (!dec) { report.notes.push(`"${file.name}" could not be decoded${/\.wv$/i.test(file.name) ? ' (WavPack: convert it to WAV)' : ''}`); continue; }
      const info = await poolSample(file.name.replace(/\.[^.]*$/, ''), dec.channels, dec.rate, dec.bytes);
      added.push(info);
      srcIds[p] = info.id;
    }
  }

  // 3. one undo step: the curves, the image marks, the sample references
  if (!added.length && !found.some(Boolean)) return report;
  store.update('Import FL content', (d) => {
    for (const info of added) d.samples[info.id] = info;
    const ps = A.fxParamsDraft(d, slotId);
    if (!ps) return;
    for (const p of [0, 1]) {
      const hp = (p ? ps.hB : ps.hA) as HPart | undefined;
      if (!hp) continue;
      const raw = found[p];
      if (raw) {
        const r = I.fillCurves(hp, raw);
        report.curves += r.filled.length;
        if (r.absent.length) report.notes.push(`part ${'AB'[p]}: ${r.absent.length} curve(s) not in the preset`);
      }
      if (imgIds[p]) { ps[IMG_SAMPLE_KEYS[p]] = imgIds[p]; I.markImage(hp.img); report.images++; }
      if (srcIds[p]) { ps[SRC_SAMPLE_KEYS[p]] = srcIds[p]; report.sources++; }
    }
  });
  report.from = [...new Set(fromOf.filter(Boolean).map((s) => s.replace(/\.fst$/i, '')))];
  return report;
}
