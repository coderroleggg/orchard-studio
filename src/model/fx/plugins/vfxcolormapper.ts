// VFX Color Mapper (FL: VFX Color Mapper): a note-event filter used inside
// Patcher. Each of the 16 piano-roll note colour groups is sent to one of 16
// voice outputs ("Voice output" tab) and can be given another colour group
// ("Color" tab). Form: SynthPanel 319 x 230; 16 combos (Tags 0..15) reused by
// the two tabs. FL's parameter names (from the plugin, including FL's missing
// space): "Note color group 1to voice output" (0..15) and "Note color group
// 1to note color group" (16..31); defaults are the identity mapping.

import type { FxParamDef, FxPluginDef } from '../types';

export const COLOR_GROUPS = 16;

export const outKey = (i: number) => `out${i + 1}`;
export const colKey = (i: number) => `col${i + 1}`;

function params(): FxParamDef[] {
  const out: FxParamDef[] = [];
  for (let i = 0; i < COLOR_GROUPS; i++) {
    out.push({ key: outKey(i), name: `Note color group ${i + 1}to voice output`, index: i, min: 0, max: 15, def: i, format: (v) => `${i + 1} to ${Math.round(v) + 1}` });
  }
  for (let i = 0; i < COLOR_GROUPS; i++) {
    out.push({ key: colKey(i), name: `Note color group ${i + 1}to note color group`, index: 16 + i, min: 0, max: 15, def: i, format: (v) => `${i + 1} to ${Math.round(v) + 1}` });
  }
  return out;
}

export const def: FxPluginDef = {
  id: 'vfxcolormapper',
  name: 'VFX Color Mapper',
  category: 'Patcher',
  width: 319,
  height: 230,
  description: 'Route the 16 note colors to separate voice outputs (Patcher)',
  params: params(),
  state: () => ({ tab: 0 }),
};
