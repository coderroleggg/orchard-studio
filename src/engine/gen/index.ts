// Instrument plugin registry for the audio engine: every module in ./plugins
// exports `gen: GenModule` (src/engine/gen/types.ts).

import type { GenEnv, GenInstance, GenModule } from './types';

export type { GenContext, GenEnv, GenInstance, GenModule, GenNote, GenVoice, GenVoiceParams, GenLevels } from './types';

const mods = import.meta.glob<{ gen?: GenModule }>('./plugins/*.ts', { eager: true });

const registry = new Map<string, GenModule>();
for (const m of Object.values(mods)) if (m.gen) registry.set(m.gen.id, m.gen);

const NO_ENV: GenEnv = { sample: () => undefined };

/** Register an instrument module at runtime (tests). */
export function registerGen(m: GenModule): void {
  registry.set(m.id, m);
}

export function hasGen(plugin: string): boolean {
  return registry.has(plugin);
}

/** Create an instrument instance; null for an unknown plugin (the channel stays silent). */
export function createGen(plugin: string, sampleRate: number, blockSize: number, env: GenEnv = NO_ENV): GenInstance | null {
  const m = registry.get(plugin);
  return m ? m.create(sampleRate, blockSize, env) : null;
}
