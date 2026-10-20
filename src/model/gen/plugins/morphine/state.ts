// Morphine program structure beyond the 252 parameters (FL keeps it only in
// its state blob, .flref/morphine/NOTES.md sections 1 and 3): the four
// generators' keyboard zones and spectrum timelines (breakpoints of 128
// partials: amplitude, panning, detune), the morph path, the four modulation
// envelopes, the modulation matrix, the noise sample, polyphony / glide mode /
// noise loop and filter modes. In Orchard Studio's state they are plain JSON
// under the keys below, next to the parameters (params.ts):
//
//   progName                program name (FL's preset name field, 255 chars)
//   poly 0..31              polyphony: n -> n + 1 voices, 0 = mono (internal param 124)
//   glideMode 0..3          bit 0 "Held", bit 1 "same time" (Bend VT, Held VT, Bend ST, Held ST; 125)
//   nzLoop 0..3, nzFlt 0..3 noise loop mode (one shot, forward, forward+backward, ping-pong) and
//                           filter mode (off, low pass, band pass, high pass) (126, 127)
//   gens[4]                 { pwm 0..2 (off, cos, 1 - cos), cz (current zone: FL's parameters
//                           43..47 of a generator are that zone's timeline values), zones }
//     zones[]               { w keys, l level, bp breakpoints, ls / le loop start / end (absolute
//                           times), lm loop mode 0..3, rl Release Loop, rate / kt / vt / sync (the
//                           zone's own Rate, Rate KeyTrk, Rate VelTrk, Tempo Sync: used for zones
//                           other than cz), ca / cb per-partial velocity sensitivity / gain
//                           ("Velocity" / "Window" views: a number for a flat curve or 128 values),
//                           cs? rows of spectraSample holding ca, cb }
//       bp[]                { t duration to the next point, l level, a / p / d? 128 partial
//                           amplitudes / pans (-1..1) / detunes (harmonic units), s? first of the 3
//                           rows of spectraSample holding a, p, d }
//   morph                   { pts [x, y, dt][] (x = FL axis 1 = A..B, y = axis 0), ls, le, lm,
//                           solo 0 / 1..4 (soloed generator) }
//   envs[4]                 { pts [level, dt][], ls, le, lm, bip (bipolar) }
//   mod                     { src[12] 0..136, dst[12] 0..47, amt[12] 0..1 (0.5 = 0) }
//   noise                   noise sample file name ("Noise Samples/<name>" in FL's plugin folder)
//
// FL content (the analysed spectra of the factory programs, the Noise Samples
// WAVs) is not part of this repository: factory presets carry synthesized
// spectra (substituteSpectrum, flagged spectraMissing) and only the noise file
// name (noiseMissing). "Import FL content" (import.ts) stores the real data in
// pool samples referenced by spectraSample (rows of 128 floats: s, s+1, s+2
// per breakpoint, cs, cs+1 per zone curve) and noiseSample (the WAV's frames,
// noiseRate its sample rate, noiseLoop its smpl loop).

import { MOR_KEYS, MOR_PARAMS, PROG_DEFAULTS, fOf, genParam, vOf } from './params';

const f32 = Math.fround;

export const NP = 128;
export const MAX_ZONES = 128;
export const MAX_BPS = 8192;
export const MAX_POINTS = 8192;
export const MAX_TIME = 1 << 30;

export interface MBp { t: number; l: number; a?: number[]; p?: number[]; d?: number[]; s?: number }
export interface MZone {
  w: number; l: number; bp: MBp[]; ls: number; le: number; lm: number; rl: number;
  rate: number; kt: number; vt: number; sync: number;
  ca: number | number[]; cb: number | number[]; cs?: number;
}
export interface MGen { pwm: number; cz: number; zones: MZone[] }
export interface MMorph { pts: [number, number, number][]; ls: number; le: number; lm: number; solo: number }
export interface MEnv { pts: [number, number][]; ls: number; le: number; lm: number; bip: number }
export interface MMod { src: number[]; dst: number[]; amt: number[] }

/** Non-parameter state keys (program structure and content references). */
export const STRUCT_KEYS = ['progName', 'poly', 'glideMode', 'nzLoop', 'nzFlt', 'gens', 'morph', 'envs', 'mod', 'noise',
  'noiseSample', 'noiseRate', 'noiseLoop', 'noiseMissing', 'spectraSample', 'spectraMissing'] as const;

// ------------------------------------------------------------------ synthesized spectra

/**
 * Synthesized stand-in spectra (not FL data), one per generator, for factory
 * presets whose analysed spectra are FL content: A saw, B square, C triangle,
 * D a bright pulse. Stored amplitudes are cube roots (the DSP plays a^3).
 */
export function substituteSpectrum(gen: number, partials = 32, level = 0.5): Float32Array {
  const a = new Float32Array(NP);
  for (let k = 0; k < Math.min(NP, partials); k++) {
    const h = k + 1;
    let v = 0;
    switch (gen & 3) {
      case 0: v = 1 / h; break;
      case 1: v = h & 1 ? 1 / h : 0; break;
      case 2: v = h & 1 ? 1 / (h * h) : 0; break;
      default: v = 1 / Math.sqrt(h); break;
    }
    a[k] = f32(Math.cbrt(v * level));
  }
  return a;
}

// ------------------------------------------------------------------ defaults

const timelineDefaults = { ls: 100, le: 110, lm: 3, rl: 0, rate: 0.5, kt: 0.5, vt: 0.5, sync: 0 };

function defaultZone(amp: number[] | null): MZone {
  const bp: MBp = { t: 100, l: 1 };
  if (amp) bp.a = amp;
  return { w: 128, l: 1, bp: [bp], ...timelineDefaults, ca: 1, cb: 1 };
}

const defaultEnv = (): MEnv => ({ pts: [[1, 100]], ls: 100, le: 110, lm: 0, bip: 0 });

/** The default program: FL's reset values with synthesized spectra (saw, square, triangle, pulse; 64 partials). */
export function defaultProgram(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  MOR_PARAMS.forEach((d) => { o[d.key] = d.def; });
  o.progName = 'Init';
  o.poly = 31;
  o.glideMode = 0;
  o.nzLoop = 0;
  o.nzFlt = 0;
  o.gens = [0, 1, 2, 3].map((g): MGen => ({ pwm: 0, cz: 0, zones: [defaultZone(Array.from(substituteSpectrum(g, 64)))] }));
  o.morph = { pts: [[0, 1, 100]], ls: 100, le: 110, lm: 0, solo: 0 } satisfies MMorph;
  o.envs = [0, 1, 2, 3].map(defaultEnv);
  o.mod = { src: new Array(12).fill(0), dst: new Array(12).fill(0), amt: new Array(12).fill(0.5) } satisfies MMod;
  o.noise = '';
  return o;
}

// ------------------------------------------------------------------ normalisation

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const int = (v: unknown, d: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.trunc(num(v, d))));
const flt = (v: unknown, d: number, lo = -1e6, hi = 1e6): number => f32(Math.min(hi, Math.max(lo, num(v, d))));
const bool = (v: unknown): number => (v ? 1 : 0);

function arr128(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < Math.min(NP, v.length); i++) out.push(flt(v[i], 0));
  return out;
}

function curve(v: unknown): number | number[] {
  if (Array.isArray(v)) {
    const a = arr128(v)!;
    while (a.length < NP) a.push(a.length ? a[a.length - 1] : 1);
    return a;
  }
  return flt(v, 1);
}

function normBp(v: unknown): MBp {
  const b = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const o: MBp = { t: int(b.t, 100, 0, MAX_TIME), l: flt(b.l, 1) };
  const a = arr128(b.a), p = arr128(b.p), d = arr128(b.d);
  if (a) o.a = a;
  if (p) o.p = p;
  if (d) o.d = d;
  if (typeof b.s === 'number' && Number.isFinite(b.s) && b.s >= 0) o.s = Math.trunc(b.s);
  return o;
}

function normZone(v: unknown): MZone {
  const z = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const bps = Array.isArray(z.bp) ? z.bp.slice(0, MAX_BPS).map(normBp) : [];
  const o: MZone = {
    w: int(z.w, 128, 1, 1 << 20),
    l: flt(z.l, 1, 0, 1),
    bp: bps.length ? bps : [{ t: 100, l: 1 }],
    ls: int(z.ls, 100, -MAX_TIME, MAX_TIME),
    le: int(z.le, 110, -MAX_TIME, MAX_TIME),
    lm: int(z.lm, 3, 0, 3),
    rl: bool(z.rl),
    rate: flt(z.rate, 0.5, 0, 1),
    kt: flt(z.kt, 0.5, 0, 1),
    vt: flt(z.vt, 0.5, 0, 1),
    sync: bool(z.sync),
    ca: curve(z.ca),
    cb: curve(z.cb),
  };
  if (typeof z.cs === 'number' && Number.isFinite(z.cs) && z.cs >= 0) o.cs = Math.trunc(z.cs);
  return o;
}

function normGen(v: unknown): MGen {
  const g = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const zones = Array.isArray(g.zones) ? g.zones.slice(0, MAX_ZONES).map(normZone) : [];
  if (!zones.length) zones.push(defaultZone(null));
  return { pwm: int(g.pwm, 0, 0, 2), cz: int(g.cz, 0, 0, zones.length - 1), zones };
}

function normMorph(v: unknown): MMorph {
  const m = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const pts: [number, number, number][] = [];
  if (Array.isArray(m.pts)) {
    for (const p of m.pts.slice(0, MAX_POINTS)) {
      if (!Array.isArray(p)) continue;
      pts.push([flt(p[0], 0), flt(p[1], 0), int(p[2], 100, 0, MAX_TIME)]);
    }
  }
  if (!pts.length) pts.push([0, 1, 100]);
  return { pts, ls: int(m.ls, 100, -MAX_TIME, MAX_TIME), le: int(m.le, 110, -MAX_TIME, MAX_TIME), lm: int(m.lm, 0, 0, 3), solo: int(m.solo, 0, 0, 4) };
}

function normEnv(v: unknown): MEnv {
  const e = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const pts: [number, number][] = [];
  if (Array.isArray(e.pts)) {
    for (const p of e.pts.slice(0, MAX_POINTS)) {
      if (!Array.isArray(p)) continue;
      pts.push([flt(p[0], 0), int(p[1], 100, 0, MAX_TIME)]);
    }
  }
  if (!pts.length) pts.push([1, 100]);
  return { pts, ls: int(e.ls, 100, -MAX_TIME, MAX_TIME), le: int(e.le, 110, -MAX_TIME, MAX_TIME), lm: int(e.lm, 0, 0, 3), bip: bool(e.bip) };
}

function normMod(v: unknown): MMod {
  const m = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const a = (x: unknown) => (Array.isArray(x) ? x : []);
  const src = a(m.src), dst = a(m.dst), amt = a(m.amt);
  return {
    src: Array.from({ length: 12 }, (_, i) => int(src[i], 0, 0, 136)),
    dst: Array.from({ length: 12 }, (_, i) => int(dst[i], 0, 0, 47)),
    amt: Array.from({ length: 12 }, (_, i) => flt(amt[i], 0.5, 0, 1)),
  };
}

/** Repair / complete a stored Morphine state (also expands a factory preset reference, see morphine.ts). */
export function normalizeMorphine(p: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...p };
  for (const d of MOR_PARAMS) {
    const v = o[d.key];
    o[d.key] = typeof v === 'number' && Number.isFinite(v) ? vOf(fOf(v)) : d.def;
  }
  o.progName = typeof o.progName === 'string' ? o.progName.slice(0, 255) : 'Init';
  o.poly = int(o.poly, 31, 0, 31);
  o.glideMode = int(o.glideMode, 0, 0, 3);
  o.nzLoop = int(o.nzLoop, 0, 0, 3);
  o.nzFlt = int(o.nzFlt, 0, 0, 3);
  const gens = Array.isArray(o.gens) ? o.gens : [];
  o.gens = [0, 1, 2, 3].map((g) => normGen(gens[g]));
  o.morph = normMorph(o.morph);
  const envs = Array.isArray(o.envs) ? o.envs : [];
  o.envs = [0, 1, 2, 3].map((e) => normEnv(envs[e]));
  o.mod = normMod(o.mod);
  o.noise = typeof o.noise === 'string' ? o.noise.slice(0, 1023) : '';
  if (typeof o.noiseSample !== 'string' || !o.noiseSample) delete o.noiseSample;
  if (typeof o.noiseRate === 'number' && Number.isFinite(o.noiseRate) && o.noiseRate > 0) o.noiseRate = Math.min(1e6, o.noiseRate);
  else delete o.noiseRate;
  if (Array.isArray(o.noiseLoop) && o.noiseLoop.length === 2) o.noiseLoop = [int(o.noiseLoop[0], 0, -1, 1 << 30), int(o.noiseLoop[1], 0, -1, 1 << 30)];
  else delete o.noiseLoop;
  if (o.noiseMissing !== 1) delete o.noiseMissing;
  if (typeof o.spectraSample !== 'string' || !o.spectraSample) delete o.spectraSample;
  if (o.spectraMissing !== 1) delete o.spectraMissing;
  return o;
}

/**
 * Select generator g's current zone (FL's zone list): its timeline values move
 * into the parameters 43..47 of that generator and the previous current zone
 * keeps the parameters' values. Returns the state changes.
 */
export function selectZone(st: Record<string, unknown>, g: number, z: number): Record<string, unknown> {
  const gens = (st.gens as MGen[]).map((x) => ({ ...x, zones: x.zones.slice() }));
  const gen = gens[g];
  if (!gen || z < 0 || z >= gen.zones.length || z === gen.cz) return {};
  const key = (k: number) => MOR_KEYS[genParam(g, k)];
  const f = (k: number) => fOf(st[key(k)] as number);
  gen.zones[gen.cz] = { ...gen.zones[gen.cz], rl: f(0) ? 1 : 0, sync: f(1) ? 1 : 0, rate: f(2), vt: f(3), kt: f(4) };
  const nz = gen.zones[z];
  gen.cz = z;
  return { gens, [key(0)]: vOf(nz.rl), [key(1)]: vOf(nz.sync), [key(2)]: vOf(nz.rate), [key(3)]: vOf(nz.vt), [key(4)]: vOf(nz.kt) };
}

/** A program's parameter floats 0..122 (stored floats). */
export function progFloats(st: Record<string, unknown>): number[] {
  return PROG_DEFAULTS.map((d, i) => {
    const v = st[MOR_KEYS[i]];
    return typeof v === 'number' && Number.isFinite(v) ? fOf(v) : d;
  });
}
