// Envelope Controller (FL: Fruity Envelope Controller, Plugin database >
// Generators > Controller): an internal controller with 8 articulators. Each
// articulator turns the notes it receives (its key range) into one controller
// output from up to seven sources: an ADSR-style envelope with loop markers, an
// LFO shaped by a modifier envelope, and mapping envelopes for the note's key,
// velocity, Mod X, Mod Y and a random value. The sources combine either as a
// bipolar sum or as a unipolar product. FL's form: SynthPanel 737 x 395.
//
// Parameters (FL's 90, Tags 0..89): per articulator base / envelope / LFO level,
// attack / decay / sustain / release scales, LFO speed / tension / skew /
// pulse width, plus the global Mod X / Y knobs. The envelopes, markers, polarity,
// key ranges, the "Continuous output" option and the editor's selection are plugin
// state (docs/research/gen/envctrl.md: every statement there was measured on FL's
// plugin in the test host).

import type { GenPluginDef } from '../types';
import type { FxParamDef, FxPreset } from '../../fx/types';
import type { AutoPoint, CurveMode } from '../../automation';
import { RAW_PRESETS, type RawShape } from './envctrl/presetData';

export const EC_ARTS = 8;
/** The articulators' mapping envelopes in FL's order (the editor's source list). */
export const EC_MAPS = ['Keyboard mapping', 'Velocity mapping', 'Modulation X mapping', 'Modulation Y mapping', 'Random'] as const;
/** The editor's source list (FL's ModeSelect items, "-" is the separator). */
export const EC_SOURCES = ['Envelope', 'LFO', '-', ...EC_MAPS] as const;
/** FL's range value for "no upper limit" of a key range. */
export const EC_KEY_OPEN = 256;
/** Keys the keyboard mapping spreads over (C0 = 0): the mapping envelope's x is key / 120. */
export const EC_KEY_SPAN = 120;
/** Velocity (FL 0..128) -> mapping x (measured: 0.007748626 per step, 0.99182 at 128). */
export const EC_VEL_X = 0.007748626;
/** Most points an envelope keeps (the engine compiles at most this many). */
export const EC_MAX_POINTS = 1024;
/** Seconds one envelope time unit lasts when the envelope / LFO is not tempo based (beats at 120 BPM). */
export const EC_UNIT_SECONDS = 0.5;

export interface EcShape {
  /** Points: pos in envelope units (beats when tempo based, else 0.5 s), value 0..1, tension and mode of the segment ending at the point. */
  pts: AutoPoint[];
  /** The source is enabled (envelope, LFO); the mapping envelopes are always used. */
  on: boolean;
  /** TEMPO: times follow the project tempo (units are beats), else they are absolute (units of 0.5 s). */
  tempo: boolean;
  /** GLOBAL (LFO): the LFO phase runs on the song's ticks instead of restarting with every note. */
  global: boolean;
  /** Section markers as point indexes, -1 = none: D = decay start, L = loop start, S = sustain (release start). */
  d: number;
  l: number;
  s: number;
}

export interface EcArt {
  env: EcShape;
  lfo: EcShape;
  /** Keyboard, velocity, Mod X, Mod Y and random mapping envelopes (x 0..1). */
  maps: EcShape[];
  /** MODE: true = bipolar sum, false = unipolar product. */
  polar: boolean;
  /** Key range the articulator answers to (FL's key numbers, C5 = 60; hi 256 = open). */
  lo: number;
  hi: number;
}

// ------------------------------------------------------------------ texts

/** FL rounds the percentage texts half away from zero. */
const rnd = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));
const pct = (v: number, full: number) => `${rnd((v / full) * 100)}%`;

/**
 * LFO frequency in cycles per second at a SPD control value (512..65536):
 * 32 x (10001^(v / 65536) - 1) / 10000 (measured on the plugin's real LFO to 1e-6).
 */
export function ecLfoHz(speed: number): number {
  const x = Math.min(65536, Math.max(0, speed)) / 65536;
  return (32 * (Math.pow(10001, x) - 1)) / 10000;
}

/** FL's text of the LFO speed: m:ss:mmm / s:mmm for the period in seconds (floored to ms), bars:beats:ticks (rounded; the period at 120 BPM) when tempo based. */
export function ecSpeedText(speed: number, tempo: boolean): string {
  const period = 1 / ecLfoHz(speed);
  if (tempo) {
    const ticks = Math.round(period * 2 * 96);
    const bars = Math.floor(ticks / 384);
    if (bars >= 999) return '999:00:000';
    const z = (n: number, w: number) => String(n).padStart(w, '0');
    return `${z(bars, 3)}:${z(Math.floor((ticks % 384) / 96), 2)}:${z(ticks % 96, 3)}`;
  }
  const ms = Math.floor(period * 1000 + 1e-6);
  const s = Math.floor(ms / 1000), m = ms % 1000;
  if (s >= 60) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}:${String(m).padStart(3, '0')}`;
  return `${s}:${String(m).padStart(3, '0')}`;
}

// -------------------------------------------------------------- parameters

interface Field {
  key: string;
  name: string;
  min: number;
  max: number;
  def: number;
  /** Value of FL's plugin database state (the state a new instance starts in). */
  db: number;
  text: (v: number) => string;
}
// FL's per-articulator parameters in index order (index = 11 x articulator + field).
const FIELDS: Field[] = [
  { key: 'base', name: 'Base level', min: 0, max: 256, def: 128, db: 128, text: (v) => pct(v, 256) },
  { key: 'env', name: 'Envelope level', min: -256, max: 256, def: 0, db: 256, text: (v) => pct(v, 256) },
  { key: 'lfo', name: 'LFO level', min: -256, max: 256, def: 0, db: 128, text: (v) => pct(v, 256) },
  { key: 'att', name: 'Attack time scale', min: 0, max: 256, def: 128, db: 128, text: (v) => pct(v, 128) },
  { key: 'dec', name: 'Decay time scale', min: 0, max: 256, def: 128, db: 128, text: (v) => pct(v, 128) },
  { key: 'sus', name: 'Sustain level offset', min: -128, max: 128, def: 0, db: 0, text: (v) => pct(v, 128) },
  { key: 'rel', name: 'Release time scale', min: 0, max: 256, def: 128, db: 128, text: (v) => pct(v, 128) },
  { key: 'spd', name: 'LFO speed (phase)', min: 512, max: 65536, def: 40898, db: 40000, text: () => '' },
  { key: 'tns', name: 'LFO tension', min: -128, max: 128, def: 0, db: 0, text: (v) => pct(v, 128) },
  { key: 'skw', name: 'LFO skew', min: -128, max: 128, def: 0, db: 0, text: (v) => pct(v, 128) },
  { key: 'pw', name: 'LFO pulse width', min: -112, max: 112, def: 0, db: 0, text: (v) => pct(v, 112) },
];
export const EC_FIELDS = FIELDS.map((f) => f.key);

export const ecKey = (art: number, field: string) => `${field}${art + 1}`;

function buildParams(): FxParamDef[] {
  const out: FxParamDef[] = [];
  for (let a = 0; a < EC_ARTS; a++) {
    FIELDS.forEach((f, k) => {
      const speed = f.key === 'spd';
      out.push({
        key: ecKey(a, f.key), name: `Articulator ${a + 1} - ${f.name}`, index: a * 11 + k, min: f.min, max: f.max, def: f.def,
        bipolar: f.min < 0,
        // the speed text follows the LFO's TEMPO switch (state.arts[a].lfo.tempo)
        format: speed
          ? (v, st) => ecSpeedText(v, !!(st?.arts as EcArt[] | undefined)?.[a]?.lfo?.tempo)
          : (v) => f.text(v),
      });
    });
  }
  out.push({ key: 'modx', name: 'Global modulation X', index: 88, min: 0, max: 65536, def: 32768, format: (v) => pct(v, 65536) });
  out.push({ key: 'mody', name: 'Global modulation Y', index: 89, min: 0, max: 65536, def: 32768, format: (v) => pct(v, 65536) });
  return out;
}

// ---------------------------------------------------------------- shapes

/** FL's point mode tags (as stored in FL's states) -> our curve modes. */
const MODE_OF_TAG: CurveMode[] = [
  'single', 'double', 'hold', 'stairs', 'smoothStairs', 'pulse', 'wave', 'single2', 'double2', 'halfSine', 'smooth', 'single3', 'double3',
];

export function ecPoint(pos: number, value: number, tension = 0, mode: CurveMode = 'single'): AutoPoint {
  return { pos, value, tension, mode };
}

function fromRaw(r: RawShape): EcShape {
  return {
    pts: r.p.map((p) => ({ pos: p[0], value: p[1], tension: p[2], mode: MODE_OF_TAG[p[3]] ?? 'single' })),
    on: r.e !== 0, tempo: (r.f & 1) !== 0, global: (r.f & 2) !== 0, d: r.d, l: r.l, s: r.s,
  };
}

/** A fresh mapping envelope: flat at `value` (FL's default maps are flat: 0.5 bipolar, 1 unipolar). */
export function ecFlatShape(value: number): EcShape {
  return { pts: [ecPoint(0, value), ecPoint(1, value)], on: true, tempo: false, global: false, d: -1, l: -1, s: -1 };
}

function finite(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
const mark = (v: unknown, n: number) => {
  const m = Math.round(finite(v, -1));
  return m >= 0 && m < n ? m : -1;
};

/** Repair a stored shape: finite sorted points, marker indexes inside the point list. */
export function ecNormalizeShape(raw: unknown, fallback: EcShape): EcShape {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<EcShape>;
  let pts: AutoPoint[] = [];
  if (Array.isArray(r.pts)) {
    for (const p of r.pts.slice(0, EC_MAX_POINTS)) {
      const q = p as Partial<AutoPoint>;
      pts.push({
        pos: Math.max(0, finite(q?.pos, 0)), value: Math.min(1, Math.max(0, finite(q?.value, 0))),
        tension: Math.min(1, Math.max(-1, finite(q?.tension, 0))), mode: typeof q?.mode === 'string' ? q.mode : 'single',
      });
    }
  }
  if (pts.length === 0) pts = fallback.pts.map((p) => ({ ...p }));
  for (let i = 1; i < pts.length; i++) if (pts[i].pos < pts[i - 1].pos) pts[i].pos = pts[i - 1].pos;
  const n = pts.length;
  return {
    pts, on: r.on === undefined ? fallback.on : !!r.on, tempo: !!r.tempo, global: !!r.global,
    d: mark(r.d, n), l: mark(r.l, n), s: mark(r.s, n),
  };
}

function normalizeArt(raw: unknown, fb: EcArt): EcArt {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<EcArt>;
  const maps = Array.isArray(r.maps) ? r.maps : [];
  const lo = Math.round(finite(r.lo, 0)), hi = Math.round(finite(r.hi, EC_KEY_OPEN));
  return {
    env: ecNormalizeShape(r.env, fb.env), lfo: ecNormalizeShape(r.lfo, fb.lfo),
    maps: fb.maps.map((m, k) => ecNormalizeShape(maps[k], m)),
    polar: r.polar === undefined ? fb.polar : !!r.polar,
    lo: Math.min(EC_KEY_OPEN, Math.max(0, lo)), hi: Math.min(EC_KEY_OPEN, Math.max(0, hi)),
  };
}

// ---------------------------------------------------------------- presets

type Rec = Record<string, unknown>;

function artsOf(p: (typeof RAW_PRESETS)[number]): EcArt[] {
  return p.arts.map((a, i) => ({
    env: fromRaw(a[0]), lfo: fromRaw(a[1]), maps: a[2].map(fromRaw), polar: a[3] !== 0, lo: p.lo[i], hi: p.hi[i],
  }));
}

function presetRecord(p: (typeof RAW_PRESETS)[number]): Rec {
  const r: Rec = {};
  for (let a = 0; a < EC_ARTS; a++) FIELDS.forEach((f, k) => { r[ecKey(a, f.key)] = p.params[a * 11 + k]; });
  r.modx = p.params[88];
  r.mody = p.params[89];
  r.arts = artsOf(p);
  r.cont = p.cont !== 0;
  r.sel = p.sel;
  r.src = p.src;
  return r;
}

const DEFAULT = RAW_PRESETS.find((p) => p.name === 'Default') ?? RAW_PRESETS[0];

/** FL's plugin database state (a new instance): every articulator an ADSR envelope, bipolar, all keys. */
export function ecDefaultState(): Rec {
  const r = presetRecord(DEFAULT);
  r.sel = 0;
  r.src = 0;
  return r;
}

export const def: GenPluginDef = {
  id: 'envctrl',
  name: 'Envelope Controller',
  category: 'Controller',
  notes: 'voices',
  noAudio: true,
  width: 737,
  height: 395,
  description: 'Generates envelopes and LFOs as knob tweaks (internal controller plugin)',
  params: buildParams(),
  outputs: Array.from({ length: EC_ARTS }, (_, i) => `Articulator ${i + 1}`),
  // a new instance starts as FL's plugin database state (see ecDefaultState)
  state: ecDefaultState,
  normalize: (p) => {
    const d = ecDefaultState();
    const rawArts = Array.isArray(p.arts) ? (p.arts as unknown[]) : [];
    const fb = d.arts as EcArt[];
    const arts = fb.map((a, i) => normalizeArt(rawArts[i], a));
    const int = (v: unknown, lo: number, hi: number, dflt: number) => Math.min(hi, Math.max(lo, Math.round(finite(v, dflt))));
    return { ...p, arts, cont: !!p.cont, sel: int(p.sel, 0, EC_ARTS - 1, 0), src: int(p.src, 0, EC_SOURCES.length - 1, 0) };
  },
  // the editor's selected articulator and source, toolbar switches and keyboard scroll survive preset loads
  viewState: ['sel', 'src', 'tb', 'kscroll'],
  // FL's factory presets (Plugin presets/Generators/Fruity Envelope Controller, in FL's menu order)
  presets: RAW_PRESETS.map((p): FxPreset => ({ name: p.name.replace(/^.*\//, ''), params: presetRecord(p) })),
};

// The LFO waveform and the envelope player's helpers live with the engine (src/engine/gen/plugins/envctrl.ts).
export { MODE_OF_TAG as EC_MODE_OF_TAG };

// -------------------------------------------------------------------- LFO

/** ln(10) x 0.9: the tension law's scale (measured, see docs/research/gen/envctrl.md). */
const TENSION_Q = 0.9 * Math.LN10;

/**
 * The LFO waveform (-1..1) at a phase in cycles on the shape's own axis (a
 * retriggered LFO starts at phase 0, where the wave rises through 0): a
 * trapezoid of rise time 0.25 (1 + skew) (1 - |pw|), a fall of 0.5 (1 - skew)
 * (1 - |pw|) and a hold of |pw| (at the top for a positive pulse width, at the bottom for a
 * negative one) before the second rise; the tension then bends |w| with
 * (1 - e^(-q |w|)) / (1 - e^-q), q = 0.9 ln 10 (21^(|t| / 128) - 1) (mirrored for a
 * negative tension). `sk` / `pw` / `tn` are the control values (-128..128 /
 * -112..112 / -128..128).
 */
export function ecLfoWave(phase: number, tn: number, sk: number, pw: number): number {
  const s = sk / 128, p = pw / 128, ap = Math.abs(p);
  const r = 0.25 * (1 + s) * (1 - ap), f = 0.5 * (1 - s) * (1 - ap);
  const ph = phase - Math.floor(phase);
  let w: number;
  if (p >= 0) {
    if (ph < r) w = r > 0 ? ph / r : 1;
    else if (ph < r + ap) w = 1;
    else if (ph < r + ap + f) w = f > 0 ? 1 - (2 * (ph - r - ap)) / f : -1;
    else w = r > 0 ? -1 + (ph - r - ap - f) / r : 0;
  } else if (ph < r) w = r > 0 ? ph / r : 1;
  else if (ph < r + f) w = f > 0 ? 1 - (2 * (ph - r)) / f : -1;
  else if (ph < r + f + ap) w = -1;
  else w = r > 0 ? -1 + (ph - r - f - ap) / r : 0;
  if (tn === 0) return w;
  const q = TENSION_Q * (Math.pow(21, Math.abs(tn) / 128) - 1);
  const a = Math.abs(w);
  const y = tn > 0 ? Math.expm1(-q * a) / Math.expm1(-q) : 1 - Math.expm1(-q * (1 - a)) / Math.expm1(-q);
  return w < 0 ? -y : y;
}

/**
 * Where the waveform's rising zero crossing lies on the plugin's own phase axis:
 * a retriggered LFO starts there, a GLOBAL one runs from phase 0, so its wave
 * is ecLfoWave(phase - origin). Fitted to the measured offsets over skew / pulse width.
 */
export function ecLfoOrigin(sk: number, pw: number): number {
  const s = sk / 128, p = pw / 128, a = 0.25 + s / 4;
  return -s / 4 + (p < 0 ? a * -p : -(1 - a) * p);
}
