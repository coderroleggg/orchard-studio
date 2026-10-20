// Effect plugin registry for the audio engine: every module in ./plugins
// exports `effect: EffectModule`; Parametric EQ 2 lives in ./ParametricEQ2.

import { ParametricEQ2 } from './ParametricEQ2';
import type { EffectInstance, EffectModule, FxEnv } from './types';

export type { EffectInstance, EffectModule, FxContext, FxEnv, FxMonitor } from './types';

const mods = import.meta.glob<{ effect?: EffectModule }>('./plugins/*.ts', { eager: true });

const registry = new Map<string, EffectModule>();
registry.set('peq2', { id: 'peq2', create: (sr, bs) => new ParametricEQ2(sr, bs) });
for (const m of Object.values(mods)) if (m.effect) registry.set(m.effect.id, m.effect);

const NO_ENV: FxEnv = { sample: () => undefined };

/** Register an effect module at runtime (tests, dynamically added plugins). */
export function registerEffect(m: EffectModule): void {
  registry.set(m.id, m);
}

export function hasEffect(plugin: string): boolean {
  return registry.has(plugin);
}

export function createEffect(plugin: string, sampleRate: number, blockSize: number, env: FxEnv = NO_ENV): EffectInstance {
  const m = registry.get(plugin);
  if (m) return m.create(sampleRate, blockSize, env);
  return { setParams() {}, process() {}, reset() {} };
}
