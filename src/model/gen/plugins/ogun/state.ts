// Ogun plugin state: the 89 parameters (flat keys, params.ts) plus the settings, info text and curves of FL's state
// (types.ts). The factory presets (presets.ts) and a new instance (base.ts, FL's plugin database entry) are stored as
// generated entries and expanded here; curves left out as FL content (`missing`) get default stand-ins.

import type { FxParams } from '../../../fx/types';
import { OG_BASE } from './base';
import { OG_PRESET_BANK, OG_PRESET_NAMES } from './presets';
import { base64ToBytes, inflateRaw } from './inflate';
import { OGUN_PARAMS, ART_TARGETS } from './params';
import type { OgArt, OgEntry, OgEnv } from './types';

export { OG_PRESET_NAMES };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function numArr(a: unknown, n: number): a is number[] {
  if (!Array.isArray(a) || a.length !== n) return false;
  for (let i = 0; i < n; i++) if (!isNum(a[i])) return false;
  return true;
}

/** Flat points [x, y, tension, packed bytes] -> [x, y, tension, b0, b1, b2, b3]. */
function expandPoints(flat: unknown): number[][] {
  const out: number[][] = [];
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const b = flat[i + 3] as number;
    out.push([flat[i] as number, flat[i + 1] as number, flat[i + 2] as number, b & 255, (b >>> 8) & 255, (b >>> 16) & 255, (b >>> 24) & 255]);
  }
  return out;
}

/** An entry curve [points, markers, a4 | l4, phase] -> OgEnv of the given type. */
function expandCurve(c: unknown, t: number, def: OgEnv): OgEnv {
  const x = c as unknown[];
  const p = expandPoints(x[0]);
  if (!p.length) return def;
  const e: OgEnv = { t, p, m: (x[1] as number[]).slice() };
  if (t === 1) e.a = (x[2] as number[]).slice();
  if (t === 2) { e.l = (x[2] as number[]).slice(); e.ph = x[3] as number; }
  return e;
}

/** Stand-in for a curve the preset leaves out: FL's default envelope / LFO, or a flat mapping. */
function defaultCurve(t: number, y: number): OgEnv {
  if (t === 1) return { t, p: [[0, 0, 0, 0, 0, 0, 0], [0.75, 1, 0.2, 0, 0, 0, 1], [1.5, 0.5, 0.2, 0, 0, 0, 1], [0.25, 0, 0.2, 0, 0, 0, 1]], m: [0, 0, 1, -1, 2], a: [128, 128, 0, 128] };
  if (t === 2) return { t, p: [[0, 0.5, 0, 0, 0, 0, 0], [1, 0.5, 0, 0, 0, 0, 2], [0.25, 1, 0, 0, 0, 0, 2], [1, 0.5, 0, 0, 0, 0, 2]], m: [0, 0, -1, -1, 2], l: [40000, 0, 0, 0], ph: 0 };
  return { t, p: [[0, y, 0, 0, 0, 0, 0], [1, y, 0, 0, 0, 0, 2]], m: [0, -1, -1, -1, -1] };
}
/** The default level of each shaping map (forced harmonics 0, the EQ maps 0.5). */
const MAP_DEF = [0, 0.5, 0.5, 0.5];

/** Expand a generated entry into a plugin state. */
export function entryToState(e: OgEntry): FxParams {
  const out: FxParams = {};
  for (let i = 0; i < 49; i++) out[OGUN_PARAMS[i].key] = e.i[i];
  const arts: OgArt[] = e.a.map((a) => {
    const k = (a as unknown[]).slice(5);
    return {
      mode: a[0] as number, ea: a[1] as number, la: a[2] as number,
      e: expandCurve(a[3], 1, defaultCurve(1, 0)), l: expandCurve(a[4], 2, defaultCurve(2, 0)),
      k: [0, 1, 2, 3].map((j) => expandCurve(k[j], 3, defaultCurve(3, 0.5))),
    };
  });
  for (let g = 0; g < ART_TARGETS.length; g++) {
    const kp = ART_TARGETS[g][0], a = arts[g].e.a ?? [128, 128, 0, 128], l = arts[g].l.l ?? [40000, 0, 0, 0];
    ['Att', 'Dec', 'Sus', 'Rel'].forEach((s, j) => { out[kp + s] = a[j]; });
    ['LfoSpd', 'LfoTns', 'LfoSkw', 'LfoPw'].forEach((s, j) => { out[kp + s] = l[j]; });
  }
  out.xi = e.i.slice(49);
  out.b3 = e.b.slice();
  out.i2 = e.c.slice();
  out.info = e.t;
  out.arts = arts;
  out.maps = e.m.map((m, j) => expandCurve(m, 3, defaultCurve(3, MAP_DEF[j])));
  out.missing = e.x.slice();
  return out;
}

let bank: OgEntry[] | null = null;
/** The factory presets (decoded on first use). */
export function ogunBank(): OgEntry[] {
  if (!bank) bank = JSON.parse(utf8(inflateRaw(base64ToBytes(OG_PRESET_BANK)))) as OgEntry[];
  return bank;
}

/** UTF-8 bytes to a string (no TextDecoder: the AudioWorklet scope may lack it). */
function utf8(b: Uint8Array): string {
  const cps: number[] = [];
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i++];
    if (c < 0x80) cps.push(c);
    else if (c < 0xe0) cps.push(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    else if (c < 0xf0) { cps.push(((c & 0x0f) << 12) | ((b[i] & 0x3f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
    else { cps.push(((c & 0x07) << 18) | ((b[i] & 0x3f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; }
    if (cps.length >= 8192) { s += String.fromCodePoint(...cps); cps.length = 0; }
  }
  return s + String.fromCodePoint(...cps);
}

let fresh: FxParams | null = null;
/** The cached fresh state (read only). */
function freshRef(): FxParams {
  if (!fresh) fresh = entryToState(OG_BASE as unknown as OgEntry);
  return fresh;
}
/** The state a new Ogun has (FL's plugin database entry). */
export function freshState(): FxParams {
  return structuredClone(freshRef());
}

// ------------------------------------------------------------- normalisation

const MAX_POINTS = 4096;
/** Mapping curves (type 3) may hold FL's analysed resynthesis maps: up to 31 624 points in FL's presets. */
const MAX_MAP_POINTS = 65536;
const num = (x: unknown, d: number): number => (isNum(x) ? x : d);

function curveTotal(p: number[][]): number {
  let t = 0;
  for (const q of p) t += q[0];
  return t;
}

/** FL's fixed-length normalisation of mapping curves (TCustomMEnvelope 0x447d00 as in Harmor): point at 0, distances sum to 1. */
function mapFixLength(p: number[][], def: number): number[][] {
  let q = p.map((x) => x.slice());
  if (!q.length) q = [[0, def]];
  else if (q[0][0] > 0) q.unshift([0, q[0][1]]);
  const t = curveTotal(q);
  if (!(t > 0)) q.push([1, q[q.length - 1][1]]);
  else if (Math.abs(t - 1) > 1e-6) {
    const r = 1 / t;
    for (const x of q) x[0] = Math.fround(x[0] * r);
  }
  return q;
}

function mapLenOk(p: number[][]): boolean {
  if (!p.length || p[0][0] > 0) return false;
  const t = curveTotal(p);
  return t > 0 && Math.abs(t - 1) <= 1e-6;
}

function envOk(x: unknown, d: OgEnv): x is OgEnv {
  if (!x || typeof x !== 'object') return false;
  const e = x as OgEnv;
  if (!isNum(e.t) || !numArr(e.m, 5) || !Array.isArray(e.p) || e.p.length === 0 || e.p.length > (e.t === 3 ? MAX_MAP_POINTS : MAX_POINTS)) return false;
  for (let i = 0; i < e.p.length; i++) {
    const q = e.p[i];
    if (!Array.isArray(q) || q.length < 2 || q.length > 7) return false;
    for (let j = 0; j < q.length; j++) if (!isNum(q[j])) return false;
  }
  if (d.a && !numArr(e.a, 4)) return false;
  if (d.l && (!numArr(e.l, 4) || !isNum(e.ph))) return false;
  if (e.t === 3 && !mapLenOk(e.p)) return false;
  return true;
}

function normEnv(x: unknown, d: OgEnv): OgEnv {
  if (envOk(x, d)) return x;
  if (!x || typeof x !== 'object') return d;
  const e = x as Partial<OgEnv>;
  const pts = Array.isArray(e.p) ? e.p.filter((q) => Array.isArray(q) && q.length >= 2).map((q) => q.slice(0, 7).map((v) => num(v, 0))) : [];
  const t = d.t;
  const out: OgEnv = {
    t,
    p: t === 3 ? mapFixLength(pts.slice(0, MAX_MAP_POINTS), d.p[0]?.[1] ?? 0) : pts.length ? pts.slice(0, MAX_POINTS) : d.p,
    m: Array.isArray(e.m) && e.m.length === 5 ? e.m.map((v, i) => Math.round(num(v, d.m[i]))) : d.m,
  };
  if (d.a) out.a = Array.isArray(e.a) && e.a.length === 4 ? e.a.map((v, i) => num(v, d.a![i])) : d.a;
  if (d.l) {
    out.l = Array.isArray(e.l) && e.l.length === 4 ? e.l.map((v, i) => num(v, d.l![i])) : d.l;
    out.ph = num(e.ph, d.ph ?? 0);
  }
  return out;
}

function normArt(x: unknown): OgArt {
  const d: OgArt = { mode: 0, ea: 1, la: 1, e: defaultCurve(1, 0), l: defaultCurve(2, 0), k: [0, 1, 2, 3].map(() => defaultCurve(3, 0.5)) };
  if (!x || typeof x !== 'object') return d;
  const a = x as Partial<OgArt>;
  const k = Array.isArray(a.k) ? a.k : [];
  return { mode: num(a.mode, 0), ea: num(a.ea, 1), la: num(a.la, 1), e: normEnv(a.e, d.e), l: normEnv(a.l, d.l), k: d.k.map((m, i) => normEnv(k[i], m)) };
}

/** View state (editor page) kept across preset loads. */
export interface OgView {
  target: number;
  part: number;
  kb: number;
}
export function defaultView(): OgView {
  return { target: 0, part: 0, kb: 1 };
}

/** Repair a stored state; expands a factory preset reference ({ __og: index }). */
export function normalizeOgun(p: FxParams): FxParams {
  let q: FxParams = { ...p };
  if (typeof q.__og === 'number') {
    const e = ogunBank()[q.__og];
    delete q.__og;
    if (e) q = { ...q, ...entryToState(e) };
  }
  const f = freshRef();
  for (const d of OGUN_PARAMS) {
    const v = q[d.key];
    q[d.key] = isNum(v) ? Math.min(d.max, Math.max(d.min, Math.round(v))) : (f[d.key] as number);
  }
  q.xi = numArr(q.xi, 15) ? (q.xi as number[]).map((v) => Math.round(v) | 0) : (f.xi as number[]).slice();
  q.b3 = numArr(q.b3, 3) ? (q.b3 as number[]).map((v) => Math.round(v) & 255) : (f.b3 as number[]).slice();
  // the three EQ band types (0 low shelf, 1 peaking, 2 high shelf); older two-int states have band 3 = 2
  const i2 = numArr(q.i2, 3) ? (q.i2 as number[]) : numArr(q.i2, 2) ? [...(q.i2 as number[]), 2] : (f.i2 as number[]);
  q.i2 = i2.map((v) => Math.min(2, Math.max(0, Math.round(v) | 0)));
  q.info = typeof q.info === 'string' ? q.info.slice(0, 4096) : '';
  const arts = Array.isArray(q.arts) ? q.arts : [];
  q.arts = Array.from({ length: 13 }, (_, i) => normArt(arts[i] ?? (f.arts as OgArt[])[i]));
  const maps = Array.isArray(q.maps) ? q.maps : [];
  q.maps = Array.from({ length: 4 }, (_, i) => normEnv(maps[i] ?? (f.maps as OgEnv[])[i], defaultCurve(3, MAP_DEF[i])));
  q.missing = Array.isArray(q.missing) ? q.missing.filter((s): s is string => typeof s === 'string') : [];
  // the articulator knobs live in the flat keys: write them into the curves' own copies
  const arr = q.arts as OgArt[];
  for (let g = 0; g < ART_TARGETS.length; g++) {
    const kp = ART_TARGETS[g][0];
    const a = ['Att', 'Dec', 'Sus', 'Rel'].map((s) => q[kp + s] as number);
    const l = ['LfoSpd', 'LfoTns', 'LfoSkw', 'LfoPw'].map((s) => q[kp + s] as number);
    const art = arr[g];
    if (!art.e.a || a.some((v, i) => v !== art.e.a![i])) arr[g] = { ...art, e: { ...art.e, a } };
    if (!arr[g].l.l || l.some((v, i) => v !== arr[g].l.l![i])) arr[g] = { ...arr[g], l: { ...arr[g].l, l } };
  }
  return q;
}
