// GMS (FL: GMS, Plugin database > Generators > Synth classic): the Groove Machine Synth:
// three oscillators playing single-cycle waves (FL's "Synth Waves" or the user's files) as
// band-limited tables, oscillator 1 synced / FM'd / ring-modulated by oscillator 2, noise,
// up to 16 unison voices, a 4-pole LP / BP / HP ladder, two envelopes and two LFOs with
// destinations, the amplitude envelope, MIDI velocity / mod wheel / aftertouch routing, ten
// performance effects (distortion, crusher, flanger, phaser, low / high pass, delay, reverb,
// panner, trancer) with X / Y, glue and LFO each, and a five-band EQ.
// From FL 2026: the parameter list (76 synth parameters that view the engine's 212 internal
// values, MIDI CC 0..127, channel aftertouch: 205 parameters, names and value texts from
// test-host sweeps), FL's 306 presets and the plugin database entry (state chunks decoded).
// GMS renders silence in FL's test host (licence check), so its sound could not be compared
// with FL. See docs/research/gen/gms.md.

import type { FxParamDef } from '../../fx/types';
import type { GenPluginDef } from '../types';
import {
  GMS_ENGINE_COUNT, GMS_PARAM_COUNT, GMS_PARAM_KEYS, GMS_PARAM_NAMES, GMS_PRESET_NAMES, gmsFormat, gmsInsertState, gmsMirror,
  gmsPresetState, type GmsStateLike,
} from './gms/data';

const INSERT = gmsInsertState();

const PARAMS: FxParamDef[] = GMS_PARAM_KEYS.map((key, i) => {
  const def = i < GMS_PARAM_COUNT ? Number(INSERT[key]) : 0;
  const p: FxParamDef = { key, name: GMS_PARAM_NAMES[i], index: i, min: 0, max: 256, def, format: (v) => gmsFormat(i, v) };
  if (i === 21) p.bipolar = true;
  return p;
});

const fin = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export const def: GenPluginDef = {
  id: 'gms',
  name: 'GMS',
  category: 'Synth classic',
  notes: 'events',
  velocity: 'plugin',
  levels: 'plugin',
  defPoly: 16,
  width: 964,
  height: 414,
  description: 'Groove Machine Synth: three-oscillator wavetable synthesizer with unison, filter and performance effects',
  params: PARAMS,
  viewState: ['wavePool', 'fxHold'],
  state: () => ({
    iv: (INSERT.iv as number[]).slice(),
    sel: (INSERT.sel as number[]).slice(),
    waves: (INSERT.waves as string[]).slice(),
    wavePool: {},
  }),
  normalize: (p) => {
    const q: Record<string, unknown> = { ...p };
    if (typeof q.__gms === 'number') {
      const st = gmsPresetState(q.__gms);
      delete q.__gms;
      Object.assign(q, st);
    }
    const iv = Array.isArray(q.iv) ? q.iv : [];
    q.iv = Array.from({ length: GMS_ENGINE_COUNT }, (_, i) => fin(iv[i], (INSERT.iv as number[])[i]));
    const sel = Array.isArray(q.sel) ? q.sel : [];
    q.sel = [0, 1, 2].map((k) => Math.min(Math.max(Math.trunc(fin(sel[k], 0)), 0), k === 0 ? 9 : 1));
    const w = Array.isArray(q.waves) ? q.waves : [];
    q.waves = [0, 1, 2].map((k) => (typeof w[k] === 'string' ? (w[k] as string) : ''));
    const pool = q.wavePool && typeof q.wavePool === 'object' && !Array.isArray(q.wavePool) ? (q.wavePool as Record<string, unknown>) : {};
    q.wavePool = Object.fromEntries(Object.entries(pool).filter(([, v]) => typeof v === 'string'));
    // FL's synth parameters show the internal values they view
    const missing = GMS_PARAM_KEYS.slice(0, GMS_PARAM_COUNT).some((k) => typeof q[k] !== 'number');
    if (missing) gmsMirror(q as GmsStateLike);
    return q;
  },
  presets: GMS_PRESET_NAMES.map((name, i) => ({ name, params: { __gms: i } })),
};
