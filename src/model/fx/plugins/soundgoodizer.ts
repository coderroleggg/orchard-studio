// Soundgoodizer (FL: Soundgoodizer): a Maximus engine running one of four
// factory Maximus presets (modes A..D, FL's "Soundgoodizer presets/a..d"),
// with the big knob driving its LMH mix. Verified on FL's own plugin: its
// state is (version 3, mode, amount 0..1000, default 600) and its output
// equals Maximus with preset a..d and LMH mix = amount (docs/research/fx/soundgoodizer.md).
// FL exposes no automatable parameters for it, so both controls are noAuto.

import type { FxPluginDef } from '../types';
import { MAXIMUS_DEFAULTS, MAXIMUS_PRESET_DATA } from './maximus/presets';
import { LIMIT_CURVE, type CurvePoint } from './maximus/curve';
import { MX_PARAMS } from './maximus';

export const SG_MODES = ['A', 'B', 'C', 'D'];

/** Full Maximus state for a Soundgoodizer mode at a given amount (0..1000). */
export function sgMaximusState(mode: number, amount: number): Record<string, unknown> {
  const pr = MAXIMUS_PRESET_DATA.find((p) => p.name === `Soundgoodizer presets/${'abcd'[Math.max(0, Math.min(3, mode))]}`)!;
  const st: Record<string, unknown> = {};
  MX_PARAMS.forEach((q, k) => { st[q.key] = MAXIMUS_DEFAULTS[k]; });
  Object.assign(st, pr.params);
  st.lmhMix = Math.max(0, Math.min(1000, amount));
  st.curves = [0, 1, 2, 3].map((k) => (pr.curves?.[k] ?? LIMIT_CURVE).map((q) => [...q] as CurvePoint));
  st.oversample = pr.oversample ?? 0;
  st.masterMid = pr.midMode ?? false;
  st.safety = true;
  return st;
}

export const def: FxPluginDef = {
  id: 'soundgoodizer',
  name: 'Soundgoodizer',
  category: 'Dynamics',
  width: 210,
  height: 294,
  description: 'One-knob maximizer-enhancer (Maximus presets A to D)',
  params: [
    { key: 'amount', name: 'Amount', min: 0, max: 1000, def: 600, noAuto: true, format: (v) => `${Math.round(v / 10)}%`, parse: (pct) => Math.round(pct * 10) },
    { key: 'mode', name: 'Mode', min: 0, max: 3, def: 0, noAuto: true, options: SG_MODES },
  ],
};
