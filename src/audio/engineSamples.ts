// Audio that effects (and instrument plugins) play from the sample pool or render on the main thread,
// gathered for engines other than the live one (project WAV export). The live
// engine receives it from AudioHost.pushFxSamples and the plugins' own
// delivery; an export engine starts empty, so it asks the providers here.

import type { Project } from '../model/types';
import { getRaw } from './samples';

export interface EngineSample {
  id: string;
  channels: Float32Array[];
  sampleRate: number;
}

/** Returns the engine samples a plugin's slots need, rendered for `sampleRate` where that matters. */
export type EngineSampleProvider = (p: Project, sampleRate: number) => EngineSample[];

const providers = new Map<string, EngineSampleProvider>();

/** Register (or replace, on hot reload) a plugin's provider. */
export function registerEngineSamples(name: string, fn: EngineSampleProvider): void {
  providers.set(name, fn);
}

/**
 * Pool sample ids effect slots' and instrument plugins' states refer to:
 * strings under keys containing "sample" (instruments read them with
 * GenEnv.sample like effects with FxEnv.sample).
 */
export function slotSampleRefs(p: Project): Set<string> {
  const want = new Set<string>();
  const scan = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === 'string' && /sample/i.test(k) && p.samples[v]) want.add(v);
      else if (v && typeof v === 'object') scan(v, depth + 1);
    }
  };
  for (const tr of p.mixer.tracks) for (const sl of tr.slots) if (sl) scan(sl.params, 0);
  for (const c of p.channels) if (c.kind === 'plugin' && c.plugin) scan(c.plugin.params, 0);
  return want;
}

/** Everything the effects of `p` need in a fresh engine running at `sampleRate`. */
export function engineSamplesFor(p: Project, sampleRate: number): EngineSample[] {
  const out: EngineSample[] = [];
  for (const id of slotSampleRefs(p)) {
    const r = getRaw(id);
    if (r) out.push({ id, channels: r.channels, sampleRate: r.sampleRate });
  }
  for (const fn of providers.values()) {
    try { for (const s of fn(p, sampleRate)) if (s.channels.length) out.push(s); } catch { /* a plugin's samples are not ready */ }
  }
  return out;
}
