// Hint bar text: a tiny external store so hover updates never re-render the app.

import { useSyncExternalStore } from 'react';

let text = '';
let sticky = '';
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setHint(t: string): void {
  if (t === text) return;
  text = t;
  emit();
}

export function clearHint(): void {
  setHint('');
}

/** A message that stays until replaced by another hover hint (e.g. "Undo: Step edit"). */
export function flashHint(t: string): void {
  sticky = t;
  text = t;
  emit();
}

export function useHintText(): string {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => text || sticky,
  );
}

/** Props helper to attach a static hint to any element. */
export function hintProps(t: string): { onPointerEnter: () => void; onPointerLeave: () => void } {
  return {
    onPointerEnter: () => setHint(t),
    onPointerLeave: () => clearHint(),
  };
}
