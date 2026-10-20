// Plucked! (FL: Plucked!, Plugin database > Generators > Synth special): "an
// example of a physical modeling synth" (FL's manual), a Karplus-Strong
// plucked string by Didier Dambrin. A port of FL's plugin
// (docs/research/gen/plucked.md).
//
// From FL 2026: the editor form (SynthPanel 360 x 156; DecayWheel Tag 0
// 0..256 default 128, ColorWheel Tag 1 0..128 default 64, NormBtn Tag 2,
// GateBtn Tag 3, WidenBtn Tag 4: 0..1 switches), the test host's parameter
// list and value texts (Decay round(v / 256 x 100) "%", Color round(v / 128 x
// 100) "%", the switches an empty text; swept over every value), the plugin
// info (generator, GetChanCustomShape, note input, DefPoly 16). The only
// factory preset, Default.fst, and the plugin database's Plucked!.fst hold
// the constructor state (128, 64, 1, 0, 1).
//
// `sample`: the channel sample (a sample pool id) whose 16384-point shape FL
// hands the plugin as the excitation (FL: the channel's sample); '' = none.

import type { GenPluginDef } from '../types';

const pct = (range: number) => (v: number) => `${Math.round((v / range) * 100)}%`;
const fromPct = (range: number) => (typed: number) => Math.round((typed / 100) * range);
const blank = () => '';

export const def: GenPluginDef = {
  id: 'plucked',
  name: 'Plucked!',
  category: 'Synth special',
  notes: 'voices',
  levels: 'plugin',
  defPoly: 16,
  width: 360,
  height: 156,
  description: 'Karplus-Strong plucked string',
  params: [
    { key: 'decay', name: 'Decay', index: 0, min: 0, max: 256, def: 128, format: pct(256), parse: fromPct(256) },
    { key: 'color', name: 'Color', index: 1, min: 0, max: 128, def: 64, format: pct(128), parse: fromPct(128) },
    { key: 'norm', name: 'Normalize decay', index: 2, min: 0, max: 1, def: 1, format: blank },
    { key: 'gate', name: 'Short release', index: 3, min: 0, max: 1, def: 0, format: blank },
    { key: 'widen', name: 'Widen (stereo)', index: 4, min: 0, max: 1, def: 1, format: blank },
  ],
  state: () => ({ sample: '' }),
  normalize: (p) => ({ ...p, sample: typeof p.sample === 'string' ? p.sample : '' }),
  presets: [
    { name: 'Default', params: { decay: 128, color: 64, norm: 1, gate: 0, widen: 1 } },
  ],
};
