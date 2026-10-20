// Digests of an Ogun state for the random preset generator's tests: the plugin state of FL (parsed .state) and the model's state are
// reduced to the same fields and hashed (FNV-1a over the numbers), so the generator can be compared with FL's output by a few numbers.
import type { OgArt, OgEnv } from '../../src/model/gen/plugins/ogun/types';
import { OGUN_KEYS } from '../../src/model/gen/plugins/ogun/params';

export interface Common {
  ints: number[];
  b3: number[];
  eq: number[];
  info: string;
  arts: OgArt[];
  maps: OgEnv[];
}

/** The model's generated state in the common form. */
export function fromModel(st: Record<string, unknown>): Common {
  return {
    ints: [...OGUN_KEYS.slice(0, 49).map((k) => st[k] as number), ...(st.xi as number[])],
    b3: st.b3 as number[], eq: st.i2 as number[], info: st.info as string, arts: st.arts as OgArt[], maps: st.maps as OgEnv[],
  };
}

class Hash {
  h = 2166136261;
  private readonly dv = new DataView(new ArrayBuffer(8));
  byte(b: number): void {
    this.h = Math.imul(this.h ^ (b & 255), 16777619) >>> 0;
  }
  i32(v: number): void {
    for (let k = 0; k < 4; k++) this.byte((v >>> (8 * k)) & 255);
  }
  f32(v: number): void {
    this.dv.setFloat32(0, v, true);
    for (let k = 0; k < 4; k++) this.byte(this.dv.getUint8(k));
  }
  f64(v: number): void {
    this.dv.setFloat64(0, v, true);
    for (let k = 0; k < 8; k++) this.byte(this.dv.getUint8(k));
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) { this.byte(s.charCodeAt(i)); this.byte(s.charCodeAt(i) >> 8); }
  }
}

function curve(h: Hash, c: OgEnv): void {
  h.i32(c.t);
  h.i32(c.p.length);
  for (const q of c.p) {
    h.f64(q[0]); h.f32(q[1]); h.f32(q[2]);
    for (let k = 3; k < 7; k++) h.byte(q[k] ?? 0);
  }
  for (const m of c.m) h.i32(m);
  for (const a of c.a ?? []) h.i32(a);
  for (const a of c.l ?? []) h.i32(a);
  if (c.t === 2) h.i32(c.ph ?? 0);
}

export interface Digest {
  ints: number;
  info: number;
  arts: number;
  /** One digest per shaping map (null: left out as FL content). */
  maps: (number | null)[];
}

export function digest(s: Common, skipMap1: boolean): Digest {
  const a = new Hash();
  s.ints.forEach((v) => a.i32(v));
  s.b3.forEach((v) => a.i32(v));
  s.eq.forEach((v) => a.i32(v));
  const i = new Hash();
  i.str(s.info);
  const r = new Hash();
  for (const art of s.arts) {
    r.f32(art.mode); r.f32(art.ea); r.f32(art.la);
    curve(r, art.e); curve(r, art.l);
    for (const k of art.k) curve(r, k);
  }
  const maps = s.maps.map((m, j) => {
    if (skipMap1 && j === 1) return null;
    const h = new Hash();
    curve(h, m);
    return h.h;
  });
  return { ints: a.h, info: i.h, arts: r.h, maps };
}
