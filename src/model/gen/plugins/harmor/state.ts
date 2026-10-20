// Harmor plugin state: the 825 parameters (flat keys, params.ts) plus the
// non-automatable state under `hA` / `hB` (parts), `hG` (global) and the view
// settings `hView`. Factory presets and the fresh instance are stored as
// differences to BASE (FL's "Default" preset as FL saves it): see base.ts,
// presets.ts and scratchpad/harmor/tools/gen_model.py.

import type { FxParams } from '../../../fx/types';
import { BASE, FRESH } from './base';
import { HARMOR_KEYS, HARMOR_PARAMS, ART_ENV_TARGETS, artKey } from './params';
import { H_PRESET_BANK, H_PRESET_NAMES } from './presets';
import { base64ToBytes, inflateRaw } from './inflate';
import { H_ARTS, H_ART_MAPS, H_MAPS, type HArt, type HEnv, type HGlobal, type HImage, type HPart, type HView } from './types';

/** A whole state as generated (parameters in FL index order). */
export interface HarmorStateJson {
  params: number[];
  A: HPart;
  B: HPart;
  G: HGlobal;
}

/** Partial articulator in a difference (changed members; `k` by mapping index). */
export interface HArtDiff {
  mode?: number;
  ea?: number;
  la?: number;
  e?: HEnv;
  l?: HEnv;
  k?: Record<string, HEnv>;
}

/** Partial part in a difference. */
export type HPartDiff = Partial<Omit<HPart, 'arts' | 'maps'>> & {
  arts?: Record<string, HArtDiff>;
  maps?: Record<string, HEnv>;
};

/** A state as a difference to BASE: [param index, value] pairs and changed part / global members. */
export interface HarmorDiff {
  p?: [number, number][];
  A?: HPartDiff;
  B?: HPartDiff;
  G?: Partial<HGlobal>;
}

const clone = <T>(x: T): T => structuredClone(x);

// States share unchanged curve objects with BASE and with each other: plugin
// states are immutable values (the store edits them copy-on-write and the
// engine only reads them), so expanding a preset copies containers only.

function applyPart(base: HPart, d: HPartDiff | undefined): HPart {
  const out: HPart = { ...base, order: base.order.slice(), arts: base.arts.slice(), maps: base.maps.slice(), img: { ...base.img, d: base.img.d.slice() } };
  if (!d) return out;
  for (const [k, v] of Object.entries(d)) {
    if (k === 'arts' || k === 'maps') continue;
    (out as unknown as Record<string, unknown>)[k] = clone(v);
  }
  if (d.arts) {
    for (const [i, a] of Object.entries(d.arts)) {
      const t0 = out.arts[+i];
      if (!t0) continue;
      const t: HArt = { ...t0, k: t0.k.slice() };
      if (a.mode !== undefined) t.mode = a.mode;
      if (a.ea !== undefined) t.ea = a.ea;
      if (a.la !== undefined) t.la = a.la;
      if (a.e) t.e = a.e;
      if (a.l) t.l = a.l;
      if (a.k) for (const [j, m] of Object.entries(a.k)) if (t.k[+j]) t.k[+j] = m;
      out.arts[+i] = t;
    }
  }
  if (d.maps) for (const [i, m] of Object.entries(d.maps)) if (out.maps[+i]) out.maps[+i] = m;
  return out;
}

/** The full plugin state of a difference to BASE. */
export function expandDiff(d: HarmorDiff): FxParams {
  const params = BASE.params.slice();
  for (const [i, v] of d.p ?? []) if (i >= 0 && i < params.length) params[i] = v;
  const out: FxParams = {};
  HARMOR_KEYS.forEach((k, i) => { out[k] = params[i]; });
  out.hA = applyPart(BASE.A, d.A);
  out.hB = applyPart(BASE.B, d.B);
  out.hG = { ...BASE.G, ...clone(d.G ?? {}), fxOrder: (d.G?.fxOrder ?? BASE.G.fxOrder).slice() };
  artParamsFromCurves(out);
  return out;
}

const ADSR_FIELDS = ['att', 'dec', 'sus', 'rel'];
const LFO_FIELDS = ['lfoSpd', 'lfoTns', 'lfoSkw', 'lfoPw'];

/**
 * FL keeps the live articulator envelope / LFO parameters (part params 95..342)
 * in the curve objects (TMEnvelope +0x98, TMLFO +0xd0; ProcessParam writes them
 * there and REC_GetValue reads them back): the values in FL's saved parameter
 * array are stale (0). For FL states the curves' `a` / `l` are the parameters.
 */
function artParamsFromCurves(out: FxParams): void {
  for (const p of ['a', 'b'] as const) {
    const part = (p === 'a' ? out.hA : out.hB) as HPart;
    for (let t = 0; t < ART_ENV_TARGETS; t++) {
      const art = part.arts[t];
      if (!art) continue;
      const a = art.e.a, l = art.l.l;
      if (a) for (let k = 0; k < 4; k++) out[artKey(p, t, ADSR_FIELDS[k])] = a[k];
      if (l) for (let k = 0; k < 4; k++) out[artKey(p, t, LFO_FIELDS[k])] = l[k];
    }
  }
}

let bank: HarmorDiff[] | null = null;
/** The factory presets (decoded on first use). */
export function harmorBank(): HarmorDiff[] {
  if (!bank) bank = JSON.parse(utf8(inflateRaw(base64ToBytes(H_PRESET_BANK)))) as HarmorDiff[];
  return bank;
}

/** UTF-8 bytes to a string (no TextDecoder: the AudioWorklet scope may lack it). */
function utf8(b: Uint8Array): string {
  let s = '';
  const CH = 8192;
  const cps: number[] = [];
  for (let i = 0; i < b.length;) {
    const c = b[i++];
    if (c < 0x80) cps.push(c);
    else if (c < 0xe0) cps.push(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    else if (c < 0xf0) { cps.push(((c & 0x0f) << 12) | ((b[i] & 0x3f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
    else { cps.push(((c & 0x07) << 18) | ((b[i] & 0x3f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; }
    if (cps.length >= CH) { s += String.fromCodePoint(...cps); cps.length = 0; }
  }
  return s + String.fromCodePoint(...cps);
}

export { H_PRESET_NAMES };

let fresh: FxParams | null = null;
/** The state a fresh Harmor has (FL's plugin database entry, "Spacebass - nucleon"). */
export function freshState(): FxParams {
  if (!fresh) fresh = expandDiff(FRESH);
  return { ...fresh, hView: defaultView() };
}

export function defaultView(): HView {
  return { part: 0, page: 0, target: 1, artPart: 0, kb: 1, vis: 0 };
}

// ------------------------------------------------------------- normalisation

function num(x: unknown, d: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : d;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** An array of n finite numbers (plain loop: this runs for every curve of every state load). */
function numArr(a: unknown, n: number): a is number[] {
  if (!Array.isArray(a) || a.length !== n) return false;
  for (let i = 0; i < n; i++) { const v = a[i]; if (typeof v !== 'number' || !Number.isFinite(v)) return false; }
  return true;
}

/** A curve as stored is kept as is (shared) when it is well formed. */
function envOk(x: unknown, d: HEnv): x is HEnv {
  if (!x || typeof x !== 'object') return false;
  const e = x as HEnv;
  if (!isNum(e.t) || !numArr(e.m, 5) || !Array.isArray(e.p) || e.p.length === 0 || e.p.length > 4096) return false;
  const P = e.p;
  for (let i = 0; i < P.length; i++) {
    const q = P[i];
    if (!Array.isArray(q) || q.length < 2 || q.length > 7) return false;
    for (let j = 0; j < q.length; j++) { const v = q[j]; if (typeof v !== 'number' || !Number.isFinite(v)) return false; }
  }
  if (d.a && !numArr(e.a, 4)) return false;
  if (d.l && (!numArr(e.l, 4) || !isNum(e.ph))) return false;
  if (e.t === 3 && !mapLenOk(e.p)) return false;
  return true;
}

/** Total time of a curve's points (sum of the point distances). */
function curveTotal(p: number[][]): number {
  let t = 0;
  for (const q of p) t += q[0];
  return t;
}

/** A mapping curve as FL keeps it after loading (0x447d00): starts at 0, point distances sum to 1. */
function mapLenOk(p: number[][]): boolean {
  if (!p.length || p[0][0] > 0) return false;
  const t = curveTotal(p);
  return t > 0 && Math.abs(t - 1) <= 1e-6;
}

/** FL's fixed-length normalisation of mapping curves (0x447d00): point at 0, distances scaled to sum 1. */
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

function normEnv(x: unknown, d: HEnv): HEnv {
  if (envOk(x, d)) return x;
  if (!x || typeof x !== 'object') return d;
  const e = x as Partial<HEnv>;
  const pts = Array.isArray(e.p) ? e.p.filter((q) => Array.isArray(q) && q.length >= 2).map((q) => q.slice(0, 7).map((v) => num(v, 0))) : [];
  const t = num(e.t, d.t);
  const out: HEnv = {
    t,
    p: t === 3 ? mapFixLength(pts.slice(0, 4096), d.p[0]?.[1] ?? 0) : pts.length ? pts.slice(0, 4096) : d.p,
    m: Array.isArray(e.m) && e.m.length === 5 ? e.m.map((v, i) => Math.round(num(v, d.m[i]))) : d.m,
  };
  if (d.a) out.a = Array.isArray(e.a) && e.a.length === 4 ? e.a.map((v, i) => num(v, d.a![i])) : d.a;
  if (d.l) {
    out.l = Array.isArray(e.l) && e.l.length === 4 ? e.l.map((v, i) => num(v, d.l![i])) : d.l;
    out.ph = num(e.ph, d.ph ?? 0);
  }
  return out;
}

function normArt(x: unknown, d: HArt): HArt {
  if (!x || typeof x !== 'object') return d;
  const a = x as Partial<HArt>;
  const k = Array.isArray(a.k) ? a.k : [];
  const e = normEnv(a.e, d.e), l = normEnv(a.l, d.l);
  const kk = d.k.map((m, i) => normEnv(k[i], m));
  if (isNum(a.mode) && isNum(a.ea) && isNum(a.la) && e === a.e && l === a.l && k.length === kk.length && kk.every((m, i) => m === k[i])) return a as HArt;
  return { mode: num(a.mode, d.mode), ea: num(a.ea, d.ea), la: num(a.la, d.la), e, l, k: kk };
}

function normImage(x: unknown, d: HImage): HImage {
  if (!x || typeof x !== 'object') return clone(d);
  const m = x as Partial<HImage>;
  const out: HImage = {
    mode: num(m.mode, d.mode) ? 1 : 0, a58: num(m.a58, d.a58), a100: num(m.a100, d.a100),
    d: Array.isArray(m.d) && m.d.length === 3 ? m.d.map((v, i) => num(v, d.d[i])) : clone(d.d),
    h: Math.max(0, Math.round(num(m.h, 0))), w: Math.max(0, Math.round(num(m.w, 0))),
    planes: Math.round(num(m.planes, 0)) & 7,
  };
  if (m.missing) out.missing = true;
  return out;
}

export function normPart(x: unknown, d: HPart): HPart {
  if (!x || typeof x !== 'object') return applyPart(d, undefined);
  const p = x as Partial<HPart>;
  const out: HPart = { ...d };
  const o = out as unknown as Record<string, unknown>;
  for (const k of Object.keys(d) as (keyof HPart)[]) {
    const dv = d[k];
    if (typeof dv === 'number') o[k] = num(p[k], dv);
  }
  out.src = typeof p.src === 'string' ? p.src : d.src;
  out.order = Array.isArray(p.order) && p.order.length === 12 ? p.order.map((v, i) => Math.round(num(v, d.order[i]))) : d.order.slice();
  const arts = Array.isArray(p.arts) ? p.arts : [];
  out.arts = d.arts.map((a, i) => normArt(arts[i], a));
  const maps = Array.isArray(p.maps) ? p.maps : [];
  out.maps = d.maps.map((m, i) => normEnv(maps[i], m));

  out.img = normImage(p.img, d.img);
  if (Array.isArray(p.missing) && p.missing.length) out.missing = p.missing.filter((s): s is string => typeof s === 'string');
  else delete out.missing;
  return out;
}

export function normGlobal(x: unknown, d: HGlobal): HGlobal {
  if (!x || typeof x !== 'object') return clone(d);
  const g = x as Partial<HGlobal>;
  const out = clone(d);
  const o = out as unknown as Record<string, unknown>;
  for (const k of Object.keys(d) as (keyof HGlobal)[]) {
    const dv = d[k];
    if (typeof dv === 'number') o[k] = num(g[k], dv);
  }
  out.fxOrder = Array.isArray(g.fxOrder) && g.fxOrder.length === 6 ? g.fxOrder.map((v, i) => Math.round(num(v, d.fxOrder[i]))) : clone(d.fxOrder);
  out.info = typeof g.info === 'string' ? g.info.slice(0, 4096) : d.info;
  return out;
}

function normView(x: unknown): HView {
  const d = defaultView();
  if (!x || typeof x !== 'object') return d;
  const v = x as Partial<HView>;
  const r = (k: keyof HView, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(num(v[k], d[k]))));
  return { part: r('part', 0, 1), page: r('page', 0, 3), target: r('target', 0, 92), artPart: r('artPart', 0, 10), kb: r('kb', 0, 1), vis: r('vis', 0, 1) };
}

/**
 * A resynthesized image (img.mode 1) is rebuilt from its source audio: without the
 * user's imported copy of it (pool sample `<p>_srcSample`) the image is missing.
 */
function srcMissing(part: HPart, sample: unknown): HPart {
  if (part.img.mode !== 1 || !part.src) return part;
  const want = !sample;
  if (!!part.img.missing === want) return part;
  const img = { ...part.img };
  if (want) img.missing = true; else delete img.missing;
  return { ...part, img };
}

/** Repair a stored state; expands a factory preset reference ({ __h: index }). */
export function normalizeHarmor(p: FxParams): FxParams {
  let q: FxParams = { ...p };
  if (typeof q.__h === 'number') {
    const d = harmorBank()[q.__h];
    delete q.__h;
    if (d) q = { ...q, ...expandDiff(d) };
  }
  for (const def of HARMOR_PARAMS) {
    const v = q[def.key];
    q[def.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(def.max, Math.max(def.min, v)) : def.def;
  }
  q.hA = srcMissing(normPart(q.hA, BASE.A), q.a_srcSample);
  q.hB = srcMissing(normPart(q.hB, BASE.B), q.b_srcSample);
  q.hG = normGlobal(q.hG, BASE.G);
  q.hView = normView(q.hView);
  return q;
}

/** Part state of a plugin state ('a' / 'b'). */
export function harmorPart(p: FxParams, part: 'a' | 'b'): HPart {
  return (part === 'a' ? p.hA : p.hB) as HPart;
}

export function harmorGlobal(p: FxParams): HGlobal {
  return p.hG as HGlobal;
}

export { BASE, H_ARTS, H_MAPS, H_ART_MAPS };
