// Sytrus editor smoke tests without a browser: registration, every page /
// editor target / articulator part / delay panel rendered server side (default
// state and factory presets), the canvas drawings (matrix, scopes, curves of
// every part) on a stand-in context, and the curve edit operations.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultGenParams, genDef, genPresetState } from '../../src/model/gen/registry';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
g.document ??= { body: {}, getElementById: () => null };

/** A canvas context that accepts every call and rejects non-finite numbers. */
function fakeCtx(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => { for (const x of a) if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`non-finite argument to ${k}`); return undefined; };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

describe('Sytrus editor', async () => {
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { genEditorFor } = await import('../../src/ui/plugins/genRegistry');
  const mod = await import('../../src/ui/plugins/gen/sytrus');
  const html = (params: Record<string, unknown>) => renderToStaticMarkup(
    createElement(FxEditorContext.Provider, { value: { slotId: 'ch:test', plugin: 'sytrus', params, trackName: 'Sytrus', pluginName: 'Sytrus' } }, createElement(mod.editor.Editor)),
  );
  const withView = (p: Record<string, unknown>, v: Record<string, number>) => ({ ...p, syView: { ...(p.syView as object), ...v } });

  it('is registered for the instrument', () => {
    expect(genEditorFor('sytrus')).toBe(mod.editor);
    const p = defaultGenParams('sytrus');
    expect(mod.editor.size?.(p)).toEqual({ w: 845, h: 450 });
  });

  it('renders every page, target, part and delay panel', () => {
    const base = defaultGenParams('sytrus');
    const presets = genDef('sytrus')!.presets!;
    const states = [base, genPresetState('sytrus', presets[1]), genPresetState('sytrus', presets[Math.floor(presets.length / 2)])];
    for (const st of states) {
      const main = html(st);
      expect(main).toContain('MODULATION');
      expect(main).toContain('QUALITY');
      expect(main).toContain('MATRIX');
      for (let page = 1; page <= 10; page++) {
        const nt = page <= 6 ? 7 : page <= 9 ? 9 : 2;
        for (let target = 0; target < nt; target++) {
          for (const part of target === 0 ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2]) {
            const out = html(withView(st, { page, target, part }));
            expect(out).toContain('PAN');
          }
        }
      }
      for (let delNum = 0; delNum < 4; delNum++) expect(html(withView(st, { page: 10, delNum }))).toContain(delNum < 3 ? 'SERIAL' : 'COLOR');
      expect(html(withView(st, { rf: 1 }))).toContain('RM');
    }
    expect(html(withView(base, { page: 1 }))).toContain('BAND LIMIT');
    expect(html(withView(base, { page: 7 }))).toContain('NEXT');
    expect(html(withView(base, { page: 9 }))).not.toContain('NEXT');
  });

  it('hides the testing keyboard', () => {
    const p = defaultGenParams('sytrus') as Record<string, unknown>;
    const sy = structuredClone(p.sy) as { g: { x510: number } };
    sy.g.x510 = 0;
    expect(mod.editor.size?.({ ...p, sy })).toEqual({ w: 845, h: 348 });
  });

  it('draws the matrix, scopes and every curve', async () => {
    const { drawMatrix } = await import('../../src/ui/plugins/gen/sytrus/Matrix');
    const { drawScope, opTable } = await import('../../src/ui/plugins/gen/sytrus/scope');
    const { drawCurve, CurveGeom, fitSpan } = await import('../../src/ui/plugins/gen/sytrus/curveDraw');
    const { timesOf } = await import('../../src/ui/plugins/gen/sytrus/curve');
    const { CEnv } = await import('../../src/engine/gen/plugins/sytrus/env');
    const { resolveArt } = await import('../../src/model/gen/plugins/sytrus/defaults');
    const { UNIT_ARTS } = await import('../../src/model/gen/plugins/sytrus/types');
    const presets = genDef('sytrus')!.presets!;
    for (const st of [defaultGenParams('sytrus'), genPresetState('sytrus', presets[3]), genPresetState('sytrus', presets[700])]) {
      const sy = st.sy as import('../../src/model/gen/plugins/sytrus/types').SyState;
      const ctx = fakeCtx();
      drawMatrix(ctx, sy, 0, 10);
      drawMatrix(ctx, sy, 1, -1);
      for (const op of sy.ops) {
        const t = opTable(op, !!sy.g.gibbs);
        expect(t.every(Number.isFinite)).toBe(true);
        drawScope(ctx, 79, 64, t, '#000');
      }
      UNIT_ARTS.forEach((names, u) => names.forEach((_, a) => {
        const art = resolveArt(sy, u, a);
        art.e.forEach((env, j) => {
          const kind = j === 0 ? 'env' : j === 1 ? 'lfo' : 'map';
          const gm = new CurveGeom(533, 162, 0, fitSpan(env, kind));
          drawCurve(ctx, {
            gm, env, ce: new CEnv(env, j === 0 ? 1 : j === 1 ? 2 : 3), T: timesOf(env), kind, axis: j < 2 ? 'time' : j === 2 ? 'key' : 'unit',
            bipolar: a === 0, enabled: true, tempo: false, lfo: j === 1 ? { speed: 40000, tension: 30, skew: -20, pw: 10 } : null, hover: { kind: 'point', i: 1 }, freeze: false,
          });
        });
      }));
    }
  });

  it('edits curves keeping times and markers', async () => {
    const C = await import('../../src/ui/plugins/gen/sytrus/curve');
    const { defaultEnv } = await import('../../src/model/gen/plugins/sytrus/defaults');
    const e = defaultEnv(); // times 0, 0.75, 2.25, 2.5; decay 1, sustain 2
    const ins = C.insertPoint(e, 1.5, 0.3);
    expect(ins.index).toBe(2);
    expect(C.timesOf(ins.env)).toEqual([0, 0.75, 1.5, 2.25, 2.5]);
    expect(ins.env.m[C.M_SUS]).toBe(3);
    expect(ins.env.m[C.M_DECAY]).toBe(1);
    const del = C.deletePoint(ins.env, 2);
    expect(C.timesOf(del)).toEqual([0, 0.75, 2.25, 2.5]);
    expect(del.m[C.M_SUS]).toBe(2);
    expect(C.deletePoint(e, 0)).toBe(e);
    // move without slide: the following point keeps its time; with slide it moves along
    expect(C.timesOf(C.movePoint(e, 1, 1, 0.5, false, 'env'))).toEqual([0, 1, 2.25, 2.5]);
    expect(C.timesOf(C.movePoint(e, 1, 1, 0.5, true, 'env'))).toEqual([0, 1, 2.5, 2.75]);
    expect(C.movePoint(e, 1, 5, 2, false, 'env').p[1][1]).toBe(1);
    expect(C.timesOf(C.movePoint(e, 1, 5, 0, false, 'env'))[1]).toBe(2.25);
    const t = C.setPointField(e, 2, 3, 5);
    expect(t.p[2]).toEqual([1.5, 0.5, 0.2, 5]);
    expect(C.setPointField(t, 2, 3, 0).p[2]).toEqual([1.5, 0.5, 0.2]);
    expect(C.isEnabled(C.setEnabled(e, true))).toBe(true);
    expect(C.setFlag(e, 4, true).m[0]).toBe(4);
    expect(C.toggleMarker(e, C.M_LOOP, 1).m[C.M_LOOP]).toBe(1);
  });
});
