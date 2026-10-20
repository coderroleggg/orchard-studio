// Actions of the Dance plugin that the editor and the character window share
// (kept out of the components' modules so those keep Fast Refresh).

import { store } from '../../../../store';
import * as A from '../../../../store/actions';

/** Open the channel's settings window (FL: View settings), without closing it when it is already open. */
export function openSettings(slotId: string): void {
  const id = A.channelOfSlot(slotId);
  if (id === null) return;
  const win = store.ui.windows['chan:' + id];
  if (win?.open) A.focusWindow('chan:' + id);
  else A.openChannelSettings(id);
}

/** Show or hide the character (parameter 2 "Show window") as one undo step. */
export function setVisible(slotId: string, on: boolean): void {
  store.beginGesture('Show window');
  try { A.setFxParam(slotId, 'visible', on ? 1 : 0, 'Show window'); } finally { store.endGesture(); }
}
