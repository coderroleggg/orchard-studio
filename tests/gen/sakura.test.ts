// Sakura (FL: Sakura): the model side - registration (FL's 207 parameters, value texts pinned from
// test-host sweeps of every parameter at every raw value 0..256), FL's 501 factory presets (state
// chunks decoded), the insertion state, FL's state chunk and the repair of stored states. Sakura
// renders silence in FL's test host (licence check), so its DSP (ported by static analysis) cannot
// be compared with FL's output; the engine tests follow at the end of this file.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SkPlugin } from '../../src/engine/gen/plugins/sakura/plugin';
import { SkSynth, SK_DEFAULTS, skResetSeed } from '../../src/engine/gen/plugins/sakura/core';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';
import { defaultGenParams, genDef, genPresetState, normalizeGenParams } from '../../src/model/gen/registry';
import {
  SK_DELAY_SYNC, SK_ENGINE_COUNT, SK_H_DELAY_SYNC, SK_H_S2_RATIO, SK_H_SLOT0, SK_H_TRANSPOSE, SK_HIDDEN_COUNT, SK_HIDDEN_DEFAULT,
  SK_INSERT_PRESET, SK_INVERTS, SK_MOD_DESTS, SK_MOD_SOURCES, SK_PARAM_COUNT, SK_PARAM_KEYS, SK_PARAM_NAMES, SK_PRESET_NAMES,
  SK_S2_RATIOS, SK_SWITCHES, skChunkName, skChunkToState, skFormat, skInsertState, skNormHidden, skOctaves, skParse,
  skPresetState, skSlotIndex, skStateValues,
} from '../../src/model/gen/plugins/sakura/data';

const D = genDef('sakura')!;
const index = (name: string): number => SK_PRESET_NAMES.indexOf(name);
const preset = (name: string): Record<string, unknown> => genPresetState('sakura', D.presets![index(name)]);
const texts = (i: number): string[] => Array.from({ length: 257 }, (_, v) => D.params[i].format!(v));
/** FL's texts as runs: [first raw value, text] pairs expanded to raw 0..256 */
const runs = (r: [number, string][]): string[] => Array.from({ length: 257 }, (_, v) => r.filter(([s]) => s <= v).pop()![1]);

// FL's texts at raw 0..256 (flfxhost sweep Sakura I --all --tsv): the same list for every percent parameter
const PERCENT = (
  '0.0% 0.4% 0.8% 1.2% 1.6% 2.0% 2.3% 2.7% 3.1% 3.5% 3.9% 4.3% 4.7% 5.1% 5.5% 5.9% ' +
  '6.3% 6.6% 7.0% 7.4% 7.8% 8.2% 8.6% 9.0% 9.4% 9.8% 10.2% 10.5% 10.9% 11.3% 11.7% 12.1% ' +
  '12.5% 12.9% 13.3% 13.7% 14.1% 14.5% 14.8% 15.2% 15.6% 16.0% 16.4% 16.8% 17.2% 17.6% 18.0% 18.4% ' +
  '18.8% 19.1% 19.5% 19.9% 20.3% 20.7% 21.1% 21.5% 21.9% 22.3% 22.7% 23.0% 23.4% 23.8% 24.2% 24.6% ' +
  '25.0% 25.4% 25.8% 26.2% 26.6% 27.0% 27.3% 27.7% 28.1% 28.5% 28.9% 29.3% 29.7% 30.1% 30.5% 30.9% ' +
  '31.3% 31.6% 32.0% 32.4% 32.8% 33.2% 33.6% 34.0% 34.4% 34.8% 35.2% 35.5% 35.9% 36.3% 36.7% 37.1% ' +
  '37.5% 37.9% 38.3% 38.7% 39.1% 39.5% 39.8% 40.2% 40.6% 41.0% 41.4% 41.8% 42.2% 42.6% 43.0% 43.4% ' +
  '43.8% 44.1% 44.5% 44.9% 45.3% 45.7% 46.1% 46.5% 46.9% 47.3% 47.7% 48.0% 48.4% 48.8% 49.2% 49.6% ' +
  '50.0% 50.4% 50.8% 51.2% 51.6% 52.0% 52.3% 52.7% 53.1% 53.5% 53.9% 54.3% 54.7% 55.1% 55.5% 55.9% ' +
  '56.3% 56.6% 57.0% 57.4% 57.8% 58.2% 58.6% 59.0% 59.4% 59.8% 60.2% 60.5% 60.9% 61.3% 61.7% 62.1% ' +
  '62.5% 62.9% 63.3% 63.7% 64.1% 64.5% 64.8% 65.2% 65.6% 66.0% 66.4% 66.8% 67.2% 67.6% 68.0% 68.4% ' +
  '68.8% 69.1% 69.5% 69.9% 70.3% 70.7% 71.1% 71.5% 71.9% 72.3% 72.7% 73.0% 73.4% 73.8% 74.2% 74.6% ' +
  '75.0% 75.4% 75.8% 76.2% 76.6% 77.0% 77.3% 77.7% 78.1% 78.5% 78.9% 79.3% 79.7% 80.1% 80.5% 80.9% ' +
  '81.3% 81.6% 82.0% 82.4% 82.8% 83.2% 83.6% 84.0% 84.4% 84.8% 85.2% 85.5% 85.9% 86.3% 86.7% 87.1% ' +
  '87.5% 87.9% 88.3% 88.7% 89.1% 89.5% 89.8% 90.2% 90.6% 91.0% 91.4% 91.8% 92.2% 92.6% 93.0% 93.4% ' +
  '93.8% 94.1% 94.5% 94.9% 95.3% 95.7% 96.1% 96.5% 96.9% 97.3% 97.7% 98.0% 98.4% 98.8% 99.2% 99.6% ' +
  '100.0%'
).split(' ');
const ONOFF = runs([[0, 'Off'], [1, 'On']]);
const SIGN = runs([[0, '+'], [1, '-']]);
const HZ = runs([[0, '0Hz'], [21, '1Hz'], [72, '2Hz'], [123, '3Hz'], [175, '4Hz'], [226, '5Hz']]);

const SWITCHES = [55, 56, 57, 58, 59, 60, 61, 62, 63, 70, 74];
const INVERTS = [7, 12, 21, 23];
const PERCENT_PARAMS = Array.from({ length: SK_PARAM_COUNT }, (_, i) => i).filter((i) => !SWITCHES.includes(i) && !INVERTS.includes(i) && i !== 71);

describe('Sakura: registration', () => {
  it("has FL's 207 parameters (78 synth parameters, MIDI CC 0..127, channel aftertouch)", () => {
    expect(D).toBeDefined();
    expect(D.name).toBe('Sakura');
    expect(D.category).toBe('Synth special');
    expect(D.notes).toBe('events');
    expect(D.velocity).toBe('plugin');
    expect(D.levels).toBe('plugin');
    expect(D.defPoly).toBe(0);
    expect([D.width, D.height]).toEqual([855, 532]);
    expect(D.params.length).toBe(207);
    expect(SK_PARAM_KEYS.length).toBe(207);
    expect(SK_PARAM_NAMES.length).toBe(207);
    expect(new Set(D.params.map((p) => p.key)).size).toBe(207);
    D.params.forEach((p, i) => {
      expect(p.index, p.key).toBe(i);
      expect([p.min, p.max], p.key).toEqual([0, 256]);
      expect(p.key).toBe(SK_PARAM_KEYS[i]);
      expect(p.name).toBe(SK_PARAM_NAMES[i]);
      expect(typeof p.format, p.key).toBe('function');
    });
    expect(D.params[0]).toMatchObject({ key: 'masterLevel', name: 'Master level', index: 0 });
    expect(D.params.slice(0, 6).map((p) => p.name)).toEqual(['Master level', 'Tune', 'Amp attack', 'Amp decay', 'Amp sustain', 'Amp release']);
    const names: Record<number, string> = {
      7: 'String 1 decay inverted', 12: 'String 2 decay inverted', 19: 'Comp ratio', 21: 'Comb feedback inverted', 23: 'Comb level Inverted',
      24: 'Lo-Cut cutoff', 33: 'Hi-Cut drive', 38: 'LFO rate', 39: 'Resonator frequency 1', 55: 'Resonator on 1', 62: 'Resonator on 8',
      63: 'Delay', 70: 'Chorus', 71: 'Chorus rate', 74: 'Reverb', 77: 'Reverb color', 78: 'MIDI CC #0 (Bank select MSB)',
      88: 'MIDI CC #10 (Pan)', 116: 'MIDI CC #38 (Data entry LSB )', 205: 'MIDI CC #127 (Poly mode on)', 206: 'Channel Aftertouch',
    };
    for (const [i, n] of Object.entries(names)) expect(D.params[Number(i)].name, `parameter ${i}`).toBe(n);
    expect(D.params[78].key).toBe('cc0');
    expect(D.params[205].key).toBe('cc127');
    expect(D.params[206].key).toBe('chanAT');
  });

  it("lists the switches' choices and the typed-value conversions", () => {
    for (const i of SWITCHES) expect(D.params[i].options, D.params[i].name).toEqual(['Off', 'On']);
    for (const i of INVERTS) expect(D.params[i].options, D.params[i].name).toEqual(['+', '-']);
    expect([...SK_SWITCHES].sort((a, b) => a - b)).toEqual(SWITCHES);
    expect([...SK_INVERTS].sort((a, b) => a - b)).toEqual(INVERTS);
    expect(D.params[0].options).toBeUndefined();
    expect(D.params[1].bipolar).toBe(true);
    expect(D.params[0].bipolar).toBeUndefined();
    // typed display units -> raw
    expect(D.params[0].parse!(50)).toBe(128);
    expect(D.params[0].parse!(100)).toBe(256);
    expect(D.params[71].parse!(3)).toBeCloseTo(148.48, 6); // "3Hz" is raw 123..174
    expect(D.params[78].parse!(77)).toBe(77);
    expect(D.params[63].parse).toBeUndefined();
    expect(D.params[7].parse).toBeUndefined();
    expect(D.params[79].parse).toBeUndefined();
    expect(skParse(206)).toBeUndefined();
  });

  it('defaults are the insertion state (CC and aftertouch parameters 0), the extra state its hidden settings', () => {
    const bowed = preset('Default/Bowed 6');
    for (let i = 0; i < SK_PARAM_COUNT; i++) expect(D.params[i].def, D.params[i].name).toBe(bowed[D.params[i].key]);
    for (let i = SK_PARAM_COUNT; i < 207; i++) expect(D.params[i].def, D.params[i].name).toBe(0);
    expect(D.params[0].def).toBe(92.47999572753906);
    expect(D.params[0].format!(D.params[0].def)).toBe('35.9%');
    expect(D.params[63].def).toBe(0);
    expect(D.params[70].def).toBe(256);
    expect(D.state!()).toEqual({ hidden: bowed.hidden });
    expect(D.viewState).toEqual([]);
    const def = defaultGenParams('sakura');
    expect(Object.keys(def).length).toBe(207 + 1);
    expect(def.hidden).toEqual(bowed.hidden);
    // the state is a copy
    (D.state!().hidden as number[])[1] = 99;
    expect((D.state!().hidden as number[])[1]).toBe(6);
  });
});

describe("Sakura: FL's value texts (test-host sweeps)", () => {
  it('percent parameters: all 257 values of every one of the 62 percent parameters', () => {
    expect(PERCENT.length).toBe(257);
    expect(PERCENT_PARAMS.length).toBe(62);
    for (const i of PERCENT_PARAMS) expect(texts(i), D.params[i].name).toEqual(PERCENT);
    expect(D.params[0].format!(0)).toBe('0.0%');
    expect(D.params[0].format!(16)).toBe('6.3%'); // 6.25: half away from zero
    expect(D.params[0].format!(128)).toBe('50.0%');
    expect(D.params[0].format!(256)).toBe('100.0%');
  });

  it('Off / On switches (Resonator on 1..8, Delay, Chorus, Reverb) and "+" / "-" switches (inverted decay, comb)', () => {
    for (const i of SWITCHES) expect(texts(i), D.params[i].name).toEqual(ONOFF);
    for (const i of INVERTS) expect(texts(i), D.params[i].name).toEqual(SIGN);
  });

  it('chorus rate: the Hz text of round(0.1 + 5 v) (the engine rate), at all 257 values', () => {
    expect(texts(71)).toEqual(HZ);
    expect(D.params[71].format!(128)).toBe('3Hz');
    expect(D.params[71].format!(20)).toBe('0Hz');
    expect(D.params[71].format!(21)).toBe('1Hz');
    expect(D.params[71].format!(256)).toBe('5Hz');
  });

  it('MIDI CC 0 shows the raw integer; every other CC and the aftertouch parameter shows "0" (what FL returns)', () => {
    expect(texts(78)).toEqual(Array.from({ length: 257 }, (_, v) => String(v)));
    for (const i of [79, 85, 100, 127, 205, 206]) expect(texts(i), D.params[i].name).toEqual(runs([[0, '0']]));
    expect(D.params[78].format!(200)).toBe('200');
  });

  it('matches other sampled sweep points (FL: parameter, raw -> text)', () => {
    const fl: [number, number, string][] = [
      [15, 163, '63.7%'], [64, 52, '20.3%'], [28, 215, '84.0%'], [73, 251, '98.0%'], [75, 225, '87.9%'], [30, 1, '0.4%'],
      [10, 56, '21.9%'], [36, 50, '19.5%'], [57, 5, 'On'], [62, 160, 'On'], [26, 203, '79.3%'], [32, 178, '69.5%'],
      [7, 0, '+'], [7, 1, '-'], [12, 256, '-'], [21, 3, '-'], [23, 0, '+'], [63, 0, 'Off'], [74, 77, 'On'], [71, 200, '4Hz'],
      [78, 0, '0'], [100, 77, '0'],
    ];
    for (const [i, raw, text] of fl) expect(D.params[i].format!(raw), `parameter ${i} at ${raw}`).toBe(text);
  });

  it("shows a loaded preset's fractional values like FL (the integer part of the value; switches on for any non-zero value)", () => {
    // flfxhost info Sakura --preset "Default/Bowed 6": value 92 "35.9%", 93 "36.3%", 5 "2.0%", 45 "1Hz", 213 "83.2%"
    const b = preset('Default/Bowed 6');
    const fl: [string, string][] = [
      ['masterLevel', '35.9%'], ['ampAttack', '36.3%'], ['ampRelease', '37.1%'], ['string1DampAmount', '2.0%'], ['string2DampOffset', '17.2%'],
      ['combFeedback', '34.0%'], ['loCutCutoff', '37.5%'], ['hiCutCutoff', '70.3%'], ['lfoRate', '79.7%'], ['chorusRate', '1Hz'],
      ['chorusDepth', '34.8%'], ['chorusWet', '22.7%'], ['reverbMix', '59.4%'], ['reverbColor', '83.2%'], ['combLevelInverted', '-'],
      ['resonatorOn1', 'On'], ['resonatorOn5', 'Off'], ['delay', 'Off'], ['chorus', 'On'], ['reverb', 'On'],
    ];
    for (const [key, text] of fl) {
      const p = D.params.find((q) => q.key === key)!;
      expect(p.format!(b[key] as number), `Bowed 6 ${key}`).toBe(text);
    }
    // a switch holding a tiny value is on in the engine (value != 0) and FL shows "On"
    const c = preset('Eastern Dreams Bank/KEY Clavi-Mighty DS');
    expect(c.chorus).toBe(0.1266188621520996);
    expect(D.params[70].format!(c.chorus as number)).toBe('On');
    expect(D.params[71].format!(c.chorusRate as number)).toBe('2Hz');
    expect(D.params[72].format!(c.chorusDepth as number)).toBe('50.8%');
    expect(D.params[73].format!(c.chorusWet as number)).toBe('38.7%');
    // non-finite input never leaks into a text
    expect(skFormat(0, NaN)).toBe('0.0%');
    expect(skFormat(78, Infinity)).toBe('0');
  });
});

describe('Sakura: factory presets', () => {
  it("lists FL's 501 presets in 11 folders, root files first then folders and files case-insensitively", () => {
    expect(D.presets!.length).toBe(501);
    expect(SK_PRESET_NAMES.length).toBe(501);
    expect(D.presets!.map((p) => p.name)).toEqual(SK_PRESET_NAMES);
    expect(SK_PRESET_NAMES[0]).toBe('Atmosphere/ATM ChainSaw Symphony FG');
    expect(SK_PRESET_NAMES[500]).toBe('Xenos Soundworks Vol1/ST Synth Pizzicato');
    expect(new Set(SK_PRESET_NAMES).size).toBe(501);
    const folders = new Map<string, number>();
    for (const n of SK_PRESET_NAMES) folders.set(n.split('/')[0], (folders.get(n.split('/')[0]) ?? 0) + 1);
    expect([...folders]).toEqual([
      ['Atmosphere', 9], ['Bass', 14], ['Default', 106], ['Eastern Dreams Bank', 139], ['Keyboard', 12], ['Pads', 5], ['Prc', 4],
      ['Sfx', 4], ['Sonic Haiku Bank', 160], ['String', 16], ['Xenos Soundworks Vol1', 32],
    ]);
    expect(SK_PRESET_NAMES.filter((n) => n.startsWith('Default/')).slice(0, 3)).toEqual(['Default/Alaska', 'Default/Alladdin', 'Default/Amped E-Guitar']);
  });

  it('decodes presets exactly as FL stores them (float32 engine values * 256, spot checks of the .fst chunks)', () => {
    const bowed = preset('Default/Bowed 6');
    expect(bowed.__preset).toBe('Default/Bowed 6');
    expect(bowed).toMatchObject({
      masterLevel: 92.47999572753906, tune: 128, ampAttack: 93.44000244140625, ampRelease: 95.35999298095703,
      string1DampAmount: 5.7599945068359375, loCutCutoff: 96.00001525878906, hiCutDecay: 49.27997589111328, hiCutCutoff: 180.80001831054688,
      lfoRate: 204.8000030517578, resonatorFrequency1: 121.60000610351562, resonatorOn1: 256, delay: 0, delayTime: 128,
      chorus: 256, chorusRate: 45.12000274658203, reverb: 256, reverbColor: 213.1199951171875,
    });
    expect(bowed.hidden).toEqual([0, 6, 1, 0, 1, 4, 1, 0, 3, 2, 0.10874998569488525, 0, 1, 2, 0.052500009536743164, 0, 3, 1, 0.8749999403953552, 1, 3,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0.5]);
    const first = preset('Atmosphere/ATM ChainSaw Symphony FG');
    expect(first).toMatchObject({ masterLevel: 99.20005798339844, ampAttack: 174.72000122070312, string1DampAmount: 27.20001220703125, delay: 256, delayTime: 145.28001403808594, chorus: 0, chorusRate: 0, resonatorFrequency1: 0, reverbColor: 41.600013732910156 });
    expect(first.hidden).toEqual([0, 6, 0.53125, 0, 1, 1, 0.1899999976158142, 0, 3, 1, 0.5887500047683716, 0, 14, 2, 0.18374991416931152, 0, 3, 2,
      0.10499998927116394, 1, 13, 2, 0.3924998939037323, 0, 14, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0.38750001788139343]);
    const last = preset('Xenos Soundworks Vol1/ST Synth Pizzicato');
    expect(last).toMatchObject({ masterLevel: 133.44000244140625, tune: 204.47998046875, ampRelease: 156.16000366210938, string1DampAmount: 240.00001525878906, loCutCutoff: 103.67999267578125, hiCutCutoff: 82.24000549316406, delay: 256, reverb: 256 });
    expect(last.hidden).toEqual([0, 6, 1, 0, 1, 4, 1, 0, 3, 7, 0.5512500405311584, 1, 11, 7, 0.7124999761581421, 0, 5, 7, 0.45249998569488525, 1, 1,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0.5]);
    // "Default": the engine's own hidden defaults
    const dflt = preset('Default/Default');
    expect(dflt.hidden).toEqual(SK_HIDDEN_DEFAULT);
    expect(dflt.masterLevel).toBe(90.24003601074219);
    expect(dflt.hiCutDecay).toBe(51.20000076293945);
    expect(SK_HIDDEN_DEFAULT).toEqual([0, 6, 1, 0, 1, 4, 1, 0, 3, ...new Array(24).fill(0), 3, 0, 0.5]);
  });

  it("decodes all 501 presets to the exact float32 values of FL's .fst chunks (SHA-256 of the 501 x 114 engine values)", () => {
    // pinned from the chunks of every .fst file (.flref/ilsynths/saw/fstchunk.py), 114 little-endian float32 per preset
    const h = createHash('sha256');
    for (let i = 0; i < SK_PRESET_NAMES.length; i++) h.update(Buffer.from(skStateValues(skPresetState(i)).values.buffer));
    expect(h.digest('hex')).toBe('7d245955e0b7f1737ca7a8c063a3c7f5e8c0f4319befd42bb8f1d850bb1db283');
  });

  it('shows the texts FL shows for every parameter of every loaded preset (39078 texts from flfxhost info --preset)', () => {
    const texts: string[] = [];
    for (let i = 0; i < SK_PRESET_NAMES.length; i++) {
      const st = skPresetState(i);
      for (let k = 0; k < SK_PARAM_COUNT; k++) texts.push(D.params[k].format!(st[SK_PARAM_KEYS[k]] as number));
    }
    expect(texts.length).toBe(501 * 78);
    expect(createHash('sha256').update(texts.join('\n')).digest('hex')).toBe('456a38f9fcce8ef46141cd63ac27e03f951bda31b0bb2d28e583bd0062b4e532');
  });

  it('every preset loads finite and in range, with valid hidden settings and no CC / aftertouch values', () => {
    const def = normalizeGenParams('sakura', defaultGenParams('sakura'));
    let fractionalSwitches = 0;
    for (const pr of D.presets!) {
      const st = genPresetState('sakura', pr, def);
      expect(st.__preset).toBe(pr.name);
      for (const q of D.params) {
        const x = st[q.key];
        expect(typeof x === 'number' && Number.isFinite(x) && x >= q.min && x <= q.max, `${pr.name}: ${q.key} = ${String(x)}`).toBe(true);
        if (q.index! >= SK_PARAM_COUNT) expect(x, `${pr.name}: ${q.key}`).toBe(0);
      }
      const h = st.hidden as number[];
      expect(h.length).toBe(SK_HIDDEN_COUNT);
      expect(skNormHidden(h), `${pr.name}: hidden settings need no repair`).toEqual(h);
      expect(h[0]).toBe(0);
      for (let s = 0; s < 8; s++) {
        expect(Number.isInteger(h[skSlotIndex(s, 0)]) && Number.isInteger(h[skSlotIndex(s, 2)]) && Number.isInteger(h[skSlotIndex(s, 3)]), pr.name).toBe(true);
      }
      expect(Number.isInteger(h[SK_H_S2_RATIO]) && Number.isInteger(h[SK_H_DELAY_SYNC]), pr.name).toBe(true);
      expect(JSON.parse(JSON.stringify(st))).toEqual(st);
      if ([...SK_SWITCHES, ...SK_INVERTS].some((i) => st[SK_PARAM_KEYS[i]] !== 0 && st[SK_PARAM_KEYS[i]] !== 256)) fractionalSwitches++;
    }
    // the 106 presets of the Eastern Dreams and Sonic Haiku banks that hold free floats on switch parameters
    expect(fractionalSwitches).toBe(106);
  });

  it('keeps the transpose octave and the modulation matrix in the ranges the editor offers', () => {
    const oct = new Map<number, number>();
    for (let i = 0; i < SK_PRESET_NAMES.length; i++) {
      const h = skPresetState(i).hidden as number[];
      const o = skOctaves(h[SK_H_TRANSPOSE]);
      oct.set(o, (oct.get(o) ?? 0) + 1);
      for (let s = 0; s < 8; s++) {
        expect(SK_MOD_SOURCES[h[skSlotIndex(s, 0)]], SK_PRESET_NAMES[i]).toBeDefined();
        expect(SK_MOD_DESTS[h[skSlotIndex(s, 3)]], SK_PRESET_NAMES[i]).toBeDefined();
      }
      expect(SK_S2_RATIOS[h[SK_H_S2_RATIO]]).toBeDefined();
      expect(SK_DELAY_SYNC[h[SK_H_DELAY_SYNC]]).toBeDefined();
    }
    expect([...oct].sort((a, b) => a[0] - b[0])).toEqual([[-3, 4], [-2, 54], [-1, 173], [0, 186], [1, 61], [2, 19], [3, 4]]);
  });

  it('the insertion state is the values of "Default/Bowed 6" (FL\'s plugin database entry)', () => {
    expect(SK_PRESET_NAMES[SK_INSERT_PRESET]).toBe('Default/Bowed 6');
    expect(SK_INSERT_PRESET).toBe(43);
    const ins = skInsertState();
    const bowed = skPresetState(SK_INSERT_PRESET);
    expect(ins).toEqual(bowed);
    for (let i = 0; i < SK_PARAM_COUNT; i++) expect(D.params[i].def).toBe(ins[SK_PARAM_KEYS[i]]);
    expect(D.state!().hidden).toEqual(ins.hidden);
    expect(skPresetState(7)).toEqual(skPresetState(7)); // decoding does not share state between calls
    expect(skPresetState(7).hidden).not.toBe(skPresetState(7).hidden);
  });
});

describe("Sakura: FL's state chunk ('1rkS': 114 float32 and a 128-byte name)", () => {
  const H = [0, 8, 0.25, 1, 14, 3, 0.5, 0, 2, ...new Array(24).fill(0), 6, 9, 0.25];
  function makeChunk(magic: number[] = [0x31, 0x72, 0x6b, 0x53], at = (i: number): number => (i < SK_PARAM_COUNT ? i / 100 : H[i - SK_PARAM_COUNT]), name = 'Test Program'): Uint8Array {
    const b = new Uint8Array(588);
    b.set(magic);
    const dv = new DataView(b.buffer);
    for (let i = 0; i < SK_ENGINE_COUNT; i++) dv.setFloat32(4 + 4 * i, at(i), true);
    for (let k = 0; k < name.length; k++) b[460 + k] = name.charCodeAt(k);
    return b;
  }

  it('turns a chunk into model state (parameters * 256 unrounded, hidden settings as they are)', () => {
    const st = skChunkToState(makeChunk())!;
    expect(st.masterLevel).toBe(0);
    expect(st.tune).toBe(Math.fround(0.01) * 256);
    expect(st.reverbColor).toBe(Math.fround(0.77) * 256);
    expect(Object.keys(st).length).toBe(SK_PARAM_COUNT + 1);
    expect(st.hidden).toEqual(H);
    expect(skChunkName(makeChunk())).toBe('Test Program');
    // the trial version's magic "DrkS" has the same layout
    expect(skChunkToState(makeChunk([0x44, 0x72, 0x6b, 0x53]))).toEqual(st);
  });

  it('round-trips FL presets: float32 values -> state -> engine values', () => {
    const src = skPresetState(SK_INSERT_PRESET);
    const vals = skStateValues(src).values;
    const b = new Uint8Array(588);
    b.set([0x31, 0x72, 0x6b, 0x53]);
    const f = new Float32Array(b.buffer, 4, 114);
    for (let i = 0; i < 114; i++) f[i] = vals[i];
    expect(skChunkToState(b)).toEqual(src);
    expect(vals.length).toBe(114);
    expect(vals[0]).toBe(Math.fround(92.47999572753906 / 256));
    expect(vals[0]).toBeCloseTo(0.36125, 6);
    expect(vals[SK_PARAM_COUNT]).toBe(0);
    expect([...vals.slice(79, 83)]).toEqual([6, 1, 0, 1]);
    expect([...vals.slice(83, 87)]).toEqual([4, 1, 0, 3]);
    expect([...vals.slice(111, 114)]).toEqual([3, 0, 0.5]);
  });

  it('refuses anything that is not a chunk and repairs odd values', () => {
    expect(skChunkToState(new Uint8Array(0))).toBeNull();
    expect(skChunkToState(makeChunk([0x53, 0x72, 0x6b, 0x31]))).toBeNull();
    expect(skChunkToState(makeChunk([0x31, 0x72, 0x77, 0x53]))).toBeNull(); // Sawer's "1rwS"
    expect(skChunkToState(makeChunk().subarray(0, 459))).toBeNull();
    expect(skChunkToState(makeChunk().subarray(0, 460))).not.toBeNull(); // the name is optional
    expect(skChunkName(makeChunk().subarray(0, 460))).toBe('');
    // a view into a larger buffer
    const big = new Uint8Array(700);
    big.set(makeChunk(), 50);
    expect(skChunkToState(big.subarray(50, 638))).toEqual(skChunkToState(makeChunk()));
    // NaN / out-of-range values
    const odd = skChunkToState(makeChunk(undefined, (i) => (i === 0 ? NaN : i === 1 ? 5 : i === 2 ? -1 : i === 79 ? NaN : i === 82 ? 99 : i === 111 ? 7.4 : 0.5)))!;
    expect(odd.masterLevel).toBe(92.47999572753906); // NaN: the insertion default
    expect(odd.tune).toBe(256);
    expect(odd.ampAttack).toBe(0);
    const h = odd.hidden as number[];
    expect(h[1]).toBe(6); // NaN source: the engine default
    expect(h[4]).toBe(14);
    expect(h[SK_H_S2_RATIO]).toBe(6);
    expect(h.length).toBe(36);
  });

  it('turns state into the engine values: float32, clamped, missing values at their insertion defaults, hidden settings repaired', () => {
    const empty = skStateValues({}).values;
    const ins = skStateValues(skInsertState()).values;
    expect([...empty]).toEqual([...ins]);
    const hidden = [0, 99, 0.5, 1, 0, NaN, 'a', -1, 7.4] as unknown as number[];
    const { values } = skStateValues({ masterLevel: 128, tune: 1000, ampAttack: -3, ampDecay: 'x', ampSustain: 64, hidden });
    expect(values[0]).toBe(0.5);
    expect(values[1]).toBe(1);
    expect(values[2]).toBe(0);
    expect(values[3]).toBe(Math.fround(skInsertState().ampDecay as number / 256));
    expect(values[4]).toBe(0.25);
    expect(values[79]).toBe(8); // source clamped
    expect(values[80]).toBe(0.5);
    expect(values[82]).toBe(0); // destination
    expect(values[83]).toBe(4); // NaN: the engine's default (slot 2 source)
    expect(values[84]).toBe(1); // 'a': the engine's default (slot 2 amount)
    expect(values[85]).toBe(0); // -1 -> 0 (phase)
    expect(values[86]).toBe(7); // 7.4 -> 7 (destination index, rounded)
    expect([...values.slice(87, 111)]).toEqual(new Array(24).fill(0));
    expect(values.every(Number.isFinite)).toBe(true);
  });
});

describe('Sakura: state repair', () => {
  it('turns garbage into a valid state and keeps valid states as they are', () => {
    const ins = skInsertState();
    const n = normalizeGenParams('sakura', {
      masterLevel: 'loud', tune: NaN, ampAttack: 1e9, ampDecay: -4, cc7: null, chanAT: Infinity, delay: 3.5,
      hidden: [NaN, 99, 'x', 5, -1, 3.4, 0.5, 2, 77, 'q', 0.25],
    });
    expect(n.masterLevel).toBe(ins.masterLevel);
    expect(n.tune).toBe(ins.tune);
    expect(n.ampAttack).toBe(256);
    expect(n.ampDecay).toBe(0);
    expect(n.cc7).toBe(0);
    expect(n.chanAT).toBe(0);
    expect(n.delay).toBe(3.5);
    expect(n.hidden).toEqual([0, 8, 1, 1, 0, 3, 0.5, 1, 14, 0, 0.25, ...SK_HIDDEN_DEFAULT.slice(11)]);
    expect(normalizeGenParams('sakura', n)).toEqual(n);
    // a state without hidden settings gets the insertion state's
    const m = normalizeGenParams('sakura', { masterLevel: 10 });
    expect(m.masterLevel).toBe(10);
    expect(m.hidden).toEqual(ins.hidden);
    expect(normalizeGenParams('sakura', 5)).toEqual(defaultGenParams('sakura'));
    expect(normalizeGenParams('sakura', { hidden: 'abc' }).hidden).toEqual(ins.hidden);
    expect(normalizeGenParams('sakura', { hidden: [] }).hidden).toEqual(SK_HIDDEN_DEFAULT);
    // valid states survive a JSON round trip and a second normalisation
    for (const name of ['Default/Bowed 6', 'Eastern Dreams Bank/KEY Clavi-Mighty DS', 'Default/Default']) {
      const st = preset(name);
      expect(normalizeGenParams('sakura', JSON.parse(JSON.stringify(st)))).toEqual(st);
    }
  });

  it('resolves preset references ({ __sk: index }) and ignores invalid ones', () => {
    const p = D.presets![12];
    expect(p.params).toEqual({ __sk: 12 });
    const st = normalizeGenParams('sakura', { ...defaultGenParams('sakura'), __sk: 12 });
    expect('__sk' in st).toBe(false);
    const ref = skPresetState(12);
    for (const k of SK_PARAM_KEYS.slice(0, SK_PARAM_COUNT)) expect(st[k], k).toBe(ref[k]);
    expect(st.hidden).toEqual(ref.hidden);
    const def = defaultGenParams('sakura');
    for (const bad of [-1, 501, 1.5, NaN, '3', null, {}]) {
      const q = normalizeGenParams('sakura', { __sk: bad });
      expect('__sk' in q, String(bad)).toBe(false);
      expect(q, String(bad)).toEqual(def);
    }
    // and through the preset loader: defaults + preset, CC parameters untouched
    const loaded = genPresetState('sakura', D.presets![12], { ...def, cc7: 100 });
    expect(loaded.cc7).toBe(0);
    expect(loaded.masterLevel).toBe(ref.masterLevel);
  });
});

describe('Sakura: tables for the editor', () => {
  it("lists FL's modulation sources and destinations, string 2 ratios and delay sync steps", () => {
    expect(SK_MOD_SOURCES).toEqual(['...', 'envelope', 'lfo', 'mod whl', 'ptch whl', 'aftch', 'velocity', 'key num', 'release']);
    expect(SK_MOD_DESTS).toEqual([
      'lfo ampl', 'level', 'pan', 'pitch', 'lo-cut ctf', 'hi-cut ctf', 'hi-cut atk', 'hi-cut dec', 'str1 decay', 'str2 decay',
      'stri1&2 dec', 'str1 damp', 'str2  damp', 'str1&2 dmp', 'noise rate',
    ]);
    expect(SK_S2_RATIOS).toEqual(['4 : 1', '3 : 1', '2 : 1', '1 : 1', '1 : 2', '1 : 3', '1 : 4']);
    expect(SK_DELAY_SYNC).toEqual(['---', '1/16', '2/16', '3/16', '1/4', '2/4', '3/4', '4/4', '8/4', '16/4']);
  });

  it('lays the hidden settings out as engine values 78..113 (slots of source, amount, phase, destination)', () => {
    expect(SK_HIDDEN_COUNT).toBe(36);
    expect(SK_ENGINE_COUNT - SK_PARAM_COUNT).toBe(36);
    expect(SK_H_SLOT0).toBe(1);
    expect([skSlotIndex(0, 0), skSlotIndex(0, 3), skSlotIndex(1, 0), skSlotIndex(7, 3)]).toEqual([1, 4, 5, 32]);
    expect([SK_H_S2_RATIO, SK_H_DELAY_SYNC, SK_H_TRANSPOSE]).toEqual([33, 34, 35]);
    expect(SK_HIDDEN_DEFAULT.length).toBe(36);
  });

  it('transposes by trunc(v * 6) - 3 octaves', () => {
    expect([0, 0.16, 0.5, 0.6, 0.66, 0.84, 0.999, 1].map(skOctaves)).toEqual([-3, -3, 0, 0, 0, 2, 2, 3]);
    expect(skOctaves(0.39250001311302185)).toBe(-1);
    expect(skOctaves(-5)).toBe(-3);
    expect(skOctaves(5)).toBe(3);
  });
});

// ---- engine tests appended by the engine author ----
// Sakura renders silence in FL's test host (licence check, neither patched nor faked), so the DSP ported by
// static analysis cannot be compared with FL's output: these tests check the port's invariants (finite,
// deterministic output, silence without notes, pitch, voices ending after the release, the behaviour of the
// controls, the mapping from FL's parameters to the engine's values).

vi.setConfig({ testTimeout: 120_000 });

const SR = 44100;

function note(key: number, vel: number, id: number): GenNote {
  const init = newLevels(), levels = newLevels();
  init.pitch = key * 100; init.vol = (Math.pow(11, vel / 100) - 1) / 10;
  levels.pitch = key * 100; levels.vol = 1; levels.pan = 0;
  return { id, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/** Notes [key, velocity %, start s, length s] in 512-frame blocks split at note events, 130 BPM; the engine-wide noise restarts. */
function render(params: Record<string, unknown>, notes: [number, number, number, number][], seconds: number): { L: Float32Array; R: Float32Array; pl: SkPlugin } {
  skResetSeed();
  const pl = new SkPlugin(SR, 512);
  pl.setParams(params);
  const n = Math.round(seconds * SR);
  const evs: { t: number; on: boolean; n: GenNote }[] = [];
  notes.forEach(([k, v, st, d], i) => {
    const nn = note(k, v, i + 1);
    evs.push({ t: Math.round(st * SR), on: true, n: nn }, { t: Math.round((st + d) * SR), on: false, n: nn });
  });
  evs.sort((a, b) => a.t - b.t || (a.on === b.on ? 0 : a.on ? 1 : -1));
  const L = new Float32Array(n), R = new Float32Array(n);
  const bl = new Float32Array(512), br = new Float32Array(512);
  let t = 0, e = 0;
  while (t < n) {
    while (e < evs.length && evs[e].t <= t) { const ev = evs[e++]; if (ev.on) pl.noteOn(ev.n, 0); else pl.noteOff(ev.n, 0); }
    let m = Math.min(512, n - t);
    if (e < evs.length && evs[e].t < t + m) m = evs[e].t - t;
    const ctx = { sampleRate: SR, blockSize: 512, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0 };
    bl.fill(0); br.fill(0);
    pl.render(bl, br, m, ctx);
    L.set(bl.subarray(0, m), t); R.set(br.subarray(0, m), t);
    t += m;
  }
  return { L, R, pl };
}

const rms = (x: Float32Array, a = 0, b = x.length): number => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const finite = (x: Float32Array): boolean => x.every((v) => Number.isFinite(v));
const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const diff = (a: Float32Array, b: Float32Array): number => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d; };
/** Fundamental by autocorrelation (30 Hz .. 4 kHz). */
function f0(x: Float32Array, a: number, b: number): number {
  let best = 0, bl = 1;
  const lo = Math.floor(SR / 4000), hi = Math.floor(SR / 30);
  for (let lag = lo; lag < hi; lag++) {
    let s = 0;
    for (let i = a; i < b - lag; i++) s += x[i] * x[i + lag];
    if (s > best) { best = s; bl = lag; }
  }
  return SR / bl;
}
const DEFAULT = (): Record<string, unknown> => preset('Default/Default');
const withHidden = (st: Record<string, unknown>, f: (h: number[]) => void): Record<string, unknown> => {
  const h = (st.hidden as number[]).slice();
  f(h);
  return { ...st, hidden: h };
};

describe('Sakura: engine', () => {
  it('is silent without notes (every effect on)', () => {
    const { L, R, pl } = render(preset('Default/Bowed 6'), [], 0.5);
    // (the reverb keeps FL's 1e-30 anti-denormal offsets circulating: ~1e-21)
    expect(peak(L)).toBeLessThan(1e-15);
    expect(peak(R)).toBeLessThan(1e-15);
    expect(pl.synth.count).toBe(0);
  });

  it('plays the pitch of the key (equal temperament, A = 440 Hz at MIDI note 69)', () => {
    for (const key of [36, 48, 60, 72, 84]) {
      const { L } = render(DEFAULT(), [[key, 100, 0, 0.9]], 1);
      const want = 440 * Math.pow(2, (key - 69) / 12);
      expect(Math.abs(f0(L, 3000, 30000) / want - 1), `key ${key}`).toBeLessThan(0.012);
    }
  });

  it('is deterministic and finite', () => {
    const a = render(preset('Default/Bowed 6'), [[60, 100, 0, 0.4], [67, 80, 0.1, 0.4]], 0.9);
    const b = render(preset('Default/Bowed 6'), [[60, 100, 0, 0.4], [67, 80, 0.1, 0.4]], 0.9);
    expect(finite(a.L) && finite(a.R)).toBe(true);
    expect(peak(a.L)).toBeGreaterThan(0.001);
    expect(diff(a.L, b.L)).toBe(0);
    expect(diff(a.R, b.R)).toBe(0);
  });

  it('keeps sounding a lossless string and ends after the release', () => {
    const { L, pl } = render(DEFAULT(), [[60, 100, 0, 0.6]], 1.6);
    expect(rms(L, 5000, 25000)).toBeGreaterThan(0.02);
    expect(Math.abs(rms(L, 5000, 15000) / rms(L, 15000, 25000) - 1)).toBeLessThan(0.1);
    expect(rms(L, 60000, 70000)).toBeLessThan(1e-6);
    expect(pl.synth.count).toBe(0);
  });

  it('decays faster with a lower string decay and with damping', () => {
    const base = DEFAULT();
    const late = (st: Record<string, unknown>): number => rms(render(st, [[60, 100, 0, 1.4]], 1.5).L, 38000, 55000);
    const open = late(base);
    expect(late({ ...base, string1Decay: 150 })).toBeLessThan(open * 0.5);
    expect(late({ ...base, string1DampAmount: 200 })).toBeLessThan(open * 0.5);
  });

  it("the exciter slider balances click (256) and noise (0): a noise exciter keeps feeding a decaying string", () => {
    // (the Hi-Cut envelope gates the exciter: sustain open)
    const base = { ...DEFAULT(), string1Decay: 140, hiCutSustain: 256, hiCutCutoff: 200 };
    const click = render({ ...base, exciterNoiseLevel: 256 }, [[60, 100, 0, 1.4]], 1.5).L;
    const noise = render({ ...base, exciterNoiseLevel: 0 }, [[60, 100, 0, 1.4]], 1.5).L;
    expect(rms(noise, 30000, 55000)).toBeGreaterThan(rms(click, 30000, 55000) * 1.5);
  });

  it('shapes the onset with the amp attack and the level with the master level', () => {
    const fast = render(DEFAULT(), [[60, 100, 0, 0.6]], 0.7).L;
    const slow = render({ ...DEFAULT(), ampAttack: 200 }, [[60, 100, 0, 0.6]], 0.7).L;
    expect(rms(slow, 0, 3000)).toBeLessThan(rms(fast, 0, 3000) * 0.5);
    const loud = render({ ...DEFAULT(), masterLevel: 200 }, [[60, 100, 0, 0.3]], 0.4).L;
    const quiet = render({ ...DEFAULT(), masterLevel: 100 }, [[60, 100, 0, 0.3]], 0.4).L;
    expect(rms(loud, 3000, 15000)).toBeGreaterThan(rms(quiet, 3000, 15000) * 5);
  });

  it('transposes by octaves (hidden value 113) and follows the string 2 ratio', () => {
    const up = render(withHidden(DEFAULT(), (h) => { h[35] = 4.5 / 6; }), [[60, 100, 0, 0.8]], 1).L;
    const down = render(withHidden(DEFAULT(), (h) => { h[35] = 2.5 / 6; }), [[60, 100, 0, 0.8]], 1).L;
    expect(Math.abs(f0(up, 3000, 30000) / (2 * 261.6256) - 1)).toBeLessThan(0.012);
    expect(Math.abs(f0(down, 3000, 30000) / (0.5 * 261.6256) - 1)).toBeLessThan(0.012);
    // string 2 alone (mix 256), ratio 4 : 1 plays two octaves above, 1 : 2 an octave below
    const s2 = (ratio: number): number => f0(render(withHidden({ ...DEFAULT(), stringMix: 256 }, (h) => { h[33] = ratio; }), [[60, 100, 0, 0.8]], 1).L, 3000, 30000);
    expect(Math.abs(s2(3) / 261.6256 - 1)).toBeLessThan(0.012);
    expect(Math.abs(s2(0) / (4 * 261.6256) - 1)).toBeLessThan(0.02);
    expect(Math.abs(s2(4) / (0.5 * 261.6256) - 1)).toBeLessThan(0.012);
  });

  it('modulation matrix: velocity to level (slot 1) scales the note, an empty slot does not', () => {
    const quiet = rms(render(DEFAULT(), [[60, 30, 0, 0.5]], 0.6).L, 4000, 20000);
    const loud = rms(render(DEFAULT(), [[60, 100, 0, 0.5]], 0.6).L, 4000, 20000);
    expect(loud).toBeGreaterThan(quiet * 3);
    const flat = (v: number): number => rms(render(withHidden(DEFAULT(), (h) => { h[2] = 0; }), [[60, v, 0, 0.5]], 0.6).L, 4000, 20000);
    // no source on the level: FL's matrix leaves the level at its own default of 1 and only the key's velocity curve (InitVol) remains
    expect(Math.abs(flat(30) / flat(100))).toBeGreaterThan(0.05);
    expect(Math.abs(flat(30) / flat(100))).toBeLessThan(quiet / loud * 20);
  });

  it('plays chords on separate keys and steals the oldest when the polyphony is limited', () => {
    const { pl } = render(DEFAULT(), [[60, 100, 0, 5], [64, 100, 0, 5], [67, 100, 0, 5]], 0.3);
    expect(pl.synth.count).toBe(3);
    const lim = new SkPlugin(SR, 512);
    lim.setParams(DEFAULT());
    lim.setMaxPoly(2);
    const ctx = { sampleRate: SR, blockSize: 512, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0 };
    const bl = new Float32Array(256), br = new Float32Array(256);
    for (let i = 0; i < 3; i++) { lim.noteOn(note(60 + 4 * i, 100, i + 1), 0); lim.render(bl, br, 256, ctx); }
    expect(lim.synth.count).toBe(2);
    expect(lim.synth.keys.filter((k) => k.active).map((k) => k.key).sort()).toEqual([64, 68]);
  });

  it('the effects change the sound and ring out: resonators, chorus, reverb, delay', () => {
    const dry = { ...DEFAULT(), resonatorOn1: 0, resonatorOn2: 0, delay: 0, chorus: 0, reverb: 0 };
    const ref = render(dry, [[60, 100, 0, 0.3]], 1.5);
    for (const [k, v] of [['resonatorOn1', 256], ['chorus', 256], ['reverb', 256], ['delay', 256]] as const) {
      const wet = render({ ...dry, [k]: v, resonatorFeedback1: 200, delayWet: 200, delayFeedback: 100, chorusWet: 200, reverbMix: 200 }, [[60, 100, 0, 0.3]], 1.5);
      expect(finite(wet.L) && finite(wet.R), k).toBe(true);
      expect(diff(wet.L, ref.L), k).toBeGreaterThan(1);
    }
    // the reverb adds a tail after the note ended, the dry string does not
    const rev = render({ ...dry, reverb: 256, reverbMix: 256, reverbDecay: 200 }, [[60, 100, 0, 0.3]], 2);
    expect(rms(rev.L, 40000, 60000)).toBeGreaterThan(rms(ref.L, 40000, 60000) * 100 + 1e-5);
  });

  it('sources of the matrix: mod wheel (CC 1) and channel aftertouch reach the engine through the CC parameters', () => {
    const slot = (src: number, dest: number, amt: number): Record<string, unknown> => withHidden(DEFAULT(), (h) => { h[1 + 4 * 2] = src; h[2 + 4 * 2] = amt; h[3 + 4 * 2] = 0; h[4 + 4 * 2] = dest; });
    // destination "level": the source scales the level (default 1 when nothing is routed there, a source adds to it)
    const a = render({ ...slot(3, 1, 1), cc1: 0 }, [[60, 100, 0, 0.5]], 0.6).L;
    const b = render({ ...slot(3, 1, 1), cc1: 256 }, [[60, 100, 0, 0.5]], 0.6).L;
    expect(diff(a, b)).toBeGreaterThan(1);
    const c = render({ ...slot(5, 1, 1), chanAT: 0 }, [[60, 100, 0, 0.5]], 0.6).L;
    const d = render({ ...slot(5, 1, 1), chanAT: 256 }, [[60, 100, 0, 0.5]], 0.6).L;
    expect(diff(c, d)).toBeGreaterThan(1);
  });

  it('is finite for random extreme settings, extreme keys and velocities', () => {
    let seed = 987654;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let it = 0; it < 12; it++) {
      const st: Record<string, unknown> = { ...genPresetState('sakura', D.presets![Math.floor(rnd() * D.presets!.length)]) };
      for (let i = 0; i < SK_PARAM_COUNT; i++) {
        const r = rnd();
        if (r < 0.3) st[SK_PARAM_KEYS[i]] = r < 0.15 ? 0 : 256;
        else if (r < 0.6) st[SK_PARAM_KEYS[i]] = Math.floor(rnd() * 257);
      }
      const h = (st.hidden as number[]).slice();
      for (let sl = 0; sl < 8; sl++) { h[1 + 4 * sl] = Math.floor(rnd() * 9); h[2 + 4 * sl] = rnd(); h[3 + 4 * sl] = rnd() < 0.5 ? 0 : 1; h[4 + 4 * sl] = Math.floor(rnd() * 15); }
      h[33] = Math.floor(rnd() * 7); h[34] = Math.floor(rnd() * 10); h[35] = rnd();
      st.hidden = h;
      const key = [0, 12, 60, 100, 127][Math.floor(rnd() * 5)];
      const vel = [1, 50, 100, 128][Math.floor(rnd() * 4)];
      const { L, R } = render(st, [[key, vel, 0, 0.3], [Math.min(127, key + 7), vel, 0.05, 0.25]], 0.6);
      expect(finite(L) && finite(R), `case ${it}`).toBe(true);
    }
  });

  it('plays a sample of the factory presets with finite, audible output', () => {
    for (let i = 0; i < D.presets!.length; i += 37) {
      const { L, R } = render(genPresetState('sakura', D.presets![i]), [[60, 100, 0, 0.4]], 0.8);
      expect(finite(L) && finite(R), D.presets![i].name).toBe(true);
      expect(peak(L) + peak(R), D.presets![i].name).toBeGreaterThan(1e-4);
    }
  });

  it("maps FL's parameters to the engine's values (setParameter laws)", () => {
    const S = new SkSynth();
    S.setSampleRate(SR);
    const set = (i: number, v: number): void => S.setParameter(i, v);
    set(0, 0.5);
    expect(S.masterGain).toBeCloseTo(Math.pow(10, 0.6), 5);
    set(1, 0.5);
    expect(S.tune).toBe(0);
    set(1, 1);
    expect(S.tune).toBe(Math.fround(0.99));
    set(2, 1);
    expect(S.ampA).toBeCloseTo(35.001, 4);
    set(3, 1);
    expect(S.ampD).toBeCloseTo(50.001, 4);
    set(4, 0.5);
    expect(S.ampS).toBe(0.25);
    set(5, 1);
    expect(S.ampR).toBeCloseTo(10.1, 4);
    set(7, 1);
    expect(S.s1Inv).toBe(true);
    set(7, 0);
    expect(S.s1Inv).toBe(false);
    set(10, 0.5);
    expect(S.s1DampSharp).toBe(0.25);
    set(20, 0.25);
    expect(S.combFb).toBe(0.5);
    set(31, 1);
    expect(S.noiseMix).toBe(0);
    set(33, 1);
    expect(S.drive).toBe(1000);
    set(34, 1);
    expect(S.egA).toBeCloseTo(10.001, 4);
    set(37, 1);
    expect(S.egR).toBeCloseTo(50.1, 4);
    set(38, 1);
    expect(S.lfoRate).toBeCloseTo(10.01, 4);
    set(111, 4.9);
    expect(S.s2Ratio).toBe(4);
    set(113, 0.75);
    expect(S.transpose).toBe(0.75);
    for (let i = 0; i < 114; i++) { set(i, 0.3); expect(S.getParameter(i)).toBe(Math.fround(0.3)); }
  });

  it("loads FL's state values in order and resets to the engine's defaults", () => {
    const S = new SkSynth();
    S.setSampleRate(SR);
    S.resetToDefaults();
    for (let i = 0; i < 114; i++) expect(S.getParameter(i), `default ${i}`).toBe(Math.fround(SK_DEFAULTS[i]));
    const { values } = skStateValues(skInsertState());
    S.loadState(values);
    for (let i = 0; i < 114; i++) expect(S.getParameter(i), `state ${i}`).toBe(values[i]);
  });

  it('voice levels reach the engine per key (pan law and volume of the FL voice)', () => {
    const pl = new SkPlugin(SR, 512);
    pl.setParams(DEFAULT());
    const n = note(60, 100, 1);
    n.levels.vol = 0.5; n.levels.pan = 1;
    pl.noteOn(n, 0);
    const bl = new Float32Array(128), br = new Float32Array(128);
    pl.render(bl, br, 128, { sampleRate: SR, blockSize: 512, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0 });
    expect(pl.synth.noteL[60]).toBeCloseTo(0, 6);
    expect(pl.synth.noteR[60]).toBeCloseTo(0.5, 6);
  });
});
