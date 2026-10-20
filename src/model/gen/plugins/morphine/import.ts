// Morphine FL content import (pure part). FL's factory programs hold content
// that is not part of this repository: the analysed spectra (per breakpoint
// 3 x 128 partial amplitudes / pans / detunes, and the non-flat per-partial
// velocity / window curves) and the Noise Samples WAVs. The user imports them
// at runtime from their own FL installation (plugin menu "Import FL content...");
// the UI picks the files, these functions parse them DEFENSIVELY (untrusted
// input: bounds-checked reads, capped sizes, nothing evaluated) and return the
// state changes and the float data to store as pool samples:
//
// - importProgram(bytes, state): a picked .mrp (FL's preset folder
//   Data/Patches/Plugin presets/Generators/Morphine/<folder>/<name>.mrp), .fst or
//   FL state; returns `spectra` (rows of 128 floats: per breakpoint amp, pan,
//   detune; per non-flat zone the two curves) to store as a mono pool sample
//   (encode with floatWav(): 32-bit float at a nominal 44100 Hz, so the pool's
//   decoder returns the floats unchanged) whose id goes to state.spectraSample,
//   and `updates` (row indices `s` / `cs` in the breakpoints and zones). When the
//   state's program structure still matches the file (a factory preset as
//   loaded) only the content is added; otherwise the file's whole program
//   replaces the structure (its parameters are kept unless `replace`).
// - parseNoiseWav(bytes): a Noise Samples WAV as Morphine's loader reads it
//   (8/16/24/32-bit PCM and float, FL's own conversions, the first 'smpl'
//   loop); store `channels` with floatWav(channels) (nominal 44100 Hz: FL plays
//   the frames unresampled at their own rate, kept in noiseRate) and set
//   noiseSample / noiseRate / noiseLoop from noiseUpdates().
// - presetFileFor(state, paths): the picked file that holds the state's preset.

import { parseMorphineFile, rawToState, type RawProgram } from './mrp';
import { MOR_KEYS, N_PROG } from './params';
import { NP, normalizeMorphine, type MGen } from './state';

export const MAX_WAV_BYTES = 64 << 20;
/** Most frames of a noise sample accepted. */
export const MAX_NOISE_FRAMES = 1 << 24;

const f32 = Math.fround;

// ------------------------------------------------------------------ noise samples

export interface NoiseWav {
  channels: Float32Array[];
  sampleRate: number;
  /** The first 'smpl' loop [start, end] (frames), null when none. */
  loop: [number, number] | null;
}

const U8K = f32(1 / 127.5); // 0x3c008081
const S24K = (() => { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, 0x34000001); return d.getFloat32(0); })();

/** A WAV file as Morphine's CWaveSample loader (0x46af4) converts it; null if it is not a supported WAV. */
export function parseNoiseWav(b: Uint8Array): NoiseWav | null {
  if (b.length < 44 || b.length > MAX_WAV_BYTES) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = 0, ch = 0, rate = 0, bits = 0, block = 0, data = -1, dataLen = 0;
  let loop: [number, number] | null = null;
  for (let o = 12; o + 8 <= b.length;) {
    const id = tag(o), n = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ' && n >= 16 && body + 16 <= b.length) {
      fmt = dv.getUint16(body, true); ch = dv.getUint16(body + 2, true); rate = dv.getUint32(body + 4, true);
      block = dv.getUint16(body + 12, true); bits = dv.getUint16(body + 14, true);
      if (fmt === 0xfffe && n >= 40 && body + 26 <= b.length) fmt = dv.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = body; dataLen = Math.min(n, b.length - body);
    } else if (id === 'smpl' && n >= 36 + 24 && body + 60 <= b.length) {
      const nl = dv.getUint32(body + 28, true);
      if (nl > 0) loop = [dv.getInt32(body + 36 + 8, true), dv.getInt32(body + 36 + 12, true)];
    }
    o = body + n + (n & 1);
    if (n > b.length) break;
  }
  if (data < 0 || ch < 1 || ch > 2 || !(rate > 0) || rate > 1e6) return null;
  const bytes = bits >> 3;
  if (!((fmt === 1 && (bits === 8 || bits === 16 || bits === 24 || bits === 32)) || (fmt === 3 && bits === 32))) return null;
  if (block < bytes * ch) block = bytes * ch;
  const frames = Math.min(MAX_NOISE_FRAMES, Math.floor(dataLen / block));
  if (!frames) return null;
  const out = Array.from({ length: ch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const p = data + i * block + c * bytes;
      let v: number;
      if (fmt === 3) v = dv.getFloat32(p, true);
      else if (bits === 8) v = f32(b[p] * U8K + -1);
      else if (bits === 16) v = f32(dv.getInt16(p, true) * 2 ** -15);
      else if (bits === 24) v = f32(((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8 >> 8) * S24K);
      else v = f32(f32(dv.getInt32(p, true)) * 2 ** -31);
      out[c][i] = v;
    }
  }
  return { channels: out, sampleRate: rate, loop };
}

/** State changes for an imported noise sample (the caller adds noiseSample = the pool id). */
export function noiseUpdates(w: NoiseWav): Record<string, unknown> {
  const u: Record<string, unknown> = { noiseRate: w.sampleRate, noiseMissing: undefined };
  u.noiseLoop = w.loop ?? undefined;
  return u;
}

/** A 32-bit float WAV of `channels` (1 or 2) at `rate`: what the sample pool stores and decodes back exactly. */
export function floatWav(channels: Float32Array[], rate = 44100): Uint8Array {
  const ch = Math.min(2, channels.length), n = channels[0]?.length ?? 0;
  const out = new Uint8Array(44 + n * ch * 4);
  const dv = new DataView(out.buffer);
  const w4 = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  w4(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 4, true); w4(8, 'WAVE');
  w4(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 4, true); dv.setUint16(32, ch * 4, true); dv.setUint16(34, 32, true);
  w4(36, 'data'); dv.setUint32(40, n * ch * 4, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) dv.setFloat32(44 + (i * ch + c) * 4, channels[c][i], true);
  return out;
}

// ------------------------------------------------------------------ spectra

export interface ProgramImport {
  /** State changes (spectraSample: the caller sets it to the pool id of `spectra`). */
  updates: Record<string, unknown>;
  /** Rows of 128 floats for the spectra pool sample (null when the program has no breakpoints). */
  spectra: Float32Array | null;
  /** The program's noise sample file name ('' = none). */
  noise: string;
  /** The program name stored in the file. */
  name: string;
  /** True when the file's structure matched the state's and only content was added. */
  matched: boolean;
}

function sameStructure(st: Record<string, unknown>, raw: RawProgram): boolean {
  const gens = st.gens as MGen[] | undefined;
  if (!Array.isArray(gens) || gens.length !== 4) return false;
  for (let g = 0; g < 4; g++) {
    const zs = gens[g].zones, rz = raw.gens[g].zones;
    if (zs.length !== rz.length) return false;
    for (let z = 0; z < zs.length; z++) {
      const a = zs[z].bp, b = rz[z].tl.bps;
      if (a.length !== b.length || zs[z].w !== Math.max(1, rz[z].width)) return false;
      for (let i = 0; i < a.length; i++) if (a[i].t !== b[i].time) return false;
    }
  }
  return true;
}

/**
 * Import the spectra (and the noise file name) of a picked Morphine program
 * file for `state`. Null when the bytes are not a Morphine program.
 * `replace`: take the file's whole program (parameters included).
 */
export function importProgram(bytes: Uint8Array, state: Record<string, unknown>, replace = false): ProgramImport | null {
  const raw = parseMorphineFile(bytes);
  if (!raw) return null;
  const rows = { rows: [] as Float32Array[] };
  const full = rawToState(raw, rows);
  const matched = !replace && sameStructure(state, raw);
  let updates: Record<string, unknown>;
  if (matched) {
    // keep the state's (possibly edited) structure values, add the row references
    const gens = (state.gens as MGen[]).map((g, gi) => ({
      ...g,
      zones: g.zones.map((z, zi) => {
        const fz = (full.gens as MGen[])[gi].zones[zi];
        const nz = { ...z, bp: z.bp.map((bp, bi) => ({ ...bp, s: fz.bp[bi].s })) };
        if (fz.cs !== undefined) nz.cs = fz.cs;
        return nz;
      }),
    }));
    updates = { gens };
  } else {
    updates = {};
    for (const [k, v] of Object.entries(full)) {
      const i = MOR_KEYS.indexOf(k);
      if (i >= 0 && i < N_PROG && !replace) continue;
      updates[k] = v;
    }
    if (replace) for (let i = 0; i < N_PROG; i++) updates[MOR_KEYS[i]] = full[MOR_KEYS[i]];
  }
  updates.spectraMissing = undefined;
  const spectra = rows.rows.length ? new Float32Array(rows.rows.length * NP) : null;
  if (spectra) rows.rows.forEach((r, i) => spectra.set(r, i * NP));
  if (raw.noise && !state.noiseSample) updates.noise = raw.noise;
  return { updates, spectra, noise: raw.noise, name: raw.name, matched };
}

/** Apply import updates to a state (undefined values delete keys) and normalise. */
export function applyUpdates(state: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...state };
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) delete o[k];
    else o[k] = v;
  }
  return normalizeMorphine(o);
}

// ------------------------------------------------------------------ matching picked files

/** Lower-case path parts of a picked file's relative path. */
export function pathParts(rel: string): string[] {
  return rel.split(/[\\/]+/).filter(Boolean);
}

/**
 * Index in `paths` (picked files' relative paths) of the program file for the
 * state's preset (`__preset` "Folder/Name", else its program name): the .mrp
 * whose "<folder>/<name>" ends the path, else one whose file name matches. -1 if none.
 */
export function presetFileFor(state: Record<string, unknown>, paths: string[]): number {
  const pre = typeof state.__preset === 'string' ? state.__preset : '';
  const name = (pre || (typeof state.progName === 'string' ? state.progName : '')).toLowerCase();
  if (!name) return -1;
  const want = pathParts(name);
  const file = want[want.length - 1];
  let byName = -1;
  for (let i = 0; i < paths.length; i++) {
    const pp = pathParts(paths[i].toLowerCase());
    const last = pp[pp.length - 1] ?? '';
    if (!/\.(mrp|fst)$/.test(last)) continue;
    const base = last.replace(/\.(mrp|fst)$/, '');
    if (base !== file) continue;
    if (want.length > 1 && pp.length >= 2 && pp[pp.length - 2] === want[want.length - 2]) return i;
    if (byName < 0) byName = i;
  }
  return byName;
}

/** Index in `paths` of the noise WAV the state names (file name match, case-insensitive), -1 if none. */
export function noiseFileFor(state: Record<string, unknown>, paths: string[]): number {
  const n = typeof state.noise === 'string' ? state.noise.toLowerCase() : '';
  if (!n) return -1;
  const want = pathParts(n).pop()!;
  return paths.findIndex((p) => (pathParts(p.toLowerCase()).pop() ?? '') === want);
}

/** What content a state lacks: its spectra (stand-ins playing) and / or its noise sample. */
export function contentNeeds(state: Record<string, unknown>): { spectra: boolean; noise: string } {
  return { spectra: state.spectraMissing === 1, noise: typeof state.noise === 'string' && state.noise && !state.noiseSample ? state.noise : '' };
}
