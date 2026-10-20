// Instrument (generator) plugin definitions shared by the engine and the UI.
// They have the effect definitions' shape (src/model/fx/types.ts): FL's
// parameter list (names, parameter indices, control ranges in FL's control
// units, defaults, value texts), factory presets, view state, extra state,
// controller outputs and the editor size, plus how the plugin takes notes and
// which channel settings tabs FL shows for it. See docs/gen-framework.md.

import type { FxParamDef, FxParams, FxPluginDef, FxPreset } from '../fx/types';

export type { FxParamDef as GenParamDef, FxPreset as GenPreset, FxParams as GenParams };

/**
 * FL's plugin database folders (Browser > Plugin database > Generators), in
 * FL's order. 'MIDI' holds MIDI Out and 'Sampler' the Sampler (built-in
 * channel kinds, listed by the UI next to the plugins of those folders).
 */
export type GenCategory =
  | 'Controller' | 'Drum' | 'MIDI' | 'Misc' | 'Patcher' | 'Sampler' | 'Synth classic' | 'Synth special' | 'Visual';

export const GEN_CATEGORIES: GenCategory[] = [
  'Controller', 'Drum', 'MIDI', 'Misc', 'Patcher', 'Sampler', 'Synth classic', 'Synth special', 'Visual',
];

/**
 * How notes reach an instrument (FL's TFruityPlug voice API):
 * - 'voices': the channel triggers one voice per note (FL's TriggerVoice) and
 *   renders every voice itself (Voice_Render), updating the voice's levels
 *   (FL's TVoiceParams.FinalLevels) at the channel's control rate. This also
 *   covers FL's "hybrid" generators (FPF_UseSampler) whose voices stream into
 *   the host's sampler. Most FL synths and drum synths.
 * - 'events': the plugin receives note on / note off events (each note with its
 *   live levels) and renders all its voices itself in render() (FL's Gen_Render
 *   plugins that manage their own voices: FPC, DirectWave, Slicex...).
 * Either way the channel's note handling (key range, time shift, arpeggiator,
 * echo, polyphony / mono / porta, cut groups) runs first.
 */
export type GenNoteMode = 'voices' | 'events';

export interface GenPluginDef extends Omit<FxPluginDef, 'category' | 'alsoIn'> {
  /** FL's plugin database folder (first = main). */
  category: GenCategory;
  /** Further folders the plugin is also listed in. */
  alsoIn?: GenCategory[];
  /** How notes reach the plugin (see GenNoteMode). */
  notes: GenNoteMode;
  /**
   * FL shows the INS tab (Envelope / instrument settings): FL's legacy native
   * generators (3x Osc, Fruit Kick, BeepMap, DX10, Granulizer...) whose voices
   * take the channel's INS envelopes, LFOs and filter, with the Sampler's
   * semantics. Other instruments get the channel's levels only.
   */
  ins?: boolean;
  /**
   * Who applies a voice's volume and panning ('voices' plugins):
   * - 'channel' (default): the plugin renders the voice at unity gain and
   *   centred; the channel multiplies it by the voice's volume (velocity,
   *   channel volume, MISC levels, echo, INS volume envelope / LFO) and pans it
   *   with FL's pan law, ramping per control step like the Sampler.
   * - 'plugin': the plugin applies levels.vol and levels.pan itself (FL plugins
   *   that map velocity to their own modulation or pan voices internally);
   *   use computeLRVol() (src/engine/gen/levels.ts) for FL's pan law.
   */
  levels?: 'channel' | 'plugin';
  /**
   * Who applies note velocity: 'levels' (default) folds it into the voice's
   * final volume; 'plugin': the plugin uses the note velocity itself and FL
   * leaves it out of FinalLevels.Vol (measured: BassDrum, MiniSynth, PoiZone...).
   */
  velocity?: 'levels' | 'plugin';
  /**
   * Names the plugin gives to Piano roll keys (FL's GetName(FPN_Semitone): Fruity Dance's
   * moves), by key number for the plugin's state; keys without an entry keep their note name.
   */
  keyNames?: (params: FxParams) => Record<number, string>;
  /** No audio output (controllers): FL hides the channel's mixer TRACK selector. */
  noAudio?: boolean;
  /** FL's TFruityPlugInfo.DefPoly: the channel's max polyphony when the plugin is loaded (0 / absent = unlimited). */
  defPoly?: number;
  /** Factory presets (FL's preset names and values in control units). */
  presets?: FxPreset[];
}

/** A channel's instrument state: the plugin id and its state (parameters by key plus plugin-specific fields). */
export interface ChannelPlugin {
  id: string;
  params: FxParams;
  /**
   * MIDI input port 0..255 (undefined / -1 = none): notes that MIDI Out
   * channels send on this port play the instrument, as FL's plugin wrapper's
   * input port.
   */
  midiPort?: number;
}
