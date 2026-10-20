// Kepler Exo (FL: Kepler Exo) model: registration (FL's 155 parameters = the engine's parameter ids, ranges,
// insertion state), FL's value texts (pinned samples + FNV hashes of FL's complete text tables from the test host:
// every raw value of every parameter, 2.5 million texts), the engine floats FL sends (chorus mode, DCO2 semitones),
// the modulation matrix and Options-menu state, FL's 188 presets (decoded with FL's own loader) and state
// normalisation. Engine tests are the engine's own.
import { describe, it, expect } from 'vitest';
import { genDef, genPresetState, defaultGenParams, normalizeGenParams, formatParam } from '../../src/model/gen/registry';
import {
  KEPLEREXO_MAX, KEPLEREXO_MIN, KEPLEREXO_MOD_SOURCES, KEPLEREXO_OPTION_DEFAULT, KEPLEREXO_OPTION_KEYS, KEPLEREXO_OPTIONS_MENU,
  KEPLEREXO_PARAM_KEYS, KEPLEREXO_PRESET_DATA,
  KEPLEREXO_PRESET_NAMES, keplerExoEngineValue, keplerExoEngineVector, keplerExoModDestName, keplerExoModDestValid, keplerExoNormalizeMatrix,
  keplerExoPresetState,
} from '../../src/model/gen/plugins/keplerexo/data';
import { KEPLEREXO_SYNC_TEXT_HASH, KEPLEREXO_TEXT_HASH } from './kepler-golden';

const D = genDef('keplerexo')!;
const f = (i: number, v: number, st: Record<string, unknown> = {}) => formatParam(D.params[i], v, st);
const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** FNV-1a (32 bit) over the lines "<value>\t<text>\n" of a parameter's whole range. */
function tableHash(i: number, st: Record<string, unknown>): number {
  let h = 0x811c9dc5;
  for (let v = KEPLEREXO_MIN[i]; v <= KEPLEREXO_MAX[i]; v++) {
    const s = `${v}\t${formatParam(D.params[i], v, st)}\n`;
    for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

describe('Kepler Exo: registration', () => {
  it("is FL's Kepler Exo: 155 parameters in FL's order (= the engine's ids), form 1080 x 574", () => {
    expect(D.name).toBe('Kepler Exo');
    expect(D.category).toBe('Synth classic');
    expect(D.notes).toBe('events');
    expect(D.velocity).toBe('plugin');
    expect(D.levels).toBe('plugin');
    expect(D.defPoly).toBe(0);
    expect([D.width, D.height]).toEqual([1080, 574]);
    expect(D.params.length).toBe(155);
    expect(D.params.map((p) => p.index)).toEqual(Array.from({ length: 155 }, (_, i) => i));
    expect(new Set(D.params.map((p) => p.key)).size).toBe(155);
    expect(D.params.map((p) => p.key)).toEqual(KEPLEREXO_PARAM_KEYS);
    expect(D.params[0]).toMatchObject({ key: 'lfo1Dco1', name: 'LFO1->DCO1 Amount', min: 0, max: 6000 });
    expect(D.params[3].name).toBe('LFO2->Osc1 Range');
    expect(D.params[13]).toMatchObject({ name: 'DCO2 Semitones', min: -48, max: 48, bipolar: true });
    expect(D.params[28]).toMatchObject({ name: 'DCO1->DCO2 CrossMod', min: 0, max: 245760 });
    expect(D.params[29]).toMatchObject({ name: 'DCO2->DCO1 CrossMod', min: 1, max: 245760 });
    expect(D.params[36]).toMatchObject({ name: 'HP Freq', min: 1000, max: 170000 });
    expect(D.params[37]).toMatchObject({ name: 'Cutoff', min: 1000, max: 170000 });
    expect(D.params[48]).toMatchObject({ name: 'LFO1 Rate', min: 1, max: 245760 });
    expect(D.params[61]).toMatchObject({ name: 'Env1 Attack', min: 0, max: 10000 });
    expect(D.params[72]).toMatchObject({ name: 'Main Volume', min: 0, max: 65536 });
    expect(D.params[92].bipolar).toBe(true);
    expect(D.params[107]).toMatchObject({ name: 'EQ Lo Freq', min: 0, max: 21000 });
    expect(D.params[122]).toMatchObject({ name: 'Reverb Low Cut', min: 190, max: 30000 });
    expect(D.params[123]).toMatchObject({ name: 'Reverb High Cut', min: 5000, max: 221000 });
    expect(D.params[154]).toMatchObject({ key: 'hpOn', name: 'Highpass Active', min: 0, max: 1 });
  });

  it("has FL's insertion state (plugin database entry = Default preset) as the defaults", () => {
    const d = defaultGenParams('keplerexo');
    expect(d).toMatchObject({
      dco1Saw: 1, dco1SubLevel: 6000, dco1SubPhase: 3000, dco2Detune: 1980, dco2Saw: 1, dco2SubLevel: 6000, dco1Level: 245760,
      dco2Level: 245760, hpFreq: 1000, cutoff: 170000, slope: 3, lfo1Rate: 131941, lfo2Rate: 122881, env1Decay: 5000,
      env1Sustain: 3000, env2Decay: 5000, env2Sustain: 3000, chorusNoiseGate: 1, volume: 41357, velocityVolume: 49177, pan: 32768,
      portaMode: 0, octave: 1, arpRate: 122880, arpSync: 1, arpGate: 6000, delayOn: 0, delayTime: 3643, reverbLowCut: 6191,
      reverbHighCut: 174884, hcMix: 3014, xOffset: 32768, yOffset: 32768, vcaSmooth: 0, satHq: 0, masterTune: 32768, hpOn: 1,
      modAmount1: 3000, modAmount8: 0,
    });
    for (const p of D.params) { expect(p.def).toBeGreaterThanOrEqual(p.min); expect(p.def).toBeLessThanOrEqual(p.max); }
    expect(D.params.map((p) => d[p.key])).toEqual(KEPLEREXO_PRESET_DATA[0].slice(0, 155));
    expect(d).toMatchObject({ ...KEPLEREXO_OPTION_DEFAULT, modPage: 0, theme: 0, modMatrix: { src: new Array(8).fill(-1), dst: new Array(8).fill(-1) } });
  });

  it('lists the matrix sources and destinations', () => {
    expect(KEPLEREXO_MOD_SOURCES.length).toBe(24);
    expect(KEPLEREXO_MOD_SOURCES[0]).toBe('LFO1 Bipolar Triangle');
    expect(KEPLEREXO_MOD_SOURCES[2]).toBe('Env1');
    expect(KEPLEREXO_MOD_SOURCES[23]).toBe('ModY Unipolar');
    expect(keplerExoModDestName(37)).toBe('Cutoff');
    expect(keplerExoModDestName(256)).toBe('DCO1 Pitch');
    expect(keplerExoModDestName(257)).toBe('DCO2 Pitch');
    expect(keplerExoModDestName(200)).toBe('');
    expect([-1, 0, 154, 256, 257].every(keplerExoModDestValid)).toBe(true);
    expect([-2, 155, 200, 258, 1000].some(keplerExoModDestValid)).toBe(false);
  });
});

describe("Kepler Exo: FL's value texts", () => {
  it('prints switches and selectors as FL does (including the quirks)', () => {
    expect([0, 1].map((v) => f(1, v))).toEqual(['Off', 'On']);
    expect([0, 1].map((v) => f(7, v))).toEqual(['0.0%', '100.0%']); // "DCO1 Pulse Active" prints a percentage
    expect([0, 1].map((v) => f(26, v))).toEqual(['0.0%', '100.0%']);
    expect([0, 1].map((v) => f(91, v))).toEqual(['0.0%', '100.0%']);
    expect([0, 1, 2].map((v) => f(6, v))).toEqual(['LFO1', 'Man', 'Env1']);
    expect([0, 1, 2, 3, 4, 5].map((v) => f(30, v))).toEqual(['Sine', 'Triangle', 'Pulse', 'Saw', 'Noise', 'DCO1']);
    expect(f(31, 5)).toBe('DCO2');
    expect(f(42, 5)).toBe('DCO1 out');
    expect([0, 1, 2, 3].map((v) => f(40, v))).toEqual(['6 dB/Oct', '12 dB/Oct', '18 dB/Oct', '24 dB/Oct']);
    expect([0, 1, 2].map((v) => f(47, v))).toEqual(['Env1', 'Gate', 'Env2']);
    expect([0, 1, 2, 3, 4, 5].map((v) => f(58, v))).toEqual(['Triangle', 'Ramp Up', 'Ramp Down', 'Sine', 'Random', 'Random+Glide']);
    expect([0, 1, 2, 3].map((v) => f(69, v))).toEqual(['Off', 'Chorus 1', 'Chorus 2', 'Chorus 1+2']);
    expect([0, 1].map((v) => f(79, v))).toEqual(['Exp', 'Linear']);
    expect([0, 1, 2].map((v) => f(83, v))).toEqual(['-1', '0', '+1']);
    expect(f(89, 0)).toBe('Up');
    expect(f(89, 8)).toBe('As played down');
    expect([0, 1, 2, 3].map((v) => f(117, v))).toEqual(['LP', 'HP', 'BP', 'Off']);
    expect([0, 1].map((v) => f(136, v))).toEqual(['Pre', 'Post']);
    expect([0, 1].map((v) => f(144, v))).toEqual(['4', '8']);
    expect(D.params[134].options).toEqual(['Off', 'On']);
  });

  it('prints percentages, times, frequencies, dB and the rest (pinned test-host values)', () => {
    expect(f(13, -48)).toBe('-48');
    expect(f(13, 24)).toBe('24');
    expect(f(14, 0)).toBe('-100.0%');
    expect(f(14, 3000)).toBe('0.0%');
    expect(f(14, 2999)).toBe('0.0%'); // never "-0.0%"
    expect(f(92, 6000)).toBe('100.0%');
    expect(f(36, 1000)).toBe('10.00 Hz');
    expect(f(36, 85500)).toBe('50.00 Hz');
    expect(f(36, 170000)).toBe('170.00 Hz');
    expect(f(37, 1000)).toBe('4.00 Hz');
    expect(f(37, 85500)).toBe('124.00 Hz');
    expect(f(37, 127750)).toBe('2758.84 Hz');
    expect(f(37, 170000)).toBe('49999.99 Hz');
    expect(f(48, 1)).toBe('0.13 Hz');
    expect(f(48, 122881)).toBe('3.41 Hz');
    expect(f(48, 245760)).toBe('21.74 Hz');
    expect(f(54, 1)).toBe('0.10 Hz');
    expect(f(54, 122881)).toBe('10.00 Hz');
    expect(f(54, 245760)).toBe('1000.00 Hz');
    expect(f(50, 5000)).toBe('500.0 ms');
    expect(f(72, 0)).toBe('-Inf dB');
    expect(f(72, 41357)).toBe('-4.00 dB');
    expect(f(72, 65536)).toBe('0.00 dB');
    expect(f(86, 0)).toBe('0.00 Hz');
    expect(f(86, 245760)).toBe('10.00 Hz');
    expect([0, 3000, 6000].map((v) => f(101, v))).toEqual(['0.28', '0.81', '3.64']);
    expect([0, 3000].map((v) => f(104, v))).toEqual(['-16.00 dB', '0.00 dB']);
    expect([0, 10500, 21000].map((v) => f(107, v))).toEqual(['20 Hz', '648 Hz', '21000 Hz']);
    expect([0, 3643, 6000].map((v) => f(113, v))).toEqual(['10.0 ms', '307.5 ms', '500.0 ms']);
    expect([190, 191, 7642, 30000].map((v) => f(122, v))).toEqual(['Off', '19.1 Hz', '764.2 Hz', '3000.0 Hz']);
    expect([5000, 5001, 221000].map((v) => f(123, v))).toEqual(['Off', '500.1 Hz', '22100.0 Hz']);
    expect(f(124, 1500)).toBe('31.3 ms');
    expect([0, 6000].map((v) => f(145, v))).toEqual(['714.0 Hz', '22000.0 Hz']);
    expect(f(146, 3000)).toBe('114.4 Hz');
    expect([3014, 6000].map((v) => f(147, v))).toEqual(['50% Dry / 50% Wet', '0% Dry / 100% Wet']);
    expect([0, 32768, 65536].map((v) => f(153, v))).toEqual(['-12.00', '0.00', '12.00']);
  });

  it('follows the tempo sync switches (LFO rates, arpeggiator rate, delay time)', () => {
    expect(f(48, 1, { lfo1Sync: 1 })).toBe('128:0');
    expect(f(48, 122881, { lfo1Sync: 1 })).toBe('10:19');
    expect(f(54, 245760, { lfo2Sync: 1 })).toBe('0:1');
    expect([0, 122880, 245760].map((v) => f(86, v, { arpSync: 1 }))).toEqual(['1/4', '1/16', '1/64']);
    expect([0, 3000, 6000].map((v) => f(113, v, { delaySync: 1 }))).toEqual(['1/64', '1/6', '1/1']);
    expect(f(48, 1, { lfo2Sync: 1 })).toBe('0.13 Hz'); // the other LFO's switch does not count
  });

  it("matches FL's complete text tables (every raw value of every parameter, hashed)", () => {
    const bad: string[] = [];
    for (let i = 0; i < 155; i++) if (tableHash(i, {}) !== KEPLEREXO_TEXT_HASH[i]) bad.push(`${i} ${D.params[i].name}`);
    for (const [i, key, h] of KEPLEREXO_SYNC_TEXT_HASH) if (tableHash(i, { [key]: 1 }) !== h) bad.push(`${i} with ${key}`);
    expect(bad).toEqual([]);
 }, 120_000);

  it('parses typed values for the linear texts', () => {
    expect(D.params[0].parse!(50)).toBe(3000);
    expect(D.params[92].parse!(-100)).toBe(0);
    expect(D.params[61].parse!(500)).toBe(5000);
    expect(D.params[124].parse!(62.5)).toBe(3000);
    expect(D.params[104].parse!(0)).toBe(3000);
    expect(D.params[13].parse!(7)).toBe(7);
    expect(D.params[37].parse).toBeUndefined();
    expect(D.params[89].parse).toBeUndefined();
  });
});

describe('Kepler Exo: engine floats', () => {
  it("sends (v - min) * (1 / (max - min)) as FL's wrapper does", () => {
    expect(keplerExoEngineValue(37, 170000)).toBe(1);
    expect(keplerExoEngineValue(37, 1000)).toBe(0);
    expect(keplerExoEngineValue(62, 5000)).toBe(0.5);
    expect(keplerExoEngineValue(54, 122881)).toBe(Math.fround(122880 / 245759));
    expect(keplerExoEngineValue(72, 41357)).toBe(Math.fround(41357 / 65536));
    expect(keplerExoEngineValue(107, 4990)).toBe(Math.fround(4990 / 21000));
    expect(keplerExoEngineValue(122, 6191)).toBe(Math.fround((6191 - 190) / 29810));
  });

  it('sends the chorus mode as 0 / 0.33 / 0.66 / 1 and DCO2 semitones with a 0.1 offset away from zero', () => {
    expect([0, 1, 2, 3].map((v) => keplerExoEngineValue(69, v))).toEqual([0, Math.fround(0.33), Math.fround(0.66), 1]);
    expect(keplerExoEngineValue(13, 0)).toBe(0.5);
    expect(keplerExoEngineValue(13, 24)).toBe(0.7510416507720947);
    expect(keplerExoEngineValue(13, -16)).toBe(0.3322916626930237);
    expect(keplerExoEngineValue(13, -47)).toBe(0.00937500037252903);
    expect(keplerExoEngineValue(13, 47)).toBe(0.9906250238418579);
    expect(keplerExoEngineValue(13, 48)).toBe(1);
    expect(keplerExoEngineValue(13, -48)).toBe(0);
  });
});

describe('Kepler Exo: Options menu', () => {
  it("lists FL's Options menu in FL's order with every switch once", () => {
    const keys = KEPLEREXO_OPTIONS_MENU.filter((m) => m !== '-').map((m) => (m as { key: string }).key);
    expect([...keys].sort()).toEqual([...KEPLEREXO_OPTION_KEYS].sort());
    expect(KEPLEREXO_OPTIONS_MENU[0]).toEqual({ key: 'arpQuantize', label: 'Arp 1st Step Quantize' });
    expect(KEPLEREXO_OPTIONS_MENU.map((m) => (m === '-' ? '-' : m.label))).toEqual(['Arp 1st Step Quantize', '-', 'HQ mode', 'Enhanced Oscillators', '-']);
  });
});

describe('Kepler Exo: engine parameter vector', () => {
  it('is the 155 parameters through the wrapper conversion, at the engine ids', () => {
    const def = defaultGenParams('keplerexo');
    const v = keplerExoEngineVector(def);
    expect(v.length).toBe(155);
    expect(v[37]).toBe(1);
    expect(v[13]).toBe(0.5);
    expect(v[72]).toBe(Math.fround(41357 / 65536));
    expect(v[154]).toBe(1);
    const w = keplerExoEngineVector({ ...def, dco2Semi: 24, chorusMode: 1 });
    expect([w[13], w[69]]).toEqual([0.7510416507720947, Math.fround(0.33)]);
    expect(Array.from(keplerExoEngineVector({}))).toEqual(Array.from(v));
  });
});

describe("Kepler Exo: FL's 188 factory presets", () => {
  const P = D.presets!;

  it('lists them in the menu order, "Default" first', () => {
    expect(P.length).toBe(188);
    expect(KEPLEREXO_PRESET_NAMES.length).toBe(188);
    expect(KEPLEREXO_PRESET_DATA.length).toBe(188);
    expect(P[0].name).toBe('Default');
    expect(P[1].name).toBe('X Dan/C64 Arp');
    expect(P[P.length - 1].name).toBe("X Sako/Synth/Seq/No Man's Land");
    expect(new Set(P.map((p) => p.name)).size).toBe(188);
    const folders = new Map<string, number>();
    for (const p of P.slice(1)) { const fo = p.name.slice(0, p.name.lastIndexOf('/')); folders.set(fo, (folders.get(fo) ?? 0) + 1); }
    expect(folders.size).toBe(23);
    expect(folders.get('X Dan')).toBe(16);
    expect(folders.get('X Saif Sameer/Keys')).toBe(14);
    expect(folders.get('X Sako/FX')).toBe(33);
    expect(folders.get('X Sako/Instrument/Brass and Winds')).toBe(10);
    for (const row of KEPLEREXO_PRESET_DATA) expect(row.length).toBe(171);
  });

  it('keeps every engine float FL loads bit for bit (control positions through the wrapper conversion)', () => {
    for (let n = 0; n < P.length; n++) {
      const row = KEPLEREXO_PRESET_DATA[n];
      for (let k = 0; k < 155; k++) {
        expect(Number.isInteger(row[k]), `${KEPLEREXO_PRESET_NAMES[n]} ${KEPLEREXO_PARAM_KEYS[k]}`).toBe(true);
        expect(row[k]).toBeGreaterThanOrEqual(KEPLEREXO_MIN[k]);
        expect(row[k]).toBeLessThanOrEqual(KEPLEREXO_MAX[k]);
      }
      for (let k = 0; k < 8; k++) {
        expect(row[155 + k]).toBeGreaterThanOrEqual(-1);
        expect(row[155 + k]).toBeLessThan(24);
        expect(keplerExoModDestValid(row[163 + k])).toBe(true);
      }
    }
  });

  it("loads FL's values and matrix (test host: X Sako/Synth/Seq/No Man's Land)", () => {
    const i = KEPLEREXO_PRESET_NAMES.indexOf("X Sako/Synth/Seq/No Man's Land");
    const st = genPresetState('keplerexo', P[i]);
    expect(st).toMatchObject({
      lfo1Dco1Range: 1, dco2Semi: -21, dco2Detune: 2974, dco1Level: 196096, dco2Level: 167424, noiseLevel: 0, cutoff: 57032,
      lfo1Rate: 203066, lfo1Sync: 1, lfo2Rate: 207294, lfo2Sync: 1, volume: 35328, velocityVolume: 49177, arp: 0, arpMode: 2,
      arpRate: 102400, arpSync: 1, eqOn: 1, delayOn: 1, delayTime: 4543, reverbOn: 1, hcOn: 1, hcLowPass: 1160, hcHighPass: 3547,
      hcMix: 4176, hpOn: 1,
    });
    expect(st.modMatrix).toEqual({ src: [15, 12, 12, 12, 18, 14, -1, -1], dst: [106, 37, 93, 24, 74, 98, -1, -1] });
    // texts FL shows for the loaded values (test host)
    expect(f(14, 2974)).toBe('-0.9%');
    expect(f(32, 196096)).toBe('79.8%');
    expect(f(37, 57032)).toBe('26.94 Hz');
    expect(f(48, 203066, st)).toBe('1:17');
    expect(f(54, 207294, st)).toBe('1:8');
    expect(f(72, 35328)).toBe('-5.37 dB');
    expect(f(86, 102400, st)).toBe('1/8 Triplet');
    expect(f(113, 4543)).toBe('381.0 ms');
    expect(f(145, 1160)).toBe('1385.2 Hz');
    expect(f(147, 4176)).toBe('30% Dry / 70% Wet');
    expect(st).toMatchObject({ arpQuantize: false, hq: false, enhancedOscillators: false });
  });

  it("stores DCO2 semitones as the control position (FL's engine float is the position + 0.1 away from zero)", () => {
    const i = KEPLEREXO_PRESET_NAMES.indexOf('X Dan/DistLead');
    expect(KEPLEREXO_PRESET_DATA[i][13]).toBe(24);
    expect(keplerExoEngineValue(13, KEPLEREXO_PRESET_DATA[i][13])).toBe(0.7510416507720947);
    const j = KEPLEREXO_PRESET_NAMES.indexOf('X Dan/Planet Exo');
    expect(KEPLEREXO_PRESET_DATA[j][13]).toBe(-28);
    expect(keplerExoEngineValue(13, -28)).toBe(0.20729166269302368);
  });

  it('keeps the Options switches and view settings when a preset loads', () => {
    const base = { ...defaultGenParams('keplerexo'), hq: true, enhancedOscillators: true, arpQuantize: true, modPage: 1, theme: 2 };
    const st = genPresetState('keplerexo', P[5], base);
    expect(st).toMatchObject({ hq: true, enhancedOscillators: true, arpQuantize: true, modPage: 1, theme: 2 });
    expect(st.__preset).toBe(P[5].name);
    expect(st.modMatrix).toEqual(keplerExoPresetState(5).modMatrix);
    for (let n = 0; n < P.length; n += 5) {
      const s = genPresetState('keplerexo', P[n]);
      expect(normalizeGenParams('keplerexo', json(s))).toEqual(s);
    }
  });
});

describe('Kepler Exo: state', () => {
  it('normalises stored states idempotently and repairs the matrix', () => {
    const def = normalizeGenParams('keplerexo', defaultGenParams('keplerexo'));
    expect(normalizeGenParams('keplerexo', json(def))).toEqual(def);
    expect(normalizeGenParams('keplerexo', {})).toEqual(def);
    const odd = normalizeGenParams('keplerexo', {
      hq: 1, enhancedOscillators: 'x', modPage: 7, theme: -3,
      modMatrix: { src: [3, 24, -2, 30.4, 'a', 23], dst: [37, 155, 256, 257, 258, 154.2, 0] },
    });
    expect(odd).toMatchObject({ hq: true, enhancedOscillators: false, arpQuantize: false, modPage: 0, theme: 0 });
    expect(odd.modMatrix).toEqual({ src: [3, -1, -1, -1, -1, 23, -1, -1], dst: [37, -1, 256, 257, -1, 154, 0, -1] });
    expect(keplerExoNormalizeMatrix(null)).toEqual({ src: new Array(8).fill(-1), dst: new Array(8).fill(-1) });
    expect(normalizeGenParams('keplerexo', json(odd))).toEqual(odd);
    expect(normalizeGenParams('keplerexo', { __keplerexo: 3 })).toMatchObject(keplerExoPresetState(3));
    expect('__keplerexo' in normalizeGenParams('keplerexo', { __keplerexo: 3 })).toBe(false);
  });
});
