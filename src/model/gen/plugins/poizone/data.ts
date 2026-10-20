// PoiZone parameter model: FL's 203 parameters (74 synth parameters, MIDI CC
// 0..127, channel aftertouch), their engine values and FL's value texts
// (FL 2026 test-host sweeps: integer texts use banker's rounding, decimal
// texts round half away from zero), and the state fields FL keeps outside
// its parameters (the engine's hidden settings 74..80 and the CC map).

import { PZ_PRESET_DATA, PZ_PRESET_NAMES } from './presets';

export const PZ_PARAM_COUNT = 74;

const GATE_KEYS = Array.from({ length: 16 }, (_, i) => `gate${i + 1}`);
const CC_KEYS = Array.from({ length: 128 }, (_, i) => `cc${i}`);

/** Parameter keys in FL's index order. */
export const PZ_PARAM_KEYS: string[] = [
  'oscAShape', 'oscAPw', 'oscASync', 'oscARing', 'oscBShape', 'oscBPw', 'oscBPitch', 'oscBDetune', 'oscBal', 'noiseBal',
  'egAmt', 'egA', 'egD', 'egS', 'egR', 'gain', 'fine', 'transpose', 'cutoff', 'reso', 'keytrack', 'veltrack',
  'ampA', 'ampD', 'ampS', 'ampR', 'lfoAmt', 'lfoRetrig', 'lfoRate', 'uniDetune', 'uniPan', 'delayOn', 'delayL',
  'delayR', 'delayFb', 'delayMod', 'delayLo', 'delayHi', 'delayWet', 'chorusOn', 'chorusRate', 'chorusDepth',
  'chorusWet', 'mwAmt', 'mono', 'octaver', 'glide', 'gateMix', 'gateSmooth', ...GATE_KEYS, 'egDest', 'filterMode',
  'lfoDest', 'lfoShape', 'arpMode', 'arpRange', 'mwDest', 'glideHeld', 'glideStatic', ...CC_KEYS, 'chanAT',
];

/** FL's parameter names. */
export const PZ_PARAM_NAMES: string[] = [
  'Osc A shape', 'Osc A PW', 'Osc A sync', 'Osc A ring', 'Osc B shape', 'Osc B PW', 'Osc B pitch', 'Osc B detune',
  'Osc balance', 'Noise balance', 'EG amount', 'EG attack', 'EG decay', 'EG sustain', 'EG release', 'Gain', 'Fine tune',
  'Transpose', 'Filter cutoff', 'Filter resolution', 'Filter keytrack', 'Filter veltrk', 'Amplifier attack',
  'Amplifier decay', 'Amplifier sustain', 'Amplifier release', 'LFO amount', 'LFO retrig', 'LFO rate', 'Unison detune',
  'Unison pan', 'Delay on', 'Delay time left', 'Delay time right', 'Delay feedback', 'Delay mod. depth', 'Delay lo-cut',
  'Delay hi-cut', 'Delay wet', 'Chorus on', 'Chorus rate', 'Chorus depth', 'Chorus wet', 'MW amount', 'Monophonic',
  'Octaver', 'Glide time', 'Gate mix', 'Gate smooth', ...Array.from({ length: 16 }, (_, i) => `Gate step ${i + 1}`),
  'Envelope destination', 'Filter mode', 'LFO destination', 'LFO shape', 'Arpegiator mode', 'Arpegiator range',
  'ModWheel destination', 'Glide held', 'Glide static', ...Array.from({ length: 128 }, (_, i) => `MIDI CC ${i}`),
  'Channel Aftertouch',
];

/** FL's switch parameters: raw 0 / 1 (the engine gets the raw value). */
export const PZ_SWITCHES = new Set([0, 2, 3, 4, 27, 31, 39, 44, 45, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 72, 73]);

/** Raw maximum of FL parameter i. */
export const pzMax = (i: number): number => (PZ_SWITCHES.has(i) ? 1 : 256);

/** FL parameter value -> engine value (switches as they are, others / 256). */
export function pzRawToEngine(i: number, raw: number): number {
  return PZ_SWITCHES.has(i) ? raw : Math.fround(raw / 256);
}

/** Engine value -> FL parameter value (exact: presets keep the engine's floats). */
export function pzEngineToRaw(i: number, v: number): number {
  return PZ_SWITCHES.has(i) ? v : v * 256;
}

const f32 = Math.fround;
/** Delphi Round: half to even. */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
const int = (x: number): string => { const r = roundEven(x); return String(r === 0 ? 0 : r); };
/** Delphi %.Nf: half away from zero, no "-0". */
function fix(x: number, n: number): string {
  const s = x.toFixed(n);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}
const q4 = (v: number): number => { const q = f32(v * v); return f32(q * q); };

const EG_DEST = ['CUTOFF', 'FRQ A', 'FRQ AB', 'PW A', 'PW AB'];
const LFO_DEST = ['CUTOFF', 'FRQ A', 'FRQ AB', 'PW A', 'PW AB', 'PAN'];
const LFO_SHAPE = ['SAW', 'PULSE', 'TRIANGLE', 'SINE', 'RND'];
const ARP_MODE = ['OFF', 'UP', 'DOWN', 'UP / DN', 'RND'];
const MW_DEST = ['CUTOFF', 'LFO', 'FRQ A', 'PW A', 'PW AB'];
const FILTER_MODE = ['LP', 'BP', 'HP'];
const sel = (v: number, mul: number, eps: number, list: string[]): string =>
  list[Math.min(Math.max(Math.trunc(f32(f32(v * mul) + f32(eps))), 0), list.length - 1)];

/** FL's value text of parameter i at raw value r. */
export function pzFormat(i: number, r: number): string {
  if (i >= PZ_PARAM_COUNT) return '';
  if (PZ_SWITCHES.has(i)) {
    if (i === 0 || i === 4) return r === 0 ? 'SAW' : 'PULSE';
    return r !== 0 ? 'On' : 'Off';
  }
  const v = f32(r / 256);
  switch (i) {
    case 6: case 17: return String(Math.trunc(f32(f32(v * 48) - 24)) || 0);
    case 7: return String(Math.trunc(f32(v * 50)));
    case 10: case 26: case 43: return `${int((v * 2 - 1) * 100)}%`;
    case 11: case 12: case 14: return `${int(f32(q4(v) * 49995 + 5))}ms`;
    case 15: return `${fix(v * 30 - 20, 2)}dB`;
    case 16: return String(Math.trunc(f32(f32(v * 2 - 1) * 100)) || 0);
    case 22: return `${int(f32(q4(v) * 4999 + 1))}ms`;
    case 23: return `${int(f32(q4(v) * 19999 + 1))}ms`;
    case 25: return `${int(f32(q4(v) * 9985 + 15))}ms`;
    case 28: return `${fix(f32(q4(v) * f32(v * 30)), 2)}Hz`;
    case 32: case 33: return `${Math.trunc(v * 7) + 1}/4`;
    case 40: return `${fix(v * 5 + f32(0.1), 2)}Hz`;
    case 65: return sel(v, 4, 0.0004, EG_DEST);
    case 66: return sel(v, 2, 0.0002, FILTER_MODE);
    case 67: return sel(v, 5, 0.0005, LFO_DEST);
    case 68: return sel(v, 4, 0.0004, LFO_SHAPE);
    case 69: return sel(v, 4, 0.0004, ARP_MODE);
    case 70: return String(Math.min(Math.max(Math.trunc(f32(f32(v * 3) + f32(0.0003))), 0), 3) + 1);
    case 71: return sel(v, 4, 0.0004, MW_DEST);
    default: return `${int(v * 100)}%`;
  }
}

/** Typed value (display units) -> raw value, where FL's text is a plain number. */
export function pzParse(i: number): ((t: number) => number) | undefined {
  switch (i) {
    case 6: case 17: return (t) => ((t + 24) / 48) * 256;
    case 7: return (t) => (t / 50) * 256;
    case 10: case 26: case 43: return (t) => ((t / 100 + 1) / 2) * 256;
    case 15: return (t) => ((t + 20) / 30) * 256;
    case 16: return (t) => ((t / 100 + 1) / 2) * 256;
    default:
      if (PZ_SWITCHES.has(i) || (i >= 65 && i <= 71) || i === 11 || i === 12 || i === 14 || (i >= 22 && i <= 25 && i !== 24) || i === 28 || i === 32 || i === 33 || i === 40 || i >= PZ_PARAM_COUNT) return undefined;
      return (t) => (t / 100) * 256;
  }
}

/** Option lists of the enumerated parameters (raw steps of 256 / n). */
export const PZ_ENUMS: Record<number, string[]> = { 65: EG_DEST, 66: FILTER_MODE, 67: LFO_DEST, 68: LFO_SHAPE, 69: ARP_MODE, 71: MW_DEST };

/** Hidden settings (engine ids 74..80): unison voices / polyphony / arp speed / bend range / gate speed / LFO sync. */
export const PZ_HIDDEN_DEFAULT = [0, 0, 12, 1, 0, 0, 0];
export const PZ_UNISON_STEPS = [1, 2, 3, 4, 8, 12, 16];
export const PZ_SPEED_TEXT = ['1/32', '1/16', '1/8', '3/16', '1/4', '1/2', '1/1'];
export const PZ_LFO_SYNC_TEXT = ['Off', '1/16', '1/8', '3/16', '1/4', '1/2', '3/4', '1 bar', '2 bars', '4 bars'];

export interface PzStateLike {
  [key: string]: unknown;
  hidden?: number[];
  ccMap?: number[];
}

/** A preset's state (raw parameter values by key + hidden settings). */
export function pzPresetState(i: number): Record<string, unknown> {
  const d = PZ_PRESET_DATA[i];
  const st: Record<string, unknown> = {};
  for (let k = 0; k < PZ_PARAM_COUNT; k++) st[PZ_PARAM_KEYS[k]] = pzEngineToRaw(k, d[k]);
  st.hidden = d.slice(74, 81);
  st.ccMap = new Array(74).fill(-1);
  return st;
}

export const PZ_INSERT_PRESET = PZ_PRESET_NAMES.indexOf('Factory/ARP Classic VA ToTc');
export { PZ_PRESET_NAMES };
