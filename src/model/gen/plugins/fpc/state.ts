// FPC's state model: 2 banks x 16 pads, each with its layers (samples), its
// volume / pan envelopes and its settings (docs/research/gen/fpc.md). FL keeps
// the same data in its state chunks (pad chunk 100: volume, pan, flags, key,
// output, cut groups, tune, colour, icon; 101 name; 102 random mode; 105
// layers: sample file, volume, pan, velocity range, flags, tune, region; 103 /
// 104 the two envelopes). Pad volume, pan, mute, solo, tune and the envelopes'
// ADSR knobs are FL parameters (keys of the plugin state), the rest lives in
// `pads` (JSON).

import { FPC_DIRS, FPC_ENVS, FPC_KITS, FPC_PADS, FPC_PRESET_NAMES, type RawEnv, type RawLayer, type RawPad } from './kits';

export const FPC_PADS_N = 32;
/** Layers a pad can hold here (FL's list is unbounded; the factory kits use up to 21). */
export const FPC_MAX_LAYERS = 64;

/** A layer: a sample played over a velocity range. */
export interface FpcLayer {
  /** Sample pool id ('' = none; also when the file reference is not resolved yet). */
  sample: string;
  /** FL's file reference ('%FLStudioFactoryData%\Data\...\name.wav' for FL's library, else the file name); '' = empty layer. */
  file: string;
  /** Volume 0..127 (FL's new layer: 127). */
  vol: number;
  /** Pan -128..128. */
  pan: number;
  /** Velocity range: lo <= velocity < hi (hi 127 also takes 127). */
  lo: number;
  hi: number;
  /** "Scale volume with velocity" (FL keeps it per layer, the pad's switch sets every layer). */
  vel: boolean;
  /** Reverse sample. */
  rev: boolean;
  /** Tune -128..128 (9.375 cents per step: +-1 octave). */
  tune: number;
  /** Sample region (-1 = the whole sample). */
  region: number;
}

/**
 * An envelope (FL's TMEnvelope state): points [dt, value, tension, mode, b13, b14, b15] with dt the segment length
 * before the point (envelope units of 0.5 s, FL's delta format), value 0..1, tension -1..1, mode = FL's point curve
 * type; markers as point indexes (-1 = none): D decay start, L loop start, S sustain.
 */
export interface FpcEnv {
  on: boolean;
  flags: number;
  d: number;
  l: number;
  s: number;
  pts: number[][];
}

export interface FpcPad {
  name: string;
  /** Note that triggers the pad (60 = C5). */
  key: number;
  /** Mixer track offset (FL's "Output", 0 = the channel's track). */
  out: number;
  /** Cut group this pad cuts / cut by group (-1 = none). */
  cut: number;
  cutBy: number;
  /** Pad colour (Delphi TColor 0x00BBGGRR) and icon index. */
  color: number;
  icon: number;
  /** Lock layers (no overlapping velocity ranges). */
  lock: boolean;
  /** Trigger overlapping layers randomly. */
  random: boolean;
  /** Random layer mode: 0 Random, 1 Random (avoid previous), 2 Cycle backward, 3 Cycle. */
  rmode: number;
  layers: FpcLayer[];
  venv: FpcEnv;
  penv: FpcEnv;
}

export const FPC_RANDOM_MODES = ['Random', 'Random (avoid previous)', 'Cycle backward', 'Cycle'];

/** FL's empty pad colour. */
export const FPC_EMPTY_COLOR = 10920863;

export function fpcEmptyLayer(): FpcLayer {
  return { sample: '', file: '', vol: 127, pan: 0, lo: 0, hi: 127, vel: true, rev: false, tune: 0, region: -1 };
}

/** FL's default envelopes (TFPCVolEnvelope / TFPCPanEnvelope resets), disabled: volume an ADSR (D = 1, S = 2), pan centred. */
export function fpcDefaultEnv(pan: boolean): FpcEnv {
  return pan
    ? { on: false, flags: 0, d: -1, l: -1, s: -1, pts: [[0, 0.5, 0.2, 0, 0, 0, 0]] }
    : { on: false, flags: 0, d: 1, l: -1, s: 2, pts: [[0, 0, 0, 0, 0, 0, 0], [0.75, 1, 0.2, 0, 0, 0, 1], [1.5, 0.5, 0.2, 0, 0, 0, 1], [0.25, 0, 0.2, 0, 0, 0, 1]] };
}

export function fpcEmptyPad(key = 60): FpcPad {
  return {
    name: '', key, out: 0, cut: -1, cutBy: -1, color: FPC_EMPTY_COLOR, icon: 0, lock: false, random: false, rmode: 1,
    layers: [fpcEmptyLayer()], venv: fpcDefaultEnv(false), penv: fpcDefaultEnv(true),
  };
}

// ------------------------------------------------------------------ keys

/** FL parameter index of pad k's volume, pan, mute, solo (bank b = k >> 4: 64 b + 16 kind + k % 16) and tune (256 + 64 b + k % 16). */
export function fpcPadIndex(k: number, kind: 'vol' | 'pan' | 'mute' | 'solo' | 'tune'): number {
  const b = k >> 4, j = k & 15;
  switch (kind) {
    case 'vol': return 64 * b + j;
    case 'pan': return 64 * b + 16 + j;
    case 'mute': return 64 * b + 32 + j;
    case 'solo': return 64 * b + 48 + j;
    default: return 256 + 64 * b + j;
  }
}

/** Envelope knob keys per pad (FL indices 512 + 8 k + n): volume / pan attack, decay, sustain, release. */
export const FPC_ENV_KEYS = ['va', 'vd', 'vs', 'vr', 'pa', 'pd', 'ps', 'pr'] as const;
export const fpcKey = (kind: string, k: number): string => `${kind}${k + 1}`;

// ------------------------------------------------------------------ kits

function envOf(raw: RawEnv | undefined, pan: boolean): { env: FpcEnv; adsr: number[] } {
  if (!raw) return { env: fpcDefaultEnv(pan), adsr: [128, 128, 0, 128] };
  const [, flags, enabled, d, l, s, a, dc, su, r, pts] = raw;
  return { env: { on: enabled !== 0, flags, d, l, s, pts: pts.map((p) => [...p]) }, adsr: [a, dc, su, r] };
}

function layerOf(l: RawLayer): FpcLayer {
  const [dir, file, vol, pan, lo, hi, flags, tune, region] = l;
  return {
    sample: '', file: dir >= 0 ? `${FPC_DIRS[dir]}\\${file}` : '', vol, pan, lo, hi,
    vel: (flags & 1) !== 0, rev: (flags & 2) !== 0, tune, region,
  };
}

/** Pad k of a raw kit as [pad state, its parameter values]. */
function padOf(raw: RawPad, k: number): [FpcPad, Record<string, number>] {
  const [vol, pan, flags, key, out, cut, cutBy, tune, color, icon, name, rmode, ve, pe, layers] = raw;
  const v = envOf(FPC_ENVS[ve], false), p = envOf(FPC_ENVS[pe], true);
  const pad: FpcPad = {
    name, key, out, cut, cutBy, color, icon, lock: (flags & 4) !== 0, random: (flags & 8) !== 0, rmode,
    layers: layers.map(layerOf), venv: v.env, penv: p.env,
  };
  const prm: Record<string, number> = {
    [fpcKey('vol', k)]: vol, [fpcKey('pan', k)]: pan, [fpcKey('mute', k)]: flags & 1 ? 1 : 0,
    [fpcKey('solo', k)]: flags & 2 ? 1 : 0, [fpcKey('tune', k)]: tune,
  };
  FPC_ENV_KEYS.forEach((e, n) => { prm[fpcKey(e, k)] = n < 4 ? v.adsr[n] : p.adsr[n - 4]; });
  return [pad, prm];
}

/** Kit i (0 = FL's plugin database state, i + 1 = preset i) as a state fragment, or null. */
export function fpcKitState(i: number): Record<string, unknown> | null {
  const kit = FPC_KITS[i];
  if (!kit) return null;
  const q: Record<string, unknown> = {};
  const pads: FpcPad[] = [];
  kit[2].forEach((pi, k) => {
    const [pad, prm] = padOf(FPC_PADS[pi], k);
    pads.push(pad);
    Object.assign(q, prm);
  });
  q.pads = pads;
  q.loop = kit[0];
  return q;
}

export { FPC_PRESET_NAMES };

// ------------------------------------------------------------------ repair

const num = (x: unknown, d: number, lo: number, hi: number, int = true): number => {
  if (typeof x !== 'number' || !Number.isFinite(x)) return d;
  const v = Math.max(lo, Math.min(hi, x));
  return int ? Math.round(v) : v;
};
const str = (x: unknown, d = ''): string => (typeof x === 'string' ? x : d);

function normEnv(x: unknown, pan: boolean): FpcEnv {
  const d = fpcDefaultEnv(pan);
  if (!x || typeof x !== 'object') return d;
  const e = x as Partial<FpcEnv>;
  const pts = Array.isArray(e.pts) ? e.pts : [];
  const out: number[][] = [];
  for (const p of pts) {
    if (!Array.isArray(p) || out.length >= 1024) continue;
    out.push([num(p[0], 0, 0, 1e6, false), num(p[1], 0, 0, 1, false), num(p[2], 0, -1, 1, false), num(p[3], 0, 0, 255),
      num(p[4], 0, 0, 255), num(p[5], 0, 0, 255), num(p[6], out.length ? 1 : 0, 0, 255)]);
  }
  if (!out.length) out.push(...d.pts);
  const n = out.length;
  const mark = (v: unknown) => num(v, -1, -1, n - 1);
  return { on: e.on === true, flags: num(e.flags, 0, 0, 255), d: mark(e.d), l: mark(e.l), s: mark(e.s), pts: out };
}

function normLayer(x: unknown): FpcLayer {
  const d = fpcEmptyLayer();
  if (!x || typeof x !== 'object') return d;
  const l = x as Partial<FpcLayer>;
  return {
    sample: str(l.sample), file: str(l.file), vol: num(l.vol, d.vol, 0, 127), pan: num(l.pan, 0, -128, 128),
    lo: num(l.lo, 0, 0, 127), hi: num(l.hi, 127, 0, 127), vel: l.vel !== false, rev: l.rev === true,
    tune: num(l.tune, 0, -128, 128), region: num(l.region, -1, -1, 1 << 20),
  };
}

export function fpcNormPad(x: unknown, k: number): FpcPad {
  const d = fpcEmptyPad(60 + (k & 15));
  if (!x || typeof x !== 'object') return d;
  const p = x as Partial<FpcPad>;
  const layers = Array.isArray(p.layers) ? p.layers.slice(0, FPC_MAX_LAYERS).map(normLayer) : d.layers;
  return {
    name: str(p.name), key: num(p.key, d.key, 0, 131), out: num(p.out, 0, -125, 125), cut: num(p.cut, -1, -1, 99),
    cutBy: num(p.cutBy, -1, -1, 99), color: num(p.color, d.color, 0, 0xffffff), icon: num(p.icon, 0, 0, 1023),
    lock: p.lock === true, random: p.random === true, rmode: num(p.rmode, 1, 0, 3),
    layers, venv: normEnv(p.venv, false), penv: normEnv(p.penv, true),
  };
}
