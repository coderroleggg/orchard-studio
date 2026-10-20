// Sawer parameter model: FL's 202 parameters (73 synth parameters, MIDI CC 0..127,
// channel aftertouch), FL's value texts (the Delphi wrapper's formats, checked against
// test-host sweeps of every parameter: integer texts round half to even, decimal texts
// half away from zero), the engine's hidden settings 73..95 (arpeggiator speed,
// polyphony, pitch-bend range, the six-slot modulation matrix) and FL's state chunk.

import { SW_PRESET_NAMES, SW_FLOATS, SW_MODE, SW_DIFF, SW_CC } from './presets';

export const SW_PARAM_COUNT = 73;
/** The engine's values: 73 FL parameters + 23 hidden (73 unused, 74 arpeggiator speed, 75 polyphony, 76 bend range, 77 unused, 78..83 modulation amounts, 84..89 destinations, 90..95 sources). */
export const SW_ENGINE_COUNT = 96;

export const SW_PARAM_KEYS: string[] = [
  "masterLevel", "masterPan", "masterAttack", "masterDecay", "masterSustain", "masterRelease", "transpose", "fineTune",
  "monoMode", "glideTimemode", "glideKeymode", "glideTime", "octaver", "unisonRetrig", "unisonVoices", "unisonDetune",
  "unisonPan", "subSawPhase", "subSawHarmonic", "subSawLevel", "subSawDetune", "subSawRetrig", "subSawInvert", "subSawSquare",
  "syncFrequency", "syncEnable", "noiseLevel", "filterCutoff", "filterResolution", "filterKeytrack", "filterVeltrk", "filterMode",
  "egfAttack", "egfDecay", "egfSustain", "egfRelease", "egfAmount", "egfDestination", "lfoShape", "lfoSpeed",
  "lfoTempoSync", "lfoAttack", "lfoRelease", "lfoRetrig", "lfoInvert", "lfoAmount", "lfoDestination", "chorusEnabled",
  "chorusDepth", "chorusRate", "chorusMix", "phaserEnabled", "phaserCenter", "phaserRate", "phaserDepth", "phaserFeedback",
  "phaserMix", "delayEnabled", "delayLeft", "delayRight", "delayFeedback", "delayDepth", "delayLowCut", "delayHighCut",
  "delayMix", "reverbEnabled", "reverbDecay", "reverbHighCut", "reverbDamp", "reverbMix", "arpPlayEnabled", "arpMode",
  "arpRange", "cc0", "cc1", "cc2", "cc3", "cc4", "cc5", "cc6",
  "cc7", "cc8", "cc9", "cc10", "cc11", "cc12", "cc13", "cc14",
  "cc15", "cc16", "cc17", "cc18", "cc19", "cc20", "cc21", "cc22",
  "cc23", "cc24", "cc25", "cc26", "cc27", "cc28", "cc29", "cc30",
  "cc31", "cc32", "cc33", "cc34", "cc35", "cc36", "cc37", "cc38",
  "cc39", "cc40", "cc41", "cc42", "cc43", "cc44", "cc45", "cc46",
  "cc47", "cc48", "cc49", "cc50", "cc51", "cc52", "cc53", "cc54",
  "cc55", "cc56", "cc57", "cc58", "cc59", "cc60", "cc61", "cc62",
  "cc63", "cc64", "cc65", "cc66", "cc67", "cc68", "cc69", "cc70",
  "cc71", "cc72", "cc73", "cc74", "cc75", "cc76", "cc77", "cc78",
  "cc79", "cc80", "cc81", "cc82", "cc83", "cc84", "cc85", "cc86",
  "cc87", "cc88", "cc89", "cc90", "cc91", "cc92", "cc93", "cc94",
  "cc95", "cc96", "cc97", "cc98", "cc99", "cc100", "cc101", "cc102",
  "cc103", "cc104", "cc105", "cc106", "cc107", "cc108", "cc109", "cc110",
  "cc111", "cc112", "cc113", "cc114", "cc115", "cc116", "cc117", "cc118",
  "cc119", "cc120", "cc121", "cc122", "cc123", "cc124", "cc125", "cc126",
  "cc127", "chanAT",
];

export const SW_PARAM_NAMES: string[] = [
  "Master level", "Master pan", "Master attack", "Master decay", "Master sustain", "Master release", "Transpose", "Fine tune",
  "Mono mode", "Glide timemode", "Glide keymode", "Glide time", "Octaver", "Unison retrig", "Unison voices", "Unison detune",
  "Unison pan", "Sub-saw phase", "Sub-saw harmonic", "Sub-saw level", "Sub-saw detune", "Sub-saw retrig", "Sub-saw invert", "Sub-saw square",
  "Sync frequency", "Sync enable", "Noise level", "Filter cutoff", "Filter resolution", "Filter keytrack", "Filter veltrk", "Filter mode",
  "EGF attack", "EGF decay", "EGF sustain", "EGF release", "EGF amount", "EGF destination", "LFO shape", "LFO speed",
  "LFO tempo sync", "LFO attack", "LFO release", "LFO retrig", "LFO invert", "LFO amount", "LFO destination", "Chorus enabled",
  "Chorus depth", "Chorus rate", "Chorus mix", "Phaser enabled", "Phaser center", "Phaser rate", "Phaser depth", "Phaser feedback",
  "Phaser mix", "Delay enabled", "Delay left", "Delay right", "Delay Feedback", "Delay depth", "Delay low cut", "Delay high cut",
  "Delay mix", "Reverb enabled", "Reverb decay", "Reverb high cut", "Reverb damp", "Reverb mix", "Arp play enabled", "Arp mode",
  "Arp range", "MIDI CC 0", "MIDI CC 1", "MIDI CC 2", "MIDI CC 3", "MIDI CC 4", "MIDI CC 5", "MIDI CC 6",
  "MIDI CC 7", "MIDI CC 8", "MIDI CC 9", "MIDI CC 10", "MIDI CC 11", "MIDI CC 12", "MIDI CC 13", "MIDI CC 14",
  "MIDI CC 15", "MIDI CC 16", "MIDI CC 17", "MIDI CC 18", "MIDI CC 19", "MIDI CC 20", "MIDI CC 21", "MIDI CC 22",
  "MIDI CC 23", "MIDI CC 24", "MIDI CC 25", "MIDI CC 26", "MIDI CC 27", "MIDI CC 28", "MIDI CC 29", "MIDI CC 30",
  "MIDI CC 31", "MIDI CC 32", "MIDI CC 33", "MIDI CC 34", "MIDI CC 35", "MIDI CC 36", "MIDI CC 37", "MIDI CC 38",
  "MIDI CC 39", "MIDI CC 40", "MIDI CC 41", "MIDI CC 42", "MIDI CC 43", "MIDI CC 44", "MIDI CC 45", "MIDI CC 46",
  "MIDI CC 47", "MIDI CC 48", "MIDI CC 49", "MIDI CC 50", "MIDI CC 51", "MIDI CC 52", "MIDI CC 53", "MIDI CC 54",
  "MIDI CC 55", "MIDI CC 56", "MIDI CC 57", "MIDI CC 58", "MIDI CC 59", "MIDI CC 60", "MIDI CC 61", "MIDI CC 62",
  "MIDI CC 63", "MIDI CC 64", "MIDI CC 65", "MIDI CC 66", "MIDI CC 67", "MIDI CC 68", "MIDI CC 69", "MIDI CC 70",
  "MIDI CC 71", "MIDI CC 72", "MIDI CC 73", "MIDI CC 74", "MIDI CC 75", "MIDI CC 76", "MIDI CC 77", "MIDI CC 78",
  "MIDI CC 79", "MIDI CC 80", "MIDI CC 81", "MIDI CC 82", "MIDI CC 83", "MIDI CC 84", "MIDI CC 85", "MIDI CC 86",
  "MIDI CC 87", "MIDI CC 88", "MIDI CC 89", "MIDI CC 90", "MIDI CC 91", "MIDI CC 92", "MIDI CC 93", "MIDI CC 94",
  "MIDI CC 95", "MIDI CC 96", "MIDI CC 97", "MIDI CC 98", "MIDI CC 99", "MIDI CC 100", "MIDI CC 101", "MIDI CC 102",
  "MIDI CC 103", "MIDI CC 104", "MIDI CC 105", "MIDI CC 106", "MIDI CC 107", "MIDI CC 108", "MIDI CC 109", "MIDI CC 110",
  "MIDI CC 111", "MIDI CC 112", "MIDI CC 113", "MIDI CC 114", "MIDI CC 115", "MIDI CC 116", "MIDI CC 117", "MIDI CC 118",
  "MIDI CC 119", "MIDI CC 120", "MIDI CC 121", "MIDI CC 122", "MIDI CC 123", "MIDI CC 124", "MIDI CC 125", "MIDI CC 126",
  "MIDI CC 127", "Channel Aftertouch",
];

const f32 = Math.fround;
/** Delphi Round: half to even. */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
const int = (x: number): string => { const r = roundEven(x); return String(r === 0 ? 0 : r); };
/** Delphi %.Nf: half away from zero, no "-0". */
function fix(x: number, n: number): string {
  const m = 10 ** n, t = Math.abs(x) * m;
  let r = Math.floor(t);
  if (t - r >= 0.5) r += 1;
  const s = (r / m).toFixed(n);
  return x < 0 && r !== 0 ? `-${s}` : s;
}
const time = (v: number): number => Math.max(50 * ((v * v) * (v * v)) * v, 0.00101);

export const SW_SWITCHES = new Set([8, 9, 10, 12, 13, 21, 22, 23, 25, 40, 43, 44, 47, 51, 57, 65, 70]);
export const SW_ENUMS: Record<number, string[]> = {
  14: ['Off', '2 voices', '4 voices', '8 voices'],
  18: ['-2 oct', '-1.5 oct', '-1 oct', '-0.5 oct', '0 oct', '0.5 oct', '1 oct', '1.5 oct', '2 oct'],
  31: ['LP24', 'LP12', 'BP', 'HP'],
  37: ['Cutoff', 'Sync frequency', 'Sub phase', 'Master frequency'],
  38: ['Triangle', 'Saw', 'Square', 'Random'],
  46: ['Cutoff', 'Sync frequency', 'Sub phase', 'Master frequency', 'Noise level', 'Level', 'Panning'],
  58: ['1/16', '2/16', '3/16', '4/16', '5/16', '6/16', '7/16', '8/16'],
  59: ['1/16', '2/16', '3/16', '4/16', '5/16', '6/16', '7/16', '8/16'],
  71: ['Up', 'Down', 'Up and down', 'Random'],
};
const TIME = new Set([2, 3, 5, 32, 33, 35, 41, 42]);

/** FL's value text of parameter i at raw value r (FL's 0..256 scale). */
export function swFormat(i: number, r: number): string {
  if (i >= SW_PARAM_COUNT) return '';
  const v = r / 256;
  if (SW_SWITCHES.has(i)) return r !== 0 ? 'On' : 'Off';
  const en = SW_ENUMS[i];
  if (en) return en[Math.min(Math.max(Math.trunc(v * (en.length - 1)), 0), en.length - 1)];
  if (TIME.has(i)) return `${fix(time(v), 3)} s`;
  switch (i) {
    case 0: return `${fix(v * 48 - 24, 1)} dB`;
    case 6: return `${int(v * 48 - 24)} semitones`;
    case 7: return `${int(v * 200 - 100)} cents`;
    case 24: return `${fix(v * 4, 3)} oct`;
    case 39: return `${fix(10 * (v * v) * v, 2)} Hz`;
    case 72: return `${int(r)} oct`;
    default: return `${int(v * 100)} %`;
  }
}

/** Typed value (display units) -> raw value, where FL's text is a plain number. */
export function swParse(i: number): ((t: number) => number) | undefined {
  if (SW_SWITCHES.has(i) || SW_ENUMS[i] || TIME.has(i) || i === 39 || i === 72 || i >= SW_PARAM_COUNT) return undefined;
  switch (i) {
    case 0: return (t) => ((t + 24) / 48) * 256;
    case 6: return (t) => ((t + 24) / 48) * 256;
    case 7: return (t) => ((t + 100) / 200) * 256;
    case 24: return (t) => (t / 4) * 256;
    default: return (t) => (t / 100) * 256;
  }
}

/** Hidden settings' defaults (FL's Default preset): arp speed 1/16, 8 voices, bend 2, modulation amounts 0. */
export const SW_HIDDEN_DEFAULT = [0, 1, 1, 2, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
export const SW_ARP_SPEED_TEXT = ['1/32', '1/16', '2/16', '3/16', '1/4', '2/4', '3/4'];
export const SW_POLY_TEXT = ['4', '8', '12', '16', '20', '24'];
export const SW_BEND_TEXT = [' ---', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12'];

export interface SwStateLike {
  [key: string]: unknown;
  /** engine values 73..95 */
  hidden?: number[];
  /** CC number linked to each engine value 0..95 (-1 = none) */
  ccMap?: number[];
}

/** Model state -> the engine's 96 values (FL parameters raw / 256) and CC map. */
export function swStateValues(st: SwStateLike): { values: Float32Array; ccMap: Int16Array } {
  const values = new Float32Array(SW_ENGINE_COUNT);
  for (let i = 0; i < SW_PARAM_COUNT; i++) {
    const raw = Number(st[SW_PARAM_KEYS[i]]);
    values[i] = Number.isFinite(raw) ? f32(raw / 256) : 0;
  }
  const h = Array.isArray(st.hidden) ? st.hidden : [];
  for (let i = SW_PARAM_COUNT; i < SW_ENGINE_COUNT; i++) {
    const x = Number(h[i - SW_PARAM_COUNT]);
    values[i] = Number.isFinite(x) ? f32(x) : SW_HIDDEN_DEFAULT[i - SW_PARAM_COUNT];
  }
  const ccMap = new Int16Array(SW_ENGINE_COUNT).fill(-1);
  const m = Array.isArray(st.ccMap) ? st.ccMap : [];
  for (let i = 0; i < SW_ENGINE_COUNT; i++) {
    const c = Math.trunc(Number(m[i]));
    if (c >= 0 && c <= 127) ccMap[i] = c;
  }
  return { values, ccMap };
}

/** FL's state chunk ('SwR1': 96 floats, 96-byte CC link map, 128-byte name) -> model state; null for anything else. */
export function swChunkToState(b: Uint8Array): SwStateLike | null {
  if (b.length < 4 + 96 * 4 + 96) return null;
  if (b[0] !== 0x31 || b[1] !== 0x72 || b[2] !== 0x77 || b[3] !== 0x53) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const st: SwStateLike = {};
  const v: number[] = [];
  for (let i = 0; i < SW_ENGINE_COUNT; i++) v.push(dv.getFloat32(4 + i * 4, true));
  for (let i = 0; i < SW_PARAM_COUNT; i++) st[SW_PARAM_KEYS[i]] = v[i] * 256;
  st.hidden = v.slice(SW_PARAM_COUNT);
  const cc: number[] = [];
  for (let i = 0; i < SW_ENGINE_COUNT; i++) { const c = b[388 + i]; cc.push(c <= 127 ? c : -1); }
  st.ccMap = cc;
  return st;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64v = (s: string, i: number): number => B64.indexOf(s[i]) * 64 + B64.indexOf(s[i + 1]);
let fTab: Float32Array | null = null;

export { SW_PRESET_NAMES };
/**
 * The insertion state: FL's plugin database entry holds the values of the factory preset
 * "Ambient/MC Chains" with the MIDI-learn links of "Default" (master level = CC 7, master pan = CC 10).
 */
export const SW_INSERT_PRESET = 1;

/** A factory preset as model state. */
export function swPresetState(i: number): SwStateLike {
  if (!fTab) {
    const bin = atob(SW_FLOATS);
    const u = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
    fTab = new Float32Array(u.buffer);
  }
  const v = SW_MODE.map((k) => fTab![k]);
  const d = SW_DIFF[i] ?? '';
  for (let j = 0; j + 3 < d.length; j += 4) v[b64v(d, j)] = fTab[b64v(d, j + 2)];
  const st: SwStateLike = {};
  for (let k = 0; k < SW_PARAM_COUNT; k++) st[SW_PARAM_KEYS[k]] = v[k] * 256;
  st.hidden = v.slice(SW_PARAM_COUNT);
  const cc = new Array<number>(SW_ENGINE_COUNT).fill(-1);
  const e = SW_CC[i] ?? '';
  for (let j = 0; j + 3 < e.length; j += 4) cc[b64v(e, j)] = b64v(e, j + 2);
  st.ccMap = cc;
  return st;
}

/** FL's plugin database state (see SW_INSERT_PRESET). */
export function swInsertState(): SwStateLike {
  const st = swPresetState(SW_INSERT_PRESET);
  const cc = (st.ccMap as number[]).slice();
  cc[0] = 7;
  cc[1] = 10;
  st.ccMap = cc;
  return st;
}
