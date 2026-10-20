// X-Y Controller (FL: Fruity X-Y Controller): a target glides toward a goal
// position on a 2D pad (Speed / Acceleration) and outputs its X and Y
// coordinates, each through Min / Max and a tension curve. Form: 239 x 352;
// parameters X / Y level, min, max, tension (Tags 0..7), speed and
// acceleration (8, 9). The motion maths is FL's (docs/research/fx/xyctrl.md).

import type { FxPluginDef } from '../types';

const pct = (min: number, max: number) => (v: number) => `${Math.round(((v - min) / (max - min)) * 100)}%`;
const tens = (v: number) => `${v < 0 ? '-' : ''}${Math.round(Math.abs(v / 128) * 100)}%`;

/** Joystick settings (FL's joystick panel and axis menus; not automatable). */
export interface XYJoystick {
  enabled: boolean;
  /** Gamepad axis index (0-based) driving X / Y. */
  xAxis: number;
  yAxis: number;
  /** Absolute mode per axis: the stick position is the goal; else the stick moves the goal. */
  xAbs: boolean;
  yAbs: boolean;
  /** Joystick speed 0..100 (FL's default 70). */
  speed: number;
}

export function defaultJoystick(): XYJoystick {
  return { enabled: false, xAxis: 0, yAxis: 1, xAbs: false, yAbs: false, speed: 70 };
}

export const def: FxPluginDef = {
  id: 'xyctrl',
  name: 'X-Y Controller',
  category: 'Controller',
  width: 239,
  height: 352,
  description: 'Two controller outputs from a target moving on a 2D pad',
  params: [
    { key: 'xLevel', name: 'X Level', index: 0, min: 0, max: 65536, def: 32768, format: pct(0, 65536) },
    { key: 'xMin', name: 'X Min', index: 1, min: 0, max: 65536, def: 0, format: pct(0, 65536) },
    { key: 'xMax', name: 'X Max', index: 2, min: 0, max: 65536, def: 65536, format: pct(0, 65536) },
    { key: 'xTension', name: 'X Tension', index: 3, min: -128, max: 128, def: 0, bipolar: true, format: tens },
    { key: 'yLevel', name: 'Y Level', index: 4, min: 0, max: 65536, def: 32768, format: pct(0, 65536) },
    { key: 'yMin', name: 'Y Min', index: 5, min: 0, max: 65536, def: 0, format: pct(0, 65536) },
    { key: 'yMax', name: 'Y Max', index: 6, min: 0, max: 65536, def: 65536, format: pct(0, 65536) },
    { key: 'yTension', name: 'Y Tension', index: 7, min: -128, max: 128, def: 0, bipolar: true, format: tens },
    { key: 'speed', name: 'Speed', index: 8, min: 1024, max: 2048, def: 1536, format: pct(1024, 2048) },
    { key: 'accel', name: 'Acceleration', index: 9, min: 256, max: 1024, def: 1024, format: pct(256, 1024) },
  ],
  // the X/Y switch (which axis the knobs edit), the pad skin and the joystick
  state: () => ({ axis: 0, skin: 'Default', joy: defaultJoystick() }),
  normalize: (p) => ({
    ...p,
    axis: p.axis === 1 ? 1 : 0,
    skin: typeof p.skin === 'string' ? p.skin : 'Default',
    joy: { ...defaultJoystick(), ...(p.joy && typeof p.joy === 'object' ? p.joy : {}) },
  }),
  outputs: ['X', 'Y'],
  // FL's factory presets (Plugin presets/Effects/Fruity X-Y Controller)
  presets: [
    { name: 'Default', params: { xLevel: 32768, xMin: 0, xMax: 65536, xTension: 0, yLevel: 32768, yMin: 0, yMax: 65536, yTension: 0, speed: 1536, accel: 1024, skin: 'Default', joy: defaultJoystick() } },
    { name: 'Immediate', params: { xLevel: 32768, xMin: 0, xMax: 65536, xTension: 0, yLevel: 32768, yMin: 0, yMax: 65536, yTension: 0, speed: 2048, accel: 1024, skin: 'Default', joy: defaultJoystick() } },
    { name: 'Joystick - alt axis', params: { xLevel: 32768, xMin: 0, xMax: 65536, xTension: 0, yLevel: 32768, yMin: 0, yMax: 65536, yTension: 0, speed: 2048, accel: 1024, skin: 'Sampler grid', joy: { ...defaultJoystick(), enabled: true, xAxis: 5, yAxis: 7 } } },
    { name: 'Joystick - main axis', params: { xLevel: 32768, xMin: 0, xMax: 65536, xTension: 0, yLevel: 32768, yMin: 0, yMax: 65536, yTension: 0, speed: 2048, accel: 1024, skin: 'Sampler grid', joy: { ...defaultJoystick(), enabled: true, xAxis: 0, yAxis: 1 } } },
    { name: 'Satellite', params: { xLevel: 32768, xMin: 0, xMax: 65536, xTension: 0, yLevel: 32768, yMin: 0, yMax: 65536, yTension: 0, speed: 1804, accel: 452, skin: 'Default', joy: defaultJoystick() } },
    { name: 'XBOX Joystick - alt axis', params: { xLevel: 32768, xMin: 0, xMax: 65536, xTension: 0, yLevel: 32768, yMin: 0, yMax: 65536, yTension: 0, speed: 2048, accel: 1024, skin: 'Sampler grid', joy: { ...defaultJoystick(), enabled: true, xAxis: 2, yAxis: 5 } } },
    { name: 'XBOX Joystick - main axis', params: { xLevel: 32768, xMin: 0, xMax: 65536, xTension: 0, yLevel: 32768, yMin: 0, yMax: 65536, yTension: 0, speed: 2048, accel: 1024, skin: 'Sampler grid', joy: { ...defaultJoystick(), enabled: true, xAxis: 0, yAxis: 1 } } },
    { name: 'XBOX Joystick - triggers', params: { xLevel: 0, xMin: 0, xMax: 65536, xTension: 0, yLevel: 65536, yMin: 0, yMax: 65536, yTension: 0, speed: 2048, accel: 1024, skin: 'Sampler grid', joy: { ...defaultJoystick(), enabled: true, xAxis: 7, yAxis: 6, xAbs: true, yAbs: true } } },
  ],
};
