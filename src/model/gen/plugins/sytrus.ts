// Sytrus (FL: Sytrus, Plugin database > Generators > Synth classic): FL's
// six-operator FM / RM / subtractive / additive synthesizer with three
// filters, per-parameter articulators (envelope, LFO and six mappings each),
// unison, chorus, three delays, reverb and a 3-band EQ.
// FL's 597 automatable parameters (index order, names and ranges from FL
// 2026's plugin via the test host; value texts matched to FL's GetName) are
// the flat parameters; FL's non-automatable state (waveforms, harmonics,
// matrix, filter types, curves, switches) is `sy` (sytrus/types.ts). Defaults
// are FL's "Default" patch. The 984 factory presets are converted from FL's
// .fst files (sytrus/codec.ts). Spec: docs/research/gen/sytrus.md.

import type { FxParamDef, FxParams } from '../../fx/types';
import type { GenPluginDef } from '../types';
import { ART_FIELDS, paramKeys, UNIT_ARTS, UNIT_PREFIX, type SyState } from './sytrus/types';
import { defaultSyState } from './sytrus/defaults';
import { normalizeSy } from './sytrus/normalize';
import { decodeBank, type DecodedPreset } from './sytrus/codec';
import { SY_PRESET_BANK, SY_PRESET_NAMES } from './sytrus/presets';

/** Round half away from zero (FL's percent texts: 12.5 -> 13, -12.5 -> -13). */
export function roundAway(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

/** FL's percent text: (v - off) / div. */
const pct = (div: number, off = 0) => (v: number) => `${roundAway(((v - off) / div) * 100)}%`;
const fromPct = (div: number, off = 0) => (t: number) => Math.round((t / 100) * div + off);

function plural(v: number, unit: string): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)} ${unit}${Math.abs(v) > 1 ? 's' : ''}`;
}

/** LFO period in seconds for an LFO speed value (non-tempo), as FL computes it. */
export function lfoPeriodSeconds(v: number): number {
  const x = Math.fround(v * 1.52587890625e-5);
  const y = Math.fround(Math.exp(x * 9.210440366976517) - 1);
  return y > 0 ? 312.5 / y : Infinity;
}

/** FL's LFO speed text: "S:mmm" or "M:SS:mmm" (period, truncated to ms). */
export function lfoSpeedText(v: number): string {
  const ms = Math.floor(lfoPeriodSeconds(v) * 1000);
  if (!Number.isFinite(ms)) return '-';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  const mmm = String(ms % 1000).padStart(3, '0');
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}:${mmm}` : `${s}:${mmm}`;
}

/** FL's effects panning text ("Centered", "16% left"). */
export function fxPanText(v: number): string {
  const t = Math.trunc(v / 2) * 2;
  const x = (Math.abs(t) / 128) * 100;
  // FL rounds this one half to even
  let q = Math.round(x);
  if (Math.abs(x - Math.trunc(x) - 0.5) < 1e-9 && q % 2) q -= 1;
  return q === 0 ? 'Centered' : `${q}% ${v < 0 ? 'left' : 'right'}`;
}

/** Delay stereo offset in ms (|v| / 512 -> 0..500 ms, exponential). */
export function delayOffsetMs(v: number): number {
  return (500 * (Math.pow(1000, Math.abs(v) / 512) - 1)) / 999;
}

/** EQ band frequency in Hz for a 0..65536 control value. */
export function eqFreqHz(v: number): number {
  const x = Math.fround(v * 1.52587890625e-5);
  return Math.fround(Math.exp(x * 4.61512051684126) - 1) * 159.9 + 10;
}

const FILTER_MODES = ['OFF', 'x1', 'x2', 'x3', 'ALT x2', 'ALT x3'];
const DELAY_MODES = ['NORM', 'INV', 'PONG'];
const OP_ART_NAMES = ['Panning', 'Volume', 'Input modulation', 'Pitch', 'Phase', 'Plucked damp'];
const FLT_ART_NAMES = ['Panning', 'Volume', 'Filter cutoff frequency', 'Filter resonance / bw / feedback', 'Filter low / gain / drive',
  'Filter band', 'Filter high', 'Waveshaper'];
const FIELD_NAMES = ['Attack time scale', 'Decay time scale', 'Sustain level offset', 'Release time scale', 'LFO speed (phase)',
  'LFO tension', 'LFO skew', 'LFO pulse width'];

function artParams(unit: number, prefix: string, artName: (a: number) => string, firstIndex: number): FxParamDef[] {
  const out: FxParamDef[] = [];
  let index = firstIndex;
  UNIT_ARTS[unit].forEach((_, a) => {
    ART_FIELDS.forEach((f, fi) => {
      const key = UNIT_PREFIX[unit] + UNIT_ARTS[unit][a] + f;
      const name = `${prefix} - ${artName(a)} - ${FIELD_NAMES[fi]}`;
      const base = { key, name, index: index++ };
      if (fi === 0 || fi === 1 || fi === 3) out.push({ ...base, min: 0, max: 256, def: 128, format: pct(128), parse: fromPct(128) });
      else if (fi === 2) out.push({ ...base, min: -128, max: 128, def: 0, bipolar: true, format: pct(128), parse: fromPct(128) });
      else if (fi === 4) out.push({ ...base, min: 512, max: 65536, def: 40000, format: lfoSpeedText });
      else if (fi === 7) out.push({ ...base, min: -112, max: 112, def: 0, bipolar: true, format: pct(112), parse: fromPct(112) });
      else out.push({ ...base, min: -128, max: 128, def: 0, bipolar: true, format: pct(128), parse: fromPct(128) });
    });
  });
  return out;
}

function buildParams(): FxParamDef[] {
  const P: FxParamDef[] = [];
  let i = 0;
  const add = (key: string, name: string, min: number, max: number, def: number, extra: Partial<FxParamDef> = {}) => {
    P.push({ key, name, index: i++, min, max, def, ...extra });
  };
  const M = (s: string) => `Main - ${s}`;
  add('level', M('Master level'), 0, 160, 128, { format: pct(128), parse: fromPct(128) });
  add('lfo', M('Master LFO level'), -128, 128, 128, { bipolar: true, format: pct(128), parse: fromPct(128) });
  add('pitch', M('Master pitch'), -24, 24, 0, { bipolar: true, format: (v) => plural(v, 'semitone') });
  for (const [k, n] of [['vA', 'Volume attack'], ['vD', 'Volume decay'], ['vS', 'Volume sustain'], ['vR', 'Volume release'],
    ['fA', 'Filter attack'], ['fD', 'Filter decay'], ['fS', 'Filter sustain'], ['fR', 'Filter release']]) {
    if (k.endsWith('S')) add(k, M(n), -128, 128, 0, { bipolar: true, format: pct(128), parse: fromPct(128) });
    else add(k, M(n), 0, 256, 128, { format: pct(128), parse: fromPct(128) });
  }
  add('uOrder', M('Unison order'), 1, 9, 1, { format: (v) => String(v) });
  add('uPan', M('Unison panning'), 0, 128, 128, { format: pct(128), parse: fromPct(128) });
  add('uVol', M('Unison volume'), 16, 128, 100, { format: pct(112, 16), parse: fromPct(112, 16) });
  add('uPitch', M('Unison pitch'), 0, 256, 128, { format: pct(256), parse: fromPct(256) });
  add('uSub', M('Unison sub level'), 0, 96, 0, { format: pct(96), parse: fromPct(96) });
  add('uPhase', M('Unison phase'), 0, 128, 16, { format: pct(128), parse: fromPct(128) });
  add('uEnv', M('Unison envelope variation'), 0, 192, 0, { format: pct(192), parse: fromPct(192) });
  add('modX', M('Modulation X'), 0, 512, 256, { format: pct(512), parse: fromPct(512) });
  add('modY', M('Modulation Y'), 0, 512, 256, { format: pct(512), parse: fromPct(512) });
  for (let n = 0; n < 6; n++) {
    const O = `Operator ${n + 1}`;
    add(`o${n + 1}phase`, `${O} - Starting phase`, 0, 256, 0, { format: pct(256), parse: fromPct(256) });
    add(`o${n + 1}vol`, `${O} - Volume`, -256, 256, 256, { bipolar: true, format: pct(256), parse: fromPct(256) });
    add(`o${n + 1}pe`, `${O} - Pitch envelope/LFO amount`, 0, 4800, 1200, { format: (v) => plural(v, 'cent') });
    for (const q of artParams(n, O, (a) => OP_ART_NAMES[a], i)) { P.push(q); i++; }
  }
  for (let n = 0; n < 3; n++) {
    const F = `Filter ${n + 1}`, f = `f${n + 1}`;
    add(`${f}mode`, `${F} - Filter mode`, 0, 5, 1, { options: FILTER_MODES });
    add(`${f}env`, `${F} - Cutoff envelope / LFO amount`, 0, 256, 128, { format: pct(256), parse: fromPct(256) });
    add(`${f}cut`, `${F} - Cutoff frequency`, 0, 256, 128, { format: pct(256), parse: fromPct(256) });
    add(`${f}res`, `${F} - Resonance / bw / feedback`, 0, 256, 0, { format: pct(256), parse: fromPct(256) });
    add(`${f}low`, `${F} - Low / gain / drive`, 0, 128, 128, { format: pct(128), parse: fromPct(128) });
    add(`${f}band`, `${F} - Band`, 0, 128, 0, { format: pct(128), parse: fromPct(128) });
    add(`${f}high`, `${F} - High`, 0, 128, 0, { format: pct(128), parse: fromPct(128) });
    add(`${f}wsAmp`, `${F} - Waveshaper pre amp`, 64, 192, 128, { format: pct(128), parse: fromPct(128) });
    add(`${f}wsMix`, `${F} - Waveshaper mix`, 0, 128, 128, { format: pct(128), parse: fromPct(128) });
    if (n < 2) add(`${f}next`, `${F} - To next filter`, -256, 256, 0, { bipolar: true, format: pct(256), parse: fromPct(256) });
    for (const q of artParams(6 + n, F, (a) => FLT_ART_NAMES[a], i)) { P.push(q); i++; }
  }
  const E = (s: string) => `Effects - ${s}`;
  add('fxPan', E('Panning'), -128, 128, 0, { bipolar: true, format: fxPanText });
  add('chOrder', E('Chorus order'), 0, 9, 4, { format: (v) => String(v) });
  add('chDepth', E('Chorus depth'), 0, 1024, 512, { format: pct(1024), parse: fromPct(1024) });
  add('chSpeed', E('Chorus speed'), 0, 1024, 768, { format: pct(1024), parse: fromPct(1024) });
  add('chDelay', E('Chorus delay'), 0, 128, 8, { format: pct(128), parse: fromPct(128) });
  add('chSpread', E('Chorus spread'), 0, 128, 128, { format: pct(128), parse: fromPct(128) });
  add('chCross', E('Chorus cross'), -128, 128, -32, { bipolar: true, format: pct(128), parse: fromPct(128) });
  add('chVol', E('Chorus volume'), -128, 128, 128, { bipolar: true, format: pct(128), parse: fromPct(128) });
  add('send', E('Send level'), 0, 128, 128, { format: pct(128), parse: fromPct(128) });
  for (let d = 1; d <= 3; d++) {
    add(`d${d}fb`, E('Delay feedback level'), 0, 127, 64, { format: pct(128), parse: fromPct(128) });
    add(`d${d}time`, E('Delay time'), 0, 384, 144, { format: (v) => `${Math.floor(v / 48)}:${String(v % 48).padStart(2, '0')}` });
    add(`d${d}ofs`, E('Delay time stereo offset'), -512, 512, 0, {
      bipolar: true, format: (v) => `${delayOffsetMs(v).toFixed(1)}ms ${v < 0 ? 'left' : 'right'}`,
    });
    add(`d${d}vol`, E('Delay volume'), -128, 128, 64, { bipolar: true, format: pct(128), parse: fromPct(128) });
    add(`d${d}mode`, E('Delay feedback mode'), 0, 2, 0, { options: DELAY_MODES });
  }
  for (const q of artParams(9, 'Effects', (a) => ['Panning', 'Volume'][a], i)) { P.push(q); i++; }
  for (let b = 1; b <= 3; b++) add(`eq${b}lvl`, M(`EQ band ${b} level`), -1800, 1800, 0, { bipolar: true, format: (v) => `${(v / 100).toFixed(1)}dB` });
  for (let b = 1; b <= 3; b++) add(`eq${b}freq`, M(`EQ band ${b} freq`), 0, 65536, [5777, 33145, 55825][b - 1], { format: (v) => `${Math.round(eqFreqHz(v))}Hz` });
  for (let b = 1; b <= 3; b++) add(`eq${b}bw`, M(`EQ band ${b} width`), 0, 65536, 17500, { format: (v) => (v / 65536).toFixed(2) });
  add('porta', M('Portamento'), 0, 1, 0, { options: ['off', 'on'] });
  return P;
}

export const SYTRUS_PARAMS = buildParams();

// FL's Default patch: filters x1 with resonance 0 and LOW at 100 %, waveshaper mix 100 %
for (const q of SYTRUS_PARAMS) {
  if (/^f\dres$/.test(q.key)) q.def = 0;
  if (/^f\dlow$/.test(q.key)) q.def = 128;
  if (/^f\dwsMix$/.test(q.key)) q.def = 128;
}

let bank: DecodedPreset[] | null = null;
/** The decoded factory preset bank (decoded on first use). */
export function sytrusBank(): DecodedPreset[] {
  if (!bank) bank = decodeBank(SY_PRESET_BANK, SY_PRESET_NAMES.length);
  return bank;
}

/** Read the plugin's `sy` state (normalised). */
export function syState(p: FxParams): SyState {
  return p.sy as SyState;
}

export const def: GenPluginDef = {
  id: 'sytrus',
  name: 'Sytrus',
  category: 'Synth classic',
  notes: 'events',
  width: 845,
  height: 450,
  description: 'FM / RM / subtractive synthesizer with 6 operators and 3 filters',
  params: SYTRUS_PARAMS,
  viewState: ['syView'],
  state: () => ({ sy: defaultSyState(), syView: { page: 0, target: 0, part: 0, rf: 0, delNum: 0, eqSel: 0, harm: 0 } }),
  normalize: (p) => {
    const q: Record<string, unknown> = { ...p };
    if (typeof q.__sy === 'number') {
      const pr = sytrusBank()[q.__sy];
      delete q.__sy;
      if (pr) {
        Object.assign(q, pr.params);
        q.sy = pr.sy; // normalizeSy copies
      }
    }
    q.sy = normalizeSy(q.sy);
    const v = (q.syView ?? {}) as Record<string, unknown>;
    q.syView = {
      page: num(v.page, 0, 0, 10), target: num(v.target, 0, 0, 8), part: num(v.part, 0, 0, 7), rf: num(v.rf, 0, 0, 1),
      delNum: num(v.delNum, 0, 0, 3), eqSel: num(v.eqSel, 0, 0, 3), harm: num(v.harm, 0, 0, 255),
    };
    return q;
  },
  presets: SY_PRESET_NAMES.map((name, i) => ({ name, params: { __sy: i } })),
};

function num(x: unknown, d: number, lo: number, hi: number): number {
  const v = typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : d;
  return Math.max(lo, Math.min(hi, v));
}

/** Parameter keys in FL's index order (export for the engine and tests). */
export const SYTRUS_KEYS = paramKeys();
