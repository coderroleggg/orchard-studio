// Autogun editor: renders FL's panel (282 x 379) with the preset's title, author and description, the previous / next preset buttons move
// the 32 bit counter and reset the quality like FL's generator, the options menu offers FL's items (enter a preset number, processing quality,
// about, homepage), and the window follows the plugin's size.
import { describe, it, expect, vi } from 'vitest';
import './util';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

describe('Autogun editor', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { editor, stepPreset, autogunMenu, PANEL_W, PANEL_H } = await import('../../src/ui/plugins/gen/autogun');
  const { genEditorFor } = await import('../../src/ui/plugins/genRegistry');
  const { presetInfo } = await import('../../src/model/gen/plugins/autogun/state');

  function setup(state: Record<string, unknown> = { n: 1 }) {
    const id = A.addGenChannel('autogun');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    A.setFxStateNoHistory(slotId, 'test state', (p) => { Object.assign(p, state); });
    const render = () => {
      const ctx = { slotId, plugin: 'autogun', params: params(), trackName: 'Autogun', pluginName: 'Autogun' };
      return renderToStaticMarkup(React.createElement(FxEditorContext.Provider, { value: ctx }, React.createElement(editor.Editor)));
    };
    return { slotId, params, render };
  }

  it('is registered for the plugin and sized like FL\'s SynthPanel2', () => {
    expect(genEditorFor('autogun')).toBe(editor);
    expect([PANEL_W, PANEL_H]).toEqual([282, 379]);
    expect(editor.size!({})).toEqual({ w: 282, h: 379 });
  });

  it('renders the panel with the preset\'s title, author and description on the screen', () => {
    const { render } = setup({ n: 1 });
    const html = render();
    expect(html.length).toBeGreaterThan(3000);
    expect(html).toContain('width:282px');
    expect(html).toContain('Synthesizer');
    expect(html).toContain('donatello');
    expect(html).toContain('Pretty good, much like old synthesizers tweaked by yo motha.');
    expect(html).toContain('AUT');
    // the other preset's text
    const { render: r2 } = setup({ n: 2 });
    expect(r2()).toContain('Fading air');
    expect(presetInfo(2).author).toBe('The Enforcer');
  });

  it('the previous / next buttons move the counter (32 bit), keep level and dust and give back the generated quality, without undo', () => {
    const { slotId, params } = setup({ n: 100, level: 180, dust: 777, quality: 4 });
    stepPreset(slotId, 1);
    expect(params()).toMatchObject({ n: 101, level: 180, dust: 777, quality: 1 });
    A.setFxStateNoHistory(slotId, 'test', (p) => { p.quality = 3; });
    stepPreset(slotId, -1);
    stepPreset(slotId, -1);
    expect(params().n).toBe(99);
    expect(params().quality).toBe(1);
    A.setFxStateNoHistory(slotId, 'test', (p) => { p.n = 0; });
    stepPreset(slotId, -1);
    expect(params().n).toBe(4294967295);
    stepPreset(slotId, 1);
    expect(params().n).toBe(0);
  });

  it('the options menu offers FL\'s items: enter a preset number, processing quality, about, homepage', () => {
    const { slotId, params } = setup({ n: 41, quality: 2 });
    const m = autogunMenu(slotId);
    expect(m.map((i) => i.label ?? '-')).toEqual(['Enter preset number...', 'Processing quality', '-', 'About', 'Autogun homepage']);
    const q = m[1].submenu!;
    expect(q.map((i) => i.label)).toEqual(['Draft', 'Average', 'High', 'Pristine', 'Huge waste of CPU']);
    expect(q.map((i) => !!i.checked)).toEqual([false, false, true, false, false]);
    expect(q.every((i) => i.radio)).toBe(true);
    q[4].onClick!();
    expect(params().quality).toBe(4);
    expect(autogunMenu(slotId)[1].submenu!.map((i) => !!i.checked)).toEqual([false, false, false, false, true]);
    expect(editor.menu!(slotId).map((i) => i.label ?? '-')).toEqual(m.map((i) => i.label ?? '-'));
  });

  it('"Enter preset number..." takes 1 .. 4294967296 (the counter + 1), shows the current number and refuses anything else', () => {
    const { slotId, params } = setup({ n: 41, quality: 3, dust: 10 });
    const asked: unknown[] = [];
    const answers: (string | null)[] = ['4294967296', '1', '0', '4294967297', 'abc', '12.5', null, ' 2077 '];
    vi.stubGlobal('prompt', (msg: string, def: string) => { asked.push([msg, def]); return answers.shift() ?? null; });
    const enter = () => autogunMenu(slotId)[0].onClick!();
    enter();
    expect(asked[0]).toEqual(['Current preset number', '42']);
    expect(params().n).toBe(4294967295);
    expect(params().quality).toBe(1);
    expect(params().dust).toBe(10);
    enter();
    expect(params().n).toBe(0);
    for (let i = 0; i < 5; i++) { enter(); expect(params().n, `refused ${i}`).toBe(0); }
    enter();
    expect(params().n).toBe(2076);
    vi.unstubAllGlobals();
  });
});
