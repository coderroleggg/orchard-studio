import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { processNotes } from '../../src/engine/effects/plugins/vfxcolormapper';
import { note } from '../../src/model/fx/plugins/vfx/notes';
import { pluginPorts } from '../../src/model/fx/plugins/patcher';
import { makeCtx } from './util';

describe('VFX Color Mapper', () => {
  it('is registered with FL parameter names, ranges and the identity mapping', () => {
    const d = fxDef('vfxcolormapper')!;
    expect(d.category).toBe('Patcher');
    expect(d.width).toBe(319);
    expect(d.height).toBe(230);
    expect(d.params).toHaveLength(32);
    expect(d.params[0]).toMatchObject({ name: 'Note color group 1to voice output', index: 0, min: 0, max: 15, def: 0 });
    expect(d.params[31]).toMatchObject({ name: 'Note color group 16to note color group', index: 31, def: 15 });
    expect(formatParam(d.params[15], 1)).toBe('16 to 2');
    const p = defaultFxParams('vfxcolormapper');
    expect(p.out5).toBe(4);
    expect(p.col16).toBe(15);
    // 16 voice outputs in Patcher, voice ports 1-4 active on a new module
    expect(pluginPorts('vfxcolormapper')).toEqual({ audioIn: 0, audioOut: 0, eventsIn: 1, eventsOut: 16 });
  });

  it('routes each note colour to its voice output (identity by default)', () => {
    const p = defaultFxParams('vfxcolormapper');
    const out = processNotes([note({ key: 60, color: 0 }), note({ key: 62, color: 4 }), note({ key: 64, color: 15 })], p);
    expect(out.map((n) => n.port)).toEqual([0, 4, 15]);
    expect(out.map((n) => n.color)).toEqual([0, 4, 15]);
    expect(out.map((n) => n.key)).toEqual([60, 62, 64]);
  });

  it('maps several colours to one port and recolours notes (e.g. colour 13 behaving as colour 16)', () => {
    const p = { ...defaultFxParams('vfxcolormapper'), out1: 0, out5: 0, out9: 0, out13: 0, col13: 15 };
    const out = processNotes([0, 4, 8, 12].map((c) => note({ key: 60 + c, color: c, vel: 90 })), p);
    expect(out.every((n) => n.port === 0)).toBe(true);
    expect(out.map((n) => n.color)).toEqual([0, 4, 8, 15]);
    expect(out[3]).toMatchObject({ key: 72, vel: 90, pos: 0, len: 96 }); // other properties untouched
  });

  it('does nothing to audio in a mixer slot', () => {
    const fx = createEffect('vfxcolormapper', 48000, 128);
    fx.setParams(defaultFxParams('vfxcolormapper'));
    const L = new Float32Array(128).fill(0.3), R = new Float32Array(128).fill(-0.2);
    fx.process(L, R, 128, makeCtx());
    expect(L[77]).toBeCloseTo(0.3, 7);
    expect(R[3]).toBeCloseTo(-0.2, 7);
  });
});
