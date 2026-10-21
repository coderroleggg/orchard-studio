// Plugins hosted inside Patcher (effects and generators; Patcher modules). Their
// editors, display data and parameter edits address them as "<slot id>#<module
// id>"; the module lives in the host slot's state at $graph.modules[<module id>].
// The host is a mixer effect slot or, for the instrument version of Patcher, a
// channel ("ch:<channel id>#<module id>", state at Channel.plugin.params).
// Generator modules have ids starting with 'g' (isGenSlot).

import type { Id, Project } from '../types';
import { GEN_PARAM_PATH, channelOfSlot, genTargetOf, hostedInChannel } from '../gen/ids';
import { isGenModule } from './plugins/patcher/graph';

export const HOSTED_SEP = '#';
const HOST_GRAPH = '$graph';

export function splitHostedId(id: Id): { slotId: Id; moduleId: string } | null {
  const k = id.indexOf(HOSTED_SEP);
  return k > 0 ? { slotId: id.slice(0, k), moduleId: id.slice(k + 1) } : null;
}

export type HostedModule = { plugin: string; name?: string; params: Record<string, unknown> };

/**
 * The slot id belongs to an instrument plugin: a channel's ("ch:<id>") or a
 * generator hosted in a Patcher ("<slot id>#g<n>"). Other ids are effects
 * (mixer slots and the effect modules of Patchers).
 */
export function isGenSlot(slotId: Id): boolean {
  if (channelOfSlot(slotId) !== null) return true;
  const h = splitHostedId(slotId);
  return !!h && isGenModule(h.moduleId);
}

/**
 * Where state key `key` of plugin `slotId` lives for automation and links: the
 * mixer slot and the path in it (scope 'fx'; inside the host's state for
 * modules hosted in Patcher, "<slot>#<module>"), or, for an instrument
 * ("ch:<channel id>"), its channel and `plugin.params.<key>` with
 * scope 'channel'; a module hosted in an instrument Patcher
 * ("ch:<channel id>#<module>") is addressed inside the channel's plugin state
 * (`plugin.params.$graph.modules.<module>.params.<key>`, scope 'channel').
 * Effect targets carry no scope field (it is 'fx'): use pluginTargetOf for a
 * target with its scope.
 */
export function fxTargetOf(slotId: Id, key: string): { scope?: 'channel'; id: Id; path: string } {
  const ch = channelOfSlot(slotId);
  if (ch !== null) return genTargetOf(ch, key);
  const hc = hostedInChannel(slotId);
  if (hc) return { scope: 'channel', id: hc.channelId, path: `${GEN_PARAM_PATH}${HOST_GRAPH}.modules.${hc.moduleId}.params.${key}` };
  const h = splitHostedId(slotId);
  return h ? { id: h.slotId, path: `params.${HOST_GRAPH}.modules.${h.moduleId}.params.${key}` } : { id: slotId, path: `params.${key}` };
}

/** fxTargetOf with the scope: { scope: 'fx' | 'channel', id, path } (automation / link targets of editor controls). */
export function pluginTargetOf(slotId: Id, key: string): { scope: 'fx' | 'channel'; id: Id; path: string } {
  return { scope: 'fx', ...fxTargetOf(slotId, key) };
}

/**
 * The effect parameter an automation / link target points at: the plugin, its
 * state and the parameter key, for `params.<key>` of a slot or
 * `params.$graph.modules.<module>.params.<key>` of a module hosted in it.
 */
export function fxParamAt(p: Project, slotId: Id, path: string): { plugin: string; state: Record<string, unknown>; key: string; gen: boolean } | null {
  let slot: { plugin: string; params: Record<string, unknown> } | undefined;
  for (const t of p.mixer.tracks) { slot = t.slots.find((s) => s?.id === slotId) ?? undefined; if (slot) break; }
  if (!slot) return null;
  const hosted = path.match(/^params\.\$graph\.modules\.([^.]+)\.params\.([^.]+)$/);
  if (hosted) {
    const m = hostedModule(slot.params, hosted[1]);
    return m ? { plugin: m.plugin, state: m.params, key: hosted[2], gen: isGenModule(hosted[1]) } : null;
  }
  const top = path.match(/^params\.([^.]+)$/);
  return top ? { plugin: slot.plugin, state: slot.params, key: top[1], gen: false } : null;
}

/**
 * The instrument parameter a channel-scope automation / link path points at: the
 * channel's own plugin (`plugin.params.<key>`) or a module hosted in its Patcher
 * (`plugin.params.$graph.modules.<module>.params.<key>`; `gen` tells the registry:
 * a generator module's parameters are an instrument's, an effect module's an effect's).
 */
export function channelParamAt(p: Project, channelId: Id, path: string): { plugin: string; state: Record<string, unknown>; key: string; gen: boolean } | null {
  const c = p.channels.find((x) => x.id === channelId);
  if (!c || c.kind !== 'plugin' || !c.plugin) return null;
  const hosted = path.match(/^plugin\.params\.\$graph\.modules\.([^.]+)\.params\.([^.]+)$/);
  if (hosted) {
    const m = hostedModule(c.plugin.params, hosted[1]);
    return m ? { plugin: m.plugin, state: m.params, key: hosted[2], gen: isGenModule(hosted[1]) } : null;
  }
  const top = path.match(/^plugin\.params\.([^.]+)$/);
  return top ? { plugin: c.plugin.id, state: c.plugin.params, key: top[1], gen: true } : null;
}

/** Module `moduleId` of a host slot's state, if it hosts one. */
export function hostedModule(params: unknown, moduleId: string): HostedModule | undefined {
  const g = (params as Record<string, unknown> | undefined)?.[HOST_GRAPH] as { modules?: Record<string, HostedModule> } | undefined;
  return g?.modules?.[moduleId];
}

/**
 * Every effect of the project: the mixer slots, then (after each Patcher slot)
 * the effect modules hosted in it, with their "<slot>#<module>" ids, and the
 * effect modules hosted in the Patcher channels ("ch:<channel>#<module>").
 * `plugin` limits it to one plugin id.
 */
export function* allFx(p: Project, plugin?: string): Generator<{ id: Id; plugin: string; params: Record<string, unknown> }> {
  for (const t of p.mixer.tracks) {
    for (const s of t.slots) {
      if (!s) continue;
      if (!plugin || s.plugin === plugin) yield { id: s.id, plugin: s.plugin, params: s.params };
      yield* hostedEffects(s.id, s.params, plugin);
    }
  }
  for (const c of p.channels ?? []) {
    if (c.kind === 'plugin' && c.plugin) yield* hostedEffects(`ch:${c.id}`, c.plugin.params, plugin);
  }
}

function* hostedEffects(hostId: Id, params: Record<string, unknown> | undefined, plugin?: string): Generator<{ id: Id; plugin: string; params: Record<string, unknown> }> {
  const mods = (params?.[HOST_GRAPH] as { modules?: Record<string, HostedModule> } | undefined)?.modules;
  if (!mods || typeof mods !== 'object') return;
  for (const [mid, m] of Object.entries(mods)) {
    if (isGenModule(mid) || !m || typeof m.plugin !== 'string' || !m.params || typeof m.params !== 'object') continue;
    if (!plugin || m.plugin === plugin) yield { id: `${hostId}${HOSTED_SEP}${mid}`, plugin: m.plugin, params: m.params };
  }
}
