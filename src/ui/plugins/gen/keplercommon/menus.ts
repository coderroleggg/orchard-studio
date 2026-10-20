// Kepler / Kepler Exo menus: FL's Options popup (the form's `Options` menu, items from the model's option tables), the wheel menu's
// "Set" submenu (the form's TimeSetMenu, note lengths for the tempo-synced LFO rates) and the Import FL content items.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { KEPLER_OPTIONS_MENU, keplerOptionsOf } from '../../../../model/gen/plugins/kepler/data';
import { KEPLEREXO_OPTIONS_MENU, keplerExoOptionsOf } from '../../../../model/gen/plugins/keplerexo/data';
import { EXO_THEME_MENU } from './skin';
import { forgetTables, pickTables, projectTables, reuseTables, usesTables } from './fldata';

/** The current state of an instrument slot ("ch:<id>"). */
export function slotParams(slotId: string): Record<string, unknown> {
  return (A.findFx(store.project, slotId)?.fx.params ?? {}) as Record<string, unknown>;
}

/** The Import FL content items (plugin window menu and the panel's Options menu). */
export function importItems(slotId: string, plugin: string): MenuItem[] {
  const using = usesTables(slotParams(slotId));
  const inProject = projectTables();
  return [
    {
      label: 'Import FL content...', hint: 'Pick engine.dylib from your FL Studio installation (Plugins/Fruity/Generators/Kepler or Kepler Exo) for FL\'s LFO sine and noise tables',
      onClick: () => pickTables(slotId, plugin),
    },
    ...(!using && inProject ? [{ label: 'Use FL content from this project', onClick: () => reuseTables(slotId) } as MenuItem] : []),
    { label: 'Use the stand-in LFO and noise', checked: !using, disabled: !using, onClick: () => forgetTables(slotId) },
  ];
}

/** Kepler's Options menu (FL: Quantize first arpeggiator step, Velocity to volume, Align sub oscillator phase, Chorus noise, Chorus noise gate, HQ mode). */
export function keplerOptionItems(slotId: string): MenuItem[] {
  const cur = keplerOptionsOf(slotParams(slotId));
  return KEPLER_OPTIONS_MENU.map((it): MenuItem => {
    if (it === '-') return { separator: true };
    return {
      label: it.label, checked: cur[it.key],
      onClick: () => A.editFx(slotId, it.label, (p) => { p[it.key] = !keplerOptionsOf(p)[it.key]; }),
    };
  });
}

export function keplerMenu(slotId: string): MenuItem[] {
  return [...keplerOptionItems(slotId), { separator: true }, ...importItems(slotId, 'Kepler')];
}

/** Kepler Exo's Options menu (FL: Arp 1st Step Quantize, HQ mode, Enhanced Oscillators, Theme). */
export function keplerExoOptionItems(slotId: string): MenuItem[] {
  const st = slotParams(slotId);
  const cur = keplerExoOptionsOf(st);
  const theme = typeof st.theme === 'number' ? Math.round(st.theme) : 0;
  const items = KEPLEREXO_OPTIONS_MENU.map((it): MenuItem => {
    if (it === '-') return { separator: true };
    return {
      label: it.label, checked: cur[it.key],
      onClick: () => A.editFx(slotId, it.label, (p) => { p[it.key] = !keplerExoOptionsOf(p)[it.key]; }),
    };
  });
  items.push({
    label: 'Theme',
    submenu: EXO_THEME_MENU.map((t): MenuItem => ({
      label: t.label, radio: true, checked: theme === t.value,
      onClick: () => A.setFxStateNoHistory(slotId, 'Theme', (p) => { p.theme = t.value; }),
    })),
  });
  return items;
}

export function keplerExoMenu(slotId: string): MenuItem[] {
  return [...keplerExoOptionItems(slotId), { separator: true }, ...importItems(slotId, 'Kepler Exo')];
}

// ------------------------------------------------------------------ wheel menu: Set (note lengths)
/** The form's TimeSetMenu: caption and the control value of the tempo-synced LFO rate (the items' Tag). */
export const SET_LENGTHS: [string, number][] = [
  ['1/64', 245760], ['1/32', 244216], ['1/16', 211373], ['1/8', 190725], ['1/4', 164762], ['1/2', 134931],
  ['1/16 dotted', 199737], ['1/8 dotted', 176098], ['1/4 dotted', 147681], ['1/2 dotted', 116283],
  ['1/16 triplet', 220695], ['1/8 triplet', 203210], ['1/4 triplet', 180324], ['1/2 triplet', 152664],
];

/** FL's wheel menu "Set" for a tempo-synced rate control `key` (added after Reset in the control's right-click menu). */
export function setLengthMenu(slotId: string, key: string): MenuItem[] {
  return [{
    label: 'Set',
    submenu: SET_LENGTHS.map(([label, v]): MenuItem => ({ label, onClick: () => A.setFxParam(slotId, key, v) })),
  }];
}
