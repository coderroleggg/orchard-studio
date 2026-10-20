// Peak Controller (FL: Fruity Peak Controller): an internal controller that
// follows the input level (peak follower with base, volume, tension and decay)
// plus an LFO; outputs Peak+LFO, Peak and LFO. Audio passes through unless
// Mute is on. Form: 521 x 209, ten parameters (Tags 0..9). The value maths is
// FL's (docs/research/fx/peakctrl.md).

import type { FxPluginDef } from '../types';

/** Peak / LFO amount factor: (6^(|v|/256) - 1) x 0.4 (peak, 179 = 100%) or x 0.2 (LFO), signed. */
export function amountFactor(v: number, lfo: boolean): number {
  const f = (Math.pow(6, Math.abs(v) / 256) - 1) * (lfo ? 0.2 : 0.4);
  return v < 0 ? -f : f;
}

export { tensionSpeed } from '../ctrl';

/** Peak decay per beat (linear amplitude units): (10001^(d/128) - 1) x 0.0192. */
export function decayPerBeat(d: number): number {
  return (Math.pow(10001, d / 128) - 1) * 0.0192;
}

/** LFO period in 1/48 steps (FL's speed display unit): (1001^(v/65536) - 1) x 24.576. */
export function lfoPeriod48(v: number): number {
  return (Math.pow(1001, v / 65536) - 1) * 24.576;
}

const pct = (x: number) => `${x < 0 ? '-' : ''}${Math.round(Math.abs(x))}%`;

/** Speed text: steps:48ths of a step ("16:00" = 16 steps = one bar). */
export function lfoSpeedText(v: number): string {
  const t = Math.round(lfoPeriod48(v));
  return `${Math.floor(t / 48)}:${String(t % 48).padStart(2, '0')}`;
}

export const LFO_SHAPES = ['Sine', 'Triangle', 'Square', 'Saw', 'Random'];

export const def: FxPluginDef = {
  id: 'peakctrl',
  name: 'Peak Controller',
  category: 'Controller',
  width: 521,
  height: 209,
  description: 'Controller driven by the input level and an LFO',
  params: [
    { key: 'base', name: 'Peak base level', index: 0, min: 0, max: 65536, def: 0, format: (v) => pct((v / 65536) * 100) },
    { key: 'vol', name: 'Peak amount', index: 1, min: -256, max: 256, def: 179, bipolar: true, format: (v) => pct(amountFactor(v, false) * 100) },
    { key: 'tension', name: 'Peak tension', index: 2, min: -128, max: 128, def: 0, bipolar: true, format: (v) => pct((v / 128) * 100) },
    { key: 'decay', name: 'Peak decay speed', index: 3, min: 5, max: 128, def: 66, format: (v) => pct((v / 128) * 100) },
    { key: 'lfoBase', name: 'LFO base level', index: 4, min: 0, max: 65536, def: 0, format: (v) => pct((v / 65536) * 100) },
    { key: 'lfoVol', name: 'LFO amount', index: 5, min: -256, max: 256, def: 0, bipolar: true, format: (v) => pct(amountFactor(v, true) * 100) },
    { key: 'lfoTension', name: 'LFO tension', index: 6, min: -128, max: 128, def: 0, bipolar: true, format: (v) => pct((v / 128) * 100) },
    { key: 'lfoSpeed', name: 'LFO speed', index: 7, min: 200, max: 65536, def: 32950, format: lfoSpeedText },
    { key: 'lfoShape', name: 'LFO shape', index: 8, min: 0, max: 4, def: 0, options: LFO_SHAPES },
    { key: 'lfoPhase', name: 'LFO phase', index: 9, min: 0, max: 65535, def: 0, format: (v) => pct((v / 65536) * 100) },
  ],
  // Ramp and Mute are switches outside the parameter list (FL's state bytes after the parameters)
  state: () => ({ mute: false, ramp: false }),
  normalize: (p) => ({ ...p, mute: !!p.mute, ramp: !!p.ramp }),
  outputs: ['Peak+LFO', 'Peak', 'LFO'],
  // FL's factory presets (Plugin presets/Effects/Fruity Peak Controller)
  presets: [
    { name: 'Default', params: { base: 0, vol: 179, tension: 0, decay: 66, lfoBase: 0, lfoVol: 0, lfoTension: 0, lfoSpeed: 32950, lfoShape: 0, lfoPhase: 0, mute: false, ramp: false } },
    { name: 'Fast LFO', params: { base: 0, vol: 0, tension: 0, decay: 66, lfoBase: 65536, lfoVol: -256, lfoTension: 66, lfoSpeed: 10272, lfoShape: 3, lfoPhase: 0, mute: false, ramp: false } },
    { name: 'Randomness', params: { base: 0, vol: 0, tension: 0, decay: 66, lfoBase: 0, lfoVol: 256, lfoTension: 0, lfoSpeed: 10272, lfoShape: 4, lfoPhase: 0, mute: false, ramp: true } },
  ],
};
