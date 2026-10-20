// Sakura editor (FL: Sakura, SynthEditorForm 855 x 532): FL's layout at the form's coordinates (TVectorWheel
// knobs of 47 / 45 / 38 / 36 / 33 / 28 / 26 / 20 px, TVectorSlider slots and bars, TVectorCheckBox lamps,
// TSwitchSelector +/- levers, the TVectorDigiWheel windows, the TQuickCombo lists of the modulation matrix,
// the level meter, the centre-top hint display and the string / damper picture). FL draws its artwork from
// bitmaps: this is an original drawing in the plugin's crimson and silver colours (art.tsx, skin.tsx).
// Every FL parameter (form tags 0..77) is bound through the kit's useParam (undo, automation, FL's value
// texts); the editor-only settings (form tags 79..113: the eight modulation slots, the string 2 frequency
// ratio, the delay time sync and the transpose wheel) edit the state's `hidden` array with undoable edits
// (a drag is one undo step), as Sawer's editor does. The plugin menu has FL's (disabled) "Convert old presets".

import { FxPanel, useFxEdit, useFxEditor, useFxState } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { store } from '../../../../store';
import {
  SK_DELAY_SYNC, SK_HIDDEN_COUNT, SK_HIDDEN_DEFAULT, SK_MOD_DESTS, SK_MOD_SOURCES, SK_PARAM_KEYS, SK_S2_RATIOS, skFormat,
} from '../../../../model/gen/plugins/sakura/data';
import { Backdrop, HintDisplay, MeterNeedle, StringArt } from './art';
import {
  DIGI_S2, DIGI_SYNC, FORM_DEFAULT, H, HIDDEN_TRANSPOSE, HINT, KNOBS, MENU_BTN, SLIDERS, SLOTS, SLOT_COMBO, SLOT_KNOB, SLOT_NEG, TOGGLES,
  TRANSPOSE, W, octaveStored, storedOctave,
} from './layout';
import { ComboControl, DigiControl, KnobControl, LeverControl, PKnob, PSlider, PToggle, useHintFx } from './skin';
import './sakura.css';

// ------------------------------------------------------------------ editor-only settings (state `hidden`)
/** `hidden[i]` of the state with an undoable setter (edits to one setting within 1.5 s merge into one undo step). */
function useHidden(i: number): [number, (v: number, label: string) => void] {
  const edit = useFxEdit();
  const hid = useFxState<number[]>('hidden', SK_HIDDEN_DEFAULT);
  const raw = Number(hid[i]);
  const value = Number.isFinite(raw) ? raw : SK_HIDDEN_DEFAULT[i];
  const set = (v: number, label: string) => edit(label, (p) => {
    const h = Array.isArray(p.hidden) ? (p.hidden as number[]).slice() : SK_HIDDEN_DEFAULT.slice();
    while (h.length < SK_HIDDEN_COUNT) h.push(SK_HIDDEN_DEFAULT[h.length]);
    h[i] = v;
    p.hidden = h;
  }, `sk-hidden-${i}`);
  return [value, set];
}

interface HiddenSpec {
  name: string; min: number; max: number; step: number; def: number;
  /** stored value -> control value */
  from: (raw: number) => number;
  /** control value -> stored value */
  to: (v: number) => number;
  format: (v: number) => string;
  parse?: (typed: number) => number;
}

/** ControlProps of a hidden setting (not automatable: FL's OnNonAutoParamChange). */
function useHiddenControl(i: number, o: HiddenSpec): ControlProps {
  const [raw, set] = useHidden(i);
  return {
    value: o.from(raw), min: o.min, max: o.max, step: o.step, defaultValue: o.def, label: o.name,
    format: o.format, parse: o.parse,
    onChange: (v) => set(o.to(v), o.name),
    onBegin: () => store.beginGesture(o.name),
    onEnd: () => store.endGesture(),
  };
}

type Slot = (typeof SLOTS)[number];

/** ModAmountNKnob: the slot's amount, FL control units 0..256 (stored 0..1). */
function ModAmount({ slot }: { slot: Slot }) {
  const c = useHiddenControl(slot.amount, {
    name: HINT.amount(slot.slot), min: 0, max: 256, step: 1, def: FORM_DEFAULT.amount,
    from: (r) => r * 256, to: (v) => v / 256, format: (v) => skFormat(0, v),
  });
  return <KnobControl x={slot.knobX} y={SLOT_KNOB.y} w={SLOT_KNOB.w} skin="strip" control={c} />;
}

/** ModAmountNegNSwitch: the slot's phase (0 = "+", 1 = "-"). */
function ModPhase({ slot }: { slot: Slot }) {
  const [v, set] = useHidden(slot.phase);
  const on = v !== 0;
  return (
    <LeverControl x={slot.negX} y={SLOT_NEG.y} w={SLOT_NEG.w} h={SLOT_NEG.h} on={on} name={HINT.negative} text={skFormat(7, on ? 1 : 0)}
      onToggle={() => set(on ? 0 : 1, HINT.negative)} />
  );
}

/** ModSourceNCombo / ModDestNCombo. */
function ModCombo({ slot, field }: { slot: Slot; field: 'source' | 'dest' }) {
  const src = field === 'source';
  const [v, set] = useHidden(src ? slot.source : slot.dest);
  const items = src ? SK_MOD_SOURCES : SK_MOD_DESTS;
  const name = src ? HINT.source(slot.slot) : HINT.dest(slot.slot);
  const index = Math.min(items.length - 1, Math.max(0, Math.trunc(v)));
  return (
    <ComboControl x={slot.comboX} y={src ? SLOT_COMBO.srcY : SLOT_COMBO.dstY} w={SLOT_COMBO.w} h={SLOT_COMBO.h}
      items={items} index={index} name={name} onPick={(i) => set(i, name)} />
  );
}

/** String2FreqRatioDigiWheel / DelayTimeSyncDigiWheel. */
function Digi({ box, items, name, def }: { box: { x: number; y: number; w: number; h: number; index: number }; items: string[]; name: string; def: number }) {
  const c = useHiddenControl(box.index, {
    name, min: 0, max: items.length - 1, step: 1, def,
    from: (r) => Math.round(r), to: (v) => Math.round(v), format: (v) => items[Math.round(v)] ?? '', parse: (n) => n,
  });
  return <DigiControl x={box.x} y={box.y} w={box.w} h={box.h} control={c} items={items} />;
}

/**
 * StringTransposeKnob: -3..3 octaves. The setting is a float 0..1 whose octave shift is trunc(v * 6) - 3 (the
 * default 0.5 = 0): the wheel stores the middle of each octave's range so no rounding can change the shift.
 */
function Transpose() {
  const c = useHiddenControl(HIDDEN_TRANSPOSE, {
    name: HINT.transpose, min: -3, max: 3, step: 1, def: FORM_DEFAULT.transpose,
    from: storedOctave, to: octaveStored, format: (v) => (v > 0 ? `+${v}` : String(v)), parse: (n) => n,
  });
  return <KnobControl x={TRANSPOSE.x} y={TRANSPOSE.y} w={TRANSPOSE.w} h={TRANSPOSE.h} skin="chrome" ticks={7} control={c} />;
}

/** MenuBtn "Options": the plugin menu under the button. */
function OptionsButton() {
  const { slotId } = useFxEditor();
  const hint = useHintFx('Options', '', true);
  return (
    <div className="sk-ctl sk-menu" style={{ left: MENU_BTN.x, top: MENU_BTN.y, width: MENU_BTN.w, height: MENU_BTN.h }}
      onPointerEnter={hint.enter} onPointerLeave={hint.leave}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom + 2, menu(slotId));
      }}>
      <svg width={8} height={6} viewBox="0 0 8 6" style={{ display: 'block' }}><path d="M0.8 0.8 L4 5 L7.2 0.8 Z" fill="#cfd1da" /></svg>
    </div>
  );
}

function SakuraEditor() {
  return (
    <FxPanel width={W} height={H} className="sk-panel">
      <Backdrop />
      <StringArt />
      {KNOBS.map((k) => <PKnob key={k.tag} k={SK_PARAM_KEYS[k.tag]} x={k.x} y={k.y} w={k.w} h={k.h} skin={k.skin} />)}
      {SLIDERS.map((s) => <PSlider key={s.tag} k={SK_PARAM_KEYS[s.tag]} x={s.x} y={s.y} w={s.w} h={s.h} kind={s.kind} />)}
      {TOGGLES.map((t) => <PToggle key={t.tag} k={SK_PARAM_KEYS[t.tag]} x={t.x} y={t.y} w={t.w} h={t.h} kind={t.kind} />)}
      <Transpose />
      <Digi box={DIGI_S2} items={SK_S2_RATIOS} name={HINT.s2Ratio} def={FORM_DEFAULT.s2Ratio} />
      <Digi box={DIGI_SYNC} items={SK_DELAY_SYNC} name={HINT.delaySync} def={FORM_DEFAULT.delaySync} />
      {SLOTS.map((s) => (
        <div key={s.slot} style={{ display: 'contents' }}>
          <ModCombo slot={s} field="source" />
          <ModAmount slot={s} />
          <ModPhase slot={s} />
          <ModCombo slot={s} field="dest" />
        </div>
      ))}
      <HintDisplay />
      <MeterNeedle />
      <OptionsButton />
    </FxPanel>
  );
}

function menu(_slotId?: string): MenuItem[] {
  return [
    { label: 'Convert old presets', disabled: true, hint: 'FL converts presets of the old Sakura version here; Orchard reads every Sakura preset directly' },
  ];
}

export const editor: FxEditorModule = { id: 'sakura', Editor: SakuraEditor, menu };
