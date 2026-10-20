// Sytrus patch: the plugin state (params + `sy`) compiled into what the voices
// read, with FL's conversions (Sytrus_x64 ProcessParam updates 0x783f0,
// 0x78450, 0x78850, 0x73a60, 0x78770, 0x78e50): matrix levels through FL's
// LogVol curve (11^x - 1) / 10, operator ratio / offset to cycles per sample,
// PE to nepers, filter LOW / BAND / HIGH, articulator amounts (filter ENV,
// master LFO), compiled curves and operator waveforms.

import type { SyEnv, SyState } from '../../../../model/gen/plugins/sytrus/types';
import { artEnv } from '../../../../model/gen/plugins/sytrus/defaults';
import { UNIT_ARTS, artIsBipolar, artKey } from '../../../../model/gen/plugins/sytrus/types';
import { CEnv, roundEven } from './env';
import { SyShape, shapeKey } from './shape';

/** FL's LogVol curve (11^x - 1) / 10 (exactly 1 at x = 1), signed. */
export function logCurve(x: number): number {
  const a = Math.abs(x);
  const y = a === 1 ? 1 : Math.fround(Math.fround(Math.exp(Math.fround(a * 2.397895336151123)) - 1) * Math.fround(0.1));
  return x < 0 ? -y : y;
}

export const CENT_NP = 0.057762265046662105 / 100; // ln(2) / 1200
export const C5_HZ = 523.251130601197;

export interface ArtCfg {
  /** Additive (bipolar, centred at 0.5) or multiplicative. */
  bip: boolean;
  env: CEnv;
  lfo: CEnv;
  maps: CEnv[];
  /** Mod X / Y mapping tables (513 entries, index 0..512), null = flat. */
  xTab: Float32Array | null;
  yTab: Float32Array | null;
  /** Envelope / LFO amounts (FL's articulator +0x24 / +0x28). */
  ea: number;
  la: number;
  /** A, D, S, R and LFO speed, tension, skew, PW parameters. */
  p: Int32Array;
  /** Applies the main page Volume (0) / Filter (1) ADSR offsets, or -1. */
  adsr: number;
  /** Envelope or LFO enabled. */
  active: boolean;
}

export interface OpCfg {
  /** Waveform (null when nothing is routed from / to the operator). */
  shape: SyShape | null;
  /** Cycles per sample of ratio 1 x note (C5 per sample x ratio / 20000). */
  ratioInc: number;
  ofsInc: number;
  /** Start phase (cycles), volume (signed), PE nepers per articulator unit. */
  phase: number;
  vol: number;
  pe2: number;
  /** PE parameter (cents of pitch range). */
  pe: number;
  ns: number;
  glob: boolean;
  center: boolean;
  declick: boolean;
  pluck: boolean;
  blimit: boolean;
}

export interface FltCfg {
  mode: number;
  type: number;
  cut: number;
  res: number;
  low: number;
  band: number;
  high: number;
  wsAmp: number;
  wsMix: number;
  next: number;
  hq: boolean;
  flat: boolean;
  ws: boolean;
  wsBip: boolean;
  wsMap: CEnv;
  /** LOW parameter as stored (0..128): drive of types 8..11. */
  lowRaw: number;
  /** Waveshaper table (int16 values of the WS map x 32767 / 65535, guard entry at N + 1) and its last index N; null when off. */
  wsTable: Int16Array | null;
  wsN: number;
}

export interface Patch {
  /** Units 0..9 articulators. */
  arts: ArtCfg[][];
  ops: OpCfg[];
  flt: FltCfg[];
  /** Matrix level per [row][col] after FL's curve (FM) and raw RM, mute applied. */
  fm: Float32Array;
  rm: Float32Array;
  /** Unit (0..8) pan (col 6 / 512), FX send (col 7), output (col 8). */
  uPan: Float32Array;
  uFx: Float32Array;
  uOut: Float32Array;
  masterVol: number;
  masterLfo: number;
  masterPitch: number;
  /** Portamento switch (parameter 596). */
  porta: boolean;
  adsr: Int32Array;
  uni: { order: number; pan: number; vol: number; pitch: number; sub: number; phase: number; env: number };
  modX: number;
  modY: number;
  fxPan: number;
  send: number;
  g: SyState['g'];
  sy: SyState;
  params: Record<string, number>;
}

const shapeCache = new Map<string, SyShape>();

/** Mod X / Y mapping table: the curve at 513 points (map range 0..1) minus its centre; null when it is neutral (no effect). */
function mapTable(e: CEnv, center: number, neutral: number): Float32Array | null {
  const t = new Float32Array(513);
  e.readSeq(1 / 512, 513, t);
  let same = true;
  for (let i = 0; i <= 512; i++) {
    t[i] = Math.fround(t[i] - center);
    if (t[i] !== neutral) same = false;
  }
  return same ? null : t;
}

/** Waveshaper table (0x82b70): the WS map sampled at 16384 (unipolar) or 32768 (bipolar) points as int16. */
function wsTable(map: CEnv | null, bip: boolean): { wsTable: Int16Array | null; wsN: number } {
  if (!map) return { wsTable: null, wsN: 0 };
  const size = bip ? 32768 : 16384;
  const N = size - 1;
  const scale = bip ? 65535 : 32767;
  const ctr = bip ? 0.5 : 0;
  const t = new Int16Array(size + 1);
  const vals = new Float32Array(N + 1);
  map.readSeq(1 / N, N + 1, vals);
  for (let i = 0; i <= N; i++) {
    let v = roundEven(Math.fround(Math.fround(vals[i] - ctr) * scale));
    if (v < -32768) v = -32768; else if (v > 32767) v = 32767;
    t[i] = v;
  }
  t[N + 1] = t[N];
  return { wsTable: t, wsN: N };
}

// compiled curves are immutable: FL's default curves (shared objects) compile once
const cenvCache = [new WeakMap<SyEnv, CEnv>(), new WeakMap<SyEnv, CEnv>(), new WeakMap<SyEnv, CEnv>()];
function cenv(e: SyEnv, type: number): CEnv {
  const m = cenvCache[type - 1];
  let c = m.get(e);
  if (!c) { c = new CEnv(e, type); m.set(e, c); }
  return c;
}

export function compilePatch(params: Record<string, number>, sy: SyState, sampleRate: number): Patch {
  const num = (k: string, d = 0) => { const v = params[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };
  const masterLfo = logCurve(num('lfo', 128) / 128);
  const arts: ArtCfg[][] = UNIT_ARTS.map((names, u) => names.map((_, a) => {
    const bip = artIsBipolar(u, a);
    const center = bip ? 0.5 : 0;
    const p = new Int32Array(8);
    for (let f = 0; f < 8; f++) p[f] = num(artKey(u, a, f), [128, 128, 0, 128, 40000, 0, 0, 0][f]);
    const env = cenv(artEnv(sy, u, a, 0), 1);
    const lfo = cenv(artEnv(sy, u, a, 1), 2);
    const maps = [2, 3, 4, 5, 6, 7].map((j) => cenv(artEnv(sy, u, a, j), 3));
    let ea = 1;
    let la = masterLfo;
    if (u >= 6 && u <= 8 && a === 2) {
      ea = Math.fround(num(`f${u - 5}env`, 128) * 0.0078125);
      la = Math.fround(ea * masterLfo);
    }
    let adsr = -1;
    if (a === 1) adsr = 0;
    else if (u >= 6 && u <= 8 && (a === 2 || a === 3)) adsr = 1;
    return {
      bip, env, lfo, maps, ea, la, p, adsr,
      xTab: mapTable(maps[2], center, bip ? 0 : 1), yTab: mapTable(maps[3], center, bip ? 0 : 1),
      active: env.enabled || lfo.enabled,
    };
  }));
  const c5Inc = C5_HZ / sampleRate;
  const gibbs = !!sy.g.gibbs;
  // operators no voice can make audible (nothing routed from / to them) need no waveform
  const cell = (m: number, i: number) => (sy.mute[m * 81 + i] ? 0 : m ? sy.rm[i] : sy.fm[i]) !== 0;
  const used = (o: number) => {
    for (let r = 0; r < 9; r++) if (cell(0, r * 9 + o) || (r < 6 && cell(1, r * 9 + o))) return true;
    return cell(0, o * 9 + 7) || cell(0, o * 9 + 8);
  };
  const ops: OpCfg[] = sy.ops.map((o, i) => {
    let shape: SyShape | null = null;
    if (used(i)) {
      const key = shapeKey(o, gibbs);
      shape = shapeCache.get(key) ?? null;
      if (!shape) {
        shape = new SyShape(o, gibbs);
        if (shapeCache.size > 64) shapeCache.clear();
        shapeCache.set(key, shape);
      }
    }
    const n = i + 1;
    return {
      shape,
      ratioInc: Math.fround(Math.fround(o.ratio * Math.fround(c5Inc)) / 20000),
      ofsInc: Math.fround(o.ofs / (sampleRate * 100)),
      phase: Math.fround(num(`o${n}phase`) * 0.00390625),
      vol: Math.fround(num(`o${n}vol`, 256) * 0.00390625),
      pe2: Math.fround(num(`o${n}pe`, 1200) * 2 * 0.0005776226504666211),
      pe: num(`o${n}pe`, 1200),
      ns: o.ns,
      glob: !!o.glob, center: !!o.center, declick: !!o.declick, pluck: !!o.pluck, blimit: !!o.blimit,
    };
  });
  const flt: FltCfg[] = sy.flt.map((f, i) => {
    const n = i + 1;
    return {
      mode: num(`f${n}mode`, 1), type: f.type,
      cut: Math.fround(num(`f${n}cut`, 128) * 0.00390625),
      res: Math.fround(num(`f${n}res`) * 0.00390625),
      low: logCurve(num(`f${n}low`, 128) * 0.0078125),
      band: logCurve(num(`f${n}band`) * 0.0078125),
      high: logCurve(num(`f${n}high`) * 0.0078125),
      wsAmp: Math.fround(num(`f${n}wsAmp`, 128) * 0.0078125),
      wsMix: Math.fround(num(`f${n}wsMix`, 128) * 0.0078125),
      next: n < 3 ? logCurve(num(`f${n}next`) * 0.00390625) : 0,
      hq: !!f.hq, flat: !!f.flat, ws: !!f.ws, wsBip: !!f.wsBip,
      wsMap: new CEnv(f.wsMap, 3),
      lowRaw: num(`f${n}low`, 128),
      ...wsTable(f.ws ? new CEnv(f.wsMap, 3) : null, !!f.wsBip),
    };
  });
  const fm = new Float32Array(81), rm = new Float32Array(81);
  const uPan = new Float32Array(9), uFx = new Float32Array(9), uOut = new Float32Array(9);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const i = r * 9 + c;
      const vf = sy.mute[i] ? 0 : sy.fm[i];
      const vr = sy.mute[81 + i] ? 0 : sy.rm[i];
      fm[i] = logCurve(vf / 256);
      rm[i] = logCurve(vr / 256);
    }
    uPan[r] = Math.fround((sy.mute[r * 9 + 6] ? 0 : sy.fm[r * 9 + 6]) * 0.001953125);
    uFx[r] = fm[r * 9 + 7];
    uOut[r] = fm[r * 9 + 8];
  }
  const adsr = new Int32Array(8);
  ['vA', 'vD', 'vS', 'vR', 'fA', 'fD', 'fS', 'fR'].forEach((k, i) => { adsr[i] = num(k, i % 4 === 2 ? 0 : 128); });
  return {
    arts, ops, flt, fm, rm, uPan, uFx, uOut,
    masterVol: logCurve(num('level', 128) / 128),
    masterLfo,
    masterPitch: num('pitch') * 100,
    porta: num('porta') !== 0,
    adsr,
    uni: {
      order: Math.max(1, Math.min(9, num('uOrder', 1))), pan: num('uPan', 128), vol: num('uVol', 100), pitch: num('uPitch', 128),
      sub: num('uSub'), phase: num('uPhase', 16), env: num('uEnv'),
    },
    modX: num('modX', 256), modY: num('modY', 256),
    fxPan: Math.fround(num('fxPan') * 0.00390625),
    send: logCurve(num('send', 128) / 128),
    g: sy.g,
    sy,
    params,
  };
}
