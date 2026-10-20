// Toxic Biohazard parameter data, from FL 2026's Toxic Biohazard: FL's 423
// parameters (the engine's values 0..293, MIDI CC 0..127, channel aftertouch),
// the hidden engine values 294..339 (unison, polyphony, glide mode, LFO
// sync / free run, filter type, operator / LFO shapes, effect types and
// sync, the MIDI modulation matrix), the custom harmonics and the CC link map.

import { TX_CC_REFS, TX_DIFF, TX_FLOATS, TX_MODE, TX_PRESET_NAMES, TX_WAVES, TX_WAVE_REFS } from './presets';

export const TX_PARAM_COUNT = 294;

export const TX_PARAM_NAMES: string[] = [
  "Gain", "Distortion", "Transpose", "Master Atk", "Master Dec", "Master Sus", "Master Rel", "Vel. Curve",
  "Unison Dtn", "Unison Pan", "Glide Time", "EGF to Pitch", "Lfo2 to Pitch", "Lfo1 Speed", "Lfo2 Speed",
  "Flt Cutoff", "Flt Res", "Flt KeyTrk", "Flt VelTrk", "Flt EG Atk", "Flt EG Dec", "Flt EG Sus", "Flt EG Rel",
  "Flt Eg Amnt", "Flt Lfo1 Amnt", "O1 Enable", "O2 Enable", "O3 Enable", "O4 Enable", "O5 Enable", "O6 Enable",
  "O1 Coarse", "O2 Coarse", "O3 Coarse", "O4 Coarse", "O5 Coarse", "O6 Coarse", "O1 Fine", "O2 Fine", "O3 Fine",
  "O4 Fine", "O5 Fine", "O6 Fine", "O1 Frq Shift", "O2 Frq Shift", "O3 Frq Shift", "O4 Frq Shift", "O5 Frq Shift",
  "O6 Frq Shift", "O1 Free Run", "O2 Free Run", "O3 Free Run", "O4 Free Run", "O5 Free Run", "O6 Free Run",
  "O1 Phase", "O2 Phase", "O3 Phase", "O4 Phase", "O5 Phase", "O6 Phase", "O1 VelSens", "O2 VelSens", "O3 VelSens",
  "O4 VelSens", "O5 VelSens", "O6 VelSens", "O1 Init", "O2 Init", "O3 Init", "O4 Init", "O5 Init", "O6 Init",
  "O1 Atk", "O2 Atk", "O3 Atk", "O4 Atk", "O5 Atk", "O6 Atk", "O1 Dec", "O2 Dec", "O3 Dec", "O4 Dec", "O5 Dec",
  "O6 Dec", "O1 Sus", "O2 Sus", "O3 Sus", "O4 Sus", "O5 Sus", "O6 Sus", "O1 Rel", "O2 Rel", "O3 Rel", "O4 Rel",
  "O5 Rel", "O6 Rel", "O1 Pan", "O2 Pan", "O3 Pan", "O4 Pan", "O5 Pan", "O6 Pan", "O1 Mix", "O2 Mix", "O3 Mix",
  "O4 Mix", "O5 Mix", "O6 Mix", "O1 Fm 1", "O2 Fm 1", "O3 Fm 1", "O4 Fm 1", "O5 Fm 1", "O6 Fm 1", "O1 Fm 2",
  "O2 Fm 2", "O3 Fm 2", "O4 Fm 2", "O5 Fm 2", "O6 Fm 2", "O1 Fm 3", "O2 Fm 3", "O3 Fm 3", "O4 Fm 3", "O5 Fm 3",
  "O6 Fm 3", "O1 Fm 4", "O2 Fm 4", "O3 Fm 4", "O4 Fm 4", "O5 Fm 4", "O6 Fm 4", "O1 Fm 5", "O2 Fm 5", "O3 Fm 5",
  "O4 Fm 5", "O5 Fm 5", "O6 Fm 5", "O1 Fm 6", "O2 Fm 6", "O3 Fm 6", "O4 Fm 6", "O5 Fm 6", "O6 Fm 6", "LFO1 Osc1",
  "LFO1 Osc2", "LFO1 Osc3", "LFO1 Osc4", "LFO1 Osc5", "LFO1 Osc6", "LFO2 Osc1", "LFO2 Osc2", "LFO2 Osc3",
  "LFO2 Osc4", "LFO2 Osc5", "LFO2 Osc6", "Seq Play", "Seq Swing", "Seq P-P", "Seq Rnd", "Seq Dual", "Seq Steps",
  "Seq Ptrn 0", "Seq Ptrn 1", "Seq Ptrn 2", "Seq Ptrn 3", "Seq Ptrn 4", "Seq Ptrn 5", "Seq Ptrn 6", "Seq Ptrn 7",
  "Seq Ptrn 8", "Seq Ptrn 9", "Seq Ptrn 10", "Seq Ptrn 11", "Seq Ptrn 12", "Seq Ptrn 13", "Seq Ptrn 14",
  "Seq Ptrn 15", "Seq Ptrn 16", "Seq Ptrn 17", "Seq Ptrn 18", "Seq Ptrn 19", "Seq Ptrn 20", "Seq Ptrn 21",
  "Seq Ptrn 22", "Seq Ptrn 23", "Seq Ptrn 24", "Seq Ptrn 25", "Seq Ptrn 26", "Seq Ptrn 27", "Seq Ptrn 28",
  "Seq Ptrn 29", "Seq Ptrn 30", "Seq Ptrn 31", "Seq Ptrn 32", "Seq Ptrn 33", "Seq Ptrn 34", "Seq Ptrn 35",
  "Seq Ptrn 36", "Seq Ptrn 37", "Seq Ptrn 38", "Seq Ptrn 39", "Seq Ptrn 40", "Seq Ptrn 41", "Seq Ptrn 42",
  "Seq Ptrn 43", "Seq Ptrn 44", "Seq Ptrn 45", "Seq Ptrn 46", "Seq Ptrn 47", "Seq Ptrn 48", "Seq Ptrn 49",
  "Seq Ptrn 50", "Seq Ptrn 51", "Seq Ptrn 52", "Seq Ptrn 53", "Seq Ptrn 54", "Seq Ptrn 55", "Seq Ptrn 56",
  "Seq Ptrn 57", "Seq Ptrn 58", "Seq Ptrn 59", "Seq Ptrn 60", "Seq Ptrn 61", "Seq Ptrn 62", "Seq Ptrn 63", "EQ On ",
  "EQ Band1", "EQ Band2", "EQ Band3", "EQ Band4", "EQ Band5", "EQ Band6", "EQ Band7", "EQ Band8", "Fx1 Enable",
  "Fx2 Enable", "Flang1 Delay", "Flang2 Delay", "Flang1 Fdbk", "Flang2 Fdbk", "Flang1 Depth", "Flang2 Depth",
  "Flang1 Rate", "Flang2 Rate", "Flang1 Mix", "Flang2 Mix", "Flang1 -Fdbk", "Flang2 Inv. Fdbk", "Flang1 -Mix",
  "Flang2 Inv. Mix", "Chor1 Depth", "Chor2 Depth", "Chor1 Rate", "Chor2 Rate", "Chor1 Mix", "Chor2 Mix", "Rev1 Mix",
  "Rev2 Mix", "Rev1 Decay", "Rev2 Decay", "Rev1 Damp", "Rev2 Damp", "Rev1 Hi-Cut", "Rev2 Hi-Cut", "Delay1 Time",
  "Delay2 Time", "Delay1 Fdbk", "Delay2 Fdbk", "Delay1 Rate", "Delay2 Rate", "Delay1 Depth", "Delay2 Depth",
  "Delay1 Blur", "Delay2 Blur", "Delay1 Mix", "Delay2 Mix", "LoFi1 Bits", "LoFi2 Bits", "LoFi1 Smp", "LoFi2 Smp",
  "LoFi1 Flt", "LoFi2 Flt", "Phas1 Frq", "Phas2 Frq", "Phas1 Rate", "Phas2 Rate", "Phas1 Dpth", "Phas2 Dpth",
  "Phas1 Fdbk", "Phas2 Fdbk", "Phas1 Mix", "Phas2 Mix", "MIDI CC 0", "MIDI CC 1", "MIDI CC 2", "MIDI CC 3",
  "MIDI CC 4", "MIDI CC 5", "MIDI CC 6", "MIDI CC 7", "MIDI CC 8", "MIDI CC 9", "MIDI CC 10", "MIDI CC 11",
  "MIDI CC 12", "MIDI CC 13", "MIDI CC 14", "MIDI CC 15", "MIDI CC 16", "MIDI CC 17", "MIDI CC 18", "MIDI CC 19",
  "MIDI CC 20", "MIDI CC 21", "MIDI CC 22", "MIDI CC 23", "MIDI CC 24", "MIDI CC 25", "MIDI CC 26", "MIDI CC 27",
  "MIDI CC 28", "MIDI CC 29", "MIDI CC 30", "MIDI CC 31", "MIDI CC 32", "MIDI CC 33", "MIDI CC 34", "MIDI CC 35",
  "MIDI CC 36", "MIDI CC 37", "MIDI CC 38", "MIDI CC 39", "MIDI CC 40", "MIDI CC 41", "MIDI CC 42", "MIDI CC 43",
  "MIDI CC 44", "MIDI CC 45", "MIDI CC 46", "MIDI CC 47", "MIDI CC 48", "MIDI CC 49", "MIDI CC 50", "MIDI CC 51",
  "MIDI CC 52", "MIDI CC 53", "MIDI CC 54", "MIDI CC 55", "MIDI CC 56", "MIDI CC 57", "MIDI CC 58", "MIDI CC 59",
  "MIDI CC 60", "MIDI CC 61", "MIDI CC 62", "MIDI CC 63", "MIDI CC 64", "MIDI CC 65", "MIDI CC 66", "MIDI CC 67",
  "MIDI CC 68", "MIDI CC 69", "MIDI CC 70", "MIDI CC 71", "MIDI CC 72", "MIDI CC 73", "MIDI CC 74", "MIDI CC 75",
  "MIDI CC 76", "MIDI CC 77", "MIDI CC 78", "MIDI CC 79", "MIDI CC 80", "MIDI CC 81", "MIDI CC 82", "MIDI CC 83",
  "MIDI CC 84", "MIDI CC 85", "MIDI CC 86", "MIDI CC 87", "MIDI CC 88", "MIDI CC 89", "MIDI CC 90", "MIDI CC 91",
  "MIDI CC 92", "MIDI CC 93", "MIDI CC 94", "MIDI CC 95", "MIDI CC 96", "MIDI CC 97", "MIDI CC 98", "MIDI CC 99",
  "MIDI CC 100", "MIDI CC 101", "MIDI CC 102", "MIDI CC 103", "MIDI CC 104", "MIDI CC 105", "MIDI CC 106",
  "MIDI CC 107", "MIDI CC 108", "MIDI CC 109", "MIDI CC 110", "MIDI CC 111", "MIDI CC 112", "MIDI CC 113",
  "MIDI CC 114", "MIDI CC 115", "MIDI CC 116", "MIDI CC 117", "MIDI CC 118", "MIDI CC 119", "MIDI CC 120",
  "MIDI CC 121", "MIDI CC 122", "MIDI CC 123", "MIDI CC 124", "MIDI CC 125", "MIDI CC 126", "MIDI CC 127",
  "Chn. Aftertouch",
];

export const TX_PARAM_KEYS: string[] = [
  "gain", "distortion", "transpose", "masterAtk", "masterDec", "masterSus", "masterRel", "velCurve", "unisonDtn",
  "unisonPan", "glideTime", "egfToPitch", "lfo2ToPitch", "lfo1Speed", "lfo2Speed", "fltCutoff", "fltRes",
  "fltKeyTrk", "fltVelTrk", "fltEGAtk", "fltEGDec", "fltEGSus", "fltEGRel", "fltEgAmnt", "fltLfo1Amnt", "o1Enable",
  "o2Enable", "o3Enable", "o4Enable", "o5Enable", "o6Enable", "o1Coarse", "o2Coarse", "o3Coarse", "o4Coarse",
  "o5Coarse", "o6Coarse", "o1Fine", "o2Fine", "o3Fine", "o4Fine", "o5Fine", "o6Fine", "o1FrqShift", "o2FrqShift",
  "o3FrqShift", "o4FrqShift", "o5FrqShift", "o6FrqShift", "o1FreeRun", "o2FreeRun", "o3FreeRun", "o4FreeRun",
  "o5FreeRun", "o6FreeRun", "o1Phase", "o2Phase", "o3Phase", "o4Phase", "o5Phase", "o6Phase", "o1VelSens",
  "o2VelSens", "o3VelSens", "o4VelSens", "o5VelSens", "o6VelSens", "o1Init", "o2Init", "o3Init", "o4Init", "o5Init",
  "o6Init", "o1Atk", "o2Atk", "o3Atk", "o4Atk", "o5Atk", "o6Atk", "o1Dec", "o2Dec", "o3Dec", "o4Dec", "o5Dec",
  "o6Dec", "o1Sus", "o2Sus", "o3Sus", "o4Sus", "o5Sus", "o6Sus", "o1Rel", "o2Rel", "o3Rel", "o4Rel", "o5Rel",
  "o6Rel", "o1Pan", "o2Pan", "o3Pan", "o4Pan", "o5Pan", "o6Pan", "o1Mix", "o2Mix", "o3Mix", "o4Mix", "o5Mix",
  "o6Mix", "o1Fm1", "o2Fm1", "o3Fm1", "o4Fm1", "o5Fm1", "o6Fm1", "o1Fm2", "o2Fm2", "o3Fm2", "o4Fm2", "o5Fm2",
  "o6Fm2", "o1Fm3", "o2Fm3", "o3Fm3", "o4Fm3", "o5Fm3", "o6Fm3", "o1Fm4", "o2Fm4", "o3Fm4", "o4Fm4", "o5Fm4",
  "o6Fm4", "o1Fm5", "o2Fm5", "o3Fm5", "o4Fm5", "o5Fm5", "o6Fm5", "o1Fm6", "o2Fm6", "o3Fm6", "o4Fm6", "o5Fm6",
  "o6Fm6", "lfo1Osc1", "lfo1Osc2", "lfo1Osc3", "lfo1Osc4", "lfo1Osc5", "lfo1Osc6", "lfo2Osc1", "lfo2Osc2",
  "lfo2Osc3", "lfo2Osc4", "lfo2Osc5", "lfo2Osc6", "seqPlay", "seqSwing", "seqPingPong", "seqRnd", "seqDual",
  "seqSteps", "seqPtrn0", "seqPtrn1", "seqPtrn2", "seqPtrn3", "seqPtrn4", "seqPtrn5", "seqPtrn6", "seqPtrn7",
  "seqPtrn8", "seqPtrn9", "seqPtrn10", "seqPtrn11", "seqPtrn12", "seqPtrn13", "seqPtrn14", "seqPtrn15", "seqPtrn16",
  "seqPtrn17", "seqPtrn18", "seqPtrn19", "seqPtrn20", "seqPtrn21", "seqPtrn22", "seqPtrn23", "seqPtrn24",
  "seqPtrn25", "seqPtrn26", "seqPtrn27", "seqPtrn28", "seqPtrn29", "seqPtrn30", "seqPtrn31", "seqPtrn32",
  "seqPtrn33", "seqPtrn34", "seqPtrn35", "seqPtrn36", "seqPtrn37", "seqPtrn38", "seqPtrn39", "seqPtrn40",
  "seqPtrn41", "seqPtrn42", "seqPtrn43", "seqPtrn44", "seqPtrn45", "seqPtrn46", "seqPtrn47", "seqPtrn48",
  "seqPtrn49", "seqPtrn50", "seqPtrn51", "seqPtrn52", "seqPtrn53", "seqPtrn54", "seqPtrn55", "seqPtrn56",
  "seqPtrn57", "seqPtrn58", "seqPtrn59", "seqPtrn60", "seqPtrn61", "seqPtrn62", "seqPtrn63", "eqOn", "eqBand1",
  "eqBand2", "eqBand3", "eqBand4", "eqBand5", "eqBand6", "eqBand7", "eqBand8", "fx1Enable", "fx2Enable",
  "flang1Delay", "flang2Delay", "flang1Fdbk", "flang2Fdbk", "flang1Depth", "flang2Depth", "flang1Rate", "flang2Rate",
  "flang1Mix", "flang2Mix", "flang1InvFdbk", "flang2InvFdbk", "flang1InvMix", "flang2InvMix", "chor1Depth",
  "chor2Depth", "chor1Rate", "chor2Rate", "chor1Mix", "chor2Mix", "rev1Mix", "rev2Mix", "rev1Decay", "rev2Decay",
  "rev1Damp", "rev2Damp", "rev1HiCut", "rev2HiCut", "delay1Time", "delay2Time", "delay1Fdbk", "delay2Fdbk",
  "delay1Rate", "delay2Rate", "delay1Depth", "delay2Depth", "delay1Blur", "delay2Blur", "delay1Mix", "delay2Mix",
  "lofi1Bits", "lofi2Bits", "lofi1Smp", "lofi2Smp", "lofi1Flt", "lofi2Flt", "phas1Frq", "phas2Frq", "phas1Rate",
  "phas2Rate", "phas1Dpth", "phas2Dpth", "phas1Fdbk", "phas2Fdbk", "phas1Mix", "phas2Mix", "midiCC0", "midiCC1",
  "midiCC2", "midiCC3", "midiCC4", "midiCC5", "midiCC6", "midiCC7", "midiCC8", "midiCC9", "midiCC10", "midiCC11",
  "midiCC12", "midiCC13", "midiCC14", "midiCC15", "midiCC16", "midiCC17", "midiCC18", "midiCC19", "midiCC20",
  "midiCC21", "midiCC22", "midiCC23", "midiCC24", "midiCC25", "midiCC26", "midiCC27", "midiCC28", "midiCC29",
  "midiCC30", "midiCC31", "midiCC32", "midiCC33", "midiCC34", "midiCC35", "midiCC36", "midiCC37", "midiCC38",
  "midiCC39", "midiCC40", "midiCC41", "midiCC42", "midiCC43", "midiCC44", "midiCC45", "midiCC46", "midiCC47",
  "midiCC48", "midiCC49", "midiCC50", "midiCC51", "midiCC52", "midiCC53", "midiCC54", "midiCC55", "midiCC56",
  "midiCC57", "midiCC58", "midiCC59", "midiCC60", "midiCC61", "midiCC62", "midiCC63", "midiCC64", "midiCC65",
  "midiCC66", "midiCC67", "midiCC68", "midiCC69", "midiCC70", "midiCC71", "midiCC72", "midiCC73", "midiCC74",
  "midiCC75", "midiCC76", "midiCC77", "midiCC78", "midiCC79", "midiCC80", "midiCC81", "midiCC82", "midiCC83",
  "midiCC84", "midiCC85", "midiCC86", "midiCC87", "midiCC88", "midiCC89", "midiCC90", "midiCC91", "midiCC92",
  "midiCC93", "midiCC94", "midiCC95", "midiCC96", "midiCC97", "midiCC98", "midiCC99", "midiCC100", "midiCC101",
  "midiCC102", "midiCC103", "midiCC104", "midiCC105", "midiCC106", "midiCC107", "midiCC108", "midiCC109",
  "midiCC110", "midiCC111", "midiCC112", "midiCC113", "midiCC114", "midiCC115", "midiCC116", "midiCC117",
  "midiCC118", "midiCC119", "midiCC120", "midiCC121", "midiCC122", "midiCC123", "midiCC124", "midiCC125",
  "midiCC126", "midiCC127", "chnAftertouch",
];

const f32 = Math.fround;
const clampI = (n: number, lo: number, hi: number): number => (n > lo ? (n < hi ? n : hi) : lo);
const tz = (x: number): number => (x === x ? Math.trunc(x) : 0);

/** C printf("%.Nf"): toFixed, but exact binary ties round half to even like the C library. */
function cFixed(x: number, d: number): string {
  const m = 10 ** d, t = Math.abs(x) * m, fl = Math.floor(t);
  if (t - fl === 0.5 && fl % 2 === 0 && Number.isSafeInteger(fl)) return ((x < 0 ? -fl : fl) / m).toFixed(d);
  return x.toFixed(d);
}
const env = (v: number): number => Math.max(50 * ((v * v) * (v * v)), 0.00101);

/** FL's value text of Toxic Biohazard parameter i (0..422) at raw value r (FL's 0..256 scale). */
export function txFormat(i: number, r: number): string {
  if (i >= TX_PARAM_COUNT) return String(clampI(tz(Math.min(Math.max(r / 256, 0), 1) * 127), 0, 127));
  const v = f32(r / 256);
  const unit = i === 0 || (i >= 228 && i <= 235) ? 'dB'
    : i === 3 || i === 4 || i === 6 || i === 19 || i === 20 || i === 22 || (i >= 73 && i <= 84) || (i >= 91 && i <= 96) ? 's'
      : i === 13 || i === 14 || (i >= 43 && i <= 48) ? 'Hz' : '%';
  let t: string;
  if (i === 0) t = cFixed(f32(v * 60 - 30), 1);
  else if (i === 2 || i === 11) t = String(clampI(tz(f32(v * 48 - 24)), -24, 24));
  else if (i === 6) t = cFixed(env(v) * 0.35 + 0.019999999552965164, 3);
  else if (i === 3 || i === 4 || i === 19 || i === 20 || i === 22 || (i >= 73 && i <= 84) || (i >= 91 && i <= 96)) t = cFixed(env(v), 3);
  else if (i === 13 || i === 14) t = cFixed(f32(f32(f32(v * v) * 20) * v + f32(0.01)), 2);
  else if (i === 23) { const s = f32(v * 2 - 1); t = cFixed(f32(Math.abs(s) * s) * 100, 2); }
  else if (i >= 31 && i <= 42) t = String(clampI(tz(f32(v * 198 - 99)), -99, 99));
  else if (i >= 43 && i <= 48) { const s = f32(v * 2 - 1); t = cFixed((s * s) * (s * s) * (s * 4000), 2); }
  else if (i >= 97 && i <= 102) t = String(clampI(tz(f32(f32(v * 100) - 50)), -50, 50));
  else if (i >= 145 && i <= 156) t = String(clampI(tz(f32(v * 199 - 99)), -99, 100));
  else if (i === 162) t = String(clampI(tz(f32(v * 63 + 1)), 1, 64));
  else if (i >= 163 && i <= 226) {
    const n = clampI(tz(f32(v * 50 - 26)), -26, 24);
    t = n === -25 ? 'SUS' : n === -26 ? '---' : String(n);
  } else if (i >= 228 && i <= 235) t = cFixed(v * 36 - 18, 1);
  else t = String(clampI(tz(f32(v * 100)), 0, 100));
  return `${t} ${unit}`;
}

/** The model state of an instance (FL's chunk, decoded). */
export interface TxStateLike {
  [key: string]: unknown;
  /** engine values 294..339 */
  hidden?: number[];
  /** custom harmonics per operator / LFO: 128 amplitudes + 128 phases, or 0 when empty */
  waves?: (number[] | 0)[];
  /** CC number linked to each FL parameter 0..293 (-1 = none) */
  ccMap?: number[];
}

export interface TxValues {
  values: Float64Array;
  waves: ([Float32Array, Float32Array] | null)[];
  ccMap: Uint8Array;
}

/** Model state -> the engine's 340 values (FL parameters raw / 256), harmonics and CC map. */
export function txStateValues(st: TxStateLike): TxValues {
  const values = new Float64Array(340);
  for (let i = 0; i < TX_PARAM_COUNT; i++) {
    const raw = Number(st[TX_PARAM_KEYS[i]]);
    values[i] = Number.isFinite(raw) ? raw / 256 : 0;
  }
  const h = Array.isArray(st.hidden) ? st.hidden : [];
  for (let i = 294; i < 340; i++) {
    const v = Number(h[i - 294]);
    values[i] = Number.isFinite(v) ? v : 0;
  }
  const waves: ([Float32Array, Float32Array] | null)[] = [];
  const w = Array.isArray(st.waves) ? st.waves : [];
  for (let k = 0; k < 8; k++) {
    const a = w[k];
    if (Array.isArray(a) && a.length >= 256) waves.push([Float32Array.from(a.slice(0, 128)), Float32Array.from(a.slice(128, 256))]);
    else waves.push(null);
  }
  const ccMap = new Uint8Array(294).fill(0xff);
  const m = Array.isArray(st.ccMap) ? st.ccMap : [];
  for (let i = 0; i < 294; i++) {
    const c = Math.trunc(Number(m[i]));
    if (c >= 0 && c <= 127) ccMap[i] = c;
  }
  return { values, waves, ccMap };
}

/**
 * FL's state chunk (magic TBi2 / TBio / TBiD; the .tbio preset files) -> model state: the 340 values (FL
 * parameters as raw x 256, the hidden ones as is), custom harmonics, CC link map. Old (TBio) chunks number
 * the modulation sources differently (FL converts them on load). Returns null for anything else.
 */
export function txChunkToState(b: Uint8Array): TxStateLike | null {
  if (b.length < 0x44 + 0x2000 + 0x550) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x54426932 && magic !== 0x5442696f && magic !== 0x54426944) return null;
  const st: TxStateLike = {};
  const waves: (number[] | 0)[] = [];
  let p = 0x44;
  for (let k = 0; k < 8; k++) {
    const a: number[] = [];
    let nz = false;
    for (let i = 0; i < 256; i++) {
      const v = dv.getFloat32(p + i * 4, true);
      a.push(v);
      if (v !== 0) nz = true;
    }
    waves.push(nz ? a : 0);
    p += 0x400;
  }
  const v: number[] = [];
  for (let i = 0; i < 340; i++) v.push(dv.getFloat32(p + i * 4, true));
  p += 0x550;
  if (magic === 0x5442696f) {
    for (let k = 0; k < 8; k++) {
      const s = Math.trunc(v[316 + k]);
      if (s !== 0) v[316 + k] = (s > 2 ? s + 1 : s) + 3;
    }
  }
  for (let i = 0; i < TX_PARAM_COUNT; i++) st[TX_PARAM_KEYS[i]] = v[i] * 256;
  st.hidden = v.slice(294);
  st.waves = waves;
  const cc: number[] = [];
  for (let i = 0; i < 294; i++) {
    const c = p + i < b.length ? b[p + i] : 0xff;
    cc.push(c <= 127 ? c : -1);
  }
  st.ccMap = cc;
  return st;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64v = (s: string, i: number): number => B64.indexOf(s[i]) * 64 + B64.indexOf(s[i + 1]);

function floats(b64: string): Float32Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Float32Array(u.buffer);
}

let fTab: Float32Array | null = null;
let wTab: Float32Array | null = null;

/** The insertion state: FL's plugin database entry = the first factory preset, "Ambient Textures/AquaTone ToTc". */
export const TX_INSERT_PRESET = 1;

export { TX_PRESET_NAMES };

/** A factory preset as model state. */
export function txPresetState(i: number): TxStateLike {
  fTab ??= floats(TX_FLOATS);
  wTab ??= floats(TX_WAVES);
  const v = TX_MODE.map((k) => fTab![k]);
  const d = TX_DIFF[i] ?? '';
  for (let j = 0; j + 3 < d.length; j += 4) v[b64v(d, j)] = fTab[b64v(d, j + 2)];
  const st: TxStateLike = {};
  for (let k = 0; k < TX_PARAM_COUNT; k++) st[TX_PARAM_KEYS[k]] = v[k] * 256;
  st.hidden = v.slice(294);
  const wr = TX_WAVE_REFS[i] ?? '';
  const waves: (number[] | 0)[] = [];
  for (let k = 0; k < 8; k++) {
    const a = wr ? b64v(wr, k * 4) : 0, p = wr ? b64v(wr, k * 4 + 2) : 0;
    if (!a && !p) { waves.push(0); continue; }
    const out = new Array<number>(256).fill(0);
    if (a) for (let h = 0; h < 128; h++) out[h] = wTab[(a - 1) * 128 + h];
    if (p) for (let h = 0; h < 128; h++) out[128 + h] = wTab[(p - 1) * 128 + h];
    waves.push(out);
  }
  st.waves = waves;
  const cc = new Array<number>(294).fill(-1);
  const cr = TX_CC_REFS[i] ?? '';
  for (let j = 0; j + 3 < cr.length; j += 4) cc[b64v(cr, j)] = b64v(cr, j + 2);
  st.ccMap = cc;
  return st;
}
