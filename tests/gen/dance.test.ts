// Dance (FL: Fruity Dance): registration (FL's parameters, texts, defaults),
// the note -> parameter table and the voice behaviour measured on the real
// plugin in the test host (every key 0..131 from two different start states,
// velocity / colour / length / pan / fine pitch variations), the state changes
// the engine reports, and the animation rules measured from the plugin's own
// window (frame law, speed, motion blending, Sync changes, Freestyle, sprite
// sheet layout and window geometry). docs/research/gen/dance.md.
import { describe, it, expect } from 'vitest';
import { genDef, genInCategory, defaultGenParams, normalizeGenParams, formatParam, clampParam } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';
import type { GenVoiceParams } from '../../src/engine/gen/types';
import type { FromEngine } from '../../src/engine/protocol';
import { createGenChannel } from '../../src/model/defaults';
import {
  DANCE_MOVES, DANCE_SHEET_NAMES, danceBlend, danceBox, danceCoordsOf, danceFreeRow, danceHeldRow, danceKeyEffect, danceKeyMovesOf, danceKeyNames,
  danceFramesPerBeat, danceMoveList, danceMovesOf, danceMoveText, dancePhase, danceSpeedInverse, danceReflectAlpha, danceRowOf, danceSheetGrid, danceState, danceWindowPos, parseSheetNames,
} from '../../src/model/gen/plugins/dance';
import { DanceAnimator, type AnimTarget } from '../../src/ui/plugins/gen/dance/anim';
import { neutralPose, poseOf } from '../../src/ui/plugins/gen/dance/art';
import { makeEngine, play, peak, SR } from './util';

const D = genDef('dance')!;
const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function voiceParams(key: number, extra: Partial<GenVoiceParams> = {}, vel = 100): GenVoiceParams {
  const init = newLevels(), levels = newLevels();
  setInitLevels(init, (key - 60) * 100, vel, 0, 0, 0);
  Object.assign(levels, init);
  return { key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels, ...extra };
}

/** Play a key on a fresh plugin holding `state`; returns the state afterwards (as the project would hold it). */
function after(key: number, state: Record<string, unknown>, extra: Partial<GenVoiceParams> = {}, vel = 100): Record<string, unknown> {
  const inst = createGen('dance', SR, 128)!;
  inst.setParams({ ...defaultGenParams('dance'), ...state });
  const v = inst.triggerVoice!(voiceParams(key, extra, vel));
  expect(v).toBeNull();
  const out: Record<string, unknown> = { ...state };
  for (const [k, val] of inst.takeStateChanges?.() ?? []) out[k] = val;
  return out;
}

// ------------------------------------------------------------------ the measured note table
// FL's plugin in the test host, played at each key 0..131 from two start states
// (move 5, mirror 0, shown; and move 6, mirror 1, hidden): only these keys changed anything
// (the other 108 left the seven parameters and the saved state as they were).
const MEASURED: Record<number, { move?: number; mirror?: number; visible?: number }> = {
  39: { move: 9, mirror: 1 }, 40: { move: 8, mirror: 1 }, 41: { move: 7, mirror: 1 }, 42: { move: 6, mirror: 1 }, 43: { move: 5, mirror: 1 },
  44: { move: 4, mirror: 1 }, 45: { move: 3, mirror: 1 }, 46: { move: 2, mirror: 1 }, 47: { move: 1, mirror: 1 }, 48: { move: 0, mirror: 1 },
  53: { visible: 0 }, 54: { visible: 1 },
  59: { move: 0, mirror: 0 }, 60: { move: 1, mirror: 0 }, 61: { move: 2, mirror: 0 }, 62: { move: 3, mirror: 0 }, 63: { move: 4, mirror: 0 },
  64: { move: 5, mirror: 0 }, 65: { move: 6, mirror: 0 }, 66: { move: 7, mirror: 0 }, 67: { move: 8, mirror: 0 }, 68: { move: 9, mirror: 0 },
};

describe('Dance: registration', () => {
  it('has FL\'s plugin info: Visual, no audio, notes through voices, the form size', () => {
    expect(D.name).toBe('Dance');
    expect(D.category).toBe('Visual');
    expect(genInCategory('Visual').map((d) => d.id)).toContain('dance');
    expect(D.notes).toBe('voices');
    expect(D.noAudio).toBe(true);
    expect(D.ins).toBeFalsy();
    expect([D.width, D.height]).toEqual([558, 224]);
    expect(D.presets ?? []).toEqual([]);
  });

  it('has FL\'s seven parameters with their ranges and defaults', () => {
    expect(D.params.map((q) => [q.index, q.name, q.min, q.max, q.def])).toEqual([
      [0, 'Dance move', 0, 9, 2],
      [1, 'Mirror character horizontally', 0, 1, 0],
      [2, 'Show window', 0, 1, 1],
      [3, 'Motion blending', 0, 256, 64],
      [4, 'Speed multiplicator', -96, 96, 0],
      [5, 'X coordinate', -8192, 8192, 600],
      [6, 'Y coordinate', -8192, 8192, 500],
    ]);
    expect(D.params.map((q) => q.key)).toEqual(['move', 'mirror', 'visible', 'blend', 'speed', 'x', 'y']);
  });

  it('writes FL\'s value texts: the move names for parameter 0, nothing special for the rest', () => {
    const move = D.params[0];
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => formatParam(move, v))).toEqual(
      ['Freestyle', 'Waiting', 'Stepping', 'Jumping', 'Zombie', 'Waving', 'Hula', 'Windmill', 'Zitabata', 'Dervish'],
    );
    expect(DANCE_MOVES).toHaveLength(10);
    // the host reports no value text for 1..6: the plain number is shown
    expect(D.params.slice(1).map((q) => formatParam(q, q.def))).toEqual(['0', '1', '64', '0', '600', '500']);
    expect(formatParam(D.params[4], -96)).toBe('-96');
  });

  it('follows the sprite sheet\'s row names in the move texts', () => {
    const p = { ...defaultGenParams('dance'), sheet: 'user', sheetNames: ['Alpha', 'Bravo', 'Charlie', 'Held'] };
    expect(danceMoveList(danceState(p))).toEqual(['Freestyle', 'Alpha', 'Bravo', 'Charlie']);
    expect([0, 1, 2, 3].map((v) => formatParam(D.params[0], v, p))).toEqual(['Freestyle', 'Alpha', 'Bravo', 'Charlie']);
    // values beyond the list show the last move (FL's range shrinks with the sheet; moves beyond play the last row)
    expect(danceMoveText(9, p)).toBe('Charlie');
    const cd = { ...defaultGenParams('dance'), sheet: 'countdown' };
    expect(danceMoveList(danceState(cd))).toEqual(['Freestyle', 'Count']);
  });

  it('starts from FL\'s state: Stepping, window shown, blend 64, speed 0; Sync, Solid, Keep in front, On desktop on; Reflect 64', () => {
    const p = defaultGenParams('dance');
    expect(p).toMatchObject({ move: 2, mirror: 0, visible: 1, blend: 64, speed: 0, y: 500, sync: true, solid: true, front: true, desktop: true, reflect: 64, sheet: 'pippin' });
    // like FL, a new instance stands at a random x of 400..799 (the parameter's own default stays 600)
    const xs = Array.from({ length: 40 }, () => defaultGenParams('dance').x as number);
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(400); expect(x).toBeLessThan(800); }
    expect(new Set(xs).size).toBeGreaterThan(10);
    const s = danceState(p);
    expect([s.move, s.mirror, s.visible, s.blend, s.speed, s.sync, s.solid, s.front, s.desktop, s.reflect]).toEqual([2, false, true, 64, 0, true, true, true, true, 64]);
  });

  it('survives a JSON round trip and repairs a damaged state', () => {
    const def = normalizeGenParams('dance', defaultGenParams('dance'));
    expect(normalizeGenParams('dance', json(def))).toEqual(def);
    // a saved x is kept, a missing one is filled in
    expect(normalizeGenParams('dance', { x: 123 }).x).toBe(123);
    const bad = normalizeGenParams('dance', { move: 'x', mirror: NaN, visible: 7, blend: 9999, speed: -9999, x: null, y: Infinity, reflect: -3, sheet: 'user', sheetNames: [3, '', 'ok'], sheetData: 5 });
    expect(bad).toMatchObject({ move: 2, mirror: 0, visible: 1, blend: 256, speed: -96, x: 600, y: 500, reflect: 0, sheet: 'user', sheetNames: ['ok'], sheetData: '' });
    // a stored sheet image is an inline image only: a link the page would fetch is dropped
    expect(danceState({ sheetData: 'https://example.com/x.png' }).sheetData).toBe('');
    expect(danceState({ sheetData: 'data:text/html;base64,AAAA' }).sheetData).toBe('');
    expect(danceState({ sheetData: 'data:image/png;base64,iVBORw0KGgo=' }).sheetData).toBe('data:image/png;base64,iVBORw0KGgo=');
    // a user sheet without row names is not a sheet
    expect(danceState({ sheet: 'user', sheetNames: [] }).sheet).toBe('pippin');
    for (const q of D.params) expect(clampParam(q, 1e9)).toBeLessThanOrEqual(q.max);
  });
});

describe('Dance: notes (FL\'s TriggerVoice)', () => {
  it('has the measured note -> parameter table', () => {
    for (let k = 0; k <= 131; k++) {
      const e = danceKeyEffect(k);
      const want = MEASURED[k];
      if (want) expect(e, `key ${k}`).toEqual(want);
      else expect(e, `key ${k}`).toBeNull();
    }
    // keys 59..68 = move 0..9 with Mirror off, keys 48..39 the same with Mirror on, 53 hides, 54 shows
    expect(DANCE_MOVES[0]).toBe('Freestyle');
    expect(Object.keys(MEASURED)).toHaveLength(22);
  });

  it('applies the table to the plugin from any start state (the test host sweep)', () => {
    const A = { move: 5, mirror: 0, visible: 1, blend: 100, speed: 10, x: 111, y: 222 };
    const B = { move: 6, mirror: 1, visible: 0, blend: 150, speed: -10, x: -111, y: -222 };
    for (let k = 0; k <= 131; k++) {
      for (const base of [A, B]) {
        const got = after(k, base);
        const w = MEASURED[k] ?? {};
        expect(got, `key ${k}`).toEqual({ ...base, ...w });
      }
    }
  });

  it('follows the loaded sprite sheet: the keys reach its moves only (measured with sheets of 6, 3, 1 rows)', () => {
    // names (the last is the Held row) -> keys 59.. / 48.. up to the number of rows minus one
    const sheets: [string[], number][] = [[['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Held'], 5], [['a', 'b', 'Held'], 2], [['Solo'], 0], [['Count'], 0], [['A', 'Held'], 1]];
    for (const [names, moves] of sheets) {
      expect(danceKeyMovesOf(names.length)).toBe(moves);
      const base = { move: 1, mirror: 1, visible: 0, sheet: 'user', sheetNames: names };
      for (let k = 36; k <= 70; k++) {
        const e = danceKeyEffect(k, moves);
        const got = after(k, base);
        const want: Record<string, unknown> = {};
        if (k >= 59 && k <= 59 + moves) Object.assign(want, { move: k - 59, mirror: 0 });
        else if (k <= 48 && k >= 48 - moves) Object.assign(want, { move: 48 - k, mirror: 1 });
        else if (k === 53) Object.assign(want, { visible: 0 });
        else if (k === 54) Object.assign(want, { visible: 1 });
        expect(e ?? {}, `key ${k} on ${names.length} rows`).toEqual(want);
        expect(got, `engine key ${k} on ${names.length} rows`).toEqual({ ...base, ...want });
      }
    }
    // a sheet with more than 9 moves keeps the parameter's range: FL's keys reach 59..70 / 48..37 for 11 moves, here 59..68 / 48..39
    expect(danceKeyMovesOf(12)).toBe(9);
    expect(danceKeyEffect(69, danceKeyMovesOf(12))).toBeNull();
    expect(danceKeyEffect(68, danceKeyMovesOf(12))).toEqual({ move: 9, mirror: 0 });
    expect(danceMoveList(danceState({ sheet: 'user', sheetNames: Array.from({ length: 12 }, (_, i) => `m${i}`) }))).toHaveLength(10);
    // the countdown sheet (one row): only Freestyle (and the window keys) answer
    const cd = { move: 1, mirror: 1, visible: 1, sheet: 'countdown' };
    expect(after(59, cd)).toEqual({ ...cd, move: 0, mirror: 0 });
    expect(after(60, cd)).toEqual(cd);
    expect(after(47, cd)).toEqual(cd);
  });

  it('names the keys as the plugin does in the Piano roll (FL: GetName(FPN_Semitone))', () => {
    const k = danceKeyNames(defaultGenParams('dance'));
    expect(Object.keys(k).map(Number).sort((a, b) => a - b)).toEqual([39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 53, 54, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68]);
    expect([59, 60, 61, 62, 63, 64, 65, 66, 67, 68].map((n) => k[n])).toEqual(DANCE_MOVES);
    expect([48, 47, 46, 45, 44, 43, 42, 41, 40, 39].map((n) => k[n])).toEqual(DANCE_MOVES.map((m) => `M ${m}`));
    expect([k[53], k[54]]).toEqual(['Hide', 'Show']);
    expect(D.keyNames).toBe(danceKeyNames);
    // a loaded sheet's row names (measured with a 6-row sheet and one with a single row)
    const five = danceKeyNames({ ...defaultGenParams('dance'), sheet: 'user', sheetNames: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Held'] });
    expect(five).toEqual({
      43: 'M Echo', 44: 'M Delta', 45: 'M Charlie', 46: 'M Bravo', 47: 'M Alpha', 48: 'M Freestyle', 53: 'Hide', 54: 'Show',
      59: 'Freestyle', 60: 'Alpha', 61: 'Bravo', 62: 'Charlie', 63: 'Delta', 64: 'Echo',
    });
    expect(danceKeyNames({ ...defaultGenParams('dance'), sheet: 'countdown' })).toEqual({ 48: 'M Freestyle', 53: 'Hide', 54: 'Show', 59: 'Freestyle' });
  });

  it('reads only the key: velocity, colour, length, pan and note off change nothing', () => {
    const base = { move: 6, mirror: 1, visible: 0 };
    for (const vel of [0, 1, 50, 100, 128, 255]) expect(after(61, base, {}, vel)).toEqual({ move: 2, mirror: 0, visible: 0 });
    for (let c = 0; c < 16; c++) expect(after(61, base, { color: c })).toEqual({ move: 2, mirror: 0, visible: 0 });
    for (const length of [1, 480, Infinity]) expect(after(45, base, { length })).toEqual({ move: 3, mirror: 1, visible: 0 });
    expect(after(61, base, { release: 0, init: { ...newLevels(), pan: 1, fcut: 1, fres: 1, pitch: 8000 } })).toEqual({ move: 2, mirror: 0, visible: 0 });
  });

  it('makes no voice (FL kills it inside TriggerVoice) so no note off or render follows', () => {
    const inst = createGen('dance', SR, 128)!;
    inst.setParams(defaultGenParams('dance'));
    for (const k of [0, 39, 48, 53, 54, 59, 61, 68, 100, 131]) expect(inst.triggerVoice!(voiceParams(k))).toBeNull();
  });
});

describe('Dance: state changes the engine reports', () => {
  it('reports each parameter it changed, once, in the order the note changes them', () => {
    const inst = createGen('dance', SR, 128)!;
    inst.setParams(defaultGenParams('dance'));
    expect(inst.takeStateChanges!()).toBeNull();
    inst.triggerVoice!(voiceParams(45));
    expect(inst.takeStateChanges!()).toEqual([['move', 3], ['mirror', 1]]);
    expect(inst.takeStateChanges!()).toBeNull();
    // the same note again changes nothing
    inst.triggerVoice!(voiceParams(45));
    expect(inst.takeStateChanges!()).toBeNull();
    inst.triggerVoice!(voiceParams(53));
    expect(inst.takeStateChanges!()).toEqual([['visible', 0]]);
    inst.triggerVoice!(voiceParams(54));
    expect(inst.takeStateChanges!()).toEqual([['visible', 1]]);
  });

  it('reports only the last value when several notes fall in one block', () => {
    const inst = createGen('dance', SR, 128)!;
    inst.setParams(defaultGenParams('dance'));
    // key 61 is the state it already has: only the notes that change something are reported, the last value wins
    for (const k of [61, 62, 63, 66]) inst.triggerVoice!(voiceParams(k));
    expect(inst.takeStateChanges!()).toEqual([['move', 7]]);
    inst.triggerVoice!(voiceParams(46));
    inst.triggerVoice!(voiceParams(64));
    expect(inst.takeStateChanges!()).toEqual([['move', 5], ['mirror', 0]]);
  });

  it('follows the state the project holds (setParams), not an older one', () => {
    const inst = createGen('dance', SR, 128)!;
    inst.setParams({ ...defaultGenParams('dance'), move: 7, mirror: 0 });
    inst.triggerVoice!(voiceParams(66));
    expect(inst.takeStateChanges!()).toBeNull();
    inst.triggerVoice!(voiceParams(61));
    expect(inst.takeStateChanges!()).toEqual([['move', 2]]);
    inst.setParams({ ...defaultGenParams('dance'), move: 2 });
    inst.triggerVoice!(voiceParams(61));
    expect(inst.takeStateChanges!()).toBeNull();
  });

  it('is mirrored into the project by an engine playing the channel, and the channel stays silent', () => {
    const msgs: FromEngine[] = [];
    const e = makeEngine({ post: (m) => msgs.push(m) });
    const ch = createGenChannel('dance');
    ch.volume = 1;
    // a pattern: key 63 (Zombie, mirror off) at the start, key 46 (Stepping mirrored) a beat later, key 53 (hide) after that
    const [L, R] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 12, key: 63 }, { pos: 96, len: 12, key: 46 }, { pos: 192, len: 12, key: 53 }] }, Math.round(SR * 1.9));
    expect(peak(L)).toBe(0);
    expect(peak(R)).toBe(0);
    const items = msgs.filter((m): m is Extract<FromEngine, { t: 'fxState' }> => m.t === 'fxState').flatMap((m) => m.items);
    expect(items).toEqual([[`ch:${ch.id}`, 'move', 4], [`ch:${ch.id}`, 'move', 2], [`ch:${ch.id}`, 'mirror', 1], [`ch:${ch.id}`, 'visible', 0]]);
  });

  it('stays finite for every key with extreme or invalid settings', () => {
    const inst = createGen('dance', SR, 128)!;
    for (const st of [{}, { move: 99, mirror: -4, visible: 1e9 }, { move: Number.NaN, mirror: Number.POSITIVE_INFINITY }, null, 5]) {
      expect(() => inst.setParams(st)).not.toThrow();
      for (let k = -5; k < 140; k++) expect(() => inst.triggerVoice!(voiceParams(k))).not.toThrow();
      const ch = inst.takeStateChanges!() ?? [];
      for (const [, v] of ch) expect(Number.isFinite(v as number)).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ the animation, measured from the plugin's window

describe('Dance: animation law', () => {
  it('frame = floor(beats x 4 / (1 + |speed| / 32)): a cycle of 8 frames takes 2 beats, 4 at speed 32, 8 at +-96', () => {
    expect(dancePhase(0.25, 0)).toBeCloseTo(1, 12);
    expect(dancePhase(2, 0)).toBeCloseTo(8, 12);
    expect(dancePhase(4, 32)).toBeCloseTo(8, 12);
    expect(dancePhase(8, 96)).toBeCloseTo(8, 12);
    expect(dancePhase(8, -96)).toBeCloseTo(8, 12);
    // measured frame durations in beats at speeds 8 / 16 / 32 / 48 / 64 / 96: 0.3125 / 0.375 / 0.5 / 0.625 / 0.75 / 1
    const want: Record<number, number> = { 8: 0.3125, 16: 0.375, 32: 0.5, 48: 0.625, 64: 0.75, 96: 1, 1: 0.2578125, 4: 0.28125, 12: 0.34375, 24: 0.4375, 40: 0.5625, 80: 0.875 };
    for (const [sp, d] of Object.entries(want)) expect(1 / dancePhase(1, Number(sp)), `speed ${sp}`).toBeCloseTo(d, 9);
  });

  it('reproduces FL\'s speed quirk: a speed changed FROM A POSITIVE speed speeds the dance up by 1 + |speed| / 32 instead of slowing it', () => {
    // measured grid (old -> new, post-change frame duration in beats, normal / inverse law)
    const grid: [number, number, 'normal' | 'inverse'][] = [
      [-48, -16, 'normal'], [-48, 16, 'normal'], [-48, 48, 'normal'], [-24, -48, 'normal'], [-24, -16, 'normal'], [-24, 16, 'normal'], [-24, 48, 'normal'],
      [-8, -48, 'normal'], [-8, 16, 'normal'], [-8, 48, 'normal'], [0, 24, 'normal'], [0, -24, 'normal'], [0, 70, 'normal'],
      [8, -48, 'inverse'], [8, -16, 'inverse'], [8, 16, 'inverse'], [8, 48, 'inverse'], [24, -48, 'inverse'], [24, -16, 'inverse'], [24, 16, 'inverse'], [24, 48, 'inverse'],
      [48, -48, 'inverse'], [48, -16, 'inverse'], [48, 16, 'inverse'], [24, -24, 'inverse'], [16, 24, 'inverse'], [24, -70, 'inverse'],
    ];
    for (const [o, n, want] of grid) {
      expect(danceSpeedInverse(o, n) ? 'inverse' : 'normal', `${o} -> ${n}`).toBe(want);
      const f = 1 + Math.abs(n) / 32;
      expect(1 / danceFramesPerBeat(n, danceSpeedInverse(o, n)), `${o} -> ${n}`).toBeCloseTo(want === 'normal' ? 0.25 * f : 0.25 / f, 9);
    }
    // the animator follows it from the changes it sees: a loaded +24 is slow, the next change makes it fast, 0 and negatives are normal again
    const a = new DanceAnimator(() => 0.5);
    const rate = (speed: number, from: number) => {
      const c0 = a.frame(from, true, false, tg({ speed })).col;
      // frames advanced over the next beat (a whole number of frames is not guaranteed: measure the phase over 4 beats)
      let n = 0, last = c0;
      for (let i = 1; i <= 400; i++) { const c = a.frame(from + i * 0.01, true, false, tg({ speed })).col; if (c !== last) n++; last = c; }
      return n / 4;
    };
    expect(rate(24, 8)).toBeCloseTo(4 / 1.75, 0);       // set (loaded): slow, 2.29 frames per beat
    expect(rate(16, 16)).toBeCloseTo(4 * 1.5, 0);       // changed from +24: fast, 6 frames per beat
    expect(rate(16, 24)).toBeCloseTo(4 * 1.5, 0);       // rewriting nothing: stays fast
    expect(rate(-16, 32)).toBeCloseTo(4 * 1.5, 0);      // +16 -> -16 (from positive): fast
    expect(rate(16, 40)).toBeCloseTo(4 / 1.5, 0);       // -16 -> +16: normal again
    expect(rate(0, 48)).toBeCloseTo(4, 0);
    expect(rate(32, 56)).toBeCloseTo(2, 0);             // 0 -> +32: normal
    // move, mirror and blend changes do not touch the mode
    expect(a.frame(60, true, false, tg({ speed: 32 })).col).toBeGreaterThanOrEqual(0);
    expect(danceSpeedInverse(24, 24)).toBe(false);
  });

  it('mixes the next frame in linearly over the last blend / 256 of each frame', () => {
    expect(danceBlend(0.5, 0)).toBe(0);
    expect([0, 0.5, 0.74, 0.75, 0.875, 1].map((f) => danceBlend(f, 64))).toEqual([0, 0, 0, 0, 0.5, 1]);
    expect([0, 0.25, 0.5, 0.75, 1].map((f) => danceBlend(f, 256))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect([0.5, 0.75, 1].map((f) => danceBlend(f, 128))).toEqual([0, 0.5, 1]);
    expect(danceBlend(0.99, 1)).toBeCloseTo(0.0, 1);
  });
});

const T: AnimTarget = { move: 2, mirror: false, blend: 0, speed: 0, sync: true, moves: 9, heldRow: 9 };
const tg = (over: Partial<AnimTarget> = {}): AnimTarget => ({ ...T, ...over });

describe('Dance: character animation', () => {
  it('shows frame floor(beats x 4) mod 8 of the move\'s row while the song plays', () => {
    const a = new DanceAnimator(() => 0.5);
    for (let i = 0; i < 40; i++) {
      const beat = i * 0.2;
      const f = a.frame(beat, true, false, tg());
      expect(f.col).toBe(Math.floor(beat * 4 + 1e-9) % 8);
      expect(f.row).toBe(1);
      expect(f.t).toBe(0);
    }
  });

  it('stands still on frame 0 while the song is stopped (the real plugin does not dance then)', () => {
    const a = new DanceAnimator(() => 0.3);
    for (const beat of [0, 1.3, 7.7, 1000]) {
      const f = a.frame(beat, false, false, tg({ move: 5 }));
      expect([f.row, f.col, f.t]).toEqual([4, 0, 0]);
    }
  });

  it('applies a new move at the end of the running cycle when Sync changes is on, at once otherwise or while stopped', () => {
    const a = new DanceAnimator(() => 0.5);
    expect(a.frame(0.1, true, false, tg()).row).toBe(1);
    // change to Hula (6) in the middle of the cycle: the old move runs on until beat 2
    expect(a.frame(0.8, true, false, tg({ move: 6 })).row).toBe(1);
    expect(a.frame(1.9, true, false, tg({ move: 6 })).row).toBe(1);
    expect(a.frame(2.0, true, false, tg({ move: 6 })).row).toBe(5);
    expect(a.frame(2.1, true, false, tg({ move: 6 })).col).toBe(0);
    // without Sync it applies at once
    const b = new DanceAnimator(() => 0.5);
    b.frame(0.1, true, false, tg({ sync: false }));
    const f = b.frame(0.8, true, false, tg({ sync: false, move: 6 }));
    expect([f.row, f.col]).toEqual([5, 3]);
    // stopped: at once even with Sync
    const c = new DanceAnimator(() => 0.5);
    c.frame(0, false, false, tg());
    expect(c.frame(0, false, false, tg({ move: 6 })).row).toBe(5);
  });

  it('counts a change noticed just after a cycle began (grace) as made before it: a note on the downbeat switches at the downbeat', () => {
    const a = new DanceAnimator(() => 0.5);
    a.frame(1.9, true, false, tg());
    // the change reaches the page 0.05 beat after the cycle began at beat 2: within a 0.1 beat grace it applies now
    a.frame(2.0, true, false, tg(), 0.1);
    expect(a.frame(2.05, true, false, tg({ move: 6 }), 0.1).row).toBe(5);
    // 0.3 beat after: too late, the move waits for the next cycle
    const b = new DanceAnimator(() => 0.5);
    b.frame(1.9, true, false, tg());
    b.frame(2.0, true, false, tg(), 0.1);
    expect(b.frame(2.3, true, false, tg({ move: 6 }), 0.1).row).toBe(1);
    expect(b.frame(3.9, true, false, tg({ move: 6 }), 0.1).row).toBe(1);
    expect(b.frame(4.0, true, false, tg({ move: 6 }), 0.1).row).toBe(5);
    // the window is in beats since the cycle began, whatever the speed (speed 32: the cycle takes 4 beats)
    const c = new DanceAnimator(() => 0.5);
    c.frame(3.9, true, false, tg({ speed: 32 }), 0.1);
    c.frame(4.0, true, false, tg({ speed: 32 }), 0.1);
    expect(c.frame(4.06, true, false, tg({ speed: 32, move: 6 }), 0.1).row).toBe(5);
    // without a grace (the default) it is exactly the end of the cycle
    const d = new DanceAnimator(() => 0.5);
    d.frame(1.9, true, false, tg());
    d.frame(2.0, true, false, tg());
    expect(d.frame(2.05, true, false, tg({ move: 6 })).row).toBe(1);
  });

  it('keeps a pending change waiting when a speed change jumps the cycle counter: it applies when the frame index wraps (measured)', () => {
    const a = new DanceAnimator(() => 0.5);
    a.frame(4.5, true, false, tg());
    // a change is pending at frame 3 of the cycle starting at beat 4 (speed 0)
    expect(a.frame(4.75, true, false, tg({ move: 6 })).row).toBe(1);
    // the speed changes to 8 (from 0: normal slowing): the phase jumps back to frame 7 of the previous cycle: nothing applies
    const f = a.frame(4.75, true, false, tg({ move: 6, speed: 8 }));
    expect([f.row, f.col]).toEqual([1, 7]);
    expect(a.frame(4.9, true, false, tg({ move: 6, speed: 8 })).row).toBe(1);
    // the frame index wraps to 0 at phase 16 (beat 5): now it applies
    const g = a.frame(5.0, true, false, tg({ move: 6, speed: 8 }));
    expect([g.row, g.col]).toEqual([5, 0]);
    // a jump that lands on frame 0 does apply it
    const b = new DanceAnimator(() => 0.5);
    b.frame(0.4, true, false, tg());
    expect(b.frame(0.5, true, false, tg({ move: 6 })).row).toBe(1);
    const h = b.frame(2.0, true, false, tg({ move: 6 }));
    expect([h.row, h.col]).toEqual([5, 0]);
  });

  it('applies a pending change whenever the position inside the cycle goes back, a speed jump included (measured)', () => {
    // speed 0 -> 8 at beat 3.0: phase 12 -> 9.6, frame 4 -> 1: the pending move applies at once
    const a = new DanceAnimator(() => 0.5);
    a.frame(2.2, true, false, tg());
    expect(a.frame(2.3, true, false, tg({ move: 6 })).row).toBe(1);
    expect(a.frame(2.9, true, false, tg({ move: 6, blend: 40 })).row).toBe(1);
    const f = a.frame(3.0, true, false, tg({ move: 6, blend: 40, speed: 8 }));
    expect([f.row, f.col]).toEqual([5, 1]);
    // the same for a pending mirror state
    const m = new DanceAnimator(() => 0.5);
    m.frame(2.2, true, false, tg());
    m.frame(2.3, true, false, tg({ mirror: true }));
    m.frame(2.9, true, false, tg({ mirror: true }));
    const g = m.frame(3.0, true, false, tg({ mirror: true, speed: 8 }));
    expect([g.mirror, g.col]).toEqual([true, 1]);
    // speed 0 -> 32 at beat 3.0: phase 12 -> 6, frame 4 -> 6 (higher): it keeps waiting, until the frame index wraps at beat 4.0
    const b = new DanceAnimator(() => 0.5);
    b.frame(2.2, true, false, tg());
    b.frame(2.3, true, false, tg({ move: 6 }));
    b.frame(2.9, true, false, tg({ move: 6 }));
    const h = b.frame(3.0, true, false, tg({ move: 6, speed: 32 }));
    expect([h.row, h.col]).toEqual([1, 6]);
    expect(b.frame(3.95, true, false, tg({ move: 6, speed: 32 })).row).toBe(1);
    const h2 = b.frame(4.0, true, false, tg({ move: 6, speed: 32 }));
    expect([h2.row, h2.col]).toEqual([5, 0]);
    // the same frame index (7 -> 7 at beat 3.8, phase 15.2 -> 7.6) leaves it waiting too
    const c = new DanceAnimator(() => 0.5);
    c.frame(2.2, true, false, tg());
    c.frame(2.3, true, false, tg({ move: 6 }));
    c.frame(3.79, true, false, tg({ move: 6 }));
    expect(c.frame(3.8, true, false, tg({ move: 6, speed: 32 })).row).toBe(1);
    expect(c.frame(4.0, true, false, tg({ move: 6, speed: 32 })).row).toBe(5);
    // the cycle counter going down is no wrap by itself: frame 1 -> 0 at beat 4.45 (phase 17.8 -> 8.9) is
    const d = new DanceAnimator(() => 0.5);
    d.frame(4.1, true, false, tg());
    d.frame(4.2, true, false, tg({ move: 6 }));
    d.frame(4.44, true, false, tg({ move: 6 }));
    const k = d.frame(4.45, true, false, tg({ move: 6, speed: 32 }));
    expect([k.row, k.col]).toEqual([5, 0]);
    // the position inside the cycle counts, not the frame index: speed 0 -> 64 at beat 3.1 (phase 12.4 -> 4.13, frame 4 -> 4) applies it ...
    const r = new DanceAnimator(() => 0.5);
    r.frame(2.2, true, false, tg());
    r.frame(2.3, true, false, tg({ move: 6 }));
    r.frame(3.09, true, false, tg({ move: 6 }));
    const r1 = r.frame(3.1, true, false, tg({ move: 6, speed: 64 }));
    expect([r1.row, r1.col]).toEqual([5, 4]);
    // ... and a jump to a later place of the same frame (beat 2.9: phase 11.6 -> 3.87, frame 3 -> 3) does not
    const s = new DanceAnimator(() => 0.5);
    s.frame(2.2, true, false, tg());
    s.frame(2.3, true, false, tg({ move: 6 }));
    s.frame(2.89, true, false, tg({ move: 6 }));
    const s1 = s.frame(2.9, true, false, tg({ move: 6, speed: 64 }));
    expect([s1.row, s1.col]).toEqual([1, 3]);
    // the fast mode too: speed 12 -> 20 at beat 2.2 (phase 6.37 -> 14.3, frame 6 -> 6, 6.37 -> 6.3 inside the cycle) applies it
    const w = new DanceAnimator(() => 0.5);
    w.frame(0.2, true, false, tg({ speed: 12 }));
    w.frame(1.7, true, false, tg({ speed: 12, move: 6 }));
    w.frame(2.19, true, false, tg({ speed: 12, move: 6 }));
    const w1 = w.frame(2.2, true, false, tg({ speed: 20, move: 6 }));
    expect([w1.row, w1.col]).toEqual([5, 6]);
    // a switch to the fast mode (from a positive speed) that jumps to a higher frame index leaves it waiting as well
    const e = new DanceAnimator(() => 0.5);
    e.frame(2.6, true, false, tg({ speed: 8 }));
    e.frame(2.7, true, false, tg({ speed: 8, move: 6 }));
    e.frame(3.39, true, false, tg({ speed: 8, move: 6 }));
    const q = e.frame(3.4, true, false, tg({ speed: 16, move: 6 }));
    expect([q.row, q.col]).toEqual([1, 4]);
    const q2 = e.frame(4.0, true, false, tg({ speed: 16, move: 6 }));
    expect([q2.row, q2.col]).toEqual([5, 0]);
  });

  it('takes small backward steps of the position for jitter when asked to, but not a real jump back', () => {
    const run = (jitter: number, back: number) => {
      const a = new DanceAnimator(() => 0.5);
      a.frame(0.2, true, false, tg(), 0, jitter);
      a.frame(0.5, true, false, tg({ move: 6 }), 0, jitter);          // pending, frame 2
      return a.frame(0.5 - back, true, false, tg({ move: 6 }), 0, jitter);
    };
    // 0.03 beat back (frame 2 -> 1): a wrap for FL's smooth position, noise for the page's estimate
    expect([run(0, 0.03).row, run(0, 0.03).col]).toEqual([5, 1]);
    expect([run(0.1, 0.03).row, run(0.1, 0.03).col]).toEqual([1, 2]);
    // 0.4 beat back is a jump (a loop, a seek): it ends the cycle
    expect([run(0.1, 0.4).row, run(0.1, 0.4).col]).toEqual([5, 0]);
  });

  it('applies a new Mirror state like a new move (the end of the cycle)', () => {
    const a = new DanceAnimator(() => 0.5);
    a.frame(0.1, true, false, tg());
    expect(a.frame(0.8, true, false, tg({ mirror: true })).mirror).toBe(false);
    expect(a.frame(2.05, true, false, tg({ mirror: true })).mirror).toBe(true);
  });

  it('blends the last frame of a cycle into the first frame of the new move', () => {
    const a = new DanceAnimator(() => 0.5);
    a.frame(0.1, true, false, tg({ blend: 256 }));
    // elsewhere in the cycle the next frame is of the same row
    const g = a.frame(0.5 + 0.0625, true, false, tg({ blend: 256, move: 6 }));
    expect([g.row, g.col, g.row2, g.col2]).toEqual([1, 2, 1, 3]);
    // frame 7 of the cycle, a quarter way through the frame
    const f = a.frame(1.75 + 0.0625, true, false, tg({ blend: 256, move: 6 }));
    expect([f.row, f.col, f.row2, f.col2, f.mirror2]).toEqual([1, 7, 5, 0, false]);
    expect(f.t).toBeCloseTo(0.25, 6);
  });

  it('plays Freestyle as a random move after the first for each cycle, the same one throughout the cycle', () => {
    let n = 0;
    const seq = [0.0, 0.99, 0.5, 0.26, 0.74];
    const a = new DanceAnimator(() => seq[n++ % seq.length]);
    const rows: number[] = [];
    for (let cycle = 0; cycle < 12; cycle++) {
      const r = new Set<number>();
      for (const off of [0.01, 0.6, 1.2, 1.9]) r.add(a.frame(cycle * 2 + off, true, false, tg({ move: 0 })).row);
      expect(r.size).toBe(1);
      rows.push([...r][0]);
    }
    for (const r of rows) { expect(r).toBeGreaterThanOrEqual(1); expect(r).toBeLessThanOrEqual(8); }
    expect(new Set(rows).size).toBeGreaterThan(3);
    // the pick is the model's: rows 1..moves-1 evenly, never Waiting
    expect([0, 0.124, 0.125, 0.5, 0.875].map((r) => danceFreeRow(9, r))).toEqual([1, 1, 2, 5, 8]);
    expect(danceFreeRow(9, 0)).toBe(1);
    expect(danceFreeRow(9, 0.9999)).toBe(8);
    expect(danceFreeRow(5, 0.5)).toBe(3);
    // sheets with few moves (measured): 2 moves -> row 1, 1 move -> row 0
    expect([danceFreeRow(2, 0), danceFreeRow(2, 0.99), danceFreeRow(1, 0.5)]).toEqual([1, 1, 0]);
  });

  it('Freestyle never picks the first move over many cycles and uses every other one', () => {
    let seed = 12345;
    const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const a = new DanceAnimator(rand);
    const seen = new Map<number, number>();
    for (let cycle = 0; cycle < 400; cycle++) {
      a.frame(cycle * 2 + 1.9, true, false, tg({ move: 0 }));
      const row = a.frame(cycle * 2 + 2.3, true, false, tg({ move: 0 })).row;
      seen.set(row, (seen.get(row) ?? 0) + 1);
    }
    expect(seen.has(0)).toBe(false);
    expect([...seen.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const n of seen.values()) expect(n).toBeGreaterThan(20);
  });

  it('shows the Held row at once while the mouse holds the character, on the running frame', () => {
    const a = new DanceAnimator(() => 0.5);
    a.frame(0.1, true, false, tg());
    const f = a.frame(0.8, true, true, tg({ move: 6 }));
    expect([f.row, f.col]).toEqual([9, 3]);
    expect(a.frame(0.9, true, false, tg({ move: 6 })).row).toBe(1);
    expect(a.frame(0, false, true, tg()).row).toBe(9);
    // the Held row crossfades over the last two thirds of each frame whatever the blend slider says
    const h = new DanceAnimator(() => 0.5);
    const held = (frame: number, frac: number, blend: number) => h.frame((frame + frac) / 4, true, true, tg({ blend }));
    expect(held(1, 0.2, 0).t).toBe(0);
    expect(held(1, 0.5, 0).t).toBeCloseTo(0.25, 9);
    expect(held(1, 0.9, 256).t).toBeCloseTo(0.85, 9);
    expect(held(1, 0.3, 256).t).toBe(0);
    expect(held(1, 0.9, 256).col2).toBe(2);
    // ... and it runs at the base speed: the Speed slider does not apply (measured at speed 32: a frame per quarter beat)
    const sp = new DanceAnimator(() => 0.5);
    expect([0.3, 0.55, 0.8].map((b) => sp.frame(b, true, true, tg({ speed: 32 })).col)).toEqual([1, 2, 3]);
    expect(sp.frame(0.8, true, false, tg({ speed: 32 })).col).toBe(1);
    // the Held row is not mirrored (measured: Mirror on, mouse held: the unflipped cells)
    const b = new DanceAnimator(() => 0.5);
    expect(b.frame(0.9, true, false, tg({ mirror: true })).mirror).toBe(true);
    expect(b.frame(0.9, true, true, tg({ mirror: true })).mirror).toBe(false);
    expect(b.frame(0, false, true, tg({ mirror: true })).mirror).toBe(false);
  });

  it('follows the speed from the song position: a speed change jumps the frame', () => {
    const a = new DanceAnimator(() => 0.5);
    expect(a.frame(0.833, true, false, tg()).col).toBe(3);
    expect(a.frame(0.867, true, false, tg({ speed: 32 })).col).toBe(1);
    expect(a.frame(1.034, true, false, tg({ speed: 32 })).col).toBe(2);
    // the sign does not matter (a negative speed set from 0, like a positive one)
    const b = new DanceAnimator(() => 0.5);
    b.frame(0.833, true, false, tg());
    expect(b.frame(1.034, true, false, tg({ speed: -32 })).col).toBe(2);
  });

  it('clamps moves beyond the sheet to its last move row', () => {
    expect(danceRowOf(9, 5, 0)).toBe(4);
    expect(danceRowOf(1, 5, 0)).toBe(0);
    expect(danceRowOf(0, 5, 3)).toBe(3);
    const a = new DanceAnimator(() => 0.5);
    expect(a.frame(0.1, true, false, tg({ move: 9, moves: 5 })).row).toBe(4);
  });
});

describe('Dance: sprite sheets and the window', () => {
  it('lays a sheet out as 8 cells wide with one row per name (measured with sheets of other sizes)', () => {
    expect(danceSheetGrid(1760, 2560, 10)).toEqual({ cellW: 220, cellH: 256, rows: 10 });
    expect(danceSheetGrid(800, 100, 1)).toEqual({ cellW: 100, cellH: 100, rows: 1 });
    expect(danceSheetGrid(352, 312, 6)).toEqual({ cellW: 44, cellH: 52, rows: 6 });
    // fewer names than image rows: taller cells (FL: a 3-row image with one name has one tall row)
    expect(danceSheetGrid(352, 156, 1)).toEqual({ cellW: 44, cellH: 156, rows: 1 });
    expect(danceSheetGrid(352, 312, 12)).toEqual({ cellW: 44, cellH: 26, rows: 12 });
    expect(danceSheetGrid(352, 312, 4)).toEqual({ cellW: 44, cellH: 78, rows: 4 });
    // refused: the height is not a whole number of rows, the width not of 8 cells
    expect(danceSheetGrid(352, 312, 7)).toBeNull();
    expect(danceSheetGrid(352, 156, 5)).toBeNull();
    expect(danceSheetGrid(350, 312, 6)).toBeNull();
    expect(danceSheetGrid(352, 312, 0)).toBeNull();
  });

  it('reads row names from the text file and offers every row but the last as a move', () => {
    expect(parseSheetNames('Waiting\r\nStepping\r\nHeld\r\n')).toEqual(['Waiting', 'Stepping', 'Held']);
    expect(parseSheetNames('A\n\n  B  \nHeld')).toEqual(['A', 'B', 'Held']);
    expect(danceMovesOf(['A', 'B', 'Held'])).toEqual(['A', 'B']);
    expect(danceHeldRow(['A', 'B', 'Held'])).toBe(2);
    // a single row is the move and the held pose
    expect(danceMovesOf(['Count'])).toEqual(['Count']);
    expect(danceHeldRow(['Count'])).toBe(0);
    expect(danceMovesOf(DANCE_SHEET_NAMES)).toEqual(DANCE_MOVES.slice(1));
    expect(DANCE_SHEET_NAMES.at(-1)).toBe('Held');
  });

  it('sizes the window at half the cell with a reflection of a third of the height below it', () => {
    expect(danceBox(220, 256, 64)).toEqual({ w: 110, h: 128, refl: 43 });
    expect(danceBox(100, 100, 64)).toEqual({ w: 50, h: 50, refl: 17 });
    expect(danceBox(44, 52, 64)).toEqual({ w: 22, h: 26, refl: 9 });
    expect(danceBox(32, 32, 64)).toEqual({ w: 16, h: 16, refl: 5 });
    expect(danceBox(220, 256, 0)).toEqual({ w: 110, h: 128, refl: 0 });
  });

  it('fades the reflection linearly from Reflect / 256 at the feet (measured profile)', () => {
    expect(danceReflectAlpha(0, 43, 256)).toBe(1);
    expect(danceReflectAlpha(21.5, 43, 256)).toBeCloseTo(0.5, 12);
    expect(danceReflectAlpha(43, 43, 256)).toBe(0);
    // measured at 2x: Reflect 64, 12 px below the feet of 86: 0.212
    expect(danceReflectAlpha(6, 43, 64)).toBeCloseTo(0.2151, 3);
    expect(danceReflectAlpha(6, 43, 128)).toBeCloseTo(0.43, 2);
    expect(danceReflectAlpha(5, 0, 256)).toBe(0);
  });

  it('puts the window at X (centre) / Y (feet) and keeps 16 px of it on screen (measured)', () => {
    const box = danceBox(220, 256, 64);
    expect(danceWindowPos(557, 500, box, 1920, 1080)).toEqual({ left: 502, top: 372 });
    expect(danceCoordsOf(502, 372, box)).toEqual({ x: 557, y: 500 });
    // left edge: FL stops at -94 for the 110 px window (16 px stay visible), whatever X is
    expect(danceWindowPos(-100, 500, box, 1920, 1080).left).toBe(-94);
    expect(danceWindowPos(-8192, 500, box, 1920, 1080).left).toBe(-94);
    // never above the top of the work area, 16 px stay at the bottom
    expect(danceWindowPos(300, 0, box, 1920, 1080).top).toBe(0);
    expect(danceWindowPos(300, -500, box, 1920, 1080).top).toBe(0);
    expect(danceWindowPos(300, 8000, box, 1920, 1080).top).toBe(1080 - 16);
    expect(danceWindowPos(5000, 500, box, 1920, 1080).left).toBe(1920 - 16);
  });
});

describe('Dance: built-in character (Pippin)', () => {
  it('stands in the same neutral pose on frame 0 of every move (what is shown while the song is stopped)', () => {
    const n = neutralPose();
    for (let move = 0; move <= 8; move++) {
      const p = poseOf(move, 0);
      // the pivot may differ (Windmill turns about its middle) as long as the figure is drawn at the same place
      expect([p.ax - p.px, p.ay - p.py], `move ${move}`).toEqual([n.ax - n.px, n.ay - n.py]);
      // (through JSON: -0 and 0 are the same angle)
      expect(JSON.parse(JSON.stringify({ ...p, ax: 0, ay: 0, px: 0, py: 0 })), `move ${move}`).toEqual(JSON.parse(JSON.stringify({ ...n, ax: 0, ay: 0, px: 0, py: 0 })));
    }
  });

  it('animates every move: finite poses, at least 5 different ones in the 8 frames (Waiting and Zitabata repeat some on purpose)', () => {
    for (let move = 0; move <= 9; move++) {
      const keys = new Set<string>();
      for (let f = 0; f < 8; f++) {
        const p = poseOf(move, f);
        for (const v of [p.ax, p.ay, p.rot, p.sx, p.sy, p.yaw, ...p.armL, ...p.armR, ...p.legL, ...p.legR]) expect(Number.isFinite(v)).toBe(true);
        keys.add(JSON.stringify(p));
      }
      expect(keys.size, `move ${move}`).toBeGreaterThanOrEqual(5);
    }
  });
});
