// Harmless (FL: Harmless, Synth classic): FL's 100 automatable parameters.
// From FL 2026's Harmless_x64.dylib (arm64; docs/research/gen/harmless.md):
// names as GetName(FPN_Param), ranges as the editor form's controls (Tag =
// FL index, Min / Max, DefaultValue = FL's reset value), value texts ported
// from the plugin's value-text routine (0x6b840; ProcessParam's own laws, FPC's
// FloatToStrF rounding half away from zero, times in ms computed at 44.1 kHz)
// and checked against `flfxhost sweep Harmless I --all` for every raw value.

import type { GenParamDef } from '../../types';

/** State keys of FL's parameters 0..99, in FL index order. */
export const HL_KEYS = [
  'phaseRand', 'lowProtect', 'sub1', 'sub3', 'sub4', 'eq1', 'eq2', 'eq3', 'eq4', 'eq5', 'eq6',
  'mask1', 'mask2', 'mask3', 'mask4', 'mask5', 'mask6', 'mask7', 'mask8', 'mask9', 'mask10', 'mask11', 'mask12',
  'maskMix', 'maskMixLfo', 'tremolo', 'volA', 'volD', 'volR', 'velAtt', 'relVelRel',
  'pluckDec', 'velPluck', 'pluckAlt', 'pluckMask', 'pluckRel', 'mainVol', 'velVol', 'mainPitch', 'detune', 'grit',
  'vibrato', 'pitchLfo', 'porta', 'mono', 'portaTime', 'velPorta',
  'fenvAdaptive', 'fenvA', 'fenvD', 'fenvASlope', 'fenvDSlope', 'fenvAmt', 'velFenv',
  'fcut', 'fScale', 'fWidth', 'keyFcut', 'fLfo', 'res', 'resScale', 'resOfs', 'resOsc', 'resAdaptive', 'resTrack',
  'uniOrder', 'uniPan', 'uniPitch', 'uniPhase', 'uniVar', 'uniType',
  'phMix', 'phScale', 'phWidth', 'phWidthLfo', 'phOfs', 'phOfsLfo', 'phSpeed', 'keyPhOfs',
  'hzMix', 'hzWidth', 'hzWidthLfo', 'velHzWidth', 'hzStrength', 'hzType', 'hzPos',
  'lfoShape', 'lfoGlobal', 'lfoAtt', 'lfoSpeed', 'chType', 'chMix', 'delType', 'delVol', 'delFb', 'delTime',
  'revType', 'revWet', 'compLevel', 'velUniPitch',
] as const;

export type HlKey = (typeof HL_KEYS)[number];

const f32 = Math.fround;
const LN3F = f32(Math.log(3)); // FL's runtime ln 3 (0x3f8c9f54)
const LN11F = f32(Math.log(11)); // ln 11 (0x4019771e)

/** Round a non-negative decimal string (digits and one optional dot) to `d` decimals, half up. */
function roundDec(s: string, d: number): string {
  let [ip, fp = ''] = s.split('.');
  fp = fp.padEnd(d + 1, '0');
  const keep = ip + fp.slice(0, d);
  const up = fp.charCodeAt(d) >= 53; // '5'
  let digits = keep.split('').map(Number);
  if (up) {
    let i = digits.length - 1;
    while (i >= 0) { if (digits[i] === 9) { digits[i] = 0; i--; } else { digits[i]++; break; } }
    if (i < 0) digits = [1, ...digits];
  }
  const t = digits.join('');
  const il = t.length - d;
  return d > 0 ? `${t.slice(0, il)}.${t.slice(il)}` : t;
}

/** Plain decimal digits of |x| at `prec` significant digits (no exponent). */
function sigDigits(x: number, prec: number): string {
  const s = Math.abs(x).toPrecision(prec);
  if (!/e/.test(s)) return s;
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s)!;
  const digits = m[1] + (m[2] ?? ''), e = Number(m[3]);
  if (e >= 0) return digits.length > e + 1 ? `${digits.slice(0, e + 1)}.${digits.slice(e + 1)}` : digits + '0'.repeat(e + 1 - digits.length);
  return `0.${'0'.repeat(-e - 1)}${digits}`;
}

/**
 * FPC FloatToStrF(x, ffFixed, prec, d): the value at `prec` significant digits,
 * then rounded half up to `d` decimals (checked on FL's texts: 14.4999.. shows
 * "15"); no minus sign when the result is zero.
 */
export function flFixed(x: number, d: number, prec = 15): string {
  if (x !== x) return 'Nan';
  if (x === Infinity) return 'Inf';
  if (x === -Infinity) return '-Inf';
  const s = roundDec(sigDigits(x, prec), d);
  return x < 0 && /[1-9]/.test(s) ? '-' + s : s;
}

/** FL's 3-base volume law (ProcessParam): x == 1 ? 1 : (3^x - 1) / 2 in float32 steps. */
export function law3(x: number): number {
  x = f32(x);
  return x === 1 ? 1 : f32((Math.exp(f32(x * LN3F)) - 1) * 0.5);
}

/** FL's 11-base law (LogVol): x == 1 ? 1 : (11^x - 1) / 10. */
export function law11(x: number): number {
  x = f32(x);
  return x === 1 ? 1 : f32((Math.exp(f32(x * LN11F)) - 1) * f32(0.1));
}

/** Value text helper 0x7b840: 20 log10 |gain| with one decimal and "dB" ("-InfdB" for silence). */
function dbText(g: number): string {
  const a = Math.abs(f32(g));
  const db = a > 0 ? f32(20 * Math.log10(a)) : -Infinity;
  return flFixed(db, 1) + 'dB';
}

/** Percent text 0x7b620: FloatToStrF(x * 100, ffFixed, 7, 0) + "%". */
const pctText = (x: number) => flFixed(x * 100, 0) + '%';

/** Cents text 0x7b6f0: sign, two decimals, " cent" / " cents". */
function centText(v: number): string {
  const x = f32(v);
  return (x >= 0 ? '+' : '') + flFixed(x, 2) + ' cent' + (Math.abs(x) > 1 ? 's' : '');
}

/** Bars:steps text 0x7b9a0 (48 ticks per step group). */
function ticksText(t: number): string {
  const b = Math.trunc(t / 48), s = t - b * 48;
  return `${b}:${String(s).padStart(2, '0')}`;
}

const SR = 44100;
const msText = (samples: number) => `${Math.round(samples * 1000 * (1 / SR))}ms`;
const onOff = (v: number) => (v > 0 ? 'on' : 'off');

/** LFO / phaser motion speed: "Still" or [-]bars:steps of round(64 / 2^(|v|/1000) * 192) ticks. */
function speedText(v: number): string {
  if (v === 0) return 'Still';
  const a = Math.abs(v);
  const r = Math.exp(f32(f32(a) * f32(0.001)) * Math.LN2);
  const t = ticksText(Math.round((64 / r) * 192));
  return v > 0 ? t : '-' + t;
}

function p(index: number, name: string, min: number, max: number, def: number, format: (v: number) => string, extra: Partial<GenParamDef> = {}): GenParamDef {
  return { key: HL_KEYS[index], name, index, min, max, def, format, ...extra };
}

const pct = (max: number) => (v: number) => pctText(v / max);
const pct2 = (max: number) => (v: number) => pctText((v * 2) / max);
const choice = (items: string[]) => (v: number) => items[Math.max(0, Math.min(items.length - 1, v))];

export const UNI_TYPES = ['Classic', 'Uniform', 'Blurred'];
export const HZ_TYPES = ['Oct up', 'Oct up +1', 'Oct up +2', 'Harm up', 'Harm up +1'];
export const HZ_POS = ['Pre-filter', 'Pre-phaser', 'Pre-pluck', 'Final'];
export const LFO_SHAPES = ['Sine', 'Smooth saw', 'Smooth pulse', 'Saw', 'Pulse', 'Stairs', 'Triangle', 'Sickle', 'Multisine',
  'Filter envelope', 'Filter frequency', 'Voice random', 'Velocity', 'Pitch'];
export const CH_TYPES = ['Off', 'Classic', 'Thick', 'Deep', 'Flanger', 'Alt flanger', 'Stereoized', 'Modulation', 'Surround', 'Vibration'];
export const DEL_TYPES = ['Off', 'Classic', 'Ping-pong', 'Stereoized'];
export const REV_TYPES = ['Off', 'Classic', 'Large hall', 'Cathedral', 'The venue', 'Drum room', 'Small studio'];

const sw = (index: number, name: string, def = 0) => p(index, name, 0, 1, def, onOff, { options: ['off', 'on'] });

function maskText(v: number): string {
  const x = f32(f32(v) * f32(0.001));
  const g = law11(Math.abs(x));
  return dbText(f32(g * (x === 0 ? 0 : x < 0 ? -1 : 1)));
}

/** Attack-type times (P26): round(f32(sr * f32(101^x - 1)) * 0.05 * 1000 / sr) ms. */
const LN101 = 4.6151205168412597, LN1001 = 6.9087547793152204, LN41 = 3.713572066704308;
function expm(x: number, ln: number): number { return Math.exp(f32(f32(x) * f32(0.001)) * ln); }

export const HL_PARAMS: GenParamDef[] = [
  p(0, 'Phase randomness', -1000, 1000, 0, (v) => (v === 0 ? 'Constant' : `${Math.trunc(Math.abs(v) / 10)}% ${v > 0 ? 'running' : 'spectral random'}`), { bipolar: true }),
  p(1, 'Low harmonics protection', 0, 1024, 256, (v) => dbText(law11(f32(f32(v) * f32(0.0009765625))))),
  p(2, 'Sub harmonic 1', 0, 2048, 0, (v) => dbText(f32(f32(v) * f32(0.0009765625)))),
  p(3, 'Sub harmonic 3', 0, 2048, 0, (v) => dbText(f32(f32(v) * f32(0.0009765625)))),
  p(4, 'Sub harmonic 4', 0, 2048, 0, (v) => dbText(f32(f32(v) * f32(0.0009765625)))),
  ...[5, 6, 7, 8, 9, 10].map((i) => p(i, `Timbre EQ band ${i - 4}`, -1024, 1024, 0, (v) => dbText(law3(f32(f32(v + 1024) * f32(0.0009765625)))), { bipolar: true })),
  ...[11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].map((i) => p(i, `Harmonic mask ${i - 10}/12`, 0, 1000, 0, maskText)),
  p(23, 'Harmonic mask mix', 0, 1000, 500, pct(1000)),
  p(24, 'Harmonic mask mix LFO amount', -1000, 1000, 0, pct(1000), { bipolar: true }),
  p(25, 'Stereo tremolo depth', 0, 1000, 0, pct(1000)),
  p(26, 'Volume env attack length', 0, 1000, 0, (v) => msText(f32(f32(SR) * f32(expm(v, LN101) - 1)) * 0.05)),
  p(27, 'Volume env decay length', 0, 1000, 500, (v) => (v >= 1000 ? 'Infinite' : msText(SR * (0.05 + f32(expm(v, LN1001) - 1) * 0.11995)))),
  p(28, 'Volume env release length', 0, 1000, 250, (v) => msText(SR * (0.01 + f32(expm(v, LN101) - 1) * 0.0249))),
  sw(29, 'Velocity to attack'),
  sw(30, 'Release velocity to release'),
  p(31, 'Pluck decay length', 0, 1000, 500, pct(1000)),
  sw(32, 'Velocity to pluck decay'),
  sw(33, 'Alternate pluck mode'),
  sw(34, 'Pluck uses harmonic mask'),
  sw(35, 'Pluck only on release'),
  p(36, 'Master volume', 0, 2000, 1000, (v) => dbText(f32(law3(f32(f32(v) * f32(0.001))) * f32(0.75)))),
  sw(37, 'Velocity to volume'),
  p(38, 'Master pitch', -2400, 2400, 0, centText, { bipolar: true }),
  p(39, 'Detuning', -2400, 2400, 0, centText, { bipolar: true }),
  p(40, 'Grittiness', -1000, 1000, 0, pct(1000), { bipolar: true }),
  p(41, 'Pitch vibrato depth', 0, 1000, 0, pct(1000)),
  p(42, 'Pitch LFO amount', -1000, 1000, 0, pct(1000), { bipolar: true }),
  sw(43, 'Portamento mode'),
  sw(44, 'Monophonic mode'),
  p(45, 'Portamento / legato time', -1000, 1000, 0, (v) => {
    const per = 88, sgn = v === 0 ? 0 : v < 0 ? -1 : 1;
    const x = f32(f32(Math.abs(v)) * f32(0.001));
    const s = f32(f32(f32(f32(SR * sgn) * f32(Math.exp(x * LN41) - 1)) / f32(f32(26.666666) * f32(per))) * f32(per));
    const t = `${Math.round(Math.abs(s) * 1000 * (1 / SR))}ms`;
    return sgn < 0 ? '-' + t : t;
  }, { bipolar: true }),
  sw(46, 'Velocity / release to portamento / legato time'),
  sw(47, 'Adaptive filter envelope mode'),
  p(48, 'Filter env attack length', 0, 1000, 0, (v) => (v >= 1000 ? 'Infinite'
    : msText(1 / (1 / (f32(f32(SR) * f32(expm(v, LN1001) - 1)) * 0.12 + 1))))),
  p(49, 'Filter env decay length', 0, 1000, 500, (v) => (v >= 1000 ? 'Infinite'
    : msText(-1 / (-1 / (SR * (f32(expm(v, LN1001) - 1) * 0.12) + 1))))),
  p(50, 'Filter env attack slope', -1000, 1000, 0, pct(1000), { bipolar: true }),
  p(51, 'Filter env decay slope', -1000, 1000, 0, pct(1000), { bipolar: true }),
  p(52, 'Filter env amount', -1000, 1000, 0, pct(1000), { bipolar: true }),
  sw(53, 'Velocity to filter env amount'),
  p(54, 'Filter frequency', 0, 8192, 4096, pct(8192)),
  p(55, 'Filter scale', 0, 1, 0, choice(['Oct', 'Hz']), { options: ['Oct', 'Hz'] }),
  p(56, 'Filter width', 0, 1000, 500, pct(1000)),
  p(57, 'Key to filter frequency', -2000, 2000, 1000, pct2(2000), { bipolar: true }),
  p(58, 'Filter LFO amount', -1000, 1000, 0, pct(1000), { bipolar: true }),
  p(59, 'Resonance amount', 0, 1000, 0, pct(1000)),
  p(60, 'Resonance scale', 0, 1, 0, choice(['Oct', 'Hz']), { options: ['Oct', 'Hz'] }),
  p(61, 'Resonance offset / noise length', -2400, 2400, 0, centText, { bipolar: true }),
  p(62, 'Resonance self-oscillation', 0, 2048, 0, pct(2048)),
  sw(63, 'Adaptive width'),
  sw(64, 'Track filter frequency motion'),
  p(65, 'Unison order', 1, 9, 1, (v) => String(v)),
  p(66, 'Unison panning', 0, 128, 128, pct(128)),
  p(67, 'Unison pitch thickness', 0, 256, 128, pct(256)),
  p(68, 'Unison phase', 0, 128, 64, pct(128)),
  p(69, 'Unison variation', 0, 128, 64, pct(128)),
  p(70, 'Unison type', 0, 2, 0, choice(UNI_TYPES), { options: UNI_TYPES }),
  p(71, 'Phaser mix', 0, 1000, 0, pct(1000)),
  p(72, 'Phaser scale', 0, 2, 0, choice(['oct', 'hz', 'harmonic']), { options: ['oct', 'hz', 'harmonic'] }),
  p(73, 'Phaser width', 0, 10000, 5000, pct(10000)),
  p(74, 'Phaser width LFO amount', -1000, 1000, 0, pct(1000), { bipolar: true }),
  p(75, 'Phaser offset', 0, 999, 500, (v) => String(Math.round(v * 0.36))),
  p(76, 'Phaser offset LFO amount', -1000, 1000, 0, pct(1000), { bipolar: true }),
  p(77, 'Phaser offset motion speed', -8000, 8000, 3000, speedText, { bipolar: true }),
  p(78, 'Key to phaser offset', -2000, 2000, 1000, pct2(2000), { bipolar: true }),
  p(79, 'Harmonizer mix', 0, 1000, 0, pct(1000)),
  p(80, 'Harmonizer width', 0, 1000, 500, pct(1000)),
  p(81, 'Harmonizer width LFO amount', -1000, 1000, 0, pct(1000), { bipolar: true }),
  sw(82, 'Velocity to harmonizer width'),
  p(83, 'Harmonizer strength', 0, 1024, 0, pct(1024)),
  p(84, 'Harmonizer type', 0, 4, 0, choice(HZ_TYPES), { options: HZ_TYPES }),
  p(85, 'Harmonizer position', 0, 3, 0, choice(HZ_POS), { options: HZ_POS }),
  p(86, 'LFO shape / source', 0, 13, 0, choice(LFO_SHAPES), { options: LFO_SHAPES }),
  sw(87, 'Global / retriggered LFO'),
  p(88, 'LFO attack', 0, 1000, 0, pct(1000)),
  p(89, 'LFO speed', -8000, 8000, 3000, speedText, { bipolar: true }),
  p(90, 'Chorus type', 0, 9, 0, choice(CH_TYPES), { options: CH_TYPES }),
  p(91, 'Chorus mix', 0, 1000, 500, pct(1000)),
  p(92, 'Delay type', 0, 3, 0, choice(DEL_TYPES), { options: DEL_TYPES }),
  p(93, 'Delay input level', 0, 1000, 500, pct(1000)),
  p(94, 'Delay feedback level', 0, 900, 300, pct(900)),
  p(95, 'Delay time', 0, 384, 144, ticksText),
  p(96, 'Reverb type', 0, 6, 0, choice(REV_TYPES), { options: REV_TYPES }),
  p(97, 'Reverb wet level', 0, 1000, 500, pct(1000)),
  p(98, 'Compression level', 0, 1000, 500, pct(1000)),
  sw(99, 'Velocity to unison pitch thickness'),
];
