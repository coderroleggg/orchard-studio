// SoundFont 2 (RIFF "sfbk") reader for the SoundFont Player: a defensive parser of untrusted files.
// Every offset and size is bounds-checked, counts are capped, odd or truncated chunks are repaired or
// dropped, nothing here throws for bad input (parse functions return null / an error text).
//
// A soundfont is split into the two parts the instrument keeps (see state.ts):
// - the sample pool: the `smpl` chunk (16 bit; the optional `sm24` low bytes are ignored like FL does) becomes one mono WAV
//   in the project's sample pool (the engine receives it with GenEnv.sample), sample header positions
//   index that pool directly;
// - the hydra: the `pdta` chunk (presets, instruments, zones, generators, modulators, sample headers)
//   as it is in the file, kept base64 encoded in the plugin state. The engine and the editor parse it
//   with parseHydra().
// Formats: SF2 2.x (SF2.01 / 2.04 headers). Compressed SF3 / SF4 samples are rejected (no decoder).

/** Largest file the importer accepts (bytes). */
export const SF2_MAX_BYTES = 768 * 1024 * 1024;
/** Caps on the table sizes (the SF2 index fields are 16 bit). */
const MAX_PRESETS = 65535;
const MAX_INSTS = 65535;
const MAX_BAGS = 1 << 20;
const MAX_GENS = 1 << 22;
const MAX_MODS = 1 << 20;
const MAX_SAMPLES = 1 << 20;

export interface Sf2Sample {
  name: string;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  rate: number;
  /** Original MIDI key (root key). */
  pitch: number;
  /** Fine tune correction in cents (signed 8 bit). */
  correction: number;
  /** Sample link (the other half of a stereo pair, or a linked sample). */
  link: number;
  /** sfSampleType: 1 mono, 2 right, 4 left, 8 linked, 0x8000 ROM flag, 0x10 Vorbis (SF3). */
  type: number;
}

export interface Sf2Preset {
  name: string;
  program: number;
  bank: number;
  /** Index of the preset's first zone in pbag. */
  bag: number;
}

export interface Sf2Inst {
  name: string;
  /** Index of the instrument's first zone in ibag. */
  bag: number;
}

/** A modulator record (SF2 section 7.4). */
export interface Sf2Mod {
  src: number;
  dest: number;
  amount: number;
  amtSrc: number;
  trans: number;
}

/** The parsed pdta tables. Bag arrays hold (generator index, modulator index) pairs; gens (oper, amount) pairs. */
export interface Sf2Hydra {
  /** The presets, the terminal record last (its bag is the end of the zones). */
  presets: Sf2Preset[];
  pbag: Uint16Array;
  pmod: Sf2Mod[];
  pgen: Int32Array;
  insts: Sf2Inst[];
  ibag: Uint16Array;
  imod: Sf2Mod[];
  igen: Int32Array;
  /** The samples (terminal record dropped). */
  samples: Sf2Sample[];
}

/** What an SF2 file contains, ready for the editor / importer. */
export interface Sf2Info {
  /** INAM (the soundfont's name), possibly empty. */
  name: string;
  version: [number, number];
  /** Sample points in the pool (smpl / 2). */
  frames: number;
  /** Always false: FL ignores the sm24 chunk. */
  has24: boolean;
  /** The raw pdta chunk contents. */
  pdta: Uint8Array;
  hydra: Sf2Hydra;
  /** Byte range of the smpl chunk and of sm24 in the source buffer. */
  smpl: [number, number];
  sm24: [number, number] | null;
}

export interface Sf2Error { error: string }

// ------------------------------------------------------------------ RIFF helpers
interface Chunk { id: string; start: number; size: number }

function tag(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function i16(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
}

function asciiz(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = b[o + i];
    if (c === 0) break;
    s += (c >= 32 && c < 127) || c >= 160 ? String.fromCharCode(c) : ' ';
  }
  return s.trim();
}

/** The chunks between [start, end): sizes are clipped to the parent, a truncated last chunk is kept short. */
function chunks(b: Uint8Array, start: number, end: number): Chunk[] {
  const out: Chunk[] = [];
  let o = start;
  while (o + 8 <= end && out.length < 4096) {
    const id = tag(b, o);
    let size = u32(b, o + 4);
    const body = o + 8;
    if (size > end - body) size = end - body;
    out.push({ id, start: body, size });
    o = body + size + (size & 1);
  }
  return out;
}

// ------------------------------------------------------------------ pdta
const PHDR = 38, PBAG = 4, PMOD = 10, PGEN = 4, INST = 22, IBAG = 4, IMOD = 10, IGEN = 4, SHDR = 46;

function count(c: Chunk | undefined, rec: number, cap: number): number {
  if (!c) return 0;
  return Math.min(cap, Math.floor(c.size / rec));
}

function readMods(b: Uint8Array, c: Chunk | undefined, cap: number): Sf2Mod[] {
  const n = count(c, PMOD, cap);
  const out: Sf2Mod[] = [];
  for (let i = 0; i < n; i++) {
    const o = c!.start + i * PMOD;
    out.push({ src: u16(b, o), dest: u16(b, o + 2), amount: i16(b, o + 4), amtSrc: u16(b, o + 6), trans: u16(b, o + 8) });
  }
  return out;
}

function readGens(b: Uint8Array, c: Chunk | undefined, cap: number): Int32Array {
  const n = count(c, PGEN, cap);
  const out = new Int32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const o = c!.start + i * PGEN;
    out[i * 2] = u16(b, o);
    out[i * 2 + 1] = i16(b, o + 2);
  }
  return out;
}

function readBags(b: Uint8Array, c: Chunk | undefined): Uint16Array {
  const n = count(c, PBAG, MAX_BAGS);
  const out = new Uint16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const o = c!.start + i * PBAG;
    out[i * 2] = u16(b, o);
    out[i * 2 + 1] = u16(b, o + 2);
  }
  return out;
}

/**
 * Parse the contents of a pdta chunk (the sub-chunks phdr..shdr). Missing or mismatched tables give an
 * empty soundfont (null when there is no usable phdr / inst / shdr at all).
 */
export function parseHydra(pdta: Uint8Array): Sf2Hydra | null {
  const list = chunks(pdta, 0, pdta.length);
  const find = (id: string) => list.find((c) => c.id === id);
  const phdr = find('phdr'), inst = find('inst'), shdr = find('shdr');
  if (!phdr || !inst || !shdr) return null;

  const np = count(phdr, PHDR, MAX_PRESETS + 1);
  const presets: Sf2Preset[] = [];
  for (let i = 0; i < np; i++) {
    const o = phdr.start + i * PHDR;
    presets.push({ name: asciiz(pdta, o, 20), program: u16(pdta, o + 20), bank: u16(pdta, o + 22), bag: u16(pdta, o + 24) });
  }
  const ni = count(inst, INST, MAX_INSTS + 1);
  const insts: Sf2Inst[] = [];
  for (let i = 0; i < ni; i++) {
    const o = inst.start + i * INST;
    insts.push({ name: asciiz(pdta, o, 20), bag: u16(pdta, o + 20) });
  }
  const ns = count(shdr, SHDR, MAX_SAMPLES + 1);
  const samples: Sf2Sample[] = [];
  for (let i = 0; i < ns - 1; i++) {
    const o = shdr.start + i * SHDR;
    samples.push({
      name: asciiz(pdta, o, 20),
      start: u32(pdta, o + 20), end: u32(pdta, o + 24), loopStart: u32(pdta, o + 28), loopEnd: u32(pdta, o + 32),
      rate: u32(pdta, o + 36), pitch: pdta[o + 40], correction: (pdta[o + 41] << 24) >> 24, link: u16(pdta, o + 42), type: u16(pdta, o + 44),
    });
  }

  const pbag = readBags(pdta, find('pbag'));
  const ibag = readBags(pdta, find('ibag'));
  const pgen = readGens(pdta, find('pgen'), MAX_GENS);
  const igen = readGens(pdta, find('igen'), MAX_GENS);
  const pmod = readMods(pdta, find('pmod'), MAX_MODS);
  const imod = readMods(pdta, find('imod'), MAX_MODS);

  // zone ranges are monotonic and stay inside the bag tables (a corrupt file points anywhere); the
  // last record of presets / instruments is the terminal one (EOP / EOI), the real ones precede it
  fixRanges(presets, pbag.length / 2);
  fixRanges(insts, ibag.length / 2);
  return { presets, pbag, pmod, pgen, insts, ibag, imod, igen, samples };
}

function fixRanges(list: { bag: number }[], bags: number): void {
  let prev = 0;
  for (const r of list) {
    if (r.bag < prev) r.bag = prev;
    if (r.bag > bags) r.bag = bags;
    prev = r.bag;
  }
}

// ------------------------------------------------------------------ file
/**
 * Parse an SF2 file: the INFO strings, the pdta tables (validated) and where the sample data is.
 * Returns { error } for files that are not SF2 or that this player cannot play.
 */
export function parseSf2(buf: Uint8Array): Sf2Info | Sf2Error {
  if (buf.length < 12) return { error: 'The file is too short to be a SoundFont.' };
  if (buf.length > SF2_MAX_BYTES) return { error: 'The SoundFont file is too large.' };
  if (tag(buf, 0) !== 'RIFF' || tag(buf, 8) !== 'sfbk') return { error: 'The file is not a SoundFont 2 (RIFF sfbk) file.' };
  let riffEnd = 8 + u32(buf, 4);
  if (riffEnd > buf.length || riffEnd < 12) riffEnd = buf.length;

  let name = '';
  let version: [number, number] = [2, 1];
  let smpl: [number, number] | null = null;
  let sm24: [number, number] | null = null;
  let pdta: Uint8Array | null = null;
  for (const top of chunks(buf, 12, riffEnd)) {
    if (top.id !== 'LIST' || top.size < 4) continue;
    const kind = tag(buf, top.start);
    const sub = chunks(buf, top.start + 4, top.start + top.size);
    if (kind === 'INFO') {
      for (const c of sub) {
        if (c.id === 'INAM') name = asciiz(buf, c.start, Math.min(c.size, 256));
        else if (c.id === 'ifil' && c.size >= 4) version = [u16(buf, c.start), u16(buf, c.start + 2)];
      }
    } else if (kind === 'sdta') {
      for (const c of sub) {
        if (c.id === 'smpl') smpl = [c.start, c.size];
        else if (c.id === 'sm24') sm24 = [c.start, c.size];
      }
    } else if (kind === 'pdta') {
      pdta = buf.subarray(top.start + 4, top.start + top.size);
    }
  }
  if (version[0] < 2 || version[0] > 2) {
    return { error: version[0] >= 3 ? 'SoundFont 3 / 4 files with compressed samples are not supported.' : 'Unsupported SoundFont version.' };
  }
  if (!pdta) return { error: 'The SoundFont has no preset data (pdta).' };
  if (!smpl || smpl[1] < 2) return { error: 'The SoundFont has no sample data (smpl).' };
  const hydra = parseHydra(pdta);
  if (!hydra) return { error: 'The SoundFont preset data is damaged.' };
  const frames = smpl[1] >> 1;
  // FL plays the 16 bit smpl data only: the optional sm24 chunk (the low bytes of 24 bit samples, SF2.04) is ignored (measured with
  // the test host: a 24 bit font renders identically to its 16 bit part), and so it is here
  const has24 = false;
  for (const s of hydra.samples) if (s.type & 0x10) return { error: 'SoundFont 3 files with compressed (Vorbis) samples are not supported.' };
  return { name, version, frames, has24, pdta, hydra, smpl, sm24: has24 ? sm24 : null };
}

export function isSf2Error(x: Sf2Info | Sf2Error): x is Sf2Error {
  return 'error' in x;
}

/** The sample pool of a parsed file as floats (-1..1): the 16 bit smpl data. */
export function sf2Pcm(buf: Uint8Array, info: Sf2Info): Float32Array {
  const [so, sl] = info.smpl;
  const n = info.frames;
  const out = new Float32Array(n);
  const lo = info.sm24 ? info.sm24[0] : -1;
  for (let i = 0; i < n; i++) {
    const o = so + i * 2;
    if (o + 1 >= so + sl) break;
    const hi = ((buf[o] | (buf[o + 1] << 8)) << 16) >> 16;
    out[i] = lo >= 0 ? (hi * 256 + buf[lo + i]) / 8388608 : hi / 32768;
  }
  return out;
}

/** A mono WAV file (16 bit PCM) of the pool: what the sample pool stores. */
export function sf2Wav(buf: Uint8Array, info: Sf2Info, rate = 44100): Uint8Array {
  const n = info.frames;
  const bytes = info.has24 ? 3 : 2;
  const data = n * bytes;
  const out = new Uint8Array(44 + data);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + data, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * bytes, true); dv.setUint16(32, bytes, true); dv.setUint16(34, bytes * 8, true);
  w(36, 'data'); dv.setUint32(40, data, true);
  const [so, sl] = info.smpl;
  const lo = info.sm24 ? info.sm24[0] : -1;
  for (let i = 0; i < n; i++) {
    const o = so + i * 2;
    if (o + 1 >= so + sl) break;
    if (lo >= 0) {
      out[44 + i * 3] = buf[lo + i];
      out[44 + i * 3 + 1] = buf[o];
      out[44 + i * 3 + 2] = buf[o + 1];
    } else {
      out[44 + i * 2] = buf[o];
      out[44 + i * 2 + 1] = buf[o + 1];
    }
  }
  return out;
}

// ------------------------------------------------------------------ base64 (the worklet polyfills atob / btoa)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 text of bytes (no dependency on btoa: runs in the worklet and in tests alike). */
export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  const n = b.length;
  const parts: string[] = [];
  for (let i = 0; i < n; i += 3) {
    const a = b[i], c = i + 1 < n ? b[i + 1] : 0, d = i + 2 < n ? b[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (c >> 4)] + (i + 1 < n ? B64[((c & 15) << 2) | (d >> 6)] : '=') + (i + 2 < n ? B64[d & 63] : '=');
    if (s.length >= 32768) { parts.push(s); s = ''; }
  }
  parts.push(s);
  return parts.join('');
}

const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Bytes of a base64 text (invalid characters are skipped; null for a text that is not base64). */
export function base64ToBytes(text: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 61) break;
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return o ? out.subarray(0, o) : null;
}

/** Parse the hydra a plugin state stores (base64 pdta); null when it is missing or damaged. */
export function hydraFromState(text: unknown): Sf2Hydra | null {
  if (typeof text !== 'string' || !text) return null;
  const b = base64ToBytes(text);
  return b ? parseHydra(b) : null;
}
