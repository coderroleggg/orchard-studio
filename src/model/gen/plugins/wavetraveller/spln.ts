// Wave Traveller's spline preset files (.spln: "Save presets..." in the patch selector's menu, FL's Presets folder).
// Layout (FL: 0x603a0 writer, 0x61010 loader): tag 4000, version 1000005, speed mode, normalised SPEED (tempo mode),
// normalised SPEED (absolute mode), normalised ATT, normalised REL, START, END (float32), then the WAVE points, the
// VOL points (count + 60-byte records) and the mutes (count + 8-byte records), like a patch chunk. Parsed defensively.

import {
  attackFromWheel, attackToWheel, newPoint, normalizePatch, releaseFromWheel, releaseToWheel, speedFromWheel, speedToWheel,
  type WtPatch, type WtPoint,
} from './state';

const MAX_POINTS = 4096;
const MAX_MUTES = 65536;

/** The patch as a .spln file. */
export function writeSpln(p: WtPatch): Uint8Array {
  const n = 36 + 4 + 60 * p.wave.length + 4 + 60 * p.vol.length + 4 + 8 * p.mutes.length;
  const b = new Uint8Array(n);
  const dv = new DataView(b.buffer);
  let o = 0;
  const i32 = (v: number) => { dv.setInt32(o, v, true); o += 4; };
  const f32 = (v: number) => { dv.setFloat32(o, v, true); o += 4; };
  i32(4000); i32(1000005); i32(p.mode);
  f32(speedToWheel(0, p.steps)); f32(speedToWheel(1, p.speed));
  f32(attackToWheel(p.attack)); f32(releaseToWheel(p.release));
  f32(p.start); f32(p.end);
  for (const list of [p.wave, p.vol]) {
    i32(list.length);
    for (const q of list) {
      const r = o;
      dv.setFloat32(r + 8, q.x, true); dv.setFloat32(r + 12, q.y, true);
      dv.setFloat32(r + 20, q.h1x, true); dv.setFloat32(r + 24, q.h1y, true);
      dv.setFloat32(r + 32, q.h2x, true); dv.setFloat32(r + 36, q.h2y, true);
      dv.setFloat32(r + 40, q.tension, true);
      dv.setInt32(r + 48, q.type, true);
      dv.setUint8(r + 56, q.locked ? 1 : 0);
      o += 60;
    }
  }
  i32(p.mutes.length);
  for (const m of p.mutes) { dv.setUint8(o, m[0] ? 1 : 0); dv.setFloat32(o + 4, m[1], true); o += 8; }
  return b;
}

function readPoints(dv: DataView, o: number, n: number): { pts: WtPoint[]; end: number } | null {
  if (n < 0 || n > MAX_POINTS || o + 60 * n > dv.byteLength) return null;
  const pts: WtPoint[] = [];
  for (let k = 0; k < n; k++, o += 60) {
    const q = newPoint(dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true), dv.getInt32(o + 48, true), (dv.getUint8(o + 56) & 1) !== 0);
    q.h1x = dv.getFloat32(o + 20, true); q.h1y = dv.getFloat32(o + 24, true);
    q.h2x = dv.getFloat32(o + 32, true); q.h2y = dv.getFloat32(o + 36, true);
    q.tension = dv.getFloat32(o + 40, true);
    pts.push(q);
  }
  return { pts, end: o };
}

/** A .spln file as a patch (the name is kept by the caller); null if it is not one. */
export function readSpln(buf: ArrayBuffer | Uint8Array): WtPatch | null {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length < 36 + 12 || u.length > (1 << 24)) return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (dv.getInt32(0, true) !== 4000) return null;
  const mode = dv.getInt32(8, true);
  const spT = dv.getFloat32(12, true);
  const spA = dv.getFloat32(16, true);
  const att = dv.getFloat32(20, true);
  const rel = dv.getFloat32(24, true);
  const start = dv.getFloat32(28, true);
  const end = dv.getFloat32(32, true);
  let o = 36;
  const wave = readPoints(dv, o + 4, dv.getInt32(o, true));
  if (!wave) return null;
  o = wave.end;
  if (o + 4 > u.length) return null;
  const vol = readPoints(dv, o + 4, dv.getInt32(o, true));
  if (!vol) return null;
  o = vol.end;
  const mutes: [number, number][] = [];
  if (o + 4 <= u.length) {
    const n = dv.getInt32(o, true);
    o += 4;
    if (n < 0 || n > MAX_MUTES || o + 8 * n > u.length) return null;
    for (let k = 0; k < n; k++, o += 8) mutes.push([dv.getUint8(o), dv.getFloat32(o + 4, true)]);
  }
  const m = mode === 1 ? 1 : 0;
  return normalizePatch({
    name: '', start, end,
    steps: speedFromWheel(0, Number.isFinite(spT) ? spT : 0.5),
    speed: speedFromWheel(1, Number.isFinite(spA) ? spA : 0.2),
    attack: attackFromWheel(Number.isFinite(att) ? att : 0),
    release: releaseFromWheel(Number.isFinite(rel) ? rel : 0),
    mode: m, wave: wave.pts, vol: vol.pts, mutes,
  });
}
