// Morphine (FL: Morphine, Plugin database > Generators > Synth special): FL's
// additive morphing synthesizer. Four generators, each a set of keyboard zones
// holding a timeline of spectra (breakpoints of 128 partials: amplitude, pan,
// detune), are morphed on an XY square along a morph path, played by a bank of
// magic-circle sine oscillators per voice (per-voice 127-sample control grid,
// master ADSR with a Catmull-Rom gain spline), with a sampled noise layer and
// its filter, four looping modulation envelopes, a 12-slot modulation matrix
// (velocity, key, MIDI CCs, aftertouch, envelopes), PWM, glide / mono modes and
// the effects chain (overdrive, chorus, delay, reverb, EQ).
//
// From FL 2026's Morphine_x64.dylib (plugin 1.7.0 Rev2653, arm64 slice;
// .flref/morphine/NOTES.md, notes/fx.md):
// - the 252 automatable parameters (params.ts: FL's names, raw 0..256 controls
//   holding FL's exact stored floats, value texts as the plugin prints them);
// - the program structure (state.ts) and FL's .mrp / FL state / .fst formats
//   (mrp.ts: read and write);
// - the 300 factory programs with their parameter-level data (presets.ts); the
//   analysed spectra and the noise samples are FL content, imported from the
//   user's FL installation (import.ts); without it presets play synthesized
//   stand-in spectra;
// - a new instance plays a synthesized init program (FL's reset values).

import type { GenPluginDef, GenPreset } from '../types';
import { inflateRaw, base64ToBytes } from './drumaxx/inflate';
import { MOR_KEYS, MOR_PARAMS, N_PROG, vOf } from './morphine/params';
import { MOR_PRESET_DATA, MOR_PRESET_NAMES } from './morphine/presets';
import { defaultProgram, normalizeMorphine, type MEnv, type MGen, type MMorph, type MZone } from './morphine/state';

const f32 = Math.fround;

type ZoneEntry = [number, number, number, number, number, number, number, number, number, number, number | null, number | null, number[], number[]];
type Entry = [string, number[], number[], [number, ZoneEntry[]][], [number[], number, number, number, number],
  [number[], number, number, number, number][], [number[], number[], number[]], string, string?];

let bank: Entry[] | null = null;
function presetBank(): Entry[] {
  if (!bank) bank = JSON.parse(new TextDecoder().decode(inflateRaw(base64ToBytes(MOR_PRESET_DATA)))) as Entry[];
  return bank;
}

/** A factory program's state (parameter-level data; spectra flagged missing). */
export function factoryProgram(i: number): Record<string, unknown> | null {
  const e = presetBank()[i];
  if (!e) return null;
  const [name, pf, internal, gens, morph, envs, mod, noise, pname] = e;
  const o: Record<string, unknown> = {};
  for (let k = 0; k < MOR_KEYS.length; k++) o[MOR_KEYS[k]] = k < N_PROG ? vOf(pf[k] ?? 0) : 0;
  o.progName = pname ?? name.slice(name.lastIndexOf('/') + 1);
  [o.poly, o.glideMode, o.nzLoop, o.nzFlt] = internal;
  o.gens = gens.map(([pwm, zones]): MGen => ({
    pwm, cz: 0,
    zones: zones.map(([w, l, ls, le, lm, rl, rate, kt, vt, sync, ca, cb, times, levels]): MZone => ({
      w, l: f32(l), ls, le, lm, rl, rate: f32(rate), kt: f32(kt), vt: f32(vt), sync, ca: f32(ca ?? 1), cb: f32(cb ?? 1),
      bp: times.map((t, k) => ({ t, l: f32(levels[k]) })),
    })),
  }));
  const pts: [number, number, number][] = [];
  for (let k = 0; k + 2 < morph[0].length; k += 3) pts.push([f32(morph[0][k]), f32(morph[0][k + 1]), morph[0][k + 2]]);
  o.morph = { pts, ls: morph[1], le: morph[2], lm: morph[3], solo: morph[4] >= 1 && morph[4] <= 4 ? morph[4] : 0 } satisfies MMorph;
  o.envs = envs.map(([flat, ls, le, lm, bip]): MEnv => {
    const ep: [number, number][] = [];
    for (let k = 0; k + 1 < flat.length; k += 2) ep.push([f32(flat[k]), flat[k + 1]]);
    return { pts: ep, ls, le, lm, bip };
  });
  o.mod = { src: mod[0].slice(), dst: mod[1].slice(), amt: mod[2].map(f32) };
  o.noise = noise;
  o.spectraMissing = 1;
  if (noise) o.noiseMissing = 1;
  return o;
}

/** Content keys a factory program replaces (pool references of a previous program). */
const CONTENT_KEYS = ['noiseSample', 'noiseRate', 'noiseLoop', 'noiseMissing', 'spectraSample', 'spectraMissing'];

/** Normalise a stored state; expands a factory preset reference ({ __m: index }). */
export function normalizeMorphineState(p: Record<string, unknown>): Record<string, unknown> {
  let q = p;
  if (typeof p.__m === 'number') {
    const fp = factoryProgram(p.__m);
    q = { ...p };
    delete q.__m;
    if (fp) {
      for (const k of CONTENT_KEYS) delete q[k];
      Object.assign(q, fp);
    }
  }
  return normalizeMorphine(q);
}

/** Index of a factory preset by name ("Folder/Name" or just the program / file name, case-insensitive); -1 if none. */
export function factoryPresetIndex(name: string): number {
  const n = name.trim().toLowerCase().replace(/\.mrp$/, '');
  let i = MOR_PRESET_NAMES.findIndex((x) => x.toLowerCase() === n);
  if (i < 0) i = MOR_PRESET_NAMES.findIndex((x) => x.slice(x.lastIndexOf('/') + 1).toLowerCase() === n);
  return i;
}

const presets: GenPreset[] = MOR_PRESET_NAMES.map((name, i) => ({ name, params: { __m: i } }));

export const def: GenPluginDef = {
  id: 'morphine',
  name: 'Morphine',
  category: 'Synth special',
  notes: 'events',
  levels: 'plugin',
  velocity: 'plugin',
  defPoly: 32,
  width: 886,
  height: 552,
  description: 'Additive morphing synthesizer',
  params: MOR_PARAMS,
  viewState: ['mView'],
  state: () => defaultProgram(),
  normalize: (p) => normalizeMorphineState(p),
  presets,
};
