// All project / UI mutations. UI components call these instead of touching the store.

import type { Draft } from 'immer';
import { store, host } from './index';
import type { Channel, Clip, FxSlot, Id, MixerTrack, Note, Pattern, Project } from '../model/types';
import type { SamplerSettings } from '../model/sampler';
import type { PEQ2Params } from '../model/peq2';
import { createChannel, createClone, createFxSlot, createGenChannel, createLayerChannel, createMidiOutChannel, createNote, createPattern, uid, DEFAULT_PATTERN_COLOR, mixerTrackName } from '../model/defaults';
import { defaultMidiOut, type MidiOutSettings } from '../model/midiout';
import { defaultLayer, removeFromLayers, resetChildren, setChildren, splitChildren, type LayerSettings } from '../model/layer';
import { ticksPerStep, ticksPerBar } from '../model/timing';
import { flashHint } from '../ui/hint';
import { fxDef, fxOutputs, fxParamDef } from '../model/fx/registry';
import { HOSTED_SEP, allFx, hostedModule, isGenSlot, splitHostedId } from '../model/fx/hosted';
import { defaultGenParams, genDef, genOutputs, genParamDef } from '../model/gen/registry';
import { GEN_PARAM_PATH, allGens, channelOfSlot, channelSlotId, genParamKeyOf } from '../model/gen/ids';
import { currentTick, live } from '../audio/live';
import type { UiState, WindowState } from './ui';
import {
  defaultClipRange, defaultLfo, envelopeValueOf, flatEnvelope, getPath, sameTarget, TEMPO_TARGET,
  type AutomationChannel, type AutomationTarget, type InitControl,
} from '../model/automation';
import type { ControllerLink, ControllerSourceInfo } from '../model/links';
import { CHANNEL_COLORS } from '../model/defaults';

type P = Draft<Project>;

const findChannel = (d: P, id: Id) => d.channels.find((c) => c.id === id);
const findPattern = (d: P, id: Id) => d.patterns.find((p) => p.id === id);

export function currentPattern(p: Project = store.project): Pattern {
  return p.patterns.find((x) => x.id === p.currentPatternId) ?? p.patterns[0];
}

// ------------------------------------------------------------------ globals
export function setTempo(bpm: number): void {
  const v = Math.round(Math.min(522, Math.max(10, bpm)) * 1000) / 1000;
  store.update('Tempo change', (d) => { d.tempo = v; }, { mergeKey: 'tempo' });
}

export function setGlobal<K extends 'swing' | 'mainVolume' | 'mainPitch'>(key: K, v: Project[K], label: string): void {
  store.update(label, (d) => { (d as Project)[key] = v; }, { mergeKey: key });
}

export function setSongMode(song: boolean): void {
  store.update(song ? 'Song mode' : 'Pattern mode', (d) => { d.songMode = song; }, { noHistory: true });
}

export function toggleSongMode(): void {
  setSongMode(!store.project.songMode);
  flashHint(store.project.songMode ? 'Song mode' : 'Pattern mode');
}

// ----------------------------------------------------------------- patterns
export function selectPattern(id: Id): void {
  store.update('Select pattern', (d) => { d.currentPatternId = id; }, { noHistory: true });
}

export function addPattern(): Id {
  const n = store.project.patterns.length + 1;
  const p = createPattern(n);
  store.update('New pattern', (d) => { d.patterns.push(p); d.currentPatternId = p.id; });
  return p.id;
}

export function clonePattern(id: Id): void {
  const src = store.project.patterns.find((p) => p.id === id);
  if (!src) return;
  const copy: Pattern = {
    ...createPattern(store.project.patterns.length + 1),
    name: src.name + ' #2',
    color: src.color,
    notes: Object.fromEntries(Object.entries(src.notes).map(([k, v]) => [k, v.map((n) => ({ ...n, id: uid('n') }))])),
  };
  store.update('Clone pattern', (d) => {
    const i = d.patterns.findIndex((p) => p.id === id);
    d.patterns.splice(i + 1, 0, copy);
    d.currentPatternId = copy.id;
  });
}

/** Clip menu "Make unique" on a pattern clip: the clip gets its own copy of the pattern. */
export function makePatternClipUnique(clipId: Id): void {
  const p = store.project;
  const clip = p.playlist.clips.find((c) => c.id === clipId);
  const src = clip ? p.patterns.find((x) => x.id === clip.patternId) : undefined;
  if (!clip || !src) return;
  const copy: Pattern = {
    ...structuredClone(src),
    ...createPattern(p.patterns.length + 1),
    name: src.name + ' #2',
    color: src.color,
    lengthSteps: src.lengthSteps,
    notes: Object.fromEntries(Object.entries(src.notes).map(([k, v]) => [k, v.map((n) => ({ ...n, id: uid('n') }))])),
  };
  store.update('Make unique', (d) => {
    const i = d.patterns.findIndex((x) => x.id === src.id);
    d.patterns.splice(i + 1, 0, copy);
    const c = d.playlist.clips.find((x) => x.id === clipId);
    if (c) c.patternId = copy.id;
    d.currentPatternId = copy.id;
  });
}

export function renamePattern(id: Id, name: string): void {
  store.update('Rename pattern', (d) => { const p = findPattern(d, id); if (p) p.name = name; });
}

export function setPatternLength(id: Id, steps: number): void {
  store.update('Pattern length', (d) => { const p = findPattern(d, id); if (p) p.lengthSteps = Math.max(0, Math.min(512, Math.round(steps))); }, { mergeKey: 'patlen:' + id });
}

export function setPatternColor(id: Id, color: string | null): void {
  store.update('Pattern color', (d) => { const p = findPattern(d, id); if (p) p.color = color; });
}

export function deletePattern(id: Id): void {
  if (store.project.patterns.length <= 1) return;
  store.update('Delete pattern', (d) => {
    const i = d.patterns.findIndex((p) => p.id === id);
    if (i < 0) return;
    d.patterns.splice(i, 1);
    d.playlist.clips = d.playlist.clips.filter((c) => c.patternId !== id);
    if (d.currentPatternId === id) d.currentPatternId = d.patterns[Math.max(0, i - 1)].id;
  });
}

export function patternColor(p: Pattern, index: number): string {
  void index;
  return p.color ?? DEFAULT_PATTERN_COLOR;
}

// ------------------------------------------------------------------ steps
/** Steps are zero-length notes on a step boundary. */
export function isStepNote(n: Note, tps: number): boolean {
  return n.len === 0 && n.pos % tps === 0 && !n.slide && !n.porta;
}

/**
 * Notes that can be shown as plain steps: every note is zero-length, on a step
 * boundary, without slide/porta, and at most one per step. Otherwise the rack
 * shows a piano-roll preview.
 */
export function channelIsStepOnly(notes: Note[] | undefined, tps: number): boolean {
  if (!notes) return true;
  const seen = new Set<number>();
  for (const n of notes) {
    if (!isStepNote(n, tps) || seen.has(n.pos)) return false;
    seen.add(n.pos);
  }
  return true;
}

export function setStep(channelId: Id, step: number, on: boolean, patternId = store.project.currentPatternId): void {
  const tps = ticksPerStep(store.project);
  const pos = step * tps;
  store.update('Step edit', (d) => {
    const pat = findPattern(d, patternId);
    if (!pat) return;
    const list = (pat.notes[channelId] ??= []);
    const idx = list.findIndex((n) => n.pos === pos && n.len === 0);
    if (on && idx < 0) {
      list.push(createNote({ pos, len: 0 }));
      list.sort((a, b) => a.pos - b.pos);
    } else if (!on && idx >= 0) {
      list.splice(idx, 1);
    }
  }, { mergeKey: undefined });
}

export function fillSteps(channelId: Id, every: number, steps: number): void {
  const tps = ticksPerStep(store.project);
  store.update(`Fill each ${every} steps`, (d) => {
    const pat = findPattern(d, d.currentPatternId);
    if (!pat) return;
    const list: Note[] = [];
    for (let s = 0; s < steps; s += every) list.push(createNote({ pos: s * tps, len: 0 }));
    pat.notes[channelId] = list;
  });
}

export function clearChannelNotes(channelId: Id): void {
  store.update('Clear', (d) => {
    const pat = findPattern(d, d.currentPatternId);
    if (pat) delete pat.notes[channelId];
  });
}

// ------------------------------------------------------------------ notes
export function setChannelNotes(patternId: Id, channelId: Id, notes: Note[], label: string, mergeKey?: string): void {
  store.update(label, (d) => {
    const pat = findPattern(d, patternId);
    if (!pat) return;
    const sorted = [...notes].sort((a, b) => a.pos - b.pos || a.key - b.key);
    if (sorted.length) pat.notes[channelId] = sorted as Note[];
    else delete pat.notes[channelId];
  }, { mergeKey });
}

// ---------------------------------------------------------------- channels
export function setChannel<K extends keyof Channel>(id: Id, key: K, v: Channel[K], label: string): void {
  store.update(label, (d) => {
    const c = findChannel(d, id);
    if (c) (c as Channel)[key] = v;
  }, { mergeKey: `ch:${id}:${String(key)}` });
}

export function setSampler(id: Id, label: string, recipe: (s: Draft<SamplerSettings>) => void): void {
  store.update(label, (d) => {
    const c = findChannel(d, id);
    if (c) recipe(c.sampler);
  }, { mergeKey: `smp:${id}:${label}` });
}

export function addChannel(name: string, sampleId: Id | null, at?: number): Id {
  const c = createChannel(name, sampleId);
  store.update('Add channel', (d) => {
    const i = at ?? d.channels.length;
    d.channels.splice(i, 0, c);
  });
  store.updateUi((u) => { u.selectedChannels = [c.id]; });
  return c.id;
}

/** Name for a new channel of a plugin: "MIDI Out", then "MIDI Out #2", ... */
function uniqueChannelName(base: string): string {
  const names = new Set(store.project.channels.map((c) => c.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} #${i}`)) return `${base} #${i}`;
}

/** Add a MIDI Out channel (FL: Generators > MIDI > MIDI Out): no sound, its notes go out on its port. */
export function addMidiOutChannel(at?: number): Id {
  const c = createMidiOutChannel(uniqueChannelName('MIDI Out'));
  store.update('Add channel', (d) => {
    const i = at ?? d.channels.length;
    d.channels.splice(i, 0, c);
  });
  store.updateUi((u) => { u.selectedChannels = [c.id]; });
  return c.id;
}

/** Add a Layer channel (FL: Generators > Misc > Layer): no sound, its notes play its children. */
export function addLayerChannel(at?: number): Id {
  const c = createLayerChannel(uniqueChannelName('Layer'));
  store.update('Add channel', (d) => {
    const i = at ?? d.channels.length;
    d.channels.splice(i, 0, c);
  });
  store.updateUi((u) => { u.selectedChannels = [c.id]; });
  return c.id;
}

/**
 * A generator choice of the Channel rack's add / Replace / Insert menus and
 * the Browser's Plugin database > Generators: the Sampler, MIDI Out, a Layer
 * or an instrument plugin.
 */
export type GeneratorChoice = { kind: 'sampler' } | { kind: 'midiout' } | { kind: 'layer' } | { kind: 'plugin'; id: string };

/** Add an instrument plugin channel (FL: a generator from the plugin database), named after the plugin. */
export function addGenChannel(pluginId: string, at?: number): Id {
  const c = createGenChannel(pluginId, uniqueChannelName(genDef(pluginId)?.name ?? pluginId));
  store.update('Add channel', (d) => {
    const i = at ?? d.channels.length;
    d.channels.splice(i, 0, c);
  });
  store.updateUi((u) => { u.selectedChannels = [c.id]; });
  return c.id;
}

/** Add a channel with a generator (Sampler, MIDI Out, Layer or an instrument plugin) at `at` (default: the end). */
export function addGenerator(g: GeneratorChoice, at?: number): Id {
  if (g.kind === 'plugin') return addGenChannel(g.id, at);
  if (g.kind === 'midiout') return addMidiOutChannel(at);
  if (g.kind === 'layer') return addLayerChannel(at);
  return addChannel(uniqueChannelName('Sampler'), null, at);
}

/** Channel button menu > Insert: a new channel with the generator right below this one. */
export function insertGenerator(afterId: Id, g: GeneratorChoice): Id {
  const i = store.project.channels.findIndex((c) => c.id === afterId);
  return addGenerator(g, i < 0 ? undefined : i + 1);
}

/** A channel's links that belong to its generator: its instrument parameters (also those of modules hosted in its Patcher; and a layer's FADE) as targets and its controller outputs as sources. */
function dropGeneratorLinks(d: P, channelId: Id): void {
  if (!d.links?.length) return;
  const src = channelSlotId(channelId);
  d.links = d.links.filter((l) => l.source?.slotId !== src && !(l.target.scope === 'channel' && l.target.id === channelId && (l.target.path.startsWith(GEN_PARAM_PATH) || l.target.path.startsWith('layer.'))));
}

/**
 * Channel button menu > Replace: the channel gets another generator. It keeps
 * its notes, mixer routing and channel settings, takes the generator's name and
 * loses its old plugin's state (and the links and automation targets of it).
 */
export function replaceGenerator(channelId: Id, g: GeneratorChoice): void {
  const old = store.project.channels.find((c) => c.id === channelId);
  if (!old) return;
  const name = g.kind === 'plugin' ? genDef(g.id)?.name ?? g.id : g.kind === 'midiout' ? 'MIDI Out' : g.kind === 'layer' ? 'Layer' : 'Sampler';
  const others = new Set(store.project.channels.filter((c) => c.id !== channelId).map((c) => c.name));
  let unique = name;
  for (let k = 2; others.has(unique); k++) unique = `${name} #${k}`;
  store.update('Replace generator', (d) => {
    const c = findChannel(d, channelId);
    if (!c) return;
    dropGeneratorLinks(d, channelId);
    c.name = unique;
    delete c.midiOut;
    delete c.plugin;
    delete c.layer; // a layer replaced by another generator lets its children go
    if (g.kind === 'plugin') {
      c.kind = 'plugin';
      c.plugin = { id: g.id, params: defaultGenParams(g.id) } as Draft<Channel['plugin']> & object;
      const poly = genDef(g.id)?.defPoly;
      if (poly) c.sampler.polyMax = poly;
    } else if (g.kind === 'midiout') {
      c.kind = 'midiout';
      c.midiOut = defaultMidiOut() as Draft<MidiOutSettings>;
    } else if (g.kind === 'layer') {
      // a layer is nobody's child ("not another Layer channel"); the channel keeps its levels and settings
      c.kind = 'layer';
      c.layer = defaultLayer() as Draft<LayerSettings>;
      removeFromLayers(d.channels as Channel[], [channelId]);
    } else {
      // an empty Sampler (the channel's INS / MISC settings stay)
      c.kind = 'sampler';
      c.sampler.sampleId = null;
    }
  });
}

/** A channel's instrument MIDI input port (-1 = none): MIDI Out notes on it play the instrument. */
export function setGenMidiPort(channelId: Id, port: number): void {
  const v = port >= 0 ? Math.min(255, Math.round(port)) : -1;
  store.update('MIDI input port', (d) => {
    const c = findChannel(d, channelId);
    if (!c?.plugin) return;
    if (v >= 0) c.plugin.midiPort = v; else delete c.plugin.midiPort;
  }, { mergeKey: `genport:${channelId}` });
}

/** Edit a MIDI Out channel's settings (consecutive edits with the same label merge into one undo step). */
export function setMidiOut(id: Id, label: string, recipe: (s: Draft<MidiOutSettings>) => void, mergeKey?: string): void {
  store.update(label, (d) => {
    const c = findChannel(d, id);
    if (c?.midiOut) recipe(c.midiOut);
  }, { mergeKey: mergeKey ?? `mo:${id}:${label}` });
}

/** An effect slot's MIDI input port (the wrapper's "Input port"; -1 = none). */
export function setFxMidiPort(slotId: Id, port: number): void {
  const loc = findFx(store.project, slotId);
  if (!loc) return;
  const v = port >= 0 ? Math.min(255, Math.round(port)) : -1;
  store.update('MIDI input port', (d) => {
    const s = d.mixer.tracks[loc.track]?.slots[loc.slot];
    if (!s) return;
    if (v >= 0) s.midiPort = v; else delete s.midiPort;
  }, { mergeKey: `fxport:${slotId}` });
}

/**
 * "No input port set (click to auto assign)": the port of the selected MIDI Out
 * channel, else of the first MIDI Out channel, else the lowest port no effect
 * listens on yet.
 */
export function autoMidiPort(p: Project = store.project): number {
  const outs = p.channels.filter((c) => c.kind === 'midiout' && c.midiOut);
  const sel = outs.find((c) => store.ui.selectedChannels.includes(c.id));
  if (sel?.midiOut) return sel.midiOut.port;
  if (outs[0]?.midiOut) return outs[0].midiOut.port;
  const used = new Set<number>();
  for (const t of p.mixer.tracks) for (const s of t.slots) if (s && typeof s.midiPort === 'number') used.add(s.midiPort);
  for (let k = 0; k <= 255; k++) if (!used.has(k)) return k;
  return 0;
}

/**
 * Clone a channel with its notes, right below it. FL clones a layer's children
 * with it (the copy plays the copies, which follow it in the rack, in the same
 * order): a channel is the child of one layer only, and undoing the clone
 * removes the copies too.
 */
export function cloneChannel(id: Id): void {
  const src = store.project.channels.find((c) => c.id === id);
  if (!src) return;
  const copy = createClone(src);
  const kids = (src.layer?.children ?? [])
    .map((k) => store.project.channels.find((c) => c.id === k))
    .filter((c): c is Channel => !!c && c.kind !== 'layer')
    .map((c) => ({ from: c.id, copy: createClone(c) }));
  if (copy.layer) copy.layer.children = kids.map((k) => k.copy.id);
  store.update('Clone channel', (d) => {
    const i = d.channels.findIndex((c) => c.id === id);
    d.channels.splice(i + 1, 0, copy, ...kids.map((k) => k.copy));
    for (const p of d.patterns) {
      for (const [from, to] of [[id, copy.id], ...kids.map((k) => [k.from, k.copy.id])]) {
        const notes = p.notes[from];
        if (notes) p.notes[to] = notes.map((n) => ({ ...n, id: uid('n') }));
      }
    }
  });
}

// ------------------------------------------------------------------ layers
/** Edit a layer's settings (Random / Sequential / Crossfade / FADE); consecutive edits with the same label merge into one undo step. */
export function setLayer(id: Id, label: string, recipe: (l: Draft<LayerSettings>) => void, mergeKey?: string): void {
  store.update(label, (d) => {
    const c = findChannel(d, id);
    if (c?.layer) recipe(c.layer);
  }, { mergeKey: mergeKey ?? `layer:${id}:${label}` });
}

/**
 * Layering > Set children: the selected channels (the Channel rack's selection;
 * layers and the layer itself left out) become the layer's children, in rack
 * order; they leave the layer they belonged to. "To remove channels, select
 * the ones to keep and press the button again" (the rest stop being children).
 */
export function setLayerChildren(layerId: Id, ids: readonly Id[] = store.ui.selectedChannels): Id[] {
  let out: Id[] = [];
  store.update('Set children', (d) => { out = setChildren(d.channels as Channel[], layerId, ids); });
  return out;
}

/**
 * Layering > Show children: select the layer's children in the Channel rack and
 * nothing else; the rack is shown if it is hidden (FL 25: "Show children"
 * brings the Channel rack up).
 */
export function showLayerChildren(layerId: Id): void {
  const l = store.project.channels.find((c) => c.id === layerId);
  if (!l?.layer) return;
  const ids = [...l.layer.children];
  store.updateUi((u) => { u.selectedChannels = ids; });
  const rack = store.ui.windows['channelRack'];
  if (!rack || !rack.open || rack.minimized) openWindow('channelRack');
}

/**
 * Hold Shift while dropping a file on a layer (FL 2024): the sample becomes a
 * new Sampler channel that is a child of the layer, in the rack right below the
 * layer's last child (or below the layer).
 */
export function addLayerChild(layerId: Id, name: string, sampleId: Id | null): Id | null {
  const layer = store.project.channels.find((c) => c.id === layerId);
  if (!layer?.layer) return null;
  const c = createChannel(name, sampleId);
  store.update('Add child channel', (d) => {
    const l = findChannel(d, layerId);
    if (!l?.layer) return;
    let at = -1;
    for (const k of l.layer.children) at = Math.max(at, d.channels.findIndex((x) => x.id === k));
    if (at < 0) at = d.channels.findIndex((x) => x.id === layerId);
    d.channels.splice(at + 1, 0, c as Draft<Channel>);
    l.layer.children.push(c.id);
  });
  store.updateUi((u) => { u.selectedChannels = [c.id]; });
  return c.id;
}

/** Layering menu > Split children: one child per key from the layer's root key, each with that key as range and root key. */
export function splitLayerChildren(layerId: Id): void {
  store.update('Split children', (d) => splitChildren(d.channels as Channel[], layerId));
}

/** Layering menu > Reset children: key range and root key of every child back to the defaults (undoes Split children). */
export function resetLayerChildren(layerId: Id): void {
  store.update('Reset children', (d) => resetChildren(d.channels as Channel[], layerId));
}

/** Layering menu > Group children...: every child joins the channel filter group `name`. */
export function groupLayerChildren(layerId: Id, name: string): void {
  const n = name.trim();
  if (!n) return;
  store.update('Group children', (d) => {
    const l = findChannel(d, layerId);
    if (!l?.layer) return;
    for (const id of l.layer.children) {
      const c = findChannel(d, id);
      if (c) c.filterGroup = n;
    }
  });
}

/** Layering menu > Delete children...: delete all the layer's children channels. */
export function deleteLayerChildren(layerId: Id): void {
  const l = store.project.channels.find((c) => c.id === layerId);
  if (l?.layer?.children.length) deleteChannels([...l.layer.children]);
}

/** Channel rack menu > Create layer with selected channels: a new layer (at the end of the rack) with them as children. */
export function createLayerWithSelected(ids: readonly Id[] = store.ui.selectedChannels): Id {
  const c = createLayerChannel(uniqueChannelName('Layer'));
  store.update('Create layer', (d) => {
    d.channels.push(c as Draft<Channel>);
    setChildren(d.channels as Channel[], c.id, ids);
  });
  store.updateUi((u) => { u.selectedChannels = [c.id]; });
  return c.id;
}

export function deleteChannels(ids: Id[]): void {
  if (!ids.length) return;
  store.update(ids.length > 1 ? 'Delete channels' : 'Delete channel', (d) => {
    d.channels = d.channels.filter((c) => !ids.includes(c.id));
    removeFromLayers(d.channels as Channel[], ids); // a deleted child leaves its layer
    for (const p of d.patterns) for (const id of ids) delete p.notes[id];
    if (d.links?.length) {
      const srcs = new Set(ids.map(channelSlotId));
      d.links = d.links.filter((l) => !(l.target.scope === 'channel' && ids.includes(l.target.id)) && !(l.source && srcs.has(l.source.slotId)));
    }
  });
  store.updateUi((u) => {
    u.selectedChannels = u.selectedChannels.filter((x) => !ids.includes(x));
    if (u.pianoRoll.channelId && ids.includes(u.pianoRoll.channelId)) u.pianoRoll.channelId = null;
    for (const id of ids) delete u.windows['chan:' + id];
  });
}

export function moveChannels(ids: Id[], dir: -1 | 1): void {
  store.update('Move channel', (d) => {
    const order = d.channels.map((c) => c.id);
    const sel = new Set(ids);
    const idxs = order.map((id, i) => (sel.has(id) ? i : -1)).filter((i) => i >= 0);
    if (dir < 0 && idxs[0] === 0) return;
    if (dir > 0 && idxs[idxs.length - 1] === order.length - 1) return;
    const arr = [...d.channels];
    if (dir < 0) for (const i of idxs) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    else for (const i of [...idxs].reverse()) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
    d.channels = arr;
  });
}

export function toggleChannelEnabled(id: Id): void {
  const c = store.project.channels.find((x) => x.id === id);
  if (c) setChannel(id, 'enabled', !c.enabled, 'Channel mute');
}

/** Solo: enable only this channel; soloing an already-solo channel re-enables all. */
export function soloChannel(id: Id): void {
  const p = store.project;
  const isSolo = p.channels.every((c) => (c.id === id ? c.enabled : !c.enabled));
  store.update('Channel solo', (d) => {
    for (const c of d.channels) c.enabled = isSolo ? true : c.id === id;
  });
}

export function selectChannel(id: Id, mode: 'only' | 'toggle' | 'range' = 'only'): void {
  store.updateUi((u) => {
    if (mode === 'only') u.selectedChannels = [id];
    else if (mode === 'toggle') {
      u.selectedChannels = u.selectedChannels.includes(id) ? u.selectedChannels.filter((x) => x !== id) : [...u.selectedChannels, id];
    } else {
      const order = store.project.channels.map((c) => c.id);
      const last = u.selectedChannels[u.selectedChannels.length - 1];
      const a = order.indexOf(last), b = order.indexOf(id);
      if (a < 0) u.selectedChannels = [id];
      else {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        u.selectedChannels = order.slice(lo, hi + 1);
      }
    }
  });
}

// ---------------------------------------------------------------- playlist
export function addClip(track: number, patternId: Id, start: number, length?: number): Id {
  const p = store.project;
  const pat = p.patterns.find((x) => x.id === patternId);
  const len = length ?? patternLength(pat, p);
  const clip: Clip = { id: uid('k'), track, kind: 'pattern', patternId, start, length: len, offset: 0, muted: false };
  store.update('Add clip', (d) => { d.playlist.clips.push(clip); });
  return clip.id;
}

export function updateClips(label: string, recipe: (clips: Draft<Clip>[]) => void, mergeKey?: string): void {
  store.update(label, (d) => recipe(d.playlist.clips), { mergeKey });
}

export function deleteClips(ids: Id[]): void {
  store.update('Delete clips', (d) => { d.playlist.clips = d.playlist.clips.filter((c) => !ids.includes(c.id)); });
}

export function setPlaylistTrack<K extends keyof Project['playlist']['tracks'][number]>(index: number, key: K, v: Project['playlist']['tracks'][number][K], label: string): void {
  store.update(label, (d) => { const t = d.playlist.tracks[index]; if (t) t[key] = v as never; });
}

/** Pattern length in ticks (whole bars, >= 1 bar), computed from its notes. */
export function patternLength(pat: Pattern | undefined, p: Project = store.project): number {
  const bar = ticksPerBar(p);
  if (!pat) return bar;
  if (pat.lengthSteps && pat.lengthSteps > 0) return pat.lengthSteps * ticksPerStep(p);
  let end = 0;
  // a note's end counts at least one tick, so zero-length steps still occupy their bar
  for (const list of Object.values(pat.notes)) for (const n of list) end = Math.max(end, n.pos + Math.max(n.len, 1));
  return Math.max(bar, Math.ceil(end / bar - 1e-9) * bar);
}

// ------------------------------------------------------------------- mixer
export function setMixer<K extends keyof MixerTrack>(index: number, key: K, v: MixerTrack[K], label: string): void {
  store.update(label, (d) => {
    const t = d.mixer.tracks[index];
    if (t) (t as MixerTrack)[key] = v;
  }, { mergeKey: `mx:${index}:${String(key)}` });
}

export function setSend(from: number, to: number, level: number | null): void {
  store.update(level === null ? 'Remove route' : 'Route', (d) => {
    const t = d.mixer.tracks[from];
    if (!t) return;
    if (level === null) delete t.sends[to];
    else t.sends[to] = level;
  }, { mergeKey: `send:${from}:${to}` });
}

/** Would routing from -> to create a cycle? */
export function routeCreatesCycle(p: Project, from: number, to: number): boolean {
  if (to === 0) return false;
  if (from === to) return true;
  const seen = new Set<number>();
  const stack = [to];
  while (stack.length) {
    const i = stack.pop()!;
    if (i === from) return true;
    if (seen.has(i)) continue;
    seen.add(i);
    for (const k of Object.keys(p.mixer.tracks[i]?.sends ?? {})) stack.push(Number(k));
  }
  return false;
}

export function addFx(track: number, slot: number, plugin = 'peq2'): Id {
  const fx = createFxSlot(plugin);
  store.update('Add effect', (d) => {
    const t = d.mixer.tracks[track];
    const old = t?.slots[slot];
    if (old) dropSlotLinks(d, old.id);
    if (t) t.slots[slot] = fx as FxSlot;
  });
  return fx.id;
}

/** A removed plugin takes its controller links (as source or as target) with it. */
function dropSlotLinks(d: P, slotId: Id): void {
  if (!d.links?.length) return;
  d.links = d.links.filter((l) => l.source?.slotId !== slotId && !(l.target.scope === 'fx' && l.target.id === slotId));
}

/** Load a plugin into a slot (replacing what is there), open its editor. */
export function loadFx(track: number, slot: number, plugin: string): Id {
  const old = store.project.mixer.tracks[track]?.slots[slot];
  if (old) store.updateUi((u) => { delete u.windows['fx:' + old.id]; });
  const id = addFx(track, slot, plugin);
  const t = store.project.mixer.tracks[track];
  const name = store.project.mixer.tracks[track]?.slots[slot]?.name ?? plugin;
  if (t) openFxWindow(id, `${name} (${mixerTrackName(t)})`);
  return id;
}

/** Set one plugin parameter (consecutive tweaks of the same parameter merge into one undo step). */
export function setFxParam(slotId: Id, key: string, value: unknown, label?: string): void {
  const loc = findFx(store.project, slotId);
  if (!loc) return;
  const name = label ?? pluginParamDef(slotId, loc.fx.plugin, key)?.name ?? key;
  store.update(name, (d) => {
    const ps = slotParamsDraft(d, loc);
    if (ps) ps[key] = value;
  }, { mergeKey: `fxp:${slotId}:${key}` });
}

/** Edit a plugin's state with a recipe (discrete edits: menus, buttons, editors). */
export function editFx(slotId: Id, label: string, recipe: (p: Draft<Record<string, unknown>>) => void, mergeKey?: string): void {
  const loc = findFx(store.project, slotId);
  if (!loc) return;
  store.update(label, (d) => {
    const ps = slotParamsDraft(d, loc);
    if (ps) recipe(ps);
  }, mergeKey ? { mergeKey } : undefined);
}

/** Replace a plugin's state without an undo entry (auditions, transient displays). */
export function setFxStateNoHistory(slotId: Id, label: string, recipe: (p: Draft<Record<string, unknown>>) => void): void {
  const loc = findFx(store.project, slotId);
  if (!loc) return;
  store.update(label, (d) => {
    const ps = slotParamsDraft(d, loc);
    if (ps) recipe(ps);
  }, { noHistory: true });
}

export function removeFx(track: number, slot: number): void {
  const id = store.project.mixer.tracks[track]?.slots[slot]?.id;
  store.update('Remove effect', (d) => {
    const t = d.mixer.tracks[track];
    if (id) dropSlotLinks(d, id);
    if (t) t.slots[slot] = null;
  });
  if (id) store.updateUi((u) => { delete u.windows['fx:' + id]; });
}

export function setFx(track: number, slot: number, label: string, recipe: (s: Draft<FxSlot>) => void, mergeKey?: string): void {
  store.update(label, (d) => {
    const s = d.mixer.tracks[track]?.slots[slot];
    if (s) recipe(s);
  }, { mergeKey: mergeKey ?? `fx:${track}:${slot}:${label}` });
}

export function setPeq2(track: number, slot: number, label: string, recipe: (p: Draft<PEQ2Params>) => void, mergeKey?: string): void {
  setFx(track, slot, label, (s) => recipe(s.params as unknown as Draft<PEQ2Params>), mergeKey);
}

/** A plugin parameter's definition: an instrument's ("ch:<channel id>", or a generator hosted in Patcher) or an effect's. */
export function pluginParamDef(slotId: Id, plugin: string, key: string) {
  return isGenSlot(slotId) ? genParamDef(plugin, key) : fxParamDef(plugin, key);
}

/**
 * Hosted plugin instances (effect modules inside Patcher) are addressed as
 * "<slot id>#<module id>"; their state lives at params.$graph.modules[id].params
 * of the host slot. Every slot action below accepts these ids, so editors and
 * their helpers work the same inside Patcher.
 */
export { HOSTED_SEP, splitHostedId, allFx, allGens, channelOfSlot, channelSlotId };

/**
 * Where plugin `slotId` lives: a mixer slot, a module hosted in Patcher
 * ("<slot>#<module>", `hosted`), or a channel's instrument plugin ("ch:<channel
 * id>", `channel`; slot -1, track = the channel's mixer track). A module hosted
 * in a channel's Patcher ("ch:<channel id>#<module>") has both `hosted` and
 * `channel`. `fx` describes it as a slot (plugin id, name, enabled, params)
 * either way.
 */
export function findFx(p: Project, slotId: Id): { track: number; slot: number; fx: FxSlot; hosted?: { slotId: Id; moduleId: string }; channel?: Id } | null {
  const chId = channelOfSlot(slotId);
  if (chId !== null) {
    const c = p.channels.find((x) => x.id === chId);
    if (!c || c.kind !== 'plugin' || !c.plugin) return null;
    return {
      track: c.mixerTrack, slot: -1, channel: chId,
      fx: { id: slotId, plugin: c.plugin.id, name: genDef(c.plugin.id)?.name ?? c.plugin.id, enabled: c.enabled, mix: 1, params: c.plugin.params },
    };
  }
  const h = splitHostedId(slotId);
  if (h) {
    const host = findFx(p, h.slotId);
    const m = host ? hostedModule(host.fx.params, h.moduleId) : undefined;
    if (!host || !m) return null;
    return {
      track: host.track, slot: host.slot, hosted: h, ...(host.channel !== undefined ? { channel: host.channel } : {}),
      fx: { id: slotId, plugin: m.plugin, name: m.name ?? m.plugin, enabled: host.fx.enabled, mix: 1, params: m.params },
    };
  }
  for (const t of p.mixer.tracks) {
    const i = t.slots.findIndex((s) => s?.id === slotId);
    if (i >= 0) return { track: t.index, slot: i, fx: t.slots[i]! };
  }
  return null;
}

/** The writable params of a slot, of a hosted module or of a channel's instrument, inside a draft. */
function slotParamsDraft(d: Draft<Project>, loc: { track: number; slot: number; hosted?: { moduleId: string }; channel?: Id }): Draft<Record<string, unknown>> | undefined {
  if (loc.channel !== undefined) {
    const params = findChannel(d, loc.channel)?.plugin?.params as Draft<Record<string, unknown>> | undefined;
    // a module hosted in the channel's Patcher
    return loc.hosted ? hostedModule(params, loc.hosted.moduleId)?.params as Draft<Record<string, unknown>> | undefined : params;
  }
  const s = d.mixer.tracks[loc.track]?.slots[loc.slot];
  if (!s) return undefined;
  if (!loc.hosted) return s.params as Draft<Record<string, unknown>>;
  return hostedModule(s.params, loc.hosted.moduleId)?.params as Draft<Record<string, unknown>> | undefined;
}

/**
 * The writable state of effect `slotId` (a slot's params, or a module's hosted
 * in Patcher for "<slot>#<module>") inside a store recipe.
 */
export function fxParamsDraft(d: Draft<Project>, slotId: Id): Draft<Record<string, unknown>> | undefined {
  const loc = findFx(d as Project, slotId);
  return loc ? slotParamsDraft(d, loc) : undefined;
}

// ------------------------------------------------------------------ windows
export function openWindow(id: string, init?: Partial<WindowState>): void {
  store.updateUi((u) => {
    const w = u.windows[id];
    u.zTop += 1;
    if (w) {
      w.open = true;
      w.minimized = false;
      w.z = u.zTop;
      if (init?.title) w.title = init.title;
    } else {
      u.windows[id] = {
        id, title: init?.title ?? id, open: true, x: init?.x ?? 160, y: init?.y ?? 80, w: init?.w ?? 500, h: init?.h ?? 360,
        z: u.zTop, maximized: false, minimized: false,
      };
    }
    u.focused = id;
  });
}

export function closeWindow(id: string): void {
  store.updateUi((u) => {
    const w = u.windows[id];
    if (w) w.open = false;
    if (u.focused === id) u.focused = null;
  });
}

export function toggleWindow(id: string): void {
  const w = store.ui.windows[id];
  if (w && w.open && !w.minimized && store.ui.focused === id) closeWindow(id);
  else openWindow(id);
}

export function focusWindow(id: string): void {
  if (store.ui.focused === id && store.ui.windows[id]?.z === store.ui.zTop) return;
  store.updateUi((u) => {
    const w = u.windows[id];
    if (!w) return;
    u.zTop += 1;
    w.z = u.zTop;
    u.focused = id;
  });
}

export function updateWindow(id: string, patch: Partial<WindowState>): void {
  store.updateUi((u) => {
    const w = u.windows[id];
    if (w) Object.assign(w, patch);
  });
}

export function setUi(recipe: (u: Draft<UiState>) => void): void {
  store.updateUi(recipe);
}

export function openPianoRoll(channelId: Id): void {
  store.updateUi((u) => {
    u.pianoRoll.channelId = channelId;
    u.selectedChannels = [channelId];
    u.pianoRoll.selected = [];
  });
  openWindow('pianoRoll');
}

export function openChannelSettings(channelId: Id): void {
  const c = store.project.channels.find((x) => x.id === channelId);
  const id = 'chan:' + channelId;
  const existing = store.ui.windows[id];
  if (existing?.open && store.ui.focused === id) { closeWindow(id); return; }
  const n = Object.keys(store.ui.windows).filter((k) => k.startsWith('chan:')).length;
  openWindow(id, { title: c?.name ?? 'Channel', x: 220 + (n % 6) * 24, y: 70 + (n % 6) * 24, w: 520, h: 470 });
}

export function openFxWindow(slotId: Id, title: string): void {
  const id = 'fx:' + slotId;
  const loc = findFx(store.project, slotId);
  const d = loc ? fxDef(loc.fx.plugin) : undefined;
  // window chrome: 1 px border each side, 24 px title bar
  const w = d && d.id !== 'peq2' ? d.width + 2 : 700;
  const h = d && d.id !== 'peq2' ? d.height + 26 : 460;
  openWindow(id, { title, x: 260, y: 90, w, h });
}

// ---------------------------------------------------------------- transport
/** Space: play / stop (stop returns to where playback started). */
export async function togglePlay(): Promise<void> {
  if (live.playing) host.stop();
  else await host.play();
}

/** Play button / Ctrl+Space: play / pause. */
export async function togglePause(): Promise<void> {
  await host.togglePause();
}

export function undo(): void {
  const label = store.undo();
  flashHint(label ? `Undo: ${label}` : 'Nothing to undo');
}

export function redo(): void {
  const label = store.redo();
  flashHint(label ? `Redo: ${label}` : 'Nothing to redo');
}

// ------------------------------------------------------------ mixer extras
export function selectMixerTrack(i: number): void {
  if (store.ui.mixerSelected === i) return;
  store.updateUi((u) => { u.mixerSelected = i; });
  host.send({ t: 'mixerSelect', index: i });
}

function downstream(p: Project, i: number, out: Set<number>): void {
  for (const k of Object.keys(p.mixer.tracks[i]?.sends ?? {})) {
    const t = Number(k);
    if (!out.has(t)) { out.add(t); downstream(p, t, out); }
  }
}

function upstream(p: Project, i: number, out: Set<number>): void {
  for (const t of p.mixer.tracks) {
    if (t.sends[i] !== undefined && !out.has(t.index)) { out.add(t.index); upstream(p, t.index, out); }
  }
}

/** Exclusive solo implemented by muting: keeps master and the track's destinations (and sources for alt-solo). */
export function soloMixer(i: number, alt = false): void {
  const p = store.project;
  const keep = new Set<number>([0, i]);
  downstream(p, i, keep);
  if (alt) upstream(p, i, keep);
  const isSolo = p.mixer.tracks.every((t) => (keep.has(t.index) ? t.enabled : !t.enabled || t.index === 0));
  store.update(alt ? 'Alt solo' : 'Solo', (d) => {
    for (const t of d.mixer.tracks) {
      if (t.index === 0) continue;
      t.enabled = isSolo ? true : keep.has(t.index);
    }
  });
}

export function unmuteAllMixer(): void {
  store.update('Unmute all', (d) => { for (const t of d.mixer.tracks) t.enabled = true; });
}

export function moveFx(track: number, from: number, to: number): void {
  if (to < 0 || to > 9 || from === to) return;
  store.update('Move effect', (d) => {
    const s = d.mixer.tracks[track]?.slots;
    if (!s) return;
    const tmp = s[to];
    s[to] = s[from];
    s[from] = tmp;
  });
}

export function setMixerEq(track: number, band: number, key: 'gain' | 'freq' | 'width', v: number): void {
  store.update('Mixer EQ', (d) => {
    const b = d.mixer.tracks[track]?.eq[band];
    if (b) b[key] = v;
  }, { mergeKey: `eq:${track}:${band}:${key}` });
}

/** Ctrl+L in the mixer: route the selected channels to this track. */
export function routeSelectedChannelsTo(track: number): void {
  const ids = store.ui.selectedChannels;
  if (!ids.length) return;
  store.update('Route channels', (d) => {
    for (const c of d.channels) if (ids.includes(c.id) && c.kind !== 'layer') c.mixerTrack = track; // a layer makes no sound: no track
  });
}

/** Ctrl+L in the channel rack: route selected channels to free inserts, naming them. */
export function assignChannelsToFreeTracks(): void {
  const p = store.project;
  const ids = store.ui.selectedChannels.length ? store.ui.selectedChannels : [];
  if (!ids.length) return;
  store.update('Assign to free mixer tracks', (d) => {
    const used = new Set(d.channels.map((c) => c.mixerTrack));
    let next = 1;
    for (const c of d.channels) {
      if (!ids.includes(c.id) || c.kind === 'layer') continue; // a layer makes no sound: no track
      while (next <= 125 && (used.has(next) || d.mixer.tracks[next].name || d.mixer.tracks[next].slots.some(Boolean))) next++;
      if (next > 125) break;
      c.mixerTrack = next;
      used.add(next);
      if (!d.mixer.tracks[next].name) d.mixer.tracks[next].name = c.name;
      next++;
    }
  });
  void p;
}

// -------------------------------------------------------------- automation
/** Read a target's current model value from the project. */
export function readTarget(p: Project, t: AutomationTarget): number | null {
  const obj = targetObject(p, t);
  const v = obj ? getPath(obj, t.path) : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' ? v : null;
}

/** The object a target's path is relative to (works on drafts too). */
export function targetObject(p: Project | Draft<Project>, t: AutomationTarget): unknown {
  switch (t.scope) {
    case 'channel': return p.channels.find((c) => c.id === t.id);
    case 'mixer': return p.mixer.tracks[Number(t.id)];
    case 'fx': {
      for (const tr of p.mixer.tracks) for (const s of tr.slots) if (s && s.id === t.id) return s;
      return undefined;
    }
    case 'global': return p;
  }
}

/**
 * Track for a new automation clip: the highest empty track from the top of the
 * Playlist view down; else the first track free over the clip's time range.
 */
function firstFreeTrack(p: Project, from: number, to: number): number {
  const top = Math.max(0, Math.floor(store.ui.playlist.scrollTrack));
  const n = p.playlist.tracks.length;
  const usedAt = new Set(p.playlist.clips.map((c) => c.track));
  for (let i = top; i < n; i++) if (!usedAt.has(i)) return i;
  const used = new Set(p.playlist.clips.filter((c) => c.start < to && c.start + c.length > from).map((c) => c.track));
  for (let i = top; i < n; i++) if (!used.has(i)) return i;
  for (let i = 0; i < top; i++) if (!used.has(i)) return i;
  return top;
}

/** FL's parameter names of channel and mixer track controls in clip names. */
const CHANNEL_PARAM_NAMES: Record<string, string> = { volume: 'Channel volume', pan: 'Channel panning', pitch: 'Channel pitch', 'layer.fade': 'Crossfade level' };
const MIXER_PARAM_NAMES: Record<string, string> = { volume: 'Volume', pan: 'Panning', stereoSep: 'Stereo separation' };

/**
 * FL's display name of an automation target: its owner, then the parameter
 * ("Kick - Channel volume", "Insert 2 - Volume", "Insert 1 - To Master",
 * "<effect> - <mixer track> - <parameter>", "Tempo", "Master pitch").
 */
export function automationName(p: Project, t: AutomationTarget): string {
  // the parameter part of a control label ("Kick - Panning" -> "Panning")
  const param = (label: string) => { const k = label.lastIndexOf(' - '); return k < 0 ? label : label.slice(k + 3); };
  switch (t.scope) {
    case 'channel': {
      const ch = p.channels.find((c) => c.id === t.id);
      if (!ch) return t.label;
      // an instrument parameter: "<channel> - <FL's parameter name>"
      const key = genParamKeyOf(t.path);
      const gp = key && ch.plugin ? genParamDef(ch.plugin.id, key) : undefined;
      return `${ch.name} - ${gp?.name ?? CHANNEL_PARAM_NAMES[t.path] ?? param(t.label)}`;
    }
    case 'mixer': {
      const tr = p.mixer.tracks[Number(t.id)];
      if (!tr) return t.label;
      const name = mixerTrackName(tr);
      let what = MIXER_PARAM_NAMES[t.path];
      if (!what && t.path.startsWith('sends.')) {
        const dst = p.mixer.tracks[Number(t.path.slice(6))];
        what = `To ${dst ? mixerTrackName(dst) : t.path.slice(6)}`;
      }
      return `${name} - ${what ?? (t.label.startsWith(name + ' - ') ? t.label.slice(name.length + 3) : param(t.label))}`;
    }
    case 'fx': {
      const loc = findFx(p, t.id);
      if (!loc) return t.label;
      const key = t.path.startsWith('params.') ? t.path.slice(7) : '';
      const what = t.path === 'mix' ? 'Mix level' : t.path === 'enabled' ? 'Mute / solo'
        : (key && !key.includes('.') && fxParamDef(loc.fx.plugin, key)?.name) || param(t.label);
      return `${loc.fx.name} - ${mixerTrackName(p.mixer.tracks[loc.track])} - ${what}`;
    }
    case 'global':
      return t.path === 'tempo' ? 'Tempo' : t.path === 'mainPitch' ? 'Master pitch' : t.label;
  }
}

/** Further clips of a name are numbered " #2", " #3"... */
function uniqueAutomationName(p: Project, base: string): string {
  const names = new Set(p.automation.map((a) => a.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} #${n}`)) n++;
  return `${base} #${n}`;
}

/** A new clip takes the colour of its target's owner (channel, mixer track), else the next channel palette colour. */
function automationColor(p: Project, t: AutomationTarget): string {
  if (t.scope === 'channel') {
    const ch = p.channels.find((c) => c.id === t.id);
    if (ch) return ch.color;
  }
  const tr = t.scope === 'mixer' ? p.mixer.tracks[Number(t.id)] : t.scope === 'fx' ? p.mixer.tracks.find((m) => m.slots.some((s) => s?.id === t.id)) : undefined;
  if (tr?.color) return tr.color;
  return CHANNEL_COLORS[(p.channels.length + p.automation.length) % CHANNEL_COLORS.length];
}

/** The range FL automates a control over: tempo 10..522 BPM, channel pitch +-4800 cents. */
function automationRange(p: Project, t: AutomationTarget): AutomationTarget {
  if (t.scope === 'global' && t.path === 'tempo') return { ...t, min: TEMPO_TARGET.min, max: TEMPO_TARGET.max };
  if (t.scope === 'channel' && t.path === 'pitch') {
    // the knob is a factor of the channel's pitch range (semitones): +-4800 cents in knob units
    const k = 48 / Math.max(1, p.channels.find((c) => c.id === t.id)?.sampler.pitchRange ?? 2);
    return { ...t, min: -k, max: k };
  }
  return t;
}

/**
 * "Create automation clip" on a control (FL 21 / 2024): a new automation
 * channel linked to the control, with MIN / MAX defaults for its kind, a flat
 * line at the control's current value inside MIN..MAX, the control
 * initialized, and a Playlist clip over the time selection, else from the
 * playback position (song mode) to the song end, at least one bar long, on
 * the highest empty track in view.
 */
export function createAutomationClip(control: AutomationTarget, range?: { start: number; end: number }): Id {
  const p = store.project;
  const name = automationName(p, control);
  const target = { ...automationRange(p, control), label: name };
  const cur = readTarget(p, target);
  const out = defaultClipRange(target);
  const value = cur === null ? 0.5 : envelopeValueOf(out, target, cur);
  const bar = ticksPerBar(p);
  const sel = range ?? store.ui.playlist.timeSel ?? undefined;
  let start = sel?.start ?? 0;
  let end = sel?.end ?? 0;
  if (end <= start) {
    // "Create automation clips at the playback position" (FL 21.2+, on by default)
    let songEnd = 0;
    for (const c of p.playlist.clips) songEnd = Math.max(songEnd, c.start + c.length);
    start = p.songMode ? Math.max(0, Math.round(currentTick())) : 0;
    end = Math.max(start + bar, Math.ceil(songEnd / bar - 1e-9) * bar);
  }
  const len = end - start;
  const id = uid('a');
  const chan: AutomationChannel = {
    id, name: uniqueAutomationName(p, name), color: automationColor(p, target), enabled: true, target,
    points: flatEnvelope(value, len), length: len, loop: false, min: out.min, max: out.max, lfo: defaultLfo(),
  };
  const track = firstFreeTrack(p, start, end);
  const clip: Clip = { id: uid('k'), track, kind: 'automation', patternId: '', autoId: id, start, length: len, offset: 0, muted: false };
  store.update('Create automation clip', (d) => {
    d.automation.push(chan as Draft<AutomationChannel>);
    d.playlist.clips.push(clip as Draft<Clip>);
    // the control is initialized with its current value (FL: "Initialized controls")
    if (cur !== null) upsertInit(d, target, cur);
  });
  flashHint(`Automation clip created: ${chan.name}`);
  return id;
}

function upsertInit(d: Draft<Project>, target: AutomationTarget, value: number): void {
  const list = (d.initControls ??= []);
  const k = list.findIndex((i) => sameTarget(i.target, target));
  if (k >= 0) list[k].value = value;
  else list.push({ target: { ...target }, value } as Draft<InitControl>);
}

/** "Init song with this position": the control's current value becomes its value at song start. */
export function initSongWithPosition(target: AutomationTarget): void {
  const cur = readTarget(store.project, target);
  if (cur === null) return;
  store.update('Init song with this position', (d) => upsertInit(d, target, cur));
  flashHint(`${target.label} initialized`);
}

export function deleteInitialValue(target: AutomationTarget): void {
  store.update('Delete initial value', (d) => {
    d.initControls = (d.initControls ?? []).filter((i) => !sameTarget(i.target, target));
  });
}

export function hasInitialValue(target: AutomationTarget): boolean {
  return (store.project.initControls ?? []).some((i) => sameTarget(i.target, target));
}

/** Place another instance of an automation clip in the Playlist (its natural length by default). */
export function addAutomationInstance(track: number, autoId: Id, start: number, length?: number): Id {
  const a = store.project.automation.find((x) => x.id === autoId);
  const len = Math.max(1, length ?? a?.length ?? ticksPerBar(store.project));
  const id = uid('k');
  store.update('Add clip', (d) => {
    d.playlist.clips.push({ id, track, kind: 'automation', patternId: '', autoId, start, length: len, offset: 0, muted: false } as Draft<Clip>);
  });
  return id;
}

export function updateAutomation(id: Id, label: string, recipe: (a: Draft<AutomationChannel>) => void, mergeKey?: string): void {
  store.update(label, (d) => {
    const a = d.automation.find((x) => x.id === id);
    if (a) recipe(a);
  }, { mergeKey });
}

export function deleteAutomation(ids: Id[]): void {
  if (!ids.length) return;
  store.update(ids.length > 1 ? 'Delete automation clips' : 'Delete automation clip', (d) => {
    d.automation = d.automation.filter((a) => !ids.includes(a.id));
    d.playlist.clips = d.playlist.clips.filter((c) => !(c.kind === 'automation' && c.autoId && ids.includes(c.autoId)));
  });
  store.updateUi((u) => { for (const id of ids) delete u.windows['auto:' + id]; });
}

/** Clone an automation channel (Make unique; the target link is kept) and point a clip at the copy. */
export function makeAutomationUnique(clipId: Id): void {
  const p = store.project;
  const clip = p.playlist.clips.find((c) => c.id === clipId);
  const src = clip?.autoId ? p.automation.find((a) => a.id === clip.autoId) : undefined;
  if (!clip || !src) return;
  const id = uid('a');
  const name = uniqueAutomationName(p, src.name.replace(/ #\d+$/, ''));
  store.update('Make unique', (d) => {
    d.automation.push({ ...structuredClone(src), id, name } as Draft<AutomationChannel>);
    const c = d.playlist.clips.find((x) => x.id === clipId);
    if (c) c.autoId = id;
  });
}

export function openAutomationWindow(id: Id): void {
  const a = store.project.automation.find((x) => x.id === id);
  openWindow('auto:' + id, { title: a ? a.name : 'Automation clip', x: 240, y: 110, w: 640, h: 360 });
}

// ------------------------------------------------------- remote control links
/** Internal controllers of a project: every output of every controller plugin in the mixer. */
export function controllerSources(p: Project = store.project): ControllerSourceInfo[] {
  const out: ControllerSourceInfo[] = [];
  // controller instruments (Envelope / Keyboard / Voltage Controller...): "<channel> - <output>"
  for (const g of allGens(p)) {
    const ch = p.channels.find((c) => c.id === g.channelId);
    genOutputs(g.plugin, g.params).forEach((name, output) => {
      if (name) out.push({ slotId: g.id, output, label: `${ch?.name ?? g.plugin} - ${name}` });
    });
  }
  for (const tr of p.mixer.tracks) {
    for (const s of tr.slots) {
      if (!s) continue;
      const names = fxOutputs(s.plugin, s.params);
      names.forEach((name, output) => {
        if (name) out.push({ slotId: s.id, output, label: `${s.name} (${mixerTrackName(tr)}) - ${name}` });
      });
    }
  }
  return out;
}

/** Links of a parameter, in creation order ("Link 1", "Link 2"...). */
export function linksOf(target: AutomationTarget, p: Project = store.project): ControllerLink[] {
  return (p.links ?? []).filter((l) => sameTarget(l.target, target));
}

export function isLinked(target: AutomationTarget, p: Project = store.project): boolean {
  return (p.links ?? []).some((l) => sameTarget(l.target, target));
}

/**
 * Accept in the Remote control settings dialog: create or update a link.
 * "Remove conflicts" removes the parameter's other links.
 */
export function saveLink(link: ControllerLink, removeConflicts = false): void {
  store.update('Link to controller', (d) => {
    let list = (d.links ??= []) as ControllerLink[];
    if (removeConflicts) list = list.filter((l) => l.id === link.id || !sameTarget(l.target, link.target));
    const k = list.findIndex((l) => l.id === link.id);
    const copy = structuredClone(link);
    if (k >= 0) list[k] = copy; else list.push(copy);
    d.links = list as Draft<ControllerLink>[];
  });
}

export function removeLink(id: Id): void {
  store.update('Remove link', (d) => {
    if (d.links) d.links = d.links.filter((l) => l.id !== id);
  });
}

/** Link a parameter to a controller output with the default 1:1 mapping (replaces its other links). */
export function linkToController(target: AutomationTarget, source: { slotId: Id; output: number }, formula = 'Input'): Id {
  const id = uid('l');
  saveLink({ id, target: { ...target }, source: { ...source }, formula }, true);
  return id;
}
