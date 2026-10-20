import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, formatParam, fxDef } from '../../src/model/fx/registry';
import { render } from './util';

function out(mute: number, channel: number): [number, number] {
  const fx = createEffect('mute2', 44100, 128);
  fx.setParams({ ...defaultFxParams('mute2'), mute, channel });
  const [L, R] = render(fx, new Float32Array(256).fill(0.5), new Float32Array(256).fill(0.25));
  return [L[200], R[200]];
}

describe('Mute 2', () => {
  it('is registered as a hidden legacy plugin with FL\'s wheels and labels', () => {
    const d = fxDef('mute2')!;
    expect(d.name).toBe('Mute 2');
    expect(d.hidden).toBe(true);
    expect([d.width, d.height]).toEqual([335, 55]);
    expect(d.params.map((p) => [p.key, p.name, p.index, p.min, p.max, p.def])).toEqual([
      ['mute', 'Mute', 0, 0, 1024, 512], ['channel', 'Channel', 1, 0, 1024, 512],
    ]);
    // the editor's label captions read from FL at these values
    const mute = (v: number) => formatParam(d.params[0], v), ch = (v: number) => formatParam(d.params[1], v);
    expect([0, 511, 512, 1024].map(mute)).toEqual(['Off', 'Off', 'On', 'On']);
    expect([0, 341, 342, 682, 683, 1024].map(ch)).toEqual(['L', 'L', 'L + R', 'L + R', 'R', 'R']);
  });

  it('mutes like FL: L, both or R below 512; passes from 512 up', () => {
    // flfxhost measurements with L = 0.5, R = 0.25 DC
    expect(out(0, 0)).toEqual([0, 0.25]);
    expect(out(0, 341)).toEqual([0, 0.25]);
    expect(out(511, 342)).toEqual([0, 0]);
    expect(out(0, 682)).toEqual([0, 0]);
    expect(out(0, 683)).toEqual([0.5, 0]);
    expect(out(0, 1024)).toEqual([0.5, 0]);
    for (const c of [0, 512, 1024]) expect(out(512, c)).toEqual([0.5, 0.25]);
    expect(out(1024, 0)).toEqual([0.5, 0.25]);
  });

  it('switches at once, without a ramp (as FL)', () => {
    const fx = createEffect('mute2', 44100, 128);
    fx.setParams({ mute: 1024, channel: 512 });
    const [a] = render(fx, new Float32Array(128).fill(0.5));
    fx.setParams({ mute: 0, channel: 512 });
    const [b] = render(fx, new Float32Array(128).fill(0.5));
    expect(a[127]).toBe(0.5);
    expect(b[0]).toBe(0);
  });
});
