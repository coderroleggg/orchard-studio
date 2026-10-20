// A plugin's auxiliary window (FL's detached displays: Wave Candy's display,
// ZGameEditor Visualizer's video window), kept in the window store as
// `fxaux:<slot id>` and rendered by the plugin's Persistent component.

import { useEffect, useRef } from 'react';
import { store, useUi } from '../../../store';
import * as A from '../../../store/actions';
import type { WindowState } from '../../../store/ui';

/**
 * Keeps the window `fxaux:<slotId>` open while `want` holds (the plugin state
 * decides), reports a close from elsewhere (F12, the close window key) through
 * `closedElsewhere`, and drops the window once the slot no longer holds
 * `plugin`. `init` gives the window's title and rect when it opens. Returns
 * whether the window is open.
 */
export function useAuxWindow(slotId: string, plugin: string, want: boolean, init: () => Partial<WindowState>, closedElsewhere: () => void): boolean {
  const id = `fxaux:${slotId}`;
  const open = useUi((u) => !!u.windows[id]?.open);
  const wantRef = useRef(want);
  wantRef.current = want;
  useEffect(() => {
    const isOpen = !!store.ui.windows[id]?.open;
    if (want && !isOpen) A.openWindow(id, init());
    else if (!want && isOpen) A.closeWindow(id);
  }, [want]);
  const prev = useRef(open);
  useEffect(() => {
    if (prev.current && !open && wantRef.current) closedElsewhere();
    prev.current = open;
  }, [open]);
  useEffect(() => () => {
    setTimeout(() => {
      if (A.findFx(store.project, slotId)?.fx.plugin !== plugin) A.setUi((u) => { delete u.windows[id]; if (u.focused === id) u.focused = null; });
    }, 0);
  }, []);
  return open;
}
