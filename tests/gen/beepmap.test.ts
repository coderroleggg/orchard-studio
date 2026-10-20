// BeepMap (FL: BeepMap): registration (FL's form / parameter list / value texts /
// presets / new-instance state), the bitmap helpers (text form, stand-in picture,
// BMP and FL state readers, fitting to the Max bitmap height) and the sound,
// pinned to FL Studio 2026's own plugin rendered by the test host (flfxhost render
// BeepMap --state <stand-in bitmap> --no-newtick --fixed-time 1700000000, raw
// channel): tests/gen/beepmap.golden.ts holds FL's output (a hash of every sample
// and picked samples), which this port reproduces bit for bit. The images in the
// renders are the stand-in picture (original code); no FL content is used.
import { describe, it, expect } from 'vitest';
import { def, pctText, SCALES } from '../../src/model/gen/plugins/beepmap';
import { gen, seedBeepMapRandom } from '../../src/engine/gen/plugins/beepmap';
import { standinBitmap, encodeBitmap, decodeBitmap, bitmapOf, validSize, MAXH_DEFAULT, MAX_H, MAX_W, type Bitmap } from '../../src/model/gen/plugins/beepmap/image';
import { parseBmp } from '../../src/model/gen/plugins/beepmap/bmp';
import { flPluginState, parseBeepMapFile, parseBeepMapState } from '../../src/model/gen/plugins/beepmap/flstate';
import { fitBitmap, resizeRows } from '../../src/model/gen/plugins/beepmap/resize';
import { newLevels, PITCH_C5 } from '../../src/engine/gen/levels';
import type { GenVoice, GenVoiceParams } from '../../src/engine/gen/types';
import { formatParam, genPresetState, defaultGenParams, normalizeGenParams } from '../../src/model/gen/registry';
import { GenChannel } from '../../src/engine/GenChannel';
import { createGenChannel } from '../../src/model/defaults';
import type { SeqNote } from '../../src/engine/Sequencer';
import { GOLDEN, STANDIN_HASH, type GoldenCase } from './beepmap.golden';

const fr = Math.fround;
const KEYS = ['freq', 'length', 'scale', 'blue', 'grainy', 'loop', 'widen'];

/** FNV-1a over bytes (the goldens' hash). */
function fnv(bytes: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h >>> 0;
}
const fnvText = (s: string) => fnv(new TextEncoder().encode(s));

/** FL's InitLevels.Vol for a velocity (single precision, as FL computes it). */
function flVol(vel: number): number {
  if (vel === 100) return 1;
  const s = fr(fr(vel * fr(0.01)) * fr(2.397895336151123));
  return fr((Math.exp(s) - 1) * fr(0.1));
}

type Inst = ReturnType<typeof gen.create> & { setBlockLength(n: number): void; setBitmap(b: Bitmap): void };

/**
 * Render a golden case the way the test host does: Gen_Render blocks of at most
 * `block` frames, split at note on / off, parameter automation and (with a glide)
 * every 16 frames; every voice rendered in steps of up to 16 frames.
 */
function render(c: Pick<GoldenCase, 'params' | 'notes' | 'at' | 'block' | 'sr' | 'frames'>, bitmap?: Bitmap): [Float32Array, Float32Array] {
  seedBeepMapRandom(1700000000);
  const inst = gen.create(c.sr, 128, { sample: () => undefined }) as Inst;
  if (bitmap) inst.setBitmap(bitmap);
  const cur: Record<string, number> = { freq: 7200, length: 2048, scale: 0, blue: 0, grainy: 0, loop: 1, widen: 1, ...c.params };
  inst.setParams({ ...cur });
  const L = new Float32Array(c.frames), R = new Float32Array(c.frames);
  type Ev = { t: number; kind: 'on' | 'off' | 'at'; i: number; k?: string; v?: number };
  const evs: Ev[] = [];
  c.notes.forEach((n, i) => { evs.push({ t: Math.round(n.start * c.sr), kind: 'on', i }); evs.push({ t: Math.round((n.start + n.dur) * c.sr), kind: 'off', i }); });
  for (const [t, k, v] of c.at ?? []) evs.push({ t: Math.round(t * c.sr), kind: 'at', i: -1, k, v });
  evs.sort((a, b) => a.t - b.t || (a.kind === 'on' ? 1 : 0) - (b.kind === 'on' ? 1 : 0));
  const live = new Map<number, { v: GenVoice; p: GenVoiceParams }>();
  const glide = c.notes.some((n) => n.glide);
  let ei = 0, t = 0;
  const pitchOf = (i: number, tt: number): number => {
    const n = c.notes[i];
    let ofs = 0;
    if (n.glide) {
      const s0 = Math.round(n.start * c.sr), s1 = Math.round((n.start + n.dur) * c.sr);
      ofs = fr(n.glide * (s1 > s0 ? Math.max(0, Math.min(1, (tt - s0) / (s1 - s0))) : 1));
    }
    return fr(PITCH_C5 + (n.key - 60) * 100 + ofs);
  };
  while (t < c.frames) {
    while (ei < evs.length && evs[ei].t <= t) {
      const e = evs[ei++];
      if (e.kind === 'at') { cur[e.k!] = e.v!; inst.setParams({ ...cur }); continue; }
      if (e.kind === 'off') { live.get(e.i)?.v.release(); continue; }
      const n = c.notes[e.i];
      const levels = newLevels();
      levels.pitch = pitchOf(e.i, t);
      levels.vol = flVol(n.vel ?? 100);
      levels.pan = n.pan ?? 0;
      const p: GenVoiceParams = { key: n.key, velocity: n.vel ?? 100, release: 64, color: 0, length: Infinity, frame: 0, init: newLevels(), levels };
      const v = inst.triggerVoice!(p);
      if (v) live.set(e.i, { v, p });
    }
    let n = Math.min(c.block, c.frames - t);
    if (ei < evs.length && evs[ei].t < t + n) n = evs[ei].t - t;
    if (glide) { n = Math.min(n, 16); for (const [i, x] of live) x.p.levels.pitch = pitchOf(i, t); }
    inst.setBlockLength(Math.max(1, n));
    for (const [i, x] of live) {
      let alive = true;
      for (let o = 0; o < n && alive;) {
        const k = Math.min(16, n - o);
        x.p.frame = o;
        alive = x.v.render(L.subarray(t + o, t + o + k), R.subarray(t + o, t + o + k), k);
        o += k;
      }
      if (!alive) { x.v.kill(); live.delete(i); }
    }
    t += Math.max(1, n);
  }
  return [L, R];
}

const hashOf = (L: Float32Array, R: Float32Array): number => {
  const w = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) { w[2 * i] = L[i]; w[2 * i + 1] = R[i]; }
  return fnv(new Uint8Array(w.buffer));
};

// ------------------------------------------------------------ BMP / FL state builders

function bmpFile(w: number, h: number, bpp: 8 | 24 | 32 | 1, o: { topDown?: boolean; pal?: number[]; at: (x: number, y: number) => number }): Uint8Array {
  const stride = Math.floor((w * bpp + 31) / 32) * 4;
  const pal = bpp <= 8 ? (o.pal ?? []) : [];
  const dataOff = 54 + pal.length * 4;
  const out = new Uint8Array(dataOff + stride * h);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  dv.setUint32(2, out.length, true); dv.setUint32(10, dataOff, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, o.topDown ? -h : h, true);
  dv.setUint16(26, 1, true); dv.setUint16(28, bpp, true); dv.setUint32(46, pal.length, true);
  pal.forEach((c, i) => { out[54 + 4 * i] = c & 255; out[55 + 4 * i] = (c >>> 8) & 255; out[56 + 4 * i] = (c >>> 16) & 255; });
  for (let y = 0; y < h; y++) {
    const row = dataOff + (o.topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const v = o.at(x, y);
      if (bpp === 24) { out[row + 3 * x] = v & 255; out[row + 3 * x + 1] = (v >>> 8) & 255; out[row + 3 * x + 2] = (v >>> 16) & 255; }
      else if (bpp === 32) { out[row + 4 * x] = v & 255; out[row + 4 * x + 1] = (v >>> 8) & 255; out[row + 4 * x + 2] = (v >>> 16) & 255; out[row + 4 * x + 3] = 0x7f; }
      else if (bpp === 8) out[row + x] = v;
      else if (v) out[row + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** A BeepMap state (FL's SaveRestoreState): version 0 = 15 integers, version 1 adds the 91-integer INS block. */
function flState(version: number, p: number[], maxH: number, bmp: Uint8Array | null, ins = true): Uint8Array {
  const head = [version, ...p, 0, 0, 0, 0, 0, 0, 0, maxH];
  const insInts = version === 1 && ins ? new Array(91).fill(0) : [];
  const ints = [...head, ...insInts];
  const out = new Uint8Array(ints.length * 4 + (bmp ? 4 + bmp.length : 0));
  const dv = new DataView(out.buffer);
  ints.forEach((v, i) => dv.setInt32(4 * i, v, true));
  if (bmp) { dv.setInt32(ints.length * 4, bmp.length, true); out.set(bmp, ints.length * 4 + 4); }
  return out;
}

/** An FL event file (.fst) holding `blob` as its plugin data (event 213). */
function fst(blob: Uint8Array): Uint8Array {
  const ev: number[] = [0xc7, 6, 50, 46, 53, 46, 52, 0, 0xd5];
  let n = blob.length;
  do { const b = n & 0x7f; n >>>= 7; ev.push(n ? b | 0x80 : b); } while (n);
  const body = new Uint8Array(ev.length + blob.length);
  body.set(ev);
  body.set(blob, ev.length);
  const out = new Uint8Array(8 + 6 + 8 + body.length);
  const dv = new DataView(out.buffer);
  out.set([0x46, 0x4c, 0x68, 0x64]); dv.setUint32(4, 6, true);
  out.set([0x46, 0x4c, 0x64, 0x74], 14); dv.setUint32(18, body.length, true);
  out.set(body, 22);
  return out;
}

describe('BeepMap: registration', () => {
  it("has FL's plugin facts and form size", () => {
    expect(def.name).toBe('BeepMap');
    expect(def.category).toBe('Synth special');
    expect(def.notes).toBe('voices');
    expect(def.ins).toBe(true);
    expect(def.levels).toBe('plugin');
    expect(def.defPoly).toBe(4);
    expect([def.width, def.height]).toEqual([380, 170]);
  });

  it("lists FL's parameters 0..6 with their ranges, defaults and names", () => {
    expect(def.params.map((p) => [p.index, p.key, p.name, p.min, p.max, p.def])).toEqual([
      [0, 'freq', 'Freq range', 24, 9600, 7200],
      [1, 'length', 'Pixel duration', 0, 4096, 2048],
      [2, 'scale', 'Type of frequency scale', 0, 2, 0],
      [3, 'blue', 'Enable blue color', 0, 1, 0],
      [4, 'grainy', 'Switch smooth / grainy mode', 0, 1, 0],
      [5, 'loop', 'Repeat sound', 0, 1, 1],
      [6, 'widen', 'Widen (stereo)', 0, 1, 1],
    ]);
  });

  it("matches FL's value texts over the whole range of the two wheels", () => {
    // flfxhost sweep BeepMap 0 / 1 --all: "value<TAB>text" lines, hashed
    const sweep = (k: string, lo: number, hi: number) => {
      const q = def.params.find((p) => p.key === k)!;
      let s = '';
      for (let v = lo; v <= hi; v++) s += `${v}\t${formatParam(q, v)}\n`;
      return s;
    };
    expect(fnvText(sweep('freq', 24, 9600)).toString(16)).toBe('709f57bd');
    expect(fnvText(sweep('length', 0, 4096)).toString(16)).toBe('6fde2be5');
    // a few of them: halves round up, the default shows 75% / 50%
    expect([pctText(7200, 9600), pctText(2048, 4096), pctText(1392, 9600), pctText(5520, 9600), pctText(512, 4096)]).toEqual(['75%', '50%', '15%', '58%', '13%']);
  });

  it("matches FL's texts of the scale and the switches", () => {
    const text = (k: string, v: number) => formatParam(def.params.find((p) => p.key === k)!, v);
    expect(SCALES).toEqual(['Log', 'Linear', 'Harmonics']);
    expect([0, 1, 2].map((v) => text('scale', v))).toEqual(['Log', 'Linear', 'Harmonics']);
    for (const k of ['blue', 'grainy', 'loop', 'widen']) expect([text(k, 0), text(k, 1)]).toEqual(['off', 'on']);
  });

  it("starts a new instance with FL's insertion state (Widen on, height 23, no bitmap) and keeps the Default preset's Widen off", () => {
    const fresh = defaultGenParams('beepmap');
    expect(fresh).toEqual({ freq: 7200, length: 2048, scale: 0, blue: 0, grainy: 0, loop: 1, widen: 1, maxH: 23, bmp: '' });
    const dflt = def.presets!.find((p) => p.name === 'Default')!;
    expect(dflt.params.widen).toBe(0);
    expect(genPresetState('beepmap', dflt).widen).toBe(0);
  });

  it("has FL's 7 factory presets (parameter values and Max bitmap height; the bitmaps are FL content)", () => {
    expect(def.presets!.map((p) => [p.name, ...KEYS.map((k) => p.params[k]), p.params.maxH])).toEqual([
      ['Ambiance', 2816, 3008, 0, 0, 1, 1, 0, 64],
      ['Bleep', 8672, 1664, 0, 0, 0, 1, 0, 23],
      ['Climbing', 7616, 3424, 0, 1, 0, 1, 0, 64],
      ['Default', 7200, 2048, 0, 0, 0, 1, 0, 23],
      ['Liquid', 8832, 3584, 0, 1, 0, 0, 0, 64],
      ['Voice', 6656, 704, 1, 0, 0, 1, 0, 40],
      ['Warp', 3296, 3808, 0, 1, 0, 0, 0, 64],
    ]);
    for (const p of def.presets!) {
      const s = genPresetState('beepmap', p);
      expect(s.bmp).toBe('');
      expect(s.__preset).toBe(p.name);
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    }
  });

  it('repairs stored states', () => {
    expect(normalizeGenParams('beepmap', { maxH: 5000, bmp: 7 })).toMatchObject({ maxH: 999, bmp: '' });
    expect(normalizeGenParams('beepmap', { maxH: -3 }).maxH).toBe(3);
    expect(normalizeGenParams('beepmap', { maxH: 'x' }).maxH).toBe(23);
    expect(normalizeGenParams('beepmap', {})).toMatchObject({ freq: 7200, widen: 1, maxH: 23, bmp: '' });
  });
});

describe('BeepMap: the bitmap', () => {
  it('round-trips through its text form and refuses damaged text', () => {
    const b: Bitmap = { w: 2, h: 3, px: new Uint32Array([0x000000, 0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0x123456]) };
    const t = encodeBitmap(b);
    expect(t.startsWith('2x3:')).toBe(true);
    expect(t.length).toBe(4 + 6 * 4);
    expect(decodeBitmap(t)).toEqual(b);
    for (const bad of ['', 'x', '2x3:', '2x3:' + 'A'.repeat(23), '2x3:' + 'A'.repeat(25), '0x3:', '2x3:' + '!'.repeat(24), '2x3:' + 'é'.repeat(24), 'ax3:AAAA', '99999x99999:AAAA', '3x2:' + 'A'.repeat(24), 5 as unknown, null as unknown]) expect(decodeBitmap(bad)).toBeNull();
    expect(validSize(1, 1)).toBe(true);
    expect(validSize(MAX_W + 1, 1)).toBe(false);
    expect(validSize(2, MAX_H + 1)).toBe(false);
    expect(validSize(0, 5)).toBe(false);
    expect(validSize(2000, 999)).toBe(true);
    expect(validSize(2200, 999)).toBe(false); // over 2 million pixels (8 MB of text in the state)
  });

  it('plays an original stand-in picture while none is loaded', () => {
    const s = standinBitmap();
    expect([s.w, s.h]).toEqual([300, MAXH_DEFAULT]);
    expect(s).toBe(standinBitmap());
    expect(bitmapOf('')).toBe(s);
    expect(bitmapOf('garbage')).toBe(s);
    // the goldens were rendered from this picture: regenerate them (.flref/special/beepmap/mkgolden.py) if it changes
    expect(fnv(new Uint8Array(s.px.buffer, s.px.byteOffset, s.px.byteLength))).toBe(STANDIN_HASH);
  });
});

describe('BeepMap: reading FL bitmaps and states', () => {
  it('reads 24-bit, 32-bit, palette and 1-bit BMPs, bottom-up and top-down', () => {
    const at = (x: number, y: number) => ((x * 40 + 5) << 16) | ((y * 50 + 9) << 8) | ((x * 7 + y * 11) & 255);
    for (const topDown of [false, true]) {
      for (const bpp of [24, 32] as const) {
        const b = parseBmp(bmpFile(5, 4, bpp, { topDown, at }))!;
        expect([b.w, b.h]).toEqual([5, 4]);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) expect(b.px[y * 5 + x]).toBe(at(x, y));
      }
    }
    // an 8-bit palette (FL's Voice.bmp is one): index -> colour
    const pal = [0x000000, 0xff0000, 0x00ff00, 0x0000ff, 0x102030];
    const p8 = parseBmp(bmpFile(7, 3, 8, { pal, at: (x, y) => (x + y) % 5 }))!;
    expect([p8.w, p8.h, p8.px[0], p8.px[1], p8.px[2], p8.px[3 + 7]]).toEqual([7, 3, pal[0], pal[1], pal[2], pal[(3 + 1) % 5]]);
    const p1 = parseBmp(bmpFile(10, 2, 1, { pal: [0x000000, 0xffffff], at: (x, y) => ((x + y) & 1) as number }))!;
    expect([p1.px[0], p1.px[1], p1.px[10], p1.px[11]]).toEqual([0, 0xffffff, 0xffffff, 0]);
  });

  it('refuses damaged, truncated, absurd and compressed BMPs', () => {
    const good = bmpFile(5, 4, 24, { at: () => 0x112233 });
    expect(parseBmp(good)).not.toBeNull();
    expect(parseBmp(good.subarray(0, good.length - 1))).toBeNull();
    expect(parseBmp(good.subarray(0, 20))).toBeNull();
    expect(parseBmp(new Uint8Array(100))).toBeNull();
    const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const huge = good.slice(); dv(huge).setInt32(18, 40000, true);
    expect(parseBmp(huge)).toBeNull();
    const area = good.slice(); dv(area).setInt32(18, 30000, true); dv(area).setInt32(22, 30000, true);
    expect(parseBmp(area)).toBeNull();
    const rle = good.slice(); dv(rle).setUint32(30, 1, true);
    expect(parseBmp(rle)).toBeNull();
    const zero = good.slice(); dv(zero).setInt32(22, 0, true);
    expect(parseBmp(zero)).toBeNull();
    const bpp = good.slice(); dv(bpp).setUint16(28, 7, true);
    expect(parseBmp(bpp)).toBeNull();
    const off = good.slice(); dv(off).setUint32(10, 0xffffff, true);
    expect(parseBmp(off)).toBeNull();
  });

  it("reads FL's version 0 and version 1 states and their .fst files", () => {
    const img = bmpFile(6, 4, 32, { at: (x, y) => (x << 16) | (y << 8) });
    const v0 = flState(0, [2816, 3008, 0, 0, 1, 1, 0], 64, img);
    const s0 = parseBeepMapState(v0)!;
    expect(s0.version).toBe(0);
    expect(s0.params).toEqual({ freq: 2816, length: 3008, scale: 0, blue: 0, grainy: 1, loop: 1, widen: 0 });
    expect(s0.maxH).toBe(64);
    expect(parseBmp(s0.bmp!)!.w).toBe(6);
    const v1 = flState(1, [7200, 2048, 2, 1, 0, 1, 1], 23, img);
    const s1 = parseBeepMapState(v1)!;
    expect(s1.params).toEqual({ freq: 7200, length: 2048, scale: 2, blue: 1, grainy: 0, loop: 1, widen: 1 });
    expect(s1.maxH).toBe(23);
    expect([...s1.bmp!]).toEqual([...img]);
    // the .fst wrapper (FLhd / FLdt, event 213)
    expect(flPluginState(fst(v0))).toEqual(v0);
    expect(parseBeepMapFile(fst(v1))!.params.scale).toBe(2);
    expect(parseBeepMapFile(v0)!.maxH).toBe(64);
    // values out of range are clamped; unknown versions, short or damaged files are refused
    expect(parseBeepMapState(flState(0, [99999, -5, 7, 3, 9, 0, 2], 5000, img))!.params).toEqual({ freq: 9600, length: 0, scale: 2, blue: 1, grainy: 1, loop: 0, widen: 1 });
    expect(parseBeepMapState(flState(0, [7200, 2048, 0, 0, 0, 1, 1], 1, img))!.maxH).toBe(3);
    expect(parseBeepMapState(flState(2, [7200, 2048, 0, 0, 0, 1, 1], 23, img))).toBeNull();
    expect(parseBeepMapState(v0.subarray(0, 40))).toBeNull();
    expect(parseBeepMapState(flState(0, [7200, 2048, 0, 0, 0, 1, 1], 23, null))!.bmp).toBeNull();
    expect(parseBeepMapState(v0.subarray(0, v0.length - 3))!.bmp).toBeNull();
    const lie = v0.slice(); new DataView(lie.buffer).setInt32(64, 0x7fffffff, true);
    expect(parseBeepMapState(lie)!.bmp).toBeNull();
    expect(flPluginState(new Uint8Array([0x46, 0x4c, 0x68, 0x64, 6, 0, 0, 0, 1, 2, 3]))).toBeNull();
  });
});

describe('BeepMap: fitting a picture', () => {
  const grad = (w: number, h: number): Bitmap => {
    const px = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = ((y * 255 / (h - 1) | 0) << 16) | (x % 256) << 8 | 128;
    return { w, h, px };
  };

  it('keeps pictures within the Max bitmap height and refuses fewer than 3 rows (as FL does)', () => {
    const b = grad(10, 8);
    expect(fitBitmap(b, 23)).toBe(b);
    expect(fitBitmap({ w: 10, h: 2, px: new Uint32Array(20) }, 23)).toBeNull();
    const r = fitBitmap(grad(12, 48), 23)!;
    expect([r.w, r.h]).toEqual([12, 23]);
    expect(fitBitmap(grad(5, 48), 3)!.h).toBe(3);
    expect(fitBitmap(grad(5, 48), 1)!.h).toBe(3);
    expect(fitBitmap(grad(5, 1500), 5000)!.h).toBe(999);
    // too wide pictures are reduced to the engine's pixel limit (Orchard's own)
    const wide = fitBitmap({ w: 9000, h: 3, px: new Uint32Array(27000) }, 23)!;
    expect(wide.w).toBe(8192);
  });

  it("resamples rows like FL's loader: a flat picture stays flat, and a single row spreads as FL's does", () => {
    const flat = resizeRows({ w: 4, h: 48, px: new Uint32Array(4 * 48).fill(0x7f3a91) }, 23);
    expect(new Set(flat.px)).toEqual(new Set([0x7f3a91]));
    // FL's measured response (flfxhost, 48 -> 23 rows: a baseline of 64 with one row at 192, units of 1 / 128):
    // output row k of source rows lo..lo + n - 1
    const FL: [number, number, number[]][] = [
      [0, 0, [62, 56, 20, -7, -6, 1, 1]],
      [3, 1, [0, 2, -3, -9, 9, 47, 60, 30, -3, -8, 0, 1, 0]],
      [11, 18, [1, 1, -6, -7, 19, 55, 55, 19, -7, -6, 1, 1]],
      [21, 39, [1, 1, -7, -5, 25, 59, 51, 13, -10]],
    ];
    for (const [k, lo, resp] of FL) {
      resp.forEach((v, i) => {
        const px = new Uint32Array(2 * 48).fill(0x400000);
        px[(lo + i) * 2] = 0xc00000; px[(lo + i) * 2 + 1] = 0xc00000;
        const got = ((resizeRows({ w: 2, h: 48, px }, 23).px[k * 2] >>> 16) & 255) - 64;
        expect(Math.abs(got - v), `row ${k}, source ${lo + i}`).toBeLessThanOrEqual(1);
      });
    }
  });
});

describe('BeepMap: sound (pinned to FL Studio 2026)', () => {
  const standin = standinBitmap();
  for (const c of GOLDEN) {
    it(`renders ${c.name} bit for bit`, () => {
      const [L, R] = render(c, standin);
      expect(L.length).toBe(c.frames);
      for (const [i, l, r] of c.picks) expect([i, L[i], R[i]]).toEqual([i, fr(l), fr(r)]);
      let pk = 0;
      for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
      expect(pk).toBeCloseTo(c.peak, 5);
      expect(hashOf(L, R).toString(16)).toBe(c.hash.toString(16));
    });
  }

  it('plays through an instrument channel bit for bit (128-frame blocks, the first case)', () => {
    const c = GOLDEN.find((x) => x.name === 'wide')!;
    const sr = c.sr;
    const ch = createGenChannel('beepmap');
    ch.volume = 1;
    const ctx = { sampleRate: sr, blockSize: 128, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
    const gc = new GenChannel(ch.id, sr, 128, 'beepmap', { sample: () => undefined }, ctx as never);
    gc.setGlobals({ tempo: 130, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } as never);
    gc.apply(ch);
    seedBeepMapRandom(1700000000);
    const L = new Float32Array(c.frames), R = new Float32Array(c.frames);
    const bl = new Float32Array(128), br = new Float32Array(128);
    for (let off = 0; off < c.frames; off += 128) {
      if (off === 0) {
        const sn = { pos: 0, len: 0, oneShot: false, key: 60, vel: 100, rel: 64, pan: 64, fine: 120, modX: 128, modY: 128, slide: false, porta: false, color: 0, chId: ch.id } as unknown as SeqNote;
        gc.scheduleNote(sn, 0, Math.round(0.75 * sr));
      }
      bl.fill(0); br.fill(0);
      const n = Math.min(128, c.frames - off);
      gc.render(bl.subarray(0, n), br.subarray(0, n), n);
      L.set(bl.subarray(0, n), off); R.set(br.subarray(0, n), off);
    }
    // the instrument's own state holds the stand-in picture: the render is FL's
    expect(hashOf(L, R).toString(16)).toBe(c.hash.toString(16));
  });

  it('maps red to the left channel and green to the right, and the pixel height to the frequency', () => {
    const w = 6, h = 8;
    const make = (color: number, row: number): Bitmap => {
      const px = new Uint32Array(w * h);
      for (let x = 0; x < w; x++) px[row * w + x] = color;
      return { w, h, px };
    };
    const rms = (b: Float32Array) => Math.sqrt(b.reduce((s, v) => s + v * v, 0) / b.length);
    const run = (b: Bitmap, params: Record<string, number> = {}) => render({ params: { widen: 0, length: 100, ...params }, notes: [{ key: 60, start: 0, dur: 0.2 }], block: 128, sr: 44100, frames: 8820 }, b);
    const [rl, rr] = run(make(0xff0000, 3));
    expect(rms(rl)).toBeGreaterThan(0.05);
    expect(rms(rr)).toBe(0);
    const [gl, gr] = run(make(0x00ff00, 3));
    expect(rms(gl)).toBe(0);
    expect(rms(gr)).toBeGreaterThan(0.05);
    const [yl, yr] = run(make(0xffff00, 3));
    expect(rms(yl)).toBeCloseTo(rms(yr), 1);
    const [bl, br] = run(make(0x0000ff, 3));
    expect(rms(bl) + rms(br)).toBe(0);
    // zero crossings of a single row: the top row is the highest pitch (+3600 cents = 4186 Hz at the default range), the bottom the lowest
    const cross = (b: Float32Array, a = 2000, z = 8000) => { let n = 0; for (let i = a + 1; i < z; i++) if (b[i - 1] < 0 && b[i] >= 0) n++; return (n * 44100) / (z - a); };
    expect(cross(run(make(0xff0000, 0))[0])).toBeGreaterThan(3900);
    expect(cross(run(make(0xff0000, 0))[0])).toBeLessThan(4400);
    expect(cross(run(make(0xff0000, 7))[0])).toBeGreaterThan(60);
    expect(cross(run(make(0xff0000, 7))[0])).toBeLessThan(70);
    // the middle (row 3.5 of 8) is C5: row 3 and 4 straddle 523 Hz
    const mid = cross(run(make(0xff0000, 3))[0]);
    expect(mid).toBeGreaterThan(300);
    expect(mid).toBeLessThan(800);
  });

  it('ends by itself after the last pixel with Loop off, and loops without it', () => {
    const w = 5, h = 4;
    const b: Bitmap = { w, h, px: new Uint32Array(w * h).fill(0xffffff) };
    const run = (loop: number) => render({ params: { widen: 0, length: 0, loop }, notes: [{ key: 60, start: 0, dur: 1 }], block: 128, sr: 44100, frames: 44100 }, b)[0];
    const lastSound = (a: Float32Array) => { let l = -1; for (let i = 0; i < a.length; i++) if (a[i] !== 0) l = i; return l; };
    // 5 pixels of 64 samples, a silent one fading out, then the block ends the voice
    expect(lastSound(run(0))).toBeLessThan(5 * 64 + 64 + 128 + 128);
    expect(lastSound(run(0))).toBeGreaterThan(5 * 64);
    expect(lastSound(run(1))).toBeGreaterThan(30000);
  });

  it('applies the note off as FL\'s 441-sample cosine fade and ends the voice with it', () => {
    const inst = gen.create(44100, 128, { sample: () => undefined }) as Inst;
    inst.setParams({});
    const p: GenVoiceParams = { key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: newLevels(), levels: newLevels() };
    const v = inst.triggerVoice!(p)!;
    const out = new Float32Array(2048), r = new Float32Array(2048);
    let alive = true, end = -1;
    for (let o = 0; o < 2048; o += 16) {
      if (o === 1024) v.release();
      p.frame = o % 128;
      alive = v.render(out.subarray(o, o + 16), r.subarray(o, o + 16), 16);
      if (!alive && end < 0) end = o + 16;
    }
    let pk = 0;
    for (let i = 1024 + 441; i < 2048; i++) pk = Math.max(pk, Math.abs(out[i]));
    expect(pk).toBe(0);
    expect(end).toBeGreaterThanOrEqual(1024 + 441);
    expect(end).toBeLessThanOrEqual(1024 + 441 + 16);
  });

  it('stops the voices when a new bitmap is loaded (FL kills them) and takes parameter changes at the next block', () => {
    const inst = gen.create(44100, 128, { sample: () => undefined }) as Inst;
    inst.setParams({});
    const p: GenVoiceParams = { key: 60, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: newLevels(), levels: newLevels() };
    const v = inst.triggerVoice!(p)!;
    const l = new Float32Array(16), r = new Float32Array(16);
    expect(v.render(l, r, 16)).toBe(true);
    inst.setParams({ bmp: encodeBitmap({ w: 3, h: 3, px: new Uint32Array(9).fill(0xffffff) }) });
    expect(v.render(l, r, 16)).toBe(false);
    // the same text again keeps the voices
    const v2 = inst.triggerVoice!(p)!;
    inst.setParams({ bmp: encodeBitmap({ w: 3, h: 3, px: new Uint32Array(9).fill(0xffffff) }) });
    expect(v2.render(l, r, 16)).toBe(true);
  });

  it('stays finite at extreme settings, keys and pictures', () => {
    const noise = (w: number, h: number): Bitmap => {
      const px = new Uint32Array(w * h);
      for (let i = 0; i < px.length; i++) px[i] = (Math.imul(i + 1, 2654435761) >>> 8) & 0xffffff;
      return { w, h, px };
    };
    const sets: [Record<string, unknown>, number[]][] = [
      [{ freq: 24, length: 0, scale: 0, blue: 1, grainy: 1, loop: 0, widen: 1 }, [8000, 44100, 192000]],
      [{ freq: 9600, length: 4096, scale: 1, blue: 1, grainy: 1, loop: 1, widen: 0 }, [8000, 44100, 192000]],
      [{ freq: 9600, length: 100, scale: 2, blue: 1, grainy: 0, loop: 1, widen: 1 }, [44100]],
      [{ freq: Number.NaN, length: Number.POSITIVE_INFINITY, scale: 'x', blue: 5, grainy: -1 }, [44100]],
    ];
    const bitmap = noise(9, 40);
    for (const [params, rates] of sets) {
      for (const key of [0, 131]) {
        for (const sr of rates) {
          const [L, R] = render({ params: params as Record<string, number>, notes: [{ key, start: 0, dur: 0.03 }, { key: 131 - key, vel: 128, start: 0.01, dur: 0.05, pan: -1 }], block: 128, sr, frames: Math.round(sr * 0.1) }, bitmap);
          for (let i = 0; i < L.length; i++) { expect(Number.isFinite(L[i])).toBe(true); expect(Number.isFinite(R[i])).toBe(true); }
        }
      }
    }
    // a minimal picture (3 rows x 1 column) and a 999-row one
    for (const b of [noise(1, 3), noise(2, 999)]) {
      const [L] = render({ params: {}, notes: [{ key: 60, start: 0, dur: 0.02 }], block: 128, sr: 44100, frames: 3000 }, b);
      expect(L.every(Number.isFinite)).toBe(true);
    }
  }, 60000);
});
