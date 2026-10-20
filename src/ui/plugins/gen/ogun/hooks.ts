// Extension point of the Ogun editor: the options menu's "Import FL content..." items call the registered hook with what the user wants
// to pick (FL's Ogun preset folder, or single .fst files). index.tsx registers flimport.ts; without a registered hook the item is disabled.

export type OgunImportHook = (slotId: string, mode: 'folder' | 'files') => void;

let importHook: OgunImportHook | null = null;
let importLabel = 'Import FL content...';

/** Register the "Import FL content..." handler (null removes it); `label` renames the menu item. */
export function setOgunImportHook(hook: OgunImportHook | null, label?: string): void {
  importHook = hook;
  if (label) importLabel = label;
}

export function ogunImportHook(): { hook: OgunImportHook | null; label: string } {
  return { hook: importHook, label: importLabel };
}
