// Harmor editor state access: the displayed part, view state, settings
// edits (undoable, one step per gesture) and parameter bindings that follow
// FL's "GUI-link parts" switch (a part control edits both parts while on).

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { clampParam, formatParam } from '../../../../model/fx/registry';
import { genParamDef } from '../../../../model/gen/registry';
import type { HGlobal, HPart, HView } from '../../../../model/gen/plugins/harmor/types';
import type { PartId } from '../../../../model/gen/plugins/harmor/params';
import type { ControlProps } from '../../../widgets/control';
import { useFxEditor, useParam } from '../../kit';
import { SETTINGS, partId, tagKey, viewOf, itemText, type SettingBind } from './bind';
import type { FCtl } from './form';

export interface HarmorCtx {
  slotId: string;
  params: Record<string, unknown>;
  view: HView;
  /** Displayed part: 0 = A, 1 = B. */
  part: number;
  p: PartId;
  hp: HPart;
  hg: HGlobal;
  linked: boolean;
}

/** The editor's Harmor state (current part, view, part / global settings). */
export function useHarmor(): HarmorCtx {
  const c = useFxEditor();
  const params = c.params;
  const view = viewOf(params);
  const p = partId(view.part);
  const hp = (p === 'a' ? params.hA : params.hB) as HPart;
  const hg = params.hG as HGlobal;
  return { slotId: c.slotId, params, view, part: view.part, p, hp, hg, linked: !!hg?.linkParts };
}

/** Write view state (no undo entry). */
export function setView(slotId: string, label: string, patch: Partial<HView>): void {
  A.setFxStateNoHistory(slotId, label, (d) => {
    const v = (d.hView ?? (d.hView = {})) as Record<string, number>;
    Object.assign(v, patch);
  });
}

/** Undoable edit of a part setting (both parts while linked when `follow`). */
export function editPart(slotId: string, part: number, label: string, recipe: (hp: HPart) => void, linked = false): void {
  A.editFx(slotId, label, (d) => {
    const parts = linked ? ['hA', 'hB'] : [part === 1 ? 'hB' : 'hA'];
    for (const k of parts) {
      const hp = d[k] as unknown as HPart | undefined;
      if (hp) recipe(hp);
    }
  });
}

export function editGlobal(slotId: string, label: string, recipe: (hg: HGlobal) => void): void {
  A.editFx(slotId, label, (d) => {
    const hg = d.hG as unknown as HGlobal | undefined;
    if (hg) recipe(hg);
  });
}

/** ControlProps of a setting (FL's Tag -1 / negative controls). */
export function settingControl(h: HarmorCtx, s: SettingBind, items?: readonly string[], format?: (v: number) => string): ControlProps {
  const src = (s.scope === 'part' ? h.hp : h.hg) as unknown as Record<string, number> | undefined;
  const raw = src?.[s.field];
  const scale = s.scale ?? 1;
  const value = typeof raw === 'number' ? Math.round(raw / scale) : s.def;
  return {
    value, min: s.min, max: s.max, defaultValue: s.def, step: 1, label: s.label,
    format: format ?? (items ? (v) => itemText(items, v) : undefined),
    onBegin: () => store.beginGesture(s.label),
    onEnd: () => store.endGesture(),
    onChange: (v) => {
      const x = Math.min(s.max, Math.max(s.min, Math.round(v))) * scale;
      if (s.scope === 'part') editPart(h.slotId, h.part, s.label, (hp) => { (hp as unknown as Record<string, number>)[s.field] = x; }, h.linked);
      else editGlobal(h.slotId, s.label, (hg) => { (hg as unknown as Record<string, number>)[s.field] = x; });
    },
  };
}

/** useSetting: the ControlProps of FL component `name` (bind.ts SETTINGS). */
export function useSetting(name: string, items?: readonly string[], format?: (v: number) => string): ControlProps {
  const h = useHarmor();
  const s = SETTINGS[name];
  if (!s) throw new Error(`Harmor: no setting for ${name}`);
  return settingControl(h, s, items, format);
}

/**
 * The parameter of an FL control (Tag 0..94 part parameter of the displayed
 * part, 10000 + i / 20000 + i globals). Part controls mirror to the other
 * part while "GUI-link parts" is on.
 */
export function useTagParam(ctl: FCtl, over?: Partial<ControlProps>): ControlProps {
  const h = useHarmor();
  const key = tagKey(ctl.tag, h.p) ?? `__missing_${ctl.n}`;
  const other = h.linked && ctl.tag !== undefined && ctl.tag < 10000 ? tagKey(ctl.tag, h.p === 'a' ? 'b' : 'a') : null;
  return useKeyParam(key, other, over);
}

/** A parameter by key, mirrored to `other` when given. */
export function useKeyParam(key: string, other: string | null, over?: Partial<ControlProps>): ControlProps {
  const { slotId, plugin, params } = useFxEditor();
  const b = useParam(key, over);
  if (!other) return b.control;
  const odef = genParamDef(plugin, other);
  return {
    ...b.control,
    onChange: (v) => {
      b.control.onChange(v);
      if (odef) A.setFxParam(slotId, other, clampParam(odef, v));
    },
    format: (v) => formatParam(b.def, v, params),
  };
}
