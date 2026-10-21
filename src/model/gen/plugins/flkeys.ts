// FL Keys (FL: FL Keys, Plugin database > Generators > Misc): "a wavetable piano synth" (FL's plugin info),
// Image-Line's generalisation of Paul Kellett's mda Piano / ePiano: 15 parameters, a wavetable list (Grand
// Piano, mda Piano, Rhodes, Roto Organ) and a piano keyboard. A port of FL's engine (docs/research/gen/flkeys.md).
//
// From FL 2026: the editor form (SynthPanel 480 x 270; the 15 wheels' Tag = parameter index, Min / Max /
// DefaultValue), the test host's parameter list and value texts (every value of every parameter swept), the
// plugin info (generator, note input, voice params, DefPoly 32), the 9 factory presets (values decoded from
// the .fst state: version 1, the wavetable name as a short string, 15 int32 values) and the plugin database
// entry FL loads for a new instance (Grand Piano with the values of `state()` below).
//
// State: the 15 parameters by key (FL's control units), `wavetable` (a name of the engine's catalogue) and the
// pool samples of the user's imported FL data, one per wavetable (`sample...` keys, '' = the synthesized
// stand-in plays).

import type { GenParamDef, GenPluginDef } from '../types';
import { KEYS_CATALOG, KEYS_PARAM_KEYS, keysEntry } from '../../../engine/gen/plugins/flkeys/catalog';

/** Round half away from zero (Delphi's Round on the values FL shows). */
const ra = (x: number) => (x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5));
const pct = (v: number) => `${ra(v / 10)}%`;
const fromPct = (t: number) => t * 10;

const p = (index: number, name: string, min: number, max: number, def: number, format: (v: number) => string, parse?: (t: number) => number): GenParamDef =>
  ({ key: KEYS_PARAM_KEYS[index], name, index, min, max, def, format, parse, bipolar: min < 0 });

export const def: GenPluginDef = {
  id: 'flkeys',
  name: 'FL Keys',
  category: 'Misc',
  notes: 'voices',
  levels: 'plugin',
  defPoly: 32,
  width: 480,
  height: 270,
  description: 'A wavetable piano synth',
  params: [
    p(0, 'Decay', -1000, 1000, 0, (v) => (v === -1000 ? 'No decay (sustain)' : pct(v)), fromPct),
    p(1, 'Release', -1000, 1000, 0, pct, fromPct),
    p(2, 'Hardness', -1000, 1000, 0, pct, fromPct),
    p(3, 'Velocity to Hardness', -1000, 1000, 0, pct, fromPct),
    p(4, 'Muffle', 0, 1000, 784, (v) => `${ra(100 - v / 10)}%`, (t) => 1000 - t * 10),
    p(5, 'Velocity to Muffle', 0, 2000, 502, pct, fromPct),
    p(6, 'Velocity Sensitivity', -1000, 1000, 0, pct, fromPct),
    p(7, 'Stereo', 0, 2000, 1000, pct, fromPct),
    p(8, 'Tune', -1000, 1000, 0, (v) => `${ra(v / 10)} cents`, (t) => t * 10),
    p(9, 'Detune', 0, 500, 123, (v) => ((v * v) / 5000).toFixed(1), (t) => Math.round(Math.sqrt(Math.max(0, t) * 5000))),
    p(10, 'Stretch', -500, 500, 0, (v) => `${(v / 10).toFixed(1)} cents`, (t) => t * 10),
    p(11, 'Treble', -1000, 1000, 0, pct, fromPct),
    p(12, 'Pan/Tremolo', -1000, 1000, 0, (v) => (v === 0 ? 'Off' : `${ra(Math.abs(v) / 10)}% (${v < 0 ? 'pan' : 'tremelo'})`), (t) => t * 10),
    p(13, 'LFO Rate', 0, 65536, 0, (v) => `${Math.exp((9.22 * v) / 65536 - 4.61).toFixed(2)} Hz`,
      (t) => Math.round(((Math.log(Math.max(1e-6, t)) + 4.61) / 9.22) * 65536)),
    p(14, 'Overdrive', 0, 1000, 0, (v) => `${(v / 10).toFixed(1)}%`, (t) => t * 10),
  ],
  /** FL's plugin database entry: the state a new FL Keys has (Grand Piano). */
  state: () => ({
    decay: -1000, release: 250, hardness: 0, velHardness: -1000, muffle: 0, velMuffle: 1000, velSens: -500, stereo: 0,
    tune: 0, detune: 123, stretch: 0, treble: 0, panTrem: 0, lfoRate: 0, overdrive: 0,
    wavetable: 'Grand Piano',
    ...Object.fromEntries(KEYS_CATALOG.map((e) => [e.key, ''])),
  }),
  /** The imported FL data stays attached when a preset is loaded. */
  viewState: KEYS_CATALOG.map((e) => e.key),
  normalize: (s) => {
    const o: Record<string, unknown> = { ...s, wavetable: keysEntry(s.wavetable).name };
    for (const e of KEYS_CATALOG) if (typeof o[e.key] !== 'string') o[e.key] = '';
    return o;
  },
  presets: [
    ['Broken Piano', [-568, 680, -408, 552, 299, 1568, -648, 976, 26, 341, -500, 0, 0, 0, 0]],
    ['Compressed Piano', [760, -202, 246, -1000, 856, 662, -488, 998, 0, 0, 0, 0, 0, 0, 0]],
    ['Concert Piano', [296, 0, -232, -504, 280, 1328, -24, 1680, 0, 147, 160, 0, 0, 0, 0]],
    ['Dance Piano', [0, -584, 744, -1000, 1000, 0, -632, 448, 0, 0, 167, 0, 0, 0, 0]],
    ['Dark Piano', [0, 216, -1000, -1000, 0, 0, -280, 1344, 0, 164, 0, 0, 0, 0, 0]],
    ['Default', [0, 0, 0, -1000, 784, 502, -248, 1000, 0, 123, 0, 0, 0, 0, 0]],
    ['ePiano', [0, 0, 0, 0, 200, 1300, -500, 1000, 0, 123, -500, 0, -600, 42598, 0], 'Rhodes (mda ePiano)'],
    ['Plain Piano', [0, 0, 0, -1000, 736, 0, -312, 0, 0, 0, 0, 0, 0, 0, 0]],
    ['School Piano', [-100, 196, 252, -568, 603, 1248, -424, 662, 0, 193, 273, 0, 0, 0, 0]],
  ].map(([name, v, wt]) => ({
    name: name as string,
    params: { ...Object.fromEntries(KEYS_PARAM_KEYS.map((k, i) => [k, (v as number[])[i]])), wavetable: (wt as string | undefined) ?? 'mda Piano' },
  })),
};
