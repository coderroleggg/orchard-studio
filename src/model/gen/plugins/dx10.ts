// DX10 (FL: Fruity DX10, Plugin database > Generators > Synth classic): Image-Line's
// port of Paul Kellett's mda DX10 FM synthesizer with a second modulator ("Mod 2")
// and an octave wheel ("Coarse"). See docs/research/gen/dx10.md.
//
// From FL 2026's binary (Fruity DX10_x64.dylib, arm64 slice, TTestPlug):
// - the editor form (SynthPanel 536 x 340; wheels Tag 0..21, Min / Max /
//   DefaultValue below; Coarse is -3..3, the others 0..65536);
// - parameter names from the test host (`flfxhost info "Fruity DX10"`; FL also
//   lists its INS envelope / LFO / filter block as parameters 22..113, which are
//   the channel's INS settings here);
// - value texts (GetName 0x5dc20, checked against `flfxhost sweep` for every
//   value of every parameter): rounded percent of the wheel; Mod Coarse
//   '%7.0f' of floor(40.1 c^2); Mod Fine '%7.3f' of the fine ratio; Mod Thru
//   '%7.2f' of 25 t^2; Coarse '%7d' (FPC Format, right-aligned in 7 columns);
// - the 59 factory presets (Plugin presets/Generators/Fruity DX10/*.fst: version
//   1 then the 22 values; identical to what the plugin reports after loading them).
//
// A fresh FL instance has the constructor state, which equals the factory
// "Default" preset (mda DX10's program 0, "Bright E.Piano"); the form's
// DefaultValue (the wheels' reset value) differs for Mod 1 Coarse (55706 vs
// 55181) and all of Mod 2 (reset values 55706 / 21561 / 15073 / 52429 / 3277 /
// 52429 / 58982, constructor 0): `def` keeps the form's reset values and
// `state()` gives the fresh instance the Default patch.

import type { GenParamDef, GenPluginDef, GenPreset } from '../types';

const W = 65536;
const f32 = Math.fround;

/** FL's normalised wheel value (float32 of (v - min) / (max - min)). */
export function dx10Norm(v: number, min = 0, max = W): number {
  return f32((v - min) / (max - min));
}

/** Integer part of a modulator's frequency ratio (Mod Coarse): floor(40.1 c^2), c = wheel 0..1. */
export function dx10CoarseRatio(c: number): number {
  return Math.floor(40.1 * c * c);
}

/**
 * Fractional part of a modulator's frequency ratio (Mod Fine), float32: 0.2 f^2
 * below the wheel's middle, then the fixed ratios 1/4, 1/3, 1/2, 2/3, 3/4 picked by
 * round(8.9 f) (FL rounds where mda DX10 truncates).
 */
export function dx10FineRatio(f: number): number {
  if (f < 0.5) return f32(0.2 * f * f);
  const i = roundEven(8.9 * f);
  return i === 4 ? 0.25 : i === 5 ? f32(1 / 3) : i === 6 ? 0.5 : i === 7 ? f32(2 / 3) : 0.75;
}

/** Round half to even (ARM frintx in the default rounding mode). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * C / FPC "%W.Pf": fixed point with P decimals, right-aligned in W columns, rounding
 * the exact binary value half to even (as printf does).
 */
export function fixed(x: number, prec: number, width = 7): string {
  let s = x.toFixed(prec);
  // toFixed rounds exact ties up; printf rounds them to even
  const scaled = x * 10 ** prec;
  const fl = Math.floor(scaled);
  if (scaled - fl === 0.5 && fl % 2 === 0 && Number.isFinite(scaled) && Math.abs(scaled) < 2 ** 52) s = (fl / 10 ** prec).toFixed(prec);
  return s.padStart(width);
}

const pct = (v: number) => `${Math.round((v / W) * 100)}%`;
const fromPct = (t: number) => Math.round((t / 100) * W);
const coarseText = (v: number) => fixed(dx10CoarseRatio(dx10Norm(v)), 0);
const fineText = (v: number) => fixed(dx10FineRatio(dx10Norm(v)), 3);
const thruText = (v: number) => {
  const t = dx10Norm(v);
  return fixed(f32(f32(25 * t) * t), 2);
};
/** Typed coarse ratio -> the smallest wheel value giving it. */
const fromCoarse = (r: number) => Math.min(W, Math.max(0, Math.ceil(Math.sqrt(Math.max(0, Math.round(r)) / 40.1) * W)));
/** Typed fine ratio (below 0.05: 0.2 f^2) -> wheel value. */
const fromFine = (r: number) => {
  if (r >= 0.05) {
    const k = r < 0.29 ? 4 : r < 0.42 ? 5 : r < 0.58 ? 6 : r < 0.71 ? 7 : 8;
    return Math.min(W, Math.round((k / 8.9) * W));
  }
  return Math.round(Math.sqrt(Math.max(0, r) / 0.2) * W);
};
const fromThru = (t: number) => Math.min(W, Math.round(Math.sqrt(Math.max(0, t) / 25) * W));

const wheel = (key: string, name: string, index: number, def: number, format = pct, parse: (t: number) => number = fromPct): GenParamDef =>
  ({ key, name, index, min: 0, max: W, def, format, parse });

export const DX10_KEYS = [
  'attack', 'decay', 'release', 'mod1Coarse', 'mod1Fine', 'mod1Init', 'mod1Decay', 'mod1Sustain', 'mod1Release', 'mod1Vel',
  'vibrato', 'waveform', 'modThru', 'lfoRate', 'mod2Coarse', 'mod2Fine', 'mod2Init', 'mod2Decay', 'mod2Sustain', 'mod2Release',
  'mod2Vel', 'octave',
] as const;

/** Values (parameters 0..21) -> state. */
function patch(v: readonly number[]): Record<string, number> {
  const p: Record<string, number> = {};
  DX10_KEYS.forEach((k, i) => { p[k] = v[i]; });
  return p;
}

/** FL's constructor state = the factory Default preset (mda DX10 program 0, "Bright E.Piano"). */
export const DX10_DEFAULT_PATCH: readonly number[] = [0, 42598, 28901, 55181, 21561, 15073, 52429, 3277, 52429, 58982, 0, 29295, 0, 27132, 0, 0, 0, 0, 0, 0, 0, 0];

/** FL's 59 factory presets (name, values of parameters 0..21), in the preset menu's order. */
const PRESETS: [string, number[]][] = [
  ['Bang Bass', [7424, 45875, 34079, 15073, 12911, 34079, 47186, 18350, 47841, 32768, 22272, 14340, 28049, 54528, 13568, 0, 29952, 37888, 9728, 40192, 37376, 0]],
  ['Bass Pluck', [0, 44032, 30464, 13742, 0, 8448, 6912, 0, 0, 18944, 0, 21928, 5177, 17408, 16384, 0, 16640, 36096, 0, 0, 14848, -1]],
  ['Bright E.Piano', [0, 42598, 28901, 55181, 21561, 15073, 52429, 3277, 52429, 58982, 0, 29295, 0, 27132, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Chiff Organ', [39322, 64881, 26214, 20972, 18547, 37356, 19661, 3277, 15729, 32768, 9044, 18547, 53871, 32768, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Chunky Bass', [0, 26214, 0, 18350, 8192, 31064, 16384, 6554, 32768, 32768, 0, 37945, 38797, 32768, 0, 0, 0, 0, 0, 0, 0, -1]],
  ['Clunk Bass', [0, 39322, 26214, 15073, 0, 29491, 20972, 3277, 58982, 32768, 0, 34079, 6881, 32768, 0, 0, 0, 0, 0, 0, 0, -2]],
  ['Default', [0, 42598, 28901, 55181, 21561, 15073, 52429, 3277, 52429, 58982, 0, 29295, 0, 27132, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['E.Bass', [15073, 32768, 6554, 25887, 0, 25428, 6029, 16384, 9830, 32768, 13107, 11665, 53871, 32768, 0, 0, 0, 0, 0, 0, 0, -2]],
  ['E.Piano Pad', [0, 45875, 26214, 15073, 12059, 17695, 31064, 14680, 52429, 63832, 16384, 28049, 54788, 32768, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Effect', [0, 44595, 24422, 0, 36237, 65112, 51589, 20251, 52429, 65536, 65536, 4776, 51540, 49832, 5, 34560, 54528, 8704, 19200, 19456, 65536, -1]],
  ['eFlute', [9327, 48753, 27847, 40, 0, 15360, 29655, 13396, 15821, 45285, 11520, 12800, 49611, 25344, 30, 0, 10496, 22016, 33024, 0, 20224, -1]],
  ['eThing', [2048, 25702, 35226, 7, 0, 6400, 27648, 42240, 22016, 10496, 0, 34560, 20021, 0, 3, 0, 22784, 20992, 60160, 30976, 20480, 2]],
  ['Faieries', [45056, 48742, 36581, 55437, 21817, 15073, 51405, 41677, 52429, 33382, 30976, 8047, 0, 27132, 57088, 16640, 20736, 31744, 7680, 29952, 49664, 0]],
  ['FM Sub', [0, 44032, 30464, 13742, 0, 8448, 0, 0, 0, 18944, 0, 15272, 5177, 17408, 16384, 0, 16640, 0, 0, 0, 14848, -1]],
  ['Funk Clav', [0, 26214, 6554, 23593, 0, 57344, 10486, 38797, 52429, 32768, 0, 19857, 56885, 32768, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Fuzzy E.Piano', [0, 45875, 26214, 20972, 14221, 39256, 43909, 20251, 52429, 32768, 17236, 18088, 41812, 34472, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Gill Bass 1', [0, 44902, 35301, 16905, 22073, 18145, 54528, 512, 52429, 51814, 0, 16640, 8192, 0, 15622, 0, 24320, 17408, 17152, 0, 37120, -1]],
  ['Gill Bass 2', [8192, 35635, 47206, 15629, 13312, 0, 24453, 11264, 26112, 32768, 0, 54016, 41812, 0, 16911, 0, 0, 0, 0, 0, 31744, -1]],
  ['Gill Bass 3', [0, 44902, 35301, 15625, 22073, 18145, 54528, 512, 52429, 51814, 0, 16640, 8192, 0, 16902, 0, 24320, 17408, 41216, 0, 37120, -1]],
  ['Gill Bass 4', [0, 42598, 28901, 15104, 12601, 15073, 52429, 7629, 52429, 35686, 0, 27759, 0, 27132, 16138, 14592, 24576, 20480, 11520, 0, 33536, -1]],
  ['Gill ClavishLead', [18350, 33649, 35758, 33806, 14336, 29696, 42240, 28160, 37376, 34304, 15104, 43661, 0, 32768, 33801, 14848, 43776, 55552, 17152, 39424, 0, 0]],
  ['Gill Frog', [18688, 22733, 33483, 15872, 65536, 0, 58778, 49553, 52705, 33280, 19968, 12032, 0, 26368, 38151, 0, 0, 40448, 30976, 47104, 20224, 0]],
  ['Gill RosRezz', [31744, 49920, 26880, 12299, 0, 21627, 31539, 14592, 45875, 32768, 0, 9896, 5177, 32768, 15629, 0, 24832, 51968, 51200, 32256, 28416, 0]],
  ['Gill Sweep', [0, 44902, 41957, 27145, 22073, 15073, 65536, 45517, 52429, 51814, 23808, 25600, 8192, 27132, 0, 0, 24320, 17408, 49920, 50688, 37120, -1]],
  ['Harmonics', [0, 32768, 32768, 18350, 0, 21627, 13107, 0, 45875, 32768, 0, 9896, 5177, 32768, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Harp', [0, 32768, 45875, 10486, 0, 10355, 22872, 0, 18350, 58982, 0, 26280, 0, 32768, 0, 0, 0, 0, 0, 0, 0, 1]],
  ['Harpsichord', [0, 22413, 0, 18350, 0, 57672, 6554, 26739, 48497, 0, 0, 55181, 42664, 32768, 0, 0, 0, 0, 0, 0, 0, 1]],
  ['Horn', [18350, 64881, 18350, 15073, 0, 11796, 26214, 19661, 52429, 32768, 0, 14221, 31457, 32768, 0, 0, 0, 0, 0, 0, 0, -1]],
  ['Jazz E.Piano', [0, 32768, 6554, 43975, 0, 28901, 22020, 15925, 52429, 32768, 0, 11665, 0, 32768, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Jazz Guitar', [0, 32768, 6554, 25559, 0, 32113, 16384, 16384, 52429, 32768, 0, 17236, 9503, 32768, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Koto', [0, 15729, 0, 25559, 0, 57672, 6554, 39322, 48497, 32768, 0, 34472, 31457, 32768, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Log Drum', [0, 19661, 32768, 20972, 0, 30605, 5177, 10355, 32768, 32768, 0, 9896, 1311, 32768, 0, 0, 0, 0, 0, 0, 0, -1]],
  ['MetalBass', [51311, 48753, 38855, 40, 0, 6912, 61143, 62804, 15821, 45285, 11520, 12800, 49611, 25344, 30, 0, 11776, 62464, 59904, 11776, 20224, -1]],
  ['Movie Swell', [0, 45875, 39782, 24044, 0, 0, 62085, 28160, 52429, 32768, 17748, 11008, 22356, 27304, 14080, 0, 17152, 65536, 43776, 62208, 0, 0]],
  ['mPiano', [24431, 48753, 27847, 40, 0, 18688, 21719, 47956, 52429, 20709, 0, 39680, 49611, 24832, 30, 0, 48128, 14080, 9216, 33280, 20224, 0]],
  ['Music Box', [0, 19661, 32768, 65536, 0, 30605, 5177, 10355, 32768, 32768, 0, 13312, 1311, 32768, 65536, 0, 57600, 44800, 0, 0, 0, 0]],
  ['Music Box 2', [0, 36045, 21248, 20972, 0, 34189, 7481, 10355, 32768, 32768, 0, 9896, 1311, 27132, 58112, 0, 59136, 1536, 0, 15104, 0, 0]],
  ['Overdrive Bass', [18432, 44032, 40960, 13742, 0, 12288, 65536, 0, 34304, 9216, 256, 35072, 5177, 17408, 16384, 0, 16640, 65536, 0, 34304, 7424, 0]],
  ['Plink', [0, 19661, 33227, 29921, 44513, 59392, 6554, 14225, 41953, 65536, 0, 0, 0, 32768, 0, 0, 0, 0, 0, 0, 0, 1]],
  ['Reed 1', [14418, 64881, 16384, 11141, 0, 15729, 20316, 16843, 58982, 49611, 0, 45679, 52625, 32768, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Reed 2', [14418, 64881, 16384, 29491, 4588, 15729, 20316, 23593, 58982, 32768, 13828, 12059, 0, 27132, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Robot', [65536, 56945, 47104, 6, 38144, 21248, 65536, 37972, 55757, 65536, 10381, 35381, 38347, 9388, 1, 52992, 37632, 65536, 35584, 37888, 52992, 1]],
  ['Scratch', [0, 32768, 0, 0, 15729, 38011, 41288, 0, 0, 32768, 0, 53477, 15925, 32768, 0, 0, 0, 0, 0, 0, 0, 1]],
  ['Shoot', [2048, 25702, 35226, 7, 0, 6400, 27648, 42240, 22016, 10496, 0, 34560, 51509, 0, 0, 1536, 18688, 34048, 60160, 30976, 20480, 2]],
  ['Sine Bass', [0, 39322, 32113, 11141, 9896, 6488, 26214, 0, 58982, 32768, 0, 7733, 852, 32768, 0, 0, 0, 0, 0, 0, 0, -1]],
  ['Sitar', [0, 32768, 46137, 15073, 0, 9896, 49152, 32309, 50463, 32768, 0, 27591, 41419, 32768, 0, 0, 0, 0, 0, 0, 0, -1]],
  ['Soft Chimes', [26214, 39322, 42598, 49807, 0, 25559, 16384, 10486, 58982, 32768, 23724, 26280, 19399, 32309, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Space Pad', [0, 45875, 34079, 15073, 12911, 34079, 47186, 18350, 47841, 32768, 16384, 22020, 28049, 32768, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['Spaceship', [45679, 64881, 27591, 2, 9044, 49152, 25559, 33620, 52429, 20709, 0, 0, 49611, 24832, 6, 59648, 32000, 65536, 0, 0, 62976, -3]],
  ['Square Bass', [0, 39322, 6554, 20972, 0, 22938, 43909, 6554, 9830, 32768, 0, 19857, 47841, 32768, 0, 0, 0, 0, 0, 0, 0, -2]],
  ['Steel Drum', [0, 19661, 33227, 31457, 47841, 0, 6554, 19857, 47841, 65536, 0, 37945, 0, 32768, 0, 0, 0, 0, 0, 0, 0, 1]],
  ['Steel Guitar', [14336, 33137, 41216, 25559, 0, 57672, 12698, 26266, 48497, 32768, 6656, 50600, 31457, 32768, 52224, 14848, 65536, 36352, 36352, 47872, 0, 0]],
  ['Syn Tom', [0, 23265, 22938, 0, 6881, 0, 0, 13107, 32768, 32768, 0, 65536, 19399, 32768, 0, 0, 0, 0, 0, 0, 0, 1]],
  ['Thick Bass', [0, 39322, 26214, 11141, 9503, 19005, 22938, 6554, 58982, 32768, 0, 28901, 20251, 32768, 0, 0, 0, 0, 0, 0, 0, -1]],
  ['Tinkle', [0, 32768, 42598, 24117, 42664, 25887, 36045, 16843, 58982, 32768, 19661, 0, 27132, 32768, 0, 0, 0, 0, 0, 0, 0, 2]],
  ['Trumpet', [0, 64881, 6554, 15073, 0, 0, 13107, 29491, 52429, 0, 7340, 46596, 0, 26280, 0, 0, 0, 0, 0, 0, 0, 1]],
  ['Upright Bass 1', [19661, 32768, 26214, 18350, 0, 11796, 35389, 0, 45875, 32768, 0, 19399, 2163, 32768, 0, 0, 0, 0, 0, 0, 0, -1]],
  ['Upright Bass 2', [19661, 32768, 26214, 23593, 0, 30212, 4588, 4588, 45875, 32768, 0, 35783, 30605, 32768, 0, 0, 0, 0, 0, 0, 0, -1]],
  ['Violin', [45679, 64881, 27591, 15073, 9044, 49152, 25559, 33620, 52429, 20709, 30605, 48693, 49611, 31916, 0, 0, 0, 0, 0, 0, 0, 1]],
];

export const def: GenPluginDef = {
  id: 'dx10',
  name: 'DX10',
  category: 'Synth classic',
  notes: 'voices',
  ins: true,
  // FL's sampler processing inside the plugin applies the voice levels with its own
  // float32 pan law and slope-limited ramps (see the engine)
  levels: 'plugin',
  defPoly: 16,
  width: 536,
  height: 340,
  description: 'An FM synth with 2 modulators',
  params: [
    wheel('attack', 'Attack', 0, 0),
    wheel('decay', 'Decay', 1, 42598),
    wheel('release', 'Release', 2, 28901),
    wheel('mod1Coarse', 'Mod 1 Coarse', 3, 55706, coarseText, fromCoarse),
    wheel('mod1Fine', 'Mod 1 Fine', 4, 21561, fineText, fromFine),
    wheel('mod1Init', 'Mod 1 Init', 5, 15073),
    wheel('mod1Decay', 'Mod 1 Decay', 6, 52429),
    wheel('mod1Sustain', 'Mod 1 Sustain', 7, 3277),
    wheel('mod1Release', 'Mod 1 Release', 8, 52429),
    wheel('mod1Vel', 'Mod 1 Velocity', 9, 58982),
    wheel('vibrato', 'Vibrato', 10, 0),
    wheel('waveform', 'Waveform', 11, 29295),
    wheel('modThru', 'Mod Thru', 12, 0, thruText, fromThru),
    wheel('lfoRate', 'LFO Rate', 13, 27132),
    wheel('mod2Coarse', 'Mod 2 Coarse', 14, 55706, coarseText, fromCoarse),
    wheel('mod2Fine', 'Mod 2 Fine', 15, 21561, fineText, fromFine),
    wheel('mod2Init', 'Mod 2 Init', 16, 15073),
    wheel('mod2Decay', 'Mod 2 Decay', 17, 52429),
    wheel('mod2Sustain', 'Mod 2 Sustain', 18, 3277),
    wheel('mod2Release', 'Mod 2 Release', 19, 52429),
    wheel('mod2Vel', 'Mod 2 Velocity', 20, 58982),
    { key: 'octave', name: 'Coarse', index: 21, min: -3, max: 3, def: 0, bipolar: true, format: (v) => String(Math.round(v)).padStart(7), parse: (t) => Math.round(t) },
  ],
  // a fresh instance plays FL's constructor state (= the Default preset and the
  // plugin database's "Fruity DX10.fst")
  state: () => patch(DX10_DEFAULT_PATCH),
  // editor view: keyboard shown / hidden, its first visible white key
  viewState: ['keyboard', 'kbView'],
  presets: PRESETS.map(([name, v]): GenPreset => ({ name, params: patch(v) })),
};
