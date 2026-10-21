// FL Keys' wavetables (docs/research/gen/flkeys.md). FL describes a wavetable in a .wti ini file (key
// groups: root / high key, position / end / loop in a sample buffer, velocity layers, the sample rate and
// velocity factor, default parameter values) next to its sample data (one raw 16-bit .dat, or one RIFF
// wave per group). FL's own data never ships with Orchard: the plugin plays synthesized wavetables of the
// same layout (./synth.ts) and, when the user imports their FL install's Wavtables folder, tables built
// here by the same rules FL's loader (TPianoWaveTable, FL Keys_x64.dylib 0x62ae0 / 0x64f20 / 0x65280)
// applies, packed into a pool sample (pack / unpack below). Everything here is pure (no DOM), the same code
// runs in the importer, the tests and the worklet.
//
// The sample buffer is kept in "int16 units" (k / 32768, exactly the 16-bit grid, mono or interleaved
// stereo): FL's engine interpolates 16-bit integers, so the voice multiplies by 32768 and gets them back.

export const KEYS_PARAMS = 15;

export interface KeysTable {
  /** Wavetable name (FL's `name` in the .wti; the plugin state refers to it). */
  name: string;
  stereo: boolean;
  /** The .wti's `samplerate` (the rate the engine assumes for playback pitch). */
  rate: number;
  /** The rate of the sample files (RIFF: the first file's; raw: `rate`): what FL converts from when `resample` is on. */
  fileRate: number;
  /** `velocityfactor`: the voice envelope's start level. */
  vf: number;
  /** `releasehighnotes`: notes >= 94 get the regular release too. */
  relHigh: boolean;
  /** `resample` (default true, RIFF tables only): the files are converted to the host's sample rate when loaded (FL quirk). */
  resample: boolean;
  layers: number;
  /** Lowest velocity of each layer (layer 0: 0). */
  thr: Int32Array;
  /** Key groups (all velocity layers of a key range follow each other): FL's `root`, `high`, `pos`, `end`, `loop`. */
  root: Int32Array;
  high: Int32Array;
  pos: Int32Array;
  end: Int32Array;
  loop: Int32Array;
  /** Samples in k / 32768 units, interleaved when stereo, with spare frames after the last group (index end + 1 is read). */
  waves: Float32Array;
  /** Frames available in `waves` (without the spare ones). */
  frames: number;
  /** The .wti's [parameters] (0..1), NaN where it gives none. */
  defaults: Float64Array;
}

/** Decoded audio of one RIFF wave: 16-bit values (-32768..32767), interleaved when stereo. */
export interface KeysWave {
  channels: 1 | 2;
  rate: number;
  data: Int16Array;
  /** The file's sustain loop (smpl chunk) in frames, or null. */
  loopStart: number;
  loopEnd: number;
}

// ------------------------------------------------------------------ the .wti ini file
export class Ini {
  readonly sections = new Map<string, Map<string, string>>();
  constructor(text: string) {
    let cur: Map<string, string> | null = null;
    for (const raw of text.split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      if (!line || line[0] === ';') continue;
      if (line[0] === '[') {
        const e = line.indexOf(']');
        if (e < 0) continue;
        const name = line.slice(1, e).trim().toLowerCase();
        cur = this.sections.get(name) ?? new Map();
        this.sections.set(name, cur);
        continue;
      }
      const q = line.indexOf('=');
      if (q < 0 || !cur) continue;
      const k = line.slice(0, q).trim().toLowerCase();
      if (!cur.has(k)) cur.set(k, line.slice(q + 1).trim());
    }
  }
  str(sec: string, key: string, def = ''): string {
    return this.sections.get(sec.toLowerCase())?.get(key.toLowerCase()) ?? def;
  }
  /** Delphi's ReadInteger: StrToIntDef (an empty or bad value gives the default). */
  int(sec: string, key: string, def: number): number {
    const s = this.str(sec, key, '');
    if (!/^[+-]?\d{1,9}$/.test(s)) return def;
    return parseInt(s, 10);
  }
  float(sec: string, key: string, def: number): number {
    const s = this.str(sec, key, '').replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return def;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : def;
  }
  bool(sec: string, key: string, def: boolean): boolean {
    const s = this.str(sec, key, '').toLowerCase();
    if (s === '') return def;
    if (s === '1' || s === 'true' || s === 'yes') return true;
    if (s === '0' || s === 'false' || s === 'no') return false;
    const n = Number(s);
    return Number.isFinite(n) ? n !== 0 : def;
  }
}

export class KeysTableError extends Error {}

const f32 = Math.fround;
/** Round half to even (Delphi's Round). */
const rne = (x: number): number => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && (r & 1) !== 0 ? r - 1 : r; };
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** What the loader needs from the user's files. */
export interface KeysFiles {
  /** A raw 16-bit (little endian) sample file next to the .wti, by the name the .wti gives. */
  raw(name: string): Int16Array | null;
  /** A RIFF wave decoded to 16-bit PCM, by the name the .wti gives (relative to its `path`). */
  wave(name: string): KeysWave | null;
}

const MAX_GROUPS = 512;
const MAX_FRAMES = 40_000_000;

/**
 * Build a wavetable the way FL's loader does: groups from the [sampleN] sections, samples appended
 * (RIFF: one wave per group, each followed by a spare frame; raw: the single file's regions compacted),
 * every group's end + 1 frame set to the sample `loop` frames before its end (the interpolation read at the
 * loop wrap), then FL's validation clamps (root 0..127, high 0..999, positions inside the data, no loop
 * when `canloop` is off). Throws KeysTableError for data FL could not load either.
 */
export function buildKeysTable(ini: Ini, files: KeysFiles, hostRate: number): KeysTable {
  void hostRate;
  const count = clamp(ini.int('info', 'samples', 0), 0, MAX_GROUPS);
  if (count < 1) throw new KeysTableError('The wavetable lists no samples.');
  const fileType = ini.str('info', 'filetype', 'raw').toLowerCase();
  const sampleFile = ini.str('info', 'samplefile', '');
  const infoCanLoop = ini.bool('info', 'canloop', true);
  const layers = clamp(ini.int('velocitylayers', 'count', 1), 1, 255);
  const thr = new Int32Array(layers);
  for (let i = 1; i < layers; i++) thr[i] = ini.int('velocitylayers', String(i), 128);
  const rate = f32(ini.float('info', 'samplerate', 44100));
  const vf = f32(ini.float('info', 'velocityfactor', 1));
  const relHigh = ini.bool('info', 'releasehighnotes', false);
  const resample = ini.bool('info', 'resample', true);
  const defaults = new Float64Array(KEYS_PARAMS).fill(NaN);
  for (let i = 0; i < KEYS_PARAMS; i++) {
    const s = ini.str('parameters', String(i), '');
    if (s !== '') defaults[i] = clamp(ini.float('parameters', String(i), NaN), 0, 1);
  }

  const root = new Int32Array(count), high = new Int32Array(count), pos = new Int32Array(count);
  const end = new Int32Array(count), loop = new Int32Array(count), start = new Int32Array(count);
  const canLoop = new Uint8Array(count);
  let prevRoot = 60, prevHigh = 999;
  let stereo = false;
  let waves: Int16Array;
  let total: number;
  let fileRate = rate;

  const secOf = (i: number) => 'sample' + i;
  for (let i = 0; i < count; i++) {
    const s = secOf(i);
    root[i] = ini.int(s, 'root', -1);
    if (root[i] === -1) root[i] = prevRoot;
    high[i] = ini.int(s, 'high', -1);
    if (high[i] === -1) high[i] = prevHigh;
    prevRoot = root[i];
    prevHigh = high[i];
    canLoop[i] = infoCanLoop && ini.bool(s, 'canloop', true) ? 1 : 0;
  }

  if (sampleFile) {
    // ---- one sample file for every group (mda Piano, Rhodes: raw 16-bit); the regions are compacted
    if (fileType !== 'raw') throw new KeysTableError('Only raw single-file wavetables and one-file-per-sample RIFF wavetables are supported.');
    const src = files.raw(sampleFile);
    if (!src || src.length < 2) throw new KeysTableError(`The sample file "${sampleFile}" is missing.`);
    if (src.length > MAX_FRAMES) throw new KeysTableError('The sample file is too large.');
    const len = new Int32Array(count);
    const unique = new Uint8Array(count).fill(1);
    for (let i = 0; i < count; i++) {
      const s = secOf(i);
      pos[i] = ini.int(s, 'pos', 0);
      start[i] = pos[i];
      end[i] = ini.int(s, 'end', 0);
      loop[i] = ini.int(s, 'loop', 0);
      len[i] = end[i] - start[i] + 1;
      // a group that starts where the previous one does shares its data (Rhodes' velocity layers of the top keys)
      if (i > 0 && pos[i] === pos[i - 1]) { unique[i] = 0; start[i] = start[i - 1]; }
    }
    // FL's compaction (0x64f20): every unique region copied in turn, followed by one spare frame. A shared
    // group keeps the *old* start of the last unique group (FL does not remap it: its pos / end index the
    // compacted buffer with the old offsets)
    let cur = 0, lastOld = 0;
    const out = new Int16Array(src.length + count + 4);
    for (let i = 0; i < count; i++) {
      if (!unique[i]) {
        start[i] = lastOld;
        pos[i] = start[i];
        end[i] = start[i] + len[i] - 1;
        continue;
      }
      if (len[i] < 1 || start[i] < 0 || start[i] + len[i] > src.length) throw new KeysTableError(`Sample ${i} lies outside the sample file.`);
      out.set(src.subarray(start[i], start[i] + len[i]), cur);
      lastOld = start[i];
      start[i] = cur;
      pos[i] = cur;
      end[i] = cur + len[i] - 1;
      // the frame after the end repeats the one the loop wrap lands on (end - loop + 1: FL's compaction)
      const pad = end[i] - loop[i] + 1;
      out[end[i] + 1] = pad >= 0 && pad < out.length ? out[pad] : 0;
      cur += len[i] + 1;
    }
    waves = out;
    total = src.length + count;
  } else {
    // ---- one RIFF wave per group (Grand Piano, Roto Organ)
    if (fileType !== 'riff') throw new KeysTableError('Only raw single-file wavetables and one-file-per-sample RIFF wavetables are supported.');
    const chunks: { data: Int16Array; frames: number }[] = [];
    const loaded = new Map<string, { base: number; frames: number; loopLen: number; loopEnd: number }>();
    let cur = 0;
    let last = { base: 0, frames: 0, loopLen: 1, loopEnd: 0 };
    for (let i = 0; i < count; i++) {
      const s = secOf(i);
      const name = ini.str(s, 'name', '');
      let info = last;
      if (name) {
        const key = name.toLowerCase();
        const dup = loaded.get(key);
        if (dup) info = dup;
        else {
          const w = files.wave(name);
          if (!w || w.data.length < w.channels) throw new KeysTableError(`The sample file "${name}" is missing.`);
          const st = w.channels === 2;
          if (loaded.size === 0 && Number.isFinite(w.rate) && w.rate >= 1000) fileRate = w.rate;
          if (i > 0 && st !== stereo) throw new KeysTableError('The samples of a wavetable must all be mono or all stereo.');
          stereo = st;
          const N = Math.floor(w.data.length / w.channels);
          if (cur + N + 1 > MAX_FRAMES) throw new KeysTableError('The wavetable is too large.');
          // the file's loop as FL's reader reports it (clamped), default: the whole file
          const ls = clamp(Number.isFinite(w.loopStart) ? w.loopStart : 0, 0, N);
          const le = Math.max(ls, Math.min(N - 1, Number.isFinite(w.loopEnd) ? w.loopEnd : N - 1));
          info = { base: cur, frames: N, loopLen: le - ls + 1, loopEnd: le };
          chunks.push({ data: w.data, frames: N });
          loaded.set(key, info);
          cur += N + 1;
        }
        last = info;
      }
      pos[i] = ini.int(s, 'pos', 0) + info.base;
      start[i] = pos[i];
      end[i] = ini.int(s, 'end', 0) + info.base;
      if (end[i] === info.base) end[i] = info.loopEnd + info.base;
      loop[i] = ini.int(s, 'loop', info.loopLen);
    }
    const ch = stereo ? 2 : 1;
    const out = new Int16Array((cur + 4) * ch);
    let o = 0;
    for (const c of chunks) {
      out.set(c.data.subarray(0, c.frames * ch), o * ch);
      o += c.frames + 1;
    }
    // the spare frame after each group's end, from the frame `loop` before the end (FL's RIFF loader: not
    // end - loop + 1 as the raw compaction does; a group sharing a file with an earlier one repeats it)
    for (let i = 0; i < count; i++) {
      const pad = end[i] - loop[i];
      for (let c = 0; c < ch; c++) {
        const dst = (end[i] + 1) * ch + c, srcI = pad * ch + c;
        if (dst >= 0 && dst < out.length) out[dst] = srcI >= 0 && srcI < out.length ? out[srcI] : 0;
      }
    }
    waves = out;
    total = cur;
  }

  // ---- FL's validation (0x65280)
  for (let i = 0; i < count; i++) {
    root[i] = clamp(root[i], 0, 127);
    high[i] = clamp(high[i], 0, 999);
    pos[i] = clamp(pos[i], 0, total - 1);
    end[i] = clamp(Math.max(end[i], pos[i]), 0, total - 1);
    loop[i] = clamp(loop[i], 0, total - pos[i]);
    if (!canLoop[i]) loop[i] = end[i];
  }

  const ch = stereo ? 2 : 1;
  const nv = Math.min(waves.length, (total + 2) * ch);
  const fl = new Float32Array((total + 2) * ch);
  for (let i = 0; i < nv; i++) fl[i] = waves[i] / 32768;
  return {
    name: ini.str('info', 'name', ''), stereo, rate, fileRate, vf, relHigh, resample: sampleFile ? false : resample, layers, thr,
    root, high, pos, end, loop, waves: fl, frames: total, defaults,
  };
}

// ------------------------------------------------------------------ pool pack
// A wavetable as one mono pool sample: 16-bit words on the 16-bit grid (value k / 32768, which the pool's
// 24-bit storage and float copies keep exactly), a header (int32 / float32 fields as two words each,
// little endian) and the sample buffer.

const MAGIC0 = 0x464b; // 'KF'
const MAGIC1 = 0x5945; // 'EY'
const VERSION = 2;

class Words {
  w: number[] = [];
  i16(v: number) { this.w.push(((v & 0xffff) << 16) >> 16); }
  i32(v: number) { this.i16(v); this.i16(v >> 16); }
}

const F4 = new Float32Array(1);
const U4 = new Uint32Array(F4.buffer);

/** Pack a table into a pool sample's channel (null when it cannot be represented). */
export function packKeysTable(t: KeysTable): Float32Array {
  const n = t.root.length;
  const ch = t.stereo ? 2 : 1;
  const W = new Words();
  W.i16(MAGIC0); W.i16(MAGIC1); W.i16(VERSION);
  W.i16((t.stereo ? 1 : 0) | (t.relHigh ? 2 : 0) | (t.resample ? 4 : 0));
  W.i32(t.frames); W.i32(n); W.i32(t.layers);
  F4[0] = t.rate; W.i32(U4[0] | 0);
  F4[0] = t.vf; W.i32(U4[0] | 0);
  F4[0] = t.fileRate; W.i32(U4[0] | 0);
  for (let i = 0; i < KEYS_PARAMS; i++) {
    const v = t.defaults[i];
    F4[0] = Number.isFinite(v) ? v : 2;
    W.i32(U4[0] | 0);
  }
  const name = t.name.slice(0, 60);
  W.i16(name.length);
  for (let i = 0; i < name.length; i++) W.i16(name.charCodeAt(i) & 0x7fff);
  for (let i = 0; i < t.layers; i++) W.i32(t.thr[i]);
  for (let i = 0; i < n; i++) { W.i32(t.root[i]); W.i32(t.high[i]); W.i32(t.pos[i]); W.i32(t.end[i]); W.i32(t.loop[i]); }
  const head = W.w.length;
  const nw = (t.frames + 2) * ch;
  const out = new Float32Array(head + nw);
  for (let i = 0; i < head; i++) out[i] = W.w[i] / 32768;
  out.set(t.waves.subarray(0, nw), head);
  return out;
}

/** The table a pool sample holds, or null when it is not a valid FL Keys pack. Validates every field (untrusted pool data). */
export function unpackKeysTable(d: Float32Array): KeysTable | null {
  let p = 0;
  const bad = () => p > d.length;
  const w = (): number => (p < d.length ? Math.round(d[p++] * 32768) : (p++, 0));
  const i32 = (): number => { const lo = w() & 0xffff, hi = w(); return (hi << 16) | lo; };
  if (d.length < 40 || w() !== ((MAGIC0 << 16) >> 16) || w() !== MAGIC1 || w() !== VERSION) return null;
  const flags = w();
  const frames = i32(), n = i32(), layers = i32();
  const rateBits = i32(), vfBits = i32(), frBits = i32();
  if (frames < 1 || frames > MAX_FRAMES || n < 1 || n > MAX_GROUPS || layers < 1 || layers > 255) return null;
  U4[0] = rateBits >>> 0; const rate = F4[0];
  U4[0] = vfBits >>> 0; const vf = F4[0];
  U4[0] = frBits >>> 0; const fileRate = F4[0];
  if (!Number.isFinite(rate) || rate < 1000 || rate > 400000 || !Number.isFinite(vf) || vf < 0 || vf > 1000) return null;
  if (!Number.isFinite(fileRate) || fileRate < 1000 || fileRate > 400000) return null;
  const defaults = new Float64Array(KEYS_PARAMS);
  for (let i = 0; i < KEYS_PARAMS; i++) { U4[0] = i32() >>> 0; defaults[i] = F4[0] >= 0 && F4[0] <= 1 ? F4[0] : NaN; }
  const nameLen = w();
  if (nameLen < 0 || nameLen > 60) return null;
  let name = '';
  for (let i = 0; i < nameLen; i++) name += String.fromCharCode(w() & 0x7fff);
  const thr = new Int32Array(layers);
  for (let i = 0; i < layers; i++) thr[i] = i32();
  const root = new Int32Array(n), high = new Int32Array(n), pos = new Int32Array(n), end = new Int32Array(n), loop = new Int32Array(n);
  for (let i = 0; i < n; i++) { root[i] = i32(); high[i] = i32(); pos[i] = i32(); end[i] = i32(); loop[i] = i32(); }
  if (bad()) return null;
  const stereo = (flags & 1) !== 0;
  const ch = stereo ? 2 : 1;
  if (d.length < p + (frames + 2) * ch) return null;
  if (layers > 1 && n % layers !== 0) return null;
  for (let i = 0; i < n; i++) {
    if (root[i] < 0 || root[i] > 127 || high[i] < 0 || high[i] > 999) return null;
    if (pos[i] < 0 || end[i] < pos[i] || end[i] >= frames || loop[i] < 0 || loop[i] > frames) return null;
  }
  return {
    name, stereo, rate, fileRate, vf, relHigh: (flags & 2) !== 0, resample: (flags & 4) !== 0, layers, thr,
    root, high, pos, end, loop, waves: d.subarray(p, p + (frames + 2) * ch), frames, defaults,
  };
}


// ------------------------------------------------------------------ FL's `resample`
/**
 * FL converts a RIFF wavetable's files to the host's sample rate when it loads them (`resample`, on unless the
 * .wti says false) but still plays them with the .wti's rate in its pitch maths: at 48 kHz the Roto Organ sounds
 * 44.1 / 48 flat. This converts a table the same way for an engine running at `sr`: every file (the stretches of
 * the buffer that start at a group's first frame, each followed by a spare frame) on its own, by the 6-point cubic
 * FL's resampler resembles, to round(N r) frames, with the loop positions of the groups scaled (start round(s r),
 * end round((e + 1) r) - 1, round half to even like Delphi's Round) and the frame after each loop end taken
 * from the converted data. Against FL's plugin this matches to -80 .. -90 dB on the Roto Organ (it is FL's 6-point
 * cubic in double precision, rounded to 16 bits) and about -57 dB on a synthetic file with content up to 9 kHz
 * at 32 kHz; very high ratios (96 kHz) and the loop points there are less exact.
 */
export function resampleKeysTable(t: KeysTable, sr: number): KeysTable {
  const r = sr / t.fileRate;
  if (!t.resample || Math.abs(r - 1) < 1e-9) return t;
  const ch = t.stereo ? 2 : 1;
  const n = t.root.length;
  // the files: distinct group starts, in order
  const bases = [...new Set(Array.from(t.pos))].sort((a, b) => a - b);
  const nf = bases.length;
  const len = bases.map((b, k) => (k + 1 < nf ? bases[k + 1] : t.frames) - b - 1);
  const nb = new Array<number>(nf), nl = new Array<number>(nf);
  let cur = 0;
  for (let k = 0; k < nf; k++) { nb[k] = cur; nl[k] = Math.max(1, rne(Math.max(1, len[k]) * r)); cur += nl[k] + 1; }
  const M = cur;
  const out = new Float32Array((M + 3) * ch);
  const src = t.waves;
  for (let k = 0; k < nf; k++) {
    const b0 = bases[k], N = Math.max(1, len[k]);
    for (let c = 0; c < ch; c++) {
      const x = (j: number) => (j < 0 || j >= N ? 0 : src[(b0 + j) * ch + c] * 32768);
      for (let i = 0; i < nl[k]; i++) {
        const p = i / r, j = Math.floor(p), f = p - j;
        const xm2 = x(j - 2), xm1 = x(j - 1), x0 = x(j), x1 = x(j + 1), x2 = x(j + 2), x3 = x(j + 3);
        const a = 1.25 * xm1 - (7 / 3) * x0 + (5 / 3) * x1 - 0.5 * x2 + (1 / 12) * x3 - (1 / 6) * xm2;
        const b = (1 / 12) * (xm2 - x3) + (7 / 12) * (x2 - xm1) + (4 / 3) * (x0 - x1);
        const d = (1 / 12) * (xm2 - x2) + (2 / 3) * (x1 - xm1);
        out[(nb[k] + i) * ch + c] = Math.max(-32768, Math.min(32767, Math.round(((b * f + a) * f + d) * f + x0))) / 32768;
      }
    }
  }
  const pos = new Int32Array(n), end = new Int32Array(n), loop = new Int32Array(n);
  for (let g = 0; g < n; g++) {
    let k = 0;
    while (k + 1 < nf && bases[k + 1] <= t.pos[g]) k++;
    const rel = (x: number) => x - bases[k];
    const looping = t.loop[g] < t.end[g];
    pos[g] = Math.min(M - 1, nb[k] + rne(rel(t.pos[g]) * r));
    if (looping) {
      // the loop in the file's frames, converted: start floor(s r), end floor(e r) + 1
      const e = nb[k] + rne((rel(t.end[g]) + 1) * r) - 1;
      const s = nb[k] + rne(rel(t.end[g] - t.loop[g] + 1) * r);
      end[g] = Math.min(M - 1, e);
      loop[g] = Math.max(0, Math.min(M - pos[g], end[g] - Math.min(end[g], s) + 1));
      for (let c = 0; c < ch; c++) {
        const d = (end[g] + 1) * ch + c, s2 = (end[g] - loop[g]) * ch + c;
        if (d < out.length && s2 >= 0) out[d] = out[s2];
      }
    } else {
      end[g] = Math.min(M - 1, nb[k] + rne((rel(t.end[g]) + 1) * r) - 1);
      loop[g] = end[g];
    }
  }
  return { ...t, fileRate: sr, waves: out, frames: M, pos, end, loop };
}
