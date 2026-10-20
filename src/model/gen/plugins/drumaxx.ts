// Drumaxx (FL: Drumaxx, Plugin database > Generators > Drum; by Maxx Claster):
// a 16-pad physical-modelling drum machine: per pad Volume, Panning, Mute,
// Solo, Key and the 38 Drumpad parameters, cut groups, mixer track offsets and
// names; the master section (Master Level, 8-band EQ, limiter) and the
// performance sequencer (16 patterns, Swing) (docs/research/gen/drumaxx.md).
//
// From FL 2026's binaries: the 719 parameters, names and value texts (test host
// sweeps: every text matches the formats below), the editor form
// (Drumaxx_x64.dylib TSynthEditorForm 762 x 614), the engine (engine.dylib
// DMSynth) and the kit format. Kits (FL's .fst states: parameters, patterns,
// pad names, cut groups, offsets) are kept exactly (./drumaxx/kits.ts): the 131
// factory presets and, for a fresh instance, FL's plugin database state
// (Plugin database/Generators/Drum/Drumaxx.fst, "Default Kit").

import type { GenPluginDef } from '../types';
import { DX_GLOBAL, DX_PAD_LOCAL, DX_PADS, dxEmptyPattern, dxKey, dxRaw, type DxPattern } from './drumaxx/keys';
import { DX_PRESET_NAMES, dxKitState } from './drumaxx/state';
import { DP_TARGETS } from './drumpad';

export { dxKey, DX_PADS, DX_PAD_LOCAL, DX_GLOBAL };

type P = GenPluginDef['params'][number];

const LOCAL_NAMES = ['Volume', 'Panning', 'Mute', 'Solo', 'Key', 'Mallet retrig', 'Retrig', 'Mallet amplitude', 'Mallet decay', 'Mallet noise',
  'Mallet noise RP', 'Membrane decay', 'Membrane cutoff', 'Membrane tension', 'Membrane phase', 'Membrane material', 'Membrane size',
  'Membrane shape', 'LOW frequency', 'LOW reso', 'SOF frequency', 'SOF decay', 'SOF level', 'MID frequency', 'MID level', 'MID res',
  'MID frequency mod', 'MID level mod', 'MID attack', 'HIGH frequency', 'HIGH level', 'HIGH res', 'Lo-Fi', 'Hold', 'Pitch',
  'Velocity mod 1 source', 'Velocity mod 2 source', 'Velocity mod 3 source', 'Velocity mod 4 source', 'Velocity mod 1 value',
  'Velocity mod 2 value', 'Velocity mod 3 value', 'Velocity mod 4 value'];
const GLOBAL_NAMES = ['Master Level', 'Swing', 'EQ Enable', 'EQ Band 1', 'EQ Band 2', 'EQ Band 3', 'EQ Band 4', 'EQ Band 5', 'EQ Band 6', 'EQ Band 7',
  'EQ Band 8', 'Limiter Enable', 'Limiter Gain', 'Limiter Release'];

/** The engine's own defaults (control units) per pad local (Drumpad's: decay 0.9, cutoff 0.35, tension 0.3). */
const LOCAL_DEFS = [186.88, 128, 0, 0, 0, 0, 0, 128, 128, 0, 0, 230.4, 89.6, 76.8, 128, 128, 256, 256, 0, 0, 128, 128, 0, 128, 128, 0, 128, 128, 128,
  128, 128, 0, 0, 256, 128, 0, 0, 0, 0, 0, 0, 0, 0];
const GLOBAL_DEFS = [128, 0, 0, 128, 128, 128, 128, 128, 128, 128, 128, 0, 0, 0];

const BIP_LOCAL = new Set([1, 24, 26, 27, 30, 34]);
const SWITCH_LOCAL = new Set([2, 3, 5]);
const RETRIG = ['0', 'I', 'II', 'III'];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** General MIDI drum names FL adds to the keys 35..81. */
const GM = ['Acoustic Bass Drum', 'Bass Drum 1', 'Side Stick', 'Acoustic Snare', 'Hand Clap', 'Electric Snare', 'Low Floor Tom', 'Closed Hi-Hat',
  'High Floor Tom', 'Pedal Hi-Hat', 'Low Tom', 'Open Hi-Hat', 'Low-Mid Tom', 'Hi-Mid Tom', 'Crash Cymbal 1', 'High Tom', 'Ride Cymbal 1',
  'Chinese Cymbal', 'Ride Bell', 'Tambourine', 'Splash Cymbal', 'Cowbell', 'Crash Cymbal 2', 'Vibraslap', 'Ride Cymbal 2', 'Hi Bongo', 'Low Bongo',
  'Mute Hi Conga', 'Open Hi Conga', 'Low Conga', 'High Timbale', 'Low Timbale', 'High Agogo', 'Low Agogo', 'Cabasa', 'Maracas', 'Short Whistle',
  'Long Whistle', 'Short Guiro', 'Long Guiro', 'Claves', 'Hi Wood Block', 'Low Wood Block', 'Mute Cuica', 'Open Cuica', 'Mute Triangle',
  'Open Triangle'];

/** FL's key text: note name (60 = C5), with the General MIDI drum name for 35..81. */
export function dxKeyText(k: number): string {
  const n = Math.max(0, Math.round(k));
  const name = `${NOTE[n % 12]}${Math.floor(n / 12)}`;
  return n >= 35 && n <= 81 ? `${name} - ${GM[n - 35]}` : name;
}

const pct = (v: number) => `${((v / 256) * 100).toFixed(1)}%`;
const bip = (v: number) => `${((v / 128 - 1) * 100).toFixed(1)}%`;

/**
 * FL's value text of pad local j. FL's wrapper shows whole numbers: a kit's values truncated
 * (61.7% for 158.72), Retrig's four positions rounded (85.33: "0", 170.67: "II").
 */
export function dxLocalText(j: number, x: number): string {
  const v = j === 6 ? Math.round(x) : Math.trunc(x);
  if (j === 4) return dxKeyText(v);
  if (j >= 35 && j <= 38) return v === 0 ? ' ---' : ` ${DP_TARGETS[v] ?? ''}`;
  if (SWITCH_LOCAL.has(j)) return v ? 'On' : 'Off';
  if (j === 6) return RETRIG[Math.min(3, Math.trunc(Math.fround(Math.fround(v * 0.00390625) * 3)))];
  return BIP_LOCAL.has(j) ? bip(v) : pct(v);
}

/** FL's value text of global g (0 = Master Level). */
export function dxGlobalText(g: number, x: number): string {
  const v = Math.trunc(x);
  if (g === 2 || g === 11) return v ? 'On' : 'Off';
  return g >= 3 && g <= 10 ? bip(v) : pct(v);
}

function params(): P[] {
  const out: P[] = [];
  for (let k = 0; k < DX_PADS; k++) {
    for (let j = 0; j < 43; j++) {
      const raw = dxRaw(j);
      out.push({
        key: dxKey(k, j), name: `Channel ${k + 1}: ${LOCAL_NAMES[j]}`, index: 44 * k + j, min: 0, max: j === 4 ? 126 : raw ? 28 : 256,
        def: LOCAL_DEFS[j], bipolar: BIP_LOCAL.has(j), format: (x) => dxLocalText(j, x),
        options: j >= 35 && j <= 38 ? DP_TARGETS : undefined,
        parse: raw || SWITCH_LOCAL.has(j) || j === 6 ? undefined : (t) => (BIP_LOCAL.has(j) ? (t / 100 + 1) * 128 : (t / 100) * 256),
      });
    }
  }
  DX_GLOBAL.forEach((key, g) => out.push({
    key, name: GLOBAL_NAMES[g], index: 705 + g, min: 0, max: 256, def: GLOBAL_DEFS[g], bipolar: g >= 3 && g <= 10, format: (x) => dxGlobalText(g, x),
    parse: g === 2 || g === 11 ? undefined : (t) => (g >= 3 && g <= 10 ? (t / 100 + 1) * 128 : (t / 100) * 256),
  }));
  return out;
}

const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : d);

function normPatterns(x: unknown): DxPattern[] {
  const a = Array.isArray(x) ? x : [];
  return Array.from({ length: 16 }, (_, p) => {
    const s = (a[p] ?? {}) as Partial<DxPattern>;
    const e = dxEmptyPattern();
    return { len: num(s.len, e.len, 0, 255), key: num(s.key, e.key, 0, 255), steps: typeof s.steps === 'string' ? s.steps : e.steps };
  });
}

export const def: GenPluginDef = {
  id: 'drumaxx',
  name: 'Drumaxx',
  category: 'Drum',
  notes: 'events',
  velocity: 'plugin',
  width: 762,
  height: 614,
  description: 'Physical-modelling drum machine with 16 pads and a pattern sequencer',
  params: params(),
  // FL's plugin database state ("Default Kit"); view: selected pad / bank / pattern / bar, Play (-1: stopped)
  state: () => ({ ...(dxKitState(0) ?? {}), sel: 0, bank: 0, pat: 0, bar: 0, play: -1 }),
  normalize: (p) => {
    const q: Record<string, unknown> = { ...p };
    if (typeof q.__dx === 'number') {
      const k = dxKitState(q.__dx);
      delete q.__dx;
      if (k) Object.assign(q, k);
    }
    q.patterns = normPatterns(q.patterns);
    const names = Array.isArray(q.padNames) ? q.padNames : [];
    q.padNames = Array.from({ length: 16 }, (_, k) => (typeof names[k] === 'string' ? names[k] : ''));
    const cuts = Array.isArray(q.cuts) ? q.cuts : [];
    q.cuts = Array.from({ length: 16 }, (_, k) => num(cuts[k], 0, 0, 255));
    const offs = Array.isArray(q.offsets) ? q.offsets : [];
    q.offsets = Array.from({ length: 16 }, (_, k) => num(offs[k], 0, -125, 125));
    q.sel = num(q.sel, 0, 0, 15); q.bank = num(q.bank, 0, 0, 1); q.pat = num(q.pat, 0, 0, 15); q.bar = num(q.bar, 0, 0, 3);
    q.play = num(q.play, -1, -1, 15);
    return q;
  },
  viewState: ['sel', 'bank', 'pat', 'bar'],
  presets: DX_PRESET_NAMES.map((name, i) => ({ name, params: { __dx: i + 1 } })),
};
