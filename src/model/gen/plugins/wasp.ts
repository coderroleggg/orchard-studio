// Wasp (FL: Wasp, not in FL's plugin database): Image-Line's three-oscillator subtractive
// synthesizer. FL 2026 only ships a 64-bit dummy of it: the editor says the plugin has no
// 64-bit version, it renders silence, and it keeps no state. Legacy, so hidden from the menus.
// The definition keeps FL's 41 parameters as the host reports them (see ./dummy64/params.ts).
// See docs/research/gen/wasp.md.

import type { GenPluginDef } from '../types';
import { dummy64Params } from './dummy64/params';

export const def: GenPluginDef = {
  id: 'wasp',
  name: 'Wasp',
  category: 'Synth classic',
  hidden: true,
  notes: 'voices',
  defPoly: 4,
  width: 356,
  height: 201,
  description: 'Legacy three-oscillator synthesizer: a 64-bit dummy in FL 2026 (silent)',
  params: dummy64Params(41),
};
