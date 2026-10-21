// Patcher as an instrument in the store and the editor: modules hosted in a channel are addressed as
// "ch:<channel id>#<module id>" (generators 'g', effects 'm'), edited through the slot actions, automated
// in the channel scope, saved and loaded with the channel; the shared editor renders the instrument's map.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SR, makeEngine, DcGen } from './util';
import { registerGen } from '../../src/engine/gen';
import { registerGenDef } from '../../src/model/gen/registry';
import { registerEffect } from '../../src/engine/effects';
import type { EffectInstance } from '../../src/engine/effects/types';
import type { FromEngine } from '../../src/engine/protocol';
import type { GenPluginDef } from '../../src/model/gen/types';
import { createGenChannel } from '../../src/model/defaults';

const g = globalThis as Record<string, unknown>;
// editors register timers and listeners when their modules load (the registries import every editor)
g.window ??= {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800,
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
};
g.document ??= { body: {}, getElementById: () => null };
g.getComputedStyle ??= () => ({ fontFamily: 'sans-serif' });

// an instrument with editor display data, to watch it through the hosting channel
const MON_DEF: GenPluginDef = {
  id: 'test-mon', name: 'Test Monitor', category: 'Synth special', notes: 'voices', width: 120, height: 50,
  params: [{ key: 'v', name: 'Value', index: 0, min: 0, max: 10, def: 3 }],
};
registerGenDef(MON_DEF);
registerGen({
  id: 'test-mon',
  create: () => ({ setParams() {}, reset() {}, monitor: () => ({ seen: 7 }) }),
});
registerEffect({ id: 'ps-gain', create: () => ({ setParams() {}, reset() {}, process() {} } as EffectInstance) });

describe('Patcher instrument in the store', async () => {
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { fxTargetOf, pluginTargetOf, isGenSlot, allFx } = await import('../../src/model/fx/hosted');
  const { channelOfSlot, hostedInChannel } = await import('../../src/model/gen/ids');
  const { paramDefOf, paramLabel, pluginDefOf } = await import('../../src/ui/plugins/kit/context');
  const { editGraph, hostedCtx, patcherState } = await import('../../src/ui/plugins/fx/patcher/sync');
  const { GRAPH_KEY, IN, OUT, addModule, connect } = await import('../../src/model/fx/plugins/patcher');
  const { defaultGenParams } = await import('../../src/model/gen/registry');
  const { normalizeProject } = await import('../../src/model/defaults');
  const { getPath } = await import('../../src/model/automation');

  /** A Patcher channel with a generator (g) and an effect (m) module; returns their hosted ids. */
  const setup = () => {
    const id = A.addGenChannel('patcher');
    const slot = 'ch:' + id;
    let gm = '', fm = '';
    editGraph(slot, 'Add modules', (gr) => {
      gm = addModule(gr, 'test-dc', defaultGenParams('test-dc'), 300, 200, 'DC', true).id;
      fm = addModule(gr, 'ps-gain', {}, 500, 200, 'Gain').id;
      connect(gr, 'events', IN, 0, gm, 0);
      connect(gr, 'audio', gm, 0, fm, 0);
      connect(gr, 'audio', fm, 0, OUT, 0);
    });
    return { id, slot, gm, fm, genId: `${slot}#${gm}`, fxId: `${slot}#${fm}` };
  };
  const params = (id: string) => store.project.channels.find((x) => x.id === id)!.plugin!.params;

  it('creates the channel with the instrument\'s default state', () => {
    const id = A.addGenChannel('patcher');
    const c = store.project.channels.find((x) => x.id === id)!;
    expect(c.name).toBe('Patcher');
    expect(c.kind).toBe('plugin');
    expect((c.plugin!.params[GRAPH_KEY] as { gen?: boolean }).gen).toBe(true);
    expect(patcherState('ch:' + id)).not.toBeNull();
  });

  it('tells hosted ids from the channel\'s own and from effects', () => {
    const s = setup();
    expect(channelOfSlot(s.slot)).toBe(s.id);
    expect(channelOfSlot(s.genId)).toBeNull();
    expect(hostedInChannel(s.genId)).toEqual({ channelId: s.id, moduleId: s.gm });
    expect(hostedInChannel(s.slot)).toBeNull();
    expect(hostedInChannel('fx1#m2')).toBeNull();
    expect(isGenSlot(s.slot)).toBe(true);
    expect(isGenSlot(s.genId)).toBe(true);
    expect(isGenSlot(s.fxId)).toBe(false);
    expect(isGenSlot('fx1')).toBe(false);
    expect(isGenSlot('fx1#g2')).toBe(true); // a generator hosted in an effect slot's Patcher
  });

  it('resolves, edits and undoes hosted modules through the slot actions', () => {
    const s = setup();
    const loc = A.findFx(store.project, s.genId)!;
    expect(loc.hosted).toEqual({ slotId: s.slot, moduleId: s.gm });
    expect(loc.channel).toBe(s.id);
    expect(loc.fx.plugin).toBe('test-dc');
    expect(loc.fx.name).toBe('DC');
    const mod = () => (params(s.id)[GRAPH_KEY] as { modules: Record<string, { params: Record<string, unknown> }> }).modules[s.gm].params;
    expect(loc.fx.params).toBe(mod());
    A.setFxParam(s.genId, 'level', 0.25);
    expect(mod().level).toBe(0.25);
    expect(store.historyLabels().past.at(-1)).toBe('Level'); // the generator's parameter name, not the effect registry's
    A.editFx(s.genId, 'Release', (p) => { p.releaseFrames = 100; });
    expect(mod().releaseFrames).toBe(100);
    store.undo();
    expect(mod().releaseFrames).toBe(0);
    A.setFxStateNoHistory(s.genId, 'View', (p) => { p.view = 3; });
    expect(mod().view).toBe(3);
    store.update('Draft', (d) => { A.fxParamsDraft(d, s.genId)!.level = 0.75; });
    expect(mod().level).toBe(0.75);
    // the effect module resolves too, its parameters through the effect registry
    expect(A.findFx(store.project, s.fxId)!.fx.plugin).toBe('ps-gain');
    expect(A.findFx(store.project, `${s.slot}#g99`)).toBeNull();
    // hosted editors' contexts address the module inside the channel
    const ctx = hostedCtx(s.slot, (params(s.id)[GRAPH_KEY] as { modules: Record<string, never> }).modules[s.gm], 'Patcher', true);
    expect(ctx.slotId).toBe(s.genId);
    expect(ctx.plugin).toBe('test-dc');
    // node thumbnails are inert (their writes find nothing) but read the same registry
    const thumb = hostedCtx(s.slot, (params(s.id)[GRAPH_KEY] as { modules: Record<string, never> }).modules[s.gm], 'Patcher', false);
    expect(A.findFx(store.project, thumb.slotId)).toBeNull();
    expect(isGenSlot(thumb.slotId)).toBe(true);
    expect(paramDefOf(thumb, 'level')?.name).toBe('Level');
    expect(paramDefOf(ctx, 'level')?.name).toBe('Level');
    expect(pluginDefOf(ctx)?.name).toBe('Test DC');
    expect(paramLabel(ctx, 'Level')).toBe('DC (Patcher) - Level');
  });

  it('automates hosted parameters in the channel scope, through the whole state path', () => {
    const s = setup();
    A.setFxParam(s.genId, 'level', 0.25);
    const path = `plugin.params.$graph.modules.${s.gm}.params.level`;
    expect(fxTargetOf(s.genId, 'level')).toEqual({ scope: 'channel', id: s.id, path });
    expect(pluginTargetOf(s.genId, 'level')).toEqual({ scope: 'channel', id: s.id, path });
    expect(pluginTargetOf(s.fxId, 'g')).toEqual({ scope: 'channel', id: s.id, path: `plugin.params.$graph.modules.${s.fm}.params.g` });
    expect(pluginTargetOf('fx1#m3', 'g')).toEqual({ scope: 'fx', id: 'fx1', path: 'params.$graph.modules.m3.params.g' });
    const target = { ...pluginTargetOf(s.genId, 'level'), min: 0, max: 1, label: 'DC (Patcher) - Level' };
    const autoId = A.createAutomationClip(target);
    expect(store.project.automation.find((x) => x.id === autoId)!.target.path).toBe(path);
    expect(A.readTarget(store.project, target)).toBe(0.25);
    expect(getPath(store.project.channels.find((x) => x.id === s.id)!, path)).toBe(0.25);
    A.setFxParam(s.genId, 'level', 0.5);
    A.initSongWithPosition(target);
    expect(store.project.initControls!.find((i) => i.target.path === path)?.value).toBe(0.5);
  });

  it('names and formats hosted parameters with the plugin\'s own definitions (clips, hints)', async () => {
    const s = setup();
    const { channelParamAt, fxParamAt } = await import('../../src/model/fx/hosted');
    const { formatAutoValue } = await import('../../src/ui/playlist/autoClip');
    const gp = `plugin.params.$graph.modules.${s.gm}.params.level`;
    expect(channelParamAt(store.project, s.id, gp)).toMatchObject({ plugin: 'test-dc', key: 'level', gen: true });
    expect(channelParamAt(store.project, s.id, `plugin.params.$graph.modules.${s.fm}.params.g`)).toMatchObject({ plugin: 'ps-gain', key: 'g', gen: false });
    expect(channelParamAt(store.project, s.id, 'plugin.params.level')).toMatchObject({ plugin: 'patcher', key: 'level', gen: true }); // the channel's own plugin (the registry decides whether the key exists)
    expect(channelParamAt(store.project, s.id, `plugin.params.$graph.modules.g99.params.level`)).toBeNull();
    expect(channelParamAt(store.project, 'nope', gp)).toBeNull();
    // the instrument's value text (a plain number here, not the generic percentage of an unknown parameter)
    const t = { scope: 'channel' as const, id: s.id, path: gp, min: 0, max: 1, label: 'x' };
    expect(formatAutoValue(t, 0.5)).toBe('0.5');
    // a generator hosted in an effect slot's Patcher resolves to the instrument registry
    const mx = store.project.mixer.tracks[1];
    store.update('Slot', (d) => { d.mixer.tracks[1].slots[0] = { id: 'fxhost', plugin: 'patcher', name: 'Patcher', enabled: true, mix: 1, params: { [GRAPH_KEY]: { modules: { g2: { plugin: 'test-dc', name: 'DC', params: { level: 0.4 } } } } } } as never; });
    expect(fxParamAt(store.project, 'fxhost', 'params.$graph.modules.g2.params.level')).toMatchObject({ plugin: 'test-dc', gen: true });
    expect(mx).toBeDefined();
  });

  it('delivers the samples a hosted instrument refers to, however deep its state keeps them', async () => {
    const { slotSampleRefs } = await import('../../src/audio/engineSamples');
    const s = setup();
    store.update('Samples', (d) => {
      d.samples.s1 = { id: 's1', name: 'a', source: { kind: 'user' } } as never;
      d.samples.s2 = { id: 's2', name: 'b', source: { kind: 'user' } } as never;
      const gr = d.channels.find((x) => x.id === s.id)!.plugin!.params[GRAPH_KEY] as { modules: Record<string, { params: Record<string, unknown> }> };
      gr.modules[s.gm].params.sampleId = 's1';
      gr.modules[s.gm].params.pads = [{ layers: [{ sample: 's2' }] }]; // as deep as an instrument's own state may keep them
    });
    expect([...slotSampleRefs(store.project)].sort()).toEqual(['s1', 's2']);
  });

  it('walks hosted instruments and effects (sample delivery, persistent windows, formula scans)', () => {
    const s = setup();
    expect([...A.allGens(store.project, 'test-dc')].map((x) => x.id)).toContain(s.genId);
    expect([...A.allGens(store.project, 'patcher')].map((x) => x.id)).toContain(s.slot);
    expect([...allFx(store.project, 'ps-gain')].map((x) => x.id)).toContain(s.fxId);
    expect([...allFx(store.project)].map((x) => x.id)).not.toContain(s.genId);
    expect([...A.allGens(store.project)].find((x) => x.id === s.genId)!.channelId).toBe(s.id);
  });

  it('saves and loads the patch with the channel (hosted state, generator flag, links)', () => {
    const s = setup();
    A.setFxParam(s.genId, 'level', 0.3);
    A.setFxParam(s.fxId, 'g', 0.4);
    const saved = JSON.parse(JSON.stringify(store.project));
    const p = normalizeProject(saved);
    const c = p.channels.find((x) => x.id === s.id)!;
    const gr = c.plugin!.params[GRAPH_KEY] as import('../../src/model/fx/plugins/patcher').PatcherGraph;
    expect(gr.gen).toBe(true);
    expect(Object.keys(gr.modules).sort()).toEqual([s.fm, s.gm].sort());
    expect(gr.modules[s.gm].plugin).toBe('test-dc');
    expect(gr.modules[s.gm].params.level).toBe(0.3);
    expect(gr.modules[s.fm].params.g).toBe(0.4);
    expect(gr.links.map((l) => `${l.kind}:${l.from}>${l.to}`).sort()).toEqual([`audio:${s.fm}>out`, `audio:${s.gm}>${s.fm}`, `events:in>${s.gm}`].sort());
    expect(normalizeProject(JSON.parse(JSON.stringify(p))).channels).toEqual(p.channels);
  });

  it('plays a loaded project\'s patch and follows automation of a hosted parameter', async () => {
    const s = setup();
    const e = makeEngine();
    const c = normalizeProject(JSON.parse(JSON.stringify(store.project))).channels.find((x) => x.id === s.id)!;
    c.volume = 1;
    const { createNote, createPattern } = await import('../../src/model/defaults');
    const { defaultLfo } = await import('../../src/model/automation');
    DcGen.all.length = 0;
    e.handle({ t: 'channel', c });
    const target = { scope: 'channel' as const, id: s.id, path: `plugin.params.$graph.modules.${s.gm}.params.level`, min: 0, max: 1, label: 'Level' };
    const a = {
      id: 'a1', name: 'Level', color: '#888', enabled: true, target, length: 384, loop: false, min: 0, max: 1, lfo: defaultLfo(),
      points: [{ pos: 0, value: 0.2, tension: 0, mode: 'single' as const }, { pos: 384, value: 0.2, tension: 0, mode: 'single' as const }],
    };
    const pat = createPattern(1);
    pat.notes[s.id] = [createNote({ pos: 0, len: 384 })];
    e.handle({ t: 'pattern', p: pat });
    const tracks = [0, 1].map((i) => ({ id: 't' + i, name: 'T', color: '#485156', height: 1, enabled: true, locked: false }));
    e.handle({ t: 'automation', list: [a], init: [] });
    e.handle({ t: 'playlist', tracks, clips: [
      { id: 'p', track: 0, kind: 'pattern', patternId: pat.id, start: 0, length: 384, offset: 0, muted: false },
      { id: 'c', track: 1, kind: 'automation', patternId: '', autoId: 'a1', start: 0, length: 384, offset: 0, muted: false },
    ] });
    e.handle({ t: 'mode', song: true, patternId: pat.id });
    e.handle({ t: 'play' });
    const [L] = e.renderOffline(4000);
    const dc = DcGen.all[DcGen.all.length - 1];
    expect(dc.params.level).toBeCloseTo(0.2, 9);
    // the hosted effect is a pass-through stand-in: level 0.2 x channel volume 1 x centred pan
    expect(L[2000]).toBeCloseTo(0.2 * Math.SQRT1_2 * 1, 6);
  });

  it('serves a hosted instrument\'s display data to the editors watching "ch:<channel>#<module>"', () => {
    const posted: FromEngine[] = [];
    const e = makeEngine({ post: (m) => posted.push(m) });
    const id = 'monch';
    const c = { ...createGenChannel('patcher'), id };
    const gr = c.plugin!.params[GRAPH_KEY] as import('../../src/model/fx/plugins/patcher').PatcherGraph;
    const m = addModule(gr, 'test-mon', defaultGenParams('test-mon'), 300, 200, 'Mon', true);
    connect(gr, 'events', IN, 0, m.id, 0);
    e.handle({ t: 'channel', c });
    e.handle({ t: 'watchFx', ids: [`ch:${id}#${m.id}`, 'ch:' + id] });
    e.renderOffline(SR / 4);
    const items = posted.filter((x) => x.t === 'fxMonitor').flatMap((x) => (x as Extract<FromEngine, { t: 'fxMonitor' }>).items);
    const hosted = items.find(([sid]) => sid === `ch:${id}#${m.id}`);
    expect(hosted?.[1].seen).toBe(7);
    // the channel's own display data are the patch's activity data
    const own = items.find(([sid]) => sid === 'ch:' + id);
    expect(own?.[1].__pIds).toBe(m.id);
  });
});

describe('Patcher instrument editor', async () => {
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { genEditorFor } = await import('../../src/ui/plugins/genRegistry');
  // the shared editor component (the instrument's module loads it lazily)
  const { PatcherEditor } = await import('../../src/ui/plugins/fx/patcher/Editor');
  const { genPickerItems } = await import('../../src/ui/plugins/pluginMenu');
  const { GRAPH_KEY, IN, OUT, addModule, connect, defaultGraph, nodePorts } = await import('../../src/model/fx/plugins/patcher');
  const { defaultGenParams } = await import('../../src/model/gen/registry');
  const { iconSize, editorSize } = await import('../../src/ui/plugins/fx/patcher/Hosted');
  const { allPorts } = await import('../../src/ui/plugins/fx/patcher/geometry');

  const state = () => {
    const gr = defaultGraph(true);
    const m = addModule(gr, 'test-dc', defaultGenParams('test-dc'), 300, 200, 'Tone', true);
    const f = addModule(gr, 'ps-gain', {}, 500, 200, 'Level');
    connect(gr, 'events', IN, 0, m.id, 0);
    connect(gr, 'audio', m.id, 0, f.id, 0);
    connect(gr, 'audio', f.id, 0, OUT, 0);
    return { gr, params: { [GRAPH_KEY]: gr } as Record<string, unknown> };
  };
  const render = (slotId: string, params: Record<string, unknown>) => renderToStaticMarkup(
    createElement(FxEditorContext.Provider, { value: { slotId, plugin: 'patcher', params, trackName: 'Patcher', pluginName: 'Patcher' } }, createElement(PatcherEditor)),
  );

  it('registers the shared map editor for the instrument, and the effect keeps its own', async () => {
    const e = genEditorFor('patcher')!;
    expect(e.id).toBe('patcher');
    expect(typeof e.Editor).toBe('function');
    const { editorFor } = await import('../../src/ui/plugins/registry');
    expect(editorFor('patcher')!.Editor).toBe(PatcherEditor);
  });

  it('draws the map of the instrument: both I/O nodes, hosted generator and effect labels', () => {
    const { params } = state();
    const html = render('ch:p1', params);
    expect(html).toContain('From FL Studio');
    expect(html).toContain('To FL Studio');
    expect(html).toContain('Tone');
    expect(html).toContain('Level');
    expect(html.length).toBeGreaterThan(3000);
    // an empty instrument draws too
    expect(render('ch:p2', {})).toContain('From FL Studio');
  });

  it('has no audio port on From FL Studio, a Notes input on generators and the Notes output linked', () => {
    const { gr } = state();
    const ids = Object.keys(gr.modules);
    const ports = allPorts(gr, { zx: 1, zy: 1, ox: 0, oy: 0 }, gr.view);
    const of = (node: string, dir: 'in' | 'out', kind: 'audio' | 'events') => ports.filter((p) => p.node === node && p.dir === dir && p.kind === kind).length;
    expect(of(IN, 'out', 'audio')).toBe(0);
    expect(of(IN, 'out', 'events')).toBe(1);
    expect(of(ids[0], 'in', 'events')).toBe(1);
    expect(of(ids[0], 'in', 'audio')).toBe(0);
    expect(of(ids[0], 'out', 'audio')).toBe(1);
    expect(of(OUT, 'in', 'audio')).toBe(1);
    expect(nodePorts(gr, ids[0])!.eventsOut).toBe(0);
  });

  it('sizes hosted generator nodes and windows from the instrument\'s own editor size', () => {
    const e = editorSize('test-dc', undefined, true);
    expect(e.w).toBeGreaterThan(0);
    const ic = iconSize('test-dc', true);
    expect(ic.w).toBeLessThanOrEqual(156);
    expect(ic.h).toBeLessThanOrEqual(76);
    // an unknown plugin id still gets a box
    expect(editorSize('no-such-plugin', undefined, true)).toEqual({ w: 260, h: 116 });
  });

  it('offers the instruments by FL folder (not controllers without audio, not Patcher itself)', () => {
    const items = genPickerItems(() => {});
    const folders = items.map((i) => i.label);
    expect(folders).toContain('Synth classic');
    const all = items.flatMap((i) => (i.submenu ?? []).map((s) => (s as { label: string }).label));
    expect(all).toContain('Test DC');
    expect(all).not.toContain('Test Gen Controller');
    expect(all).not.toContain('Patcher');
    expect(all.length).toBeGreaterThan(10);
  });
});
