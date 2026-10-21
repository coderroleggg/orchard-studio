// FL Keys editor: every parameter of FL's form (15 wheels) is bound, FL's captions and group bars are drawn at
// their anchors, the wavetable list shows the selected table, the about panel reads the table's metadata and the
// window menu offers the FL content import.
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

describe('FL Keys editor', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { editor } = await import('../../src/ui/plugins/gen/flkeys');
  const { KEYS_PARAM_KEYS, KEYS_CATALOG } = await import('../../src/engine/gen/plugins/flkeys/catalog');

  function setup() {
    const id = A.addGenChannel('flkeys');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    const render = (over: Record<string, unknown> = {}) => {
      rec.keys.clear();
      const ctx = { slotId, plugin: 'flkeys', params: { ...params(), ...over }, trackName: 'FL Keys', pluginName: 'FL Keys' };
      return renderToStaticMarkup(React.createElement(FxEditorContext.Provider, { value: ctx }, React.createElement(editor.Editor)));
    };
    return { id, slotId, params, render };
  }

  it('is registered for the plugin and sized like FL\'s form (480 x 270)', () => {
    expect(editor.id).toBe('flkeys');
    const { render } = setup();
    const html = render();
    expect(html).toContain('width:480px');
    expect(html).toContain('height:270px');
  });

  it('binds all 15 parameters with one wheel each at FL\'s form positions', () => {
    const { render } = setup();
    const html = render();
    expect([...rec.keys].sort()).toEqual([...KEYS_PARAM_KEYS].sort());
    const at: Record<string, [number, number]> = {
      decay: [14, 62], release: [72, 62], overdrive: [135, 62], lfoRate: [192, 62], velMuffle: [255, 62], muffle: [311, 62], tune: [425, 62],
      panTrem: [14, 124], stereo: [72, 124], treble: [135, 124], stretch: [192, 124], velHardness: [255, 124], hardness: [311, 124], velSens: [364, 124], detune: [425, 124],
    };
    for (const [x, y] of Object.values(at)) expect(html).toContain(`left:${x}px;top:${y}px;width:42px;height:42px`);
  });

  it('draws FL\'s title, group bars and captions', () => {
    const html = setup().render();
    for (const t of ['FL KEYS', 'ENVIRONMENT', 'MISC', 'VELOCITY', 'TUNING', 'DECAY', 'RELEASE', 'OVERDRIVE', 'LFO', 'MUFFLE', 'TUNE', 'PAN', 'STEREO', 'TREBLE', 'STRETCH', 'HARDNESS', 'SENS', 'DETUNE']) expect(html).toContain(t);
  });

  it('shows the selected wavetable in the list and keeps the info panel closed until asked', () => {
    const { render } = setup();
    expect(render()).toContain('Grand Piano');
    expect(render({ wavetable: 'Roto Organ' })).toContain('Roto Organ');
    expect(render()).not.toContain('NR OF SAMPLES');
  });

  it('the window menu imports FL content or switches back to the synthesized sound', () => {
    const { slotId } = setup();
    const items = editor.menu!(slotId);
    expect(items[0].label).toBe('Import FL content...');
    expect(items.some((i) => i.label === 'Use synthesized sound' && i.disabled)).toBe(true);
    expect(KEYS_CATALOG.length).toBe(4);
  });
});
