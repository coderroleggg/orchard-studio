// Sytrus factory preset bank decoder. FL's 984 presets (Data/Patches/Plugin
// presets/Generators/Sytrus/**/*.fst) were loaded in FL's own Sytrus (test
// host), saved in its current state format and converted to this plugin's
// state model by scratchpad/sytrus/tools (conv.py, pack2.py). The bank is one
// binary blob ("SY2"): a table of unique harmonic sets (amplitudes as 16-bit
// log codes, 1e-7..1; phases as 16-bit fractions), a table of unique envelope
// curves (float32 points), then per preset its parameter changes from the
// "Default" preset (the first one, fully listed), the matrices, operators,
// filters, articulators (only curves that differ from Default), globals,
// effects and the info text. Raw deflate + base64 (presets.ts).

import { inflateRaw, base64ToBytes } from './inflate';
import type { SyArt, SyEnv, SyState } from './types';
import { paramKeys, UNIT_ARTS } from './types';
import { defaultArtEnv } from './defaults';

function sameEnv(a: SyEnv, b: SyEnv): boolean {
  if (a.p.length !== b.p.length || a.ph !== b.ph) return false;
  for (let i = 0; i < 5; i++) if (a.m[i] !== b.m[i]) return false;
  for (let i = 0; i < a.p.length; i++) {
    const p = a.p[i], q = b.p[i];
    if (p.length !== q.length) return false;
    for (let k = 0; k < p.length; k++) if (p[k] !== q[k]) return false;
  }
  return true;
}

class Reader {
  p = 0;
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u(): number {
    let v = 0, s = 0;
    for (;;) {
      const c = this.b[this.p++];
      v += (c & 0x7f) * 2 ** s;
      if (!(c & 0x80)) return v;
      s += 7;
    }
  }
  i(): number { const z = this.u(); return z % 2 ? -(z + 1) / 2 : z / 2; }
  byte(): number { return this.b[this.p++]; }
  f(): number { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  u16(): number { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  /** UTF-8 string (decoded by hand: TextDecoder is not available in AudioWorklets). */
  str(): string {
    const n = this.u();
    const end = this.p + n;
    let s = '';
    while (this.p < end) {
      const c = this.b[this.p++];
      let cp = c;
      if (c >= 0xf0) cp = ((c & 7) << 18) | ((this.b[this.p++] & 63) << 12) | ((this.b[this.p++] & 63) << 6) | (this.b[this.p++] & 63);
      else if (c >= 0xe0) cp = ((c & 15) << 12) | ((this.b[this.p++] & 63) << 6) | (this.b[this.p++] & 63);
      else if (c >= 0xc0) cp = ((c & 31) << 6) | (this.b[this.p++] & 63);
      s += String.fromCodePoint(cp);
    }
    return s;
  }
}

/** The shortest decimal that is the same float32 (FL stores float32; keeps the JSON state short and exact). */
export function shortF32(x: number): number {
  const f = Math.fround(x);
  for (let p = 6; p < 10; p++) {
    const v = Number(f.toPrecision(p));
    if (Math.fround(v) === f) return v;
  }
  return f;
}
/** 7 significant digits (dequantized harmonics). */
const r7 = (x: number) => Number(x.toPrecision(7));

const G_KEYS = ['dqEnv', 'rqEnv', 'dqOver', 'rqOver', 'modSmooth', 'rand', 'gPitch', 'monoKey', 'x792', 'x796', 'sendTrack', 'soften',
  'oscUni', 'gCenter', 'gibbs', 'arpInv', 'portaVar', 'portaTrack', 'portaLimit', 'velVol', 'velAtt', 'relRel', 'uniDist',
  'eqMode', 'x510', 'hqWs'] as const;
const REV_KEYS = ['lc', 'hc', 'pd', 'rs', 'df', 'de', 'hd', 'col', 'vol', 'on', 'tempo'] as const;
const OP_KEYS = ['ratio', 'ofs', 'ns', 'sh', 'tn', 'sk', 'sn', 'fl'] as const;
const OP_FLAGS = ['half', 'even', 'abs', 'glob', 'center', 'declick', 'pluck', 'blimit'] as const;

export interface DecodedPreset {
  params: Record<string, number>;
  sy: SyState;
}

/** Decode the bank: one state per preset (in the names' order; articulators compact, see SyArt). */
export function decodeBank(b64: string, count: number): DecodedPreset[] {
  const r = new Reader(inflateRaw(base64ToBytes(b64)));
  if (r.byte() !== 0x53 || r.byte() !== 0x59 || r.byte() !== 0x32) throw new Error('Sytrus preset bank: bad header');
  const n = r.u();
  if (n !== count) throw new Error('Sytrus preset bank: preset count mismatch');
  // harmonic sets
  const nh = r.u();
  const lens: [number, number][] = [];
  for (let i = 0; i < nh; i++) lens.push([r.u(), r.u()]);
  const harm: { amp: number[]; ph: number[] }[] = lens.map(() => ({ amp: [], ph: [] }));
  for (let i = 0; i < nh; i++) {
    for (let k = 0; k < lens[i][0]; k++) {
      const c = r.u16();
      harm[i].amp.push(c === 0 ? 0 : r7(10 ** (((c - 1) / 65534) * 7 - 7)));
    }
  }
  for (let i = 0; i < nh; i++) for (let k = 0; k < lens[i][1]; k++) harm[i].ph.push(r7(r.u16() / 65536));
  // envelope curves
  const ne = r.u();
  const envs: SyEnv[] = [];
  const npts: number[] = [];
  for (let i = 0; i < ne; i++) {
    const np = r.u();
    const m = [r.i(), r.i(), r.i(), r.i(), r.i()];
    const e: SyEnv = { p: [], m };
    if (r.byte()) e.ph = r.i();
    envs.push(e);
    npts.push(np);
    for (let k = 0; k < np; k++) e.p.push([0, 0, 0]);
  }
  for (let col = 0; col < 3; col++) for (let i = 0; i < ne; i++) for (let k = 0; k < npts[i]; k++) envs[i].p[k][col] = shortF32(r.f());
  for (let i = 0; i < ne; i++) {
    for (let k = 0; k < npts[i]; k++) {
      const seg = r.byte(), b1 = r.byte(), b2 = r.byte();
      if (seg || b1 || b2) envs[i].p[k].push(seg, b1, b2);
    }
  }
  const cloneEnv = (e: SyEnv): SyEnv => {
    const c: SyEnv = { p: e.p.map((q) => q.slice()), m: e.m.slice() };
    if (e.ph !== undefined) c.ph = e.ph;
    return c;
  };
  const keys = paramKeys();
  const out: DecodedPreset[] = [];
  let base: DecodedPreset | null = null;
  for (let pi = 0; pi < n; pi++) {
    const params: Record<string, number> = base ? { ...base.params } : {};
    const nch = r.u();
    let idx = -1;
    for (let c = 0; c < nch; c++) { idx += r.u() + 1; params[keys[idx]] = r.i(); }
    const sparse = (len: number): number[] => {
      const a = new Array(len).fill(0);
      const k = r.u();
      let j = -1;
      for (let c = 0; c < k; c++) { j += r.u() + 1; a[j] = r.i(); }
      return a;
    };
    const fm = sparse(81), rm = sparse(81);
    const mute = new Array(162).fill(0);
    { const k = r.u(); let j = -1; for (let c = 0; c < k; c++) { j += r.u() + 1; mute[j] = 1; } }
    const ops = [];
    for (let o = 0; o < 6; o++) {
      const op: Record<string, unknown> = {};
      for (const k of OP_KEYS) op[k] = r.i();
      const fl = r.byte();
      OP_FLAGS.forEach((k, b) => { op[k] = (fl >> b) & 1; });
      const h = harm[r.u()];
      op.amp = h.amp.slice();
      op.ph = h.ph.slice();
      ops.push(op as unknown as SyState['ops'][number]);
    }
    const flt = [];
    for (let f = 0; f < 3; f++) {
      const type = r.i(), hq = r.i(), flat = r.i(), ws = r.i(), wsBip = r.i();
      flt.push({ type, hq, flat, ws, wsBip, wsMap: cloneEnv(envs[r.u()]) });
    }
    // articulators, compact (null = FL's default curve / articulator); env objects are shared with the
    // curve table (normalizeSy copies them into the state)
    const arts: (SyArt | null)[][] = [];
    for (let u = 0; u < UNIT_ARTS.length; u++) {
      const ua: (SyArt | null)[] = [];
      for (let a = 0; a < UNIT_ARTS[u].length; a++) {
        const mask = r.u();
        const b = base ? base.sy.arts[u][a] : null;
        const ea = mask & 256 ? shortF32(r.f()) : b ? b.ea : 1;
        const la = mask & 512 ? shortF32(r.f()) : b ? b.la : 1;
        const e: (SyEnv | null)[] = [];
        let any = ea !== 1 || la !== 1;
        for (let j = 0; j < 8; j++) {
          let v: SyEnv | null;
          if (mask & (1 << j)) {
            v = envs[r.u()];
            if (sameEnv(v, defaultArtEnv(u, a, j))) v = null;
          } else v = b ? b.e[j] : null;
          if (v) any = true;
          e.push(v);
        }
        ua.push(any ? { ea, la, e } : null);
      }
      arts.push(ua);
    }
    const g: Record<string, unknown> = {};
    for (const k of G_KEYS) g[k] = r.i();
    g.eqType = [r.i(), r.i(), r.i()];
    const del = [0, 1, 2].map(() => ({ tempo: r.i(), serial: r.i(), on: r.i() }));
    const rev: Record<string, number> = {};
    for (const k of REV_KEYS) rev[k] = r.i();
    const info = r.str();
    const p: DecodedPreset = {
      params,
      sy: { fm, rm, mute, ops, flt, arts, g: g as unknown as SyState['g'], del, rev: rev as unknown as SyState['rev'], info },
    };
    out.push(p);
    if (!base) base = p;
  }
  return out;
}
