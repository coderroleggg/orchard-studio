// Smoke tests of the controller editors without a browser: the editors render (server side) in every state they show,
// and the envelope display's drawing runs on a stand-in canvas for every source, view and point layout.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import './util';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
g.document ??= { body: {}, getElementById: () => null };
g.getComputedStyle ??= () => ({ fontFamily: 'sans-serif' });

/** A canvas context that accepts every call (and counts the paths and fills). */
function fakeCtx() {
  const calls: Record<string, number> = {};
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => { calls[k] = (calls[k] ?? 0) + 1; for (const x of a) if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`non-finite argument to ${k}`); return undefined; };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('Envelope Controller editor', async () => {
  const { ecDefaultState, ecFlatShape, ecPoint, def } = await import('../../src/model/gen/plugins/envctrl');
  const { drawEnvDisplay } = await import('../../src/ui/plugins/gen/envctrl/draw');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const mod = await import('../../src/ui/plugins/gen/envctrl');

  const render = (params: Record<string, unknown>) => renderToStaticMarkup(
    createElement(FxEditorContext.Provider, { value: { slotId: 'ch:test', plugin: 'envctrl', params, trackName: 'Env', pluginName: 'Envelope Controller' } }, createElement(mod.editor.Editor)),
  );

  it('renders every source of every articulator', () => {
    const base = ecDefaultState();
    for (const src of [0, 1, 3, 4, 5, 6, 7]) {
      for (const sel of [0, 3, 7]) {
        const html = render({ ...base, src, sel });
        expect(html).toContain('BASE');
        expect(html).toContain('MODE');
        expect(html.length).toBeGreaterThan(2000);
        if (src === 0) expect(html).toContain('ATT');
        if (src === 1) { expect(html).toContain('SKEW'); expect(html).toContain('GLOBAL'); }
        if (src >= 3) expect(html).not.toContain('TEMPO');
      }
    }
  });

  it('renders every factory preset', () => {
    for (const p of def.presets!) expect(render({ ...ecDefaultState(), ...p.params }).length).toBeGreaterThan(2000);
  });

  it('draws the envelope display for every layout without non-finite coordinates', () => {
    const st = ecDefaultState();
    const arts = st.arts as Array<{ env: ReturnType<typeof ecFlatShape>; lfo: ReturnType<typeof ecFlatShape>; maps: ReturnType<typeof ecFlatShape>[] }>;
    const shapes = [arts[0].env, arts[0].lfo, ...arts[0].maps, ecFlatShape(0.3), {
      ...ecFlatShape(0), pts: [ecPoint(0, 0), ecPoint(0.5, 1, 0.6, 'single2'), ecPoint(0.5, 0.2, -0.7, 'hold'), ecPoint(1, 1, 0.3, 'wave'), ecPoint(1.5, 0.4, 0.5, 'smooth')], d: 1, l: 2, s: 3,
    }];
    for (const [i, shape] of shapes.entries()) {
      for (const kind of ['time', 'key', 'map'] as const) {
        for (const view of [{ v0: 0, v1: 3.5, y0: 0, y1: 1 }, { v0: 0.2, v1: 0.4, y0: 0.25, y1: 0.75 }, { v0: 0, v1: 1, y0: 0, y1: 1 }]) {
          const { ctx, calls } = fakeCtx();
          drawEnvDisplay(ctx, {
            w: 720, h: 256, shape, kind, tempo: i % 2 === 1, ...view, handles: true, selected: new Set([1]), markers: kind === 'time',
            lfo: i === 1 ? { hz: 2.5, tns: 20, sk: -30, pw: 10, level: 0.5 } : null, noteLine: kind !== 'time' ? 0.4 : null,
            marquee: i === 2 ? { x0: 10, y0: 10, x1: 100, y1: 90 } : null,
          });
          expect(calls.fillRect).toBeGreaterThan(10);
          expect(calls.stroke).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('Voltage Controller editor', async () => {
  const { vcDefaultState } = await import('../../src/model/gen/plugins/voltagectrl');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const mod = await import('../../src/ui/plugins/gen/voltagectrl');

  const render = (params: Record<string, unknown>) => renderToStaticMarkup(
    createElement(FxEditorContext.Provider, { value: { slotId: 'ch:test', plugin: 'voltagectrl', params, trackName: 'Volt', pluginName: 'Voltage Controller' } }, createElement(mod.editor.Editor)),
  );

  it('renders the four output tabs', () => {
    for (let tab = 0; tab < 4; tab++) {
      const html = render({ ...vcDefaultState(), tab, on: tab % 2 === 0 });
      expect(html).toContain('Fruity Voltage Controller');
      expect(html).toContain('Left voltage');
      expect(html).toContain('Right voltage');
      expect(html).toContain('Out 4');
    }
  });
});
