// Delay (FL: Fruity Delay, legacy): tempo-based delay with ramped input and
// feedback, a one-pole low-pass on the echoes, a custom tempo and normal /
// inverted stereo / ping-pong modes. Form: 500 x 105. FL reports no value
// texts for its parameters; the texts below are the editor's labels (strings
// from FL's plugin: "Auto", "bpm", "%d notes", "Normal", "Inv. stereo",
// "Ping pong"). Mappings measured with flfxhost (docs/research/fx/delay.md).

import type { FxPluginDef } from '../types';

export const DELAY_MODES = ['Normal', 'Inv. stereo', 'Ping pong'];

/** Mode wheel (0..1024) -> 0 normal, 1 inverted stereo, 2 ping pong (FL: v * 3 div 1024). */
export function delayMode(v: number): number {
  return Math.min(2, Math.max(0, Math.floor((Math.max(0, v) * 3) / 1024)));
}

/** Tempo wheel: 0 = the song tempo, otherwise round(60 + v * 220 / 1024) BPM (60..280). */
export function delayTempo(v: number): number {
  return Math.round(60 + (Math.min(1024, Math.max(0, v)) * 220) / 1024);
}

/** One-pole low-pass coefficient (21^(v/1024) - 1) / 20 (the same at every sample rate). */
export function delayCutoffCoef(v: number): number {
  return (Math.pow(21, Math.min(1024, Math.max(0, v)) / 1024) - 1) / 20;
}

export const delayTempoText = (v: number): string => (Math.round(v) <= 0 ? 'Auto bpm' : `${delayTempo(v)} bpm`);
export const delayStepsText = (v: number): string => `${Math.round(v)} notes`;
export const delayModeText = (v: number): string => DELAY_MODES[delayMode(v)];
const pct = (v: number): string => `${Math.round((v / 1024) * 100)}%`;

const KEYS = ['input', 'feedback', 'cutoff', 'tempo', 'steps', 'mode'];

function preset(name: string, raw: number[]): { name: string; params: Record<string, number> } {
  const params: Record<string, number> = {};
  KEYS.forEach((k, i) => { params[k] = raw[i]; });
  return { name, params };
}

export const def: FxPluginDef = {
  id: 'delay',
  name: 'Delay',
  category: 'Delay reverb',
  width: 500,
  height: 105,
  hidden: true,
  description: 'Legacy tempo-based delay with low-pass echoes and ping pong',
  params: [
    { key: 'input', name: 'Input', index: 0, min: 0, max: 1024, def: 338, format: pct },
    { key: 'feedback', name: 'Feedback', index: 1, min: 0, max: 1024, def: 512, format: pct },
    { key: 'cutoff', name: 'Cutoff', index: 2, min: 0, max: 1024, def: 1024, format: pct },
    { key: 'tempo', name: 'Tempo', index: 3, min: 0, max: 1024, def: 0, format: delayTempoText },
    { key: 'steps', name: 'Steps', index: 4, min: 1, max: 16, def: 3, format: delayStepsText },
    { key: 'mode', name: 'Mode', index: 5, min: 0, max: 1024, def: 0, format: delayModeText },
  ],
  // FL's factory presets (raw values in parameter-index order)
  presets: [
    preset('Default', [338, 512, 1024, 0, 3, 0]),
    preset('Ambient', [384, 960, 800, 0, 3, 448]),
    preset('Double attack', [880, 0, 1024, 0, 1, 0]),
    preset('Half step at 140', [642, 240, 720, 1024, 1, 0]),
    preset('Lowpass', [1024, 1024, 64, 0, 1, 800]),
    preset('Single echo', [496, 0, 272, 0, 3, 0]),
  ],
};
