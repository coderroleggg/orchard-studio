// WAV files for Edison: 16 / 24-bit PCM or 32-bit float, with Edison's
// regions as cue points ('cue ' + 'LIST adtl' labels, 'ltxt' lengths for
// regions) and the root note / loop in a 'smpl' chunk, like FL writes them.
// The reader recovers those markers when a WAV is loaded back.

import type { EdMarker } from '../../../../model/fx/plugins/edison';

export interface WavMeta {
  markers?: EdMarker[];
  loop?: [number, number] | null;
  root?: number;
  title?: string;
}

function pad2(n: number): number { return n + (n & 1); }

export function encodeEdisonWav(ch: Float32Array[], sampleRate: number, bits: 16 | 24 | 32, meta: WavMeta = {}): ArrayBuffer {
  const nch = Math.max(1, ch.length);
  const n = ch[0]?.length ?? 0;
  const bps = bits / 8;
  const dataSize = n * nch * bps;
  const markers = meta.markers ?? [];
  const enc = new TextEncoder();
  const labels = markers.map((m) => enc.encode(m.name + '\0'));
  const cueSize = markers.length ? 4 + markers.length * 24 : 0;
  let adtlSize = 0;
  markers.forEach((m, i) => {
    adtlSize += 8 + pad2(4 + labels[i].length);
    if (m.end !== undefined) adtlSize += 8 + 20;
  });
  const listSize = markers.length ? 4 + adtlSize : 0;
  const infoName = meta.title ? enc.encode(meta.title + '\0') : null;
  const infoSize = infoName ? 4 + 8 + pad2(infoName.length) : 0;
  const smplSize = 36 + (meta.loop ? 24 : 0);
  const fmtSize = 16;
  const total = 4 + (8 + fmtSize) + (8 + pad2(dataSize)) + (8 + smplSize) + (cueSize ? 8 + cueSize : 0) + (listSize ? 8 + listSize : 0) + (infoSize ? 8 + infoSize : 0);
  const buf = new ArrayBuffer(8 + total);
  const v = new DataView(buf);
  let o = 0;
  const str = (s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); };
  const u32 = (x: number) => { v.setUint32(o, x >>> 0, true); o += 4; };
  const u16 = (x: number) => { v.setUint16(o, x, true); o += 2; };
  str('RIFF'); u32(total); str('WAVE');
  str('fmt '); u32(fmtSize);
  u16(bits === 32 ? 3 : 1); u16(nch); u32(sampleRate); u32(sampleRate * nch * bps); u16(nch * bps); u16(bits);
  str('data'); u32(dataSize);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const x = (ch[c] ?? ch[0])[i];
      if (bits === 32) { v.setFloat32(o, x, true); o += 4; continue; }
      const cl = Math.max(-1, Math.min(1, x));
      if (bits === 16) { v.setInt16(o, Math.round(cl * 32767), true); o += 2; }
      else {
        const s = Math.round(cl * 8388607);
        v.setUint8(o, s & 0xff); v.setUint8(o + 1, (s >> 8) & 0xff); v.setUint8(o + 2, (s >> 16) & 0xff);
        o += 3;
      }
    }
  }
  if (dataSize & 1) v.setUint8(o++, 0);
  // smpl: root note and loop
  str('smpl'); u32(smplSize);
  u32(0); u32(0); u32(Math.round(1e9 / sampleRate)); u32(meta.root ?? 60); u32(0); u32(0); u32(0);
  u32(meta.loop ? 1 : 0); u32(0);
  if (meta.loop) { u32(0); u32(0); u32(meta.loop[0]); u32(Math.max(meta.loop[0], meta.loop[1] - 1)); u32(0); u32(0); }
  if (cueSize) {
    str('cue '); u32(cueSize); u32(markers.length);
    markers.forEach((m, i) => { u32(i + 1); u32(m.pos); str('data'); u32(0); u32(0); u32(m.pos); });
  }
  if (listSize) {
    str('LIST'); u32(listSize); str('adtl');
    markers.forEach((m, i) => {
      const l = labels[i];
      str('labl'); u32(4 + l.length); u32(i + 1);
      for (const b of l) v.setUint8(o++, b);
      if (l.length & 1) v.setUint8(o++, 0);
      if (m.end !== undefined) {
        str('ltxt'); u32(20); u32(i + 1); u32(m.end - m.pos); str('rgn '); u16(0); u16(0); u16(0); u16(0);
      }
    });
  }
  if (infoName) {
    str('LIST'); u32(infoSize); str('INFO');
    str('INAM'); u32(infoName.length);
    for (const b of infoName) v.setUint8(o++, b);
    if (infoName.length & 1) v.setUint8(o++, 0);
  }
  return buf;
}

/** Markers, loop and root note stored in a WAV file (Edison's or another editor's). */
export function readWavMeta(data: ArrayBuffer): WavMeta {
  const out: WavMeta = {};
  if (data.byteLength < 12) return out;
  const v = new DataView(data);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return out;
  const cues = new Map<number, number>();
  const names = new Map<number, string>();
  const lens = new Map<number, number>();
  const dec = new TextDecoder();
  const readStr = (o: number, n: number) => {
    const bytes = new Uint8Array(data, o, Math.max(0, n));
    let end = bytes.indexOf(0);
    if (end < 0) end = bytes.length;
    return dec.decode(bytes.subarray(0, end));
  };
  let o = 12;
  while (o + 8 <= data.byteLength) {
    const id = tag(o), size = v.getUint32(o + 4, true), body = o + 8;
    if (body + size > data.byteLength) break;
    if (id === 'cue ' && size >= 4) {
      const cnt = v.getUint32(body, true);
      for (let i = 0; i < cnt && body + 4 + i * 24 + 24 <= body + size; i++) {
        const p = body + 4 + i * 24;
        cues.set(v.getUint32(p, true), v.getUint32(p + 20, true));
      }
    } else if (id === 'LIST' && size >= 4 && tag(body) === 'adtl') {
      let q = body + 4;
      while (q + 8 <= body + size) {
        const sid = tag(q), ssz = v.getUint32(q + 4, true);
        if (sid === 'labl' && ssz >= 4) names.set(v.getUint32(q + 8, true), readStr(q + 12, ssz - 4));
        if (sid === 'ltxt' && ssz >= 8) lens.set(v.getUint32(q + 8, true), v.getUint32(q + 12, true));
        q += 8 + pad2(ssz);
      }
    } else if (id === 'LIST' && size >= 4 && tag(body) === 'INFO') {
      let q = body + 4;
      while (q + 8 <= body + size) {
        const sid = tag(q), ssz = v.getUint32(q + 4, true);
        if (sid === 'INAM') out.title = readStr(q + 8, ssz);
        q += 8 + pad2(ssz);
      }
    } else if (id === 'smpl' && size >= 36) {
      out.root = v.getUint32(body + 12, true);
      const loops = v.getUint32(body + 28, true);
      if (loops > 0 && size >= 60) {
        const s = v.getUint32(body + 36 + 8, true), e = v.getUint32(body + 36 + 12, true);
        if (e >= s) out.loop = [s, e + 1];
      }
    }
    o = body + pad2(size);
  }
  if (cues.size) {
    out.markers = [...cues.entries()].sort((a, b) => a[1] - b[1]).map(([cid, pos]) => {
      const m: EdMarker = { pos, name: names.get(cid) ?? '' };
      const l = lens.get(cid);
      if (l && l > 0) m.end = pos + l;
      return m;
    });
  }
  return out;
}
