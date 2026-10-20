// Transistor Bass (FL: Transistor Bass, Plugin database > Generators > Synth
// classic): FL's TB-303 emulation (two engines: "V1 Legacy" and "V2" with
// extended or TB-303 cutoff ranges), with distortion, delay, reverb and a
// 16-step sequencer with 128 programs / patches / sequences.
// From FL 2026's binary: the form (SynthPanel 700 x 600, four panel layouts),
// the parameter list (42 parameters, names, ranges, value texts verified with
// full test-host sweeps: FL rounds half away from zero and never prints -0),
// and the three factory presets (state format decoded from the engine;
// "Factory programs" is also the plugin database entry FL loads on insertion,
// so it is the default state here). See docs/research/gen/transistorbass.md.

import type { FxParamDef } from '../../fx/types';
import type { GenPluginDef } from '../types';
import {
  TB_PARAM_KEYS, TB_PARAM_MAX, TB_SYNC_TEXT, flFix, type TbBank, type TbStateLike,
} from './transistorbass/data';
import { TB_FACTORY } from './transistorbass/factory';

const NAMES = [
  'Tuning', 'Waveform', 'Cutoff', 'Cutoff key follow', 'Resonance', 'Envelope mod', 'Decay', 'Accent', 'Volume', 'HP',
  'Minimum decay', 'Pulse width', 'LFO -> Pulse width rate', 'LFO -> Pulse width amount', 'Reverb', 'Reverb low cut',
  'Reverb high cut', 'Reverb predelay', 'Reverb predelay feedback', 'Reverb room size', 'Reverb diffusion', 'Reverb decay',
  'Reverb high damp', 'Reverb width', 'Reverb dry amount', 'Reverb early reflection amount', 'Reverb wet amount',
  'Distortion', 'Distortion HP', 'Distortion drive', 'Distortion tone', 'Distortion volume', 'Delay', 'Delay BPM sync',
  'Delay amount', 'Delay time', 'Delay right tap point', 'Delay feedback', 'Delay tone', 'Delay stereo', 'Clicks', '303 Pulse',
];

const pct = (v: number) => `${flFix((v / 65536) * 100, 1)}%`;
const onOff = ['Off', 'On'];

/** FL's value text of parameter `i`. */
export function tbFormat(i: number, v: number, st?: Record<string, unknown>): string {
  switch (i) {
    case 0: return `${flFix((v - 12288) / 1024, 2)} Semitones`;
    case 1: return v < 32768 ? `${flFix(100 - (50 * v) / 32768, 0)}% Pulse` : `${flFix(50 + (50 * (v - 32768)) / 32768, 0)}% Saw`;
    case 3: return `${flFix(((v - 32768) / 32768) * 100, 1)}%`;
    case 11: return `${flFix(50 + (45 * v) / 65536, 1)}%`;
    case 14: case 27: case 32: case 33: case 41: return onOff[v >= 0.5 ? 1 : 0];
    case 24: case 25: case 26: return v <= 0 ? '-inf' : `${flFix((42 * v) / 65536 - 36, 1)} dB`;
    case 35: {
      const sync = st ? Number(st.delaySync ?? 1) >= 0.5 : true;
      if (sync) return TB_SYNC_TEXT[Math.max(0, Math.min(17, Math.floor((v * 17) / 65536 + 0.5)))];
      return `${flFix(10 + (490 * v) / 65536, 1)}ms`;
    }
    default: return pct(v);
  }
}

function parseFor(i: number): ((typed: number) => number) | undefined {
  switch (i) {
    case 0: return (t) => Math.round(t * 1024 + 12288);
    case 3: return (t) => Math.round((t / 100) * 32768 + 32768);
    case 11: return (t) => Math.round(((t - 50) / 45) * 65536);
    case 24: case 25: case 26: return (t) => Math.round(((t + 36) / 42) * 65536);
    case 1: case 14: case 27: case 32: case 33: case 35: case 41: return undefined;
    default: return (t) => Math.round((t / 100) * 65536);
  }
}

const INSERT = TB_FACTORY['Factory programs'];

const PARAMS: FxParamDef[] = TB_PARAM_KEYS.map((key, i) => {
  const max = TB_PARAM_MAX[i];
  const p: FxParamDef = {
    key, name: NAMES[i], index: i, min: 0, max, def: INSERT.params[i],
    format: (v, st) => tbFormat(i, v, st),
  };
  const parse = parseFor(i);
  if (parse) p.parse = parse;
  if (max === 1) p.options = onOff;
  if (i === 3) p.bipolar = true;
  return p;
});

/** The state a bank gives (non-parameter fields). */
export function tbBankState(b: TbBank): Record<string, unknown> {
  return {
    engine: b.engine, seqOn: b.seqOn, af: b.af, prog: b.prog, panels: b.panels, theme: b.theme,
    progs: {}, base: b.base.slice(), patches: structuredClone(b.patches), edits: structuredClone(b.edits),
    seqs: structuredClone(b.seqs), playing: false,
  };
}

function bankPreset(name: string): { name: string; params: Record<string, unknown> } {
  const b = TB_FACTORY[name];
  const params: Record<string, unknown> = tbBankState(b);
  TB_PARAM_KEYS.forEach((k, i) => { params[k] = b.params[i]; });
  return { name, params };
}

const int = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const def: GenPluginDef = {
  id: 'transistorbass',
  name: 'Transistor Bass',
  category: 'Synth classic',
  notes: 'events',
  velocity: 'plugin',
  levels: 'plugin',
  defPoly: 0,
  width: 700,
  height: 600,
  description: 'TB-303 bass synthesizer with step sequencer',
  params: PARAMS,
  viewState: [],
  state: () => tbBankState(INSERT),
  normalize: (p) => {
    const st = p as TbStateLike;
    return {
      ...p,
      engine: int(st.engine, 0, 0, 2),
      seqOn: typeof st.seqOn === 'boolean' ? st.seqOn : true,
      af: typeof st.af === 'boolean' ? st.af : true,
      prog: int(st.prog, 65, 0, 127),
      panels: int(p.panels, 3, 0, 3),
      theme: int(p.theme, 1, 0, 3),
      progs: obj(st.progs),
      base: Array.isArray(st.base) && st.base.length === 42 ? st.base : INSERT.base.slice(),
      patches: obj(st.patches),
      edits: obj(st.edits),
      seqs: obj(st.seqs),
      playing: false,
    };
  },
  presets: ['Empty', 'Factory programs', 'Sequencer off'].map(bankPreset),
};
