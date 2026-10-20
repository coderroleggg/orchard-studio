// Harmor's parameter value texts: an exact port of FL's GetName(FPN_ParamValue)
// (TTestPlug slot 4 = 0xd9890 -> value-text function 0xd4350 with "short"
// flag 1; index mapping 0xd1010). Checked against `flfxhost sweep` for every
// value of every parameter (scratchpad/harmor/texts/check.mjs); see
// docs/research/gen/harmor.md, "Value texts".
//
// How FL builds them:
// - 0xd1010 maps the FL index to (part, local index): local = index - 386 * part
//   for 0..771, the index itself for the globals. Articulator envelope / LFO
//   fields (local 95..342) become local = field 0..7 (FL's bug: they are then
//   formatted by the handlers of part parameters 0..7, e.g. "Attack time
//   scale" 128 reads "46" like a starting phase in degrees); the articulator
//   smoothing knobs (343..385) fall to the default handler.
// - Default handler: round(100 v / Max)% with Max the editor control's Max.
// - Numbers: FPC FloatToStrF (exact binary value, ties away from zero, no "-0";
//   = JS toFixed), integer texts via Round (ties to even) or Trunc, single
//   precision maths where FL computes in single (Math.fround).
// - List parameters read the editor control's item (FL ignores the value; the
//   control shows the part the editor displays, see listText).

import type { FxParams } from '../../../fx/types';

/** FL's value text of a control value; `state` = the plugin state when known. */
export type HarmorFmt = (v: number, state?: FxParams) => string;

const f32 = Math.fround;
/** ln 2 (FL's runtime constant at 0xa2d228). */
const LN2 = 0.6931471805599453;
/** ln 17 (Harmonic blur amount). */
const LN17 = 2.833213344056216;
/** Single-precision ln 11 / ln 3 (runtime constants 0xa2d25c / 0xa2d264). */
const LN11F = f32(2.397895336151123);
const LN3F = f32(1.0986123085021973);
/** Single-precision 1/1024, 0.001, 0.01, 0.1. */
const K1024 = f32(0.0009765625);
const K001 = f32(0.001);
const K01 = f32(0.01);
const K1 = f32(0.1);
/** Single(NoteToFreq(0)) = single(440 * 2^(-57/12)) (runtime constant 0xa97148). */
const FREQ0 = f32(16.351598739624023);

/** ARM frintx / FPC Round: nearest, ties to even. */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * FPC FloatToStrF(x, ffFixed, precision, digits) as FL prints it: the value's
 * decimal digits rounded to `sig` significant digits (15 for doubles), then
 * rounded half up to `digits` decimals (so 14.499999999999998 reads "15");
 * "-0" printed as "0", infinities as "+Inf" / "-Inf".
 */
export function flFixed(x: number, digits: number, sig = 15): string {
  if (x !== x) return 'Nan';
  if (x === Infinity) return '+Inf';
  if (x === -Infinity) return '-Inf';
  if (x === 0) return (0).toFixed(digits);
  // significant digits and decimal exponent of |x|
  const e = Math.abs(x).toExponential(sig - 1); // d.ddde+N
  const k = e.indexOf('e');
  const ds = (e[0] + e.slice(2, k)).split('').map(Number);
  let exp = Number(e.slice(k + 1)) + 1; // digits before the decimal point
  const keep = exp + digits; // digits kept
  if (keep < ds.length) {
    const up = keep >= 0 && ds[keep] >= 5;
    ds.length = Math.max(keep, 0);
    if (up) {
      let j = keep - 1;
      while (j >= 0 && ds[j] === 9) ds[j--] = 0;
      if (j >= 0) ds[j]++;
      else { ds.unshift(1); exp++; }
    } else if (keep < 0) { exp = -digits; }
  }
  while (ds.length < exp + digits) ds.push(0);
  let ip = exp > 0 ? ds.slice(0, exp).join('') : '0';
  let fp = exp >= 0 ? ds.slice(exp, exp + digits).join('') : (new Array(-exp).fill(0).join('') + ds.join('')).slice(0, digits);
  while (fp.length < digits) fp += '0';
  if (ip === '') ip = '0';
  const s = digits > 0 ? `${ip}.${fp}` : ip;
  return x < 0 && /[1-9]/.test(s) ? `-${s}` : s;
}

/** FL's percent text (0x105d40): FloatToStrF(x * 100, ffFixed, 7, digits) + '%'. */
function percent(x: number, digits = 0): string {
  return `${flFixed(x * 100, digits)}%`;
}

/** FPC FloatToStrF(x, ffGeneral, 15, 0) for plain-range numbers: shortest form, no trailing zeros. */
function general15(x: number): string {
  return String(Number(x.toPrecision(15)));
}

/**
 * dB text of a single-precision gain (0x106130 with flag 0): 20 log10 |g| with
 * one decimal ("-Inf" for 0), "dB", two spaces, the gain with two decimals.
 * log10 is FPC's ln(x) * 0.4342944819032518, the dB value rounded to single.
 */
function dbText(g: number): string {
  const a = Math.abs(g);
  const db = a > 0 ? f32(Math.log(a) * 0.4342944819032518 * 20) : -Infinity;
  return `${flFixed(db, 1)}dB  ${flFixed(g, 2)}`;
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Frequency text (0x105f60): '%sHz %s' of the frequency with two decimals and
 * the nearest note (FL's note names, C5 = key 60): n = round(57 + 12 log2(f / 440)).
 */
export function hzText(f: number): string {
  let n = roundEven(57 + Math.log(f * 0.0022727272727272726) * 17.312340490667562);
  if (!Number.isFinite(n)) n = 0; // FL: fcvtzs of +-Inf, low 32 bits = 0
  n |= 0;
  const name = NOTES[(n < 0 ? 0 : n) % 12];
  const oct = Math.trunc((n + 1200) / 12) - 100;
  return `${flFixed(f, 2)}Hz ${name}${oct}`;
}

/** Hz of the frequency wheels (distortion / reverb / delay cuts): single(2^(v/100) * NoteToFreq(0)). */
function hzOf(v: number): number {
  return f32(Math.exp(f32(f32(v) * K01) * LN2) * FREQ0);
}

/**
 * Cents text (0x105e10 with unit 1): FloatToStrF(x, ffFixed, 15, digits) + ' cent',
 * '+' for x >= 0, plural 's' for |x| > 1.
 */
function centsText(x: number, digits: number): string {
  let s = `${flFixed(x, digits)} cent`;
  if (x >= 0) s = `+${s}`;
  if (Math.abs(x) > 1) s += 's';
  return s;
}

/** Tempo-based time (0x106290): steps:ticks of 48 per step ("3:00"). */
function ticksText(t: number): string {
  const r = t % 48;
  return `${Math.trunc(t / 48)}:${r < 10 ? '0' : ''}${r}`;
}

/** Negative side of the tempo-based time wheels: round(single((2^(-v k) - 1) m)) ms. */
function msText(v: number, k: number, m: number): string {
  return `${roundEven(f32((Math.exp(v * k * LN2) - 1) * m))}ms`;
}

/** Time wheels: v >= 0 tempo-based (steps:ticks), v < 0 milliseconds. */
const timeWheel = (k: number, m: number) => (v: number) => (v >= 0 ? ticksText(v) : msText(v, k, m));

const onOff = (v: number) => (v > 0 ? 'on' : 'off');

/** Volume wheels (time / frequency domain envelope volume, pre-FX main volume). */
function volumeText(v: number): string {
  const x = f32(f32(v) * K001);
  const a = Math.abs(x);
  const g = a === 1 ? a : f32((Math.exp(f32(a * LN3F)) - 1) * 0.5);
  const sign = x === 0 ? 0 : x < 0 ? -1 : 1;
  return dbText(f32(g * sign));
}

/** Harmonic protection: single((11^x - 1) * 0.1), x = v / 1024 (exactly 1 at x = 1). */
function protectionText(v: number): string {
  const x = f32(f32(v) * K1024);
  return dbText(x === 1 ? x : f32((Math.exp(f32(x * LN11F)) - 1) * K1));
}

/**
 * Clipping threshold: "Off" at 1024 (clipping mode "High threshold") or at 0
 * (the other clipping modes, part setting `clipMode`), else 4 (v/1024)^4 in dB.
 */
function clipText(v: number, clipMode: number): string {
  if (v === (clipMode === 0 ? 1024 : 0)) return 'Off';
  const s8 = f32(f32(f32(f32(v) * K1024) * f32(v)) * K1024);
  return dbText(f32(f32(s8 * s8) * 4));
}

/** Harmonic blur amount: 1 + 15.9375 (17^(v/10000) - 1), two decimals, FPC ffGeneral. */
function blurText(v: number): string {
  const y = f32(Math.exp(f32(v / 10000) * LN17) - 1);
  const z = 1 + y * 15.9375;
  return general15(roundEven(z * 100) / 100);
}

/** Phaser offset motion speed: "Still", else the period 64 / 2^(|v|/1000) beats as steps:ticks, '-' below 0. */
function phaserSpeedText(v: number): string {
  if (v === 0) return 'Still';
  const x = f32(f32(Math.abs(v)) * K001);
  const t = roundEven((64 / Math.exp(x * LN2)) * 192) | 0;
  const s = ticksText(t);
  return v < 0 ? `-${s}` : s;
}

/** Tremolo speed: the period 1000 / 2^(6 - v/1000) ms (FL scales numerator and denominator by a plugin double). */
function tremoloText(v: number): string {
  const d = Math.exp((6 - v * 0.001) * LN2);
  return `${roundEven(1000 / d)}ms`;
}

/** Unison phase: "All aligned", "Full blur", else |v|/10 % jump ahead (v > 0) / equal spread (v < 0). */
function unisonPhaseText(v: number): string {
  if (v === 1000) return 'Full blur';
  if (v === 0) return 'All aligned';
  return `${percent(f32(f32(Math.abs(v)) * K001))} ${v > 0 ? 'jump ahead' : 'equal spread'}`;
}

/** Pitch vibrato depth: v/10 cents ("Off", "1 cent", else "%d cent" of the rounded value: FL never pluralises here). */
function vibDepthText(v: number): string {
  const x = f32(v * 0.1);
  if (x === 0) return 'Off';
  if (x === 1) return '1 cent';
  return `${roundEven(x)} cent`;
}

/** Portamento / legato pitch limits. */
function pitchLimitText(v: number, wrapAt: number): string {
  if (v === 0) return 'Off';
  if (v === wrapAt) return 'Portamento octave wrap';
  return v === 1 ? '1 cent' : `${v} cents`;
}

/** Image freq pixel scale: v / 10 %; FL's GetName prints (v + 2) x 100 % in freq mode 2 (Wide Hz), (v + 1) x 100 % in mode 3 (Unison). */
function freqScaleText(v: number, mode: number): string {
  if (mode === 2) return percent(v + 2);
  if (mode === 3) return percent(v + 1);
  return percent(v / 1000);
}

/** Item lists of the editor's list controls (FL's control items; '' = no text). */
export const HARMOR_LISTS = {
  // FatTypeSelect: the menu shows a "-Special" header before Hz; Value counts selectable items only.
  uniDist: ['Classic', 'Blurred', 'Uniform', 'Random', 'Hz'],
  scale: ['oct', 'Hz'],
  phScale: ['octave', 'Hz', 'harmonic'],
  curve: ['Block', 'Cap', 'Bell', 'Linear', 'Cubic', 'Rise', 'Fall'],
  freqMode: ['Oct', 'Hz', 'Wide Hz', 'Unison'],
  strum: ['Up', 'Down', 'Alt', 'Random'],
  delayFb: ['norm', 'inv', 'pong'],
  revColor: ['B+', 'B', 'F', 'W', 'W+'],
} as const;

/** Part parameter keys (params.ts PART_MAIN order) of the list parameters. */
const LIST_KEYS: Record<number, [string, readonly string[]]> = {
  35: ['uniDist', HARMOR_LISTS.uniDist],
  47: ['portaCurve', []],
  53: ['f1Scale', HARMOR_LISTS.scale],
  58: ['f1ResScale', HARMOR_LISTS.scale],
  65: ['f2Scale', HARMOR_LISTS.scale],
  70: ['f2ResScale', HARMOR_LISTS.scale],
  77: ['phScale', HARMOR_LISTS.phScale],
  87: ['imgGainCurve', HARMOR_LISTS.curve],
  90: ['imgFreqMode', HARMOR_LISTS.freqMode],
  91: ['imgFreqCurve', HARMOR_LISTS.curve],
};

/**
 * A list parameter of part `p` (0 = A, 1 = B): FL's GetName ignores the value
 * and prints the item of the editor control, which shows the part the editor
 * displays (`hView.part`). So the text of the displayed part's parameter is
 * its item; the other part's parameter reads the displayed part's item (FL
 * shows part A's choice for part B's parameter while part A is displayed).
 * Without a state: the item of v.
 */
function listText(local: number, p: number): HarmorFmt {
  const [key, items] = LIST_KEYS[local];
  return (v, st) => {
    let i = v;
    if (st) {
      const view = st.hView as { part?: number } | undefined;
      const shown = view && view.part === 1 ? 1 : 0;
      if (shown !== p) i = Number(st[`${shown ? 'b' : 'a'}_${key}`] ?? v);
    }
    return items[i] ?? '';
  };
}

/** Default handler: round(100 v / Max)% with Max the editor control's Max. */
const pctOf = (max: number): HarmorFmt => (v) => percent(v / max);

/** Part parameters 0..94 (local index) -> text; p = part (0 A, 1 B). */
function partMain(i: number, p: number): HarmorFmt | undefined {
  const P = p ? 'b' : 'a';
  switch (i) {
    case 0: case 19: case 79: return (v) => String(Math.trunc(v * 0.36)); // degrees
    case 1: return (v) => `${Math.trunc(v / 10)}%`;
    case 2: return timeWheel(-0.020833333333333332, 3.9215686274509802);
    case 5: case 6: case 7: return (v) => dbText(f32(f32(v) * K1024));
    case 8: return protectionText;
    case 9: return (v, st) => clipText(v, Number((st?.[p ? 'hB' : 'hA'] as { clipMode?: number } | undefined)?.clipMode ?? 0));
    case 11: case 12: return volumeText;
    case 13: return (v) => percent(f32(f32(v) * K001));
    case 14: case 15: case 16: case 36: case 51: case 61: case 63: case 73: return onOff;
    case 18: return tremoloText;
    case 23: return blurText;
    case 30: return (v) => String(v + 2);
    case 31: case 33: return (v) => (v < 1 ? `x${Math.abs(v) + 1}` : `+${v}`);
    case 32: return (v) => String(v + 1);
    case 34: case 41: case 43: return (v) => String(v);
    case 35: case 47: case 53: case 58: case 65: case 70: case 77: case 87: case 90: case 91: return listText(i, p);
    case 39: return unisonPhaseText;
    case 40: case 42: return (v) => flFixed(v / 10000, 4);
    case 44: return (v) => centsText(v, 0);
    case 45: return vibDepthText;
    case 46: return (v) => `${roundEven(1000 / Math.exp(f32(3 - f32(f32(v) * K001)) * LN2))}ms`;
    case 48: return () => '';
    case 49: return timeWheel(-0.015625, 23.80952380952381);
    case 50: return (v) => pitchLimitText(v, 1200);
    case 55: case 67: case 81: return (v) => percent((2 * v) / 2000);
    case 60: case 72: case 93: return (v) => centsText(v, 2);
    case 74: return (v) => { const s = percent(f32(f32(Math.abs(v)) * K001)); return v < 0 ? `-${s}` : s; };
    case 80: return phaserSpeedText;
    case 82: return (v) => { const x = f32(f32(Math.abs(v)) * K001); const s = `${roundEven(x * x * 2000)}ms`; return v < 0 ? `-${s}` : s; };
    case 83: return (v) => percent(v / 1048576, 2);
    case 84: return (v) => `${flFixed(v / 100, 2)}%`;
    case 85: return (v) => `x${flFixed(Math.exp((v / 10000) * LN2), 3)}`;
    case 86: return (v) => (v >= 0 ? '' : `-${percent(Math.abs(f32(f32(v) * K001)))}`);
    case 92: return (v, st) => freqScaleText(v, Number(st?.[`${P}_imgFreqMode`] ?? 0));
    // default handler (control Max)
    case 3: case 4: case 10: case 17: case 20: case 24: case 25: case 26: case 27: case 28:
    case 54: case 56: case 57: case 59: case 66: case 68: case 69: case 71: case 75: case 76:
    case 88: case 89: case 94:
      return pctOf(1000);
    case 21: case 22: return pctOf(1600);
    case 29: return pctOf(1024);
    case 37: case 38: return pctOf(256);
    case 52: case 64: return pctOf(8192);
    case 62: return pctOf(2048);
    case 78: return pctOf(10000);
    default: return undefined;
  }
}

/**
 * Articulator envelope / LFO fields (part parameters 95..342, field f = (i - 95) % 8):
 * FL formats field f with the handler of part parameter f (0 starting phase,
 * 1 phase randomness, 2 predelay, 5..7 sub-harmonic level); 3 (release scale)
 * and 4 (LFO speed) use the default handler with their knob's Max.
 */
function artField(f: number, p: number): HarmorFmt | undefined {
  if (f === 3) return pctOf(256);
  if (f === 4) return pctOf(65536);
  return partMain(f, p);
}

/** Global parameters 772..824 -> text. */
function globalFormat(i: number): HarmorFmt | undefined {
  switch (i) {
    case 772: case 773: case 774: case 815: return pctOf(512);
    case 775: return (v) => pitchLimitText(v, NaN);
    case 776: case 777: case 778: case 785: case 788: case 794: case 811: case 820: return onOff;
    case 779: return (v) => HARMOR_LISTS.strum[v] ?? '';
    case 780: case 781: case 782: case 787: case 789: case 792: case 803: case 810: case 813: case 816: case 821:
      return pctOf(1000);
    case 783: return volumeText;
    case 784: case 791: case 822: case 823: case 824: return pctOf(2000);
    case 786: return (v) => centsText(v, 0);
    case 790: return (v) => `${percent(Math.abs(v) * 0.002)}${v < 0 ? ' stereo' : v > 0 ? ' mono' : ''}`;
    case 793: return (v) => hzText(hzOf(v));
    case 795: case 818: return (v) => (v === 0 ? 'Off' : hzText(hzOf(v)));
    case 796: case 801: case 819: return (v) => (v === 1050 ? 'Off' : hzText(hzOf(v)));
    case 797: return timeWheel(-0.015625, 15.873015873015873);
    case 798: case 799: return pctOf(100);
    case 800: return (v) => `${roundEven(100 * Math.exp(f32(f32(v) * K01) * LN2))}ms`;
    case 802: return (v) => HARMOR_LISTS.revColor[v < 0 ? 0 : v > 4 ? 4 : v];
    case 804: return pctOf(9);
    case 805: case 806: return pctOf(1024);
    case 807: case 808: case 809: case 817: return pctOf(128);
    case 812: return (v) => HARMOR_LISTS.delayFb[v] ?? '';
    case 814: return timeWheel(-0.010416666666666666, 66.66666666666667);
    default: return undefined;
  }
}

/** FL's value text function for parameter `index` (0..824; undefined = raw value). */
export function HARMOR_FORMATS(index: number): HarmorFmt | undefined {
  if (index >= 772) return globalFormat(index);
  const p = index >= 386 ? 1 : 0;
  const i = index - 386 * p;
  if (i >= 343) return pctOf(1001); // articulator output smoothing (0..1001)
  if (i >= 95) return artField((i - 95) % 8, p);
  return partMain(i, p);
}
