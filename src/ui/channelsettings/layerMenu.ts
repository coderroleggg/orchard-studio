// FL's Layering menu: the arrow in the Layering panel's title (FL's LayerMenu in
// the main form), also offered by the layer's Channel rack menu and window
// options menu. Item names and hints are FL's.

import type { Channel } from '../../model/types';
import { store } from '../../store';
import * as A from '../../store/actions';
import type { MenuItem } from '../widgets/ContextMenu';

/**
 * Set children (FL's LayerSetBtnClick): the selected channels become the layer's
 * children. With no channel selected FL asks first ("No channel is selected.
 * This layer will then be linked to nothing."). Returns the number of children
 * set, or -1 when the question was answered No.
 */
export function pressSetChildren(layerId: string, ids: readonly string[] = store.ui.selectedChannels): number {
  const picked = store.project.channels.filter((c) => ids.includes(c.id) && c.kind !== 'layer').length;
  if (!picked && !confirm('No channel is selected. This layer will then be linked to nothing.')) return -1;
  return A.setLayerChildren(layerId, ids).length;
}

export function layerMenuItems(ch: Channel): MenuItem[] {
  const n = ch.layer?.children.length ?? 0;
  return [
    { label: 'Split children', hint: 'Assign one layer per key (starts at root note)', disabled: !n, onClick: () => A.splitLayerChildren(ch.id) },
    { label: 'Reset children', disabled: !n, onClick: () => A.resetLayerChildren(ch.id) },
    {
      label: 'Group children...', hint: 'Send children to a group', disabled: !n,
      onClick: () => { const name = prompt('Group name', ch.name); if (name !== null) A.groupLayerChildren(ch.id, name); },
    },
    {
      label: 'Delete children...', hint: 'Delete all children channels', disabled: !n,
      onClick: () => { if (confirm(`Delete the ${n} child channel${n === 1 ? '' : 's'} of ${ch.name}?`)) A.deleteLayerChildren(ch.id); },
    },
  ];
}
