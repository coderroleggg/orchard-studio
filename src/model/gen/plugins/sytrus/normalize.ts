// Repair a stored Sytrus `sy` state: every field present, typed and within
// FL's ranges (older saves, hand-edited projects). Unknown fields are dropped.

import type { SyArt, SyArtFull, SyEnv, SyFilter, SyGlobal, SyOp, SyState } from './types';
import { UNIT_ARTS } from './types';
import { defaultArt, defaultFilter, defaultGlobal, defaultOp, defaultSyState } from './defaults';

const DEF_ARTS = UNIT_ARTS.map((names, u) => names.map((_, a) => defaultArt(u, a)));

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function int(x: unknown, d: number, lo: number, hi: number): number {
  const v = typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : d;
  return Math.max(lo, Math.min(hi, v));
}

function flt(x: unknown, d: number, lo: number, hi: number): number {
  const v = typeof x === 'number' && Number.isFinite(x) ? x : d;
  return Math.max(lo, Math.min(hi, v));
}

function intArray(x: unknown, len: number, lo: number, hi: number, d: number[]): number[] {
  const a = Array.isArray(x) ? x : [];
  return Array.from({ length: len }, (_, i) => int(a[i], d[i] ?? 0, lo, hi));
}

/** An envelope curve: at least one point, dt >= 0 (the first point's dt delays the curve), markers within the point range. */
export function normalizeEnv(x: unknown, d: SyEnv): SyEnv {
  if (!isObj(x) || !Array.isArray(x.p) || x.p.length === 0) return structuredClone(d);
  const p = (x.p as unknown[]).filter(Array.isArray).slice(0, 4096).map((q, i) => {
    const a = q as unknown[];
    // the first point may start late (LFO curves with a delayed start): its dt is kept
    const pt = [flt(a[0], 0, 0, 1e4), flt(a[1], 0, -1, 2), flt(a[2], 0, -1, 1)];
    const seg = int(a[3], 0, 0, 12), b1 = int(a[4], 0, 0, 255), b2 = int(a[5], 0, 0, 255);
    if (seg || b1 || b2) pt.push(seg, b1, b2);
    return pt;
  });
  if (p.length === 0) return structuredClone(d);
  const n = p.length;
  const m = Array.isArray(x.m) ? x.m : d.m;
  const mark = (v: unknown, dv: number) => { const k = int(v, dv, -1, n - 1); return k; };
  const e: SyEnv = { p, m: [int(m[0], 0, 0, 255), int(m[1], 0, -1, 1) === 0 ? 0 : -1, mark(m[2], -1), mark(m[3], -1), mark(m[4], -1)] };
  if (d.ph !== undefined || x.ph !== undefined) e.ph = int(x.ph, 0, -2147483648, 2147483647);
  return e;
}

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

/** Compact articulator: curves equal to the slot's default are null, an all-default articulator is null. */
function normalizeArt(x: unknown, d: SyArtFull): SyArt | null {
  if (!isObj(x)) return null;
  const e = Array.isArray(x.e) ? x.e : [];
  const ea = flt(x.ea, d.ea, -16, 16), la = flt(x.la, d.la, -16, 16);
  let any = ea !== d.ea || la !== d.la;
  const out = d.e.map((de, j) => {
    if (e[j] == null) return null;
    const v = normalizeEnv(e[j], de);
    if (sameEnv(v, de)) return null;
    any = true;
    return v;
  });
  return any ? { ea, la, e: out } : null;
}

function normalizeOp(x: unknown): SyOp {
  const d = defaultOp();
  if (!isObj(x)) return d;
  const sw = (k: keyof SyOp) => (x[k] ? 1 : 0);
  const arr = (v: unknown, lo: number, hi: number) => (Array.isArray(v) ? v.slice(0, 256).map((a) => flt(a, 0, lo, hi)) : []);
  const amp = Array.isArray(x.amp) ? arr(x.amp, -1, 1) : d.amp;
  const ph = arr(x.ph, 0, 1);
  while (amp.length && amp[amp.length - 1] === 0) amp.pop();
  while (ph.length && ph[ph.length - 1] === 0) ph.pop();
  return {
    ratio: int(x.ratio, d.ratio, 0, 640000), ofs: int(x.ofs, 0, -999999, 999999), ns: int(x.ns, 0, 0, 128),
    sh: int(x.sh, 0, 0, 512), tn: int(x.tn, 0, -128, 128), sk: int(x.sk, 0, 0, 128), sn: int(x.sn, 0, 0, 128), fl: int(x.fl, 128, 0, 128),
    half: sw('half'), even: sw('even'), abs: sw('abs'), glob: sw('glob'), center: sw('center'), declick: sw('declick'),
    pluck: sw('pluck'), blimit: sw('blimit'), amp, ph,
  };
}

function normalizeFilter(x: unknown): SyFilter {
  const d = defaultFilter();
  if (!isObj(x)) return d;
  return {
    type: int(x.type, 0, 0, 12), hq: x.hq ? 1 : 0, flat: x.flat ? 1 : 0, ws: x.ws ? 1 : 0, wsBip: x.wsBip ? 1 : 0,
    wsMap: normalizeEnv(x.wsMap, d.wsMap),
  };
}

function normalizeGlobal(x: unknown): SyGlobal {
  const d = defaultGlobal();
  if (!isObj(x)) return d;
  const g = { ...d } as unknown as Record<string, unknown>;
  const ranges: Record<string, [number, number]> = {
    dqOver: [0, 6], rqOver: [0, 6], sendTrack: [-126, 124], soften: [0, 128], portaLimit: [0, 5], velAtt: [0, 3], uniDist: [0, 3], eqMode: [0, 3],
    x792: [-2147483648, 2147483647], x796: [-2147483648, 2147483647],
  };
  for (const k of Object.keys(d)) {
    if (k === 'eqType') continue;
    const [lo, hi] = ranges[k] ?? [0, 1];
    g[k] = int(x[k], (d as unknown as Record<string, number>)[k], lo, hi);
  }
  g.eqType = intArray(x.eqType, 3, 0, 2, d.eqType);
  return g as unknown as SyGlobal;
}

export function normalizeSy(x: unknown): SyState {
  const d = defaultSyState();
  if (!isObj(x)) return d;
  const arts = Array.isArray(x.arts) ? x.arts : [];
  const ops = Array.isArray(x.ops) ? x.ops : [];
  const fl = Array.isArray(x.flt) ? x.flt : [];
  const del = Array.isArray(x.del) ? x.del : [];
  const rev = isObj(x.rev) ? x.rev : {};
  return {
    fm: intArray(x.fm, 81, -256, 256, d.fm),
    rm: intArray(x.rm, 81, -256, 256, d.rm),
    mute: intArray(x.mute, 162, 0, 1, d.mute),
    ops: [0, 1, 2, 3, 4, 5].map((i) => normalizeOp(ops[i])),
    flt: [0, 1, 2].map((i) => normalizeFilter(fl[i])),
    arts: UNIT_ARTS.map((names, u) => {
      const ua = Array.isArray(arts[u]) ? arts[u] as unknown[] : [];
      return names.map((_, a) => normalizeArt(ua[a], DEF_ARTS[u][a]));
    }),
    g: normalizeGlobal(x.g),
    del: [0, 1, 2].map((i) => {
      const o = isObj(del[i]) ? del[i] as Record<string, unknown> : {};
      return { tempo: int(o.tempo, 1, 0, 1), serial: int(o.serial, 0, 0, 1), on: int(o.on, 0, 0, 1) };
    }),
    rev: {
      lc: int(rev.lc, d.rev.lc, 0, 3000), hc: int(rev.hc, d.rev.hc, 5, 221), pd: int(rev.pd, 0, 0, 384), rs: int(rev.rs, d.rev.rs, 1, 100),
      df: int(rev.df, d.rev.df, 0, 100), de: int(rev.de, d.rev.de, 1, 200), hd: int(rev.hd, d.rev.hd, 5, 221), col: int(rev.col, 2, 0, 4),
      vol: int(rev.vol, d.rev.vol, -128, 128), on: int(rev.on, 0, 0, 1), tempo: int(rev.tempo, 0, 0, 1),
    },
    info: typeof x.info === 'string' ? x.info.slice(0, 65536) : d.info,
  };
}
