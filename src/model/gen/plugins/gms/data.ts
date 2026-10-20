// GMS parameter model: FL's 205 parameters (76 synth parameters, MIDI CC 0..127, channel
// aftertouch) and the engine's 212 internal values they view. FL's synth parameters are not
// the engine's values one to one (FL 2026's GMS_x64, GMSynth::setParameter 0x17d64 / mapping
// 0x17a44): "CHN" / filter / "SYNTH" parameters map to fixed values, the envelope, LFO and FX
// parameters edit the selected envelope (EG1 / EG2), LFO (1 / 2) and effect (0..9), "Envelope
// Number" / "LFO Number" select, and "FX 1..10", "FX Activate" and the "... Switch" parameters
// reach nothing. Value texts: FL's (C printf: ties to even), equal to the test host's at all
// 19 532 sweep points; FL describes the current value, which is 0 for the unmapped parameters.
// State: `iv` (the 212 internal values), `sel` (selected effect, envelope, LFO), `waves` (the
// three oscillators' wave file names), `wavePool` (pool samples holding imported waves by name).

import {
  GMS_PRESET_NAMES, GMS_WAVE_NAMES, GMS_FLOATS, GMS_MODE, GMS_DIFF, GMS_WAVES, GMS_SEL, GMS_INSERT,
} from './presets';

export const GMS_PARAM_COUNT = 76;
export const GMS_ENGINE_COUNT = 212;

export const GMS_PARAM_NAMES: string[] = [
  'FX 1', 'FX 2', 'FX 3', 'FX 4', 'FX 5', 'FX 6', 'FX 7', 'FX 8', 'FX 9', 'FX 10', 'FX Activate', 'FX Glue',
  'FX LFO Rate', 'FX LFO Amount', 'FX LFO Shape Switch', 'FX LFO Shape', 'FX LFO Sync Switch', 'FX LFO Sync', 'FX Param X',
  'FX Param Y', 'CHN: Mix Level', 'CHN: Panning', 'CHN: Pitch', 'CHN: Note Length', 'CHN: Amp Attack', 'CHN: Amp Decay',
  'CHN: Amp Sustain', 'CHN: Amp Release', 'CHN: Amp Level', 'CHN: Shuffle Enable', 'CHN: Slide Time', 'CHN: Slide Enable',
  'Filter Cutoff', 'Filter Resonance', 'Filter KBD Tracking', 'Filter Type Switch', 'Filter Type', 'Envelope Number',
  'Envelope Destination Switch', 'Envelope Destination', 'Envelope Attack', 'Envelope Decay', 'Envelope Amount',
  'Envelope Invert', 'LFO Number', 'LFO Rate', 'LFO Amount', 'LFO Retrig', 'LFO Invert', 'LFO Sync Switch', 'LFO Sync',
  'LFO Destination Switch', 'LFO Destination', 'LFO Shape Switch', 'LFO Shape', 'SYNTH: Mono Voice', 'SYNTH: Unison Voices',
  'SYNTH: Unison Detune', 'SYNTH: Unison Stereo', 'SYNTH: Octave', 'SYNTH: Noise Mix', 'SYNTH: Unison Phase',
  'SYNTH: Unison Phase Retrig', 'SYNTH: Mix Oscllator 2', 'SYNTH: Mix Oscillator 3', 'SYNTH: Modulation', 'SYNTH: Mod Kind',
  'SYNTH: Phase Offset Osc 2', 'SYNTH: Phase Retrig Osc 2', 'SYNTH: Osc 2 Invert', 'SYNTH: Osc 1 Pitch', 'SYNTH: Osc 1 Detune',
  'SYNTH: Osc 2 Pitch', 'SYNTH: Osc 2 Detune', 'SYNTH: Osc 3 Pitch', 'SYNTH: Osc 3 Detune',
  ...Array.from({ length: 128 }, (_, i) => `MIDI CC ${i}`), 'Chn. Aftertouch',
];

const SYNTH_KEYS = [
  'fx1', 'fx2', 'fx3', 'fx4', 'fx5', 'fx6', 'fx7', 'fx8', 'fx9', 'fx10', 'fxActivate', 'fxGlue',
  'fxLfoRate', 'fxLfoAmount', 'fxLfoShapeSwitch', 'fxLfoShape', 'fxLfoSyncSwitch', 'fxLfoSync', 'fxX',
  'fxY', 'mixLevel', 'panning', 'pitch', 'noteLength', 'ampAttack', 'ampDecay',
  'ampSustain', 'ampRelease', 'ampLevel', 'shuffle', 'slideTime', 'slideEnable',
  'cutoff', 'resonance', 'kbdTracking', 'filterTypeSwitch', 'filterType', 'envNumber',
  'envDestSwitch', 'envDest', 'envAttack', 'envDecay', 'envAmount',
  'envInvert', 'lfoNumber', 'lfoRate', 'lfoAmount', 'lfoRetrig', 'lfoInvert', 'lfoSyncSwitch', 'lfoSync',
  'lfoDestSwitch', 'lfoDest', 'lfoShapeSwitch', 'lfoShape', 'monoVoice', 'unisonVoices',
  'unisonDetune', 'unisonStereo', 'octave', 'noiseMix', 'unisonPhase',
  'unisonPhaseRetrig', 'mixOsc2', 'mixOsc3', 'modulation', 'modKind',
  'osc2Phase', 'osc2PhaseRetrig', 'osc2Invert', 'osc1Pitch', 'osc1Detune',
  'osc2Pitch', 'osc2Detune', 'osc3Pitch', 'osc3Detune',
];
export const GMS_PARAM_KEYS: string[] = [...SYNTH_KEYS, ...Array.from({ length: 128 }, (_, i) => `cc${i}`), 'chanAT'];

/** The internal value FL parameter i edits for the selection [fx, eg, lfo] (-1: none; 37 / 44 select). */
export function gmsInternal(i: number, sel: ArrayLike<number>): number {
  const fx = sel[0] | 0, eg = sel[1] | 0, lfo = sel[2] | 0;
  switch (i) {
    case 11: return 0x93 + fx;
    case 12: return 0x89 + fx;
    case 13: return 0xb1 + fx;
    case 15: return 0x9d + fx;
    case 17: return 0xa7 + fx;
    case 18: return 0x75 + fx;
    case 19: return 0x7f + fx;
    case 36: return 15;
    case 39: return 0x18 + eg;
    case 40: return 0x14 + eg;
    case 41: return 0x16 + eg;
    case 42: return 0x10 + eg;
    case 43: return 0x12 + eg;
    case 45: return 0x22 + lfo;
    case 46: return 0x1c + lfo;
    case 47: return 0x1a + lfo;
    case 48: return 0x1e + lfo;
    case 50: return 0x24 + lfo;
    case 52: return 0x26 + lfo;
    case 54: return 0x20 + lfo;
    default:
      if (i >= 20 && i <= 31) return i - 20;
      if (i >= 32 && i <= 34) return i - 20;
      if (i >= 55 && i <= 75) return i - 15;
      return -1;
  }
}

/** The effects (internal index 0..9) and their X / Y names (FL's). */
export const GMS_FX_NAMES = ['Distortion', 'Crusher', 'Flanger', 'Phaser', 'Low Pass', 'Hi Pass', 'Delay', 'Reverb', 'Panner', 'Trancer'];
export const GMS_FX_XY: [string, string][] = [
  ['Distortion', 'Filter'], ['Crush', 'Filter'], ['Time', 'Feedback'], ['Depth', 'Feedback'], ['Frequency', 'Bandwidth'],
  ['Frequency', 'Bandwidth'], ['Feedback', 'Filter'], ['Feedback', 'Filter'], ['Panning', 'Binaural'], ['Release', 'Depth'],
];
/** LFO / FX LFO rates in beats (index trunc(9 v)). */
export const GMS_SYNC_TEXT = ['1/8', '1/4', '3/8', '1/2', '3/4', '1/1', '2/1', '4/1', '8/1'];
/** MIDI modulation destinations (codes stored in internal values 199 / 202 / 204; headers have no target). */
export const GMS_MIDI_DESTS = [
  '---', 'Cutoff', 'Resonance', '', 'Mod Amount', 'Envelope 1', 'EG1 Attack', 'EG1 Decay', 'EG1 Amount', 'Envelope 2', 'EG2 Attack',
  'EG2 Decay', 'EG2 Amount', 'LFO 1', 'LFO1 Rate', 'LFO1 Amount', 'LFO 2', 'LFO2 Rate', 'LFO2 Amount', 'Amplitude EG',
  'AMP Attack', 'AMP Decay', 'Param X', 'Param Y',
];

/** C printf %.Nf: the double's exact value rounded half to even. */
export function cfix(x: number, n: number): string {
  if (!Number.isFinite(x)) return String(x);
  const neg = x < 0 || Object.is(x, -0);
  const s = Math.abs(x).toFixed(Math.min(100, n + 30));
  const dot = s.indexOf('.');
  const head = s.slice(0, dot + 1 + n), tail = s.slice(dot + 1 + n);
  let up = false;
  if (tail[0] > '5') up = true;
  else if (tail[0] === '5') {
    if (/[1-9]/.test(tail.slice(1))) up = true;
    else {
      const last = head.replace('.', '').slice(-1);
      up = (Number(last) & 1) === 1;
    }
  }
  let digits = head.replace('.', '');
  if (up) {
    const arr = digits.split('').map(Number);
    let k = arr.length - 1;
    while (k >= 0) { if (arr[k] === 9) { arr[k] = 0; k--; } else { arr[k]++; break; } }
    if (k < 0) arr.unshift(1);
    digits = arr.join('');
  }
  const ip = digits.slice(0, digits.length - n) || '0', fp = digits.slice(digits.length - n);
  const out = n > 0 ? `${ip}.${fp}` : ip;
  return neg ? `-${out}` : out;
}

const f32 = Math.fround;
const UNMAPPED = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 16, 35, 38, 49, 51, 53]);

/** FL's value text of parameter i at raw value r (0..256). */
export function gmsFormat(i: number, r: number): string {
  if (i >= GMS_PARAM_COUNT) {
    const v = Math.min(Math.max(r / 256, 0), 1);
    return String(Math.trunc(v * 127));
  }
  if (UNMAPPED.has(i)) return '0.00 % ';
  const v = f32(Math.min(Math.max(f32(r * 0.00390625), 0), 1));
  if (i === 37 || i === 44) return `${cfix(r >= 256 ? 1 : 0, 2)} % `;
  switch (i) {
    case 12: case 45: return `${GMS_SYNC_TEXT[Math.min(Math.max(Math.trunc(v * 9), 0), 8)]} `;
    case 20: return `${cfix(v * 80 - 60, 1)} dB `;
    case 21: return `${cfix((v * 2 - 1) * 100, 1)} % `;
    case 22: return `${Math.trunc(v * 48 - 24)} `;
    case 28: return `${cfix(v * 50 - 25, 1)} dB `;
    case 56: return `${Math.min(16, Math.trunc(v * 15) + 1)} `;
    case 70: case 72: case 74: return `${Math.trunc(v * 72 - 36)} `;
    case 71: case 73: case 75: return `${Math.trunc(v * 100 - 50)} `;
    default: return `${cfix(v, 2)} % `;
  }
}

export interface GmsStateLike {
  [key: string]: unknown;
  iv?: number[];
  sel?: number[];
  waves?: string[];
  wavePool?: Record<string, string>;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64v = (s: string, i: number): number => B64.indexOf(s[i]) * 64 + B64.indexOf(s[i + 1]);
let fTab: Float32Array | null = null;
function floats(): Float32Array {
  if (!fTab) {
    const bin = atob(GMS_FLOATS);
    const u = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
    fTab = new Float32Array(u.buffer);
  }
  return fTab;
}

/** The FL parameter values that view the internal values (raw = value x 256, FL's readback). */
export function gmsMirror(st: GmsStateLike): void {
  const iv = st.iv ?? [];
  const sel = st.sel ?? [0, 0, 0];
  for (let i = 0; i < GMS_PARAM_COUNT; i++) {
    const m = gmsInternal(i, sel);
    if (i === 37) st[SYNTH_KEYS[i]] = (sel[1] | 0) * 256;
    else if (i === 44) st[SYNTH_KEYS[i]] = (sel[2] | 0) * 256;
    else if (m < 0) st[SYNTH_KEYS[i]] = 0;
    else {
      const v = Number(iv[m]);
      st[SYNTH_KEYS[i]] = Number.isFinite(v) ? Math.trunc(Math.min(Math.max(v, 0), 1) * 256) : 0;
    }
  }
}

function decode(diff: string, waves: string, sel: string): GmsStateLike {
  const t = floats();
  const iv = GMS_MODE.map((k) => t[k]);
  for (let j = 0; j + 3 < diff.length; j += 4) iv[b64v(diff, j)] = t[b64v(diff, j + 2)];
  const w = [0, 1, 2].map((k) => { const x = b64v(waves, k * 2); return x > 0 ? GMS_WAVE_NAMES[x - 1] : ''; });
  const s = [0, 1, 2].map((k) => B64.indexOf(sel[k] ?? 'A'));
  const st: GmsStateLike = { iv, sel: s, waves: w };
  gmsMirror(st);
  return st;
}

export { GMS_PRESET_NAMES, GMS_WAVE_NAMES };

/** A factory preset as model state. */
export function gmsPresetState(i: number): GmsStateLike {
  return decode(GMS_DIFF[i] ?? '', GMS_WAVES[i] ?? '', GMS_SEL[i] ?? 'AAA');
}

/** FL's plugin database entry (the insertion state: "Agressive TE" with the Beast / Sine / Saw waves). */
export function gmsInsertState(): GmsStateLike {
  return decode(GMS_INSERT.diff, GMS_INSERT.waves, GMS_INSERT.sel);
}

/** FL's chunk ('4nyS', old '3nyS'): three 512-byte wave paths, selections (v4), 212 floats. */
export function gmsChunkToState(b: Uint8Array): GmsStateLike | null {
  if (b.length < 0xe04 + 212 * 4) return null;
  const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (tag !== '4nyS' && tag !== '3nyS') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const waves = [0, 1, 2].map((k) => {
    let s = '';
    for (let j = 4 + 0x200 * k; j < 4 + 0x200 * (k + 1) && b[j]; j++) s += String.fromCharCode(b[j]);
    return s.replace(/\\/g, '/').split('/').pop() ?? '';
  });
  let off = 0xe04, sel = [0, 0, 0];
  if (tag === '4nyS') {
    if (b.length < 0xe10 + 212 * 4) return null;
    const c = (x: number, hi: number) => Math.min(Math.max(x, 0), hi);
    sel = [c(dv.getInt32(0xe04, true), 9), c(dv.getInt32(0xe08, true), 1), c(dv.getInt32(0xe0c, true), 1)];
    off = 0xe10;
  }
  const iv: number[] = [];
  for (let k = 0; k < 212; k++) iv.push(dv.getFloat32(off + 4 * k, true));
  const st: GmsStateLike = { iv, sel, waves };
  gmsMirror(st);
  return st;
}
