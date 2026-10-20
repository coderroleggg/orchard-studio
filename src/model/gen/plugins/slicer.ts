// Slicer (FL: Fruity Slicer, Plugin database > Generators > Drum): beat-sliced loop player.
// A loaded sample is cut into slices (FL's beat detector, beat divisions or the file's own
// slices); each slice plays on its key, the beat can be dumped to the piano roll as a score,
// and the slices can be stretched (TS), pitch-shifted (PS), faded (ATT / DEC), declicked and
// reversed. See docs/research/gen/slicer.md.
//
// From FL 2026's binary (Fruity Slicer_x64.dylib, arm64 slice, TTestPlug):
// - FL's parameter list is only the INS block (envelopes, LFOs, filter: FL pushes the
//   channel's INS settings into the plugin), which is the channel's INS tab here (`ins`), so
//   `params` is empty; the plugin's settings are its saved state (SaveRestoreState 0x61660,
//   version 16), as JSON here (./slicer/state.ts);
// - editor form: SynthPanel 377 x 330;
// - a new instance gets the plugin database state (Fruity Slicer.fst): no sample, stretching
//   method Transient, AUTO-DUMP, DECLICK and AUTO-FIT on; DefPoly 0 (unlimited).

import type { GenPluginDef } from '../types';
import { defaultSlicerState, normalizeSlicerState, sliceKeyMap, sliceName, slicerState } from './slicer/state';

export const def: GenPluginDef = {
  id: 'slicer',
  name: 'Slicer',
  category: 'Drum',
  notes: 'voices',
  ins: true,
  // FL's channel sampler processing inside the plugin applies the voice levels (float32 pan
  // law, slope-limited ramps) and the release declick
  levels: 'plugin',
  defPoly: 0,
  width: 377,
  height: 330,
  description: 'Beat slicer: plays the slices of a loop from the piano roll',
  params: [],
  state: () => ({ ...defaultSlicerState() }),
  normalize: (p) => normalizeSlicerState(p),
  // editor view: selected slice, AUTO wheels (not saved by FL), FL's saved view value
  viewState: ['sel', 'autoLow', 'autoHigh'],
  // FL's GetName(FPN_Semitone): the slice name (or "Slice #n") on each slice's key
  keyNames: (params) => {
    const s = slicerState(params);
    const map = sliceKeyMap(s.slices, s.baseKey);
    const out: Record<number, string> = {};
    for (let k = 0; k < 125; k++) if (map[k] >= 0) out[k] = sliceName(s.slices, map[k]);
    return out;
  },
};
