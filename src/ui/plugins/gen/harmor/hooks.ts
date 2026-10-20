// Extension point of the Harmor editor: the plugin menu's "Import FL content"
// items call the registered hook with what the user wants to pick (FL's Harmor
// preset folder, or single files). index.tsx registers flimport.ts; without a
// registered hook the items are disabled.

export type HarmorImportHook = (slotId: string, mode: 'folder' | 'files') => void;

let importHook: HarmorImportHook | null = null;
let importLabel = 'Import FL content';

/** Register the "Import FL content..." handler (null removes it); `label` renames the menu item. */
export function setHarmorImportHook(hook: HarmorImportHook | null, label?: string): void {
  importHook = hook;
  if (label) importLabel = label;
}

export function harmorImportHook(): { hook: HarmorImportHook | null; label: string } {
  return { hook: importHook, label: importLabel };
}
