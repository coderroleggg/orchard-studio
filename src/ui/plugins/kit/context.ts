// Editor context: which plugin an editor edits (an effect slot, a module
// hosted in Patcher, or a channel's instrument plugin), and parameter binding.

import { createContext, useContext } from 'react';
import { store } from '../../../store';
import { editFx, setFxParam, setFxStateNoHistory } from '../../../store/actions';
import type { Draft } from 'immer';
import { clampParam, formatParam, fxDef, fxParamDef } from '../../../model/fx/registry';
import { genDef, genParamDef } from '../../../model/gen/registry';
import { channelOfSlot } from '../../../model/gen/ids';
import { pluginTargetOf } from '../../../model/fx/hosted';
import type { FxParamDef } from '../../../model/fx/types';
import type { ControlProps } from '../../widgets/control';

export interface FxEditorCtx {
  /**
   * The edited plugin: a mixer slot id, "<slot>#<module>" for a module hosted
   * in Patcher, or "ch:<channel id>" for a channel's instrument plugin.
   */
  slotId: string;
  plugin: string;
  /** The plugin's current state (params object). */
  params: Record<string, unknown>;
  /** "Insert 3" etc. for effects, the channel name for instruments (automation clip names). */
  trackName: string;
  /** Plugin display name. */
  pluginName: string;
}

export const FxEditorContext = createContext<FxEditorCtx | null>(null);

export function useFxEditor(): FxEditorCtx {
  const c = useContext(FxEditorContext);
  if (!c) throw new Error('FX editor control used outside an FxEditorContext');
  return c;
}

export interface BoundParam {
  def: FxParamDef;
  value: number;
  /** ControlProps for knobs, sliders and spinners (undo gesture, automation, value text). */
  control: ControlProps;
  set(v: number): void;
}

/** The edited plugin's definition (an instrument's for "ch:<channel id>" editors). */
export function pluginDefOf(c: FxEditorCtx) {
  return channelOfSlot(c.slotId) !== null ? genDef(c.plugin) : fxDef(c.plugin);
}

/** A parameter definition of the edited plugin. */
export function paramDefOf(c: FxEditorCtx, key: string): FxParamDef | undefined {
  return channelOfSlot(c.slotId) !== null ? genParamDef(c.plugin, key) : fxParamDef(c.plugin, key);
}

/**
 * FL's name of a parameter in automation clips and the Remote control dialog:
 * "<plugin> (<mixer track>) - <parameter>" for effects, "<channel> - <parameter>"
 * for instruments.
 */
export function paramLabel(c: FxEditorCtx, name: string): string {
  return channelOfSlot(c.slotId) !== null ? `${c.trackName} - ${name}` : `${c.pluginName} (${c.trackName}) - ${name}`;
}

/** Bind a control to plugin parameter `key` of the edited slot. */
export function useParam(key: string, overrides?: Partial<ControlProps>): BoundParam {
  const c = useFxEditor();
  const def = paramDefOf(c, key) ?? { key, name: key, min: 0, max: 1, def: 0 };
  const raw = c.params[key];
  const value = typeof raw === 'number' ? raw : typeof raw === 'boolean' ? (raw ? 1 : 0) : def.def;
  const set = (v: number) => setFxParam(c.slotId, key, clampParam(def, v));
  const control: ControlProps = {
    value,
    min: def.min,
    max: def.max,
    defaultValue: def.def,
    step: def.step ?? 1,
    label: def.name,
    format: (v) => formatParam(def, v, c.params),
    parse: def.parse,
    onChange: set,
    onBegin: () => store.beginGesture(def.name),
    onEnd: () => store.endGesture(),
    auto: def.noAuto ? undefined : {
      ...pluginTargetOf(c.slotId, key),
      label: paramLabel(c, def.name),
      min: def.min, max: def.max, step: def.step ?? 1,
    },
    ...overrides,
  };
  return { def, value, control, set };
}

/**
 * Undoable edit of the edited params object (the slot's, or a hosted
 * module's). Edits sharing a merge key within 1.5 s form one undo step.
 */
export function useFxEdit(): (label: string, recipe: (p: Draft<Record<string, unknown>>) => void, mergeKey?: string) => void {
  const { slotId } = useFxEditor();
  return (label, recipe, mergeKey) => editFx(slotId, label, recipe, mergeKey);
}

/** Write view state (selected page, tab, scroll) without an undo entry. */
export function useFxView(): (label: string, recipe: (p: Draft<Record<string, unknown>>) => void) => void {
  const { slotId } = useFxEditor();
  return (label, recipe) => setFxStateNoHistory(slotId, label, recipe);
}

/** Read a non-parameter state field of the edited slot. */
export function useFxState<T>(key: string, fallback: T): T {
  const c = useFxEditor();
  const v = c.params[key];
  return (v === undefined ? fallback : v) as T;
}
