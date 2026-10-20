import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, formatParam, fxDef } from '../../src/model/fx/registry';
import { phaseInverterState } from '../../src/model/fx/plugins/phaseinverter';
import { render } from './util';

describe('Phase Inverter', () => {
  it('is registered as a hidden legacy plugin with FL\'s wheel and state names', () => {
    const d = fxDef('phaseinverter')!;
    expect(d.name).toBe('Phase Inverter');
    expect(d.hidden).toBe(true);
    expect([d.width, d.height]).toEqual([170, 55]);
    expect(d.params.map((p) => [p.key, p.name, p.index, p.min, p.max, p.def])).toEqual([['state', 'State', 0, 0, 1024, 1024]]);
    // thresholds measured in FL (renders and the editor's label captions)
    const text = (v: number) => formatParam(d.params[0], v);
    expect([0, 341, 342, 512, 682, 683, 1024].map(text)).toEqual(['Off', 'Off', 'Left', 'Left', 'Left', 'Right', 'Right']);
    expect(phaseInverterState(NaN)).toBe(2);
  });

  it('inverts the chosen channel exactly (default: right)', () => {
    const l = new Float32Array([0.5, -0.25, 0, 1]), r = new Float32Array([0.125, 0.75, -1, 0.3]);
    const run = (state: number) => {
      const fx = createEffect('phaseinverter', 44100, 128);
      fx.setParams({ ...defaultFxParams('phaseinverter'), state });
      return render(fx, l, r);
    };
    const [L0, R0] = run(1024);
    expect(Array.from(L0)).toEqual(Array.from(l));
    expect(Array.from(R0)).toEqual(Array.from(r).map((v) => -v));
    const [L1, R1] = run(512);
    expect(Array.from(L1)).toEqual(Array.from(l).map((v) => -v));
    expect(Array.from(R1)).toEqual(Array.from(r));
    const [L2, R2] = run(0);
    expect(Array.from(L2)).toEqual(Array.from(l));
    expect(Array.from(R2)).toEqual(Array.from(r));
  });

  it('switches at once (no ramp), as FL does', () => {
    const fx = createEffect('phaseinverter', 44100, 128);
    fx.setParams({ state: 0 });
    const [a] = render(fx, new Float32Array(128).fill(0.5));
    fx.setParams({ state: 400 });
    const [b] = render(fx, new Float32Array(128).fill(0.5));
    expect(a[127]).toBe(0.5);
    expect(b[0]).toBe(-0.5);
  });
});
