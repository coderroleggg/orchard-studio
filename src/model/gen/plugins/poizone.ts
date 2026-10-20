// PoiZone (FL: PoiZone, Plugin database > Generators > Synth classic): Image-Line's
// virtual-analog synthesizer: two oscillators (saw / pulse, sync, ring mod) and
// noise, a 4-pole LP / BP / HP filter, envelope and LFO modulation, unison,
// glide, arpeggiator, trance gate, chorus and delay.
// From FL 2026: the parameter list (FL's 74 synth parameters, MIDI CC 0..127 and
// channel aftertouch: 203 parameters, names, raw ranges, value texts from full
// test-host sweeps), the editor form (855 x 521), the engine's hidden settings
// (unison voices, polyphony, arpeggiator / gate speed, pitch-bend range, LFO tempo
// sync) and FL's 385 presets (state blobs decoded). FL's plugin database entry
// equals the factory preset "ARP Classic VA ToTc": the insertion state. See
// docs/research/gen/poizone.md.

import type { FxParamDef } from '../../fx/types';
import type { GenPluginDef } from '../types';
import {
  PZ_ENUMS, PZ_HIDDEN_DEFAULT, PZ_INSERT_PRESET, PZ_PARAM_COUNT, PZ_PARAM_KEYS, PZ_PARAM_NAMES, PZ_PRESET_NAMES, PZ_SWITCHES,
  pzFormat, pzMax, pzParse, pzPresetState,
} from './poizone/data';

const INSERT = pzPresetState(PZ_INSERT_PRESET);

const PARAMS: FxParamDef[] = PZ_PARAM_KEYS.map((key, i) => {
  const max = i < PZ_PARAM_COUNT ? pzMax(i) : 256;
  const def = i < PZ_PARAM_COUNT ? Number(INSERT[key]) : 0;
  const p: FxParamDef = { key, name: PZ_PARAM_NAMES[i], index: i, min: 0, max, def, format: (v) => pzFormat(i, v) };
  const parse = pzParse(i);
  if (parse) p.parse = parse;
  if (PZ_SWITCHES.has(i)) p.options = i === 0 || i === 4 ? ['SAW', 'PULSE'] : ['Off', 'On'];
  if (i === 6 || i === 10 || i === 16 || i === 17 || i === 26 || i === 43) p.bipolar = true;
  if (PZ_ENUMS[i]) p.step = 1;
  return p;
});

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export const def: GenPluginDef = {
  id: 'poizone',
  name: 'PoiZone',
  category: 'Synth classic',
  notes: 'events',
  velocity: 'plugin',
  levels: 'plugin',
  defPoly: 0,
  width: 855,
  height: 521,
  description: 'Virtual analog synthesizer with arpeggiator, trance gate, chorus and delay',
  params: PARAMS,
  viewState: [],
  state: () => ({ hidden: (INSERT.hidden as number[]).slice(), ccMap: new Array(74).fill(-1) }),
  normalize: (p) => {
    const q: Record<string, unknown> = { ...p };
    if (typeof q.__pz === 'number') {
      const st = pzPresetState(q.__pz);
      delete q.__pz;
      Object.assign(q, st);
    }
    const h = Array.isArray(q.hidden) ? q.hidden : [];
    q.hidden = PZ_HIDDEN_DEFAULT.map((d, i) => num(h[i], d));
    const m = Array.isArray(q.ccMap) ? q.ccMap : [];
    q.ccMap = Array.from({ length: 74 }, (_, i) => Math.max(-1, Math.min(127, Math.trunc(num(m[i], -1)))));
    return q;
  },
  presets: PZ_PRESET_NAMES.map((name, i) => ({ name, params: { __pz: i } })),
};
