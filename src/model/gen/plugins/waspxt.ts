// Wasp XT (FL: Wasp XT, not in FL's plugin database): FL's bundle describes it as Wasp's
// three-oscillator subtractive synthesizer. FL 2026 only ships a 64-bit dummy of it, as Wasp:
// the same editor, silence and empty state. Legacy, so hidden from the menus. The definition
// keeps FL's 56 parameters as the host reports them (see ./dummy64/params.ts).
// See docs/research/gen/waspxt.md.

import type { GenPluginDef } from '../types';
import { dummy64Params } from './dummy64/params';

export const def: GenPluginDef = {
  id: 'waspxt',
  name: 'Wasp XT',
  category: 'Synth classic',
  hidden: true,
  notes: 'voices',
  defPoly: 4,
  width: 356,
  height: 201,
  description: 'Legacy three-oscillator synthesizer: a 64-bit dummy in FL 2026 (silent)',
  params: dummy64Params(56),
};
