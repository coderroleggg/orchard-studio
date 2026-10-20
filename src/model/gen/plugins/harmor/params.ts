// Harmor's 825 automatable parameters (FL 2026, `flfxhost info Harmor`): 386
// per part (A = 0..385, B = 386..771) and 53 global ones (772..824), in FL's
// index order with FL's names, control ranges and the editor form's reset
// values (DefaultValue; the constructor value where the form has none).
// Keys: part parameters `a_<name>` / `b_<name>`; articulator fields
// `a_art<t>_<field>` (t = articulator target 0..42, see ART_TARGETS); global
// parameters without prefix. Value texts: ./texts.ts (FL's GetName).

import type { FxParamDef } from '../../../fx/types';
import { HARMOR_FORMATS } from './texts';

/** One part parameter: [key, FL name, min, max, reset value]. */
type Row = [string, string, number, number, number];

/** Part parameters 0..94 (FL index = row index; part B adds 386). */
export const PART_MAIN: Row[] = [
  ['phase', 'Starting phase', 0, 999, 500],
  ['phaseRand', 'Phase randomness', -1000, 1000, 0],
  ['predelay', 'Predelay', -384, 384, 0],
  ['polyRel', 'Envelope release polyphonic scale', 0, 1000, 1000],
  ['tmix', 'Timbre 1 & 2 mix', 0, 1000, 500],
  ['sub1', 'Sub-harmonic 1', 0, 2048, 0],
  ['sub3', 'Sub-harmonic 3', 0, 2048, 0],
  ['sub4', 'Sub-harmonic 4', 0, 2048, 0],
  ['protect', 'Harmonic protection', 0, 1024, 256],
  ['clip', 'Clipping threshold', 0, 1024, 1024],
  ['fxMix', 'FX / dry mix', -1000, 1000, 0],
  ['vol', 'Time domain volume', -2000, 2000, 1000],
  ['envVol', 'Frequency domain envelope volume', 0, 2000, 1000],
  ['autoGain', 'Auto-gain', 0, 1000, 0],
  ['velAttTime', 'Velocity to volume envelope attack time', 0, 1, 0],
  ['velAttScale', 'Velocity to volume envelope attack scale', 0, 1, 0],
  ['relVelRel', 'Release velocity to envelope release scale', 0, 1, 0],
  ['tremDepth', 'Tremolo depth', 0, 1000, 0],
  ['tremSpeed', 'Tremolo speed', 0, 10000, 4000],
  ['tremGap', 'Tremolo stereo gap', 0, 999, 500],
  ['blurMix', 'Blur mix', 0, 1000, 1000],
  ['blurAtt', 'Time blur attack', 0, 1600, 0],
  ['blurDec', 'Time blur decay', 0, 1600, 0],
  ['hblur', 'Harmonic blur amount', 0, 10000, 0],
  ['hblurBot', 'Harmonic blur bottom tension', 0, 1000, 500],
  ['hblurTop', 'Harmonic blur top tension', 0, 1000, 500],
  ['prism', 'Prism amount', -1000, 1000, 0],
  ['hzMix', 'Harmonizer mix', 0, 1000, 0],
  ['hzWidth', 'Harmonizer width', 0, 1000, 500],
  ['hzStr', 'Harmonizer strength', 0, 1024, 0],
  ['hzShiftOfs', 'Harmonizer pattern - shift - offset', -2, 7, -1],
  ['hzShiftStep', 'Harmonizer pattern - shift - step', -7, 8, -1],
  // FL's wheel stops at 8, but FL's state load and harmonizer take 9 ("FX/Ice rain" and "X Olbaid/FX/FX Inferno" store 9)
  ['hzGapOfs', 'Harmonizer pattern - gap - offset', -1, 9, 0],
  ['hzGapStep', 'Harmonizer pattern - gap - step', -7, 8, -1],
  ['uniOrder', 'Unison order', 1, 9, 1],
  ['uniDist', 'Unison distribution', 0, 4, 0],
  ['uniAlt', 'Unison alternate distribution', 0, 1, 0],
  ['uniPan', 'Unison panning', 0, 256, 192],
  ['uniPitch', 'Unison pitch thickness', 0, 256, 128],
  ['uniPhase', 'Unison phase', -1000, 1000, 500],
  ['freqMul', 'Freq multiplicator', 10000, 160000, 10000],
  ['freqDiv', 'Freq divider', 1, 9, 1],
  ['detMul', 'Harmonic detuning multiplicator', 10000, 160000, 10000],
  ['detDiv', 'Harmonic detuning divider', 1, 9, 1],
  ['pitchAmt', 'Pitch articulator amount', -6000, 6000, 6000],
  ['vibDepth', 'Pitch vibrato depth', 0, 1000, 0],
  ['vibSpeed', 'Pitch vibrato speed', 0, 1000, 500],
  ['portaCurve', 'Linear / logarithmic portamento curve', 0, 1, 0],
  ['portaVar', 'Fixed / variable portamento / legato time', 0, 1, 0],
  ['portaTime', 'Portamento / legato time', -384, 384, -140],
  ['portaLimit', 'Portamento pitch limit', 0, 1200, 1200],
  ['f1Adapt', 'Adaptive filter 1 envelope mode', 0, 1, 1],
  ['f1Freq', 'Filter 1 frequency', 0, 8192, 4096],
  ['f1Scale', 'Filter 1 scale', 0, 1, 0],
  ['f1Width', 'Filter 1 width', 0, 1000, 500],
  ['f1Key', 'Key to filter 1 frequency', -2000, 2000, 1000],
  ['f1Env', 'Filter 1 envelope amount', -1000, 1000, 0],
  ['f1Res', 'Filter 1 resonance / noise amount', 0, 1000, 0],
  ['f1ResScale', 'Filter 1 resonance / noise scale', 0, 1, 0],
  ['f1ResWidth', 'Filter 1 resonance width / noise length', 0, 1000, 500],
  ['f1ResOfs', 'Filter 1 resonance offset', -2400, 2400, 0],
  ['f1ResAdapt', 'Filter 1 resonance adaptive width / free noise', 0, 1, 0],
  ['f1Osc', 'Filter 1 resonance self-oscillation', 0, 2048, 0],
  ['f2Adapt', 'Adaptive filter 2 envelope mode', 0, 1, 1],
  ['f2Freq', 'Filter 2 frequency', 0, 8192, 4096],
  ['f2Scale', 'Filter 2 scale', 0, 1, 0],
  ['f2Width', 'Filter 2 width', 0, 1000, 500],
  ['f2Key', 'Key to filter 2 frequency', -2000, 2000, 1000],
  ['f2Env', 'Filter 2 envelope amount', -1000, 1000, 0],
  ['f2Res', 'Filter 2 resonance / noise amount', 0, 1000, 0],
  ['f2ResScale', 'Filter 2 resonance / noise scale', 0, 1, 0],
  ['f2ResWidth', 'Filter 2 resonance width / noise length', 0, 1000, 500],
  ['f2ResOfs', 'Filter 2 resonance offset', -2400, 2400, 0],
  ['f2ResAdapt', 'Filter 2 resonance adaptive width / free noise', 0, 1, 0],
  ['fMix', 'Filter 1 & 2 mix (parallel - serial)', -1000, 1000, 0],
  ['pluck', 'Pluck decay length', 0, 1000, 500],
  ['phMix', 'Phaser mix', 0, 1000, 0],
  ['phScale', 'Phaser scale', 0, 2, 0],
  ['phWidth', 'Phaser width', 0, 10000, 5000],
  ['phOfs', 'Phaser offset', 0, 999, 500],
  ['phSpeed', 'Phaser offset motion speed', -8000, 8000, 3000],
  ['phKey', 'Key to phaser offset', -2000, 2000, 1000],
  ['imgSmooth', 'Image time offset smoothing', -1000, 1000, 500],
  ['imgTime', 'Image time offset', 0, 1048575, 0],
  ['imgFine', 'Image fine speed', -20000, 20000, 10000],
  ['imgCoarse', 'Image coarse speed', -60000, 60000, 0],
  ['imgSharp', 'Image sharpening', -1000, 1000, 750],
  ['imgGainCurve', 'Image gain interpolation curve', 0, 6, 0],
  ['imgGainScale', 'Image gain pixel scale', 0, 1000, 500],
  ['imgGainMix', 'Image gain mix', 0, 1000, 1000],
  ['imgFreqMode', 'Image freq mode', 0, 3, 0],
  ['imgFreqCurve', 'Image freq interpolation curve', 0, 6, 0],
  ['imgFreqScale', 'Image freq pixel scale', -2000, 2000, 1000],
  ['imgFormant', 'Formant shift', -600, 600, 0],
  ['imgFormantMix', 'Image formant shift mix', 0, 1000, 1000],
];

/**
 * The 43 articulator targets of a part (FL's "Editor target" list): 0..30
 * articulation targets (envelope, LFO and mappings; parameters 95..342 are
 * their envelope / LFO fields), 31..42 mapping-only targets. Each target also
 * has an "Articulator output smoothing" parameter (343..385).
 */
export const ART_TARGETS = [
  'Panning', 'Volume', 'FX / dry mix', 'Timbre 1 & 2 mix',
  'Filter 1 frequency', 'Filter 2 frequency', 'Filter 1 width', 'Filter 2 width',
  'Filter 1 resonance amount', 'Filter 2 resonance amount', 'Filter 1 resonance width', 'Filter 2 resonance width',
  'Filter 1 resonance offset', 'Filter 2 resonance offset', 'Filter 1 & 2 mix', 'Pluck amount',
  'Phaser mix', 'Phaser width', 'Phaser offset', 'Harmonizer mix', 'Harmonizer width',
  'Harmonic clipping threshold', 'Harmonic blur amount', 'Prism amount',
  'Pitch', 'Pitch vibrato depth', 'Unison pitch thickness',
  'Image time offset', 'Image fine speed', 'Image formant shift', 'Image freq pixel scale',
  'Filter 1 envelope amount', 'Filter 2 envelope amount',
  'Global envelope attack time', 'Global envelope attack scale', 'Global envelope decay scale',
  'Global envelope sustain offset', 'Global envelope release scale',
  'Global LFO amount', 'Global LFO speed', 'Global LFO phase',
  'Unison phase', 'Predelay',
] as const;

/** Articulation targets with envelope / LFO parameters (0..30). */
export const ART_ENV_TARGETS = 31;

/** Envelope / LFO parameter fields of an articulation target: [key suffix, FL name, min, max, default]. */
export const ART_FIELDS: Row[] = [
  ['att', 'Attack time scale', 0, 256, 128],
  ['dec', 'Decay time scale', 0, 256, 128],
  ['sus', 'Sustain level offset', -128, 128, 0],
  ['rel', 'Release time scale', 0, 256, 128],
  ['lfoSpd', 'LFO speed (phase)', 512, 65536, 40898],
  ['lfoTns', 'LFO tension', -128, 128, 0],
  ['lfoSkw', 'LFO skew', -128, 128, 0],
  ['lfoPw', 'LFO pulse width', -112, 112, 0],
];

/** Global parameters 772..824: [key, FL name, min, max, reset value]. */
export const GLOBAL_PARAMS: Row[] = [
  ['modX', 'Modulation X', 0, 512, 256],
  ['modY', 'Modulation Y', 0, 512, 256],
  ['modZ', 'Modulation Z', 0, 512, 256],
  ['legatoLimit', 'Legato pitch limit', 0, 2400, 0],
  ['legato', 'Legato mode', 0, 1, 0],
  ['porta', 'Portamento mode', 0, 1, 0],
  ['velPorta', 'Velocity / release to portamento / legato time', 0, 1, 0],
  ['strumMode', 'Strum mode', 0, 3, 0],
  ['strumTime', 'Strum time', 0, 1000, 500],
  ['strumTension', 'Strum tension', -1000, 1000, 0],
  ['partMix', 'Part A & B mix', 0, 1000, 500],
  ['preVol', 'Pre-FX main volume', 0, 2000, 1000],
  ['postVol', 'Post-FX main volume', 0, 2000, 1000],
  ['velVol', 'Velocity to volume', 0, 1, 1],
  ['pitch', 'Main pitch', -2400, 2400, 0],
  ['lfoAmt', 'Main LFO amount', -1000, 1000, 1000],
  ['invArp', 'Invert arpeggiator (if any)', 0, 1, 0],
  ['distAmt', 'Distortion amount', 0, 1000, 500],
  ['distAsym', 'Distortion asymmetry / extra', -500, 500, 0],
  ['distWet', 'Distortion wet volume', 0, 2000, 1000],
  ['distMix', 'Distortion mix', -1000, 1000, 0],
  ['distHC', 'Distortion highcut', 500, 1100, 950],
  ['revOn', 'Enable reverb', 0, 1, 0],
  ['revLC', 'Reverb lowcut', 0, 1000, 220],
  ['revHC', 'Reverb highcut', 400, 1050, 796],
  ['revPredelay', 'Reverb predelay', -384, 384, 0],
  ['revRoom', 'Reverb room size', 1, 100, 40],
  ['revDiff', 'Reverb diffusion', 0, 100, 100],
  ['revDecay', 'Reverb decay', 0, 900, 390],
  ['revHD', 'Reverb high damping', 400, 1050, 796],
  ['revColor', 'Reverb color', 0, 4, 2],
  ['revWet', 'Reverb wet volume', -1000, 1000, 500],
  ['chOrder', 'Chorus order', 0, 9, 4],
  ['chDepth', 'Chorus depth', 0, 1024, 512],
  ['chSpeed', 'Chorus speed', 0, 1024, 768],
  ['chDelay', 'Chorus delay', 0, 128, 8],
  ['chSpread', 'Chorus spread', 0, 128, 128],
  ['chCross', 'Chorus cross', -128, 128, -32],
  ['chMix', 'Chorus mix', -1000, 1000, 500],
  ['delOn', 'Enable delay', 0, 1, 0],
  ['delMode', 'Delay feedback mode', 0, 2, 0],
  ['delFb', 'Delay feedback level', 0, 1000, 300],
  ['delTime', 'Delay time', -384, 384, 144],
  ['delOfs', 'Delay time stereo offset', -512, 512, 0],
  ['delVol', 'Delay input volume', -1000, 1000, 500],
  ['delPan', 'Delay input panning', -128, 128, 0],
  ['delLC', 'Delay lowcut', 0, 1000, 0],
  ['delHC', 'Delay highcut', 400, 1050, 1050],
  ['delDamp', 'Delay feedback damping', 0, 1, 0],
  ['compAmt', 'Compression amount', 0, 1000, 500],
  ['compLow', 'Compression low band', 0, 2000, 1000],
  ['compMid', 'Compression mid band', 0, 2000, 1000],
  ['compHigh', 'Compression high band', 0, 2000, 1000],
];

export const PART_PARAMS = 386;
export const GLOBAL_FIRST = 772;
export const PARAM_COUNT = 825;
export const PARTS = ['a', 'b'] as const;
export type PartId = (typeof PARTS)[number];

/** Key of articulator field `field` (ART_FIELDS key or 'smooth') of target t in part p. */
export function artKey(p: PartId, t: number, field: string): string {
  return `${p}_art${t}_${field}`;
}

/** Parameter keys in FL's index order (0..824). */
export function harmorKeys(): string[] {
  const keys: string[] = [];
  for (const p of PARTS) {
    for (const r of PART_MAIN) keys.push(`${p}_${r[0]}`);
    for (let t = 0; t < ART_ENV_TARGETS; t++) for (const f of ART_FIELDS) keys.push(artKey(p, t, f[0]));
    for (let t = 0; t < ART_TARGETS.length; t++) keys.push(artKey(p, t, 'smooth'));
  }
  for (const g of GLOBAL_PARAMS) keys.push(g[0]);
  return keys;
}

export const HARMOR_KEYS = harmorKeys();

function build(): FxParamDef[] {
  const out: FxParamDef[] = [];
  let index = 0;
  const add = (key: string, name: string, min: number, max: number, def: number) => {
    const q: FxParamDef = { key, name, index, min, max, def };
    if (min < 0 && max > 0) q.bipolar = true;
    const fmt = HARMOR_FORMATS(index);
    if (fmt) q.format = fmt;
    out.push(q);
    index++;
  };
  for (const p of PARTS) {
    const P = p.toUpperCase();
    for (const r of PART_MAIN) add(`${p}_${r[0]}`, `${P} - ${r[1]}`, r[2], r[3], r[4]);
    for (let t = 0; t < ART_ENV_TARGETS; t++) {
      for (const f of ART_FIELDS) add(artKey(p, t, f[0]), `${P} - ${ART_TARGETS[t]} - ${f[1]}`, f[2], f[3], f[4]);
    }
    for (let t = 0; t < ART_TARGETS.length; t++) {
      add(artKey(p, t, 'smooth'), `${P} - ${ART_TARGETS[t]} - Articulator output smoothing`, 0, 1001, 0);
    }
  }
  for (const g of GLOBAL_PARAMS) add(g[0], g[1], g[2], g[3], g[4]);
  return out;
}

export const HARMOR_PARAMS: FxParamDef[] = build();
