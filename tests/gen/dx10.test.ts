// DX10 (FL: Fruity DX10): registration (FL's form, parameter list, value texts,
// 59 factory presets, fresh state) and the sound, pinned to renders of FL's real
// plugin (scratchpad flfxhost, FL 2026): the engine is a line-by-line float32 port
// and reproduces FL's samples exactly (until a voice's last FL block, see
// docs/research/gen/dx10.md). Renders go through the real instrument channel at
// channel volume 1 (= the host's --chan-vol 100), root key C5, like the host.
import { describe, it, expect } from 'vitest';
import { genDef, genPresetState, defaultGenParams, formatParam, genInCategory, normalizeGenParams } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { GenChannel } from '../../src/engine/GenChannel';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';
import type { GenVoiceParams } from '../../src/engine/gen/types';
import type { SeqNote } from '../../src/engine/Sequencer';
import { createGenChannel } from '../../src/model/defaults';
import type { Channel } from '../../src/model/types';
import { DX10_DEFAULT_PATCH, DX10_KEYS } from '../../src/model/gen/plugins/dx10';

const D = genDef('dx10')!;
const f = Math.fround;

interface N { key: number; vel?: number; start: number; dur: number; pan?: number; fine?: number }

/**
 * Render notes (times in s) through an instrument channel holding DX10 with `params`
 * (over FL's fresh state), sample-accurately: parameter changes (`at`) and channel
 * changes (`chan`: volume knob, pan, pitch knob) apply at their exact sample.
 */
function render(params: Record<string, number>, notes: N[], seconds: number, o: {
  sr?: number; at?: [number, Record<string, number>][]; chan?: [number, Partial<Channel>][];
} = {}): [Float32Array, Float32Array] {
  const sr = o.sr ?? 44100, block = 128;
  const frames = Math.round(seconds * sr);
  const ch = createGenChannel('dx10');
  ch.volume = 1;
  ch.plugin!.params = { ...defaultGenParams('dx10'), ...params };
  const ctx = { sampleRate: sr, blockSize: block, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
  const c = new GenChannel(ch.id, sr, block, 'dx10', { sample: () => undefined }, ctx);
  c.setGlobals({ tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } as never);
  c.apply(ch);
  type Ev = { f: number; run: () => void };
  const evs: Ev[] = [];
  for (const [t, p] of o.at ?? []) evs.push({ f: Math.round(t * sr), run: () => { ch.plugin!.params = { ...ch.plugin!.params, ...p }; c.apply(ch); } });
  for (const [t, p] of o.chan ?? []) evs.push({ f: Math.round(t * sr), run: () => { Object.assign(ch, p); c.apply(ch); } });
  evs.sort((a, b) => a.f - b.f);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const bL = new Float32Array(block), bR = new Float32Array(block);
  let ei = 0;
  for (let s0 = 0; s0 < frames;) {
    while (ei < evs.length && evs[ei].f <= s0) evs[ei++].run();
    let m = Math.min(block, frames - s0);
    if (ei < evs.length && evs[ei].f < s0 + m) m = evs[ei].f - s0;
    for (const n of notes) {
      const nf = Math.round(n.start * sr);
      if (nf < s0 || nf >= s0 + m) continue;
      const sn = { pos: 0, len: 0, oneShot: false, key: n.key, vel: n.vel ?? 100, rel: 64, pan: Math.round(64 + 64 * (n.pan ?? 0)),
        fine: n.fine ?? 120, modX: 128, modY: 128, slide: false, porta: false, color: 0, chId: ch.id } as SeqNote;
      c.scheduleNote(sn, nf - s0, Math.round(n.dur * sr));
    }
    bL.fill(0); bR.fill(0);
    c.render(bL.subarray(0, m), bR.subarray(0, m), m);
    L.set(bL.subarray(0, m), s0); R.set(bR.subarray(0, m), s0);
    s0 += m;
  }
  return [L, R];
}

/**
 * Render like the FL test host does: FL processes in blocks (at most 512 samples from
 * each split, split at note on / off and at ticks: 212.02 samples at 130 BPM), and the
 * channel's render call is that block here. DX10 checks a voice (end, modulator
 * envelopes) after each block and FL kills finished voices there, so with FL's block
 * structure even the voice ends are FL's. `maxPoly`: FL's FPE_MaxPoly (0 = none, as the
 * host sends none by default).
 */
function renderFlBlocks(params: Record<string, number>, notes: N[], seconds: number, maxPoly = 0): Float32Array {
  const sr = 44100, B = 512, spt = (sr * 60) / (130 * 96);
  const frames = Math.round(seconds * sr);
  const ch = createGenChannel('dx10');
  ch.volume = 1;
  ch.sampler.polyMax = 0;
  ch.plugin!.params = { ...defaultGenParams('dx10'), ...params };
  const ctx = { sampleRate: sr, blockSize: B, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
  const c = new GenChannel(ch.id, sr, B, 'dx10', { sample: () => undefined }, ctx);
  c.setGlobals({ tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } as never);
  c.apply(ch);
  (c.inst as unknown as { setMaxPoly(n: number): void }).setMaxPoly(maxPoly);
  const cuts = [...new Set(notes.flatMap((n) => [Math.round(n.start * sr), Math.round((n.start + n.dur) * sr)]))].sort((a, b) => a - b);
  const L = new Float32Array(frames), bL = new Float32Array(B), bR = new Float32Array(B);
  let k = 1;
  for (let t = 0; t < frames;) {
    while (Math.floor(k * spt) <= t) k++;
    let n = Math.min(B, frames - t);
    const cut = cuts.find((e) => e > t);
    if (cut !== undefined && cut < t + n) n = cut - t;
    if (Math.floor(k * spt) < t + n) n = Math.floor(k * spt) - t;
    for (const nn of notes) {
      if (Math.round(nn.start * sr) !== t) continue;
      c.scheduleNote({ pos: 0, len: 0, oneShot: false, key: nn.key, vel: nn.vel ?? 100, rel: 64, pan: 64, fine: 120, modX: 128, modY: 128,
        slide: false, porta: false, color: 0, chId: ch.id } as SeqNote, 0, Math.round(nn.dur * sr));
    }
    bL.fill(0); bR.fill(0);
    c.render(bL.subarray(0, n), bR.subarray(0, n), n);
    L.set(bL.subarray(0, n), t);
    t += n;
  }
  return L;
}

/** Expect FL's float32 samples [index, value] exactly. */
function pinned(b: Float32Array, samples: [number, number][]): void {
  for (const [i, v] of samples) expect(b[i], `sample ${i}`).toBe(f(v));
}

function rms(b: Float32Array, a = 0, z = b.length): number {
  let s = 0;
  for (let i = a; i < z; i++) s += b[i] * b[i];
  return Math.sqrt(s / (z - a));
}

/** Frequency from upward zero crossings between two times (s). */
function freq(b: Float32Array, sr: number, t0: number, t1: number): number {
  let first = -1, last = -1, n = 0;
  for (let i = Math.round(t0 * sr) + 1; i < Math.round(t1 * sr); i++) {
    if (b[i - 1] < 0 && b[i] >= 0) {
      const x = i - 1 + b[i - 1] / (b[i - 1] - b[i]);
      if (first < 0) first = x; else n++;
      last = x;
    }
  }
  return n > 0 ? (n * sr) / (last - first) : 0;
}

function lastNonZero(b: Float32Array): number {
  for (let i = b.length - 1; i >= 0; i--) if (b[i] !== 0) return i;
  return -1;
}

describe('DX10: registration', () => {
  it('has FL\'s parameters, ranges, form reset values and panel', () => {
    expect(D.name).toBe('DX10');
    expect(D.category).toBe('Synth classic');
    expect(genInCategory('Synth classic').map((d) => d.id)).toContain('dx10');
    expect([D.notes, D.ins, D.levels, D.velocity ?? 'levels', D.defPoly]).toEqual(['voices', true, 'plugin', 'levels', 16]);
    expect([D.width, D.height]).toEqual([536, 340]);
    expect(D.params.map((q) => [q.index, q.key, q.name, q.min, q.max, q.def])).toEqual([
      [0, 'attack', 'Attack', 0, 65536, 0],
      [1, 'decay', 'Decay', 0, 65536, 42598],
      [2, 'release', 'Release', 0, 65536, 28901],
      [3, 'mod1Coarse', 'Mod 1 Coarse', 0, 65536, 55706],
      [4, 'mod1Fine', 'Mod 1 Fine', 0, 65536, 21561],
      [5, 'mod1Init', 'Mod 1 Init', 0, 65536, 15073],
      [6, 'mod1Decay', 'Mod 1 Decay', 0, 65536, 52429],
      [7, 'mod1Sustain', 'Mod 1 Sustain', 0, 65536, 3277],
      [8, 'mod1Release', 'Mod 1 Release', 0, 65536, 52429],
      [9, 'mod1Vel', 'Mod 1 Velocity', 0, 65536, 58982],
      [10, 'vibrato', 'Vibrato', 0, 65536, 0],
      [11, 'waveform', 'Waveform', 0, 65536, 29295],
      [12, 'modThru', 'Mod Thru', 0, 65536, 0],
      [13, 'lfoRate', 'LFO Rate', 0, 65536, 27132],
      [14, 'mod2Coarse', 'Mod 2 Coarse', 0, 65536, 55706],
      [15, 'mod2Fine', 'Mod 2 Fine', 0, 65536, 21561],
      [16, 'mod2Init', 'Mod 2 Init', 0, 65536, 15073],
      [17, 'mod2Decay', 'Mod 2 Decay', 0, 65536, 52429],
      [18, 'mod2Sustain', 'Mod 2 Sustain', 0, 65536, 3277],
      [19, 'mod2Release', 'Mod 2 Release', 0, 65536, 52429],
      [20, 'mod2Vel', 'Mod 2 Velocity', 0, 65536, 58982],
      [21, 'octave', 'Coarse', -3, 3, 0],
    ]);
  });

  it('writes FL\'s value texts (flfxhost sweep; all 1,376,284 checked against FL)', () => {
    const text = (key: string, v: number) => formatParam(D.params.find((q) => q.key === key)!, v);
    const cases: [string, [number, string][]][] = [
      ['attack', [[0, '0%'], [327, '0%'], [328, '1%'], [8192, '13%'], [24576, '38%'], [32767, '50%'], [42598, '65%'], [65535, '100%']]],
      ['mod1Coarse', [[0, '      0'], [21561, '      4'], [32768, '     10'], [55181, '     28'], [55706, '     28'], [65536, '     40']]],
      ['mod1Fine', [[4634, '  0.001'], [21561, '  0.022'], [32767, '  0.050'], [32768, '  0.250'], [40000, '  0.333'], [42598, '  0.500'], [55181, '  0.667'], [55706, '  0.750']]],
      ['modThru', [[0, '   0.00'], [4634, '   0.12'], [21561, '   2.71'], [32768, '   6.25'], [55706, '  18.06'], [65536, '  25.00']]],
      ['octave', [[-3, '     -3'], [0, '      0'], [3, '      3']]],
    ];
    for (const [k, list] of cases) for (const [v, t] of list) expect(text(k, v), `${k} ${v}`).toBe(t);
  });

  it('has FL\'s 59 factory presets with their exact values', () => {
    const ps = D.presets!;
    expect(ps.length).toBe(59);
    expect(ps.slice(0, 4).map((p) => p.name)).toEqual(['Bang Bass', 'Bass Pluck', 'Bright E.Piano', 'Chiff Organ']);
    expect(ps.slice(-3).map((p) => p.name)).toEqual(['Upright Bass 1', 'Upright Bass 2', 'Violin']);
    const robot = genPresetState('dx10', ps.find((p) => p.name === 'Robot')!);
    expect(DX10_KEYS.map((k) => robot[k])).toEqual([65536, 56945, 47104, 6, 38144, 21248, 65536, 37972, 55757, 65536, 10381, 35381, 38347, 9388, 1, 52992, 37632, 65536, 35584, 37888, 52992, 1]);
    const ship = genPresetState('dx10', ps.find((p) => p.name === 'Spaceship')!);
    expect(ship.octave).toBe(-3);
    for (const p of ps) for (const k of DX10_KEYS) expect(typeof p.params[k], `${p.name} ${k}`).toBe('number');
  });

  it('starts a fresh instance with FL\'s constructor state = the Default preset (form reset values differ)', () => {
    const fresh = defaultGenParams('dx10');
    expect(DX10_KEYS.map((k) => fresh[k])).toEqual([...DX10_DEFAULT_PATCH]);
    const def = genPresetState('dx10', D.presets!.find((p) => p.name === 'Default')!, fresh);
    expect(DX10_KEYS.map((k) => def[k])).toEqual([...DX10_DEFAULT_PATCH]);
    // Mod 1 Coarse resets to 55706 and Mod 2 to an active modulator, but a new instance has 55181 and Mod 2 off
    expect([fresh.mod1Coarse, D.params[3].def]).toEqual([55181, 55706]);
    expect([fresh.mod2Init, D.params[16].def]).toEqual([0, 15073]);
    expect(normalizeGenParams('dx10', {}).mod1Coarse).toBe(55181);
  });
});

describe('DX10: sound, pinned to FL', () => {
  it('plays the default patch (key 60, velocity 100) sample for sample like FL', () => {
    const [L, R] = render({}, [{ key: 60, start: 0, dur: 0.5 }], 1.0);
    pinned(L, [[0, 0.0006579676], [1, 0.0042694965], [2, 0.012336077], [3, 0.024553226], [7, 0.06835536], [111, -0.336586],
      [1000, -0.07815586], [5000, -0.30723134], [10000, 0.2568483], [22049, -0.161542], [22050, -0.16302845], [30000, 0.0013036324],
      [40000, 0.00028051977]]);
    expect(R).toEqual(L);
    expect(rms(L, 0, 22050)).toBeCloseTo(0.200068427, 8);
  });

  it('tracks the key and the velocity (modulation depth) and runs at 48 kHz like FL', () => {
    pinned(render({}, [{ key: 36, start: 0, dur: 0.4 }], 0.5)[0], [[5, 0.009313254], [500, -0.28829265], [9000, 0.26354697], [17000, 0.23730062]]);
    pinned(render({}, [{ key: 84, start: 0, dur: 0.4 }], 0.5)[0], [[5, 0.0748063], [500, -0.14981343], [9000, -0.23722695], [17000, 0.117339656]]);
    pinned(render({}, [{ key: 60, vel: 64, start: 0, dur: 0.4 }], 0.3)[0], [[50, 0.1179331], [2000, -0.06011879], [12000, 0.091673315]]);
    pinned(render({}, [{ key: 60, vel: 127, start: 0, dur: 0.4 }], 0.3)[0], [[50, 0.64053524], [2000, -0.26749167], [12000, 0.5305196]]);
    pinned(render({}, [{ key: 60, start: 0, dur: 0.4 }], 0.7, { sr: 48000 })[0], [[50, 0.3230325], [2000, -0.108142786], [12000, 0.10025924], [30000, -0.0021239845]]);
    pinned(render({ octave: -3 }, [{ key: 60, start: 0, dur: 0.4 }], 0.1)[0], [[300, 0.3358717], [3000, 0.2824346]]);
    pinned(render({ octave: 3 }, [{ key: 60, start: 0, dur: 0.4 }], 0.1)[0], [[300, 0.33398888], [3000, 0.20862211]]);
    // note fine pitch +40 cents (FL: fine=40)
    pinned(render({}, [{ key: 60, start: 0, dur: 0.4, fine: 124 }], 0.1)[0], [[400, 0.1880146], [4000, 0.3068679]]);
  });

  it('plays the vibrato LFO, Mod 2, Mod Thru, the presets and note panning like FL', () => {
    pinned(render({ vibrato: 50000, lfoRate: 40000 }, [{ key: 60, start: 0, dur: 1.0 }], 1.0)[0], [[3000, -0.29988718], [20000, -0.12636858], [40000, 0.08142348], [44000, 0.14661148]]);
    pinned(render({ mod2Coarse: 30000, mod2Fine: 40000, mod2Init: 40000, mod2Decay: 30000, mod2Sustain: 20000, mod2Release: 30000, mod2Vel: 10000 },
      [{ key: 60, start: 0, dur: 0.6 }], 0.7)[0], [[100, -0.3361221], [5000, 0.23719156], [20000, 0.2250786], [30000, -0.050623517]]);
    pinned(render({ modThru: 50000, waveform: 60000 }, [{ key: 48, start: 0, dur: 0.6 }], 0.2)[0], [[500, -0.19131453], [6000, -0.15943027]]);
    const robot = genPresetState('dx10', D.presets!.find((p) => p.name === 'Robot')!) as Record<string, number>;
    pinned(render(robot, [{ key: 55, start: 0, dur: 0.8 }], 2.0)[0], [[100, 0.00038777845], [10000, -0.014722742], [40000, -0.099367455], [80000, 0.0029848088]]);
    // note pan -0.625 (FL note pan 24): FL's float32 circular pan law
    const [pl, pr] = render({}, [{ key: 60, start: 0, dur: 0.4, pan: -0.625 }], 0.1);
    pinned(pl, [[100, -0.42705622], [3000, -0.28773186]]);
    pinned(pr, [[100, -0.12954608], [3000, -0.0872825]]);
  });

  it('reacts to parameter and pitch changes during a note like FL', () => {
    // Waveform changes at once; envelopes and frequencies keep their trigger values
    pinned(render({}, [{ key: 60, start: 0, dur: 0.6 }], 0.4, { at: [[0.2, { waveform: 60000 }]] })[0],
      [[8000, 0.081034414], [8820, 0.5111094], [9000, 0.44973654], [15000, 0.017862115]]);
    // a pitch change (channel pitch +200 cents) retunes the carrier and modulators
    pinned(render({ decay: 65536 }, [{ key: 60, start: 0, dur: 0.8 }], 0.7, { chan: [[0.25, { pitch: 1 }]] })[0],
      [[11025, 0.11968664], [11030, 0.12487267], [11100, -0.062609725], [30000, -0.29151163]]);
  });

  it('sounds an octave below FL\'s C5 at key 60, as FL\'s DX10 does (Coarse wheel = octaves)', () => {
    const pure = { mod1Init: 0, mod1Sustain: 0, decay: 65536 };
    const at = (key: number, octave = 0) => freq(render({ ...pure, octave }, [{ key, start: 0, dur: 1 }], 0.9)[0], 44100, 0.2, 0.85);
    expect(at(60)).toBeCloseTo(261.63, 1); // FL: 261.63 Hz
    expect(at(72)).toBeCloseTo(523.25, 1);
    expect(at(48)).toBeCloseTo(130.81, 1);
    expect(at(60, -3)).toBeCloseTo(32.70, 1);
    expect(at(60, 3)).toBeCloseTo(2093.0, 0);
    pinned(render(pure, [{ key: 60, start: 0, dur: 1 }], 0.7)[0], [[0, 0.0006579676], [1, 0.0025448906], [1000, -0.1029781], [30000, -0.02993847]]);
  });

  it('ends a voice after the block in which its envelope falls below 0.0002 (FL: last sample 41554)', () => {
    // with FL's block structure: FL's samples to the last one
    const fl = renderFlBlocks({}, [{ key: 60, start: 0, dur: 0.5 }], 1.2);
    pinned(fl, [[30000, 0.0013036324], [41500, 0.0001593043], [41553, -6.061386e-05], [41554, -6.641629e-05]]);
    expect(lastNonZero(fl)).toBe(41554);
    // in the engine's 128-sample blocks it ends at the end of its block
    const [L] = render({}, [{ key: 60, start: 0, dur: 0.5 }], 1.2);
    const end = lastNonZero(L);
    expect(end % 128).toBe(127);
    expect(Math.abs(end - 41554)).toBeLessThan(512);
    // with Decay at its top the note holds; low velocities end earlier (FL's absolute threshold)
    const [held] = render({ decay: 65536 }, [{ key: 60, start: 0, dur: 1.5 }], 1.6);
    expect(rms(held, 60000, 66000)).toBeGreaterThan(0.1);
    const [soft] = render({}, [{ key: 60, vel: 1, start: 0, dur: 0.5 }], 1.2);
    expect(lastNonZero(soft)).toBeLessThan(end - 4000);
  });

  it('steps its single vibrato LFO from every voice and clears modulator envelopes per block, like FL', () => {
    // FL's shared LFO advances from each voice's own counter within each block: exact with FL's blocks
    pinned(renderFlBlocks({ vibrato: 60000, lfoRate: 50000 }, [{ key: 60, start: 0, dur: 1.0 }, { key: 67, start: 0.05, dur: 1.0 }], 1.5),
      [[2205, -0.18001772], [3000, 0.07023889], [20000, 0.015516445], [40000, 0.20393077], [60000, -0.0011356847]]);
    // Bass Pluck: the modulator decays to zero and is cleared below 2^-24 at a block end
    const pluck = genPresetState('dx10', D.presets!.find((p) => p.name === 'Bass Pluck')!) as Record<string, number>;
    pinned(renderFlBlocks(pluck, [{ key: 45, start: 0, dur: 0.7 }], 1.0), [[5000, 0.24836797], [40000, -0.0061487113]]);
  });

  it('steals the quietest voice at FL\'s max polyphony (FPE_MaxPoly; FL sends DefPoly 16 at load)', () => {
    const inst = createGen('dx10', 44100, 128) as unknown as { maxPoly: number };
    expect(inst.maxPoly).toBe(16);
    // max polyphony 2: the third note silences the oldest of two equal voices (FL's voice list order)
    const L = renderFlBlocks({ decay: 65536, release: 0 }, [{ key: 60, start: 0, dur: 1 }, { key: 64, start: 0.1, dur: 1.1 }, { key: 67, start: 0.2, dur: 0.7 }], 1.4, 2);
    pinned(L, [[22050, -0.470439076423645], [30000, 0.6752433180809021], [44100, -0.3374903202056885], [46305, 0.2819214463233948], [50000, -0.2806451618671417]]);
  });

  it('applies channel level changes with FL\'s ramp (at most 0.001 per sample, no fade-in)', () => {
    const [a] = render({ decay: 65536 }, [{ key: 60, start: 0, dur: 0.8 }], 0.5);
    const [b] = render({ decay: 65536 }, [{ key: 60, start: 0, dur: 0.8 }], 0.5, { chan: [[0.25, { volume: 0.5 }]] });
    const t = Math.round(0.25 * 44100);
    // identical before the change; after it the gain (0.7071 at the centre) steps down by 0.001 per sample
    for (let i = 0; i < t; i++) expect(b[i]).toBe(a[i]);
    const g = (i: number) => (b[i] / a[i]) * 0.70710677;
    expect(g(t)).toBeCloseTo(0.70710677, 6);
    expect(g(t + 1)).toBeCloseTo(0.70710677 - 0.001, 6);
    expect(g(t + 10)).toBeCloseTo(0.70710677 - 0.010, 6);
    // the target: FL's LogVol(0.5) x cos(pi/4)
    expect(g(t + 2000)).toBeCloseTo(((11 ** 0.5 - 1) / 10) * Math.SQRT1_2, 6);
  });

  it('stays finite at extreme settings and keys, and with parameter changes mid-voice', () => {
    const top: Record<string, number> = {}, zero: Record<string, number> = {};
    for (const q of D.params) { top[q.key] = q.max; zero[q.key] = q.min; }
    for (const p of [top, zero, { ...top, attack: 0, decay: 0, release: 0 }, { ...zero, mod1Init: 65536, mod1Coarse: 65536, mod2Init: 65536, mod2Coarse: 65536, vibrato: 65536, lfoRate: 65536 }]) {
      for (const key of [0, 131]) {
        const [L, R] = render(p, [{ key, vel: 128, start: 0, dur: 0.05 }, { key: 60, vel: 1, start: 0.01, dur: 0.05 }], 0.15);
        for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
      }
    }
    const inst = createGen('dx10', 44100, 128)!;
    inst.setParams(defaultGenParams('dx10'));
    const init = newLevels(), levels = newLevels();
    setInitLevels(init, 0, 100, 0, 0, 0);
    Object.assign(levels, init);
    const vp: GenVoiceParams = { key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
    const v = inst.triggerVoice!(vp)!;
    const b = new Float32Array(16), r = new Float32Array(16);
    v.render(b, r, 16);
    inst.setParams({ ...defaultGenParams('dx10'), waveform: Number.NaN, modThru: 1e9, octave: -99 });
    levels.pitch = Number.NaN;
    levels.vol = Number.POSITIVE_INFINITY;
    b.fill(0);
    v.render(b, r, 16);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(b[i])).toBe(true);
    expect(inst.monitor!()).toEqual({ keys: [60] });
    v.release();
    expect(inst.monitor!()).toEqual({ keys: [] });
  });
});
