// Parametric EQ 2 (FL: Fruity Parametric EQ 2). Its state is the structured
// PEQ2Params (bands, options, spare bank); automation addresses the fields by
// path (params.bands.3.level ...), so no flat parameter list is declared here.

import type { FxPluginDef } from '../types';
import { defaultPEQ2, normalizePEQ2, type PEQ2Params } from '../../peq2';

export const def: FxPluginDef = {
  id: 'peq2',
  name: 'Parametric EQ 2',
  category: 'Filter',
  width: 700,
  height: 350,
  params: [],
  state: () => defaultPEQ2() as unknown as Record<string, unknown>,
  normalize: (p) => normalizePEQ2(p as Partial<PEQ2Params>) as unknown as Record<string, unknown>,
  description: '7-band parametric equalizer with spectrum analyzer',
};
