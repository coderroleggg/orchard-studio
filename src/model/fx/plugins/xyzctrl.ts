// X-Y-Z Controller (FL: Fruity X-Y-Z Controller): three controller outputs
// from a cursor on a pad (Z: mouse wheel). Each axis goes through an input
// mapping curve, a smoother (smoothing speed / acceleration, global speed)
// and an output mapping curve. Parameters (Tags 0..10): X / Y / Z value,
// smoothing speed and acceleration per axis, global speed, external
// controller speed. The mapping curves are FL envelopes (model/automation.ts
// points: pos = input 0..1, value = output). docs/research/fx/xyzctrl.md.

import type { FxPluginDef, FxPreset } from '../types';
import type { AutoPoint, CurveMode } from '../../automation';

const pct = (max: number) => (v: number) => `${Math.round((v / max) * 100)}%`;

export function linearMap(): AutoPoint[] {
  return [{ pos: 0, value: 0, tension: 0, mode: 'single' }, { pos: 1, value: 1, tension: 0, mode: 'single' }];
}

export interface XYZOptions {
  /** Absolute mode: a click jumps the cursor there (else it moves relative to where the drag starts). */
  absolute: boolean;
  /** Multi-touch: control X-Y with one fingertip. */
  fingertip: boolean;
  /** Keep the pad square. */
  roundToSquare: boolean;
}

export function defaultXYZOptions(): XYZOptions {
  return { absolute: true, fingertip: true, roundToSquare: false };
}

function maps(out: AutoPoint[]): { inMap: AutoPoint[][]; outMap: AutoPoint[][] } {
  return { inMap: [linearMap(), linearMap(), linearMap()], outMap: [0, 1, 2].map(() => out.map((p) => ({ ...p }))) };
}

const pt = (pos: number, value: number, tension = 0, mode: CurveMode = 'single'): AutoPoint => ({ pos, value, tension, mode });

function preset(name: string, globalSpeed: number, out: AutoPoint[], absolute = false): FxPreset {
  return {
    name,
    params: {
      xValue: 32768, yValue: 32768, zValue: 32768, xSpeed: 2048, ySpeed: 2048, zSpeed: 2048, xAcc: 3072, yAcc: 3072, zAcc: 3072,
      globalSpeed, extSpeed: 1024, ...maps(out), options: { ...defaultXYZOptions(), absolute }, color: 144,
    },
  };
}

export const def: FxPluginDef = {
  id: 'xyzctrl',
  name: 'X-Y-Z Controller',
  category: 'Controller',
  width: 425,
  height: 417,
  description: 'Three controller outputs from a cursor on a pad, with mapping curves and smoothing',
  params: [
    { key: 'xValue', name: 'X value', index: 0, min: 0, max: 65536, def: 32768, format: pct(65536) },
    { key: 'yValue', name: 'Y value', index: 1, min: 0, max: 65536, def: 32768, format: pct(65536) },
    { key: 'zValue', name: 'Z value', index: 2, min: 0, max: 65536, def: 32768, format: pct(65536) },
    { key: 'xSpeed', name: 'X smoothing speed', index: 3, min: 0, max: 4096, def: 2048, format: pct(4096) },
    { key: 'ySpeed', name: 'Y smoothing speed', index: 4, min: 0, max: 4096, def: 2048, format: pct(4096) },
    { key: 'zSpeed', name: 'Z smoothing speed', index: 5, min: 0, max: 4096, def: 2048, format: pct(4096) },
    { key: 'xAcc', name: 'X smoothing acceleration', index: 6, min: 0, max: 3072, def: 3072, format: pct(3072) },
    { key: 'yAcc', name: 'Y smoothing acceleration', index: 7, min: 0, max: 3072, def: 3072, format: pct(3072) },
    { key: 'zAcc', name: 'Z smoothing acceleration', index: 8, min: 0, max: 3072, def: 3072, format: pct(3072) },
    { key: 'globalSpeed', name: 'Global smoothing speed', index: 9, min: 0, max: 4096, def: 2048, format: pct(4096) },
    { key: 'extSpeed', name: 'External controller speed', index: 10, min: 0, max: 4096, def: 1024, format: pct(4096) },
  ],
  state: () => ({ ...maps(linearMap()), page: 0, axis: 0, color: 144, options: defaultXYZOptions(), hideControls: false }),
  normalize: (p) => {
    const fix = (m: unknown) => (Array.isArray(m) && m.length === 3 && m.every((x) => Array.isArray(x) && x.length >= 2) ? m : [linearMap(), linearMap(), linearMap()]);
    return {
      ...p,
      inMap: fix(p.inMap), outMap: fix(p.outMap),
      page: [0, 1, 2].includes(p.page as number) ? p.page : 0,
      axis: [0, 1, 2].includes(p.axis as number) ? p.axis : 0,
      color: typeof p.color === 'number' ? p.color : 144,
      options: { ...defaultXYZOptions(), ...(p.options && typeof p.options === 'object' ? p.options : {}) },
    };
  },
  outputs: ['X', 'Y', 'Z'],
  // FL's factory presets (Plugin presets/Effects/Fruity X-Y-Z Controller): output curves and global speed
  presets: [
    preset('Default', 2048, linearMap(), true),
    preset('First half', 2048, [pt(0, 0), pt(1, 0.5)]),
    preset('Instant', 0, linearMap()),
    preset('Inverted', 2048, [pt(0, 1), pt(1, 0)]),
    preset('Last half', 2048, [pt(0, 0.5), pt(1, 1)]),
    preset('Slow', 4096, linearMap()),
    preset('Smooth', 2048, linearMap()),
    preset('Steppy', 0, [pt(0, 0), pt(1, 1, 0.65, 'stairs')]),
    preset('Tension down', 2048, [pt(0, 0), pt(1, 1, -0.28)]),
    preset('Tension up', 2048, [pt(0, 0), pt(1, 1, 0.28)]),
    preset('Wobbler', 0, [pt(0, 0), pt(1, 1, -0.725, 'wave')]),
  ],
};
