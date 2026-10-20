// Patcher (FL: Patcher, effect slot): a modular host. Its "Map" tab holds any
// number of effect modules wired between "From FL Studio" and "To FL Studio";
// each module keeps its own plugin state inside the Patcher state.
// Form: SynthPanel 1001 x 591 (TopWP 30 px: options menu, Map / Surface tabs,
// minimap button and the Audio / Parameters / Events link filters).
// FL's Patcher exposes up to 4096 dynamic parameters (activated module
// controls and surface controls); this clone has none of its own: hosted
// module parameters are edited through the modules' editors and automated at
// their own paths (params.$graph.modules.<id>.params.<key>).

import type { FxPluginDef } from '../types';
import { GRAPH_KEY, defaultGraph, normalizeGraph } from './patcher/graph';

export * from './patcher/graph';

export const def: FxPluginDef = {
  id: 'patcher',
  name: 'Patcher',
  category: 'Patcher',
  width: 1001,
  height: 591,
  description: 'Chain effects into a modular patch',
  params: [],
  state: () => ({ [GRAPH_KEY]: defaultGraph() }),
  normalize: (p) => ({ ...p, [GRAPH_KEY]: normalizeGraph(p[GRAPH_KEY]) }),
};
