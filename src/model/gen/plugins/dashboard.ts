// Dashboard (FL: Dashboard, not in FL's plugin database): FL's user-definable dashboard, an internal
// controller plugin without audio (FPF_NoProcess). FL 2026 ships only a 64-bit dummy of it: the same
// dummy strings as FL Slayer, the "Dummy x64" window, and its own parameter list. It renders silence
// and sends no controller output. Legacy, so hidden from the menus. The definition keeps FL's 257
// parameters as the host reports them (see ./dummy64/params.ts). See docs/research/gen/dashboard.md.

import type { GenPluginDef } from '../types';
import { dummy64Params } from './dummy64/params';

export const def: GenPluginDef = {
  id: 'dashboard',
  name: 'Dashboard',
  category: 'Controller',
  hidden: true,
  notes: 'voices',
  noAudio: true,
  defPoly: 0,
  width: 356,
  height: 201,
  description: 'Legacy user-definable dashboard controller: a 64-bit dummy in FL 2026 (silent)',
  params: dummy64Params(257),
};
