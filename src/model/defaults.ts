// Factories for project objects and the default (template) project.

import type { Channel, MixerTrack, Note, Pattern, PlaylistTrack, Project, SampleInfo, Id } from './types';
import { defaultSampler, normalizeSampler } from './sampler';
import { FADER_DEFAULT, CHANNEL_VOLUME_DEFAULT } from './scales';
import { DEFAULT_KEY } from './notes';
import { normalizeAutomation } from './automation';
import { normalizeLinks } from './links';
import { defaultFxParams, fxDef, normalizeFxParams } from './fx/registry';
import { defaultMidiOut, normalizeMidiOut } from './midiout';
import { defaultGenParams, genDef, normalizeGenParams } from './gen/registry';
import { channelOfSlot } from './gen/ids';
import { LAYER_COLOR, defaultLayer, defaultLayerSampler, normalizeLayer, repairLayers } from './layer';
import { AUDIO_CLIP_COLOR, AUDIO_CLIP_VOLUME_DEFAULT, audioClipSampler, normalizeAudioClip } from './audioclip';

export const NUM_INSERTS = 125;
export const NUM_PLAYLIST_TRACKS = 500;
export const NUM_FX_SLOTS = 10;

let counter = 0;
export function uid(prefix = ''): Id {
  counter = (counter + 1) % 1e9;
  return prefix + Date.now().toString(36).slice(-5) + counter.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

export const CHANNEL_COLORS = ['#5c656a', '#8fa0ad', '#99a8a1', '#a59a8b', '#9a8fa8', '#8a9fb0', '#a1928a', '#8ea98f'];
export const MIXER_TRACK_COLOR = '#636c71';
export const DEFAULT_PATTERN_COLOR = '#485156';
export const PATTERN_COLORS = ['#485156', '#5f7d8f', '#7c6f9a', '#9a6f7c', '#8f8a5f', '#5f8f6f', '#5f8a8f', '#8f6f5f'];
export const TRACK_COLOR = '#485156';

export function createNote(partial: Partial<Note> & { pos: number; len: number }): Note {
  return {
    id: uid('n'),
    key: DEFAULT_KEY,
    vel: 100,
    rel: 64,
    pan: 64,
    fine: 120,
    modX: 128,
    modY: 128,
    color: 0,
    slide: false,
    porta: false,
    muted: false,
    ...partial,
  };
}

export function createChannel(name: string, sampleId: Id | null, mixerTrack = 0): Channel {
  return {
    id: uid('c'),
    name,
    color: CHANNEL_COLORS[0],
    kind: 'sampler',
    enabled: true,
    volume: CHANNEL_VOLUME_DEFAULT,
    pan: 0,
    pitch: 0,
    mixerTrack,
    filterGroup: 'Unsorted',
    sampler: defaultSampler(sampleId),
  };
}

/** A MIDI Out channel (FL: Generators > MIDI > MIDI Out): no sound, its notes go out on its MIDI port. */
export function createMidiOutChannel(name = 'MIDI Out', mixerTrack = 0): Channel {
  return { ...createChannel(name, null, mixerTrack), kind: 'midiout', midiOut: defaultMidiOut() };
}

/**
 * An instrument plugin channel (FL: a generator from Browser > Plugin database
 * > Generators): the plugin's default state, named after the plugin, and the
 * plugin's default polyphony (FL's DefPoly) in MISC.
 */
export function createGenChannel(pluginId: string, name?: string, mixerTrack = 0): Channel {
  const d = genDef(pluginId);
  const c: Channel = { ...createChannel(name ?? d?.name ?? pluginId, null, mixerTrack), kind: 'plugin', plugin: { id: pluginId, params: defaultGenParams(pluginId) } };
  if (d?.defPoly) c.sampler.polyMax = d.defPoly;
  return c;
}

/**
 * A Layer channel (FL: Generators > Misc > Layer): no sound, its notes play its
 * children. FL's template (Layer.fst / LayerTrack.fst): channel volume 100%
 * (new layers do not attenuate their children), "Enable main pitch" off,
 * centred pan / pitch, levels adjustment 100%, root C5, no children.
 */
export function createLayerChannel(name = 'Layer'): Channel {
  const c = createChannel(name, null, 0);
  return { ...c, kind: 'layer', color: LAYER_COLOR, volume: 1, sampler: defaultLayerSampler(), layer: defaultLayer() };
}

/**
 * An Audio Clip channel (FL: made when a sample is dropped on the Playlist): a
 * Sampler-like channel that holds one pool sample and plays only through its
 * audio clips. Volume 100% (the sample's original level), centred, routed to
 * the Master unless a mixer track is given.
 */
export function createAudioClipChannel(name: string, sampleId: Id | null, mixerTrack = 0): Channel {
  const c = createChannel(name, sampleId, mixerTrack);
  return { ...c, kind: 'audioclip', color: AUDIO_CLIP_COLOR, volume: AUDIO_CLIP_VOLUME_DEFAULT, sampler: audioClipSampler(sampleId) };
}

/** A channel's instrument MIDI input port (-1 = none). */
function normalizePort(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(255, Math.round(v)) : -1;
}

/**
 * Bring a stored channel up to the current model: channels saved before MIDI
 * Out are samplers; an instrument channel's plugin state is normalised (a
 * plugin id this version does not know keeps its stored state).
 */
export function normalizeChannel(c: Channel): Channel {
  const kind = c.kind === 'midiout' ? 'midiout' : c.kind === 'layer' ? 'layer' : c.kind === 'audioclip' ? 'audioclip' : c.kind === 'plugin' && c.plugin && typeof c.plugin.id === 'string' ? 'plugin' : 'sampler';
  const out: Channel = { ...c, kind, sampler: normalizeSampler(c.sampler, c.sampler?.sampleId ?? null) };
  if (kind === 'midiout') out.midiOut = normalizeMidiOut(c.midiOut);
  else delete out.midiOut;
  // a layer's children are repaired against the other channels by normalizeProject (repairLayers)
  if (kind === 'layer') out.layer = normalizeLayer(c.layer);
  else delete out.layer;
  if (kind === 'plugin') {
    const id = c.plugin!.id;
    const port = normalizePort(c.plugin!.midiPort);
    out.plugin = { id, params: normalizeGenParams(id, c.plugin!.params), ...(port >= 0 ? { midiPort: port } : {}) };
  } else delete out.plugin;
  return out;
}

/** A slot's MIDI input port (-1 = none). */
export function normalizeMidiPort(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(255, Math.round(v)) : -1;
}

export function createClone(src: Channel): Channel {
  const c: Channel = { ...structuredClone(src), id: uid('c'), name: src.name + ' #2' };
  // a channel is the child of one layer at most: a cloned layer starts without children
  if (c.layer) c.layer.children = [];
  return c;
}

export function createPattern(index: number): Pattern {
  return { id: uid('p'), name: `Pattern ${index}`, color: null, notes: {} };
}

export function createMixerTrack(index: number): MixerTrack {
  return {
    index,
    name: '',
    color: null,
    enabled: true,
    volume: FADER_DEFAULT,
    pan: 0,
    stereoSep: 0,
    polarity: false,
    swapLR: false,
    sends: index === 0 || index === NUM_INSERTS + 1 ? {} : { 0: FADER_DEFAULT },
    slots: new Array(NUM_FX_SLOTS).fill(null),
    fxEnabled: true,
    eq: [
      { gain: 0, freq: 0.0882, width: 0.267 },
      { gain: 0, freq: 0.5058, width: 0.267 },
      { gain: 0, freq: 0.8518, width: 0.267 },
    ],
  };
}

export function createPlaylistTrack(index: number): PlaylistTrack {
  return { id: uid('t'), name: `Track ${index + 1}`, color: TRACK_COLOR, height: 1, enabled: true, locked: false };
}

export function mixerTrackName(t: MixerTrack): string {
  if (t.name) return t.name;
  if (t.index === 0) return 'Master';
  if (t.index === NUM_INSERTS + 1) return 'Current';
  return `Insert ${t.index}`;
}

export function createFxSlot(plugin = 'peq2'): import('./types').FxSlot {
  const d = fxDef(plugin);
  return { id: uid('fx'), plugin, name: d?.name ?? plugin, enabled: true, mix: 1, params: defaultFxParams(plugin) };
}

/** Default template: four drum channels (Kick, Clap, Hat, Snare), one empty pattern. */
export function createDefaultProject(samples: Record<Id, SampleInfo>, sampleIdsByKey: Record<string, Id>): Project {
  const pattern = createPattern(1);
  // the basic template routes its four drum channels to inserts 1-4
  const channels = [
    createChannel('Kick', sampleIdsByKey['kick'] ?? null, 1),
    createChannel('Clap', sampleIdsByKey['clap'] ?? null, 2),
    createChannel('Hat', sampleIdsByKey['hat'] ?? null, 3),
    createChannel('Snare', sampleIdsByKey['snare'] ?? null, 4),
  ];
  const tracks: MixerTrack[] = [];
  for (let i = 0; i <= NUM_INSERTS + 1; i++) tracks.push(createMixerTrack(i));
  channels.forEach((c) => { tracks[c.mixerTrack].name = c.name; });
  const ptracks: PlaylistTrack[] = [];
  for (let i = 0; i < NUM_PLAYLIST_TRACKS; i++) ptracks.push(createPlaylistTrack(i));
  return {
    version: 1,
    title: '',
    tempo: 130,
    ppq: 96,
    beatsPerBar: 4,
    stepsPerBeat: 4,
    mainVolume: 0.8,
    mainPitch: 0,
    swing: 0,
    channels,
    automation: [],
    initControls: [],
    links: [],
    patterns: [pattern],
    currentPatternId: pattern.id,
    songMode: false,
    playlist: { tracks: ptracks, clips: [], markers: [], autoCrossfades: true },
    mixer: { tracks },
    samples,
  };
}

/** Bring a project saved by an older version up to the current data model. */
export function normalizeProject(p: Project): Project {
  const tracks: MixerTrack[] = [];
  for (let i = 0; i <= NUM_INSERTS + 1; i++) {
    const t = p.mixer?.tracks?.[i];
    const d = createMixerTrack(i);
    tracks.push(t ? {
      ...d, ...t,
      eq: t.eq && t.eq.length === 3 ? t.eq : d.eq,
      fxEnabled: t.fxEnabled !== false,
      slots: Array.from({ length: NUM_FX_SLOTS }, (_, k) => {
        const s = t.slots?.[k];
        if (!s) return null;
        const plugin = s.plugin ?? 'peq2';
        const slot = { ...s, plugin, params: normalizeFxParams(plugin, s.params) };
        const port = normalizeMidiPort(s.midiPort);
        if (port >= 0) slot.midiPort = port; else delete slot.midiPort;
        return slot;
      }),
    } : d);
  }
  const ptracks: PlaylistTrack[] = [];
  for (let i = 0; i < NUM_PLAYLIST_TRACKS; i++) ptracks.push(p.playlist?.tracks?.[i] ?? createPlaylistTrack(i));
  const channels = (p.channels ?? []).map((c) => normalizeChannel(c));
  repairLayers(channels);
  // audio clips: an older project has none; one whose Audio Clip channel is gone cannot play and is dropped
  const audioChannels = new Set(channels.filter((c) => c.kind === 'audioclip').map((c) => c.id));
  const clips = (p.playlist?.clips ?? [])
    .map((c) => normalizeAudioClip({ ...c, kind: c.kind ?? 'pattern' }))
    .filter((c) => c.kind !== 'audio' || (c.channelId !== undefined && audioChannels.has(c.channelId)));
  return {
    ...p,
    swing: p.swing ?? 0,
    mainPitch: p.mainPitch ?? 0,
    mainVolume: p.mainVolume ?? 0.8,
    channels,
    automation: (p.automation ?? []).map(normalizeAutomation),
    initControls: p.initControls ?? [],
    links: normalizeLinks(p.links, (id) => {
      // a controller output of an effect slot, or of an instrument channel ("ch:<channel id>")
      const ch = channelOfSlot(id);
      if (ch !== null) return (p.channels ?? []).some((c) => c.id === ch && c.kind === 'plugin');
      return tracks.some((t) => t.slots.some((s) => s?.id === id));
    }),
    playlist: { tracks: ptracks, clips, markers: p.playlist?.markers ?? [], ...(p.playlist?.autoCrossfades ? { autoCrossfades: true } : {}) },
    mixer: { tracks },
  };
}
