// Instruments seen through the effect editor kit. An instrument channel's
// plugin is addressed as "ch:<channel id>" wherever the kit and the store's
// slot actions take a slot id (findFx, setFxParam, editFx, setFxStateNoHistory,
// fxParamsDraft, useFxMonitor), so effect editors' building blocks work
// unchanged for instrument editors. Its state lives at Channel.plugin.params;
// automation and controller links address a parameter as
// { scope: 'channel', id: <channel id>, path: 'plugin.params.<key>' }.

import type { Id, Project } from '../types';
import { isGenModule } from '../fx/plugins/patcher/graph';

export const CHANNEL_SLOT_PREFIX = 'ch:';
/** Path of an instrument parameter inside its channel (automation / link targets). */
export const GEN_PARAM_PATH = 'plugin.params.';

/** The kit's slot id of a channel's instrument plugin. */
export function channelSlotId(channelId: Id): string {
  return CHANNEL_SLOT_PREFIX + channelId;
}

/**
 * The channel id of an instrument slot id ("ch:<id>"), or null for effect slot
 * ids and for modules hosted in a channel's Patcher ("ch:<id>#<module>", see
 * hostedInChannel): those are plugins of their own, not the channel's instrument.
 */
export function channelOfSlot(slotId: string): Id | null {
  return slotId.startsWith(CHANNEL_SLOT_PREFIX) && !slotId.includes('#') ? slotId.slice(CHANNEL_SLOT_PREFIX.length) : null;
}

/** A module hosted in a channel's Patcher ("ch:<channel id>#<module id>"): the channel and the module id. */
export function hostedInChannel(slotId: string): { channelId: Id; moduleId: string } | null {
  if (!slotId.startsWith(CHANNEL_SLOT_PREFIX)) return null;
  const k = slotId.indexOf('#');
  return k > CHANNEL_SLOT_PREFIX.length ? { channelId: slotId.slice(CHANNEL_SLOT_PREFIX.length, k), moduleId: slotId.slice(k + 1) } : null;
}

/** Automation / link target of instrument parameter `key` of a channel. */
export function genTargetOf(channelId: Id, key: string): { scope: 'channel'; id: Id; path: string } {
  return { scope: 'channel', id: channelId, path: GEN_PARAM_PATH + key };
}

/** The parameter key of a 'channel' scope target path ('plugin.params.<key>'), or null. */
export function genParamKeyOf(path: string): string | null {
  if (!path.startsWith(GEN_PARAM_PATH)) return null;
  const k = path.slice(GEN_PARAM_PATH.length);
  return k && !k.includes('.') ? k : null;
}

/**
 * Every instrument plugin of the project with its "ch:<channel id>" slot id
 * (the counterpart of allFx for main-thread code that walks plugins: sample
 * delivery, persistent windows, formula scans), followed by the generators
 * hosted in a Patcher channel ("ch:<channel id>#g<n>"). `plugin` limits it to
 * one id.
 */
export function* allGens(p: Project, plugin?: string): Generator<{ id: string; channelId: Id; plugin: string; params: Record<string, unknown> }> {
  for (const c of p.channels) {
    if (c.kind !== 'plugin' || !c.plugin || typeof c.plugin.id !== 'string') continue;
    const slotId = channelSlotId(c.id);
    if (!plugin || c.plugin.id === plugin) yield { id: slotId, channelId: c.id, plugin: c.plugin.id, params: c.plugin.params ?? {} };
    const mods = (c.plugin.params?.$graph as { modules?: Record<string, { plugin?: unknown; params?: unknown }> } | undefined)?.modules;
    if (!mods || typeof mods !== 'object') continue;
    for (const [mid, m] of Object.entries(mods)) {
      if (!isGenModule(mid) || !m || typeof m.plugin !== 'string' || !m.params || typeof m.params !== 'object') continue;
      if (!plugin || m.plugin === plugin) yield { id: `${slotId}#${mid}`, channelId: c.id, plugin: m.plugin, params: m.params as Record<string, unknown> };
    }
  }
}
