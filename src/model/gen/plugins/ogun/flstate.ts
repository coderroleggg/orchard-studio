// Ogun FL state reader (pure part of "Import FL content..."). FL's factory presets (.fst files: FLhd / FLdt event
// chunks, event 213 = plugin state) hold what Orchard Studio does not ship: the dense harmonic maps of resynthesis
// presets (OgEnv curves of up to 32 000 points). The user imports them at run time from their own FL install; this
// file reads those files DEFENSIVELY (untrusted input: every read is bounds checked, sizes and counts are capped,
// nothing is evaluated) into the model's form (types.ts).
//
// FL's state (TTestPlug.SaveRestoreState 0x68750, .flref/special/ogun-ui/saverestore_68750.txt): u32 version, then
// zlib( ints, bytes, EQ types, info, 13 articulators, 4 maps ). The version is FL's state version (0 .. 14 in the
// factory files, 0x120003 / 0x130003 = major 18 / 19 in the newer ones: major = version >> 16 when version >= 0x10000).
// What each major version stores (verified against all 229 factory presets, every version they use: 0 1 4 7 8 9 11 12
// 13 14 18, by comparing with the states FL's own plugin re-saved, tests/gen/ogun-ui.test.ts):
// - parameters 0..48: version < 8 has no master fine pitch (parameter 2 = 0);
// - the settings block (plug+0x200 .. 0x23b, ints 49..63) grows with the version: +1 byte at 0x21f (v1), +3 bytes 0x220..
//   0x222 (v2), +1 byte 0x223 (v7), +16 bytes 0x224..0x233 (the four harmonic combs, v9), +1 byte 0x234 (alt decay, v11),
//   +1 byte 0x235 (auto loudness, v12), +6 bytes 0x236..0x23b (natural EQ weighting, magic dust, v13); what an old
//   version lacks keeps FL's defaults (porta variable time on, magic dust 430...);
// - 3 bytes (plug+0x368: delay tempo / delay enable / unused) and 3 ints (EQ band types 1..3);
// - the info text: version < 18 an RTF stream (int byte count + RichEdit RTF), else UTF-16 (length byte + chars);
// - 13 articulators (int version, 3 floats, envelope, LFO, 4 mapping curves); versions < 4 lack articulators 4 and 5
//   (unison pitch / phase), versions < 10 lack 11 and 12 (timbre rotation / EQ shifting): FL's defaults;
// - 4 maps; version < 5 lacks the forced harmonics map (default); versions < 6 store the maps on the old linear
//   harmonic scale: FL converts them to the octave scale while loading (convertOldMap).
// A curve (TCustomMEnvelope) carries its own version: < 2 stores x / y as float32, < 1 has no point bytes after the
// tension, LFOs < 3 have no phase. After loading, FL recomputes the point kind (byte b3: -1 / 1 by the sign of the
// tension, 2 for a flat tension on types 0 1 7 8 9 11 12) and scales the distances of every mapping so that they sum
// to 1 (in double, each distance rounded to float32).

import type { OgArt, OgEnv } from './types';

/** Newest state version FL writes (and reads). */
export const OG_FL_VERSION = 0x130003;
/** Largest file / state blob and largest decompressed state accepted (bytes). */
export const OG_MAX_FILE_BYTES = 64 << 20;
export const OG_MAX_STATE_BYTES = 128 << 20;
/** Largest curve read (points): FL's resynthesis maps have up to 32 767 harmonics. */
export const OG_MAX_CURVE_POINTS = 1 << 17;
/** Largest info text read (characters). */
const MAX_INFO = 1 << 16;

export class OgunStateError extends Error {}

/** What FL holds after loading a state, in the model's form. */
export interface OgFlState {
  /** Major state version the state was saved with (0 .. 19). */
  version: number;
  /** The 64 state ints: parameters 0..48 and the settings 49..63 (state.ts `xi`). */
  ints: number[];
  /** plug+0x368: delay tempo-based time, delay enabled, unused. */
  b3: number[];
  /** EQ band types 1..3 (0 low shelf, 1 peaking, 2 high shelf). */
  eq: number[];
  info: string;
  arts: OgArt[];
  maps: OgEnv[];
  /** Objects FL does not read for this version and fills with its defaults: 'a4', 'a5', 'a11', 'a12', 'm0'. */
  defaulted: string[];
  /** Maps converted from the old linear scale (version < 6): 'm1'.. */
  converted: string[];
  /** Autogun's states (parseOgunState `autogun`): the preset counter (plug+0x620, since version 19), the seed of the generated preset. */
  counter?: number;
}

const f32 = Math.fround;
/** Finite or 0 (the model keeps finite numbers only). */
const fin = (x: number): number => (Number.isFinite(x) ? x : 0);

class Reader {
  readonly b: Uint8Array;
  readonly end: number;
  readonly dv: DataView;
  p: number;
  constructor(b: Uint8Array, p = 0, end = b.length) {
    this.b = b;
    this.end = end;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.p = p;
  }
  need(n: number): void {
    if (!(n >= 0) || this.p + n > this.end) throw new OgunStateError(`truncated at ${this.p} (+${n} > ${this.end})`);
  }
  i32(): number { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  u8(): number { this.need(1); return this.b[this.p++]; }
  f32(): number { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64(): number { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  ints(n: number): number[] { this.need(4 * n); const o: number[] = []; for (let i = 0; i < n; i++) o.push(this.i32()); return o; }
  bytes(n: number): Uint8Array { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  /** A string length: a byte, 0xff = an int follows. */
  strLen(): number { const n = this.u8(); return n === 0xff ? this.i32() : n; }
}

// ------------------------------------------------------------------ zlib

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huff { count: Uint16Array; sym: Uint16Array }

function build(lengths: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  const sym = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
  return { count, sym };
}

/** Raw DEFLATE (RFC 1951) with an output cap (a decompression bomb throws instead of filling memory). */
export function inflateCapped(src: Uint8Array, maxOut: number): Uint8Array {
  let out = new Uint8Array(Math.min(maxOut, Math.max(1024, src.length * 4)));
  let op = 0, pos = 0, bitBuf = 0, bitCnt = 0;
  const need = (n: number) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new OgunStateError('inflate: truncated');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
  };
  const bits = (n: number): number => {
    if (n === 0) return 0;
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h: Huff): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new OgunStateError('inflate: bad code');
  };
  const ensure = (n: number) => {
    if (op + n > maxOut) throw new OgunStateError('inflate: state too large');
    if (op + n <= out.length) return;
    const grown = new Uint8Array(Math.min(maxOut, Math.max(out.length * 2, op + n)));
    grown.set(out.subarray(0, op));
    out = grown;
  };
  let fixedLit: Huff | null = null, fixedDist: Huff | null = null;
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      if (pos + 4 > src.length) throw new OgunStateError('inflate: truncated');
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (pos + len > src.length) throw new OgunStateError('inflate: truncated');
      ensure(len);
      out.set(src.subarray(pos, pos + len), op);
      op += len; pos += len;
      continue;
    }
    let lit: Huff, dist: Huff;
    if (type === 1) {
      if (!fixedLit) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
        fixedLit = build(l, 288);
        fixedDist = build(new Uint8Array(30).fill(5), 30);
      }
      lit = fixedLit; dist = fixedDist!;
    } else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clh = build(cl, 19);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const s = decode(clh);
        if (s < 16) lens[i++] = s;
        else if (s === 16) {
          if (i === 0) throw new OgunStateError('inflate: bad lengths');
          const r = 3 + bits(2), p = lens[i - 1];
          if (i + r > lens.length) throw new OgunStateError('inflate: bad lengths');
          for (let k = 0; k < r; k++) lens[i++] = p;
        } else {
          const r = s === 17 ? 3 + bits(3) : 11 + bits(7);
          if (i + r > lens.length) throw new OgunStateError('inflate: bad lengths');
          i += r;
        }
      }
      lit = build(lens.subarray(0, hlit), hlit);
      dist = build(lens.subarray(hlit), hdist);
    } else throw new OgunStateError('inflate: bad block type');
    for (;;) {
      const s = decode(lit);
      if (s < 256) { ensure(1); out[op++] = s; continue; }
      if (s === 256) break;
      const li = s - 257;
      if (li >= LEN_BASE.length) throw new OgunStateError('inflate: bad length code');
      const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
      const di = decode(dist);
      if (di >= DIST_BASE.length) throw new OgunStateError('inflate: bad distance code');
      const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
      if (d > op) throw new OgunStateError('inflate: bad distance');
      ensure(len);
      for (let k = 0; k < len; k++, op++) out[op] = out[op - d];
    }
  }
  return out.subarray(0, op);
}

/** A zlib stream (2 byte header, DEFLATE, Adler-32 trailer which is not checked) to bytes. */
export function inflateZlib(src: Uint8Array, maxOut = OG_MAX_STATE_BYTES): Uint8Array {
  if (src.length < 3 || (src[0] & 15) !== 8 || ((src[0] << 8) | src[1]) % 31 !== 0 || (src[1] & 0x20)) throw new OgunStateError('not a zlib stream');
  return inflateCapped(src.subarray(2), maxOut);
}

// ------------------------------------------------------------------ text

const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
const cp1252 = (c: number): string => String.fromCharCode(c >= 0x80 && c < 0xa0 ? CP1252[c - 0x80] : c);

/** RTF destinations whose content is not text. */
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'listtable', 'listoverridetable', 'generator']);

/**
 * The plain text of the RTF FL's info memo (RichEdit) saved in versions < 18: paragraphs (\par) joined by CR, the last
 * \par ending the last paragraph (3 \par = 3 lines; a trailing empty paragraph gives a trailing CR). Text that is not RTF
 * is taken as 8-bit characters.
 */
export function rtfToText(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  if (!s.startsWith('{\\rtf')) return s.replace(/\0+$/, '').slice(0, MAX_INFO);
  const paras: string[] = [];
  let cur = '';
  let depth = 0, skip = 0;
  let i = 0;
  while (i < s.length && paras.length < MAX_INFO) {
    const c = s[i];
    if (c === '{') {
      depth++; i++;
      if (!skip && s[i] === '\\') {
        if (s[i + 1] === '*') skip = depth;
        else {
          let k = i + 1;
          while (k < s.length && /[a-z]/i.test(s[k])) k++;
          if (RTF_SKIP.has(s.slice(i + 1, k))) skip = depth;
        }
      }
      continue;
    }
    if (c === '}') { if (skip === depth) skip = 0; if (depth > 0) depth--; i++; continue; }
    if (c === '\\') {
      i++;
      const c2 = s[i];
      if (c2 === undefined) break;
      if (c2 === '\\' || c2 === '{' || c2 === '}') { if (!skip) cur += c2; i++; continue; }
      if (c2 === "'") {
        const h = parseInt(s.slice(i + 1, i + 3), 16);
        i += 3;
        if (!skip && Number.isFinite(h)) cur += cp1252(h);
        continue;
      }
      if (c2 === '~') { if (!skip) cur += ' '; i++; continue; }
      let k = i;
      while (k < s.length && /[a-z]/i.test(s[k])) k++;
      if (k === i) { i++; continue; }
      const word = s.slice(i, k);
      let m = k;
      if (s[m] === '-' || (s[m] >= '0' && s[m] <= '9')) { m++; while (m < s.length && s[m] >= '0' && s[m] <= '9') m++; }
      const arg = s.slice(k, m);
      i = m;
      if (s[i] === ' ') i++;
      if (skip) continue;
      if (word === 'par') { paras.push(cur); cur = ''; }
      else if (word === 'tab') cur += '\t';
      else if (word === 'line') cur += '\v';
      else if (word === 'u') {
        const n = parseInt(arg, 10);
        if (Number.isFinite(n)) cur += String.fromCharCode(n & 0xffff);
        if (i < s.length) i++; // the ANSI fallback character
      }
      continue;
    }
    if (c === '\r' || c === '\n' || c === '\0') { i++; continue; }
    if (!skip) cur += c;
    i++;
  }
  if (cur) paras.push(cur);
  return paras.join('\r').slice(0, MAX_INFO);
}

// ------------------------------------------------------------------ curves

/** FL's point types whose flat tension gets kind 2 (the others keep the sign of the tension: 0). */
const KIND2 = new Set([0, 1, 7, 8, 9, 11, 12]);

/** The kind byte of a point after FL's update (tension sign; 2 for a flat tension on the point types above). */
export function pointKind(tension: number, type: number): number {
  if (tension === 0) return KIND2.has(type) ? 2 : 0;
  return tension > 0 ? 1 : 255;
}

/**
 * FL's fixed length of a mapping (TCustomMEnvelope 0x25f850, length 1): a first point at 0 when the curve starts later, then
 * the distances are scaled (in double) so that they sum to the length; a curve without length gets a last point at it.
 */
export function fixLength(p: number[][]): void {
  if (!p.length) { p.push([0, 0, 0, 0, 0, 0, 0]); } else if (p[0][0] > 0) p.unshift([0, p[0][1], 0, 0, 0, 0, 0]);
  let total = 0;
  for (const q of p) total += q[0];
  if (!(total > 0)) { p.push([1, p[p.length - 1][1], 0, 0, 0, 0, 0]); return; }
  const k = 1 / total;
  if (k !== 1) for (const q of p) q[0] = q[0] * k;
}

/** A curve (TCustomMEnvelope.SaveRestore 0x25c0a0 with the TMEnvelope / TMLFO / TMMap extensions). */
function readCurve(r: Reader, expect: number, fix: boolean): OgEnv {
  const t = r.i32();
  if (t !== expect) throw new OgunStateError(`curve type ${t} at ${r.p - 4} (expected ${expect})`);
  const v = r.i32();
  if (v < 0 || v > 3) throw new OgunStateError(`curve version ${v} at ${r.p - 4}`);
  const n = r.i32();
  if (n < 0 || n > OG_MAX_CURVE_POINTS) throw new OgunStateError(`bad point count ${n} at ${r.p - 4}`);
  r.need(n * (v >= 2 ? 24 : v >= 1 ? 16 : 12));
  const p: number[][] = [];
  for (let i = 0; i < n; i++) {
    let x: number, y: number;
    if (v < 2) { x = r.f32(); y = r.f32(); } else { x = r.f64(); y = r.f64(); }
    const tension = r.f32();
    const b = v >= 1 ? [r.u8(), r.u8(), r.u8(), r.u8()] : [0, 0, 0, 0];
    p.push([x, y, tension, b[0], b[1], b[2], b[3]]);
  }
  const m = r.ints(5);
  const e: OgEnv = { t, p, m };
  if (t === 1) e.a = r.ints(4);
  else if (t === 2) { e.l = r.ints(4); e.ph = v >= 3 ? r.i32() : 0; }
  else if (fix) fixLength(p);
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    q[0] = fin(q[0]); q[1] = f32(fin(q[1])); q[2] = f32(fin(q[2]));
    // FL recomputes the kind of every point but the first when it loads a curve
    if (fix && i > 0) q[6] = pointKind(q[2], q[3]);
  }
  return e;
}

function readArt(r: Reader, fix: boolean): OgArt {
  r.i32(); // articulator version (FL ignores it)
  const mode = f32(fin(r.f32())), ea = f32(fin(r.f32())), la = f32(fin(r.f32()));
  const e = readCurve(r, 1, fix), l = readCurve(r, 2, fix);
  const k: OgEnv[] = [];
  for (let j = 0; j < 4; j++) k.push(readCurve(r, 3, fix));
  return { mode, ea, la, e, l, k };
}

// ---------------------------------------------------------------- defaults

const defEnv = (): OgEnv => ({
  t: 1, m: [0, 0, 1, -1, 2], a: [128, 128, 0, 128],
  p: [[0, 0, 0, 0, 0, 0, 0], [0.75, 1, f32(0.2), 0, 0, 0, 1], [1.5, 0.5, f32(0.2), 0, 0, 0, 1], [0.25, 0, f32(0.2), 0, 0, 0, 1]],
});
const defLfo = (): OgEnv => ({
  t: 2, m: [0, 0, -1, -1, 2], l: [40898, 0, 0, 0], ph: 0,
  p: [[0, 0.5, 0, 0, 0, 0, 0], [1, 0.5, 0, 0, 0, 0, 2], [0.25, 1, 0, 0, 0, 0, 2], [1, 0.5, 0, 0, 0, 0, 2]],
});
const defMap = (y: number): OgEnv => ({ t: 3, m: [0, -1, -1, -1, -1], p: [[0, y, 0, 0, 0, 0, 0], [1, y, 0, 0, 0, 0, 0]] });

/** FL's default articulator (TOpArticulator.Reset + 0x6a570): mappings at 1 for the unison articulators, 0.5 for the others. */
export function defaultArt(i: number): OgArt {
  const mid = i === 1 || i === 2 || i === 3 || i === 9 || i === 11 || i === 12;
  return { mode: 0, ea: 1, la: 1, e: defEnv(), l: defLfo(), k: [0, 1, 2, 3].map(() => defMap(mid ? 0.5 : 1)) };
}

/** FL's default forced harmonics map (versions < 5 do not store it). */
export function defaultForcedMap(): OgEnv {
  return defMap(0);
}

// -------------------------------------------------------- old (linear) maps

const LN1E6 = 13.815511557963774;

/** A map as FL's reader sees it (TCustomMEnvelope Changed 0x448ad0 for the segment types 0 / 1 / 2, reader 0x263ec0). */
interface OldMap { n: number; x: number[]; y: number[]; c0: number[]; c1: number[]; c2: number[]; seg: number[]; kind: number[] }

function compileOld(pts: number[][]): OldMap {
  const n = pts.length;
  const m: OldMap = { n, x: [], y: [], c0: [], c1: [], c2: [], seg: [], kind: [] };
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    const sg = q[3] ?? 0;
    m.x.push(q[0]); m.y.push(f32(q[1])); m.seg.push(sg);
    let c0 = 0, c1 = 0, c2 = 0, kind = 0;
    if (i > 0) {
      const tn = f32(q[2]);
      kind = tn === 0 ? 0 : tn < 0 ? -1 : 1;
      const e = f32(Math.exp(f32(Math.abs(tn)) * LN1E6) - 1);
      c0 = f32(tn === 0 ? 0 : tn < 0 ? -e : e);
      if (c0 !== 0) {
        const av = f32(Math.abs(c0));
        c1 = f32(1 / av);
        c2 = f32(Math.log(f32(av + 1)));
      }
      if (sg < 2 && tn === 0) kind = 2;
    }
    m.c0.push(c0); m.c1.push(c1); m.c2.push(c2); m.kind.push(kind);
  }
  return m;
}

/** FL's tension curve on u with the coefficients of a point (double). */
function tcurve(k: number, a: number, b: number, u: number): number {
  if (k === 0) return u;
  if (k > 0) return 1 - (Math.exp((1 - u) * b) - 1) * a;
  return (Math.exp(u * b) - 1) * a;
}

/** The segment shape of point i at position t (the point types 0 'single', 1 'double', 2 'hold'; others read as 0). */
function shapeOld(m: OldMap, i: number, t: number): number {
  if (m.kind[i] === 2) return t;
  const c0 = m.c0[i], c1 = m.c1[i], c2 = m.c2[i];
  switch (m.seg[i]) {
    case 1:
      return t < 0.5 ? tcurve(c0, c1, c2, t * 2) * 0.5 : 1 - tcurve(c0, c1, c2, (1 - t) * 2) * 0.5;
    case 2:
      return 0;
    default:
      return tcurve(c0, c1, c2, t);
  }
}

/** Value of the map at x by a fresh sequential read (Eval 0x264ce0: reader init 0x262cf0, advance 0x263ec0). */
function readOld(m: OldMap, x: number): number {
  const n = m.n - 1;
  let cur = 0, inc: number, pos: number;
  if (m.x[0] === 0) { inc = 1; pos = 1; } else { inc = 1 / m.x[0]; pos = 0; }
  let start = m.y[0], delta = 0;
  if (cur >= 0 && cur <= n) pos = pos + x * inc;
  for (;;) {
    // FL compares the high word of the double: pos >= 1
    if (!(pos >= 1)) break;
    const old = cur;
    pos = inc === 0 ? x : (pos - 1) / inc;
    start = m.y[cur];
    if (cur < n) cur++;
    delta = m.y[cur] - start;
    if (cur === old) { pos = 0; inc = 0; continue; }
    const dt = m.x[cur];
    if (dt > 0) { inc = 1 / dt; pos = pos * inc; } else { inc = 1; pos = pos + 1; }
  }
  const v = cur >= 0 && cur <= n ? (cur === 0 ? 0 : shapeOld(m, cur, pos)) : 0;
  return start + v * delta;
}

/**
 * FL's conversion of a map of version < 6 (SaveRestoreState 0x68e7c..0x690c8): the old map is on the linear scale of the
 * harmonics 1 .. 2^(order-1) - 1 of the richness `order` (state int 52). FL rescales its distances to the 32 767 harmonics,
 * extends it flat to the full length 1, samples it at the 16 octaves 2^k / 32 767 (k = 0..15) as new points at x = k / 15 and
 * removes the interior points of flat runs (two equal neighbours). Bit-equal to the maps FL's plugin saved for all 33
 * factory presets of versions 0 / 1 / 4.
 */
export function convertOldMap(m: OgEnv, order: number): OgEnv {
  const span = ((1 << Math.max(0, Math.min(30, order - 1))) - 1) / 32767;
  const pts = m.p.map((q) => q.slice());
  let total = 0;
  for (const q of pts) { q[0] = q[0] * span; total += q[0]; }
  const last = pts[pts.length - 1];
  // AddPoint at the length: its distance is stored as a float32, so the copy FL reads is normalised to length 1 again (0x25f850)
  pts.push([f32(1 - total), last[1], 0, 0, 0, 0, 0]);
  let sum = 0;
  for (const q of pts) sum += q[0];
  if (1 / sum !== 1) for (const q of pts) q[0] = q[0] * (1 / sum);
  const old = compileOld(pts);
  const ys: number[] = [];
  for (let k = 0; k < 16; k++) ys.push(f32(readOld(old, (1 << k) / 32767)));
  // FL adds the 16 points one by one (AddPoint 0x25fca0: the distance to the sum of the stored distances, rounded to float32),
  // then deletes the interior points of flat runs, each adding its distance to the next point's (in double)
  const dx: number[] = [];
  let cum = 0;
  for (let k = 0; k < 16; k++) {
    const d = k === 0 ? 0 : f32(k / 15 - cum);
    dx.push(d);
    cum += d;
  }
  const rows: number[][] = [];
  let carry = 0;
  for (let k = 0; k < 16; k++) {
    if (k > 0 && k < 15 && ys[k - 1] === ys[k] && ys[k + 1] === ys[k]) { carry += dx[k]; continue; }
    const d = rows.length === 0 ? 0 : dx[k] + carry;
    carry = 0;
    rows.push([d, ys[k], 0, 0, 0, 0, rows.length === 0 ? 0 : 2]);
  }
  return { t: 3, m: m.m.slice(), p: rows };
}

// ------------------------------------------------------------------- state

/**
 * Parse a plugin state blob (u32 version + zlib stream) of any version FL's Ogun can load (0 .. 0x130003) into what the
 * plugin holds after loading it (`asSaved`: the values as stored, without the fix-ups FL does while loading: a state FL's
 * plugin saved holds objects FL never loaded as they are; `autogun`: the layout of FL's Autogun, which adds the preset counter).
 * Throws OgunStateError on bad input.
 */
export function parseOgunState(blob: Uint8Array, asSaved = false, autogun = false): OgFlState {
  const fix = !asSaved;
  if (blob.length < 8 || blob.length > OG_MAX_FILE_BYTES) throw new OgunStateError('bad state size');
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const vraw = dv.getUint32(0, true);
  if (vraw > OG_FL_VERSION) throw new OgunStateError(`state version ${vraw}: not supported`);
  const ver = vraw >= 0x10000 ? vraw >>> 16 : vraw;
  const raw = inflateZlib(blob.subarray(4));
  const r = new Reader(raw);

  // parameters 0..2 (fine pitch since version 8), then the block 3..48 + the settings (a prefix of plug+0x148..0x23c)
  const ints = new Array<number>(64).fill(0);
  const n1 = ver >= 8 ? 3 : 2;
  for (let i = 0; i < n1; i++) ints[i] = r.i32();
  let n2 = 244;
  if (ver < 1) n2 -= 1;
  if (ver < 2) n2 -= 3;
  if (ver < 7) n2 -= 1;
  if (ver < 9) n2 -= 16;
  if (ver < 11) n2 -= 1;
  if (ver < 12) n2 -= 1;
  if (ver < 13) n2 -= 6;
  const region = new Uint8Array(244);
  const rv = new DataView(region.buffer);
  region[0x221 - 0x148] = 1; // porta variable time: on
  rv.setInt32(0x238 - 0x148, 430, true); // magic dust
  region.set(r.bytes(n2));
  for (let i = 0; i < 46; i++) ints[3 + i] = rv.getInt32(4 * i, true);
  for (let k = 0; k < 15; k++) ints[49 + k] = rv.getInt32(0x200 - 0x148 + 4 * k, true);

  const b3 = Array.from(r.bytes(3));
  const eq = r.ints(3);
  let info: string;
  if (ver < 18) {
    const n = r.i32();
    if (n < 0 || n > MAX_INFO * 4) throw new OgunStateError(`bad info length ${n}`);
    info = rtfToText(r.bytes(n));
  } else {
    const n = r.strLen();
    if (n < 0 || n > MAX_INFO) throw new OgunStateError(`bad info length ${n}`);
    const b = r.bytes(2 * n);
    info = '';
    for (let i = 0; i + 1 < b.length; i += 2) info += String.fromCharCode(b[i] | (b[i + 1] << 8));
  }

  // Autogun's SaveRestoreState (0x65800) stores the preset counter between the info text and the articulators (version >= 19)
  const counter = autogun && ver >= 19 ? r.i32() >>> 0 : undefined;
  const defaulted: string[] = [], converted: string[] = [];
  const arts: OgArt[] = [];
  for (let i = 0; i < 13; i++) {
    if ((ver < 4 && (i === 4 || i === 5)) || (ver < 10 && (i === 11 || i === 12))) { arts.push(defaultArt(i)); defaulted.push(`a${i}`); } else arts.push(readArt(r, fix));
  }
  const maps: OgEnv[] = [];
  const order = ints[52];
  for (let j = 0; j < 4; j++) {
    if (ver < 5 && j === 0) { maps.push(defaultForcedMap()); defaulted.push('m0'); continue; }
    let m = readCurve(r, 3, fix);
    if (ver < 6) { m = convertOldMap(m, order); converted.push(`m${j}`); }
    maps.push(m);
  }
  // the old maps' conversion switches the natural (octave) EQ mapping scale on (settings byte plug+0x223)
  if (ver < 6) ints[57] = (ints[57] & ~(255 << 24)) | (1 << 24);
  if (r.p !== r.end) throw new OgunStateError(`${r.end - r.p} bytes left over`);
  return { version: ver, ints, b3, eq, info, arts, maps, defaulted, converted, ...(counter !== undefined ? { counter } : {}) };
}

/**
 * The plugin state of an FL event file (.fst preset: FLhd header, FLdt chunk, event 213 = plugin data); a raw state blob
 * is returned as is. Null when the file holds no plugin state.
 */
export function flPluginState(file: Uint8Array): Uint8Array | null {
  if (file.length > OG_MAX_FILE_BYTES) return null;
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

/** Parse an FL preset file (.fst) or a raw state; null when it is not an Ogun state. */
export function parseOgunFile(file: Uint8Array): OgFlState | null {
  const blob = flPluginState(file);
  if (!blob) return null;
  try { return parseOgunState(blob); } catch { return null; }
}
