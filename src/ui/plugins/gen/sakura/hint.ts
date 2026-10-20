// The editor's own hint display (FL's HintLabel, top centre): the name and value text of the control
// under the mouse or being dragged, "---" otherwise. A tiny external store so hovering never
// re-renders the editor; only the display subscribes.

import { useSyncExternalStore } from 'react';

export interface SkHint { name: string; text: string }

let cur: SkHint | null = null;
let owner = 0;
const subs = new Set<() => void>();
const emit = (): void => { for (const f of subs) f(); };

/** Show `name` / `text` for control `id` (the control last touched wins). */
export function showHint(id: number, name: string, text: string): void {
  if (owner === id && cur && cur.name === name && cur.text === text) return;
  owner = id;
  cur = { name, text };
  emit();
}

/** The control `id` no longer shows a hint (ignored when another control has taken the display). */
export function dropHint(id: number): void {
  if (owner !== id || !cur) return;
  owner = 0;
  cur = null;
  emit();
}

export function useSkHint(): SkHint | null {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; },
    () => cur,
    () => null,
  );
}
