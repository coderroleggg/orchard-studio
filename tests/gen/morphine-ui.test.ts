// Morphine editor: every page renders (default program and factory presets),
// the controls bind real parameters (FL's indices from the GUI code), view
// state switches pages / partial views / envelopes, structure edits from the
// editor keep a valid state, and the plugin menu offers FL content import.
import { describe, it, expect, vi } from 'vitest';
import './util';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

const rec = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('../../src/ui/plugins/kit/context', async (orig) => {
  const m = await orig<typeof import('../../src/ui/plugins/kit/context')>();
  return {
    ...m,
    useParam: (key: string, over?: Parameters<typeof m.useParam>[1]) => {
      rec.keys.add(key);
      return m.useParam(key, over);
    },
  };
});

describe('Morphine editor', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { editor } = await import('../../src/ui/plugins/gen/morphine');
  const L = await import('../../src/ui/plugins/gen/morphine/layout');
  const D = await import('../../src/ui/plugins/gen/morphine/data');
  const { toolHits } = await import('../../src/ui/plugins/gen/morphine/views');
  const { MOR_KEYS, MOR_PARAMS } = await import('../../src/model/gen/plugins/morphine/params');
  const { normalizeMorphine } = await import('../../src/model/gen/plugins/morphine/state');
  const { genDef } = await import('../../src/model/gen/registry');

  function setup() {
    const id = A.addGenChannel('morphine');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    const render = () => {
      rec.keys.clear();
      const ctx = { slotId, plugin: 'morphine', params: params(), trackName: 'Morphine', pluginName: 'Morphine' };
      return renderToStaticMarkup(React.createElement(FxEditorContext.Provider, { value: ctx }, React.createElement(editor.Editor)));
    };
    return { slotId, params, render };
  }

  it('renders every page and binds FL\'s parameters', () => {
    const { slotId, render } = setup();
    const keys = new Set(MOR_PARAMS.map((p) => p.key));
    const bound = new Set<string>();
    for (let page = 0; page < 6; page++) {
      for (let env = 0; env < (page === 1 ? 4 : 1); env++) {
        D.setView(slotId, { page, env });
        expect(render().length).toBeGreaterThan(2000);
        for (const k of rec.keys) { expect(keys.has(k), k).toBe(true); bound.add(k); }
      }
    }
    // the top bar, effects, generators' timeline / PWM / range, morph, noise and envelope parameters (0..122)
    for (let i = 0; i < 123; i++) expect(bound.has(MOR_KEYS[i]), `${i} ${MOR_KEYS[i]}`).toBe(true);
  });

  it('renders factory presets on every page, partial view and envelope', () => {
    const { slotId, params, render } = setup();
    const presets = genDef('morphine')!.presets!;
    for (let i = 0; i < presets.length; i += 61) {
      A.editFx(slotId, 'preset', (p) => { Object.assign(p, normalizeMorphine({ ...p, ...structuredClone(presets[i].params) })); });
      for (let page = 0; page < 6; page++) {
        D.setView(slotId, { page, view: page % 5, env: page % 4 });
        expect(render().length).toBeGreaterThan(2000);
      }
    }
    expect(D.viewOf(params()).page).toBe(5);
  });

  it('edits the program structure into a valid state', () => {
    const { slotId, params } = setup();
    D.editZone(slotId, 'Draw spectrum', 0, (z) => { z.bp[0].a = new Array(128).fill(0.5); delete z.bp[0].s; });
    D.editState(slotId, 'Morph point', (s) => { (s.morph as { pts: number[][] }).pts[0][0] = 0.25; });
    D.editState(slotId, 'Mod', (s) => { const m = s.mod as { src: number[]; dst: number[] }; m.src[3] = 2; m.dst[3] = 1; });
    const st = params();
    const n = normalizeMorphine(st);
    expect((n.gens as { zones: { bp: { a: number[] }[] }[] }[])[0].zones[0].bp[0].a[7]).toBe(0.5);
    expect((n.morph as { pts: number[][] }).pts[0][0]).toBe(0.25);
    expect((n.mod as { src: number[] }).src[3]).toBe(2);
    const [a] = D.spectrumOf(st, 0, (st.gens as { zones: { bp: object[] }[] }[])[0].zones[0].bp[0] as never);
    expect(a[0]).toBe(0.5);
  });

  it('steps through the factory programs with the view kept', async () => {
    const { stepProgram } = await import('../../src/ui/plugins/gen/morphine');
    const { factoryProgram } = await import('../../src/model/gen/plugins/morphine');
    const { slotId, params } = setup();
    D.setView(slotId, { page: 3 });
    const presets = genDef('morphine')!.presets!;
    stepProgram(slotId, params(), 1);
    stepProgram(slotId, params(), 1);
    stepProgram(slotId, params(), -1);
    const st = params();
    expect(st.__preset).toBe(presets[0].name);
    expect(st.__m).toBeUndefined();
    const fp = factoryProgram(0)!;
    expect(st.progName).toBe(fp.progName);
    expect(st[MOR_KEYS[0]]).toBe(fp[MOR_KEYS[0]]);
    expect(D.viewOf(st).page).toBe(3);
  });

  it('keeps FL\'s menus and tool sets', () => {
    expect(L.MOD_SOURCES.length).toBe(137);
    expect(L.MOD_TARGETS.length).toBe(48);
    expect(L.PAGES).toEqual(['MORPHING', 'MODULATION', 'GENERATOR A', 'GENERATOR B', 'GENERATOR C', 'GENERATOR D']);
    expect([0, 1, 2].map((k) => toolHits(1, k))).toEqual([true, false, true]);
    expect([0, 1, 2].map((k) => toolHits(3, k))).toEqual([false, false, true]);
    const { slotId } = setup();
    const menu = editor.menu!(slotId).map((m) => m.label);
    expect(menu).toContain('Import FL content...');
    expect(menu).toContain('Save Program...');
  });
});
