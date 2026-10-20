// Emphasis (FL: Emphasis, Image-Line / Dario Sanfilippo). Multi-stage mastering
// limiter: clean look-ahead limiting, an oversampled shaping limiter whose
// hardness goes from clean (0) to hard clipping (9), and a brick-wall stage.
// Form: 740 x 366. FL exposes 10 parameters to hosts plus hidden ones that
// its editor drives by Tag (10 Level matching, 11 Oversampling, 12 Hardness,
// 26 Instant recovery, 27 DC block); all are automatable in FL.

import type { FxPluginDef } from '../types';

const f32 = Math.fround;

/** Input gain: 0..10000 = 0..24 dB. */
export function emInputGainDb(v: number): number {
  return (24 * v) / 10000;
}

/** Output ceiling (linear): FL's (11^x - 1) / 10 law. */
export function emCeilingGain(v: number): number {
  return (Math.pow(11, v / 10000) - 1) / 10;
}

export function emCeilingText(v: number): string {
  if (v <= 0) return '-Inf dB';
  const db = 20 * Math.log10(emCeilingGain(v));
  const r = Math.round(db * 10) / 10;
  return `${(r === 0 ? 0 : r).toFixed(1)} dB`;
}

function dbText(db: number): string {
  const r = Math.round(f32(db) * 10) / 10;
  return `${(r === 0 ? 0 : r).toFixed(1)} dB`;
}

function pctText(v: number): string {
  return `${Math.round(f32(v / 10000) * 100)}%`;
}

export const EM_MODES = ['Versatile', 'Loud', 'Transient', 'Steady'];
export const EM_OVERSAMPLING = ['Off', '2x', '4x', '8x', '16x'];
export const EM_OS_FACTORS = [1, 2, 4, 8, 16];

const onOff = ['Off', 'On'];

export const def: FxPluginDef = {
  id: 'emphasis',
  name: 'Emphasis',
  category: 'Dynamics',
  width: 740,
  height: 366,
  description: 'Mastering limiter with clean limiting, shaping and brick-wall stages',
  // display options (FL keeps them in the plugin state): LUFS readout, display range, low latency, visuals
  state: () => ({ lufsMode: 1, displayRange: 1, lowLatency: false, visuals: true, lock: false }),
  params: [
    { key: 'bypass', name: 'Bypass', index: 0, min: 0, max: 1, def: 0, options: onOff },
    { key: 'delta', name: 'Delta', index: 1, min: 0, max: 1, def: 0, options: onOff },
    { key: 'envOrder', name: 'Envelope order', index: 2, min: 1, max: 4, def: 1, format: (v) => String(Math.round(v)) },
    { key: 'truePeak', name: 'True peak detection', index: 3, min: 0, max: 1, def: 0, options: onOff },
    { key: 'channelMode', name: 'Channel mode', index: 4, min: 0, max: 1, def: 0, options: ['L/R', 'M/S'] },
    { key: 'mode', name: 'Emphasis mode', index: 5, min: 0, max: 3, def: 0, options: EM_MODES },
    { key: 'inputGain', name: 'Input gain', index: 6, min: 0, max: 10000, def: 0, format: (v) => dbText(emInputGainDb(v)), parse: (db) => Math.round((db / 24) * 10000) },
    { key: 'linking', name: 'Linking', index: 7, min: 0, max: 10000, def: 10000, format: pctText, parse: (p) => Math.round(p * 100) },
    { key: 'emphasis', name: 'Emphasis amount', index: 8, min: 0, max: 10000, def: 10000, format: pctText, parse: (p) => Math.round(p * 100) },
    // FL's Default preset sets the ceiling to -0.2 dB (9912); the constructor value is 0 dB
    { key: 'ceiling', name: 'Output ceiling', index: 9, min: 0, max: 10000, def: 9912, format: emCeilingText, parse: (db) => Math.round(10000 * Math.log(1 + 10 * Math.pow(10, db / 20)) / Math.log(11)) },
    { key: 'levelMatch', name: 'Level matching', index: 10, min: 0, max: 1, def: 0, options: onOff },
    { key: 'oversampling', name: 'Oversampling Factor', index: 11, min: 0, max: 4, def: 2, options: EM_OVERSAMPLING },
    { key: 'hardness', name: 'Emphasis Hardness', index: 12, min: 0, max: 9, def: 7, format: (v) => String(Math.round(v)) },
    { key: 'instantRecovery', name: 'Instant recovery', index: 26, min: 0, max: 1, def: 0, options: onOff },
    { key: 'dcBlock', name: 'DC Block', index: 27, min: 0, max: 1, def: 0, options: onOff },
  ],
  // FL's factory presets (Plugin presets/Effects/Emphasis), values read with the FL host
  presets: [
    { name: 'Classical', params: { ceiling: 10000, oversampling: 0, hardness: 0 } },
    { name: 'Clean upward limiter (extreme)', params: { mode: 3, ceiling: 10000, oversampling: 0, hardness: 0 } },
    { name: 'Clean upward limiter (heavy)', params: { mode: 2, ceiling: 10000, oversampling: 0, hardness: 0 } },
    { name: 'Clean upward limiter (soft)', params: { mode: 2, emphasis: 5035, ceiling: 10000, oversampling: 0, hardness: 0 } },
    { name: 'Default', params: {} },
    { name: 'Easy listening', params: { ceiling: 10000, oversampling: 0, hardness: 2 } },
    { name: 'Hard-clipper', params: { mode: 3, ceiling: 10000, oversampling: 0, hardness: 9 } },
    { name: 'Harsh electronics', params: { mode: 1, ceiling: 10000, oversampling: 0, hardness: 8 } },
    { name: 'Heavy', params: { ceiling: 10000, oversampling: 0, hardness: 8 } },
    { name: 'Louder (mild saturation)', params: { mode: 3, emphasis: 7450, ceiling: 10000, oversampling: 0, hardness: 5 } },
    { name: 'Louder (mild transient shaping)', params: { mode: 2, emphasis: 7450, ceiling: 10000, oversampling: 0, hardness: 5 } },
    { name: 'Pop (heavy)', params: { ceiling: 10000, oversampling: 0, hardness: 7 } },
    { name: 'Pop (soft)', params: { ceiling: 10000, oversampling: 0, hardness: 5 } },
    { name: 'Soft-clipper (heavy)', params: { mode: 3, ceiling: 10000, oversampling: 0, hardness: 7 } },
    { name: 'Soft-clipper (light)', params: { mode: 3, ceiling: 10000, oversampling: 0, hardness: 3 } },
    { name: 'Soft-clipper (mild)', params: { mode: 3, ceiling: 10000, oversampling: 0, hardness: 5 } },
    { name: 'Transient shaping (extreme)', params: { mode: 2, ceiling: 10000, oversampling: 0, hardness: 8 } },
    { name: 'Transient shaping (heavy)', params: { mode: 2, emphasis: 7457, ceiling: 10000, oversampling: 0, hardness: 8 } },
    { name: 'Transient shaping (light)', params: { mode: 2, emphasis: 2483, ceiling: 10000, oversampling: 0, hardness: 8 } },
    { name: 'Transient shaping (mild)', params: { mode: 2, emphasis: 5033, ceiling: 10000, oversampling: 0, hardness: 8 } },
    { name: 'Transparent normalizer', params: { mode: 2, emphasis: 0, ceiling: 10000, oversampling: 0, hardness: 0 } },
  ],
};
