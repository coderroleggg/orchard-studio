// Slicing and tempo information stored in a WAV file, read defensively: the cue points
// ("cue " chunk, named by "LIST"/"adtl"/"labl"), which FL turns into slices ("Use sample
// built-in slicing"), and the ACID chunk's tempo (FL's sample tempo, else 120 BPM).

import type { Marker } from './slicing';

export interface WavMeta {
  markers: Marker[];
  /** The file's tempo in BPM (0 = none). */
  tempo: number;
}

export function parseWavMeta(buf: ArrayBuffer): WavMeta {
  const out: WavMeta = { markers: [], tempo: 0 };
  if (buf.byteLength < 12) return out;
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return out;
  const cues = new Map<number, number>();
  const names = new Map<number, string>();
  const text = (o: number, n: number) => {
    let s = '';
    for (let i = 0; i < n && o + i < buf.byteLength; i++) {
      const c = dv.getUint8(o + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = tag(o), n = dv.getUint32(o + 4, true), body = o + 8;
    const end = Math.min(buf.byteLength, body + n);
    if (id === 'cue ' && body + 4 <= end) {
      const count = dv.getUint32(body, true);
      for (let i = 0; i < count && body + 4 + 24 * (i + 1) <= end; i++) {
        const p = body + 4 + 24 * i;
        cues.set(dv.getUint32(p, true), dv.getUint32(p + 20, true));
      }
    } else if (id === 'LIST' && body + 4 <= end && tag(body) === 'adtl') {
      for (let q = body + 4; q + 8 <= end;) {
        const sid = tag(q), sn = dv.getUint32(q + 4, true);
        if ((sid === 'labl' || sid === 'note') && sn >= 4 && q + 12 <= end && sid === 'labl') names.set(dv.getUint32(q + 8, true), text(q + 12, sn - 4));
        q += 8 + sn + (sn & 1);
      }
    } else if (id === 'acid' && n >= 24 && body + 24 <= end) {
      const t = dv.getFloat32(body + 20, true);
      if (Number.isFinite(t) && t > 0 && t < 1000) out.tempo = t;
    }
    if (n === 0 && id === '\0\0\0\0') break;
    o = body + n + (n & 1);
  }
  for (const [cid, pos] of cues) out.markers.push({ pos, name: names.get(cid) ?? '' });
  out.markers.sort((a, b) => a.pos - b.pos);
  return out;
}
