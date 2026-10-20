// Wave Traveller: registration, state model and FL's preset data, the spline -> table builder and the engine pinned to FL's
// own renders (test host: bit-exact), voice behaviour, finiteness at extreme settings, the editing logic and the editor.
import { describe, it, expect } from 'vitest';
import './util';
import { genDef, genInCategory, defaultGenParams, normalizeGenParams, genPresetState } from '../../src/model/gen/registry';
import { def } from '../../src/model/gen/plugins/wavetraveller';
import { gen } from '../../src/engine/gen/plugins/wavetraveller';
import {
  WT_BEZIER, WT_HALF_COSINE, WT_KEYS, WT_LINEAR, WT_MUTE, WT_QUARTER_COSINE, WT_QUARTER_SINE, WT_TABLE, WT_TENSION,
  attackFromWheel, attackToWheel, buildTable, clonePatch, defaultPatch, defaultWtState, newPoint, normalizePatch, patchFromSeed,
  releaseFromWheel, releaseToWheel, speedFromWheel, speedText, speedToWheel, wtState, type WtPatch, type WtPoint,
} from '../../src/model/gen/plugins/wavetraveller/state';
import { WT_FACTORY, WT_SPLINE_PRESETS } from '../../src/model/gen/plugins/wavetraveller/presets';
import { readSpln, writeSpln } from '../../src/model/gen/plugins/wavetraveller/spln';
import {
  SPLINE_H, SPLINE_W, addPointAt, applyDrag, deletePoint, fromPx, handlePos, hitTest, mutedAt, normalize100, normalize50, paintMutes,
  tensionPos, toPx, type DragOptions,
} from '../../src/model/gen/plugins/wavetraveller/edit';
import { renderWt, testAudio, type WtAudioName } from './wavetraveller-render';
import { WT_GOLDEN, WT_TABLES } from './wavetraveller-golden';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
const SR = 44100;
/** The default state as a plain record (renderWt takes JSON-like states). */
const dflt = (): Record<string, unknown> => ({ ...defaultWtState() });

function rms(a: Float32Array): number {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s / a.length);
}

/** The FL test host's arguments of a golden case as render options. */
function hostOpts(args: string[] | undefined): { sr: number; pitch?: number; pan?: number; root?: number; interp?: 'hermite6'; rendering: boolean } {
  const a = args ?? [];
  const num = (n: string): number | undefined => (a.includes(n) ? Number(a[a.indexOf(n) + 1]) : undefined);
  const pm = num('--process-mode');
  return {
    sr: num('--sr') ?? SR, pitch: num('--chan-pitch'), pan: num('--chan-pan'), root: num('--root-note'),
    interp: pm !== undefined && ((pm >> 8) & 0xffff) === 3 ? 'hermite6' : undefined, rendering: pm !== undefined,
  };
}

describe('Wave Traveller definition', () => {
  it('is registered as FL has it: Sampler, 715 x 224, no parameters, voices with its own levels', () => {
    expect(genDef('wavetraveller')).toBe(def);
    expect(def.name).toBe('Wave Traveller');
    expect(def.category).toBe('Sampler');
    expect(def.notes).toBe('voices');
    expect(def.levels).toBe('plugin');
    expect(def.defPoly).toBe(0);
    expect([def.width, def.height]).toEqual([715, 224]);
    expect(def.params).toEqual([]);
    expect(genInCategory('Sampler').map((d) => d.id)).toContain('wavetraveller');
  });

  it('a new instance has FL\'s database state: key 60, no sample, 120 default patches', () => {
    const s = wtState(defaultGenParams('wavetraveller'));
    expect(s).toMatchObject({ sample: '', file: '', key: 60, patches: {}, continuous: false, part: 0, octave: 5, snap: 0 });
    const d = defaultPatch();
    expect(d).toMatchObject({ name: '', start: 0, end: 1, steps: 4, speed: 1, attack: 1, release: 1, mode: 0, mutes: [[1, 0]] });
    expect(d.wave.map((p) => [p.x, p.y, p.type])).toEqual([[0, 0, 1], [1, 1, 1]]);
    expect(d.vol.map((p) => [p.x, p.y, p.type])).toEqual([[0, 1, 1], [1, 1, 1]]);
    for (const p of [...d.wave, ...d.vol]) {
      expect(p.tension).toBe(0.5);
      expect([p.h1x, p.h1y, p.h2x, p.h2y]).toEqual([Math.fround(-0.042), 0, Math.fround(0.042), 0]);
      expect(p.locked).toBe(false);
    }
    expect(WT_KEYS).toBe(120);
  });

  it('normalizes a stored state: ranges, types, point order, the sparse patch map', () => {
    const bad = normalizeGenParams('wavetraveller', {
      key: 500, octave: -3, snap: 99, part: 7, file: 12, patches: {
        '60': { start: -1, end: 9, steps: 100, speed: 0, attack: 0, release: 99999, mode: 5, name: 3, wave: [{ x: 1, y: 2, type: 77 }, { x: 0.3, y: -4, type: 3 }], vol: [], mutes: 'x' },
        '120': { start: 0.5 }, 'x': {},
      },
    });
    const s = wtState(bad);
    expect(s.key).toBe(119);
    expect(s.octave).toBe(0);
    expect(s.snap).toBe(6);
    expect(s.part).toBe(1);
    expect(s.file).toBe('');
    expect(Object.keys(s.patches)).toEqual(['60']);
    const p = s.patches['60'];
    expect([p.start, p.end, p.steps, p.speed, p.attack, p.release, p.mode, p.name]).toEqual([0, 1, 8, 0.25, 1, 1000, 1, '']);
    // a spline needs two points: broken lists fall back to FL's default line; point values are clamped and ordered
    expect(p.wave.map((q) => [q.x, q.y, q.type])).toEqual([[0.30000001192092896, 0, WT_BEZIER], [1, 1, WT_LINEAR]]);
    expect(p.vol).toEqual(defaultPatch().vol);
    expect(p.mutes).toEqual([[1, 0]]);
  });

  it('keeps the state JSON-serialisable and idempotent', () => {
    const st = { ...defaultWtState(), key: 65, patches: { 65: patchFromSeed(WT_FACTORY[2].patches[65]) } };
    const once = normalizeGenParams('wavetraveller', JSON.parse(JSON.stringify(st)));
    expect(normalizeGenParams('wavetraveller', JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('names the keys of the patches that have a name (FL: GetName for the piano roll)', () => {
    const s = genPresetState('wavetraveller', def.presets!.find((p) => p.name === 'classic kick')!);
    expect(def.keyNames!(s)).toEqual({ 60: 'kick 1', 62: 'kick2', 64: 'kick3', 65: 'kick4' });
    expect(def.keyNames!(defaultGenParams('wavetraveller'))).toEqual({});
  });
});

describe('FL factory presets and spline presets as data', () => {
  it('lists FL\'s 6 presets with their sample, selected key and patches', () => {
    expect(def.presets!.map((p) => p.name)).toEqual(['classic kick', 'Default', 'go', 'hmmm', 'just scratchin', 'snare']);
    const summary = WT_FACTORY.map((f) => [f.name, f.file, f.key, Object.keys(f.patches).map(Number)]);
    expect(summary).toEqual([
      ['classic kick', 'HIP_Kick_3.wav', 67, [60, 62, 64, 65, 67]],
      ['Default', '', 60, []],
      ['go', 'VOC_Go.wav', 65, [60, 62, 64, 65]],
      ['hmmm', 'VOC_ICantFeelNoBetter.wav', 60, [60, 62, 64]],
      ['just scratchin', 'VOC_ScratchinSurf.wav', 64, [60, 62, 64]],
      ['snare', 'HIP_Snare_8.wav', 60, [60, 62, 64, 65]],
    ]);
    // sample content is the user's: presets never carry audio
    for (const p of def.presets!) expect((p.params as { sample?: string }).sample ?? '').toBe('');
  });

  it('decodes FL\'s patches: points, mutes and fields (spot checks of the .fst data)', () => {
    const kick = WT_FACTORY.find((f) => f.name === 'classic kick')!;
    const p64 = patchFromSeed(kick.patches[64]);
    expect(p64.name).toBe('kick3');
    expect(p64.wave).toHaveLength(13);
    expect(p64.mutes).toHaveLength(8);
    expect(p64.wave[1]).toMatchObject({ type: WT_HALF_COSINE, locked: true });
    expect(p64.wave[0]).toMatchObject({ x: 0, y: 0, type: WT_LINEAR, locked: false });
    const go62 = patchFromSeed(WT_FACTORY.find((f) => f.name === 'go')!.patches[62]);
    expect(go62.start).toBeCloseTo(0.02, 6);
    expect(go62.end).toBeCloseTo(0.5375, 5);
    const hm = patchFromSeed(WT_FACTORY.find((f) => f.name === 'hmmm')!.patches[62]);
    expect(hm.steps).toBeCloseTo(4.1575, 4);
    expect(hm.vol).toHaveLength(3);
    expect(hm.end).toBeCloseTo(0.302501, 6);
  });

  it('lists the 19 spline presets of the plugin\'s Presets folder', () => {
    expect(WT_SPLINE_PRESETS.map((p) => p.name)).toEqual([
      'Accelerate', 'AccelerateBackwards', 'Backwards', 'classic', 'classic2', 'classic3', 'classic4', 'classic5', 'classic6', 'Default',
      'PingPong', 'PingPongBackWards', 'simple 1', 'simple 2', 'simple 3', 'simple 4', 'simple 5', 'Slowdown', 'SlowDownBackwards',
    ]);
    const by = Object.fromEntries(WT_SPLINE_PRESETS.map((p) => [p.name, patchFromSeed(p.patch)]));
    expect(by.classic.wave).toHaveLength(15);
    expect(by.classic.mutes).toHaveLength(15);
    expect(by['simple 4'].wave).toHaveLength(26);
    expect(by.classic4.start).toBeCloseTo(0.285, 6);
    expect(by.classic6.start).toBeCloseTo(0.06, 6);
    expect(by.PingPong.wave.map((q) => q.type)).toEqual([WT_QUARTER_SINE, WT_QUARTER_COSINE, WT_LINEAR]);
    expect(by.Default).toEqual(defaultPatch());
    // every preset is a usable patch: ordered points from 0 to 1 and a table of the plugin's length
    for (const p of Object.values(by)) {
      expect(p.wave[0].x).toBe(0);
      expect(p.wave[p.wave.length - 1].x).toBe(1);
      const tab = new Float32Array(WT_TABLE);
      expect(buildTable(p.wave, tab).last).toBeGreaterThan(900);
    }
  });

  it('the mutes of the presets alternate between playing and muted (FL: [on, time] pairs)', () => {
    const c = patchFromSeed(WT_SPLINE_PRESETS.find((p) => p.name === 'classic')!.patch);
    expect(c.mutes[0]).toEqual([1, 0]);
    for (let i = 1; i < c.mutes.length; i++) {
      expect(c.mutes[i][0]).toBe(i % 2 ? 0 : 1);
      expect(c.mutes[i][1]).toBeGreaterThan(c.mutes[i - 1][1]);
    }
  });

  it('round-trips a patch through FL\'s .spln file layout (tag 4000, version 1000005, normalised controls)', () => {
    for (const sp of WT_SPLINE_PRESETS) {
      const p = patchFromSeed(sp.patch);
      const bytes = writeSpln(p);
      const dv = new DataView(bytes.buffer);
      expect([dv.getInt32(0, true), dv.getInt32(4, true)]).toEqual([4000, 1000005]);
      // the controls go through float32 (v -> value -> v): equal to an ulp
      const back = readSpln(bytes)!;
      expect(back.wave).toEqual(p.wave);
      expect(back.vol).toEqual(p.vol);
      expect(back.mutes).toEqual(p.mutes);
      for (const k of ['steps', 'speed', 'attack', 'release', 'start', 'end'] as const) expect(back[k], k).toBeCloseTo(p[k], 5);
      expect(back.mode).toBe(p.mode);
    }
    // the file stores the controls' 0..1 positions: 4 beats = 0.49206, absolute 100 % = 0.2
    const bytes = writeSpln(defaultPatch());
    const dv = new DataView(bytes.buffer);
    expect(dv.getFloat32(12, true)).toBeCloseTo(0.49206, 5);
    expect(dv.getFloat32(16, true)).toBeCloseTo(0.2, 6);
    expect(bytes.length).toBe(296);
    expect(readSpln(new Uint8Array(40))).toBeNull();
    expect(readSpln(bytes.slice(0, 100))).toBeNull();
  });
});

describe('control mappings (CWWarper 0x6d9a0..)', () => {
  it('maps wheel positions to steps / speed / attack / release as the plugin does', () => {
    expect(speedFromWheel(0, 0)).toBe(0.125);
    expect(speedFromWheel(0, 1)).toBe(8);
    expect(speedFromWheel(1, 0)).toBe(0.25);
    expect(speedFromWheel(1, 1)).toBe(4);
    expect(attackFromWheel(0)).toBe(1);
    expect(attackFromWheel(1)).toBe(500);
    expect(releaseFromWheel(1)).toBe(1000);
    for (const v of [0, 0.2, 0.49206, 0.75, 1]) {
      expect(speedToWheel(0, speedFromWheel(0, v))).toBeCloseTo(v, 6);
      expect(speedToWheel(1, speedFromWheel(1, v))).toBeCloseTo(v, 6);
      expect(attackToWheel(attackFromWheel(v))).toBeCloseTo(v, 6);
      expect(releaseToWheel(releaseFromWheel(v))).toBeCloseTo(v, 6);
    }
    // 4 beats show as 16 steps
    expect(speedText({ mode: 0, steps: 4, speed: 1 })).toBe('16.000 (Steps)');
    expect(speedText({ mode: 1, steps: 4, speed: 2 })).toBe('200 %');
  });
});

describe('spline tables (CWWarper.Rebuild, pinned to the plugin\'s patch objects)', () => {
  for (const t of WT_TABLES) {
    it(`builds the plugin's tables: ${t.name}`, () => {
      const patch = normalizePatch(t.state.patches ? (t.state.patches as Record<string, unknown>)['60'] ?? {} : {});
      const A = new Float32Array(WT_TABLE);
      const B = new Float32Array(WT_TABLE);
      const ia = buildTable(patch.wave, A);
      const ib = buildTable(patch.vol, B);
      expect(ia.last).toBe(t.waveLast);
      expect(ib.last).toBe(t.volLast);
      // entries past the last index are stale memory in the plugin (never read by a voice)
      t.at.forEach((idx, k) => {
        if (idx <= t.waveLast) expect(A[idx], `wave[${idx}]`).toBeCloseTo(t.wave[k], 6);
        if (idx <= t.volLast) expect(B[idx], `vol[${idx}]`).toBeCloseTo(t.vol[k], 6);
      });
    });
  }

  it('flattens the default line as FL does: x = i / 1022, the last entry short of 1 by float accumulation', () => {
    const tab = new Float32Array(WT_TABLE);
    const info = buildTable(defaultPatch().wave, tab);
    expect(info.last).toBe(1022);
    expect(tab[1]).toBe(Math.fround(1 / 1022));
    expect(tab[1022]).toBe(0.9999964237213135);
    expect(info.min).toBe(0);
    expect(info.max).toBeCloseTo(1, 5);
  });

  it('gives each segment round(dx x 1023) entries and shares the end points', () => {
    const pts = [newPoint(0, 0), newPoint(0.5, 0.5, WT_LINEAR, true), newPoint(1, 1)];
    const tab = new Float32Array(WT_TABLE);
    const { last } = buildTable(pts, tab);
    expect(last).toBe(round(0.5 * 1023) * 2 - 2);
    function round(x: number): number { return Math.round(x); }
    expect(tab[Math.round(0.5 * 1023) - 1]).toBeCloseTo(0.5, 2);
  });

  it('clamps entries to 0..1 and tracks the curve\'s unclamped minimum / maximum', () => {
    const pts: WtPoint[] = [newPoint(0, 0.5), newPoint(1, 0.5)];
    pts[0].y = 0.5;
    const tab = new Float32Array(WT_TABLE);
    // a curve through a point outside 0..1 can only come from the Bezier overshoot: handles beyond the range
    pts[0].type = WT_BEZIER;
    pts[0].h2x = 0.2; pts[0].h2y = 0.9;
    pts[1].h1x = -0.2; pts[1].h1y = -0.9;
    const info = buildTable(pts, tab);
    expect(info.max).toBeGreaterThan(0.9);
    for (let i = 0; i <= info.last; i++) { expect(tab[i]).toBeGreaterThanOrEqual(0); expect(tab[i]).toBeLessThanOrEqual(1); }
  });

  it('a Mute segment plays silence', () => {
    const pts = [newPoint(0, 0.7, WT_MUTE), newPoint(1, 0.9)];
    const tab = new Float32Array(WT_TABLE).fill(0.5);
    const { last } = buildTable(pts, tab);
    expect(last).toBe(1022);
    for (let i = 0; i <= last; i++) expect(tab[i]).toBe(0);
  });
});

describe('engine pinned to FL\'s renders (flfxhost, Wave Traveller_x64.dylib)', () => {
  for (const c of WT_GOLDEN) {
    it(`${c.name}: bit-exact at the sampled frames, same RMS and end`, () => {
      const o = hostOpts(c.hostArgs);
      const state = c.preset ? def.presets!.find((p) => p.name === c.preset)!.params : c.state;
      const { L, R } = renderWt({
        name: c.name, state, notes: c.notes, secs: c.frames / o.sr, sr: o.sr, pitch: o.pitch, pan: o.pan, root: o.root, interp: o.interp, rendering: o.rendering,
      }, testAudio(c.audio as WtAudioName));
      expect(L.length).toBe(c.frames);
      c.L.forEach((v, k) => expect(L[c.from + k * c.stride], `L[${c.from + k * c.stride}]`).toBeCloseTo(v, 6));
      c.R.forEach((v, k) => expect(R[c.from + k * c.stride], `R[${c.from + k * c.stride}]`).toBeCloseTo(v, 6));
      const e = new Float32Array(L.length * 2);
      e.set(L); e.set(R, L.length);
      if (c.rmsDb < -900) expect(rms(e)).toBe(0);
      else expect(20 * Math.log10(rms(e))).toBeCloseTo(c.rmsDb, 4);
      let last = -1;
      for (let i = L.length - 1; i >= 0; i--) if (L[i] !== 0 || R[i] !== 0) { last = i; break; }
      expect(last).toBe(c.last);
    });
  }
});

describe('voice behaviour', () => {
  const audio = testAudio('lcg');
  const base = { name: 'x', notes: '60:100:0:3', secs: 3.5 };

  it('plays nothing without a sample, for keys outside 0..119 and when the pool lacks the sample', () => {
    let have = false;
    const inst = gen.create(SR, 512, { sample: () => (have ? audio : undefined) });
    inst.setParams({ ...defaultWtState(), sample: 'S' });
    const note = (key: number) => ({ key, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 }, levels: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 } });
    expect(inst.triggerVoice!(note(60))).toBeNull();
    have = true;
    expect(inst.triggerVoice!(note(60))).not.toBeNull();
    for (const k of [-1, 120, 125, 200]) expect(inst.triggerVoice!(note(k))).toBeNull();
    const none = gen.create(SR, 512, { sample: () => undefined });
    none.setParams({ ...defaultWtState() });
    expect(none.triggerVoice!(note(60))).toBeNull();
  });

  it('a phrase takes steps x 60 / tempo seconds, then plays its last 256 outputs backwards (FL: 4 beats at 130 BPM)', () => {
    const r = renderWt({ ...base, state: dflt(), tempo: 130 }, audio);
    let last = -1;
    for (let i = r.L.length - 1; i >= 0; i--) if (r.L[i] !== 0) { last = i; break; }
    expect(last).toBe(81415 + 256);
    const slow = renderWt({ ...base, notes: '60:100:0:6', secs: 7, state: dflt(), tempo: 65 }, audio);
    let l2 = -1;
    for (let i = slow.L.length - 1; i >= 0; i--) if (slow.L[i] !== 0) { l2 = i; break; }
    expect(Math.abs(l2 - (2 * 81415 + 256))).toBeLessThanOrEqual(2);
  });

  it('the tail is the last 256 outputs reversed with a linear fade', () => {
    const r = renderWt({ ...base, state: dflt() }, audio);
    const end = 81415; // the last sample of the phrase is at 81414 or 81415
    const n = 256;
    // tail sample k (k = 0..255) = (256 - k) / 256 x the output k + 1 samples before the first tail sample
    let first = -1;
    for (let i = end - 5; i < end + 5; i++) {
      // find the alignment: out[i + k] = (256 - k)/256 x out[i - 1 - k] for the tail
      let ok = true;
      for (let k = 0; k < 20 && ok; k++) ok = Math.abs(r.L[i + k] - ((n - k) / n) * r.L[i - 1 - k]) < 1e-6;
      if (ok) { first = i; break; }
    }
    expect(first).toBeGreaterThan(0);
  });

  it('a note off starts REL: the voice ends when its level (1 at the sustain) has run down', () => {
    const p = normalizePatch({ ...defaultPatch(), release: 100 });
    const r = renderWt({ ...base, notes: '60:100:0:1', secs: 1.5, state: { patches: { 60: p } } }, audio);
    let last = -1;
    for (let i = r.L.length - 1; i >= 0; i--) if (r.L[i] !== 0) { last = i; break; }
    // 100 ms at 44.1 kHz: level -= 1000 / (100 x 44100) per sample from 1; the sample where it goes negative is dropped
    expect(last).toBeGreaterThan(SR + 4410 - 3);
    expect(last).toBeLessThan(SR + 4410 + 3);
  });

  it('ATT fades the voice in from 0', () => {
    const p = normalizePatch({ ...defaultPatch(), attack: 200 });
    const r = renderWt({ ...base, state: { patches: { 60: p } } }, audio);
    const early = rms(r.L.subarray(0, 200));
    const later = rms(r.L.subarray(20000, 20200));
    expect(early).toBeLessThan(0.005);
    expect(later).toBeGreaterThan(0.05);
  });

  it('a muted region decays instead of cutting (g = 0.99 g) and unmutes the same way', () => {
    const p = normalizePatch({ ...defaultPatch(), mutes: [[1, 0], [0, 0.25], [1, 0.5]] });
    const r = renderWt({ ...base, state: { patches: { 60: p } } }, audio);
    // the phrase is 81415 samples; the muted region is its second quarter
    const mid = Math.floor(81415 * 0.45);
    expect(rms(r.L.subarray(mid, mid + 500))).toBeLessThan(1e-30);
    expect(rms(r.L.subarray(Math.floor(81415 * 0.25), Math.floor(81415 * 0.25) + 100))).toBeGreaterThan(0);
    expect(rms(r.L.subarray(Math.floor(81415 * 0.6), Math.floor(81415 * 0.6) + 500))).toBeGreaterThan(0.03);
  });

  it('the pitch (channel knob / fine pitch) at the note start moves the speed, the key does not', () => {
    const lenOf = (r: { L: Float32Array }) => { for (let i = r.L.length - 1; i >= 0; i--) if (r.L[i] !== 0) return i; return -1; };
    const plain = lenOf(renderWt({ ...base, state: dflt() }, audio));
    const high = lenOf(renderWt({ ...base, state: dflt(), notes: '72:100:0:3' }, audio));
    expect(high).toBe(plain);
    const bent = lenOf(renderWt({ ...base, state: dflt(), pitch: 1200 }, audio));
    // speed x 2 at +1200 cents: half the phrase
    expect(Math.abs(bent - (plain / 2 + 128))).toBeLessThan(260);
  });

  it('absolute mode plays the region at the sample\'s speed x SPEED, whatever the tempo', () => {
    const p = normalizePatch({ ...defaultPatch(), mode: 1, speed: 1, start: 0, end: 1 });
    const a = renderWt({ ...base, secs: 3, state: { patches: { 60: p } }, tempo: 130 }, audio);
    const b = renderWt({ ...base, secs: 3, state: { patches: { 60: p } }, tempo: 60 }, audio);
    expect(Array.from(a.L.subarray(1000, 1100))).toEqual(Array.from(b.L.subarray(1000, 1100)));
    let last = -1;
    for (let i = a.L.length - 1; i >= 0; i--) if (a.L[i] !== 0) { last = i; break; }
    // the sample is 88200 frames (88199 intervals): the phrase takes (frames - 1) x 1022/1021... samples + the tail
    expect(Math.abs(last - (88199 + 256))).toBeLessThan(120);
  });

  it('a new sample ends the running voices (FL: LoadSample kills them) and the next note plays the new one', () => {
    let cur = testAudio('lcg');
    const inst = gen.create(SR, 512, { sample: () => cur });
    inst.setParams({ ...defaultWtState(), sample: 'S' });
    const mk = () => ({ key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 }, levels: { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 } });
    const v = inst.triggerVoice!(mk())!;
    const L = new Float32Array(16);
    const R = new Float32Array(16);
    expect(v.render(L, R, 16)).toBe(true);
    cur = testAudio('st48');
    inst.setParams({ ...defaultWtState(), sample: 'S' });
    L.fill(0); R.fill(0);
    expect(v.render(L, R, 16)).toBe(false);
    expect(Array.from(L).every((x) => x === 0)).toBe(true);
    expect(inst.triggerVoice!(mk())).not.toBeNull();
  });

  it('follows the live pan and volume of the voice every sample (FinalLevels)', () => {
    const inst = gen.create(SR, 512, { sample: () => testAudio('lcg') });
    inst.setParams({ ...defaultWtState(), sample: 'S' });
    const levels = { pan: 0, vol: 1, pitch: 6000, fcut: 0, fres: 0 };
    const v = inst.triggerVoice!({ key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: { ...levels }, levels })!;
    const L = new Float32Array(16);
    const R = new Float32Array(16);
    for (let i = 0; i < 50; i++) { L.fill(0); R.fill(0); v.render(L, R, 16); }
    levels.pan = 1; // hard right: the left gain decays towards 0, the right one rises (g = 0.99 g + 0.01 target)
    let lastL = 1;
    for (let i = 0; i < 300; i++) { L.fill(0); R.fill(0); v.render(L, R, 16); lastL = rms(L); }
    expect(lastL).toBeLessThan(0.01);
    levels.vol = 0;
    for (let i = 0; i < 400; i++) { L.fill(0); R.fill(0); v.render(L, R, 16); }
    expect(rms(R)).toBeLessThan(1e-3);
  });

  it('HQ export (hermite setting) switches to the windowed-sinc kernel; the project\'s live playback does not', () => {
    const fast = normalizePatch({ ...defaultPatch(), steps: 0.5, wave: [newPoint(0, 0), newPoint(0.25, 1, WT_LINEAR, true), newPoint(0.5, 0, WT_LINEAR, true), newPoint(0.75, 1, WT_LINEAR, true), newPoint(1, 0)] });
    const st = { patches: { 60: fast } };
    const live = renderWt({ ...base, secs: 1.5, state: st }, audio);
    const hq = renderWt({ ...base, secs: 1.5, state: st, rendering: true, interp: 'hermite6' }, audio);
    const sinc24 = renderWt({ ...base, secs: 1.5, state: st, rendering: true, interp: 'sinc24' }, audio);
    expect(Array.from(sinc24.L)).toEqual(Array.from(live.L));
    expect(Array.from(hq.L)).not.toEqual(Array.from(live.L));
  });

  it('keeps every output finite at extreme settings, keys and samples', () => {
    const wild: WtPoint[] = [newPoint(0, 0, WT_TENSION), newPoint(0.01, 1, WT_BEZIER, true), newPoint(0.02, 0, WT_QUARTER_SINE, true), newPoint(0.03, 0.9, WT_MUTE, true), newPoint(0.5, 0.1, WT_QUARTER_COSINE, true), newPoint(0.5005, 0.9, WT_HALF_COSINE, true), newPoint(1, 0.5)];
    wild[0].tension = 0.001; wild[1].h2x = 0.9; wild[1].h2y = -0.9; wild[2].h1x = -0.9;
    const patches: Record<number, WtPatch> = {
      60: normalizePatch({ ...defaultPatch(), steps: 0.125, attack: 500, release: 1, wave: wild }),
      61: normalizePatch({ ...defaultPatch(), steps: 8, speed: 4, mode: 1, start: 0.4, end: 0.4005, release: 1000 }),
      62: normalizePatch({ ...defaultPatch(), mode: 1, speed: 0.25, start: 1, end: 0, mutes: [[0, 0], [1, 0], [0, 0], [1, 1]] }),
      63: normalizePatch({ ...defaultPatch(), start: 0.999, end: 1 }),
    };
    const cases: [string, string, number | undefined, WtAudioName][] = [
      ['60:128:0:1,61:128:0:1,62:128:0:1,63:128:0:1,0:100:0:1,119:100:0:1', '', undefined, 'lcg'],
      ['60:100:0:1,61:100:0:0.001,62:100:0:2', '', -6000, 'tiny'],
      ['60:100:0:1,63:100:0:1', '', 6000, 'mono22'],
    ];
    for (const [notes, , pitch, aud] of cases) {
      for (const hq of [false, true]) {
        const r = renderWt({ name: 'w', state: { patches }, notes, secs: 1.2, pitch, tempo: 999, rendering: hq, interp: hq ? 'hermite6' : undefined, pan: 1 }, testAudio(aud));
        for (const b of [r.L, r.R]) for (const v of b) if (!Number.isFinite(v)) throw new Error(`non-finite output (hq ${hq}, ${notes})`);
      }
    }
    const slow = renderWt({ name: 'w', state: { patches }, notes: '60:100:0:1', secs: 0.5, tempo: 1 }, audio);
    for (const v of slow.L) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('spline editing logic (FL\'s TCSplnCtrl)', () => {
  const o: DragOptions = { shift: false, ctrl: false, alt: false, snap: 0, beats: 4 };
  const line = (): WtPoint[] => [newPoint(0, 0), newPoint(1, 1)];

  it('maps between values and the editor\'s 400 x 210 pixels (value 1 at the top)', () => {
    expect(toPx(0, 0)).toEqual([0, SPLINE_H - 1]);
    expect(toPx(1, 1)).toEqual([SPLINE_W - 1, 0]);
    const [x, y] = fromPx(...toPx(0.25, 0.75));
    expect(x).toBeCloseTo(0.25, 2);
    expect(y).toBeCloseTo(0.75, 2);
  });

  it('hits a point within 4 pixels, then the handles of Bezier segments and the Tension handle', () => {
    const pts = [newPoint(0, 0, WT_BEZIER), newPoint(0.5, 0.5, WT_TENSION, true), newPoint(1, 1)];
    const [px, py] = toPx(0.5, 0.5);
    expect(hitTest(pts, px + 4, py - 4)).toEqual({ index: 1, mode: 0 });
    expect(hitTest(pts, px + 5, py)).toBeNull();
    const [hx, hy] = handlePos(pts[0], 2);
    expect(hitTest(pts, hx, hy)).toEqual({ index: 0, mode: 2 });
    const [h1x, h1y] = handlePos(pts[1], 1);
    expect(hitTest(pts, h1x, h1y)).toEqual({ index: 1, mode: 1 });
    const [tx, ty] = tensionPos(pts, 1);
    expect(hitTest(pts, tx, ty)).toEqual({ index: 1, mode: 3 });
  });

  it('inserts a point of the page\'s type, locked, in time order; the border and the snap grid', () => {
    const pts = line();
    const at = addPointAt(pts, 200, 100, WT_HALF_COSINE, o);
    expect(at).toBe(1);
    expect(pts[1]).toMatchObject({ type: WT_HALF_COSINE, locked: true, tension: 0.5 });
    expect(pts).toHaveLength(3);
    expect(addPointAt(pts, 0, 100, WT_LINEAR, o)).toBe(-1);
    expect(addPointAt(pts, 399, 100, WT_LINEAR, o)).toBe(-1);
    expect(addPointAt(pts, 200, 0, WT_LINEAR, o)).toBe(-1);
    // 1/16 of a beat over 4 beats = 64 cells of 399 / 64 pixels
    const sn = line();
    addPointAt(sn, 203, 100, WT_LINEAR, { ...o, snap: 1 });
    expect(Math.round(toPx(sn[1].x, 0)[0] / (399 / 64))).toBeCloseTo(toPx(sn[1].x, 0)[0] / (399 / 64), 0);
    expect(Math.abs(toPx(sn[1].x, 0)[0] - Math.round(Math.round(203 / (399 / 64)) * (399 / 64)))).toBeLessThanOrEqual(1);
    // Alt inverts the setting: Off + Alt snaps to the 4 per beat grid
    const alt = line();
    addPointAt(alt, 203, 100, WT_LINEAR, { ...o, alt: true });
    expect(Math.abs(toPx(alt[1].x, 0)[0] - Math.round(Math.round(203 / (399 / 16)) * (399 / 16)))).toBeLessThanOrEqual(1);
  });

  it('drags a point: end points only vertically, others keep one pixel from their neighbours; Shift / Ctrl lock a direction', () => {
    const pts = [newPoint(0, 0), newPoint(0.3, 0.3, WT_LINEAR, true), newPoint(0.6, 0.6, WT_LINEAR, true), newPoint(1, 1)];
    applyDrag(pts, { index: 0, mode: 0 }, 150, 50, o);
    expect(pts[0].x).toBe(0);
    expect(pts[0].y).toBeCloseTo(1 - 50 / 209, 2);
    applyDrag(pts, { index: 1, mode: 0 }, 300, 100, o);
    expect(pts[1].x).toBeLessThan(pts[2].x);
    expect(pts[1].x).toBeCloseTo(pts[2].x - 1 / 399, 5);
    applyDrag(pts, { index: 2, mode: 0 }, 5, 100, o);
    expect(pts[2].x).toBeCloseTo(pts[1].x + 1 / 399, 5);
    const lockY = [newPoint(0, 0), newPoint(0.3, 0.3, WT_LINEAR, true), newPoint(1, 1)];
    applyDrag(lockY, { index: 1, mode: 0 }, 200, 20, { ...o, shift: true }, { x: 0.3, y: 0.3 });
    expect(lockY[1].y).toBeCloseTo(0.3, 6);
    expect(lockY[1].x).toBeCloseTo(200 / 399, 3);
    const lockX = [newPoint(0, 0), newPoint(0.3, 0.3, WT_LINEAR, true), newPoint(1, 1)];
    applyDrag(lockX, { index: 1, mode: 0 }, 200, 20, { ...o, ctrl: true }, { x: 0.3, y: 0.3 });
    expect(lockX[1].x).toBeCloseTo(0.3, 6);
    expect(lockX[1].y).toBeCloseTo(1 - 20 / 209, 3);
  });

  it('drags Bezier handles on their side of the point (a locked point mirrors the other) and the Tension handle within 0.001..0.999', () => {
    const pts = [newPoint(0, 0, WT_BEZIER), newPoint(0.5, 0.5, WT_BEZIER, true), newPoint(1, 1)];
    applyDrag(pts, { index: 1, mode: 2 }, toPx(0.6, 0.7)[0], toPx(0.6, 0.7)[1], o);
    expect(pts[1].h2x).toBeCloseTo(0.1, 1);
    expect(pts[1].h1x).toBeCloseTo(-pts[1].h2x, 6);
    expect(pts[1].h1y).toBeCloseTo(-pts[1].h2y, 6);
    applyDrag(pts, { index: 1, mode: 2 }, toPx(0.3, 0.7)[0], toPx(0.3, 0.7)[1], o);
    expect(pts[1].h2x).toBeGreaterThan(0);
    const free = [newPoint(0, 0, WT_BEZIER), newPoint(1, 1)];
    applyDrag(free, { index: 1, mode: 1 }, toPx(0.95, 0.5)[0], toPx(0.95, 0.5)[1], o);
    expect(free[1].h1x).toBeLessThan(0);
    const tn = [newPoint(0, 0, WT_TENSION), newPoint(1, 1)];
    applyDrag(tn, { index: 0, mode: 3 }, 100, toPx(0, 0.25)[1], o);
    expect(tn[0].tension).toBeCloseTo(0.25, 1);
    applyDrag(tn, { index: 0, mode: 3 }, 100, 0, o);
    expect(tn[0].tension).toBeCloseTo(0.999, 3);
    applyDrag(tn, { index: 0, mode: 3 }, 100, SPLINE_H - 1, o);
    expect(tn[0].tension).toBeCloseTo(0.001, 3);
  });

  it('deletes points except the first and the last', () => {
    const pts = [newPoint(0, 0), newPoint(0.5, 0.5, WT_LINEAR, true), newPoint(1, 1)];
    expect(deletePoint(pts, 0)).toBe(false);
    expect(deletePoint(pts, 2)).toBe(false);
    expect(deletePoint(pts, 1)).toBe(true);
    expect(pts).toHaveLength(2);
  });

  it('Normalize 100 % stretches the WAVE curve to 0..1 and moves START / END to what it covered; 50 % maps to 0.25..0.75', () => {
    const p = normalizePatch({ ...defaultPatch(), start: 0.1, end: 0.9, wave: [newPoint(0, 0.2), newPoint(0.5, 0.6, WT_LINEAR, true), newPoint(1, 0.4)] });
    const q = clonePatch(p);
    expect(normalize100(q)).toBe(true);
    // FL uses the table's min / max: float32 accumulation leaves the peak a hair below 0.6
    expect(q.wave[0].y).toBe(0);
    expect(q.wave[1].y).toBeCloseTo(1, 4);
    expect(q.wave[2].y).toBeCloseTo(0.5, 4);
    expect(q.start).toBeCloseTo(0.1 + 0.8 * 0.2, 5);
    expect(q.end).toBeCloseTo(0.1 + 0.8 * 0.6, 5);
    const h = clonePatch(p);
    expect(normalize50(h)).toBe(true);
    expect(h.wave[0].y).toBeCloseTo(0.25, 4);
    expect(h.wave[1].y).toBeCloseTo(0.75, 4);
    expect([h.start, h.end]).toEqual([p.start, p.end]);
    // a flat curve is left alone
    const flat = normalizePatch({ ...defaultPatch(), wave: [newPoint(0, 0.5), newPoint(1, 0.5)] });
    expect(normalize100(clonePatch(flat))).toBe(false);
    expect(normalize50(clonePatch(flat))).toBe(false);
  });

  it('paints the mutes strip: muted regions drop out, unmuting restores them, lists stay minimal', () => {
    let m = paintMutes([[1, 0]], 0.2, 0.4, 0);
    expect(m).toEqual([[1, 0], [0, 0.2], [1, 0.4]].map((x) => [x[0], Math.fround(x[1])]));
    expect(mutedAt(m, 0.1)).toBe(false);
    expect(mutedAt(m, 0.3)).toBe(true);
    expect(mutedAt(m, 0.41)).toBe(false);
    m = paintMutes(m, 0.3, 0.6, 0);
    expect(mutedAt(m, 0.5)).toBe(true);
    expect(mutedAt(m, 0.7)).toBe(false);
    expect(m.filter((x) => x[0] === 0)).toHaveLength(1);
    m = paintMutes(m, 0, 1, 1);
    expect(m).toEqual([[1, 0]]);
    m = paintMutes([[1, 0]], 0, 0.3, 0);
    expect(m[0]).toEqual([0, 0]);
    expect(mutedAt(m, 0.1)).toBe(true);
  });
});

describe('Wave Traveller editor', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { editor } = await import('../../src/ui/plugins/gen/wavetraveller');
  const { editPatchIn, patchLabel, oggInWav } = await import('../../src/ui/plugins/gen/wavetraveller/ops');

  function setup() {
    const id = A.addGenChannel('wavetraveller');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    const render = () => {
      const ctx = { slotId, plugin: 'wavetraveller', params: params(), trackName: 'Wave Traveller', pluginName: 'Wave Traveller' };
      return renderToStaticMarkup(React.createElement(FxEditorContext.Provider, { value: ctx }, React.createElement(editor.Editor)));
    };
    return { id, slotId, params, render };
  }

  it('lays out FL\'s form: 715 x 224 panel, five wheels, the captions, the patch label, five displays', () => {
    const { render } = setup();
    const html = render();
    expect(html).toContain('width:715px;height:224px');
    expect((html.match(/fxk-wheel/g) ?? []).length).toBe(5);
    for (const t of ['SPEED', 'T-A', 'ATT', 'REL', 'WAVE', 'traveller', 'Patch C5']) expect(html, t).toContain(t);
    expect((html.match(/<canvas/g) ?? []).length).toBe(5);
    // form coordinates: spline editor 400 x 210 at 253, vertical scope 61 x 210 at 654, mutes 400 x 13 at (253, 211)
    expect(html).toContain('left:253px;top:0;width:400px;height:210px');
    expect(html).toContain('left:654px;top:0;width:61px;height:210px');
    expect(html).toContain('left:253px;top:211px;width:400px;height:13px');
    expect(html).toContain('left:0;top:162px;width:252px;height:62px');
  });

  it('shows the sample name, the VOL page and a named patch', () => {
    const { id, slotId, render } = setup();
    A.editFx(slotId, 'test', (d) => {
      const p = d as Record<string, unknown>;
      p.file = 'VOC_Go.wav'; p.part = 1; p.key = 65;
      editPatchIn(p, 65, (q) => { q.name = 'kick4'; });
    });
    void id;
    const html = render();
    expect(html).toContain('VOC_Go.wav');
    expect(html).toContain('VOL');
    expect(html).toContain('kick4');
    expect(patchLabel(65, '')).toBe('Patch F5');
    expect(patchLabel(60, '')).toBe('Patch C5');
    expect(patchLabel(66, '')).toBe('Patch F#5');
  });

  it('a patch edited back to the default patch leaves the state\'s sparse map', () => {
    const { slotId, params } = setup();
    A.editFx(slotId, 'e', (d) => editPatchIn(d as Record<string, unknown>, 61, (p) => { p.steps = 2; }));
    expect(Object.keys((params().patches ?? {}) as object)).toEqual(['61']);
    A.editFx(slotId, 'e', (d) => editPatchIn(d as Record<string, unknown>, 61, (p) => { p.steps = 4; }));
    expect(Object.keys((params().patches ?? {}) as object)).toEqual([]);
  });

  it('finds the Ogg stream inside FL\'s Ogg-in-WAV pack samples, nothing in PCM or damaged files', () => {
    const wav = (fmtTag: number, payload: number[], dataLen = payload.length) => {
      const fmt = new Uint8Array(16); new DataView(fmt.buffer).setUint16(0, fmtTag, true);
      const head = (id: string, n: number) => {
        const h = new Uint8Array(8); for (let i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
        new DataView(h.buffer).setUint32(4, n, true); return [...h];
      };
      const body = [...'WAVE'].map((c) => c.charCodeAt(0)).concat(head('fmt ', 16), [...fmt], head('data', dataLen), payload);
      return new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat(head('', body.length).slice(4), body)).buffer;
    };
    const ogg = [...'OggS'].map((c) => c.charCodeAt(0)).concat(new Array(60).fill(7));
    const hit = oggInWav(wav(0x674f, ogg));
    expect(hit).not.toBeNull();
    expect(hit!.size).toBe(ogg.length);
    expect(hit!.type).toBe('audio/ogg');
    // a data chunk that claims more than the file holds is read up to the end of the file
    expect(oggInWav(wav(0x6751, ogg, 100000))!.size).toBe(ogg.length);
    // PCM (tag 1), a Vorbis tag without an Ogg stream, tiny and non-RIFF buffers
    expect(oggInWav(wav(1, ogg))).toBeNull();
    expect(oggInWav(wav(0x674f, new Array(64).fill(0)))).toBeNull();
    expect(oggInWav(new ArrayBuffer(10))).toBeNull();
    expect(oggInWav(new Uint8Array(200).buffer)).toBeNull();
  });

  it('has the plugin window menu items (Continuous output, Import FL content)', () => {
    const { slotId } = setup();
    const items = editor.menu!(slotId);
    expect(items.map((i) => i.label).filter(Boolean)).toEqual(['Continuous output', 'Import FL content...', 'Import FL content from files...']);
  });
});
