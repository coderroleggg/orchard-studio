// FL Slayer (FL: FL Slayer, not in FL's plugin database): Image-Line's guitar and bass
// synthesizer. FL 2026 only ships a 64-bit dummy of it (the same code as Wasp: the editor says
// the plugin has no 64-bit version, it renders silence and keeps no state). Legacy, so hidden
// from the menus. The definition keeps FL's 29 parameters as the host reports them (see
// ./dummy64/params.ts). See docs/research/gen/flslayer.md.

import type { GenPluginDef } from '../types';
import { dummy64Params } from './dummy64/params';

export const def: GenPluginDef = {
  id: 'flslayer',
  name: 'FL Slayer',
  category: 'Synth special',
  hidden: true,
  notes: 'voices',
  defPoly: 0,
  width: 356,
  height: 201,
  description: 'Legacy guitar and bass synthesizer: a 64-bit dummy in FL 2026 (silent)',
  params: dummy64Params(29),
};
