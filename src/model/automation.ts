// Automation clips: an automation "channel" holds an envelope (points with a
// curve mode and tension) and a target parameter; Playlist clips are windows
// onto that envelope. Values are stored normalised 0..1 and mapped linearly to
// the target's model range (min..max). The curve maths is FL Studio's envelope
// evaluator (docs/research/automation.md §4).

import type { Id } from './types';

export type AutoScope = 'channel' | 'mixer' | 'fx' | 'global';

/** A parameter address: object scope + dot path inside it, with its value range. */
export interface AutomationTarget {
  scope: AutoScope;
  /** channel id | mixer track index | fx slot id | '' (global) */
  id: string;
  /** Dot path inside the scoped object, e.g. "volume", "sampler.modX", "params.bands.3.level", "tempo". */
  path: string;
  /** Model value at normalised 0 and 1. */
  min: number;
  max: number;
  /** Quantisation in model units (1 = integers); 0 = continuous. */
  step?: number;
  /** Parameter name shown in hints and clip titles, e.g. "Kick - Channel volume". */
  label: string;
}

export type CurveMode =
  | 'single' | 'double' | 'hold' | 'stairs' | 'smoothStairs' | 'pulse' | 'wave'
  | 'single2' | 'double2' | 'halfSine' | 'smooth' | 'single3' | 'double3';

/** FL's point mode numbers (the envelope editor's menu tags, as stored in projects). */
export const CURVE_TAG: Record<CurveMode, number> = {
  single: 0, double: 1, hold: 2, stairs: 3, smoothStairs: 4, pulse: 5, wave: 6,
  single2: 7, double2: 8, halfSine: 9, smooth: 10, single3: 11, double3: 12,
};

/** The Mode section of the Playlist's point menu, in FL's order. */
export const CURVE_MODES: CurveMode[] = [
  'smooth', 'hold', 'single', 'single2', 'single3', 'double', 'double2', 'double3',
  'halfSine', 'stairs', 'smoothStairs', 'pulse', 'wave',
];

/** The same modes in the automation clip editor's (generic envelope editor's) point menu: Hold before Smooth. */
export const CURVE_MODES_EDITOR: CurveMode[] = ['hold', 'smooth', ...CURVE_MODES.slice(2)];

export const CURVE_LABELS: Record<CurveMode, string> = {
  smooth: 'Smooth',
  hold: 'Hold',
  single: 'Single curve',
  single2: 'Single curve 2',
  single3: 'Single curve 3',
  double: 'Double curve',
  double2: 'Double curve 2',
  double3: 'Double curve 3',
  halfSine: 'Half sine',
  stairs: 'Stairs',
  smoothStairs: 'Smooth stairs',
  pulse: 'Pulse',
  wave: 'Wave',
};

export interface AutoPoint {
  /** Ticks from the start of the envelope. */
  pos: number;
  /** Normalised value 0..1. */
  value: number;
  /**
   * Tension of the segment that ends at this point, -1..1 (ignored on the
   * first point). Curves: the sign is the direction (Single curve: < 0 starts
   * slow, > 0 starts fast), |t| the amount. Stepped modes: |t| sets the
   * number of steps / cycles (stepCount), the sign their phase or shape.
   */
  tension: number;
  /** Shape of the segment that ends at this point. */
  mode: CurveMode;
}

export interface AutomationChannel {
  id: Id;
  name: string;
  color: string;
  enabled: boolean;
  target: AutomationTarget;
  points: AutoPoint[];
  /** Natural length of the envelope in ticks. */
  length: number;
  /** Loop the envelope when a clip is longer than it. */
  loop: boolean;
  /** Output range (Min / Max knobs, 0..1): re-ranges the envelope without changing its display. */
  min: number;
  max: number;
  /** The clip's LFO (FL's automation clip LFO panel), combined with the envelope. */
  lfo: AutoLfo;
}

/** Automation clip LFO, in FL's control ranges. */
export interface AutoLfo {
  on: boolean;
  /** SPD 512..65536 (default 40000). */
  speed: number;
  /** TNS -128..128: morphs the shape from square (left) through sine (centre) to triangle (right). */
  tension: number;
  /** SKEW -128..128: moves the peak (with a triangle shape: saw / reversed saw). */
  skew: number;
  /** PW -112..112: pulse width (length of the upper half). */
  pw: number;
  /** AMNT -128..128: level; 0 = no effect, negative inverts. New clips start at +64 (+50%). */
  amount: number;
  /** MUL: multiply with the envelope level (else added to it). */
  multiply: boolean;
}

export function defaultLfo(): AutoLfo {
  return { on: false, speed: 40000, tension: 0, skew: 0, pw: 0, amount: 64, multiply: false };
}

export const LFO_SPEED_MIN = 512;
export const LFO_SPEED_MAX = 65536;

/** LFO cycles per beat at a SPEED value (the knob's top is two cycles per beat). */
export function lfoCyclesPerBeat(speed: number): number {
  return (2 * Math.min(LFO_SPEED_MAX, Math.max(LFO_SPEED_MIN, speed))) / LFO_SPEED_MAX;
}

/** Bipolar LFO wave (-1..1) at phase p (cycles). */
export function lfoWave(l: AutoLfo, p: number): number {
  let q = p - Math.floor(p);
  // pulse width: the upper half lasts `d` of the cycle
  const d = 0.5 + (0.5 * Math.min(112, Math.max(-112, l.pw))) / 128;
  q = q < d ? (0.5 * q) / d : 0.5 + (0.5 * (q - d)) / (1 - d);
  // skew moves the peak inside the upper half and the trough inside the lower one
  const k = Math.min(128, Math.max(-128, l.skew)) / 128;
  const c = 0.25 + 0.2499 * k;
  if (q < 0.5) q = q < c ? (0.25 * q) / c : 0.25 + (0.25 * (q - c)) / (0.5 - c);
  else {
    const r = q - 0.5;
    q = 0.5 + (r < c ? (0.25 * r) / c : 0.25 + (0.25 * (r - c)) / (0.5 - c));
  }
  const sine = Math.sin(2 * Math.PI * q);
  const t = Math.min(128, Math.max(-128, l.tension)) / 128;
  if (t < 0) {
    // toward square
    const e = 1 / (1 + 24 * -t);
    return Math.sign(sine) * Math.pow(Math.abs(sine), e);
  }
  // toward triangle
  const tri = q < 0.25 ? q * 4 : q < 0.75 ? 2 - q * 4 : q * 4 - 4;
  return sine + (tri - sine) * t;
}

/**
 * Envelope level (0..1, before Min / Max) at envelope tick `pos`, with the
 * LFO applied: added to the envelope (env + level * lfo), or (MUL) as an
 * amplitude modulator (env * (1 - |level| + |level| * lfo01)).
 */
export function envelopeLevel(a: Pick<AutomationChannel, 'points' | 'lfo'>, pos: number, ppq: number): number {
  const env = evalEnvelope(a.points, pos);
  const l = a.lfo;
  if (!l || !l.on || l.amount === 0) return env;
  const amt = Math.min(128, Math.max(-128, l.amount)) / 128;
  const w = lfoWave(l, (pos / ppq) * lfoCyclesPerBeat(l.speed));
  if (l.multiply) {
    const u = amt >= 0 ? (w + 1) / 2 : (1 - w) / 2;
    return env * (1 - Math.abs(amt) + Math.abs(amt) * u);
  }
  return Math.min(1, Math.max(0, env + amt * w));
}

/** Tempo automation covers FL's tempo control range: linear 10..522 BPM. */
export const TEMPO_TARGET: AutomationTarget = { scope: 'global', id: '', path: 'tempo', min: 10, max: 522, label: 'Tempo' };

/**
 * MIN / MAX of a new clip for a target (FL's "sane" defaults): tempo clips
 * 60..180 BPM (1250 / 4250 of 12800), channel pitch clips +-1200 cents of
 * the +-4800 range (4800 / 8000 of 12800), anything else the full range.
 */
export function defaultClipRange(t: Pick<AutomationTarget, 'scope' | 'path'>): { min: number; max: number } {
  if (t.scope === 'global' && t.path === 'tempo') return { min: 1250 / 12800, max: 4250 / 12800 };
  if (t.scope === 'channel' && t.path === 'pitch') return { min: 4800 / 12800, max: 8000 / 12800 };
  return { min: 0, max: 1 };
}

/** Envelope value that makes a clip output model value `x` (clamped to the clip's MIN..MAX). */
export function envelopeValueOf(a: Pick<AutomationChannel, 'min' | 'max'>, t: AutomationTarget, x: number): number {
  if (a.max === a.min) return 0;
  return clamp01((normalize(t, x) - a.min) / (a.max - a.min));
}

/** Fill fields missing from older saves. */
export function normalizeAutomation(a: Partial<AutomationChannel> & Pick<AutomationChannel, 'id' | 'target'>): AutomationChannel {
  let target = a.target;
  let min = typeof a.min === 'number' ? a.min : 0;
  let max = typeof a.max === 'number' ? a.max : 1;
  if (target.scope === 'global' && target.path === 'tempo' && (target.min !== TEMPO_TARGET.min || target.max !== TEMPO_TARGET.max)) {
    // older saves gave tempo clips a 60..180 BPM target: move to FL's 10..522 BPM range, MIN / MAX keep the output
    const lo = target.min, span = target.max - target.min, full = TEMPO_TARGET.max - TEMPO_TARGET.min;
    const remap = (v: number) => (lo + span * v - TEMPO_TARGET.min) / full;
    min = remap(min);
    max = remap(max);
    target = { ...target, min: TEMPO_TARGET.min, max: TEMPO_TARGET.max };
  }
  const length = a.length ?? 384;
  const points: AutoPoint[] = (a.points?.length ? a.points : flatEnvelope(0.5, length)).map((p) => ({
    pos: Math.max(0, p.pos),
    value: clamp01(p.value),
    tension: Math.min(1, Math.max(-1, p.tension || 0)),
    mode: p.mode in CURVE_TAG ? p.mode : 'single',
  }));
  // "The automation envelope must have at least two points"
  if (points.length < 2) points.push({ pos: Math.max(points[0].pos, length), value: points[0].value, tension: 0, mode: 'single' });
  return {
    name: target.label, color: AUTOMATION_COLOR, enabled: true, length: 384, loop: false,
    ...a,
    target, points, min, max,
    lfo: { ...defaultLfo(), ...(a.lfo ?? {}) },
  } as AutomationChannel;
}

/** Envelope value -> output value (Min / Max re-ranging). */
export function autoOutput(a: Pick<AutomationChannel, 'min' | 'max'>, env: number): number {
  return a.min + (a.max - a.min) * env;
}

export const AUTOMATION_COLOR = '#8fa9b8';

/** An initialized control ("Init song with this position"): the model value the song starts with. */
export interface InitControl {
  target: AutomationTarget;
  value: number;
}

export function targetKey(t: Pick<AutomationTarget, 'scope' | 'id' | 'path'>): string {
  return `${t.scope}:${t.id}:${t.path}`;
}

export function sameTarget(a: AutomationTarget, b: AutomationTarget): boolean {
  return a.scope === b.scope && a.id === b.id && a.path === b.path;
}

/** Normalised automation value -> model value. */
export function denormalize(t: AutomationTarget, v: number): number {
  const x = t.min + (t.max - t.min) * Math.min(1, Math.max(0, v));
  return t.step && t.step > 0 ? Math.round(x / t.step) * t.step : x;
}

/** Model value -> normalised automation value. */
export function normalize(t: AutomationTarget, x: number): number {
  if (t.max === t.min) return 0;
  return Math.min(1, Math.max(0, (x - t.min) / (t.max - t.min)));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// --------------------------------------------------------------- path utils
export function getPath(obj: unknown, path: string): unknown {
  let o = obj as Record<string, unknown> | undefined;
  for (const k of path.split('.')) {
    if (o === null || typeof o !== 'object') return undefined;
    o = (o as Record<string, unknown>)[k] as Record<string, unknown> | undefined;
  }
  return o;
}

/** Mutating set (works on immer drafts and plain working copies). */
export function setPath(obj: unknown, path: string, value: unknown): boolean {
  const keys = path.split('.');
  let o = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = o?.[keys[i]];
    if (next === null || typeof next !== 'object') return false;
    o = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (!o || !(last in o)) return false;
  const cur = o[last];
  if (typeof cur === 'boolean') o[last] = (value as number) >= 0.5;
  else o[last] = value;
  return true;
}

// ---------------------------------------------------------------- curves
// FL's envelope segment evaluator (docs/research/automation.md §4). Segment i
// runs from point i-1 to point i and takes point i's mode and tension t
// (-1..1). Its shape S(u), u = 0..1, blends the two values:
// v = v0 + (v1 - v0) * S(u).

const LN_1E6 = Math.log(1e6);
/** A Smooth segment flatter than this evaluates as a line (2^-24). */
const FLAT = 5.96e-8;

/** Round to nearest, ties to even (the evaluator's rounding). */
function rint(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Steps / cycles of the stepped modes (Stairs, Smooth stairs, Pulse, Wave)
 * for tension t: N = round((10^(6 (1 - 0.6|t|)) - 1) / 1000), the inner term
 * rounded to float32. 1000 at t = 0, 16 at |t| = 0.5, 0 at |t| = 1.
 */
export function stepCount(t: number): number {
  const e = Math.fround(1 - 0.6 * Math.min(1, Math.abs(t)));
  return rint((Math.exp(LN_1E6 * e) - 1) * 0.001);
}

/**
 * Shape S(u) of a segment for normalised time u (0..1) and tension t. S(1) is
 * 1: a segment ends on its point's value. Smooth depends on the neighbouring
 * segments and is evaluated by evalEnvelope; here it is an isolated Smooth
 * segment (a smoothstep).
 */
export function curveShape(mode: CurveMode, u: number, tension: number): number {
  if (u >= 1) return 1;
  if (!(u > 0)) u = 0;
  const t = Math.min(1, Math.max(-1, tension || 0));
  switch (mode) {
    case 'single':
      return single(u, t);
    case 'double':
      return mirror(u, t, single);
    case 'hold':
      return 0;
    case 'stairs': {
      // t >= 0: N+2 levels from 0 to 1 inclusive; t < 0: N+1 levels strictly inside
      const s = t >= 0 ? 1 : -1;
      const n = stepCount(t) + (t >= 0 ? 2 : 1);
      return rint(u * n - s / 2) / (n - s);
    }
    case 'smoothStairs': {
      // N+1 steps with cubic transitions; t >= 0: plateaus on 0, 1/n, ..., 1, t < 0: on the half levels
      const n = stepCount(t) + 1;
      const d = u * n - 0.5;
      const j = rint(d - 0.5);
      const x = 2 * (d - j) - 1;
      const e = t >= 0 ? x * x * x : Math.sign(x) * (1 - (1 - Math.abs(x)) ** 3);
      return (j + 0.5 * e + 1) / n;
    }
    case 'pulse': {
      // N+1 periods; t >= 0 starts on the start value, t < 0 on the end value
      const m = 2 * (stepCount(t) + 1);
      return rint(u * m - (t >= 0 ? 0.5 : -0.5)) % 2 === 0 ? 0 : 1;
    }
    case 'wave': {
      // N+1/2 cycles from 0 to 1: a sine for t < 0, a triangle for t >= 0
      const n = stepCount(t);
      if (t > 0 && n === 0) return u; // half a triangle cycle is a line
      const f = n + 0.5;
      if (t < 0) return 0.5 * (Math.sin(2 * Math.PI * (u * f + 0.75)) + 1);
      const d = u * f - 0.5;
      return Math.abs(2 * (d - rint(d - 0.5)) - 1);
    }
    case 'single2':
      return single2(u, t);
    case 'double2':
      return mirror(u, t, single2);
    case 'halfSine': {
      const q = t > 0 ? Math.sin((Math.PI / 2) * u) : 1 - Math.cos((Math.PI / 2) * u);
      const a = Math.abs(t);
      return (1 - a) * u + a * q;
    }
    case 'smooth':
      return smoothBlend(u, t, 0, 0);
    case 'single3':
      return single3(u, t);
    case 'double3':
      return mirror(u, t, single3);
  }
}

/** Single curve: exponential spanning 10^(6|t|) (120 dB at |t| = 1); t < 0 starts slow, t > 0 fast. */
function single(u: number, t: number): number {
  if (t === 0) return u;
  const L = LN_1E6 * Math.abs(t); // ln(1 + k), k = 10^(6|t|) - 1
  const k = Math.expm1(L);
  return t < 0 ? Math.expm1(L * u) / k : 1 - Math.expm1(L * (1 - u)) / k;
}

/** Single curve 2: blend between the line and a 6th-power curve. */
function single2(u: number, t: number): number {
  const x = t > 0 ? 1 - u : u;
  return u - t * (x ** 6 - x);
}

/** Single curve 3: rational (hyperbolic) curvature. */
function single3(u: number, t: number): number {
  if (t === 0) return u;
  const a = 1 - (1 - Math.max(0.9 * Math.abs(t), 2 ** -16)) ** 3;
  if (t < 0) return ((1 - a) * u) / (1 - a * u);
  const w = 1 - u;
  return 1 - ((1 - a) * w) / (1 - a * w);
}

/** Double curves: a single curve on two mirrored halves (S(1/2) = 1/2). */
function mirror(u: number, t: number, f: (x: number, t: number) => number): number {
  return u < 0.5 ? 0.5 * f(2 * u, t) : 1 - 0.5 * f(2 * (1 - u), t);
}

/** Smooth: cubic Hermite with end tangents m0 / m1, blended toward the line by |t| (t = 0: full smoothing). */
function smoothBlend(u: number, t: number, m0: number, m1: number): number {
  const u2 = u * u, u3 = u2 * u;
  const h = 3 * u2 - 2 * u3 + m0 * u * (u - 1) * (u - 1) + m1 * (u3 - u2);
  return u + (h - u) * (1 - Math.min(1, Math.abs(t)));
}

/**
 * Smooth segment ending at point i: a monotone cubic spline (Fritsch-Butland
 * tangents) in the segment's normalised frame. A neighbouring segment shapes
 * the tangent only when it is Smooth too, otherwise that end is flat.
 */
function smoothShape(points: AutoPoint[], i: number, u: number): number {
  const a = points[i - 1], b = points[i];
  const dv = b.value - a.value;
  if (Math.abs(dv) < FLAT) return u;
  const span = b.pos - a.pos;
  const prev = points[i - 2], next = points[i + 1];
  let m0 = 0, m1 = 0;
  if (prev && a.mode === 'smooth') {
    const r = Math.max(FLAT, (a.pos - prev.pos) / span);
    m0 = harmonicSlope(-((prev.value - a.value) / dv) / r, 1, 2 + r, 1 + 2 * r);
  }
  if (next && next.mode === 'smooth') {
    const r = Math.max(FLAT, (next.pos - b.pos) / span);
    m1 = harmonicSlope(1, ((next.value - a.value) / dv - 1) / r, 2 * r + 1, r + 2);
  }
  return smoothBlend(u, b.tension, m0, m1);
}

/** Weighted harmonic mean of the slopes left and right of a point; 0 at an extremum. */
function harmonicSlope(left: number, right: number, w1: number, w2: number): number {
  if (left * right <= 0) return 0;
  return ((w1 + w2) * left * right) / (w1 * right + w2 * left);
}

/**
 * Envelope value (0..1) at tick `pos` (relative to the envelope start). At a
 * time shared by several points the last one's value applies (a zero-length
 * segment is a jump). The first point's value holds before it, the last
 * point's after it.
 */
export function evalEnvelope(points: AutoPoint[], pos: number): number {
  const n = points.length;
  if (n === 0) return 0;
  if (pos < points[0].pos) return points[0].value;
  if (pos >= points[n - 1].pos) return points[n - 1].value;
  // binary search: points[lo].pos <= pos < points[hi].pos
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].pos <= pos) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const u = (pos - a.pos) / (b.pos - a.pos);
  const s = b.mode === 'smooth' ? smoothShape(points, hi, u) : curveShape(b.mode, u, b.tension);
  return clamp01(a.value + (b.value - a.value) * s);
}

/** Default envelope: a flat line at `value` over `length` ticks. */
export function flatEnvelope(value: number, length: number): AutoPoint[] {
  return [
    { pos: 0, value, tension: 0, mode: 'single' },
    { pos: length, value, tension: 0, mode: 'single' },
  ];
}
