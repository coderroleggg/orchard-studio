// 3x Osc (FL: 3x Osc): registration (FL's form / parameter list / value texts /
// Default patch) and the sound, pinned to FL Studio 2026's own plugin rendered
// by the test host (flfxhost render "3x Osc", raw channel, key 60 at 523.25 Hz,
// --fixed-time 1700000000 for the random generators): the numbers below are
// FL's output samples, which this port reproduces bit for bit.
import { describe, it, expect } from 'vitest';
import { def, DEFAULT_PATCH, panText, pctText, unitText } from '../../src/model/gen/plugins/3xosc';
import { gen, seed3xOscRandom, resetHqNoise } from '../../src/engine/gen/plugins/3xosc';
import { fma32, sinf } from '../../src/engine/gen/plugins/3xosc/hq';
import { FL_TABLES, FADE } from '../../src/engine/gen/plugins/3xosc/tables';
import { newLevels, PITCH_C5 } from '../../src/engine/gen/levels';
import type { GenVoice, GenVoiceParams } from '../../src/engine/gen/types';
import { formatParam } from '../../src/model/gen/registry';
import { GenChannel } from '../../src/engine/GenChannel';
import { createGenChannel } from '../../src/model/defaults';
import type { SeqNote } from '../../src/engine/Sequencer';

const fr = Math.fround;
const KEYS = ['pan1', 'shape1', 'coarse1', 'fine1', 'phase1', 'detune1', 'mix2', 'pan2', 'shape2', 'coarse2', 'fine2', 'phase2', 'detune2',
  'mix3', 'pan3', 'shape3', 'coarse3', 'fine3', 'phase3', 'detune3', 'rand'];
const CTOR: Record<string, unknown> = Object.fromEntries(KEYS.map((k) => [k, 0]));
const SWITCHES = { inv1: false, inv2: false, inv3: false, am: false, hq: false, sample: '' };

/** FL's InitLevels.Vol for a velocity (single precision, as FL computes it). */
function flVol(vel: number): number {
  if (vel === 100) return 1;
  const s = fr(fr(vel * fr(0.01)) * fr(2.397895336151123));
  return fr((Math.exp(s) - 1) * fr(0.1));
}

interface Note { key: number; vel?: number; start: number; end: number; pan?: number }

/**
 * Render single 3x Osc notes directly: FL blocks of `block` frames (the test
 * host's first block is one tick, 212 samples at 44.1 kHz / 130 BPM),
 * rendered in steps of up to 16 frames, the note off at its exact sample.
 */
function render(params: Record<string, unknown>, notes: Note[], frames: number, o: { sr?: number; block?: number } = {}): [Float32Array, Float32Array] {
  const sr = o.sr ?? 44100, B = o.block ?? 212;
  seed3xOscRandom(1700000000);
  resetHqNoise();
  const inst = gen.create(sr, 128, { sample: () => undefined }) as ReturnType<typeof gen.create> & { setBlockLength(n: number): void };
  inst.setParams({ ...CTOR, ...SWITCHES, ...params });
  inst.setBlockLength(B);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const live: { v: GenVoice; p: GenVoiceParams; n: Note }[] = [];
  for (let t = 0; t < frames; t += B) {
    for (const n of notes) {
      if (n.start !== t) continue;
      const init = newLevels(), levels = newLevels();
      levels.pitch = PITCH_C5 + (n.key - 60) * 100;
      levels.vol = flVol(n.vel ?? 100);
      levels.pan = n.pan ?? 0;
      const p: GenVoiceParams = { key: n.key, velocity: n.vel ?? 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
      const v = inst.triggerVoice!(p);
      if (v) live.push({ v, p, n });
    }
    const m = Math.min(B, frames - t);
    for (const x of live) {
      for (let o2 = 0; o2 < m;) {
        let k = Math.min(16, m - o2);
        const rel = x.n.end - (t + o2);
        if (rel === 0) x.v.release();
        else if (rel > 0 && rel < k) k = rel;
        x.p.frame = o2;
        x.v.render(L.subarray(t + o2, t + o2 + k), R.subarray(t + o2, t + o2 + k), k);
        o2 += k;
      }
    }
  }
  return [L, R];
}

describe('3x Osc: registration', () => {
  it("has FL's parameters, ranges, defaults and form size", () => {
    expect(def.name).toBe('3x Osc');
    expect(def.category).toBe('Synth classic');
    expect(def.notes).toBe('voices');
    expect(def.ins).toBe(true);
    expect(def.levels).toBe('plugin');
    expect(def.velocity ?? 'levels').toBe('levels');
    expect(def.defPoly).toBe(0);
    expect([def.width, def.height]).toEqual([558, 389]);
    expect(def.params.map((q) => q.index)).toEqual([...Array(21).keys()]);
    expect(def.params.map((q) => q.key)).toEqual(KEYS);
    expect(def.params.map((q) => [q.name, q.min, q.max, q.def])).toEqual([
      ['Osc 1 panning', -64, 64, 0], ['Osc 1 shape', 0, 6, 0], ['Osc 1 coarse pitch', -24, 24, 0], ['Osc 1 fine pitch', -100, 100, 0],
      ['Osc 1 stereo phase offset', -64, 64, 0], ['Osc 1 stereo detune', -50, 50, 0],
      ['Osc 2 mix level', 0, 128, 64], ['Osc 2 panning', -64, 64, 0], ['Osc 2 shape', 0, 6, 0], ['Osc 2 coarse pitch', -24, 24, 0],
      ['Osc 2 fine pitch', -100, 100, 0], ['Osc 2 stereo phase offset', -64, 64, 0], ['Osc 2 stereo detune', -50, 50, 0],
      ['Osc 3 mix level', 0, 128, 64], ['Osc 3 panning', -64, 64, 0], ['Osc 3 shape', 0, 6, 0], ['Osc 3 coarse pitch', -24, 24, 0],
      ['Osc 3 fine pitch', -100, 100, 0], ['Osc 3 stereo phase offset', -64, 64, 0], ['Osc 3 stereo detune', -50, 50, 0],
      ['Stereo phase randomness', 0, 64, 0],
    ]);
    expect(def.params[1].options).toEqual(['Sine', 'Triangle', 'Square', 'Saw', 'Rounded saw', 'Noise', 'Custom']);
  });

  it("writes FL's value texts (test host sweeps)", () => {
    const P = (k: string) => def.params.find((q) => q.key === k)!;
    const t = (k: string, vs: number[]) => vs.map((v) => formatParam(P(k), v));
    expect(t('pan1', [-64, -63, -40, -24, -8, -1, 0, 1, 8, 24, 40, 64])).toEqual(
      ['100% left', '98% left', '62% left', '38% left', '12% left', '2% left', 'Centered', '2% right', '12% right', '38% right', '62% right', '100% right']);
    expect(t('phase1', [-64, -40, -8, -1, 0, 1, 8, 40, 56, 64])).toEqual(['-100%', '-63%', '-13%', '-2%', '0%', '2%', '13%', '63%', '88%', '100%']);
    expect(t('mix2', [0, 1, 16, 17, 64, 80, 127, 128])).toEqual(['0%', '1%', '13%', '13%', '50%', '63%', '99%', '100%']);
    expect(t('rand', [0, 1, 8, 40, 63, 64])).toEqual(['0%', '2%', '13%', '63%', '98%', '100%']);
    expect(t('coarse2', [-24, -12, -2, -1, 0, 1, 9, 24])).toEqual(['-24 semitones', '-12 semitones', '-2 semitones', '-1 semitone', '+0 semitone', '+1 semitone', '+9 semitones', '+24 semitones']);
    expect(t('fine1', [-100, -1, 0, 1, 13, 100])).toEqual(['-100 cents', '-1 cent', '+0 cent', '+1 cent', '+13 cents', '+100 cents']);
    expect(t('detune3', [-50, -1, 0, 1, 15])).toEqual(['-50 cents', '-1 cent', '+0 cent', '+1 cent', '+15 cents']);
    expect(t('shape1', [0, 6])).toEqual(['', '']);
    expect(panText(-56)).toBe('88% left');
    expect(pctText(-56, 64)).toBe('-88%');
    expect(unitText(-12, 'semitone')).toBe('-12 semitones');
  });

  it("starts with FL's Default patch and has it as the factory preset", () => {
    const st = def.state!();
    expect(st).toMatchObject({ mix2: 64, coarse2: -12, mix3: 32, coarse3: -24, shape1: 0, pan1: 0, rand: 0, ...SWITCHES });
    expect(def.presets!.map((p) => p.name)).toEqual(['Default']);
    expect(def.presets![0].params).toEqual({ ...DEFAULT_PATCH, inv1: false, inv2: false, inv3: false, am: false, hq: false });
    expect(def.normalize!({ ...st, hq: 1, sample: 3 })).toMatchObject({ hq: false, sample: '' });
  });
});

describe('3x Osc: tables', () => {
  it("are FL's host wavetables and FL's release fade", () => {
    expect(FL_TABLES.map((t) => t.length)).toEqual([16384, 16384, 16384, 16384, 16384, 16384]);
    expect(FL_TABLES[0][4096]).toBe(1);
    expect(FL_TABLES[1][0]).toBe(0);
    expect(FL_TABLES[1][4096]).toBe(1);
    expect(FL_TABLES[3][0]).toBe(-1);
    expect(FL_TABLES[4][0]).toBe(-1);
    expect(FL_TABLES[4][7600]).toBe(1);
    expect(FL_TABLES[4][13653]).toBe(-1);
    expect([FL_TABLES[4][1], FL_TABLES[4][100], FL_TABLES[4][7599]]).toEqual([-0.993987858, -0.480941176, 1].map(fr));
    // FL's noise table (Mersenne Twister with FL's off-by-one twist), as FLEngine builds it
    expect([FL_TABLES[5][0], FL_TABLES[5][1], FL_TABLES[5][2], FL_TABLES[5][16383]]).toEqual([0.0829383582, -0.775481462, 0.945165575, -0.954082906].map(fr));
    expect(FADE.length).toBe(441);
    expect(FADE[0]).toBe(fr(0.999987364));
    expect(FADE[440]).toBe(fr(1.26361847e-5));
  });

  it("computes macOS's sinf and exact single-precision fused multiply-adds", () => {
    expect(sinf(fr(1))).toBe(fr(0.841470957));
    expect(sinf(fr(5.5))).toBe(fr(-0.705540299));
    // where macOS's sinf is not correctly rounded
    expect(sinf(fr(1.00000596))).toBe(fr(0.841474235));
    expect(fr(Math.sin(fr(1.00000596)))).toBe(fr(0.841474175));
    // fused: one rounding (unfused would give 0), and a double-rounding tie resolved by the exact value
    expect(fma32(fr(1 + 2 ** -13), fr(1 - 2 ** -13), -1)).toBe(-(2 ** -26));
    expect(fma32(fr(1 + 2 ** -23), fr(1 - 2 ** -23), 16777218)).toBe(16777218);
    expect(fma32(1, 1, fr(2 ** -25))).toBe(1);
  });
});

describe("3x Osc: sound (FL's samples)", () => {
  const N = 23000;
  it('plays the Default patch like FL, including the release fade', () => {
    const [L, R] = render(DEFAULT_PATCH, [{ key: 60, start: 0, end: 22050 }], N);
    expect([L[1], L[2], L[3], L[100], L[1000], L[22049], L[22050], L[22300], L[22490], L[22491]]).toEqual(
      [0.0232108217, 0.0463820174, 0.0694007576, 0.188812152, -0.244080886, -0.227163821, -0.236786932, 0.0700400472, -2.38239863e-6, 0].map(fr));
    expect(R).toEqual(L);
    for (let i = 22491; i < N; i++) expect(L[i]).toBe(0);
  });

  it('plays the constructor state (oscillator 1 only) at 0.5 peak and 48 kHz', () => {
    const [L] = render(CTOR, [{ key: 60, start: 0, end: 22050 }], 2000);
    expect([L[1], L[2], L[3], L[100]]).toEqual([0.0371647254, 0.0741238371, 0.110859834, 0.460682482].map(fr));
    let pk = 0;
    for (const v of L) pk = Math.max(pk, Math.abs(v));
    expect(pk).toBeLessThanOrEqual(0.5);
    const [D] = render(DEFAULT_PATCH, [{ key: 60, start: 0, end: 24000 }], 24500, { sr: 48000 });
    expect([D[1], D[2], D[3], D[100], D[24000], D[24440], D[24441]]).toEqual([0.0212966707, 0.0426448584, 0.0637380779, 0.171944901, -0.236786932, 2.44199828e-6, 0].map(fr));
  });

  it('plays the saw, panning and AM like FL', () => {
    const [S] = render({ shape1: 3 }, [{ key: 60, start: 0, end: 22050 }], 1100);
    expect([S[1], S[2], S[3], S[100], S[1000]]).toEqual([-0.48815915, -0.47631833, -0.464416504, -0.313537598, 0.36505127].map(fr));
    const [PL, PR] = render({ ...DEFAULT_PATCH, pan1: -40, pan2: 64, pan3: 13 }, [{ key: 60, start: 0, end: 22050 }], 1100);
    expect([PL[1], PR[1], PL[2], PR[2], PL[100], PR[100], PL[1000], PR[1000]]).toEqual(
      [0.0207670014, 0.0182201266, 0.0414686948, 0.036448963, 0.332947552, 0.0615448765, -0.212081507, -0.197005212].map(fr));
    const [A] = render({ ...DEFAULT_PATCH, am: true }, [{ key: 60, start: 0, end: 22050 }], 1100);
    expect([A[1], A[2], A[100], A[1000]]).toEqual([0.0277892575, 0.0552784503, 0.0765665248, -0.30116412].map(fr));
  });

  it('plays the HQ oscillators like FL (sinf sine, mip-mapped saw)', () => {
    const [H] = render({ ...DEFAULT_PATCH, hq: true }, [{ key: 60, start: 0, end: 22050 }], 1100);
    expect([H[1], H[2], H[3], H[100], H[1000]]).toEqual([0.0232823789, 0.0464766622, 0.0694951862, 0.188767448, -0.243956029].map(fr));
    const [W] = render({ hq: true, shape1: 3 }, [{ key: 60, start: 0, end: 22050 }], 1100);
    expect([W[1], W[2], W[100], W[1000]]).toEqual([-0.572752714, -0.435253024, -0.319795728, 0.359006137].map(fr));
  });

  it('draws noise speeds and phase randomness from FPC\'s Random like FL (seed 1700000000)', () => {
    const [L, R] = render({ shape1: 5 }, [{ key: 60, start: 0, end: 22050 }], 120);
    expect([L[0], R[0], L[1], R[1], L[2], R[2], L[3], R[3], L[100], R[100]]).toEqual(
      [0.0414691754, 0.0414691754, 0.472582787, -0.112796299, -0.0331298895, 0.40387997, 0.0854607001, 0.447888106, 0.0906819999, 0.440373331].map(fr));
    const [QL, QR] = render({ ...DEFAULT_PATCH, rand: 40 }, [{ key: 60, start: 0, end: 22050 }], 120);
    expect([QL[0], QR[0], QL[1], QR[1], QL[2], QR[2], QL[100], QR[100]]).toEqual(
      [-0.180583104, 0.496922642, -0.16532813, 0.49760586, -0.149116814, 0.496943951, 0.0851736888, -0.138954192].map(fr));
  });

  it('follows the pitch level and applies parameter changes at the next block', () => {
    const freq = (b: Float32Array, a: number, z: number, sr = 44100) => {
      let first = -1, last = -1, n = 0;
      for (let i = a + 1; i < z; i++) if (b[i - 1] < 0 && b[i] >= 0) { const x = i - 1 + b[i - 1] / (b[i - 1] - b[i]); if (first < 0) first = x; else n++; last = x; }
      return (n * sr) / (last - first);
    };
    const [L] = render(CTOR, [{ key: 69, start: 0, end: 40000 }], 8000);
    expect(freq(L, 0, 8000)).toBeCloseTo(880, 0);
    // coarse +12 mid-note: one octave up from the next block on
    const inst = gen.create(44100, 128, { sample: () => undefined });
    inst.setParams({ ...CTOR, ...SWITCHES });
    const init = newLevels(), levels = newLevels();
    const p: GenVoiceParams = { key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
    const v = inst.triggerVoice!(p)!;
    const out = new Float32Array(44100), r = new Float32Array(16);
    for (let o = 0; o < 44100; o += 16) {
      if (o === 22016) inst.setParams({ ...CTOR, ...SWITCHES, coarse1: 12 });
      p.frame = o % 128;
      v.render(out.subarray(o, o + 16), r, 16);
    }
    expect(freq(out, 0, 22000)).toBeCloseTo(523.25, 0);
    expect(freq(out, 22100, 44000)).toBeCloseTo(1046.5, 0);
  });

  it('ramps the voice gain at most 0.001 per sample and declicks note offs in 441 samples at any rate', () => {
    const inst = gen.create(48000, 128, { sample: () => undefined });
    inst.setParams({ ...CTOR, ...SWITCHES });
    const init = newLevels(), levels = newLevels();
    const p: GenVoiceParams = { key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
    const v = inst.triggerVoice!(p)!;
    const out = new Float32Array(4096), r = new Float32Array(4096);
    let alive = true, end = -1;
    for (let o = 0; o < 4096; o += 16) {
      if (o === 1024) levels.vol = 0.1;
      if (o === 2048) v.release();
      p.frame = o % 128;
      alive = v.render(out.subarray(o, o + 16), r.subarray(o, o + 16), 16);
      if (!alive && end < 0) end = o + 16;
    }
    // the gain falls from 0.5 toward 0.05 by 0.001 x 0.7071 per sample from the next block on
    const peakOf = (a: number, z: number) => { let pk = 0; for (let i = a; i < z; i++) pk = Math.max(pk, Math.abs(out[i])); return pk; };
    expect(peakOf(1100, 1200)).toBeGreaterThan(0.35);
    expect(peakOf(1100, 1200)).toBeLessThan(0.46);
    expect(peakOf(1900, 2048)).toBeCloseTo(0.05, 2);
    expect(peakOf(2048 + 400, 2048 + 441)).toBeGreaterThan(0);
    expect(peakOf(2048 + 441, 4096)).toBe(0);
    expect(end).toBe(2048 + 448);
  });

  it('plays the Default patch through an instrument channel bit for bit (velocity 100 / 64 / 127)', () => {
    const sr = 44100, frames = 23000;
    const ch = createGenChannel('3xosc');
    ch.volume = 1;
    const env = { sample: () => undefined };
    const ctx = { sampleRate: sr, blockSize: 128, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
    const c = new GenChannel(ch.id, sr, 128, '3xosc', env, ctx as never);
    c.setGlobals({ tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } as never);
    c.apply(ch);
    const L = new Float32Array(frames), R = new Float32Array(frames);
    const bl = new Float32Array(128), br = new Float32Array(128);
    for (let off = 0; off < frames; off += 128) {
      if (off === 0) {
        const sn = { pos: 0, len: 0, oneShot: false, key: 60, vel: 100, rel: 64, pan: 64, fine: 120, modX: 128, modY: 128, slide: false, porta: false, color: 0, chId: ch.id } as unknown as SeqNote;
        c.scheduleNote(sn, 0, 22050);
      }
      bl.fill(0); br.fill(0);
      const n = Math.min(128, frames - off);
      c.render(bl.subarray(0, n), br.subarray(0, n), n);
      L.set(bl.subarray(0, n), off); R.set(br.subarray(0, n), off);
    }
    expect([L[1], L[2], L[3], L[100], L[1000], L[22049], L[22050], L[22300], L[22490], L[22491]]).toEqual(
      [0.0232108217, 0.0463820174, 0.0694007576, 0.188812152, -0.244080886, -0.227163821, -0.236786932, 0.0700400472, -2.38239863e-6, 0].map(fr));
  });

  it('stays finite at extreme settings and keys', () => {
    for (const p of [
      { shape1: 6, shape2: 5, shape3: 4, coarse1: 24, coarse2: 24, coarse3: 24, fine1: 100, mix2: 128, mix3: 128, rand: 64, phase1: 64, detune1: 50, pan1: -64, am: true },
      { shape1: 4, shape2: 2, shape3: 1, coarse1: -24, coarse2: -24, coarse3: -24, fine1: -100, mix2: 0, mix3: 0, inv1: true, hq: true },
      { shape1: 3, shape2: 6, shape3: 5, hq: true, am: true, mix3: 128, rand: 64 },
      { mix2: Number.NaN, coarse1: Number.POSITIVE_INFINITY, pan2: 'x' },
    ]) {
      for (const key of [0, 131]) {
        const [L, R] = render({ ...DEFAULT_PATCH, ...p }, [{ key, start: 0, end: 2000 }, { key: 131 - key, vel: 128, start: 212, end: 3000 }], 4000);
        for (let i = 0; i < L.length; i++) { expect(Number.isFinite(L[i])).toBe(true); expect(Number.isFinite(R[i])).toBe(true); }
      }
    }
  });
});
