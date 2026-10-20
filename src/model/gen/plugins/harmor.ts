// Harmor (FL: Harmor, Plugin database > Generators > Synth special): Image-Line's
// additive / subtractive / resynthesis synthesizer. Two parts (A / B), each a
// bank of up to 516 partials per voice and unison voice shaped in the frequency
// domain (timbres, sub-harmonics, filters, phaser, pluck, harmonizer, prism,
// blur, tremolo, image synthesis / resynthesis), rendered by a recursive sine
// bank, then FX (distortion, chorus, delay, reverb, compression).
//
// From FL 2026's binary (Harmor_x64.dylib, arm64 slice, TTestPlug):
// - 825 automatable parameters (names, ranges: test host `info`; reset values:
//   the editor form's DefaultValue) — params.ts;
// - the plugin state (SaveRestoreState 0xc6670, version 0x130003) — types.ts,
//   docs/research/gen/harmor.md "State";
// - the 325 factory presets, each loaded and re-saved by FL itself through the
//   test host and stored as differences to the "Default" preset (state.ts);
// - a new instance plays FL's plugin database entry ("Spacebass - nucleon").
// Spec, DSP and fidelity: docs/research/gen/harmor.md.

import type { GenPluginDef } from '../types';
import { HARMOR_PARAMS } from './harmor/params';
import { H_PRESET_NAMES, freshState, normalizeHarmor } from './harmor/state';

export const def: GenPluginDef = {
  id: 'harmor',
  name: 'Harmor',
  category: 'Synth special',
  notes: 'events',
  defPoly: 16,
  width: 1024,
  height: 680,
  description: 'Additive / subtractive synthesizer with image synthesis and resynthesis',
  params: HARMOR_PARAMS,
  viewState: ['hView'],
  state: () => freshState(),
  normalize: (p) => normalizeHarmor(p),
  presets: H_PRESET_NAMES.map((name, i) => ({ name, params: { __h: i } })),
};
