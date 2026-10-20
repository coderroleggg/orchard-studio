// BooBass (FL: BooBass, Plugin database > Generators > Misc): "a monophonic,
// realistic bass generator with adjustable frequency response and supports
// portamento slides" (FL's manual), by David Billen. A port of FL's C++
// engine (docs/research/gen/boobass.md).
//
// From FL 2026: the editor form (SynthPanel 340 x 150; BassWheel Tag 0,
// MidWheel Tag 1, TrebleWheel Tag 2, all 0..65535, default 32767), the test
// host's parameter list ("Bass", "Mid", "Treble", value text = round(v /
// 65535 x 100) "%", swept over all 65536 values), the plugin info (generator,
// note input, no factory presets, DefPoly 0). A fresh instance plays the
// form's defaults (FL pushes 32767 to the engine at load: measured).
//
// `dataSample`: the sample pool id of FL's own BooBass recordings imported
// from the user's FL install (empty: the synthesized substitutes play).

import type { GenPluginDef } from '../types';

const pct = (v: number) => `${Math.round((v / 65535) * 100)}%`;
const fromPct = (typed: number) => Math.round((typed / 100) * 65535);

export const def: GenPluginDef = {
  id: 'boobass',
  name: 'BooBass',
  category: 'Misc',
  notes: 'voices',
  levels: 'plugin',
  defPoly: 0,
  width: 340,
  height: 150,
  description: 'Monophonic bass guitar generator',
  params: [
    { key: 'bass', name: 'Bass', index: 0, min: 0, max: 65535, def: 32767, format: pct, parse: fromPct },
    { key: 'mid', name: 'Mid', index: 1, min: 0, max: 65535, def: 32767, format: pct, parse: fromPct },
    { key: 'treble', name: 'Treble', index: 2, min: 0, max: 65535, def: 32767, format: pct, parse: fromPct },
  ],
  state: () => ({ dataSample: '' }),
  normalize: (p) => ({ ...p, dataSample: typeof p.dataSample === 'string' ? p.dataSample : '' }),
  presets: [],
};
