// Slicex (FL: Slicex, Plugin database > Generators > Drum): FL's beat slicer. Two decks hold
// a sample each, cut into regions (slices) by FL's beat detector when it is loaded (or by the
// regions stored in the WAV); every region plays from a key (trigger notes, or one key per
// region upwards from C5), with its own volume, panning, pitch, filter, delay, sample start,
// cut group and mixer track offset, modulated by one of 8 articulator groups (envelope, LFO and
// velocity / X / Y / random mappings for panning, volume, filter cutoff and resonance, speed and
// sample start). Layered regions on one key mix by FL's layering modes and crossfade curves.
// See docs/research/gen/slicex.md.
//
// From FL 2026's binary (Slicex_x64.dylib, arm64 slice; addresses in the research note): the
// 352 parameters and value texts, the state (SaveRestoreState 0x73450), TriggerVoice 0x79860,
// the voice 0x7bf50 and FL's sample / envelope / filter classes. Orchard ships no FL audio: the
// user loads their own samples (Browser drag & drop, files); FL's factory presets carry no audio.

import type { GenPluginDef } from '../types';
import type { FxParams } from '../../fx/types';
import { DEFAULT_SETTINGS_RAW, defaultArts, settingsFromRaw } from './slicex/defaults';
import { sxParams } from './slicex/params';
import { SX_DECK_KEYS, SX_SAMPLE_KEYS, SX_VIEW_KEYS, sxInitialState, sxKeyNames, sxNormalize } from './slicex/state';

export { sxKeyLists, sxRegionEnd, sxRegionKey, sxBaseNote } from './slicex/state';

/** FL's option block with byte (offset - 0x1304) set. */
function rawWith(changes: Record<number, number>): number[] {
  const r = DEFAULT_SETTINGS_RAW.slice();
  for (const [o, v] of Object.entries(changes)) r[Number(o) - 0x1304] = v;
  return r;
}

/** FL's factory presets (Plugin presets/Generators/Slicex: they carry empty WAVs; FL keeps the audio, "Lock audio data"). */
function presets(): GenPluginDef['presets'] {
  const opt = (raw: number[]): FxParams => ({ ...settingsFromRaw(raw) });
  const sustaining = defaultArts();
  // articulator 1's volume envelope: on, holding full level for 6 units (3 s) after the note off
  sustaining[0].t[1].env = { t: 1, p: [[0, 1, 0, 0, 0, 0, 0], [6, 1, 0, 0, 0, 0, 2]], m: [0, -1, -1, -1, 0], a: [128, 128, 0, 128] };
  return [
    { name: 'Default', params: { opt: opt(rawWith({ 0x1327: 0 })) } },
    { name: 'Minimal', params: { opt: opt(rawWith({ 0x1314: 3, 0x1327: 0, 0x1330: 0 })) } },
    { name: 'Sustaining', params: { opt: opt(rawWith({ 0x1327: 0 })), arts: sustaining } },
  ];
}

export const def: GenPluginDef = {
  id: 'slicex',
  name: 'Slicex',
  category: 'Drum',
  notes: 'events',
  width: 714,
  height: 625,
  description: 'Beat slicer: two decks of auto-sliced audio played from the keyboard, with 8 articulator groups',
  params: sxParams(),
  state: sxInitialState,
  normalize: sxNormalize,
  viewState: [...SX_VIEW_KEYS, ...SX_SAMPLE_KEYS, ...SX_DECK_KEYS],
  presets: presets(),
  keyNames: sxKeyNames,
  defPoly: 0,
};
