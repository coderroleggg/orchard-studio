// Control Surface (FL: Control Surface): a user-built panel of controls
// (knobs, sliders, X/Y pads, buttons, check boxes, digits, keyboards, plus
// labels and bevels for layout), each an internal controller output that
// can be linked to parameters. Editor: 540 x 454 (FL's form). The panel
// layout and the control values live in the slot state; values are stored
// normalised (0..1) per output index (`values[out]`), so a control keeps its
// links when others are added or removed. docs/research/fx/controlsurface.md.

import type { FxPluginDef } from '../types';

export type CSType = 'knob' | 'slider' | 'xy' | 'button' | 'checkbox' | 'digits' | 'keyboard' | 'label' | 'bevel';

export interface CSControl {
  id: number;
  type: CSType;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Output indices (X/Y pads and keyboards have two). Labels and bevels have none. */
  outs: number[];
  /** Range shown by Digits / knob hints (the output stays 0..1). */
  min: number;
  max: number;
  /** Default value (normalised), "Set default value". */
  def: number;
  /** Accent colour (fill, pointer). */
  color: string;
  /** Style variant (slider: default / fill / round; button: momentary / toggle...). */
  style: string;
  /** Labels: text size; bevels: background colour is `color`. */
  text?: string;
}

/** The menu's "Add control" types, in FL's order (bevels and labels are layout only). */
export const CS_TYPES: { type: CSType; label: string; w: number; h: number; outs: number }[] = [
  { type: 'bevel', label: 'Bevel', w: 160, h: 100, outs: 0 },
  { type: 'button', label: 'Button', w: 76, h: 62, outs: 1 },
  { type: 'checkbox', label: 'CheckBox', w: 24, h: 24, outs: 1 },
  { type: 'digits', label: 'Digits', w: 64, h: 26, outs: 1 },
  { type: 'label', label: 'Label', w: 90, h: 24, outs: 0 },
  { type: 'keyboard', label: 'Keyboard', w: 240, h: 64, outs: 2 },
  { type: 'knob', label: 'Knob', w: 66, h: 66, outs: 1 },
  { type: 'slider', label: 'Slider', w: 32, h: 140, outs: 1 },
  { type: 'xy', label: 'XY', w: 160, h: 140, outs: 2 },
];

const TYPE_NAME: Record<CSType, string> = {
  knob: 'Knob', slider: 'Slider', xy: 'XY', button: 'Button', checkbox: 'Check', digits: 'Digits', keyboard: 'Keyboard', label: 'Label', bevel: 'Bevel',
};

export const CS_DEFAULT_COLORS: Record<CSType, string> = {
  knob: '#ffa036', slider: '#52ffff', xy: '#ffffff', button: '#b9f35a', checkbox: '#ff6a3d', digits: '#ffd38a', keyboard: '#7dd3ff', label: '#e6ecef', bevel: '#454f55',
};

/** The output names of a surface: per output index, "<control>" (X/Y pads: "<control> X" / "Y"). */
export function surfaceOutputs(p: Record<string, unknown>): string[] {
  const controls = Array.isArray(p.controls) ? (p.controls as CSControl[]) : [];
  const names: string[] = [];
  for (const c of controls) {
    c.outs?.forEach((o, k) => {
      const suffix = c.outs.length < 2 ? '' : c.type === 'xy' ? (k ? ' Y' : ' X') : k ? ' Gate' : ' Note';
      names[o] = `${c.name}${suffix}`;
    });
  }
  for (let i = 0; i < names.length; i++) if (names[i] === undefined) names[i] = '';
  return names;
}

/** A new control of a type at a position, with the next free name number and output indices. */
export function newControl(p: Record<string, unknown>, type: CSType, x: number, y: number): { control: CSControl; values: number[] } {
  const controls = Array.isArray(p.controls) ? (p.controls as CSControl[]) : [];
  const values = Array.isArray(p.values) ? [...(p.values as number[])] : [];
  const spec = CS_TYPES.find((t) => t.type === type)!;
  const id = Math.max(0, ...controls.map((c) => c.id)) + 1;
  const outs: number[] = [];
  for (let k = 0; k < spec.outs; k++) outs.push(values.length + k);
  const def = type === 'xy' || type === 'knob' ? 0.5 : 0;
  for (const o of outs) values[o] = def;
  const control: CSControl = {
    id, type, name: type === 'label' ? 'Label' : `${TYPE_NAME[type]} ${id}`, x, y, w: spec.w, h: spec.h, outs,
    min: 0, max: type === 'digits' ? 100 : 1, def, color: CS_DEFAULT_COLORS[type], style: 'default',
    ...(type === 'label' ? { text: 'Label' } : {}),
  };
  return { control, values };
}

function initial(): Record<string, unknown> {
  // FL's default surface: an X/Y pad, a knob, a slider and a button
  let p: Record<string, unknown> = { controls: [], values: [] };
  const add = (type: CSType, x: number, y: number, patch: Partial<CSControl> = {}) => {
    const { control, values } = newControl(p, type, x, y);
    p = { controls: [...(p.controls as CSControl[]), { ...control, ...patch }], values };
  };
  add('xy', 22, 70, { w: 122, h: 100 });
  add('knob', 52, 196);
  add('slider', 268, 38, { h: 112 });
  add('button', 443, 204, { text: 'Start' });
  return p;
}

export const def: FxPluginDef = {
  id: 'controlsurface',
  name: 'Control Surface',
  category: 'Controller',
  width: 540,
  height: 454,
  description: 'Your own panel of controls, each linkable as a controller',
  params: [],
  state: () => ({ ...initial(), edit: false, showButtons: true, showLabels: true, grid: 0, multiTouch: false }),
  normalize: (p) => ({
    ...p,
    controls: Array.isArray(p.controls) ? p.controls : [],
    values: Array.isArray(p.values) ? (p.values as unknown[]).map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)) : [],
    edit: !!p.edit,
    showButtons: p.showButtons !== false,
    showLabels: p.showLabels !== false,
    grid: typeof p.grid === 'number' ? p.grid : 0,
  }),
  outputs: surfaceOutputs,
};
