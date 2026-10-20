// The Video Player's Options menu (FL's OptionsMenu: the arrow button and a
// right-click on the picture) and the control panel's height. Kept out of the
// component files so they stay Fast Refresh friendly.

import * as A from '../../../../store/actions';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { VP_TIME_MODES, timeModeLabel, type VpState } from '../../../../model/gen/plugins/videoplayer';
import type { VideoController } from './controller';

/** FL's control panel (OverlayPanel) height. */
export const PANEL_H = 100;

/** FL's Options menu (the arrow button / right-click on the picture): Enable audio, Dock control panel, Keep aspect ratio, Time display. */
export function optionsMenu(ctl: VideoController, s: VpState): MenuItem[] {
  const slotId = ctl.slotId;
  const set = (label: string, recipe: (p: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
  const view = (label: string, recipe: (p: Record<string, unknown>) => void) => A.setFxStateNoHistory(slotId, label, recipe);
  return [
    { label: 'Enable audio', checked: s.audio, onClick: () => set('Enable audio', (p) => { p.audio = !s.audio; }) },
    { label: 'Dock control panel', checked: s.dock, onClick: () => view('Dock control panel', (p) => { p.dock = !s.dock; }) },
    { label: 'Keep aspect ratio', checked: s.aspect, onClick: () => view('Keep aspect ratio', (p) => { p.aspect = !s.aspect; }) },
    {
      label: 'Time display',
      submenu: VP_TIME_MODES.map((m): MenuItem => ({
        label: timeModeLabel(m, s.fps), radio: true, checked: s.timeMode === m.tag,
        onClick: () => view('Time display', (p) => { p.timeMode = m.tag; }),
      })),
    },
  ];
}
