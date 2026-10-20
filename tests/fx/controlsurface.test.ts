import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, fxOutputs } from '../../src/model/fx/registry';
import { newControl, type CSControl } from '../../src/model/fx/plugins/controlsurface';
import { Engine } from '../../src/engine/Engine';
import { createMixerTrack } from '../../src/model/defaults';
import { targetKey, type AutomationTarget } from '../../src/model/automation';
import { makeCtx } from './util';

describe('Control Surface', () => {
  it('starts with an X/Y pad, a knob, a slider and a button, each an output', () => {
    const d = fxDef('controlsurface')!;
    expect([d.width, d.height]).toEqual([540, 454]);
    expect(d.category).toBe('Controller');
    const p = defaultFxParams('controlsurface');
    expect((p.controls as CSControl[]).map((c) => c.type)).toEqual(['xy', 'knob', 'slider', 'button']);
    expect(fxOutputs('controlsurface', p)).toEqual(['XY 1 X', 'XY 1 Y', 'Knob 2', 'Slider 3', 'Button 4']);
  });

  it('gives new controls new output indices; removed controls leave their index unused', () => {
    let p = defaultFxParams('controlsurface');
    const { control, values } = newControl(p, 'knob', 10, 10);
    expect(control.outs).toEqual([5]);
    expect(control.name).toBe('Knob 5');
    p = { ...p, controls: [...(p.controls as CSControl[]).filter((c) => c.type !== 'slider'), control], values };
    expect(fxOutputs('controlsurface', p)).toEqual(['XY 1 X', 'XY 1 Y', 'Knob 2', '', 'Button 4', 'Knob 5']);
    expect(newControl(p, 'label', 0, 0).control.outs).toEqual([]);
    expect(newControl(p, 'xy', 0, 0).control.outs).toEqual([6, 7]);
  });

  it('outputs its control values (0..1) and passes audio', () => {
    const fx = createEffect('controlsurface', 48000, 128);
    fx.setParams({ ...defaultFxParams('controlsurface'), values: [0.1, 0.9, 0.5, 2, -1] });
    const L = new Float32Array(128).fill(0.4), R = new Float32Array(128).fill(0.4);
    fx.process(L, R, 128, makeCtx());
    expect(Array.from(fx.controls!())).toEqual([0.1, 0.9, 0.5, 1, 0]);
    expect(L[9]).toBeCloseTo(0.4, 6);
  });

  it('a surface knob drives a linked mixer volume', () => {
    const e = new Engine({ sampleRate: 48000, blockSize: 128 });
    e.handle({ t: 'globals', g: { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
    for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: createMixerTrack(i) });
    const tr = createMixerTrack(4);
    const params = { ...defaultFxParams('controlsurface') };
    (params.values as number[])[2] = 0.3; // Knob 2
    tr.slots[0] = { id: 'cs', plugin: 'controlsurface', name: 'Control Surface', enabled: true, mix: 1, params };
    e.handle({ t: 'mixerTrack', tr });
    const vol: AutomationTarget = { scope: 'mixer', id: '1', path: 'volume', min: 0, max: 1, label: 'Insert 1 - Volume' };
    e.handle({ t: 'links', list: [{ id: 'l', target: vol, source: { slotId: 'cs', output: 2 }, formula: 'Input' }] });
    e.renderOffline(256);
    expect(e.linkCurrent.get(targetKey(vol))).toBeCloseTo(0.3, 9);
  });
});
