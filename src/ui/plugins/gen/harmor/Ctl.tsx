// Generic Harmor control: FL's form entry -> widget and binding (a part /
// global parameter by Tag, or a setting for FL's Tag -1 / negative controls).

import { memo, type ReactNode } from 'react';
import type { ControlProps } from '../../../widgets/control';
import { FORM, type FCtl } from './form';
import { RES_TYPE, SETTINGS, itemText, tagKey } from './bind';
import { editPart, settingControl, useHarmor, useKeyParam, type HarmorCtx } from './use';
import { HCheck, HCombo, HDblSwitch, HDigi, HMultiDigi, HSlider, HSwitch, HWheel, type WheelLook } from './widgets';
import { store } from '../../../../store';
import { partParamMenu } from './menus';

/** Double switch captions (FL draws two glyphs: DblSwitchPaint table 0x8ebfe0). */
const DBL: Record<string, [string, string]> = {
  PortaCurveBox: ['lin', 'log'],
  PortaVarTimeBox: ['fix', 'var'],
  GrittyModeBox: ['+', '×'],
};

/** Digit wheel texts of FL's GetText handlers (blank for "off" values). */
function digiText(n: string, v: number, fmt?: (v: number) => string): string | undefined {
  if (n === 'FatOrderSelect') return v === 1 ? '' : String(v);
  if (n === 'ChOrderSelect') return v === 0 ? '' : String(v);
  if (n === 'PartPitchDivSelect' || n === 'DetuningDivSelect') return String(v);
  return fmt ? fmt(v) : undefined;
}

/** ControlProps of a resonance type combo (FL stores Value + 100). */
function resTypeControl(h: HarmorCtx, name: string): ControlProps {
  const field = RES_TYPE[name];
  const raw = (h.hp as unknown as Record<string, number> | undefined)?.[field] ?? 100;
  const label = name === 'F1ResTypeSelect' ? 'Filter 1 resonance type' : 'Filter 2 resonance type';
  const items = FORM[name].items ?? [];
  return {
    value: Math.max(0, Math.min(11, raw - 100)), min: 0, max: 11, defaultValue: 0, step: 1, label,
    format: (v) => itemText(items, v),
    onBegin: () => store.beginGesture(label),
    onEnd: () => store.endGesture(),
    onChange: (v) => editPart(h.slotId, h.part, label, (hp) => { (hp as unknown as Record<string, number>)[field] = 100 + Math.round(v); }, h.linked),
  };
}

/** Bindings of an FL control (call unconditionally: both hooks run, the setting wins). */
export function useCtlProps(c: FCtl, format?: (v: number) => string): ControlProps {
  const h = useHarmor();
  const key = tagKey(c.tag, h.p);
  const other = key && h.linked && (c.tag ?? 0) < 10000 ? tagKey(c.tag, h.p === 'a' ? 'b' : 'a') : null;
  const extra = key && (c.tag ?? 0) < 10000 ? { extraMenu: partParamMenu(h.slotId, key) } : undefined;
  const pc = useKeyParam(key ?? `__${c.n}`, other, extra);
  if (RES_TYPE[c.n]) return resTypeControl(h, c.n);
  const s = SETTINGS[c.n];
  if (s) return settingControl(h, s, c.k === 'combo' || c.k === 'switch' ? (c.items ?? c.caps) : undefined, format);
  return pc;
}

/** An FL control of the form by component name. */
export const HCtl = memo(function HCtl({ n, look, caption, dim, items, glyph, format, color }: {
  n: string; look?: Partial<WheelLook>; caption?: string; dim?: boolean; items?: readonly string[]; glyph?: ReactNode;
  format?: (v: number) => string; color?: string;
}) {
  const c = FORM[n];
  const cp = useCtlProps(c, format);
  if (!c) return null;
  switch (c.k) {
    case 'wheel': return <HWheel ctl={c} cp={cp} dim={dim} look={look} />;
    case 'slider': return <HSlider ctl={c} cp={cp} />;
    case 'check': return <HCheck ctl={c} cp={cp} caption={caption} color={color} />;
    case 'combo': return <HCombo ctl={c} cp={cp} items={items} glyph={glyph} />;
    case 'switch': return <HSwitch ctl={c} cp={cp} />;
    case 'digi': return <HDigi ctl={c} cp={cp} text={digiText(c.n, Math.round(cp.value), cp.format)} />;
    case 'multidigi': return <HMultiDigi ctl={c} cp={cp} />;
    case 'button': return DBL[c.n] ? <HDblSwitch ctl={c} cp={cp} opts={DBL[c.n]} /> : null;
    default: return null;
  }
});
