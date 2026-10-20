// Maximus: FL's multiband maximizer. The DSP lives in ./maximus/core.ts (shared
// with Soundgoodizer); this module maps the slot state (FL's 59 parameters,
// the band curves and the option switches) to the core's configuration.

import type { EffectInstance, EffectModule, FxMonitor } from '../types';
import {
  MX_PARAMS, mxFreqHz, mxGain, mxKey, mxLongMs, mxLowCutHz, mxShortMs, mxSideGain, type MxField,
} from '../../../model/fx/plugins/maximus';
import { normalizeCurve, type CurvePoint } from '../../../model/fx/plugins/maximus/curve';
import { MaximusCore, type MxBandConfig, type MxConfig } from './maximus/core';

const DEFS = new Map(MX_PARAMS.map((q) => [q.key, q.def]));

/** Read a parameter (control units) from a state object, falling back to FL's default. */
export function mxNum(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return DEFS.get(key) ?? 0;
}

/** Map a Maximus state (params + curves + options) to the DSP configuration. */
export function mxConfig(p: Record<string, unknown>): MxConfig {
  const curves = Array.isArray(p.curves) ? (p.curves as unknown[]) : [];
  const bands: MxBandConfig[] = [0, 1, 2, 3].map((b) => {
    const g = (f: MxField) => mxNum(p, mxKey(b, f));
    const rel2 = g('Rel2');
    return {
      mode: Math.max(0, Math.min(3, Math.round(g('Mode')))),
      pre: mxGain(g('Pre')),
      post: mxGain(g('Post')),
      side: mxSideGain(g('Stereo')),
      satThres: Math.max(-1, Math.min(1, g('SatThres') / 1000)),
      satCeil: mxGain(g('SatCeil')),
      attMs: g('Att') > 0 ? mxShortMs(g('Att')) : 0,
      rel2Ms: rel2 > 0 ? mxLongMs(rel2) : 0,
      attCurve: g('AttCurve'),
      relMs: mxLongMs(g('Rel')),
      relCurve: g('RelCurve'),
      susMs: mxShortMs(g('Sustain')),
      rms: g('SusMode') >= 1,
      curve: normalizeCurve(curves[b]) as CurvePoint[],
    };
  });
  const an = (p.an && typeof p.an === 'object' ? p.an : {}) as { input?: number };
  return {
    f1: mxFreqHz(mxNum(p, 'lowFreq')),
    f2: mxFreqHz(mxNum(p, 'highFreq')),
    slope1: mxNum(p, 'lowSlope') >= 1 ? 1 : 0,
    slope2: mxNum(p, 'highSlope') >= 1 ? 1 : 0,
    lmhDelayMs: mxShortMs(mxNum(p, 'lmhDelay')),
    mix: mxNum(p, 'lmhMix') / 1000,
    lowCutHz: mxLowCutHz(mxNum(p, 'lowCut')),
    bands,
    solo: p.solo === true,
    soloBand: typeof p.band === 'number' ? p.band : 3,
    midMode: p.masterMid === true,
    safety: p.safety !== false,
    monInput: typeof an.input === 'number' ? an.input : 0,
    oversample: typeof p.oversample === 'number' ? p.oversample : p.oversample === true ? 1 : 0,
    linear: p.linPhase === true,
  };
}

export class MaximusFx implements EffectInstance {
  readonly core: MaximusCore;
  private sr: number;
  private bandsView = false;

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    this.core = new MaximusCore(sampleRate, blockSize);
    this.core.configure(mxConfig({ curves: [] }));
  }

  get latency(): number { return this.core.latency; }
  /** The lookahead delay lines keep sounding after the input stops. */
  get tail(): number { return this.core.latency / this.sr + 0.05; }

  setParams(p: unknown): void {
    const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    this.bandsView = q.display === 1;
    this.core.configure(mxConfig(q));
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    this.core.process(L, R, n);
  }

  reset(): void { this.core.reset(); }

  monitor(): FxMonitor {
    const m: FxMonitor = { chunks: this.core.takeChunks(), gains: this.core.gains(), latency: this.core.latency };
    if (this.bandsView) m.spectrum = this.core.spectrum(160);
    return m;
  }
}

export const effect: EffectModule = {
  id: 'maximus',
  create: (sr, bs) => new MaximusFx(sr, bs),
};
