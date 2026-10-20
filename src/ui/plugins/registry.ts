// Effect editor registry: every module in ./fx (file or folder with index.tsx)
// exports `editor: FxEditorModule`. Plugins without one get the generic editor.

import type { ComponentType } from 'react';
import type { MenuItem } from '../widgets/ContextMenu';

export interface FxEditorModule {
  id: string;
  /** The editor surface; reads its slot from FxEditorContext (see kit/context.ts). */
  Editor: ComponentType;
  /** Extra items for the plugin window's menu (FL's plugin options menu). */
  menu?: (slotId: string) => MenuItem[];
  /**
   * Panel size for the current state, when the editor grows or shrinks with
   * its state (FL: Vintage Phaser's advanced strip); the plugin window follows
   * it. Default: the def's width x height.
   */
  size?: (params: Record<string, unknown>) => { w: number; h: number };
  /**
   * Rendered for every slot holding this plugin, whether or not its editor
   * window is open (FL's detached displays: Wave Candy's display window,
   * ZGameEditor Visualizer's video window). Reads its slot from
   * FxEditorContext like the editor, and renders its own floating window(s),
   * e.g. a Window with id `fxaux:<slotId>`; it should render nothing while
   * that window is closed.
   */
  Persistent?: ComponentType;
}

export function persistentPlugins(): Set<string> {
  const ids = new Set<string>();
  for (const [id, m] of byId) if (m.Persistent) ids.add(id);
  return ids;
}

const mods = import.meta.glob<{ editor?: FxEditorModule }>(['./fx/*.tsx', './fx/*/index.tsx'], { eager: true });

const byId = new Map<string, FxEditorModule>();
for (const m of Object.values(mods)) if (m.editor) byId.set(m.editor.id, m.editor);

export function editorFor(plugin: string): FxEditorModule | undefined {
  return byId.get(plugin);
}
