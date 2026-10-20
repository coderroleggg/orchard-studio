// Phase Inverter (FL: Fruity Phase Inverter, legacy): inverts the left or
// the right channel. Form: 170 x 55; StateWheel (Tag 0) 0..1024, default
// 1024, three states read off the wheel (Off / Left / Right); the value
// label shows the state name. Not listed in FL's plugin database.

import type { FxPluginDef } from '../types';

export const PHASE_STATES = ['Off', 'Left', 'Right'];

function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * State for a wheel value, as FL computes it: x = float32(v / 1024), state =
 * Round(float32(float32(x * 3) - 0.5)) with banker's rounding: 0..341 Off,
 * 342..682 Left, 683..1024 Right.
 */
export function phaseInverterState(v: number): number {
  const x = Math.fround(Math.min(1, Math.max(0, (Number.isFinite(v) ? v : 1024) / 1024)));
  const s = roundHalfEven(Math.fround(Math.fround(x * 3) - 0.5));
  return Math.min(2, Math.max(0, s));
}

export const def: FxPluginDef = {
  id: 'phaseinverter',
  name: 'Phase Inverter',
  category: 'Gain',
  width: 170,
  height: 55,
  hidden: true,
  description: 'Inverts the phase of the left or right channel',
  params: [
    { key: 'state', name: 'State', index: 0, min: 0, max: 1024, def: 1024, format: (v) => PHASE_STATES[phaseInverterState(v)] },
  ],
};
