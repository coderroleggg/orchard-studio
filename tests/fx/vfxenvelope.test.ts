import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import { lfoWave, processNotes, scaledEnvelope, timelineValue } from '../../src/engine/effects/plugins/vfxenvelope';
import { defaultArticulator, envKey, normalizeArticulators, type Articulator } from '../../src/model/fx/plugins/vfxenvelope';
import { envFrom } from '../../src/model/fx/plugins/vfx/envelope';
import { note, vfxContext } from '../../src/model/fx/plugins/vfx/notes';
import { makeCtx } from './util';

const base = () => defaultFxParams('vfxenvelope');
const preset = (name: string) => {
  const p = fxDef('vfxenvelope')!.presets!.find((q) => q.name === name)!;
  return { ...base(), ...structuredClone(p.params) };
};
/** Value of a mod curve at a tick (step curve sampling). */
const at = (c: [number, number][] | undefined, tick: number) => {
  if (!c) return undefined;
  let v = c[0][1];
  for (const [t, x] of c) if (t <= tick) v = x;
  return v;
};

describe('VFX Envelope', () => {
  it('has FL\'s 880 parameters with the Default preset\'s values', () => {
    const d = fxDef('vfxenvelope')!;
    expect(d.width).toBe(768);
    expect(d.height).toBe(400);
    expect(d.params).toHaveLength(880);
    expect(d.params[0]).toMatchObject({ name: 'Articulator 1 Velocity - Attack', index: 0, min: 0, max: 256, def: 128 });
    expect(d.params[4]).toMatchObject({ name: 'Articulator 1 Velocity - LFO Speed', min: 512, max: 65536, def: 40898 });
    expect(d.params[8]).toMatchObject({ name: 'Articulator 1 Velocity - Base Level', def: 0 });
    expect(d.params[20]).toMatchObject({ name: 'Articulator 1 Pitch - Envelope Level', def: 64 });
    expect(d.params[879]).toMatchObject({ name: 'Articulator 16 Mod Y - LFO Level', index: 879, def: 256 });
    expect(formatParam(d.params[0], 128)).toBe('x1.00');
    expect(d.presets!.map((p) => p.name)).toEqual(['Default', 'Default (all channels)', 'Pumping', 'Vibrato']);
    const arts = base().arts as Articulator[];
    expect(arts).toHaveLength(16);
    expect(arts.every((a) => a.color === 0)).toBe(true);
    expect((preset('Default (all channels)').arts as Articulator[]).map((a) => a.color)).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it('plays the envelope: stops at S while held, loops D..S with loop on, then releases', () => {
    const pts = envFrom([[0, 0], [0.75, 1, 0.2], [2.25, 0.5, 0.2], [2.5, 0, 0.2]]);
    expect(timelineValue(pts, false, 1, 2, 8, 0.75)).toBeCloseTo(1, 6);
    expect(timelineValue(pts, false, 1, 2, 8, 5)).toBeCloseTo(0.5, 6); // sustain
    expect(timelineValue(pts, false, 1, 2, 8, 8.25 + 0.25)).toBeCloseTo(0, 6); // released at 8: S + 0.25 = end
    const pump = envFrom([[0, 0], [0.5, 1, -0.16], [1, 0, 0, 2]]);
    expect(timelineValue(pump, true, 0, 2, 16, 0.75)).toBeCloseTo(1, 6); // hold segment
    expect(timelineValue(pump, true, 0, 2, 16, 2.75)).toBeCloseTo(timelineValue(pump, true, 0, 2, 16, 0.75), 9); // loops every beat
    expect(timelineValue(pump, true, 0, 2, 16, 3.0)).toBeCloseTo(0, 6);
  });

  it('applies the Default velocity envelope to colour-1 notes (attack, decay to 50% sustain, release)', () => {
    const [n] = processNotes([note({ key: 60, vel: 100, len: 96 * 8, color: 0 })], base(), vfxContext({ ppq: 96 }));
    const v = n.mod!.vel!;
    expect(at(v, 0)).toBeCloseTo(0, 6);
    expect(at(v, 72)).toBeCloseTo(100, 0); // 0.75 beats: peak
    expect(at(v, 96 * 4)).toBeCloseTo(50, 0); // sustain
    expect(n.mod!.pitch).toBeUndefined(); // flat bipolar envelopes change nothing
    expect(n.vel).toBe(100);
  });

  it('answers only notes of the articulator\'s colour inside its key range', () => {
    const p = base();
    const arts = normalizeArticulators(p.arts);
    arts.forEach((a, i) => { a.color = i; });
    arts[2].low = 60; arts[2].high = 72;
    arts[2].targets[0] = { ...arts[2].targets[0], env: envFrom([[0, 0.25], [1, 0.25]]), sus: -1, dec: -1 };
    const q = { ...p, arts };
    const [a, b] = processNotes([note({ key: 64, color: 2, vel: 100 }), note({ key: 80, color: 2, vel: 100 })], q);
    expect(at(a.mod!.vel, 0)).toBeCloseTo(25, 6);
    expect(b.mod).toBeUndefined();
    const off = processNotes([note({ key: 60, color: 0 })], { ...p, enable: 0 });
    expect(off[0].mod).toBeUndefined();
  });

  it('scales envelope parts with ATT / DEC / REL and offsets the sustain level with SUS', () => {
    const t = defaultArticulator().targets[0];
    const s = scaledEnvelope(t, 192, 128, 64, 0);
    expect(s[1].pos).toBeCloseTo(0.75 * 2, 6); // attack x2
    expect(s[2].pos - s[1].pos).toBeCloseTo(1.5, 6); // decay x1
    expect(s[2].value).toBeCloseTo(1, 6); // 0.5 + 64/128
    expect(s[3].pos - s[2].pos).toBeCloseTo(0.25 * 0.25, 6); // release x0.25
    const p = { ...base(), [envKey(0, 0, 'Att')]: 0 };
    const [n] = processNotes([note({ key: 60, vel: 100, len: 960 })], p, vfxContext({ ppq: 96 }));
    expect(at(n.mod!.vel, 24)).toBeGreaterThan(90); // fast attack
  });

  it('pumps the velocity every beat (Pumping) and adds a gentle vibrato (Vibrato)', () => {
    const [n] = processNotes([note({ key: 60, vel: 100, len: 96 * 4 })], preset('Pumping'), vfxContext({ ppq: 96 }));
    expect(at(n.mod!.vel, 0)).toBeCloseTo(0, 6);
    expect(at(n.mod!.vel, 72)).toBeCloseTo(100, 0);
    expect(at(n.mod!.vel, 96 + 72)).toBeCloseTo(100, 0);
    expect(at(n.mod!.vel, 96 + 8)).toBeLessThan(30);
    const [m] = processNotes([note({ key: 60, vel: 100, len: 96 * 2 })], preset('Vibrato'), vfxContext({ ppq: 96 }));
    expect(m.mod!.vel).toBeUndefined(); // velocity envelope flat at 100%
    const pitch = m.mod!.pitch!.map((c) => c[1]);
    expect(Math.max(...pitch)).toBeGreaterThan(0.2);
    expect(Math.max(...pitch)).toBeLessThan(0.5); // a fraction of a semitone
    expect(Math.min(...pitch)).toBeLessThan(-0.2);
  });

  it('shapes the LFO with skew and pulse width and stays within -1..1', () => {
    expect(lfoWave(0.25, 0, 0, 0)).toBeCloseTo(1, 6);
    expect(lfoWave(0.75, 0, 0, 0)).toBeCloseTo(-1, 6);
    expect(lfoWave(0.1, 0, 0.8, 0)).toBeGreaterThan(lfoWave(0.1, 0, 0, 0) - 1);
    for (let i = 0; i < 200; i++) { const w = lfoWave(i / 37, (i % 7) / 3 - 1, (i % 5) / 2.5 - 1, (i % 3) - 1); expect(Math.abs(w)).toBeLessThanOrEqual(1); }
    expect(Math.abs(lfoWave(0.1, 0, 0, 0.9))).toBeGreaterThan(Math.abs(lfoWave(0.1, 0, 0, 0))); // squarer
  });

  it('does nothing to audio in a mixer slot', () => {
    const fx = createEffect('vfxenvelope', 48000, 128);
    fx.setParams(base());
    const L = new Float32Array(128).fill(0.3), R = new Float32Array(128).fill(0.3);
    fx.process(L, R, 128, makeCtx());
    expect(L[1]).toBeCloseTo(0.3, 7);
  });
});
