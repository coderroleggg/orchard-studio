// Scratcher (FL: Fruity Scratcher): a vinyl turntable simulator playing a
// loaded sample, added to the track's audio. Form: 247 x 303. Parameters
// (FL Tags): 0 Wave position (platter, 0..30000 = start..end of the sample),
// 1 Mute (0 = muted "On", 1 = "Off"), 2 Turntable speed, 3 acceleration,
// 4 Pan, 5 Volume, 6 Turntable hold, 7 sensitivity, 8 Transport (-1 reverse,
// 0 pause, 1 forward), 9..12 Smooth 1..4, 13 Rotations. Value texts are FL's
// (read with flfxhost): "0.023000", "0.500000 x", "25%", "78%", "Forward".
//
// Non-parameter state: the loaded sample (a SampleInfo in the project's sample
// pool, persisted with the project), the DVS time code type and RIAA switch,
// and the editor's 2x zoom.

import type { FxPluginDef } from '../types';
import type { SampleInfo } from '../../types';

export const SC_POS_MAX = 30000;
export const SC_TIMECODES = [
  'Off', 'Serato Mk2, Side A', 'Serato Mk2, Side B', 'Serato CD', 'Traktor Skratch Mk1, Side A',
  'Traktor Skratch Mk1, Side B', 'Traktor Skratch Mk2, Side A', 'Traktor Skratch Mk2, Side B', 'Timecode CD',
];
export const SC_TRANSPORT = ['Reverse', 'Pause', 'Forward'];

/** Prefix of the engine sample id under which the editor sends a Scratcher sample. */
export const SC_SAMPLE_PREFIX = 'scratcher:';

/** FL's "%f" value text: six decimals. */
const f6 = (v: number) => v.toFixed(6);
const pct = (v: number, full: number) => `${Math.round((v / full) * 100)}%`;

export function scPanText(v: number): string {
  const p = Math.round((Math.abs(v) / 128) * 100) * Math.sign(v);
  return `${p === 0 ? 0 : p}%`;
}

/** Platter speed factor of the motor: 1x at the default (50), 2x at 100. */
export function scSpeedFactor(v: number): number {
  return (2 * Math.min(100, Math.max(0, v))) / 100;
}

/** Output gain of the Volume knob: unity at FL's default 199 (78%), linear. */
export function scVolumeGain(v: number): number {
  return Math.max(0, v) / 199;
}

export interface ScState {
  sample: SampleInfo | null;
  timecode: number;
  riaa: boolean;
  zoom: boolean;
  dvs: boolean;
}

export const def: FxPluginDef = {
  id: 'scratcher',
  name: 'Scratcher',
  category: 'Misc',
  width: 247,
  height: 303,
  description: 'Vinyl turntable simulator: scratch a loaded sample',
  params: [
    { key: 'pos', name: 'Wave position', index: 0, min: 0, max: SC_POS_MAX, def: 690, format: (v) => f6(v / SC_POS_MAX) },
    { key: 'mute', name: 'Mute', index: 1, min: 0, max: 1, def: 1, format: (v) => (v >= 0.5 ? 'Off' : 'On') },
    { key: 'speed', name: 'Turntable speed', index: 2, min: 0, max: 100, def: 50, format: (v) => `${f6(v / 100)} x` },
    { key: 'acc', name: 'Turntable acceleration', index: 3, min: 0, max: 100, def: 25, format: (v) => pct(v, 100) },
    { key: 'pan', name: 'Pan', index: 4, min: -128, max: 128, def: 0, bipolar: true, format: scPanText },
    { key: 'vol', name: 'Volume', index: 5, min: 0, max: 255, def: 199, format: (v) => pct(v, 255) },
    { key: 'hold', name: 'Turntable hold', index: 6, min: 0, max: 1, def: 0, format: (v) => (v >= 0.5 ? 'On' : 'Off') },
    { key: 'sens', name: 'Turntable sensitivity', index: 7, min: 0, max: 100, def: 50, format: (v) => pct(v, 100) },
    { key: 'transport', name: 'Transport', index: 8, min: -1, max: 1, def: 0, options: SC_TRANSPORT },
    { key: 'sm1', name: 'Smooth 1', index: 9, min: 0, max: 1000, def: 500, format: (v) => f6(v / 1000) },
    { key: 'sm2', name: 'Smooth 2', index: 10, min: 0, max: 1000, def: 908, format: (v) => f6(v / 1000) },
    { key: 'sm3', name: 'Smooth 3', index: 11, min: 0, max: 1000, def: 999, format: (v) => f6(v / 1000) },
    { key: 'sm4', name: 'Smooth 4', index: 12, min: 0, max: 1000, def: 400, format: (v) => f6(v / 1000) },
    { key: 'rot', name: 'Rotations', index: 13, min: 0, max: 18, def: 9, format: (v) => f6(v / 18) },
  ],
  state: (): Record<string, unknown> => ({ sample: null, timecode: 0, riaa: false, zoom: false, dvs: false } satisfies ScState),
  normalize: (p) => ({
    ...p,
    sample: p.sample && typeof p.sample === 'object' && typeof (p.sample as SampleInfo).id === 'string' ? p.sample : null,
    timecode: Number.isInteger(p.timecode) && (p.timecode as number) >= 0 && (p.timecode as number) < SC_TIMECODES.length ? p.timecode : 0,
    riaa: !!p.riaa,
    zoom: !!p.zoom,
    dvs: !!p.dvs,
  }),
};
