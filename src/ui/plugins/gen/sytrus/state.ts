// Sytrus editor state access: the `sy` blob (SyState, undoable edits through
// useFxEdit: one undo step per gesture), the view state `syView` (no undo) and
// ControlProps builders for non-automatable `sy` fields.

import type { Draft } from 'immer';
import { store } from '../../../../store';
import { useFxEdit, useFxState, useFxView } from '../../kit';
import type { ControlProps } from '../../../widgets/control';
import type { SyState } from '../../../../model/gen/plugins/sytrus/types';
import { defaultSyState } from '../../../../model/gen/plugins/sytrus/defaults';

export interface SyView {
  /** 0 MAIN, 1-6 operators, 7-9 filters, 10 FX. */
  page: number;
  /** Editor target (EnvTargetSelect index of the page's unit). */
  target: number;
  /** Articulator part (EnvSelect: 0 ENV, 1 LFO, 2-7 maps). */
  part: number;
  /** Matrix levels shown: 0 FM, 1 RM. */
  rf: number;
  /** FX page: 0-2 delays, 3 reverb. */
  delNum: number;
  eqSel: number;
  /** First harmonic shown by the harmonics editor. */
  harm: number;
}

const DEF_VIEW: SyView = { page: 0, target: 0, part: 0, rf: 0, delNum: 0, eqSel: 0, harm: 0 };
let fallback: SyState | null = null;

/** The plugin's `sy` state (normalised by the def). */
export function useSy(): SyState {
  const sy = useFxState<SyState | undefined>('sy', undefined);
  return sy ?? (fallback ??= defaultSyState());
}

export function useSyView(): [SyView, (patch: Partial<SyView>) => void] {
  const raw = useFxState<Partial<SyView>>('syView', DEF_VIEW);
  const view = useFxView();
  const cur: SyView = { ...DEF_VIEW, ...raw };
  const set = (patch: Partial<SyView>) => view('Sytrus view', (p) => {
    const old = (p.syView ?? {}) as Partial<SyView>;
    p.syView = { ...DEF_VIEW, ...old, ...patch };
  });
  return [cur, set];
}

export type SyEdit = (label: string, recipe: (sy: Draft<SyState>) => void, mergeKey?: string) => void;

/** Undoable edit of `sy` (inside store.beginGesture / endGesture the edits of a gesture form one step). */
export function useSyEdit(): SyEdit {
  const edit = useFxEdit();
  return (label, recipe, mergeKey) => edit(label, (p) => {
    if (!p.sy) p.sy = defaultSyState() as unknown as Draft<Record<string, unknown>>;
    recipe(p.sy as unknown as Draft<SyState>);
  }, mergeKey);
}

export interface SyNumSpec {
  label: string;
  min: number;
  max: number;
  def: number;
  step?: number;
  format?: (v: number) => string;
  parse?: (typed: number) => number;
  travel?: number;
}

/** ControlProps for a numeric `sy` field (knobs, sliders, digit wheels). */
export function syControl(edit: SyEdit, value: number, spec: SyNumSpec, put: (sy: Draft<SyState>, v: number) => void): ControlProps {
  return {
    value,
    min: spec.min,
    max: spec.max,
    defaultValue: spec.def,
    step: spec.step ?? 1,
    label: spec.label,
    format: spec.format,
    parse: spec.parse,
    // no `travel` key unless given: the controls supply their own (slider length, digit wheel range)
    ...(spec.travel !== undefined ? { travel: spec.travel } : {}),
    onChange: (v) => edit(spec.label, (sy) => put(sy, Math.round(Math.max(spec.min, Math.min(spec.max, v))))),
    onBegin: () => store.beginGesture(spec.label),
    onEnd: () => store.endGesture(),
  };
}
