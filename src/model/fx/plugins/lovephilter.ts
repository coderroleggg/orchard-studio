// Love Philter (FL: Fruity Love Philter). Eight filter units (banks); each has
// 12 parameters plus four LFO parameters for each of its 8 modulation targets
// (unit 8 has no "To next filter"): 8 master + 7 x 44 + 43 = 359 parameters in
// FL's order. The filter types, modes, switches and all envelopes (10 pattern
// envelopes, LFO amount, X / Y / IEF mappings per target, the waveshaper
// curve) are state (`lp`), as in FL where they live in the plugin chunk.
// Mappings and texts were measured on FL's binary (see docs/research/fx/lovephilter.md).

import type { FxParamDef, FxPluginDef } from '../types';
import { LP_PRESET_DATA, type LpPresetData } from './lovephilter.presets';

export const LP_UNITS = 8;
export const LP_PATTERNS = 10;

/** Modulation targets in FL's order (the WS curve has its own tab). */
export const LP_TARGETS = ['PAN', 'VOL', 'CUT', 'RES', 'LOW', 'BAND', 'HIGH', 'WMIX'] as const;
/** Editor target tabs (WS = the waveshaper curve). */
export const LP_TABS = ['PAN', 'VOL', 'CUT', 'RES', 'LOW', 'BAND', 'HIGH', 'WS', 'WMIX'] as const;
export const LP_SOURCES = ['PAT', 'LFO', 'MOD X', 'MOD Y', 'IEF'] as const;
/** Targets combined additively (neutral 0.5); the others multiply (neutral 1). */
export const LP_ADDITIVE = [true, false, true, true, false, false, false, false];

/** Filter types (FL's internal order; menu names from the plugin). */
export const LP_TYPES = ['SVF', 'LP', 'HP', 'LP2', 'BP', 'BS', 'HP2', 'AP', 'LS', 'PK', 'HS', 'LP3'] as const;
export const LP_TYPE_NAMES = [
  'Chocolate state variable', 'Lime low pass', 'Lime high pass', 'Vanilla low pass', 'Vanilla band pass', 'Vanilla band stop',
  'Vanilla high pass', 'Vanilla all pass', 'Vanilla low shelf', 'Vanilla peaking', 'Vanilla high shelf', 'Mango low pass',
];
export const LP_MODES = ['OFF', 'SINGLE', 'DUAL', 'TRIPLE', 'ALT DUAL', 'ALT TRIPLE'] as const;

// ---------------------------------------------------------------- envelopes

/**
 * An FL envelope (MEnvEditor): points [dt, value 0..1, tension -1..1, type
 * (0 single curve, 1 double curve)], dt = time since the previous point (beats
 * for patterns, 0..1 axis for mappings); ls / le = loop start / end point
 * (-1: no loop, the last value holds); off = the envelope's enable switch is
 * off (FL keeps the points; the target then sees the neutral value).
 */
export interface LpEnv { p: number[][]; ls: number; le: number; off?: number }

export interface LpTarget {
  /** Pattern envelopes 1..10 (null = empty pattern). */
  pats: (LpEnv | null)[];
  /** LFO amount (0..1, 0.5 = none) and on switch. */
  lfo: [number, number];
  /** X, Y and input envelope follower mappings (null = flat neutral). */
  mx: LpEnv | null;
  my: LpEnv | null;
  ief: LpEnv | null;
}

export interface LpUnit {
  mode: number;
  type: number;
  alt: number;
  on: number;
  ws: number;
  wsb: number;
  wsc: LpEnv;
  t: LpTarget[];
}

export interface LpState {
  units: LpUnit[];
  center: number;
  hq: number;
  smooth: number;
  use1: number;
  os: number;
  solo: number;
  info: string;
}

/** Single-curve tension shape on u in 0..1 (FL envelopes: B = 2^(20 |T|)). */
export function lpTension(u: number, T: number): number {
  if (T === 0 || !Number.isFinite(T)) return u;
  const B = Math.pow(2, 20 * Math.min(1, Math.abs(T)));
  if (B <= 1.000001) return u;
  return T < 0 ? (Math.pow(B, u) - 1) / (B - 1) : 1 - (Math.pow(B, 1 - u) - 1) / (B - 1);
}

/** Point curve types of FL's envelope editor (the curve of the segment ending at the point). */
export const LP_POINT_TYPES = [
  'Single curve', 'Double curve', 'Hold', 'Stairs', 'Smooth stairs', 'Pulse', 'Wave', 'Alt single curve', 'Alt double curve',
  'Half sine', 'Smooth', 'Single curve 3', 'Double curve 3',
] as const;

// steps (stairs) / cycles (pulse, wave) per segment for |tension| (measured on FL's binary)
const STEP_T = [0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95, 1];
const STEP_N = [1000, 438, 192, 127, 84, 37, 17, 8, 4, 3, 2, 2, 1, 1];
export function lpStepCount(T: number): number {
  const a = Math.min(1, Math.abs(T));
  for (let i = 1; i < STEP_T.length; i++) {
    if (a <= STEP_T[i]) {
      const f = (a - STEP_T[i - 1]) / (STEP_T[i] - STEP_T[i - 1]);
      return Math.max(1, Math.round(Math.exp(Math.log(STEP_N[i - 1]) + (Math.log(STEP_N[i]) - Math.log(STEP_N[i - 1])) * f)));
    }
  }
  return 1;
}

const smoothstep = (u: number) => u * u * (3 - 2 * u);
/** "Alt" curve: 1 - (1 - u)^6 blended with the line by |T| (mirrored for T < 0). */
const altCurve = (u: number, T: number) => (T >= 0 ? u + (1 - Math.pow(1 - u, 6) - u) * Math.min(1, T) : u + (Math.pow(u, 6) - u) * Math.min(1, -T));
/** "Curve 3": hyperbola u (1 + a) / (u + a), a = (1 - |T|) / (5 |T|) (mirrored for T < 0). */
function curve3(u: number, T: number): number {
  const t = Math.min(1, Math.abs(T));
  if (t < 1e-6) return u;
  const a = Math.max(0.001, (1 - t) / (5 * t));
  const h = (v: number) => (v * (1 + a)) / (v + a);
  return T > 0 ? h(u) : 1 - h(1 - u);
}
const sCurve = (u: number, f: (v: number) => number) => (u < 0.5 ? 0.5 * f(2 * u) : 1 - 0.5 * f(2 - 2 * u));

/**
 * Segment shape (0..1 on u in 0..1) for a point's curve type and tension
 * (measured on FL's binary: single / double curve, hold, stairs, pulse, half
 * sine, smooth, alt and "3" curves exact; smooth stairs and wave approximated).
 */
export function lpSegment(u: number, T: number, type: number): number {
  switch (type) {
    case 0: return lpTension(u, T);
    case 1: return sCurve(u, (v) => lpTension(v, T));
    case 3: {
      const m = lpStepCount(T);
      return T >= 0 ? Math.min(m, Math.floor((m + 1) * u)) / m : (Math.min(m - 1, Math.floor(m * u)) + 1) / (m + 1);
    }
    case 4: {
      // smooth stairs: steps joined by cubic S curves (exact for one step)
      const m = lpStepCount(T), S = (v: number) => sCurve(v, (w) => w * w * w);
      if (T >= 0) { const x = u * m, k = Math.min(m - 1, Math.floor(x)); return (k + S(x - k)) / m; }
      const x = u * m + 0.5, k = Math.min(m, Math.floor(x));
      return Math.max(0, Math.min(1, (k + S(x - k) - 0.5) / m));
    }
    case 5: {
      const m = lpStepCount(T), hi = Math.floor(2 * m * u) % 2 === 1;
      return (T >= 0 ? hi : !hi) ? 1 : 0;
    }
    case 6: return (1 - Math.cos(Math.PI * (2 * lpStepCount(T) - 1) * u)) / 2;
    case 7: return altCurve(u, T);
    case 8: return sCurve(u, (v) => altCurve(v, T));
    case 9: return T >= 0 ? u + (Math.sin((u * Math.PI) / 2) - u) * Math.min(1, T) : u + (1 - Math.cos((u * Math.PI) / 2) - u) * Math.min(1, -T);
    case 10: return smoothstep(u) + (u - smoothstep(u)) * Math.min(1, Math.abs(T));
    case 11: return curve3(u, T);
    case 12: return sCurve(u, (v) => curve3(v, T));
    default: return 0; // hold: the start value until the point
  }
}

/** Total length of an envelope. */
export function lpEnvLength(e: LpEnv): number {
  let t = 0;
  for (let i = 1; i < e.p.length; i++) t += Math.max(0, e.p[i][0]);
  return t;
}

/**
 * Envelope value at time t (FL semantics): with a loop, time past the loop
 * end wraps to the loop start, and the segment leaving the loop start starts
 * from the loop end's value; without one the last value holds.
 */
export function lpEnvValue(e: LpEnv, t: number): number {
  const p = e.p;
  const n = p.length;
  if (n === 0) return 0;
  if (n === 1 || t <= 0) return p[0][1];
  let start = 0;
  const ls = e.ls, le = e.le;
  let looped = false;
  if (ls >= 0 && le > ls && le < n) {
    let tLs = 0, tLe = 0;
    for (let i = 1; i <= le; i++) { const d = Math.max(0, p[i][0]); if (i <= ls) tLs += d; tLe += d; }
    const len = tLe - tLs;
    if (len > 1e-9 && t > tLe) {
      t = tLs + ((t - tLs) % len);
      looped = true;
    }
    start = 0;
  }
  let acc = 0;
  for (let i = start + 1; i < n; i++) {
    const d = Math.max(0, p[i][0]);
    if (t <= acc + d || i === n - 1) {
      if (t > acc + d) return p[n - 1][1];
      const u = d > 1e-12 ? (t - acc) / d : 1;
      const v0 = looped && i - 1 === ls ? p[le][1] : p[i - 1][1];
      return v0 + (p[i][1] - v0) * lpSegment(u, p[i][2], p[i][3]);
    }
    acc += d;
  }
  return p[n - 1][1];
}

/** LFO tension shape (stronger than the envelope one: B = 8^(21^|T| - 1)). */
function lfoCurve(u: number, T: number): number {
  if (T === 0) return u;
  const B = Math.pow(8, Math.pow(21, Math.min(1, Math.abs(T))) - 1);
  if (!(B > 1.000001)) return u;
  if (B > 1e300) return T > 0 ? (u > 0 ? 1 : 0) : (u < 1 ? 0 : 1);
  return T < 0 ? (Math.pow(B, u) - 1) / (B - 1) : 1 - (Math.pow(B, 1 - u) - 1) / (B - 1);
}

/**
 * LFO waveform at phase p (0..1): a triangle starting at 0 and rising, shaped
 * by tension (-128..128), skew (-128..128: moves the peaks) and pulse width
 * (-112..112: holds at the top / bottom for up to 7/8 of the cycle).
 */
export function lpLfoWave(p: number, ten: number, skew: number, pw: number): number {
  const T = Math.max(-1, Math.min(1, ten / 128)), s = Math.max(-1, Math.min(1, skew / 128)), w = Math.max(-1, Math.min(1, pw / 112));
  p -= Math.floor(p);
  const hold = 0.875 * Math.abs(w), rem = 1 - hold;
  const rise = rem * 0.5 * (1 + s), fall = rem * 0.5 * (1 - s);
  const ht = w > 0 ? hold : 0, hb = w < 0 ? hold : 0;
  const a = rise / 2, f2 = fall / 2;
  if (p < a) return lfoCurve(p / a, T);
  p -= a;
  if (p < ht) return 1;
  p -= ht;
  if (p < f2) return lfoCurve(1 - p / f2, T);
  p -= f2;
  if (p < f2) return -lfoCurve(p / f2, T);
  p -= f2;
  if (p < hb) return -1;
  p -= hb;
  return a > 0 ? -lfoCurve(Math.max(0, 1 - p / a), T) : 0;
}

/** LFO period in ticks (PPQ 96) for a speed value: 60000 / (10000^(v/65536) - 1). */
export function lpLfoTicks(v: number): number {
  const x = Math.min(65536, Math.max(512, v)) / 65536;
  return 60000 / (Math.pow(10000, x) - 1);
}

// ---------------------------------------------------------------- texts

/** FL's gain curve for 0..128 = 0..100 % knobs: (11^t - 1)/10 (t = v/128, up to 1.25). */
export function lpGain(t: number): number {
  return t >= 0 ? (Math.pow(11, t) - 1) / 10 : -(Math.pow(11, -t) - 1) / 10;
}

const pct = (max: number) => (v: number) => `${Math.round((v / max) * 100)}%`;
export const lpPanText = (v: number) => (Math.round(v) === 0 ? 'Centered' : `${Math.round((Math.abs(v) / 128) * 100)}% ${v < 0 ? 'left' : 'right'}`);
export const lpMsText = (v: number) => `${Math.round(((Math.pow(81, v / 16384) - 1) / 80) * 1000)}ms`;
export function lpTimeText(v: number): string {
  const t = Math.min(383616, Math.round(lpLfoTicks(v)));
  const bars = Math.floor(t / 384), beats = Math.floor((t % 384) / 96), ticks = t % 96;
  return `${String(bars).padStart(3, '0')}:${String(beats).padStart(2, '0')}:${String(ticks).padStart(3, '0')}`;
}

const UNIT_PARAMS: [string, string, number, number, number, (v: number) => string][] = [
  ['env', 'Cutoff envelope / LFO / IEF amount', 0, 256, 128, pct(256)],
  ['cut', 'Cutoff frequency', 0, 256, 128, pct(256)],
  ['res', 'Resonance / bandwidth', 0, 256, 128, pct(256)],
  ['low', 'Low / gain / drive', 0, 128, 128, pct(128)],
  ['band', 'Band', 0, 128, 0, pct(128)],
  ['high', 'High', 0, 128, 0, pct(128)],
  ['wsAmp', 'Waveshaper pre amp', 64, 192, 128, pct(128)],
  ['wsMix', 'Waveshaper mix', 0, 128, 128, pct(128)],
  ['pan', 'Output panning', -128, 128, 0, lpPanText],
  ['vol', 'Output volume', 0, 160, 128, pct(128)],
  ['in', 'Input volume', -160, 160, 128, pct(128)],
  ['next', 'To next filter', -160, 160, 0, pct(128)],
];
export const LP_LFO_NAMES = ['Panning', 'Volume', 'Filter cutoff', 'Filter resonance', 'Filter low / gain / drive', 'Filter band', 'Filter high', 'Waveshaper'];
export const LP_LFO_KEYS = ['Spd', 'Ten', 'Skew', 'Pw'];

/** Parameter key of unit u (0-based) field. */
export const lpKey = (u: number, f: string) => `u${u + 1}${f}`;
/** Parameter key of the LFO parameter k (0 speed, 1 tension, 2 skew, 3 pulse width) of target t. */
export const lpLfoKey = (u: number, t: number, k: number) => `u${u + 1}${LP_TARGETS[t].toLowerCase()}${LP_LFO_KEYS[k]}`;

function buildParams(): FxParamDef[] {
  const out: FxParamDef[] = [
    { key: 'master', name: 'Master level', index: 0, min: 0, max: 160, def: 128, format: pct(128) },
    { key: 'masterLfo', name: 'Master LFO level', index: 1, min: -128, max: 128, def: 128, format: pct(128), bipolar: true },
    { key: 'efLevel', name: 'Envelope follower level', index: 2, min: 0, max: 160, def: 128, format: pct(128) },
    { key: 'efAtt', name: 'Envelope follower attack', index: 3, min: 0, max: 16384, def: 4096, format: lpMsText },
    { key: 'efRel', name: 'Envelope follower release', index: 4, min: 0, max: 16384, def: 8192, format: lpMsText },
    { key: 'pattern', name: 'Pattern number', index: 5, min: 1, max: 10, def: 1, format: (v) => String(Math.round(v)) },
    { key: 'modX', name: 'Modulation X', index: 6, min: 0, max: 1024, def: 512, format: pct(1024) },
    { key: 'modY', name: 'Modulation Y', index: 7, min: 0, max: 1024, def: 512, format: pct(1024) },
  ];
  let index = 8;
  for (let u = 0; u < LP_UNITS; u++) {
    for (const [f, name, min, max, def, format] of UNIT_PARAMS) {
      if (f === 'next' && u === LP_UNITS - 1) continue;
      out.push({ key: lpKey(u, f), name: `Filter ${u + 1} - ${name}`, index: index++, min, max, def, format, bipolar: min < 0 || undefined });
    }
    for (let t = 0; t < LP_TARGETS.length; t++) {
      out.push({ key: lpLfoKey(u, t, 0), name: `Filter ${u + 1} - ${LP_LFO_NAMES[t]} - LFO speed (phase)`, index: index++, min: 512, max: 65536, def: 40000, format: lpTimeText });
      out.push({ key: lpLfoKey(u, t, 1), name: `Filter ${u + 1} - ${LP_LFO_NAMES[t]} - LFO tension`, index: index++, min: -128, max: 128, def: 0, format: pct(128), bipolar: true });
      out.push({ key: lpLfoKey(u, t, 2), name: `Filter ${u + 1} - ${LP_LFO_NAMES[t]} - LFO skew`, index: index++, min: -128, max: 128, def: 0, format: pct(128), bipolar: true });
      out.push({ key: lpLfoKey(u, t, 3), name: `Filter ${u + 1} - ${LP_LFO_NAMES[t]} - LFO pulse width`, index: index++, min: -112, max: 112, def: 0, format: pct(112), bipolar: true });
    }
  }
  return out;
}

export const LP_PARAMS = buildParams();

// ---------------------------------------------------------------- state

export const lpFlat = (v: number): LpEnv => ({ p: [[0, v, 0, 0], [1, v, 0, 0]], ls: -1, le: -1 });

export function lpDefaultWs(): LpEnv {
  return { p: [[0, 0, 0, 0], [1, 0.75, 0.75, 0]], ls: -1, le: -1 };
}

export function lpDefaultTarget(): LpTarget {
  return { pats: Array.from({ length: LP_PATTERNS }, () => null), lfo: [1, 0], mx: null, my: null, ief: null };
}

export function lpDefaultUnit(on: boolean): LpUnit {
  return { mode: 1, type: 0, alt: 0, on: on ? 1 : 0, ws: 0, wsb: 0, wsc: lpDefaultWs(), t: Array.from({ length: LP_TARGETS.length }, lpDefaultTarget) };
}

export function lpDefaultState(): LpState {
  return {
    units: Array.from({ length: LP_UNITS }, (_, u) => lpDefaultUnit(u === 0)),
    center: 0, hq: 0, smooth: 1, use1: 0, os: 1, solo: -1, info: 'Preset name\rPreset details',
  };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function normEnv(e: unknown): LpEnv | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Partial<LpEnv>;
  if (!Array.isArray(o.p) || o.p.length === 0) return null;
  const p = o.p.filter((q) => Array.isArray(q)).map((q) => [Math.max(0, num(q[0], 0)), Math.min(1, Math.max(0, num(q[1], 0))), Math.max(-1, Math.min(1, num(q[2], 0))), Math.min(13, Math.max(0, Math.round(num(q[3], 0))))]);
  if (!p.length) return null;
  const out: LpEnv = { p, ls: Math.round(num(o.ls, -1)), le: Math.round(num(o.le, -1)) };
  if (num(o.off, 0)) out.off = 1;
  return out;
}

export function lpNormalizeState(s: unknown): LpState {
  const d = lpDefaultState();
  if (!s || typeof s !== 'object') return d;
  const o = s as Partial<LpState>;
  const units = Array.isArray(o.units) ? o.units : [];
  d.units = d.units.map((du, u) => {
    const su = (units[u] ?? {}) as Partial<LpUnit>;
    const t = Array.isArray(su.t) ? su.t : [];
    return {
      mode: Math.min(5, Math.max(0, Math.round(num(su.mode, du.mode)))),
      type: Math.min(11, Math.max(0, Math.round(num(su.type, du.type)))),
      alt: num(su.alt, 0) ? 1 : 0,
      on: num(su.on, du.on) ? 1 : 0,
      ws: num(su.ws, 0) ? 1 : 0,
      wsb: num(su.wsb, 0) ? 1 : 0,
      wsc: normEnv(su.wsc) ?? lpDefaultWs(),
      t: du.t.map((dt, k) => {
        const st = (t[k] ?? {}) as Partial<LpTarget>;
        const pats = Array.isArray(st.pats) ? st.pats : [];
        const lfo = Array.isArray(st.lfo) ? st.lfo : dt.lfo;
        return {
          pats: dt.pats.map((_, i) => normEnv(pats[i])),
          lfo: [Math.min(1, Math.max(0, num(lfo[0], 1))), num(lfo[1], 0) ? 1 : 0] as [number, number],
          mx: normEnv(st.mx), my: normEnv(st.my), ief: normEnv(st.ief),
        };
      }),
    };
  });
  d.center = num(o.center, d.center) ? 1 : 0;
  d.hq = num(o.hq, d.hq) ? 1 : 0;
  d.smooth = num(o.smooth, d.smooth) ? 1 : 0;
  d.use1 = num(o.use1, d.use1) ? 1 : 0;
  d.os = Math.min(4, Math.max(0, Math.round(num(o.os, d.os))));
  d.solo = Math.min(7, Math.max(-1, Math.round(num(o.solo, -1))));
  d.info = typeof o.info === 'string' ? o.info : d.info;
  return d;
}

function decodeEnv(a: number[] | undefined): LpEnv | null {
  if (!a || a.length < 6) return null;
  const p: number[][] = [];
  for (let i = 2; i + 3 < a.length; i += 4) p.push([a[i], a[i + 1], a[i + 2], a[i + 3]]);
  return { p, ls: a[0], le: a[1] };
}

const DEFAULT_PARAMS: Record<string, number> = Object.fromEntries(LP_PARAMS.map((q) => [q.key, q.def]));

/** Expand a compact preset into a full slot state (parameters + lp state). */
export function lpExpandPreset(d: LpPresetData): Record<string, unknown> {
  const lp = lpDefaultState();
  for (const [ui, uo] of Object.entries(d.u ?? {})) {
    const U = lp.units[Number(ui)];
    if (!U) continue;
    if (uo.m !== undefined) U.mode = uo.m;
    if (uo.ty !== undefined) U.type = uo.ty;
    if (uo.a !== undefined) U.alt = uo.a;
    if (uo.on !== undefined) U.on = uo.on;
    if (uo.ws !== undefined) U.ws = uo.ws;
    if (uo.wb !== undefined) U.wsb = uo.wb;
    if (uo.wc) U.wsc = decodeEnv(uo.wc) ?? U.wsc;
    for (const [ti, to] of Object.entries(uo.t ?? {})) {
      const T = U.t[Number(ti)];
      if (!T) continue;
      for (const [pi, pe] of Object.entries(to.pats ?? {})) T.pats[Number(pi)] = decodeEnv(pe);
      for (const [pi, pe] of Object.entries(to.po ?? {})) {
        const e = decodeEnv(pe);
        if (e) T.pats[Number(pi)] = { ...e, off: 1 };
      }
      if (to.lfo) T.lfo = [to.lfo[0], to.lfo[1]];
      if (to.mx) T.mx = decodeEnv(to.mx);
      if (to.my) T.my = decodeEnv(to.my);
      if (to.ief) T.ief = decodeEnv(to.ief);
    }
  }
  const g = d.g ?? {};
  for (const k of ['center', 'hq', 'smooth', 'use1', 'os', 'solo'] as const) if (g[k] !== undefined) lp[k] = g[k];
  if (d.i !== undefined) lp.info = d.i;
  return { ...DEFAULT_PARAMS, ...(d.p ?? {}), lp };
}

export const def: FxPluginDef = {
  id: 'lovephilter',
  name: 'Love Philter',
  category: 'Filter',
  width: 670,
  height: 400,
  description: 'Eight-unit filter with pattern envelopes, LFOs, X/Y and envelope follower modulation',
  params: LP_PARAMS,
  state: () => ({ lp: lpDefaultState(), lpUi: { unit: 0, tab: 2, src: 0 } }),
  normalize: (p) => ({ ...p, lp: lpNormalizeState(p.lp) }),
  presets: LP_PRESET_DATA.map((d) => ({ name: d.n, params: lpExpandPreset(d) })),
  viewState: ['lpUi'],
};
