// Plugin picker menus: FL's plugin database categories, each listing its effects.

import { fxCategories, fxInCategory } from '../../model/fx/registry';
import type { MenuItem } from '../widgets/ContextMenu';

export function fxPickerItems(onPick: (plugin: string) => void, current?: string): MenuItem[] {
  return fxCategories().map((cat) => ({
    label: cat,
    submenu: fxInCategory(cat).map((d) => ({ label: d.name, checked: d.id === current, radio: true, onClick: () => onPick(d.id) } as MenuItem)),
  }));
}
