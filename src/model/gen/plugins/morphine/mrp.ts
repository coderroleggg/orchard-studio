// Morphine program files: FL's .mrp format, the FL state blob ('FLSS' + size +
// .mrp image) and .fst preset files (event 0xD5 = the state blob), read and
// written exactly as Morphine 1.7.0 does (Program_LoadMor0 0x4dc50 /
// Program_SaveMor0 0x4e690; .flref/morphine/NOTES.md section 1, the reference
// tools mrp_dump.py / mrp_build.py, byte-exact on the 300 factory programs).
//
// Little-endian int32 / float32. Tags are C multichar constants stored
// reversed ('MPR0' -> "0RPM"). A parent writes int32 size before each child
// chunk. Objects end with a trailer struct whose first int32 is its own size;
// the plugin zero-fills an expected-size struct and copies min(size, expected)
// bytes, so short (old) trailers read missing fields as 0.
//
//   file  = 'Mor0' | 'Mde0' MPR0             (Mde0: saved by a demo plugin)
//   MPR0  = 'MPR0' 4 x (size MVC0) (size MML0) (size MMD0) PROG_TR(0x5c4)
//   MVC0  = 'MVC0' (size MZH0) GEN_TR(0x1c)
//   MZH0  = 'MZH0' n n x {i32 width, f32 level, size MSP0}
//   MSP0  = 'MSP0' n n x {i32 time, f32 level, size MBP0} TL_TR(0x424)
//   MBP0  = 'MBP0' PACKED(amp) PACKED(pan) PACKED(detune)
//   PACKED= 16 x {u8 mask; f32 per set bit (partial 8g + bit)}; clear bit -> 0, |v| < 1e-9 read as 0
//   MML0  = 'MML0' n i32 recsize(12) n x {f32 a, f32 b, i32 dt} MORPH_TR(0x54)
//   MMD0  = 'MMD0' n n x (size MEG0) MOD_TR(0x94)
//   MEG0  = 'MEG0' n i32 recsize(8) n x {f32 level, i32 dt} ENV_TR(0x2c)
//
// The parsers are defensive (untrusted files): every read is bounds checked,
// counts and sizes are capped, a malformed file throws MorFileError.

import { MOR_KEYS, N_PROG, PROG_DEFAULTS, envParam, fOf, genParam, mixParam, vOf } from './params';
import { MAX_BPS, MAX_POINTS, MAX_ZONES, NP, substituteSpectrum, type MBp, type MEnv, type MGen, type MMod, type MMorph, type MZone } from './state';

const f32 = Math.fround;

export class MorFileError extends Error {}

/** Largest file / blob accepted (bytes). */
export const MAX_FILE_BYTES = 64 << 20;

// ------------------------------------------------------------------ raw program tree

export interface RawBp { time: number; level: number; amp: Float32Array; pan: Float32Array; det: Float32Array }
export interface RawTimeline {
  bps: RawBp[]; ls: number; le: number; rl: number; lm: number; rate: number; kt: number; vt: number; sync: number;
  curveA: Float32Array; curveB: Float32Array;
}
export interface RawZone { width: number; level: number; tl: RawTimeline }
export interface RawGen { zones: RawZone[]; pwmRate: number; pwmMode2: number; pwmPhase: number; pwmFree: number; detune: number; panRange: number }
export interface RawMorph {
  pts: [number, number, number][]; ls: number; le: number; lm: number; sync: number;
  mix: number[]; pan: number[]; mute: number[]; rate: number; kt: number; vt: number; solo: number;
}
export interface RawEnv {
  pts: [number, number][]; ls: number; le: number; rl: number; vel: number; lm: number; rate: number; sync: number;
  vt: number; kt: number; bip: number;
}
export interface RawProgram {
  magic: 'Mor0' | 'Mde0';
  gens: RawGen[];
  morph: RawMorph;
  envs: RawEnv[];
  src: number[]; dst: number[]; amt: number[];
  /** The 42 floats at prog+0x608..0x6ac then 0x6b0..0x6c0 (see PROG_MAP). */
  floats: number[];
  noise: string;
  name: string;
}

/**
 * Program trailer floats: parameter index of each (internal 124 Polyphony, 125
 * Glide Mode, 126 Noise Loop Mode, 127 Noise Flt Mode): 42 floats at
 * +4 (prog+0x608..0x6ac), then the 5 floats at +0x5b0.
 */
export const PROG_MAP: number[] = [0, 1, 125, 124, 2, 4, 5, 6, 3, 30, 31, 32, 33, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 34, 35, 36, 38, 39, 126, 127, 40, 41, 42, 37];

// ------------------------------------------------------------------ reader

class Rd {
  readonly dv: DataView;
  constructor(readonly b: Uint8Array, public p: number, readonly end: number) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number, what: string): void {
    if (!(n >= 0) || this.p + n > this.end) throw new MorFileError(`truncated ${what} at ${this.p}`);
  }
  i32(what = 'int'): number { this.need(4, what); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32(what = 'float'): number { this.need(4, what); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  u8(what = 'byte'): number { this.need(1, what); return this.b[this.p++]; }
  tag(t: string): void {
    this.need(4, t);
    const s = String.fromCharCode(this.b[this.p + 3], this.b[this.p + 2], this.b[this.p + 1], this.b[this.p]);
    if (s !== t) throw new MorFileError(`expected ${t} at ${this.p}`);
    this.p += 4;
  }
  sized(what: string): Rd {
    const n = this.i32(what + ' size');
    this.need(n, what);
    const r = new Rd(this.b, this.p, this.p + n);
    this.p += n;
    return r;
  }
  /** A trailer: zero-filled `expected` bytes with min(size, expected) copied; the reader skips `size`. */
  trailer(expected: number, what: string): DataView {
    const start = this.p;
    const size = this.i32(what);
    if (size < 4 || start + size > this.end) throw new MorFileError(`bad ${what} size ${size}`);
    const buf = new Uint8Array(expected);
    buf.set(this.b.subarray(start, start + Math.min(size, expected)));
    this.p = start + size;
    return new DataView(buf.buffer);
  }
}

function packed(r: Rd): Float32Array {
  const v = new Float32Array(NP);
  for (let g = 0; g < 16; g++) {
    const m = r.u8('mask');
    for (let b = 0; b < 8; b++) {
      if ((m >> b) & 1) {
        const x = r.f32('partial');
        v[8 * g + b] = x > -1e-9 && x < 1e-9 ? 0 : x;
      }
    }
  }
  return v;
}

function readTimeline(r: Rd): RawTimeline {
  r.tag('MSP0');
  const n = r.i32('breakpoints');
  if (n < 0 || n > MAX_BPS) throw new MorFileError(`bad breakpoint count ${n}`);
  const bps: RawBp[] = [];
  for (let i = 0; i < n; i++) {
    const time = r.i32('time'), level = r.f32('level');
    const s = r.sized('MBP0');
    s.tag('MBP0');
    bps.push({ time, level, amp: packed(s), pan: packed(s), det: packed(s) });
  }
  const t = r.trailer(0x424, 'timeline trailer');
  const curveA = new Float32Array(NP), curveB = new Float32Array(NP);
  for (let k = 0; k < NP; k++) { curveA[k] = t.getFloat32(0x24 + 4 * k, true); curveB[k] = t.getFloat32(0x224 + 4 * k, true); }
  return {
    bps, ls: t.getInt32(4, true), le: t.getInt32(8, true), rl: t.getInt32(0xc, true) ? 1 : 0, lm: t.getInt32(0x10, true),
    rate: t.getFloat32(0x14, true), kt: t.getFloat32(0x18, true), vt: t.getFloat32(0x1c, true), sync: t.getInt32(0x20, true) ? 1 : 0,
    curveA, curveB,
  };
}

function readGen(r: Rd): RawGen {
  r.tag('MVC0');
  const z = r.sized('MZH0');
  z.tag('MZH0');
  const n = z.i32('zones');
  if (n < 0 || n > MAX_ZONES) throw new MorFileError(`bad zone count ${n}`);
  const zones: RawZone[] = [];
  for (let i = 0; i < n; i++) {
    const width = z.i32('zone width'), level = z.f32('zone level');
    zones.push({ width, level, tl: readTimeline(z.sized('MSP0')) });
  }
  const t = r.trailer(0x1c, 'generator trailer');
  return {
    zones, pwmRate: t.getFloat32(4, true), pwmMode2: t.getInt32(8, true), pwmPhase: t.getFloat32(0xc, true),
    pwmFree: t.getInt32(0x10, true) ? 1 : 0, detune: t.getFloat32(0x14, true), panRange: t.getFloat32(0x18, true),
  };
}

function readMorph(r: Rd): RawMorph {
  r.tag('MML0');
  const n = r.i32('morph points'), rs = r.i32('record size');
  if (n < 0 || n > MAX_POINTS || rs < 12 || rs > 64) throw new MorFileError('bad morph path');
  const pts: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const s = new Rd(r.b, r.p, r.p + rs);
    r.need(rs, 'morph point');
    r.p += rs;
    pts.push([s.f32(), s.f32(), s.i32()]);
  }
  const t = r.trailer(0x54, 'morph trailer');
  const f4 = (o: number) => [0, 1, 2, 3].map((k) => t.getFloat32(o + 4 * k, true));
  return {
    pts, ls: t.getInt32(4, true), le: t.getInt32(8, true), lm: t.getInt32(0xc, true), sync: t.getInt32(0x10, true) ? 1 : 0,
    mix: f4(0x14), pan: f4(0x24), mute: [0, 1, 2, 3].map((k) => (t.getInt32(0x34 + 4 * k, true) ? 1 : 0)),
    rate: t.getFloat32(0x44, true), kt: t.getFloat32(0x48, true), vt: t.getFloat32(0x4c, true), solo: t.getInt32(0x50, true),
  };
}

function readEnv(r: Rd): RawEnv {
  r.tag('MEG0');
  const n = r.i32('envelope points'), rs = r.i32('record size');
  if (n < 0 || n > MAX_POINTS || rs < 8 || rs > 64) throw new MorFileError('bad envelope');
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const s = new Rd(r.b, r.p, r.p + rs);
    r.need(rs, 'envelope point');
    r.p += rs;
    pts.push([s.f32(), s.i32()]);
  }
  const t = r.trailer(0x2c, 'envelope trailer');
  return {
    pts, ls: t.getInt32(4, true), le: t.getInt32(8, true), rl: t.getInt32(0xc, true) ? 1 : 0, vel: t.getFloat32(0x10, true),
    lm: t.getInt32(0x14, true), rate: t.getFloat32(0x18, true), sync: t.getInt32(0x1c, true) ? 1 : 0,
    vt: t.getFloat32(0x20, true), kt: t.getFloat32(0x24, true), bip: t.getInt32(0x28, true) ? 1 : 0,
  };
}

function cstr(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

/** Parse a .mrp image ('Mor0' / 'Mde0'). */
export function parseMrp(b: Uint8Array): RawProgram {
  if (b.length > MAX_FILE_BYTES) throw new MorFileError('file too large');
  const r = new Rd(b, 0, b.length);
  r.need(4, 'magic');
  const magic = String.fromCharCode(b[3], b[2], b[1], b[0]);
  if (magic !== 'Mor0' && magic !== 'Mde0') throw new MorFileError('not a Morphine program');
  r.p = 4;
  r.tag('MPR0');
  const gens = [0, 1, 2, 3].map(() => readGen(r.sized('MVC0')));
  const morph = readMorph(r.sized('MML0'));
  const m = r.sized('MMD0');
  m.tag('MMD0');
  const ne = m.i32('envelopes');
  if (ne < 0 || ne > 16) throw new MorFileError('bad envelope count');
  const envs: RawEnv[] = [];
  for (let i = 0; i < ne; i++) envs.push(readEnv(m.sized('MEG0')));
  const mt = m.trailer(0x94, 'modulation trailer');
  const src: number[] = [], dst: number[] = [], amt: number[] = [];
  for (let k = 0; k < 12; k++) {
    src.push(Math.min(136, Math.max(0, mt.getInt32(4 + 4 * k, true))));
    dst.push(Math.min(47, Math.max(0, mt.getInt32(0x34 + 4 * k, true))));
    amt.push(Math.min(1, Math.max(0, mt.getFloat32(0x64 + 4 * k, true))));
  }
  const t = r.trailer(0x5c4, 'program trailer');
  const tb = new Uint8Array(t.buffer);
  const floats: number[] = [];
  for (let k = 0; k < 42; k++) floats.push(t.getFloat32(4 + 4 * k, true));
  for (let k = 0; k < 5; k++) floats.push(t.getFloat32(0x5b0 + 4 * k, true));
  return { magic, gens, morph, envs, src, dst, amt, floats, noise: cstr(tb, 0xac, 1024), name: cstr(tb, 0x4b0, 256) };
}

/** The plugin data (event 0xD5) of an FL .fst file; null when absent / malformed. */
export function fstBlob(b: Uint8Array): Uint8Array | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 22 || tag(0) !== 'FLhd') return null;
  let p = 8 + dv.getUint32(4, true);
  if (p + 8 > b.length || tag(p) !== 'FLdt') return null;
  const end = Math.min(b.length, p + 8 + dv.getUint32(p + 4, true));
  p += 8;
  while (p < end) {
    const ev = b[p++];
    if (ev < 64) p += 1;
    else if (ev < 128) p += 2;
    else if (ev < 192) p += 4;
    else {
      let n = 0, sh = 0;
      for (;;) { if (p >= end || sh > 28) return null; const c = b[p++]; n += (c & 0x7f) * 2 ** sh; sh += 7; if (!(c & 0x80)) break; }
      if (ev === 0xd5) return p + n <= end ? b.subarray(p, p + n) : null;
      p += n;
    }
  }
  return null;
}

/**
 * Any Morphine program container: a .mrp image, an FL state blob ('FLSS' +
 * size), an .fst preset (its event 0xD5) or a VST fxp chunk (the 0x3c-byte
 * header the plugin skips). Null when the bytes are none of these.
 */
export function parseMorphineFile(b: Uint8Array): RawProgram | null {
  try {
    if (b.length < 8 || b.length > MAX_FILE_BYTES) return null;
    const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (tag(0) === 'FLhd') { const blob = fstBlob(b); return blob ? parseMorphineFile(blob) : null; }
    if (tag(0) === 'SSLF') {
      const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true);
      return parseMrp(b.subarray(8, Math.min(b.length, 8 + n)));
    }
    if (tag(0) === 'CcnK' && b.length > 0x3c && tag(8) === 'FPCh') return parseMrp(b.subarray(0x3c));
    return parseMrp(b);
  } catch (e) {
    if (e instanceof MorFileError || e instanceof RangeError) return null;
    throw e;
  }
}

// ------------------------------------------------------------------ writer

class Wr {
  private buf = new Uint8Array(1 << 16);
  private dv = new DataView(this.buf.buffer);
  n = 0;
  private grow(k: number): void {
    if (this.n + k <= this.buf.length) return;
    let m = this.buf.length * 2;
    while (m < this.n + k) m *= 2;
    const nb = new Uint8Array(m);
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  i32(v: number): void { this.grow(4); this.dv.setInt32(this.n, v | 0, true); this.n += 4; }
  f32(v: number): void { this.grow(4); this.dv.setFloat32(this.n, v, true); this.n += 4; }
  u8(v: number): void { this.grow(1); this.buf[this.n++] = v & 0xff; }
  tag(t: string): void { for (let i = 3; i >= 0; i--) this.u8(t.charCodeAt(i)); }
  bytes(b: Uint8Array): void { this.grow(b.length); this.buf.set(b, this.n); this.n += b.length; }
  /** Reserve the size word of a child chunk; call end() with the returned position. */
  begin(): number { this.i32(0); return this.n; }
  end(at: number): void { this.dv.setInt32(at - 4, this.n - at, true); }
  out(): Uint8Array { return this.buf.slice(0, this.n); }
}

function writePacked(w: Wr, v: ArrayLike<number>): void {
  for (let g = 0; g < 16; g++) {
    let m = 0;
    for (let b = 0; b < 8; b++) if (f32(v[8 * g + b] ?? 0) !== 0) m |= 1 << b;
    w.u8(m);
    for (let b = 0; b < 8; b++) if (m & (1 << b)) w.f32(v[8 * g + b]);
  }
}

function trailer(w: Wr, size: number, fill: (dv: DataView) => void): void {
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  dv.setInt32(0, size, true);
  fill(dv);
  w.bytes(b);
}

/** Write a .mrp image (FL saves 'Mor0'; full-size trailers, the 4 uninitialised trailer bytes as 0). */
export function writeMrp(p: RawProgram): Uint8Array {
  const w = new Wr();
  w.tag('Mor0');
  w.tag('MPR0');
  for (const g of p.gens) {
    const a = w.begin();
    w.tag('MVC0');
    const zh = w.begin();
    w.tag('MZH0');
    w.i32(g.zones.length);
    for (const z of g.zones) {
      w.i32(z.width);
      w.f32(z.level);
      const sp = w.begin();
      w.tag('MSP0');
      w.i32(z.tl.bps.length);
      for (const bp of z.tl.bps) {
        w.i32(bp.time);
        w.f32(bp.level);
        const b = w.begin();
        w.tag('MBP0');
        writePacked(w, bp.amp);
        writePacked(w, bp.pan);
        writePacked(w, bp.det);
        w.end(b);
      }
      const tl = z.tl;
      trailer(w, 0x424, (dv) => {
        dv.setInt32(4, tl.ls, true); dv.setInt32(8, tl.le, true); dv.setInt32(0xc, tl.rl, true); dv.setInt32(0x10, tl.lm, true);
        dv.setFloat32(0x14, tl.rate, true); dv.setFloat32(0x18, tl.kt, true); dv.setFloat32(0x1c, tl.vt, true); dv.setInt32(0x20, tl.sync, true);
        for (let k = 0; k < NP; k++) { dv.setFloat32(0x24 + 4 * k, tl.curveA[k], true); dv.setFloat32(0x224 + 4 * k, tl.curveB[k], true); }
      });
      w.end(sp);
    }
    w.end(zh);
    trailer(w, 0x1c, (dv) => {
      dv.setFloat32(4, g.pwmRate, true); dv.setInt32(8, g.pwmMode2, true); dv.setFloat32(0xc, g.pwmPhase, true);
      dv.setInt32(0x10, g.pwmFree, true); dv.setFloat32(0x14, g.detune, true); dv.setFloat32(0x18, g.panRange, true);
    });
    w.end(a);
  }
  const m = p.morph;
  let a = w.begin();
  w.tag('MML0');
  w.i32(m.pts.length);
  w.i32(12);
  for (const [x, y, t] of m.pts) { w.f32(x); w.f32(y); w.i32(t); }
  trailer(w, 0x54, (dv) => {
    dv.setInt32(4, m.ls, true); dv.setInt32(8, m.le, true); dv.setInt32(0xc, m.lm, true); dv.setInt32(0x10, m.sync, true);
    for (let k = 0; k < 4; k++) {
      dv.setFloat32(0x14 + 4 * k, m.mix[k], true); dv.setFloat32(0x24 + 4 * k, m.pan[k], true); dv.setInt32(0x34 + 4 * k, m.mute[k], true);
    }
    dv.setFloat32(0x44, m.rate, true); dv.setFloat32(0x48, m.kt, true); dv.setFloat32(0x4c, m.vt, true); dv.setInt32(0x50, m.solo, true);
  });
  w.end(a);
  a = w.begin();
  w.tag('MMD0');
  w.i32(p.envs.length);
  for (const e of p.envs) {
    const b = w.begin();
    w.tag('MEG0');
    w.i32(e.pts.length);
    w.i32(8);
    for (const [lv, t] of e.pts) { w.f32(lv); w.i32(t); }
    trailer(w, 0x2c, (dv) => {
      dv.setInt32(4, e.ls, true); dv.setInt32(8, e.le, true); dv.setInt32(0xc, e.rl, true); dv.setFloat32(0x10, e.vel, true);
      dv.setInt32(0x14, e.lm, true); dv.setFloat32(0x18, e.rate, true); dv.setInt32(0x1c, e.sync, true); dv.setFloat32(0x20, e.vt, true);
      dv.setFloat32(0x24, e.kt, true); dv.setInt32(0x28, e.bip, true);
    });
    w.end(b);
  }
  trailer(w, 0x94, (dv) => {
    for (let k = 0; k < 12; k++) {
      dv.setInt32(4 + 4 * k, p.src[k], true); dv.setInt32(0x34 + 4 * k, p.dst[k], true); dv.setFloat32(0x64 + 4 * k, p.amt[k], true);
    }
  });
  w.end(a);
  trailer(w, 0x5c4, (dv) => {
    for (let k = 0; k < 42; k++) dv.setFloat32(4 + 4 * k, p.floats[k], true);
    for (let k = 0; k < 5; k++) dv.setFloat32(0x5b0 + 4 * k, p.floats[42 + k], true);
    for (let i = 0; i < Math.min(1023, p.noise.length); i++) dv.setUint8(0xac + i, p.noise.charCodeAt(i) & 0xff);
    for (let i = 0; i < Math.min(255, p.name.length); i++) dv.setUint8(0x4b0 + i, p.name.charCodeAt(i) & 0xff);
  });
  return w.out();
}

/** FL's state blob of a program: 'FLSS' + size + the .mrp image. */
export function writeFlState(p: RawProgram): Uint8Array {
  const img = writeMrp(p);
  const out = new Uint8Array(img.length + 8);
  out.set([0x53, 0x53, 0x4c, 0x46]);
  new DataView(out.buffer).setUint32(4, img.length, true);
  out.set(img, 8);
  return out;
}

// ------------------------------------------------------------------ raw <-> state

/** How the spectra of a converted program are stored. */
export interface SpectraOut {
  /** Rows of 128 floats for spectraSample (breakpoint a/p/d, curve ca/cb). */
  rows: Float32Array[];
}

const flat = (c: Float32Array): number | null => {
  for (let k = 1; k < NP; k++) if (c[k] !== c[0]) return null;
  return c[0];
};

/**
 * A raw program as an Orchard Studio state (parameters + structure). The
 * spectra go inline into the breakpoints, or, with `rows`, into rows for a
 * pool sample (FL content; the breakpoints get their row index `s`).
 */
export function rawToState(p: RawProgram, rows?: SpectraOut): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const pf: number[] = PROG_DEFAULTS.slice();
  let poly = 31, glideMode = 0, nzLoop = 0, nzFlt = 0;
  PROG_MAP.forEach((idx, k) => {
    const v = p.floats[k];
    if (idx < N_PROG) pf[idx] = v;
    else if (idx === 124) poly = v;
    else if (idx === 125) glideMode = v;
    else if (idx === 126) nzLoop = v;
    else if (idx === 127) nzFlt = v;
  });
  const b = (x: number) => (x ? 1 : 0);
  p.gens.forEach((g, gi) => {
    const tl = g.zones[0]?.tl;
    if (tl) {
      pf[genParam(gi, 0)] = b(tl.rl); pf[genParam(gi, 1)] = b(tl.sync); pf[genParam(gi, 2)] = tl.rate;
      pf[genParam(gi, 3)] = tl.vt; pf[genParam(gi, 4)] = tl.kt;
    }
    pf[genParam(gi, 5)] = b(g.pwmFree); pf[genParam(gi, 6)] = g.pwmRate; pf[genParam(gi, 7)] = g.pwmPhase;
    pf[genParam(gi, 8)] = g.detune; pf[genParam(gi, 9)] = g.panRange;
  });
  const m = p.morph;
  pf[83] = b(m.sync); pf[84] = m.rate; pf[85] = m.kt; pf[86] = m.vt;
  for (let g = 0; g < 4; g++) { pf[mixParam(g, 0)] = m.mix[g]; pf[mixParam(g, 1)] = m.pan[g]; pf[mixParam(g, 2)] = b(m.mute[g]); }
  p.envs.slice(0, 4).forEach((e, ei) => {
    pf[envParam(ei, 0)] = b(e.rl); pf[envParam(ei, 1)] = b(e.sync); pf[envParam(ei, 2)] = e.rate;
    pf[envParam(ei, 3)] = e.kt; pf[envParam(ei, 4)] = e.vt; pf[envParam(ei, 5)] = e.vel;
  });
  for (let i = 0; i < N_PROG; i++) o[MOR_KEYS[i]] = vOf(Math.min(1, Math.max(0, pf[i])));
  o.progName = p.name;
  o.poly = Math.min(31, Math.max(0, Math.trunc(poly)));
  o.glideMode = Math.min(3, Math.max(0, Math.trunc(glideMode)));
  o.nzLoop = Math.min(3, Math.max(0, Math.trunc(nzLoop)));
  o.nzFlt = Math.min(3, Math.max(0, Math.trunc(nzFlt)));
  o.gens = p.gens.map((g): MGen => ({
    pwm: Math.min(2, Math.max(0, g.pwmMode2)),
    cz: 0,
    zones: g.zones.map((z): MZone => {
      const tl = z.tl;
      const zone: MZone = {
        w: Math.max(1, z.width), l: f32(Math.min(1, Math.max(0, z.level))), bp: [], ls: tl.ls, le: tl.le, lm: tl.lm, rl: tl.rl,
        rate: tl.rate, kt: tl.kt, vt: tl.vt, sync: tl.sync, ca: 1, cb: 1,
      };
      const ca = flat(tl.curveA), cb = flat(tl.curveB);
      if (ca !== null && cb !== null) { zone.ca = ca; zone.cb = cb; }
      else if (rows) { zone.cs = rows.rows.length; rows.rows.push(tl.curveA, tl.curveB); }
      else { zone.ca = ca ?? Array.from(tl.curveA); zone.cb = cb ?? Array.from(tl.curveB); }
      zone.bp = tl.bps.map((bp): MBp => {
        const o2: MBp = { t: bp.time, l: bp.level };
        if (rows) { o2.s = rows.rows.length; rows.rows.push(bp.amp, bp.pan, bp.det); }
        else { o2.a = Array.from(bp.amp); o2.p = Array.from(bp.pan); o2.d = Array.from(bp.det); }
        return o2;
      });
      return zone;
    }),
  }));
  o.morph = { pts: m.pts.map(([x, y, t]) => [x, y, t]), ls: m.ls, le: m.le, lm: Math.min(3, Math.max(0, m.lm)), solo: m.solo >= 1 && m.solo <= 4 ? m.solo : 0 } satisfies MMorph;
  const envs = p.envs.slice(0, 4).map((e): MEnv => ({ pts: e.pts.map(([l, t]) => [l, t]), ls: e.ls, le: e.le, lm: Math.min(3, Math.max(0, e.lm)), bip: e.bip }));
  while (envs.length < 4) envs.push({ pts: [[1, 100]], ls: 100, le: 110, lm: 0, bip: 0 });
  o.envs = envs;
  o.mod = { src: p.src.slice(), dst: p.dst.slice(), amt: p.amt.slice() } satisfies MMod;
  o.noise = p.noise;
  return o;
}

/** Spectrum lookup for the writer / engine: rows of the state's spectraSample (null when absent). */
export type RowSource = ((row: number) => Float32Array | null) | null;

/**
 * A breakpoint's spectrum (amp, pan, detune) as the engine plays it: inline
 * arrays first, then spectraSample rows, then (missing content) the
 * generator's synthesized stand-in, else silence.
 */
export function bpSpectrum(bp: MBp, gen: number, missing: boolean, rows: RowSource, out: [Float32Array, Float32Array, Float32Array]): void {
  const [a, p, d] = out;
  a.fill(0); p.fill(0); d.fill(0);
  if (bp.a || bp.p || bp.d) {
    if (bp.a) for (let k = 0; k < Math.min(NP, bp.a.length); k++) a[k] = bp.a[k];
    if (bp.p) for (let k = 0; k < Math.min(NP, bp.p.length); k++) p[k] = bp.p[k];
    if (bp.d) for (let k = 0; k < Math.min(NP, bp.d.length); k++) d[k] = bp.d[k];
    return;
  }
  if (bp.s !== undefined) {
    const ra = rows?.(bp.s), rp = rows?.(bp.s + 1), rd = rows?.(bp.s + 2);
    if (ra && rp && rd) { a.set(ra); p.set(rp); d.set(rd); return; }
    a.set(substituteSpectrum(gen));
    return;
  }
  if (missing) a.set(substituteSpectrum(gen));
}

/** A zone's velocity / window curves (ca, cb) as played. */
export function zoneCurves(z: MZone, rows: RowSource, ca: Float32Array, cb: Float32Array): void {
  const ra = z.cs !== undefined ? rows?.(z.cs) : null, rb = z.cs !== undefined ? rows?.(z.cs + 1) : null;
  if (ra && rb) { ca.set(ra); cb.set(rb); return; }
  if (Array.isArray(z.ca)) for (let k = 0; k < NP; k++) ca[k] = z.ca[k] ?? 0; else ca.fill(z.ca);
  if (Array.isArray(z.cb)) for (let k = 0; k < NP; k++) cb[k] = z.cb[k] ?? 0; else cb.fill(z.cb);
}

/** A state as a raw program (for the .mrp / FL state writer); `rows` resolves spectraSample. */
export function stateToRaw(st: Record<string, unknown>, rows: RowSource = null): RawProgram {
  const f = (i: number) => fOf(typeof st[MOR_KEYS[i]] === 'number' ? (st[MOR_KEYS[i]] as number) : vOf(PROG_DEFAULTS[i]));
  const missing = st.spectraMissing === 1;
  const floats = PROG_MAP.map((idx) => {
    if (idx < N_PROG) return f(idx);
    if (idx === 124) return Number(st.poly ?? 31);
    if (idx === 125) return Number(st.glideMode ?? 0);
    if (idx === 126) return Number(st.nzLoop ?? 0);
    return Number(st.nzFlt ?? 0);
  });
  const gens = (st.gens as MGen[]).map((g, gi): RawGen => ({
    pwmRate: f(genParam(gi, 6)), pwmMode2: g.pwm, pwmPhase: f(genParam(gi, 7)), pwmFree: f(genParam(gi, 5)) ? 1 : 0,
    detune: f(genParam(gi, 8)), panRange: f(genParam(gi, 9)),
    zones: g.zones.map((z, zi): RawZone => {
      const cur = zi === g.cz;
      const curveA = new Float32Array(NP), curveB = new Float32Array(NP);
      zoneCurves(z, rows, curveA, curveB);
      const tmp: [Float32Array, Float32Array, Float32Array] = [new Float32Array(NP), new Float32Array(NP), new Float32Array(NP)];
      return {
        width: z.w, level: z.l,
        tl: {
          bps: z.bp.map((bp): RawBp => {
            bpSpectrum(bp, gi, missing, rows, tmp);
            return { time: bp.t, level: bp.l, amp: tmp[0].slice(), pan: tmp[1].slice(), det: tmp[2].slice() };
          }),
          ls: z.ls, le: z.le, lm: z.lm, curveA, curveB,
          rl: cur ? (f(genParam(gi, 0)) ? 1 : 0) : z.rl, sync: cur ? (f(genParam(gi, 1)) ? 1 : 0) : z.sync,
          rate: cur ? f(genParam(gi, 2)) : z.rate, vt: cur ? f(genParam(gi, 3)) : z.vt, kt: cur ? f(genParam(gi, 4)) : z.kt,
        },
      };
    }),
  }));
  const m = st.morph as MMorph;
  const envs = (st.envs as MEnv[]).map((e, ei): RawEnv => ({
    pts: e.pts.map(([l, t]) => [l, t]), ls: e.ls, le: e.le, lm: e.lm, bip: e.bip,
    rl: f(envParam(ei, 0)) ? 1 : 0, sync: f(envParam(ei, 1)) ? 1 : 0, rate: f(envParam(ei, 2)), kt: f(envParam(ei, 3)),
    vt: f(envParam(ei, 4)), vel: f(envParam(ei, 5)),
  }));
  const mod = st.mod as MMod;
  return {
    magic: 'Mor0', gens,
    morph: {
      pts: m.pts.map(([x, y, t]) => [x, y, t]), ls: m.ls, le: m.le, lm: m.lm, solo: m.solo,
      sync: f(83) ? 1 : 0, rate: f(84), kt: f(85), vt: f(86),
      mix: [0, 1, 2, 3].map((g) => f(mixParam(g, 0))), pan: [0, 1, 2, 3].map((g) => f(mixParam(g, 1))),
      mute: [0, 1, 2, 3].map((g) => (f(mixParam(g, 2)) ? 1 : 0)),
    },
    envs, src: mod.src.slice(), dst: mod.dst.slice(), amt: mod.amt.slice(), floats,
    noise: typeof st.noise === 'string' ? st.noise : '', name: typeof st.progName === 'string' ? st.progName : '',
  };
}
