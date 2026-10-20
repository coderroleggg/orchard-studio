// Keyboard Controller (FL: Fruity Keyboard Controller): registration (FL's
// parameters, value texts, factory presets, plugin database state) and the
// behaviour measured on the real plugin in the test host: key range, key
// values, velocity law, the held-key stack, note off value, the smoothing
// envelope's per-tick law and the first-note rule.
import { describe, it, expect } from 'vitest';
import { genDef, genOutputs, genPresetState, defaultGenParams, formatParam, genInCategory } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { KB_KEYS, KB_VEL_SCALE, kbAutoMap, kbKeyName, kbSmoothMs, kbValueOf } from '../../src/model/gen/plugins/keyboardctrl';
import { createGenChannel } from '../../src/model/defaults';
import { driveCtl, valueAt } from './ctlutil';
import { makeEngine, play } from './util';
import { GenChannel } from '../../src/engine/GenChannel';

const D = genDef('keyboardctrl')!;
const SR = 44100;
const SPT = (SR * 60) / (130 * 96); // 212.0189 samples per tick at 130 BPM

function make(params: Record<string, unknown> = {}) {
  const k = createGen('keyboardctrl', SR, 128)!;
  k.setParams({ ...defaultGenParams('keyboardctrl'), ...params });
  return k;
}

/** Output `i` after the tick at sample floor(n x SPT) (blocks of 32 hold at most one tick). */
const afterTick = (r: ReturnType<typeof driveCtl>, i: number, n: number) => valueAt(r, i, Math.floor(n * SPT) + 32);

describe('Keyboard Controller: registration', () => {
  it('has FL\'s parameters, ranges, defaults, outputs and form size', () => {
    expect(D.name).toBe('Keyboard Controller');
    expect(D.category).toBe('Controller');
    expect(genInCategory('Controller').map((d) => d.id)).toContain('keyboardctrl');
    expect(D.notes).toBe('voices');
    expect(D.noAudio).toBe(true);
    expect([D.width, D.height]).toEqual([558, 232]);
    expect(D.params.map((q) => [q.index, q.name, q.min, q.max, q.def])).toEqual([
      [0, 'Smoothing envelope attack time', 0, 256, 32],
      [1, 'Smoothing envelope release time', 0, 256, 32],
    ]);
    expect(genOutputs('keyboardctrl')).toEqual(['Note', 'Velocity']);
  });

  it('writes FL\'s smoothing time texts (test host)', () => {
    const a = D.params[0];
    const got = [0, 1, 8, 16, 32, 64, 128, 192, 256].map((v) => formatParam(a, v));
    expect(got).toEqual(['0ms', '1ms', '8ms', '16ms', '35ms', '82ms', '232ms', '504ms', '1000ms']);
    expect(kbSmoothMs(256)).toBeCloseTo(1000, 6);
  });

  it('a new instance is FL\'s plugin database state: no smoothing, range 48..71, white keys mapped', () => {
    const p = defaultGenParams('keyboardctrl');
    expect([p.attack, p.release, p.lo, p.hi, p.noteOff, p.autoRel]).toEqual([0, 0, 48, 71, 0, false]);
    const v = p.values as number[];
    expect(v).toHaveLength(KB_KEYS);
    // C4 = 0, D4 = 1/13 (C#4 keeps C's value), E4 = 2/13 ... B5 = 1, white keys of the range spread over 14 steps
    expect([48, 49, 50, 51, 52, 60, 71].map((k) => Math.round(v[k] * 13 * 1e6) / 1e6)).toEqual([0, 0, 1, 1, 2, 7, 13]);
    expect([v[0], v[47], v[72], v[131]]).toEqual([0, 0, 1, 1]);
    expect(kbKeyName(60)).toBe('C5');
    expect(kbKeyName(49)).toBe('C#4');
  });

  it('Auto map reproduces every factory preset (FL\'s .fst data)', () => {
    const blank = new Array(KB_KEYS).fill(0);
    // spot values read from FL's preset states
    const gb = kbAutoMap(blank, 48, 108, true);
    expect(gb[50]).toBeCloseTo(1 / 35, 6);
    expect(gb[108]).toBe(1);
    const full = kbAutoMap(blank, 0, 256, true);
    expect(full[2]).toBeCloseTo(1 / 69, 6);
    expect(full[119]).toBe(1);
    const pitch = kbAutoMap(blank, 12, 108, false);
    expect(pitch[13]).toBeCloseTo(1 / 96, 6);
    expect(pitch[60]).toBeCloseTo(0.5, 6);
    const oct = kbAutoMap(blank, 60, 71, false);
    expect(oct[61]).toBeCloseTo(1 / 11, 6);
    expect(D.presets!.map((p) => p.name)).toEqual([
      '1 octave (white + black)', '1 octave (white only)', 'Default', 'Full keyboard (white only)',
      'Gross Beat - white + black', 'Gross Beat - white only', 'To pitch knob (transposing)',
    ]);
    const s = genPresetState('keyboardctrl', D.presets![3]);
    expect(s.hi).toBe(256);
    expect(s.attack).toBe(0);
    expect(s.__preset).toBe('Full keyboard (white only)');
  });

  it('Interpolate keeps the range\'s end values', () => {
    const base = new Array(KB_KEYS).fill(0);
    base[60] = 0.2; base[71] = 0.8;
    const v = kbAutoMap(base, 60, 71, false, true);
    expect(v[60]).toBeCloseTo(0.2, 6);
    expect(v[71]).toBeCloseTo(0.8, 6);
    expect(v[65]).toBeCloseTo(0.2 + 0.6 * (5 / 11), 6);
    expect(kbValueOf(v, 200)).toBe(v[131]);
  });
});

describe('Keyboard Controller: keys and velocity', () => {
  it('answers the key range only; the Note output is the key\'s value (test host: C5 -> 7/13, keys outside refused)', () => {
    const k = make();
    const p = (key: number) => ({ key, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 }, levels: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 } });
    expect(k.triggerVoice!(p(47))).toBeNull();
    expect(k.triggerVoice!(p(72))).toBeNull();
    expect(k.triggerVoice!(p(48))).not.toBeNull();
    expect(k.triggerVoice!(p(71))).not.toBeNull();
    const r = driveCtl(make(), [{ at: 1000, len: 8000, key: 60 }], 12000, { block: 32 });
    expect(valueAt(r, 0, 12000)).toBeCloseTo(7 / 13, 6);
    // out of range: nothing is ever sent
    const o = driveCtl(make(), [{ at: 1000, len: 8000, key: 80 }], 12000, { block: 32 });
    expect(Number.isNaN(valueAt(o, 0, 12000))).toBe(true);
  });

  it('Velocity = velocity / 128 x 65512 / 65536 (FL: 838553536 / 2^30 at velocity 100, 1073348480 at 128)', () => {
    for (const vel of [0, 1, 32, 64, 100, 127, 128]) {
      const r = driveCtl(make(), [{ at: 500, len: 3000, key: 60, vel }], 6000, { block: 32 });
      expect(valueAt(r, 1, 6000)).toBeCloseTo((vel / 128) * KB_VEL_SCALE, 9);
    }
    expect(100 / 128 * KB_VEL_SCALE * 2 ** 30).toBeCloseTo(838553600, -2);
  });
});

describe('Keyboard Controller: held keys and the note off value', () => {
  // test host (smoothing 0): C5 v100, E5 v50, G5 v30 pressed in turn, released newest first
  const notes = [
    { at: Math.round(0.05 * SR), len: Math.round(0.95 * SR), key: 60, vel: 100 },
    { at: Math.round(0.2 * SR), len: Math.round(0.6 * SR), key: 64, vel: 50 },
    { at: Math.round(0.4 * SR), len: Math.round(0.2 * SR), key: 67, vel: 30 },
  ];
  const at = (s: number) => Math.round(s * SR);

  it('the last held key is the target, releasing it returns to the key pressed before', () => {
    const r = driveCtl(make({ attack: 0, release: 0 }), notes, at(1.2), { block: 32 });
    const n = (s: number) => valueAt(r, 0, at(s));
    const v = (s: number) => valueAt(r, 1, at(s));
    expect([n(0.1), v(0.1)]).toEqual([expect.closeTo(7 / 13, 6), expect.closeTo(0.780941, 4)]);
    expect([n(0.3), v(0.3)]).toEqual([expect.closeTo(9 / 13, 6), expect.closeTo(0.390470, 4)]);
    expect([n(0.5), v(0.5)]).toEqual([expect.closeTo(11 / 13, 6), expect.closeTo(0.234282, 4)]);
    // G5 released: back to E5, then E5 released: back to C5
    expect([n(0.7), v(0.7)]).toEqual([expect.closeTo(9 / 13, 6), expect.closeTo(0.390470, 4)]);
    expect([n(0.9), v(0.9)]).toEqual([expect.closeTo(7 / 13, 6), expect.closeTo(0.780941, 4)]);
    // the last key released: nothing changes without auto release
    expect([n(1.15), v(1.15)]).toEqual([expect.closeTo(7 / 13, 6), expect.closeTo(0.780941, 4)]);
  });

  it('auto release sends the note off value when the last key is released (Velocity keeps its value)', () => {
    const r = driveCtl(make({ attack: 0, release: 0, autoRel: true, noteOff: 0.25 }), notes, at(1.2), { block: 32 });
    expect(valueAt(r, 0, at(1.15))).toBeCloseTo(0.25, 6);
    expect(valueAt(r, 1, at(1.15))).toBeCloseTo(0.780941, 4);
    // a middle key released while a newer one is held changes nothing
    const m = driveCtl(make({ attack: 0, release: 0 }), [
      { at: at(0.05), len: at(0.3), key: 60, vel: 100 }, { at: at(0.1), len: at(0.6), key: 64, vel: 100 },
    ], at(0.6), { block: 32 });
    expect(valueAt(m, 0, at(0.5))).toBeCloseTo(9 / 13, 6);
  });
});

describe('Keyboard Controller: smoothing envelope', () => {
  it('the first key sets the outputs at the next tick without smoothing (FL: C5 at sample 4410 -> tick 21 at sample 4452)', () => {
    const r = driveCtl(make({ attack: 200, release: 200 }), [{ at: 4410, len: 20000, key: 60 }], 8000, { block: 32 });
    expect(valueAt(r, 0, 4410 + 32)).toBeNaN();             // before the next tick: nothing sent yet
    expect(valueAt(r, 0, Math.floor(21 * SPT) + 32)).toBeCloseTo(7 / 13, 9);
    expect(valueAt(r, 0, 8000)).toBeCloseTo(7 / 13, 9);
  });

  it('every tick moves an output toward its target by 1 - 0.01^(tick / T): the test host\'s per-tick factors', () => {
    // C5 held, B5 (key 71, value 1) pressed 0.2 s later; attack = release = v. FL's first-tick fractions moved:
    const host: [number, number][] = [[16, 0.74571], [32, 0.46921], [64, 0.23627], [128, 0.09107], [192, 0.04290], [255, 0.02204], [256, 0.02182]];
    for (const [v, frac] of host) {
      const r = driveCtl(make({ attack: v, release: v }), [{ at: 882, len: 66000, key: 60 }, { at: 8820, len: 60000, key: 71 }], 14000, { block: 32 });
      const tick = Math.ceil(8820 / SPT); // the first tick after the second key
      const x = afterTick(r, 0, tick);
      expect((x - 7 / 13) / (1 - 7 / 13)).toBeCloseTo(frac, 3);
    }
  });

  it('rises with the attack time and falls with the release time (the direction decides, not the key event)', () => {
    // attack slow / release instant: C5 -> B5 (rising) is slow, B5 -> D4 (falling) is instant
    const up = driveCtl(make({ attack: 200, release: 0 }), [{ at: 882, len: 66000, key: 60 }, { at: 8820, len: 60000, key: 71 }], 14000, { block: 32 });
    expect(afterTick(up, 0, Math.ceil(8820 / SPT))).toBeLessThan(0.56);
    const down = driveCtl(make({ attack: 200, release: 0 }), [{ at: 882, len: 66000, key: 71 }, { at: 8820, len: 60000, key: 50 }], 14000, { block: 32 });
    expect(afterTick(down, 0, Math.ceil(8820 / SPT))).toBeCloseTo(1 / 13, 9);
    // returning to the held key after releasing the newer one rises again with the attack time
    const back = driveCtl(make({ attack: 200, release: 0 }), [{ at: 882, len: 66000, key: 71 }, { at: 8820, len: 20000, key: 50 }], 40000, { block: 32 });
    const t = Math.ceil(28820 / SPT);
    expect(afterTick(back, 0, t)).toBeGreaterThan(1 / 13);
    expect(afterTick(back, 0, t)).toBeLessThan(0.2);
  });

  it('smooths the note off value like any target (FL: 0.5385 -> 0.5 at attack = release = 32: 0.52041, 0.51083, 0.50575)', () => {
    const r = driveCtl(make({ attack: 32, release: 32, autoRel: true, noteOff: 0.5 }), [{ at: 2205, len: 13230, key: 60 }], 24000, { block: 32 });
    const t0 = Math.ceil(15435 / SPT);
    expect(afterTick(r, 0, t0)).toBeCloseTo(0.52041, 4);
    expect(afterTick(r, 0, t0 + 1)).toBeCloseTo(0.51083, 4);
    expect(afterTick(r, 0, t0 + 2)).toBeCloseTo(0.50575, 4);
  });

  it('the factor follows the tempo: tick time stays real time (FL: 0.2817 at 65 BPM, 0.7285 at 260 BPM)', () => {
    for (const [bpm, ratio] of [[65, 0.28169], [130, 0.53074], [260, 0.72852]] as [number, number][]) {
      const spt = (SR * 60) / (bpm * 96);
      const r = driveCtl(make({ attack: 32, release: 32 }), [{ at: 882, len: 90000, key: 60 }, { at: 8820, len: 60000, key: 71 }], 16000, { block: 32, tempo: bpm });
      const tick = Math.ceil(8820 / spt);
      const x1 = valueAt(r, 0, Math.floor(tick * spt) + 32);
      const x2 = valueAt(r, 0, Math.floor((tick + 1) * spt) + 32);
      expect((1 - x2) / (1 - x1)).toBeCloseTo(ratio, 3);
    }
  });

  it('keeps running while the song is stopped (free running ticks)', () => {
    const r = driveCtl(make({ attack: 64, release: 64 }), [{ at: 882, len: 90000, key: 60 }, { at: 8820, len: 60000, key: 71 }], 20000, { block: 32, playing: false });
    expect(valueAt(r, 0, 20000)).toBeGreaterThan(valueAt(r, 0, 12000));
    expect(valueAt(r, 0, 20000)).toBeLessThan(1);
  });

  it('output stays finite at extreme settings and many notes', () => {
    const notes = Array.from({ length: 60 }, (_, i) => ({ at: 300 * i, len: 20000, key: 48 + (i % 24), vel: (i * 7) % 129 }));
    const r = driveCtl(make({ attack: 256, release: 0, autoRel: true, noteOff: 1 }), notes, 60000, { block: 128, tempo: 522 });
    for (const v of r.values) for (const x of v) expect(Number.isFinite(x) || Number.isNaN(x)).toBe(true);
    for (const v of r.values.slice(100)) for (const x of v) expect(x >= 0 && x <= 1).toBe(true);
  });
});

describe('Keyboard Controller: channel integration', () => {
  it('plays pattern notes through a plugin channel and reports its outputs (Link to controller sources)', () => {
    const e = makeEngine();
    const c = createGenChannel('keyboardctrl', 'Keys', 0);
    c.plugin!.params.attack = 0; c.plugin!.params.release = 0;
    play(e, [c], { [c.id]: [{ key: 64, vel: 100, pos: 0, len: 48 }] }, 48000 / 4);
    const ch = e.channels.get(c.id);
    expect(ch).toBeInstanceOf(GenChannel);
    const out = (ch as GenChannel).controls()!;
    expect(out[0]).toBeCloseTo(9 / 13, 6);
    expect(out[1]).toBeCloseTo((100 / 128) * KB_VEL_SCALE, 6);
  });
});
