// The store's slot actions address a channel's instrument plugin as
// "ch:<channel id>" (so the effect editor kit works unchanged for instrument
// editors); automation / link targets of its parameters are channel-scoped
// ('plugin.params.<key>'). Plus the generator add / replace / insert actions
// and project save / load of instrument channels.
import { describe, it, expect } from 'vitest';
import './util';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

describe('instrument plugins in the store ("ch:<channel id>")', async () => {
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { fxTargetOf, pluginTargetOf } = await import('../../src/model/fx/hosted');
  const { paramDefOf, paramLabel, pluginDefOf } = await import('../../src/ui/plugins/kit/context');
  const { normalizeProject } = await import('../../src/model/defaults');
  const { getPath } = await import('../../src/model/automation');

  it('adds instrument channels named after the plugin', () => {
    const id = A.addGenChannel('test-dc');
    const id2 = A.addGenerator({ kind: 'plugin', id: 'test-dc' });
    const c = store.project.channels.find((x) => x.id === id)!;
    expect(c.kind).toBe('plugin');
    expect(c.name).toBe('Test DC');
    expect(c.plugin).toEqual({ id: 'test-dc', params: { level: 0.5, releaseFrames: 0 } });
    expect(store.project.channels.find((x) => x.id === id2)!.name).toBe('Test DC #2');
    expect(store.ui.selectedChannels).toEqual([id2]);
  });

  it('resolves, edits and undoes instrument state through the slot actions', () => {
    const id = A.addGenChannel('test-dc');
    const slot = 'ch:' + id;
    const loc = A.findFx(store.project, slot)!;
    expect(loc.channel).toBe(id);
    expect(loc.slot).toBe(-1);
    expect(loc.fx.plugin).toBe('test-dc');
    expect(loc.fx.name).toBe('Test DC');
    const params = () => store.project.channels.find((x) => x.id === id)!.plugin!.params;
    expect(loc.fx.params).toBe(params());

    A.setFxParam(slot, 'level', 0.25);
    expect(params().level).toBe(0.25);
    expect(store.historyLabels().past.at(-1)).toBe('Level');
    A.editFx(slot, 'Release', (p) => { p.releaseFrames = 100; });
    expect(params().releaseFrames).toBe(100);
    store.undo();
    expect(params().releaseFrames).toBe(0);
    A.setFxStateNoHistory(slot, 'View', (p) => { p.view = 3; });
    expect(params().view).toBe(3);
    store.update('Draft', (d) => { A.fxParamsDraft(d, slot)!.level = 0.75; });
    expect(params().level).toBe(0.75);
    // effect slots keep working; unknown or non-plugin channels resolve to nothing
    expect(A.findFx(store.project, 'ch:nope')).toBeNull();
    const smp = A.addChannel('Smp', null);
    expect(A.findFx(store.project, 'ch:' + smp)).toBeNull();
    // every instrument, with its slot id
    expect([...A.allGens(store.project, 'test-dc')].map((x) => x.id)).toContain(slot);
  });

  it('targets instrument parameters in the channel scope (automation clips, init, labels)', () => {
    const id = A.addGenChannel('test-dc');
    const slot = 'ch:' + id;
    A.setFxParam(slot, 'level', 0.25);
    expect(fxTargetOf(slot, 'level')).toEqual({ scope: 'channel', id, path: 'plugin.params.level' });
    expect(pluginTargetOf(slot, 'level')).toEqual({ scope: 'channel', id, path: 'plugin.params.level' });
    expect(pluginTargetOf('fxslot', 'x')).toEqual({ scope: 'fx', id: 'fxslot', path: 'params.x' });
    // the kit's parameter lookup and FL's label for instruments
    const ctx = { slotId: slot, plugin: 'test-dc', params: {}, trackName: 'Test DC', pluginName: 'Test DC' };
    expect(pluginDefOf(ctx)?.name).toBe('Test DC');
    expect(paramDefOf(ctx, 'level')?.name).toBe('Level');
    expect(paramLabel(ctx, 'Level')).toBe('Test DC - Level');
    expect(paramLabel({ ...ctx, slotId: 'fx1', trackName: 'Insert 1' }, 'Level')).toBe('Test DC (Insert 1) - Level');

    const target = { ...pluginTargetOf(slot, 'level'), min: 0, max: 1, label: 'Test DC - Level' };
    const autoId = A.createAutomationClip(target);
    const a = store.project.automation.find((x) => x.id === autoId)!;
    const ch = store.project.channels.find((x) => x.id === id)!;
    expect(a.name).toBe(`${ch.name} - Level`);
    expect(a.target.scope).toBe('channel');
    expect(A.readTarget(store.project, target)).toBe(0.25);
    expect(store.project.initControls!.find((i) => i.target.path === 'plugin.params.level')?.value).toBe(0.25);
    expect(getPath(ch, target.path)).toBe(0.25);
    A.setFxParam(slot, 'level', 0.5);
    A.initSongWithPosition(target);
    expect(store.project.initControls!.find((i) => i.target.path === 'plugin.params.level' && i.target.id === id)?.value).toBe(0.5);
  });

  it('lists instrument controller outputs as link sources and drops links with their channel', () => {
    const ctl = A.addGenChannel('test-genctl');
    const tone = A.addGenChannel('test-dc');
    const src = A.controllerSources().find((s) => s.slotId === 'ch:' + ctl);
    expect(src).toEqual({ slotId: 'ch:' + ctl, output: 0, label: 'Test Gen Controller - Out' });
    const target = { ...pluginTargetOf('ch:' + tone, 'level'), min: 0, max: 1, label: 'Level' };
    A.linkToController(target, { slotId: 'ch:' + ctl, output: 0 });
    expect(A.isLinked(target)).toBe(true);
    A.deleteChannels([ctl]);
    expect(A.isLinked(target)).toBe(false);
  });

  it('replaces and inserts generators', () => {
    const id = A.addGenChannel('test-dc');
    const ctl = A.addGenChannel('test-genctl');
    const levelTarget = { ...pluginTargetOf('ch:' + id, 'level'), min: 0, max: 1, label: 'Level' };
    const volTarget = { scope: 'channel' as const, id, path: 'volume', min: 0, max: 1, label: 'Vol' };
    A.linkToController(levelTarget, { slotId: 'ch:' + ctl, output: 0 });
    A.linkToController(volTarget, { slotId: 'ch:' + ctl, output: 0 });
    A.setFxParam('ch:' + id, 'level', 0.1);
    A.replaceGenerator(id, { kind: 'plugin', id: 'test-dc-ins' });
    let c = store.project.channels.find((x) => x.id === id)!;
    expect(c.plugin).toEqual({ id: 'test-dc-ins', params: { level: 0.5, releaseFrames: 0 } });
    expect(c.name.startsWith('Test DC INS')).toBe(true);
    // links of the old plugin's parameters go; links of the channel's own controls stay
    expect(A.isLinked(levelTarget)).toBe(false);
    expect(A.isLinked(volTarget)).toBe(true);
    A.replaceGenerator(id, { kind: 'midiout' });
    c = store.project.channels.find((x) => x.id === id)!;
    expect(c.kind).toBe('midiout');
    expect(c.plugin).toBeUndefined();
    expect(c.midiOut).toBeDefined();
    A.replaceGenerator(id, { kind: 'sampler' });
    c = store.project.channels.find((x) => x.id === id)!;
    expect(c.kind).toBe('sampler');
    expect(c.midiOut).toBeUndefined();
    const ins = A.insertGenerator(id, { kind: 'plugin', id: 'test-ev' });
    const order = store.project.channels.map((x) => x.id);
    expect(order.indexOf(ins)).toBe(order.indexOf(id) + 1);
    A.setGenMidiPort(ins, 7);
    expect(store.project.channels.find((x) => x.id === ins)!.plugin!.midiPort).toBe(7);
    A.setGenMidiPort(ins, -1);
    expect(store.project.channels.find((x) => x.id === ins)!.plugin!.midiPort).toBeUndefined();
  });

  it('saves and loads instrument channels (normalised state, unknown plugins kept)', () => {
    const id = A.addGenChannel('test-dc');
    A.setFxParam('ch:' + id, 'level', 0.3);
    store.update('Odd', (d) => {
      const c = d.channels.find((x) => x.id === id)!;
      delete c.plugin!.params.releaseFrames; // an older save without a newer parameter
      c.plugin!.midiPort = 300;
    });
    const unknown = { ...store.project.channels[0], id: 'u1', kind: 'plugin' as const, plugin: { id: 'future-synth', params: { a: 1 } } };
    const saved = JSON.parse(JSON.stringify({ ...store.project, channels: [...store.project.channels, unknown] }));
    const p = normalizeProject(saved);
    const c = p.channels.find((x) => x.id === id)!;
    expect(c.kind).toBe('plugin');
    expect(c.plugin).toEqual({ id: 'test-dc', params: { level: 0.3, releaseFrames: 0 }, midiPort: 255 });
    expect(p.channels.find((x) => x.id === 'u1')!.plugin).toEqual({ id: 'future-synth', params: { a: 1 } });
    // a plugin channel without its plugin object falls back to a Sampler
    const broken = normalizeProject({ ...saved, channels: [{ ...store.project.channels[0], kind: 'plugin', plugin: undefined }] });
    expect(broken.channels[0].kind).toBe('sampler');
    // load(save(x)) is stable
    expect(normalizeProject(JSON.parse(JSON.stringify(p))).channels).toEqual(p.channels);
  });
});
