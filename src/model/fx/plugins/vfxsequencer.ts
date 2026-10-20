// VFX Sequencer (FL: VFX Sequencer, "powered by BLUE ARP"): a pattern
// arpeggiator / step sequencer used inside Patcher. Form: SynthPanel 984 x 560.
// Parameters keep FL's indices and names (read from the plugin): the engine
// settings (Arp mode, input filter, order algorithm, missing-key handling,
// steps, sync, gate, swing, restart, force-to-scale, transpose, randomizers,
// output range...) and six 64-step lanes: ScaleStep (128+), Octave (192+),
// StepType (256+), KeySelect (320+), Velocity (384+), GateStep (448+). FL's
// internal parameters (patch version, program chains, MIDI ports...) are not
// exposed. The 128 built-in programs ("Sequence" list) are FL's own, read
// through the test host; program 0 ("Initial program") gives the defaults.

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';
import { SEQ_PROGRAMS } from './vfx/seqPrograms';

export const STEPS = 64;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** BlueARP note names for the octave numbering setting (0: C-2.., 1: C-1.., 2: C0.. (FL's)). */
export function seqNoteName(k: number, numbering = 2): string {
  return NAMES[((k % 12) + 12) % 12] + (Math.floor(k / 12) - 2 + numbering);
}

export const ARP_MODES = ['Off', 'On', 'Thru', '2 note on/off', '2 note on/thru', '3 note on/off', '3 note on/thru'];
export const SYNC = ['1/64', '1/48', '1/32', '1/24', '1/16', '1/12', '1/8', '1/6', '1/4', '3/64', '3/32', '3/16', '3/8'];
/** Step length of each Sync option as a fraction of a whole note. */
export const SYNC_FRAC = [1 / 64, 1 / 48, 1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 3 / 64, 3 / 32, 3 / 16, 3 / 8];
export const MISSING = ["Don't play", 'Cyclic', 'First note', 'Last note', 'Fixed note'];
export const ORDER = ['By pitch', 'By pitch down', 'As played', 'As played down', 'By velocity', 'By velocity down', 'Chord normalized', 'Chord as played'];
export const IN_QUANT = ['none', '1/16', '1/12', '1/8', '1/6', '1/4', '1/2', '1 bar', '2 bar'];
export const IN_QUANT_FRAC = [0, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 2, 1, 2];
export const RESTART = ['Beat 0', 'Key', '1st key', 'Play'];
export const SCALE_KEYS = ['Off / Note1', 'Detect from chord', 'Fixed, C', 'Fixed, C#', 'Fixed, D', 'Fixed, Eb', 'Fixed, E', 'Fixed, F', 'Fixed, F#', 'Fixed, G', 'Fixed, G#', 'Fixed, A', 'Fixed, Bb', 'Fixed, B'];
export const SCALES = ['Off / Chromatic', 'Detect from chord', 'Major', 'Minor', 'Harmonic minor', 'Melodic minor', 'Pentatonic major', 'Pentatonic minor', 'Pentatonic neutral', 'Pentatonic blues', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'Locrian'];
/** Scale intervals for SCALES[2..14]. */
export const SCALE_STEPS: number[][] = [
  [0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10], [0, 2, 3, 5, 7, 8, 11], [0, 2, 3, 5, 7, 9, 11],
  [0, 2, 4, 7, 9], [0, 3, 5, 7, 10], [0, 2, 5, 7, 10], [0, 3, 5, 6, 7, 10],
  [0, 2, 3, 5, 7, 9, 10], [0, 1, 3, 5, 7, 8, 10], [0, 2, 4, 6, 7, 9, 11], [0, 2, 4, 5, 7, 9, 10], [0, 1, 3, 5, 6, 8, 10],
];
export const SCALE_MODES = ['All notes', 'Semi-transposed'];
export const IN_RANGE_MODES = ['Truncate / default', 'Pass thru / no arping'];
export const OUT_VEL = ['Velocity lane', 'Input note', 'Lane + input note'];
export const MISSING_OCT = ['None', ' -1 octave', ' +1 octave'];
export const GATE_LANE = ['Gate / Step', 'Channel / Step'];
export const STEP_TYPES = ['Off', 'Nrm', 'Rst', 'Tie', 'Chr', 'Rnd'];
export const GATE_STEPS: Record<number, string> = { [-3]: '1/8', [-2]: '1/4', [-1]: '1/2', 0: '-', 1: '2x', 2: '4x', 3: '8x', 4: '16x', 5: '32x' };
export const OCT_NUMBERING = ['C-2 .. G8 (mid C3)', 'C-1 .. G9 (mid C4)', 'C0 .. G10 (mid C5)'];
export const SS_RANGES = [' -12 ... +12', ' 0 ... +12', ' -7 ... +7', '  0 ... +7'];

export const LANES = [
  { id: 'key', name: 'KeySelect', base: 320, min: -1, max: 63, def: 1 },
  { id: 'vel', name: 'Velocity', base: 384, min: 0, max: 127, def: 96 },
  { id: 'oct', name: 'Octave', base: 192, min: -3, max: 127, def: 0 },
  { id: 'gate', name: 'GateStep', base: 448, min: -3, max: 5, def: 0 },
  { id: 'type', name: 'StepType', base: 256, min: 0, max: 5, def: 1 },
  { id: 'scale', name: 'ScaleStep', base: 128, min: -12, max: 12, def: 0 },
] as const;
export type LaneId = (typeof LANES)[number]['id'];
export const laneKey = (l: LaneId, step: number): string => `${l}${step + 1}`;

const signed = (v: number, zero = 'None') => (v === 0 ? zero : v > 0 ? `+${v}` : String(v));

/** KeySelect text: Root, N1..N5, Fix (fixed note); poly bit masks list their notes. */
export function keySelText(v: number, poly = false): string {
  if (v === -1) return 'Fix';
  if (v === 0) return 'Root';
  if (v >= 1 && v <= 5 && !poly) return `N${v}`;
  if (v > 5 || poly) {
    const ns: string[] = [];
    for (let b = 0; b < 6; b++) if (v & (1 << b)) ns.push(b === 0 ? 'R' : `${b}`);
    return ns.length ? ns.join('') : '-';
  }
  return String(v);
}

/** Octave lane text; with poly octave the value is a bit mask of octaves -3..3 (bit 3 = 0). */
export function octText(v: number, poly = false): string {
  if (poly || v > 3) {
    const os: string[] = [];
    for (let b = 0; b < 7; b++) if (v & (1 << b)) os.push(String(b - 3));
    return os.length ? os.join(',') : '-';
  }
  return v === 0 ? '-' : v > 0 ? `+${v}` : String(v);
}

function settings(): FxParamDef[] {
  const opt = (key: string, name: string, index: number, options: string[], def: number): FxParamDef => ({ key, name, index, min: 0, max: options.length - 1, def, options });
  const note = (v: number) => seqNoteName(v);
  return [
    { key: 'midiIn', name: 'MIDI In Channel', index: 1, min: -1, max: 15, def: -1, format: (v) => (v < 0 ? 'All' : String(v + 1)) },
    { key: 'midiOut', name: 'MIDI Out Channel', index: 2, min: 0, max: 15, def: 0, format: (v) => String(v + 1) },
    opt('arpMode', 'Arp Mode', 5, ARP_MODES, 1),
    { key: 'program', name: 'CurProgram', index: 8, min: 0, max: 127, def: 0, format: (v) => SEQ_PROGRAMS[v]?.[0] ?? String(v) },
    opt('inRangeMode', 'Input range mode', 16, IN_RANGE_MODES, 0),
    opt('outVelMode', 'Output velo mode', 17, OUT_VEL, 0),
    { key: 'steps', name: 'Steps', index: 40, min: 0, max: 64, def: 16 },
    { key: 'gate', name: 'Gate', index: 41, min: 1, max: 125, def: 90, format: (v) => `${Math.round(v * 0.8)}%` },
    opt('sync', 'Sync', 42, SYNC, 4),
    opt('latch', 'Latch', 43, ['Off', 'On'], 0),
    opt('missKey', 'Missing key subst.', 44, MISSING, 0),
    { key: 'inLow', name: 'Input range (low)', index: 45, min: 0, max: 127, def: 0, format: note },
    { key: 'inHigh', name: 'Input range (high)', index: 46, min: 0, max: 127, def: 127, format: note },
    { key: 'outLow', name: 'Output rng wrap (low)', index: 47, min: 0, max: 127, def: 0, format: note },
    { key: 'outHigh', name: 'Output rng wrap (high)', index: 48, min: 0, max: 127, def: 127, format: note },
    opt('order', 'Order algorithm', 49, ORDER, 0),
    { key: 'fixedKey', name: 'Fixed key', index: 50, min: 0, max: 127, def: 57, format: note },
    { key: 'transOct', name: 'Master transpose oct', index: 51, min: -3, max: 3, def: 0, bipolar: true, format: (v) => signed(v) },
    opt('inQuant', 'Input quantize', 52, IN_QUANT, 1),
    { key: 'transSemi', name: 'Master transpose semi', index: 53, min: -12, max: 12, def: 0, bipolar: true, format: (v) => signed(v) },
    opt('autoScroll', 'Page scroll', 54, ['Off', 'On'], 0),
    { key: 'swing', name: 'Swing', index: 55, min: -50, max: 50, def: 0, bipolar: true, format: (v) => `${v * 2}%` },
    opt('restart', 'Restart On', 56, RESTART, 0),
    opt('scaleKey', 'Force scale: key', 57, SCALE_KEYS, 0),
    opt('scale', 'Force scale: scale', 58, SCALES, 0),
    opt('scaleMode', 'Force scale: mode', 59, SCALE_MODES, 0),
    opt('pageLock', 'Page lock', 60, ['Off', 'On'], 0),
    { key: 'wrapLow', name: 'Input rng wrap (low)', index: 63, min: 0, max: 127, def: 0, format: note },
    { key: 'wrapHigh', name: 'Input rng wrap (high)', index: 64, min: 0, max: 127, def: 127, format: note },
    opt('polyOct', 'Polyphonic octave', 65, ['Off', 'On'], 0),
    opt('polyKey', 'Polyphonic key sel.', 66, ['Off', 'On'], 0),
    opt('missOct', 'Missing key octave', 67, MISSING_OCT, 0),
    opt('gateLane', 'GATE lane mode', 69, GATE_LANE, 0),
    { key: 'randVel', name: 'Randomize velocity', index: 70, min: 0, max: 100, def: 0, format: (v) => `${v}%` },
    { key: 'randGate', name: 'Randomize gate per step', index: 71, min: 0, max: 100, def: 0, format: (v) => `${v}%` },
    { key: 'randStart', name: 'Randomize start time', index: 72, min: 0, max: 100, def: 0, format: (v) => `${v}%` },
    { key: 'smartBend', name: 'Smart bend', index: 80, min: -7, max: 7, def: 0, bipolar: true, format: (v) => signed(v) },
  ];
}

function lanes(): FxParamDef[] {
  const out: FxParamDef[] = [];
  for (const l of LANES) {
    for (let i = 0; i < STEPS; i++) {
      const fmt = l.id === 'key' ? (v: number) => keySelText(v) : l.id === 'oct' ? (v: number) => octText(v)
        : l.id === 'type' ? (v: number) => STEP_TYPES[v] ?? String(v) : l.id === 'gate' ? (v: number) => GATE_STEPS[v] ?? String(v)
        : l.id === 'scale' ? (v: number) => (v === 0 ? '-' : signed(v)) : (v: number) => String(v);
      out.push({ key: laneKey(l.id, i), name: `${l.name}_${String(i + 1).padStart(2, '0')}`, index: l.base + i, min: l.min, max: l.max, def: l.def, format: fmt });
    }
  }
  return out;
}

const PARAMS = [...settings(), ...lanes()];
const BY_INDEX = new Map(PARAMS.map((p) => [p.index!, p.key]));
const LANE_OF: Record<string, LaneId> = { scale: 'scale', oct: 'oct', type: 'type', key: 'key', vel: 'vel', gate: 'gate' };

/** A built-in program as parameter values (only what differs from the defaults). */
export function programParams(n: number): Record<string, number> {
  const pr = SEQ_PROGRAMS[n];
  const out: Record<string, number> = { program: n };
  if (!pr) return out;
  for (const [idx, v] of Object.entries(pr[1])) { const k = BY_INDEX.get(Number(idx)); if (k) out[k] = v; }
  for (const [lane, csv] of Object.entries(pr[2])) {
    const id = LANE_OF[lane];
    if (!id || !csv) continue;
    csv.split(',').forEach((s, i) => { if (i < STEPS) out[laneKey(id, i)] = Number(s); });
  }
  return out;
}

export const def: FxPluginDef = {
  id: 'vfxsequencer',
  name: 'VFX Sequencer',
  category: 'Patcher',
  width: 984,
  height: 560,
  description: 'Pattern arpeggiator and step sequencer, powered by BlueARP (Patcher)',
  params: PARAMS,
  state: () => ({ dispMode: 2, page: 0, octNum: 2, ssRange: 0 }),
  presets: SEQ_PROGRAMS.map((p, n): FxPreset => ({ name: p[0], params: programParams(n) })),
};
