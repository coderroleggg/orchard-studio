// Granulizer (FL: Fruity Granulizer): registration (FL's parameter list, value texts, presets, state), FL's
// conversions, FPC's Random, the port of Apple's libm (exp / cos / sin / vvsin), FL 2026's renders pinned as fingerprints
// (tests/gen/granulizer-golden.ts), the transient detector, voice life cycle, finiteness at extreme settings, engine
// integration and the editor.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultGenParams, genDef, genInCategory, genPresetState, normalizeGenParams } from '../../src/model/gen/registry';
import { createGen, hasGen } from '../../src/engine/gen';
import { FpcRandom } from '../../src/engine/gen/plugins/granulizer/random';
import { RELEASE_GAINS } from '../../src/engine/gen/plugins/granulizer/release';
import { appleCos, appleExp, appleSin, fma, vvsin } from '../../src/engine/gen/plugins/granulizer/libm';
import { RELEASE_LEN } from '../../src/engine/gen/plugins/granulizer/voice';
import { msOf, msParse, spacingOf, spacingParse } from '../../src/model/gen/plugins/granulizer/convert';
import { detectTransients } from '../../src/model/gen/plugins/granulizer/detect';
import { granulizerState } from '../../src/model/gen/plugins/granulizer/state';
import { formatParam } from '../../src/model/gen/registry';
import { GRAN_GOLDEN, GRAN_PRESET_EPOCH, GRAN_PRESET_GOLDEN, GRAN_PRESET_NOTES } from './granulizer-golden';
import { burstSignal, dcSignal, fingerprint, pulseSignal, rampSignal, SIG_RATE } from './granulizer-signals';
import { POINTS_MODE, SIGNALS, granulizer, params as voiceParams, renderLikeHost } from './granulizer-util';
import { genChannel, makeEngine, play, rms } from './util';

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (const c of new TextEncoder().encode(s)) { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

describe('Granulizer: registration', () => {
  const def = genDef('granulizer')!;
  it('is a Sampler instrument with FL\'s INS tab and form size', () => {
    expect(def.name).toBe('Granulizer');
    expect(def.category).toBe('Sampler');
    expect(def.notes).toBe('voices');
    expect(def.ins).toBe(true);
    expect(def.levels).toBe('plugin');
    expect([def.width, def.height]).toEqual([392, 429]);
    expect(genInCategory('Sampler').map((d) => d.id)).toContain('granulizer');
    expect(hasGen('granulizer')).toBe(true);
  });

  it('has FL\'s 12 parameters (names, indices, ranges, defaults)', () => {
    const want: [string, string, number, number, number, number][] = [
      ['attack', 'Grain attack time', 0, 50, 500, 204], ['hold', 'Grain hold time', 1, 0, 500, 50],
      ['spacing', 'Grain spacing', 2, 125, 1000, 611], ['wave', 'Wave spacing', 3, -1000, 1000, 611],
      ['depth', 'Effect depth', 4, 0, 384, 0], ['speed', 'Effect speed', 5, 4, 200, 180],
      ['random', 'Randomness', 6, 0, 256, 0], ['stereo', 'Stereo separation', 7, 0, 64, 0],
      ['loop', 'Repeat sound', 8, 0, 1, 0], ['holdSound', 'Hold sound', 9, 0, 1, 0],
      ['start', 'Sample start', 10, 0, 4096, 0], ['transHold', 'Transient hold time', 11, 0, 500, 228],
    ];
    expect(def.params.map((p) => [p.key, p.name, p.index, p.min, p.max, p.def])).toEqual(want);
  });

  it('formats every value like FL (the host\'s sweeps, fingerprinted)', () => {
    const want: Record<string, [number, number, string]> = {
      attack: [0, 500, '873c37c3'], hold: [0, 500, '873c37c3'], spacing: [0, 1000, '42b72c52'], wave: [-1000, 1000, 'f64e74c7'],
      depth: [0, 384, '56bc6446'], speed: [0, 200, '8bb95e71'], random: [0, 256, '3cbe21c4'], stereo: [0, 64, '3764a9dc'],
      loop: [0, 1, 'fc5df38a'], holdSound: [0, 1, 'fc5df38a'], start: [0, 4096, '6fde2be5'], transHold: [0, 500, '873c37c3'],
    };
    for (const p of def.params) {
      const [lo, hi, h] = want[p.key];
      let body = '';
      for (let v = lo; v <= hi; v++) body += `${v}\t${formatParam(p, v)}\n`;
      expect(fnv(body), p.key).toBe(h);
    }
  });

  it('converts typed values back (FL 0x63490 / 0x634f0)', () => {
    expect(msParse(40)).toBe(205);
    expect(msParse(500)).toBe(500);
    for (const t of [5, 12, 40, 96, 222, 334, 500]) expect(msOf(msParse(t))).toBe(t);
    expect(formatParam(def.params[2], spacingParse(100))).toBe('100%');
    expect(formatParam(def.params[3], spacingParse(-100))).toBe('-100%');
    for (const t of [30, 100, 150, 214, 300, -50, -214]) expect(Math.round((spacingOf(spacingParse(t)) / 256) * 100)).toBe(t);
    expect(def.params[0].parse!(38)).toBe(199);
  });

  it('keeps FL\'s conversions: milliseconds and the 256 = 100 % spacing scale', () => {
    expect([0, 50, 100, 204, 300, 500].map(msOf)).toEqual([0, 5, 12, 40, 96, 500]);
    expect([125, 611, 1000, -613, -1000].map(spacingOf)).toEqual([27, 256, 768, -257, -768]);
  });

  it('starts a new instance from FL\'s plugin database state', () => {
    const d = defaultGenParams('granulizer');
    expect(d).toMatchObject({ attack: 204, hold: 50, spacing: 611, wave: 611, depth: 0, speed: 180, random: 0, stereo: 0, loop: 0, holdSound: 0, start: 0, transHold: 228, trigger: 0, trans: 0, sample: '' });
  });

  it('lists FL\'s eight factory presets with their saved values', () => {
    const P = (name: string) => def.presets!.find((p) => p.name === name)!.params;
    expect(def.presets!.map((p) => p.name)).toEqual(['Backwards', 'Default', 'Drumloops', 'Rearranging drumloops', 'Stutter', 'Time stretch - twice faster', 'Time stretch - twice slower', 'Weird language']);
    expect(P('Backwards')).toMatchObject({ attack: 188, hold: 0, wave: -613, trigger: 0, trans: 0 });
    expect(P('Default')).toMatchObject({ attack: 200, hold: 50, spacing: 611, wave: 611 });
    expect(P('Drumloops')).toMatchObject({ attack: 190, hold: 118, transHold: 228, trans: 2, trigger: 0 });
    expect(P('Rearranging drumloops')).toMatchObject({ attack: 50, hold: 172, stereo: 3, loop: 1, holdSound: 0, start: 0, transHold: 242, trans: 2, trigger: 2 });
    expect(P('Stutter')).toMatchObject({ wave: 107, stereo: 26 });
    expect(P('Time stretch - twice faster')).toMatchObject({ spacing: 413, wave: 611 });
    expect(P('Time stretch - twice slower')).toMatchObject({ spacing: 611, wave: 410 });
    expect(P('Weird language')).toMatchObject({ random: 256 });
    // a preset keeps the channel's sample
    const cur = { ...defaultGenParams('granulizer'), sample: 'S', file: 'x.wav', regions: [10], detected: [5], detectedFor: 'S|9|1' };
    const st = genPresetState('granulizer', def.presets![3], cur);
    expect(st).toMatchObject({ sample: 'S', file: 'x.wav', regions: [10], detected: [5], trigger: 2, trans: 2 });
  });

  it('repairs stored states (ranges, types, lists)', () => {
    const s = granulizerState({ attack: 9999, hold: -4, spacing: 'x', wave: 5000, trigger: 7, trans: -2, regions: [3.7, -1, 'a', 20], tempoLocked: 1, sample: 4 });
    expect(s.attack).toBe(500);
    expect(s.hold).toBe(0);
    expect(s.spacing).toBe(611);
    expect(s.wave).toBe(1000);
    expect(s.trigger).toBe(3);
    expect(s.trans).toBe(2); // out of range -> 0, then KEY TO Transient with TRANSIENTS off switches to DETECT
    expect(s.regions).toEqual([3, 20]);
    expect(s.tempoLocked).toBe(false);
    expect(s.sample).toBe('');
    expect(normalizeGenParams('granulizer', { attack: 100 }).attack).toBe(100);
    // KEY TO Transient with TRANSIENTS OFF switches to DETECT (FL's TriggerModeSelectChange, also on loading a state)
    expect(granulizerState({ trigger: 3, trans: 0 }).trans).toBe(2);
    expect(granulizerState({ trigger: 3, trans: 1 }).trans).toBe(1);
    expect(granulizerState({ trigger: 2, trans: 0 }).trans).toBe(0);
  });

  it('names the keys by KEY TO (FL\'s GetName for the piano roll)', () => {
    const names = def.keyNames!;
    const pct = names({ trigger: 1 });
    expect([pct[60], pct[61], pct[72], pct[83], pct[84], pct[59]]).toEqual(['0%', '4%', '50%', '96%', undefined, undefined]);
    const step = names({ trigger: 2 });
    expect([step[60], step[61], step[64], step[68], step[131]]).toEqual(['1 - Beat 1', '2', '5 - Beat 2', '9 - Beat 3', '72']);
    const slices = names({ trigger: 3, trans: 2, detected: [0, 10, 20] });
    expect([slices[60], slices[62], slices[63]]).toEqual(['Slice #1', 'Slice #3', undefined]);
    expect(names({ trigger: 0 })).toEqual({});
  });
});

describe('Granulizer: FPC\'s Random', () => {
  it('is MT19937 seeded with the clock: first outputs of seed 0 and the Random(n) scaling', () => {
    const r = new FpcRandom();
    r.reset(0);
    expect([r.next32(), r.next32(), r.next32(), r.next32()]).toEqual([2357136044, 2546248239, 3071714933, 3626093760]);
    r.reset(0);
    expect([r.random(256), r.random(176400), r.random(256)]).toEqual([140, 104577, 183]);
    r.reset(1700000000);
    const a = r.next32();
    r.reset(1700000000);
    expect(r.next32()).toBe(a);
  });
});

describe('Granulizer: release declick table', () => {
  it('is (cos((k + 1) pi / 442) + 1) / 2 in float32 within two ulps of the correctly rounded cosine', () => {
    expect(RELEASE_GAINS.length).toBe(RELEASE_LEN);
    for (let k = 0; k < RELEASE_LEN; k++) {
      const x = Math.fround(Math.fround(k + 1) * Math.fround(Math.PI / 442));
      const want = Math.fround(Math.fround(Math.fround(Math.cos(x)) + 1) * 0.5);
      expect(Math.abs(RELEASE_GAINS[k] - want)).toBeLessThanOrEqual(1.3e-7);
    }
    expect(RELEASE_GAINS[0]).toBeCloseTo(0.9999874, 6);
    expect(RELEASE_GAINS[440]).toBeLessThan(1e-4);
  });
});

// Apple's libm / Accelerate results (macOS arm64) for arguments where JS's own Math.* is one ulp off: FL's plugin
// calls these, and the sinc kernel's sine recurrence turns the last bit into audible samples (1e-5) where a source
// position lands next to an integer. [argument bits, result bits] of the system exp / cos / sin / vvsin.
const EXP_PINS: [string, string][] = [
  ['bfe861b50897adb0', '3fdddf7ea52a24c0'],
  ['bffb10d140221d28', '3fc794a261e500b5'],
  ['c01dc13d909c7e3a', '3f4344db8d478c3b'],
  ['40184e82635478ee', '407b39373f4946e3'],
  ['c0174db91cc22c3e', '3f682ae63d8cd613'],
  ['3ff97fb9061c3ea0', '4013aff6a771a16b'],
  ['4005428dd4c82818', '402c8566ff451b4d'],
  ['3ff1670a1b159598', '4007bd0d7f5aa2f1'],
  ['4008d45d353f47cc', '403647b3e7f67615'],
  ['401e108d6716b4c4', '409cb605fa820623'],
  ['c01fe9a16e5d96ae', '3f36786dcbaded75'],
  ['401c7915d036b2d6', '4093492404403435'],
  ['4014f85fd553ca00', '4067a4e08422bc77'],
  ['c0149eb9b97fd462', '3f77a2c12689acf5'],
];
const COS_PINS: [string, string][] = [
  ['bfe861b50897adb0', '3fe726f82ee884f9'],
  ['c0174db91cc22c3e', '3fecb65029c57fd4'],
  ['4005428dd4c82818', 'bfec52b559b4d981'],
  ['c01d78b3eaf9046e', '3fdde668fd9fd76f'],
  ['401e108d6716b4c4', '3fd5361fcb0766a5'],
  ['4006beb8da161660', 'bfee95d1c65b1697'],
  ['4015a5bfef3e5320', '3fe49a25bde390d2'],
  ['bfe4cc09f730b130', '3fe979faa25cc2d3'],
  ['c003920fd8541738', 'bfe892762a77cbdd'],
  ['c01604429b6a136a', '3fe6c56b17dd96fe'],
  ['40111a2e16791dc6', 'bfdb1374c8c5c69e'],
  ['c01ba2127818470c', '3fe9f2fc9bbe5e63'],
  ['c0004951ce79c528', 'bfdcb305702652ad'],
  ['4010b23eac480ce6', 'bfe068011c3080f0'],
];
const SIN_PINS: [string, string][] = [
  ['bfe861b50897adb0', 'bfe61713bc81b645'],
  ['c0174db91cc22c3e', '3fdc41be4d6f9e43'],
  ['4005428dd4c82818', '3fddc93ecfdd80d9'],
  ['401e108d6716b4c4', '3fee30fdb1e940df'],
  ['c00fe266e9398ef4', '3fe7e9b1f2b180b4'],
  ['c0147c99677cdf70', '3fed5b5ed6270998'],
  ['bfeac9fbd4a8ffd0', 'bfe7c48ad9f94d0e'],
  ['c015b1b744003284', '3fe83e4b09011fa5'],
  ['401cee3e64a53d7e', '3fea04fec47ecbe3'],
  ['c00e996fbfc2944c', '3fe4343d636d5cc7'],
  ['c01caff13ff08432', 'bfe8d6b834f306bb'],
  ['4002b8148922e8f0', '3fe6fe54a772667d'],
  ['c003bfee6d4cf980', 'bfe3f19071559da9'],
  ['c015b548e4ff6ba2', '3fe82b9eafa9d689'],
];
const VVSIN_PINS: [string, string][] = [
  ['bfe861b50897adb0', 'bfe61713bc81b645'],
  ['4013026683e5039c', 'bfeff976419da73f'],
  ['bffb10d140221d28', 'bfefc44ab5dd2e38'],
  ['401ab6077751d034', '3fd89a4eef18174e'],
  ['4012c4e197b5003a', 'bfeffe5771c3cc99'],
  ['40184e82635478ee', 'bfca3f1e53145d10'],
  ['bffd96bcb8f938c0', 'bfeec457ab77ef6b'],
  ['c0174db91cc22c3e', '3fdc41be4d6f9e43'],
  ['c010ce4a71c41656', '3febe9c9c76fd19d'],
  ['c00d2379338aeba8', '3fdeb960ea5f8db9'],
  ['3ff19dcc14e2b418', '3fec889313d7d09f'],
  ['c006fd4e3bcf53a0', 'bfd0f116d2fde561'],
  ['401bbf37272c6606', '3fe374cc2acbfdf9'],
  ['bfe7ae12687d4f60', 'bfe593c2b663b570'],
];

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const fromHex = (h: string): number => { u64[0] = BigInt('0x' + h); return f64[0]; };
const toHex = (x: number): string => { f64[0] = x; return u64[0].toString(16).padStart(16, '0'); };

describe('Granulizer: Apple libm port (exp, cos, sin, vvsin)', () => {
  const run = (name: string, pins: [string, string][], f: (x: number) => number, js: (x: number) => number) => {
    it(`${name} gives Apple's bits where Math.${name === 'vvsin' ? 'sin' : name} does not`, () => {
      let jsOff = 0;
      for (const [xh, yh] of pins) {
        const x = fromHex(xh);
        expect(toHex(f(x)), `${name}(${x})`).toBe(yh);
        if (toHex(js(x)) !== yh) jsOff++;
      }
      expect(jsOff).toBeGreaterThan(pins.length / 2);
    });
  };
  run('exp', EXP_PINS, appleExp, Math.exp);
  run('cos', COS_PINS, appleCos, Math.cos);
  run('sin', SIN_PINS, appleSin, Math.sin);
  run('vvsin', VVSIN_PINS, vvsin, Math.sin);

  it('exp of the pitch constants: the keys where Math.exp is an ulp off (key 57 = -300 cents, 90, 91, ...)', () => {
    // [semitones from C5, bits of Apple's exp(100 k x 0.0005776226504666211)]
    const KEY_PINS: [number, string][] = [
      [-113, '3f57f910d768cfb1'],
      [-42, '3fb6a09e667f3bcd'],
      [-3, '3feae89f995ad3ad'],
      [30, '4016a09e667f3bcd'],
      [31, '4017f910d768cfaf'],
      [55, '4037f910d768cfb1'],
      [115, '4087f910d768cfb1'],
    ];
    for (const [k, yh] of KEY_PINS) {
      const x = Math.fround(k * 100) * 0.0005776226504666211;
      expect(toHex(appleExp(x)), `key ${60 + k}`).toBe(yh);
    }
  });

  it('fma rounds once: the exact product error survives the sum', () => {
    const a = 1 + 2 ** -30, b = 1 - 2 ** -30, c = -1;
    expect(fma(a, b, c)).toBe(-(2 ** -60)); // a b = 1 - 2^-60 exactly; a * b + c in doubles would give 0
    expect(a * b + c).toBe(0);
  });

  it('vvsin of pi / 2 is exactly 1 (the rounding of |x| / pi lands on a tie: needs a truly fused operation)', () => {
    expect(vvsin(1.5707963267948966)).toBe(1);
    expect(vvsin(-1.5707963267948966)).toBe(-1);
    expect(vvsin(1.5707963267948966 - 1e-25 * 0.2617993877991494)).toBe(1); // the kernel's sine at f = 0
  });

  it('falls back to Math outside the ported ranges', () => {
    expect(appleExp(800)).toBe(Infinity);
    expect(appleExp(-800)).toBe(0);
    expect(appleExp(NaN)).toBeNaN();
    expect(appleCos(1e9)).toBe(Math.cos(1e9));
    expect(appleSin(-1e9)).toBe(Math.sin(-1e9));
    expect(vvsin(1e9)).toBe(Math.sin(1e9));
    expect(appleSin(0)).toBe(0);
    expect(Object.is(appleSin(-0), -0)).toBe(true);
    expect(appleCos(0)).toBe(1);
    expect(vvsin(0)).toBe(0);
  });
});

describe('Granulizer: FL 2026 renders (bit-exact)', () => {
  const cache = new Map<string, Float32Array[]>();
  const signal = (name: string) => { let s = cache.get(name); if (!s) { s = SIGNALS[name](); cache.set(name, s); } return s; };
  for (const c of GRAN_GOLDEN) {
    it(c.name, () => {
      const sr = c.sr ?? 44100;
      const g = granulizer(c.state, signal(c.sig), c.rate ?? SIG_RATE, sr, POINTS_MODE[c.points ?? 1]);
      const [L, R] = renderLikeHost(g, c.notes.map(([key, start, dur]) => ({ key, start, dur })), c.frames, sr, c.bpm ?? 130, c.epoch, c.ramps, c.ctl);
      expect(fingerprint([L, R], c.frames)).toBe(c.hash);
    }, 60000);
  }
});

describe('Granulizer: factory presets (FL loads the .fst files, bit-exact)', () => {
  for (const [name, want] of Object.entries(GRAN_PRESET_GOLDEN)) {
    it(name, () => {
      const preset = genDef('granulizer')!.presets!.find((p) => p.name === name)!;
      for (const sig of ['burst', 'pulse'] as const) {
        const state = genPresetState('granulizer', preset) as Record<string, unknown>;
        const g = granulizer({ ...state, sample: 'S' }, SIGNALS[sig]());
        const frames = Math.round(2.3 * 44100);
        const [L, R] = renderLikeHost(g, GRAN_PRESET_NOTES.map(([key, start, dur]) => ({ key, start, dur })), frames, 44100, 130, GRAN_PRESET_EPOCH);
        expect(fingerprint([L, R], frames), sig).toBe(want[sig]);
      }
    }, 60000);
  }
});

describe('Granulizer: transient detection', () => {
  it('finds the positions FL\'s detector finds (decoded from the host\'s Transient-mode notes)', () => {
    expect(detectTransients(burstSignal(), SIG_RATE)).toEqual([0, 8702, 20688, 34176, 39568, 48959, 54128, 58288, 66031, 75454, 96544, 105728, 115562, 118464, 136493, 155582, 166032]);
  });
  it('finds none in silence and nothing past the end', () => {
    expect(detectTransients([new Float32Array(5000)], SIG_RATE).every((p) => p < 5000)).toBe(true);
    expect(detectTransients([new Float32Array(0)], SIG_RATE)).toEqual([]);
  });
});

describe('Granulizer: voices', () => {
  const sig = dcSignal();
  const ctx = { sampleRate: 44100, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };

  it('plays nothing without a sample and plays once it is delivered', () => {
    const g = createGen('granulizer', 44100, 128)!;
    g.setParams({ sample: 'S' });
    expect(g.triggerVoice!(voiceParams(60), ctx)).toBeNull();
    let delivered = false;
    const g2 = createGen('granulizer', 44100, 128, { sample: () => (delivered ? { channels: sig, sampleRate: 44100 } : undefined) })!;
    g2.setParams({ sample: 'S' });
    expect(g2.triggerVoice!(voiceParams(60), ctx)).toBeNull();
    delivered = true;
    expect(g2.triggerVoice!(voiceParams(60), ctx)).not.toBeNull();
  });

  it('ends when the sample has been played (no loop) and keeps going with LOOP', () => {
    const run = (state: Record<string, unknown>, frames: number) => {
      const g = granulizer(state, sig);
      const v = g.triggerVoice!(voiceParams(60), ctx)!;
      const L = new Float32Array(16), R = new Float32Array(16);
      for (let t = 0; t < frames; t += 16) { L.fill(0); R.fill(0); if (!v.render(L, R, 16)) return t; }
      return -1;
    };
    const end = run({}, 4 * 44100);
    expect(end).toBeGreaterThan(1.9 * 44100);
    expect(end).toBeLessThan(2.3 * 44100);
    expect(run({ loop: 1 }, 4 * 44100)).toBe(-1);
    expect(run({ holdSound: 1 }, 4 * 44100)).toBe(-1);
  });

  it('declicks a released voice over 441 samples and then ends', () => {
    const g = granulizer({ loop: 1 }, sig);
    const v = g.triggerVoice!(voiceParams(60), ctx)!;
    const L = new Float32Array(16), R = new Float32Array(16);
    for (let t = 0; t < 4800; t += 16) { L.fill(0); R.fill(0); expect(v.render(L, R, 16)).toBe(true); }
    v.release();
    let frames = 0, alive = true;
    const out: number[] = [];
    while (alive && frames < 2000) { L.fill(0); R.fill(0); alive = v.render(L, R, 16); out.push(...L); frames += 16; }
    expect(alive).toBe(false);
    expect(frames).toBeGreaterThanOrEqual(RELEASE_LEN);
    expect(frames).toBeLessThan(RELEASE_LEN + 32);
    expect(out[0]).toBeGreaterThan(0.3);
    expect(Math.abs(out[RELEASE_LEN + 4])).toBeLessThan(1e-6);
    for (let i = 1; i < 400; i++) expect(Math.abs(out[i])).toBeLessThanOrEqual(Math.abs(out[i - 1]) + 1e-3);
  });

  it('follows the parameters live: a new attack time shapes the next grains', () => {
    const g = granulizer({}, sig);
    const v = g.triggerVoice!(voiceParams(60), ctx)!;
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let t = 0; t < 22050; t += 128) { L.fill(0); R.fill(0); v.render(L, R, 128); }
    g.setParams({ sample: 'S', attack: 500, hold: 500 });
    let min = 1;
    for (let t = 0; t < 88200; t += 128) { L.fill(0); R.fill(0); v.render(L, R, 128); for (let i = 0; i < 128; i++) min = Math.min(min, L[i]); }
    expect(Number.isFinite(min)).toBe(true);
  });

  it('plays mono, stereo and any sample rate and stays finite at extreme settings', () => {
    const mono = [new Float32Array(30000).map((_, i) => Math.sin(i * 0.05) * 0.5)];
    const cases: Record<string, unknown>[] = [
      { attack: 500, hold: 500, spacing: 125, wave: -1000 }, { attack: 50, hold: 0, spacing: 1000, wave: 1000, stereo: 64 },
      { depth: 384, speed: 4, random: 256 }, { depth: 384, speed: 200, random: 1, loop: 1 }, { trigger: 3, trans: 2, transHold: 500, start: 4096 },
      { trigger: 1, start: 4096 }, { trigger: 2, wave: 0 }, { holdSound: 1, depth: 384, random: 256, loop: 1 }, { wave: 1000, spacing: 125, attack: 50, hold: 0, trans: 2 },
    ];
    for (const st of cases) for (const [ch, rate, key] of [[mono, 11025, 12], [mono, 96000, 120], [pulseSignal(20000), 44100, 0], [rampSignal(500), 8000, 131], [mono, 44100, 60]] as [Float32Array[], number, number][]) {
      const g = granulizer(st, ch, rate, 44100, 'sinc24');
      const v = g.triggerVoice!(voiceParams(key), ctx);
      if (!v) continue;
      const L = new Float32Array(128), R = new Float32Array(128);
      for (let t = 0; t < 30000; t += 128) {
        L.fill(0); R.fill(0);
        if (t === 20000) v.release();
        const alive = v.render(L, R, 128);
        for (let i = 0; i < 128; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error(`non-finite in ${JSON.stringify(st)} key ${key}`);
        if (!alive) break;
      }
      v.kill();
    }
  }, 120000);

  it('plays a chord of 128 voices', () => {
    const g = granulizer({ loop: 1 }, pulseSignal());
    const vs = Array.from({ length: 128 }, (_, i) => g.triggerVoice!(voiceParams(40 + (i % 40)), ctx));
    expect(vs.every((v) => v)).toBe(true);
    expect(g.triggerVoice!(voiceParams(60), ctx)).toBeNull();
    const L = new Float32Array(16), R = new Float32Array(16);
    for (let t = 0; t < 8000; t += 16) { L.fill(0); R.fill(0); for (const v of vs) v!.render(L, R, 16); }
    expect(rms(L)).toBeGreaterThan(0);
    vs.forEach((v) => v!.kill());
    expect(g.triggerVoice!(voiceParams(60), ctx)).not.toBeNull();
  });

  it('shows the voices\' sample positions to the editor', () => {
    const g = granulizer({ start: 2048 }, sig);
    const v = g.triggerVoice!(voiceParams(60), ctx)!;
    const L = new Float32Array(16), R = new Float32Array(16);
    v.render(L, R, 16);
    const m = g.monitor!() as { pos: number[] };
    expect(m.pos.length).toBe(1);
    expect(m.pos[0]).toBeGreaterThan(0.45);
    expect(m.pos[0]).toBeLessThan(0.7);
  });
});

describe('Granulizer: engine integration', () => {
  it('plays notes through the channel (INS, levels, pan law, declick) and is finite', () => {
    const e = makeEngine();
    const pulses = pulseSignal();
    e.handle({ t: 'sample', id: 'S', data: pulses, sampleRate: SIG_RATE });
    const c = genChannel('granulizer');
    c.plugin!.params = normalizeGenParams('granulizer', { sample: 'S', stereo: 20 });
    const [L, R] = play(e, [c], { [c.id]: [{ key: 60, pos: 0, len: 24 }, { key: 67, pos: 24, len: 24 }, { key: 55, pos: 48, len: 24 }] }, 48000);
    expect(rms(L)).toBeGreaterThan(0.005);
    expect(rms(R)).toBeGreaterThan(0.005);
    for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
  }, 60000);
});

describe('Granulizer: editor', () => {
  it('renders FL\'s layout, empty and with a sample', async () => {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
    g.document ??= { body: {}, getElementById: () => null };
    const { FxEditorContext } = await import('../../src/ui/plugins/kit');
    const { editor } = await import('../../src/ui/plugins/gen/granulizer');
    const render = (p: Record<string, unknown>) => renderToStaticMarkup(createElement(FxEditorContext.Provider,
      { value: { slotId: 'ch:x', plugin: 'granulizer', params: p, trackName: 'Granulizer', pluginName: 'Granulizer' } }, createElement(editor.Editor)));
    const html = render(normalizeGenParams('granulizer', defaultGenParams('granulizer')));
    for (const t of ['GRAINS', 'EFFECTS', 'TRANSIENTS', 'TIME', 'ATTACK', 'HOLD', 'GR. SPACING', 'WAVE SPACING', 'PAN', 'DEPTH', 'SPEED', 'RAND', 'START', 'LOOP', 'TEMPO LOCKED', 'KEY TO', 'OFF', 'USE REGIONS', 'DETECT', 'Pitch']) {
      expect(html).toContain(t);
    }
    const percent = render(normalizeGenParams('granulizer', { trigger: 1, trans: 2, tempoLocked: true }));
    expect(percent).toContain('Percent');
    expect(editor.menu!('ch:x').map((m) => m.label)).toContain('Load sample...');
  }, 60000);
});
