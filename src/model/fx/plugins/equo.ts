// EQUO: morphing 31-band graphic equalizer (volume, panning and send curve
// per band) with 8 morphable banks and a master bank. 842 parameters in FL's
// order: band shift, band mix, morph, motion smoothness, output volume, then
// banks 0-7 (31 volumes, 31 pannings, 31 sends each), then the master bank.
// Band values are 0..2^30 (2^29 = neutral) as in FL. Bandwidth, oversampling,
// add mode, send only, send track and the band modes are state.
// Measured on FL's binary (docs/research/fx/equo.md).

import type { FxParamDef, FxPluginDef } from '../types';
import { EQUO_PRESETS } from './equo.presets';

export const EQUO_BANDS = 31;
export const EQUO_BANKS = 8;
export const EQUO_ONE = 536870912; // 2^29: neutral band value (1.0)
export const EQUO_MAX = 1073741824; // 2^30 (2.0)
export const EQUO_KINDS = ['v', 'p', 's'] as const; // volume, panning, send

/** Band centre frequency: 20 * 2^(j / 3) Hz (1/3 octave from 20 Hz). */
export const equoFreq = (j: number) => 20 * Math.pow(2, j / 3);

/** Band value (0..2) -> gain: (3^v - 1) / 2 (measured). */
export const equoGain = (v: number) => (Math.pow(3, Math.min(2, Math.max(0, v))) - 1) / 2;

/** Output volume: (11^(x / 128) - 1) / 10 (x 0..256, 128 = unity, 256 = x12). */
export const equoVol = (x: number) => (Math.pow(11, Math.min(256, Math.max(0, x)) / 128) - 1) / 10;

export const equoKey = (bank: number, kind: 'v' | 'p' | 's', band: number) => (bank < 0 ? `m${kind}${band + 1}` : `b${bank}${kind}${band + 1}`);

const pct = (lo: number, hi: number) => (v: number) => `${Math.round(((v - lo) / (hi - lo)) * 100)}%`;
/** FL's value text for band parameters: the gain rounded to a whole number, in percent ("100" = unity). */
const bandText = (raw: number) => String(Math.round(equoGain(raw / EQUO_ONE)) * 100);

/** Readable band value for the editor's hint bar. */
export function equoValueText(kind: 'v' | 'p' | 's', v: number): string {
  if (kind === 'p') return Math.abs(v - 1) < 0.005 ? 'centered' : `${Math.round(Math.abs(v - 1) * 100)}% ${v < 1 ? 'left' : 'right'}`;
  const g = equoGain(v);
  return g <= 1e-6 ? '-inf dB' : `${g >= 1 ? '+' : ''}${(20 * Math.log10(g)).toFixed(1)} dB`;
}

/** Band frequency label ("640 Hz", "1.28 kHz"). */
export function equoFreqText(j: number): string {
  const f = equoFreq(j);
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`;
}

function buildParams(): FxParamDef[] {
  const out: FxParamDef[] = [
    { key: 'shift', name: 'Band shift', index: 0, min: -12000, max: 12000, def: 0, format: (v) => `${Math.round(v / 120)}%`, bipolar: true },
    { key: 'mix', name: 'Band mix', index: 1, min: -128, max: 128, def: 128, format: (v) => `${Math.round((v / 128) * 100)}%`, bipolar: true },
    { key: 'morph', name: 'Morph between banks', index: 2, min: 0, max: 7000, def: 0, format: pct(0, 7000) },
    { key: 'smooth', name: 'Motion smoothness', index: 3, min: 0, max: 1024, def: 170, format: pct(0, 1024) },
    { key: 'vol', name: 'Output volume', index: 4, min: 0, max: 256, def: 128, format: pct(0, 256) },
  ];
  let index = 5;
  const names = { v: 'volume', p: 'panning', s: 'send' } as const;
  for (let b = 0; b <= EQUO_BANKS; b++) {
    const bank = b === EQUO_BANKS ? -1 : b;
    for (const kind of EQUO_KINDS) {
      for (let j = 0; j < EQUO_BANDS; j++) {
        out.push({
          key: equoKey(bank, kind, j), name: `${bank < 0 ? 'Master' : `Bank ${bank}`} - ${names[kind]} - band ${j + 1}`, index: index++,
          min: 0, max: EQUO_MAX, def: EQUO_ONE, format: bandText, bipolar: kind === 'p',
        });
      }
    }
  }
  return out;
}

export const EQUO_PARAMS = buildParams();

export interface EquoState {
  /** Bandwidth (80..500, 300 = one octave per band), 2x oversampling, add mode, send only. */
  bw: number; os: number; add: number; sendOnly: number;
  /** Send mixer track (-1 = none). */
  sendTarget: number;
  /** Band modes per curve kind (0 enabled, 1 off, 2 locked), 31 each. */
  modes: { v: number[]; p: number[]; s: number[] };
}

export const equoDefaultState = (): EquoState => ({
  bw: 150, os: 0, add: 0, sendOnly: 0, sendTarget: -1,
  modes: { v: Array(EQUO_BANDS).fill(0), p: Array(EQUO_BANDS).fill(0), s: Array(EQUO_BANDS).fill(0) },
});

export function equoNormalizeState(s: unknown): EquoState {
  const d = equoDefaultState();
  if (!s || typeof s !== 'object') return d;
  const o = s as Partial<EquoState>;
  const num = (v: unknown, def: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  const modes = (o.modes ?? {}) as Partial<EquoState['modes']>;
  const m = (a: unknown) => (Array.isArray(a) ? d.modes.v.map((_, i) => (a[i] === 1 || a[i] === 2 ? a[i] : 0)) : d.modes.v.slice());
  return {
    bw: num(o.bw, 150, 80, 500), os: num(o.os, 0, 0, 1) ? 1 : 0, add: num(o.add, 0, 0, 1) ? 1 : 0, sendOnly: num(o.sendOnly, 0, 0, 1) ? 1 : 0,
    sendTarget: Math.round(num(o.sendTarget, -1, -1, 1e6)),
    modes: { v: m(modes.v), p: m(modes.p), s: m(modes.s) },
  };
}

const DEFAULTS: Record<string, number> = Object.fromEntries(EQUO_PARAMS.map((p) => [p.key, p.def]));

/** Expand a compact preset (non-default band values as [key, value] pairs). */
export function equoExpandPreset(p: { g?: Record<string, number>; b?: [string, number][]; st?: Partial<EquoState> }): Record<string, unknown> {
  const out: Record<string, unknown> = { ...DEFAULTS, ...(p.g ?? {}) };
  for (const [k, v] of p.b ?? []) out[k] = v;
  out.eq = { ...equoDefaultState(), ...(p.st ?? {}) };
  return out;
}

export const def: FxPluginDef = {
  id: 'equo',
  name: 'EQUO',
  category: 'Filter',
  width: 565,
  height: 240,
  description: 'Morphing 31-band graphic equalizer with per band panning and sends',
  params: EQUO_PARAMS,
  state: () => ({ eq: equoDefaultState(), eqUi: { bank: 0, kind: 0, draw: 2 } }),
  normalize: (p) => ({ ...p, eq: equoNormalizeState(p.eq) }),
  viewState: ['eqUi'],
  presets: EQUO_PRESETS.map((p) => ({ name: p.n, params: equoExpandPreset(p) })),
};
