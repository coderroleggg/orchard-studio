// RIFF / WAVE reading for Slicex, with the region data FL keeps in WAVs (FL's TWAVSample reader
// 0x20a290 and writer 0x205e40): 'cue ' points (region starts), LIST adtl 'labl' (names), 'note'
// (info), 'ltxt' (length and purpose), LIST 'tlst' (trigger notes: 24-byte entries 'cue ', cue id - 1,
// 1, 0xff, note, 0x90), 'acid' (beats / tempo) and 'smpl' (root note). Pure functions, defensive.

import type { SxRegion } from './types';
import { defaultRegion } from './defaults';

export interface WavData {
  channels: Float32Array[];
  sampleRate: number;
  /** Source format: bits per sample and float flag. */
  bits: number;
  float: boolean;
  regions: SxRegion[];
  tempo: number;
  beats: number;
  title: string;
  root: number;
}

const PURPOSES = ['loop', 'rgn ', 'beat', 'dwnb', 'trak', 'indx', 'wtsc', 'none'];
const MAX_BYTES = 512 << 20;

/** Parse a WAV file; null if it is not a readable RIFF / WAVE. */
export function parseSxWav(buf: ArrayBuffer | Uint8Array): WavData | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < 12 || u8.byteLength > MAX_BYTES) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o: number) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = 0, ch = 0, rate = 0, bits = 0, dataOff = -1, dataLen = 0;
  const cues = new Map<number, number>();
  const cueOrder: number[] = [];
  const labl = new Map<number, string>(), note = new Map<number, string>();
  const ltxt = new Map<number, { len: number; pur: string }>();
  const trig = new Map<number, number>();
  let tempo = 0, beats = 0, title = '', root = 60;
  const str = (o: number, n: number) => {
    let s = '';
    for (let i = 0; i < n && u8[o + i] !== 0; i++) s += String.fromCharCode(u8[o + i]);
    try { return decodeURIComponent(escape(s)); } catch { return s; }
  };
  const list = (o: number, end: number, kind: string) => {
    for (let p = o; p + 8 <= end;) {
      const id = tag(p), n = dv.getUint32(p + 4, true), b = p + 8;
      if (b + n > end) break;
      if (kind === 'adtl') {
        if ((id === 'labl' || id === 'note') && n >= 4) (id === 'labl' ? labl : note).set(dv.getUint32(b, true), str(b + 4, n - 4));
        else if (id === 'ltxt' && n >= 12) ltxt.set(dv.getUint32(b, true), { len: dv.getUint32(b + 4, true), pur: tag(b + 8) });
      } else if (kind === 'INFO' && id === 'INAM') title = str(b, n);
      p = b + n + (n & 1);
    }
    if (kind === 'tlst') {
      for (let p = o + 4, k = 0, cnt = dv.getUint32(o, true); k < cnt && p + 24 <= end; k++) {
        if (tag(p) === 'cue ' && dv.getUint32(p + 8, true) === 1 && u8[p + 14] === 0x90 && dv.getUint32(p + 16, true) === 0) {
          trig.set(dv.getUint32(p + 4, true) + 1, Math.min(127, u8[p + 13]));
        }
        p += 24 + dv.getUint32(p + 20, true);
      }
    }
  };
  for (let o = 12; o + 8 <= u8.byteLength;) {
    const id = tag(o), n = dv.getUint32(o + 4, true), b = o + 8;
    const end = Math.min(u8.byteLength, b + n);
    if (id === 'fmt ' && n >= 16) {
      fmt = dv.getUint16(b, true); ch = dv.getUint16(b + 2, true); rate = dv.getUint32(b + 4, true); bits = dv.getUint16(b + 14, true);
      if (fmt === 0xfffe && n >= 26) fmt = dv.getUint16(b + 24, true);
    } else if (id === 'data') {
      dataOff = b; dataLen = end - b;
    } else if (id === 'cue ' && n >= 4) {
      const k = dv.getUint32(b, true);
      for (let i = 0; i < k && b + 4 + 24 * (i + 1) <= end; i++) {
        const q = b + 4 + 24 * i;
        const cid = dv.getUint32(q, true);
        if (!cues.has(cid)) cueOrder.push(cid);
        cues.set(cid, dv.getUint32(q + 20, true));
      }
    } else if (id === 'LIST' && n >= 4) {
      list(b + 4, end, tag(b));
    } else if (id === 'tlst' && n >= 4) {
      list(b, end, 'tlst');
    } else if (id === 'acid' && n >= 24) {
      beats = dv.getUint32(b + 12, true);
      tempo = dv.getFloat32(b + 20, true);
    } else if (id === 'smpl' && n >= 36) {
      root = dv.getUint32(b + 12, true) & 0x7f;
    }
    o = b + n + (n & 1);
    if (n === 0 && id !== 'data') continue;
  }
  if (dataOff < 0 || ch < 1 || ch > 8 || rate < 1000 || rate > 768000) return null;
  const isFloat = fmt === 3;
  if (!isFloat && fmt !== 1) return null;
  if (isFloat ? bits !== 32 && bits !== 64 : ![8, 16, 24, 32].includes(bits)) return null;
  const bpf = (bits / 8) * ch;
  const frames = Math.floor(dataLen / bpf);
  const chans = Array.from({ length: Math.min(ch, 2) }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chans.length; c++) {
      const q = dataOff + i * bpf + c * (bits / 8);
      let v: number;
      if (isFloat) v = bits === 32 ? dv.getFloat32(q, true) : dv.getFloat64(q, true);
      else if (bits === 16) v = dv.getInt16(q, true) / 32768;
      else if (bits === 24) v = ((u8[q] | (u8[q + 1] << 8) | (u8[q + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bits === 32) v = dv.getInt32(q, true) / 2147483648;
      else v = (u8[q] - 128) / 128;
      chans[c][i] = v;
    }
  }
  const regions: SxRegion[] = [];
  for (const cid of cueOrder) {
    const s = cues.get(cid)!;
    if (s >= frames) continue;
    const rg = defaultRegion(s, -1);
    const lt = ltxt.get(cid);
    if (lt) {
      if (lt.len > 0) rg.e = Math.min(frames - 1, s + lt.len - 1);
      const k = PURPOSES.indexOf(lt.pur);
      rg.pur = k >= 0 ? k : 2;
    }
    rg.name = labl.get(cid) ?? '';
    rg.info = note.get(cid) ?? '';
    rg.note = trig.get(cid) ?? -1;
    regions.push(rg);
  }
  return { channels: chans, sampleRate: rate, bits, float: isFloat, regions, tempo, beats, title, root };
}
