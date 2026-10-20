// Kepler (FL: Kepler) model: registration (FL's 36 parameters, ranges, indices, engine ids, insertion state), FL's
// value texts (pinned samples + FNV hashes of FL's complete text tables from the test host: every raw value of every
// parameter, 2.3 million texts), the engine floats FL sends, the Options-menu state, FL's 277 presets (decoded with
// FL's own loader) and state normalisation. Engine tests are the engine's own.
import { describe, it, expect } from 'vitest';
import { genDef, genPresetState, defaultGenParams, normalizeGenParams, formatParam } from '../../src/model/gen/registry';
import {
  KEPLER_ENGINE_DEFAULTS, KEPLER_ENGINE_ID, KEPLER_MAX, KEPLER_MIN, KEPLER_OPTION_DEFAULT, KEPLER_OPTION_KEYS, KEPLER_OPTIONS_MENU, KEPLER_PARAM_KEYS,
  KEPLER_PRESET_DATA, KEPLER_PRESET_NAMES, keplerEngineValue, keplerEngineVector, keplerOptionEngineValues, keplerPresetState,
} from '../../src/model/gen/plugins/kepler/data';
import { fpcFix, powD } from '../../src/model/gen/plugins/kepler/texts';
import { KEPLER_SYNC_TEXT_HASH, KEPLER_TEXT_HASH } from './kepler-golden';

const D = genDef('kepler')!;
const f = (i: number, v: number, st: Record<string, unknown> = {}) => formatParam(D.params[i], v, st);
const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** FNV-1a (32 bit) over the lines "<value>\t<text>\n" of a parameter's whole range. */
function tableHash(i: number, st: Record<string, unknown>): number {
  let h = 0x811c9dc5;
  for (let v = KEPLER_MIN[i]; v <= KEPLER_MAX[i]; v++) {
    const s = `${v}\t${formatParam(D.params[i], v, st)}\n`;
    for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

describe('Kepler: registration', () => {
  it("is FL's Kepler: 36 parameters in FL's order, form 1080 x 217", () => {
    expect(D.name).toBe('Kepler');
    expect(D.category).toBe('Synth classic');
    expect(D.notes).toBe('events');
    expect(D.velocity).toBe('plugin');
    expect(D.levels).toBe('plugin');
    expect(D.defPoly).toBe(0);
    expect([D.width, D.height]).toEqual([1080, 217]);
    expect(D.params.length).toBe(36);
    expect(D.params.map((p) => p.index)).toEqual(Array.from({ length: 36 }, (_, i) => i));
    expect(new Set(D.params.map((p) => p.key)).size).toBe(36);
    expect(D.params.map((p) => p.key)).toEqual(KEPLER_PARAM_KEYS);
    expect(D.params[0]).toMatchObject({ key: 'arp', name: 'Arpeggio', min: 0, max: 1 });
    expect(D.params[3]).toMatchObject({ name: 'Arpeggio rate', min: 0, max: 245760 });
    expect(D.params[5]).toMatchObject({ name: 'LFO rate', min: 1, max: 245760 });
    expect(D.params[19]).toMatchObject({ name: 'VCF Frequency', min: 0, max: 6000 });
    expect(D.params[30]).toMatchObject({ name: 'Mode', min: 0, max: 3 });
    expect(D.params[33]).toMatchObject({ name: 'Volume', min: 0, max: 65536 });
    expect(D.params[35]).toMatchObject({ name: 'LFO phase', min: 1, max: 245760 });
  });

  it("maps FL's parameters onto the engine's parameter ids (Kepler Exo's indices)", () => {
    expect(KEPLER_ENGINE_ID.length).toBe(36);
    expect(new Set(KEPLER_ENGINE_ID).size).toBe(36);
    expect(KEPLER_ENGINE_ID.slice(0, 6)).toEqual([85, 89, 88, 86, 87, 48]);
    expect(KEPLER_ENGINE_ID[19]).toBe(37); // VCF Frequency = Exo "Cutoff"
    expect(KEPLER_ENGINE_ID[33]).toBe(72); // Volume = Exo "Main Volume"
    expect(KEPLER_ENGINE_DEFAULTS.length).toBe(155);
    expect(KEPLER_ENGINE_DEFAULTS[154]).toBe(1); // highpass active
    expect(KEPLER_ENGINE_DEFAULTS[12]).toBe(0); // DCO2 off
  });

  it("has FL's insertion state (plugin database entry = Default preset) as the defaults", () => {
    const d = defaultGenParams('kepler');
    expect(d).toMatchObject({
      arp: 0, arpMode: 0, arpRate: 0, lfoRate: 1, dcoSaw: 1, dcoSubLevel: 0, vcfFreq: 6000, vcfReso: 0, envAttack: 0,
      envDecay: 3000, envSustain: 3000, envRelease: 0, chorusMode: 0, octave: 1, volume: 32768, lfoRetrig: 0, lfoPhase: 1,
    });
    expect(D.params.map((p) => d[p.key])).toEqual(KEPLER_PRESET_DATA[0].slice(0, 36));
    for (const p of D.params) { expect(p.def).toBeGreaterThanOrEqual(p.min); expect(p.def).toBeLessThanOrEqual(p.max); }
    expect(d).toMatchObject(KEPLER_OPTION_DEFAULT);
    expect(KEPLER_OPTION_DEFAULT).toEqual({
      arpQuantize: false, velocityToVolume: true, alignSubPhase: false, chorusNoiseGate: false, chorusNoise: false, hq: false,
    });
  });
});

describe("Kepler: FL's number printing", () => {
  it('rounds the double to 15 digits, then half away from zero (never "-0")', () => {
    expect(fpcFix(0.15, 1)).toBe('0.2'); // the double is 0.1499999999999999944
    expect(fpcFix(0.35, 1)).toBe('0.4');
    expect(fpcFix(2.675, 2)).toBe('2.68');
    expect(fpcFix(0.5, 0)).toBe('1');
    expect(fpcFix(2.5, 0)).toBe('3');
    expect(fpcFix(-2.5, 0)).toBe('-3');
    expect(fpcFix(-0.04, 1)).toBe('0.0');
    expect(fpcFix(-0.06, 1)).toBe('-0.1');
    expect(fpcFix(999.995, 2)).toBe('1000.00');
    expect(fpcFix(49999.99, 2)).toBe('49999.99');
    expect(fpcFix(1e-9, 2)).toBe('0.00');
    expect(fpcFix(0, 2)).toBe('0.00');
    expect(fpcFix(123456789.125, 2)).toBe('123456789.13');
    expect(fpcFix(Infinity, 2)).toBe('Inf');
  });

  it("follows Free Pascal's Power: integer exponents by squaring, otherwise exp(e ln b)", () => {
    expect(powD(2, 15.609640121459961)).toBeCloseTo(49999.99, 1); // the f32 log2 node of "50000 Hz"
    expect(powD(2, 2)).toBe(4);
    expect(powD(10, 4)).toBe(10000);
    expect(powD(5, 0)).toBe(1);
    expect(powD(0, 3)).toBe(0);
  });
});

describe("Kepler: FL's value texts", () => {
  it('prints switches and selectors as FL does (including the quirks)', () => {
    expect([0, 1].map((v) => f(0, v))).toEqual(['Off', 'On']);
    expect([0, 1, 2].map((v) => f(1, v))).toEqual(['UP', 'UP/DOWN', 'UP']); // FL shows "UP" for the third position
    expect(D.params[1].options).toEqual(['UP', 'UP/DOWN', 'DOWN']);
    expect([0, 1, 2].map((v) => f(2, v))).toEqual(['1', '2', '3']);
    expect([0, 1].map((v) => f(8, v))).toEqual(['AUTO', 'MAN']);
    expect([0, 1, 2].map((v) => f(12, v))).toEqual(['LFO', 'MAN', 'ENV']);
    expect([0, 1].map((v) => f(21, v))).toEqual(['POS', 'NEG']);
    expect([0, 1].map((v) => f(25, v))).toEqual(['ENV', 'GATE']);
    expect([0, 1, 2, 3].map((v) => f(30, v))).toEqual(['Off', 'Chorus 1', 'Chorus 2', 'Chorus 1 + 2']);
    expect([0, 1, 2].map((v) => f(32, v))).toEqual(['-1', '0', '+1']);
  });

  it('prints percentages, times, frequencies and the volume (pinned test-host values)', () => {
    expect(f(10, 9)).toBe('0.2%'); // 0.15 -> 0.2
    expect(f(10, 3512)).toBe('58.5%');
    expect(f(16, 6000)).toBe('100.0%');
    expect(f(28, 1980)).toBe('33.0%');
    expect(f(35, 1)).toBe('0.0%');
    expect(f(35, 122880)).toBe('50.0%');
    expect(f(7, 1)).toBe('0.2 ms');
    expect(f(7, 3000)).toBe('500.0 ms');
    expect(f(26, 2999)).toBe('499.8 ms');
    expect(f(18, 0)).toBe('10.00 Hz');
    expect(f(18, 3000)).toBe('50.00 Hz');
    expect(f(18, 6000)).toBe('170.00 Hz');
    expect(f(19, 0)).toBe('4.00 Hz');
    expect(f(19, 1200)).toBe('10.00 Hz');
    expect(f(19, 3000)).toBe('124.00 Hz');
    expect(f(19, 5100)).toBe('14025.41 Hz');
    expect(f(19, 5400)).toBe('36699.99 Hz');
    expect(f(19, 6000)).toBe('49999.99 Hz');
    expect(f(33, 0)).toBe('-Inf dB');
    expect(f(33, 1)).toBe('-96.33 dB');
    expect(f(33, 21463)).toBe('-9.70 dB');
    expect(f(33, 32768)).toBe('-6.02 dB');
    expect(f(33, 65536)).toBe('0.00 dB');
  });

  it('follows the tempo sync switches (arpeggio rate, LFO rate)', () => {
    expect(f(3, 122880)).toBe('2.50 Hz');
    expect(f(3, 245760)).toBe('10.00 Hz');
    expect(f(3, 0, { arpSync: 1 })).toBe('1/4');
    expect(f(3, 122880, { arpSync: 1 })).toBe('1/16');
    expect(f(3, 245760, { arpSync: 1 })).toBe('1/64');
    expect(f(5, 1)).toBe('0.00 Hz');
    expect(f(5, 122881)).toBe('2.50 Hz');
    expect(f(5, 1, { lfoSync: 1 })).toBe('128:0');
    expect(f(5, 2, { lfoSync: 1 })).toBe('127:47');
    expect(f(5, 122880, { lfoSync: 1 })).toBe('10:19');
    expect(f(5, 245760, { lfoSync: 1 })).toBe('0:1');
  });

  it('uses the control position FL rounds a fractional value to', () => {
    expect(f(10, 9.4)).toBe(f(10, 9));
    expect(f(10, 8.6)).toBe(f(10, 9));
    expect(f(30, 0.99)).toBe('Chorus 1');
    expect(f(10, 7000)).toBe('100.0%');
  });

  it("matches FL's complete text tables (every raw value of every parameter, hashed)", () => {
    const bad: string[] = [];
    for (let i = 0; i < 36; i++) if (tableHash(i, {}) !== KEPLER_TEXT_HASH[i]) bad.push(`${i} ${D.params[i].name}`);
    for (const [i, key, h] of KEPLER_SYNC_TEXT_HASH) if (tableHash(i, { [key]: 1 }) !== h) bad.push(`${i} with ${key}`);
    expect(bad).toEqual([]);
 }, 120_000);

  it('parses typed values for the linear texts', () => {
    expect(D.params[10].parse!(50)).toBe(3000);
    expect(D.params[7].parse!(500)).toBe(3000);
    expect(D.params[33].parse!(-6.0206)).toBeCloseTo(32768, 0);
    expect(D.params[19].parse).toBeUndefined();
    expect(D.params[0].parse).toBeUndefined();
  });
});

describe('Kepler: engine floats', () => {
  it("sends (v - min) * (1 / (max - min)) as FL's wrapper does, the chorus mode as 0 / 0.33 / 0.66 / 1", () => {
    expect(keplerEngineValue(19, 6000)).toBe(1);
    expect(keplerEngineValue(27, 4500)).toBe(0.75);
    expect(keplerEngineValue(28, 2000)).toBe(Math.fround(2000 / 6000));
    expect(keplerEngineValue(5, 1)).toBe(0);
    expect(keplerEngineValue(5, 122881)).toBe(Math.fround(122880 / 245759));
    expect(keplerEngineValue(32, 1)).toBe(0.5);
    expect(keplerEngineValue(33, 21463)).toBe(Math.fround(21463 / 65536));
    expect([0, 1, 2, 3].map((v) => keplerEngineValue(30, v))).toEqual([0, Math.fround(0.33), Math.fround(0.66), 1]);
    expect(keplerEngineValue(10, 9999)).toBe(1);
    expect(keplerEngineValue(10, -5)).toBe(0);
  });

  it("lists FL's Options menu in FL's order with every switch once", () => {
    const keys = KEPLER_OPTIONS_MENU.filter((m) => m !== '-').map((m) => (m as { key: string }).key);
    expect([...keys].sort()).toEqual([...KEPLER_OPTION_KEYS].sort());
    expect(KEPLER_OPTIONS_MENU[0]).toEqual({ key: 'arpQuantize', label: 'Quantize first arpeggiator step' });
    expect(KEPLER_OPTIONS_MENU.filter((m) => m === '-').length).toBe(2);
    expect(KEPLER_OPTIONS_MENU[KEPLER_OPTIONS_MENU.length - 1]).toEqual({ key: 'hq', label: 'HQ mode' });
  });

  it('turns the Options switches into the engine values they stand for', () => {
    expect(keplerOptionEngineValues(KEPLER_OPTION_DEFAULT)).toEqual({
      velocityToVolume: 1, subOscPhase: 0.5, chorusNoise: 0, chorusNoiseGate: 0, oversampling: 2,
    });
    expect(keplerOptionEngineValues({ arpQuantize: true, velocityToVolume: false, alignSubPhase: true, chorusNoiseGate: true, chorusNoise: true, hq: true })).toEqual({
      velocityToVolume: 0, subOscPhase: 0, chorusNoise: 0.09, chorusNoiseGate: 1, oversampling: 4,
    });
  });
});

describe('Kepler: engine parameter vector', () => {
  it("is the insertion vector with the model's parameters and options applied at their engine ids", () => {
    const def = defaultGenParams('kepler');
    const v = keplerEngineVector(def);
    expect(v.length).toBe(155);
    expect(v[37]).toBe(1); // VCF Frequency 6000 -> engine id 37
    expect(v[72]).toBe(0.5); // Volume 32768 -> id 72
    expect(v[62]).toBe(0.5); // envelope decay
    expect(v[63]).toBe(0.5); // envelope sustain
    expect(v[10]).toBe(0); // DCO sub level 0 (id 10)
    expect(v[73]).toBe(1); // velocity to volume on
    expect(v[11]).toBe(0.5);
    expect(v[70]).toBe(0);
    expect(v[71]).toBe(0);
    expect(v[12]).toBe(0); // DCO2 off
    expect(v[154]).toBe(1); // highpass active
    const w = keplerEngineVector({ ...def, chorusMode: 2, alignSubPhase: true, chorusNoise: true, chorusNoiseGate: true, velocityToVolume: false });
    expect([w[69], w[11], w[70], w[71], w[73]]).toEqual([Math.fround(0.66), 0, Math.fround(0.09), 1, 0]);
    expect(Array.from(keplerEngineVector({})).slice(0, 80)).toEqual(Array.from(v).slice(0, 80)); // missing fields -> defaults
  });
});

describe("Kepler: FL's 277 factory presets", () => {
  const P = D.presets!;

  it('lists them in the menu order, "Default" first', () => {
    expect(P.length).toBe(277);
    expect(KEPLER_PRESET_NAMES.length).toBe(277);
    expect(KEPLER_PRESET_DATA.length).toBe(277);
    expect(P[0].name).toBe('Default');
    expect(P[1].name).toBe('Arps/Ascendirect');
    expect(P[P.length - 1].name).toBe('X WiseLabs/Zarp');
    expect(new Set(P.map((p) => p.name)).size).toBe(277);
    const folders = new Map<string, number>();
    for (const p of P.slice(1)) { const fo = p.name.split('/')[0]; folders.set(fo, (folders.get(fo) ?? 0) + 1); }
    expect(Object.fromEntries(folders)).toEqual({
      Arps: 8, Basses: 22, Brasses: 26, Drums: 5, FX: 4, Keys: 43, Pads: 17, Plucks: 10, Strings: 18, Synths: 23, 'X WiseLabs': 100,
    });
    expect(P.filter((p) => p.name.includes('&')).length).toBe(2);
    for (const row of KEPLER_PRESET_DATA) expect(row.length).toBe(39);
  });

  it("loads FL's values (test host: Keys/Acceletrosonic with tempo-synced LFO, velocity to volume off)", () => {
    const i = KEPLER_PRESET_NAMES.indexOf('Keys/Acceletrosonic');
    const st = genPresetState('kepler', P[i]);
    expect(KEPLER_PARAM_KEYS.map((k) => st[k])).toEqual([
      0, 0, 0, 0, 0, 243708, 1, 0, 0, 0, 3512, 6000, 2, 1, 1, 0, 0, 0, 0, 3242, 6000, 0, 1072, 520, 4992, 0, 0, 3520, 0, 3080,
      1, 0, 1, 21463, 0, 1,
    ]);
    expect(st).toMatchObject({ arpQuantize: false, velocityToVolume: false, alignSubPhase: false });
    expect(f(5, st.lfoRate as number, st)).toBe('0:3');
    expect(f(19, st.vcfFreq as number)).toBe('193.34 Hz');
    expect(f(33, st.volume as number)).toBe('-9.70 dB');
    // Chorus 1 is the engine float 0.33 in FL's files
    expect(keplerEngineValue(30, st.chorusMode as number)).toBe(Math.fround(0.33));
  });

  it('keeps every engine float FL loads bit for bit (control positions through the wrapper conversion)', () => {
    for (let n = 0; n < P.length; n++) {
      const row = KEPLER_PRESET_DATA[n];
      for (let k = 0; k < 36; k++) {
        expect(Number.isInteger(row[k]), `${KEPLER_PRESET_NAMES[n]} ${KEPLER_PARAM_KEYS[k]}`).toBe(true);
        expect(row[k]).toBeGreaterThanOrEqual(KEPLER_MIN[k]);
        expect(row[k]).toBeLessThanOrEqual(KEPLER_MAX[k]);
      }
    }
  });

  it('is the state of a preset: parameters, the three option switches the files store, view options kept', () => {
    const base = { ...defaultGenParams('kepler'), hq: true, chorusNoise: true, chorusNoiseGate: true };
    const i = KEPLER_PRESET_NAMES.indexOf('Arps/Bassliner');
    const st = genPresetState('kepler', P[i], base);
    expect(st).toMatchObject({ hq: true, chorusNoise: true, chorusNoiseGate: true });
    expect(st.__preset).toBe('Arps/Bassliner');
    expect(keplerPresetState(i)).toMatchObject({ arpQuantize: expect.any(Boolean), velocityToVolume: expect.any(Boolean), alignSubPhase: expect.any(Boolean) });
    // every preset round-trips through JSON and normalisation unchanged
    for (let n = 0; n < P.length; n += 7) {
      const s = genPresetState('kepler', P[n]);
      expect(normalizeGenParams('kepler', json(s))).toEqual(s);
    }
    // option switches stored by the files (arpQuantize, velocityToVolume, alignSubPhase): five combinations occur
    const flags = new Map<string, number>();
    for (const r of KEPLER_PRESET_DATA) { const k = r.slice(36).join(''); flags.set(k, (flags.get(k) ?? 0) + 1); }
    expect(Object.fromEntries(flags)).toEqual({ '010': 131, '000': 79, '001': 60, '011': 5, '100': 2 });
  });
});

describe('Kepler: state', () => {
  it('normalises stored states (booleans, missing fields, preset markers) idempotently', () => {
    const def = normalizeGenParams('kepler', defaultGenParams('kepler'));
    expect(normalizeGenParams('kepler', json(def))).toEqual(def);
    expect(normalizeGenParams('kepler', {})).toEqual(def);
    const odd = normalizeGenParams('kepler', { hq: 1, arpQuantize: 'x', velocityToVolume: 0, chorusNoise: null });
    expect(odd).toMatchObject({ hq: true, arpQuantize: false, velocityToVolume: false, chorusNoise: false, alignSubPhase: false });
    expect(normalizeGenParams('kepler', json(odd))).toEqual(odd);
    expect(normalizeGenParams('kepler', { __kepler: 2 })).toMatchObject(keplerPresetState(2));
    expect('__kepler' in normalizeGenParams('kepler', { __kepler: 2 })).toBe(false);
  });
});
