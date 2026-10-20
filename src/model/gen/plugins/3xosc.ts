// 3x Osc (FL: 3x Osc, Plugin database > Generators > Synth classic): three
// oscillators with shapes, coarse / fine pitch, panning, stereo phase offset
// and detune, mix levels for oscillators 2 and 3, inversion, AM by
// oscillator 3, stereo phase randomness and HQ (anti-aliased) oscillators.
// FL's "hybrid" generator: its INS tab (envelopes, LFOs, filter) is the
// channel's INS settings here.
//
// From FL 2026's plugin (3x Osc_x64.dylib): the editor form (SynthPanel
// 558 x 389; Osc1Select Tag 1 .. RandPhaseWheel Tag 20, form DefaultValue
// 64 for the mix wheels, 0 elsewhere), the test host's parameter list and
// value texts (`flfxhost info / sweep "3x Osc"`: params 0..20; 21..113 are
// the INS block), the plugin info (generator, note input, DefPoly 0), and the
// state format (SaveRestoreState 0x5c9b0, version 14: the 21 parameters, then
// bytes invert osc 1 / 2 / 3, AM, then HQ, then the INS block; older versions
// down to the 11-integer 2.5 format of Default.fst are read too).
//
// Fresh instance: FL adds the plugin with Plugin database/Generators/Synth
// classic/3x Osc.fst (version 12: osc 2 at 64 = 50 % and -12 semitones, osc 3
// at 32 = 25 % and -24 semitones; switches off), which is also the factory
// Default.fst (version 0: the same values, everything else 0); both render
// bit-identically. The constructor state (all 21 parameters 0) plays only
// oscillator 1. The parameters' defaults stay FL's form values (the Reset
// value of each wheel: mix levels 64), and state() gives the fresh instance
// the Default patch.

import type { GenPluginDef, GenParamDef } from '../types';

/** FL's pan text: "Centered", "N% left" / "N% right" (N = |v| / 64 x 100, banker's rounding: FPC Round). */
export function panText(v: number): string {
  if (v === 0) return 'Centered';
  const x = (Math.abs(v) / 64) * 100;
  let p = Math.round(x);
  if (p - x === 0.5 && p % 2 !== 0) p -= 1;
  return `${p}% ${v < 0 ? 'left' : 'right'}`;
}

/** FL's percent texts (phase offset, mix level, phase randomness): sign, |v| / max x 100 rounded half up. */
export function pctText(v: number, max: number): string {
  const p = Math.floor((Math.abs(v) / max) * 100 + 0.5);
  return `${v < 0 && p !== 0 ? '-' : ''}${p}%`;
}

/** "+0 semitone", "-1 semitone", "+12 semitones" (and cents likewise). */
export function unitText(v: number, unit: string): string {
  return `${v < 0 ? '-' : '+'}${Math.abs(v)} ${unit}${Math.abs(v) === 1 || v === 0 ? '' : 's'}`;
}

export const SHAPES = ['Sine', 'Triangle', 'Square', 'Saw', 'Rounded saw', 'Noise', 'Custom'];

function osc(n: number, base: number): GenParamDef[] {
  const o: GenParamDef[] = [];
  if (n > 1) o.push({ key: `mix${n}`, name: `Osc ${n} mix level`, index: base - 1, min: 0, max: 128, def: 64, format: (v) => pctText(v, 128), parse: (t) => Math.round((t / 100) * 128) });
  o.push(
    { key: `pan${n}`, name: `Osc ${n} panning`, index: base, min: -64, max: 64, def: 0, bipolar: true, format: panText, parse: (t) => Math.round((t / 100) * 64) },
    { key: `shape${n}`, name: `Osc ${n} shape`, index: base + 1, min: 0, max: 6, def: 0, options: SHAPES, format: () => '' },
    { key: `coarse${n}`, name: `Osc ${n} coarse pitch`, index: base + 2, min: -24, max: 24, def: 0, bipolar: true, format: (v) => unitText(v, 'semitone') },
    { key: `fine${n}`, name: `Osc ${n} fine pitch`, index: base + 3, min: -100, max: 100, def: 0, bipolar: true, format: (v) => unitText(v, 'cent') },
    { key: `phase${n}`, name: `Osc ${n} stereo phase offset`, index: base + 4, min: -64, max: 64, def: 0, bipolar: true, format: (v) => pctText(v, 64), parse: (t) => Math.round((t / 100) * 64) },
    { key: `detune${n}`, name: `Osc ${n} stereo detune`, index: base + 5, min: -50, max: 50, def: 0, bipolar: true, format: (v) => unitText(v, 'cent') },
  );
  return o;
}

/** Switches without a parameter index (FL's state bytes after the 21 parameters). */
export const SWITCHES = { inv1: false, inv2: false, inv3: false, am: false, hq: false };

/** FL's Default patch (Default.fst / the plugin database state): what a new 3x Osc plays. */
export const DEFAULT_PATCH = {
  pan1: 0, shape1: 0, coarse1: 0, fine1: 0, phase1: 0, detune1: 0,
  mix2: 64, pan2: 0, shape2: 0, coarse2: -12, fine2: 0, phase2: 0, detune2: 0,
  mix3: 32, pan3: 0, shape3: 0, coarse3: -24, fine3: 0, phase3: 0, detune3: 0,
  rand: 0,
};

export const def: GenPluginDef = {
  id: '3xosc',
  name: '3x Osc',
  category: 'Synth classic',
  notes: 'voices',
  ins: true,
  // FL's voice engine applies the voice's pan / volume levels itself (ramped, after the release fade)
  levels: 'plugin',
  defPoly: 0,
  width: 558,
  height: 389,
  description: 'Three-oscillator subtractive synthesizer',
  params: [
    ...osc(1, 0),
    ...osc(2, 7),
    ...osc(3, 14),
    { key: 'rand', name: 'Stereo phase randomness', index: 20, min: 0, max: 64, def: 0, format: (v) => pctText(v, 64), parse: (t) => Math.round((t / 100) * 64) },
  ],
  // the custom shape's sample: a sample pool id (delivered to the engine) or ''
  state: () => ({ ...DEFAULT_PATCH, ...SWITCHES, sample: '' }),
  normalize: (p) => {
    const o = { ...p };
    for (const k of Object.keys(SWITCHES)) o[k] = o[k] === true;
    o.sample = typeof o.sample === 'string' ? o.sample : '';
    return o;
  },
  presets: [
    { name: 'Default', params: { ...DEFAULT_PATCH, ...SWITCHES } },
  ],
};
