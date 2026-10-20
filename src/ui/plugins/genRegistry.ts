// Instrument editor registry: every module in ./gen (a file, or a folder with
// index.tsx) exports `editor: FxEditorModule` (the effect editor module type,
// with `id` = the instrument plugin id). Instruments without one get the
// generic knob editor. Editors read their plugin from FxEditorContext with
// slotId "ch:<channel id>" (see docs/gen-framework.md).

import type { FxEditorModule } from './registry';

const mods = import.meta.glob<{ editor?: FxEditorModule }>(['./gen/*.tsx', './gen/*/index.tsx'], { eager: true });

const byId = new Map<string, FxEditorModule>();
for (const m of Object.values(mods)) if (m.editor) byId.set(m.editor.id, m.editor);

export function genEditorFor(plugin: string): FxEditorModule | undefined {
  return byId.get(plugin);
}

/** Instruments with a Persistent component (rendered for every channel holding them). */
export function persistentGenPlugins(): Set<string> {
  const ids = new Set<string>();
  for (const [id, m] of byId) if (m.Persistent) ids.add(id);
  return ids;
}
