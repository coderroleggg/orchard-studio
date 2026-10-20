// Slot state access for the Newtone / Newtime editors: reads the plugin
// state from the editor context and edits it through A.editFx (undoable) or
// A.setFxStateNoHistory (transport, view modes, renders). In the standalone
// gallery (no mixer slot) edits go to a local copy so the editor still works.

import { useCallback, useMemo, useState } from 'react';
import { produce, type Draft } from 'immer';
import * as A from '../../../../store/actions';
import { useFxEditor } from '../../kit';

export interface SlotState<T> {
  slotId: string;
  p: T;
  gallery: boolean;
  /** Undoable edit (one step; consecutive edits with the same mergeKey merge). */
  edit: (label: string, recipe: (d: Draft<T>) => void, mergeKey?: string) => void;
  /** Edit without an undo step. */
  quiet: (label: string, recipe: (d: Draft<T>) => void) => void;
}

export function useSlotState<T extends object>(): SlotState<T> {
  const ctx = useFxEditor();
  const gallery = ctx.slotId.startsWith('gallery:');
  const [local, setLocal] = useState<T | null>(null);
  const p = (gallery && local ? local : ctx.params) as unknown as T;
  const apply = useCallback((recipe: (d: Draft<T>) => void) => {
    setLocal((cur) => produce((cur ?? ctx.params) as T, recipe) as T);
  }, [ctx.params]);
  const edit = useCallback((label: string, recipe: (d: Draft<T>) => void, mergeKey?: string) => {
    if (gallery) { apply(recipe); return; }
    A.editFx(ctx.slotId, label, recipe as unknown as (d: Draft<Record<string, unknown>>) => void, mergeKey);
  }, [gallery, apply, ctx.slotId]);
  const quiet = useCallback((label: string, recipe: (d: Draft<T>) => void) => {
    if (gallery) { apply(recipe); return; }
    A.setFxStateNoHistory(ctx.slotId, label, recipe as unknown as (d: Draft<Record<string, unknown>>) => void);
  }, [gallery, apply, ctx.slotId]);
  return useMemo(() => ({ slotId: ctx.slotId, p, gallery, edit, quiet }), [ctx.slotId, p, gallery, edit, quiet]);
}
