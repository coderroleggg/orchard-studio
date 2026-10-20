// Convolver (FL: Fruity Convolver): convolution with an impulse response from
// the project's sample pool (or a built-in synthetic room). Form: 714 x 346.
// FL automates only dry, wet and the two stereo separations (Tags 0..3); the
// delay / self-convolution / stretch / equalizer-mix knobs and the impulse
// editing state (envelopes, EQ curve, trims) are plugin state.

import type { FxParamDef, FxPluginDef } from '../types';

/** Dry level curve (FL): (11^(v/1000) - 1) / 10. */
export function convDryGain(v: number): number {
  return (Math.pow(11, v / 1000) - 1) / 10;
}
/** Wet level curve (FL): (1000^(v/1000) - 1) / 999, "-30.3dB" at the default 500. */
export function convWetGain(v: number): number {
  return (Math.pow(1000, v / 1000) - 1) / 999;
}
const dbText = (g: number) => {
  if (g <= 0) return '-InfdB';
  const db = 20 * Math.log10(g);
  const s = db.toFixed(1);
  return `${Number(s) === 0 ? '0.0' : s}dB`;
};
export const sepText = (v: number) => {
  const p = Math.round(Math.abs(v) / 10);
  return p === 0 ? 'Original' : `${p}% ${v < 0 ? 'separated' : 'merged'}`;
};
/** Pre-delay knob (0..1000 = 0..1000 ms). */
export const convDelayMs = (v: number) => v;
/** Stretch knob (-1000..1000): resampling ratio 2^(v/1000) (half to double length). */
export const stretchRatio = (v: number) => Math.pow(2, v / 1000);

export interface EnvPoint { t: number; v: number; tension?: number }

export type EnvKind = 'vol' | 'pan' | 'sep' | 'ap';

export interface ConvState {
  /** Sample pool id of the impulse, or null for the built-in room. */
  impulse: string | null;
  impulseName: string;
  normalize: boolean;
  reverse: boolean;
  /** Fades as fractions of the impulse length. */
  fadeIn: number;
  fadeOut: number;
  /** Trim (fractions of the source length). */
  trimStart: number;
  trimEnd: number;
  /** Impulse envelopes (time 0..1 over the impulse): volume, pan, stereo separation, all-purpose (damping). */
  env: Record<EnvKind, EnvPoint[]>;
  /** Equalizer curve over FL's frequency axis (eqFreqOfT); 0.5 = no change, 1 = +12 dB, 0 = -inf. */
  eq: EnvPoint[];
  /** Latency reported for delay compensation (samples). */
  latency: number;
  /** Editor view. */
  view: 'impulse' | 'equalizer';
  envEdit: EnvKind | null;
  /** Counters the engine reacts to: trigger an impulse click / arm recording. */
  trigger: number;
  record: number;
}

export const DEFAULT_ENV: Record<EnvKind, EnvPoint[]> = {
  vol: [{ t: 0, v: 1 }, { t: 1, v: 1 }],
  pan: [{ t: 0, v: 0.5 }, { t: 1, v: 0.5 }],
  sep: [{ t: 0, v: 0.5 }, { t: 1, v: 0.5 }],
  ap: [{ t: 0, v: 1 }, { t: 1, v: 1 }],
};
export const DEFAULT_EQ: EnvPoint[] = [{ t: 0, v: 0.5 }, { t: 1, v: 0.5 }];

export function defaultConvState(): ConvState {
  return {
    impulse: null, impulseName: 'Default', normalize: true, reverse: false, fadeIn: 0, fadeOut: 0, trimStart: 0, trimEnd: 1,
    env: structuredClone(DEFAULT_ENV), eq: structuredClone(DEFAULT_EQ), latency: 0, view: 'impulse', envEdit: null, trigger: 0, record: 0,
  };
}

/** Envelope value at time t (0..1): piecewise curve with optional tension (-1..1). */
export function envAt(pts: EnvPoint[], t: number): number {
  if (!pts.length) return 0.5;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      let f = span > 1e-9 ? (t - a.t) / span : 1;
      const k = a.tension ?? 0;
      if (k) f = k > 0 ? Math.pow(f, 1 + 4 * k) : 1 - Math.pow(1 - f, 1 - 4 * k);
      return a.v + (b.v - a.v) * f;
    }
  }
  return pts[pts.length - 1].v;
}

/**
 * FL's equalizer frequency axis (measured from its editor labels): logarithmic
 * from about 260 Hz up (85 px per octave on the 714 px editor), stretched
 * toward linear below. t = 0..1 across the editor width.
 */
const EQ_AXIS_F = [0, 20, 32.7, 50, 65.4, 100, 130.8, 200, 261.6, 500, 1000, 2000, 4186, 8372, 16744, 20000, 22050];
const EQ_AXIS_X = [0, 18, 26.7, 38, 48, 73, 90.7, 145, 176, 257, 341, 425, 515, 601, 687, 707, 714];

export function eqTOfFreq(f: number): number {
  if (f <= 0) return 0;
  for (let i = 1; i < EQ_AXIS_F.length; i++) {
    if (f <= EQ_AXIS_F[i]) {
      const f0 = EQ_AXIS_F[i - 1], f1 = EQ_AXIS_F[i];
      const u = f0 > 0 ? Math.log(f / f0) / Math.log(f1 / f0) : f / f1;
      return (EQ_AXIS_X[i - 1] + (EQ_AXIS_X[i] - EQ_AXIS_X[i - 1]) * u) / 714;
    }
  }
  return 1;
}

export function eqFreqOfT(t: number): number {
  const x = Math.min(1, Math.max(0, t)) * 714;
  for (let i = 1; i < EQ_AXIS_X.length; i++) {
    if (x <= EQ_AXIS_X[i]) {
      const f0 = EQ_AXIS_F[i - 1], f1 = EQ_AXIS_F[i];
      const u = (x - EQ_AXIS_X[i - 1]) / (EQ_AXIS_X[i] - EQ_AXIS_X[i - 1]);
      return f0 > 0 ? f0 * Math.pow(f1 / f0, u) : f1 * u;
    }
  }
  return 22050;
}

/** Equalizer curve value -> linear gain (+12 dB at the top, -inf at the bottom). */
export function eqGain(v: number): number {
  if (v >= 0.5) return Math.pow(10, (24 * (v - 0.5)) / 20);
  const a = Math.max(0, 2 * v);
  return a * a;
}

const P = (key: string, name: string, min: number, max: number, def: number, format: (v: number) => string, extra: Partial<FxParamDef> = {}): FxParamDef =>
  ({ key, name, min, max, def, format, ...extra });

export const def: FxPluginDef = {
  id: 'convolver',
  name: 'Convolver',
  category: 'Delay reverb',
  width: 714,
  height: 346,
  description: 'Convolution reverb / impulse response processor with impulse envelopes and equalizer',
  params: [
    P('dry', 'Dry level', 0, 1000, 1000, (v) => dbText(convDryGain(v)), { index: 0 }),
    P('wet', 'Wet level', 0, 1000, 500, (v) => dbText(convWetGain(v)), { index: 1 }),
    P('inSep', 'Input stereo separation', -1000, 1000, 0, sepText, { index: 2, bipolar: true }),
    P('wetSep', 'Wet stereo separation', -1000, 1000, 0, sepText, { index: 3, bipolar: true }),
    // FL's editor knobs without a parameter index (not automatable)
    P('delay', 'Pre-delay time', 0, 1000, 0, (v) => `${Math.round(convDelayMs(v))} ms`, { noAuto: true }),
    P('selfConv', 'Self-convolution amount', 0, 1000, 0, (v) => `${Math.round(v / 10)}%`, { noAuto: true }),
    P('stretch', 'Stretching (resampling) ratio', -1000, 1000, 0, (v) => `x${stretchRatio(v).toFixed(2)}`, { noAuto: true, bipolar: true }),
    P('eqMix', 'Equalizer mix', 0, 1000, 1000, (v) => `${Math.round(v / 10)}%`, { noAuto: true }),
  ],
  state: () => defaultConvState() as unknown as Record<string, unknown>,
  normalize: (p) => {
    const d = defaultConvState();
    const env = (p.env && typeof p.env === 'object' ? p.env : {}) as Partial<Record<EnvKind, EnvPoint[]>>;
    return {
      ...p,
      impulse: typeof p.impulse === 'string' ? p.impulse : null,
      impulseName: typeof p.impulseName === 'string' ? p.impulseName : d.impulseName,
      normalize: p.normalize === undefined ? d.normalize : !!p.normalize,
      env: {
        vol: Array.isArray(env.vol) ? env.vol : d.env.vol, pan: Array.isArray(env.pan) ? env.pan : d.env.pan,
        sep: Array.isArray(env.sep) ? env.sep : d.env.sep, ap: Array.isArray(env.ap) ? env.ap : d.env.ap,
      },
      eq: Array.isArray(p.eq) ? p.eq : d.eq,
      view: p.view === 'equalizer' ? 'equalizer' : 'impulse',
    };
  },
};
