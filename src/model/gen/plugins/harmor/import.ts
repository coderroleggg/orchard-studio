// Harmor FL content import (pure part). FL's factory presets hold content that
// is not part of this repository: the dense per-partial curves of waveform
// import / resynthesis (HPart.missing), the image planes (HImage.missing) and
// the resynthesis source audio (HPart.src). The user imports them at runtime
// from their own FL installation (plugin menu "Import FL content..."); this
// file parses FL's preset files DEFENSIVELY (untrusted input: every read is
// bounds checked, sizes are capped, nothing is evaluated) and moves the
// content into the state (curves) or into float samples (image planes).
//
// FL's state format (TTestPlug.SaveRestoreState 0xc6670, part load 0xc7560;
// .flref/harmor/tools/hstate.py decodes version 0x130003): int version, int
// flags (bit 0 part A, bit 1 part B, bit 2 global), the parts (int size, then
// 386 parameters, the unit order, 17 ints and 7 bytes of settings, 43
// articulators, 26 shaping maps, the image, the resynthesis source path), the
// global block. FL's factory .fst files are versions 11, 12, 16, 17 and
// 0x130003; the older ones differ only in:
// - versions < 16 store 385 part parameters (FL inserts a 0 at index 376, the
//   smoothing of articulator target 33) and 42 articulators (target 33 keeps
//   FL's default);
// - versions < 12 store the articulator smoothing values (part parameters
//   343..385) on an older scale, converted on load;
// - versions < 18 save the info text as int length + 8-bit characters, and
//   only version 0x130003 has the trailing flags byte.
// Curves carry their own version (TCustomMEnvelope 0x4443c0): < 2 stores x / y
// as float32, < 1 has no point bytes after the tension, LFOs < 3 no phase.

import type { HArt, HEnv, HImage, HPart } from './types';

export const H_STATE_VERSION = 0x130003;
/** Largest state blob / file accepted (bytes). */
export const MAX_STATE_BYTES = 64 << 20;
/** Largest curve the model keeps (state.ts normalisation). */
export const MAX_CURVE_POINTS = 4096;
/** Largest image plane accepted (rows x cols floats). */
export const MAX_IMAGE_CELLS = 1 << 22;
/** Part parameters 95..342 are the articulators' envelope / LFO values: FL keeps them in the curves (state.ts). */
const ART_PARAMS = [95, 343] as const;

export class HarmorStateError extends Error {}

export interface HRawCurve {
  /** FL curve type: 1 envelope, 2 LFO, 3 mapping. */
  t: number;
  /** Curve version as stored (0..3). */
  v: number;
  /** Points [x, y, tension, b0, b1, b2, b3] (x, y as FL's float32 values). */
  p: number[][];
  m: number[];
  a?: number[];
  l?: number[];
  ph?: number;
}

export interface HRawArt {
  mode: number;
  ea: number;
  la: number;
  e: HRawCurve;
  l: HRawCurve;
  k: HRawCurve[];
}

export interface HRawImage {
  mode: number;
  a58: number;
  a100: number;
  d: number[];
  rows: number;
  cols: number;
  /** Gain, freq and third plane (rows x cols floats, row major); null = absent. */
  planes: (Float32Array | null)[];
}

export interface HRawPart {
  /** The 386 part parameters (old versions converted to FL's current layout). */
  params: number[];
  order: number[];
  /** 17 ints and 7 bytes of settings (hstate.py PART_INT_FIELDS + PART_BYTE_FIELDS). */
  fields: number[];
  /** The 43 articulators; null where an old version has none (FL's default). */
  arts: (HRawArt | null)[];
  maps: HRawCurve[];
  img: HRawImage;
  /** Resynthesis source path as FL saved it. */
  src: string;
}

export interface HRawGlobal {
  params: number[];
  fxOrder: number[];
  fields: number[];
  info: string;
  flags: number;
}

export interface HRawState {
  /** Major version: 11, 12, 16, 17 or 19 (0x130003). */
  version: number;
  flags: number;
  parts: [HRawPart | null, HRawPart | null];
  global: HRawGlobal | null;
  /** Bytes after the parsed data (0 for FL's files; -1: the global block did not parse). */
  rest: number;
}

class Reader {
  readonly dv: DataView;
  p: number;
  /** Apply what FL does after loading (fixLength). */
  fix = true;
  constructor(readonly b: Uint8Array, p = 0, readonly end = b.length) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.p = p;
  }
  need(n: number): void {
    if (!(n >= 0) || this.p + n > this.end) throw new HarmorStateError(`truncated at ${this.p} (+${n} > ${this.end})`);
  }
  i32(): number { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  u8(): number { this.need(1); return this.b[this.p++]; }
  f32(): number { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64(): number { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  ints(n: number): number[] { this.need(4 * n); const out: number[] = []; for (let i = 0; i < n; i++) out.push(this.i32()); return out; }
  bytes(n: number): Uint8Array { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  strLen(): number { const n = this.u8(); return n === 0xff ? this.i32() : n; }
}

const f32 = Math.fround;
/** Finite or 0 (the model keeps finite numbers only). */
const fin = (x: number) => (Number.isFinite(x) ? x : 0);

function utf8(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) cp = c;
    else if (c < 0xe0) cp = ((c & 0x1f) << 6) | ((b[i++] ?? 0) & 0x3f);
    else if (c < 0xf0) { cp = ((c & 0x0f) << 12) | (((b[i] ?? 0) & 0x3f) << 6) | ((b[i + 1] ?? 0) & 0x3f); i += 2; }
    else { cp = ((c & 0x07) << 18) | (((b[i] ?? 0) & 0x3f) << 12) | (((b[i + 1] ?? 0) & 0x3f) << 6) | ((b[i + 2] ?? 0) & 0x3f); i += 3; }
    s += cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
  }
  return s;
}

/** FL's string (0xfa610): byte length (0xff: int length follows), UTF-8; trailing control characters dropped. */
function readStr8(r: Reader, max: number): string {
  const n = r.strLen();
  if (n < 0 || n > max) throw new HarmorStateError(`bad string length ${n}`);
  let s = utf8(r.bytes(n));
  while (s.length && s.charCodeAt(s.length - 1) < 0x20) s = s.slice(0, -1);
  return s;
}

/** FL's UTF-16 string: length in characters (0xff: int length follows), then 2 n bytes. */
function readStr16(r: Reader, max: number): string {
  const n = r.strLen();
  if (n < 0 || n > max) throw new HarmorStateError(`bad string length ${n}`);
  const b = r.bytes(2 * n);
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8));
  return s;
}

/** A curve (TCustomMEnvelope SaveRestore with the TMEnvelope / TMLFO / TMMap extensions). */
function readCurve(r: Reader, expect: number): HRawCurve {
  const t = r.i32();
  if (t !== expect) throw new HarmorStateError(`curve type ${t} at ${r.p - 4} (expected ${expect})`);
  const v = r.i32();
  if (v < 0 || v > 3) throw new HarmorStateError(`curve version ${v} at ${r.p - 4}`);
  const n = r.i32();
  const size = v >= 2 ? 24 : v >= 1 ? 16 : 12;
  if (n < 0 || n > 1 << 20) throw new HarmorStateError(`bad point count ${n} at ${r.p - 4}`);
  r.need(n * size);
  const p: number[][] = [];
  for (let i = 0; i < n; i++) {
    let x: number, y: number;
    if (v < 2) { x = r.f32(); y = r.f32(); } else { x = f32(r.f64()); y = f32(r.f64()); }
    const tension = r.f32();
    const b = v >= 1 ? [r.u8(), r.u8(), r.u8(), r.u8()] : [0, 0, 0, 0];
    p.push([fin(x), fin(y), fin(tension), ...b]);
  }
  const c: HRawCurve = { t, v, p, m: r.ints(5) };
  if (t === 1) c.a = r.ints(4);
  else if (t === 2) { c.l = r.ints(4); c.ph = v >= 3 ? r.i32() : 0; }
  else if (r.fix) fixLength(c);
  return c;
}

/**
 * What FL does after loading a curve of fixed length (0x447d00; mappings:
 * length 1): the point distances are scaled so that they sum to the length
 * (in double, each distance rounded back to float32).
 */
function fixLength(c: HRawCurve, length = 1): void {
  let total = 0;
  for (const q of c.p) total += q[0];
  if (!(total > 0)) return;
  const k = length / total;
  if (k !== 1) for (const q of c.p) q[0] = f32(q[0] * k);
}

function readArt(r: Reader): HRawArt {
  r.i32(); // articulator version (FL ignores it)
  const mode = fin(r.f32()), ea = fin(r.f32()), la = fin(r.f32());
  const e = readCurve(r, 1), l = readCurve(r, 2);
  const k: HRawCurve[] = [];
  for (let j = 0; j < 9; j++) k.push(readCurve(r, 3));
  return { mode, ea, la, e, l, k };
}

function readImage(r: Reader): HRawImage {
  const ver = r.i32();
  if (ver !== 0) throw new HarmorStateError(`image version ${ver} at ${r.p - 4}`);
  const [mode, a58, a100] = r.ints(3);
  const d = [fin(r.f64()), fin(r.f64()), fin(r.f64())];
  const [rows, cols] = r.ints(2);
  const img: HRawImage = { mode, a58, a100, d, rows, cols, planes: [null, null, null] };
  if (mode === 0) {
    for (let k = 0; k < 3; k++) {
      const cnt = r.i32();
      if (!cnt) continue;
      if (rows <= 0 || cols <= 0 || rows * cols > MAX_IMAGE_CELLS || cnt !== rows * cols) {
        throw new HarmorStateError(`image plane of ${cnt} values (${rows} x ${cols}) at ${r.p - 4}`);
      }
      r.need(cnt * 4);
      const pl = new Float32Array(cnt);
      for (let i = 0; i < cnt; i++) pl[i] = fin(r.f32());
      img.planes[k] = pl;
    }
  }
  return img;
}

/** FL's conversion of the articulator smoothing values of versions < 12 (part load 0xc7560). */
export function oldSmoothing(p: number): number {
  const x = f32(f32(p) * f32(0.001));
  const e = f32(Math.exp(x * 3.713572066704308) - 1);
  const v = Math.log2(e * 37.5 * 0.0511 + 1) * 111.11111111111111;
  const r = Math.round(v); // frintx: ties to even
  return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function readPart(r: Reader, ver: number): HRawPart {
  const size = r.i32();
  if (size < 0 || r.p + size > r.end) throw new HarmorStateError(`bad part size ${size} at ${r.p - 4}`);
  const pr = new Reader(r.b, r.p, r.p + size);
  pr.fix = r.fix;
  const params = pr.ints(ver < 16 ? 385 : 386);
  if (ver < 16) params.splice(376, 0, 0);
  if (ver < 12) for (let i = 343; i <= 385; i++) params[i] = oldSmoothing(params[i]);
  const order = pr.ints(12);
  const fields = pr.ints(17);
  for (let i = 0; i < 7; i++) fields.push(pr.u8());
  const arts: (HRawArt | null)[] = [];
  for (let t = 0; t < 43; t++) arts.push(ver < 16 && t === 33 ? null : readArt(pr));
  const maps: HRawCurve[] = [];
  for (let i = 0; i < 26; i++) maps.push(readCurve(pr, 3));
  const img = readImage(pr);
  const src = readStr8(pr, 4096);
  if (pr.p !== pr.end) throw new HarmorStateError(`part block: ${pr.end - pr.p} bytes left over`);
  r.p = pr.end;
  return { params, order, fields, arts, maps, img, src };
}

function readGlobal(r: Reader, ver: number): HRawGlobal {
  const params = r.ints(53), fxOrder = r.ints(6);
  const fields = r.ints(14);
  for (let i = 0; i < 5; i++) fields.push(r.u8());
  let info = '';
  if (ver < 18) {
    const n = r.i32();
    if (n < 0 || n > 1 << 16) throw new HarmorStateError(`bad info length ${n}`);
    for (const c of r.bytes(n)) info += String.fromCharCode(c);
  } else info = readStr16(r, 1 << 16);
  const flags = ver > 18 ? r.u8() : 0;
  return { params, fxOrder, fields, info, flags };
}

/**
 * Parse a Harmor state blob (versions 11, 12, 16, 17 and 0x130003) into what
 * FL holds after loading it (`asSaved`: the values as stored). Throws
 * HarmorStateError on bad input.
 */
export function parseHarmorState(blob: Uint8Array, asSaved = false): HRawState {
  if (blob.length > MAX_STATE_BYTES) throw new HarmorStateError('state too large');
  const r = new Reader(blob);
  r.fix = !asSaved;
  let ver = r.i32();
  if (ver < 0 || ver > H_STATE_VERSION) throw new HarmorStateError(`state version ${ver}: not supported`);
  if (ver >= 0x10000) ver >>= 16;
  if (ver !== 11 && ver !== 12 && ver !== 16 && ver !== 17 && ver !== 19) throw new HarmorStateError(`state version ${ver}: not supported`);
  const flags = r.i32();
  const parts: [HRawPart | null, HRawPart | null] = [null, null];
  if (flags & 1) parts[0] = readPart(r, ver);
  if (flags & 2) parts[1] = readPart(r, ver);
  let global: HRawGlobal | null = null, rest = 0;
  if (flags & 4) {
    // the parts are what the import needs: a global block that does not parse leaves them usable
    try { global = readGlobal(r, ver); } catch { rest = -1; }
  }
  if (rest === 0) rest = r.end - r.p;
  return { version: ver, flags, parts, global, rest };
}

/**
 * The plugin state of an FL event file (.fst preset: FLhd header, FLdt chunk,
 * event 213 = plugin data); a raw state blob is returned as is. Null when the
 * file holds no plugin state.
 */
export function flPluginState(file: Uint8Array): Uint8Array | null {
  if (file.length > MAX_STATE_BYTES) return null;
  const tag = (o: number) => String.fromCharCode(file[o], file[o + 1], file[o + 2], file[o + 3]);
  if (file.length < 8 || tag(0) !== 'FLhd') return file;
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let p = 8 + dv.getUint32(4, true);
  if (p + 8 > file.length || tag(p) !== 'FLdt') return null;
  const end = Math.min(file.length, p + 8 + dv.getUint32(p + 4, true));
  p += 8;
  let blob: Uint8Array | null = null;
  while (p < end) {
    const ev = file[p++];
    let n: number;
    if (ev < 64) n = 1;
    else if (ev < 128) n = 2;
    else if (ev < 192) n = 4;
    else {
      n = 0;
      for (let sh = 0; ; sh += 7) {
        if (p >= end || sh > 28) return blob;
        const b = file[p++];
        n += (b & 0x7f) * 2 ** sh;
        if (!(b & 0x80)) break;
      }
    }
    if (p + n > end) return blob;
    if (ev === 213) blob = file.subarray(p, p + n);
    p += n;
  }
  return blob;
}

/** Parse an FL preset file (.fst) or a raw state; null when it is not a Harmor state. */
export function parseHarmorFile(file: Uint8Array): HRawState | null {
  const blob = flPluginState(file);
  if (!blob) return null;
  try { return parseHarmorState(blob); } catch { return null; }
}

// ------------------------------------------------------------ model form

/** The shortest decimal that reads back as the same float32 (the model's numbers, gen_model.py f32s). */
export function f32num(x: number): number {
  const v = f32(x);
  if (v === 0 || !Number.isFinite(v)) return 0;
  for (let d = 1; d <= 9; d++) {
    const s = Number(v.toPrecision(d));
    if (f32(s) === v) return s;
  }
  return v;
}

/** A raw curve in the model's form (points [dx, y, tension, segment type, arpeggio break, b2], trailing zeros dropped). */
export function modelCurve(c: HRawCurve): HEnv {
  const p = c.p.map((q) => {
    // FL recomputes the point kind (b3) when it loads a curve: the model does not keep it
    const row = [f32num(q[0]), f32num(q[1]), f32num(q[2]), q[3], q[4], q[5]];
    while (row.length > 2 && row[row.length - 1] === 0) row.pop();
    return row;
  });
  const e: HEnv = { t: c.t, p, m: c.m.slice() };
  if (c.a) e.a = c.a.slice();
  if (c.l) { e.l = c.l.slice(); e.ph = c.ph ?? 0; }
  return e;
}

export function modelArt(a: HRawArt): HArt {
  return { mode: f32num(a.mode), ea: f32num(a.ea), la: f32num(a.la), e: modelCurve(a.e), l: modelCurve(a.l), k: a.k.map(modelCurve) };
}

const sameNums = (a: readonly number[] | undefined, b: readonly number[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));

/** Same curve (model form; a missing trailing point value counts as 0). */
export function sameCurve(a: HEnv, b: HEnv): boolean {
  if (a.t !== b.t || !sameNums(a.m, b.m) || a.p.length !== b.p.length) return false;
  if (!sameNums(a.a, b.a) || !sameNums(a.l, b.l) || (a.ph ?? 0) !== (b.ph ?? 0)) return false;
  return a.p.every((q, i) => {
    const r = b.p[i];
    for (let j = 0; j < 6; j++) if ((q[j] ?? 0) !== (r[j] ?? 0)) return false;
    return true;
  });
}

const MISSING_RE = /^(?:m(\d+)|a(\d+)(?:(e)|(l)|k(\d+)))$/;

/** The raw curve behind an HPart.missing key ('m<i>', 'a<t>e', 'a<t>l', 'a<t>k<j>'); null when absent. */
export function rawCurveFor(part: HRawPart, key: string): HRawCurve | null {
  const m = MISSING_RE.exec(key);
  if (!m) return null;
  if (m[1] !== undefined) return part.maps[+m[1]] ?? null;
  const art = part.arts[+m[2]];
  if (!art) return null;
  return m[3] ? art.e : m[4] ? art.l : art.k[+m[5]] ?? null;
}

/** The curve of a model part behind a curve key (see rawCurveFor). */
export function curveFor(hp: HPart, key: string): HEnv | null {
  const m = MISSING_RE.exec(key);
  if (!m) return null;
  if (m[1] !== undefined) return hp.maps[+m[1]] ?? null;
  const art = hp.arts[+m[2]];
  if (!art) return null;
  return m[3] ? art.e : m[4] ? art.l : art.k[+m[5]] ?? null;
}

/** Every curve key of a part (43 articulators x 11 curves, 26 maps). */
export const CURVE_KEYS: string[] = (() => {
  const out: string[] = [];
  for (let t = 0; t < 43; t++) {
    out.push(`a${t}e`, `a${t}l`);
    for (let j = 0; j < 9; j++) out.push(`a${t}k${j}`);
  }
  for (let i = 0; i < 26; i++) out.push(`m${i}`);
  return out;
})();

/**
 * How well a parsed FL part matches a model part, 0..1: the share of equal
 * curves among those the model part has (HPart.missing excluded) and of equal
 * part parameters (the articulator values 95..342 live in the curves). A
 * part loaded from the same preset scores 1 until the user edits it.
 * `params(i)` = the model's part parameter i.
 */
export function partScore(hp: HPart, params: (i: number) => unknown, raw: HRawPart): number {
  const miss = new Set(hp.missing ?? []);
  let same = 0, n = 0;
  for (const key of CURVE_KEYS) {
    if (miss.has(key)) continue;
    const a = curveFor(hp, key), b = rawCurveFor(raw, key);
    if (!a || !b) continue;
    n++;
    if (b.p.length === a.p.length && sameCurve(a, modelCurve(b))) same++;
  }
  let ps = 0, pn = 0;
  for (let i = 0; i < raw.params.length; i++) {
    if (i >= ART_PARAMS[0] && i < ART_PARAMS[1]) continue;
    pn++;
    if (params(i) === raw.params[i]) ps++;
  }
  return 0.5 * (n ? same / n : 0) + 0.5 * (pn ? ps / pn : 0);
}

// ------------------------------------------------------------- the import

/** What a part lacks: FL content curves, the image planes, the resynthesis source audio. */
export interface PartNeeds {
  curves: string[];
  image: boolean;
  source: boolean;
}

/** The FL content a part state lacks; `haveSource` = a resynthesis sample is already in the state. */
export function partNeeds(hp: HPart | undefined, haveImage = false, haveSource = false): PartNeeds {
  return {
    curves: hp?.missing ? hp.missing.slice() : [],
    image: !!hp?.img?.missing && !haveImage,
    source: !!hp && hp.img?.mode === 1 && !!hp.src && !haveSource,
  };
}

export const needsAny = (n: PartNeeds) => n.curves.length > 0 || n.image || n.source;

/**
 * Fill the curves a part lacks (HPart.missing) from a parsed FL part, in
 * place (an Immer draft or a copy); filled keys leave the list. Returns the
 * filled keys and those the file did not have (empty or over MAX_CURVE_POINTS).
 */
export function fillCurves(hp: HPart, raw: HRawPart): { filled: string[]; absent: string[] } {
  const filled: string[] = [], absent: string[] = [];
  for (const key of hp.missing ?? []) {
    const c = rawCurveFor(raw, key);
    const m = MISSING_RE.exec(key);
    if (!c || !m || c.p.length === 0 || c.p.length > MAX_CURVE_POINTS) { absent.push(key); continue; }
    const e = modelCurve(c);
    if (m[1] !== undefined) {
      if (!hp.maps[+m[1]]) { absent.push(key); continue; }
      hp.maps[+m[1]] = e;
    } else {
      const art = hp.arts[+m[2]];
      if (!art) { absent.push(key); continue; }
      if (m[3]) art.e = e;
      else if (m[4]) art.l = e;
      else if (art.k[+m[5]]) art.k[+m[5]] = e;
      else { absent.push(key); continue; }
    }
    filled.push(key);
  }
  if (filled.length) {
    if (absent.length) hp.missing = absent.slice();
    else delete hp.missing;
  }
  return { filled, absent };
}

/** The image planes of a parsed part when they are the ones a model part lacks (same size, planes present). */
export function imageFor(hp: HPart, raw: HRawPart): HRawImage | null {
  const im = raw.img;
  if (!hp.img?.missing || im.mode !== 0 || im.rows !== hp.img.h || im.cols !== hp.img.w) return null;
  return im.planes.some(Boolean) ? im : null;
}

/**
 * Image planes as one float sample for the pool (`a_imgSample` / `b_imgSample`):
 * plane k (0 gain, 1 freq, 2 third) at frames [k n, (k + 1) n) with n = rows x
 * cols in FL's row major order (rows = HImage.h, cols = HImage.w); absent
 * planes are zeros. The values are scaled by IMG_PLANE_SCALE (powers of two:
 * exact) so that they stay within -1..1 through the pool's WAV storage
 * (FL's gain plane is 0..255, its freq plane about -1.3..1.3).
 */
export const IMG_PLANE_SCALE = [1 / 256, 1 / 2, 1 / 256] as const;

export function imagePlanesSample(img: HRawImage): Float32Array {
  const n = img.rows * img.cols;
  const out = new Float32Array(3 * n);
  img.planes.forEach((pl, k) => {
    if (!pl || pl.length !== n) return;
    const s = IMG_PLANE_SCALE[k];
    for (let i = 0; i < n; i++) out[k * n + i] = Math.max(-1, Math.min(1, pl[i] * s));
  });
  return out;
}

/** The image planes of a pool sample made by imagePlanesSample (unscaled), null when the size does not fit. */
export function samplePlanes(data: Float32Array, rows: number, cols: number): Float32Array[] | null {
  const n = rows * cols;
  if (n <= 0 || data.length < 3 * n) return null;
  return IMG_PLANE_SCALE.map((s, k) => {
    const pl = data.slice(k * n, (k + 1) * n);
    for (let i = 0; i < n; i++) pl[i] /= s;
    return pl;
  });
}

/** Mark a part's image as present once its planes are in the pool. */
export function markImage(img: HImage): void {
  delete img.missing;
}

/** A mono 32-bit float WAV (44.1 kHz) of float data (the pool stores user samples as files). */
export function floatWav(data: Float32Array, rate = 44100): ArrayBuffer {
  const buf = new ArrayBuffer(44 + data.length * 4);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + data.length * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 32, true);
  str(36, 'data'); dv.setUint32(40, data.length * 4, true);
  new Float32Array(buf, 44, data.length).set(data);
  return buf;
}

/** A path's components, lower case ('\' and '/' separators, FL's %...% placeholders kept as components). */
export function pathParts(path: string): string[] {
  return path.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
}

/**
 * The picked file a saved FL path refers to: the longest common suffix of
 * path components (at least the file name). `files` are [lower case relative
 * path parts, file] pairs.
 */
export function matchPath<T>(path: string, files: [string[], T][]): T | null {
  const want = pathParts(path);
  if (!want.length) return null;
  let best: T | null = null, bestN = 0;
  for (const [parts, f] of files) {
    let n = 0;
    while (n < want.length && n < parts.length && want[want.length - 1 - n] === parts[parts.length - 1 - n]) n++;
    if (n > bestN) { best = f; bestN = n; }
  }
  return best;
}
