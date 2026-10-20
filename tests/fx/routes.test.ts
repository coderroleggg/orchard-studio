// Mixer routing seen from an effect (kit/routes.ts): send targets and sidechain inputs.
import { describe, it, expect } from 'vitest';

describe('effect routes', () => {
  it('lists the tracks a slot sends to and the tracks routed into it, in track order', async () => {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
    const { store } = await import('../../src/store');
    const A = await import('../../src/store/actions');
    const { routesOf } = await import('../../src/ui/plugins/kit/routes');

    const slotId = A.addFx(5, 0, 'limiter');
    // sources routed into insert 5 (a level-0 route counts too: "Sidechain to this track")
    A.setSend(7, 5, 0);
    A.setSend(2, 5, 0.8);
    // insert 5 sends to 9 and 3 (besides its default route to the master)
    A.setSend(5, 9, 0.8);
    A.setSend(5, 3, 0.8);

    const ins = routesOf(store.project, slotId, 'in');
    expect(ins.map((r) => r.index)).toEqual([2, 7]);
    const { mixerTrackName } = await import('../../src/model/defaults');
    expect(ins[0].name).toBe(mixerTrackName(store.project.mixer.tracks[2]));
    const outs = routesOf(store.project, slotId, 'out').map((r) => r.index);
    expect(outs).toEqual(expect.arrayContaining([3, 9]));
    expect(outs).toEqual([...outs].sort((a, b) => a - b));
    expect(outs).not.toContain(5);

    // a module hosted in Patcher sees its host slot's track
    const { defaultFxParams } = await import('../../src/model/fx/registry');
    const host = A.addFx(5, 1, 'patcher');
    A.editFx(host, 'Add module', (p) => {
      const graph = p.$graph as { modules: Record<string, unknown>; order: string[] };
      graph.modules.m9 = { id: 'm9', plugin: 'compressor', name: 'Compressor', x: 0, y: 0, params: defaultFxParams('compressor') };
      graph.order.push('m9');
    });
    expect(routesOf(store.project, `${host}#m9`, 'in')).toEqual(ins);
    expect(routesOf(store.project, 'nope', 'in')).toEqual([]);
  });
});
