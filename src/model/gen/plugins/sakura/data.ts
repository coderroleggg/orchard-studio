// Sakura parameter model: FL's 207 parameters (78 synth parameters, MIDI CC 0..127, channel
// aftertouch), FL's value texts (the Delphi wrapper's formats, checked against test-host sweeps of
// every parameter at every raw value 0..256), the engine's hidden settings 78..113 (modulation
// matrix, string 2 frequency ratio, delay time sync, transpose) and FL's state chunk.
//
// Model state: key SK_PARAM_KEYS[i] (i < 78) = the engine's float32 value * 256, unrounded (FL's
// 0..256 control units), and `hidden` = engine values 78..113 (36 numbers, layout SK_H_*).

import { SK_DIFF, SK_FLOATS, SK_MODE, SK_PRESET_NAMES } from './presets';

export { SK_PRESET_NAMES };

/** FL's synth parameters (0..77); 78..205 are MIDI CC 0..127 and 206 is channel aftertouch. */
export const SK_PARAM_COUNT = 78;
/** The engine's values: 78 FL parameters + 36 hidden (editor-only) values. */
export const SK_ENGINE_COUNT = 114;
export const SK_HIDDEN_COUNT = SK_ENGINE_COUNT - SK_PARAM_COUNT;

export const SK_PARAM_KEYS: string[] = [
  "masterLevel", "tune", "ampAttack", "ampDecay", "ampSustain", "ampRelease", "string1Decay", "string1DecayInverted",
  "string1DampOffset", "string1DampAmount", "string1DampSharpness", "string2Decay", "string2DecayInverted", "string2DampOffset", "string2DampAmount", "string2DampSharpness",
  "stringSaturation", "stringMix", "stringStereoSeparation", "compRatio", "combFeedback", "combFeedbackInverted", "combLevel", "combLevelInverted",
  "loCutCutoff", "loCutResonance", "hiCutAttack", "hiCutDecay", "hiCutSustain", "hiCutCutoff", "hiCutResonance", "exciterNoiseLevel",
  "exciterNoiseRate", "hiCutDrive", "egAttack", "egDecay", "egSustain", "egRelease", "lfoRate", "resonatorFrequency1",
  "resonatorFrequency2", "resonatorFrequency3", "resonatorFrequency4", "resonatorFrequency5", "resonatorFrequency6", "resonatorFrequency7", "resonatorFrequency8", "resonatorFeedback1",
  "resonatorFeedback2", "resonatorFeedback3", "resonatorFeedback4", "resonatorFeedback5", "resonatorFeedback6", "resonatorFeedback7", "resonatorFeedback8", "resonatorOn1",
  "resonatorOn2", "resonatorOn3", "resonatorOn4", "resonatorOn5", "resonatorOn6", "resonatorOn7", "resonatorOn8", "delay",
  "delayTime", "delayFeedback", "delayModSpeed", "delayModDepth", "delayBlur", "delayWet", "chorus", "chorusRate",
  "chorusDepth", "chorusWet", "reverb", "reverbMix", "reverbDecay", "reverbColor", "cc0", "cc1",
  "cc2", "cc3", "cc4", "cc5", "cc6", "cc7", "cc8", "cc9",
  "cc10", "cc11", "cc12", "cc13", "cc14", "cc15", "cc16", "cc17",
  "cc18", "cc19", "cc20", "cc21", "cc22", "cc23", "cc24", "cc25",
  "cc26", "cc27", "cc28", "cc29", "cc30", "cc31", "cc32", "cc33",
  "cc34", "cc35", "cc36", "cc37", "cc38", "cc39", "cc40", "cc41",
  "cc42", "cc43", "cc44", "cc45", "cc46", "cc47", "cc48", "cc49",
  "cc50", "cc51", "cc52", "cc53", "cc54", "cc55", "cc56", "cc57",
  "cc58", "cc59", "cc60", "cc61", "cc62", "cc63", "cc64", "cc65",
  "cc66", "cc67", "cc68", "cc69", "cc70", "cc71", "cc72", "cc73",
  "cc74", "cc75", "cc76", "cc77", "cc78", "cc79", "cc80", "cc81",
  "cc82", "cc83", "cc84", "cc85", "cc86", "cc87", "cc88", "cc89",
  "cc90", "cc91", "cc92", "cc93", "cc94", "cc95", "cc96", "cc97",
  "cc98", "cc99", "cc100", "cc101", "cc102", "cc103", "cc104", "cc105",
  "cc106", "cc107", "cc108", "cc109", "cc110", "cc111", "cc112", "cc113",
  "cc114", "cc115", "cc116", "cc117", "cc118", "cc119", "cc120", "cc121",
  "cc122", "cc123", "cc124", "cc125", "cc126", "cc127", "chanAT",
];

export const SK_PARAM_NAMES: string[] = [
  "Master level", "Tune", "Amp attack", "Amp decay",
  "Amp sustain", "Amp release", "String 1 decay", "String 1 decay inverted",
  "String 1 damp offset", "String 1 damp amount", "String 1 damp sharpness", "String 2 decay",
  "String 2 decay inverted", "String 2 damp offset", "String 2 damp amount", "String 2 damp sharpness",
  "String saturation", "String mix", "String stereo separation", "Comp ratio",
  "Comb feedback", "Comb feedback inverted", "Comb level", "Comb level Inverted",
  "Lo-Cut cutoff", "Lo-Cut resonance", "Hi-Cut attack", "Hi-Cut decay",
  "Hi-Cut sustain", "Hi-Cut cutoff", "Hi-Cut resonance", "Exciter noise level",
  "Exciter noise rate", "Hi-Cut drive", "EG attack", "EG decay",
  "EG sustain", "EG release", "LFO rate", "Resonator frequency 1",
  "Resonator frequency 2", "Resonator frequency 3", "Resonator frequency 4", "Resonator frequency 5",
  "Resonator frequency 6", "Resonator frequency 7", "Resonator frequency 8", "Resonator feedback 1",
  "Resonator feedback 2", "Resonator feedback 3", "Resonator feedback 4", "Resonator feedback 5",
  "Resonator feedback 6", "Resonator feedback 7", "Resonator feedback 8", "Resonator on 1",
  "Resonator on 2", "Resonator on 3", "Resonator on 4", "Resonator on 5",
  "Resonator on 6", "Resonator on 7", "Resonator on 8", "Delay",
  "Delay time", "Delay feedback", "Delay mod speed", "Delay mod depth",
  "Delay blur", "Delay wet", "Chorus", "Chorus rate",
  "Chorus depth", "Chorus wet", "Reverb", "Reverb mix",
  "Reverb decay", "Reverb color", "MIDI CC #0 (Bank select MSB)", "MIDI CC #1 (Modulation wheel)",
  "MIDI CC #2 (Breath controller)", "MIDI CC #3", "MIDI CC #4 (Foot controller)", "MIDI CC #5 (Portamento time)",
  "MIDI CC #6 (Data entry MSB)", "MIDI CC #7 (Main volume)", "MIDI CC #8 (Balance)", "MIDI CC #9",
  "MIDI CC #10 (Pan)", "MIDI CC #11 (Expression controller)", "MIDI CC #12 (Control 1)", "MIDI CC #13 (Control 2)",
  "MIDI CC #14", "MIDI CC #15", "MIDI CC #16 (General purpose controller 1)", "MIDI CC #17 (General purpose controller 2)",
  "MIDI CC #18 (General purpose controller 3)", "MIDI CC #19 (General purpose controller 4)", "MIDI CC #20", "MIDI CC #21",
  "MIDI CC #22", "MIDI CC #23", "MIDI CC #24", "MIDI CC #25",
  "MIDI CC #26", "MIDI CC #27", "MIDI CC #28", "MIDI CC #29",
  "MIDI CC #30", "MIDI CC #31", "MIDI CC #32 (Bank select LSB)", "MIDI CC #33 (Modulation wheel LSB)",
  "MIDI CC #34 (Breath controller LSB)", "MIDI CC #35", "MIDI CC #36 (Foot controller LSB)", "MIDI CC #37 (Portamento time LSB)",
  "MIDI CC #38 (Data entry LSB )", "MIDI CC #39 (Main volume LSB)", "MIDI CC #40 (Balance LSB)", "MIDI CC #41",
  "MIDI CC #42 (Pan LSB)", "MIDI CC #43 (Expression controller LSB)", "MIDI CC #44 (Control 1 LSB)", "MIDI CC #45 (Control 2 LSB)",
  "MIDI CC #46", "MIDI CC #47", "MIDI CC #48 (General purpose controller 1 LSB)", "MIDI CC #49 (General purpose controller 2 LSB)",
  "MIDI CC #50 (General purpose controller 3 LSB)", "MIDI CC #51 (General purpose controller 4 LSB)", "MIDI CC #52", "MIDI CC #53",
  "MIDI CC #54", "MIDI CC #55", "MIDI CC #56", "MIDI CC #57",
  "MIDI CC #58", "MIDI CC #59", "MIDI CC #60", "MIDI CC #61",
  "MIDI CC #62", "MIDI CC #63", "MIDI CC #64 (Damper pedal (sustain))", "MIDI CC #65 (Portamento)",
  "MIDI CC #66 (Sostenuto)", "MIDI CC #67 (Soft pedal)", "MIDI CC #68 (Legato footswitch)", "MIDI CC #69 (Hold 2)",
  "MIDI CC #70 (Sound variation)", "MIDI CC #71 (Harmonic content)", "MIDI CC #72 (Release time)", "MIDI CC #73 (Attack time)",
  "MIDI CC #74 (Brightness)", "MIDI CC #75 (Sound controller 6)", "MIDI CC #76 (Sound controller 7)", "MIDI CC #77 (Sound controller 8)",
  "MIDI CC #78 (Sound controller 9)", "MIDI CC #79 (Sound controller 10)", "MIDI CC #80 (General purpose controller 5)", "MIDI CC #81 (General purpose controller 6)",
  "MIDI CC #82 (General purpose controller 7)", "MIDI CC #83 (General purpose controller 8)", "MIDI CC #84 (Portamento control)", "MIDI CC #85",
  "MIDI CC #86", "MIDI CC #87", "MIDI CC #88", "MIDI CC #89",
  "MIDI CC #90", "MIDI CC #91 (Reverb depth)", "MIDI CC #92 (Tremolo depth)", "MIDI CC #93 (Chorus depth)",
  "MIDI CC #94 (Celeste depth)", "MIDI CC #95 (Phaser depth)", "MIDI CC #96 (Data increment)", "MIDI CC #97 (Data decrement)",
  "MIDI CC #98 (NRPN LSB)", "MIDI CC #99 (NRPN MSB)", "MIDI CC #100 (RPN LSB)", "MIDI CC #101 (RPN MSB)",
  "MIDI CC #102", "MIDI CC #103", "MIDI CC #104", "MIDI CC #105",
  "MIDI CC #106", "MIDI CC #107", "MIDI CC #108", "MIDI CC #109",
  "MIDI CC #110", "MIDI CC #111", "MIDI CC #112", "MIDI CC #113",
  "MIDI CC #114", "MIDI CC #115", "MIDI CC #116", "MIDI CC #117",
  "MIDI CC #118", "MIDI CC #119", "MIDI CC #120 (All sound off)", "MIDI CC #121 (Reset all controllers)",
  "MIDI CC #122 (Local control on/off)", "MIDI CC #123 (All notes off)", "MIDI CC #124 (Omni mode off)", "MIDI CC #125 (Omni mode on)",
  "MIDI CC #126 (Mono mode on)", "MIDI CC #127 (Poly mode on)", "Channel Aftertouch",
];

// ---- the hidden settings (engine values 78..113 = `hidden[0..35]` of the model state)

/** hidden[0] (engine value 78) is a constant 0 that nothing reads. */
export const SK_H_DUMMY = 0;
/** Eight modulation matrix slots of four values each, starting at hidden[SK_H_SLOT0] (engine value 79). */
export const SK_SLOTS = 8;
export const SK_H_SLOT0 = 1;
export const SK_SLOT_SIZE = 4;
/** Offsets inside a slot: source (integer 0..8), amount (0..1), phase (0 or 1: FL's "Negative amount" switch), destination (integer 0..14). */
export const SK_H_SOURCE = 0;
export const SK_H_AMOUNT = 1;
export const SK_H_PHASE = 2;
export const SK_H_DEST = 3;
/** String 2 frequency ratio index (0..6, SK_S2_RATIOS). */
export const SK_H_S2_RATIO = 33;
/** Delay time sync index (0..9, SK_DELAY_SYNC). */
export const SK_H_DELAY_SYNC = 34;
/** Transpose: a float 0..1 whose octave shift is trunc(v * 6) - 3 (default 0.5 = 0). */
export const SK_H_TRANSPOSE = 35;
/** Index into `hidden` of field `field` (SK_H_SOURCE...) of modulation slot `slot` (0..7). */
export const skSlotIndex = (slot: number, field: number): number => SK_H_SLOT0 + SK_SLOT_SIZE * slot + field;

/** Modulation sources (FL's combo items), indexed by the slot's source value. */
export const SK_MOD_SOURCES: string[] = ['...', 'envelope', 'lfo', 'mod whl', 'ptch whl', 'aftch', 'velocity', 'key num', 'release'];
/** Modulation destinations (FL's combo items; sic: "str2  damp" has two spaces), indexed by the slot's destination value. */
export const SK_MOD_DESTS: string[] = [
  'lfo ampl', 'level', 'pan', 'pitch', 'lo-cut ctf', 'hi-cut ctf', 'hi-cut atk', 'hi-cut dec',
  'str1 decay', 'str2 decay', 'stri1&2 dec', 'str1 damp', 'str2  damp', 'str1&2 dmp', 'noise rate',
];
/** String 2 frequency ratio texts, indexed by hidden[SK_H_S2_RATIO]. */
export const SK_S2_RATIOS: string[] = ['4 : 1', '3 : 1', '2 : 1', '1 : 1', '1 : 2', '1 : 3', '1 : 4'];
/** Delay time sync texts, indexed by hidden[SK_H_DELAY_SYNC]. */
export const SK_DELAY_SYNC: string[] = ['---', '1/16', '2/16', '3/16', '1/4', '2/4', '3/4', '4/4', '8/4', '16/4'];

/**
 * The hidden settings' defaults (the engine's own, FL's "Default" preset): slot 1 velocity -> level (amount 1),
 * slot 2 pitch wheel -> pitch (amount 1), the other slots empty, string 2 ratio 1 : 1, no delay sync, no transpose.
 */
export const SK_HIDDEN_DEFAULT: number[] = [0, 6, 1, 0, 1, 4, 1, 0, 3, ...new Array<number>(24).fill(0), 3, 0, 0.5];

/** Octave shift (-3..3) of the transpose value hidden[SK_H_TRANSPOSE]. */
export const skOctaves = (v: number): number => Math.trunc(Math.min(1, Math.max(0, v)) * 6) - 3;

const f32 = Math.fround;
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/** [max, integer] of every hidden value (all start at 0; the dummy is not limited). */
const H_SPEC: [number, boolean][] = [[0, false]];
for (let s = 0; s < SK_SLOTS; s++) H_SPEC.push([8, true], [1, false], [1, true], [14, true]);
H_SPEC.push([6, true], [9, true], [1, false]);

/**
 * Repair the hidden settings: 36 finite values in range (indices rounded); a value that is not a finite number
 * takes the engine's default (SK_HIDDEN_DEFAULT) and anything that is not an array the insertion state's settings.
 */
export function skNormHidden(h: unknown): number[] {
  if (!Array.isArray(h)) return insertHidden().slice();
  const a = h as unknown[];
  const out: number[] = [];
  for (let k = 0; k < SK_HIDDEN_COUNT; k++) {
    const x = num(a[k], SK_HIDDEN_DEFAULT[k]);
    out.push(k === SK_H_DUMMY ? x : clamp(H_SPEC[k][1] ? Math.round(x) : x, 0, H_SPEC[k][0]));
  }
  return out;
}

// ---- FL's value texts

/** Delphi Format('%.Nf'): half away from zero on the value, no "-0". */
function fix(x: number, n: number): string {
  const m = 10 ** n, t = Math.abs(x) * m;
  let r = Math.floor(t);
  if (t - r >= 0.5) r += 1;
  const s = (r / m).toFixed(n);
  return x < 0 && r !== 0 ? `-${s}` : s;
}

/** Off / On switches: Resonator on 1..8 (55..62), Delay (63), Chorus (70), Reverb (74). */
export const SK_SWITCHES = new Set([55, 56, 57, 58, 59, 60, 61, 62, 63, 70, 74]);
/** "+" / "-" switches: String 1 / 2 decay inverted (7, 12), Comb feedback inverted (21), Comb level Inverted (23). */
export const SK_INVERTS = new Set([7, 12, 21, 23]);
/** Chorus rate (Hz text: round(0.1 + 5 v), the engine's rate). */
export const SK_CHORUS_RATE = 71;

/**
 * FL's value text of parameter i at raw value `raw` (FL's 0..256 scale). FL hands its texts the integer part of
 * the engine's value * 256 (a loaded preset's fractions never show); the switches are on for any non-zero
 * value, as in the engine. Percent: "50.0%"; Off/On; "+"/"-"; chorus rate "3Hz"; CC 0 shows the raw integer
 * and every other CC / aftertouch parameter "0" (what FL's wrapper returns).
 */
export function skFormat(i: number, raw: number): string {
  const x = Number.isFinite(raw) ? raw : 0;
  if (SK_SWITCHES.has(i)) return x !== 0 ? 'On' : 'Off';
  if (SK_INVERTS.has(i)) return x !== 0 ? '-' : '+';
  const r = Math.trunc(x);
  if (i >= SK_PARAM_COUNT) return i === SK_PARAM_COUNT ? String(r) : '0';
  if (i === SK_CHORUS_RATE) return `${fix((r / 256) * 5 + 0.1, 0)}Hz`;
  return `${fix((r / 256) * 100, 1)}%`;
}

/** Typed value (display units) -> raw value, where FL's text is a plain number. */
export function skParse(i: number): ((t: number) => number) | undefined {
  if (i === SK_PARAM_COUNT) return (t) => t;
  if (i > SK_PARAM_COUNT || SK_SWITCHES.has(i) || SK_INVERTS.has(i)) return undefined;
  if (i === SK_CHORUS_RATE) return (t) => ((t - 0.1) / 5) * 256;
  return (t) => (t / 100) * 256;
}

// ---- the state

export interface SkStateLike {
  [key: string]: unknown;
  /** engine values 78..113 (layout: SK_H_*) */
  hidden?: number[];
}

/** FL's state chunk: 588 bytes = magic "1rkS" ("DrkS" when saved by the trial version), 114 float32, a 128-byte name at NAME_AT. */
const NAME_AT = 4 + SK_ENGINE_COUNT * 4;

/**
 * Model state -> the engine's 114 values (FL parameters raw / 256 as float32, then the hidden settings). A
 * missing or non-finite parameter takes its default (the insertion state); out-of-range values are clamped.
 */
export function skStateValues(st: SkStateLike): { values: Float32Array } {
  const values = new Float32Array(SK_ENGINE_COUNT);
  const def = insertRaw();
  for (let i = 0; i < SK_PARAM_COUNT; i++) values[i] = f32(clamp(num(st[SK_PARAM_KEYS[i]], def[i]), 0, 256) / 256);
  const h = skNormHidden(st.hidden);
  for (let k = 0; k < SK_HIDDEN_COUNT; k++) values[SK_PARAM_COUNT + k] = f32(h[k]);
  return { values };
}

/** FL's state chunk (magic, 114 float32; the name is optional) -> model state; null for anything else. Non-finite values are repaired. */
export function skChunkToState(b: Uint8Array): SkStateLike | null {
  if (b.length < NAME_AT) return null;
  if (!((b[0] === 0x31 || b[0] === 0x44) && b[1] === 0x72 && b[2] === 0x6b && b[3] === 0x53)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const def = insertRaw();
  const st: SkStateLike = {};
  for (let i = 0; i < SK_PARAM_COUNT; i++) {
    const v = dv.getFloat32(4 + i * 4, true);
    st[SK_PARAM_KEYS[i]] = Number.isFinite(v) ? clamp(v * 256, 0, 256) + 0 : def[i];
  }
  const h: number[] = [];
  for (let k = 0; k < SK_HIDDEN_COUNT; k++) h.push(dv.getFloat32(4 + (SK_PARAM_COUNT + k) * 4, true));
  st.hidden = skNormHidden(h);
  return st;
}

/** The program name of a state chunk (128 bytes at offset 460, zero-terminated; '' when the chunk has none). */
export function skChunkName(b: Uint8Array): string {
  let s = '';
  for (let i = NAME_AT; i < Math.min(b.length, NAME_AT + 128) && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
  return s;
}

// ---- factory presets (data in ./presets.ts, generated by .flref/special/sakura/gen_presets.py)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64 = (s: string, i: number): number => B64.indexOf(s[i]);
/** characters of a preset's mask of changed values: 6 values each */
const MASK_CHARS = SK_ENGINE_COUNT / 6;
let fTab: Float32Array | null = null;

function floatTable(): Float32Array {
  if (!fTab) {
    const bin = atob(SK_FLOATS);
    const u = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
    const dv = new DataView(u.buffer);
    const t = new Float32Array(u.length >> 2);
    for (let k = 0; k < t.length; k++) t[k] = dv.getFloat32(4 * k, true);
    fTab = t;
  }
  return fTab;
}

/**
 * The index of FL's factory preset "Default/Bowed 6": FL's plugin database entry for Sakura (the state a new
 * instance loads) holds exactly its values, and no MIDI links (this chunk has none).
 */
export const SK_INSERT_PRESET = SK_PRESET_NAMES.indexOf('Default/Bowed 6');

/** The engine values of factory preset i (0..500, SK_PRESET_NAMES) as model state; the mode state for anything else. */
export function skPresetState(i: number): SkStateLike {
  const tab = floatTable();
  const v = SK_MODE.map((k) => tab[k]);
  const d = SK_DIFF[i] ?? '';
  if (d.length >= MASK_CHARS) {
    let p = MASK_CHARS;
    for (let k = 0; k < SK_ENGINE_COUNT; k++) {
      if ((b64(d, Math.floor(k / 6)) >> (k % 6)) & 1) {
        const c = b64(d, p++);
        let n: number;
        if (c < 16) n = c;
        else if (c < 48) n = 16 + (c - 16) * 64 + b64(d, p++);
        else { n = 2064 + (c - 48) * 4096 + b64(d, p) * 64 + b64(d, p + 1); p += 2; }
        v[k] = tab[n];
      }
    }
  }
  const st: SkStateLike = {};
  for (let k = 0; k < SK_PARAM_COUNT; k++) st[SK_PARAM_KEYS[k]] = v[k] * 256 + 0;
  st.hidden = v.slice(SK_PARAM_COUNT);
  return st;
}

/** FL's plugin database state (see SK_INSERT_PRESET). */
export function skInsertState(): SkStateLike {
  return skPresetState(SK_INSERT_PRESET);
}

let insState: SkStateLike | null = null;
let insRawCache: number[] | null = null;
const cachedInsert = (): SkStateLike => (insState ??= skInsertState());
/** The 78 parameters' insertion values (raw), cached (do not modify). */
const insertRaw = (): number[] => (insRawCache ??= SK_PARAM_KEYS.slice(0, SK_PARAM_COUNT).map((k) => Number(cachedInsert()[k])));
/** The insertion state's hidden settings, cached (do not modify). */
const insertHidden = (): number[] => cachedInsert().hidden as number[];
