// Harmless editor: every form control with a parameter Tag binds a real
// parameter, the extra controls edit state keys that exist, FL's painted
// captions sit on known anchors, combo items map to FL's selectable values,
// the editor renders for the default state and presets, the keyboard toggle
// sizes the panel, and the timbre colour menu actions are present.
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

describe('Harmless editor', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { editor } = await import('../../src/ui/plugins/gen/harmless');
  const { HL_FORM } = await import('../../src/ui/plugins/gen/harmless/layout');
  const { HL_LABELS } = await import('../../src/ui/plugins/gen/harmless/labels');
  const { comboItems, comboMenu } = await import('../../src/ui/plugins/gen/harmless/widgets');
  const { HL_PARAMS } = await import('../../src/model/gen/plugins/harmless/params');
  const { HL_EXTRAS, FILTER_TYPES, RES_TYPES, PHASER_TYPES, COMP_TYPES, TIMBRES } = await import('../../src/model/gen/plugins/harmless/state');
  const { genDef } = await import('../../src/model/gen/registry');

  function setup() {
    const id = A.addGenChannel('harmless');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    const render = () => {
      rec.keys.clear();
      const ctx = { slotId, plugin: 'harmless', params: params(), trackName: 'Harmless', pluginName: 'Harmless' };
      return renderToStaticMarkup(React.createElement(FxEditorContext.Provider, { value: ctx }, React.createElement(editor.Editor)));
    };
    return { id, slotId, params, render };
  }

  it('binds every parameter control of FL\'s form and only real state keys', () => {
    const keys = new Set(HL_PARAMS.map((p) => p.key));
    const extras = new Set<string>(HL_EXTRAS.map((e) => e.key));
    const special = new Set(['kb', 'about', 'keyboard']);
    for (const c of HL_FORM) expect(keys.has(c.k) || extras.has(c.k) || special.has(c.k), c.n).toBe(true);
    // all 100 parameters have a control
    const bound = new Set(HL_FORM.map((c) => c.k));
    for (const k of keys) expect(bound.has(k), k).toBe(true);
    const { render } = setup();
    const html = render();
    expect(html.length).toBeGreaterThan(1000);
    for (const c of HL_FORM) if (keys.has(c.k)) expect(rec.keys.has(c.k), c.n).toBe(true);
  });

  it('maps FL\'s combo items (separators and headers skipped) to the selectable values', () => {
    const items = (k: string) => comboItems(HL_FORM.find((c) => c.k === k)!.items!);
    expect(items('filterType')).toEqual(FILTER_TYPES);
    expect(items('resType')).toEqual(RES_TYPES);
    expect(items('phaserType')).toEqual(PHASER_TYPES);
    expect(items('compType')).toEqual(COMP_TYPES);
    expect(items('timbre')).toEqual(TIMBRES);
    for (const k of ['chType', 'delType', 'revType', 'uniType', 'hzType', 'hzPos', 'lfoShape']) {
      const p = HL_PARAMS.find((q) => q.key === k)!;
      expect(items(k).length, k).toBe(p.max - p.min + 1);
    }
    const m = comboMenu(HL_FORM.find((c) => c.k === 'resType')!.items!, 8, () => {});
    expect(m.some((x) => x.header && x.label === 'Special')).toBe(true);
    expect(m.filter((x) => x.radio).length).toBe(9);
    expect(m.find((x) => x.checked)!.label).toBe('Noise');
  });

  it('paints FL\'s captions on their anchors', () => {
    const t = (s: string) => HL_LABELS.find((l) => l[0] === s);
    expect(t('Filter')).toBeTruthy();
    expect(t('Harmonizer')).toBeTruthy();
    expect(t('harmonic mask')).toBeTruthy();
    const timbre = t('Timbre')!;
    expect([timbre[1], timbre[2], timbre[5]]).toEqual([34, 119, 'l']);
    for (const l of HL_LABELS) {
      expect(l[1] + l[3]).toBeGreaterThan(0);
      expect(l[1]).toBeLessThan(848);
    }
  });

  it('renders every factory preset and sizes the panel with the keyboard', () => {
    const { slotId, params, render } = setup();
    const presets = genDef('harmless')!.presets!;
    for (let i = 0; i < presets.length; i += 37) {
      A.editFx(slotId, 'preset', (p) => { Object.assign(p, presets[i].params); });
      expect(render().length).toBeGreaterThan(1000);
    }
    expect(editor.size!(params())).toEqual({ w: 848, h: 569 });
    A.setFxStateNoHistory(slotId, 'Keyboard', (d) => { d.kbShown = 0; });
    expect(editor.size!(params())).toEqual({ w: 848, h: 502 });
    const menu = editor.menu!(slotId).map((m) => m.label);
    expect(menu).toContain('Import FL content...');
    expect(menu).toContain('Analyze single-cycle waveform...');
    expect(menu).toContain('Reset custom timbre color');
  });
});
