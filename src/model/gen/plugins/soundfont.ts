// SoundFont Player (FL: Soundfont Player, Plugin database > Generators > Misc): a SoundFont 2 sampler. FL's
// player is Benjamin Rosseaux's "Sobanth" synth (Soundfont Player_x64.dylib, arm64 slice, 16 MIDI channels, a
// voice per zone with SF2 generators, modulators, volume / modulation envelopes, LFOs and a resonant low-pass
// filter, banded sinc resampling, built-in reverb and chorus). See docs/research/gen/soundfont.md.
//
// From FL 2026's binary:
// - 13 parameters: patch / bank (hidden state: the selected preset), reverb / chorus send level multipliers,
//   modulation (MIDI CC1), "Env 2" (the volume envelope's attack / decay / sustain / release), "LFO 2" (the
//   vibrato LFO's delay / depth / speed) and the initial filter cutoff: parameters 5..12 override the SF2
//   generators of every voice while they are not "Disabled";
// - DefPoly 8192; the plugin takes the note velocity itself (FPV_SetLinkVelocity(0)) and applies FinalLevels.Vol
//   / Pan / Pitch to each voice, so it is an 'events' instrument with velocity 'plugin';
// - editor form: SynthPanel 370 x 385; a new instance gets the plugin database state: no soundfont (FL loads
//   STR_Ensemble.sf2 from its factory data: "Import FL content..." reads the user's own copy), patch 1, bank 0,
//   BUILT-IN reverb and chorus off, Standard resampling, all three options on.

import type { GenPluginDef } from '../types';
import { sfInitialState, sfNormalize, sfParams } from './soundfont/state';

export const def: GenPluginDef = {
  id: 'soundfont',
  name: 'SoundFont Player',
  category: 'Misc',
  notes: 'events',
  velocity: 'plugin',
  defPoly: 8192,
  width: 370,
  height: 385,
  description: 'SoundFont (.sf2) sampler with built-in reverb and chorus',
  params: sfParams(),
  state: sfInitialState,
  normalize: sfNormalize,
  viewState: [],
};
