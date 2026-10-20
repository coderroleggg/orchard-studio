// Fruity Slicer 2 (FL: Fruity Slicer 2, Plugin database > Generators > Drum): a beat
// slicer. A loaded loop is cut into up to 128 slices (FL's beat detector, the file's
// own markers, or even beat divisions), each played by its own key from C5 up, with
// per-slice gain, pan, attack, release, transpose, detune, play options (play to end,
// hold, reverse), a 12 dB state variable filter, a global filter, chromatic mode,
// time stretching (None / Resample / Stretch), monophonic mode, and the score dumped
// to the piano roll (docs/research/gen/slicer2.md).
//
// From FL 2026's binaries: the 1040 parameters (test host info / sweeps; indices 5..15
// are unused by FL's engine and left out), the editor form (TSynthEditorForm 1000 x 300),
// the engine (engine.dylib: MyPlugin, slicer instance, voices) and the state ("slc1" v4).
// FL ships no sample: the plugin starts empty like FL's plugin database state
// (Plugin database/Generators/Drum/Fruity Slicer 2.fst = Default.fst), and the user
// loads audio (Browser drag and drop, OS files, the Load sample button).

import type { GenPluginDef } from '../types';
import {
  SL2_BLOCKS, SL2_BLOCK_NAMES, SL2_BLOCK_RANGE, SL2_MAX, flDefaultState, normalizeSlicer2State, sl2Index,
  sl2Key, sl2Norm, sliceKey, slicer2State, type Sl2Block,
} from './slicer2/state';
import { gainFromDb, gainText, panText, pctText } from './slicer2/texts';

type P = GenPluginDef['params'][number];

const pct = (max: number) => (x: number) => pctText(sl2Norm(x, 0, max));

function sliceParam(b: Sl2Block, i: number): P {
  const [min, max, def] = SL2_BLOCK_RANGE[b];
  const base: P = { key: sl2Key(b, i), name: `Slice ${i + 1} ${SL2_BLOCK_NAMES[b]}`, index: sl2Index(b, i), min, max, def };
  switch (b) {
    case 't': return { ...base, bipolar: true, format: (x) => `${Math.round(x)} ST` };
    case 'd': return { ...base, bipolar: true, format: (x) => `${Math.round(x) - 100} Cents`, parse: (t) => t + 100 };
    case 'g': return { ...base, format: (x) => gainText(sl2Norm(x, 0, max)), parse: (t) => gainFromDb(t) * max };
    case 'p': return { ...base, bipolar: true, format: (x) => panText(sl2Norm(x, 0, max)), parse: (t) => (t / 200 + 0.5) * max };
    default: return { ...base, format: pct(max), parse: (t) => (t / 100) * max };
  }
}

function params(): P[] {
  const out: P[] = [
    { key: 'mono', name: 'Monophonic', index: 0, min: 0, max: 1, def: 0, options: ['Off', 'On'] },
    { key: 'cutoff', name: 'Cutoff', index: 1, min: 0, max: 100000, def: 100000, format: pct(100000), parse: (t) => t * 1000 },
    { key: 'res', name: 'Res', index: 2, min: 0, max: 100000, def: 0, format: pct(100000), parse: (t) => t * 1000 },
    { key: 'transpose', name: 'Transpose', index: 3, min: -24, max: 24, def: 0, bipolar: true, format: (x) => `${Math.round(x)} ST` },
    { key: 'detune', name: 'Detune', index: 4, min: 0, max: 200, def: 100, bipolar: true, format: (x) => `${Math.round(x) - 100} Cents`, parse: (t) => t + 100 },
  ];
  for (const b of SL2_BLOCKS) for (let i = 0; i < SL2_MAX; i++) out.push(sliceParam(b, i));
  return out;
}

export const def: GenPluginDef = {
  id: 'slicer2',
  name: 'Slicer 2',
  category: 'Drum',
  notes: 'events',
  // FL's engine takes the note velocity from InitLevels.Vol and the channel volume /
  // panning as FPE_MIDI_Vol / FPE_MIDI_Pan events (FPF_MIDIOut plugin), not from FinalLevels.Vol
  velocity: 'plugin',
  defPoly: 16,
  width: 1000,
  height: 300,
  description: 'Beat slicer: loads a loop, slices it and plays each slice from its own key',
  params: params(),
  state: () => flDefaultState(),
  normalize: (p) => normalizeSlicer2State(p),
  viewState: ['sel', 'bank', 'filterSlice'],
  // Default.fst = the plugin database state: an empty slicer with FL's defaults
  presets: [{ name: 'Default', params: flDefaultState() }],
  // FL's GetName(FPN_Semitone) (wrapper 0x6af40): the slice's marker name, or "Slice #n"
  keyNames: (p) => {
    const s = slicer2State(p);
    const out: Record<number, string> = {};
    for (let i = 0; i < s.slices.length; i++) {
      const k = sliceKey(s.slices, s.baseKey, i);
      if (k >= 0 && k <= 127) out[k] = s.slices[i].name || `Slice #${i + 1}`;
    }
    return out;
  },
};
