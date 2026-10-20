// Reads BooBass's 12 PCM tables out of the user's own FL Studio engine library
// (macOS: FL Studio.app/Contents/Resources/FL/Plugins/Fruity/Generators/
// BooBass/BooBass_Eng_x64.dylib). The file is untrusted input: every header,
// load command, symbol, offset and length is validated, and anything
// unexpected fails with a hint. Nothing of FL is bundled with Orchard; the
// tables only enter the user's project (sample pool) when the user picks
// the file. Pure code (no DOM): also used by tests.

import type { BooPcm } from '../../../../engine/gen/plugins/boobass/tables';
import { MAX_TABLE } from '../../../../engine/gen/plugins/boobass/tables';

/** FL's table symbols in its PcmFile order: six strikes, then six single cycles. */
export const STRIKE_SYMS = ['_b0', '_e1', '_b1', '_e2', '_b2', '_e3'];
export const WAVE_SYMS = ['_b02', '_e12', '_b12', '_e22', '_b22', '_e32'];

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;

export class FlDataError extends Error {}

const fail = (msg: string): never => { throw new FlDataError(msg); };

interface Slice { off: number; size: number; cpu: number }

function slices(dv: DataView): Slice[] {
  const len = dv.byteLength;
  if (len < 32) fail('The file is too small to be FL\'s BooBass engine library.');
  const be = dv.getUint32(0, false);
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const wide = be === 0xcafebabf;
    const n = dv.getUint32(4, false);
    if (n < 1 || n > 16) fail('Unexpected universal binary header.');
    const es = wide ? 32 : 20;
    if (8 + n * es > len) fail('Truncated universal binary header.');
    const out: Slice[] = [];
    for (let i = 0; i < n; i++) {
      const p = 8 + i * es;
      const cpu = dv.getInt32(p, false);
      let off: number, size: number;
      if (wide) {
        if (dv.getUint32(p + 8, false) !== 0 || dv.getUint32(p + 16, false) !== 0) fail('Universal binary slice out of range.');
        off = dv.getUint32(p + 12, false);
        size = dv.getUint32(p + 20, false);
      } else {
        off = dv.getUint32(p + 8, false);
        size = dv.getUint32(p + 12, false);
      }
      if (off < 8 + n * es || off + size > len || size < 32) fail('Universal binary slice out of range.');
      out.push({ off, size, cpu });
    }
    return out;
  }
  return [{ off: 0, size: len, cpu: dv.getInt32(4, true) }];
}

interface Seg { vmaddr: number; vmsize: number; fileoff: number; filesize: number }

/** Parse one thin 64-bit Mach-O image: segments and the symbols we want (name -> vmaddr). */
function image(dv: DataView, s: Slice, want: Set<string>): { segs: Seg[]; syms: Map<string, number> } {
  const at = (o: number, n: number) => {
    if (o < 0 || n < 0 || o + n > s.size) fail('A header or table points outside the file.');
    return s.off + o;
  };
  if (dv.getUint32(at(0, 4), true) !== MH_MAGIC_64) fail('Not a 64-bit Mach-O library (pick BooBass_Eng_x64.dylib from FL Studio for macOS).');
  const ncmds = dv.getUint32(at(16, 4), true);
  const sizeofcmds = dv.getUint32(at(20, 4), true);
  if (ncmds > 4096 || 32 + sizeofcmds > s.size) fail('Corrupt Mach-O load commands.');
  const segs: Seg[] = [];
  let symtab: { symoff: number; nsyms: number; stroff: number; strsize: number } | null = null;
  let p = 32;
  const end = 32 + sizeofcmds;
  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > end) fail('Corrupt Mach-O load commands.');
    const cmd = dv.getUint32(at(p, 4), true);
    const size = dv.getUint32(at(p + 4, 4), true);
    if (size < 8 || p + size > end) fail('Corrupt Mach-O load commands.');
    if (cmd === LC_SEGMENT_64) {
      if (size < 72) fail('Corrupt segment command.');
      const u64 = (o: number) => {
        const lo = dv.getUint32(at(p + o, 8), true), hi = dv.getUint32(at(p + o + 4, 4), true);
        if (hi > 0x1fffff) fail('Segment address out of range.');
        return hi * 4294967296 + lo;
      };
      segs.push({ vmaddr: u64(24), vmsize: u64(32), fileoff: u64(40), filesize: u64(48) });
    } else if (cmd === LC_SYMTAB) {
      if (size < 24) fail('Corrupt symbol table command.');
      symtab = { symoff: dv.getUint32(at(p + 8, 4), true), nsyms: dv.getUint32(at(p + 12, 4), true), stroff: dv.getUint32(at(p + 16, 4), true), strsize: dv.getUint32(at(p + 20, 4), true) };
    }
    p += size;
  }
  if (!symtab) fail('The library has no symbol table: this is not FL\'s BooBass engine.');
  const st = symtab!;
  if (st.nsyms > 1_000_000) fail('Corrupt symbol table.');
  at(st.symoff, st.nsyms * 16);
  at(st.stroff, st.strsize);
  const syms = new Map<string, number>();
  for (let i = 0; i < st.nsyms; i++) {
    const e = st.symoff + i * 16;
    const strx = dv.getUint32(at(e, 4), true);
    if (strx >= st.strsize) continue;
    // read a short name (our symbols are at most 12 characters)
    let name = '';
    for (let k = 0; k < 16 && strx + k < st.strsize; k++) {
      const c = dv.getUint8(at(st.stroff + strx + k, 1));
      if (c === 0) break;
      name += String.fromCharCode(c);
    }
    if (!want.has(name)) continue;
    const lo = dv.getUint32(at(e + 8, 4), true), hi = dv.getUint32(at(e + 12, 4), true);
    if (hi > 0x1fffff) continue;
    syms.set(name, hi * 4294967296 + lo);
  }
  return { segs, syms };
}

/** File offset (within the slice) of `n` bytes at vmaddr `a`; throws when outside a segment's file data. */
function fileOff(segs: Seg[], a: number, n: number, s: Slice): number {
  for (const g of segs) {
    if (a >= g.vmaddr && a + n <= g.vmaddr + Math.min(g.vmsize, g.filesize)) {
      const o = g.fileoff + (a - g.vmaddr);
      if (o + n > s.size) break;
      return o;
    }
  }
  return fail('A BooBass table lies outside the library\'s file data.');
}

/**
 * The 12 tables from BooBass_Eng_x64.dylib (universal or thin, arm64 or
 * x86_64; arm64 preferred). Throws FlDataError with a hint for anything else.
 */
export function readBooBassData(buf: ArrayBuffer): { pcm: BooPcm; arch: string } {
  const dv = new DataView(buf);
  const all = slices(dv);
  const pick = all.find((s) => s.cpu === CPU_ARM64) ?? all.find((s) => s.cpu === CPU_X86_64);
  if (!pick) fail('No arm64 or x86_64 code in this file (pick BooBass_Eng_x64.dylib from FL Studio for macOS).');
  const s = pick!;
  const names = [...STRIKE_SYMS, ...WAVE_SYMS];
  const want = new Set<string>();
  for (const nm of names) { want.add(nm); want.add(nm + 'Length'); }
  const { segs, syms } = image(dv, s, want);
  const missing = names.filter((nm) => !syms.has(nm) || !syms.has(nm + 'Length'));
  if (missing.length) fail('This is not FL\'s BooBass engine library (BooBass_Eng_x64.dylib): its tables are missing.');
  const tables = names.map((nm, i) => {
    const lenAt = fileOff(segs, syms.get(nm + 'Length')!, 4, s);
    const bytes = dv.getInt32(s.off + lenAt, true);
    const strike = i < 6;
    const n = bytes >> 1;
    if (bytes <= 0 || n < (strike ? 1000 : 16) || n > (strike ? MAX_TABLE : 4096)) fail(`Unexpected size of BooBass table ${nm.slice(1)}: this FL version is not supported.`);
    const o = fileOff(segs, syms.get(nm)!, n * 2, s);
    const t = new Int16Array(n);
    for (let k = 0; k < n; k++) t[k] = dv.getInt16(s.off + o + 2 * k, true);
    return t;
  });
  return { pcm: { strikes: tables.slice(0, 6), waves: tables.slice(6) }, arch: s.cpu === CPU_ARM64 ? 'arm64' : 'x86_64' };
}
