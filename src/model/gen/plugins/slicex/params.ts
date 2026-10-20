// Slicex's 352 automatable parameters (FL 2026: `flfxhost info / sweep Slicex`): the master
// section (0..7) and per articulator group (8 + 43 g) the filter's envelope amount, cutoff and
// resonance, then for the targets Panning, Volume, Filter cutoff frequency, Filter resonance and
// Speed the envelope's attack / decay / sustain / release scales and the LFO's speed, tension,
// skew and pulse width. Value texts follow FL's formatting code (0x76740 and helpers): percent
// texts round half away from zero (FL's FloatToStrF), master level "dB  gain" (0x1ed160),
// pitch in cents (0x1ed010), LFO speed as the LFO period in [m:]ss:mmm (0x27dfb0, 0x199840).

import type { GenParamDef } from '../../types';
import { exp } from '../../../../engine/gen/plugins/slicex/libm';

const f32 = Math.fround;

export const SX_TARGET_PARAM_NAMES = ['Panning', 'Volume', 'Filter cutoff frequency', 'Filter resonance', 'Speed'];
export const SX_TARGET_KEYS = ['pan', 'vol', 'cut', 'res', 'spd'];
export const SX_FIELD_KEYS = ['att', 'dec', 'sus', 'rel', 'lspd', 'lten', 'lskw', 'lpw'];
const FIELD_NAMES = ['Attack time scale', 'Decay time scale', 'Sustain level offset', 'Release time scale', 'LFO speed (phase)', 'LFO tension',
  'LFO skew', 'LFO pulse width'];
const FIELD_RANGE: [number, number, number][] = [[0, 256, 128], [0, 256, 128], [-128, 128, 0], [0, 256, 128], [512, 65536, 31102],
  [-128, 128, 0], [-128, 128, 0], [-112, 112, 0]];

/** Key of global parameter i (0..7). */
export const SX_GLOBAL_KEYS = ['play', 'livesel', 'master', 'rand', 'lfo', 'pitch', 'modx', 'mody'];

/** Parameter key of articulator group g (0..7): header field h (0 fenv, 1 fcut, 2 fres). */
export function sxHdrKey(g: number, h: number): string {
  return `g${g + 1}_${['fenv', 'fcut', 'fres'][h]}`;
}

/** Parameter key of articulator group g, target t (0..4), field f (0..7). */
export function sxFieldKey(g: number, t: number, f: number): string {
  return `g${g + 1}_${SX_TARGET_KEYS[t]}_${SX_FIELD_KEYS[f]}`;
}

/** FL's parameter index of a key's slot: 8 + 43 g + (h | 3 + 8 t + f). */
export function sxArtIndex(g: number, t: number, f: number): number {
  return 8 + 43 * g + 3 + 8 * t + f;
}

/** FL's FloatToStrF(x, ffFixed, .., digits): rounding half away from zero. */
export function fixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return x > 0 ? 'Inf' : x < 0 ? '-Inf' : 'Nan';
  const s = Math.abs(x).toFixed(digits);
  return x < 0 ? `-${s}` : s;
}

/** Percent of the control's range (FL 0x1ecf40 with value / max). */
export const pctOfMax = (max: number) => (v: number) => `${fixed((v / max) * 100, 0)}%`;

/** FL's LogVol curve of the master level (0x76ad0): (11^x - 1) / 10 with x = v / 12800, in FL's precision. */
export function sxMasterGain(v: number): number {
  const x = f32(v * f32(7.81249983e-5));
  if (x === 1) return 1;
  return f32((exp(f32(x * f32(2.39789534))) - 1) * f32(0.1));
}

/** Signed LogVol of the randomness / LFO levels (0x76ad0): sgn(x) (11^|x| - 1) / 10. */
export function sxSignedLog(x: number): number {
  const a = Math.abs(x);
  const g = a === 1 ? 1 : f32((exp(f32(a * f32(2.39789534))) - 1) * f32(0.1));
  return x === 0 ? 0 : f32(g * (x < 0 ? -1 : 1));
}

/** "-9.2dB  0.35" (0x1ed160). */
export function dbGainText(g: number): string {
  const a = Math.abs(g);
  const db = a > 0 ? 20 * Math.log10(a) : -Infinity;
  return `${fixed(db, 1)}dB  ${fixed(g, 2)}`;
}

/** "+300.00 cents", "+0.00 cent" (0x1ed010: plural above one cent). */
export function centsText(v: number): string {
  return `${v >= 0 ? '+' : ''}${fixed(v, 2)} cent${Math.abs(v) > 1 ? 's' : ''}`;
}

/** LFO period in curve time units (FL TMLFO 0x27dfb0): 625 / (10000^(v / 65536) - 1) in FL's precision. */
export function sxLfoPeriod(v: number): number {
  const k = f32(v * 1.52587890625e-5);
  const e = f32(exp(k * 9.210440366976517) - 1);
  return f32(f32(4294967296) / e) / 6871947.6736;
}

/** FL's seconds text (0x199840): s:mmm, m:ss:mmm from a minute. */
export function secondsText(t: number): string {
  const a = Math.abs(t);
  const s = Math.trunc(a);
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  if (s >= 60) return `${Math.trunc(s / 60)}:${pad(s % 60, 2)}:${pad(Math.trunc((a - s) * 1000), 3)}`;
  return `${s}:${pad(Math.trunc((t - s) * 1000), 3)}`;
}

/** LFO speed text: the period at half a second per unit. */
export const lfoSpeedText = (v: number) => secondsText(sxLfoPeriod(v) * 0.5);

function fieldFormat(f: number): (v: number) => string {
  if (f === 4) return lfoSpeedText;
  if (f === 0 || f === 1 || f === 3) return pctOfMax(128);
  return pctOfMax(FIELD_RANGE[f][1]);
}

export function sxParams(): GenParamDef[] {
  const out: GenParamDef[] = [
    { key: 'play', name: 'Space lay / pause', index: 0, min: 0, max: 1, def: 0, format: () => '' },
    { key: 'livesel', name: 'Live selection', index: 1, min: 0, max: 1, def: 0, format: () => '' },
    { key: 'master', name: 'Master level', index: 2, min: 0, max: 16000, def: 12800, format: (v) => dbGainText(sxMasterGain(v)) },
    { key: 'rand', name: 'Master randomness level', index: 3, min: 0, max: 256, def: 256, format: pctOfMax(256) },
    { key: 'lfo', name: 'Master LFO level', index: 4, min: -128, max: 128, def: 128, bipolar: true, format: pctOfMax(128) },
    { key: 'pitch', name: 'Master pitch', index: 5, min: -1200, max: 1200, def: 0, bipolar: true, format: centsText },
    { key: 'modx', name: 'Modulation X', index: 6, min: 0, max: 512, def: 256, bipolar: true, format: pctOfMax(512) },
    { key: 'mody', name: 'Modulation Y', index: 7, min: 0, max: 512, def: 256, bipolar: true, format: pctOfMax(512) },
  ];
  const HDR = ['Filter cutoff envelope / LFO amount', 'Filter cutoff frequency', 'Filter resonance'];
  for (let g = 0; g < 8; g++) {
    for (let h = 0; h < 3; h++) {
      out.push({ key: sxHdrKey(g, h), name: `Art group ${g + 1} - ${HDR[h]}`, index: 8 + 43 * g + h, min: 0, max: 256, def: 128, format: pctOfMax(256) });
    }
    for (let t = 0; t < 5; t++) {
      for (let f = 0; f < 8; f++) {
        const [min, max, def] = FIELD_RANGE[f];
        out.push({
          key: sxFieldKey(g, t, f), name: `Art group ${g + 1} - ${SX_TARGET_PARAM_NAMES[t]} - ${FIELD_NAMES[f]}`, index: sxArtIndex(g, t, f),
          min, max, def, bipolar: min < 0, format: fieldFormat(f),
        });
      }
    }
  }
  return out;
}
