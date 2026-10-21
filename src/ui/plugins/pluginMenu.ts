// Plugin picker menus: FL's plugin database categories, each listing its effects
// (or, for Patcher's Add plugin menu, its instruments).

import { fxCategories, fxInCategory } from '../../model/fx/registry';
import { genCategories, genInCategory } from '../../model/gen/registry';
import type { MenuItem } from '../widgets/ContextMenu';

export function fxPickerItems(onPick: (plugin: string) => void, current?: string): MenuItem[] {
  return fxCategories().map((cat) => ({
    label: cat,
    submenu: fxInCategory(cat).map((d) => ({ label: d.name, checked: d.id === current, radio: true, onClick: () => onPick(d.id) } as MenuItem)),
  }));
}

/**
 * Instruments Patcher can host, by FL's Generators folders: not the hidden ones,
 * the controllers without audio (their outputs would need parameter links) and
 * Patcher itself.
 */
export function genPickerItems(onPick: (plugin: string) => void): MenuItem[] {
  return genCategories()
    .map((cat) => ({
      label: cat,
      submenu: genInCategory(cat).filter((d) => !d.noAudio && d.id !== 'patcher').map((d) => ({ label: d.name, hint: d.description, onClick: () => onPick(d.id) } as MenuItem)),
    }))
    .filter((c) => c.submenu.length > 0);
}
