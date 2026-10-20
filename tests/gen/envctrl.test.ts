// Envelope Controller (FL: Fruity Envelope Controller): registration (FL's 90
// parameters, value texts, plugin database state, the 22 factory presets), the
// LFO's laws and the controller behaviour measured on the real plugin in the
// test host (docs/research/gen/envctrl.md): tick timing, the envelope player
// (ATT / DEC / SUS / REL, markers, loop, release), the LFO, the source combination,
// the mapping inputs, continuous output, and the plugin's recorded outputs.
import { describe, it, expect } from 'vitest';
import { genDef, genOutputs, genPresetState, defaultGenParams, formatParam, genInCategory, normalizeGenParams } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { setEnvelopeControllerRandom } from '../../src/engine/gen/plugins/envctrl';
import {
  EC_ARTS, ecDefaultState, ecFlatShape, ecKey, ecLfoHz, ecLfoOrigin, ecLfoWave, ecPoint, ecSpeedText,
  type EcArt, type EcShape,
} from '../../src/model/gen/plugins/envctrl';
import type { AutoPoint } from '../../src/model/automation';
import { driveCtlChanges, type CtlAction, type CtlNote } from './ctlutil';
import { GOLDEN } from './envctrl.golden';

const D = genDef('envctrl')!;
const SR = 44100;

type State = Record<string, unknown>;

// -------------------------------------------------------------- helpers

/** An envelope shape from [pos, value, tension?, mode?] tuples. */
function shape(pts: Array<[number, number] | [number, number, number] | [number, number, number, AutoPoint['mode']]>, o: Partial<EcShape> = {}): EcShape {
  return {
    pts: pts.map((p) => ecPoint(p[0], p[1], (p[2] as number) ?? 0, (p[3] as AutoPoint['mode']) ?? 'single')),
    on: true, tempo: false, global: false, d: -1, l: -1, s: -1, ...o,
  };
}

/** A state with articulator 0 replaced; unipolar with neutral (flat 1) maps and a flat unit envelope unless given. */
function stateOf(a0: Partial<EcArt>, params: Record<string, number> = {}, extra: State = {}): State {
  const d = ecDefaultState();
  const arts = (d.arts as EcArt[]).map((a) => structuredClone(a));
  const maps = [0, 1, 2, 3, 4].map(() => ecFlatShape(1));
  arts[0] = { env: shape([[0, 0], [1, 1]], { on: true }), lfo: shape([[0, 1], [100, 1]], { on: false }), maps, polar: false, lo: 0, hi: 256, ...a0 } as EcArt;
  return { ...d, arts, [ecKey(0, 'base')]: 0, [ecKey(0, 'env')]: 256, [ecKey(0, 'lfo')]: 256, ...params, ...extra };
}

interface RunOpt {
  bpm?: number;
  seconds?: number;
  chanModX?: number;
  chanModY?: number;
  actions?: (inst: ReturnType<typeof createGen>) => CtlAction[];
}
/** Play notes {at, len} (seconds) on `state`; returns each articulator's changes [tick, value]. */
function run(state: State, notes: Array<{ at: number; len: number } & Partial<CtlNote>>, o: RunOpt = {}) {
  const inst = createGen('envctrl', SR, 128)!;
  inst.setParams(state);
  const n: CtlNote[] = notes.map((x) => ({ ...x, at: Math.round(x.at * SR), len: Math.round(x.len * SR), chanModX: o.chanModX ?? 1, chanModY: o.chanModY ?? 0 }));
  const acts = o.actions ? o.actions(inst) : [];
  return driveCtlChanges(inst, n, Math.round((o.seconds ?? 4) * SR), acts, { tempo: o.bpm ?? 130 });
}
const at = (ev: Array<[number, number]> | undefined, tick: number): number => {
  let v = NaN;
  for (const [t, x] of ev ?? []) if (t <= tick) v = x; else break;
  return v;
};
const SPT = (bpm: number) => (SR * 60) / (bpm * 96);

// ------------------------------------------------------- registration

describe('Envelope Controller: registration', () => {
  it('has FL\'s parameters, outputs and form size', () => {
    expect(D.name).toBe('Envelope Controller');
    expect(D.category).toBe('Controller');
    expect(genInCategory('Controller').map((d) => d.id)).toContain('envctrl');
    expect(D.notes).toBe('voices');
    expect(D.noAudio).toBe(true);
    expect([D.width, D.height]).toEqual([737, 395]);
    expect(D.params).toHaveLength(90);
    expect(D.params.map((q) => q.index)).toEqual(Array.from({ length: 90 }, (_, i) => i));
    // articulator 1: name, range, form default (what a reset gives)
    expect(D.params.slice(0, 11).map((q) => [q.name, q.min, q.max, q.def])).toEqual([
      ['Articulator 1 - Base level', 0, 256, 128],
      ['Articulator 1 - Envelope level', -256, 256, 0],
      ['Articulator 1 - LFO level', -256, 256, 0],
      ['Articulator 1 - Attack time scale', 0, 256, 128],
      ['Articulator 1 - Decay time scale', 0, 256, 128],
      ['Articulator 1 - Sustain level offset', -128, 128, 0],
      ['Articulator 1 - Release time scale', 0, 256, 128],
      ['Articulator 1 - LFO speed (phase)', 512, 65536, 40898],
      ['Articulator 1 - LFO tension', -128, 128, 0],
      ['Articulator 1 - LFO skew', -128, 128, 0],
      ['Articulator 1 - LFO pulse width', -112, 112, 0],
    ]);
    expect(D.params[88]).toMatchObject({ index: 88, name: 'Global modulation X', min: 0, max: 65536, def: 32768 });
    expect(D.params[89]).toMatchObject({ index: 89, name: 'Global modulation Y', min: 0, max: 65536, def: 32768 });
    expect(D.params[77].name).toBe('Articulator 8 - Base level');
    expect(genOutputs('envctrl')).toEqual(Array.from({ length: 8 }, (_, i) => `Articulator ${i + 1}`));
  });

  it('writes FL\'s value texts (test host)', () => {
    const t = (key: string, v: number, st?: State) => formatParam(D.params.find((q) => q.key === key)!, v, st);
    // percentages round half away from zero
    expect([0, 32, 96, 160, 224, 256].map((v) => t('base1', v))).toEqual(['0%', '13%', '38%', '63%', '88%', '100%']);
    expect([-40, -32, -24, -8, 8, 32].map((v) => t('env1', v))).toEqual(['-16%', '-13%', '-9%', '-3%', '3%', '13%']);
    expect([0, 32, 128, 256].map((v) => t('att1', v))).toEqual(['0%', '25%', '100%', '200%']);
    expect([-128, -32, 0, 128].map((v) => t('sus1', v))).toEqual(['-100%', '-25%', '0%', '100%']);
    expect([-112, -98, -14, 14, 112].map((v) => t('pw1', v))).toEqual(['-100%', '-88%', '-13%', '13%', '100%']);
    expect([0, 4096, 12288, 32768, 65536].map((v) => t('modx', v))).toEqual(['0%', '6%', '19%', '50%', '100%']);
  });

  it('writes the LFO speed as FL does: m:ss:mmm / s:mmm (floored to ms), bars:beats:ticks when tempo based', () => {
    // absolute (test host sweep of the SPD wheel)
    expect([512, 2560, 4608, 6656, 14848, 16768, 33024, 40898, 49664, 65536].map((v) => ecSpeedText(v, false))).toEqual([
      '69:48:521', '12:01:678', '5:43:042', '3:21:831', '44:272', '32:706', '3:043', '0:999', '0:291', '0:031']);
    // tempo based: the period at 120 BPM in bars:beats:ticks, rounded to the tick, clipped at 999 bars
    expect([512, 3221, 8640, 33024, 40898, 49280, 65536].map((v) => ecSpeedText(v, true))).toEqual([
      '999:00:000', '272:03:064', '065:03:092', '001:02:008', '000:02:000', '000:00:059', '000:00:006']);
    const st = { arts: (ecDefaultState().arts as EcArt[]).map((a, i) => (i === 0 ? { ...a, lfo: { ...a.lfo, tempo: true } } : a)) };
    expect(formatParam(D.params[7], 40898, st)).toBe('000:02:000');
    expect(formatParam(D.params[18], 40898, st)).toBe('0:999');
  });

  it('a new instance is FL\'s plugin database state: ADSR on articulator 1, bipolar, all keys, base 50%', () => {
    const p = defaultGenParams('envctrl');
    expect([p.base1, p.env1, p.lfo1, p.att1, p.dec1, p.sus1, p.rel1, p.spd1, p.spd4, p.spd5, p.modx, p.mody]).toEqual([128, 256, 128, 128, 128, 0, 128, 40000, 40000, 40898, 32768, 32768]);
    const arts = p.arts as EcArt[];
    expect(arts).toHaveLength(EC_ARTS);
    expect(arts[0].env).toMatchObject({ on: true, tempo: false, global: false, d: 1, l: -1, s: 2 });
    expect(arts[0].env.pts.map((q) => [q.pos, q.value, q.tension])).toEqual([[0, 0, 0], [0.75, 1, 0.2], [2.25, 0.5, 0.2], [2.5, 0, 0.2]]);
    expect(arts[1].env.on).toBe(false);
    expect(arts[0].lfo.on).toBe(false);
    expect(arts[0].lfo.pts.map((q) => [q.pos, q.value])).toEqual([[0, 0.5], [1, 0.5], [1.25, 1], [2.25, 0.5]]);
    expect(arts.every((a) => a.polar && a.lo === 0 && a.hi === 256)).toBe(true);
    expect(arts[3].maps.map((m) => m.pts.map((q) => q.value))).toEqual(Array.from({ length: 5 }, () => [0.5, 0.5]));
    expect([p.cont, p.sel, p.src]).toEqual([false, 0, 0]);
  });

  it('has FL\'s 22 factory presets in FL\'s order, each loadable', () => {
    expect(D.presets!.map((q) => q.name)).toEqual([
      'Default', 'Default (unipolar product)', 'Empty',
      'Note LFO', 'Note decay', 'Note gate', 'Note gate (velocity)', 'Note link to LFO SPD sync (C2-G#2)',
      'Note switches (C2-G2 latched)', 'Note switches (C2-G2 mono)', 'Note switches (C2-G2 poly)', 'ZGE Video Controller (Play, Position, Speed)',
      'Smart X for 2 controls (inverted)', 'Smart X for 2 controls (xfade)', 'Smart X for 3 controls', 'Smart X for 5 controls (smooth)',
      'Smart X for 5 controls', 'Smart X for 8 fades', 'Smart X for 8 switches', 'Smart XY for 2 controls',
      'Smart XY for 4 controls (xfade)', 'Smart XY for pan-front-back',
    ].sort((a, b) => D.presets!.findIndex((q) => q.name === a) - D.presets!.findIndex((q) => q.name === b)));
    for (const q of D.presets!) {
      const st = genPresetState('envctrl', q);
      expect((st.arts as EcArt[])).toHaveLength(8);
      expect(normalizeGenParams('envctrl', st).arts).toEqual(st.arts);
    }
    const byName = (n: string) => genPresetState('envctrl', D.presets!.find((q) => q.name === n)!);
    // unipolar product: base 0, polarity off on articulator 1
    const u = byName('Default (unipolar product)');
    expect([u.base1, (u.arts as EcArt[])[0].polar, (u.arts as EcArt[])[1].polar]).toEqual([0, false, true]);
    // Note LFO: tempo based global LFO, speed 40898 (the plugin's own value, not the 40000 stored in the parameter list)
    const l = byName('Note LFO');
    expect([l.spd1, (l.arts as EcArt[])[0].lfo]).toMatchObject([40898, { on: true, tempo: true, global: true }]);
    // the key ranges of the C2-G2 switches
    const sw = byName('Note switches (C2-G2 poly)').arts as EcArt[];
    expect(sw.map((a) => [a.lo, a.hi])).toEqual([[24, 24], [25, 25], [26, 26], [27, 27], [28, 28], [29, 29], [30, 30], [31, 31]]);
    // Smart controls run on the global X / Y without notes
    expect(byName('Smart X for 3 controls').cont).toBe(true);
    expect(byName('Default').cont).toBe(false);
  });
});

// -------------------------------------------------------------- the LFO

describe('Envelope Controller: the LFO laws', () => {
  it('runs at 32 (10001^(v / 65536) - 1) / 10000 Hz (periods measured in ticks of the tempo-based LFO)', () => {
    // period in ticks = 192 / f, measured on the plugin over 5..80 cycles
    const measured: Array<[number, number]> = [[65536, 6.0], [60000, 13.0646], [55000, 26.3859], [50000, 53.3023], [45000, 107.7255],
      [40898, 191.9976], [36000, 383.3787], [30000, 898.5293], [25000, 1842.4306]];
    for (const [v, ticks] of measured) expect(192 / ecLfoHz(v) / ticks).toBeCloseTo(1, 4);
    expect(ecLfoHz(65536)).toBeCloseTo(32, 9);
    expect(ecLfoHz(512)).toBeCloseTo(1 / 4188.521, 6);
  });

  it('bends the triangle with the tension law q = 0.9 ln 10 (21^(|t| / 128) - 1)', () => {
    // the rising quarter at w = 4 phase, measured at tension 64 (test host)
    const ws = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9];
    const t64 = [0.3102, 0.5242, 0.7738, 0.8926, 0.9761, 0.9951, 0.9993];
    ws.forEach((w, i) => expect(ecLfoWave(w / 4, 64, 0, 0)).toBeCloseTo(t64[i], 3));
    const tm64 = [0.0003, 0.0007, 0.002, 0.0049, 0.0238, 0.1072, 0.4752];
    ws.forEach((w, i) => expect(ecLfoWave(w / 4, -64, 0, 0)).toBeCloseTo(tm64[i], 3));
    expect(ecLfoWave(0.125, 0, 0, 0)).toBeCloseTo(0.5, 12);
    // symmetric: the falling half mirrors the rising one, the negative half is the same bend
    expect(ecLfoWave(0.375, 64, 0, 0)).toBeCloseTo(ecLfoWave(0.125, 64, 0, 0), 12);
    expect(ecLfoWave(0.625, 64, 0, 0)).toBeCloseTo(-ecLfoWave(0.125, 64, 0, 0), 12);
  });

  it('skew moves the peak to 0.25 (1 + skew); pulse width holds the top (+) or bottom (-)', () => {
    expect(ecLfoWave(0.375, 0, 64, 0)).toBeCloseTo(1, 12);
    expect(ecLfoWave(0.625, 0, 64, 0)).toBeCloseTo(-1, 12);
    expect(ecLfoWave(0.4999, 0, 128, 0)).toBeCloseTo(1, 3);
    expect(ecLfoWave(0.5001, 0, 128, 0)).toBeCloseTo(-1, 3);
    // pulse width 56: rise 0.1406 (slope 7.11), hold to 0.5781, fall 0.2812
    expect(ecLfoWave(0.140625, 0, 0, 56)).toBeCloseTo(1, 12);
    expect(ecLfoWave(0.4, 0, 0, 56)).toBeCloseTo(1, 12);
    expect(ecLfoWave(0.7, 0, 0, 56)).toBeCloseTo(1 - (2 * (0.7 - 0.140625 - 0.4375)) / 0.28125, 9);
    expect(ecLfoWave(0.3, 0, 0, -56)).toBeCloseTo(1 - (2 * (0.3 - 0.140625)) / 0.28125, 9);
    expect(ecLfoWave(0.6, 0, 0, -56)).toBe(-1);
    // skew 64 + pulse width 56: rise 0.2109, hold to 0.6461, fall 0.1406 (measured segment slopes 4.74 / -14.22)
    expect(ecLfoWave(0.2085, 0, 64, 56)).toBeCloseTo(0.9884, 3);
    expect(ecLfoWave(0.5, 0, 64, 56)).toBe(1);
    expect(ecLfoWave(0.7167, 0, 64, 56)).toBeCloseTo(1 - (2 * (0.7167 - 0.2109375 - 0.4375)) / 0.140625, 9);
  });

  it('a global LFO runs on the waveform\'s own phase axis (origin fitted to the plugin)', () => {
    expect(ecLfoOrigin(0, 0)).toBeCloseTo(0, 12);
    expect(ecLfoOrigin(64, 0)).toBeCloseTo(-0.125, 12);
    expect(ecLfoOrigin(0, 112)).toBeCloseTo(-(1 - 0.25) * 0.875, 12);
    expect(ecLfoOrigin(0, -112)).toBeCloseTo(0.25 * 0.875, 12);
    // the global phase 0 sits at the point where the retriggered wave would be at -origin
    for (const [sk, pw] of [[0, 0], [64, 56], [-64, -56], [100, 100], [-128, 40]]) {
      for (const ph of [0.1, 0.4, 0.77]) expect(Math.abs(ecLfoWave(ph - ecLfoOrigin(sk, pw), 0, sk, pw))).toBeLessThanOrEqual(1);
    }
  });
});

// ------------------------------------------------------------- engine

describe('Envelope Controller: the tick engine', () => {
  it('plays FL\'s default ADSR on articulator 1 (test host: first ticks and the end)', () => {
    const out = run(defaultGenParams('envctrl'), [{ at: 0.1, len: 1.0, key: 60, vel: 100 }], { seconds: 5 });
    expect(out[0].slice(0, 3).map(([t]) => t)).toEqual([21, 22, 23]);
    expect(out[0][0][1]).toBeCloseTo(0.037148308, 6);
    expect(out[0][1][1]).toBeCloseTo(0.073, 3);
    expect(out[0]).toHaveLength(234);
    expect(out[0][233]).toEqual([254, 0]);
    // the other articulators send their value once (disabled sources: bipolar base 50%)
    for (let a = 1; a < 8; a++) expect(out[a]).toEqual([[21, 0.5]]);
  });

  it('sends nothing before a note and only changes after it (no output at all while disabled and 0)', () => {
    const out = run(stateOf({ env: shape([[0, 0], [1, 1]], { on: false }) }, { [ecKey(0, 'base')]: 0 }), [{ at: 0.1, len: 0.5, key: 60 }]);
    expect(out[0] ?? []).toEqual([]);
    const o2 = run(stateOf({ env: shape([[0, 0.6], [100, 0.6]], { on: true }) }), [{ at: 0.1, len: 0.5 }, { at: 0.4, len: 0.5 }]);
    // a flat 0.6 is sent once (the second note keeps the value)
    expect(o2[0]).toEqual([[21, expect.closeTo(0.6, 6)]]);
  });

  it('a note takes the articulators in its key range, a new note takes over the articulator', () => {
    const st = stateOf({ lo: 70, hi: 80, env: shape([[0, 0.5], [100, 0.5]]) });
    expect(run(st, [{ at: 0.1, len: 0.5, key: 60 }])[0] ?? []).toEqual([]);
    expect(run(st, [{ at: 0.1, len: 0.5, key: 75 }])[0]).toHaveLength(1);
    // two overlapping notes: the second restarts the envelope (a ramp 0 -> 1 over 4 beats, tempo based)
    const ramp = stateOf({ env: shape([[0, 0], [4, 1]], { tempo: true }) });
    const o = run(ramp, [{ at: 0.1, len: 1.5, key: 60 }, { at: 0.6, len: 1.5, key: 62 }]);
    const t2 = Math.floor((0.6 * SR) / SPT(130)) + 1;
    expect(at(o[0], t2 - 1)).toBeGreaterThan(0.2);
    expect(at(o[0], t2)).toBeLessThan(0.02);
  });

  it('ENV is a step per tick: tempo based = 1/96 beat, else 0.5 s per unit; ATT / DEC / REL scale the stages (test host)', () => {
    const p = [[0, 0], [1, 1], [3, 0.5], [4, 0]] as Array<[number, number]>;
    const tempo = run(stateOf({ env: shape(p, { tempo: true, d: 1, s: 2 }) }), [{ at: 0.1, len: 3 }]);
    // age n = tick - 20: the peak at 96, sustain from 288, linear
    expect(at(tempo[0], 20 + 48)).toBeCloseTo(0.5, 6);
    expect(at(tempo[0], 20 + 96)).toBeCloseTo(1, 6);
    expect(at(tempo[0], 20 + 192)).toBeCloseTo(0.75, 6);
    expect(at(tempo[0], 20 + 400)).toBeCloseTo(0.5, 6);
    const att = run(stateOf({ env: shape(p, { tempo: true, d: 1, s: 2 }) }, { [ecKey(0, 'att')]: 64 }), [{ at: 0.1, len: 3 }]);
    expect(at(att[0], 20 + 48)).toBeCloseTo(1, 6);
    const abs = run(stateOf({ env: shape(p, { tempo: false, d: 1, s: 2 }) }), [{ at: 0.1, len: 3 }], { bpm: 65 });
    // 1 unit = 0.5 s = 52 ticks at 65 BPM (the note's first tick is 11): the peak at age 52
    expect(at(abs[0], 10 + 52)).toBeCloseTo(1, 3);
  });

  it('SUS ramps its offset in from D to S and clamps; the release continues from the current value', () => {
    const p = [[0, 0], [1, 1], [3, 0.5], [4, 0]] as Array<[number, number]>;
    const sus = run(stateOf({ env: shape(p, { tempo: true, d: 1, s: 2 }) }, { [ecKey(0, 'sus')]: 32 }), [{ at: 0.1, len: 3 }]);
    expect(at(sus[0], 20 + 300)).toBeCloseTo(0.75, 6);
    expect(at(sus[0], 20 + 96)).toBeCloseTo(1, 6);
    expect(at(sus[0], 20 + 192)).toBeCloseTo(0.875, 6);
    // release during the attack: linear from the value reached to 0 over (4 - 3) beats = 96 ticks
    const rel = run(stateOf({ env: shape(p, { tempo: true, d: 1, s: 2 }) }), [{ at: 0.1, len: 0.25 }]);
    const tr = Math.ceil((0.35 * SR) / SPT(130)); // the tick that sees the note off
    const v0 = at(rel[0], tr - 1);
    expect(at(rel[0], tr)).toBeCloseTo(v0 * (1 - 1 / 96), 6);
    expect(at(rel[0], tr + 95)).toBeCloseTo(0, 6);
  });

  it('the loop marker repeats L..S while held (continuing from the loop end\'s level) and the note off leaves it', () => {
    const p = [[0, 0], [0.5, 1], [1, 0.4], [1.5, 0.8], [2, 0.3], [2.5, 0]] as Array<[number, number]>;
    const o = run(stateOf({ env: shape(p, { tempo: true, d: 1, l: 2, s: 4 }) }), [{ at: 0.1, len: 2 }]);
    // age 192: S (0.3); the loop restarts from it: 0.3 -> 0.8 over 48 ticks (0.425 after 12), 0.8 -> 0.3 over 48
    expect(at(o[0], 20 + 192)).toBeCloseTo(0.3, 6);
    expect(at(o[0], 20 + 204)).toBeCloseTo(0.425, 6);
    expect(at(o[0], 20 + 240)).toBeCloseTo(0.8, 6);
    expect(at(o[0], 20 + 288)).toBeCloseTo(0.3, 6);
    expect(at(o[0], 20 + 300)).toBeCloseTo(0.425, 6);
  });
});

// ------------------------------------------------------ the combination

describe('Envelope Controller: combining the sources', () => {
  const flat = (v: number) => ecFlatShape(v);
  it('unipolar: (base + E e) (1 + L w) x maps; bipolar: base + E (e - 1/2) + L w / 2 + sum (m - 1/2)', () => {
    // E = 100%, e = 0.6 (flat), base 25%: unipolar 0.85, bipolar 0.5 + (0.25 - 0.5) + 0.1 + ... with neutral maps = 0.35
    const env = shape([[0, 0.6], [100, 0.6]]);
    const u = run(stateOf({ env }, { [ecKey(0, 'base')]: 64 }), [{ at: 0.1, len: 0.3 }]);
    expect(u[0][0][1]).toBeCloseTo(0.85, 6);
    const b = run(stateOf({ env, polar: true, maps: [0, 1, 2, 3, 4].map(() => flat(0.5)) }, { [ecKey(0, 'base')]: 64 }), [{ at: 0.1, len: 0.3 }]);
    expect(b[0][0][1]).toBeCloseTo(0.35, 6);
    // maps: seven factors / terms (Mod X and Mod Y count twice when flat)
    const m = [flat(0.5), flat(0.5), flat(0.5), flat(0.5), flat(0.5)];
    const um = run(stateOf({ env, maps: m }), [{ at: 0.1, len: 0.3 }]);
    expect(um[0][0][1]).toBeCloseTo(0.6 * 0.5 ** 7, 7);
    const bm = run(stateOf({ env, maps: [flat(0.7), flat(0.5), flat(0.5), flat(0.5), flat(0.5)], polar: true }, { [ecKey(0, 'base')]: 128 }), [{ at: 0.1, len: 0.3 }]);
    expect(bm[0][0][1]).toBeCloseTo(0.5 + 0.1 + 0.2, 6);
  });

  it('maps read key / 120, velocity x 0.007748626 and global X + (note + channel Mod X) / 2', () => {
    const ramp = shape([[0, 0], [1, 1]]);
    const env = shape([[0, 1], [100, 1]]);
    const kb = run(stateOf({ env, maps: [ramp, flat(1), flat(1), flat(1), flat(1)] }), [{ at: 0.1, len: 0.2, key: 72 }]);
    expect(kb[0][0][1]).toBeCloseTo(0.6, 6);
    const vel = run(stateOf({ env, maps: [flat(1), ramp, flat(1), flat(1), flat(1)] }), [{ at: 0.1, len: 0.2, vel: 100 }]);
    expect(vel[0][0][1]).toBeCloseTo(100 * 0.007748626, 6);
    // Mod X map (ramp): x = g + (note + channel) / 2 with g = 0 (global X 0), channel Mod X 0.5, note Mod X -0.25
    const mx = run(stateOf({ env, maps: [flat(1), flat(1), ramp, flat(1), flat(1)] }, { modx: 0 }), [{ at: 0.1, len: 0.2, modX: -0.25 }], { chanModX: 0.5 });
    expect(mx[0][0][1]).toBeCloseTo((0.5 - 0.25) / 2, 6);
    const my = run(stateOf({ env, maps: [flat(1), flat(1), flat(1), ramp, flat(1)] }, { mody: 16384 }), [{ at: 0.1, len: 0.2, modY: 0.5 }], { chanModY: 0.5 });
    expect(my[0][0][1]).toBeCloseTo(0.25 + 0.5, 6);
  });

  it('a flat Mod X / Y map counts twice, a sloped map once (plugin quirk)', () => {
    const env = shape([[0, 1], [100, 1]]);
    const f = run(stateOf({ env, maps: [flat(1), flat(1), flat(0.5), flat(1), flat(1)] }), [{ at: 0.1, len: 0.2 }]);
    expect(f[0][0][1]).toBeCloseTo(0.25, 6);
    const s = run(stateOf({ env, maps: [flat(1), flat(1), shape([[0, 0.5], [1, 0.5001]]), flat(1), flat(1)] }), [{ at: 0.1, len: 0.2 }]);
    expect(s[0][0][1]).toBeCloseTo(0.5, 3);
  });

  it('the Random source draws a value per note and reads its map at it', () => {
    const env = shape([[0, 1], [100, 1]]);
    setEnvelopeControllerRandom(() => 0.3);
    const r = run(stateOf({ env, maps: [flat(1), flat(1), flat(1), flat(1), shape([[0, 0], [1, 1]])] }), [{ at: 0.1, len: 0.2 }]);
    setEnvelopeControllerRandom(null);
    expect(r[0][0][1]).toBeCloseTo(0.3, 6);
  });

  it('the LFO scales its wave with the modifier envelope (2 y - 1), restarts per note, runs on the tick count when GLOBAL', () => {
    const env = shape([[0, 0], [1, 0]], { on: false });
    const lfo = (o: Partial<EcShape>) => shape([[0, 1], [100, 1]], { on: true, tempo: true, ...o });
    const params = { [ecKey(0, 'base')]: 128, [ecKey(0, 'env')]: 0, [ecKey(0, 'spd')]: 40898 };
    const a = run(stateOf({ env, lfo: lfo({}) }, params), [{ at: 0.1, len: 0.3 }, { at: 1.3, len: 0.3 }]);
    // period 192 ticks (tempo based): 0.5 (1 + w), w = 4 age / 192 at the start of each note
    expect(a[0][0][1]).toBeCloseTo(0.5 * (1 + 4 / 191.9904), 4);
    const t2 = Math.floor((1.3 * SR) / SPT(130)) + 1;
    expect(at(a[0], t2)).toBeCloseTo(0.5 * (1 + 4 / 191.9904), 4);
    // GLOBAL: the second note does not restart the phase
    const g = run(stateOf({ env, lfo: lfo({ global: true }) }, params), [{ at: 0.1, len: 0.3 }, { at: 1.3, len: 0.3 }]);
    expect(at(g[0], t2)).not.toBeCloseTo(0.5 * (1 + 4 / 191.9904), 2);
    // a flat modifier envelope at 0.5 silences it
    const z = run(stateOf({ env, lfo: lfo({ pts: [ecPoint(0, 0.5), ecPoint(100, 0.5)] }) }, params), [{ at: 0.1, len: 0.3 }]);
    expect(z[0]).toEqual([[21, 0.5]]);
  });

  it('Continuous output follows the global X / Y without notes (Smart controls)', () => {
    const ramp = shape([[0, 0], [1, 1]]);
    const st = stateOf({ polar: true, maps: [flat(0.5), flat(0.5), ramp, flat(0.5), flat(0.5)], env: shape([[0, 0], [1, 0]], { on: false }), lfo: shape([[0, 0.5], [1, 0.5]], { on: false }) },
      { [ecKey(0, 'base')]: 128 }, { cont: true });
    const out = run(st, [], {
      seconds: 3, actions: (inst) => [
        { at: Math.round(1.0 * SR), fn: () => inst!.setParams({ ...st, modx: 0 }) },
        { at: Math.round(2.0 * SR), fn: () => inst!.setParams({ ...st, modx: 49152 }) },
      ],
    });
    expect(out[0].map(([, v]) => Math.round(v * 1000) / 1000)).toEqual([0.5, 0, 0.75]);
    // without the option the same state sends nothing
    const off = run({ ...st, cont: false }, [], { seconds: 3 });
    expect(off[0] ?? []).toEqual([]);
  });
});

// ------------------------------------------------- the plugin's outputs

describe('Envelope Controller: recorded outputs of FL\'s plugin', () => {
  for (const c of GOLDEN) {
    it(c.name, () => {
      const base = c.preset ? genPresetState('envctrl', D.presets!.find((q) => q.name === c.preset)!) : ecDefaultState();
      const state: State = c.art0 ? { ...base, ...(c.params ?? {}), cont: !!c.cont, arts: [c.art0, ...(base.arts as EcArt[]).slice(1)] } : base;
      const spt = SPT(c.bpm);
      const notes: CtlNote[] = c.notes.map(([s, l, key, vel, mx, my]) => ({ at: Math.floor(s * SR + 0.5), len: Math.floor((s + l) * SR + 0.5) - Math.floor(s * SR + 0.5), key, vel, modX: mx, modY: my, chanModX: c.chan[0], chanModY: c.chan[1] }));
      const inst = createGen('envctrl', SR, 128)!;
      inst.setParams(state);
      const cur: State = { ...state };
      const actions: CtlAction[] = c.autos.map(([t, idx, v]) => ({
        at: Math.floor(t * SR + 0.5), fn: () => { cur[idx === 88 ? 'modx' : 'mody'] = v; inst.setParams({ ...cur }); },
      }));
      const end = Math.round((Math.max(...c.notes.map((n) => n[0] + n[1]), ...c.autos.map((a) => a[0]), 0) + c.tail) * SR);
      const out = driveCtlChanges(inst, notes, end, actions, { tempo: c.bpm });
      void spt;
      for (const [a, ev] of Object.entries(c.host)) {
        const mine = out[Number(a)] ?? [];
        for (const [tick, v] of ev) expect(at(mine, tick), `art ${a} tick ${tick}`).toBeCloseTo(v, 4);
      }
    });
  }
});
