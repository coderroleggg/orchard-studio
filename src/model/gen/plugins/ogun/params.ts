// Ogun's 89 automatable parameters (FL Studio 2026, Ogun_x64.dylib: names, indices and ranges from the test host's
// `info`, reset values from the editor form's DefaultValue (SynthEditorForm), value texts: texts.ts).
//
// Parameters 49..88 are the articulators' envelope and LFO knobs (five targets x ADSR scales + LFO speed / tension / skew /
// pulse width): FL keeps them in the articulator curves (TMEnvelope +0x98, TMLFO +0xd0); the flat keys below are
// authoritative here and the curves' own copies are rewritten from them when a state is normalised.

import type { GenParamDef } from '../../types';
import type { FxParams } from '../../../fx/types';
import * as T from './texts';

const sgn = (v: number, unit: string, one: string) => `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(2)} ${Math.abs(v) <= 1 ? one : unit}`;
const pct = (d: number) => (v: number) => T.pctText(v, d);

/** [index, key, FL name, min, max, reset value]. */
const ROWS: [number, string, string, number, number, number][] = [
  [0, 'level', 'Master level', 0, 256, 128],
  [1, 'coarse', 'Master coarse pitch', -24, 24, 0],
  [2, 'fine', 'Master fine pitch', -50, 50, 0],
  [3, 'modx', 'Modulation X', 0, 512, 256],
  [4, 'mody', 'Modulation Y', 0, 512, 256],
  [5, 'pre', 'Timbre pre-decay', 0, 1000, 100],
  [6, 'dec', 'Timbre decay time', 0, 10000, 4000],
  [7, 'rel', 'Timbre release time', 0, 10000, 2000],
  [8, 'full', 'Timbre fullness', -1000, 1000, 0],
  [9, 'morph', 'Timbre morphing / randomness', 0, 1000, 300],
  [10, 'seed1', 'Timbre seed 1', 0, 9999, 1],
  [11, 'seed2', 'Timbre seed 2', 0, 9999, 0],
  [12, 'uniOrd', 'Unison order', 1, 9, 1],
  [13, 'uniPan', 'Unison panning', 0, 128, 128],
  [14, 'uniVol', 'Unison volume', 16, 128, 128],
  [15, 'uniPit', 'Unison pitch', 0, 256, 128],
  [16, 'uniPhs', 'Unison phase', 0, 128, 64],
  [17, 'fltFreq', 'Filter frequency', 0, 256, 128],
  [18, 'fltRes', 'Filter resonance', 0, 256, 128],
  [19, 'choOrd', 'Chorus order', 0, 9, 4],
  [20, 'choDep', 'Chorus depth', 0, 1024, 512],
  [21, 'choSpd', 'Chorus speed', 0, 1024, 768],
  [22, 'choDel', 'Chorus delay', 0, 128, 8],
  [23, 'choSpr', 'Chorus spread', 0, 128, 128],
  [24, 'choCrs', 'Chorus cross', -128, 128, -32],
  [25, 'choMix', 'Chorus mix', -128, 128, 64],
  [26, 'delFb', 'Delay feedback level', 0, 127, 64],
  [27, 'delTime', 'Delay time', 0, 384, 144],
  [28, 'delOfs', 'Delay time stereo offset', -512, 512, 0],
  [29, 'delVol', 'Delay volume', -128, 128, 64],
  [30, 'delMode', 'Delay feedback mode', 0, 2, 0],
  [31, 'revLow', 'Reverb lowcut', 19, 3000, 75],
  [32, 'revHigh', 'Reverb highcut', 5, 221, 40],
  [33, 'revPre', 'Reverb predelay', 0, 384, 0],
  [34, 'revRoom', 'Reverb room size', 1, 100, 40],
  [35, 'revDiff', 'Reverb diffusion', 0, 100, 100],
  [36, 'revDec', 'Reverb decay', 1, 200, 15],
  [37, 'revDamp', 'Reverb high damping', 5, 221, 40],
  [38, 'revCol', 'Reverb color', 0, 4, 2],
  [39, 'revWet', 'Reverb wet volume', -128, 128, 25],
  [40, 'eq1Lvl', 'EQ band 1 level', -1800, 1800, 0],
  [41, 'eq2Lvl', 'EQ band 2 level', -1800, 1800, 0],
  [42, 'eq3Lvl', 'EQ band 3 level', -1800, 1800, 0],
  [43, 'eq1Frq', 'EQ band 1 freq', 0, 65536, 8950],
  [44, 'eq2Frq', 'EQ band 2 freq', 0, 65536, 33145],
  [45, 'eq3Frq', 'EQ band 3 freq', 0, 65536, 49305],
  [46, 'eq1Wid', 'EQ band 1 width', 0, 65536, 17500],
  [47, 'eq2Wid', 'EQ band 2 width', 0, 65536, 17500],
  [48, 'eq3Wid', 'EQ band 3 width', 0, 65536, 17500],
];

/** The five articulated targets in FL's order: key prefix and name prefix. */
export const ART_TARGETS: [string, string][] = [
  ['vol', 'Volume'], ['flt', 'Filter frequency'], ['res', 'Filter resonance'], ['pit', 'Pitch'], ['upi', 'Unison pitch'],
];
/** The eight knobs of a target: key suffix, name, min, max, reset value. */
const ART_KNOBS: [string, string, number, number, number][] = [
  ['Att', 'Attack time scale', 0, 256, 128],
  ['Dec', 'Decay time scale', 0, 256, 128],
  ['Sus', 'Sustain level offset', -128, 128, 0],
  ['Rel', 'Release time scale', 0, 256, 128],
  ['LfoSpd', 'LFO speed (phase)', 512, 65536, 40000],
  ['LfoTns', 'LFO tension', -128, 128, 0],
  ['LfoSkw', 'LFO skew', -128, 128, 0],
  ['LfoPw', 'LFO pulse width', -112, 112, 0],
];

/** Whether the delay time (b3[0]) / reverb predelay (xi[4] byte 1) is tempo-based in a state (defaults: delay yes, reverb no). */
const delayTempo = (st?: FxParams): boolean => (Array.isArray(st?.b3) ? (st!.b3 as number[])[0] !== 0 : true);
const reverbTempo = (st?: FxParams): boolean => (Array.isArray(st?.xi) ? (((st!.xi as number[])[4] >> 8) & 255) !== 0 : false);

function textOf(key: string): ((v: number, st?: FxParams) => string) | undefined {
  switch (key) {
    case 'level': case 'uniPan': case 'uniVol': case 'uniPhs': case 'choDel': case 'choSpr': case 'choCrs': case 'choMix':
    case 'delVol': case 'revWet': return pct(128);
    case 'modx': case 'mody': return pct(512);
    case 'pre': case 'full': case 'morph': return pct(1000);
    case 'uniPit': case 'fltFreq': case 'fltRes': return pct(256);
    case 'choDep': case 'choSpd': return pct(1024);
    case 'delFb': return pct(127);
    case 'coarse': return (v) => sgn(v, 'semitones', 'semitone');
    case 'fine': return (v) => sgn(v, 'cents', 'cent');
    case 'dec': return T.decayText;
    case 'rel': return T.releaseText;
    case 'seed1': return T.seed1Text;
    case 'seed2': return T.seed2Text;
    case 'delTime': return (v, st) => (delayTempo(st) ? T.delayTimeText(v) : T.msTimeText(v));
    case 'delOfs': return T.offsetText;
    case 'revLow': return T.reverbLowText;
    case 'revHigh': case 'revDamp': return T.reverbHighText;
    case 'revPre': return (v, st) => (reverbTempo(st) ? T.delayTimeText(v) : T.msTimeText(v));
    case 'revDec': return T.reverbDecayText;
    case 'eq1Lvl': case 'eq2Lvl': case 'eq3Lvl': return T.eqLevelText;
    case 'eq1Frq': case 'eq2Frq': case 'eq3Frq': return T.eqFreqText;
    case 'eq1Wid': case 'eq2Wid': case 'eq3Wid': return T.eqWidthText;
    default: return undefined;
  }
}

export const OGUN_PARAMS: GenParamDef[] = ROWS.map(([index, key, name, min, max, def]) => {
  const p: GenParamDef = { key, name, index, min, max, def };
  const f = textOf(key);
  if (key === 'delMode') p.options = T.DELAY_MODES;
  else if (key === 'revCol') p.options = T.REVERB_COLORS;
  if (f) p.format = f;
  else if (!p.options) p.format = (v) => String(v);
  if (min < 0) p.bipolar = true;
  return p;
});

for (let g = 0; g < ART_TARGETS.length; g++) {
  const [kp, np] = ART_TARGETS[g];
  ART_KNOBS.forEach(([ks, nn, min, max, def], k) => {
    const p: GenParamDef = { key: kp + ks, name: `${np} - ${nn}`, index: 49 + g * 8 + k, min, max, def };
    p.format = k === 4 ? (v) => T.lfoSpeedText(v) : pct(k === 7 ? 112 : 128);
    if (min < 0) p.bipolar = true;
    OGUN_PARAMS.push(p);
  });
}

export const OGUN_KEYS: string[] = OGUN_PARAMS.map((p) => p.key);
