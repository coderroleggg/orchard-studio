// Patcher <-> store glue: graph edits, and the editor contexts of hosted
// modules. A hosted module's editor edits "<slot>#<module>": the store's slot
// actions (setFxParam, editFx, setFxStateNoHistory, findFx) resolve that id to
// the module inside Patcher's state (`params.$graph.modules.<id>.params`), as
// does display data (useFxMonitor -> Patcher's monitorHosted), so every editor
// works hosted without changes; automation targets go to the module's
// params inside the Patcher slot (fxTargetOf).

import type { Draft } from 'immer';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { findFx } from '../../../../store/actions';
import { GRAPH_KEY, normalizeGraph, type PatcherGraph, type PatcherModule } from '../../../../model/fx/plugins/patcher';
import { HOSTED_SEP } from '../../../../model/fx/hosted';
import type { FxEditorCtx } from '../../kit';

type State = Record<string, unknown>;

/** The current state and graph of a Patcher slot. */
export function patcherState(slotId: string): { params: State; graph: PatcherGraph } | null {
  const loc = findFx(store.project, slotId);
  if (!loc || loc.fx.plugin !== 'patcher') return null;
  const params = loc.fx.params as State;
  const graph = params[GRAPH_KEY] as PatcherGraph | undefined;
  return graph && typeof graph === 'object' && graph.modules ? { params, graph } : null;
}

/** Undoable graph edit. */
export function editGraph(slotId: string, label: string, recipe: (g: Draft<PatcherGraph>) => void, mergeKey?: string): void {
  A.editFx(slotId, label, (p) => {
    if (!p[GRAPH_KEY] || typeof p[GRAPH_KEY] !== 'object') p[GRAPH_KEY] = normalizeGraph(undefined);
    recipe(p[GRAPH_KEY] as Draft<PatcherGraph>);
  }, mergeKey);
}

/** Graph change without an undo entry (view options, focus). */
export function viewGraph(slotId: string, recipe: (g: Draft<PatcherGraph>) => void): void {
  A.setFxStateNoHistory(slotId, 'Patcher view', (p) => {
    const g = p[GRAPH_KEY] as Draft<PatcherGraph> | undefined;
    if (g && typeof g === 'object') recipe(g);
  });
}

/** Make a module the one whose display data Patcher's monitor() returns. No undo entry. */
export function focusModule(slotId: string, moduleId: string | null): void {
  const st = patcherState(slotId);
  if (!st || (st.graph.focus ?? null) === moduleId) return;
  viewGraph(slotId, (g) => { g.focus = moduleId && g.modules[moduleId] ? moduleId : null; });
}

/** Inert slot id for editors that must not write anywhere (node thumbnails). */
export function idleSlotId(slotId: string, moduleId: string): string {
  return `patcher-idle:${slotId}:${moduleId}`;
}

/**
 * The editor context of a hosted module: its plugin and state, edited through
 * its "<slot>#<module>" id. `live: false` (thumbnails) gives an inert id:
 * every write finds nothing and does nothing.
 */
export function hostedCtx(slotId: string, m: PatcherModule, trackName: string, live: boolean): FxEditorCtx {
  return {
    slotId: live ? `${slotId}${HOSTED_SEP}${m.id}` : idleSlotId(slotId, m.id),
    plugin: m.plugin, params: m.params, trackName, pluginName: m.name,
  };
}
