// FL's Drumaxx kits: the compressed bank (./kits.ts) and FL's kit state format
// (see ./keys.ts), parsed into our state.

import { DX_KITS_DEFLATED, DX_KIT_BYTES, DX_PRESET_NAMES } from './kits';
import { base64ToBytes, inflateRaw } from './inflate';
import { dxEncodeSteps, dxKeyOf, dxRaw, type DxPattern } from './keys';

let bank: Uint8Array | null = null;

/** Kit i of the bank (0: the plugin database state, i + 1: preset i) as a state object, or null. */
export function dxKitState(i: number): Record<string, unknown> | null {
  if (!bank) bank = inflateRaw(base64ToBytes(DX_KITS_DEFLATED));
  if (!Number.isInteger(i) || i < 0 || (i + 1) * DX_KIT_BYTES > bank.length) return null;
  return dxParseKit(bank.subarray(i * DX_KIT_BYTES, (i + 1) * DX_KIT_BYTES));
}

/** FL's kit state (the plugin's SaveRestoreState chunk) -> our state; null when malformed. */
export function dxParseKit(c: Uint8Array): Record<string, unknown> | null {
  if (c.length < 260 + 2880 + 16 * 1026 + 2048 + 16 + 16) return null;
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  const q: Record<string, unknown> = {};
  // version 3 kits ("3SMD", "3DMD") store Retrig as a count: FL's loader scales it by 1/3 (f32) into 0..1
  const v3 = c[0] === 0x33 && (c[1] === 0x53 || c[1] === 0x44) && c[2] === 0x4d && c[3] === 0x44;
  let o = 260;
  for (let i = 0; i < 720; i++, o += 4) {
    const key = dxKeyOf(i);
    if (!key) continue;
    let v = dv.getFloat32(o, true);
    const local = i < 704 ? i % 44 : -1;
    if (local === 6 && v3) v = Math.fround(v * Math.fround(1 / 3));
    // (out-of-range junk some kits hold for unused pads acts as its clamped value)
    q[key] = local >= 0 && dxRaw(local) ? Math.round(v) : (v > 0 ? (v < 1 ? v : 1) : 0) * 256;
  }
  const patterns: DxPattern[] = [];
  for (let p = 0; p < 16; p++, o += 1026) patterns.push({ len: c[o], key: c[o + 1], steps: dxEncodeSteps(c.subarray(o + 2, o + 1026)) });
  q.patterns = patterns;
  const names: string[] = [];
  for (let k = 0; k < 16; k++, o += 128) {
    let s = '';
    for (let j = 0; j < 128 && c[o + j]; j++) s += String.fromCharCode(c[o + j]);
    names.push(s);
  }
  q.padNames = names;
  q.cuts = Array.from(c.subarray(o, o + 16)); o += 16;
  const offs: number[] = [];
  for (let k = 0; k < 16; k++) {
    let v = 0, sh = 0, b = 0;
    do { b = c[o++] ?? 0; v += (b & 0x7f) * 2 ** sh; sh += 7; } while (b & 0x80 && sh < 35);
    if (v >= 2 ** 31) v -= 2 ** 32;
    offs.push(v);
  }
  q.offsets = offs;
  return q;
}

export { DX_PRESET_NAMES };
