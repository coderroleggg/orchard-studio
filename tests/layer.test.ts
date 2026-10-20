// Layer channels (FL: Generators > Misc > Layer; docs/research/layer.md): the
// model (defaults, normalisation, children rules, crossfade law), the store
// actions (add / replace / insert, Set / Show / Split / Reset / Group / Delete
// children, deleting and cloning, undo, links and automation of FADE, save /
// load) and the engine (notes reach every child at the same frame with the
// same data, Random / Sequential / Crossfade, the layer's levels adjustment as
// live levels of its children's voices, live notes, panic / stop / seek, muted
// layers and children, key ranges, the children's own MISC features).
import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine/Engine';
import { registerGen } from '../src/engine/gen';
import { registerEffect } from '../src/engine/effects';
import type { EffectInstance } from '../src/engine/effects/types';
import type { GenInstance, GenLevels, GenNote } from '../src/engine/gen/types';
import { LayerChannel } from '../src/engine/LayerChannel';
import type { FromEngine } from '../src/engine/protocol';
import { PITCH_C5 } from '../src/engine/gen/levels';
import { DcGen, genChannel } from './gen/util';
import { registerGenDef } from '../src/model/gen/registry';
import type { GenPluginDef } from '../src/model/gen/types';
import {
  createChannel, createClone, createDefaultProject, createFxSlot, createGenChannel, createLayerChannel, createMidiOutChannel, createMixerTrack,
  createNote, createPattern, normalizeChannel, normalizeProject,
} from '../src/model/defaults';
import {
  crossfadeGain, defaultLayer, LAYER_COLOR, LAYER_FADE_MAX, normalizeLayer, removeFromLayers, repairLayers, resetChildren, setChildren, splitChildren,
} from '../src/model/layer';
import { defaultLfo, type AutomationChannel, type AutomationTarget } from '../src/model/automation';
import { adjVolGain, defaultSampler, velocityGain } from '../src/model/sampler';
import { CHANNEL_VOLUME_DEFAULT, channelVolumeToGain } from '../src/model/scales';
import type { Channel, Clip, Note, Pattern, Project } from '../src/model/types';

const SR = 48000;
// 120 BPM, PPQ 96: 250 samples per tick, a step (24 ticks) = 6000 samples, a beat = 24000
const TICK = 250;

// ------------------------------------------------------------ a recording instrument
interface RecEvent {
  kind: 'on' | 'off' | 'kill';
  key: number;
  velocity: number;
  release: number;
  color: number;
  length: number;
  /** Absolute frame of the event. */
  frame: number;
  init: GenLevels;
}

/** An 'events' instrument that logs every note with its frame and levels, and the levels of the held notes after every block. */
class Rec implements GenInstance {
  static all: Rec[] = [];
  events: RecEvent[] = [];
  /** [absolute frame of the block, note id, FinalLevels] of every held note after each block. */
  trail: { t: number; id: number; levels: GenLevels }[] = [];
  t = 0;
  tail = Infinity;
  private held = new Map<number, GenNote>();
  constructor() { Rec.all.push(this); }
  setParams(): void {}
  reset(): void {}
  private log(kind: RecEvent['kind'], n: GenNote, frame: number): void {
    this.events.push({ kind, key: n.key, velocity: n.velocity, release: n.release, color: n.color, length: n.length, frame, init: { ...n.init } });
  }
  noteOn(n: GenNote, off: number): void { this.held.set(n.id, n); this.log('on', n, this.t + off); }
  noteOff(n: GenNote, off: number): void { this.log('off', n, this.t + off); this.held.delete(n.id); }
  killNote(n: GenNote): void { this.log('kill', n, this.t); this.held.delete(n.id); }
  isActive(): boolean { return this.held.size > 0; }
  render(_L: Float32Array, _R: Float32Array, n: number): void {
    for (const [id, note] of this.held) this.trail.push({ t: this.t, id, levels: { ...note.levels } });
    this.t += n;
  }
  /** The note-on events. */
  get ons(): RecEvent[] { return this.events.filter((e) => e.kind === 'on'); }
  /** The levels of the newest trail entry. */
  get lv(): GenLevels { return this.trail[this.trail.length - 1].levels; }
}

const REC_DEF: GenPluginDef = { id: 'test-layer-rec', name: 'Layer test recorder', category: 'Drum', notes: 'events', width: 100, height: 40, params: [] };
registerGenDef(REC_DEF);
registerGen({ id: 'test-layer-rec', create: () => new Rec() });

// ------------------------------------------------------------------- engine helpers
function engine(random?: () => number, post?: (m: FromEngine) => void): Engine {
  const e = new Engine({ sampleRate: SR, blockSize: 128, random, post });
  e.handle({ t: 'globals', g: { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: createMixerTrack(i) });
  return e;
}

function rec(name = 'Rec'): Channel {
  const c = createGenChannel('test-layer-rec', name);
  c.volume = 1;
  return c;
}

interface Scene {
  e: Engine;
  layer: Channel;
  kids: Channel[];
  recs: Rec[];
}

/** An engine with a layer over `n` recording children (the children are created first, so `recs[i]` is child i). */
function scene(n: number, opts: { random?: () => number; layer?: (l: Channel) => void; kid?: (c: Channel, i: number) => void; post?: (m: FromEngine) => void } = {}): Scene {
  Rec.all = [];
  const e = engine(opts.random, opts.post);
  const kids = Array.from({ length: n }, (_, i) => { const c = rec(`Kid ${i + 1}`); opts.kid?.(c, i); return c; });
  const layer = createLayerChannel();
  layer.layer!.children = kids.map((k) => k.id);
  opts.layer?.(layer);
  for (const k of kids) e.handle({ t: 'channel', c: k });
  e.handle({ t: 'channel', c: layer });
  return { e, layer, kids, recs: Rec.all.slice() };
}

/** Put notes into a pattern and start playing it (pattern mode). */
function startPattern(e: Engine, notes: Record<string, Partial<Note>[]>): Pattern {
  const pat = createPattern(1);
  for (const [id, list] of Object.entries(notes)) pat.notes[id] = list.map((n) => createNote({ pos: 0, len: 24, ...n }));
  e.handle({ t: 'pattern', p: pat });
  e.handle({ t: 'mode', song: false, patternId: pat.id });
  e.handle({ t: 'play' });
  return pat;
}

/** A copy of a layer channel with changed layer settings (what the host sends after an edit). */
function withLayer(c: Channel, patch: Partial<NonNullable<Channel['layer']>>): Channel {
  return { ...c, layer: { ...c.layer!, ...patch } };
}

const noteOn = (e: Engine, ch: Channel, key: number, tag: number, vel = 100) => e.handle({ t: 'noteOn', ch: ch.id, key, vel, tag });
const noteOff = (e: Engine, ch: Channel, key: number, tag: number) => e.handle({ t: 'noteOff', ch: ch.id, key, tag });

// =================================================================== the model
describe('Layer model', () => {
  it('a new layer is FL\'s template: 100% volume, no children, main pitch off, DB colour', () => {
    const c = createLayerChannel();
    expect(c.name).toBe('Layer');
    expect(c.kind).toBe('layer');
    expect(c.enabled).toBe(true);
    expect(c.volume).toBe(1);
    expect(c.pan).toBe(0);
    expect(c.pitch).toBe(0);
    expect(c.mixerTrack).toBe(0);
    expect(c.color).toBe(LAYER_COLOR);
    expect(c.layer).toEqual({ children: [], random: false, sequential: false, crossfade: false, fade: 0 });
    expect(c.midiOut).toBeUndefined();
    expect(c.plugin).toBeUndefined();
    const s = c.sampler;
    expect(s.mainPitch).toBe(false);
    expect(s.adjVol).toBe(defaultSampler().adjVol); // levels adjustment 100%
    expect([s.adjPan, s.adjModX, s.adjModY, s.fineTune]).toEqual([0, 0, 0, 0]);
    expect([s.rootKey, s.keyLo, s.keyHi]).toEqual([60, 0, 131]);
    // other new channels keep their 78% default volume
    expect(createChannel('x', null).volume).toBe(CHANNEL_VOLUME_DEFAULT);
  });

  it('repairs stored layer settings', () => {
    expect(normalizeLayer(undefined)).toEqual(defaultLayer());
    expect(normalizeLayer('junk')).toEqual(defaultLayer());
    expect(normalizeLayer({ children: 'a' })).toEqual(defaultLayer());
    expect(normalizeLayer({ children: ['a', 'b', 'a', 3, null, 'c'], random: true, sequential: 'yes', crossfade: true, fade: 99.6 })).toEqual({
      children: ['a', 'b', 'c'], random: true, sequential: false, crossfade: true, fade: 100,
    });
    expect(normalizeLayer({ fade: -5 }).fade).toBe(0);
    expect(normalizeLayer({ fade: 900 }).fade).toBe(LAYER_FADE_MAX);
    expect(normalizeLayer({ fade: NaN }).fade).toBe(0);
  });

  it('normalizeChannel keeps layers, gives them settings and drops layer data from other kinds', () => {
    const l = createLayerChannel();
    expect(normalizeChannel(l)).toEqual(l);
    const noSettings = normalizeChannel({ ...l, layer: undefined });
    expect(noSettings.kind).toBe('layer');
    expect(noSettings.layer).toEqual(defaultLayer());
    const stray = normalizeChannel({ ...createChannel('S', null), layer: defaultLayer() });
    expect(stray.kind).toBe('sampler');
    expect(stray.layer).toBeUndefined();
    expect(normalizeChannel({ ...l, kind: 'bogus' as never }).kind).toBe('sampler');
  });

  it('createClone of a layer keeps its settings and has no children yet (cloneChannel adds copies of them)', () => {
    const l = createLayerChannel();
    l.layer = { children: ['a', 'b'], random: true, sequential: false, crossfade: true, fade: 70 };
    const c = createClone(l);
    expect(c.id).not.toBe(l.id);
    expect(c.name).toBe('Layer #2');
    expect(c.layer).toEqual({ children: [], random: true, sequential: false, crossfade: true, fade: 70 });
    expect(l.layer.children).toEqual(['a', 'b']);
  });

  it('normalizeProject repairs the children: they exist, are no layers, belong to one layer', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((n) => createChannel(n, null));
    const l1 = createLayerChannel('L1');
    const l2 = createLayerChannel('L2');
    l1.layer!.children = [a.id, 'ghost', l2.id, l1.id, b.id];
    l2.layer!.children = [b.id, c.id];
    const p = createDefaultProject({}, {});
    const out = normalizeProject({ ...p, channels: [a, b, c, l1, l2] });
    const kids = (n: string) => out.channels.find((x) => x.name === n)!.layer!.children;
    expect(kids('L1')).toEqual([a.id, b.id]);
    expect(kids('L2')).toEqual([c.id]); // B stays with the first layer
    // nothing changes in a project without layers, and a repaired project is stable
    const plain = normalizeProject(p);
    expect(plain.channels.map((x) => x.kind)).toEqual(['sampler', 'sampler', 'sampler', 'sampler']);
    expect(plain.channels.every((x) => x.layer === undefined)).toBe(true);
    expect(normalizeProject(JSON.parse(JSON.stringify(out))).channels).toEqual(out.channels);
  });

  it('removeFromLayers / setChildren move children between layers in rack order', () => {
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => createChannel(n, null));
    const l1 = createLayerChannel('L1');
    const l2 = createLayerChannel('L2');
    const chans = [a, l1, b, c, l2, d];
    // selection order does not matter, layers and the layer itself are left out; the rack order is stored
    expect(setChildren(chans, l1.id, [d.id, a.id, l1.id, l2.id, c.id])).toEqual([a.id, c.id, d.id]);
    expect(l1.layer!.children).toEqual([a.id, c.id, d.id]);
    // the other layer takes B and C: C leaves the first layer
    setChildren(chans, l2.id, [c.id, b.id]);
    expect(l2.layer!.children).toEqual([b.id, c.id]);
    expect(l1.layer!.children).toEqual([a.id, d.id]);
    // "select the ones to keep and press the button again"
    setChildren(chans, l1.id, [d.id]);
    expect(l1.layer!.children).toEqual([d.id]);
    // not a layer: nothing happens
    expect(setChildren(chans, a.id, [b.id])).toEqual([]);
    removeFromLayers(chans, [d.id, b.id]);
    expect(l1.layer!.children).toEqual([]);
    expect(l2.layer!.children).toEqual([c.id]);
    const x = createLayerChannel('X');
    x.layer!.children = ['q', a.id, 'q2'];
    repairLayers([a, x]);
    expect(x.layer!.children).toEqual([a.id]);
  });

  it('Split children: one child per key from the layer\'s root key, root key = key; Reset children undoes it', () => {
    const kids = ['K', 'C', 'H', 'S'].map((n) => createChannel(n, null));
    const l = createLayerChannel();
    l.sampler.rootKey = 62;
    const chans = [...kids, l];
    setChildren(chans, l.id, kids.map((k) => k.id));
    splitChildren(chans, l.id);
    expect(kids.map((k) => [k.sampler.keyLo, k.sampler.keyHi, k.sampler.rootKey])).toEqual([[62, 62, 62], [63, 63, 63], [64, 64, 64], [65, 65, 65]]);
    resetChildren(chans, l.id);
    expect(kids.map((k) => [k.sampler.keyLo, k.sampler.keyHi, k.sampler.rootKey])).toEqual(kids.map(() => [0, 131, 60]));
    // keys past the top of the keyboard stay on the last key
    l.sampler.rootKey = 130;
    splitChildren(chans, l.id);
    expect(kids.map((k) => k.sampler.rootKey)).toEqual([130, 131, 131, 131]);
  });

  it('crossfade: with three children Child 1 > 1 + 2 > Child 2 > 2 + 3 > Child 3, equal power between neighbours', () => {
    const g = (fade: number) => [0, 1, 2].map((i) => crossfadeGain(i, 3, fade));
    expect(g(0)).toEqual([1, 0, 0]);
    expect(g(128)).toEqual([0, 1, 0]);
    expect(g(256)).toEqual([0, 0, 1]);
    const q = g(64);
    expect(q[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(q[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(q[2]).toBe(0);
    const t = g(192);
    expect(t[0]).toBe(0);
    expect(t[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(t[2]).toBeCloseTo(Math.SQRT1_2, 12);
    // constant power, one child always plays
    for (let f = 0; f <= 256; f += 5) expect(g(f).reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 12);
    expect(crossfadeGain(0, 1, 200)).toBe(1);
    expect(crossfadeGain(0, 2, 128)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(crossfadeGain(1, 2, 128)).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

// ================================================================== the store
const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

describe('Layer actions', async () => {
  const { store } = await import('../src/store');
  const A = await import('../src/store/actions');
  const { generatorFolders, generatorMenuItems, channelGenerator } = await import('../src/ui/plugins/genMenu');

  const fresh = () => {
    store.replaceProject(createDefaultProject({}, {}));
    store.updateUi((u) => { u.selectedChannels = []; });
    return store.project.channels.map((c) => c.id);
  };
  const ch = (id: string) => store.project.channels.find((c) => c.id === id)!;
  const kids = (id: string) => ch(id).layer!.children;
  const names = (ids: string[]) => ids.map((i) => ch(i).name);

  it('adds layers named Layer, Layer #2... in every add path and lists Layer in the Misc folder', () => {
    fresh();
    const a = A.addLayerChannel();
    const b = A.addGenerator({ kind: 'layer' });
    const c = A.insertGenerator(a, { kind: 'layer' });
    expect(names([a, b, c])).toEqual(['Layer', 'Layer #2', 'Layer #3']);
    expect(store.project.channels.map((x) => x.id).slice(4, 7)).toEqual([a, c, b]); // inserted right below
    expect(ch(a).kind).toBe('layer');
    expect(ch(a).layer).toEqual(defaultLayer());
    expect(ch(a).volume).toBe(1);
    expect(store.ui.selectedChannels).toEqual([c]);
    // Browser > Plugin database > Generators > Misc and the add / Replace / Insert menus
    const misc = generatorFolders().find((f) => f.folder === 'Misc')!;
    expect(misc.entries.find((e) => e.name === 'Layer')!.choice).toEqual({ kind: 'layer' });
    const picked: unknown[] = [];
    const items = generatorMenuItems((x) => picked.push(x), channelGenerator(ch(a)));
    const layerItem = items.find((i) => i.label === 'Misc')!.submenu!.find((i) => i.label === 'Layer')!;
    expect(layerItem.checked).toBe(true);
    layerItem.onClick!();
    expect(picked).toEqual([{ kind: 'layer' }]);
    // one undo step per add
    store.undo();
    expect(store.project.channels.some((x) => x.id === c)).toBe(false);
  });

  it('Set children takes the selected channels in rack order, leaves layers out, one undo step', () => {
    const [kick, clap, hat, snare] = fresh();
    const L = A.addLayerChannel();
    store.updateUi((u) => { u.selectedChannels = [L, snare, kick, hat]; });
    const before = store.historyLabels().past.length;
    expect(A.setLayerChildren(L)).toEqual([kick, hat, snare]);
    expect(kids(L)).toEqual([kick, hat, snare]);
    expect(store.historyLabels().past.length).toBe(before + 1);
    expect(store.historyLabels().past.at(-1)).toBe('Set children');
    // pressing it again with the same selection changes nothing (no history entry)
    A.setLayerChildren(L);
    expect(store.historyLabels().past.length).toBe(before + 1);
    // "To remove channels, select the ones to keep and press the button again"
    store.updateUi((u) => { u.selectedChannels = [hat]; });
    A.setLayerChildren(L);
    expect(kids(L)).toEqual([hat]);
    store.undo();
    expect(kids(L)).toEqual([kick, hat, snare]);
    store.redo();
    expect(kids(L)).toEqual([hat]);
    // nothing selected: the layer has no children
    store.updateUi((u) => { u.selectedChannels = []; });
    A.setLayerChildren(L);
    expect(kids(L)).toEqual([]);
    expect(clap).toBeDefined();
  });

  it('a channel belongs to one layer: Set children moves it, in one undo step', () => {
    const [kick, clap, hat] = fresh();
    const L1 = A.addLayerChannel();
    const L2 = A.addLayerChannel();
    A.setLayerChildren(L1, [kick, clap]);
    A.setLayerChildren(L2, [clap, hat]);
    expect(kids(L1)).toEqual([kick]);
    expect(kids(L2)).toEqual([clap, hat]);
    store.undo();
    expect(kids(L1)).toEqual([kick, clap]);
    expect(kids(L2)).toEqual([]);
  });

  it('Show children selects the children and nothing else (no undo step)', () => {
    const [kick, clap, hat, snare] = fresh();
    const L = A.addLayerChannel();
    A.setLayerChildren(L, [clap, snare]);
    store.updateUi((u) => { u.selectedChannels = [kick, hat, L]; });
    const n = store.historyLabels().past.length;
    A.showLayerChildren(L);
    expect(store.ui.selectedChannels).toEqual([clap, snare]);
    expect(store.historyLabels().past.length).toBe(n);
  });

  it('Split children and Reset children edit the children\'s key range and root key, one undo step each', () => {
    const [kick, clap, hat, snare] = fresh();
    const L = A.addLayerChannel();
    A.setSampler(L, 'Root note', (d) => { d.rootKey = 48; });
    A.setLayerChildren(L, [kick, clap, hat, snare]);
    A.splitLayerChildren(L);
    const keys = () => [kick, clap, hat, snare].map((i) => [ch(i).sampler.keyLo, ch(i).sampler.keyHi, ch(i).sampler.rootKey]);
    expect(keys()).toEqual([[48, 48, 48], [49, 49, 49], [50, 50, 50], [51, 51, 51]]);
    expect(store.historyLabels().past.at(-1)).toBe('Split children');
    A.resetLayerChildren(L);
    expect(keys()).toEqual([[0, 131, 60], [0, 131, 60], [0, 131, 60], [0, 131, 60]]);
    store.undo();
    expect(keys()[2]).toEqual([50, 50, 50]);
    store.undo();
    expect(keys()[2]).toEqual([0, 131, 60]);
    // the layer's own range / root are not touched
    expect(ch(L).sampler.rootKey).toBe(48);
  });

  it('Group children, Delete children, deleting a child and deleting a layer', () => {
    const [kick, clap, hat, snare] = fresh();
    const L = A.addLayerChannel();
    A.setLayerChildren(L, [kick, hat]);
    A.groupLayerChildren(L, '  Drums ');
    expect([kick, clap, hat].map((i) => ch(i).filterGroup)).toEqual(['Drums', 'Unsorted', 'Drums']);
    A.groupLayerChildren(L, '   '); // empty name: nothing
    expect(ch(kick).filterGroup).toBe('Drums');
    // a deleted child leaves its layer, the layer stays
    A.deleteChannels([kick]);
    expect(kids(L)).toEqual([hat]);
    store.undo();
    expect(kids(L)).toEqual([kick, hat]);
    // Delete children: every child goes, in one step
    A.deleteLayerChildren(L);
    expect(store.project.channels.map((c) => c.id)).toEqual([clap, snare, L]);
    expect(kids(L)).toEqual([]);
    store.undo();
    expect(store.project.channels.length).toBe(5);
    expect(kids(L)).toEqual([kick, hat]);
    // deleting the layer leaves its children as they are
    A.deleteChannels([L]);
    expect(store.project.channels.map((c) => c.id)).toEqual([kick, clap, hat, snare]);
    expect(ch(kick).sampler.rootKey).toBe(60);
  });

  it('Create layer with selected channels', () => {
    const [kick, clap, hat] = fresh();
    store.updateUi((u) => { u.selectedChannels = [hat, kick]; });
    const L = A.createLayerWithSelected();
    expect(store.project.channels.at(-1)!.id).toBe(L);
    expect(kids(L)).toEqual([kick, hat]);
    expect(ch(L).name).toBe('Layer');
    expect(store.ui.selectedChannels).toEqual([L]);
    store.undo(); // one step
    expect(store.project.channels.length).toBe(4);
    expect(clap).toBeDefined();
  });

  it('Replace: a channel becomes a layer (out of its parent), a layer becomes another generator (children let go)', () => {
    const [kick, clap, hat] = fresh();
    const L = A.addLayerChannel();
    A.setLayerChildren(L, [kick, clap]);
    store.update('Notes', (d) => { d.patterns[0].notes[kick] = [createNote({ pos: 0, len: 0 })]; });
    // a layer cannot be a child: replacing a child by a layer takes it out of the layer
    A.replaceGenerator(kick, { kind: 'layer' });
    expect(ch(kick).kind).toBe('layer');
    expect(ch(kick).name).toBe('Layer #2');
    expect(ch(kick).layer).toEqual(defaultLayer());
    expect(kids(L)).toEqual([clap]);
    // it keeps its notes and settings
    expect(store.project.patterns[0].notes[kick]?.length).toBe(1);
    expect(ch(kick).volume).toBe(CHANNEL_VOLUME_DEFAULT);
    // a layer replaced by a Sampler / MIDI Out loses its layer data; its children stay
    A.setLayerChildren(kick, [hat]);
    A.replaceGenerator(kick, { kind: 'sampler' });
    expect(ch(kick).kind).toBe('sampler');
    expect(ch(kick).layer).toBeUndefined();
    expect(ch(hat).sampler.rootKey).toBe(60);
    A.replaceGenerator(L, { kind: 'midiout' });
    expect(ch(L).kind).toBe('midiout');
    expect(ch(L).layer).toBeUndefined();
    expect(ch(L).midiOut).toBeDefined();
    A.replaceGenerator(L, { kind: 'layer' });
    expect(ch(L).kind).toBe('layer');
    expect(ch(L).midiOut).toBeUndefined();
    expect(ch(L).name).toBe('Layer');
  });

  it('clones a layer with copies of its children (FL), notes included, in one undo step', () => {
    const [kick, clap] = fresh();
    const L = A.addLayerChannel();
    A.setLayerChildren(L, [clap, kick]); // the rack order is kick, clap
    A.setLayer(L, 'Layer random', (l) => { l.random = true; });
    A.setLayer(L, 'Crossfade level', (l) => { l.fade = 33; });
    store.update('Notes', (d) => {
      d.patterns[0].notes[L] = [createNote({ pos: 24, len: 0 })];
      d.patterns[0].notes[kick] = [createNote({ pos: 0, len: 0 }), createNote({ pos: 48, len: 0 })];
    });
    const before = store.project.channels.length;
    A.cloneChannel(L);
    const order = store.project.channels.map((c) => c.id);
    const i = order.indexOf(L);
    const copy = ch(order[i + 1]);
    expect(copy.kind).toBe('layer');
    expect(copy.name).toBe('Layer #2');
    expect(copy.layer).toMatchObject({ random: true, sequential: false, crossfade: false, fade: 33 });
    // the copies follow the layer's copy, in the stored order, and are its children; the original is untouched
    expect(names(kids(copy.id))).toEqual(['Kick #2', 'Clap #2']);
    expect(order.slice(i + 2, i + 4)).toEqual(kids(copy.id));
    expect(kids(L)).toEqual([kick, clap]);
    expect(kids(copy.id).some((k) => k === kick || k === clap)).toBe(false);
    // notes of the layer and of its children are copied
    const notes = store.project.patterns[0].notes;
    expect(notes[copy.id]?.length).toBe(1);
    expect(notes[kids(copy.id)[0]]?.length).toBe(2);
    expect(notes[kids(copy.id)[1]]).toBeUndefined();
    expect(store.project.channels.length).toBe(before + 3);
    // a channel belongs to one layer
    expect(normalizeProject(JSON.parse(JSON.stringify(store.project))).channels.find((c) => c.id === copy.id)!.layer!.children).toEqual(kids(copy.id));
    store.undo();
    expect(store.project.channels.length).toBe(before);
    expect(kids(L)).toEqual([kick, clap]);
  });

  it('a sample dropped on a layer with Shift becomes a new child channel; Show children brings up the Channel rack', () => {
    const [kick, clap, hat, snare] = fresh();
    const L = A.addLayerChannel();
    A.setLayerChildren(L, [kick, hat]);
    const id = A.addLayerChild(L, 'Snare hit', 'sample:x')!;
    const order = store.project.channels.map((c) => c.id);
    expect(ch(id).kind).toBe('sampler');
    expect(ch(id).name).toBe('Snare hit');
    expect(ch(id).sampler.sampleId).toBe('sample:x');
    expect(kids(L)).toEqual([kick, hat, id]);
    expect(order.indexOf(id)).toBe(order.indexOf(hat) + 1); // right below the last child
    expect(store.ui.selectedChannels).toEqual([id]);
    expect(store.historyLabels().past.at(-1)).toBe('Add child channel');
    store.undo();
    expect(kids(L)).toEqual([kick, hat]);
    expect(store.project.channels.some((c) => c.id === id)).toBe(false);
    // no children yet: the new channel goes right below the layer
    const L2 = A.addLayerChannel();
    const first = A.addLayerChild(L2, 'One', null)!;
    const o2 = store.project.channels.map((c) => c.id);
    expect(o2.indexOf(first)).toBe(o2.indexOf(L2) + 1);
    expect(A.addLayerChild(kick, 'x', null)).toBeNull(); // not a layer
    // Show children shows the Channel rack if it is hidden
    store.updateUi((u) => { u.windows['channelRack'].open = false; });
    A.showLayerChildren(L);
    expect(store.ui.windows['channelRack'].open).toBe(true);
    expect(store.ui.selectedChannels).toEqual([kick, hat]);
    expect([clap, snare].length).toBe(2);
  });

  it('every edit is one undo step; fade edits made together merge', () => {
    const [kick] = fresh();
    const L = A.addLayerChannel();
    A.setLayerChildren(L, [kick]);
    A.setLayer(L, 'Layer sequential', (l) => { l.sequential = true; });
    expect(store.historyLabels().past.at(-1)).toBe('Layer sequential');
    A.setLayer(L, 'Crossfade level', (l) => { l.fade = 10; });
    A.setLayer(L, 'Crossfade level', (l) => { l.fade = 20; });
    expect(ch(L).layer!.fade).toBe(20);
    store.undo();
    expect(ch(L).layer!.fade).toBe(0);
    expect(ch(L).layer!.sequential).toBe(true);
    store.undo();
    expect(ch(L).layer!.sequential).toBe(false);
    store.redo();
    store.redo();
    expect(ch(L).layer!.fade).toBe(20);
  });

  it('FADE and the header controls are automation and link targets', async () => {
    const [kick] = fresh();
    const L = A.addLayerChannel();
    A.setLayerChildren(L, [kick]);
    A.setLayer(L, 'Crossfade level', (l) => { l.fade = 192; });
    const target: AutomationTarget = { scope: 'channel', id: L, path: 'layer.fade', min: 0, max: 256, step: 1, label: 'Crossfade level' };
    expect(A.readTarget(store.project, target)).toBe(192);
    expect(A.automationName(store.project, target)).toBe('Layer - Crossfade level');
    const clip = A.createAutomationClip(target);
    const a = store.project.automation.find((x) => x.id === clip)!;
    expect(a.name).toBe('Layer - Crossfade level');
    expect(a.points[0].value).toBeCloseTo(192 / 256, 12);
    expect(a.color).toBe(LAYER_COLOR); // the clip takes its channel's colour
    // the channel's own knobs work the same way as on any channel
    for (const [path, label] of [['volume', 'Channel volume'], ['pan', 'Channel panning'], ['pitch', 'Channel pitch']] as const) {
      expect(A.automationName(store.project, { scope: 'channel', id: L, path, min: 0, max: 1, label: 'x' })).toBe(`Layer - ${label}`);
    }
    // links: FADE follows a controller; replacing the layer drops the link, the channel's own links stay
    const volTarget: AutomationTarget = { scope: 'channel', id: L, path: 'volume', min: 0, max: 1, label: 'Layer - Volume' };
    A.linkToController(target, { slotId: 'ch:' + kick, output: 0 });
    A.linkToController(volTarget, { slotId: 'ch:' + kick, output: 0 });
    expect(A.isLinked(target)).toBe(true);
    A.replaceGenerator(L, { kind: 'sampler' });
    expect(A.isLinked(target)).toBe(false);
    expect(A.isLinked(volTarget)).toBe(true);
  });

  it('saves and loads layers (children order, flags, fade); old projects stay valid', () => {
    const [kick, clap, hat, snare] = fresh();
    const L = A.addLayerChannel();
    A.setLayerChildren(L, [snare, kick, hat]); // rack order: kick, hat, snare
    A.setLayer(L, 'Layer sequential', (l) => { l.sequential = true; });
    A.setLayer(L, 'Layer crossfade', (l) => { l.crossfade = true; });
    A.setLayer(L, 'Crossfade level', (l) => { l.fade = 77; });
    A.setSampler(L, 'Root note', (d) => { d.rootKey = 64; d.keyLo = 48; d.keyHi = 80; d.fineTune = 12; d.adjVol = 0.3; });
    const saved = JSON.parse(JSON.stringify(store.project)) as Project;
    const p = normalizeProject(saved);
    const l = p.channels.find((c) => c.id === L)!;
    expect(l.kind).toBe('layer');
    expect(l.layer).toEqual({ children: [kick, hat, snare], random: false, sequential: true, crossfade: true, fade: 77 });
    expect(l.sampler.rootKey).toBe(64);
    expect(l.sampler.fineTune).toBe(12);
    expect(l.volume).toBe(1);
    expect(p.channels).toEqual(store.project.channels);
    // a project saved before layers existed
    const old = JSON.parse(JSON.stringify(createDefaultProject({}, {}))) as Project;
    for (const c of old.channels) { delete (c as Partial<Channel>).layer; }
    const loaded = normalizeProject(old);
    expect(loaded.channels.map((c) => c.kind)).toEqual(['sampler', 'sampler', 'sampler', 'sampler']);
    expect(clap).toBeDefined();
    // saving a deleted child leaves no dangling id
    A.deleteChannels([snare]);
    expect(normalizeProject(JSON.parse(JSON.stringify(store.project))).channels.find((c) => c.id === L)!.layer!.children).toEqual([kick, hat]);
  });
});

// ================================================================== the engine
describe('Layer engine: pattern notes', () => {
  it('hands every note to every child at the same frame, with the same key, velocity, release velocity, colour, pan, fine, mod X / Y and length', () => {
    const s = scene(2);
    startPattern(s.e, { [s.layer.id]: [
      { pos: 30, len: 12, key: 64, vel: 90, rel: 40, pan: 100, fine: 130, modX: 200, modY: 50, color: 3 },
      { pos: 96, len: 0, key: 67 }, // a step: one step long
    ] });
    s.e.renderOffline(SR);
    for (const r of s.recs) {
      expect(r.events.map((e) => [e.kind, e.key, e.frame])).toEqual([
        ['on', 64, 7500], ['off', 64, 10500], ['on', 67, 24000], ['off', 67, 30000],
      ]);
      const [a, , b] = r.events;
      expect([a.velocity, a.release, a.color, a.length]).toEqual([90, 40, 3, 3000]);
      expect(a.init.vol).toBeCloseTo(velocityGain(90), 9);
      expect(a.init.pan).toBeCloseTo((100 - 64) / 64, 9);
      expect(a.init.pitch).toBeCloseTo(PITCH_C5 + 400 + 100, 9); // key 64, fine +10
      expect(a.init.fcut).toBeCloseTo((200 - 128) / 128, 9);
      expect(a.init.fres).toBeCloseTo((50 - 128) / 128, 9);
      expect([b.velocity, b.release, b.length]).toEqual([100, 64, 6000]);
    }
    expect(s.recs[0].events).toEqual(s.recs[1].events);
  });

  it('plays a child like a note on the child itself (the same events and levels)', () => {
    const notes: Partial<Note>[] = [
      { pos: 0, len: 12, key: 60 }, { pos: 24, len: 30, key: 55, vel: 40, pan: 20 }, { pos: 100, len: 0, key: 72, slide: false, porta: true },
    ];
    const viaLayer = scene(1);
    startPattern(viaLayer.e, { [viaLayer.layer.id]: notes });
    viaLayer.e.renderOffline(SR);
    Rec.all = [];
    const e = engine();
    const direct = rec();
    e.handle({ t: 'channel', c: direct });
    startPattern(e, { [direct.id]: notes });
    e.renderOffline(SR);
    expect(Rec.all[0].events.length).toBe(6);
    expect(viaLayer.recs[0].events).toEqual(Rec.all[0].events);
    expect(viaLayer.recs[0].trail.map((x) => x.levels)).toEqual(Rec.all[0].trail.map((x) => x.levels));
  });

  it('keeps every note on its frame across many blocks (chains of events)', () => {
    const s = scene(2);
    const N = 240;
    // a note on every tick: frames 0, 250, 500...: they fall on every offset of the 128-frame blocks
    startPattern(s.e, { [s.layer.id]: Array.from({ length: N }, (_, i) => ({ pos: i, len: 1, key: 40 + (i % 24) })) });
    s.e.renderOffline(N * TICK + 1000);
    for (const r of s.recs) {
      expect(r.ons.map((x) => x.frame)).toEqual(Array.from({ length: N }, (_, i) => i * TICK));
      expect(r.ons.map((x) => x.key)).toEqual(Array.from({ length: N }, (_, i) => 40 + (i % 24)));
      expect(r.events.filter((x) => x.kind === 'off').map((x) => x.frame)).toEqual(Array.from({ length: N }, (_, i) => (i + 1) * TICK));
    }
    // a note exactly on a block boundary (tick 64 = frame 16000 = block 125)
    const b = scene(1);
    startPattern(b.e, { [b.layer.id]: [{ pos: 64, len: 2 }] });
    b.e.renderOffline(20000);
    expect(b.recs[0].events.map((x) => [x.kind, x.frame])).toEqual([['on', 16000], ['off', 16500]]);
  });

  it('children created after the layer, or removed, are found when a note plays', () => {
    Rec.all = [];
    const e = engine();
    const k1 = rec('K1');
    const k2 = rec('K2');
    const layer = createLayerChannel();
    layer.layer!.children = [k1.id, k2.id];
    e.handle({ t: 'channel', c: layer });
    e.handle({ t: 'channel', c: k1 });
    startPattern(e, { [layer.id]: [{ pos: 0, len: 6 }, { pos: 24, len: 6 }] });
    e.renderOffline(3000); // only K1 exists yet
    e.handle({ t: 'channel', c: k2 });
    e.renderOffline(4000);
    e.handle({ t: 'channelRemove', id: k1.id });
    e.renderOffline(SR);
    const [r1, r2] = Rec.all;
    expect(r1.ons.map((x) => x.frame)).toEqual([0, 6000]);
    expect(r2.ons.map((x) => x.frame)).toEqual([3000]); // 6000 on the engine's clock; K2's recorder counts from its creation at 3000
  });

  it('a layer is no child (nothing loops), and an unknown child is ignored', () => {
    Rec.all = [];
    const e = engine();
    const a = createLayerChannel('A');
    const b = createLayerChannel('B');
    a.layer!.children = [b.id, 'ghost', a.id];
    b.layer!.children = [a.id];
    e.handle({ t: 'channel', c: a });
    e.handle({ t: 'channel', c: b });
    startPattern(e, { [a.id]: [{ pos: 0, len: 6 }], [b.id]: [{ pos: 0, len: 6 }] });
    expect(() => e.renderOffline(SR)).not.toThrow();
    noteOn(e, a, 60, 1);
    noteOff(e, a, 60, 1);
    e.renderOffline(1000);
    expect(Rec.all.length).toBe(0);
  });
});

describe('Layer engine: Random, Sequential, Crossfade', () => {
  it('Random plays exactly one random child per note (injected random numbers)', () => {
    const rolls = [0.0, 0.5, 0.99, 0.34, 0.67, 0.2];
    const s = scene(3, { random: () => rolls.shift()!, layer: (l) => { l.layer!.random = true; } });
    startPattern(s.e, { [s.layer.id]: rolls.map((_, i) => ({ pos: i * 24, len: 6, key: 60 + i })) });
    s.e.renderOffline(7 * 6000);
    // each note went to exactly one child: the one its roll chose (floor(roll x 3): 0, 1, 2, 1, 2, 0)
    expect(s.recs.map((r) => r.ons.map((x) => x.key))).toEqual([[60, 65], [61, 63], [62, 64]]);
    expect(s.recs.reduce((n, r) => n + r.ons.length, 0)).toBe(6);
    expect(rolls.length).toBe(0); // one roll per note, nothing more
    // the notes keep their frames
    expect(s.recs[1].ons.map((x) => x.frame)).toEqual([6000, 18000]);
  });

  it('Random picks among the children that exist', () => {
    let r = 0.99;
    const s = scene(3, { random: () => r, layer: (l) => { l.layer!.random = true; } });
    s.e.handle({ t: 'channelRemove', id: s.kids[2].id });
    noteOn(s.e, s.layer, 60, 1);
    noteOff(s.e, s.layer, 60, 1);
    s.e.renderOffline(512);
    // 0.99 x 2 children -> the second child (the third is gone)
    expect(s.recs.map((x) => x.ons.length)).toEqual([0, 1, 0]);
    r = 0;
    noteOn(s.e, s.layer, 62, 2);
    s.e.renderOffline(256);
    expect(s.recs.map((x) => x.ons.length)).toEqual([1, 1, 0]);
  });

  it('Sequential plays the children in turn in the stored order, and starts over when the children change', () => {
    const s = scene(3, { layer: (l) => { l.layer!.sequential = true; } });
    startPattern(s.e, { [s.layer.id]: Array.from({ length: 7 }, (_, i) => ({ pos: i * 24, len: 6, key: 60 + i })) });
    s.e.renderOffline(8 * 6000);
    expect(s.recs.map((r) => r.ons.map((x) => x.key))).toEqual([[60, 63, 66], [61, 64], [62, 65]]);
    s.e.handle({ t: 'pause' });
    // Set children again, in another order: the next note goes to the first child of the new list
    s.e.handle({ t: 'channel', c: withLayer(s.layer, { children: [s.kids[2].id, s.kids[0].id, s.kids[1].id] }) });
    noteOn(s.e, s.layer, 70, 1);
    noteOff(s.e, s.layer, 70, 1);
    noteOn(s.e, s.layer, 71, 2);
    noteOff(s.e, s.layer, 71, 2);
    s.e.renderOffline(1024);
    expect(s.recs[2].ons.map((x) => x.key)).toEqual([62, 65, 70]);
    expect(s.recs[0].ons.map((x) => x.key)).toEqual([60, 63, 66, 71]);
  });

  it('slide notes go to every child (the one that sounds slides) and take no turn', () => {
    const s = scene(3, { layer: (l) => { l.layer!.sequential = true; } });
    startPattern(s.e, { [s.layer.id]: [
      { pos: 0, len: 48, key: 60 }, // child 1
      { pos: 12, len: 24, key: 62, slide: true },
      { pos: 24, len: 24, key: 64 }, // child 2 (the slide took no turn)
    ] });
    s.e.renderOffline(5 * 6000);
    expect(s.recs.map((r) => r.ons.map((x) => x.key))).toEqual([[60], [64], []]);
    // the sounding note glides up two semitones over the slide note's length; the others do not move
    const first = s.recs[0].trail.filter((x) => x.t >= 9000 && x.t < 12000);
    expect(first.length).toBeGreaterThan(0);
    for (const x of first) expect(x.levels.pitch).toBeCloseTo(PITCH_C5 + 200, 6);
    expect(s.recs[1].trail.every((x) => Math.abs(x.levels.pitch - (PITCH_C5 + 400)) < 1e-6)).toBe(true);
  });

  it('Crossfade: the FADE level sets each child\'s gain, live while a note sounds', () => {
    const s = scene(3, { layer: (l) => { l.layer!.crossfade = true; } });
    noteOn(s.e, s.layer, 60, 1);
    // every child plays the note (even at gain 0), so the FADE wheel can bring it in later
    s.e.renderOffline(256);
    expect(s.recs.map((r) => r.ons.length)).toEqual([1, 1, 1]);
    const vol = () => s.recs.map((r) => r.lv.vol);
    const gains = (fade: number) => [0, 1, 2].map((i) => crossfadeGain(i, 3, fade));
    for (const fade of [0, 64, 128, 192, 256, 33]) {
      s.e.handle({ t: 'channel', c: withLayer(s.layer, { fade }) });
      s.e.renderOffline(128);
      vol().forEach((v, i) => expect(v).toBeCloseTo(gains(fade)[i], 9));
    }
    // crossfade off: every child at full level whatever the wheel says
    s.e.handle({ t: 'channel', c: withLayer(s.layer, { crossfade: false, fade: 128 }) });
    s.e.renderOffline(128);
    expect(vol()).toEqual([1, 1, 1]);
  });

  it('Crossfade works with the other modes (a random child at its crossfade level)', () => {
    const s = scene(2, { random: () => 0.9, layer: (l) => { Object.assign(l.layer!, { random: true, crossfade: true, fade: 0 }); } });
    startPattern(s.e, { [s.layer.id]: [{ pos: 0, len: 6 }] });
    s.e.renderOffline(2000);
    // the random pick is child 2, which sits at gain 0 at FADE 0
    expect(s.recs[0].ons.length).toBe(0);
    expect(s.recs[1].ons.length).toBe(1);
    expect(s.recs[1].trail[0].levels.vol).toBe(0);
  });
});

describe('Layer engine: levels adjustment', () => {
  it('the layer\'s VOL, PAN, PITCH, fine tune, MOD X / Y and levels adjustment reach its notes only', () => {
    const near = (lv: GenLevels, w: GenLevels) => (['vol', 'pan', 'pitch', 'fcut', 'fres'] as const).forEach((k) => expect(lv[k], k).toBeCloseTo(w[k], 9));
    const s = scene(2, {
      layer: (l) => {
        l.volume = 0.5; l.pan = 0.5; l.pitch = 0.5; // pitch range 2: +100 cents
        Object.assign(l.sampler, { adjVol: 0.25, adjPan: 0.25, adjModX: 0.3, adjModY: -0.2, fineTune: 20 });
      },
    });
    // the layer plays key 60 at beat 0; a child plays its own step at beat 1, the same voice slot is reused
    startPattern(s.e, { [s.layer.id]: [{ pos: 0, len: 6, key: 60 }], [s.kids[0].id]: [{ pos: 96, len: 6, key: 60 }] });
    s.e.renderOffline(60000);
    const gain = channelVolumeToGain(0.5) * adjVolGain(0.25);
    for (const r of s.recs) {
      const lv = r.trail.find((x) => x.t < 1000)!.levels;
      expect(lv.vol).toBeCloseTo(gain, 9);
      expect(lv.pan).toBeCloseTo(0.75, 9);
      expect(lv.pitch).toBeCloseTo(PITCH_C5 + 120, 9);
      expect(lv.fcut).toBeCloseTo(0.3, 9);
      expect(lv.fres).toBeCloseTo(-0.2, 9);
      // the notes themselves are untouched
      expect(r.ons[0].velocity).toBe(100);
      expect(r.ons[0].init.pitch).toBe(PITCH_C5);
    }
    // the child's own step: no layer levels (and no stale levels from the reused voice)
    near(s.recs[0].trail.find((x) => x.t >= 24000)!.levels, { vol: 1, pan: 0, pitch: PITCH_C5, fcut: 0, fres: 0 });
    expect(s.recs[0].ons.map((x) => x.frame)).toEqual([0, 24000]);
    expect(s.recs[1].ons.map((x) => x.frame)).toEqual([0]);
  });

  it('adds to the child\'s own levels (volume multiplies, pan and mod add up, clamped like its own)', () => {
    const s = scene(1, {
      layer: (l) => { l.volume = 0.5; l.pan = -0.5; Object.assign(l.sampler, { adjModX: 0.1 }); },
      kid: (c) => { c.volume = 0.6; c.pan = -0.75; Object.assign(c.sampler, { adjModX: 0.2, adjVol: 0.5 }); },
    });
    startPattern(s.e, { [s.layer.id]: [{ pos: 0, len: 6, key: 60, vel: 64 }] });
    s.e.renderOffline(2000);
    const lv = s.recs[0].trail[0].levels;
    expect(lv.vol).toBeCloseTo(channelVolumeToGain(0.6) * velocityGain(64) * channelVolumeToGain(0.5), 9);
    expect(lv.pan).toBeCloseTo(-1, 9); // -0.75 + -0.5, clamped to the left
    expect(lv.fcut).toBeCloseTo(0.3, 9);
  });

  it('sounding voices follow the layer\'s controls (live, like FL\'s parent channel levels)', () => {
    const s = scene(1);
    noteOn(s.e, s.layer, 60, 1);
    s.e.renderOffline(256);
    expect(s.recs[0].lv.vol).toBe(1);
    expect(s.recs[0].lv.pitch).toBe(PITCH_C5);
    s.e.handle({ t: 'channel', c: { ...s.layer, volume: 0.4, pan: -0.6, pitch: -1, sampler: { ...s.layer.sampler, adjModY: 0.5 } } });
    s.e.renderOffline(128);
    const lv = s.recs[0].lv;
    expect(lv.vol).toBeCloseTo(channelVolumeToGain(0.4), 9);
    expect(lv.pan).toBeCloseTo(-0.6, 9);
    expect(lv.pitch).toBeCloseTo(PITCH_C5 - 200, 9); // -1 x range 2
    expect(lv.fres).toBeCloseTo(0.5, 9);
    // the range changes what the knob means
    s.e.handle({ t: 'channel', c: { ...s.layer, pitch: -1, sampler: { ...s.layer.sampler, pitchRange: 12 } } });
    s.e.renderOffline(128);
    expect(s.recs[0].lv.pitch).toBeCloseTo(PITCH_C5 - 1200, 9);
  });

  it('voice instruments (per-note voices) see the layer\'s levels too, live', () => {
    DcGen.all = [];
    const e = engine();
    const kid = genChannel('test-dc');
    const layer = createLayerChannel();
    layer.layer!.children = [kid.id];
    Object.assign(layer, { volume: 0.5, pan: 0.5, pitch: 1 });
    layer.sampler.pitchRange = 12;
    e.handle({ t: 'channel', c: kid });
    e.handle({ t: 'channel', c: layer });
    noteOn(e, layer, 60, 1);
    e.renderOffline(512);
    const voice = DcGen.all[0].voices[0];
    const first = voice.levels[0];
    expect(first[1]).toBeCloseTo(PITCH_C5 + 1200, 9); // pitch
    expect(first[2]).toBeCloseTo(channelVolumeToGain(0.5), 9); // vol
    expect(first[3]).toBeCloseTo(0.5, 9); // pan
    // the voice follows the layer's knob
    e.handle({ t: 'channel', c: { ...layer, volume: 1 } });
    e.renderOffline(128);
    expect(voice.levels[voice.levels.length - 1][2]).toBeCloseTo(1, 9);
    noteOff(e, layer, 60, 1);
    e.renderOffline(256);
    expect(voice.releasedAt).toBeGreaterThan(0);
  });

  it('a Sampler child plays quieter, panned and re-pitched through the layer (the real voice source)', () => {
    const ramp = new Float32Array(20000);
    for (let i = 0; i < ramp.length; i++) ramp[i] = 0.3 + i * 1e-5; // a slow ramp: the pitch shows in the slope
    const render = (layer: (l: Channel) => void, viaLayer: boolean) => {
      const e = engine();
      e.handle({ t: 'interp', mode: 'linear' });
      e.handle({ t: 'sample', id: 'ramp', data: [ramp], sampleRate: SR });
      const kid = createChannel('S', 'ramp');
      kid.volume = 1;
      e.handle({ t: 'channel', c: kid });
      const l = createLayerChannel();
      l.layer!.children = [kid.id];
      layer(l);
      e.handle({ t: 'channel', c: l });
      startPattern(e, { [viaLayer ? l.id : kid.id]: [{ pos: 0, len: 12 }] });
      return e.renderOffline(4000);
    };
    const [dl, dr] = render(() => {}, false);
    const [ll, lr] = render(() => {}, true);
    // an untouched layer is transparent
    for (let i = 0; i < 4000; i += 97) { expect(ll[i]).toBeCloseTo(dl[i], 9); expect(lr[i]).toBeCloseTo(dr[i], 9); }
    // VOL 50% x levels VOL 25%
    const [vl, vr] = render((l) => { l.volume = 0.5; l.sampler.adjVol = 0.25; }, true);
    const k = channelVolumeToGain(0.5) * adjVolGain(0.25);
    expect(vl[500] / dl[500]).toBeCloseTo(k, 6);
    expect(vr[500] / dr[500]).toBeCloseTo(k, 6);
    // PAN hard left: the left side gains 1 / cos(pi/4), the right side is silent
    const [pl, pr] = render((l) => { l.pan = -1; }, true);
    expect(pl[500] / dl[500]).toBeCloseTo(Math.SQRT2, 6);
    expect(Math.abs(pr[500])).toBeLessThan(1e-9);
    // PITCH +1 octave (knob 1 x range 12): the sample plays at double speed
    const [ol] = render((l) => { l.pitch = 1; l.sampler.pitchRange = 12; }, true);
    const slope = (b: Float32Array) => (b[1500] - b[500]) / 1000;
    expect(slope(ol) / slope(dl)).toBeCloseTo(2, 3);
  });
});

describe('Layer engine: live notes', () => {
  it('plays live notes on every child until the note off, with the same frames', () => {
    const s = scene(2);
    noteOn(s.e, s.layer, 65, 1, 90);
    s.e.renderOffline(256);
    noteOff(s.e, s.layer, 65, 1);
    s.e.renderOffline(256);
    noteOn(s.e, s.layer, 67, 2);
    s.e.renderOffline(128);
    for (const r of s.recs) {
      expect(r.events.map((e) => [e.kind, e.key, e.frame])).toEqual([['on', 65, 0], ['off', 65, 256], ['on', 67, 512]]);
      expect(r.events[0].velocity).toBe(90);
      expect(r.events[0].length).toBe(Infinity);
    }
    expect(s.e.layers.get(s.layer.id)!.isActive()).toBe(true);
    noteOff(s.e, s.layer, 67, 2);
    expect(s.e.layers.get(s.layer.id)!.isActive()).toBe(false);
  });

  it('a note off releases the children that note started, even when the children changed meanwhile', () => {
    const s = scene(3, { layer: (l) => { l.layer!.sequential = true; } });
    noteOn(s.e, s.layer, 60, 1); // child 1
    noteOn(s.e, s.layer, 62, 2); // child 2
    s.e.renderOffline(128);
    // the layer is told its children changed: child 2 is no child any more
    s.e.handle({ t: 'channel', c: withLayer(s.layer, { children: [s.kids[0].id] }) });
    noteOff(s.e, s.layer, 62, 2);
    noteOff(s.e, s.layer, 60, 1);
    s.e.renderOffline(128);
    expect(s.recs[0].events.map((e) => [e.kind, e.key, e.frame])).toEqual([['on', 60, 0], ['off', 60, 128]]);
    expect(s.recs[1].events.map((e) => [e.kind, e.key, e.frame])).toEqual([['on', 62, 0], ['off', 62, 128]]);
    // an off without a note (or for another key) does nothing
    noteOff(s.e, s.layer, 62, 2);
    noteOn(s.e, s.layer, 64, 3);
    noteOff(s.e, s.layer, 65, 3);
    s.e.renderOffline(128);
    expect(s.recs[0].events.filter((e) => e.kind === 'off').length).toBe(1);
  });

  it('stop, pause and seek release what the layer started; panic stops the children', () => {
    const s = scene(2);
    noteOn(s.e, s.layer, 60, 1);
    s.e.renderOffline(256);
    s.e.handle({ t: 'pause' });
    s.e.renderOffline(128);
    for (const r of s.recs) expect(r.events.map((e) => [e.kind, e.frame])).toEqual([['on', 0], ['off', 256]]);
    expect(s.e.layers.get(s.layer.id)!.isActive()).toBe(false);
    noteOn(s.e, s.layer, 62, 2);
    s.e.renderOffline(128);
    s.e.handle({ t: 'seek', tick: 48 });
    s.e.renderOffline(128);
    for (const r of s.recs) expect(r.events.at(-1)).toMatchObject({ kind: 'off', key: 62, frame: 512 });
    // the host's late note off finds nothing to release
    noteOff(s.e, s.layer, 62, 2);
    s.e.renderOffline(128);
    for (const r of s.recs) expect(r.events.filter((e) => e.kind === 'off').length).toBe(2);
    // panic
    noteOn(s.e, s.layer, 64, 3);
    s.e.renderOffline(128);
    s.e.handle({ t: 'allNotesOff' });
    s.e.renderOffline(128);
    for (const r of s.recs) expect(r.events.at(-1)).toMatchObject({ kind: 'kill', key: 64 });
    noteOff(s.e, s.layer, 64, 3);
    s.e.renderOffline(128);
    for (const r of s.recs) expect(r.events.filter((e) => e.key === 64).length).toBe(2); // on, kill: no stray off
  });

  it('stopping the transport releases the pattern notes the layer handed on', () => {
    const s = scene(2);
    startPattern(s.e, { [s.layer.id]: [{ pos: 0, len: 96, key: 50 }] });
    s.e.renderOffline(1000);
    s.e.handle({ t: 'stop' });
    s.e.renderOffline(256);
    for (const r of s.recs) expect(r.events.map((e) => [e.kind, e.key, e.frame])).toEqual([['on', 50, 0], ['off', 50, 1000]]);
  });

  it('removing or replacing the layer releases its live notes', () => {
    const s = scene(2);
    noteOn(s.e, s.layer, 60, 1);
    s.e.renderOffline(128);
    s.e.handle({ t: 'channel', c: { ...s.layer, kind: 'sampler' as const } });
    s.e.renderOffline(128);
    for (const r of s.recs) expect(r.events.map((e) => [e.kind, e.frame])).toEqual([['on', 0], ['off', 128]]);
    expect(s.e.layers.size).toBe(0);
    const s2 = scene(1);
    noteOn(s2.e, s2.layer, 60, 1);
    s2.e.renderOffline(128);
    s2.e.handle({ t: 'channelRemove', id: s2.layer.id });
    s2.e.renderOffline(128);
    expect(s2.recs[0].events.map((e) => [e.kind, e.frame])).toEqual([['on', 0], ['off', 128]]);
  });

  it('the layer\'s key region filters its notes (live and pattern)', () => {
    const s = scene(1, { layer: (l) => { l.sampler.keyLo = 60; l.sampler.keyHi = 71; } });
    startPattern(s.e, { [s.layer.id]: [59, 60, 71, 72].map((key, i) => ({ pos: i * 24, len: 6, key })) });
    s.e.renderOffline(5 * 6000);
    expect(s.recs[0].ons.map((x) => x.key)).toEqual([60, 71]);
    noteOn(s.e, s.layer, 50, 1);
    noteOn(s.e, s.layer, 65, 2);
    s.e.renderOffline(256);
    expect(s.recs[0].ons.map((x) => x.key)).toEqual([60, 71, 65]);
    // a rejected live note leaves nothing to release
    noteOff(s.e, s.layer, 50, 1);
    noteOff(s.e, s.layer, 65, 2);
    s.e.renderOffline(128);
    expect(s.recs[0].events.filter((e) => e.kind === 'off' && e.key === 50).length).toBe(0);
  });
});

describe('Layer engine: ON switches and the children\'s own settings', () => {
  it('a muted layer plays no pattern notes; live notes still play, as for any instrument channel', () => {
    const s = scene(2, { layer: (l) => { l.enabled = false; } });
    startPattern(s.e, { [s.layer.id]: [{ pos: 0, len: 6 }, { pos: 24, len: 6 }] });
    s.e.renderOffline(3 * 6000);
    expect(s.recs.map((r) => r.events.length)).toEqual([0, 0]);
    noteOn(s.e, s.layer, 60, 1);
    s.e.renderOffline(256);
    noteOff(s.e, s.layer, 60, 1);
    s.e.renderOffline(128);
    expect(s.recs.map((r) => r.ons.length)).toEqual([1, 1]);
    // switching it on again: the pattern plays through the children
    s.e.handle({ t: 'channel', c: { ...s.layer, enabled: true } });
    s.e.handle({ t: 'seek', tick: 0 });
    s.e.handle({ t: 'play' });
    s.e.renderOffline(3 * 6000);
    expect(s.recs.map((r) => r.ons.length)).toEqual([3, 3]);
  });

  it('a child plays the layer\'s notes whatever its own ON switch says (the switch gates its own steps and piano roll)', () => {
    const s = scene(2, { kid: (c, i) => { c.enabled = i !== 0; } });
    startPattern(s.e, { [s.layer.id]: [{ pos: 0, len: 6 }], [s.kids[0].id]: [{ pos: 48, len: 6 }], [s.kids[1].id]: [{ pos: 48, len: 6 }] });
    s.e.renderOffline(2 * 24000);
    expect(s.recs[0].ons.map((x) => x.frame)).toEqual([0]); // via the layer only
    expect(s.recs[1].ons.map((x) => x.frame)).toEqual([0, 12000]);
  });

  it('the children\'s key ranges and root keys apply (Split children: one child per key at its original pitch)', () => {
    const s = scene(3);
    const chans = [...s.kids, s.layer];
    splitChildren(chans, s.layer.id);
    for (const k of s.kids) s.e.handle({ t: 'channel', c: { ...k } });
    startPattern(s.e, { [s.layer.id]: [60, 61, 62, 63].map((key, i) => ({ pos: i * 24, len: 6, key })) });
    s.e.renderOffline(5 * 6000);
    expect(s.recs.map((r) => r.ons.map((x) => x.key))).toEqual([[60], [61], [62]]); // key 63 has no child
    for (const r of s.recs) expect(r.ons[0].init.pitch).toBe(PITCH_C5); // original pitch
    // Reset children: every child plays every note again, pitched by the key
    resetChildren(chans, s.layer.id);
    for (const k of s.kids) s.e.handle({ t: 'channel', c: { ...k } });
    s.e.handle({ t: 'seek', tick: 0 });
    s.e.handle({ t: 'play' });
    s.e.renderOffline(5 * 6000);
    for (const r of s.recs) {
      expect(r.ons.slice(-4).map((x) => x.key)).toEqual([60, 61, 62, 63]);
      expect(r.ons.slice(-4).map((x) => x.init.pitch)).toEqual([0, 100, 200, 300].map((c) => PITCH_C5 + c));
    }
  });

  it('a child\'s own time shift, echo delay and cut groups apply to the layer\'s notes', () => {
    // SHIFT: half a step later
    const a = scene(1, { kid: (c) => { c.sampler.shift = 0.5; } });
    startPattern(a.e, { [a.layer.id]: [{ pos: 0, len: 6 }] });
    a.e.renderOffline(8000);
    expect(a.recs[0].ons.map((x) => x.frame)).toEqual([3000]);
    // echo: two echoes a step apart
    const b = scene(1, { kid: (c) => { Object.assign(c.sampler.echo, { feed: 0.4, count: 2, time: 1 }); } });
    startPattern(b.e, { [b.layer.id]: [{ pos: 0, len: 6 }] });
    b.e.renderOffline(20000);
    expect(b.recs[0].ons.map((x) => x.frame)).toEqual([0, 6000, 12000]);
    // cut groups: the closed hat child cuts the open hat child (Sequential: open hat first, then closed)
    const c = scene(2, {
      layer: (l) => { l.layer!.sequential = true; },
      kid: (k, i) => { if (i === 0) k.sampler.cutBy = 1; else k.sampler.cutGroup = 1; },
    });
    startPattern(c.e, { [c.layer.id]: [{ pos: 0, len: 96 }, { pos: 24, len: 96 }] });
    c.e.renderOffline(12000);
    expect(c.recs[0].events.map((x) => [x.kind, x.frame])).toEqual([['on', 0], ['off', 6000]]);
    expect(c.recs[1].ons.map((x) => x.frame)).toEqual([6000]);
  });

  it('a child\'s arpeggiator keeps playing a live chord at the layer\'s levels', () => {
    const s = scene(1, {
      layer: (l) => { l.volume = 0.5; },
      kid: (k) => { Object.assign(k.sampler.arp, { direction: 'up', time: 1, gate: 1 }); },
    });
    noteOn(s.e, s.layer, 60, 1);
    noteOn(s.e, s.layer, 64, 2);
    noteOn(s.e, s.layer, 67, 3);
    s.e.renderOffline(20000);
    const ons = s.recs[0].ons;
    expect(ons.map((x) => x.key)).toEqual([60, 64, 67, 60]); // one arpeggio note per step
    expect(ons.map((x) => x.frame)).toEqual([0, 6000, 12000, 18000]);
    for (const x of s.recs[0].trail.filter((t) => t.levels.vol !== 0)) expect(x.levels.vol).toBeCloseTo(channelVolumeToGain(0.5), 9);
    // the notes off clear the arpeggiator
    for (const t of [1, 2, 3]) noteOff(s.e, s.layer, [0, 60, 64, 67][t], t);
    s.e.renderOffline(20000);
    expect(s.recs[0].ons.length).toBe(4);
  });

  it('a MIDI Out can be a child: its notes go out on its port', () => {
    type Ev = [string, number, number];
    class Port implements EffectInstance {
      static ev: Ev[] = [];
      t = 0;
      setParams(): void {}
      process(_L: Float32Array, _R: Float32Array, n: number): void { this.t += n; }
      reset(): void {}
      noteOn(key: number, _v: number, off: number): void { Port.ev.push(['on', key, this.t + off]); }
      noteOff(key: number, off: number): void { Port.ev.push(['off', key, this.t + off]); }
      midiPorts(): number[] { return []; }
      setMidiPort(): void {}
      tail = Infinity;
    }
    registerEffect({ id: 'test-layer-port', create: () => new Port() });
    Port.ev = [];
    const e = engine();
    const tr = createMixerTrack(1);
    tr.slots[0] = { ...createFxSlot('peq2'), plugin: 'test-layer-port', name: 'Port', params: {}, midiPort: 2 };
    e.handle({ t: 'mixerTrack', tr });
    const mo = createMidiOutChannel();
    mo.midiOut!.port = 2;
    const layer = createLayerChannel();
    layer.layer!.children = [mo.id];
    e.handle({ t: 'channel', c: mo });
    e.handle({ t: 'channel', c: layer });
    startPattern(e, { [layer.id]: [{ pos: 24, len: 12, key: 70 }] });
    e.renderOffline(12000);
    expect(Port.ev).toEqual([['on', 70, 6000], ['off', 70, 9000]]);
    noteOn(e, layer, 72, 1);
    e.renderOffline(256);
    noteOff(e, layer, 72, 1);
    e.renderOffline(256);
    expect(Port.ev.slice(2)).toEqual([['on', 72, 12000], ['off', 72, 12256]]);
  });
});

describe('Layer engine: automation, links and activity', () => {
  const BAR = 384;
  const clipTracks = Array.from({ length: 4 }, (_, i) => ({ id: 't' + i, name: 'Track ' + (i + 1), color: '#485156', height: 1, enabled: true, locked: false }));
  const autoClip = (target: AutomationTarget, value: number): AutomationChannel => ({
    id: 'a1', name: target.label, color: '#888', enabled: true, target, length: BAR * 2, loop: false, min: 0, max: 1, lfo: defaultLfo(),
    points: [{ pos: 0, value, tension: 0, mode: 'single' }, { pos: BAR * 2, value, tension: 0, mode: 'single' }],
  });

  it('an automation clip drives FADE', () => {
    const s = scene(3, { layer: (l) => { l.layer!.crossfade = true; } });
    const target: AutomationTarget = { scope: 'channel', id: s.layer.id, path: 'layer.fade', min: 0, max: LAYER_FADE_MAX, step: 1, label: 'Layer - Crossfade level' };
    const pat = createPattern(1);
    pat.notes[s.layer.id] = [createNote({ pos: 0, len: BAR })];
    s.e.handle({ t: 'pattern', p: pat });
    const clips: Clip[] = [
      { id: 'p1', track: 0, kind: 'pattern', patternId: pat.id, start: 0, length: BAR * 2, offset: 0, muted: false },
      { id: 'c1', track: 1, kind: 'automation', patternId: '', autoId: 'a1', start: 0, length: BAR * 2, offset: 0, muted: false },
    ];
    s.e.handle({ t: 'automation', list: [autoClip(target, 0.75)], init: [] });
    s.e.handle({ t: 'playlist', tracks: clipTracks, clips });
    s.e.handle({ t: 'mode', song: true, patternId: pat.id });
    s.e.handle({ t: 'play' });
    s.e.renderOffline(1000);
    // fade 0.75 x 256 = 192: children 2 and 3 at equal power
    const gains = [0, 1, 2].map((i) => crossfadeGain(i, 3, 192));
    s.recs.forEach((r, i) => expect(r.lv.vol).toBeCloseTo(gains[i], 9));
    expect(s.e.layers.get(s.layer.id)!.tapOf(s.kids[1].id)!.gain).toBeCloseTo(gains[1], 12);
  });

  it('a controller linked to FADE moves the crossfade', () => {
    const s = scene(2, { layer: (l) => { l.layer!.crossfade = true; } });
    // a controller instrument whose output we set through its parameter
    const ctl = createGenChannel('test-layer-ctl');
    ctl.plugin!.params.v = 1;
    s.e.handle({ t: 'channel', c: ctl });
    const target: AutomationTarget = { scope: 'channel', id: s.layer.id, path: 'layer.fade', min: 0, max: LAYER_FADE_MAX, step: 1, label: 'Layer - Crossfade level' };
    s.e.handle({ t: 'links', list: [{ id: 'l1', target, source: { slotId: 'ch:' + ctl.id, output: 0 }, formula: 'Input*0.5' }] });
    noteOn(s.e, s.layer, 60, 1);
    s.e.renderOffline(512);
    // the controller's 1 through the formula: 0.5 -> FADE 128 -> both children at equal power
    expect(s.recs[0].lv.vol).toBeCloseTo(Math.SQRT1_2, 9);
    expect(s.recs[1].lv.vol).toBeCloseTo(Math.SQRT1_2, 9);
    expect(s.e.linkCurrent.get('channel:' + s.layer.id + ':layer.fade')).toBe(128);
  });

  it('reports note activity for the rack LED and does no per-block work', () => {
    const posts: FromEngine[] = [];
    const s = scene(2, { post: (m) => posts.push(m) });
    const ly = s.e.layers.get(s.layer.id)!;
    expect(ly.takePeak()).toBe(0);
    noteOn(s.e, s.layer, 60, 1, 64);
    expect(ly.takePeak()).toBeCloseTo(0.5, 9);
    expect(ly.takePeak()).toBe(0);
    noteOn(s.e, s.layer, 61, 2, 128);
    s.e.renderOffline(3000);
    const st = posts.filter((m): m is Extract<FromEngine, { t: 'status' }> => m.t === 'status');
    const i = st[0].channelIds.indexOf(s.layer.id);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(st.some((m) => m.channelPeaks[i] === 1)).toBe(true);
    // no voices and no render step: nothing runs per block; applying the same settings keeps the taps (no allocation)
    expect('render' in LayerChannel.prototype).toBe(false);
    const tap = ly.tapOf(s.kids[0].id)!;
    for (let k = 0; k < 50; k++) s.e.handle({ t: 'channel', c: { ...s.layer, pan: k / 100 } });
    expect(ly.tapOf(s.kids[0].id)).toBe(tap);
    expect(tap.pan).toBeCloseTo(0.49, 9);
    // pattern notes keep no state in the layer
    startPattern(s.e, { [s.layer.id]: Array.from({ length: 50 }, (_, j) => ({ pos: j, len: 1 })) });
    noteOff(s.e, s.layer, 60, 1);
    noteOff(s.e, s.layer, 61, 2);
    s.e.renderOffline(20000);
    expect(ly.isActive()).toBe(false);
    expect(ly.children()).toEqual(s.kids.map((k) => k.id));
  });
});

// the controller instrument used by the link test
registerGenDef({
  id: 'test-layer-ctl', name: 'Layer test controller', category: 'Controller', notes: 'voices', noAudio: true, width: 100, height: 40,
  params: [{ key: 'v', name: 'Value', index: 0, min: 0, max: 1, def: 0, step: 0 }], outputs: ['Out'],
});
registerGen({
  id: 'test-layer-ctl',
  create: () => {
    const out = new Float64Array(1);
    return { tail: Infinity, setParams(p: unknown) { out[0] = Number((p as { v?: number }).v ?? 0); }, reset() {}, controls: () => out };
  },
});
