// FL Keys (FL: FL Keys): registration (FL's 15 parameters, ranges, defaults, every value text of every parameter,
// the 9 factory presets, the plugin database state), the wavetable loader (FL's .wti rules, pool pack), the engine
// against renders of FL's own plugin (test host, 16-sample blocks) on synthetic wavetables and, where FL Studio
// is installed, on FL's own wavetables (numbers pinned in flkeys.golden.ts, nothing of FL stored here), the
// synthesized stand-ins and the editor. docs/research/gen/flkeys.md.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { genDef, defaultGenParams, formatParam, genInCategory, genPresetState, normalizeGenParams } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { GenChannel } from '../../src/engine/GenChannel';
import { createGenChannel } from '../../src/model/defaults';
import type { SeqNote } from '../../src/engine/Sequencer';
import type { GenEnv } from '../../src/engine/gen/types';
import { KEYS_CATALOG, KEYS_PARAM_KEYS, keysEntry } from '../../src/engine/gen/plugins/flkeys/catalog';
import { Ini, KeysTableError, buildKeysTable, packKeysTable, resampleKeysTable, unpackKeysTable, type KeysTable } from '../../src/engine/gen/plugins/flkeys/table';
import { synthTable } from '../../src/engine/gen/plugins/flkeys/synth';
import { synSet, synTable, type SynName } from './flkeys-syn';
import { DEFAULT_PARAMS, FL_SCENARIOS, SCENARIOS, type Note } from './flkeys-scenarios';
import { GOLDEN, GOLDEN_FL, STRIDE, type Golden } from './flkeys.golden';
import { FL_INSTALLED, hasFfmpeg, loadFlTable } from './flkeys-fl';

const D = genDef('flkeys')!;

// ------------------------------------------------------------------ engine harness
interface RenderOpts { sr?: number; vol?: number; pan?: number; pitch?: number; root?: number; at?: { frame: number; vol?: number; pan?: number; pitch?: number }[]; wavetable?: string; maxPoly?: number }

/** A real channel playing notes (seconds) at volume 100 % (raw), blocks of 128 frames like the host's channel tests. */
function render(table: KeysTable | null, params: number[], notes: Note[], frames: number, o: RenderOpts = {}): [Float32Array, Float32Array] {
  const sr = o.sr ?? 44100, block = 128;
  const ch = createGenChannel('flkeys');
  ch.volume = (o.vol ?? 100) / 100;
  ch.pan = o.pan ?? 0;
  ch.pitch = (o.pitch ?? 0) / 200;
  if (o.root !== undefined) ch.sampler.rootKey = o.root;
  if (o.maxPoly !== undefined) ch.sampler.polyMax = o.maxPoly;
  const wt = o.wavetable ?? 'mda Piano';
  const pr: Record<string, unknown> = { ...defaultGenParams('flkeys'), wavetable: wt };
  KEYS_PARAM_KEYS.forEach((k, i) => { pr[k] = params[i]; });
  let env: GenEnv = { sample: () => undefined };
  if (table) {
    const pack = packKeysTable(table);
    pr[keysEntry(wt).key] = 'pool';
    env = { sample: (id) => (id === 'pool' ? { channels: [pack], sampleRate: 44100 } : undefined) };
  }
  ch.plugin!.params = pr as never;
  const ctx = { sampleRate: sr, blockSize: block, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
  const c = new GenChannel(ch.id, sr, block, 'flkeys', env, ctx as never);
  c.setGlobals({ tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } as never);
  c.apply(ch);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const bL = new Float32Array(block), bR = new Float32Array(block);
  const at = [...(o.at ?? [])].sort((a, b) => a.frame - b.frame);
  for (let off = 0; off < frames; off += block) {
    const n = Math.min(block, frames - off);
    while (at.length && at[0].frame <= off) {
      const q = at.shift()!;
      if (q.vol !== undefined) ch.volume = q.vol / 100;
      if (q.pan !== undefined) ch.pan = q.pan;
      if (q.pitch !== undefined) ch.pitch = q.pitch / 200;
      c.apply(ch);
    }
    for (const e of notes) {
      const s = Math.round(e.start * sr);
      if (s < off || s >= off + n) continue;
      c.scheduleNote({ pos: 0, len: 0, oneShot: false, key: e.key, vel: e.vel ?? 100, rel: 64, pan: Math.round(64 + 64 * (e.pan ?? 0)), fine: 120 + Math.round((e.fine ?? 0) / 10), modX: 128, modY: 128, slide: false, porta: false, color: 0, chId: ch.id } as SeqNote, s - off, Math.round(e.len * sr));
    }
    bL.fill(0); bR.fill(0);
    c.render(bL.subarray(0, n), bR.subarray(0, n), n);
    L.set(bL.subarray(0, n), off); R.set(bR.subarray(0, n), off);
  }
  return [L, R];
}

function rms(b: Float32Array, a = 0, z = b.length): number {
  let s = 0;
  for (let i = a; i < z; i++) s += b[i] * b[i];
  return Math.sqrt(s / Math.max(1, z - a));
}

/** f0 by autocorrelation (lag search between fmin and fmax), parabolic refinement. */
function f0(b: Float32Array, a: number, z: number, sr: number, fmin = 60, fmax = 1200): number {
  const x = b.subarray(a, z);
  let best = 0, bl = 0;
  const lo = Math.floor(sr / fmax), hi = Math.ceil(sr / fmin);
  const vals: number[] = [];
  for (let l = lo; l <= hi; l++) { let s = 0; for (let i = 0; i + l < x.length; i++) s += x[i] * x[i + l]; vals.push(s); if (s > best) { best = s; bl = l; } }
  for (let l = lo + 1; l < hi; l++) { const v = vals[l - lo]; if (v > 0.9 * best && v >= vals[l - lo - 1] && v >= vals[l - lo + 1]) { bl = l; break; } }
  const y0 = vals[bl - lo - 1], y1 = vals[bl - lo], y2 = vals[bl - lo + 1];
  return sr / (bl + (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2));
}

function peak(b: Float32Array): number {
  let p = 0;
  for (let i = 0; i < b.length; i++) p = Math.max(p, Math.abs(b[i]));
  return p;
}

/** Compare a render with FL's pinned numbers: frame count, the sampled frames, RMS and the last non-zero frame. */
function checkGolden(out: [Float32Array, Float32Array], g: Golden, loose: boolean): void {
  expect(out[0].length).toBe(g.frames);
  let ss = 0, last = 0;
  for (let i = 0; i < out[0].length; i++) { ss += out[0][i] ** 2 + out[1][i] ** 2; if (out[0][i] !== 0 || out[1][i] !== 0) last = i; }
  const r = Math.sqrt(ss / (2 * out[0].length));
  expect(Math.abs(r - g.rms)).toBeLessThanOrEqual(g.rms * (loose ? 0.01 : 2e-4));
  // FL ends a voice at the end of the 16-sample block its envelope fell below 1e-4 (the host's block grid, a few frames off here)
  expect(Math.abs(last - g.last)).toBeLessThanOrEqual(loose ? 40 : 40);
  let se = 0, sg = 0;
  let maxd = 0;
  g.L.forEach((v, k) => {
    const i = k * STRIDE;
    const dl = out[0][i] - v, dr = out[1][i] - g.R[k];
    se += dl * dl + dr * dr; sg += v * v + g.R[k] * g.R[k];
    maxd = Math.max(maxd, Math.abs(dl), Math.abs(dr));
  });
  if (loose) expect(se / (sg + 1e-30)).toBeLessThan(2e-5); // -47 dB
  else expect(maxd).toBeLessThan(3e-5);
}

// ------------------------------------------------------------------ registration
const FL_TEXT_HASHES = ['18271c8209968c6d', 'c8577a1a6dc10157', 'c8577a1a6dc10157', 'c8577a1a6dc10157', 'c412397a92b06044', 'baeeb154a6e20348', 'c8577a1a6dc10157', 'baeeb154a6e20348', 'f84d4cb24a9f5d34', '47d599edf84b635e', 'a283c1504ad1aa03', 'c8577a1a6dc10157', '5d74d9f48ca0e9e3', '9f850aa9e972a94d', 'a0cab3f5f8fbba7e'];

describe('FL Keys: registration', () => {
  it('is a Misc generator with FL\'s form size, DefPoly and voice handling', () => {
    expect(D.name).toBe('FL Keys');
    expect(D.category).toBe('Misc');
    expect(D.notes).toBe('voices');
    expect(D.levels).toBe('plugin');
    expect(D.defPoly).toBe(32);
    expect([D.width, D.height]).toEqual([480, 270]);
    expect(genInCategory('Misc').some((d) => d.id === 'flkeys')).toBe(true);
    expect(createGenChannel('flkeys').sampler.polyMax).toBe(32);
    expect(createGen('flkeys', 44100, 128, { sample: () => undefined })).toBeTruthy();
  });

  it('has FL\'s 15 parameters with FL\'s names, indices, ranges and form defaults', () => {
    const want: [string, number, number, number][] = [
      ['Decay', -1000, 1000, 0], ['Release', -1000, 1000, 0], ['Hardness', -1000, 1000, 0], ['Velocity to Hardness', -1000, 1000, 0],
      ['Muffle', 0, 1000, 784], ['Velocity to Muffle', 0, 2000, 502], ['Velocity Sensitivity', -1000, 1000, 0], ['Stereo', 0, 2000, 1000],
      ['Tune', -1000, 1000, 0], ['Detune', 0, 500, 123], ['Stretch', -500, 500, 0], ['Treble', -1000, 1000, 0],
      ['Pan/Tremolo', -1000, 1000, 0], ['LFO Rate', 0, 65536, 0], ['Overdrive', 0, 1000, 0],
    ];
    expect(D.params.length).toBe(15);
    D.params.forEach((q, i) => {
      expect([q.name, q.min, q.max, q.def]).toEqual(want[i]);
      expect(q.index).toBe(i);
      expect(q.key).toBe(KEYS_PARAM_KEYS[i]);
    });
  });

  it('formats every value of every parameter exactly as FL does (hashes of FL\'s sweep: all 2001..65537 values)', () => {
    D.params.forEach((q, i) => {
      const lines: string[] = [];
      for (let v = q.min; v <= q.max; v++) lines.push(`${v}\t${formatParam(q, v)}`);
      expect(createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16), q.name).toBe(FL_TEXT_HASHES[i]);
    });
    const text = (k: string, v: number) => formatParam(D.params.find((q) => q.key === k)!, v);
    expect(text('decay', -1000)).toBe('No decay (sustain)');
    expect(text('decay', 0)).toBe('0%');
    expect(text('muffle', 784)).toBe('22%');
    expect(text('velMuffle', 502)).toBe('50%');
    expect(text('velSens', -248)).toBe('-25%');
    expect(text('detune', 123)).toBe('3.0');
    expect(text('tune', -999)).toBe('-100 cents');
    expect(text('stretch', 5)).toBe('0.5 cents');
    expect(text('panTrem', -1)).toBe('0% (pan)');
    expect(text('panTrem', 0)).toBe('Off');
    expect(text('panTrem', 1000)).toBe('100% (tremelo)');
    expect(text('lfoRate', 0)).toBe('0.01 Hz');
    expect(text('lfoRate', 65536)).toBe('100.48 Hz');
    expect(text('overdrive', 1000)).toBe('100.0%');
  });

  it('typed values map back to control units', () => {
    const q = (k: string) => D.params.find((p) => p.key === k)!;
    expect(q('muffle').parse!(22)).toBe(780);
    expect(q('decay').parse!(50)).toBe(500);
    expect(q('detune').parse!(3)).toBe(122);
    expect(Math.round(Math.exp((9.22 * q('lfoRate').parse!(1)) / 65536 - 4.61) * 100) / 100).toBe(1);
  });

  it('starts like FL\'s plugin database entry (Grand Piano) and keeps FL\'s 9 factory presets', () => {
    const fresh = defaultGenParams('flkeys') as Record<string, unknown>;
    expect(fresh.wavetable).toBe('Grand Piano');
    expect(KEYS_PARAM_KEYS.map((k) => fresh[k])).toEqual([-1000, 250, 0, -1000, 0, 1000, -500, 0, 0, 123, 0, 0, 0, 0, 0]);
    expect(KEYS_CATALOG.every((e) => fresh[e.key] === '')).toBe(true);
    const names = D.presets!.map((p) => p.name);
    expect(names).toEqual(['Broken Piano', 'Compressed Piano', 'Concert Piano', 'Dance Piano', 'Dark Piano', 'Default', 'ePiano', 'Plain Piano', 'School Piano']);
    const vals = (name: string) => {
      const s = genPresetState('flkeys', D.presets!.find((p) => p.name === name)!) as Record<string, unknown>;
      return [KEYS_PARAM_KEYS.map((k) => s[k]), s.wavetable];
    };
    expect(vals('Broken Piano')).toEqual([[-568, 680, -408, 552, 299, 1568, -648, 976, 26, 341, -500, 0, 0, 0, 0], 'mda Piano']);
    expect(vals('Concert Piano')).toEqual([[296, 0, -232, -504, 280, 1328, -24, 1680, 0, 147, 160, 0, 0, 0, 0], 'mda Piano']);
    expect(vals('Default')).toEqual([[0, 0, 0, -1000, 784, 502, -248, 1000, 0, 123, 0, 0, 0, 0, 0], 'mda Piano']);
    expect(vals('ePiano')).toEqual([[0, 0, 0, 0, 200, 1300, -500, 1000, 0, 123, -500, 0, -600, 42598, 0], 'Rhodes (mda ePiano)']);
    for (const p of D.presets!) {
      for (const q of D.params) expect((p.params as Record<string, number>)[q.key]).toBeGreaterThanOrEqual(q.min);
    }
  });

  it('normalises stored states (unknown wavetable -> the default, bad sample ids dropped)', () => {
    const s = normalizeGenParams('flkeys', { wavetable: 'nope', samplePiano: 5 }) as Record<string, unknown>;
    expect(s.wavetable).toBe('mda Piano');
    expect(s.samplePiano).toBe('');
    expect(keysEntry('grand piano').name).toBe('Grand Piano');
    expect(keysEntry('Piano').name).toBe('mda Piano');
  });
});

// ------------------------------------------------------------------ the loader
describe('FL Keys: wavetable loader (FL\'s .wti rules, pool pack)', () => {
  it('builds the raw single-file table the way FL compacts it', () => {
    const t = synTable('Syn Raw');
    expect(t.stereo).toBe(false);
    expect([t.rate, t.fileRate, t.vf, t.layers, t.relHigh, t.resample]).toEqual([22050, 22050, 2.5, 2, false, false]);
    expect(Array.from(t.thr)).toEqual([0, 70]);
    expect(Array.from(t.root)).toEqual([48, 48, 60, 60, 72, 72]);
    expect(Array.from(t.high)).toEqual([53, 53, 65, 65, 999, 999]);
    // regions follow each other with one spare frame; the shared layer (group 3) keeps the *old* start of group 2
    // (12704 in the file) although the compacted buffer holds that region at 12702: FL does not remap it
    expect(Array.from(t.pos)).toEqual([0, 6001, 12702, 12704, 20203, 29204]);
    expect(t.end[1] - t.pos[1] + 1).toBe(6700);
    expect(t.end[3] - t.pos[3] + 1).toBe(7500);
    for (let g = 0; g < 6; g++) {
      if (g === 3) continue;
      // the frame after the end is the one the loop wraps to
      expect(t.waves[t.end[g] + 1]).toBe(t.waves[t.end[g] - t.loop[g] + 1]);
    }
  });

  it('builds RIFF tables: loops from the file, whole-file loops without smpl, canloop=false ends the voice', () => {
    const t = synTable('Syn Riff');
    expect(t.stereo).toBe(false);
    expect([t.rate, t.vf, t.resample]).toEqual([44100, 4, false]);
    expect(Array.from(t.pos)).toEqual([0, 9001, 17002, 24003]);
    // sample 1 loops 3000..8200 of its file; sample 3 has no loop chunk: the whole file loops; sample 2: canloop=false: loop = end
    expect(t.end[0]).toBe(8200);
    expect(t.loop[0]).toBe(5201);
    expect(t.end[2]).toBe(17002 + 7000 - 1);
    expect(t.loop[2]).toBe(t.end[2]);
    expect(t.end[3]).toBe(24003 + 5500);
    expect(t.loop[3]).toBe(4501);
    // the frame after a loop end repeats the one `loop` before it (RIFF loader: end - loop, not +1)
    expect(t.waves[t.end[0] + 1]).toBe(t.waves[t.end[0] - 5201]);
    expect(t.defaults[0]).toBeCloseTo(0.25);
    expect(t.defaults[1]).toBeCloseTo(0.6);
    expect(Number.isNaN(t.defaults[2])).toBe(true);
    expect(t.defaults[7]).toBeCloseTo(0.75);
  });

  it('builds stereo tables with interleaved frames', () => {
    const t = synTable('Syn Stereo');
    expect(t.stereo).toBe(true);
    expect(t.relHigh).toBe(true);
    expect(t.fileRate).toBe(32000);
    expect(t.waves.length).toBeGreaterThanOrEqual((t.frames + 2) * 2);
  });

  it('applies FL\'s validation: clamps, root / high inheritance, defaults, errors', () => {
    const files = { raw: (n: string) => (n === 'a.dat' ? Int16Array.from({ length: 100 }, (_, i) => i) : null), wave: () => null };
    const t = buildKeysTable(new Ini('[info]\nsamples=2\nsamplefile=a.dat\nfiletype=raw\n[sample0]\nroot=200\nhigh=5000\npos=0\nend=50\nloop=500\n[sample1]\npos=51\nend=99\nloop=10\ncanloop=false'), files, 44100);
    expect(t.root[0]).toBe(127);
    expect(t.high[0]).toBe(999);
    expect(t.root[1]).toBe(127); // inherited, then clamped
    expect(t.loop[0]).toBeLessThanOrEqual(t.frames - t.pos[0]);
    expect(t.loop[1]).toBe(t.end[1]); // canloop=false
    expect(t.rate).toBe(44100);
    expect(t.vf).toBe(1);
    expect(t.layers).toBe(1);
    expect(() => buildKeysTable(new Ini('[info]\nsamples=0'), files, 44100)).toThrow(KeysTableError);
    expect(() => buildKeysTable(new Ini('[info]\nsamples=1\nsamplefile=missing.dat\nfiletype=raw'), files, 44100)).toThrow(KeysTableError);
    expect(() => buildKeysTable(new Ini('[info]\nsamples=1\nsamplefile=a.dat\nfiletype=raw\n[sample0]\npos=90\nend=500'), files, 44100)).toThrow(KeysTableError);
    expect(() => buildKeysTable(new Ini('[info]\nsamples=1\nfiletype=riff\n[sample0]\nname=x.wav'), files, 44100)).toThrow(KeysTableError);
  });

  it('parses ini like Delphi\'s ReadInteger / ReadFloat (empty values give the default, sections and keys ignore case)', () => {
    const i = new Ini('[Info]\r\nSamples = 12 \r\nroot=\r\nrate=44100.5\r\nflag=true\r\n; comment\r\n[B]\r\nk=v');
    expect(i.int('info', 'samples', 0)).toBe(12);
    expect(i.int('info', 'root', 60)).toBe(60);
    expect(i.int('info', 'missing', 7)).toBe(7);
    expect(i.float('INFO', 'rate', 0)).toBe(44100.5);
    expect(i.bool('info', 'flag', false)).toBe(true);
    expect(i.str('b', 'K')).toBe('v');
  });

  it('packs into a pool sample and back, and rejects anything that is not a valid pack', () => {
    for (const n of ['Syn Raw', 'Syn Riff', 'Syn Stereo'] as SynName[]) {
      const t = synTable(n);
      const pack = packKeysTable(t);
      for (let i = 0; i < pack.length; i += 997) expect(Math.abs(pack[i] * 32768 - Math.round(pack[i] * 32768))).toBeLessThan(1e-3); // 16-bit grid
      const u = unpackKeysTable(pack)!;
      expect(u).toBeTruthy();
      expect([u.name, u.stereo, u.rate, u.fileRate, u.vf, u.relHigh, u.resample, u.layers, u.frames]).toEqual([t.name, t.stereo, t.rate, t.fileRate, t.vf, t.relHigh, t.resample, t.layers, t.frames]);
      expect(Array.from(u.pos)).toEqual(Array.from(t.pos));
      expect(Array.from(u.loop)).toEqual(Array.from(t.loop));
      expect(Array.from(u.thr)).toEqual(Array.from(t.thr));
      expect(u.waves[t.pos[1] + 5]).toBe(t.waves[t.pos[1] + 5]);
    }
    expect(unpackKeysTable(new Float32Array(10))).toBeNull();
    expect(unpackKeysTable(new Float32Array(1000).map(() => Math.random() - 0.5))).toBeNull();
    const good = packKeysTable(synTable('Syn Riff'));
    expect(unpackKeysTable(good.slice(0, 200))).toBeNull(); // truncated
    const bad = good.slice();
    bad[1] = 0; // magic
    expect(unpackKeysTable(bad)).toBeNull();
    const bad2 = good.slice();
    for (let i = 20; i < 60; i++) bad2[i] = 0.5; // header fields out of range
    expect(unpackKeysTable(bad2)).toBeNull();
  });

  it('converts RIFF tables to the host rate like FL (resample): file lengths and loops scale, the .wti rate stays', () => {
    const t = synTable('Syn Res');
    expect(t.fileRate).toBe(32000);
    expect(t.rate).toBe(44100);
    expect(t.resample).toBe(true);
    const c = resampleKeysTable(t, 44100);
    const r = 44100 / 32000;
    expect(c.fileRate).toBe(44100);
    expect(c.rate).toBe(44100);
    // file 1: 12000 frames, loop 2000..11004 -> start round(s r), end round((e + 1) r) - 1 (half to even)
    expect(c.pos[0]).toBe(0);
    expect(c.end[0] - c.pos[0] + 1 - c.loop[0]).toBe(Math.round(2000 * r));
    expect(c.end[0]).toBe(Math.round(11005 * r) - 1);
    expect(c.frames).toBeGreaterThan(t.frames * r * 0.99);
    expect(resampleKeysTable(synTable('Syn Raw'), 48000).frames).toBe(synTable('Syn Raw').frames); // raw tables are never converted
    expect(resampleKeysTable({ ...t, resample: false }, 48000)).toEqual({ ...t, resample: false });
  });
});

// ------------------------------------------------------------------ FL's renders
describe('FL Keys: engine against FL\'s plugin (synthetic wavetables, test host with 16-sample blocks)', () => {
  for (const [id, s] of Object.entries(SCENARIOS)) {
    it(id, () => {
      const g = GOLDEN[id];
      expect(g).toBeTruthy();
      const out = render(synTable(s.table, s.sr ?? 44100), s.params ?? DEFAULT_PARAMS, s.notes, g.frames, { sr: s.sr, vol: s.vol, pan: s.pan, pitch: s.pitch, root: s.root, at: s.at });
      checkGolden(out, g, !!s.loose);
    });
  }
});

describe('FL Keys: engine against FL\'s plugin (FL\'s own wavetables; needs FL Studio installed, the Grand Piano also ffmpeg)', () => {
  for (const [id, s] of Object.entries(FL_SCENARIOS)) {
    const need = s.name === 'Grand Piano' ? FL_INSTALLED && hasFfmpeg() : FL_INSTALLED;
    (need ? it : it.skip)(id, () => {
      const t = loadFlTable(s.name)!;
      expect(t).toBeTruthy();
      const g = GOLDEN_FL[id];
      const out = render(t, s.params, s.notes, g.frames, { sr: s.sr, wavetable: s.name });
      // FL's Ogg decoder differs from ffmpeg's by an occasional 16-bit step, the resampler by a hair: compare to -75 dB
      const grand = s.name === 'Grand Piano';
      let se = 0, sg = 0;
      g.L.forEach((v, k) => { const i = k * STRIDE; se += (out[0][i] - v) ** 2 + (out[1][i] - g.R[k]) ** 2; sg += v * v + g.R[k] * g.R[k]; });
      expect(10 * Math.log10((se + 1e-30) / (sg + 1e-30))).toBeLessThan(grand ? -70 : s.sr === 48000 ? -60 : -85);
      expect(out[0].length).toBe(g.frames);
    });
  }
});

// ------------------------------------------------------------------ engine behaviour
describe('FL Keys: engine behaviour', () => {
  const t = synTable('Syn Riff');

  it('plays a key at the pitch of its sample\'s root (mda note numbers: key 60 = 261.6 Hz) and an octave up for +12 keys', () => {
    const p = DEFAULT_PARAMS.slice(); p[0] = -1000;
    const lo = render(t, p, [{ key: 52, start: 0, len: 0.3 }], 8000);
    const hi = render(t, p, [{ key: 64, start: 0, len: 0.3 }], 8000);
    expect(f0(lo[0], 500, 5000, 44100, 100, 800)).toBeCloseTo(164.81, 0);
    expect(f0(hi[0], 500, 5000, 44100, 100, 800) / f0(lo[0], 500, 5000, 44100, 100, 800)).toBeCloseTo(2, 1);
  });

  it('is silent outside a voice (FL skips Gen_Render without voices) and a note off starts the release', () => {
    const [L] = render(t, DEFAULT_PARAMS, [{ key: 52, start: 0.01, len: 0.2 }], 44100);
    expect(rms(L, 0, 400)).toBe(0);
    expect(rms(L, 4000, 8000)).toBeGreaterThan(0.001);
    // release: after the note off the level falls (Release wheel at 0 = about 0.1 s of piano release)
    expect(rms(L, 24000, 26000)).toBeLessThan(0.2 * rms(L, 6000, 8000));
    // the voice ends once its envelope is below 1e-4 (a short release here), and then nothing is rendered
    const q = DEFAULT_PARAMS.slice(); q[1] = -1000;
    const [S] = render(t, q, [{ key: 52, start: 0.01, len: 0.2 }], 70000);
    expect(rms(S, 55000, 70000)).toBe(0);
    expect(rms(S, 4000, 8000)).toBeGreaterThan(0.001);
  });

  it('applies velocity sensitivity to the channel level: louder notes are louder, 128 is above 100', () => {
    const lv = (vel: number) => rms(render(t, DEFAULT_PARAMS, [{ key: 52, vel, start: 0, len: 0.3 }], 12000)[0], 0, 12000);
    expect(lv(100)).toBeGreaterThan(lv(64));
    expect(lv(128)).toBeGreaterThan(lv(100));
    expect(lv(64)).toBeGreaterThan(lv(20));
  });

  it('Stereo spreads the output (comb) and Pan/Tremolo modulates it', () => {
    const w = DEFAULT_PARAMS.slice(); w[7] = 2000;
    const [L, R] = render(t, w, [{ key: 52, start: 0, len: 0.4 }], 14000);
    let diff = 0;
    for (let i = 4000; i < 12000; i++) diff += Math.abs(L[i] - R[i]);
    const n = DEFAULT_PARAMS.slice(); n[7] = 0;
    const [L2, R2] = render(t, n, [{ key: 52, start: 0, len: 0.4 }], 14000);
    let diff2 = 0;
    for (let i = 4000; i < 12000; i++) diff2 += Math.abs(L2[i] - R2[i]);
    expect(diff).toBeGreaterThan(diff2 * 1.5);
    const m = DEFAULT_PARAMS.slice(); m[12] = 1000; m[13] = 52000; // tremolo, fast
    const [T] = render(t, m, [{ key: 52, start: 0, len: 0.5 }], 20000);
    const env = (a: number) => rms(T, a, a + 400);
    const e = [3000, 3600, 4200, 4800, 5400, 6000, 6600, 7200].map(env);
    expect(Math.max(...e) / Math.min(...e)).toBeGreaterThan(1.3);
  });

  it('stays finite and bounded for every key, velocity, parameter extreme and sample rate (synthetic and synthesized tables)', () => {
    const lows = [-1000, -1000, -1000, -1000, 0, 0, -1000, 0, -1000, 0, -500, -1000, -1000, 0, 0];
    const highs = [1000, 1000, 1000, 1000, 1000, 2000, 1000, 2000, 1000, 500, 500, 1000, 1000, 65536, 1000];
    for (const params of [lows, highs, DEFAULT_PARAMS]) {
      for (const sr of [8000, 44100, 192000]) {
        const notes: Note[] = [0, 1, 13, 40, 60, 93, 94, 127, 131].map((key, i) => ({ key, vel: [1, 64, 100, 128][i % 4], start: i * 0.01, len: 0.15 }));
        for (const table of [synTable('Syn Raw', sr), synTable('Syn Stereo', sr), null]) {
          const [L, R] = render(table, params, notes, Math.round(sr * 0.5), { sr });
          expect(peak(L)).toBeLessThan(1000);
          expect(peak(R)).toBeLessThan(1000);
          for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error(`non-finite at ${i}`);
        }
      }
    }
  });

  it('switching the wavetable stops the voices of the old one; an unknown name plays the default', () => {
    const e = createGen('flkeys', 44100, 128, { sample: () => undefined })!;
    e.setParams({ ...defaultGenParams('flkeys'), wavetable: 'Grand Piano' });
    const p = { key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 }, levels: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 } };
    const v = e.triggerVoice!(p as never)!;
    const L = new Float32Array(16), R = new Float32Array(16);
    expect(v.render(L, R, 16)).toBe(true);
    e.setParams({ ...defaultGenParams('flkeys'), wavetable: 'Roto Organ' });
    expect(v.render(new Float32Array(16), new Float32Array(16), 16)).toBe(false);
    v.kill();
    e.setParams({ ...defaultGenParams('flkeys'), wavetable: 'something else' });
    const w = e.triggerVoice!(p as never)!;
    expect(w.render(new Float32Array(16), new Float32Array(16), 16)).toBe(true);
    expect((e.monitor!() as { table: string }).table).toBe('mda Piano');
  });

  it('limits its voices with FPE_MaxPoly (the quietest voice is finished at the next note)', () => {
    const inst = createGen('flkeys', 44100, 128, { sample: () => undefined })!;
    inst.setParams(defaultGenParams('flkeys'));
    inst.setMaxPoly!(3);
    const mkp = (key: number) => ({ key, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: { pan: 0, vol: 1, pitch: key * 100, fcut: 0, fres: 0 }, levels: { pan: 0, vol: 1, pitch: key * 100, fcut: 0, fres: 0 } });
    const vs = [60, 62, 64, 66].map((k) => inst.triggerVoice!(mkp(k) as never)!);
    const L = new Float32Array(16), R = new Float32Array(16);
    const alive = vs.map((v) => v.render(L.fill(0), R.fill(0), 16));
    expect(alive).toEqual([false, true, true, true]);
  });
});

// ------------------------------------------------------------------ the synthesized stand-ins
describe('FL Keys: synthesized wavetables', () => {
  it('have the structure of the wavetables they replace', () => {
    const want: Record<string, { groups: number; layers: number; rate: number; vf: number; relHigh: boolean }> = {
      'mda Piano': { groups: 15, layers: 1, rate: 22050, vf: 3, relHigh: false },
      'Grand Piano': { groups: 14, layers: 1, rate: 22050, vf: 4, relHigh: false },
      'Rhodes (mda ePiano)': { groups: 33, layers: 3, rate: 22050, vf: 3, relHigh: true },
      'Roto Organ': { groups: 7, layers: 1, rate: 44100, vf: 1, relHigh: false },
    };
    for (const e of KEYS_CATALOG) {
      const t = synthTable(e.name);
      const w = want[e.name];
      expect([t.root.length, t.layers, t.rate, t.vf, t.relHigh]).toEqual([w.groups, w.layers, w.rate, w.vf, w.relHigh]);
      expect(t.high[t.high.length - 1]).toBe(999);
      expect(unpackKeysTable(packKeysTable(t))).toBeTruthy();
      for (let g = 0; g < t.root.length; g++) {
        expect(t.end[g]).toBeGreaterThan(t.pos[g] + 1000);
        expect(t.end[g]).toBeLessThan(t.frames);
        const looping = t.loop[g] < t.end[g];
        if (looping) expect(t.waves[t.end[g] + 1]).toBe(t.waves[t.end[g] - t.loop[g] + 1]);
      }
      let finite = true;
      for (let i = 0; i < t.frames; i++) if (!Number.isFinite(t.waves[i])) finite = false;
      expect(finite).toBe(true);
    }
    expect(synthTable('Grand Piano').loop.every((l, g) => l === synthTable('Grand Piano').end[g])).toBe(true); // no loop: voices end with the sample
    expect(synthTable('does not exist')).toBe(synthTable('mda Piano'));
  });

  it('play at about the level of FL\'s recordings (first 0.5 s RMS within 4 dB at the default parameters)', () => {
    // FL's test host, key 60 vel 100, default parameters, 0..0.5 s RMS of the left channel (dB): mda Piano -16.6, Rhodes -19.3, Organ -22.0
    const want: [string, number][] = [['mda Piano', -16.6], ['Rhodes (mda ePiano)', -19.3], ['Roto Organ', -22.0]];
    for (const [name, db] of want) {
      const [L] = render(null, DEFAULT_PARAMS, [{ key: 60, start: 0, len: 1 }], 22050, { wavetable: name });
      expect(Math.abs(20 * Math.log10(rms(L)) - db)).toBeLessThan(4);
    }
  });

  it('play the pitch they are asked for (notes at a group\'s root sound its fundamental)', () => {
    for (const [name, key] of [['Grand Piano', 60], ['Grand Piano', 72], ['Rhodes (mda ePiano)', 60]] as [string, number][]) {
      const [L] = render(null, DEFAULT_PARAMS, [{ key, start: 0, len: 0.8 }], 30000, { wavetable: name });
      const want = 440 * Math.pow(2, (key - 69) / 12);
      expect(f0(L, 3000, 13000, 44100, 150, 1500) / want).toBeGreaterThan(0.97);
      expect(f0(L, 3000, 13000, 44100, 150, 1500) / want).toBeLessThan(1.03);
    }
  });
});
