// Toxic Biohazard (FL: Toxic Biohazard, Plugin database > Generators > Synth classic):
// Image-Line's six-operator FM / additive synthesizer: wavetable operators with
// 128-harmonic waveforms, an FM matrix, unison, filter, two LFOs, a modulation
// matrix, a 64-step chord-following sequencer, two effect slots (flanger, chorus,
// reverb, delay, lo-fi, phaser) and an 8-band EQ.
// From FL 2026: the parameter list (294 synth parameters, MIDI CC 0..127 and
// channel aftertouch: 423 parameters, names and value texts from FL's own text
// code, checked against test-host sweeps), the engine's hidden settings (filter
// mode, polyphony, unison voices, waveforms, LFO sync, modulation matrix) and FL's
// 790 presets (state blobs decoded). FL's plugin database entry equals the first
// factory preset, "Ambient Textures/AquaTone ToTc": the insertion state.
// State `sample`: the pool sample with FL's built-in harmonic tables (waveforms 6..32),
// imported from the user's own FL install (plugin menu); without it the engine uses
// synthesized substitutes.
// See docs/research/gen/toxicbiohazard.md.

import type { FxParamDef } from '../../fx/types';
import type { GenPluginDef } from '../types';
import {
  TX_INSERT_PRESET, TX_PARAM_COUNT, TX_PARAM_KEYS, TX_PARAM_NAMES, TX_PRESET_NAMES, txFormat, txPresetState,
} from './toxicbiohazard/data';

const INSERT = txPresetState(TX_INSERT_PRESET);

const BIPOLAR = (i: number): boolean => i === 2 || i === 11 || i === 23 || (i >= 31 && i <= 48) || (i >= 97 && i <= 102)
  || (i >= 145 && i <= 156) || (i >= 228 && i <= 235);

const PARAMS: FxParamDef[] = TX_PARAM_KEYS.map((key, i) => {
  const def = i < TX_PARAM_COUNT ? Number(INSERT[key]) : 0;
  const p: FxParamDef = { key, name: TX_PARAM_NAMES[i], index: i, min: 0, max: 256, def, step: 0, format: (v) => txFormat(i, v) };
  if (BIPOLAR(i)) p.bipolar = true;
  return p;
});

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const HIDDEN_DEFAULT = (INSERT.hidden as number[]).slice();

export const def: GenPluginDef = {
  id: 'toxicbiohazard',
  name: 'Toxic Biohazard',
  category: 'Synth classic',
  notes: 'events',
  velocity: 'plugin',
  levels: 'plugin',
  defPoly: 32,
  width: 910,
  height: 594,
  description: 'FM / additive synthesizer with six operators, sequencer and effects',
  params: PARAMS,
  viewState: ['sample', 'txPage'],
  state: () => ({
    hidden: HIDDEN_DEFAULT.slice(),
    waves: (INSERT.waves as (number[] | 0)[]).map((w) => (Array.isArray(w) ? w.slice() : 0)),
    ccMap: new Array(TX_PARAM_COUNT).fill(-1),
    sample: '',
  }),
  normalize: (p) => {
    const q: Record<string, unknown> = { ...p };
    if (typeof q.__tx === 'number') {
      const st = txPresetState(q.__tx);
      delete q.__tx;
      Object.assign(q, st);
    }
    const h = Array.isArray(q.hidden) ? q.hidden : [];
    q.hidden = HIDDEN_DEFAULT.map((d, i) => num(h[i], d));
    const w = Array.isArray(q.waves) ? q.waves : [];
    q.waves = Array.from({ length: 8 }, (_, k) => {
      const a = w[k];
      return Array.isArray(a) && a.length >= 256 ? a.slice(0, 256).map((x) => num(x, 0)) : 0;
    });
    const m = Array.isArray(q.ccMap) ? q.ccMap : [];
    q.ccMap = Array.from({ length: TX_PARAM_COUNT }, (_, i) => Math.max(-1, Math.min(127, Math.trunc(num(m[i], -1)))));
    q.sample = typeof q.sample === 'string' ? q.sample : '';
    return q;
  },
  presets: TX_PRESET_NAMES.map((name, i) => ({ name, params: { __tx: i } })),
};
