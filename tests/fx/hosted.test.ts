// Slot actions address effect modules hosted in Patcher as "<slot id>#<module id>".
import { describe, it, expect } from 'vitest';

describe('hosted module ids', () => {
  it('resolve, edit and undo inside a Patcher module', async () => {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
    const { store } = await import('../../src/store');
    const A = await import('../../src/store/actions');
    const { defaultFxParams } = await import('../../src/model/fx/registry');

    const slotId = A.addFx(3, 0, 'patcher');
    // put a Balance module into the Patcher graph
    A.editFx(slotId, 'Add module', (p) => {
      const graph = (p.$graph ?? (p.$graph = { version: 1, modules: {}, order: [], links: [], io: { in: { x: 0, y: 0 }, out: { x: 0, y: 0 } } })) as {
        modules: Record<string, unknown>; order: string[];
      };
      graph.modules.m1 = { id: 'm1', plugin: 'balance', name: 'Balance', x: 0, y: 0, params: defaultFxParams('balance') };
      graph.order.push('m1');
    });
    const hid = `${slotId}#m1`;
    const loc = A.findFx(store.project, hid);
    expect(loc?.fx.plugin).toBe('balance');
    expect(loc?.hosted).toEqual({ slotId, moduleId: 'm1' });

    A.setFxParam(hid, 'vol', 128);
    A.editFx(hid, 'Pan', (p) => { p.pan = -64; });
    const mod = () => (store.project.mixer.tracks[3].slots[0]!.params.$graph as { modules: Record<string, { params: Record<string, unknown> }> }).modules.m1.params;
    expect(mod().vol).toBe(128);
    expect(mod().pan).toBe(-64);
    // nothing leaked to the top level of Patcher's state
    expect((store.project.mixer.tracks[3].slots[0]!.params as Record<string, unknown>).vol).toBeUndefined();

    store.undo();
    expect(mod().pan).toBe(0);
    A.setFxStateNoHistory(hid, 'View', (p) => { p.view = 2; });
    expect(mod().view).toBe(2);
    expect(A.findFx(store.project, `${slotId}#nope`)).toBeNull();

    // the writable draft of a hosted module, inside a recipe
    store.update('Draft', (d) => { A.fxParamsDraft(d, hid)!.vol = 64; });
    expect(mod().vol).toBe(64);

    // every effect, hosted modules included, with their ids
    const { allFx, fxTargetOf } = await import('../../src/model/fx/hosted');
    const all = [...allFx(store.project)].filter((x) => x.id.startsWith(slotId));
    expect(all.map((x) => [x.id, x.plugin])).toEqual([[slotId, 'patcher'], [hid, 'balance']]);
    expect([...allFx(store.project, 'balance')].map((x) => x.id)).toContain(hid);

    // automation / link targets: the mixer slot, with the path inside it
    expect(fxTargetOf(hid, 'vol')).toEqual({ id: slotId, path: 'params.$graph.modules.m1.params.vol' });
    expect(fxTargetOf(slotId, 'x')).toEqual({ id: slotId, path: 'params.x' });
    const { getPath } = await import('../../src/model/automation');
    const t = fxTargetOf(hid, 'vol');
    expect(getPath(store.project.mixer.tracks[3].slots[0]!, t.path)).toBe(64);
  });
});
