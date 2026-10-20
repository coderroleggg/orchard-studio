// PoiZone (FL: PoiZone): registration (FL's 203 parameters, value texts from full
// test-host sweeps, factory presets, insertion state) and the DSP against FL's own
// renders (flfxhost, 44.1 kHz, FPE_MaxPoly 0 as FL sends it): one voice (FL's scalar
// loop), several (FL's four-voice NEON loop and its lane-reversed level store), the
// insertion preset (arpeggiator, unison, gate, chorus, delay), effects with noise,
// band-pass filter and LFO, mono with glide. Our renders match FL's sample for
// sample (bit-exact in these cases).
import { describe, it, expect, vi } from 'vitest';
import { genDef, genPresetState, defaultGenParams, formatParam } from '../../src/model/gen/registry';
import { PzPlugin } from '../../src/engine/gen/plugins/poizone/plugin';
import { PZ_PRESET_DATA, PZ_PRESET_NAMES } from '../../src/model/gen/plugins/poizone/presets';
import { pzRawToEngine } from '../../src/model/gen/plugins/poizone/data';
import { exp2f, logf, cosf, sinf, sincosf, exp10f } from '../../src/engine/gen/plugins/poizone/applemath';
import { fmaD } from '../../src/engine/gen/plugins/poizone/dsp';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';
import { createGenChannel } from '../../src/model/defaults';
import { makeEngine, play, rms } from './util';

// DSP renders: generous time when the whole suite runs concurrently
vi.setConfig({ testTimeout: 120_000 });

const D = genDef('poizone')!;
const SR = 44100;
const dB = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

function note(key: number, vel: number, id: number): GenNote {
  const init = newLevels(), levels = newLevels();
  init.pitch = key * 100; init.vol = (Math.pow(11, vel / 100) - 1) / 10;
  levels.pitch = key * 100; levels.vol = 1; levels.pan = 0;
  return { id, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/**
 * The plugin as FL's test host drives it: SetSampleRate, then either FL parameters
 * (raw values, applied one by one) or a preset state, a 0.25 s preroll with the
 * transport stopped, 512-frame blocks split at note events, playing from the first note.
 */
function render(notes: [number, number, number, number][], seconds: number, opt: { params?: Record<number, number>; preset?: string } = {}): Float32Array[] {
  const pl = new PzPlugin(SR, 512);
  if (opt.preset) {
    const i = PZ_PRESET_NAMES.indexOf(opt.preset);
    pl.setParams(genPresetState('poizone', D.presets![i]));
  } else {
    for (const [k, v] of Object.entries(opt.params ?? {})) pl.synth.setParameter(+k, pzRawToEngine(+k, v));
    (pl as unknown as { first: boolean }).first = false;
  }
  const pre = Math.round(0.25 * SR), n = Math.round(seconds * SR), total = pre + n;
  const evs: { t: number; on: boolean; n: GenNote }[] = [];
  notes.forEach(([k, v, s, d], i) => {
    const nn = note(k, v, i + 1);
    evs.push({ t: pre + Math.round(s * SR), on: true, n: nn }, { t: pre + Math.round((s + d) * SR), on: false, n: nn });
  });
  evs.sort((a, b) => a.t - b.t);
  const L = new Float32Array(n), R = new Float32Array(n);
  const bl = new Float32Array(512), br = new Float32Array(512);
  let t = 0, e = 0;
  while (t < total) {
    let m = Math.min(512, total - t);
    for (const c of [pre, ...evs.slice(e).map((x) => x.t)]) if (c > t && c < t + m) m = c - t;
    while (e < evs.length && evs[e].t <= t) { const ev = evs[e++]; if (ev.on) pl.noteOn(ev.n, 0); else pl.noteOff(ev.n, 0); }
    const playing = t >= pre;
    const ctx = { sampleRate: SR, blockSize: 512, tempo: 130, ppq: 96, playing, pos: playing ? ((t - pre) * 130 * 96) / (60 * SR) : 0, songMode: false, track: 0 };
    bl.fill(0); br.fill(0);
    pl.render(bl, br, m, ctx);
    if (t >= pre) { L.set(bl.subarray(0, m), t - pre); R.set(br.subarray(0, m), t - pre); }
    t += m;
  }
  return [L, R];
}

function expectFl(L: Float32Array, idx: number[], fl: number[]): void {
  idx.forEach((i, k) => expect(L[i]).toBeCloseTo(fl[k], 7));
}

describe('PoiZone: registration', () => {
  it("has FL's 203 parameters (74 synth parameters, MIDI CC 0..127, channel aftertouch)", () => {
    expect(D.name).toBe('PoiZone');
    expect(D.category).toBe('Synth classic');
    expect(D.notes).toBe('events');
    expect([D.width, D.height]).toEqual([855, 521]);
    expect(D.params.length).toBe(203);
    expect(D.params[0]).toMatchObject({ name: 'Osc A shape', min: 0, max: 1, index: 0 });
    expect(D.params[1]).toMatchObject({ name: 'Osc A PW', max: 256 });
    expect(D.params[21].name).toBe('Filter veltrk');
    expect(D.params[69].name).toBe('Arpegiator mode');
    expect(D.params[74].name).toBe('MIDI CC 0');
    expect(D.params[202].name).toBe('Channel Aftertouch');
  });

  it("writes FL's value texts (test-host sweeps: banker's rounding for integers, half away from zero for decimals)", () => {
    const f = (i: number, v: number) => formatParam(D.params[i], v);
    expect(f(0, 0)).toBe('SAW');
    expect(f(0, 1)).toBe('PULSE');
    expect(f(1, 32)).toBe('12%');
    expect(f(1, 96)).toBe('38%');
    expect(f(6, 1)).toBe('-23');
    expect(f(7, 255)).toBe('49');
    expect(f(10, 112)).toBe('-12%');
    expect(f(11, 128)).toBe('3130ms');
    expect(f(15, 16)).toBe('-18.13dB');
    expect(f(15, 128)).toBe('-5.00dB');
    expect(f(16, 3)).toBe('-97');
    expect(f(23, 32)).toBe('6ms');
    expect(f(25, 128)).toBe('639ms');
    expect(f(28, 51)).toBe('0.01Hz');
    expect(f(32, 109)).toBe('3/4');
    expect(f(40, 32)).toBe('0.73Hz');
    expect(f(65, 64)).toBe('FRQ A');
    expect(f(67, 256)).toBe('PAN');
    expect(f(68, 128)).toBe('TRIANGLE');
    expect(f(69, 192)).toBe('UP / DN');
    expect(f(70, 100)).toBe('2');
    expect(f(71, 64)).toBe('LFO');
    expect(f(49, 1)).toBe('On');
  });

  it("has FL's 385 presets; the insertion state is FL's plugin database entry (ARP Classic VA ToTc)", () => {
    expect(D.presets!.length).toBe(385);
    expect(D.presets![0].name).toBe('Default');
    expect(PZ_PRESET_DATA.length).toBe(385);
    const def = defaultGenParams('poizone');
    expect(def.oscASync).toBe(1);
    expect(def.oscBal).toBeCloseTo(0.585 * 256, 3);
    expect(def.arpMode).toBe(64);
    expect(def.hidden).toEqual([0, 2, 11, 1, 1, 2, 0]);
    const p = genPresetState('poizone', D.presets!.find((x) => x.name === 'Default')!);
    expect(p).toMatchObject({ oscAShape: 0, cutoff: 256, hidden: [0, 0, 15, 1, 0, 0, 0] });
  });

  it("ports Apple's libm float functions (FL calls them; not correctly rounded) and a correctly rounded double FMA", () => {
    // Apple cosf(1.70971024) = -0.13846758 (correctly rounded: -0.138467565)
    expect(cosf(Math.fround(1.7097102403640747))).toBe(Math.fround(-0.13846758));
    expect(sinf(Math.fround(0.5))).toBe(Math.fround(Math.sin(0.5)));
    const sc = [0, 0];
    sincosf(Math.fround(0.1424758583307266), sc);
    expect(sc[0]).toBeCloseTo(0.141994312, 8);
    expect(exp2f(0)).toBe(1);
    expect(exp2f(1)).toBe(2);
    expect(exp10f(Math.fround(0.25))).toBe(Math.fround(1.77827942));
    expect(logf(Math.fround(11))).toBeCloseTo(Math.log(11), 6);
    // FL's tape speed smoothing converges to the hardware FMA's fixed point
    let s = 0.0000463853805400832;
    for (let i = 0; i < 8000; i++) s = fmaD(0.00004912705010959111 - s, 0.005, s);
    expect(s).toBe(4.912705010959044e-05);
  });
});

describe('PoiZone: DSP against FL renders', () => {
  it("one voice (FL's scalar generator loop) matches FL sample for sample", () => {
    const [L, R] = render([[60, 100, 0, 0.5]], 0.7);
    expectFl(L, [100, 1000, 5000, 10000, 20000], [-0.0242731385, -0.123986945, -0.0947734863, 0.0433069207, -0.0829598755]);
    expect(R[1000]).toBeCloseTo(-0.123986945, 7);
    expect(dB(rms(L, 0, 22050))).toBeCloseTo(-19.2101, 3);
  });

  it("several voices (FL's four-voice loop, its lane-reversed oscillator-level store) match FL", () => {
    const [L] = render([[60, 100, 0, 0.5], [64, 100, 0, 0.5], [67, 100, 0.05, 0.45]], 0.7);
    expectFl(L, [100, 1000, 5000, 10000, 20000], [-0.134023294, -0.102283545, -0.00352863478, -0.163505346, -0.0885683894]);
    expect(dB(rms(L, 0, 22050))).toBeCloseTo(-14.6616, 3);
  });

  it('the insertion preset (arpeggiator, unison x3, chorus, delay) matches FL', () => {
    const [L, R] = render([[60, 100, 0, 1.5], [64, 100, 0, 1.5], [67, 100, 0, 1.5]], 2, { preset: 'Factory/ARP Classic VA ToTc' });
    expectFl(L, [100, 1000, 5000, 10000, 20000, 40000, 60000], [-0.0218100585, 0.00985485967, -0.0786944106, -0.00432431651, -0.0584258772, -0.119569436, 0.0511611402]);
    expect(R[1000]).toBeCloseTo(-0.0544344634, 7);
    expect(dB(rms(L, 22050, 44100))).toBeCloseTo(-16.6459, 3);
  });

  it('noise, band-pass filter, LFO, chorus and delay with feedback / modulation match FL', () => {
    const [L, R] = render([[55, 110, 0, 0.3]], 1.6, { params: { 31: 1, 38: 200, 34: 150, 35: 200, 39: 1, 40: 200, 41: 230, 42: 200, 9: 60, 66: 128, 18: 140, 19: 200, 26: 230, 28: 150 } });
    expectFl(L, [100, 1000, 5000, 10000], [-0.14348419, 0.222159371, 0.340250909, -0.0981355086]);
    expect(R[1000]).toBeCloseTo(-0.279826254, 7);
    expect(dB(rms(L, 22050, 44100))).toBeCloseTo(-22.0582, 3);
  });

  it('mono legato with glide and the envelope on oscillator A pitch matches FL', () => {
    const [L] = render([[60, 100, 0, 0.4], [64, 80, 0.2, 0.4], [67, 120, 0.5, 0.3]], 1, { params: { 44: 1, 46: 100, 65: 64, 10: 200 } });
    expectFl(L, [100, 1000, 5000, 10000, 20000], [0.124918282, 0.0101141455, -0.112246186, 0.124269918, 0.0131195327]);
    expect(dB(rms(L, 0, 22050))).toBeCloseTo(-19.2532, 3);
  });
});

describe('PoiZone: in an instrument channel', () => {
  it('plays the insertion state and stays finite at extremes', () => {
    const e = makeEngine();
    const ch = createGenChannel('poizone');
    const [L] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 48, key: 60 }, { pos: 0, len: 48, key: 64 }] }, 48000);
    expect(rms(L)).toBeGreaterThan(0.01);
    for (const v of L) expect(Number.isFinite(v)).toBe(true);
    const e2 = makeEngine();
    const ch2 = createGenChannel('poizone');
    const p = ch2.plugin!.params;
    Object.assign(p, { reso: 256, cutoff: 0, noiseBal: 256, delayOn: 1, delayFb: 256, chorusOn: 1, gateMix: 256, lfoShape: 256, lfoAmt: 256, lfoDest: 64 });
    const [L2] = play(e2, [ch2], { [ch2.id]: [{ pos: 0, len: 12, key: 0, vel: 128 }, { pos: 6, len: 12, key: 127, vel: 128 }] }, 24000);
    for (const v of L2) expect(Number.isFinite(v)).toBe(true);
  });
});
