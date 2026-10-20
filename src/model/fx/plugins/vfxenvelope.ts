// VFX Envelope (FL: VFX Envelope): 16 articulators, each answering notes of
// one note colour inside a key range, with an envelope and an LFO for each of
// five note properties (Velocity, Pitch, Pan, Mod X, Mod Y).
// Form: SynthPanel 768 x 400. Parameters (FL's 880, in FL's order): for
// articulator a (1..16) and target t, index (a-1)*55 + t*11 + field: Attack,
// Decay (0..256, 128), Sustain (-128..128, 0), Release (0..256, 128), LFO Speed
// (512..65536, 40898), LFO Tension, LFO Skew (-128..128), LFO Pulse Width
// (-112..112), Base Level (0..256), Envelope Level, LFO Level (-256..256).
// Defaults follow FL's Default preset (applied on insertion): Velocity base 0,
// Pitch envelope level 64, LFO levels 256. Per-target state (envelope points,
// loop / decay / sustain markers, the LFO part's envelope, TEMPO / GLOBAL) is
// plugin state; the factory presets were decoded from FL's .fst files.

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';
import { envFrom, flatEnv, normalizeEnv, type EnvPoints } from './vfx/envelope';

export const ARTICULATORS = 16;
export const ENV_TARGETS = [
  { id: 'vel', name: 'Velocity', bipolar: false },
  { id: 'pitch', name: 'Pitch', bipolar: true },
  { id: 'pan', name: 'Pan', bipolar: true },
  { id: 'modx', name: 'Mod X', bipolar: true },
  { id: 'mody', name: 'Mod Y', bipolar: true },
] as const;

export const ENV_FIELDS = [
  { f: 'Att', name: 'Attack', min: 0, max: 256, def: 128 },
  { f: 'Dec', name: 'Decay', min: 0, max: 256, def: 128 },
  { f: 'Sus', name: 'Sustain', min: -128, max: 128, def: 0 },
  { f: 'Rel', name: 'Release', min: 0, max: 256, def: 128 },
  { f: 'LfoSpd', name: 'LFO Speed', min: 512, max: 65536, def: 40898 },
  { f: 'LfoTns', name: 'LFO Tension', min: -128, max: 128, def: 0 },
  { f: 'LfoSkw', name: 'LFO Skew', min: -128, max: 128, def: 0 },
  { f: 'LfoPw', name: 'LFO Pulse Width', min: -112, max: 112, def: 0 },
  { f: 'Base', name: 'Base Level', min: 0, max: 256, def: 128 },
  { f: 'Env', name: 'Envelope Level', min: -256, max: 256, def: 256 },
  { f: 'Lfo', name: 'LFO Level', min: -256, max: 256, def: 256 },
] as const;

export type EnvField = (typeof ENV_FIELDS)[number]['f'];

export const envKey = (a: number, t: number, f: EnvField): string => `a${a + 1}${ENV_TARGETS[t].id}${f}`;

/** FL Default preset values that differ from the constructor's. */
function fieldDefault(t: number, f: EnvField): number {
  if (f === 'Base') return t === 0 ? 0 : 128;
  if (f === 'Env') return t === 1 ? 64 : 256;
  return ENV_FIELDS.find((x) => x.f === f)!.def;
}

/** LFO speed: cycles per beat (40898 = 1 per beat, +8192 doubles). */
export const lfoCyclesPerBeat = (v: number): number => Math.pow(2, (v - 40898) / 8192);
/** ATT / DEC / REL knobs scale their envelope parts: 0 = x0.25, 128 = x1, 256 = x4. */
export const envTimeScale = (v: number): number => Math.pow(2, (v - 128) / 64);

const pct = (v: number, full: number) => `${Math.round((v / full) * 100)}%`;
const spct = (v: number, full: number) => { const p = Math.round((v / full) * 100); return `${p > 0 ? '+' : ''}${p}%`; };

function fieldFormat(f: EnvField): (v: number) => string {
  switch (f) {
    case 'Att': case 'Dec': case 'Rel': return (v) => `x${envTimeScale(v).toFixed(2)}`;
    case 'Sus': return (v) => spct(v, 128);
    case 'LfoSpd': return (v) => `${lfoCyclesPerBeat(v) >= 1 ? lfoCyclesPerBeat(v).toFixed(2) : lfoCyclesPerBeat(v).toFixed(3)} / beat`;
    case 'LfoPw': return (v) => spct(v, 112);
    case 'Base': return (v) => pct(v, 256);
    case 'Env': case 'Lfo': return (v) => spct(v, 256);
    default: return (v) => spct(v, 128);
  }
}

function params(): FxParamDef[] {
  const out: FxParamDef[] = [];
  for (let a = 0; a < ARTICULATORS; a++) {
    ENV_TARGETS.forEach((t, ti) => {
      ENV_FIELDS.forEach((fd, fi) => {
        out.push({
          key: envKey(a, ti, fd.f), name: `Articulator ${a + 1} ${t.name} - ${fd.name}`, index: a * 55 + ti * 11 + fi,
          min: fd.min, max: fd.max, def: fieldDefault(ti, fd.f), bipolar: fd.min < 0, format: fieldFormat(fd.f),
        });
      });
    });
  }
  return out;
}

export interface EnvTarget {
  /** "Select to activate envelope". */
  on: boolean;
  /** Envelope points, positions in beats (TEMPO) or seconds. */
  env: EnvPoints;
  /** Loop between the D and S markers while the note is held. */
  loop: boolean;
  /** D marker (decay start / loop start) and S marker (sustain / loop end) point indices, -1 = none. */
  dec: number;
  sus: number;
  /** The LFO part's envelope: the LFO amount over time (0..1). */
  lfo: EnvPoints;
  lfoLoop: boolean;
  lfoDec: number;
  lfoSus: number;
  tempo: boolean;
  global: boolean;
  lfoGlobal: boolean;
}

export interface Articulator {
  /** Note colour group 0..15. */
  color: number;
  /** Key range (inclusive, 0..131). */
  low: number;
  high: number;
  targets: EnvTarget[];
}

const VEL_ENV = [[0, 0], [0.75, 1, 0.2], [2.25, 0.5, 0.2], [2.5, 0, 0.2]];
const BI_ENV = [[0, 0.5], [0.25, 0.5, 0.2]];

export function defaultTarget(t: number): EnvTarget {
  return t === 0
    ? { on: true, env: envFrom(VEL_ENV), loop: false, dec: 1, sus: 2, lfo: flatEnv(0, 0.25), lfoLoop: false, lfoDec: -1, lfoSus: -1, tempo: true, global: false, lfoGlobal: false }
    : { on: true, env: envFrom(BI_ENV), loop: true, dec: 0, sus: 1, lfo: flatEnv(0, 0.25), lfoLoop: false, lfoDec: -1, lfoSus: -1, tempo: true, global: false, lfoGlobal: false };
}

export function defaultArticulator(color = 0): Articulator {
  return { color, low: 0, high: 131, targets: ENV_TARGETS.map((_, t) => defaultTarget(t)) };
}

const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);

export function normalizeArticulators(raw: unknown): Articulator[] {
  const arr = Array.isArray(raw) ? raw : [];
  return Array.from({ length: ARTICULATORS }, (_, a) => {
    const r = (arr[a] && typeof arr[a] === 'object' ? arr[a] : {}) as Partial<Articulator>;
    const tg = Array.isArray(r.targets) ? r.targets : [];
    return {
      color: int(r.color, 0, 15, 0),
      low: int(r.low, 0, 131, 0),
      high: int(r.high, 0, 131, 131),
      targets: ENV_TARGETS.map((_, t) => {
        const d = defaultTarget(t);
        const q = (tg[t] && typeof tg[t] === 'object' ? tg[t] : {}) as Partial<EnvTarget>;
        const len = (p: unknown) => (Array.isArray(p) && p.length ? Math.max(0.01, ...p.map((x) => (x && typeof x.pos === 'number' ? x.pos : 0))) : 1);
        const env = normalizeEnv(q.env, d.env, len(q.env));
        const lfo = normalizeEnv(q.lfo, d.lfo, len(q.lfo));
        return {
          on: q.on === undefined ? d.on : !!q.on,
          env, loop: q.loop === undefined ? d.loop : !!q.loop,
          dec: int(q.dec, -1, env.length - 1, Math.min(d.dec, env.length - 1)),
          sus: int(q.sus, -1, env.length - 1, Math.min(d.sus, env.length - 1)),
          lfo, lfoLoop: !!q.lfoLoop, lfoDec: int(q.lfoDec, -1, lfo.length - 1, -1), lfoSus: int(q.lfoSus, -1, lfo.length - 1, -1),
          tempo: q.tempo === undefined ? true : !!q.tempo, global: !!q.global, lfoGlobal: !!q.lfoGlobal,
        };
      }),
    };
  });
}

function presetArts(f: (a: Articulator, i: number) => void): Articulator[] {
  return Array.from({ length: ARTICULATORS }, (_, i) => { const a = defaultArticulator(); f(a, i); return a; });
}

const PRESETS: FxPreset[] = [
  { name: 'Default', params: { arts: presetArts(() => {}) } },
  { name: 'Default (all channels)', params: { arts: presetArts((a, i) => { a.color = i; }) } },
  {
    name: 'Pumping', params: {
      arts: presetArts((a, i) => {
        if (i === 0) a.targets[0] = { ...a.targets[0], env: envFrom([[0, 0], [0.5, 1, -0.16], [1, 0, 0, 2]]), loop: true, dec: 0, sus: 2 };
      }),
    },
  },
  {
    name: 'Vibrato', params: {
      a1pitchLfoSpd: 54917, a1pitchEnv: 2,
      arts: presetArts((a, i) => {
        if (i !== 0) return;
        a.targets[0] = { ...a.targets[0], env: flatEnv(1, 0.25), loop: false, dec: -1, sus: 0 };
        a.targets[1] = { ...a.targets[1], lfo: flatEnv(1, 0.25) };
      }),
    },
  },
];

export const def: FxPluginDef = {
  id: 'vfxenvelope',
  name: 'VFX Envelope',
  category: 'Patcher',
  width: 768,
  height: 400,
  description: 'Envelopes and LFOs on note velocity, pitch, pan and mod X / Y by note color (Patcher)',
  params: params(),
  state: () => ({ arts: presetArts(() => {}), enable: 1, art: 0, target: 0, mode: 0 }),
  normalize: (p) => ({ ...p, arts: normalizeArticulators(p.arts) }),
  presets: PRESETS,
};
