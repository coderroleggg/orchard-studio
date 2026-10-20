// MiniSynth (FL: MiniSynth): registration (FL's 172 parameters, value texts,
// the 92 factory presets, the fresh state from FL's plugin database), FL's
// numbers from the FL test host (FL's plugin rendered with flfxhost, block 128,
// no preroll, FPE_MaxPoly 8) pinned against our port, voice modes, effects,
// parameter changes and finiteness.
import { describe, it, expect } from 'vitest';
import { genDef, genPresetState, defaultGenParams, formatParam, genInCategory } from '../../src/model/gen/registry';
import { msChoiceValue, msFloat, MS_PARAM_KEYS } from '../../src/model/gen/plugins/minisynth';
import { createGen } from '../../src/engine/gen';
import { miniSynthSeed, miniSynthVelocity } from '../../src/engine/gen/plugins/minisynth';
import { oscSpectrum, oscTables, TABLE_LEN } from '../../src/engine/gen/plugins/minisynth/tables';
import type { GenNote } from '../../src/engine/gen/types';
import { createGenChannel } from '../../src/model/defaults';
import { makeEngine, play, rms, peak } from './util';

const D = genDef('minisynth')!;
const SR44 = 44100;

interface N { key: number; vel?: number; start: number; dur: number }

/**
 * Render MiniSynth like FL's test host: a fresh FL process (global noise seed 0), blocks of 128 frames
 * restarting at note events, transport playing from 0 at 130 BPM, levels of a raw centred channel.
 */
function render(params: Record<string, unknown>, notes: N[], seconds: number, opts: { sr?: number; at?: [number, Record<string, number>][] } = {}): [Float32Array, Float32Array] {
  const sr = opts.sr ?? SR44, tempo = 130;
  miniSynthSeed(0);
  const inst = createGen('minisynth', sr, 128)!;
  let state = { ...defaultGenParams('minisynth'), ...params };
  inst.setParams(state);
  const frames = Math.round(seconds * sr);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const bl = new Float32Array(128), br = new Float32Array(128);
  const ns = notes.map((n, i) => {
    const lv = { pan: 0, vol: 1, pitch: 6000 + (n.key - 60) * 100, fcut: 0, fres: 0 };
    const note: GenNote = { id: i + 1, key: n.key, velocity: n.vel ?? 100, release: 64, color: 0, length: Infinity, frame: 0, init: { ...lv }, levels: lv };
    return { note, on: Math.round(n.start * sr), off: Math.round((n.start + n.dur) * sr) };
  });
  const ats = (opts.at ?? []).map(([t, p]) => ({ f: Math.round(t * sr), p }));
  const cuts = [...new Set([...ns.flatMap((n) => [n.on, n.off]), ...ats.map((a) => a.f)])].sort((a, b) => a - b);
  const ctx = { sampleRate: sr, blockSize: 128, tempo, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
  for (let t = 0; t < frames;) {
    for (const a of ats) if (a.f === t) { state = { ...state, ...a.p }; inst.setParams(state); }
    for (const n of ns) { if (n.on === t) inst.noteOn!(n.note, 0); if (n.off === t) inst.noteOff!(n.note, 0); }
    let m = Math.min(128, frames - t);
    const nx = cuts.find((c) => c > t);
    if (nx !== undefined && nx < t + m) m = nx - t;
    bl.fill(0); br.fill(0);
    ctx.pos = (t * tempo * 96) / (60 * sr);
    inst.render!(bl.subarray(0, m), br.subarray(0, m), m, ctx);
    L.set(bl.subarray(0, m), t); R.set(br.subarray(0, m), t);
    t += m;
  }
  return [L, R];
}

const preset = (name: string) => genPresetState('minisynth', D.presets!.find((p) => p.name === name)!);

function f0(b: Float32Array, a: number, z: number, sr = SR44): number {
  let first = -1, last = -1, n = 0;
  for (let i = a + 1; i < z; i++) if (b[i - 1] < 0 && b[i] >= 0) { const x = i - 1 + b[i - 1] / (b[i - 1] - b[i]); if (first < 0) first = x; else n++; last = x; }
  return (n * sr) / (last - first);
}

describe('MiniSynth: registration', () => {
  it('is FL\'s MiniSynth: Synth classic, own voices (events), velocity in the plugin, 8 voices, 717 x 473', () => {
    expect(D.name).toBe('MiniSynth');
    expect(D.category).toBe('Synth classic');
    expect(genInCategory('Synth classic').map((d) => d.id)).toContain('minisynth');
    expect(D.notes).toBe('events');
    expect(D.velocity).toBe('plugin');
    expect(D.defPoly).toBe(8);
    expect([D.width, D.height]).toEqual([717, 473]);
  });

  it('has FL\'s 172 parameters in index order (43 synth parameters, MIDI CC 0..127, channel aftertouch)', () => {
    expect(D.params.length).toBe(172);
    expect(D.params.map((q) => q.index)).toEqual(Array.from({ length: 172 }, (_, i) => i));
    expect(D.params.slice(0, 43).map((q) => q.name)).toEqual([
      'Voices Mode', 'Transpose', 'Slide Time', 'MW Dest', 'MW Amount', 'OSC Kind', 'OSC Mod', 'OSC Noise', 'FLT Freq', 'FLT Peak',
      'FLT Kbd', 'FLT Vel', 'EGF Atk', 'EGF Dec', 'EGF Sus', 'EGF Rel', 'EGF Amnt', 'LFO Shape', 'LFO Dest', 'LFO Rate', 'LFO Amnt',
      'AMP Atk', 'AMP Dec', 'AMP Sus', 'AMP Rel', 'DIST', 'Overdrive', 'Decimator', 'DELAY', 'DELAY Time', 'DELAY Fdbk', 'DELAY Filter',
      'DELAY Mix', 'CHORUS', 'CHORUS ModRate', 'CHORUS ModDepth', 'CHORUS Mix', 'PHASER', 'PHASER ModSpeed', 'PHASER ModWidth',
      'PHASER Fdbk', 'PHASER Mix', 'PHASER Freq',
    ]);
    expect(D.params[43].name).toBe('MIDI CC 0');
    expect(D.params[170].name).toBe('MIDI CC 127');
    expect(D.params[171].name).toBe('Chn. Aftertouch');
    for (const q of D.params) expect([q.min, q.max, q.step]).toEqual([0, 256, 0]);
    // the synth's default table (getDefault 0x40e44) x 256
    const def = D.params.slice(0, 43).map((q) => msFloat(q.def));
    expect(def.slice(0, 5)).toEqual([0.375, 0.5, 0, 0, 0]);
    expect(def[24]).toBe(Math.fround(0.07));
    expect(def[38]).toBe(Math.fround(0.11222222447395325));
  });

  it('writes FL\'s value texts (flfxhost sweep, trailing space from FL\'s GetName)', () => {
    const cases: [number, number, string][] = [
      [0, 0, 'POLY '], [0, 127, 'POLY '], [0, 128, 'MONO '], [0, 255, 'MONO '], [0, 256, 'LEAD '],
      [1, 0, '-12 '], [1, 1, '-11 '], [1, 11, '-10 '], [1, 117, '-1 '], [1, 118, '0 '], [1, 138, '0 '], [1, 139, '1 '], [1, 256, '12 '],
      [2, 0, '0.0 '], [2, 1, '0.4 '], [2, 16, '6.2 '], [2, 48, '18.8 '], [2, 80, '31.2 '], [2, 128, '50.0 '], [2, 255, '99.6 '], [2, 256, '100.0 '],
      [3, 0, 'Filter '], [3, 255, 'Filter '], [3, 256, 'LFO '],
      [5, 0, 'SAW '], [5, 28, 'SAW '], [5, 29, 'SAW+SAW '], [5, 56, 'SAW+SAW '], [5, 57, 'PULSE '], [5, 143, 'SUPERSAW '], [5, 228, 'SAW SPREAD '], [5, 256, 'SAW SPREAD 2 '],
      [16, 0, '-100.0 '], [16, 1, '-99.2 '], [16, 127, '-0.8 '], [16, 128, '0.0 '], [16, 129, '0.8 '], [16, 255, '99.2 '], [16, 256, '100.0 '],
      [17, 0, 'SINE '], [17, 127, 'SINE '], [17, 128, 'SAW '], [17, 256, 'SQUARE '],
      [18, 0, 'FLT '], [18, 128, 'FRQ '], [18, 256, 'OSCMOD '],
      [19, 0, '1/4 '], [19, 23, '1/4 '], [19, 24, '3/8 '], [19, 94, '1/1 '], [19, 187, '16/1 '], [19, 209, '16/1 '], [19, 210, '4 Bars '], [19, 256, '16 bars '],
      [20, 0, '-100.0 '], [20, 64, '-50.0 '], [20, 128, '0.0 '], [20, 192, '50.0 '], [20, 256, '100.0 '],
      [29, 0, '1/4 '], [29, 85, '1/4 '], [29, 86, '2/4 '], [29, 170, '2/4 '], [29, 171, '3/4 '], [29, 256, '1/1 '],
      [38, 0, '1/4 '], [38, 24, '3/8 '], [38, 47, '1/2 '], [38, 256, '16 bars '],
      [43, 0, '0'], [43, 2, '0'], [43, 3, '1'], [43, 128, '63'], [43, 256, '127'], [171, 5, '2'], [171, 256, '127'],
    ];
    for (const [i, v, t] of cases) expect(formatParam(D.params[i], v), `param ${i} = ${v}`).toBe(t);
    // FL's preset floats keep their exact texts (Slide Time 0.674 -> "67.4 ", not the 172 / 256 of FL's integer)
    expect(formatParam(D.params[2], preset('Default/Bass Almost Sine').slideTime as number)).toBe('67.4 ');
  });

  it('has FL\'s 92 factory presets with FL\'s exact floats', () => {
    const names = D.presets!.map((p) => p.name);
    expect(names.length).toBe(92);
    expect(names[0]).toBe('Default');
    expect(names).toContain('Default/Bass Almost Sine');
    expect(names).toContain('Default/Keys Brass Buttons');
    expect(names.filter((n) => n.startsWith('Default/')).length).toBe(91);
    const b = preset('Default/Bass Almost Sine');
    // Bass Almost Sine.flms: LEAD, PULSE (2/9), FLT Peak 0.9695037, chorus on
    expect(msFloat(b.voicesMode as number)).toBe(1);
    expect(msFloat(b.oscKind as number)).toBe(Math.fround(2 / 9));
    expect(msFloat(b.fltPeak as number)).toBe(0.9695037007331848);
    expect(msFloat(b.chorus as number)).toBe(1);
    // the Plugin presets "Default" (Default.fst) has AMP Atk / Rel 0, the plugin database state 0.02 / 0.05
    expect(msFloat(preset('Default').ampAtk as number)).toBe(0);
    const fresh = defaultGenParams('minisynth');
    expect(msFloat(fresh.ampAtk as number)).toBe(0.019999995827674866);
    expect(msFloat(fresh.ampRel as number)).toBe(0.05000000447034836);
    expect(msFloat(fresh.egfAmnt as number)).toBe(0.6796296238899231);
    expect(fresh.page).toBe(0);
  });

  it('maps FL velocities to MIDI velocities like FL\'s wrapper (128 -> 127)', () => {
    for (let v = 0; v <= 128; v++) expect(miniSynthVelocity(v)).toBe(Math.min(v, 127));
    expect(msChoiceValue(2, 9)).toBe(Math.fround(2 / 9) * 256);
    expect(msChoiceValue(4, 11, true)).toBe(Math.fround(0.01 + 4 / 11) * 256);
  });
});

describe('MiniSynth: oscillator tables', () => {
  it('builds 1024 band-limited tables from the waveform model (table 1023 = the fundamental only)', () => {
    const { amp, phase } = oscSpectrum();
    expect(amp.length).toBe(1024);
    // the model's first harmonics (FL's data: 0.29941085, 0.13096106; phases -1.7799916, -1.9093983)
    expect(amp[0]).toBeCloseTo(0.29941085, 6);
    expect(amp[1]).toBeCloseTo(0.13096106, 6);
    expect(phase[0]).toBeCloseTo(-1.7799916, 5);
    expect(phase[1]).toBeCloseTo(-1.9093983, 5);
    const T = oscTables();
    expect(T.length).toBe(1024 * TABLE_LEN);
    const top = T.subarray(1023 * TABLE_LEN, 1024 * TABLE_LEN);
    for (let n = 0; n < TABLE_LEN; n += 97) expect(top[n]).toBeCloseTo(amp[0] * Math.cos(phase[0] + (2 * Math.PI * n) / TABLE_LEN), 6);
    // table 0: FL's ramp-down saw with the rounded reset: rise to ~0.33 near 1/7 of the cycle, linear fall to ~-0.46
    let mx = -1, mn = 1;
    for (let n = 0; n < TABLE_LEN; n++) { mx = Math.max(mx, T[n]); mn = Math.min(mn, T[n]); }
    expect(mx).toBeCloseTo(0.3316, 2);
    expect(mn).toBeCloseTo(-0.4633, 2);
  });
});

describe('MiniSynth: FL\'s sound (flfxhost renders pinned)', () => {
  it('the fresh state (plugin database "Default"): raw saw, key 60 = 261.63 Hz, FL\'s samples and levels', () => {
    const [L, R] = render({}, [{ key: 60, start: 0, dur: 0.3 }], 0.6);
    const fl = [0, 0.00777125545, 0.0275623109, 0.0504845418, 0.0732420683, 0.0952652395, 0.116520807, 0.136910424];
    for (let i = 0; i < fl.length; i++) expect(Math.abs(L[i] - fl[i]), `sample ${i}`).toBeLessThan(3e-6);
    expect(Math.abs(L[1000] - 0.198186755)).toBeLessThan(3e-6);
    expect(Math.abs(L[5000] - -0.162633017)).toBeLessThan(3e-6);
    expect(Math.abs(L[12000] - 0.0773941129)).toBeLessThan(3e-6);
    expect(L[20000]).toBe(0);
    expect(rms(L, 0, 13230)).toBeCloseTo(0.134930567, 5);
    expect(rms(L, 13230, 26460)).toBeCloseTo(0.0162449352, 5);
    expect(f0(L, 2000, 11000)).toBeCloseTo(261.627, 2);
    for (let i = 0; i < L.length; i++) expect(R[i]).toBe(L[i]);
  });

  it('the constructor state (Bass Almost Sine: LEAD, pulse, resonant filter, LFO, chorus)', () => {
    const [L, R] = render(preset('Default/Bass Almost Sine'), [{ key: 48, start: 0, dur: 0.4 }], 0.6);
    const fl: [number, number, number][] = [[100, 0.0602423847, 0.0613170862], [1000, -0.121899471, -0.122563802], [3000, -0.130585894, -0.131032556], [8000, -0.106920689, -0.1099502], [15000, 0.151876912, 0.153168648]];
    for (const [i, l, r] of fl) { expect(Math.abs(L[i] - l), `L ${i}`).toBeLessThan(3e-6); expect(Math.abs(R[i] - r), `R ${i}`).toBeLessThan(3e-6); }
    expect(rms(L, 0, 17640)).toBeCloseTo(0.106809489, 5);
    expect(rms(R, 0, 17640)).toBeCloseTo(0.108024824, 5);
    expect(f0(L, 4000, 17000)).toBeCloseTo(130.559, 1);
  });

  it('scales linearly by MIDI velocity (FL: 64 is -3.876 dB against 100)', () => {
    const [a] = render({}, [{ key: 60, start: 0, dur: 0.3 }], 0.3);
    const [b] = render({}, [{ key: 60, vel: 64, start: 0, dur: 0.3 }], 0.3);
    expect(20 * Math.log10(rms(b) / rms(a))).toBeCloseTo(-3.8764, 3);
  });

  it('echoes at the tempo-synced delay time (FL: 1/4 at 130 BPM -> first echo sample 5089)', () => {
    const [L] = render({ delay: 256, delayTime: 0, delayFdbk: 128, delayFilter: 256, delayMix: 256 }, [{ key: 60, start: 0, dur: 0.02 }], 0.5);
    let first = -1;
    for (let i = 3000; i < L.length; i++) if (Math.abs(L[i]) > 1e-3) { first = i; break; }
    expect(first).toBe(5089);
    expect(peak(L, 4500, 5500)).toBeCloseTo(0.297523, 5);
    expect(peak(L, 9500, 11000)).toBeCloseTo(0.148761, 5);
    // no feedback: FL's delay outputs only its feedback path
    const [S] = render({ delay: 256, delayTime: 0, delayFdbk: 0, delayMix: 256 }, [{ key: 60, start: 0, dur: 0.02 }], 0.3);
    expect(peak(S, 4000)).toBeLessThan(1e-6);
  });
});

describe('MiniSynth: voices and parameters', () => {
  it('POLY plays chords, MONO retriggers one voice, LEAD glides without retrigger', () => {
    const chord: N[] = [{ key: 60, start: 0, dur: 0.3 }, { key: 64, start: 0, dur: 0.3 }];
    const [poly] = render({ voicesMode: 0 }, chord, 0.3);
    const [mono] = render({ voicesMode: 128 }, chord, 0.3);
    const [one] = render({ voicesMode: 128 }, [chord[1]], 0.3);
    expect(rms(poly)).toBeGreaterThan(rms(mono) * 1.2);
    // mono: the second note takes the voice (the result is the single note, slid from key 60 for a few blocks)
    expect(Math.abs(rms(mono, 4410) - rms(one, 4410))).toBeLessThan(rms(one, 4410) * 0.05);
    // LEAD: a legato note keeps the envelope (no new attack): with a slow attack the level keeps rising smoothly
    const slow = { ampAtk: 160 };
    const [lead] = render({ voicesMode: 256, ...slow }, [{ key: 60, start: 0, dur: 0.4 }, { key: 67, start: 0.2, dur: 0.2 }], 0.4);
    const [mon2] = render({ voicesMode: 128, ...slow }, [{ key: 60, start: 0, dur: 0.4 }, { key: 67, start: 0.2, dur: 0.2 }], 0.4);
    const s = Math.round(0.2 * SR44);
    expect(rms(lead, s, s + 2000)).toBeGreaterThan(rms(lead, s - 2000, s) * 0.95);
    expect(rms(mon2, s, s + 2000)).toBeLessThan(rms(lead, s, s + 2000));
  });

  it('a parameter change takes effect at the next 32-sample block', () => {
    const base = { fltFreq: 200, fltPeak: 150 };
    const [a] = render(base, [{ key: 60, start: 0, dur: 0.3 }], 0.3);
    const [b] = render(base, [{ key: 60, start: 0, dur: 0.3 }], 0.3, { at: [[0.1, { fltFreq: 60 }]] });
    const c = Math.round(0.1 * SR44);
    for (let i = 0; i < c; i++) expect(b[i]).toBe(a[i]);
    // FL renders the rest of the block in sub-blocks of 32 from the change; the new cutoff shows within one
    let d = 0;
    for (let i = c; i < c + 32; i++) d = Math.max(d, Math.abs(b[i] - a[i]));
    expect(d).toBeGreaterThan(1e-3);
    expect(f0(b, c + 2000, c + 8000)).toBeCloseTo(261.6, 0);
  });

  it('stays finite at extreme settings, keys and velocities, at 44.1 and 48 kHz', () => {
    const lo: Record<string, number> = {}, hi: Record<string, number> = {};
    for (const k of MS_PARAM_KEYS.slice(0, 43)) { lo[k] = 0; hi[k] = 256; }
    const odd: Record<string, number> = { ...hi, voicesMode: 0, oscKind: msChoiceValue(5, 9), fltPeak: 256, egfAmnt: 256, lfoDest: 0, phaserFdbk: 256, delayFdbk: 256, decimator: 256 };
    for (const p of [lo, hi, odd]) for (const sr of [44100, 48000]) {
      const [L, R] = render(p, [{ key: 0, vel: 128, start: 0, dur: 0.1 }, { key: 127, vel: 1, start: 0.05, dur: 0.1 }, { key: 60, start: 0.1, dur: 0.1 }], 0.4, { sr });
      for (let i = 0; i < L.length; i++) { expect(Number.isFinite(L[i])).toBe(true); expect(Number.isFinite(R[i])).toBe(true); }
    }
  });

  it('plays through a channel: the plugin applies the channel levels and keeps its release after the note off', () => {
    const e = makeEngine();
    const ch = createGenChannel('minisynth');
    ch.volume = 1;
    ch.plugin!.params = { ...defaultGenParams('minisynth'), ampRel: 160 };
    const [L, R] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 6, key: 60 }] }, 24000);
    expect(rms(L, 0, 6000)).toBeGreaterThan(0.01);
    // the note ends at 6000 frames (one step at 120 BPM / 48 kHz): the synth's release continues
    expect(rms(L, 6500, 8000)).toBeGreaterThan(1e-4);
    for (let i = 0; i < L.length; i++) expect(L[i]).toBe(R[i]);
  });
});
