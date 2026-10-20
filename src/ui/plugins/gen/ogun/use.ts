// Ogun editor state access: the editor's slot, view state (no undo entry), settings (undoable, one step per gesture) and
// curve edits, and the parameter binding of FL's controls by Tag.

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { OGUN_PARAMS } from '../../../../model/gen/plugins/ogun/params';
import type { OgEnv } from '../../../../model/gen/plugins/ogun/types';
import type { ControlProps } from '../../../widgets/control';
import { useFxEditor } from '../../kit';
import type { FCtl } from './form';
import { MENU_SETTINGS, SETTINGS, missingKey, viewOf, type CurvePath, type OgView, type Params, type Setting } from './settings';

export interface OgunCtx {
  slotId: string;
  params: Params;
  view: OgView;
}

/** The editor's slot, state and view. */
export function useOgun(): OgunCtx {
  const c = useFxEditor();
  return { slotId: c.slotId, params: c.params, view: viewOf(c.params) };
}

/** FL parameter key of a control Tag (the parameter index), or null for a setting / label. */
const KEY_OF_TAG = new Map<number, string>(OGUN_PARAMS.map((p) => [p.index ?? -1, p.key]));
export function tagKey(tag: number | undefined): string | null {
  return tag !== undefined && tag >= 0 ? KEY_OF_TAG.get(tag) ?? null : null;
}

/** Write view state (no undo entry). */
export function setView(slotId: string, label: string, patch: Partial<OgView>): void {
  A.setFxStateNoHistory(slotId, label, (d) => {
    const v = (d.view ?? (d.view = {})) as Record<string, unknown>;
    Object.assign(v, patch);
  });
}

/** Undoable edit of the state (discrete edits: menus, buttons, curve edits). */
export function editState(slotId: string, label: string, recipe: (d: Params) => void, mergeKey?: string): void {
  A.editFx(slotId, label, (d) => recipe(d as Params), mergeKey);
}

/** ControlProps of a setting: value from the state, edits through one undo step per gesture. */
export function settingProps(slotId: string, p: Params, s: Setting, over?: Partial<ControlProps>): ControlProps {
  return {
    value: s.get(p), min: s.min, max: s.max, defaultValue: s.def, step: 1, label: s.label,
    onBegin: () => store.beginGesture(s.label),
    onEnd: () => store.endGesture(),
    onChange: (v) => A.editFx(slotId, s.label, (d) => s.set(d as Params, v)),
    ...over,
  };
}

/** Control definition shortcut: the FL form's DefaultValue wins over the setting's own default (alt-click resets to it). */
export function settingFor(slotId: string, p: Params, name: string, ctl?: FCtl, over?: Partial<ControlProps>): ControlProps {
  const s = SETTINGS[name];
  if (!s) throw new Error(`Ogun: no setting for ${name}`);
  return settingProps(slotId, p, s, { ...(ctl?.def !== undefined ? { defaultValue: ctl.def } : {}), ...over });
}

/** A menu item's switch / value setting. */
export function menuSetting(id: string): Setting {
  const s = MENU_SETTINGS[id];
  if (!s) throw new Error(`Ogun: no menu setting ${id}`);
  return s;
}

/** Set a menu setting (one undo step). */
export function setMenuSetting(slotId: string, id: string, v: number): void {
  const s = menuSetting(id);
  A.editFx(slotId, s.label, (d) => s.set(d as Params, v));
}

/** Read a curve of the state by path. */
export function curveAt(p: Params, path: CurvePath): OgEnv | undefined {
  if (path[0] === 'maps') return (p.maps as OgEnv[] | undefined)?.[path[1]];
  const art = (p.arts as Array<{ e: OgEnv; l: OgEnv; k: OgEnv[] }> | undefined)?.[path[1]];
  if (!art) return undefined;
  return path[2] === 'e' ? art.e : path[2] === 'l' ? art.l : art.k[path[3] ?? 0];
}

/** Write the curve at `path` (and drop its "FL content missing" mark: an edited curve is the user's). */
export function writeCurve(slotId: string, path: CurvePath, next: OgEnv, label: string): void {
  A.editFx(slotId, label, (d) => {
    const s = d as Params;
    if (path[0] === 'maps') {
      const maps = s.maps as OgEnv[] | undefined;
      if (maps) maps[path[1]] = next;
    } else {
      const art = (s.arts as Array<{ e: OgEnv; l: OgEnv; k: OgEnv[] }> | undefined)?.[path[1]];
      if (!art) return;
      if (path[2] === 'e') art.e = next;
      else if (path[2] === 'l') art.l = next;
      else art.k[path[3] ?? 0] = next;
    }
    const miss = s.missing as string[] | undefined;
    if (Array.isArray(miss)) {
      const i = miss.indexOf(missingKey(path));
      if (i >= 0) miss.splice(i, 1);
    }
  });
}
