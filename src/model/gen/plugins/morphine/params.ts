// Morphine (FL: Morphine, Plugin database > Generators > Synth special): FL's
// 252 automatable parameters, from FL 2026's Morphine_x64.dylib (plugin 1.7.0
// Rev2653, arm64; .flref/morphine/NOTES.md section 3, notes/params.tsv).
//
// Every parameter is FL's raw 0..256 control (CFLWrapper: the plugin stores
// f = clamp(raw / 256, 0, 1) as a float32 and reports trunc(f * 256)). FL's
// factory programs store floats that are not multiples of 1/256 (the
// constructor's Master Level is 0.495 = raw 126.72, "-0.2 dB"), so the state
// keeps the exact control value f * 256 (step 0: continuous); f = value / 256
// is then exactly FL's stored float. Booleans are f != 0.
//
// Indices 0..122 are the program parameters (Prog_GetParamName 0x4b34c, value
// texts 0x4af0c + " " + unit 0x4aea8, exactly as GetName(FPN_ParamValue) builds
// them, a trailing space included when the unit is empty); 123..250 are MIDI
// CC 0..127 and 251 channel aftertouch: not saved by FL, forwarded to the synth
// as int(f * 127) (CC 7, 10 and 32 are dropped) where they feed the modulation
// matrix sources "CC n" / "Chn. Aftertouch".

import type { GenParamDef } from '../../types';
import { exp2, fmaD } from './libm';

const f32 = Math.fround;

/** FL's stored float of a control value. */
export function fOf(v: number): number {
  const x = v / 256;
  return f32(x > 1 ? 1 : x > 0 ? x : 0);
}

/** Control value of a stored float. */
export const vOf = (f: number): number => f32(f) * 256;

const CV = new DataView(new ArrayBuffer(8));
/**
 * C printf("%.<d>f", x): the exact binary value rounded half to even at `d`
 * decimals (Apple libc), a minus sign kept for negative values that round to 0.
 */
export function cFixed(x: number, d: number): string {
  if (x !== x) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  CV.setFloat64(0, x);
  const hi = CV.getUint32(0), lo = CV.getUint32(4);
  const neg = hi >>> 31 === 1;
  const ex = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e = -1074;
  if (ex) { m |= 1n << 52n; e = ex - 1075; }
  const n = m * 10n ** BigInt(d);
  let q: bigint;
  if (e >= 0) q = n << BigInt(e);
  else {
    const s = BigInt(-e);
    q = n >> s;
    const r = n - (q << s), half = 1n << (s - 1n);
    if (r > half || (r === half && (q & 1n) === 1n)) q += 1n;
  }
  let str = q.toString();
  if (d > 0) {
    str = str.padStart(d + 1, '0');
    str = `${str.slice(0, str.length - d)}.${str.slice(str.length - d)}`;
  }
  return (neg ? '-' : '') + str;
}

/** C (int) of a double / float value. */
const ti = (x: number): number => (x !== x ? 0 : Math.trunc(x));

/** Default text: (int)(f * 100) "%" (float multiply). */
export const pctText = (f: number): string => `${ti(f32(f * 100))} %`;
/** Bipolar text: (int)(f * 200 - 100) "%" (float fused multiply-add). */
export const bipText = (f: number): string => `${ti(f32(f * 200 - 100))} %`;

/** The value text of program parameter `index` (0..122; internal 124..161 too) for its stored float. */
export function progValueText(index: number, f: number): string {
  switch (index) {
    case 0: return `${cFixed(f * 48 - 24, 1)} dB`;
    case 3: return `${ti(f * 12)} `;
    case 4: return `${ti(f * 48 - 24)} `;
    case 5: case 142: return `${ti(f * 200 - 100)} `;
    case 9: return `${cFixed(f32(f * 5 + 0.1), 1)} Hz`;
    case 11: { const a = fmaD(f, 0.95, 0.05); return `${ti(a * a * 1000)} ms`; }
    case 21: case 22: case 23: case 24: case 25: case 26: case 27: case 28:
      return `${cFixed(f32(f * 24 - 12), 1)} dB`;
    case 39: return `${cFixed(exp2(f * 4 - 2), 2)} `;
    case 40: return `${ti(exp2(f * 9) * 35)} Hz`;
    case 141: return `${ti(Math.min(96, Math.max(24, Math.trunc(f * 72) + 24)))} `;
    default:
      if (BIPOLAR.has(index) || (index >= 150 && index <= 161)) return bipText(f);
      return pctText(f);
  }
}

/** Program parameters shown bipolar ((int)(f*200-100) %). */
const BIPOLAR = new Set([12, 35, 45, 46, 47, 55, 56, 57, 65, 66, 67, 75, 76, 77, 84, 85, 86, 88, 91, 94, 97,
  101, 102, 103, 107, 108, 109, 113, 114, 115, 119, 120, 121]);

export const GENS = ['a', 'b', 'c', 'd'] as const;
const GEN_NAMES = ['A', 'B', 'C', 'D'];

/** State keys of FL's parameters 0..251, in FL index order. */
export const MOR_KEYS: string[] = [
  'level', 'glide', 'velCurve', 'bend', 'transpose', 'fine', 'drive',
  'chDepth', 'chWet', 'chRate', 'chOn', 'dlTime', 'dlStereo', 'dlMod', 'dlFb', 'dlWet', 'dlOn',
  'rvDecay', 'rvSize', 'rvMix', 'rvOn', 'eq1', 'eq2', 'eq3', 'eq4', 'eq5', 'eq6', 'eq7', 'eq8', 'eqOn',
  'attack', 'decay', 'sustain', 'release',
  'nzMix', 'nzPan', 'nzMute', 'nzMono', 'nzVel', 'nzRatio', 'nzCut', 'nzRes', 'nzKey',
  ...GENS.flatMap((g) => ['RelLoop', 'Sync', 'Rate', 'VelTrk', 'KeyTrk', 'PwmFree', 'PwmRate', 'PwmPhase', 'Detune', 'PanRange'].map((s) => g + s)),
  'mSync', 'mRate', 'mKeyTrk', 'mVelTrk',
  ...GENS.flatMap((g) => ['Mix', 'Pan', 'Mute'].map((s) => g + s)),
  ...[1, 2, 3, 4].flatMap((e) => ['RelLoop', 'Sync', 'Rate', 'KeyTrk', 'VelTrk', 'Vel'].map((s) => `e${e}${s}`)),
  ...Array.from({ length: 128 }, (_, k) => `cc${k}`),
  'at',
];

/** FL's parameter names 0..122 (Prog_GetParamName). */
export const PROG_NAMES: string[] = [
  'Master Level', 'Glide Time', 'Velocity Curve', 'Bend Range', 'Transpose', 'Fine Tune', 'Overdrive',
  'Chorus Depth', 'Chorus Wet', 'Chorus Rate', 'Chorus Enable', 'Delay Time', 'Delay Stereo', 'Delay Modulation',
  'Delay Feedback', 'Delay Wet', 'Delay On', 'Reverb Decay', 'Reverb Size', 'Reverb Mix', 'Reverb Enable',
  'Eq Band 1', 'Eq Band 2', 'Eq Band 3', 'Eq Band 4', 'Eq Band 5', 'Eq Band 6', 'Eq Band 7', 'Eq Band 8', 'Eq Enable',
  'Master Attack', 'Master Decay', 'Master Sustain', 'Master Release',
  'Noise Mix', 'Noise Pan', 'Noise Mute', 'Noise Mono Mode', 'Noise VelSens', 'Noise Ratio', 'Noise Flt Cutoff',
  'Noise Flt Resonance', 'Noise Flt KeyTrk',
  ...GEN_NAMES.flatMap((g) => ['Release Loop', 'Tempo Sync', 'Rate', 'Rate VelTrk', 'Rate KeyTrk', 'PWM Free', 'PWM Rate',
    'PWM Phase', 'Detune Range', 'Panning Range'].map((s) => `Gen ${g}: ${s}`)),
  'Morph: Tempo Sync', 'Morph: Rate', 'Morph: Rate KeyTrk', 'Morph: Rate VelTrk',
  ...GEN_NAMES.flatMap((g) => ['Mix', 'Pan', 'Mute'].map((s) => `Gen ${g}: ${s}`)),
  ...[1, 2, 3, 4].flatMap((e) => ['Release Loop', 'Tempo Sync', 'Rate', 'Rate KeyTrk', 'Rate VelTrk', 'Velocity'].map((s) => `Eg${e}: ${s}`)),
];

/** Number of program parameters FL exposes (GlobalInfo+0x11c). */
export const N_PROG = 123;
/** First MIDI CC parameter; 251 = channel aftertouch. */
export const CC0 = 123;
export const AFTERTOUCH = 251;

/**
 * Reset values of the program parameters (stored floats): FL's "Reset Program"
 * (0x4ab8c) for 0..42 and the generator / morph / envelope objects' defaults
 * (CVoiceGen trailer defaults .5,0,0,0,1,1; timelines, morph and envelopes:
 * rates and key / velocity tracking .5). The default state (state.ts) uses them.
 */
export const PROG_DEFAULTS: number[] = (() => {
  const d = new Array<number>(N_PROG).fill(0);
  const set = (i: number, v: number) => { d[i] = f32(v); };
  set(0, 0.5); set(2, 0.25); set(3, 0.175); set(4, 0.5); set(5, 0.5);
  for (const i of [7, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19]) set(i, 0.5);
  for (let i = 21; i <= 28; i++) set(i, 0.5);
  set(31, 1); set(32, 1);
  set(34, 0.5); set(35, 0.5); set(38, 1); set(39, 0.5); set(40, 1);
  for (let g = 0; g < 4; g++) {
    const b = 43 + 10 * g;
    set(b + 2, 0.5); set(b + 3, 0.5); set(b + 4, 0.5); set(b + 6, 0.5); set(b + 8, 1); set(b + 9, 1);
    set(87 + 3 * g, 1); set(88 + 3 * g, 0.5);
  }
  set(84, 0.5); set(85, 0.5); set(86, 0.5);
  for (let e = 0; e < 4; e++) { const b = 99 + 6 * e; set(b + 2, 0.5); set(b + 3, 0.5); set(b + 4, 0.5); }
  return d;
})();

function def(index: number): GenParamDef {
  const key = MOR_KEYS[index];
  if (index < N_PROG) {
    return {
      key, name: PROG_NAMES[index], index, min: 0, max: 256, def: vOf(PROG_DEFAULTS[index]), step: 0,
      format: (v: number) => progValueText(index, fOf(v)),
      ...(BIPOLAR.has(index) || index === 4 || index === 5 ? { bipolar: true } : {}),
    };
  }
  const name = index === AFTERTOUCH ? 'Chn. Aftertouch' : `MIDI CC ${index - CC0}`;
  return { key, name, index, min: 0, max: 256, def: 0, step: 0, format: (v: number) => `${ti(f32(fOf(v) * 127))}` };
}

export const MOR_PARAMS: GenParamDef[] = MOR_KEYS.map((_, i) => def(i));

/** Parameter index of a key. */
export const MOR_INDEX: Record<string, number> = Object.fromEntries(MOR_KEYS.map((k, i) => [k, i]));

/** Parameter indices of generator g's 10 controls (Release Loop .. Panning Range). */
export const genParam = (g: number, k: number): number => 43 + 10 * g + k;
/** Parameter index of generator g's Mix (0) / Pan (1) / Mute (2). */
export const mixParam = (g: number, k: number): number => 87 + 3 * g + k;
/** Parameter index of envelope e's controls (Release Loop, Tempo Sync, Rate, Rate KeyTrk, Rate VelTrk, Velocity). */
export const envParam = (e: number, k: number): number => 99 + 6 * e + k;
