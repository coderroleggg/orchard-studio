// Autogun (FL: Autogun_x64.dylib): registration, the one parameter, the state, the preset generator and the engine, pinned to FL Studio
// 2026's own plugin (digests of the presets it generates, hashes of its renders in the test host, of its hosted Soundgoodizer on noise).
// No FL files are used; the goldens are numbers.
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { def } from '../../src/model/gen/plugins/autogun';
import { GEN_DEFS, defaultGenParams, genDef, normalizeGenParams } from '../../src/model/gen/registry';
import {
  AG_DUST_DEFAULT, AG_PRESETS, AG_QUALITIES, AUTOGUN_PARAMS, autogunPatch, counterOf, counterOfNumber, freshState, infoOf, normalizeAutogun,
  ogunStateOf, presetInfo, presetNumber, randomCounter,
} from '../../src/model/gen/plugins/autogun/state';
import { generateOgun } from '../../src/model/gen/plugins/ogun/random';
import { parseOgunState } from '../../src/model/gen/plugins/ogun/flstate';
import { OGUN_KEYS } from '../../src/model/gen/plugins/ogun/params';
import { gen, AutogunInstance } from '../../src/engine/gen/plugins/autogun';
import { AUTOGUN_SG } from '../../src/engine/gen/plugins/autogun/sgdata';
import { SgEngine } from '../../src/engine/gen/plugins/harmor/fx-comp-sg';
import { createGenChannel } from '../../src/model/defaults';
import type { GenContext, GenVoice, GenVoiceParams } from '../../src/engine/gen/types';
import { digest, fromModel } from './ogun-random-util';
import { RANDOM_GOLDEN } from './autogun-random.golden';
import { GOLDEN } from './autogun.golden';
import { renderCase, type Case } from './autogun-render';
import { hashFrames } from './ogun-render';
import { makeEngine, play, peak, firstNonZero } from './util';

const f32 = Math.fround;

describe('Autogun: registration', () => {
  it('is the Synth special instrument with FL\'s one parameter, the master level', () => {
    expect(genDef('autogun')).toBe(def);
    expect(GEN_DEFS.some((d) => d.id === 'autogun')).toBe(true);
    expect(def.name).toBe('Autogun');
    expect(def.category).toBe('Synth special');
    expect(def.notes).toBe('voices');
    expect(def.levels).toBe('plugin');
    expect([def.width, def.height]).toEqual([282, 379]);
    // FL: NumParams 1 ("Master level", 0 .. 256, FL's form default 256 = 200 %)
    expect(def.params).toBe(AUTOGUN_PARAMS);
    expect(def.params).toHaveLength(1);
    const p = def.params[0];
    expect([p.key, p.name, p.index, p.min, p.max, p.def]).toEqual(['level', 'Master level', 0, 0, 256, 256]);
  });

  it('shows the master level as FL does at every value (digest of the test host\'s sweep) and the known values', () => {
    const p = def.params[0];
    let h = 2166136261;
    for (let v = 0; v <= 256; v++) {
      for (const ch of `${v}:${p.format!(v, {})}\n`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    }
    expect(h).toBe(0xbbc99a9f);
    expect([0, 1, 119, 122, 128, 134, 255, 256].map((v) => p.format!(v, {}))).toEqual(['0%', '1%', '93%', '95%', '100%', '105%', '199%', '200%']);
  });
});

describe('Autogun: state', () => {
  it('a new instance has a random preset, magic dust 430, quality 1 and the master level 256 (FL\'s constructor)', () => {
    const s = defaultGenParams('autogun');
    expect(s.level).toBe(256);
    expect(s.dust).toBe(AG_DUST_DEFAULT);
    expect(s.dust).toBe(430);
    expect(s.quality).toBe(1);
    expect(Number.isInteger(s.n)).toBe(true);
    expect(s.n as number).toBeGreaterThanOrEqual(0);
    expect(s.n as number).toBeLessThan(AG_PRESETS);
    expect(Object.keys(s).sort()).toEqual(['dust', 'level', 'n', 'quality']);
    // two new instances (almost surely) hold different presets
    const seen = new Set<number>();
    for (let i = 0; i < 6; i++) seen.add(defaultGenParams('autogun').n as number);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('draws the counter like FL\'s constructor (Random * 2^32, rounded, 32 bit) and numbers presets from 1', () => {
    expect(randomCounter(() => 0)).toBe(0);
    expect(randomCounter(() => 0.5)).toBe(2147483648);
    expect(randomCounter(() => 1)).toBe(0); // 2^32 wraps
    expect(randomCounter(() => 0.9999999999)).toBe(0); // rounds to 2^32 too
    expect(randomCounter(() => 0.25)).toBe(1073741824);
    expect(presetNumber(0)).toBe(1);
    expect(presetNumber(4294967295)).toBe(4294967296);
    expect(counterOfNumber(1)).toBe(0);
    expect(counterOfNumber(4294967296)).toBe(4294967295);
    expect(counterOf(-1)).toBe(4294967295); // 32 bit arithmetic: the preset before the first is the last
    expect(counterOf(4294967296 + 7)).toBe(7);
    expect(counterOf('x')).toBe(0);
  });

  it('repairs a stored state: dust 0 .. 1000, quality 0 .. 4, the counter an unsigned 32 bit integer; stored states keep their counter', () => {
    expect(normalizeAutogun({ level: 10, dust: 5000, n: 3.7, quality: 9 })).toMatchObject({ dust: 1000, n: 3, quality: 4, level: 10 });
    expect(normalizeAutogun({ dust: -5, n: -2, quality: -1 })).toMatchObject({ dust: 0, n: 4294967294, quality: 0 });
    expect(normalizeAutogun({})).toMatchObject({ dust: 430, n: 0, quality: 1 });
    const st = { level: 100, dust: 7, n: 123456, quality: 3 };
    expect(normalizeGenParams('autogun', JSON.parse(JSON.stringify(st)))).toEqual(st);
    expect(normalizeGenParams('autogun', { n: 9 }).level).toBe(256);
    expect(AG_QUALITIES).toEqual(['Draft', 'Average', 'High', 'Pristine', 'Huge waste of CPU']);
  });
});

describe('Autogun: the preset generator (pinned to FL Studio 2026)', () => {
  it('makes the presets FL makes for 38 numbers (parameters, envelopes, maps and info text) and Ogun\'s for the same numbers apart from the text', () => {
    const bad: string[] = [];
    for (const [k, g] of Object.entries(RANDOM_GOLDEN)) {
      const n = +k;
      const st = ogunStateOf({ n, level: 256, dust: 430, quality: 1 }) as Record<string, unknown>;
      const d = digest(fromModel(st), false);
      if (d.ints !== g.ints) bad.push(`${k}: ints`);
      if (d.info !== g.info) bad.push(`${k}: info`);
      if (d.arts !== g.arts) bad.push(`${k}: arts`);
      g.maps.forEach((m, j) => { if (d.maps[j] !== m) bad.push(`${k}: map ${j}`); });
      // the patch is Ogun's: only the master level (kept by Autogun, 128 in Ogun's) and the text differ
      const og = digest(fromModel(generateOgun(n) as Record<string, unknown>), false);
      expect(d.arts, `arts ${k}`).toBe(og.arts);
      expect(d.maps, `maps ${k}`).toEqual(og.maps);
    }
    expect(bad).toEqual([]);
    expect(Object.keys(RANDOM_GOLDEN).length).toBeGreaterThanOrEqual(38);
  }, 120000);

  it('writes the info text with the memo\'s style codes: title, author, description (numbers 1 to 3 as FL generates them)', () => {
    const t1 = autogunPatch(1).info as string;
    expect(t1).toBe('Synthesizer\rdonatello\rPretty good, much like old synthesizers tweaked by yo motha.');
    expect(infoOf(t1)).toEqual({ title: 'Synthesizer', author: 'donatello', lines: ['Pretty good, much like old synthesizers tweaked by yo motha.'] });
    expect(autogunPatch(2).info).toBe('Fading air\rThe Enforcer\rCaptures the timbre but shiny.');
    expect(presetInfo(3)).toEqual({
      title: 'BlurryInstrument', author: 'donatello',
      lines: ['Some variation in the dithering I mean complex.', 'Reminds me of Elvis chased by police.'],
    });
    // Ogun's text of the same number has no author line and other title words (one draw fewer)
    expect(generateOgun(2).info).not.toContain('');
    expect(infoOf('Plain title\rline')).toEqual({ title: 'Plain title', author: '', lines: ['line'] });
  });

  it('keeps the plugin\'s own level, quality and magic dust in the Ogun state it plays and reuses a given patch', () => {
    const patch = autogunPatch(5);
    const a = ogunStateOf({ n: 5, level: 77, dust: 123, quality: 3 }, patch) as Record<string, unknown>;
    expect(a.level).toBe(77);
    expect((a.xi as number[])[5]).toBe(3);
    expect((a.xi as number[])[14]).toBe(123);
    expect(a.maps).toBe(patch.maps); // not copied
    expect(a.arts).toBe(patch.arts);
    // the cached patch is not touched
    expect((patch.xi as number[])[5]).toBe(1);
    expect((patch.xi as number[])[14]).toBe(430);
    expect(autogunPatch(5)).toBe(patch);
    expect(autogunPatch(6)).not.toBe(patch);
    // everything else is the generator's
    const b = ogunStateOf({ n: 5, level: 256, dust: 430, quality: 1 }) as Record<string, unknown>;
    for (const k of OGUN_KEYS.slice(1, 49)) expect(b[k], k).toBe(patch[k]);
    expect(b.xi).toEqual(patch.xi);
  });

  it('keeps the values FL\'s state holds that a control cannot take (the "Large hall" reverb has a low cut of 0, the control\'s minimum is 19)', () => {
    let n = 1;
    while ((generateOgun(n) as Record<string, number>).revLow !== 0 && n < 400) n++;
    expect((generateOgun(n) as Record<string, number>).revLow).toBe(0);
    expect(autogunPatch(n).revLow).toBe(0);
  });

  it('reads the state FL\'s Autogun saves (the preset counter between the info text and the articulators) and loses nothing', () => {
    class Bytes {
      a: number[] = [];
      private dv = new DataView(new ArrayBuffer(8));
      i32(v: number) { this.dv.setInt32(0, v, true); for (let i = 0; i < 4; i++) this.a.push(this.dv.getUint8(i)); return this; }
      f32(v: number) { this.dv.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.a.push(this.dv.getUint8(i)); return this; }
      f64(v: number) { this.dv.setFloat64(0, v, true); for (let i = 0; i < 8; i++) this.a.push(this.dv.getUint8(i)); return this; }
      u8(v: number) { this.a.push(v & 255); return this; }
    }
    type Env = { t: number; p: number[][]; m: number[]; a?: number[]; l?: number[]; ph?: number };
    const curve = (c: Env, w: Bytes): void => {
      w.i32(c.t).i32(3).i32(c.p.length);
      for (const q of c.p) { w.f64(q[0]).f64(q[1]).f32(q[2]); for (let k = 3; k < 7; k++) w.u8(q[k] ?? 0); }
      for (const v of c.m) w.i32(v);
      if (c.t === 1) for (const v of c.a!) w.i32(v);
      if (c.t === 2) { for (const v of c.l!) w.i32(v); w.i32(c.ph ?? 0); }
    };
    const n = 9; // a pad preset: small maps
    const st = ogunStateOf({ n, level: 256, dust: 430, quality: 1 }) as Record<string, unknown>;
    const ints = [...OGUN_KEYS.slice(0, 49).map((k) => st[k] as number), ...(st.xi as number[])];
    const w = new Bytes();
    for (let i = 0; i < 3; i++) w.i32(ints[i]);
    const region = new Uint8Array(244), dv = new DataView(region.buffer);
    for (let i = 0; i < 46; i++) dv.setInt32(4 * i, ints[3 + i], true);
    for (let k = 0; k < 15; k++) dv.setInt32(0x200 - 0x148 + 4 * k, ints[49 + k], true);
    for (const b of region) w.u8(b);
    for (const b of st.b3 as number[]) w.u8(b);
    for (const e of st.i2 as number[]) w.i32(e);
    const info = st.info as string;
    expect(info.length).toBeLessThan(255);
    w.u8(info.length);
    for (const ch of info) w.u8(ch.charCodeAt(0)).u8(ch.charCodeAt(0) >> 8);
    w.i32(n); // the preset counter
    for (const a of st.arts as { mode: number; ea: number; la: number; e: Env; l: Env; k: Env[] }[]) {
      w.i32(3).f32(a.mode).f32(a.ea).f32(a.la);
      curve(a.e, w); curve(a.l, w);
      for (const k of a.k) curve(k, w);
    }
    for (const m of st.maps as Env[]) curve(m, w);
    const z = deflateSync(Uint8Array.from(w.a));
    const blob = new Uint8Array(4 + z.length);
    new DataView(blob.buffer).setUint32(0, 0x130003, true);
    blob.set(z, 4);
    const fl = parseOgunState(blob, true, true); // as stored: this writer's maps are the model's, not FL's re-saved ones
    expect(fl.counter).toBe(n);
    expect(fl.ints).toEqual(ints);
    expect(fl.info).toBe(info);
    expect(digest({ ints: fl.ints, b3: fl.b3, eq: fl.eq, info: fl.info, arts: fl.arts, maps: fl.maps }, false)).toEqual(digest(fromModel(st), false));
    // the same bytes read as an Ogun state (no counter) are not valid
    expect(() => parseOgunState(blob)).toThrow();
    expect(parseOgunState(blob, false, true).counter).toBe(9);
  }, 60000);
});

describe('Autogun: sound (pinned to FL Studio 2026)', () => {
  for (const g of GOLDEN) {
    it(`${g.name}: preset ${g.state.n + 1}, ${g.sr} Hz, block ${g.block}${g.mode ? ', ' + g.mode : ''} is FL's render bit for bit`, () => {
      const [L, R] = renderCase({ ...(g as Case), law: 'fl' });
      expect(L).toHaveLength(g.frames);
      for (const [i, l, r] of g.picks) {
        expect(L[i]).toBe(l);
        expect(R[i]).toBe(r);
      }
      expect(hashFrames(L, R).toString(16)).toBe(g.hash.toString(16));
    }, 120000);
  }
  it('covers the magic dust off and on, every quality, 22 - 96 kHz, blocks 1 - 1024, export, overlapping notes, tempo 60, polyphony, level automation and large pad maps', () => {
    const names = GOLDEN.map((g) => g.name).join(' ');
    for (const k of ['dust_off', 'dust_full', 'quality_huge', 'quality_draft', '22k_block_1', '96k_block_1024', '48k_block_64', 'export', 'tempo_60', 'max_poly', 'level_automation', 'resynthesis', 'pad_map']) {
      expect(names, k).toContain(k);
    }
    expect(GOLDEN.length).toBeGreaterThanOrEqual(19);
  });
});

describe('Autogun: the Soundgoodizer (FL\'s hosted SGv2 with Data/SG.dat), pinned to FL Studio 2026', () => {
  /** [mix = magic dust, block, amplitude, sample rate, seed, frames, FNV-1a of the bytes of FL's SGv2 output on the noise]. */
  const SG_GOLDEN: [number, number, number, number, number, number, number][] = [
    [430, 512, 3.5, 44100, 1207, 60000, 2383820301],
    [1000, 512, 1.2, 44100, 1777, 60000, 2310496984],
    [1, 16, 2, 44100, 778, 60000, 3754144738],
    [777, 1024, 3, 44100, 1554, 60000, 367844275],
    [430, 64, 3, 48000, 1207, 60000, 3605934853],
    [430, 512, 3, 22050, 1207, 60000, 2609701279],
    [0, 512, 1, 44100, 777, 60000, 691072699],
  ];
  /** Noise in steps of level with silent gaps (up to `amp`), a deterministic generator. */
  function noise(frames: number, seed: number, amp: number): Float32Array {
    const a = new Float32Array(frames * 2);
    let s = seed;
    for (let i = 0; i < frames; i++) {
      const seg = Math.floor(i / 3000);
      const env = seg % 7 === 3 ? 0 : ((seg % 20) * amp) / 20 + 0.02;
      for (let c = 0; c < 2; c++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[2 * i + c] = f32((s / 4294967296 - 0.5) * 2 * env); }
    }
    return a;
  }
  const fnv = (a: Float32Array): number => {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    let h = 2166136261;
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619) >>> 0;
    return h >>> 0;
  };
  for (const [mix, block, amp, sr, seed, frames, hash] of SG_GOLDEN) {
    it(`mix ${mix}, block ${block}, ${sr} Hz, levels up to ${amp}: every sample is FL's`, () => {
      const e = new SgEngine(sr, block);
      e.load(AUTOGUN_SG);
      e.setMix(mix);
      const out = noise(frames, seed, amp);
      for (let o = 0; o < frames; o += block) e.process(out.subarray(2 * o, 2 * (o + Math.min(block, frames - o))), Math.min(block, frames - o));
      expect(fnv(out)).toBe(hash);
    });
  }
  it('has a latency of 153 samples at 44.1 kHz and the low cut on (parameter 6 = 32768, 20 Hz) that removes DC', () => {
    const e = new SgEngine(44100, 512);
    e.load(AUTOGUN_SG);
    e.setMix(1000);
    expect(e.latency).toBe(153);
    const buf = new Float32Array(2 * 512);
    let last = 0;
    for (let k = 0; k < 120; k++) { buf.fill(0.05); e.process(buf, 512); last = buf[2 * 511]; }
    expect(Math.abs(last)).toBeLessThan(0.01);
  });
});

describe('Autogun: the engine', () => {
  const ctx: GenContext = { sampleRate: 44100, blockSize: 16, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0 };
  const mk = (key = 60): GenVoiceParams => ({
    key, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0,
    init: { pan: 0, vol: 1, pitch: 6000 + 100 * (key - 60), fcut: 0, fres: 0 },
    levels: { pan: 0, vol: 1, pitch: 6000 + 100 * (key - 60), fcut: 0, fres: 0 },
  });
  function render(st: Record<string, unknown>, frames = 8832, key = 60, release = 4416): [Float32Array, Float32Array, AutogunInstance] {
    const inst = gen.create(44100, 16, { sample: () => undefined }) as AutogunInstance;
    inst.setParams(st);
    inst.setRandomCounter(1700000000);
    const v: GenVoice = inst.triggerVoice(mk(key), ctx)!;
    const L = new Float32Array(frames), R = new Float32Array(frames);
    const bl = new Float32Array(16), br = new Float32Array(16);
    let alive = true;
    for (let o = 0; o < frames; o += 16) {
      bl.fill(0); br.fill(0);
      if (o === release) v.release();
      if (alive) alive = v.render(bl, br, 16);
      inst.render(bl, br, 16, ctx);
      L.set(bl, o); R.set(br, o);
    }
    return [L, R, inst];
  }

  it('plays the generated patch; the magic dust adds the Soundgoodizer\'s 153 samples of latency; level 0 is silent', () => {
    const base = { level: 256, n: 5, quality: 1 };
    const [dry] = render({ ...base, dust: 0 });
    const [wet] = render({ ...base, dust: 430 });
    const [off] = render({ ...base, dust: 430, level: 0 });
    expect(peak(dry)).toBeGreaterThan(0.1);
    expect(peak(wet)).toBeGreaterThan(0.1);
    expect(peak(off)).toBeLessThan(1e-20); // silent (the Soundgoodizer's filters leave denormal-sized noise)
    expect(firstNonZero(wet)).toBeGreaterThanOrEqual(firstNonZero(dry) + 150);
    expect(firstNonZero(wet)).toBeLessThanOrEqual(firstNonZero(dry) + 160);
    let diff = 0;
    for (let i = 0; i < dry.length; i++) if (dry[i] !== wet[i]) diff++;
    expect(diff).toBeGreaterThan(dry.length / 2);
  });

  it('is Ogun\'s engine with its master level times 0.25 (the same patch plays 4x louder in Ogun at the same level)', () => {
    const inst = gen.create(44100, 16, { sample: () => undefined }) as AutogunInstance;
    inst.setParams({ level: 256, dust: 0, n: 5, quality: 1 });
    expect(inst.og.plug.masterScale).toBe(0.25);
    expect(inst.og.plug.master).toBe(1); // (3^2 - 1) / 2 = 4, x 0.25
    inst.setParams({ level: 128, dust: 0, n: 5, quality: 1 });
    expect(inst.og.plug.master).toBe(0.25);
    inst.setParams({ level: 0, dust: 0, n: 5, quality: 1 });
    expect(inst.og.plug.master).toBe(0);
  });

  it('keeps the generated patch while only the level, dust or quality change (a generation takes tens of milliseconds) and makes a new one for a new number', () => {
    const inst = gen.create(44100, 16, { sample: () => undefined }) as AutogunInstance;
    inst.setParams({ level: 256, dust: 430, n: 5, quality: 1 });
    const a = inst.og.plug['lastParams'] as Record<string, unknown>;
    inst.setParams({ level: 100, dust: 900, n: 5, quality: 2 });
    const b = inst.og.plug['lastParams'] as Record<string, unknown>;
    expect(b).not.toBe(a);
    expect(b.maps).toBe(a.maps);
    expect(b.arts).toBe(a.arts);
    expect(b.level).toBe(100);
    inst.setParams({ level: 100, dust: 900, n: 6, quality: 2 });
    const c = inst.og.plug['lastParams'] as Record<string, unknown>;
    expect(c.maps).not.toBe(a.maps);
    expect(c.info).not.toBe(a.info);
  });

  it('sounds on for the Soundgoodizer\'s silence gate after the last voice while the dust is up, and stops asking for audio when it is off (no delay or reverb)', () => {
    const inst = gen.create(44100, 16, { sample: () => undefined }) as AutogunInstance;
    // a preset without delay and reverb: its effects have no tail of their own
    let n = 1;
    for (; n < 400; n++) {
      const s = autogunPatch(n);
      if (((s.xi as number[])[4] & 255) === 0 && (s.b3 as number[])[1] === 0) break;
    }
    inst.setParams({ level: 256, dust: 0, n, quality: 1 });
    const t0 = inst.tail;
    inst.setParams({ level: 256, dust: 430, n, quality: 1 });
    expect(inst.tail).toBeGreaterThanOrEqual(1.5);
    expect(inst.tail).toBeGreaterThanOrEqual(t0);
    inst.setParams({ level: 256, dust: 0, n, quality: 1 });
    expect(inst.tail).toBe(t0);
  });

  it('stays finite at the extremes: all keys, velocities, quality 4, level and dust at their limits, blocks of 1 to 1024', () => {
    for (const [key, q, level, dust, block] of [[0, 4, 256, 1000, 1], [131, 0, 256, 1000, 1024], [60, 3, 0, 1, 64], [24, 2, 128, 250, 128], [96, 4, 200, 777, 16]]) {
      const inst = gen.create(48000, block, { sample: () => undefined }) as AutogunInstance;
      inst.setParams({ level, dust, n: 4294967295, quality: q });
      const c: GenContext = { ...ctx, sampleRate: 48000, blockSize: block };
      const v = inst.triggerVoice({ ...mk(key), velocity: 128, init: { ...mk(key).init, vol: 2.05 }, levels: { ...mk(key).levels, vol: 2.05 } }, c)!;
      const bl = new Float32Array(block), br = new Float32Array(block);
      for (let o = 0; o < 24000; o += block) {
        bl.fill(0); br.fill(0);
        if (o === 12000) v.release();
        v.render(bl, br, block);
        inst.render(bl, br, block, c);
        for (let i = 0; i < block; i++) if (!Number.isFinite(bl[i]) || !Number.isFinite(br[i])) throw new Error(`non finite at ${o + i} (${key} ${q} ${level} ${dust} ${block})`);
      }
    }
  }, 120000);

  it('plays through an instrument channel of the engine (Channel.plugin.params is the state) and follows the preset number', () => {
    const e = makeEngine();
    const ch = createGenChannel('autogun');
    ch.plugin!.params = { level: 256, dust: 430, n: 12, quality: 1 };
    const [a] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 4, key: 60 }] }, 24000);
    expect(peak(a)).toBeGreaterThan(0.01);
    const e2 = makeEngine();
    const ch2 = createGenChannel('autogun');
    ch2.plugin!.params = { level: 256, dust: 430, n: 13, quality: 1 };
    const [b] = play(e2, [ch2], { [ch2.id]: [{ pos: 0, len: 4, key: 60 }] }, 24000);
    expect(peak(b)).toBeGreaterThan(0.01);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBeGreaterThan(1000);
  }, 120000);

  it('keeps the distances of a map that sums to its length up to rounding (FL scales a curve once, when it reads it) and normalises one that does not', async () => {
    const { OgCurve } = await import('../../src/engine/gen/plugins/ogun/ogcurve');
    const load = (xs: number[]): number[] => {
      const c = new OgCurve(3);
      c.load({ t: 3, p: xs.map((x) => [x, 0.5, 0, 0, 0, 0, 2]), m: [0, -1, -1, -1, -1] });
      return Array.from(c.x.slice(0, c.n));
    };
    // 27 000 points of 1/32767 and a residual of the sum like the large pad maps' (the sum is 1 - 2e-14: scaled by 1 + 2e-14 the table moves)
    const pad = [0, ...Array.from({ length: 32767 }, () => 1 / 32767 * (1 - 6e-16))];
    expect(load(pad)).toEqual(pad);
    expect(load([0, 0.25, 0.25])).toEqual([0, 0.5, 0.5]);
    expect(load([0, 0.5, 0.5, 0.5])).toEqual([0, 0.5 * (1 / 1.5), 0.5 * (1 / 1.5), 0.5 * (1 / 1.5)]);
  });
});
