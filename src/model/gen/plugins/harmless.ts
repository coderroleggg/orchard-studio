// Harmless (FL: Harmless, Plugin database > Generators > Synth classic): FL's
// additive synthesizer with subtractive-style controls. A bank of up to 528
// sine oscillators per voice and unison voice (4 sub / self-oscillation slots
// + 524 harmonics) whose amplitudes are shaped in the frequency domain
// (timbre colour, timbre EQ, harmonic mask, filter and resonance curves,
// phaser, harmonizer, pluck), then the volume envelope, stereo tremolo and the
// global FX (chorus, delay, reverb, compression = a hosted Maximus).
//
// From FL 2026's binary (Harmless_x64.dylib, arm64 slice, TTestPlug):
// - 100 automatable parameters (params.ts: names, ranges, reset values, FL's
//   exact value texts);
// - the extra state (state.ts: filter / resonance / phaser / compression types,
//   timbre colour, threaded, quality, custom timbre colour);
// - the 430 factory presets, each loaded and re-saved by FL itself through the
//   test host (presets.ts); a new instance plays the plugin database state.
// Spec, DSP and fidelity: docs/research/gen/harmless.md.

import type { GenPluginDef, GenPreset } from '../types';
import { inflateRaw, base64ToBytes } from './drumaxx/inflate';
import { HL_KEYS, HL_PARAMS } from './harmless/params';
import { HL_BASE_EXTRAS, HL_BASE_PARAMS, HL_PRESET_DATA } from './harmless/presets';
import { HL_EXTRAS } from './harmless/state';

type Entry = [string, number[], number[]?, number?];

/** A state from parameter values and extras (FL's save order). */
function stateOf(params: ArrayLike<number>, extras: ArrayLike<number>, custom = false): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (let i = 0; i < HL_KEYS.length; i++) o[HL_KEYS[i]] = params[i];
  for (let i = 0; i < HL_EXTRAS.length; i++) o[HL_EXTRAS[i].key] = extras[i];
  o.kbShown = 1;
  if (custom) o.customMissing = 1;
  return o;
}

let presets: GenPreset[] | null = null;
function loadPresets(): GenPreset[] {
  if (presets) return presets;
  const json = new TextDecoder().decode(inflateRaw(base64ToBytes(HL_PRESET_DATA)));
  const entries = JSON.parse(json) as Entry[];
  presets = entries.map(([name, diff, extras, custom]) => {
    const pv = HL_BASE_PARAMS.slice();
    for (let i = 0; i < diff.length; i += 2) pv[diff[i]] = diff[i + 1];
    return { name, params: stateOf(pv, extras ?? HL_BASE_EXTRAS, !!custom) };
  });
  return presets;
}

/** Clamp a stored state to FL's control ranges. */
export function normalizeHarmless(p: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...p };
  for (const d of HL_PARAMS) {
    const v = Number(o[d.key]);
    o[d.key] = Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, Math.round(v))) : d.def;
  }
  HL_EXTRAS.forEach((e, i) => {
    const v = Number(o[e.key]);
    o[e.key] = Number.isFinite(v) ? Math.min(e.max, Math.max(0, Math.round(v))) : HL_BASE_EXTRAS[i];
  });
  o.kbShown = o.kbShown === 0 || o.kbShown === false ? 0 : 1;
  if (typeof o.customSample !== 'string') delete o.customSample;
  if (o.customMissing !== 1) delete o.customMissing;
  return o;
}

export const def: GenPluginDef = {
  id: 'harmless',
  name: 'Harmless',
  category: 'Synth classic',
  notes: 'events',
  levels: 'plugin',
  velocity: 'plugin',
  defPoly: 16,
  width: 848,
  height: 569,
  description: 'An additive synthesizer',
  params: HL_PARAMS,
  viewState: ['kbShown'],
  state: () => stateOf(HL_BASE_PARAMS, HL_BASE_EXTRAS),
  normalize: (p) => normalizeHarmless(p),
  get presets() { return loadPresets(); },
};
