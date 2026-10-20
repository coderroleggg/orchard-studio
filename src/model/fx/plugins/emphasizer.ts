// Emphasizer (FL: Emphasizer, Image-Line / Dario Sanfilippo). The focused
// front end of Emphasis: a clean 2 ms look-ahead limiting stage that slowly
// takes over sustained gain reduction, and a hard or soft clipper that takes
// the rest. Form 580 x 120; parameters in FL's order (Tag = index).

import type { FxPluginDef } from '../types';

const f32 = Math.fround;

export function ezInputGainDb(v: number): number {
  return (24 * v) / 10000;
}

/** Output gain (linear, attenuation only): FL's (11^x - 1) / 10 law. */
export function ezOutputGain(v: number): number {
  return (Math.pow(11, v / 10000) - 1) / 10;
}

function dbText(db: number): string {
  const r = Math.round(f32(db) * 10) / 10;
  return `${(r === 0 ? 0 : r).toFixed(1)} dB`;
}

export function ezOutputText(v: number): string {
  if (v <= 0) return '-Inf dB';
  const r = Math.round(20 * Math.log10(ezOutputGain(v)) * 10) / 10;
  return `${(r === 0 ? 0 : r).toFixed(1)} dB`;
}

const onOff = ['Off', 'On'];

export const def: FxPluginDef = {
  id: 'emphasizer',
  name: 'Emphasizer',
  category: 'Dynamics',
  width: 580,
  height: 120,
  description: 'Clean limiter plus hard or soft clipper for loudness',
  // Options menu: Pause LUFS
  state: () => ({ lufsPaused: false }),
  params: [
    { key: 'inputGain', name: 'Input gain', index: 0, min: 0, max: 10000, def: 0, format: (v) => dbText(ezInputGainDb(v)), parse: (db) => Math.round((db / 24) * 10000) },
    // FL's Default preset sets Emphasis to 50% (5013); the constructor value is 0
    { key: 'emphasis', name: 'Emphasis', index: 1, min: 0, max: 10000, def: 5013, format: (v) => `${Math.round(f32(v / 10000) * 100)}%`, parse: (p) => Math.round(p * 100) },
    { key: 'clipping', name: 'Clipping', index: 2, min: 0, max: 1, def: 0, options: ['Hard', 'Soft'] },
    { key: 'levelMatch', name: 'Level matching', index: 3, min: 0, max: 1, def: 0, options: onOff },
    { key: 'bypass', name: 'Bypass', index: 4, min: 0, max: 1, def: 0, options: onOff },
    { key: 'outputGain', name: 'Output gain', index: 5, min: 0, max: 10000, def: 10000, format: ezOutputText, parse: (db) => Math.round(10000 * Math.log(1 + 10 * Math.pow(10, Math.min(0, db) / 20)) / Math.log(11)) },
  ],
  // FL ships one factory preset (Default)
  presets: [{ name: 'Default', params: {} }],
};
