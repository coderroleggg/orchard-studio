// Patcher as an instrument (FL: Patcher, Generators > Patcher): the same modular
// host as the effect (src/model/fx/plugins/patcher.ts), living in a Channel Rack
// channel. From FL Studio delivers the channel's notes as events ("Notes", plus
// the "Port p" outputs for MIDI Out ports), the map holds generators and effects
// (and VFX note processors), and To FL Studio outputs the channel's audio.
// Same form as the effect: SynthPanel 1001 x 591. The channel's state is
// `{ $graph }`: the effect's graph with `gen: true` (no audio input on From FL
// Studio; FL's generator Default.fst has no audio link and no module apart from
// the empty Control Surface, which this clone leaves out as in the effect).
//
// FL flags (test host: `info gen:Patcher`): Generator, GetNoteInput, WantNewTick,
// MIDIOut, NewVoiceParams; Gen_Render + TriggerVoice/Voice_Release/Voice_Kill/
// Voice_ProcessEvent/MIDIIn/MIDITick; DefPoly 0. The plugin takes note voices and
// mixes its hosted plugins itself, which is the framework's 'events' mode: the
// channel does its note handling (key range, arpeggiator, echo, polyphony, glides,
// levels) and Patcher gets note on / off events with their live levels.
// See docs/research/gen/patcher.md.

import type { GenPluginDef } from '../types';
import { GRAPH_KEY, defaultGraph, normalizeGraph } from '../../fx/plugins/patcher/graph';

export const def: GenPluginDef = {
  id: 'patcher',
  name: 'Patcher',
  category: 'Patcher',
  notes: 'events',
  defPoly: 0,
  width: 1001,
  height: 591,
  description: 'Chain instruments, effects and note processors into a modular patch',
  params: [],
  state: () => ({ [GRAPH_KEY]: defaultGraph(true) }),
  normalize: (p) => ({ ...p, [GRAPH_KEY]: normalizeGraph(p[GRAPH_KEY], true) }),
};
