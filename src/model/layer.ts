// Layer (FL: Browser > Plugin database > Generators > Misc > Layer): a channel
// kind that makes no sound. The notes it plays (steps, piano roll, typing
// keyboard, preview keyboards, MIDI input) are passed on to its child channels,
// as if played on them. See docs/research/layer.md.
//
// FL stores a layer as a channel of type 3 with its children (one event per
// child channel, in the order "Set children" put them in) and the layer flags
// (Random, Crossfade; Sequential came with FL 20.7). The layer keeps the usual
// channel controls: header ON / PAN / VOL / PITCH, MISC levels adjustment
// (PAN, VOL, MOD X, MOD Y), root note / key region / fine tune.

import type { Channel, Id } from './types';
import { DEFAULT_KEY, KEY_MAX, KEY_MIN } from './notes';
import { defaultSampler, type SamplerSettings } from './sampler';

/** The crossfade wheel's range (FL's Layer_FadeWheel: 0..256, default 0). */
export const LAYER_FADE_MAX = 256;

/**
 * Colour of a new layer channel: FL's Plugin database entry Layer.fst
 * (RGB 64, 68, 71). Other new channels start with #5c656a.
 */
export const LAYER_COLOR = '#404447';

export interface LayerSettings {
  /**
   * Child channel ids in the order "Set children" stored them (the Channel
   * rack order, top to bottom, at that moment): Sequential's round-robin order
   * and the order the FADE wheel crossfades along. Never contains layers or
   * the layer itself; a channel is the child of one layer at most.
   */
  children: Id[];
  /** Random: one random child plays each note (off: every child plays). */
  random: boolean;
  /** Sequential: the children play in turn (round robin) in the stored order. */
  sequential: boolean;
  /** Crossfade: the FADE wheel crossfades between the children. */
  crossfade: boolean;
  /** FADE wheel 0..256: the crossfade position (0 = first child, 256 = last child). */
  fade: number;
}

/** A new layer's channel settings: the Sampler's defaults, "Enable main pitch" off (the children follow the main pitch themselves; FL's Layer.fst). */
export function defaultLayerSampler(): SamplerSettings {
  return { ...defaultSampler(null), mainPitch: false };
}

export function defaultLayer(): LayerSettings {
  return { children: [], random: false, sequential: false, crossfade: false, fade: 0 };
}

/** Repair stored layer settings (missing fields, duplicates, out-of-range values). */
export function normalizeLayer(raw: unknown): LayerSettings {
  const d = defaultLayer();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<LayerSettings>;
  const seen = new Set<string>();
  const children: Id[] = [];
  if (Array.isArray(r.children)) {
    for (const c of r.children) {
      if (typeof c !== 'string' || seen.has(c)) continue;
      seen.add(c);
      children.push(c);
    }
  }
  const fade = typeof r.fade === 'number' && Number.isFinite(r.fade) ? Math.min(LAYER_FADE_MAX, Math.max(0, Math.round(r.fade))) : d.fade;
  return { children, random: r.random === true, sequential: r.sequential === true, crossfade: r.crossfade === true, fade };
}

/**
 * The layer rules over a project's channels, in place: the children of a
 * layer exist, are not layers (nor the layer itself) and belong to one layer
 * only (the first layer, in rack order, that lists a channel keeps it).
 */
export function repairLayers(channels: Channel[]): void {
  const kindOf = new Map<Id, string>();
  for (const c of channels) kindOf.set(c.id, c.kind);
  const taken = new Set<Id>();
  for (const c of channels) {
    if (c.kind !== 'layer' || !c.layer) continue;
    c.layer.children = c.layer.children.filter((id) => {
      const k = kindOf.get(id);
      if (!k || k === 'layer' || id === c.id || taken.has(id)) return false;
      taken.add(id);
      return true;
    });
  }
}

/** The layer that lists channel `id` as a child, if any. */
export function layerOf(channels: readonly Channel[], id: Id): Channel | undefined {
  return channels.find((c) => c.kind === 'layer' && c.layer?.children.includes(id));
}

/** Take channels out of every layer's children (they were deleted, or became layers). `except` keeps one layer as it is. */
export function removeFromLayers(channels: Channel[], ids: Iterable<Id>, except?: Id): void {
  const gone = new Set(ids);
  if (!gone.size) return;
  for (const c of channels) {
    if (c.kind !== 'layer' || !c.layer || c.id === except) continue;
    if (c.layer.children.some((id) => gone.has(id))) c.layer.children = c.layer.children.filter((id) => !gone.has(id));
  }
}

/**
 * "Set children": the channels in `ids` (layers and the layer itself left out)
 * become the layer's children, in Channel rack order; they leave the layer
 * they belonged to. Channels that were children and are not in `ids` stop
 * being children (FL: "select the ones to keep and press the button again").
 * Returns the new children.
 */
export function setChildren(channels: Channel[], layerId: Id, ids: readonly Id[]): Id[] {
  const layer = channels.find((c) => c.id === layerId);
  if (!layer || layer.kind !== 'layer' || !layer.layer) return [];
  const want = new Set(ids);
  const list = channels.filter((c) => want.has(c.id) && c.kind !== 'layer').map((c) => c.id);
  removeFromLayers(channels, list, layerId);
  const cur = layer.layer.children;
  // an unchanged list is left alone (no edit to record)
  if (cur.length !== list.length || cur.some((id, i) => id !== list[i])) layer.layer.children = list;
  return list;
}

/**
 * "Split children": one child per key from the layer's root key up, in the
 * stored order. Each child plays only its key (key range) and gets that key as
 * its root key, so the key plays the child at its original pitch. Keys past
 * the top of the keyboard stay on the last key.
 */
export function splitChildren(channels: Channel[], layerId: Id): void {
  const layer = channels.find((c) => c.id === layerId);
  if (!layer || layer.kind !== 'layer' || !layer.layer) return;
  const root = layer.sampler.rootKey;
  layer.layer.children.forEach((id, i) => {
    const c = channels.find((x) => x.id === id);
    if (!c) return;
    const key = Math.max(KEY_MIN, Math.min(KEY_MAX, root + i));
    c.sampler.keyLo = key;
    c.sampler.keyHi = key;
    c.sampler.rootKey = key;
  });
}

/** "Reset children": the children's key range is the whole keyboard and their root key C5 again (undoes Split children). */
export function resetChildren(channels: Channel[], layerId: Id): void {
  const layer = channels.find((c) => c.id === layerId);
  if (!layer || layer.kind !== 'layer' || !layer.layer) return;
  for (const id of layer.layer.children) {
    const c = channels.find((x) => x.id === id);
    if (!c) continue;
    c.sampler.keyLo = KEY_MIN;
    c.sampler.keyHi = KEY_MAX;
    c.sampler.rootKey = DEFAULT_KEY;
  }
}

/**
 * Crossfade gain of child `index` of `count` at FADE position `fade` (0..256).
 * FL's manual: with three children the wheel sounds Child 1 > Child 1 + Child 2
 * > Child 2 > Child 2 + Child 3 > Child 3, the children ordered top to bottom:
 * child i is at full level where the wheel is at i / (count - 1) of its range
 * and fades out toward its neighbours. The law between neighbours is an
 * interpretation (FL does not document it): equal power, cos / sin of a
 * quarter circle, so a crossfade keeps its loudness (-3 dB each at the middle).
 */
export function crossfadeGain(index: number, count: number, fade: number): number {
  if (count <= 1) return 1;
  const pos = Math.min(1, Math.max(0, fade / LAYER_FADE_MAX)) * (count - 1);
  const d = Math.abs(pos - index);
  return d >= 1 ? 0 : Math.cos((d * Math.PI) / 2);
}
