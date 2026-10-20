// Reeverb (FL: Fruity Reeverb, legacy). FL's legacy plugin runs the same
// engine as Reeverb 2, so this wraps the Reeverb 2 DSP and maps the legacy
// raw values onto it (measured with FL's plugin, see docs/research/fx/reeverb.md):
//   room / diffusion / decay / cuts / damping: truncated to Reeverb 2's units,
//   color: Reeverb 2 bass multiplier 20 / 60 / 100 / 150 / 300 % at 500 Hz,
//   predelay: whole ms (FL delays round(ms * fs / 1000) - 1 samples),
//   dry: linear gain, reverb: linear gain of the first tank echo,
//   no early reflections, mono (MID) input, no separation, no modulation.

import { COLOR_BASS, COLOR_CROSS, colorIndex, decayTenths, diffusionPct, kHzTenths, lowCutHz, roomSize } from '../../../model/fx/plugins/reeverb';
import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { Reeverb2, TAP_GAIN } from './reeverb2';

const U = 65536;

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** Reeverb 2 parameters for a legacy state (defaults = FL's Default preset). */
export function legacyToReeverb2(raw: unknown): Record<string, unknown> {
  const q = (raw ?? {}) as Record<string, unknown>;
  const c = (k: string, d: number, max = U) => Math.min(max, Math.max(0, num(q[k], d)));
  return {
    lowCut: lowCutHz(c('lowCut', 1231)),
    highCut: kHzTenths(c('highCut', 10682)),
    predelay: 0,
    room: roomSize(c('room', 26345)),
    diffusion: diffusionPct(c('diffusion', U)),
    decay: decayTenths(c('decay', 4614)),
    damping: kHzTenths(c('damping', 10879)),
    bass: COLOR_BASS[colorIndex(c('color', 20, 40))],
    cross: COLOR_CROSS,
    sep: 0,
    dry: 0,
    er: 0,
    wet: 128,
    modSpeed: 0,
    modDepth: 0,
    side: false,
    tempo: false,
    ovDry: c('dry', U) / U,
    ovWet: c('reverb', 13238) / U / TAP_GAIN,
    ovEr: 0,
    ovPredelayMs: Math.round(c('predelay', 0, 250)),
  };
}

export class Reeverb implements EffectInstance {
  private rv: Reeverb2;
  latency = 0;

  constructor(sampleRate: number) {
    this.rv = new Reeverb2(sampleRate);
    this.rv.setParams(legacyToReeverb2({}));
    this.rv.reset();
  }

  get tail(): number {
    return this.rv.tail;
  }

  setParams(p: unknown): void {
    this.rv.setParams(legacyToReeverb2(p));
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    this.rv.process(L, R, n, ctx);
  }

  reset(): void {
    this.rv.reset();
  }

  monitor(): FxMonitor {
    return this.rv.monitor();
  }
}

export const effect: EffectModule = {
  id: 'reeverb',
  create: (sampleRate) => new Reeverb(sampleRate),
};
